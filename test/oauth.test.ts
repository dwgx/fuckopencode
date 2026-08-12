import { describe, expect, it } from 'vitest';
import { OauthManager, parseOrgs } from '../src/oauth.js';
import type { FetchLike } from '../src/billing.js';

/**
 * OAuth device flow 客户端（src/oauth.ts）的单测。
 *
 * fake fetch 按 URL 路由三个上游端点，模拟真实 console 的状态机：
 * /auth/device/code → 会话信息；/auth/device/token → pending/成功/终态错误；
 * /api/orgs → 带 Bearer 才回组织列表。
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface FakeConsoleOpts {
  /** /auth/device/code 的响应体（默认一套标准会话）。 */
  codeResponse?: unknown;
  /** /auth/device/code 的状态码。 */
  codeStatus?: number;
  /** /auth/device/token 依次返回的响应体；耗尽后复用最后一条。 */
  tokenResponses?: unknown[];
  /** /api/orgs 的响应体。 */
  orgsResponse?: unknown;
  /** /api/orgs 的状态码。 */
  orgsStatus?: number;
  /** /api/user 的响应体（email 在这）。 */
  userResponse?: unknown;
  /** 记下每次上游调用（断言协议形状用）。 */
  requests?: Array<{ method: string; url: string; body: unknown; authorization?: string }>;
  /** 网络层直接抛（模拟连不上）。 */
  fetchThrows?: boolean;
}

const DEFAULT_CODE = {
  device_code: 'dc-1',
  user_code: 'ABCD-EFGH',
  verification_uri_complete: 'https://opencode.dev/auth/ABCD-EFGH',
  expires_in: 900,
  interval: 5,
};

const DEFAULT_TOKEN = [
  { error: 'authorization_pending' },
  { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600 },
];

const DEFAULT_ORGS = [
  { id: 'org-ws-1', name: 'main' },
  { id: 'org-ws-2', name: 'second' },
];

const DEFAULT_USER = { id: 'u1', email: 'user@example.com' };

/** 造一个按 URL 路由的假 console fetch。 */
function fakeConsoleFetch(opts: FakeConsoleOpts = {}): FetchLike {
  const requests = opts.requests ?? [];
  let tokenIdx = 0;
  return async (input, init) => {
    if (opts.fetchThrows) throw new Error('ECONNREFUSED');
    const url = typeof input === 'string' ? input : String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({
      method: init?.method ?? 'GET',
      url,
      body: init?.body != null ? (JSON.parse(String(init.body)) as unknown) : undefined,
      authorization: headers.authorization,
    });
    if (url.endsWith('/auth/device/code')) {
      return jsonResponse(opts.codeStatus ?? 200, opts.codeResponse ?? DEFAULT_CODE);
    }
    if (url.endsWith('/auth/device/token')) {
      const list = opts.tokenResponses ?? DEFAULT_TOKEN;
      const body = list[Math.min(tokenIdx++, list.length - 1)]!;
      // device flow 的 pending/终态错误是 400 + JSON（RFC 8628），成功才是 200。
      const hasError = typeof (body as Record<string, unknown>)?.error === 'string';
      return jsonResponse(hasError ? 400 : 200, body);
    }
    if (url.endsWith('/api/orgs')) {
      return jsonResponse(opts.orgsStatus ?? 200, opts.orgsResponse ?? DEFAULT_ORGS);
    }
    if (url.endsWith('/api/user')) {
      return jsonResponse(opts.orgsStatus ?? 200, opts.userResponse ?? DEFAULT_USER);
    }
    return new Response('not found', { status: 404 });
  };
}

describe('OauthManager.start', () => {
  it('成功：拿到会话四要素，请求按协议发出（body/headers）', async () => {
    const requests: FakeConsoleOpts['requests'] = [];
    const m = new OauthManager();
    const r = await m.start('https://console.test', 'opencode-cli', fakeConsoleFetch({ requests }));

    expect(r).toEqual({
      ok: true,
      session: {
        deviceCode: 'dc-1',
        userCode: 'ABCD-EFGH',
        verificationUriComplete: 'https://opencode.dev/auth/ABCD-EFGH',
        expiresIn: 900,
        interval: 5,
      },
    });
    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://console.test/auth/device/code');
    expect(req.body).toEqual({ client_id: 'opencode-cli' });
    expect(m.sessionCount()).toBe(1);
  });

  it('上游 500（非 JSON 体）→ error，detail 只进日志', async () => {
    const logs: string[] = [];
    const m = new OauthManager({ log: (x) => void logs.push(x) });
    // 非 JSON 的 500（如 HTML 错误页）：postJson 判定为失败。
    const errFetch: FetchLike = async () => new Response('<html>500</html>', { status: 500 });
    const r = await m.start('https://console.test', 'opencode-cli', errFetch);
    expect(r).toEqual({ ok: false, reason: 'error' });
    expect(logs.some((l) => l.startsWith('[oauth] start 上游失败'))).toBe(true);
  });

  it('响应缺 device_code/user_code/verification_uri → error（上游形状对不上）', async () => {
    const m = new OauthManager();
    const r = await m.start('https://console.test', 'opencode-cli', fakeConsoleFetch({ codeResponse: { device_code: 'dc-1' } }));
    expect(r).toEqual({ ok: false, reason: 'error' });
  });

  it('只有 verification_uri 没有 _complete 也能用（前端拿 user_code 让用户手输）', async () => {
    const m = new OauthManager();
    const r = await m.start(
      'https://console.test',
      'opencode-cli',
      fakeConsoleFetch({ codeResponse: { ...DEFAULT_CODE, verification_uri_complete: undefined, verification_uri: 'https://opencode.dev/auth' } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.verificationUriComplete).toBe('https://opencode.dev/auth');
  });

  it('expires_in/interval 非法时回落默认值；巨值被钳制防永不过期', async () => {
    const m = new OauthManager();
    const r = await m.start(
      'https://console.test',
      'opencode-cli',
      fakeConsoleFetch({ codeResponse: { ...DEFAULT_CODE, expires_in: 1e12, interval: 0 } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.expiresIn).toBe(7 * 86_400); // 钳到 7 天
      expect(r.session.interval).toBe(5);
    }
  });

  it('网络层失败 → error，不抛', async () => {
    const m = new OauthManager();
    const r = await m.start('https://console.test', 'opencode-cli', fakeConsoleFetch({ fetchThrows: true }));
    expect(r).toEqual({ ok: false, reason: 'error' });
  });

  it('相对路径 verification_uri_complete 拼上 console base（防前端解析到面板 origin）', async () => {
    const m = new OauthManager();
    const r = await m.start(
      'https://console.opencode.ai',
      'opencode-cli',
      fakeConsoleFetch({ codeResponse: { ...DEFAULT_CODE, verification_uri_complete: '/device?user_code=ABCD-EFGH&client_id=opencode-cli' } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.verificationUriComplete).toBe('https://console.opencode.ai/device?user_code=ABCD-EFGH&client_id=opencode-cli');
  });

  it.each([
    ['javascript:alert(1)', 'javascript: scheme 被拒'],
    ['data:text/html,<script>1</script>', 'data: scheme 被拒'],
    ['https://evil.example/phish', '钓鱼域名被拒'],
    ['//evil.example/x', '协议相对 URL 被拒'],
    ['not a url %zz', '畸形 URI 被拒'],
  ])('%s → %s（start 失败，fail-closed）', async (uri) => {
    const m = new OauthManager();
    const r = await m.start(
      'https://console.opencode.ai',
      'opencode-cli',
      fakeConsoleFetch({ codeResponse: { ...DEFAULT_CODE, verification_uri_complete: uri } }),
    );
    expect(r).toEqual({ ok: false, reason: 'error' });
    expect(m.sessionCount()).toBe(0); // 不存会话
  });

  it('活动会话达上限后 start 拒绝（防刷上游 + 撑内存 Map）', async () => {
    const m = new OauthManager();
    // 每次 start 返回不同的 device_code（否则 Map 同 key 覆盖，测不到上限）。
    let n = 0;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/auth/device/code')) {
        n += 1;
        return jsonResponse(200, { ...DEFAULT_CODE, device_code: `dc-${n}` });
      }
      return jsonResponse(404, {});
    };
    for (let i = 0; i < 10; i++) {
      const r = await m.start('https://console.test', 'opencode-cli', fetchImpl);
      expect(r.ok).toBe(true);
    }
    const r = await m.start('https://console.test', 'opencode-cli', fetchImpl);
    expect(r).toEqual({ ok: false, reason: 'error' });
    expect(m.sessionCount()).toBe(10);
  });
});

describe('OauthManager.poll', () => {
  it('pending → done 全流程：身份带 email/workspaceId，refresh_token 保留', async () => {
    const requests: FakeConsoleOpts['requests'] = [];
    const m = new OauthManager();
    const fetchImpl = fakeConsoleFetch({ requests });
    await m.start('https://console.test', 'opencode-cli', fetchImpl);

    const p1 = await m.poll('dc-1', 'https://console.test', 'opencode-cli', fetchImpl);
    expect(p1).toEqual({ ok: true, status: 'pending' });

    const p2 = await m.poll('dc-1', 'https://console.test', 'opencode-cli', fetchImpl);
    expect(p2).toEqual({
      ok: true,
      status: 'done',
      identity: { name: 'user@example.com', workspaceId: 'org-ws-1', workspaceName: 'main', refreshToken: 'rt-1' },
    });
    // 协议形状：grant_type / device_code / client_id；orgs 带 Bearer access_token。
    const tokenReq = requests.find((r) => r.url.endsWith('/auth/device/token'))!;
    expect(tokenReq.body).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'dc-1',
      client_id: 'opencode-cli',
    });
    const orgsReq = requests.find((r) => r.url.endsWith('/api/orgs'))!;
    expect(orgsReq.authorization).toBe('Bearer at-1');
    // user 端点（email 来源）也带 Bearer。
    const userReq = requests.find((r) => r.url.endsWith('/api/user'))!;
    expect(userReq.authorization).toBe('Bearer at-1');
    // 成功后会话删除：access_token 没留在任何地方。
    expect(m.sessionCount()).toBe(0);
  });

  it('slow_down 也算 pending（RFC 8628 建议放慢轮询）', async () => {
    const m = new OauthManager();
    const fetchImpl = fakeConsoleFetch({ tokenResponses: [{ error: 'slow_down' }] });
    await m.start('https://console.test', 'opencode-cli', fetchImpl);
    const r = await m.poll('dc-1', 'https://console.test', 'opencode-cli', fetchImpl);
    expect(r).toEqual({ ok: true, status: 'pending' });
  });

  it('expired_token / invalid_grant → expired（终态，会话删除）', async () => {
    for (const err of ['expired_token', 'invalid_grant']) {
      const m = new OauthManager();
      const fetchImpl = fakeConsoleFetch({ tokenResponses: [{ error: err }] });
      await m.start('https://console.test', 'opencode-cli', fetchImpl);
      const r = await m.poll('dc-1', 'https://console.test', 'opencode-cli', fetchImpl);
      expect(r).toEqual({ ok: false, reason: 'expired' });
      expect(m.sessionCount()).toBe(0);
    }
  });

  it('access_denied → denied', async () => {
    const m = new OauthManager();
    const fetchImpl = fakeConsoleFetch({ tokenResponses: [{ error: 'access_denied' }] });
    await m.start('https://console.test', 'opencode-cli', fetchImpl);
    const r = await m.poll('dc-1', 'https://console.test', 'opencode-cli', fetchImpl);
    expect(r).toEqual({ ok: false, reason: 'denied' });
  });

  it('未知错误码 → error（会话保留，前端可继续等/重试）', async () => {
    const m = new OauthManager();
    const fetchImpl = fakeConsoleFetch({ tokenResponses: [{ error: 'weird_thing' }] });
    await m.start('https://console.test', 'opencode-cli', fetchImpl);
    const r = await m.poll('dc-1', 'https://console.test', 'opencode-cli', fetchImpl);
    expect(r).toEqual({ ok: false, reason: 'error' });
    expect(m.sessionCount()).toBe(1);
  });

  it('未知 deviceCode → not_found（不查上游）', async () => {
    const m = new OauthManager();
    const r = await m.poll('dc-none', 'https://console.test', 'opencode-cli', fakeConsoleFetch());
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });

  it('token 缺 access_token/refresh_token → error', async () => {
    const m = new OauthManager();
    const fetchImpl = fakeConsoleFetch({ tokenResponses: [{ access_token: 'at' }] });
    await m.start('https://console.test', 'opencode-cli', fetchImpl);
    const r = await m.poll('dc-1', 'https://console.test', 'opencode-cli', fetchImpl);
    expect(r).toEqual({ ok: false, reason: 'error' });
  });

  it('orgs 拉取失败（401）→ error；orgs 无 workspace → error', async () => {
    const m = new OauthManager();
    const fetchImpl = fakeConsoleFetch({ tokenResponses: [{ access_token: 'at-1', refresh_token: 'rt-1' }], orgsStatus: 401 });
    await m.start('https://console.test', 'opencode-cli', fetchImpl);
    expect((await m.poll('dc-1', 'https://console.test', 'opencode-cli', fetchImpl)).ok).toBe(false);

    const m2 = new OauthManager();
    const fetchImpl2 = fakeConsoleFetch({
      tokenResponses: [{ access_token: 'at-1', refresh_token: 'rt-1' }],
      orgsResponse: { user: { email: 'x@y.z' }, orgs: [{ id: 'o1', workspaces: [] }] },
    });
    await m2.start('https://console.test', 'opencode-cli', fetchImpl2);
    expect((await m2.poll('dc-1', 'https://console.test', 'opencode-cli', fetchImpl2)).ok).toBe(false);
  });

  it('fetch 超时（AbortSignal.timeout 触发）→ error，不挂死', async () => {
    // fake 只监听 signal：abort 才 reject —— 真实 fetch 超时就是这个行为。
    const hangFetch: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('AbortError: timed out')));
      });
    const m = new OauthManager({ timeoutMs: 30 });
    await m.start('https://console.test', 'opencode-cli', fakeConsoleFetch());
    const r = await m.poll('dc-1', 'https://console.test', 'opencode-cli', hangFetch);
    expect(r).toEqual({ ok: false, reason: 'error' });
  });
});

describe('会话过期与清理', () => {
  it('poll 超过 expires_in → expired，会话删除', async () => {
    let fakeNow = 1_000_000;
    const m = new OauthManager({ now: () => fakeNow });
    await m.start('https://console.test', 'opencode-cli', fakeConsoleFetch());
    fakeNow += 900 * 1000 + 1; // 超 900s
    const r = await m.poll('dc-1', 'https://console.test', 'opencode-cli', fakeConsoleFetch());
    expect(r).toEqual({ ok: false, reason: 'expired' });
    expect(m.sessionCount()).toBe(0);
  });

  it('start 会清掉已过期会话（防 Map 无限增长）', async () => {
    let fakeNow = 1_000_000;
    const m = new OauthManager({ now: () => fakeNow });
    await m.start('https://console.test', 'opencode-cli', fakeConsoleFetch());
    expect(m.sessionCount()).toBe(1);
    fakeNow += 900 * 1000 + 1; // 第一个会话过期
    await m.start('https://console.test', 'opencode-cli', fakeConsoleFetch()); // 触发清理 + 新建
    expect(m.sessionCount()).toBe(1); // 旧的被清掉，只剩新的
  });
});

describe('parseOrgs（/api/orgs 响应解析）', () => {
  it('官方形状（实测源码）：顶层裸数组 [{id,name}]，Org.id 即 workspace id，email 来自 user 端点', () => {
    const p = parseOrgs(
      [{ id: 'org-aaa', name: 'main' }, { id: 'org-bbb', name: 'second' }],
      { id: 'u1', email: 'a@b.com' },
    );
    expect(p).toEqual({ name: 'a@b.com', workspaceId: 'org-aaa', workspaceName: 'main' });
  });

  it('官方形状 + user 无 email → 用 org.name', () => {
    const p = parseOrgs([{ id: 'org-aaa', name: '我的组织' }], { id: 'u1' });
    expect(p).toEqual({ name: '我的组织', workspaceId: 'org-aaa', workspaceName: '我的组织' });
  });

  it('官方形状无 user → oauth- 前缀兜底', () => {
    expect(parseOrgs([{ id: 'org_abcdef12x', name: '' }])?.name).toBe('oauth-org_abcd');
  });

  it('旧形状 {user, orgs:[{workspaces:[...]}]} 仍兼容（早期实现假设）', () => {
    const p = parseOrgs({
      user: { id: 'u1', email: 'a@b.com', name: 'Alice' },
      orgs: [
        { id: 'o1', workspaces: [{ id: 'ws_1', name: 'main' }] },
        { id: 'o2', workspaces: [{ id: 'ws_2' }] },
      ],
    });
    expect(p).toEqual({ name: 'a@b.com', workspaceId: 'ws_1', workspaceName: 'main' });
  });

  it('无 email 用 user.name，再没有用 workspace.name', () => {
    expect(parseOrgs({ user: { name: 'Bob' }, orgs: [{ workspaces: [{ id: 'ws_x' }] }] })?.name).toBe('Bob');
    expect(parseOrgs({ orgs: [{ workspaces: [{ id: 'ws_x', name: '我的工作区' }] }] })?.name).toBe('我的工作区');
  });

  it('都没有 → oauth- + workspaceId 前 8 位（保证账号名非空）', () => {
    expect(parseOrgs({ orgs: [{ workspaces: [{ id: 'ws_abcdef12x' }] }] })?.name).toBe('oauth-ws_abcde');
  });

  it('完全无 workspace / 无 id → null', () => {
    expect(parseOrgs([])).toBeNull();
    expect(parseOrgs([{ name: 'n' }])).toBeNull();
    expect(parseOrgs({ orgs: [] })).toBeNull();
    expect(parseOrgs(null)).toBeNull();
    expect(parseOrgs('garbage')).toBeNull();
  });
});
