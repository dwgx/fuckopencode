import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyPool } from '../src/keypool.js';
import { PAYG_PROBE_MODEL, PROBE_MODEL, probeKey, runProbeRound } from '../src/keyprobe.js';
import type { AppConfig } from '../src/config.js';
import type { AccountsStore } from '../src/accounts.js';

/**
 * 探活的价值在于「面板说可用，但真的可用吗」。
 *
 * 所以这些测试盯两件事：
 * 1. 别浪费额度 —— 只探「探针已到期」的账户（账户驱动，MULTI-ACCOUNT.md §4.4）
 * 2. 结论要和真实流量一致 —— 探活失败该禁用就禁用，用同一套分类
 */

const KEYS = ['sk-key-aaaa', 'sk-key-bbbb'];

const UPSTREAM = 'https://upstream.test';
const PAYG = 'https://payg.test';

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    anthropicBaseUrl: UPSTREAM,
    payAsYouGoBaseUrl: PAYG,
    keyProbeIdleMs: 3_600_000,
    keyProbeTimeoutMs: 5_000,
    keyProbeIntervalMs: 900_000,
    keyCooldownMs: 300_000,
    ...over,
  } as unknown as AppConfig;
}

function pool(now: () => number) {
  return new KeyPool(KEYS, { failThreshold: 5, cooldownMs: 300_000, now });
}

describe('staleKeys：只挑该探的 key（额度很珍贵）', () => {
  it('刚重启（从未使用）的 key 要探', () => {
    let t = 1_000_000;
    const p = pool(() => t);
    const stale = p.staleKeys(1_800_000);
    expect(stale.map((s) => s.fingerprint).sort()).toEqual(['****aaaa', '****bbbb']);
    // 从未使用 -> idleForMs 是 Infinity，日志会写「本进程内从未使用」
    expect(stale.every((s) => s.idleForMs === Infinity)).toBe(true);
  });

  it('刚用过的 key 不探', () => {
    let t = 1_000_000;
    const p = pool(() => t);
    const k = p.acquire();
    p.release(k);
    p.markSuccess(k);
    // 另一个还没用过，仍该被探；用过的那个不该
    const fps = p.staleKeys(1_800_000).map((s) => s.fingerprint);
    expect(fps).not.toContain('****aaaa');
    expect(fps.length).toBe(1);
  });

  it('空闲超过阈值才探', () => {
    let t = 1_000_000;
    const p = pool(() => t);
    for (const k of KEYS) {
      p.markSuccess(k);
      p.release(k);
    }
    // 两个都刚用过
    expect(p.staleKeys(1_800_000)).toHaveLength(0);
    // 时间推进 29 分钟：还不够
    t += 29 * 60_000;
    expect(p.staleKeys(1_800_000)).toHaveLength(0);
    // 推到 31 分钟：该探了
    t += 2 * 60_000;
    expect(p.staleKeys(1_800_000)).toHaveLength(2);
  });

  it('禁用中的 key 不探（有明确冷却到期时间，别拿真请求去撞额度耗尽的号）', () => {
    let t = 1_000_000;
    const p = pool(() => t);
    // 冷却 12 小时，比下面推进的 2 小时长 —— 保证测的是「禁用中不探」，
    // 而不是「冷却已到期自然恢复」。
    p.markFailure('sk-key-aaaa', 'quota-exhausted', 12 * 3_600_000);
    t += 2 * 3_600_000; // 让另一个也变成空闲
    const fps = p.staleKeys(1_800_000).map((s) => s.fingerprint);
    expect(fps).not.toContain('****aaaa');
  });

  it('正在处理请求的 key 不探（有真实流量就说明它活着）', () => {
    let t = 1_000_000;
    const p = pool(() => t);
    const k = p.acquire(); // inFlight = 1，不 release
    t += 2 * 3_600_000;
    const fps = p.staleKeys(1_800_000).map((s) => s.fingerprint);
    expect(fps).not.toContain(k.slice(-4) === 'aaaa' ? '****aaaa' : '****bbbb');
  });
});

describe('probeKey：结论与真实流量一致', () => {
  it('探活成功刷新 lastUsedAt，面板「最近使用」变新', async () => {
    let t = 1_000_000;
    const p = pool(() => t);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await probeKey(cfg(), p, 'sk-key-aaaa', '****aaaa', 5_000, UPSTREAM, PROBE_MODEL);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    // 探完就不再是 stale
    expect(p.staleKeys(1_800_000).map((s) => s.fingerprint)).not.toContain('****aaaa');
    vi.unstubAllGlobals();
  });

  it('用最小 token 的 deepseek-v4-flash，打到 baseUrl 的 /v1/chat/completions（不乱用别的模型、不浪费额度）', async () => {
    const p = pool(() => 1_000_000);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await probeKey(cfg(), p, 'sk-key-aaaa', '****aaaa', 5_000, UPSTREAM, PROBE_MODEL);
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe('https://upstream.test/v1/chat/completions');
    const init = call[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { model: string; max_tokens: number; stream: boolean };
    expect(body.model).toBe(PROBE_MODEL);
    expect(PROBE_MODEL).toBe('deepseek-v4-flash');
    expect(body.max_tokens).toBe(1);
    expect(body.stream).toBe(false);
    vi.unstubAllGlobals();
  });

  it('按量端点探活用 -free 模型（参数决定端点与模型）', async () => {
    const p = pool(() => 1_000_000);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await probeKey(cfg(), p, 'sk-key-aaaa', '****aaaa', 5_000, PAYG, PAYG_PROBE_MODEL);
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe('https://payg.test/v1/chat/completions');
    const body = JSON.parse(String((call[1] as RequestInit).body)) as { model: string };
    expect(body.model).toBe(PAYG_PROBE_MODEL);
    expect(PAYG_PROBE_MODEL).toBe('deepseek-v4-flash-free');
    vi.unstubAllGlobals();
  });

  it('探活打到指定的那个 key，不走 least-loaded', async () => {
    const p = pool(() => 1_000_000);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await probeKey(cfg(), p, 'sk-key-bbbb', '****bbbb', 5_000, UPSTREAM, PROBE_MODEL);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const auth = (init.headers as Record<string, string>).authorization;
    expect(auth).toBe('Bearer sk-key-bbbb');
    vi.unstubAllGlobals();
  });

  it('额度耗尽的探活结果按上游给的重置时间禁用（与真实流量同一套分类）', async () => {
    let t = 1_000_000;
    const p = pool(() => t);
    const body = JSON.stringify({
      error: { type: 'rate_limit_error', message: 'Weekly usage limit reached. Resets in 2hr 30min.' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 429 })));

    const r = await probeKey(cfg(), p, 'sk-key-aaaa', '****aaaa', 5_000, UPSTREAM, PROBE_MODEL);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('quota-exhausted');

    // 面板应当立刻看到它被禁用 —— 这正是探活的意义：不等用户的请求去踩
    const snap = p.snapshot().find((s) => s.fingerprint === '****aaaa')!;
    expect(snap.healthy).toBe(false);
    expect(snap.disabledReason).toBe('quota-exhausted');
    // 2hr30min + 60s 余量
    expect(snap.recoverInMs).toBeGreaterThan(2.5 * 3_600_000);
    vi.unstubAllGlobals();
  });

  it('网络失败算 transient，不因一次探活失败误杀好 key', async () => {
    let t = 1_000_000;
    const p = pool(() => t);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')));

    const r = await probeKey(cfg(), p, 'sk-key-aaaa', '****aaaa', 5_000, UPSTREAM, PROBE_MODEL);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('transient');
    expect(r.status).toBe(0);
    // failThreshold = 5，一次失败不该禁用
    const snap = p.snapshot().find((s) => s.fingerprint === '****aaaa')!;
    expect(snap.healthy).toBe(true);
    expect(snap.failCount).toBe(1);
    vi.unstubAllGlobals();
  });

  it('探活遇模型不支持（401 ModelError）→ 不 markFailure、记被动学习 blocked（M-P2-5）', async () => {
    let t = 1_000_000;
    const p = pool(() => t);
    const body = JSON.stringify({
      error: { type: 'ModelError', message: 'Model deepseek-v4-flash is not supported' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 401 })));

    const r = await probeKey(cfg(), p, 'sk-key-aaaa', '****aaaa', 5_000, UPSTREAM, PROBE_MODEL);
    expect(r.ok).toBe(false);
    expect(r.modelUnsupported).toBe(true);
    // 模型不可用 ≠ key 不可用：不 markFailure，key 保持健康、失败计数不涨
    const snap = p.snapshot().find((s) => s.fingerprint === '****aaaa')!;
    expect(snap.healthy).toBe(true);
    expect(snap.failCount).toBe(0);
    // 被动学习 (account, model) blocked：选号排除该组合（env 兜底 accountId=0）
    expect(p.isModelBlocked(0, PROBE_MODEL)).toBe(true);
    vi.unstubAllGlobals();
  });
});

// ─── 账户驱动（MULTI-ACCOUNT.md §4.4） ──────────────────────────────────────
// 时间由 vi.useFakeTimers 控制（Date.now 一并被 fake），pool 的 now 用默认
// Date.now —— 两边的时钟是一致的。

interface FakeAccountDef {
  id: number;
  name: string;
  kind: 'subscription' | 'payg' | 'unknown';
  retryUntil: number;
  keys: string[];
  /** OAuth refresh_token（无 key 的纯 OAuth 账号用）。 */
  oauth?: string;
}

/** runProbeRound 只用到 AccountsStore 的 list/keysOf/setProbeResult，这里按需假造。 */
function fakeAccounts(accts: FakeAccountDef[]) {
  const calls: Array<{ id: number; result: Record<string, unknown> }> = [];
  const store = {
    list: () =>
      accts.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        retryUntil: a.retryUntil,
      })),
    keysOf: (id: number): string[] | null => accts.find((a) => a.id === id)?.keys ?? null,
    getOauthRefresh: (id: number): string | null => accts.find((a) => a.id === id)?.oauth ?? null,
    setProbeResult: (id: number, result: Record<string, unknown>) => {
      calls.push({ id, result });
      return true;
    },
  };
  return { store: store as unknown as AccountsStore, calls };
}

/** 按账户归属构造 pool：key → accountId，与 fakeAccounts 的账户一一对应。 */
function acctPool(accts: FakeAccountDef[]): KeyPool {
  const ids = new Map<string, number>();
  for (const a of accts) {
    for (const k of a.keys) ids.set(k, a.id);
  }
  return new KeyPool(
    accts.flatMap((a) => a.keys),
    { failThreshold: 5, cooldownMs: 300_000 },
    ids,
  );
}

describe('runProbeRound：账户驱动（MULTI-ACCOUNT.md §4.4）', () => {
  const T0 = 1_000_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('冷却期不探；到期 + 提前 5min 窗口内才探', async () => {
    const accts: FakeAccountDef[] = [
      { id: 1, name: 'env', kind: 'unknown', retryUntil: T0 + 20 * 60_000, keys: ['sk-key-aaaa'] },
      { id: 2, name: 'payg', kind: 'payg', retryUntil: 0, keys: ['sk-key-bbbb'] },
    ];
    const { store, calls } = fakeAccounts(accts);
    const p = acctPool(accts);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await runProbeRound(cfg(), p, null, store, () => {});
    // 账户 1 在冷却期（20min > 提前窗口 5min）不探；账户 2 retry_until=0 到期即探
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe(2);
    // 成功写账：status=ok，retry_until = now + keyProbeIdleMs（闲置 60min 再探）
    expect(calls[0]!.result).toEqual({
      status: 'ok',
      detail: null,
      retryUntil: T0 + 3_600_000,
      lastProbeAt: T0,
    });

    // 推进 16 分钟：账户 1 进入提前窗口（20min - 5min = 15min），该探了
    vi.advanceTimersByTime(16 * 60_000);
    await runProbeRound(cfg(), p, null, store, () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls[1]!.id).toBe(1);
  });

  it('没有到期账户时一个请求都不发（不浪费额度）', async () => {
    const accts: FakeAccountDef[] = [
      { id: 1, name: 'env', kind: 'unknown', retryUntil: T0 + 60 * 60_000, keys: ['sk-key-aaaa'] },
    ];
    const { store } = fakeAccounts(accts);
    const p = acctPool(accts);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const results = await runProbeRound(cfg(), p, null, store, () => {});
    expect(results).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('没有 key 的账户跳过（没什么可探）', async () => {
    const accts: FakeAccountDef[] = [{ id: 1, name: 'env', kind: 'unknown', retryUntil: 0, keys: [] }];
    const { store } = fakeAccounts(accts);
    const p = acctPool(accts);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const results = await runProbeRound(cfg(), p, null, store, () => {});
    expect(results).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('账户任一 key 最近有真实流量 → 跳过（活着就不需要证明）', async () => {
    const accts: FakeAccountDef[] = [{ id: 1, name: 'env', kind: 'unknown', retryUntil: 0, keys: ['sk-key-aaaa'] }];
    const { store, calls } = fakeAccounts(accts);
    const p = acctPool(accts);
    p.markSuccess('sk-key-aaaa'); // 刚被真实流量用过（lastUsedAt = now）
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    // 10 分钟后仍小于 idleMs（60min）→ 不探
    vi.advanceTimersByTime(10 * 60_000);
    await runProbeRound(cfg(), p, null, store, () => {});
    expect(fetchMock).not.toHaveBeenCalled();

    // 距上次使用超过 idleMs → 该探了
    vi.advanceTimersByTime(60 * 60_000);
    await runProbeRound(cfg(), p, null, store, () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('m-1：manual 禁用的 key 跳过探活（操作员显式停用，探活是白打上游调用）', async () => {
    const accts: FakeAccountDef[] = [
      { id: 1, name: 'env', kind: 'unknown', retryUntil: 0, keys: ['sk-key-manual', 'sk-key-normal'] },
    ];
    const { store, calls } = fakeAccounts(accts);
    const p = acctPool(accts);
    p.disable('sk-key-manual'); // 操作员手动停用（365 天，reset() 才恢复）
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await runProbeRound(cfg(), p, null, store, () => {});
    // manual 的 key 不再被打（只探 normal 一个）；quota-exhausted/auth 冷却的 key
    // 仍探（「到期前确认恢复」手段）—— 见 probeKey 失败分支测试。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const authHeaders = fetchMock.mock.calls.map(
      (c) => ((c[1] as RequestInit).headers as Record<string, string>).authorization ?? '',
    );
    expect(authHeaders).toHaveLength(1);
    expect(authHeaders[0]).toContain('sk-key-normal');
    expect(authHeaders[0]).not.toContain('sk-key-manual');
    expect(results).toHaveLength(1); // 被跳过的 manual key 不产生结果
    expect(calls).toHaveLength(1);
    expect(calls[0]!.result.status).toBe('ok');
  });

  it('kind 分流：subscription/unknown 打订阅端点 + flash；payg 打按量端点 + -free', async () => {
    const accts: FakeAccountDef[] = [
      { id: 1, name: 'env', kind: 'unknown', retryUntil: 0, keys: ['sk-key-aaaa'] },
      { id: 2, name: 'payg', kind: 'payg', retryUntil: 0, keys: ['sk-key-bbbb'] },
    ];
    const { store } = fakeAccounts(accts);
    const p = acctPool(accts);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await runProbeRound(cfg(), p, null, store, () => {});
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(['https://upstream.test/v1/chat/completions', 'https://payg.test/v1/chat/completions']);
    const models = fetchMock.mock.calls.map(
      (c) => (JSON.parse(String((c[1] as RequestInit).body)) as { model: string }).model,
    );
    expect(models).toEqual([PROBE_MODEL, PAYG_PROBE_MODEL]);
    expect(PAYG_PROBE_MODEL).toBe('deepseek-v4-flash-free');
  });

  it('失败写账：GoUsageLimitError → 账户 cooldown + 上游 reset+60s，pool 按 quota-exhausted 禁用', async () => {
    const accts: FakeAccountDef[] = [{ id: 1, name: 'env', kind: 'unknown', retryUntil: 0, keys: ['sk-key-aaaa'] }];
    const { store, calls } = fakeAccounts(accts);
    const p = acctPool(accts);
    const body = JSON.stringify({
      error: { type: 'GoUsageLimitError', message: 'Weekly usage limit reached. Resets in 2hr 30min.' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 429 })));

    await runProbeRound(cfg(), p, null, store, () => {});
    expect(calls).toHaveLength(1);
    // 分类走 classifyAccountError 的真实返回（§4.2 表）
    expect(calls[0]!.result.status).toBe('cooldown');
    expect(calls[0]!.result.retryUntil).toBe(T0 + 2.5 * 3_600_000 + 60_000);
    expect(calls[0]!.result.detail).toBe('GoUsageLimitError: Weekly usage limit reached. Resets in 2hr 30min.');
    expect(calls[0]!.result.lastProbeAt).toBe(T0);
    // pool 侧与真实流量同一套分类：额度耗尽 → 长冷却禁用
    const snap = p.snapshot().find((s) => s.fingerprint === '****aaaa')!;
    expect(snap.healthy).toBe(false);
    expect(snap.disabledReason).toBe('quota-exhausted');
  });

  it('多 key 账户：每个 key 都探，不只 keys[0]', async () => {
    // 回归（故障 A）：env 种子把整组 OPENSEA_KEYS 塞进一个账户，只探 keys[0]
    // 会让排在后边的 key 从没被验证过 —— 额度已耗尽的 key 会一直挂着 healthy。
    const accts: FakeAccountDef[] = [
      { id: 1, name: 'env', kind: 'unknown', retryUntil: 0, keys: ['sk-key-aaaa', 'sk-key-bbbb'] },
    ];
    const { store, calls } = fakeAccounts(accts);
    const p = acctPool(accts);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await runProbeRound(cfg(), p, null, store, () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 打到的是指定的两个 key（探活不走 least-loaded），不是只打第一个
    const auths = fetchMock.mock.calls.map(
      (c) => ((c[1] as RequestInit).headers as Record<string, string>).authorization,
    );
    expect(auths).toEqual(['Bearer sk-key-aaaa', 'Bearer sk-key-bbbb']);
    // 全过 → 账户 ok，两个 key 都不再是 stale（避免每轮重复探）
    expect(calls[0]!.result.status).toBe('ok');
    const stale = p.staleKeys(1_800_000).map((s) => s.fingerprint);
    expect(stale).not.toContain('****aaaa');
    expect(stale).not.toContain('****bbbb');
  });

  it('多 key 账户：排在后边的 key 额度耗尽也被禁用（不再只探 keys[0]）', async () => {
    // 故障 A 的线上形态：keys[0] 正常、后边某个 key 已 GoUsageLimitError。
    // 修复前 probe 只打 keys[0]，坏 key 永远不被发现、一直 healthy。
    const accts: FakeAccountDef[] = [
      { id: 1, name: 'env', kind: 'unknown', retryUntil: 0, keys: ['sk-key-aaaa', 'sk-key-bbbb'] },
    ];
    const { store } = fakeAccounts(accts);
    const p = acctPool(accts);
    const okBody = JSON.stringify({ choices: [{ message: { content: 'hi' } }] });
    const quotaBody = JSON.stringify({
      error: { type: 'GoUsageLimitError', message: 'Weekly usage limit reached. Resets in 3 days.' },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }))
      .mockResolvedValueOnce(new Response(quotaBody, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    await runProbeRound(cfg(), p, null, store, () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const aaaa = p.snapshot().find((s) => s.fingerprint === '****aaaa')!;
    const bbbb = p.snapshot().find((s) => s.fingerprint === '****bbbb')!;
    // 正常 key 保持健康；额度耗尽的 key 立即被禁用（不等真实流量去踩）
    expect(aaaa.healthy).toBe(true);
    expect(bbbb.healthy).toBe(false);
    expect(bbbb.disabledReason).toBe('quota-exhausted');
    expect(bbbb.recoverInMs).toBeGreaterThan(3 * 86_400_000);
  });

  it('裸 429 限流 → 账户 cooldown + 15min 重探', async () => {
    const accts: FakeAccountDef[] = [{ id: 1, name: 'env', kind: 'unknown', retryUntil: 0, keys: ['sk-key-aaaa'] }];
    const { store, calls } = fakeAccounts(accts);
    const p = acctPool(accts);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));

    await runProbeRound(cfg(), p, null, store, () => {});
    expect(calls[0]!.result.status).toBe('cooldown');
    expect(calls[0]!.result.retryUntil).toBe(T0 + 15 * 60_000);
  });

  it('网络层失败 → 账户 error + 15min 重探；key 只累计失败不立即禁用', async () => {
    const accts: FakeAccountDef[] = [{ id: 1, name: 'env', kind: 'unknown', retryUntil: 0, keys: ['sk-key-aaaa'] }];
    const { store, calls } = fakeAccounts(accts);
    const p = acctPool(accts);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')));

    await runProbeRound(cfg(), p, null, store, () => {});
    expect(calls[0]!.result.status).toBe('error');
    expect(calls[0]!.result.retryUntil).toBe(T0 + 15 * 60_000);
    expect(String(calls[0]!.result.detail)).toContain('ETIMEDOUT');
    // transient 走失败计数：一次失败不到阈值（5），key 保持健康
    expect(p.snapshot().find((s) => s.fingerprint === '****aaaa')!.healthy).toBe(true);
  });

  it('探活模型不支持（401 ModelError）→ 账户不标 error，记 ok + 详情（M-P2-5）', async () => {
    const accts: FakeAccountDef[] = [{ id: 1, name: 'env', kind: 'unknown', retryUntil: 0, keys: ['sk-key-aaaa'] }];
    const { store, calls } = fakeAccounts(accts);
    const p = acctPool(accts);
    const body = JSON.stringify({
      error: { type: 'ModelError', message: 'Model deepseek-v4-flash is not supported' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 401 })));

    await runProbeRound(cfg(), p, null, store, () => {});
    expect(calls).toHaveLength(1);
    // 模型/端点不匹配 ≠ 账户坏：不标 error/cooldown（旧逻辑会标 error 推 15min）
    expect(calls[0]!.result.status).toBe('ok');
    expect(String(calls[0]!.result.detail)).toContain('探活模型不被该账号端点支持');
    // retry 推到空闲窗口（避免每轮重复打无意义的模型探针）
    expect(calls[0]!.result.retryUntil).toBe(T0 + 3_600_000);
    // key 不被 markFailure：保持健康、失败计数不涨
    const snap = p.snapshot().find((s) => s.fingerprint === '****aaaa')!;
    expect(snap.healthy).toBe(true);
    expect(snap.failCount).toBe(0);
    // 被动学习 (account, model) blocked（acctPool 把 key 映射到账户 1）
    expect(p.isModelBlocked(1, PROBE_MODEL)).toBe(true);
  });

  it('日志带账户名与账户级结论：[keyprobe] account=env probe fail 429 cooldown', async () => {
    const accts: FakeAccountDef[] = [{ id: 1, name: 'env', kind: 'unknown', retryUntil: 0, keys: ['sk-key-aaaa'] }];
    const { store } = fakeAccounts(accts);
    const p = acctPool(accts);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));
    const logs: string[] = [];

    await runProbeRound(cfg(), p, null, store, (m) => logs.push(m));
    expect(logs[0]).toContain('[keyprobe] account=env probe fail 429 cooldown');
    expect(logs[0]).toContain('probe 429:');
  });

  it('探活记录落库 endpoint=probe，模型跟 kind 走，落指纹不落明文', async () => {
    const accts: FakeAccountDef[] = [
      { id: 1, name: 'env', kind: 'unknown', retryUntil: 0, keys: ['sk-key-aaaa'] },
      { id: 2, name: 'payg', kind: 'payg', retryUntil: 0, keys: ['sk-key-bbbb'] },
    ];
    const { store } = fakeAccounts(accts);
    const p = acctPool(accts);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const rows: Array<Record<string, unknown>> = [];
    const fakeDb = { recordRequest: (r: Record<string, unknown>) => rows.push(r) };

    await runProbeRound(cfg(), p, fakeDb as never, store, () => {});
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.endpoint === 'probe')).toBe(true);
    expect(rows[0]!.model).toBe(PROBE_MODEL);
    expect(rows[1]!.model).toBe(PAYG_PROBE_MODEL);
    // 落的是指纹不是 key 原文
    expect(rows.every((r) => String(r.keyFingerprint).startsWith('****'))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('sk-key');
  });

  it('accounts 为 null（未接线/数据面降级）时不探、不炸', async () => {
    const accts: FakeAccountDef[] = [{ id: 1, name: 'env', kind: 'unknown', retryUntil: 0, keys: ['sk-key-aaaa'] }];
    const p = acctPool(accts);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runProbeRound(cfg(), p, null, null, () => {})).resolves.toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('纯 OAuth 账号（无 key）走 OAuth 会话探测：refresh→orgs 成功 = ok', async () => {
    const accts: FakeAccountDef[] = [
      { id: 1, name: 'env', kind: 'unknown', retryUntil: 0, keys: ['sk-key-aaaa'] },
      { id: 2, name: 'oauth-acc', kind: 'unknown', retryUntil: 0, keys: [], oauth: 'rt-1' },
    ];
    const { store, calls } = fakeAccounts(accts);
    const p = acctPool(accts);
    // 按 URL 分发：模型探针 200；refresh → access_token；orgs → 200
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/auth/device/token')) {
        return new Response(JSON.stringify({ access_token: 'at-1' }), { status: 200 });
      }
      if (u.includes('/api/orgs')) return new Response('[]', { status: 200 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await runProbeRound(cfg(), p, null, store, () => {});
    // 两个账户都探：env 打模型端点（1 次），oauth-acc 打 refresh + orgs（2 次）
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/auth/device/token'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/orgs'))).toBe(true);
    const oauthCall = calls.find((c) => c.id === 2);
    expect(oauthCall?.result).toEqual({
      status: 'ok',
      detail: null,
      retryUntil: T0 + 3_600_000,
      lastProbeAt: T0,
    });
  });

  it('纯 OAuth 账号 refresh 401 = invalid（会话失效，需重新登录）', async () => {
    const accts: FakeAccountDef[] = [
      { id: 1, name: 'oauth-acc', kind: 'unknown', retryUntil: 0, keys: [], oauth: 'rt-dead' },
    ];
    const { store, calls } = fakeAccounts(accts);
    const p = acctPool(accts);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));

    await runProbeRound(cfg(), p, null, store, () => {});
    const oauthCall = calls.find((c) => c.id === 1);
    expect(oauthCall?.result.status).toBe('invalid');
    expect(String(oauthCall?.result.detail)).toContain('重新登录');
  });

  it('refresh 401 后重读最新 token 重试一次（rotation 竞态不误判 invalid）', async () => {
    const accts: FakeAccountDef[] = [
      { id: 1, name: 'oauth-acc', kind: 'unknown', retryUntil: 0, keys: [], oauth: 'rt-old' },
    ];
    // 可变 store：第一次 refresh 401 后模拟 console 通道已把 token 轮换成 rt-new
    // （refresh token 每次使用即失效，输掉竞态的一方拿旧值必然 invalid_grant）。
    let currentToken = 'rt-old';
    const calls: Array<{ id: number; result: Record<string, unknown> }> = [];
    const store = {
      list: () =>
        accts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, retryUntil: a.retryUntil })),
      keysOf: (id: number): string[] | null => accts.find((a) => a.id === id)?.keys ?? null,
      getOauthRefresh: (): string | null => currentToken,
      setOauthRefresh: (_id: number, t: string | null): boolean => {
        if (t) currentToken = t;
        return true;
      },
      setProbeResult: (id: number, result: Record<string, unknown>) => {
        calls.push({ id, result });
        return true;
      },
    };
    const p = acctPool(accts);
    const refreshTokens: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/auth/device/token')) {
        const body = JSON.parse(String(init?.body)) as { refresh_token: string };
        refreshTokens.push(body.refresh_token);
        if (body.refresh_token === 'rt-old') {
          currentToken = 'rt-new'; // 并发通道已轮换
          return new Response('{}', { status: 401 });
        }
        return new Response(JSON.stringify({ access_token: 'at-1' }), { status: 200 });
      }
      if (u.includes('/api/orgs')) return new Response('[]', { status: 200 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await runProbeRound(cfg(), p, null, store as unknown as AccountsStore, () => {});
    // 两次 refresh：旧 token 401 → 重读最新 token 重试成功
    expect(refreshTokens).toEqual(['rt-old', 'rt-new']);
    const oauthCall = calls.find((c) => c.id === 1);
    expect(oauthCall?.result.status).toBe('ok');
  });

  it('重试仍 401（最新 token 也失效）→ 依旧 invalid，不无限重试', async () => {
    const accts: FakeAccountDef[] = [
      { id: 1, name: 'oauth-acc', kind: 'unknown', retryUntil: 0, keys: [], oauth: 'rt-old' },
    ];
    let currentToken = 'rt-old';
    const calls: Array<{ id: number; result: Record<string, unknown> }> = [];
    const store = {
      list: () =>
        accts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, retryUntil: a.retryUntil })),
      keysOf: (id: number): string[] | null => accts.find((a) => a.id === id)?.keys ?? null,
      getOauthRefresh: (): string | null => currentToken,
      setOauthRefresh: (_id: number, t: string | null): boolean => {
        if (t) currentToken = t;
        return true;
      },
      setProbeResult: (id: number, result: Record<string, unknown>) => {
        calls.push({ id, result });
        return true;
      },
    };
    const p = acctPool(accts);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/auth/device/token')) {
        const body = JSON.parse(String(init?.body)) as { refresh_token: string };
        if (body.refresh_token === 'rt-old') {
          currentToken = 'rt-new';
          return new Response('{}', { status: 401 });
        }
        return new Response('{}', { status: 401 });
      }
      return new Response('{}', { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await runProbeRound(cfg(), p, null, store as unknown as AccountsStore, () => {});
    // 至多两次 refresh（旧值 + 最新值），然后判 invalid，不无限循环
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/auth/device/token'))).toHaveLength(2);
    const oauthCall = calls.find((c) => c.id === 1);
    expect(oauthCall?.result.status).toBe('invalid');
  });

  it('无 key 无 OAuth 的账号不探', async () => {
    const accts: FakeAccountDef[] = [
      { id: 1, name: 'empty', kind: 'unknown', retryUntil: 0, keys: [] },
    ];
    const { store } = fakeAccounts(accts);
    const p = acctPool(accts);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await runProbeRound(cfg(), p, null, store, () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
