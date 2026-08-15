/**
 * billing 余额抓取（多账号面板：余额 / 月额度 / 月用量）。
 *
 * 为什么需要：面板想知道「这个号还有多少余额、月额度用了多少」。上游 opencode.ai
 * 的 billing 页面有登录态就能看，但没有公开 API —— 所以用账户的 auth cookie 直接
 * 抓页面、解析水合数据 / 渲染文本，不走任何 API。
 *
 * 三条克制原则（延续 usagedb 的观测哲学）：
 * 1. 抓取失败只记日志 + 每账户独立退避，绝不阻塞代理链路 —— 这是观测设施。
 * 2. 失败日志只记状态码和账户名，绝不记响应体 —— billing 页面可能含其他账户数据。
 * 3. 不新开定时器密度：每 15min tick 一次（复用探针粒度），逐账户按 nextDueAt
 *    判断，首轮错峰防 thundering herd。
 *
 * TODO(spike，上线前必做)：§5.3 两条解析正则的目标形态来自 MULTI-ACCOUNT.md 草图
 * 与社区实现（opencode-quota），真实 Next.js 页面结构**未实测**。按契约 §5.4 的
 * spike 步骤验证后再上线：
 *   1. 用真实 auth cookie 抓一次 https://opencode.ai/workspace/{ws}/billing，
 *      把 HTML 存成 test/fixtures/billing-*.html
 *   2. 核对主解析（script 水合）与兜底（data-slot）两条正则是否命中
 *   3. 按实测页面调整正则，并把 fixture 固化进单测
 */

import type { AppConfig } from './config.js';

/** 换算口径：100,000,000 units = $1（§5.3）。库内全程整数 units，防浮点漂移。 */
export const UNITS_PER_DOLLAR = 100_000_000;

/** 调度 tick 粒度：每 15min 一次，复用探针 tick（§5.4，不新开定时器密度）。 */
export const BILLING_TICK_MS = 15 * 60_000;

/** 首轮错峰：启动后第 15s 起，每账户再错开 25s（§5.4，防 thundering herd）。 */
const FIRST_ROUND_DELAY_MS = 15_000;
const FIRST_ROUND_STAGGER_MS = 25_000;

/**
 * 失败退避阶梯：15 → 30 → 60 → 120min 封顶（§5.4）。
 * 为什么退避：billing 页面公开，失败大概率是持久的（cookie 过期 / workspace id 错），
 * 30min 一锤子打到天荒地老没有意义。
 */
const BACKOFF_LADDER_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000, 120 * 60_000] as const;

/** 抓到的余额字段（units）。缺失字段 = 页面没给 / 被校验丢弃，调用方保留旧值。 */
export interface BillingUnits {
  balanceUnits?: number;
  monthlyLimitUnits?: number;
  monthlyUsageUnits?: number;
}

/** 单次抓取结果：ok + 至少一个字段；失败带原因（原因绝不含响应体）。 */
export type BillingResult =
  | { ok: true; result: BillingUnits }
  | { ok: false; reason: string };

/** billing 对 accounts 的最小接口假设（duck typing，不 import accounts.ts）。 */
export interface BillingAccountRow {
  id: number;
  name: string;
  workspaceId: string | null;
  /** 是否有 billing cookie 的布尔事实；明文不经过 list()。 */
  hasCookie: boolean;
}

export interface BillingAccounts {
  list(): BillingAccountRow[];
  /**
   * 进程内解密账户的 billing cookie 原文；无 cookie / 解密失败 → null。
   * 明文只在 billing 模块内使用，绝不进日志 / 响应 / 面板。
   */
  billingCredential(id: number): string | null;
  /** 抓取成功后写账。patch 只含本次拿到的字段 + lastBillingAt（部分更新，§5.4）。 */
  setBilling(id: number, patch: BillingWritePatch): void;
}

/** setBilling 的写账形状：可选字段 = 本次没拿到，不覆盖旧值。 */
export interface BillingWritePatch {
  balanceUnits?: number;
  monthlyLimitUnits?: number;
  monthlyUsageUnits?: number;
  lastBillingAt: number;
}

/** 调度器内存态：每账户的到期时刻 + 退避梯级。重启清零（§5.4）。 */
export interface BillingLoopState {
  bootAt: number;
  due: Map<number, { nextDueAt: number; backoffIdx: number }>;
}

/** fetch 注入点：测试传假实现，默认全局 fetch。 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** fetchAccountBilling 的入参：workspace id + cookie 原文（accounts 进程内解密后的结果）。 */
export interface BillingFetchAccount {
  workspaceId: string | null;
  cookie: string | null;
}

// ---------------------------------------------------------------------------
// 解析（§5.3）
// ---------------------------------------------------------------------------

/** 抽所有 <script> 块（SSR 水合数据所在）。 */
const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * 主解析：水合数据里的整数 units。可选引号锚定：
 * JSON（"balance":5）与 JS 对象字面量（balance:5）两种形态都吃。
 */
// 词法约束（C-I1）：key 前必须紧跟 `{`/`,`（JSON/JS 对象键位置）——原正则无
// 上下文约束，会把 JSON **字符串值**里的 `balance:0` 之类文本（如错误信息
// "insufficient balance:0"）当余额字段解析，以 balance=0 覆写真实余额。加前缀
// 后只在对象键位置命中，字符串值/任意同名变量不再误匹配。
const HYDRATION_RE = /[{,]\s*"?(balance|monthlyLimit|monthlyUsage)"?\s*:\s*(\d+)/g;

/** 兜底：data-slot 渲染文本里的美元（¥€ 同吃），只在主解析一个可用值都没有时跑。 */
const SLOT_RE = /data-slot="(balance|monthlyLimit|monthlyUsage)"[^>]*>\s*(?:[$¥€])\s*([\d,]+(?:\.\d{1,2})?)/g;

/** 正则命中后的原始数值（未过合理性校验）。 */
interface RawUnits {
  balance?: number;
  monthlyLimit?: number;
  monthlyUsage?: number;
}

/** 在给定文本上跑一条 key→值 正则。同名 key 后出现者胜（水合状态通常是后者更完整）。 */
function collectMatches(re: RegExp, text: string, convert: (raw: string) => number): RawUnits | null {
  const raw: RawUnits = {};
  let found = false;
  for (const m of text.matchAll(re)) {
    const key = m[1]!; // 正则只产出 balance | monthlyLimit | monthlyUsage 三选一，else 即 monthlyUsage
    const val = convert(m[2]!);
    if (key === 'balance') raw.balance = val;
    else if (key === 'monthlyLimit') raw.monthlyLimit = val;
    else raw.monthlyUsage = val;
    found = true;
  }
  return found ? raw : null;
}

/** 主解析：逐 script 块扫水合数据；跨块同名 key 后块覆盖前块。 */
function collectHydration(html: string): RawUnits | null {
  const raw: RawUnits = {};
  let found = false;
  for (const script of html.matchAll(SCRIPT_RE)) {
    const hit = collectMatches(HYDRATION_RE, script[1] ?? '', (s) => Number(s));
    if (hit) {
      Object.assign(raw, hit);
      found = true;
    }
  }
  return found ? raw : null;
}

/** 兜底：data-slot 文本，dollar → units（§5.3 换算口径）。 */
function collectSlots(html: string): RawUnits | null {
  return collectMatches(SLOT_RE, html, (s) => Math.round(Number(s.replace(/,/g, '')) * UNITS_PER_DOLLAR));
}

/**
 * 合理性校验（§5.3），不满足即丢弃该值：
 * - 数值有限且 ≥ 0；
 * - monthlyLimit > 0；
 * - usage <= limit * 1.1（允许小余量）。不满足时整组（limit + usage）一起丢 ——
 *   两个值互相矛盾，宁可都不信，也不留一个可能也是错配的值。
 * 返回 null = 一个可用值都没有。
 */
function sanitizeUnits(raw: RawUnits): BillingUnits | null {
  const out: BillingUnits = {};
  if (raw.balance !== undefined && Number.isFinite(raw.balance) && raw.balance >= 0) {
    out.balanceUnits = raw.balance;
  }
  let limitOk = false;
  if (raw.monthlyLimit !== undefined && Number.isFinite(raw.monthlyLimit) && raw.monthlyLimit > 0) {
    out.monthlyLimitUnits = raw.monthlyLimit;
    limitOk = true;
  }
  if (raw.monthlyUsage !== undefined && Number.isFinite(raw.monthlyUsage) && raw.monthlyUsage >= 0) {
    // 没有 limit 时无法交叉校验，按单值规则放行（局部更新语义：拿到的就是真的）。
    const groupOk =
      raw.monthlyLimit === undefined || (limitOk && raw.monthlyUsage <= raw.monthlyLimit * 1.1);
    if (groupOk) {
      out.monthlyUsageUnits = raw.monthlyUsage;
    } else {
      delete out.monthlyLimitUnits; // 丢弃整组
    }
  }
  return out.balanceUnits !== undefined || out.monthlyLimitUnits !== undefined ||
    out.monthlyUsageUnits !== undefined
    ? out
    : null;
}

/**
 * 两步解析（§5.3）：
 * 1. 主解析：script 水合数据里的整数 units。
 * 2. 兜底：主解析一个可用值都没有时（没匹配到，或匹配到的全被合理性校验丢弃 ——
 *    比契约字面的「三个值全没找到」略宽，只会让结果变多不会变少），跑 data-slot 的
 *    dollar 文本。
 * 接受规则：至少拿到一个值 → 返回（缺失字段省略）；一个都没有 → null。
 */
export function parseBillingPage(html: string): BillingUnits | null {
  const fromMain = collectHydration(html);
  if (fromMain) {
    const cleaned = sanitizeUnits(fromMain);
    if (cleaned) return cleaned;
  }
  return sanitizeUnits(collectSlots(html) ?? {});
}

// ---------------------------------------------------------------------------
// 抓取与调度（§5.2 / §5.4）
// ---------------------------------------------------------------------------

/**
 * 抓单个账户的 billing 页面。**永不抛**，失败一律带原因：
 * - 'no workspace/cookie'：没配 workspace_id 或 cookie —— 不算抓取失败，调度器按
 *   正常间隔排下一次（管理面板随时可能补上）。
 * - 'status <code>'：非 2xx。**只带状态码** —— 页面可能含其他账户的数据，响应体
 *   绝不进日志和返回值。
 * - 'parse failed'：2xx 但页面解析不出任何可用值。
 * - 'fetch failed: <msg>'：网络层失败（超时、连不上）。
 */
export async function fetchAccountBilling(
  cfg: AppConfig,
  account: BillingFetchAccount,
  fetchImpl: FetchLike = fetch,
): Promise<BillingResult> {
  if (!account.workspaceId || !account.cookie) {
    return { ok: false, reason: 'no workspace/cookie' };
  }
  try {
    // 落库值统一为完整 name=value（B1，import-cookie/PATCH 都规范化成
    // `__Host-console_session=x` 或 `auth=x` 形态，原样发送）。兼容旧数据：
    // 不含 `=` 的裸值（早期版本落库形态）自动补 `auth=` 前缀再发。
    const cookieHeader = account.cookie.includes('=') ? account.cookie : `auth=${account.cookie}`;
    const res = await fetchImpl(
      `https://opencode.ai/workspace/${encodeURIComponent(account.workspaceId)}/billing`,
      {
        headers: {
          cookie: cookieHeader,
          accept: 'text/html',
          'user-agent': 'fuckopencode/0.1',
        },
        // 超时（默认 20s）：billing 是观测数据，绝不为它无限等。
        signal: AbortSignal.timeout(cfg.billingTimeoutMs),
      },
    );
    if (!res.ok) {
      return { ok: false, reason: `status ${res.status}` };
    }
    const html = await res.text();
    const parsed = parseBillingPage(html);
    if (!parsed) return { ok: false, reason: 'parse failed' };
    return { ok: true, result: parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `fetch failed: ${msg.slice(0, 200)}` };
  }
}

/**
 * 跑一轮抓取调度：遍历账户，按 nextDueAt 判断谁到期，串行抓（后台维护动作，
 * 不并发抢占上游）。
 *
 * 导出来单测（注入 now，不挂定时器）；startBillingLoop 的 tick 就是调它。
 */
export async function runBillingRound(
  cfg: AppConfig,
  accounts: BillingAccounts | null,
  state: BillingLoopState,
  now: () => number,
  log: (msg: string) => void,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  if (!accounts || cfg.billingIntervalMs <= 0) return;
  const t = now();
  for (const account of accounts.list()) {
    let due = state.due.get(account.id);
    if (!due) {
      // 首轮错峰：每个账户从 bootAt 错开（§5.4），防 thundering herd 打爆上游。
      due = {
        nextDueAt: state.bootAt + FIRST_ROUND_DELAY_MS + account.id * FIRST_ROUND_STAGGER_MS,
        backoffIdx: 0,
      };
      state.due.set(account.id, due);
    }
    if (t < due.nextDueAt) continue;
    if (!account.workspaceId || !account.hasCookie) {
      // 没配 workspace/cookie 的账户跳过，不算失败：按正常间隔排下一次。
      // 不重置退避 —— 退避只在成功时重置（§5.4）。
      due.nextDueAt = t + cfg.billingIntervalMs;
      continue;
    }
    const cookie = accounts.billingCredential(account.id);
    if (!cookie) {
      // cookie 在但解密失败（进程内解不开）：同上，跳过不抓。
      due.nextDueAt = t + cfg.billingIntervalMs;
      continue;
    }
    const r = await fetchAccountBilling(
      cfg,
      { workspaceId: account.workspaceId, cookie },
      fetchImpl,
    );
    if (r.ok) {
      // 部分更新：只写本次拿到的字段，last_billing_at 恒更新（§5.4）。
      accounts.setBilling(account.id, { ...r.result, lastBillingAt: t });
      due.backoffIdx = 0;
      due.nextDueAt = t + cfg.billingIntervalMs;
      log(`[billing] account=${account.name} ok`);
    } else {
      const idx = Math.min(due.backoffIdx, BACKOFF_LADDER_MS.length - 1);
      due.backoffIdx = Math.min(due.backoffIdx + 1, BACKOFF_LADDER_MS.length - 1);
      due.nextDueAt = t + BACKOFF_LADDER_MS[idx]!; // 已 clamp，越界不可能
      log(`[billing] account=${account.name} fail ${r.reason}`);
    }
  }
}

/**
 * 启动周期抓取。返回停止函数。
 *
 * 无账户 / accounts 未接线（null）/ 周期为 0（关闭）→ no-op。
 * `unref()` 掉定时器：billing 是后台观测，不该拖住进程退出。
 */
export function startBillingLoop(
  cfg: AppConfig,
  accounts: BillingAccounts | null,
  log: (msg: string) => void = console.log,
  fetchImpl: FetchLike = fetch,
): () => void {
  if (!accounts || cfg.billingIntervalMs <= 0) return () => {};
  // 调度态（nextDueAt + 退避梯级）只活在内存里，重启清零（§5.4）。
  const state: BillingLoopState = { bootAt: Date.now(), due: new Map() };
  let running = false;
  const tick = async () => {
    if (running) return; // 上一轮还没跑完（上游很慢），跳过这一轮 —— 与 keyprobe 同一模式
    running = true;
    try {
      await runBillingRound(cfg, accounts, state, Date.now, log, fetchImpl);
    } catch (err) {
      // billing 是观测设施，绝不能拖垮代理链路。
      log(`[billing] 本轮异常（已忽略）: ${err instanceof Error ? err.message : err}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, BILLING_TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/**
 * 手动刷新单个账户（/__admin 用）：绕过 nextDueAt 立即抓一次，成功写账。
 *
 * 注意：不碰调度器内存态（nextDueAt/退避）—— 状态归 startBillingLoop 所有，
 * 这里只管「立即抓 + 写账」；下一轮 tick 仍按原计划跑。
 */
export async function refreshBilling(
  cfg: AppConfig,
  accounts: BillingAccounts,
  accountId: number,
  log: (msg: string) => void = console.log,
  fetchImpl: FetchLike = fetch,
): Promise<BillingResult> {
  const account = accounts.list().find((a) => a.id === accountId);
  if (!account) return { ok: false, reason: 'account not found' };
  if (!account.workspaceId || !account.hasCookie) {
    return { ok: false, reason: 'no workspace/cookie' };
  }
  const cookie = accounts.billingCredential(accountId);
  if (!cookie) return { ok: false, reason: 'no workspace/cookie' };
  const r = await fetchAccountBilling(
    cfg,
    { workspaceId: account.workspaceId, cookie },
    fetchImpl,
  );
  if (r.ok) {
    accounts.setBilling(accountId, { ...r.result, lastBillingAt: Date.now() });
    log(`[billing] account=${account.name} manual refresh ok`);
  } else {
    log(`[billing] account=${account.name} manual refresh fail ${r.reason}`);
  }
  return r;
}
