import { describe, expect, it, vi } from 'vitest';
import {
  CACHE_TTL_MS,
  MODEL_PRICING_TTL_MS,
  TIMEOUT_MS,
  ConsoleClient,
  microCentsToDollars,
  type ConsoleAccounts,
} from '../src/console.js';
import type { AppConfig } from '../src/config.js';
import type { FetchLike } from '../src/billing.js';

/**
 * ConsoleClient 单测（fake fetch 注入，不打上游）。
 *
 * 响应形状与 spike 实测 fixture（/tmp/fixtures/console-apis.json）对应：
 * billing_status / auto_recharge / members / usage_summary 的用例直接复刻
 * fixture 里的字段（microCents 为字符串）。
 */

const log = (): void => {};

function cfg(): AppConfig {
  return {
    oauthConsoleUrl: 'https://console.opencode.ai',
  } as unknown as AppConfig;
}

function fakeAccounts(): ConsoleAccounts {
  return {
    cookieOf: (id) => (id === 1 ? 'cookie-1' : null),
    workspaceIdOf: (id) => (id === 1 ? 'ws-1' : null),
    getOauthRefresh: () => null,
    setOauthRefresh: () => true,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface CapturedReq {
  method: string;
  url: string;
  cookie: string | null;
  authorization: string | null;
  orgId: string | null;
  accept: string | null;
  body: unknown;
}

/** fake fetch：记录每次调用（含解析后的 headers/body），按 handler 出响应。
 *  handler 可返回 Promise（竞态测试需要挂起读）。 */
function fakeFetch(handler: (req: CapturedReq) => Response | Promise<Response>): { f: FetchLike; reqs: CapturedReq[] } {
  const reqs: CapturedReq[] = [];
  const f: FetchLike = async (input, init) => {
    const headers = new Headers(init.headers);
    const req: CapturedReq = {
      method: init.method ?? 'GET',
      url: input,
      cookie: headers.get('cookie'),
      authorization: headers.get('authorization'),
      orgId: headers.get('x-org-id'),
      accept: headers.get('accept'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    };
    reqs.push(req);
    return handler(req);
  };
  return { f, reqs };
}

// ---------------------------------------------------------------------------
// 单位换算（microCents → dollars）
// ---------------------------------------------------------------------------

describe('microCentsToDollars', () => {
  it('字符串入参兼容（fixture 实测金额是字符串）', () => {
    expect(microCentsToDollars('0')).toBe(0);
    expect(microCentsToDollars('150000000')).toBe(1.5);
    expect(microCentsToDollars('100000000')).toBe(1);
  });

  it('数字入参同口径，保留 2 位', () => {
    expect(microCentsToDollars(100_000_000)).toBe(1);
    expect(microCentsToDollars(1)).toBe(0);
    expect(microCentsToDollars(1_234_567_890)).toBe(12.35);
  });

  it('非法输入返回 NaN', () => {
    expect(Number.isNaN(microCentsToDollars('abc'))).toBe(true);
    expect(Number.isNaN(microCentsToDollars(Number.NaN))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 读端点：解析 / headers / 失败
// ---------------------------------------------------------------------------

describe('ConsoleClient 读端点', () => {
  it('billingStatus 解析 fixture 形状，请求带 cookie + x-org-id + accept', async () => {
    const fixture = {
      billingMode: 'prepaid',
      balanceMicroCents: '0',
      availableMicroCents: '0',
      canEnableAutoRecharge: true,
    };
    const { f, reqs } = fakeFetch(() => jsonResponse(200, fixture));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    const data = await client.billingStatus(1);

    expect(data).toEqual(fixture);
    expect(reqs[0]!.method).toBe('GET');
    expect(reqs[0]!.url).toBe('https://console.opencode.ai/api/billing/status');
    expect(reqs[0]!.cookie).toBe('cookie-1');
    expect(reqs[0]!.orgId).toBe('ws-1');
    expect(reqs[0]!.accept).toBe('application/json');
  });

  it('usageSummary 带 rangeDays 参数；不同参数是不同缓存键', async () => {
    const { f, reqs } = fakeFetch(() => jsonResponse(200, { totalCostMicroCents: '0' }));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    await client.usageSummary(1, 7);
    await client.usageSummary(1, 30);
    await client.usageSummary(1, 7);

    expect(reqs.map((r) => r.url)).toEqual([
      'https://console.opencode.ai/api/usage/summary?rangeDays=7',
      'https://console.opencode.ai/api/usage/summary?rangeDays=30',
    ]);
  });

  it('members/serviceAccounts 带 pageSize 参数', async () => {
    const { f, reqs } = fakeFetch(() => jsonResponse(200, { items: [] }));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    await client.members(1, 5);
    await client.serviceAccounts(1, 3);

    expect(reqs[0]!.url).toBe('https://console.opencode.ai/api/members?pageSize=5');
    expect(reqs[1]!.url).toBe('https://console.opencode.ai/api/service-accounts?pageSize=3');
  });

  it('非 2xx 返回 null + 日志只记状态码', async () => {
    const logs: string[] = [];
    const { f } = fakeFetch(() => new Response('oops', { status: 500 }));
    const client = new ConsoleClient(cfg(), fakeAccounts(), (m) => logs.push(m), { fetchImpl: f });

    expect(await client.billingStatus(1)).toBeNull();
    expect(logs.join()).toContain('status 500');
  });

  it('响应不是 JSON 返回 null + parse failed 日志', async () => {
    const logs: string[] = [];
    const { f } = fakeFetch(() => new Response('<html>not json</html>', { status: 200 }));
    const client = new ConsoleClient(cfg(), fakeAccounts(), (m) => logs.push(m), { fetchImpl: f });

    expect(await client.billingStatus(1)).toBeNull();
    expect(logs.join()).toContain('parse failed');
  });

  it('无 cookie/workspace 直接返回 null，不打网络', async () => {
    const f = vi.fn<FetchLike>();
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    expect(await client.billingStatus(2)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('完整 name=value cookie（__Host- 前缀）原样进请求头（B1）', async () => {
    const { f, reqs } = fakeFetch(() => jsonResponse(200, {}));
    const accounts: ConsoleAccounts = {
      cookieOf: () => '__Host-console_session=Fe26.2*abc',
      workspaceIdOf: (id) => (id === 1 ? 'ws-1' : null),
      getOauthRefresh: () => null,
      setOauthRefresh: () => true,
    };
    const client = new ConsoleClient(cfg(), accounts, log, { fetchImpl: f });

    await client.billingStatus(1);
    expect(reqs[0]!.cookie).toBe('__Host-console_session=Fe26.2*abc');
  });

  it('超时返回 null（AbortSignal 触发）', async () => {
    const logs: string[] = [];
    const f: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        // 模拟真实 fetch：signal abort 时拒绝（真实网络会因超时断开）。
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = new ConsoleClient(cfg(), fakeAccounts(), (m) => logs.push(m), {
      fetchImpl: f,
      timeoutMs: 5,
    });

    expect(await client.billingStatus(1)).toBeNull();
    expect(logs.join()).toContain('fetch failed');
  });
});

// ---------------------------------------------------------------------------
// P0 数据端点（cost-by-day / usage models+users / budgets users-status / v2-config）
// 请求路径与响应形状对齐线上真实实测（range 只认 24h/7d/30d、since ISO、bucket day|hour）。
// ---------------------------------------------------------------------------

describe('ConsoleClient P0 数据端点', () => {
  it('usageCostByDay：range=7d + since(ISO UTC) + bucket=day + 鉴权头', async () => {
    const { f, reqs } = fakeFetch(() => jsonResponse(200, []));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    await client.usageCostByDay(1, 7);

    expect(reqs[0]!.method).toBe('GET');
    expect(reqs[0]!.url).toMatch(
      /^https:\/\/console\.opencode\.ai\/api\/usage\/cost-by-day\?range=7d&since=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z&bucket=day$/,
    );
    expect(reqs[0]!.cookie).toBe('cookie-1');
    expect(reqs[0]!.orgId).toBe('ws-1');
  });

  it('usageCostByDay：rangeDays=1 → 24h；bucket=hour 透传', async () => {
    const { f, reqs } = fakeFetch(() => jsonResponse(200, []));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    await client.usageCostByDay(1, 1, 'hour');

    expect(reqs[0]!.url).toMatch(/^https:\/\/console\.opencode\.ai\/api\/usage\/cost-by-day\?range=24h&since=.*&bucket=hour$/);
  });

  it('usageCostByDay：since 每次在变但缓存键只含 rangeDays+bucket（TTL 内命中）', async () => {
    let t = 1000;
    const { f, reqs } = fakeFetch(() => jsonResponse(200, []));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f, ttlMs: 30_000, now: () => t });

    await client.usageCostByDay(1, 7);
    t += 1000; // since 漂移 1s —— 不得变成新缓存键
    await client.usageCostByDay(1, 7);
    expect(reqs.length).toBe(1);

    t += 31_000; // 过 TTL → 重新打上游（since 也同步推进）
    await client.usageCostByDay(1, 7);
    expect(reqs.length).toBe(2);
    expect(reqs[1]!.url).not.toBe(reqs[0]!.url); // since 确实变了
  });

  it('usageCostByDay：rangeDays 超档就近取档（5 → 7d，14 → 30d）', async () => {
    const { f, reqs } = fakeFetch(() => jsonResponse(200, []));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    await client.usageCostByDay(1, 5);
    await client.usageCostByDay(1, 14);

    expect(reqs[0]!.url).toContain('range=7d');
    expect(reqs[1]!.url).toContain('range=30d');
  });

  it('usageModels / usageUsers：range + since + pageSize=100；{items,pageInfo} 解析', async () => {
    const payload = {
      items: [{ model: 'deepseek-v4-flash', totalCostMicroCents: '0', totalRequests: '1' }],
      pageInfo: { page: 1, pageSize: 100, total: 1, pageCount: 1 },
    };
    const { f, reqs } = fakeFetch(() => jsonResponse(200, payload));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    expect(await client.usageModels(1, 7)).toEqual(payload);
    expect(await client.usageUsers(1, 30)).toEqual(payload);

    expect(reqs[0]!.url).toMatch(/^https:\/\/console\.opencode\.ai\/api\/usage\/models\?range=7d&since=.*&pageSize=100$/);
    expect(reqs[1]!.url).toMatch(/^https:\/\/console\.opencode\.ai\/api\/usage\/users\?range=30d&since=.*&pageSize=100$/);
  });

  it('budgetsUsersStatus：路径 + fixture 形状原样解析', async () => {
    const payload = [
      {
        scope: 'user',
        userId: 'user_01KZPQ6GSB0GRQ5DW4686KFWPG',
        email: 'dwgx1337@outlook.com',
        limitMicroCents: null,
        spentMicroCents: '0',
        exceeded: false,
        resetsAt: '2026-09-01T00:00:00.000Z',
        source: null,
        updatedAt: null,
      },
    ];
    const { f, reqs } = fakeFetch(() => jsonResponse(200, payload));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    expect(await client.budgetsUsersStatus(1)).toEqual(payload);
    expect(reqs[0]!.url).toBe('https://console.opencode.ai/api/budgets/users/status');
  });

  it('modelPricing：/api/v2/config + 10 分钟长 TTL（低频数据不吃 30s 默认档）', async () => {
    expect(MODEL_PRICING_TTL_MS).toBe(600_000);
    let t = 0;
    const { f, reqs } = fakeFetch(() => jsonResponse(200, { providers: { opencode: { models: {} } } }));
    // 实例 TTL 故意设 1s：modelPricing 必须用自己的长 TTL，而不是实例的。
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f, ttlMs: 1_000, now: () => t });

    await client.modelPricing(1);
    t = 9 * 60_000; // 9 分钟：远超实例 TTL，仍应命中
    await client.modelPricing(1);
    expect(reqs.length).toBe(1);

    t = 10 * 60_000 + 1; // 10 分钟 + 1ms：过期
    await client.modelPricing(1);
    expect(reqs.length).toBe(2);
    expect(reqs[0]!.url).toBe('https://console.opencode.ai/api/v2/config');
  });

  it('P0 端点失败分类与既有读端点一致：401 → null + invalid；5xx → null + upstream', async () => {
    const logs: string[] = [];
    let status = 401;
    const { f } = fakeFetch(() => jsonResponse(status, {}));
    const client = new ConsoleClient(cfg(), fakeAccounts(), (m) => logs.push(m), { fetchImpl: f });

    expect(await client.usageCostByDay(1, 7)).toBeNull();
    expect(client.cookieStatus(1)).toBe('invalid');
    expect(logs.length).toBe(0); // auth 失败静默

    const logs2: string[] = [];
    const { f: f2 } = fakeFetch(() => new Response('err', { status: 502 }));
    const c2 = new ConsoleClient(cfg(), fakeAccounts(), (m) => logs2.push(m), { fetchImpl: f2 });

    expect(await client.budgetsUsersStatus(1)).toBeNull();
    expect(await c2.modelPricing(1)).toBeNull();
    expect(c2.cookieStatus(1)).toBe('ok');
    expect(c2.lastError(1)).toBe('upstream');
  });

  it('P0 端点无 cookie/workspace 直接返回 null，不打网络', async () => {
    const f = vi.fn<FetchLike>();
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    expect(await client.usageModels(2, 7)).toBeNull();
    expect(await client.usageUsers(2, 7)).toBeNull();
    expect(await client.budgetsUsersStatus(2)).toBeNull();
    expect(await client.modelPricing(2)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

describe('ConsoleClient 缓存', () => {
  it('TTL 内命中缓存，过期后重新打上游', async () => {
    let t = 0;
    const { f, reqs } = fakeFetch(() => jsonResponse(200, { balanceMicroCents: '0' }));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, {
      fetchImpl: f,
      ttlMs: 1000,
      now: () => t,
    });

    await client.billingStatus(1);
    await client.billingStatus(1);
    expect(reqs.length).toBe(1);

    t = 1001;
    await client.billingStatus(1);
    expect(reqs.length).toBe(2);
  });

  it('默认 TTL 30s，常量可断言', () => {
    expect(CACHE_TTL_MS).toBe(30_000);
    expect(TIMEOUT_MS).toBe(15_000);
  });

  it('写操作成功后失效该账户读缓存', async () => {
    const { f, reqs } = fakeFetch(() => jsonResponse(200, { enabled: false }));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    await client.autoRecharge(1); // 打上游并缓存
    await client.setAutoRecharge(1, { enabled: true, thresholdDollars: 5, rechargeAmountDollars: 20 });
    await client.autoRecharge(1); // 缓存已被写操作失效 → 重新打上游

    expect(reqs.length).toBe(3);
  });

  it('invalidate 后挂起的旧读响应不写回缓存（M2 竞态）', async () => {
    // 第一次读被 gate 挂起；invalidate 之后才释放 —— 模拟「写操作成功 →
    // 失效缓存 → 旧读响应姗姗来迟」的时序。
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { f, reqs } = fakeFetch(async () => {
      await gate;
      return jsonResponse(200, { balanceMicroCents: '999' });
    });
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    const pending = client.billingStatus(1); // 挂起读
    client.invalidate(1); // 写操作成功路径
    release();
    await pending;

    // 旧响应若写回缓存，第二次读会命中缓存不再打上游；正确行为是重新打。
    await client.billingStatus(1);
    expect(reqs.length).toBe(2);
  });

  it('noteCredentialChanged（换 cookie / 切换 workspace）失效读缓存，下次读重新打上游', async () => {
    // 面板切换 workspace = PATCH workspaceId → noteCredentialChanged。读缓存键
    // 不含 workspaceId，若不清缓存，切完的 30s TTL 内仍返回旧 workspace 的数据。
    const { f, reqs } = fakeFetch(() => jsonResponse(200, { balanceMicroCents: '100000000' }));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    await client.billingStatus(1); // 打上游并缓存
    await client.billingStatus(1); // 命中缓存
    client.noteCredentialChanged(1);
    await client.billingStatus(1); // 缓存已失效 → 重新打上游

    expect(reqs.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 健康态（cookie 失效标记）
// ---------------------------------------------------------------------------

describe('ConsoleClient 健康态', () => {
  it('401 立即标记 cookie 失效且不打日志；随后（cookie 失效→走 Bearer）恢复', async () => {
    const logs: string[] = [];
    let status = 401;
    const { f } = fakeFetch(() => jsonResponse(status, {}));
    // fakeAccounts 无 oauth：invalid 后走 Bearer 无凭据 → null（日志「no cookie/oauth」）
    const client = new ConsoleClient(cfg(), fakeAccounts(), (m) => logs.push(m), { fetchImpl: f });

    expect(await client.billingStatus(1)).toBeNull();
    expect(client.cookieStatus(1)).toBe('invalid');

    // 有 oauth 的账户：cookie 失效后回退 Bearer（审查 m3：auth cookie 对新版 API
    // 无效时不得锁死通道）——refresh → Bearer 请求 → 成功恢复。
    const logs2: string[] = [];
    let oauth = 'rt-1';
    const accounts: ConsoleAccounts = {
      cookieOf: () => 'auth=legacy-only-cookie', // 旧版 auth（对新版 API 无效）
      workspaceIdOf: () => 'ws-1',
      getOauthRefresh: () => oauth,
      setOauthRefresh: () => true,
    };
    const calls: string[] = [];
    const f2 = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push(url.split('?')[0] ?? url);
      if (url.includes('/auth/device/token')) {
        return jsonResponse(200, { access_token: 'at-1', refresh_token: 'rt-2' });
      }
      return jsonResponse(status, {});
    }) as FetchLike;
    const c2 = new ConsoleClient(cfg(), accounts, (m) => logs2.push(m), { fetchImpl: f2 });
    expect(await c2.billingStatus(1)).toBeNull(); // cookie 401 → invalid
    expect(c2.cookieStatus(1)).toBe('invalid');
    status = 200;
    expect(await c2.billingStatus(1)).toEqual({}); // invalid → 回退 Bearer → 恢复
    expect(c2.cookieStatus(1)).toBe('ok');
    expect(calls.some((c) => c.includes('/auth/device/token'))).toBe(true); // 真走了 Bearer
  });

  it('403 同样标记失效', async () => {
    const { f } = fakeFetch(() => jsonResponse(403, {}));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    await client.billingStatus(1);
    expect(client.cookieStatus(1)).toBe('invalid');
  });

  it('连续非 401 失败不再判定 cookie 失效（只有 auth 失败置 invalid，M-6）', async () => {
    const { f } = fakeFetch(() => new Response('err', { status: 500 }));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    await client.billingStatus(1);
    await client.billingStatus(1);
    await client.billingStatus(1);
    expect(client.cookieStatus(1)).toBe('ok');
    // 失败原因仍要可观测（面板区分「合法 null」与「真实失败」）。
    expect(client.lastError(1)).toBe('upstream');

    // 401 依旧一次即失效。
    const { f: f401 } = fakeFetch(() => new Response('', { status: 401 }));
    const c2 = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f401 });
    await c2.billingStatus(1);
    expect(c2.cookieStatus(1)).toBe('invalid');
  });

  it('任意日志不含 cookie 原文', async () => {
    const logs: string[] = [];
    let status = 500;
    const { f } = fakeFetch(() => new Response('err', { status }));
    const client = new ConsoleClient(cfg(), fakeAccounts(), (m) => logs.push(m), { fetchImpl: f });

    await client.billingStatus(1);
    await client.billingStatus(1);
    status = 401;
    await client.billingStatus(1);

    expect(logs.join(' ')).not.toContain('cookie-1');
  });
});

// ---------------------------------------------------------------------------
// 写操作：请求形状（POST 路径按 REST 惯例，待真实页面验证）
// ---------------------------------------------------------------------------

describe('ConsoleClient 写操作', () => {
  it('setAutoRecharge：POST + JSON body + 鉴权头', async () => {
    const { f, reqs } = fakeFetch(() => jsonResponse(200, { enabled: true }));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    const r = await client.setAutoRecharge(1, {
      enabled: true,
      thresholdDollars: 5,
      rechargeAmountDollars: 20,
    });

    expect(r).toEqual({ ok: true, data: { enabled: true } });
    const req = reqs[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://console.opencode.ai/api/billing/auto-recharge');
    expect(req.cookie).toBe('cookie-1');
    expect(req.orgId).toBe('ws-1');
    expect(req.body).toEqual({ enabled: true, thresholdDollars: 5, rechargeAmountDollars: 20 });
  });

  it('setMonthlyLimit / createServiceAccount / removeServiceAccount 的形状', async () => {
    const { f, reqs } = fakeFetch(() => jsonResponse(200, {}));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    await client.setMonthlyLimit(1, 50);
    await client.createServiceAccount(1, 'panel-bot');
    await client.removeServiceAccount(1, 'sa_123');

    expect(reqs.map((r) => r.url)).toEqual([
      'https://console.opencode.ai/api/billing/monthly-limit',
      'https://console.opencode.ai/api/service-accounts',
      'https://console.opencode.ai/api/service-accounts/sa_123/remove',
    ]);
    expect(reqs[0]!.body).toEqual({ limitDollars: 50 });
    expect(reqs[1]!.body).toEqual({ name: 'panel-bot' });
    expect(reqs[2]!.body).toEqual({});
  });

  it('写操作 401 返回 {ok:false, reason:"auth"} 且不打日志', async () => {
    const logs: string[] = [];
    const { f } = fakeFetch(() => new Response('', { status: 401 }));
    const client = new ConsoleClient(cfg(), fakeAccounts(), (m) => logs.push(m), { fetchImpl: f });

    const r = await client.setMonthlyLimit(1, 50);

    expect(r).toEqual({ ok: false, reason: 'auth' });
    expect(client.cookieStatus(1)).toBe('invalid');
    expect(logs.length).toBe(0);
  });

  it('写操作无 cookie 返回 no-cookie，不打网络', async () => {
    const f = vi.fn<FetchLike>();
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    const r = await client.setMonthlyLimit(2, 50);

    expect(r).toEqual({ ok: false, reason: 'no-cookie' });
    expect(f).not.toHaveBeenCalled();
  });

  it('写操作上游 5xx 返回 upstream', async () => {
    const { f } = fakeFetch(() => new Response('err', { status: 502 }));
    const client = new ConsoleClient(cfg(), fakeAccounts(), log, { fetchImpl: f });

    expect(await client.setAutoRecharge(1, { enabled: true, thresholdDollars: 5, rechargeAmountDollars: 20 }))
      .toEqual({ ok: false, reason: 'upstream' });
  });

});

describe('Bearer fallback（OAuth 账号无 cookie 也能读控制台数据）', () => {
  const log = (): void => {};

  it('无 cookie 有 OAuth：refresh → Bearer 请求 → 数据返回，新 refresh 写回', async () => {
    const saved: Array<string | null> = [];
    const accounts: ConsoleAccounts = {
      cookieOf: () => null,
      workspaceIdOf: (id) => (id === 1 ? 'ws-1' : null),
      getOauthRefresh: (id) => (id === 1 ? 'rt-old' : null),
      setOauthRefresh: (_id, t) => {
        saved.push(t);
        return true;
      },
    };
    const { f, reqs } = fakeFetch(async (req) => {
      if (String(req.url).includes('/auth/device/token')) {
        return jsonResponse(200, { access_token: 'at-1', refresh_token: 'rt-new' });
      }
      return jsonResponse(200, { balanceMicroCents: '100000000' });
    });
    const client = new ConsoleClient(cfg(), accounts, log, { fetchImpl: f });
    const data = await client.billingStatus(1);
    expect(data).toEqual({ balanceMicroCents: '100000000' });
    // refresh 用 Bearer 请求 console API
    const apiReq = reqs.find((r) => r.url.includes('/api/billing/status'))!;
    expect(apiReq.authorization).toBe('Bearer at-1');
    expect(apiReq.cookie).toBeNull();
    // refresh token 轮换：新值写回（旧值已失效）
    expect(saved).toEqual(['rt-new']);
  });

  it('refresh 401（会话失效）→ null + invalid 健康态', async () => {
    const accounts: ConsoleAccounts = {
      cookieOf: () => null,
      workspaceIdOf: () => 'ws-1',
      getOauthRefresh: () => 'rt-dead',
      setOauthRefresh: () => true,
    };
    const { f } = fakeFetch(() => jsonResponse(401, {}));
    const client = new ConsoleClient(cfg(), accounts, log, { fetchImpl: f });
    expect(await client.billingStatus(1)).toBeNull();
    expect(client.cookieStatus(1)).toBe('invalid');
  });

  it('refresh 响应缺 access_token → null（不透传空 token）', async () => {
    const accounts: ConsoleAccounts = {
      cookieOf: () => null,
      workspaceIdOf: () => 'ws-1',
      getOauthRefresh: () => 'rt-x',
      setOauthRefresh: () => true,
    };
    const { f } = fakeFetch(() => jsonResponse(200, { error: 'weird' }));
    const client = new ConsoleClient(cfg(), accounts, log, { fetchImpl: f });
    expect(await client.billingStatus(1)).toBeNull();
  });

  it('OAuth refresh 用配置的 client_id（不硬编码 opencode-cli，OAUTH_CLIENT_ID 生效）', async () => {
    const accounts: ConsoleAccounts = {
      cookieOf: () => null,
      workspaceIdOf: (id) => (id === 1 ? 'ws-1' : null),
      getOauthRefresh: (id) => (id === 1 ? 'rt-1' : null),
      setOauthRefresh: () => true,
    };
    const { f, reqs } = fakeFetch((req) => {
      if (String(req.url).includes('/auth/device/token')) {
        return jsonResponse(200, { access_token: 'at-1', expires_in: 3600 });
      }
      return jsonResponse(200, { balanceMicroCents: '100000000' });
    });
    const customCfg = { ...cfg(), oauthClientId: 'custom-client-id' } as unknown as AppConfig;
    const client = new ConsoleClient(customCfg, accounts, log, { fetchImpl: f });
    expect(await client.billingStatus(1)).not.toBeNull();
    const refreshReq = reqs.find((r) => String(r.url).includes('/auth/device/token'))!;
    expect((refreshReq.body as { client_id: string }).client_id).toBe('custom-client-id');
  });
});
