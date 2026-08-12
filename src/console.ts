/**
 * Console 数据层：调用 opencode Console 新版 REST API（console.opencode.ai）。
 *
 * 为什么需要：CONSOLE-PORT.md 的旧调研（server function /_server 协议）在 spike
 * 后被推翻 —— 新版 Console 直接暴露 REST 端点，鉴权用 auth cookie + x-org-id 头，
 * 金额单位 microCents（1e8 = $1，响应里是**字符串**，如 "0"）。
 * 响应形状实测 fixture：/tmp/fixtures/console-apis.json（含真实账号数据，只读
 * 别复制进项目）；本文件端点清单与换算口径与它一一对应。
 *
 * 已知缺口（上线前必做）：
 * - **请求路径未实测**：spike 只固化了响应体（{k, s, t} 三条），没记录请求 URL。
 *   本文件的路径按 fixture 键名 + REST 惯例推断（/api/billing/status 等），
 *   需用真实页面 Network 面板核对一次。
 * - **POST 路径/参数形状未知**：写操作（setAutoRecharge 等）按 REST 惯例实现，
 *   页面交互时才能抓真实请求，接线（admin.ts）前需验证。
 * - 例外：P0 数据端点（cost-by-day / usage models+users / budgets users-status /
 *   v2-config）已用线上真实 cookie 实测 —— 路径、参数（range 只认 24h/7d/30d、
 *   since ISO、bucket day|hour）与响应形状（见各方法注释）均已核对。
 *
 * 克制原则（沿用 billing.ts）：
 * - 失败只记日志 + 返回 null，绝不阻塞代理链路 —— 这是观测/管理数据层；
 * - 401/403 静默标记健康态（**不打任何日志**，cookie 是敏感凭证，细节不入日志）；
 *   非 auth 失败（网络/5xx）只累计计数与 lastError，不误判 cookie 失效（M-6）；
 * - 读缓存先行：面板 2s 轮询打的是缓存，上游调用频率 = 人类操作频率（TTL 30s）；
 *   invalidate 后用代数计数防挂起旧读回写缓存（M2 竞态）；
 * - cookie/workspace 明文只在进程内，绝不出现在返回值与日志。
 */

import type { AppConfig } from './config.js';
import type { FetchLike } from './billing.js';

/** 读缓存 TTL：面板 2s 轮询下，30s 内同端点只打一次上游。 */
export const CACHE_TTL_MS = 30_000;
/** 模型定价（/api/v2/config）缓存 TTL：61 模型约 20KB、价格低频变动，10 分钟。 */
export const MODEL_PRICING_TTL_MS = 10 * 60_000;
/** 单次上游调用超时。 */
export const TIMEOUT_MS = 15_000;

/** ConsoleClient 对 accounts 的最小接口假设（duck typing，不 import accounts.ts）。 */
export interface ConsoleAccounts {
  /** 进程内解密账户的 auth cookie 原文；无 cookie/解密失败 → null。 */
  cookieOf(id: number): string | null;
  /** workspace id；无 → null。 */
  workspaceIdOf(id: number): string | null;
  /** OAuth refresh_token 明文（服务器端换 access 用）；无 → null。 */
  getOauthRefresh(id: number): string | null;
  /** 写回 OAuth refresh_token（refresh token 轮换：每次 refresh 旧值立即失效）。 */
  setOauthRefresh(id: number, token: string | null): boolean;
}

export interface ConsoleClientOptions {
  /** fetch 注入点（测试用）。默认全局 fetch。 */
  fetchImpl?: FetchLike;
  /** 控制台 base URL（测试注入假端点用）。默认 cfg.oauthConsoleUrl。 */
  baseUrl?: string;
  /** 读缓存 TTL。默认 30s。 */
  ttlMs?: number;
  /** 单次调用超时。默认 15s。 */
  timeoutMs?: number;
  /** 时钟注入（测试缓存 TTL 用）。默认 Date.now。 */
  now?: () => number;
}

/** 写操作结果：成功带响应 JSON；失败带细分原因（401/403 → 'auth'）。 */
export type ConsoleWriteResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: 'auth' | 'no-cookie' | 'no-workspace' | 'upstream' | 'parse' };

/**
 * microCents → 美元（1e8 = $1，保留 2 位）。兼容字符串入参 —— 实测响应里
 * 金额字段是字符串（"0"）。非法输入返回 NaN（调用方自行丢弃）。
 */
export function microCentsToDollars(value: number | string): number {
  const n = Number(value);
  return Number.isFinite(n) ? Number((n / 1e8).toFixed(2)) : NaN;
}

/**
 * rangeDays → console 的 (range, since) 参数（实测控制台前端源码：usage 的
 * range 枚举只认 `24h|7d|30d`，其余值上游 400；since 是 ISO 8601 UTC，schema
 * 正则 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$`）。按天数就近取档：
 * ≤1 天 → 24h，≤7 天 → 7d，其余 → 30d；since = 该档时长前的时刻。
 */
function usageRangeAndSince(rangeDays: number, now: number): { range: string; since: string } {
  const days = rangeDays <= 1 ? 1 : rangeDays <= 7 ? 7 : 30;
  const range = days === 1 ? '24h' : `${days}d`;
  return { range, since: new Date(now - days * 86_400_000).toISOString() };
}

interface CacheEntry {
  at: number;
  /** 本条目的 TTL（默认实例 ttlMs；modelPricing 用长 TTL 覆盖）。 */
  ttl: number;
  data: unknown;
}

export class ConsoleClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  /** 读缓存：`${accountId}:${端点名}:${参数}` → 数据。只存成功响应。 */
  private readonly cache = new Map<string, CacheEntry>();
  /** 写代数：每账户的 invalidate 计数。invalidate 后返回的挂起读响应
   * 一律丢弃（防旧值把刚失效的缓存写回去，M2 竞态）。 */
  private readonly generations = new Map<number, number>();
  /** 健康态：每账户的连续失败次数 + 是否判定凭据失效 + 失效发生在哪个通道
   *  （cookie 或 OAuth Bearer —— 面板据此给不同恢复指引）。 */
  private readonly health = new Map<
    number,
    { consecutiveFails: number; invalid: boolean; channel: 'cookie' | 'oauth' | null }
  >();
  private readonly lastErr = new Map<number, 'auth' | 'upstream' | 'no-cred' | null>();
  /** OAuth access_token 进程内缓存（refresh 一次用 expires_in，避免每次请求
   *  都 refresh —— refresh 会轮换，并发请求互相踩踏旧 token 导致 400）。 */
  private readonly accessCache = new Map<number, { token: string; expiresAt: number }>();
  /** refresh 单飞：同一账户同一时间只发一个 refresh（并发请求共享结果），
   *  彻底消除「多个请求同时用旧 token refresh → 轮换踩踏 → 全 400」。 */
  private readonly refreshInflight = new Map<number, Promise<{ ok: boolean; token: string; workspaceId: string } | null>>();

  constructor(
    cfg: AppConfig,
    private readonly accounts: ConsoleAccounts,
    log: (msg: string) => void = console.log,
    opts: ConsoleClientOptions = {},
  ) {
    this.log = log;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? cfg.oauthConsoleUrl).replace(/\/+$/, '');
    // 与 keyprobe/oauth 同源：OAuth device flow 的 client_id 一律从配置取
    // （默认 opencode-cli，OAUTH_CLIENT_ID 可覆盖），不再硬编码。
    this.clientId = cfg.oauthClientId;
    this.ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // 读端点（全部：解析后的 JSON；失败 → null + 日志；401/403 → null + 静默标记）
  // -------------------------------------------------------------------------

  billingStatus(id: number): Promise<unknown | null> {
    return this.cachedGet(id, 'billingStatus', [], '/api/billing/status');
  }

  billingAccount(id: number): Promise<unknown | null> {
    return this.cachedGet(id, 'billingAccount', [], '/api/billing/account');
  }

  billingLedger(id: number): Promise<unknown | null> {
    return this.cachedGet(id, 'billingLedger', [], '/api/billing/ledger');
  }

  autoRecharge(id: number): Promise<unknown | null> {
    return this.cachedGet(id, 'autoRecharge', [], '/api/billing/auto-recharge');
  }

  paymentMethods(id: number): Promise<unknown | null> {
    return this.cachedGet(id, 'paymentMethods', [], '/api/billing/payment-methods');
  }

  usageSummary(id: number, rangeDays: number): Promise<unknown | null> {
    return this.cachedGet(id, 'usageSummary', [rangeDays], `/api/usage/summary?rangeDays=${rangeDays}`);
  }

  /**
   * GET /api/usage/cost-by-day：按日/小时成本时间序列（面板趋势图数据）。
   * 请求路径与响应形状都经真实控制台实测（range 只认 24h/7d/30d，since 必须
   * ISO 8601 UTC；响应是 DailyCost 数组：{date, totalCostMicroCents,
   * totalTokens, totalRequests}，金额是 microCents 字符串）。
   * 注意：since 每次调用都在变（含秒级漂移），但缓存键只含 rangeDays+bucket，
   * TTL 内命中不受影响（见单测「since 不进缓存键」）。
   */
  usageCostByDay(id: number, rangeDays: number, bucket: 'day' | 'hour' = 'day'): Promise<unknown | null> {
    const { range, since } = usageRangeAndSince(rangeDays, this.now());
    return this.cachedGet(
      id,
      'usageCostByDay',
      [rangeDays, bucket],
      `/api/usage/cost-by-day?range=${range}&since=${since}&bucket=${bucket}`,
    );
  }

  /**
   * GET /api/usage/models：按模型拆分（ModelSummary：{model, provider,
   * totalRequests, totalInputTokens, ..., totalCostMicroCents}），{items,
   * pageInfo}。pageSize 默认 100（console 上限，一次拿全）。
   */
  usageModels(id: number, rangeDays: number, pageSize = 100): Promise<unknown | null> {
    return this.cachedGet(id, 'usageModels', [rangeDays, pageSize], this.usageListPath('/api/usage/models', rangeDays, pageSize));
  }

  /**
   * GET /api/usage/users：按用户拆分（UserUsageSummary：{userId, email, name,
   * totalRequests, ..., totalCostMicroCents, lastActiveAt}），{items, pageInfo}。
   */
  usageUsers(id: number, rangeDays: number, pageSize = 100): Promise<unknown | null> {
    return this.cachedGet(id, 'usageUsers', [rangeDays, pageSize], this.usageListPath('/api/usage/users', rangeDays, pageSize));
  }

  /**
   * GET /api/budgets/users/status：用户预算状态数组（实测：{scope, userId,
   * email, limitMicroCents, spentMicroCents, exceeded, resetsAt, source,
   * updatedAt}，limit 可为 null、金额是 microCents 字符串）。
   */
  budgetsUsersStatus(id: number): Promise<unknown | null> {
    return this.cachedGet(id, 'budgetsUsersStatus', [], '/api/budgets/users/status');
  }

  /**
   * GET /api/v2/config：AI SDK 格式模型定价表（61 模型 cost/limit/capabilities，
   * 约 20KB）。价格低频变动 → 10 分钟长缓存（MODEL_PRICING_TTL_MS）。
   */
  modelPricing(id: number): Promise<unknown | null> {
    return this.cachedGet(id, 'modelPricing', [], '/api/v2/config', MODEL_PRICING_TTL_MS);
  }

  members(id: number, pageSize: number): Promise<unknown | null> {
    return this.cachedGet(id, 'members', [pageSize], `/api/members?pageSize=${pageSize}`);
  }

  serviceAccounts(id: number, pageSize: number): Promise<unknown | null> {
    return this.cachedGet(
      id,
      'serviceAccounts',
      [pageSize],
      `/api/service-accounts?pageSize=${pageSize}`,
    );
  }

  providers(id: number): Promise<unknown | null> {
    return this.cachedGet(id, 'providers', [], '/api/providers');
  }

  budgetsOrg(id: number): Promise<unknown | null> {
    return this.cachedGet(id, 'budgetsOrg', [], '/api/budgets/org');
  }

  // -------------------------------------------------------------------------
  // 写操作（POST，供后续接线。路径/参数形状按 REST 惯例，待真实页面验证）
  // -------------------------------------------------------------------------

  setAutoRecharge(
    id: number,
    input: { enabled: boolean; thresholdDollars: number; rechargeAmountDollars: number },
  ): Promise<ConsoleWriteResult> {
    return this.postJson(id, '/api/billing/auto-recharge', input);
  }

  setMonthlyLimit(id: number, limitDollars: number): Promise<ConsoleWriteResult> {
    return this.postJson(id, '/api/billing/monthly-limit', { limitDollars });
  }

  createServiceAccount(id: number, name: string): Promise<ConsoleWriteResult> {
    return this.postJson(id, '/api/service-accounts', { name });
  }

  removeServiceAccount(id: number, saId: string): Promise<ConsoleWriteResult> {
    return this.postJson(id, `/api/service-accounts/${encodeURIComponent(saId)}/remove`, {});
  }

  // -------------------------------------------------------------------------
  // 健康态（面板展示用；不阻断请求）
  // -------------------------------------------------------------------------

  /** 该账户 console 通道是否判定 cookie 失效（401/403 一次即失效；非 auth 失败不判定）。 */
  cookieStatus(id: number): 'ok' | 'invalid' {
    return this.health.get(id)?.invalid ? 'invalid' : 'ok';
  }

  /**
   * 失效凭据所在的通道（'cookie' | 'oauth'）——未失效 → null。
   * 面板据此区分恢复指引：cookie 失效 → 更新/导入 cookie；OAuth Bearer
   * 失效（refresh_token 过期/撤销）→ 重新走 Sign in with OpenCode 授权。
   */
  authChannel(id: number): 'cookie' | 'oauth' | null {
    const h = this.health.get(id);
    return h && h.invalid ? (h.channel ?? 'cookie') : null;
  }

  /**
   * 凭据更新（粘贴新 cookie / OAuth 重新登录 / 切换 workspace）后调用：清
   * invalid 标记 + access 缓存 + **读缓存** —— 否则健康态死锁（旧 cookie 401
   * 标记后新 cookie 永不被尝试，审查 H2），且切换 workspace 后读缓存仍按旧
   * workspace 命中（缓存键不含 workspaceId），面板会继续显示旧工作区的数据
   * 直到 TTL 过期。
   */
  noteCredentialChanged(id: number): void {
    this.health.delete(id);
    this.lastErr.delete(id);
    this.accessCache.delete(id);
    this.invalidate(id);
  }

  /** 最近一次失败原因（'auth' | 'upstream' | 'no-cred' | null）——区分
   *  「200+JSON null（合法响应）」与「调用失败」用：读端点返回 null 时，
   *  调用方查它判断是真实失败还是合法空值。 */
  lastError(id: number): 'auth' | 'upstream' | 'no-cred' | null {
    const e = this.lastErr.get(id);
    return e ?? null;
  }

  /** 清空读缓存（手动刷新 / 写操作成功后调用）。 */
  invalidate(id: number): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${id}:`)) this.cache.delete(key);
    }
    // 代数 +1：发起于 invalidate 之前的挂起读，响应回来时发现代数变了，
    // 直接把旧数据丢弃、不写缓存（M2：写成功后 ≤30s 显示旧数据的竞态根因）。
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** usage 列表类端点（models/users）的路径：range + since + pageSize。 */
  private usageListPath(base: string, rangeDays: number, pageSize: number): string {
    const { range, since } = usageRangeAndSince(rangeDays, this.now());
    return `${base}?range=${range}&since=${since}&pageSize=${pageSize}`;
  }

  private async cachedGet(
    id: number,
    name: string,
    args: readonly (string | number)[],
    path: string,
    ttlMs?: number,
  ): Promise<unknown | null> {
    const key = `${id}:${name}:${args.join(',')}`;
    const hit = this.cache.get(key);
    const now = this.now();
    if (hit && now < hit.at + hit.ttl) return hit.data;
    // 发起时记录代数；响应期间发生过 invalidate（写操作成功）则代数已变，
    // 旧值丢弃不写缓存（M2 竞态防护）。
    const gen = this.generations.get(id) ?? 0;
    const data = await this.getJson(id, path);
    // 注意两侧都要 ?? 0：从未 invalidate 过的账户 generations 里没有条目，
    // get 返回 undefined —— 与发起时记录的 0 相等才算代数没变。
    if (gen !== (this.generations.get(id) ?? 0)) return data;
    // 只缓存成功响应 —— 失败永远重新打上游，不给面板喂过期真相。
    if (data !== null) this.cache.set(key, { at: now, ttl: ttlMs ?? this.ttlMs, data });
    return data;
  }

  private async getJson(id: number, path: string): Promise<unknown | null> {
    const cred = await this.getCredentials(id);
    if (!cred) return null;
    const headers: Record<string, string> = {
      'x-org-id': cred.workspaceId,
      accept: 'application/json',
    };
    if (cred.type === 'cookie') {
      headers.cookie = cred.cookie;
    } else {
      headers.authorization = `Bearer ${cred.token}`;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // 网络层失败 / 超时。
      this.recordFail(id, false);
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[console] account=${id} fetch failed: ${msg.slice(0, 200)}`);
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      // 静默：cookie 是敏感凭证，失效时不打任何日志细节，只标记健康态。
      // 通道一并记下（cookie 失效 vs OAuth Bearer 失效 → 面板给不同指引）。
      this.recordFail(id, true, cred.type === 'cookie' ? 'cookie' : 'oauth');
      return null;
    }
    if (!res.ok) {
      this.recordFail(id, false);
      this.log(`[console] account=${id} status ${res.status}`);
      return null;
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      this.recordFail(id, false);
      this.log(`[console] account=${id} parse failed`);
      return null;
    }
    this.recordOk(id);
    return data;
  }

  private async postJson(id: number, path: string, body: unknown): Promise<ConsoleWriteResult> {
    const cred = await this.getCredentials(id);
    if (!cred) {
      return { ok: false, reason: 'no-cookie' };
    }
    const headers: Record<string, string> = {
      'x-org-id': cred.workspaceId,
      accept: 'application/json',
      'content-type': 'application/json',
    };
    if (cred.type === 'cookie') {
      headers.cookie = cred.cookie;
    } else {
      headers.authorization = `Bearer ${cred.token}`;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      this.recordFail(id, false);
      return { ok: false, reason: 'upstream' };
    }
    if (res.status === 401 || res.status === 403) {
      this.recordFail(id, true, cred.type === 'cookie' ? 'cookie' : 'oauth');
      return { ok: false, reason: 'auth' };
    }
    if (!res.ok) {
      this.recordFail(id, false);
      this.log(`[console] account=${id} POST ${path} status ${res.status}`);
      return { ok: false, reason: 'upstream' };
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      this.recordFail(id, false);
      this.log(`[console] account=${id} POST ${path} parse failed`);
      return { ok: false, reason: 'parse' };
    }
    this.recordOk(id);
    // 写成功即失效该账户全部读缓存，面板下次轮询拿到新值。
    this.invalidate(id);
    return { ok: true, data };
  }

  /**
   * 取进程内凭据（cookie 优先；无 cookie 但有 OAuth refresh_token 时走
   * 服务器端 Bearer fallback —— refresh → access，用户不用复制 cookie）。
   * 缺失返回 null 并打一条日志（缺失本身不算失败，不推进健康态）。
   * refresh token 轮换：响应带新 refresh_token 就写回（旧值已失效）。
   */
  private async getCredentials(
    id: number,
  ): Promise<
    | { type: 'cookie'; cookie: string; workspaceId: string }
    | { type: 'bearer'; token: string; workspaceId: string }
    | null
  > {
    const workspaceId = this.accounts.workspaceIdOf(id);
    if (!workspaceId) {
      this.log(`[console] account=${id} no workspace, skip`);
      return null;
    }
    const cookie = this.accounts.cookieOf(id);
    // cookie 优先，但健康态已标记 invalid（此前 401）时跳过 cookie 走 Bearer ——
    // 账号可能同时有「旧版 auth cookie（对新版 API 无效）」和活 OAuth token，
    // cookie 失败后必须回退 Bearer，否则通道永久锁死在 invalid（审查 m3）。
    if (cookie && this.cookieStatus(id) !== 'invalid') return { type: 'cookie', cookie, workspaceId };
    // Bearer fallback：OAuth 账号（device flow 登录存了 refresh_token）。
    // access_token 进程内缓存（refresh 一次用 expires_in，避免每次请求都
    // refresh 轮换导致并发踩踏）。
    const cached = this.accessCache.get(id);
    if (cached && cached.expiresAt > this.now()) {
      return { type: 'bearer', token: cached.token, workspaceId };
    }
    const refresh = this.accounts.getOauthRefresh(id);
    if (!refresh) {
      this.log(`[console] account=${id} no cookie/oauth, skip`);
      return null;
    }
    // 单飞：并发请求共享同一个 refresh（轮换 token 只允许一次成功）。
    const inflight = this.refreshInflight.get(id);
    if (inflight) {
      const r = await inflight;
      if (!r) return null;
      return { type: 'bearer', token: r.token, workspaceId: r.workspaceId };
    }
    const p = this.doRefresh(id, refresh, workspaceId);
    this.refreshInflight.set(id, p);
    try {
      const r = await p;
      if (!r) return null;
      return { type: 'bearer', token: r.token, workspaceId: r.workspaceId };
    } finally {
      this.refreshInflight.delete(id);
    }
  }

  /** 单次 refresh 流程（成功后写回轮换 token + 缓存 access）。 */
  private async doRefresh(
    id: number,
    refresh: string,
    workspaceId: string,
  ): Promise<{ ok: boolean; token: string; workspaceId: string } | null> {
    try {
      let r = await this.refreshAccess(id, refresh);
      if (!r.ok) {
        // rotation 竞态兜底：探针/其他进程可能刚用旧 token 换过新值，
        // 用最新 token 再试一次；仍失败才是真失效。
        const latest = this.accounts.getOauthRefresh(id);
        if (latest != null && latest !== refresh) {
          r = await this.refreshAccess(id, latest);
        }
      }
      if (!r.ok) {
        // 401/403 = refresh_token 真失效（invalid_grant / revoked）→ OAuth 凭据失效；
        // 其他（网络/5xx）是上游故障，**不误判失效** —— 面板不能因为一次网络
        // 抖动就提示用户重新授权（对 OAuth 账号这是最贵的误报）。
        const auth = r.status === 401 || r.status === 403;
        this.recordFail(id, auth, 'oauth');
        this.log(`[console] account=${id} oauth refresh fail ${r.status}`);
        return null;
      }
      const { token, newRefresh, expiresIn } = r;
      if (!token) {
        this.recordFail(id, true);
        this.log(`[console] account=${id} oauth refresh 缺 access_token`);
        return null;
      }
      if (newRefresh) {
        // refresh token 轮换：新值写回，否则下次用旧值必然 invalid_grant。
        this.accounts.setOauthRefresh(id, newRefresh);
      }
      // 缓存 access（留 60s 余量防过期边界）。
      this.accessCache.set(id, { token, expiresAt: this.now() + (expiresIn - 60) * 1000 });
      return { ok: true, token, workspaceId };
    } catch (err) {
      this.recordFail(id, false);
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[console] account=${id} oauth refresh failed: ${msg.slice(0, 120)}`);
      return null;
    }
  }

  /** 用 refresh_token 换 access_token（不判失败，由调用方处理竞态重试）。 */
  private async refreshAccess(
    id: number,
    refreshToken: string,
  ): Promise<{ ok: boolean; status: number; token: string; newRefresh: string | null; expiresIn: number }> {
    try {
      const r = await this.fetchImpl(`${this.baseUrl}/auth/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.clientId,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!r.ok) return { ok: false, status: r.status, token: '', newRefresh: null, expiresIn: 0 };
      const d = (await r.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
      const token = typeof d.access_token === 'string' && d.access_token ? d.access_token : '';
      if (!token) return { ok: false, status: 200, token: '', newRefresh: null, expiresIn: 0 };
      const newRefresh = typeof d.refresh_token === 'string' && d.refresh_token ? d.refresh_token : null;
      const expiresIn = typeof d.expires_in === 'number' && d.expires_in > 60 ? d.expires_in : 3_600;
      return { ok: true, status: 200, token, newRefresh, expiresIn };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[console] account=${id} oauth refresh failed: ${msg.slice(0, 120)}`);
      return { ok: false, status: 0, token: '', newRefresh: null, expiresIn: 0 };
    }
  }

  private recordFail(id: number, auth: boolean, channel: 'cookie' | 'oauth' | null = null): void {
    let h = this.health.get(id);
    if (!h) {
      h = { consecutiveFails: 0, invalid: false, channel: null };
      this.health.set(id, h);
    }
    if (auth) {
      // 只有 auth 失败（401/403）判定凭据失效 —— cookie 失效的唯一证据；
      // 同时记下是哪个通道失效（cookie vs OAuth Bearer，面板据此给恢复指引）。
      h.invalid = true;
      h.channel = channel;
    } else {
      // 非 auth 失败（网络/5xx/parse）只累计连续计数（供面板观测），
      // **不触发 invalid**：网络抖动与上游故障和凭据无关（M-6），
      // 混入会让通道被误判失效，面板 2s 轮询白白打无效状态。
      h.consecutiveFails++;
    }
    this.lastErr.set(id, auth ? 'auth' : 'upstream');
  }

  private recordOk(id: number): void {
    const h = this.health.get(id);
    if (h) {
      h.consecutiveFails = 0;
      h.invalid = false;
      h.channel = null;
    }
    this.lastErr.set(id, null);
  }
}
