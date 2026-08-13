/**
 * key 主动探活（账户驱动）。
 *
 * 为什么需要：面板上的「可用」只代表**不在冷却期**，不代表验证过能用。
 * 实测遇到过两个 key 都显示可用、但 40 分钟里谁都没接过真实请求 ——
 * 那时面板是绿的，可它们到底还能不能用没人知道，只有等真实流量撞上去
 * 才会发现（而那一撞就是用户的请求失败）。
 *
 * 做法（MULTI-ACCOUNT.md §4.4）：每轮从 accounts 里挑出「探针已到期」的账户
 * （到期含提前 5min 窗口），取该账户第一个 key 发一个**最小开销**的真实请求。
 * 成功就把账户标 ok、retry_until 推到 keyProbeIdleMs 之后（闲置才再探）；
 * 失败按 classifyAccountError 分流：账户状态/重探时间写进 accounts，key 走
 * 与真实流量完全相同的 pool.markFailure 路径 —— 该禁用的照样禁用，让面板
 * 提前知道，而不是等用户的请求去踩。
 *
 * 两条克制原则（额度很珍贵）：
 * - 冷却期不探。账户的 retry_until 是探针调度闸门（§4.3），与 pool 的选路
 *   冷却各管各的、互不写入；到期前 5min 提前窗口探一次，确认恢复或延长冷却。
 * - 有真实流量不探。账户任一 key 最近被选中过就说明它活着，不需要额外证明。
 */

import type { AppConfig } from './config.js';
import { classifyAccountError, classifyUpstreamFailure, resetDelayMsFromError, stripSecrets } from './errors.js';
import type { KeyPool } from './keypool.js';
import { keyFingerprint } from './keypool.js';
import type { UsageDb } from './usagedb.js';
import type { AccountsStore, AccountView } from './accounts.js';

/** 订阅端点的探活模型。上游只承载 DeepSeek，固定用这个。 */
export const PROBE_MODEL = 'deepseek-v4-flash';

/** 按量（payg）端点的探活模型。`-free` 只在按量端点存在，订阅端点 401（MULTI-ACCOUNT.md §4.4）。 */
export const PAYG_PROBE_MODEL = 'deepseek-v4-flash-free';

/** 到期提前探活窗口：5 分钟（§4.5）。retry_until 落进这个窗口即算到期。 */
const PROBE_EARLY_MS = 300_000;

/** 探活请求体：最小 token 开销。 */
function probeBody(model: string): Record<string, unknown> {
  return {
    model,
    // 1 个 token 就够判断链路是否通 —— 我们只关心状态码，不关心回什么。
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  };
}

export interface ProbeResult {
  fingerprint: string;
  ok: boolean;
  status: number;
  durationMs: number;
  /** 失败时的分类，与真实流量用同一套 classifyUpstreamFailure。 */
  kind?: 'auth' | 'rate-limit' | 'quota-exhausted' | 'transient';
  error?: string;
  /** 上游错误响应体（失败时可能有）。runProbeRound 的账户级分类与 status_detail 用。 */
  body?: unknown;
}

/**
 * 从上游错误体提取「type + message」，作账户 status_detail 的原料
 * （setProbeResult 里统一 stripControl + 截断 200）。解析不出返回空串。
 */
function probeDetail(body: unknown): string {
  if (body != null && typeof body === 'object') {
    const err = (body as { error?: unknown }).error;
    if (err != null && typeof err === 'object') {
      const e = err as { type?: unknown; message?: unknown };
      const type = typeof e.type === 'string' ? e.type : '';
      const message = typeof e.message === 'string' ? e.message : '';
      // stripSecrets：上游 error.message 可能回显 Authorization 头（Bearer sk-xxx），
      // detail 会落 accounts.status_detail 并显示在面板上，必须脱敏。
      if (type || message) return stripSecrets(type ? `${type}: ${message}` : message);
    }
    const top = (body as { message?: unknown }).message;
    if (typeof top === 'string' && top) return stripSecrets(top);
  }
  return '';
}

/**
 * 探一个指定的 key（单 key 底层函数）。
 *
 * 刻意**不走** `postUpstreamChat` —— 那个函数内部用 `pool.acquire()` 按
 * least-loaded 自己挑 key，而探活必须打到指定的那一个。所以这里直接发请求，
 * 但成功/失败的处理复用 pool 的 markSuccess/markFailure，保证探活得出的
 * 结论和真实流量完全一致（同样的分类、同样的冷却、同样的面板呈现）。
 *
 * @param baseUrl 上游 base URL（按账户 kind 分流，见 runProbeRound）
 * @param model 探活模型（订阅端点 PROBE_MODEL / 按量端点 PAYG_PROBE_MODEL）
 */
export async function probeKey(
  cfg: AppConfig,
  pool: KeyPool,
  key: string,
  fingerprint: string,
  timeoutMs: number,
  baseUrl: string,
  model: string,
): Promise<ProbeResult> {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(probeBody(model)),
      signal: ac.signal,
    });

    const durationMs = Date.now() - started;
    if (res.ok) {
      // 把 body 读干净再丢，避免连接悬着。
      await res.text().catch(() => '');
      pool.markSuccess(key);
      return { fingerprint, ok: true, status: res.status, durationMs };
    }

    let body: unknown = null;
    const raw = await res.text().catch(() => '');
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const kind = classifyUpstreamFailure(res.status, body);
    const resetMs = resetDelayMsFromError(body);
    pool.markFailure(key, kind, resetMs ?? undefined);
    // 探活也能发现额度耗尽：记录上游错误，供池空时原样透传给下游。
    if (kind === 'quota-exhausted') pool.noteQuotaError(res.status, body);
    return {
      fingerprint,
      ok: false,
      status: res.status,
      durationMs,
      kind,
      // 先脱敏再截断：错误体可能回显 Bearer sk-xxx（见 stripSecrets 注释），
      // error 会进 requests.error 列与面板。slice 放后面保证 key 不被截断漏掉。
      error: `probe ${res.status}: ${stripSecrets(raw).slice(0, 200)}`,
      body,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    // 网络层失败（超时、连不上）算 transient：可能是本机网络抖动而非 key 的问题，
    // 让它累计到阈值再禁用，不要因为一次探活失败就误杀一个好 key。
    pool.markFailure(key, 'transient');
    const msg = err instanceof Error ? err.message : String(err);
    return {
      fingerprint,
      ok: false,
      status: 0,
      durationMs,
      kind: 'transient',
      error: `probe failed: ${stripSecrets(msg).slice(0, 200)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跑一轮探活（账户驱动，MULTI-ACCOUNT.md §4.4）：把所有「探针已到期」的
 * 账户各探一次代表 key。
 *
 * 候选规则：
 * 1. `now >= retry_until - PROBE_EARLY_MS`（到期，含提前 5min 窗口；0 = 立即可探）
 * 2. 账户至少 1 个 key
 * 3. 该账户任一 key 的 lastUsedAt 新鲜（> now - keyProbeIdleMs）→ 跳过（有真实流量）
 *
 * 代表 key 取账户第一个，不因 pool 禁用跳过 —— 禁用中探一次恰好是「到期前
 * 确认恢复」的主力手段（重报同类错误不会延长 pool 冷却，见 §4.3）。
 *
 * 串行探而非并发：探活是后台维护动作，没必要为了快去抢占上游并发额度，
 * 也避免同时打多个请求触发上游的速率限制。
 */
export async function runProbeRound(
  cfg: AppConfig,
  pool: KeyPool,
  db: UsageDb | null,
  accounts: AccountsStore | null,
  log: (msg: string) => void = console.log,
): Promise<ProbeResult[]> {
  // 账户面不可用（db/密钥降级，§2.3）时没有可探的账户，直接空转。
  if (!accounts) return [];
  const now = Date.now();

  // 真实流量判断读 pool 内存快照（§1.2：探针调度读内存，不读表）。
  // 按账户聚合「最近一次被选中的时刻」，规则 3 用。
  const lastUsedByAccount = new Map<number, number>();
  for (const k of pool.snapshot()) {
    const prev = lastUsedByAccount.get(k.accountId) ?? 0;
    if (k.lastUsedAt > prev) lastUsedByAccount.set(k.accountId, k.lastUsedAt);
  }

  const candidates: Array<{ acc: AccountView; keys: string[]; oauth: string | null }> = [];
  for (const acc of accounts.list()) {
    if (now < acc.retryUntil - PROBE_EARLY_MS) continue; // 冷却期，不探
    const keys = accounts.keysOf(acc.id);
    // 有 key 走模型探针；没 key 但绑了 OAuth 的账号（refresh_token）走
    // OAuth 会话探测（refresh → /api/orgs 验证）——纯 OAuth 账号也要有状态。
    const oauth = !keys || keys.length === 0 ? accounts.getOauthRefresh(acc.id) : null;
    if ((!keys || keys.length === 0) && oauth == null) continue; // 没 key 没 OAuth，没得探
    if ((lastUsedByAccount.get(acc.id) ?? 0) > now - cfg.keyProbeIdleMs) continue; // 有真实流量，活着
    candidates.push({ acc, keys: keys ?? [], oauth });
  }
  if (candidates.length === 0) return [];

  const results: ProbeResult[] = [];
  for (const { acc, keys, oauth } of candidates) {
    // 纯 OAuth 账号（无 key）：验证 OAuth 会话有效性（refresh → /api/orgs）。
    if (keys.length === 0 && oauth != null) {
      results.push(await probeOauthAccount(cfg, accounts, acc, oauth, log, db, now));
      continue;
    }
    // 端点与模型按 kind 分流（§4.4）：subscription/unknown → 订阅端点 + flash；
    // payg → 按量端点 + `-free`。探错端点会把好号判成 auth 错误（`-free` 在
    // 订阅端点 401 ModelError），所以必须按 kind 选。
    const payg = acc.kind === 'payg';
    const model = payg ? PAYG_PROBE_MODEL : PROBE_MODEL;
    const baseUrl = payg ? cfg.payAsYouGoBaseUrl : cfg.anthropicBaseUrl;
    // 每个 key 都要探，不只 keys[0]。env 种子把整组 OPENSEA_KEYS 塞进一个账户，
    // 只探第一个会让排在后边的 key 的「额度已耗尽」永远不被发现 —— 池内存是
    // 进程级，重启即清零，坏 key 会一直挂着 healthy 被 least-loaded 选中派发
    // 流量（2026-08-14 线上实测：probe 只打 env 账户 keys[0]，其余 key 从未被
    // 验证，GoUsageLimitError 的 key 一直 healthy）。
    // pool 侧的成功/失败已由 probeKey 处理（markSuccess/markFailure）。
    let firstFail: ProbeResult | null = null;
    let lastOk: ProbeResult | null = null;
    for (const key of keys) {
      const r = await probeKey(cfg, pool, key, keyFingerprint(key), cfg.keyProbeTimeoutMs, baseUrl, model);
      results.push(r);
      if (r.ok) lastOk = r;
      else if (firstFail === null) firstFail = r;

      // 探活结果也落库，这样面板的「累计」和历史里能看出哪些请求是探活产生的
      // （endpoint = 'probe'），不会和真实流量混淆。
      db?.recordRequest({
        at: now,
        keyFingerprint: r.fingerprint,
        model,
        upstreamModel: model,
        endpoint: 'probe',
        status: r.status,
        durationMs: r.durationMs,
        stream: false,
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        error: r.error ?? null,
        // 探针是后台维护动作：path 记实际请求路径，ua 不记（node fetch 默认 UA
        // 无信息量；client 会因此落 'unknown'，靠 endpoint='probe' 区分）。
        path: '/v1/chat/completions',
        ua: '',
      });
    }

    // 探针结论写账（§4.4）：全部 key 通过 → ok + retry_until 推到空闲阈值之后
    // （闲置 60min 再探）；任一失败 → 按 §4.2 表分流（取第一个失败，最严重的
    // 语义），retry_until = now + retryMs。
    if (firstFail === null) {
      accounts.setProbeResult(acc.id, {
        status: 'ok',
        detail: null,
        retryUntil: now + cfg.keyProbeIdleMs,
        lastProbeAt: now,
      });
      const ok = lastOk;
      log(
        `[keyprobe] account=${acc.name} probe ok ` +
          (keys.length === 1 && ok ? `${ok.status}（${ok.durationMs}ms）` : `${keys.length} keys`),
      );
    } else {
      const acct = classifyAccountError(firstFail.status, firstFail.body, cfg.keyCooldownMs);
      const detail = probeDetail(firstFail.body) || firstFail.error || null;
      accounts.setProbeResult(acc.id, {
        status: acct.status,
        detail,
        retryUntil: now + acct.retryMs,
        lastProbeAt: now,
      });
      log(`[keyprobe] account=${acc.name} probe fail ${firstFail.status} ${acct.status}（${firstFail.error ?? ''}）`);
    }
  }
  return results;
}

/**
 * 启动周期探活。返回停止函数。
 *
 * `unref()` 掉定时器：探活是后台维护，不该拖住进程退出。
 */
export function startKeyProbe(
  cfg: AppConfig,
  pool: KeyPool,
  db: UsageDb | null,
  accounts?: AccountsStore | null,
  log?: (msg: string) => void,
): () => void {
  if (cfg.keyProbeIntervalMs <= 0) return () => {};

  const logger = log ?? console.log;
  let running = false;
  const tick = async () => {
    if (running) return; // 上一轮还没跑完（上游很慢），跳过这一轮
    running = true;
    try {
      await runProbeRound(cfg, pool, db, accounts ?? null, logger);
    } catch (err) {
      // 探活绝不能拖垮进程 —— 它是观测设施。
      logger(`[keyprobe] 本轮异常（已忽略）: ${err instanceof Error ? err.message : err}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, cfg.keyProbeIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/**
 * OAuth 账号探测（无 key、有 refresh_token）：refresh → access_token →
 * GET /api/orgs 验证 OAuth 会话是否还有效。成功 = ok（会话有效）；
 * 401/refresh 失败 = invalid（需要重新登录）；网络失败 = error（下次再探）。
 * refresh_token 只在本函数内流转，不落日志。
 */
async function probeOauthAccount(
  cfg: AppConfig,
  accounts: AccountsStore,
  acc: AccountView,
  refreshToken: string,
  log: (msg: string) => void,
  db: UsageDb | null,
  now: number,
): Promise<ProbeResult> {
  const started = Date.now();
  const fail = (status: number, reason: string): ProbeResult => ({
    ok: false,
    fingerprint: '',
    status,
    durationMs: Date.now() - started,
    error: reason,
  });
  const base = cfg.oauthConsoleUrl || 'https://console.opencode.ai';
  try {
    // refresh 单次请求（token 作参数，竞态重试复用）。
    const doRefresh = async (token: string): Promise<Response> =>
      fetch(`${base}/auth/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: token,
          client_id: cfg.oauthClientId,
        }),
        signal: AbortSignal.timeout(cfg.keyProbeTimeoutMs),
      });

    let refresh = await doRefresh(refreshToken);
    if (!refresh.ok && (refresh.status === 401 || refresh.status === 403)) {
      // rotation 竞态兜底（与 console.doRefresh 同款）：console 通道/另一轮
      // 探针可能刚用旧 token 换过新值（每次 refresh 旧值立即失效），输掉竞态
      // 的一方拿旧 token 必然 invalid_grant —— 重读最新 token 再试一次，仍
      // 失败才是真失效。否则健康账户会被误判 invalid 卡一整轮 idle（60min）。
      const latest = accounts.getOauthRefresh(acc.id);
      if (latest != null && latest !== refreshToken) {
        refresh = await doRefresh(latest);
      }
    }
    if (!refresh.ok) {
      // 401 = refresh_token 失效（会话过期/撤销）；5xx = 上游抖动。
      const invalid = refresh.status === 401 || refresh.status === 403;
      accounts.setProbeResult(acc.id, {
        status: invalid ? 'invalid' : 'error',
        detail: invalid ? 'OAuth 会话已失效，请重新登录' : `refresh 失败 ${refresh.status}`,
        retryUntil: now + (invalid ? cfg.keyProbeIdleMs : cfg.keyProbeTimeoutMs * 10),
        lastProbeAt: now,
      });
      log(`[keyprobe] account=${acc.name} oauth refresh fail ${refresh.status}（${invalid ? 'invalid' : 'error'}）`);
      return fail(refresh.status, invalid ? 'oauth-invalid' : 'oauth-refresh-error');
    }
    const data = (await refresh.json()) as { access_token?: unknown; refresh_token?: unknown };
    // refresh token 轮换：响应带新 refresh_token 就写回 —— 否则旧 token 已失效，
    // 下一次探测必然 invalid_grant（实测线上踩过）。
    if (typeof data.refresh_token === 'string' && data.refresh_token) {
      accounts.setOauthRefresh(acc.id, data.refresh_token);
    }
    const access = typeof data.access_token === 'string' && data.access_token ? data.access_token : '';
    if (!access) {
      accounts.setProbeResult(acc.id, {
        status: 'error',
        detail: 'refresh 响应缺 access_token',
        retryUntil: now + cfg.keyProbeTimeoutMs * 10,
        lastProbeAt: now,
      });
      log(`[keyprobe] account=${acc.name} oauth refresh 缺 access_token`);
      return fail(502, 'oauth-no-access-token');
    }
    const orgs = await fetch(`${base}/api/orgs`, {
      headers: { authorization: `Bearer ${access}` },
      signal: AbortSignal.timeout(cfg.keyProbeTimeoutMs),
    });
    if (!orgs.ok) {
      accounts.setProbeResult(acc.id, {
        status: 'error',
        detail: `orgs 拉取失败 ${orgs.status}`,
        retryUntil: now + cfg.keyProbeTimeoutMs * 10,
        lastProbeAt: now,
      });
      log(`[keyprobe] account=${acc.name} oauth orgs fail ${orgs.status}`);
      return fail(orgs.status, 'oauth-orgs-error');
    }
    accounts.setProbeResult(acc.id, {
      status: 'ok',
      detail: null,
      retryUntil: now + cfg.keyProbeIdleMs,
      lastProbeAt: now,
    });
    log(`[keyprobe] account=${acc.name} oauth ok（${Date.now() - started}ms）`);
    // 顺带抓余额写 accounts 表（面板账号卡的余额来源）——OAuth 探测本来就
    // 有 access_token 在手里，多打一次 /api/billing/status 即可；失败不影响
    // 探针结论（余额下次再补）。
    await fetchAccountBalance(cfg, accounts, acc, access, log);
    return { ok: true, fingerprint: '', status: 200, durationMs: Date.now() - started };
  } catch (err) {
    accounts.setProbeResult(acc.id, {
      status: 'error',
      detail: `OAuth 探测网络失败：${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}`,
      retryUntil: now + cfg.keyProbeTimeoutMs * 10,
      lastProbeAt: now,
    });
    log(`[keyprobe] account=${acc.name} oauth probe network error`);
    return fail(502, 'oauth-network-error');
  }
}

/**
 * 探针成功后顺带抓一次 /api/billing/status 写 accounts 表（面板账号卡的
 * 余额/月额度数据源）。失败只打日志不重试（下次探针再补）——观测设施哲学。
 */
async function fetchAccountBalance(
  cfg: AppConfig,
  accounts: AccountsStore,
  acc: AccountView,
  accessToken: string,
  log: (msg: string) => void,
): Promise<void> {
  const workspaceId = accounts.workspaceIdOf(acc.id);
  if (!workspaceId) return;
  const base = cfg.oauthConsoleUrl || 'https://console.opencode.ai';
  try {
    const r = await fetch(`${base}/api/billing/status`, {
      headers: { authorization: `Bearer ${accessToken}`, 'x-org-id': workspaceId },
      signal: AbortSignal.timeout(cfg.keyProbeTimeoutMs),
    });
    if (!r.ok) return;
    const d = (await r.json()) as { balanceMicroCents?: unknown; combinedAvailableMicroCents?: unknown };
    const pick = (v: unknown): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
    };
    const units =
      pick(d.combinedAvailableMicroCents) ??
      pick(d.balanceMicroCents);
    if (units === undefined) return;
    accounts.setBilling(acc.id, { balanceUnits: units, at: Date.now() });
  } catch (err) {
    log(`[keyprobe] account=${acc.name} balance sync failed: ${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}`);
  }
}
