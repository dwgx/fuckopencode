import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BILLING_TICK_MS,
  UNITS_PER_DOLLAR,
  fetchAccountBilling,
  parseBillingPage,
  refreshBilling,
  runBillingRound,
  startBillingLoop,
  type BillingAccounts,
  type BillingLoopState,
  type BillingWritePatch,
  type FetchLike,
} from '../src/billing.js';
import type { AppConfig } from '../src/config.js';

/**
 * billing 模块单测。
 *
 * 解析器 fixture 按 MULTI-ACCOUNT.md §5.3 两条正则的形态手工构造 —— 真实页面结构
 * 未实测（见 billing.ts 文件头 TODO spike：上线前拿真实页面固化为 fixture 后，
 * 把这里的样例换成真页面摘录）。
 * 调度器不挂定时器：直接测 runBillingRound（注入 now）；startBillingLoop 只用
 * fake timers 验证接线。
 */

const log = (): void => {};

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    billingIntervalMs: 30 * 60_000,
    billingTimeoutMs: 20_000,
    ...over,
  } as unknown as AppConfig;
}

interface FakeRow {
  id: number;
  name?: string;
  workspaceId?: string | null;
  hasCookie?: boolean;
  cookie?: string | null;
}

/** 假 accounts：list / billingCredential / setBilling 都记录调用，setBilling 记 patch。 */
function fakeAccounts(rows: FakeRow[]) {
  const billingCalls: Array<{ id: number; patch: BillingWritePatch }> = [];
  const accounts: BillingAccounts = {
    list: () =>
      rows.map((r) => ({
        id: r.id,
        name: r.name ?? `acc-${r.id}`,
        workspaceId: r.workspaceId ?? null,
        hasCookie: r.hasCookie ?? (r.cookie != null && r.workspaceId != null),
      })),
    billingCredential: (id) => rows.find((x) => x.id === id)?.cookie ?? null,
    setBilling: (id, patch) => void billingCalls.push({ id, patch }),
  };
  return { accounts, billingCalls };
}

function loopState(bootAt = 1_000_000): BillingLoopState {
  return { bootAt, due: new Map() };
}

const HYD = (json: string): string => `<script>${json}</script>`;

describe('parseBillingPage：主解析（script 水合，§5.3 第一步）', () => {
  it('JSON 引号形态：三个值全命中，units 原样返回', () => {
    const html = `<html><script id="__NEXT_DATA__">{"props":{"pageProps":{"balance":123456789,"monthlyLimit":1000000000,"monthlyUsage":20000000}}}</script></html>`;
    expect(parseBillingPage(html)).toEqual({
      balanceUnits: 123456789,
      monthlyLimitUnits: 1000000000,
      monthlyUsageUnits: 20000000,
    });
  });

  it('无引号 JS 对象形态（水合脚本里常见）', () => {
    const html = HYD('window.__DATA__ = {balance: 5, monthlyLimit: 100, monthlyUsage: 20};');
    expect(parseBillingPage(html)).toEqual({
      balanceUnits: 5,
      monthlyLimitUnits: 100,
      monthlyUsageUnits: 20,
    });
  });

  it('同名 key 多次出现取最后一次（后面的水合状态更完整）', () => {
    expect(parseBillingPage(HYD('{"balance":1,"balance":2}'))).toEqual({ balanceUnits: 2 });
  });

  it('跨多个 script 块合并，后块覆盖前块', () => {
    const html = `<html><script>{"balance":1}</script><script>{"monthlyLimit":2}</script></html>`;
    expect(parseBillingPage(html)).toEqual({ balanceUnits: 1, monthlyLimitUnits: 2 });
  });

  it('只命中部分字段：缺失字段省略（局部更新语义）', () => {
    expect(parseBillingPage(HYD('{"balance":7}'))).toEqual({ balanceUnits: 7 });
  });

  it('主解析命中任何一个值就不再跑兜底（契约：三个值全没找到才兜底）', () => {
    const html = `<script>{"balance":1}</script><div data-slot="monthlyLimit">$10.00</div>`;
    expect(parseBillingPage(html)).toEqual({ balanceUnits: 1 });
  });
});

describe('parseBillingPage：兜底（data-slot dollars，§5.3 第二步）', () => {
  it('三个值全没找到 → data-slot 兜底，dollar 换算成 units', () => {
    const html = `<div data-slot="balance">$1.23</div><div data-slot="monthlyLimit">$10.00</div><div data-slot="monthlyUsage">$2.45</div>`;
    expect(parseBillingPage(html)).toEqual({
      balanceUnits: Math.round(1.23 * UNITS_PER_DOLLAR),
      monthlyLimitUnits: Math.round(10 * UNITS_PER_DOLLAR),
      monthlyUsageUnits: Math.round(2.45 * UNITS_PER_DOLLAR),
    });
  });

  it('$1 = UNITS_PER_DOLLAR（具名常量口径）', () => {
    expect(parseBillingPage('<span data-slot="balance">$1</span>')).toEqual({
      balanceUnits: UNITS_PER_DOLLAR,
    });
  });

  it('千分位 + 两位小数', () => {
    const html = `<div data-slot="balance">$1,234.56</div>`;
    expect(parseBillingPage(html)).toEqual({ balanceUnits: Math.round(1234.56 * UNITS_PER_DOLLAR) });
  });

  it('¥ 符号同样命中', () => {
    const html = `<div data-slot="monthlyLimit">¥12.34</div>`;
    expect(parseBillingPage(html)).toEqual({ monthlyLimitUnits: Math.round(12.34 * UNITS_PER_DOLLAR) });
  });
});

describe('parseBillingPage：合理性校验（§5.3）', () => {
  it('monthlyLimit=0 → 丢弃 limit，balance 保留', () => {
    expect(parseBillingPage(HYD('{"balance":1,"monthlyLimit":0}'))).toEqual({ balanceUnits: 1 });
  });

  it('usage > limit*1.1 → 整组（limit+usage）丢弃', () => {
    const html = HYD('{"monthlyLimit":1000000000,"monthlyUsage":2000000000}');
    expect(parseBillingPage(html)).toBeNull();
  });

  it('usage <= limit*1.1 → 保留', () => {
    const html = HYD('{"monthlyLimit":1000000000,"monthlyUsage":1000000000}');
    expect(parseBillingPage(html)).toEqual({
      monthlyLimitUnits: 1000000000,
      monthlyUsageUnits: 1000000000,
    });
  });

  it('只有 usage 没有 limit → 无法交叉校验，保留 usage', () => {
    expect(parseBillingPage(HYD('{"monthlyUsage":5}'))).toEqual({ monthlyUsageUnits: 5 });
  });

  it('主解析值全被校验丢弃 → 仍走兜底（多一次机会，结果只会更多不会更少）', () => {
    const html = `<script>{"monthlyLimit":0,"monthlyUsage":5}</script><div data-slot="balance">$1</div>`;
    expect(parseBillingPage(html)).toEqual({ balanceUnits: UNITS_PER_DOLLAR });
  });
});

describe('parseBillingPage：上下文约束（C-I1）', () => {
  it('字符串值里的 balance:0 文本（如错误信息）不再被当余额字段覆写真实值', () => {
    // 旧正则无上下文约束：`"insufficient balance:0"` 的字符串值会被正则当
    // balance=0 解析，且出现在真实 balance 之后 → 覆写为 0。
    const html = HYD('{"balance":500000000,"message":"insufficient balance:0"}');
    expect(parseBillingPage(html)).toEqual({ balanceUnits: 500000000 });
  });

  it('字符串值里的 monthlyLimit:9 文本不覆写真实 monthlyLimit', () => {
    const html = HYD('{"balance":5,"monthlyLimit":100,"note":"see monthlyLimit:9"}');
    expect(parseBillingPage(html)).toEqual({ balanceUnits: 5, monthlyLimitUnits: 100 });
  });

  it('跨 script 块：无关块字符串值里的 balance:0 文本不覆写真实水合块', () => {
    const html = `<script>{"balance":500000000}</script><script>{"msg":"insufficient balance:0"}</script>`;
    expect(parseBillingPage(html)).toEqual({ balanceUnits: 500000000 });
  });
});

describe('parseBillingPage：垃圾输入', () => {
  it('空串 / 无 script 文本 → null', () => {
    expect(parseBillingPage('')).toBeNull();
    expect(parseBillingPage('<html><body>plain text</body></html>')).toBeNull();
  });

  it('script 里没有目标 key → null', () => {
    expect(parseBillingPage(HYD('{"foo":1,"bar":2}'))).toBeNull();
  });

  it('data-slot 无货币符号 → 不命中 → null', () => {
    expect(parseBillingPage('<div data-slot="balance">1.23</div>')).toBeNull();
  });
});

describe('fetchAccountBilling', () => {
  it('无 workspaceId → no workspace/cookie，不发请求', async () => {
    const f = vi.fn<FetchLike>();
    const r = await fetchAccountBilling(cfg(), { workspaceId: null, cookie: 'tok' }, f);
    expect(r).toEqual({ ok: false, reason: 'no workspace/cookie' });
    expect(f).not.toHaveBeenCalled();
  });

  it('无 cookie → no workspace/cookie，不发请求', async () => {
    const f = vi.fn<FetchLike>();
    const r = await fetchAccountBilling(cfg(), { workspaceId: 'ws_1', cookie: null }, f);
    expect(r).toEqual({ ok: false, reason: 'no workspace/cookie' });
    expect(f).not.toHaveBeenCalled();
  });

  it('GET 目标 URL + auth cookie / accept / user-agent 头', async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(HYD('{"balance":5}'), { status: 200 }));
    const r = await fetchAccountBilling(cfg(), { workspaceId: 'ws_abc', cookie: 'sekrit' }, f);
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://opencode.ai/workspace/ws_abc/billing');
    const headers = init.headers as Record<string, string>;
    // 旧数据兼容：裸值（不含 `=`）自动补 auth= 前缀。
    expect(headers.cookie).toBe('auth=sekrit');
    expect(headers.accept).toBe('text/html');
    expect(headers['user-agent']).toBe('fuckopencode/0.1');
  });

  it('完整 name=value cookie 原样发送（__Host- 前缀不再剥，B1）', async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(HYD('{"balance":5}'), { status: 200 }));
    const r = await fetchAccountBilling(
      cfg(),
      { workspaceId: 'ws_abc', cookie: '__Host-console_session=Fe26.2*abc' },
      f,
    );
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://opencode.ai/workspace/ws_abc/billing');
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toBe('__Host-console_session=Fe26.2*abc');
  });

  it('已带 auth= 前缀的完整串原样发送，不重复拼前缀', async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(HYD('{"balance":5}'), { status: 200 }));
    const r = await fetchAccountBilling(cfg(), { workspaceId: 'ws_1', cookie: 'auth=tok' }, f);
    expect(r.ok).toBe(true);
    const init = f.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toBe('auth=tok');
  });

  it('非 2xx → 失败，reason 只有状态码（响应体绝不进结果）', async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response('sk-ant-secret-value-and-other-account-data', { status: 500 }));
    const r = await fetchAccountBilling(cfg(), { workspaceId: 'ws_1', cookie: 'tok' }, f);
    expect(r).toEqual({ ok: false, reason: 'status 500' });
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('2xx + 页面可解析 → ok + result', async () => {
    const f = vi.fn<FetchLike>().mockResolvedValue(new Response(HYD('{"balance":7}'), { status: 200 }));
    const r = await fetchAccountBilling(cfg(), { workspaceId: 'ws_1', cookie: 'tok' }, f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toEqual({ balanceUnits: 7 });
  });

  it('2xx + 页面解析不出 → parse failed', async () => {
    const f = vi.fn<FetchLike>().mockResolvedValue(new Response('<html>nothing here</html>', { status: 200 }));
    const r = await fetchAccountBilling(cfg(), { workspaceId: 'ws_1', cookie: 'tok' }, f);
    expect(r).toEqual({ ok: false, reason: 'parse failed' });
  });

  it('网络异常 → fetch failed，不抛（调度器可安全处理）', async () => {
    const f = vi.fn<FetchLike>().mockRejectedValue(new Error('ETIMEDOUT'));
    const r = await fetchAccountBilling(cfg(), { workspaceId: 'ws_1', cookie: 'tok' }, f);
    expect(r).toEqual({ ok: false, reason: 'fetch failed: ETIMEDOUT' });
  });
});

describe('runBillingRound：调度', () => {
  it('首轮错峰：id 不同错开，到期才抓（§5.4 bootAt + 15s + id*25s）', async () => {
    const { accounts } = fakeAccounts([
      { id: 0, workspaceId: 'ws_0', cookie: 'c0' },
      { id: 1, workspaceId: 'ws_1', cookie: 'c1' },
    ]);
    const f = vi.fn<FetchLike>().mockResolvedValue(new Response(HYD('{"balance":1}'), { status: 200 }));
    const st = loopState(1_000); // id0 到期 16000，id1 到期 41000
    await runBillingRound(cfg(), accounts, st, () => 20_000, log, f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toContain('ws_0');
    await runBillingRound(cfg(), accounts, st, () => 42_000, log, f);
    expect(f).toHaveBeenCalledTimes(2);
    expect(String(f.mock.calls[1]![0])).toContain('ws_1');
  });

  it('成功：setBilling 部分更新 + lastBillingAt；interval 内不重复抓', async () => {
    const { accounts, billingCalls } = fakeAccounts([{ id: 0, workspaceId: 'ws_0', cookie: 'c0' }]);
    const f = vi.fn<FetchLike>().mockResolvedValue(new Response(HYD('{"balance":7}'), { status: 200 }));
    const st = loopState(0); // id0 到期 15000
    await runBillingRound(cfg(), accounts, st, () => 16_000, log, f);
    expect(billingCalls).toHaveLength(1);
    expect(billingCalls[0]!.id).toBe(0);
    expect(billingCalls[0]!.patch).toEqual({ balanceUnits: 7, lastBillingAt: 16_000 });
    await runBillingRound(cfg(), accounts, st, () => 16_000 + 29 * 60_000, log, f);
    expect(f).toHaveBeenCalledTimes(1);
    await runBillingRound(cfg(), accounts, st, () => 16_000 + 31 * 60_000, log, f);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('失败退避：15 → 30 → 60 → 120min 封顶（§5.4）', async () => {
    const { accounts } = fakeAccounts([{ id: 0, workspaceId: 'ws_0', cookie: 'c0' }]);
    const f = vi.fn<FetchLike>().mockResolvedValue(new Response('nope', { status: 500 }));
    const st = loopState(0);
    let t = 15_000;
    for (let i = 0; i < 6; i++) {
      await runBillingRound(cfg(), accounts, st, () => t, log, f);
      const backoff = [15, 30, 60, 120, 120, 120][i]! * 60_000;
      expect(st.due.get(0)!.nextDueAt).toBe(t + backoff);
      t = st.due.get(0)!.nextDueAt;
    }
    expect(f).toHaveBeenCalledTimes(6);
  });

  it('成功重置退避：失败一次后成功，下次失败回到 15min', async () => {
    const { accounts } = fakeAccounts([{ id: 0, workspaceId: 'ws_0', cookie: 'c0' }]);
    const fail = vi.fn<FetchLike>().mockResolvedValue(new Response('nope', { status: 500 }));
    const ok = vi.fn<FetchLike>().mockResolvedValue(new Response(HYD('{"balance":1}'), { status: 200 }));
    const st = loopState(0);
    await runBillingRound(cfg(), accounts, st, () => 15_000, log, fail); // 失败 → 退避 15min
    expect(st.due.get(0)!.nextDueAt).toBe(15_000 + 15 * 60_000);
    await runBillingRound(cfg(), accounts, st, () => 15_000 + 15 * 60_000, log, ok); // 到期，成功
    expect(st.due.get(0)!.nextDueAt).toBe(15_000 + 15 * 60_000 + 30 * 60_000); // 回到正常 interval
    await runBillingRound(cfg(), accounts, st, () => 15_000 + 45 * 60_000, log, fail); // 再失败
    expect(st.due.get(0)!.nextDueAt).toBe(15_000 + 45 * 60_000 + 15 * 60_000); // 回到 15min 而非 30min
  });

  it('无 workspaceId / 无 cookie 的账户：跳过不抓、不算失败，按正常间隔排下次', async () => {
    const { accounts } = fakeAccounts([
      { id: 0, workspaceId: null, cookie: 'c0' }, // 有 cookie 没 workspace
      { id: 1, workspaceId: 'ws_1' },             // 有 workspace 没 cookie
      { id: 2, workspaceId: 'ws_2', cookie: 'c2' },
    ]);
    const f = vi.fn<FetchLike>().mockResolvedValue(new Response(HYD('{"balance":1}'), { status: 200 }));
    const st = loopState(0);
    await runBillingRound(cfg(), accounts, st, () => 10_000_000, log, f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toContain('ws_2');
    expect(st.due.get(0)!.nextDueAt).toBe(10_000_000 + 30 * 60_000);
    expect(st.due.get(1)!.nextDueAt).toBe(10_000_000 + 30 * 60_000);
  });

  it('billingCredential 返回 null（解密失败）→ 跳过不抓', async () => {
    const { accounts } = fakeAccounts([{ id: 0, workspaceId: 'ws_0', hasCookie: true }]); // 无 cookie 原文
    const f = vi.fn<FetchLike>();
    const st = loopState(0);
    await runBillingRound(cfg(), accounts, st, () => 20_000, log, f);
    expect(f).not.toHaveBeenCalled();
    expect(st.due.get(0)!.nextDueAt).toBe(20_000 + 30 * 60_000);
  });

  it('accounts 未接线（null）→ no-op', async () => {
    const f = vi.fn<FetchLike>();
    await runBillingRound(cfg(), null, loopState(0), () => 99_999_999, log, f);
    expect(f).not.toHaveBeenCalled();
  });

  it('无账户（list 为空）→ no-op', async () => {
    const { accounts } = fakeAccounts([]);
    const f = vi.fn<FetchLike>();
    await runBillingRound(cfg(), accounts, loopState(0), () => 99_999_999, log, f);
    expect(f).not.toHaveBeenCalled();
  });

  it('billingIntervalMs=0（关闭）→ no-op', async () => {
    const { accounts } = fakeAccounts([{ id: 0, workspaceId: 'ws_0', cookie: 'c0' }]);
    const f = vi.fn<FetchLike>();
    await runBillingRound(cfg({ billingIntervalMs: 0 }), accounts, loopState(0), () => 99_999_999, log, f);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('startBillingLoop：定时器接线', () => {
  afterEach(() => vi.useRealTimers());

  it('accounts 未接线 → no-op（推进时间不抓）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const f = vi.fn<FetchLike>();
    const stop = startBillingLoop(cfg(), null, log, f);
    await vi.advanceTimersByTimeAsync(BILLING_TICK_MS * 3);
    expect(f).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it('billingIntervalMs=0（关闭）→ no-op', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const f = vi.fn<FetchLike>();
    const { accounts } = fakeAccounts([{ id: 0, workspaceId: 'ws_0', cookie: 'c0' }]);
    const stop = startBillingLoop(cfg({ billingIntervalMs: 0 }), accounts, log, f);
    await vi.advanceTimersByTimeAsync(BILLING_TICK_MS * 3);
    expect(f).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it('15min tick：到期抓取 + setBilling；interval 内不重复；stop 后不再抓', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { accounts, billingCalls } = fakeAccounts([{ id: 0, workspaceId: 'ws_0', cookie: 'c0' }]);
    const f = vi.fn<FetchLike>().mockResolvedValue(new Response(HYD('{"balance":3}'), { status: 200 }));
    const stop = startBillingLoop(cfg(), accounts, log, f);

    await vi.advanceTimersByTimeAsync(BILLING_TICK_MS + 1_000); // 首 tick：id0 已到期（boot+15s）
    expect(f).toHaveBeenCalledTimes(1);
    expect(billingCalls).toHaveLength(1);
    expect(billingCalls[0]!.patch.balanceUnits).toBe(3);

    await vi.advanceTimersByTimeAsync(BILLING_TICK_MS); // 距上次抓取 15min < 30min → 不抓
    expect(f).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(BILLING_TICK_MS); // 距上次抓取 30min → 再抓
    expect(f).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(BILLING_TICK_MS * 2);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('refreshBilling：手动刷新（/__admin 用）', () => {
  it('成功：立即抓取并写账（绕过 nextDueAt）', async () => {
    const { accounts, billingCalls } = fakeAccounts([
      { id: 1, name: 'env', workspaceId: 'ws_1', cookie: 'c1' },
    ]);
    const f = vi.fn<FetchLike>().mockResolvedValue(new Response(HYD('{"balance":9}'), { status: 200 }));
    const r = await refreshBilling(cfg(), accounts, 1, log, f);
    expect(r.ok).toBe(true);
    expect(billingCalls).toHaveLength(1);
    expect(billingCalls[0]!.id).toBe(1);
    expect(billingCalls[0]!.patch.balanceUnits).toBe(9);
    expect(typeof billingCalls[0]!.patch.lastBillingAt).toBe('number');
  });

  it('无 cookie → no workspace/cookie，不写账', async () => {
    const { accounts, billingCalls } = fakeAccounts([{ id: 1, workspaceId: 'ws_1' }]);
    const f = vi.fn<FetchLike>();
    const r = await refreshBilling(cfg(), accounts, 1, log, f);
    expect(r).toEqual({ ok: false, reason: 'no workspace/cookie' });
    expect(billingCalls).toHaveLength(0);
    expect(f).not.toHaveBeenCalled();
  });

  it('账户不存在 → account not found', async () => {
    const { accounts } = fakeAccounts([]);
    const f = vi.fn<FetchLike>();
    const r = await refreshBilling(cfg(), accounts, 42, log, f);
    expect(r).toEqual({ ok: false, reason: 'account not found' });
    expect(f).not.toHaveBeenCalled();
  });

  it('抓取失败透传（status）', async () => {
    const { accounts, billingCalls } = fakeAccounts([{ id: 1, workspaceId: 'ws_1', cookie: 'c1' }]);
    const f = vi.fn<FetchLike>().mockResolvedValue(new Response('x', { status: 403 }));
    const r = await refreshBilling(cfg(), accounts, 1, log, f);
    expect(r).toEqual({ ok: false, reason: 'status 403' });
    expect(billingCalls).toHaveLength(0);
  });
});

describe('main.ts 不再启动 billing SSR 调度循环（后台 M5）', () => {
  it('main.ts 不 import billing 模块/startBillingLoop（新版控制台是 SPA，SSR 解析恒 parse failed，调度循环只剩噪音 + 可能覆写 console 通道写的余额）', () => {
    const mainSrc = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
    // 断言 import 层面（注释可以引用旧名，import 不能复活）——main.ts 已不需要
    // billing.ts 的任何导出（SSR 手动刷新兜底路径由 admin.ts 直接接 refreshBilling）。
    expect(mainSrc).not.toMatch(/import\s*\{[^}]*startBillingLoop/);
    expect(mainSrc).not.toContain("from './billing.js'");
  });
});
