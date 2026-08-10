import { describe, expect, it, vi } from 'vitest';
import { KeyPool } from '../src/keypool.js';
import { PROBE_MODEL, probeKey, runProbeRound } from '../src/keyprobe.js';
import type { AppConfig } from '../src/config.js';

/**
 * 探活的价值在于「面板说可用，但真的可用吗」。
 *
 * 所以这些测试盯两件事：
 * 1. 别浪费额度 —— 只探健康且空闲的 key
 * 2. 结论要和真实流量一致 —— 探活失败该禁用就禁用，用同一套分类
 */

const KEYS = ['sk-key-aaaa', 'sk-key-bbbb'];

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    anthropicBaseUrl: 'https://upstream.test',
    keyProbeIdleMs: 1_800_000,
    keyProbeTimeoutMs: 5_000,
    keyProbeIntervalMs: 1_800_000,
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

    const r = await probeKey(cfg(), p, 'sk-key-aaaa', '****aaaa', 5_000);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    // 探完就不再是 stale
    expect(p.staleKeys(1_800_000).map((s) => s.fingerprint)).not.toContain('****aaaa');
    vi.unstubAllGlobals();
  });

  it('用最小 token 的 deepseek-v4-flash（不乱用别的模型、不浪费额度）', async () => {
    const p = pool(() => 1_000_000);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await probeKey(cfg(), p, 'sk-key-aaaa', '****aaaa', 5_000);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(PROBE_MODEL);
    expect(PROBE_MODEL).toBe('deepseek-v4-flash');
    expect(body.max_tokens).toBe(1);
    expect(body.stream).toBe(false);
    vi.unstubAllGlobals();
  });

  it('探活打到指定的那个 key，不走 least-loaded', async () => {
    const p = pool(() => 1_000_000);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await probeKey(cfg(), p, 'sk-key-bbbb', '****bbbb', 5_000);
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

    const r = await probeKey(cfg(), p, 'sk-key-aaaa', '****aaaa', 5_000);
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

    const r = await probeKey(cfg(), p, 'sk-key-aaaa', '****aaaa', 5_000);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('transient');
    expect(r.status).toBe(0);
    // failThreshold = 5，一次失败不该禁用
    const snap = p.snapshot().find((s) => s.fingerprint === '****aaaa')!;
    expect(snap.healthy).toBe(true);
    expect(snap.failCount).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe('runProbeRound：整轮行为', () => {
  it('探活记录落库时 endpoint=probe，不和真实流量混淆', async () => {
    const p = pool(() => 1_000_000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    const rows: Array<Record<string, unknown>> = [];
    const fakeDb = { recordRequest: (r: Record<string, unknown>) => rows.push(r) };

    await runProbeRound(cfg(), p, fakeDb as never, () => {});
    expect(rows.length).toBe(2); // 两个 key 都从未使用过
    expect(rows.every((r) => r.endpoint === 'probe')).toBe(true);
    expect(rows.every((r) => r.model === PROBE_MODEL)).toBe(true);
    // 落的是指纹不是 key 原文
    expect(rows.every((r) => String(r.keyFingerprint).startsWith('****'))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('sk-key');
    vi.unstubAllGlobals();
  });

  it('没有 stale key 时一个请求都不发（不浪费额度）', async () => {
    let t = 1_000_000;
    const p = pool(() => t);
    for (const k of KEYS) {
      p.markSuccess(k);
      p.release(k);
    }
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const results = await runProbeRound(cfg(), p, null, () => {});
    expect(results).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('db 为 null 时不炸（持久化降级了也要能探活）', async () => {
    const p = pool(() => 1_000_000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await expect(runProbeRound(cfg(), p, null, () => {})).resolves.toHaveLength(2);
    vi.unstubAllGlobals();
  });
});
