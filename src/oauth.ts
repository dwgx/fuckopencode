/**
 * OAuth device flow 登录（RFC 8628，官方 CLI 同款协议，已实测存活）。
 *
 * 流程：POST /auth/device/code 拿 device_code → 用户在浏览器打开
 * verification_uri_complete 完成登录 → 前端按 interval 轮询
 * POST /auth/device/token → pending 直到 done → 服务端用 access_token
 * 换一次 /api/orgs 提取 workspace 与账号名，随后 access_token 即弃。
 *
 * 隐私口径（MULTI-ACCOUNT.md 同款）：
 * - device_code 只存在内存会话 Map（start 存、poll 取、终态/过期删除），
 *   不落库、不落日志。
 * - access_token 只在 poll 函数内部存活一个网络往返，不进 Map 之外任何地方。
 * - refresh_token 由调用方（server.ts）转交 AccountsStore 加密落库，
 *   之后明文即弃。日志只记 email/workspaceId/错误类别。
 *
 * 超时：每个 fetch 用 AbortSignal.timeout(10s)，可用构造参数覆盖（测试用）。
 * fetch 可注入（测试传 fake），consoleUrl/clientId 由调用方从 config 传。
 */

import type { FetchLike } from './billing.js';

/** 单次上游往返的默认超时。 */
const DEFAULT_TIMEOUT_MS = 10_000;
/** expires_in 的上限钳制（秒）：防异常上游给巨值把会话拖成永不过期。 */
const MAX_EXPIRES_IN_S = 7 * 86_400;
/** 活动设备会话上限（防 start 刷爆上游 + 撑大内存 Map）。 */
const MAX_ACTIVE_SESSIONS = 10;
/** 验证 URL 允许的官方域名（含子域）。实测 verification 页在 opencode.dev。 */
const DEFAULT_ALLOWED_HOSTS = ['opencode.ai', 'opencode.dev'];

/** 内存会话（start 存、poll 取、终态/过期删除）。device code 不落库不落日志。 */
export interface OauthSession {
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  /** 过期时刻（now + expires_in*1000）。 */
  expiresAt: number;
  /** 上游建议的轮询间隔（秒）。 */
  interval: number;
  createdAt: number;
  /**
   * 授权成功的 refresh_token 暂存（进程内）。poll 拿到 token 后先暂存，
   * /api/orgs 拉取成功后加密落库再清除；orgs 瞬时失败时保留，重试 poll
   * 跳过 token 端点直接用暂存值再拉 orgs，避免让用户重复授权。
   * access_token 从不进会话（只在一个网络往返内存活）。
   */
  refreshToken?: string;
}

/** start 成功时给前端的会话信息（device flow 协议要求客户端持有这些）。 */
export interface OauthStartOk {
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type OauthStartResult =
  | { ok: true; session: OauthStartOk }
  | { ok: false; reason: string };

/** poll 成功的身份信息。refreshToken 仅进程内流转（加密落库后即弃）。 */
export interface OauthIdentity {
  /** 账号名候选：email > 用户名 > workspace 名 > 'oauth-' + workspaceId 前 8 位。 */
  name: string;
  workspaceId: string;
  workspaceName?: string;
  refreshToken: string;
}

export type OauthPollResult =
  | { ok: true; status: 'pending' }
  | { ok: true; status: 'done'; identity: OauthIdentity }
  | {
      ok: false;
      reason: 'expired' | 'denied' | 'not_found' | 'error';
      /**
       * 重试路径 refresh 已轮换但 orgs 仍失败时带回的**新** refresh_token
       * （调用方按需落库；undefined = 本次失败没有轮换发生）。refresh 轮换
       * 语义下旧值在轮换瞬间失效——不落库则进程重启/会话丢失后，下次用旧值
       * 刷新必然 invalid_grant。
       */
      refreshToken?: string;
      /** 与 refreshToken 配对的轮换前旧值（调用方按「旧值 == 账号存值」定位账号）。 */
      prevRefreshToken?: string;
    };

/** 单次 HTTP 往返的结果：body 能解析成 JSON 即算拿到（device flow 的失败也是 JSON）。 */
type HttpJsonResult = { ok: true; json: unknown } | { ok: false; reason: string };

export class OauthManager {
  private readonly sessions = new Map<string, OauthSession>();
  private readonly log: (msg: string) => void;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly allowedHosts: readonly string[];

  constructor(
    opts: {
      /** 每个 fetch 的超时（默认 10s；测试可缩小）。 */
      timeoutMs?: number;
      /** 时间源注入（测试固定 now 模拟会话过期）。 */
      now?: () => number;
      log?: (msg: string) => void;
      /**
       * 验证 URL 允许的官方域名（含子域）。verification_uri_complete 的实际
       * 域名与 API base（console.opencode.ai）不是同一个（实测是 opencode.dev），
       * 所以不能只比 origin —— 用域名白名单兜住「被劫持上游返回钓鱼 URL」。
       * 默认官方域；consoleUrl 的 hostname 自动并入（支持私有部署）。
       */
      allowedHosts?: readonly string[];
    } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m: string): void => console.warn(m));
    this.allowedHosts = [...(opts.allowedHosts ?? DEFAULT_ALLOWED_HOSTS)];
  }

  /** 当前存活会话数（测试/诊断用：验证 start 的过期清理真的释放了 Map）。 */
  sessionCount(): number {
    return this.sessions.size;
  }

  /** 清掉已过期会话，防 Map 无限增长（start 每次进来先跑）。 */
  private purgeExpired(): void {
    const t = this.now();
    for (const [code, s] of this.sessions) {
      if (s.expiresAt <= t) this.sessions.delete(code);
    }
  }

  /**
   * 发起 device flow：POST /auth/device/code → 存会话。失败 detail 只进日志。
   */
  async start(
    consoleUrl: string,
    clientId: string,
    fetchImpl: FetchLike = fetch,
  ): Promise<OauthStartResult> {
    this.purgeExpired();
    // 会话上限：一个管理员同时只开 1-2 个登录流程，10 个活动会话足够；
    // 防持有管理凭据者无限刷 start（每次都是真实上游请求 + 内存会话）。
    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
      this.log('[oauth] start 拒绝：活动会话已达上限');
      return { ok: false, reason: 'error' };
    }
    const res = await this.postJson(`${consoleUrl}/auth/device/code`, { client_id: clientId }, fetchImpl);
    if (!res.ok) {
      this.log(`[oauth] start 上游失败: ${res.reason}`);
      return { ok: false, reason: 'error' };
    }
    const b = res.json as Record<string, unknown> | null;
    const deviceCode = typeof b?.device_code === 'string' ? b.device_code : '';
    const userCode = typeof b?.user_code === 'string' ? b.user_code : '';
    // 以实际返回为准：优先 verification_uri_complete（带 user_code 的整链），
    // 只有 verification_uri 时前端把 user_code 给用户手输也能完成。
    // 实测上游返回相对路径（/device?user_code=...）：必须拼上 console base，
    // 否则前端把相对路径当 href 会解析到面板自己的 origin（打开就是 404）。
    // 安全底线：拼完后校验 scheme ∈ {http,https} 且 hostname 在官方域白名单
    // （opencode.ai/opencode.dev 含子域，或 consoleUrl 自身）——被劫持/恶意的
    // 上游可能返回 javascript:/data:/钓鱼域名，原样进前端 href 就是钓鱼/XSS
    // 链接入口。任何不满足 → fail-closed 当作 start 失败。
    const rawUri =
      typeof b?.verification_uri_complete === 'string'
        ? b.verification_uri_complete
        : typeof b?.verification_uri === 'string'
          ? b.verification_uri
          : '';
    let verificationUriComplete = '';
    if (rawUri) {
      try {
        const base = new URL(consoleUrl);
        // consoleUrl 的 hostname 自动并入白名单（私有部署/测试环境用）。
        const hosts = this.allowedHosts.includes(base.hostname)
          ? this.allowedHosts
          : [...this.allowedHosts, base.hostname];
        const u = rawUri.startsWith('/') ? new URL(rawUri, `${consoleUrl}/`) : new URL(rawUri);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          const host = u.hostname.toLowerCase();
          if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
            verificationUriComplete = u.toString();
          }
        }
      } catch {
        /* 畸形 URI 同 fail-closed */
      }
    }
    const expiresIn =
      typeof b?.expires_in === 'number' && b.expires_in > 0 ? Math.min(b.expires_in, MAX_EXPIRES_IN_S) : 900;
    const interval = typeof b?.interval === 'number' && b.interval > 0 ? b.interval : 5;
    if (!deviceCode || !userCode || !verificationUriComplete) {
      this.log('[oauth] start 上游响应缺 device_code/user_code/verification_uri(_complete)');
      return { ok: false, reason: 'error' };
    }
    const now = this.now();
    this.sessions.set(deviceCode, {
      deviceCode,
      userCode,
      verificationUriComplete,
      expiresAt: now + expiresIn * 1000,
      interval,
      createdAt: now,
    });
    return { ok: true, session: { deviceCode, userCode, verificationUriComplete, expiresIn, interval } };
  }

  /**
   * 轮询 device flow 状态。服务端无状态（只有 deviceCode 查会话，轮询节奏由
   * 前端按 interval 自己控制）。done 时携带 identity 供调用方落账号。
   */
  async poll(
    deviceCode: string,
    consoleUrl: string,
    clientId: string,
    fetchImpl: FetchLike = fetch,
  ): Promise<OauthPollResult> {
    const session = this.sessions.get(deviceCode);
    if (!session) return { ok: false, reason: 'not_found' };
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(deviceCode);
      return { ok: false, reason: 'expired' };
    }
    // orgs 瞬时失败后的重试路径：会话里已有暂存 refresh_token（token 端点
    // 只调一次，device_code 一次性），直接用 access_token 不可重取——需要
    // refresh_token 换新 access。这里用 refresh 换 access 再拉 orgs。
    if (session.refreshToken != null) {
      // refresh 用的旧值：轮换写回会话后它就不再可读，先存下来——orgs 再失败
      // 时随结果带回，调用方按旧值匹配现有账号把新值落库。
      const prevRefreshToken = session.refreshToken;
      const refreshed = await this.postJson(
        `${consoleUrl}/auth/device/token`,
        { grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: clientId },
        fetchImpl,
      );
      if (!refreshed.ok) {
        // refresh 失败（如 refresh_token 已失效）：会话作废，前端提示重试登录。
        this.sessions.delete(deviceCode);
        this.log(`[oauth] 重试路径 refresh 失败: ${refreshed.reason}`);
        return { ok: false, reason: 'error' };
      }
      const rb = refreshed.json as Record<string, unknown> | null;
      const accessToken = rb != null && typeof rb.access_token === 'string' ? rb.access_token : '';
      if (!accessToken) {
        this.sessions.delete(deviceCode);
        this.log('[oauth] 重试路径 refresh 响应缺 access_token');
        return { ok: false, reason: 'error' };
      }
      // refresh token 轮换（对齐 console.ts doRefresh 的轮换语义）：refresh 响应
      // 带新 refresh_token 就写回会话 —— 上游轮换后旧值立即失效，不写回则 orgs
      // 再次瞬时失败时（本分支不删会话）下一个重试用旧值必然 invalid_grant，
      // 且下面返回的 identity.refreshToken 会把死值交回调用方落库。
      if (rb != null && typeof rb.refresh_token === 'string' && rb.refresh_token) {
        session.refreshToken = rb.refresh_token;
      }
      const [orgs2, user2] = await Promise.all([
        this.getJson(`${consoleUrl}/api/orgs`, accessToken, fetchImpl),
        this.getJson(`${consoleUrl}/api/user`, accessToken, fetchImpl),
      ]);
      if (!orgs2.ok) {
        this.log(`[oauth] 重试路径 orgs 拉取失败: ${orgs2.reason}`);
        // refresh 轮换已写回会话但 orgs 仍失败：把新值带回（否则旧值已失效，
        // 进程重启/会话丢失后下次刷新必然 invalid_grant）。会话保留——下次
        // poll 继续用新值重试（与 C-P2-1 语义一致）。
        return { ok: false, reason: 'error', refreshToken: session.refreshToken, prevRefreshToken };
      }
      const parsed2 = parseOrgs(orgs2.json, user2.ok ? user2.json : undefined);
      if (parsed2 == null) {
        this.log('[oauth] 重试路径 /api/orgs 响应里找不到可用 workspace');
        return { ok: false, reason: 'error', refreshToken: session.refreshToken, prevRefreshToken };
      }
      this.sessions.delete(deviceCode);
      return {
        ok: true,
        status: 'done',
        identity: {
          name: parsed2.name,
          workspaceId: parsed2.workspaceId,
          workspaceName: parsed2.workspaceName,
          refreshToken: session.refreshToken,
        },
      };
    }
    const res = await this.postJson(
      `${consoleUrl}/auth/device/token`,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: clientId,
      },
      fetchImpl,
    );
    if (!res.ok) {
      this.log(`[oauth] poll 上游失败: ${res.reason}`);
      return { ok: false, reason: 'error' };
    }
    const b = res.json as Record<string, unknown> | null;
    if (b != null && typeof b.error === 'string') {
      // RFC 8628 错误码：pending/slow_down 继续等；access_denied/expired_token/
      // invalid_grant 是终态（会话删除）；未知错误码保留会话（可能只是上游
      // 临时故障，前端可继续等，会话过期自然清理）。
      if (b.error === 'authorization_pending' || b.error === 'slow_down') {
        return { ok: true, status: 'pending' };
      }
      if (b.error === 'access_denied') {
        this.sessions.delete(deviceCode);
        return { ok: false, reason: 'denied' };
      }
      if (b.error === 'expired_token' || b.error === 'invalid_grant') {
        this.sessions.delete(deviceCode);
        return { ok: false, reason: 'expired' };
      }
      this.log(`[oauth] poll 未知错误码: ${String(b.error).slice(0, 200)}`);
      return { ok: false, reason: 'error' };
    }
    // 成功：access_token 只在本函数内换 orgs，用完即弃，不进 Map 之外任何地方。
    // refresh_token 先暂存会话：orgs 瞬时失败时保留会话，重试 poll 直接用它
    // 再拉 orgs（token 端点只调一次，device_code 一次性）；orgs 成功后才加密
    // 落库并清除。
    const accessToken = b != null && typeof b.access_token === 'string' ? b.access_token : '';
    const refreshToken = b != null && typeof b.refresh_token === 'string' ? b.refresh_token : '';
    if (!accessToken || !refreshToken) {
      this.sessions.delete(deviceCode);
      this.log('[oauth] token 响应缺 access_token/refresh_token');
      return { ok: false, reason: 'error' };
    }
    session.refreshToken = refreshToken;
    // 照官方 poll 实现（account.ts）：orgs 与 user 并发拉取（email 在 user 端点）。
    const [orgs, user] = await Promise.all([
      this.getJson(`${consoleUrl}/api/orgs`, accessToken, fetchImpl),
      this.getJson(`${consoleUrl}/api/user`, accessToken, fetchImpl),
    ]);
    if (!orgs.ok) {
      this.log(`[oauth] orgs 拉取失败: ${orgs.reason}`);
      // 会话保留（refreshToken 已在会话里），前端重试 poll 会用暂存 token 再拉。
      return { ok: false, reason: 'error' };
    }
    const parsed = parseOrgs(orgs.json, user.ok ? user.json : undefined);
    if (parsed == null) {
      this.log('[oauth] /api/orgs 响应里找不到可用 workspace');
      return { ok: false, reason: 'error' };
    }
    // 终态：会话清除（refresh_token 已由调用方加密落库）。
    this.sessions.delete(deviceCode);
    return {
      ok: true,
      status: 'done',
      identity: {
        name: parsed.name,
        workspaceId: parsed.workspaceId,
        workspaceName: parsed.workspaceName,
        refreshToken,
      },
    };
  }

  /** POST JSON；body 能解析成 JSON 即算拿到（device flow 的 pending/错误是 400 + JSON）。 */
  private async postJson(
    url: string,
    body: unknown,
    fetchImpl: FetchLike,
  ): Promise<HttpJsonResult> {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const json = await res.json().catch(() => null);
      if (json === null) return { ok: false, reason: `status ${res.status} non-json` };
      return { ok: true, json };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'fetch failed' };
    }
  }

  /** GET JSON（带 Bearer）。非 2xx / 非 JSON 算失败。 */
  private async getJson(
    url: string,
    accessToken: string,
    fetchImpl: FetchLike,
  ): Promise<HttpJsonResult> {
    try {
      const res = await fetchImpl(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return { ok: false, reason: `status ${res.status}` };
      const json = await res.json().catch(() => null);
      if (json === null) return { ok: false, reason: 'non-json' };
      return { ok: true, json };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'fetch failed' };
    }
  }
}

/** /api/orgs 解析出的身份候选。 */
export interface ParsedOrgs {
  name: string;
  workspaceId: string;
  workspaceName?: string;
}

/**
 * 从 /api/orgs 响应里取**第一个** workspace。
 *
 * 响应形态以实测为准（官方 CLI account.ts 的 user/orgs 形状）：orgs 每个有
 * workspaces 列表（workspace 含 id/name/kind）。这里兼容两种顶层形态：
 * `{user, orgs:[...]}` 或裸数组。账号名候选顺序：
 * user.email > user.name > workspace.name > 'oauth-' + workspaceId 前 8 位
 * （保证落账号时名字非空）。
 */
export function parseOrgs(orgsBody: unknown, userBody?: unknown): ParsedOrgs | null {
  // 官方形状（实测源码 account.ts）：/api/orgs 返回裸数组 [{id, name}]，
  // Org.id 就是 workspace id（opencode 账号模型里 org ≈ workspace，每个 org
  // 有独立 billing/key）；email 在 /api/user（{id, email}）。
  // 兼容旧形状 {user, orgs:[{workspaces:[{id,name}]}]}（早期实现假设）。
  const root =
    typeof orgsBody === 'object' && orgsBody !== null && !Array.isArray(orgsBody)
      ? (orgsBody as Record<string, unknown>)
      : {};
  const arr: unknown[] = Array.isArray(orgsBody)
    ? orgsBody
    : Array.isArray(root.orgs)
      ? (root.orgs as unknown[])
      : [];
  const user = typeof userBody === 'object' && userBody !== null ? (userBody as Record<string, unknown>) : undefined;
  const email = user != null && typeof user.email === 'string' ? user.email : '';
  const rootUser = root.user as Record<string, unknown> | undefined;
  const email2 = rootUser != null && typeof rootUser.email === 'string' ? rootUser.email : '';
  const uname = (user != null && typeof user.name === 'string' ? user.name : '') ||
    (rootUser != null && typeof rootUser.name === 'string' ? rootUser.name : '');
  for (const org of arr) {
    if (typeof org !== 'object' || org === null) continue;
    const o = org as Record<string, unknown>;
    // 旧形状优先：org 带 workspaces 数组 → 走 {workspaces:[{id,name}]} 分支
    // （旧实现的 Org 也可能带 id，不能靠 id 有无判断形状）。
    if (Array.isArray(o.workspaces)) {
      for (const ws of o.workspaces as unknown[]) {
        if (typeof ws !== 'object' || ws === null) continue;
        const w = ws as Record<string, unknown>;
        const wid =
          typeof w.id === 'string' && w.id
            ? w.id
            : typeof w.workspaceId === 'string' && w.workspaceId
              ? w.workspaceId
              : '';
        if (!wid) continue;
        const wname = typeof w.name === 'string' ? w.name : '';
        return { name: email || email2 || uname || wname || `oauth-${wid.slice(0, 8)}`, workspaceId: wid, workspaceName: wname || undefined };
      }
      continue;
    }
    // 官方形状：Org {id, name}（id 即 workspace id）
    const orgId = typeof o.id === 'string' && o.id ? o.id : '';
    if (orgId) {
      const oname = typeof o.name === 'string' ? o.name : '';
      return { name: email || email2 || uname || oname || `oauth-${orgId.slice(0, 8)}`, workspaceId: orgId, workspaceName: oname || undefined };
    }
  }
  return null;
}
