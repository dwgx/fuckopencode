/**
 * 用量持久化（SQLite）—— 面板「历史累计」的数据源。
 *
 * # 为什么需要
 *
 * `metrics.ts` 的窗口只有最近 200 条、且进程重启清零。这导致一个具体的失败：
 * 2026-08-10 用户问「有个 key 是不是用完了」，回答需要「这个 key 一共扛了多少请求、
 * 什么时候开始不对的」—— 窗口里根本没有。当时只能去 `journalctl` 翻
 * `[keypool] disabled` 行、再读源码算冷却公式、再在服务器上手算恢复时刻。
 *
 * 所以这里落盘三张表：每请求一行（可任意区间回溯）+ key 状态变更审计
 * （回答「这个 key 今天被禁过几次」）+ 多账号配置（账户、加密的 key/cookie、
 * 探针/计费状态 —— 见 MULTI-ACCOUNT.md §1）。
 *
 * # 三条承重设计（改之前先理解）
 *
 * 1. **零运行时依赖**：用 Node 内置 `node:sqlite`（Node 22+），**不引入任何 npm 包**。
 *    本项目 `package.json` 的 `dependencies` 是空的，这是刻意的卖点（线上无 node_modules）。
 * 2. **可降级，绝不影响代理**：`node:sqlite` 不存在（Node 20，`engines` 允许）或打开
 *    失败（盘满/权限）→ 记一条 warn，整个模块退化成 no-op。面板照常工作，只是没有
 *    历史累计。**代理链路一个字节都不受影响** —— 观测设施永远不能成为主链路的故障源。
 * 3. **写入不阻塞请求**：`node:sqlite` 是同步 API，单条 prepared INSERT 亚毫秒级；
 *    开 WAL + `synchronous=NORMAL`（VPS 上不追求断电零丢失，追求不卡请求；
 *    `USAGE_DB_SYNCHRONOUS` 可覆盖到 FULL/EXTRA）。每 60 秒显式
 *    `wal_checkpoint(TRUNCATE)` 把 WAL 折回主库（跟着写入惰性触发，
 *    压缩异常终止时的丢失窗口），`close()` 时也做一次。
 *    每次写入都在 try/catch 里，抛错只记日志不上抛。
 *
 * # 隐私
 *
 * **只存 key 指纹（末 4 位 `****XXXX`），绝不存 key 原文。** 与日志、面板、
 * `/__metrics` 全链路口径一致。
 *
 * 请求明细列（path/ua/client/ip）与上游记账 cost 也落库 —— 这些是**管理面
 * 数据**：只能经 `isAdminRequest` 鉴权后的 /__admin 端点读到，且随保留期
 * 30 天清理（与历史聚合同一把扫帚）。IP 从 cf-connecting-ip/x-forwarded-for
 * 首段/socket 提取（clientIpOf，与登录限速同源）。
 *
 * 唯一的例外是 `accounts` 表：key/cookie 以 **AES-256-GCM 密文**（`1:...` 格式）
 * 形态落盘，解密只能由进程内的 `SecretKey`（secrets.ts）完成 —— 数据库文件
 * 本身不含任何明文凭据。
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseUserAgent } from './metrics.js';

/** 聚合口径统一的「观测流量」排除（probe=探活、count_tokens=Claude Code 计数）——所有聚合共用。 */
const EXCLUDE_OBSERVED = `endpoint NOT IN ('probe','count_tokens')`;

/** JS 侧判断一行是否属「观测流量」（不计入聚合），与 EXCLUDE_OBSERVED 同口径。
 *  额外处理 NULL endpoint（旧库行）：SQL `NOT IN` 天然排除 NULL，JS 侧必须显式
 *  对齐，否则 rebuild（SQL）与增量（JS）双口径漂移，同批行数字不一致。 */
function isObservedEndpoint(endpoint: unknown): boolean {
  return endpoint == null || endpoint === 'probe' || endpoint === 'count_tokens';
}

/** 单条请求记录（写入用）。字段与 `metrics.RequestEvent` 对齐，但只保留可长期留存的部分。 */
export interface UsageRow {
  at: number;
  keyFingerprint: string;
  model: string;
  upstreamModel: string;
  endpoint: string;
  status: number;
  durationMs: number;
  stream: boolean;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  error: string | null;
  /** 请求路径（详细请求页展示；探针落库为实际请求的路径，靠 endpoint 区分）。 */
  path: string;
  /** 原始 User-Agent（详细请求页展示；client 由本模块写入时解析）。 */
  ua: string;
  /**
   * 调用方已解析好的 client（metrics.extractDevice 的结果）。热路径优化：请求
   * 结束时 metrics 侧已经解析过 UA，这里直接复用，不二次 parseUserAgent；不传
   * （如 keyprobe 这类没有设备解析的后台写入）才由本模块在入队时补解析一次。
   */
  client?: string | null;
  /**
   * 调用方 IP（管理鉴权后的统计用；取自 cf-connecting-ip / x-forwarded-for 首段 /
   * socket，与登录限速同一套逻辑）。探针等后台动作不传（null）。
   */
  ip?: string | null;
  /** 上游记账的 cost（microCents，实测订阅端点恒 "0"、按量端点真实）。可选，缺省 0。 */
  costMicroCents?: number;
  /**
   * 分发 token 的指纹（sha256 前 24 hex，见 tokens.ts）。API key 鉴权的请求不传
   * （null）——只有走分发 token 的请求才落这一列，供按 token 聚合用量。
   */
  tokenFp?: string | null;
  /**
   * API 客户端凭据的指纹（sha256 全 hex，见 security/auth.ts）。分发 token /
   * 免鉴权请求不传（null）——只有走 API_KEYS 鉴权的请求才落这一列，
   * 供按客户端凭据归因模型授权拒绝（MODEL-ACCESS）。
   */
  apiKeyFp?: string | null;
}

/**
 * 详细请求列表的一行（GET /__admin/api/requests 的 items）。
 * 与 requests 表列一一对应；client 是写入时从 ua 解析好的，旧数据（补列前）为 null。
 */
export interface RequestDetailRow {
  at: number;
  status: number;
  path: string | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  model: string | null;
  fingerprint: string;
  ua: string | null;
  client: string | null;
  /** 调用方 IP（补列前的历史行为 null）。 */
  ip: string | null;
  endpoint: string | null;
  error: string | null;
}

/** 一页详细请求。total 与 items 同口径（都排除探活）。 */
export interface RequestPage {
  items: RequestDetailRow[];
  total: number;
}

/** 按 IP 聚合的一行（GET /__admin/api/requests/stats-by-ip 的 items）。 */
export interface IpStatRow {
  ip: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** 该 IP 用过的客户端名（去重，按出现顺序）。 */
  clients: string[];
  lastAt: number;
}

/** 一页 IP 统计。total 是不同 IP 的数量（与 items 同口径：排除探活、排除 null/空 ip）。 */
export interface IpStatsPage {
  items: IpStatRow[];
  total: number;
}

/** 按 key 指纹（末 4 位）归属统计的结果（GET /__admin/api/accounts/:id/usage-gateway）。 */
export interface KeyFingerprintUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicroCents: number;
}

/**
 * 单个 key 指纹在窗口内的用量聚合（GET /__admin/api/keys/usage 的数据源）。
 * ok/failed 口径与 history().byKey / queryTrend 一致：ok: 200<=status<300，
 * failed: status>=400 或 status=0；tokens = inputTokens + outputTokens。
 * 只含 DB 侧统计 —— 账号归属/昵称/健康态由端点层按 pool 快照 + store 合并。
 */
export interface KeyUsageAggregate {
  fingerprint: string;
  requests: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costMicroCents: number;
  /** 窗口内最后一次请求时刻；无请求为 0。 */
  lastAt: number;
}

/**
 * 真实趋势聚合的一个桶（GET /__admin/api/overview/trend 的 items 元素）。
 * at 是桶起点（毫秒时间戳，整点对齐）；ok/failed 与 history() 同口径
 * （ok: 200<=status<300，failed: status>=400 或 status=0）。
 */
export interface TrendBucket {
  at: number;
  requests: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costMicroCents: number;
}

/**
 * 24h/7d 真实趋势聚合（GET /__admin/api/overview/trend 的数据源）。
 * items 是**连续序列**（没有请求的桶补 0，sparkline 直接画，前端不用补洞）；
 * 顶层 totals 是 items 求和（面板统计卡直接读，与端点契约同口径）。
 */
export interface UsageTrend {
  rangeDays: number;
  /** hour（24h 档，每小时一桶）| day（7d 档，每天一桶）。 */
  bucket: 'hour' | 'day';
  since: number;
  until: number;
  requests: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costMicroCents: number;
  items: TrendBucket[];
}

/** key 状态变更记录（禁用/恢复审计）。 */
export interface KeyEventRow {
  at: number;
  keyFingerprint: string;
  type: 'disabled' | 'recovered';
  kind?: string;
  cooldownMs?: number;
  healthyCount: number;
  poolSize: number;
}

/**
 * 管理面写操作审计（console 写操作 / import-cookie）。
 * **绝不记金额与 cookie 明文** —— 只记操作名、账户、成败与细分类别。
 */
export interface AdminAuditRow {
  at: number;
  op: string;
  accountId: number | null;
  ok: boolean;
  note: string | null;
  /** 调用方 IP（管理面写操作/登录的来源，面板审计视图展示「谁」）。可空：
   *  部分打点位置没有 req（历史调用），或 db 里是补列前的旧行。 */
  ip?: string | null;
}

/** 面板审计视图的一行：admin_audit + accounts.name（LEFT JOIN，见 listAdminAudit）。 */
export interface AdminAuditViewRow {
  at: number;
  op: string;
  accountId: number | null;
  accountName: string | null;
  ok: boolean;
  note: string | null;
  ip: string | null;
}

/**
 * accounts 表的一行。`keysEnc`/`cookieEnc` 是 AES-256-GCM 密文（`1:...` 格式），
 * 解密只在 accounts.ts 的进程内进行，本模块不碰明文。
 */
export interface AccountRow {
  id: number;
  name: string;
  kind: string;
  workspaceId: string | null;
  /** 旧版控制台（opencode.ai，wrk_ 前缀）的 workspace id；新版 console 用 workspaceId。 */
  legacyWorkspaceId: string | null;
  keysEnc: string;
  cookieEnc: string | null;
  legacyCookieEnc: string | null;
  /** 旧版 Default API Key 的密文（AES-256-GCM，`1:...` 格式）；zen usage JSON API 用。 */
  legacyKeyEnc: string | null;
  /** OAuth refresh_token 的密文（AES-256-GCM，`1:...` 格式）。access_token 从不落库。 */
  oauthRefreshEnc: string | null;
  /**
   * 账号级模型白名单（JSON 字符串数组）。null = 未配置（用全局白名单）。
   * 账号不能突破全局 ALLOWED_MODELS —— 交集在选号时天然成立（全局门先拒，
   * 账号过滤只窄化）。
   */
  allowedModels: string[] | null;
  status: string;
  statusDetail: string | null;
  retryUntil: number;
  lastProbeAt: number;
  lastBillingAt: number;
  balanceUnits: number | null;
  monthlyLimitUnits: number | null;
  monthlyUsageUnits: number | null;
  createdAt: number;
}

/** 插入账户时必填的字段。其余列走 DDL 默认值，createdAt 由本模块统一取 Date.now()。 */
export interface InsertAccountParams {
  name: string;
  kind: string;
  workspaceId?: string | null;
  legacyWorkspaceId?: string | null;
  keysEnc: string;
  cookieEnc?: string | null;
  legacyCookieEnc?: string | null;
  legacyKeyEnc?: string | null;
  allowedModels?: string[] | null;
  status?: string;
  statusDetail?: string | null;
  retryUntil?: number;
  lastProbeAt?: number;
  lastBillingAt?: number;
  balanceUnits?: number | null;
  monthlyLimitUnits?: number | null;
  monthlyUsageUnits?: number | null;
}

/**
 * 账户可更新字段。**undefined = 不更新（拼 SET 子句时跳过），null = 置空。**
 * SQLite 没有 undefined 的概念，必须由调用方显式表达「不动这一列」。
 */
export interface AccountUpdate {
  name?: string;
  kind?: string;
  workspaceId?: string | null;
  legacyWorkspaceId?: string | null;
  keysEnc?: string;
  cookieEnc?: string | null;
  legacyCookieEnc?: string | null;
  legacyKeyEnc?: string | null;
  oauthRefreshEnc?: string | null;
  allowedModels?: string[] | null;
  status?: string;
  statusDetail?: string | null;
  retryUntil?: number;
  lastProbeAt?: number;
  lastBillingAt?: number;
  balanceUnits?: number | null;
  monthlyLimitUnits?: number | null;
  monthlyUsageUnits?: number | null;
}

/** 按 key 聚合的历史用量（面板「累计」列）。 */
export interface KeyUsageTotals {
  fingerprint: string;
  requests: number;
  ok: number;
  failed: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  lastAt: number;
}

/** 面板一次拿到的历史面。持久化不可用时整个对象为 null。 */
export interface UsageHistory {
  /** 库里最早一条记录的时间戳（面板显示「累计自 …」）。无数据时为 0。 */
  since: number;
  /** 总请求数（含未归属到 key 的）。 */
  totalRequests: number;
  /**
   * 还没选到 key 就被拒的请求数（客户端 400/401、池空 503）。
   *
   * 单独拎出来是因为它们不属于任何 key：混进 `byKey` 会让面板凭空多出一个
   * 指纹为 `-` 的「幽灵 key」。但也不能丢，否则 `byKey` 求和对不上 `totalRequests`。
   */
  unattributedRequests: number;
  /** 上面那些里失败的条数。 */
  unattributedFailed: number;
  byKey: KeyUsageTotals[];
  /** 最近的 key 状态变更（最新在前，上限 20 条）。 */
  recentKeyEvents: Array<{
    at: number;
    fingerprint: string;
    type: string;
    kind: string | null;
    cooldownMs: number | null;
  }>;
}

/** 清理周期：每 6 小时跑一次保留期删除（不用 setInterval 定时器，跟着写入惰性触发）。 */
const PRUNE_INTERVAL_MS = 6 * 3_600_000;

/**
 * WAL 显式折叠周期。WAL 模式下提交的数据先落 WAL，默认 autocheckpoint
 * （约 4MB）之前只存在于 WAL 里；异常终止时那段窗口靠 WAL 重放恢复，
 * 但 tokens 表生产实测丢过数据。每这个间隔显式 `wal_checkpoint(TRUNCATE)`
 * 把 WAL 折回主库文件，把「异常时可能丢的窗口」压缩到一个间隔内。
 * 跟随写入惰性触发（与保留期清理同模式），不设常驻定时器。
 */
const CHECKPOINT_INTERVAL_MS = 60_000;

/**
 * `history()` 结果的缓存时长。面板每 2 秒轮询，但那条全表 `GROUP BY` 在
 * 十万行量级要几百毫秒且同步阻塞事件循环 —— 详见 `history()` 的注释。
 */
const HISTORY_CACHE_MS = 15_000;

/** IP 统计的聚合缓存时长（statsByIp 注释：与 history() 同款承重设计）。 */
const IP_STATS_CACHE_MS = 10_000;

/** 分发 token 用量聚合的缓存时长（tokenUsageAll，同 statsByIp 承重设计）。 */
const TOKEN_USAGE_CACHE_MS = 10_000;

/** 全 key 用量聚合的缓存时长（keyUsageAll，同 statsByIp 承重设计）。 */
const KEY_USAGE_CACHE_MS = 10_000;

/** 趋势聚合的缓存时长（usageTrend，同 statsByIp 承重设计）。 */
const TREND_CACHE_MS = 10_000;

/**
 * 请求记账批量写入：攒批间隔与上限。见 `recordRequest`/`flush` 的注释 ——
 * 热路径把每请求一次同步 INSERT 改成内存队列，攒批后一次事务落库。
 */
const REQUEST_BATCH_MS = 100;
const REQUEST_BATCH_MAX = 50;

/**
 * flush 失败重试（I-13）：写入事务 transient 失败（SQLite busy/lock，部署重叠
 * 或长查询期间常见）时，把该批放回队首等这么久后重试一次 —— 不再整批连坐丢
 * 掉最多 50 条真实请求记录。重试仍失败才丢弃（见 flush()）。
 */
const FLUSH_RETRY_MS = 200;
/** 单批最多重试次数。1 = 首次失败放回队首重试一次，仍失败丢弃。 */
const FLUSH_RETRY_MAX = 1;

/**
 * 首次清理的宽限期。进程启动后等这么久才允许惰性清理跑第一次，
 * 既不让「每次重启都全表 DELETE」，也不至于像原来那样在重启频繁时永不清理。
 */
const FIRST_PRUNE_DELAY_MS = 10 * 60_000;

/**
 * 把底层错误归成粗粒度标签，供面板显示。**不含路径、不含原始 message。**
 * 完整原因只进日志（journalctl 本来就要 root 才看得到）。
 */
function classifyDbFailure(detail: string): string {
  if (/Cannot find module|not supported|no such built-in/i.test(detail)) return 'sqlite unavailable on this runtime';
  if (/EACCES|EPERM|permission denied/i.test(detail)) return 'permission denied';
  if (/ENOSPC|disk/i.test(detail)) return 'no disk space';
  if (/ENOENT|EEXIST|ENOTDIR|EISDIR/i.test(detail)) return 'db path unusable';
  if (/corrupt|malformed|not a database/i.test(detail)) return 'db file corrupt';
  return 'unavailable';
}

/**
 * history() 结果的对外副本（I-15）：`{...h}` 只复制顶层，byKey/recentKeyEvents
 * 里的元素对象仍是缓存内共享引用，调用方改元素照样污染缓存 —— 每层都要复制。
 */
function cloneHistory(h: UsageHistory): UsageHistory {
  return {
    ...h,
    byKey: h.byKey.map((k) => ({ ...k })),
    recentKeyEvents: h.recentKeyEvents.map((e) => ({ ...e })),
  };
}

/** usageTrend 结果的对外副本（I-15）：items 的桶对象要逐层复制。 */
function cloneTrend(t: UsageTrend): UsageTrend {
  return { ...t, items: t.items.map((it) => ({ ...it })) };
}

/**
 * 用量库。构造**永不抛**：任何失败都退化成 `enabled === false` 的 no-op 实例。
 */
export class UsageDb {
  /** 持久化是否真的可用。false = 所有方法都是空操作。close() 后也会置 false。 */
  enabled: boolean;
  private db: any = null;
  private insertRequest: any = null;
  /** insertRequest 的参数个数（19 含 api_key_fp / 18 降级，见 D-I4）。 */
  private insertRequestArity = 19;
  private insertKeyEvent: any = null;
  private insertAdminAuditStmt: any = null;
  /** key_totals 增量 upsert（flush 每 100ms 调用，prepared 缓存免重复 prepare）。 */
  private upsertTotalsStmt: any = null;
  /**
   * 请求记账的批量队列（未落库的行）。recordRequest 只入队，flush 时单事务
   * 写库 —— 见 recordRequest/flush 的注释（热路径优化：请求结束不再同步 INSERT）。
   */
  private pendingRows: Array<{ at: number; args: unknown[] }> = [];
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLastAt = 0;
  /** flush 连续失败次数（I-13）：首次失败放回队首重试，仍失败才丢弃；成功清零。 */
  private flushRetries = 0;
  private retentionMs: number;
  /**
   * 下次允许清理的最早时刻。
   *
   * 原来这里是 `lastPruneAt = Date.now()` 配 6 小时间隔，用意是避免「每次重启
   * 都在第一条请求上做全表 DELETE」。但代价没被算到：**进程只要活不满 6 小时，
   * 清理就永远不会跑**（`pruneNow` 只有测试在调，没有定时器）。正常的部署/重启
   * 节奏下 `retention 30d` 因此是一条永不执行的死配置，库无限增长 ——
   * 而库越大，`history()` 那条全表聚合越慢，直接喂大上面那个阻塞问题。
   *
   * 改成 10 分钟宽限：重启不会立刻付全表扫描的代价，但只要进程正常服务
   * 十分钟以上，清理就一定有机会跑。
   */
  private nextPruneAt = Date.now() + FIRST_PRUNE_DELAY_MS;
  /** 下次显式 WAL checkpoint 的最早时刻（见 CHECKPOINT_INTERVAL_MS）。 */
  private nextCheckpointAt = Date.now() + CHECKPOINT_INTERVAL_MS;
  private historyCache: UsageHistory | null = null;
  private historyCacheAt = 0;
  /** IP 统计的聚合缓存（10s TTL）。见 statsByIp 的注释 —— 与 history() 同款承重设计。 */
  private ipStatsCache: IpStatRow[] | null = null;
  private ipStatsCacheAt = 0;
  /** 分发 token 用量聚合缓存（10s TTL，tokenUsageAll）。 */
  private tokenUsageCache: Map<string, KeyFingerprintUsage> | null = null;
  private tokenUsageCacheAt = 0;
  /** 全 key 用量聚合缓存（10s TTL，按 rangeDays 分桶存，keyUsageAll）。 */
  private keyUsageCache = new Map<number, { at: number; data: KeyUsageAggregate[] | null }>();
  /** 趋势聚合缓存（10s TTL，按 rangeDays 分桶存，usageTrend）。 */
  private trendCache = new Map<number, { at: number; data: UsageTrend | null }>();
  /** 降级原因（面板可显示，便于知道「为什么没有历史数据」）。 */
  readonly disabledReason: string | null;

  /**
   * @param dbPath  db 文件路径。空串 = 显式关闭持久化。
   * @param retentionDays  保留天数，0 = 不清理。
   * @param log  日志函数（可注入，便于测试静音）。
   */
  constructor(
    dbPath: string,
    retentionDays = 30,
    private readonly log: (msg: string) => void = (m) => console.warn(m),
  ) {
    this.retentionMs = Math.max(0, retentionDays) * 86_400_000;
    if (!dbPath) {
      this.enabled = false;
      this.disabledReason = 'disabled by config';
      return;
    }
    try {
      // 动态取 `node:sqlite`：Node 20 上这个模块不存在，静态 import 会让整个
      // 模块加载失败（连带拖垮网关启动）。必须在 try 里按需取。
      //
      // 用 `createRequire` 而非裸 `require` —— 本项目编译产物是 ESM
      // （package.json `"type": "module"`），ESM 里没有 `require`。
      // 踩过：这里原本直接写 `require('node:module')`，单测全绿（vitest 的
      // 转换层给了 require），但生产 ESM 下抛 "require is not defined"，
      // 于是**静默**退化成无持久化 —— 降级设计反而把 bug 藏住了。
      // 也不能用同步 import()（会返回 Promise，构造函数里拿不到）。
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
        DatabaseSync: new (p: string) => any;
      };

      // 配置里给的通常是相对路径（`data/usage.db`），相对 cwd 解析。
      // 线上 systemd 的 `WorkingDirectory=/root/fuckopencode`，所以落在
      // `dist/` **外面** —— deploy.sh 会整体 mv 掉 dist/，数据不能放里面。
      const file = path.resolve(dbPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.db = new DatabaseSync(file);
      // WAL：读写不互斥，面板查询不会被写入阻塞。
      // synchronous 默认 NORMAL：不为每次提交等 fsync —— VPS 上断电丢最后几条
      // 用量完全可接受，卡住代理请求不可接受。可用 USAGE_DB_SYNCHRONOUS 覆盖到
      // FULL/EXTRA（对 tokens 这类要持久性的数据，宁可慢一点也不丢）；8GB 小
      // 机器上默认不升档是权衡过性能的（每请求落库，FULL 会每次提交都 fsync）。
      const syncRequested = (process.env.USAGE_DB_SYNCHRONOUS ?? 'NORMAL').toUpperCase();
      const syncLevel = ['OFF', 'NORMAL', 'FULL', 'EXTRA'].includes(syncRequested)
        ? syncRequested
        : 'NORMAL';
      if (syncLevel !== syncRequested) {
        this.log(`[usagedb] USAGE_DB_SYNCHRONOUS=${process.env.USAGE_DB_SYNCHRONOUS} 无效，回落 NORMAL`);
      }
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec(`PRAGMA synchronous = ${syncLevel}`);
      // 部署切换时可能短暂有两个进程同时持有库（旧进程 shutdown 有 5 秒兜底）。
      // 默认 busy_timeout=0 意味着一撞锁立刻失败、丢一条用量记录 + 刷一行 warn。
      // 给 200ms 重试窗口就基本消掉这类丢失；写都是单条 autocommit INSERT，
      // 不会长时间占锁，所以这个等待不会拖住请求。
      this.db.exec('PRAGMA busy_timeout = 200');
      // WAL 高水位不回落（journal_size_limit 默认 -1）。实测正常写入下 WAL 稳定在
      // autocheckpoint 阈值 4MB 左右，但一旦有长事务读者让 checkpoint 饿死，
      // 文件会涨到几百 MB 且不缩。设个上限，checkpoint 后把超出部分还给文件系统。
      this.db.exec('PRAGMA journal_size_limit = 16777216');
      this.migrate();
      // D-I4：旧库升级路径——api_key_fp 的 ALTER 若失败（部署重叠 busy 等），
      // prepare 引用缺失列会把整库拖成 disabled（与「补列失败只记日志」承诺不符）。
      // 回退到不含 api_key_fp 的 18 列降级 INSERT，该列数据丢弃，库照常可用。
      try {
        this.insertRequest = this.db.prepare(
          `INSERT INTO requests
             (at, key_fp, model, upstream_model, endpoint, status, duration_ms, stream,
              input_tokens, output_tokens, thinking_tokens, error, path, ua, client, ip,
              cost_micro_cents, token_fp, api_key_fp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        this.insertRequestArity = 19;
      } catch (err) {
        this.log(`[usagedb] api_key_fp 列不可用，回退降级 INSERT（丢该列数据）: ${err instanceof Error ? err.message : String(err)}`);
        this.insertRequest = this.db.prepare(
          `INSERT INTO requests
             (at, key_fp, model, upstream_model, endpoint, status, duration_ms, stream,
              input_tokens, output_tokens, thinking_tokens, error, path, ua, client, ip,
              cost_micro_cents, token_fp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        this.insertRequestArity = 18;
      }
      this.insertKeyEvent = this.db.prepare(
        `INSERT INTO key_events
           (at, key_fp, type, kind, cooldown_ms, healthy_count, pool_size)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      this.insertAdminAuditStmt = this.db.prepare(
        `INSERT INTO admin_audit (at, op, account_id, ok, note, ip) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      // key_totals 增量 upsert（flush 每 100ms 调用一次，prepared 必须缓存）。
      this.upsertTotalsStmt = this.db.prepare(`
        INSERT INTO key_totals (fingerprint, requests, ok, failed, input_tokens, output_tokens, last_at, min_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET
          requests = key_totals.requests + excluded.requests,
          ok = key_totals.ok + excluded.ok,
          failed = key_totals.failed + excluded.failed,
          input_tokens = key_totals.input_tokens + excluded.input_tokens,
          output_tokens = key_totals.output_tokens + excluded.output_tokens,
          last_at = MAX(key_totals.last_at, excluded.last_at),
          min_at = MIN(key_totals.min_at, excluded.min_at)
      `);
      this.enabled = true;
      this.disabledReason = null;
    } catch (err) {
      // 降级：Node 20 无 node:sqlite、盘满、权限不足、db 损坏 —— 一律不影响代理。
      this.enabled = false;
      const detail = err instanceof Error ? err.message : String(err);
      // 对外只给分类标签，不给原始 message。原文里通常带绝对路径
      // （`EACCES: permission denied, mkdir '/root/fuckopencode/data'`），
      // 而这个字段会经 `/__metrics` 出现在面板上 —— 公开模式下等于把部署路径
      // 和「服务跑在 root 下」这两件事白送给匿名访问者。完整原因进日志。
      this.disabledReason = classifyDbFailure(detail);
      this.db = null;
      this.log(`[usagedb] 持久化不可用，降级为内存模式（面板无历史累计）: ${detail}`);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        key_fp TEXT NOT NULL,
        model TEXT, upstream_model TEXT, endpoint TEXT,
        status INTEGER, duration_ms INTEGER, stream INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, thinking_tokens INTEGER,
        error TEXT,
        path TEXT, ua TEXT, client TEXT,
        ip TEXT, cost_micro_cents INTEGER,
        token_fp TEXT,
        api_key_fp TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_requests_key_at ON requests(key_fp, at);
      CREATE INDEX IF NOT EXISTS idx_requests_at ON requests(at);

      CREATE TABLE IF NOT EXISTS key_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        key_fp TEXT NOT NULL,
        type TEXT NOT NULL,
        kind TEXT,
        cooldown_ms INTEGER,
        healthy_count INTEGER, pool_size INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_key_events_key_at ON key_events(key_fp, at);
      -- history() 取「最近 20 条状态变更」是 ORDER BY at DESC，上面那个复合索引
      -- 前导列是 key_fp，用不上；没这条就是全表扫 + 临时 B-tree 排序。
      CREATE INDEX IF NOT EXISTS idx_key_events_at ON key_events(at);

      -- 管理面写操作审计（console 写操作 / import-cookie / 登录登出 / CRUD）。
      -- 只存摘要（op/account_id/ok/note/ip），绝不存金额与 cookie。清理随保留期走。
      CREATE TABLE IF NOT EXISTS admin_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        op TEXT NOT NULL,
        account_id INTEGER,
        ok INTEGER NOT NULL,
        note TEXT,
        ip TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at);

      -- 多账号配置（MULTI-ACCOUNT.md §1.3）。刻意不加 CHECK 约束、不加索引：
      -- key_events 同样无 CHECK，TS 类型（AccountStatus）是枚举唯一真源；
      -- 账户 2-5 行的小表，PK 即全扫，任何索引都是死代码。
      -- 后台设置页的模型映射（alias → target）。与账户表同哲学：
      -- 小表（个位数行），PK 即全扫，不加冗余索引；UNIQUE 保证 alias 幂等。
      CREATE TABLE IF NOT EXISTS model_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alias TEXT NOT NULL UNIQUE,
        target TEXT NOT NULL,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT 'account',
        kind TEXT NOT NULL DEFAULT 'unknown',          -- subscription | payg | unknown（TS 侧收敛）
        workspace_id TEXT,                             -- opencode.ai workspace id，可空
        legacy_workspace_id TEXT,                      -- 旧版控制台（wrk_ 前缀）workspace id，可空
        legacy_key_enc TEXT,                           -- 旧版 Default API Key 密文（zen usage JSON API 用），可空
        keys_enc TEXT NOT NULL DEFAULT '[]',           -- 整体一个密文串：encrypt(JSON.stringify([key...]))
        cookie_enc TEXT,                               -- 加密后的 auth cookie 原文，可空
        oauth_refresh_enc TEXT,                        -- 加密后的 OAuth refresh_token（access_token 从不落库）
        status TEXT NOT NULL DEFAULT 'unknown',        -- 见 MULTI-ACCOUNT.md §4.1 状态枚举
        status_detail TEXT,                            -- 最近一次失败的上游原文（截断 200，stripControl）
        retry_until INTEGER NOT NULL DEFAULT 0,        -- 探针调度闸门（0 = 立即可探）
        last_probe_at INTEGER NOT NULL DEFAULT 0,
        last_billing_at INTEGER NOT NULL DEFAULT 0,
        balance_units INTEGER,                         -- 余额（units，1e8 units = $1）；null = 未知
        monthly_limit_units INTEGER,
        monthly_usage_units INTEGER,
        allowed_models TEXT,                           -- 账号级模型白名单（JSON 数组）；null = 用全局白名单
        created_at INTEGER NOT NULL                    -- 代码里传 Date.now()，与 requests.at 同风格
      );

      -- 设置页热配置（settings.ts）。key-value 都存字符串（值经 JSON.stringify
      -- 序列化，解析与校验在 settings.ts 统一做）；updated_at 供将来排查
      -- 「这个值什么时候被改的」。settings 覆盖 env 默认，运行时生效不重启。
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- 分发密钥（tokens.ts）：只存 sha256(token) 前 24 hex 指纹，**明文不落库**。
      -- token_enc 列按 DDL 保留但恒为 NULL——当初设计考虑过加密存明文以便管理端
      -- 显示，收敛后校验/展示都只依赖指纹（token 256-bit 熵，指纹不可逆）。
      -- fingerprint UNIQUE 兜底碰撞；status 由 TS 侧收敛为 active/disabled。
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        token_enc TEXT,
        fingerprint TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        note TEXT,
        prefix TEXT NOT NULL DEFAULT 'tk',
        rpm_limit INTEGER NOT NULL DEFAULT 0,  -- 每分发 key 的 RPM（0 = 不限流，见 ratelimit.ts）
        quota_usd REAL NOT NULL DEFAULT 0,          -- $ 配额（0 = 无限，QUOTA.md §1）
        quota_tokens INTEGER NOT NULL DEFAULT 0,    -- token 配额（0 = 无限，input+output）
        quota_requests INTEGER NOT NULL DEFAULT 0,  -- 请求数配额（0 = 无限）
        quota_used_usd REAL NOT NULL DEFAULT 0,     -- 已用（microCents，与 cost_micro_cents 同单位）
        quota_used_tokens INTEGER NOT NULL DEFAULT 0,
        quota_used_requests INTEGER NOT NULL DEFAULT 0,
        quota_cycle TEXT NOT NULL DEFAULT 'none',   -- none | daily | monthly（周期重置）
        quota_reset_at INTEGER NOT NULL DEFAULT 0,  -- 周期窗口起点（跨周期结算归零 used + 刷新起点）
        expires_at INTEGER NOT NULL DEFAULT 0,      -- 过期时间（0 = 永不过期）
        quota_tpm INTEGER NOT NULL DEFAULT 0,       -- 每分钟 token 上限（0 = 无限；ratelimit.ts TpmLimiter 软预算）
        ip_whitelist TEXT NOT NULL DEFAULT '',      -- 逗号分隔 IP/CIDR 白名单（空 = 不限；tokens.ts ipInList）
        created_at INTEGER NOT NULL
      );

      -- 密钥-模型授权（MODEL-ACCESS.md）：管理「哪个密钥可以生成哪个模型」。
      -- 行存在 = 该密钥配了自定义授权；删行 = 清除自定义、回退全局/账号层。
      -- 三类 subject：token（复用 tokens.fingerprint）/ api-key / upstream-key
      -- （后两者用 sha256(key) 全 hex，绝不落明文）。小表、UNIQUE 即查询键，
      -- 不建多余索引（与 model_aliases 同哲学）。
      CREATE TABLE IF NOT EXISTS model_access (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_type TEXT NOT NULL,   -- 'token' | 'api-key' | 'upstream-key'
        subject_id   TEXT NOT NULL,   -- token=指纹；api-key/upstream-key=sha256 全 hex
        models       TEXT NOT NULL,   -- JSON 数组（非空；行存在 = 已配置自定义）
        updated_at   INTEGER NOT NULL,
        UNIQUE(subject_type, subject_id)
      );

      -- 按 key 累计用量聚合表（P1-F）：history() 的 byKey 段原来每次都是
      -- 全表 GROUP BY（150K 行 p50=646ms、60 万行最坏 10s，期间所有在飞 SSE
      -- 冻住）；15s 缓存只降频不降耗。现在 flush 在**同一事务**里 upsert 本
      -- 表（口径与 byKey 一致：key_fp != '-' 且 endpoint 非 probe/count_tokens），
      -- 读端 O(#keys) 即出。保留期语义：随 prune 重建（与 requests 表同窗口），
      -- 不依赖清行 —— 聚合表是快照不是增量账本。
      CREATE TABLE IF NOT EXISTS key_totals (
        fingerprint TEXT PRIMARY KEY,
        requests INTEGER NOT NULL DEFAULT 0,
        ok INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        last_at INTEGER NOT NULL DEFAULT 0,
        min_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    // 旧库升级：accounts 表在早期版本没有 oauth_refresh_enc 列，缺了才 ALTER
    // （PRAGMA table_info 检查，幂等；列已存在时 ALTER 会报 duplicate column）。
    this.ensureOauthColumn();
    this.ensureLegacyWorkspaceColumn();
    this.ensureLegacyCookieColumn();
    this.ensureLegacyKeyColumn();
    this.ensureAllowedModelsColumn();
    // requests 表补详细请求列（path/ua/client）。补列失败只记日志：历史聚合
    // 不依赖这三列；失败时 listRequests 会因缺列走 catch 返回 null（503），
    // 代理链路与面板累计都不受影响 —— 观测设施降级哲学。
    this.ensureRequestsColumns();
    this.ensureTokensPrefixColumn();
    this.ensureTokensRpmColumn();
    this.ensureTokensQuotaColumns();
    // 旧库升级：admin_audit 表补 ip 列（面板审计视图展示「谁」）。失败只记
    // 日志 —— 审计是观测设施，缺 ip 只是那列恒 null，不影响其他列。
    this.ensureAdminAuditIpColumn();
    // 聚合表建表后立即按 requests 现存量重建（旧库升级可见历史累计；幂等）。
    // 失败只记日志：history() 会退化为空 byKey（面板降级显示），不影响主链路。
    try {
      this.rebuildTotals();
    } catch (err) {
      this.log(`[usagedb] key_totals 初始重建失败（history byKey 降级为空）: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** 旧库升级：admin_audit 表补 ip 列（幂等：已存在则不动）。 */
  private ensureAdminAuditIpColumn(): void {
    try {
      const cols = this.db.prepare("SELECT name FROM pragma_table_info('admin_audit')").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'ip')) {
        this.db.exec('ALTER TABLE admin_audit ADD COLUMN ip TEXT');
      }
    } catch (err) {
      this.log(`[usagedb] admin_audit ip 列补列失败（降级：审计无来源 IP）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 给旧库的 requests 表补 path/ua/client/ip/cost_micro_cents 列（幂等：已存在则不动）。
   * 详细请求端点（GET /__admin/api/requests）需要 path/ua/client/ip；IP 统计与
   * 网关用量需要 ip/cost_micro_cents。补列前的历史行这些列全为 null，端点照常
   * 返回（null/0），聚合按「排除 null」处理 —— 旧数据不冒充来源。
   */
  /** 旧库升级：tokens 表补 prefix 列（掩码前缀 sk-/tk- 显示用——指纹派生不出前缀）。 */
  private ensureTokensPrefixColumn(): void {
    try {
      const cols = this.db.prepare("SELECT name FROM pragma_table_info('tokens')").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'prefix')) {
        this.db.exec("ALTER TABLE tokens ADD COLUMN prefix TEXT NOT NULL DEFAULT 'tk'");
      }
    } catch (err) {
      this.log(`[usagedb] tokens prefix 列补列失败（降级：掩码恒 tk- 前缀）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 旧库升级：tokens 表补 rpm_limit 列（per-key RPM 限流配置，0 = 不限流）。 */
  private ensureTokensRpmColumn(): void {
    try {
      const cols = this.db.prepare("SELECT name FROM pragma_table_info('tokens')").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'rpm_limit')) {
        this.db.exec('ALTER TABLE tokens ADD COLUMN rpm_limit INTEGER NOT NULL DEFAULT 0');
      }
    } catch (err) {
      this.log(`[usagedb] tokens rpm_limit 列补列失败（降级：该分发 key 不限流）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 旧库升级：tokens 表补配额计费列（QUOTA.md §1）。每列单独补（D-I4 先例：
   *  一列 ALTER 失败不连坐其余列），失败只记日志 —— 缺列时该口径配额不可用，
   *  settle/quotaCheck 读缺列会失败并静默跳过（settle 失败不阻断请求链路），
   *  不影响其余列与代理链路。 */
  private ensureTokensQuotaColumns(): void {
    try {
      const cols = this.db.prepare("SELECT name FROM pragma_table_info('tokens')").all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      const adds: Array<[string, string]> = [
        ['quota_usd', 'REAL NOT NULL DEFAULT 0'],
        ['quota_tokens', 'INTEGER NOT NULL DEFAULT 0'],
        ['quota_requests', 'INTEGER NOT NULL DEFAULT 0'],
        ['quota_used_usd', 'REAL NOT NULL DEFAULT 0'],
        ['quota_used_tokens', 'INTEGER NOT NULL DEFAULT 0'],
        ['quota_used_requests', 'INTEGER NOT NULL DEFAULT 0'],
        ['quota_cycle', "TEXT NOT NULL DEFAULT 'none'"],
        ['quota_reset_at', 'INTEGER NOT NULL DEFAULT 0'],
        ['expires_at', 'INTEGER NOT NULL DEFAULT 0'],
        ['quota_tpm', 'INTEGER NOT NULL DEFAULT 0'],
        ['ip_whitelist', "TEXT NOT NULL DEFAULT ''"],
      ];
      for (const [col, ddl] of adds) {
        if (!names.has(col)) {
          try {
            this.db.exec(`ALTER TABLE tokens ADD COLUMN ${col} ${ddl}`);
          } catch (err) {
            this.log(`[usagedb] tokens 表 ${col} 补列失败（该配额口径不可用）: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err) {
      this.log(`[usagedb] tokens 表配额列补列失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private ensureRequestsColumns(): void {
    try {
      const cols = this.db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      // api_key_fp（MODEL-ACCESS）：API 客户端凭据的 sha256 指纹，审计归因用
      // （token 已有 token_fp；免鉴权/分发 token 调用为 null）。
      // 每列单独补（D-I4 对抗审查）：一列 ALTER 失败（部署重叠 SQLITE_BUSY 等）不
      // 连坐其余列；api_key_fp 失败重试一次（busy 通常 200ms 窗口内可过），仍失败
      // 由 insertRequest 的降级 prepare 兜住（见构造），不再级联整库 disabled。
      for (const col of ['path', 'ua', 'client', 'ip', 'token_fp', 'api_key_fp']) {
        if (!names.has(col)) {
          try {
            this.db.exec(`ALTER TABLE requests ADD COLUMN ${col} TEXT`);
          } catch (err) {
            if (col === 'api_key_fp') {
              try {
                this.db.exec('ALTER TABLE requests ADD COLUMN api_key_fp TEXT');
                this.log(`[usagedb] api_key_fp 补列重试成功`);
              } catch (err2) {
                this.log(`[usagedb] api_key_fp 补列失败（重试后仍失败，该列降级为空）: ${err2 instanceof Error ? err2.message : String(err2)}`);
              }
            } else {
              this.log(`[usagedb] requests 表 ${col} 列补列失败: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
      // cost_micro_cents 是数字列：新库 DDL 里是 INTEGER，旧库补列必须同类型
      // （统一走 TEXT 会让新老库形态漂移，SUM 能算但语义不干净）。
      if (!names.has('cost_micro_cents')) {
        try {
          this.db.exec('ALTER TABLE requests ADD COLUMN cost_micro_cents INTEGER');
        } catch (err) {
          this.log(`[usagedb] cost_micro_cents 补列失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      this.log(`[usagedb] requests 表补详细请求列失败（详细请求端点不可用）: ${err instanceof Error ? err.message : err}`);
    }
    // 补列之后才能建 token_fp 索引：旧库 migrate 时列还不存在，
    // 提前 CREATE INDEX 会抛 "no such column" 把整个库拖成 disabled。
    // 失败只记日志 —— 聚合不依赖索引，只是没有它要大表全扫。
    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_requests_token_fp ON requests(token_fp)');
    } catch (err) {
      this.log(`[usagedb] token_fp 索引创建失败（聚合退化为全表扫）: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * 给旧库的 accounts 表补 oauth_refresh_enc 列（幂等：已存在则不动）。
   * 失败只记日志 —— OAuth 登录只是多账号管理面的一项功能，补列失败不影响
   * 其余账户数据可用性（写该列时会再失败一次并记日志，行为可预期）。
   */
  private ensureOauthColumn(): void {
    try {
      const cols = this.db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'oauth_refresh_enc')) {
        this.db.exec('ALTER TABLE accounts ADD COLUMN oauth_refresh_enc TEXT');
      }
    } catch (err) {
      this.log(`[usagedb] accounts 表补 oauth_refresh_enc 列失败（OAuth 登录不可用）: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * 给旧库的 accounts 表补 legacy_workspace_id 列（幂等：已存在则不动）。
   * 失败只记日志 —— 旧版控制台通道只是管理面的一项功能，补列失败不影响
   * 其余账户数据可用性。
   */
  /** 旧库升级：accounts 表补 legacy_cookie_enc 列（旧版控制台独立会话——
   *  与主 cookie（新版 console）互斥的槽位，避免「切一个废一个」）。 */
  private ensureLegacyCookieColumn(): void {
    try {
      const cols = this.db.prepare("SELECT name FROM pragma_table_info('accounts')").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'legacy_cookie_enc')) {
        this.db.exec('ALTER TABLE accounts ADD COLUMN legacy_cookie_enc TEXT');
      }
    } catch (err) {
      this.log(`[usagedb] legacy_cookie 补列失败（降级：legacy 用主 cookie 槽）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 给旧库的 accounts 表补 legacy_key_enc 列（旧版 Default API Key，zen usage
   * JSON API 用）。幂等：已存在则不动。失败只记日志 —— 该列缺失只影响
   * 「免 cookie 的 Go 用量」，其余通道与 cookie 路径不受影响。
   */
  private ensureLegacyKeyColumn(): void {
    try {
      const cols = this.db.prepare("SELECT name FROM pragma_table_info('accounts')").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'legacy_key_enc')) {
        this.db.exec('ALTER TABLE accounts ADD COLUMN legacy_key_enc TEXT');
      }
    } catch (err) {
      this.log(`[usagedb] legacy_key 补列失败（降级：该账号无免 cookie Go 用量）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private ensureLegacyWorkspaceColumn(): void {
    try {
      const cols = this.db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'legacy_workspace_id')) {
        this.db.exec('ALTER TABLE accounts ADD COLUMN legacy_workspace_id TEXT');
      }
    } catch (err) {
      this.log(`[usagedb] accounts 表补 legacy_workspace_id 列失败（旧版控制台通道不可用）: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * 给旧库的 accounts 表补 allowed_models 列（幂等：已存在则不动）。
   * 失败只记日志 —— 账号级模型白名单是管理面的配置功能，补列失败时
   * 该列恒 NULL（= 不限制，用全局白名单），代理链路与全局白名单不受影响。
   */
  private ensureAllowedModelsColumn(): void {
    try {
      const cols = this.db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'allowed_models')) {
        this.db.exec('ALTER TABLE accounts ADD COLUMN allowed_models TEXT');
      }
    } catch (err) {
      this.log(`[usagedb] accounts 表补 allowed_models 列失败（账号级模型白名单不可用）: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * 记一条请求（**异步批量**）：只入内存队列，攒批后一次写库。
   *
   * 热路径优化：原来每个请求都同步 INSERT（node:sqlite 是同步 API，阻塞事件
   * 循环）。现在请求结束只 push 一个数组元素（亚微秒），写库挪到 `flush` ——
   * 100ms 定时器或攒满 50 条时把整批包进一次事务（一次 fsync 而不是 N 次）。
   * 代价：进程崩溃最多丢最后一批未落库的（可接受，观测数据非关键；`close()`
   * 与读路径都会先 flush）。
   * 失败只记日志，不上抛（观测不能拖垮代理）。
   */
  recordRequest(row: UsageRow): void {
    if (!this.enabled) return;
    // client 复用调用方已解析的结果（metrics.extractDevice 在请求结束时做过一次
    // 了）；没有（keyprobe 等后台写入）才在入队时补解析一次。
    const client = row.client ?? parseUserAgent(row.ua).client;
    this.pendingRows.push({
      at: row.at,
      args: [
        row.at,
        row.keyFingerprint || '-',
        row.model || null,
        row.upstreamModel || null,
        row.endpoint || null,
        row.status,
        row.durationMs,
        row.stream ? 1 : 0,
        row.inputTokens,
        row.outputTokens,
        row.thinkingTokens,
        row.error,
        row.path || null,
        row.ua || null,
        client,
        row.ip ?? null,
        row.costMicroCents ?? 0,
        row.tokenFp ?? null,
        row.apiKeyFp ?? null,
      ],
    });
    if (row.at > this.pendingLastAt) this.pendingLastAt = row.at;
    if (this.pendingRows.length >= REQUEST_BATCH_MAX) {
      this.flush();
    } else if (this.pendingTimer == null) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.flush();
      }, REQUEST_BATCH_MS);
      // 不拖住进程退出：定时器只在有积压时存在，unref 后空转进程可正常退出。
      this.pendingTimer.unref?.();
    }
  }

  /**
   * 把积压的请求记录批量写库（单事务）。幂等：没有积压时是空操作。
   *
   * 触发点：攒满 50 条 / 100ms 定时器 / 读 requests 表的方法先 flush（保证读到的
   * 是已落库数据，批量延迟上限 ~100ms，面板 2s 轮询不受影响）/ `close()` 收尾。
   * 写失败把该批放回队首等 200ms 重试一次（I-13），仍失败才丢弃并记日志 ——
   * 丢的是观测数据，符合「崩溃最多丢最后一批」口径；最多重试一次，避免无限
   * 重试拖住事件循环。重试期间 recordRequest 新到的行照常 append 到队尾，
   * 重试 flush 时与放回的原批一起写（顺序保持）。
   */
  flush(): void {
    if (this.pendingTimer != null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (!this.enabled || this.pendingRows.length === 0) return;
    const rows = this.pendingRows;
    this.pendingRows = [];
    const lastAt = this.pendingLastAt;
    this.pendingLastAt = 0;
    try {
      this.db.exec('BEGIN');
      try {
        for (const { args } of rows) this.insertRequest.run(...args.slice(0, this.insertRequestArity));
        this.upsertTotals(rows);
        this.db.exec('COMMIT');
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // 事务可能已自动回滚，忽略。
        }
        throw err;
      }
    } catch (err) {
      // I-13：transient 写失败（部署重叠/长查询撞 SQLite busy）时整批丢弃会连坐
      // 丢掉最多 50 条真实请求记录。改放回队首等 200ms 重试一次；期间攒批继续，
      // 重试 flush 一并写掉。
      if (this.flushRetries < FLUSH_RETRY_MAX) {
        this.flushRetries += 1;
        // unshift 保留原批相对顺序；期间 recordRequest 新到的行 append 到队尾。
        this.pendingRows.unshift(...rows);
        if (lastAt > this.pendingLastAt) this.pendingLastAt = lastAt;
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null;
          this.flush();
        }, FLUSH_RETRY_MS);
        this.pendingTimer.unref?.();
        this.log(`[usagedb] 批量写入请求记录失败，${rows.length} 条放回队首，${FLUSH_RETRY_MS}ms 后重试: ${err instanceof Error ? err.message : err}`);
        return;
      }
      this.flushRetries = 0;
      this.log(`[usagedb] 批量写入请求记录失败（重试 ${FLUSH_RETRY_MAX} 次后仍失败，已忽略，丢 ${rows.length} 条）: ${err instanceof Error ? err.message : err}`);
      return;
    }
    this.flushRetries = 0;
    this.maybePrune(lastAt);
    this.maybeCheckpoint(lastAt);
  }

  /** 把一批行按 byKey 口径聚合并 upsert 进 key_totals（必须在 flush 的事务内
   *  调用 —— 与 requests 插入同事务，聚合表与明细永远原子一致）。口径与
   *  queryHistory 的 byKey 段一致：key_fp != '-' 且 endpoint 非 probe/
   *  count_tokens（探活与记账不是用户流量）。批量内同 key 先合并再单次 upsert，
   *  避免同批 N 行对同 key 做 N 次 ON CONFLICT。 */
  private upsertTotals(rows: Array<{ args: unknown[] }>): void {
    const agg = new Map<
      string,
      { requests: number; ok: number; failed: number; inTokens: number; outTokens: number; lastAt: number; minAt: number }
    >();
    for (const { args } of rows) {
      const fp = args[1];
      const endpoint = args[4];
      if (typeof fp !== 'string' || fp === '-' || fp === '') continue;
      // 与 EXCLUDE_OBSERVED 同口径（含 NULL endpoint 的旧库行语义，见 isObservedEndpoint）。
      if (isObservedEndpoint(endpoint)) continue;
      const at = Number(args[0]) || 0;
      const st = args[5];
      const status = typeof st === 'number' ? st : -1;
      const inTokens = Number(args[8]) || 0;
      const outTokens = Number(args[9]) || 0;
      let a = agg.get(fp);
      if (!a) {
        a = { requests: 0, ok: 0, failed: 0, inTokens: 0, outTokens: 0, lastAt: 0, minAt: Number.MAX_SAFE_INTEGER };
        agg.set(fp, a);
      }
      a.requests++;
      if (status >= 200 && status < 300) a.ok++;
      else if (status >= 400 || status === 0) a.failed++;
      a.inTokens += inTokens;
      a.outTokens += outTokens;
      if (at > a.lastAt) a.lastAt = at;
      if (at < a.minAt) a.minAt = at;
    }
    if (agg.size === 0) return;
    const upsert = this.upsertTotalsStmt;
    for (const [fp, a] of agg) {
      upsert.run(fp, a.requests, a.ok, a.failed, a.inTokens, a.outTokens, a.lastAt, a.minAt === Number.MAX_SAFE_INTEGER ? 0 : a.minAt);
    }
  }

  /** 按 requests 现存量重建 key_totals（与 queryHistory 的 byKey 同口径）。幂等，
   *  整表替换（避免与增量 upsert 叠加出双倍计数）。调用点：migrate 建表后
   *  （旧库升级立即可见历史累计；进程重启后窗口恢复精确）。prune **不再调用**
   *  本方法 —— 它走增量删（见 prune，避免全表 GROUP BY 同步阻塞事件循环）；
   *  本方法保留供 migrate/降级兜底用。 */
  private rebuildTotals(): void {
    // 整表替换是两条语句（DELETE + INSERT），必须同一事务：INSERT 失败
    // （SQLITE_BUSY/ENOSPC）时整体 ROLLBACK，否则 key_totals 被清空后
    // 历史聚合永久偏低，直到下次 prune 才有机会恢复。
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        DELETE FROM key_totals;
        INSERT INTO key_totals (fingerprint, requests, ok, failed, input_tokens, output_tokens, last_at, min_at)
        SELECT key_fp,
               COUNT(*),
               SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END),
               SUM(CASE WHEN status >= 400 OR status = 0 THEN 1 ELSE 0 END),
               COALESCE(SUM(input_tokens), 0),
               COALESCE(SUM(output_tokens), 0),
               MAX(at), MIN(at)
          FROM requests
         WHERE key_fp != '-' AND ${EXCLUDE_OBSERVED}
         GROUP BY key_fp
      `);
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 事务可能已自动回滚，忽略。
      }
      throw err;
    }
  }

  /**
   * 详细请求分页（GET /__admin/api/requests）。按 at 倒序（同毫秒按 id 倒序）。
   * 排除探活（endpoint='probe'）—— 与 history() 同口径：探针是后台维护动作，
   * 不是用户的请求，混进来会刷屏。
   *
   * `q` 为可选关键词：对 path/status/model/client/ua/ip 做不区分大小写的包含匹配
   * （LIKE 参数化，通配符已转义 —— 用户输入当字面量，不当作模式）。传空串/不传
   * 等价于不过滤。ip 纳入匹配是因为面板「点 IP → 过滤请求明细」用 q=<ip>。
   *
   * 分页参数在调用方 clamp（本方法只透传偏移计算）；page/pageSize 非法时
   * 由调用方兜底，本方法不做防御 —— 观测设施，参数错就 503，不拖垮代理。
   * 查询失败返回 null（调用方 503），db 不可用同样返回 null。
   */
  listRequests(page: number, pageSize: number, q?: string, filter: 'important' | 'all' = 'important'): RequestPage | null {
    if (!this.enabled) return null;
    // 批量写入是异步的：读前先把积压 flush，保证查询读到已落库数据。
    this.flush();
    const offset = Math.max(0, (page - 1) * pageSize);
    // 噪音排除（important 默认）：探活 probe、记账 count_tokens、健康检查 /（FurCDN 之类）。
    // all 模式只排除探活（保留 count_tokens/健康检查供排查）——有意的例外，不走 EXCLUDE_OBSERVED。
    const noise = filter === 'all'
      ? `endpoint != 'probe'`
      : `${EXCLUDE_OBSERVED} AND path != '/'`;
    // LIKE 的 %/_/\ 是模式字符；用户输入是字面关键词，先转义再包 %（ESCAPE '\'）。
    const like = escapeLike(q ?? '');
    const where = like
      ? `WHERE ${noise} AND (
           path LIKE ? ESCAPE '\\' OR CAST(status AS TEXT) LIKE ? ESCAPE '\\' OR
           model LIKE ? ESCAPE '\\' OR COALESCE(client, '') LIKE ? ESCAPE '\\' OR
           COALESCE(ua, '') LIKE ? ESCAPE '\\' OR COALESCE(ip, '') LIKE ? ESCAPE '\\' OR
           COALESCE(error, '') LIKE ? ESCAPE '\\')`
      : `WHERE ${noise}`;
    const bind = like ? [like, like, like, like, like, like, like] : [];
    try {
      const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM requests ${where}`).get(...bind) as { n: number };
      const rows = this.db
        .prepare(
          `SELECT at, status, path, duration_ms AS durationMs, input_tokens AS inputTokens,
                  output_tokens AS outputTokens, model, key_fp AS fingerprint, ua, client, ip,
                  endpoint, error
             FROM requests ${where}
            ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(...bind, pageSize, offset) as Array<Record<string, unknown>>;
      return {
        total: Number(totalRow?.n) || 0,
        items: rows.map((r) => ({
          at: Number(r.at) || 0,
          status: Number(r.status) || 0,
          path: r.path == null ? null : String(r.path),
          durationMs: Number(r.durationMs) || 0,
          inputTokens: r.inputTokens == null ? null : Number(r.inputTokens),
          outputTokens: r.outputTokens == null ? null : Number(r.outputTokens),
          model: r.model == null ? null : String(r.model),
          fingerprint: String(r.fingerprint),
          ua: r.ua == null ? null : String(r.ua),
          client: r.client == null ? null : String(r.client),
          ip: r.ip == null ? null : String(r.ip),
          endpoint: r.endpoint == null ? null : String(r.endpoint),
          error: r.error == null ? null : String(r.error),
        })),
      };
    } catch (err) {
      this.log(`[usagedb] 详细请求查询失败: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * 按调用方 IP 聚合（GET /__admin/api/requests/stats-by-ip）。按 requests 数倒序
   * （同数按 ip 升序，保证分页稳定）。与 listRequests 同口径：排除探活、排除
   * 未落 ip 的行（补列前的旧数据 ip 为 null，不冒充来源）。
   *
   * **带 10 秒聚合缓存（承重设计，不是优化）**：面板每 2 秒轮询这个端点，而
   * 底层是全表 GROUP BY + GROUP_CONCAT —— 与 history() 那条全表聚合同量级
   * （历史注释实测 15 万行 p50=646ms），`node:sqlite` 是同步 API，每 2 秒一次
   * 会把代理请求（含 SSE 转发）全部卡住。聚合结果全量缓存（不同 IP 数通常
   * 几百行，内存几十 KB），命中时只做内存切片，真查询降到每 10 秒最多一次。
   * IP 统计是「谁在用」级别的粗粒度观测，10 秒滞后无影响。
   *
   * clients 是 GROUP_CONCAT(DISTINCT client) 在 JS 里按逗号分割去重 —— 客户端
   * 名来自 parseUserAgent 的固定分类，不含逗号，可以安全分割。去重后顺序是
   * SQLite 扫描序（不承诺按出现顺序）。
   */
  statsByIp(page: number, pageSize: number): IpStatsPage | null {
    if (!this.enabled) return null;
    // 批量写入是异步的：读前先把积压 flush，保证聚合读到已落库数据。
    this.flush();
    const now = Date.now();
    if (this.ipStatsCache == null || now - this.ipStatsCacheAt >= IP_STATS_CACHE_MS) {
      const fresh = this.queryIpStats();
      if (fresh) {
        this.ipStatsCache = fresh;
        this.ipStatsCacheAt = now;
      } else {
        return null;
      }
    }
    const all = this.ipStatsCache;
    const offset = Math.max(0, (page - 1) * pageSize);
    return {
      total: all.length,
      // slice 只产生新数组，元素仍是缓存内同一对象（I-15）：逐个复制
      // （clients 数组也要复制），调用方改元素不污染缓存。
      items: all.slice(offset, offset + pageSize).map((r) => ({ ...r, clients: [...r.clients] })),
    };
  }

  /** statsByIp 的真查询（聚合全量，分页由调用方切片）。失败返回 null。 */
  private queryIpStats(): IpStatRow[] | null {
    try {
      // B2：加 at 窗口（retention 内）。prune 只留 retention 内的行，面板的
      // 「全部」≈ retention 窗口 —— 加了窗口语义不变，但 WHERE 能走
      // idx_requests_at 范围扫，聚合行数从全表降到窗口内（GROUP_CONCAT 的
      // 拼接范围同步缩小）。retention=0（永不清理）时保持全量，语义仍是「全部」。
      const args: unknown[] = [];
      let atClause = '';
      if (this.retentionMs > 0) {
        atClause = 'AND at >= ?';
        args.push(Date.now() - this.retentionMs);
      }
      const rows = this.db
        .prepare(
          `SELECT ip,
                  COUNT(*)                                   AS requests,
                  COALESCE(SUM(input_tokens), 0)             AS inputTokens,
                  COALESCE(SUM(output_tokens), 0)            AS outputTokens,
                  COALESCE(GROUP_CONCAT(DISTINCT client), '') AS clients,
                  MAX(at)                                    AS lastAt
             FROM requests
            WHERE ${EXCLUDE_OBSERVED} AND ip IS NOT NULL AND ip != '' ${atClause}
            GROUP BY ip
            ORDER BY requests DESC, ip ASC`,
        )
        .all(...args) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        ip: String(r.ip),
        requests: Number(r.requests) || 0,
        inputTokens: Number(r.inputTokens) || 0,
        outputTokens: Number(r.outputTokens) || 0,
        clients: String(r.clients)
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c.length > 0 && c !== 'unknown')
          .filter((c, i, a) => a.indexOf(c) === i),
        lastAt: Number(r.lastAt) || 0,
      }));
    } catch (err) {
      this.log(`[usagedb] IP 统计查询失败: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * 按 key 指纹末 4 位归属统计（GET /__admin/api/accounts/:id/usage-gateway）。
   * fingerprints 是 legacy masked（`sk-AOpQ...0osU`）的末 4 位集合，匹配
   * `key_fp LIKE '%0osU'`（与查询层脱敏口径一致：库里只有 `****XXXX` 指纹）。
   * sinceMs 为时间下限（rangeDays 换算）；探活不计入 —— 网关实际用量只算用户请求。
   * 空指纹集合返回全零（端点内部在 legacy 不可用时的兜底数据）。
   */
  usageByKeyFingerprints(fingerprints: string[], sinceMs: number): KeyFingerprintUsage {
    const empty: KeyFingerprintUsage = { requests: 0, inputTokens: 0, outputTokens: 0, costMicroCents: 0 };
    if (!this.enabled || fingerprints.length === 0) return empty;
    // 批量写入是异步的：读前先把积压 flush，保证聚合读到已落库数据。
    this.flush();
    const tails = fingerprints.filter((f) => f.length >= 4);
    if (tails.length === 0) return empty;
    try {
      const placeholders = tails.map(() => 'key_fp LIKE ?').join(' OR ');
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS requests,
                  COALESCE(SUM(input_tokens), 0)   AS inputTokens,
                  COALESCE(SUM(output_tokens), 0)  AS outputTokens,
                  COALESCE(SUM(cost_micro_cents), 0) AS costMicroCents
             FROM requests
            WHERE at >= ? AND ${EXCLUDE_OBSERVED} AND (${placeholders})`,
        )
        .get(sinceMs, ...tails.map((t) => `%${t}`)) as Record<string, number>;
      return {
        requests: Number(row.requests) || 0,
        inputTokens: Number(row.inputTokens) || 0,
        outputTokens: Number(row.outputTokens) || 0,
        costMicroCents: Number(row.costMicroCents) || 0,
      };
    } catch (err) {
      this.log(`[usagedb] key 指纹用量查询失败: ${err instanceof Error ? err.message : err}`);
      return empty;
    }
  }

  /**
   * 全部 key 指纹的窗口用量聚合（GET /__admin/api/keys/usage 的数据源）。
   *
   * 与 history().byKey 同口径：排除探活与 count_tokens（`endpoint NOT IN
   * ('probe', 'count_tokens')`）、排除未归属（key_fp '-'/''）。按 key_fp
   * GROUP BY —— 库里 key_fp 已是 `****XXXX` 脱敏指纹（与 keyFingerprint 同源）。
   * 每个指纹一行；窗口内无请求的指纹不出现（端点层按 pool/账号合并补零）。
   *
   * **带 10 秒缓存（同 statsByIp/tokenUsageAll 承重设计）**：底层是带 WHERE 的
   * GROUP BY 聚合，node:sqlite 同步 API，面板轮询不能每次全表扫。按 rangeDays
   * 分桶缓存（面板只用 7/90 两档，各自最多 10s 一次真查询）。返回副本（I-15）。
   * 失败/不可用返回 null（端点 200 补零），不抛 —— 观测设施降级哲学。
   *
   * @param now 时间源（测试注入固定时刻；生产走 Date.now()）。
   */
  keyUsageAll(rangeDays: number, now?: number): KeyUsageAggregate[] | null {
    if (!this.enabled) return null;
    // 批量写入是异步的：读前先把积压 flush，保证聚合读到已落库数据。
    this.flush();
    const nowMs = now ?? Date.now();
    const days = Number.isFinite(rangeDays) ? Math.max(1, Math.floor(rangeDays)) : 7;
    const cached = this.keyUsageCache.get(days);
    if (cached && nowMs - cached.at < KEY_USAGE_CACHE_MS) {
      return cached.data ? cached.data.map((r) => ({ ...r })) : null;
    }
    const since = nowMs - days * 86_400_000;
    let out: KeyUsageAggregate[] | null;
    try {
      const rows = this.db
        .prepare(
          `SELECT key_fp                                             AS fingerprint,
                  COUNT(*)                                             AS requests,
                  SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS ok,
                  SUM(CASE WHEN status >= 400 OR status = 0 THEN 1 ELSE 0 END)    AS failed,
                  COALESCE(SUM(input_tokens), 0)       AS inputTokens,
                  COALESCE(SUM(output_tokens), 0)      AS outputTokens,
                  COALESCE(SUM(cost_micro_cents), 0)   AS costMicroCents,
                  MAX(at)                               AS lastAt
             FROM requests
            WHERE at >= ? AND key_fp != '-' AND key_fp != ''
              AND ${EXCLUDE_OBSERVED}
            GROUP BY key_fp
            ORDER BY requests DESC`,
        )
        .all(since) as Array<Record<string, number>>;
      out = rows.map((r) => {
        const inputTokens = Number(r.inputTokens) || 0;
        const outputTokens = Number(r.outputTokens) || 0;
        return {
          fingerprint: String(r.fingerprint),
          requests: Number(r.requests) || 0,
          ok: Number(r.ok) || 0,
          failed: Number(r.failed) || 0,
          inputTokens,
          outputTokens,
          tokens: inputTokens + outputTokens,
          costMicroCents: Number(r.costMicroCents) || 0,
          lastAt: Number(r.lastAt) || 0,
        };
      });
    } catch (err) {
      this.log(`[usagedb] 全 key 用量聚合失败: ${err instanceof Error ? err.message : err}`);
      out = null;
    }
    // 失败不写缓存（下次重试），成功才缓存。
    if (out !== null) this.keyUsageCache.set(days, { at: nowMs, data: out });
    return out ? out.map((r) => ({ ...r })) : null;
  }

  /**
   * 按分发 token 指纹聚合用量（GET /__admin/api/tokens 与 /tokens/stats 的数据源）。
   * 精确匹配完整指纹（sha256 前 24 hex）。排除观测流量（EXCLUDE_OBSERVED）：
   * probe 探活与 count_tokens 记账都不计（探针请求不走 verifyAuth，token_fp 恒
   * null 本就排除，但显式排除对齐聚合口径——未来 probe 路径若带 token_fp 不混入）。
   * 失败/不可用返回空 Map（观测降级，不抛）。
   *
   * 带 10 秒缓存（与 statsByIp 同款承重设计）：底层是 GROUP BY 聚合，
   * node:sqlite 同步 API，面板轮询不能每次全表扫。
   */
  tokenUsageAll(): Map<string, KeyFingerprintUsage> {
    const empty = new Map<string, KeyFingerprintUsage>();
    if (!this.enabled) return empty;
    // 批量写入是异步的：读前先把积压 flush，保证聚合读到已落库数据。
    this.flush();
    const now = Date.now();
    if (this.tokenUsageCache != null && now - this.tokenUsageCacheAt < TOKEN_USAGE_CACHE_MS) {
      // 缓存命中返回副本：`new Map(cache)` 只复制 Map 容器，value 对象仍是共享
      // 引用，调用方改 value 照样污染缓存 —— 每个值也要复制一份。
      return new Map([...this.tokenUsageCache].map(([fp, u]) => [fp, { ...u }]));
    }
    try {
      // B2：加 at 窗口（retention 内）——prune 只留 retention 内的行，「全部」
      // ≈ retention 窗口，语义不变；过滤后聚合行数从全表降到窗口内（面板 tokens
      // 列表的 usage 列是全部口径，与 history() 的保留期口径一致）。
      // 有窗口时用 INDEXED BY 强制走 idx_requests_at 范围扫：SQLite 默认会选
      // idx_requests_token_fp（覆盖 GROUP BY 键、免排序）做全索引扫描，at 过滤
      // 退化成逐行 lookup —— 窗口完全没起到削减扫描量的作用（实测 10 万行
      // 202ms vs 72ms）。
      const args: unknown[] = [];
      let fromClause = 'FROM requests';
      let atClause = '';
      if (this.retentionMs > 0) {
        fromClause = 'FROM requests INDEXED BY idx_requests_at';
        atClause = 'AND at >= ?';
        args.push(Date.now() - this.retentionMs);
      }
      const rows = this.db
        .prepare(
          `SELECT token_fp AS fingerprint,
                  COUNT(*)                                AS requests,
                  COALESCE(SUM(input_tokens), 0)          AS inputTokens,
                  COALESCE(SUM(output_tokens), 0)         AS outputTokens,
                  COALESCE(SUM(cost_micro_cents), 0)      AS costMicroCents
             ${fromClause}
            WHERE token_fp IS NOT NULL AND token_fp != '' AND ${EXCLUDE_OBSERVED} ${atClause}
            GROUP BY token_fp
            ORDER BY requests DESC`,
        )
        .all(...args) as Array<Record<string, unknown>>;
      const map = new Map<string, KeyFingerprintUsage>();
      for (const r of rows) {
        map.set(String(r.fingerprint), {
          requests: Number(r.requests) || 0,
          inputTokens: Number(r.inputTokens) || 0,
          outputTokens: Number(r.outputTokens) || 0,
          costMicroCents: Number(r.costMicroCents) || 0,
        });
      }
      this.tokenUsageCache = map;
      this.tokenUsageCacheAt = now;
      // 与命中路径同款：返回副本，调用方改动 value 不污染缓存。
      return new Map([...map].map(([fp, u]) => [fp, { ...u }]));
    } catch (err) {
      this.log(`[usagedb] 分发 token 用量聚合失败（返回空）: ${err instanceof Error ? err.message : err}`);
      return empty;
    }
  }

  /**
   * 24h/7d 真实用量趋势（GET /__admin/api/overview/trend 的数据源）。
   *
   * rangeDays <= 1 → 24h 档（hour 桶）；> 1 → day 桶（连续 rangeDays 个桶）。
   * 与 history() 同口径：**排除探活**（endpoint='probe'，探针是维护动作不是用户流量）。
   * 返回连续序列：没有请求的桶补 0（sparkline 直接画，不需要前端补洞）。
   * 顶层 totals 与 items 求和一致（面板统计卡直接读）。
   *
   * **带 10 秒缓存（同 statsByIp/tokenUsageAll 承重设计）**：底层是带 WHERE 的
   * GROUP BY 聚合，node:sqlite 同步 API，面板 2 秒轮询不能每次全表扫。按
   * rangeDays 分桶缓存（面板只用 24h/7d 两档，各自最多 10s 一次真查询）。
   * 失败/不可用返回 null（调用方 503），不抛 —— 观测设施降级哲学。
   *
   * @param now 时间源（测试注入固定时刻；生产走 Date.now()）。
   */
  usageTrend(rangeDays: number, now?: number): UsageTrend | null {
    if (!this.enabled) return null;
    // 批量写入是异步的：读前先把积压 flush，保证聚合读到已落库数据。
    this.flush();
    const days = Number.isFinite(rangeDays) ? Math.max(1, Math.floor(rangeDays)) : 7;
    const nowMs = now ?? Date.now();
    const cached = this.trendCache.get(days);
    if (cached && nowMs - cached.at < TREND_CACHE_MS) {
      // 缓存命中返回副本（I-15）：直接 return cached.data 会让调用方改 items
      // 污染 10s 内的所有后续读取。
      const data = cached.data;
      return data ? cloneTrend(data) : null;
    }
    const fresh = this.queryTrend(days, nowMs);
    this.trendCache.set(days, { at: nowMs, data: fresh });
    return fresh ? cloneTrend(fresh) : null;
  }

  /** usageTrend 的真查询。失败返回 null（不写缓存，下次重试）。 */
  private queryTrend(days: number, now: number): UsageTrend | null {
    const bucketMs = days <= 1 ? 3_600_000 : 86_400_000;
    const bucket: 'hour' | 'day' = days <= 1 ? 'hour' : 'day';
    // 窗口对齐到桶边界：24h 档 24 个 hour 桶、7d 档 days 个 day 桶（当前桶含
    // 进行中的数据）。totals 仍是「到现在为止」的数据 —— 未来不可能有 at > now
    // 的行，对齐只影响窗口起点归属（可能比 now - days 略早不到一个桶，面板
    // sparkline 换来稳定长度）。
    const spanBuckets = days <= 1 ? 24 : days;
    const until = Math.floor(now / bucketMs) * bucketMs + bucketMs;
    const since = until - spanBuckets * bucketMs;
    try {
      const rows = this.db
        .prepare(
          `SELECT CAST(at / ? AS INTEGER)              AS b,
                  COUNT(*)                               AS requests,
                  SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS ok,
                  SUM(CASE WHEN status >= 400 OR status = 0 THEN 1 ELSE 0 END)    AS failed,
                  COALESCE(SUM(input_tokens), 0)         AS inputTokens,
                  COALESCE(SUM(output_tokens), 0)        AS outputTokens,
                  COALESCE(SUM(cost_micro_cents), 0)     AS costMicroCents
             FROM requests
            WHERE at >= ? AND at < ? AND ${EXCLUDE_OBSERVED}
            GROUP BY b`,
        )
        .all(bucketMs, since, until) as Array<Record<string, number>>;
      const byBucket = new Map<number, TrendBucket>();
      for (const r of rows) {
        const b = Number(r.b) || 0;
        byBucket.set(b, {
          at: b * bucketMs,
          requests: Number(r.requests) || 0,
          ok: Number(r.ok) || 0,
          failed: Number(r.failed) || 0,
          inputTokens: Number(r.inputTokens) || 0,
          outputTokens: Number(r.outputTokens) || 0,
          costMicroCents: Number(r.costMicroCents) || 0,
        });
      }
      // 连续序列：从 since 所在桶到 until 所在桶逐个填（缺桶补 0）。
      const first = Math.floor(since / bucketMs);
      const last = Math.floor((until - 1) / bucketMs);
      const count = Math.max(1, last - first + 1);
      const items: TrendBucket[] = [];
      for (let i = 0; i < count; i++) {
        const key = first + i;
        items.push(
          byBucket.get(key) ?? {
            at: key * bucketMs,
            requests: 0,
            ok: 0,
            failed: 0,
            inputTokens: 0,
            outputTokens: 0,
            costMicroCents: 0,
          },
        );
      }
      let requests = 0;
      let ok = 0;
      let failed = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let costMicroCents = 0;
      for (const it of items) {
        requests += it.requests;
        ok += it.ok;
        failed += it.failed;
        inputTokens += it.inputTokens;
        outputTokens += it.outputTokens;
        costMicroCents += it.costMicroCents;
      }
      return { rangeDays: days, bucket, since, until, requests, ok, failed, inputTokens, outputTokens, costMicroCents, items };
    } catch (err) {
      this.log(`[usagedb] 趋势聚合查询失败: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** 记一条 key 状态变更（禁用/恢复）。 */
  recordKeyEvent(row: KeyEventRow): void {
    if (!this.enabled) return;
    try {
      this.insertKeyEvent.run(
        row.at,
        row.keyFingerprint,
        row.type,
        row.kind ?? null,
        row.cooldownMs ?? null,
        row.healthyCount,
        row.poolSize,
      );
    } catch (err) {
      this.log(`[usagedb] 写入 key 事件失败（已忽略）: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * 记一条管理面写操作审计（op/accountId/ok/note 摘要，绝不记金额/cookie）。
   * 与 recordRequest 同一降级哲学：db 不可用时不抛、不上抛，审计是观测设施，
   * 绝不能拖垮代理链路或管理面写操作本身。
   */
  insertAdminAudit(row: AdminAuditRow): void {
    if (!this.enabled) return;
    try {
      this.insertAdminAuditStmt.run(row.at, row.op, row.accountId, row.ok ? 1 : 0, row.note, row.ip ?? null);
    } catch (err) {
      this.log(`[usagedb] 写入管理审计失败（已忽略）: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * 最近的管理面操作（GET /__admin/api/audit 的数据源，面板审计视图）。
   * LEFT JOIN accounts 把 accountId 换成可读名字（审计视图展示「谁」不需要
   * 前端再拉一遍账号列表）。按 at 倒序 + LIMIT —— 带 (at) 索引，浅查询。
   * 失败返回 null（调用方 503），不抛 —— 观测设施降级哲学。
   */
  listAdminAudit(limit: number): Array<AdminAuditViewRow> | null {
    if (!this.enabled) return null;
    const n = Math.max(1, Math.min(200, Math.floor(limit) || 50));
    try {
      const rows = this.db
        .prepare(
          `SELECT a.at, a.op, a.account_id AS accountId, a.ok, a.note, a.ip,
                  acc.name AS accountName
             FROM admin_audit a
             LEFT JOIN accounts acc ON acc.id = a.account_id
            ORDER BY a.at DESC, a.id DESC
            LIMIT ?`,
        )
        .all(n) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        at: Number(r.at) || 0,
        op: String(r.op),
        accountId: r.accountId == null ? null : Number(r.accountId),
        accountName: r.accountName == null ? null : String(r.accountName),
        ok: Boolean(r.ok),
        note: r.note == null ? null : String(r.note),
        ip: r.ip == null ? null : String(r.ip),
      }));
    } catch (err) {
      this.log(`[usagedb] 管理审计查询失败: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * 面板用的历史聚合。不可用时返回 null（面板据此隐藏累计列）。
   *
   * **结果带缓存，这是承重设计而不是优化。** `node:sqlite` 是同步 API，
   * 而 `byKey` 那条是全表 `GROUP BY key_fp`：索引 `(key_fp, at)` 只提供有序性，
   * 不覆盖 `status`/`input_tokens`/`output_tokens`，每行都要回主表取值。
   * 实测（本机 M2，warm cache）15 万行 p50=646ms、60 万行最坏 10s，
   * 而面板每 2 秒轮询一次 —— Node 单线程下这段时间**所有在飞的代理请求
   * （含流式 SSE 转发）全部停住**，实测把一个 0ms 的请求拖到 1.4 秒。
   * 生产是 2 核 VPS 且 `cache_size` 默认仅 2MB，只会更差。
   *
   * 这会让观测设施变成主链路的故障源，正是本文件开头明确要避免的事。
   * 缓存把「每 2 秒一次全表扫描」降到「每 15 秒最多一次」，面板看到的
   * 累计数字最多滞后 15 秒 —— 对「这个 key 用得怎么样」这类判断无影响，
   * 而实时性要求高的 `inFlight`/冷却剩余来自 `KeyPool.snapshot()`（纯内存），
   * 不走这条路径。
   */
  history(): UsageHistory | null {
    if (!this.enabled) return null;
    // 批量写入是异步的：读前先把积压 flush，保证聚合读到已落库数据。
    this.flush();
    const now = Date.now();
    if (this.historyCache && now - this.historyCacheAt < HISTORY_CACHE_MS) {
      // 缓存命中返回副本（I-15）：直接 return 内部缓存会让调用方改返回值
      // 污染 15s 内的所有后续读取。
      return cloneHistory(this.historyCache);
    }
    const fresh = this.queryHistory();
    // 查询失败（返回 null）时不写缓存，下次调用会重试。
    if (fresh) {
      this.historyCache = fresh;
      this.historyCacheAt = now;
    }
    return fresh ? cloneHistory(fresh) : null;
  }

  private queryHistory(): UsageHistory | null {
    try {
      // byKey 段：读 key_totals 聚合表（flush 同事务维护），O(#keys) 即出 ——
      // 不再每次全表 GROUP BY（150K 行 p50=646ms，60 万行最坏 10s，期间所有
      // 在飞 SSE 冻住）。口径与聚合表一致：key_fp != '-' 且 endpoint 非
      // probe/count_tokens（探活与记账不是用户流量；fp='-' 是没选到 key 就
      // 被拒的请求，单独在 unattributed 里数）。
      const byKey = this.db
        .prepare(
          `SELECT fingerprint,
                  requests,
                  ok,
                  failed,
                  input_tokens AS inputTokens,
                  output_tokens AS outputTokens,
                  last_at AS lastAt
             FROM key_totals
            ORDER BY requests DESC`,
        )
        .all() as Array<Record<string, number | string>>;

      // 未归属请求（key_fp = '-'）单独给一个数：真实发生的请求，丢了总数对不上。
      // 走 (key_fp, at) 索引，只扫 '-' 行。与 meta.unattrib 同口径：排除探活与
      // 记账（count_tokens 请求落库时 key_fp 为 '-'，不排除会把「未归属请求数」
      // 刷高、违反 totalRequests 不变量）。
      const unattributed = this.db
        .prepare(
          `SELECT COUNT(*) AS requests,
                  SUM(CASE WHEN status >= 400 OR status = 0 THEN 1 ELSE 0 END) AS failed
             FROM requests WHERE key_fp = '-' AND (endpoint IS NULL OR ${EXCLUDE_OBSERVED})`,
        )
        .get() as { requests: number; failed: number };

      // 总数与 byKey 同口径：聚合表累计 + 未归属里排除探活/记账的部分。
      // 未归属小查询走 (key_fp, at) 索引；since 取两路最早（LEAST）。
      const meta = this.db
        .prepare(
          `SELECT COALESCE((SELECT SUM(requests) FROM key_totals), 0)            AS totals,
                  COALESCE((SELECT MIN(min_at) FROM key_totals), 0)             AS totalsMinAt,
                  COALESCE((SELECT COUNT(*) FROM requests
                             WHERE key_fp = '-' AND (endpoint IS NULL OR ${EXCLUDE_OBSERVED})), 0) AS unattrib,
                  COALESCE((SELECT MIN(at) FROM requests
                             WHERE key_fp = '-' AND (endpoint IS NULL OR ${EXCLUDE_OBSERVED})), 0) AS unattribMinAt`,
        )
        .get() as { totals: number; totalsMinAt: number; unattrib: number; unattribMinAt: number };

      const recent = this.db
        .prepare(
          `SELECT at, key_fp AS fingerprint, type, kind, cooldown_ms AS cooldownMs
             FROM key_events ORDER BY at DESC LIMIT 20`,
        )
        .all() as Array<Record<string, never>>;

      const totalsMinAt = Number(meta.totalsMinAt) || 0;
      const unattribMinAt = Number(meta.unattribMinAt) || 0;
      const since = totalsMinAt === 0 ? unattribMinAt : unattribMinAt === 0 ? totalsMinAt : Math.min(totalsMinAt, unattribMinAt);

      return {
        since,
        totalRequests: Number(meta.totals) + Number(meta.unattrib) || 0,
        unattributedRequests: Number(unattributed?.requests) || 0,
        unattributedFailed: Number(unattributed?.failed) || 0,
        byKey: byKey.map((r) => ({
          fingerprint: String(r.fingerprint),
          requests: Number(r.requests) || 0,
          ok: Number(r.ok) || 0,
          failed: Number(r.failed) || 0,
          inputTokens: Number(r.inputTokens) || 0,
          outputTokens: Number(r.outputTokens) || 0,
          tokens: (Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0),
          lastAt: Number(r.lastAt) || 0,
        })),
        recentKeyEvents: recent.map((r: any) => ({
          at: Number(r.at) || 0,
          fingerprint: String(r.fingerprint),
          type: String(r.type),
          kind: r.kind == null ? null : String(r.kind),
          cooldownMs: r.cooldownMs == null ? null : Number(r.cooldownMs),
        })),
      };
    } catch (err) {
      this.log(`[usagedb] 历史查询失败（面板降级为无累计）: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * 保留期清理。惰性触发（跟着写入走），避免常驻定时器 ——
   * 这台机器 1.9 GB 内存、网关 `MemoryMax=400M`，能省的常驻对象就省。
   */
  private maybePrune(now: number): void {
    if (this.retentionMs <= 0) return;
    if (now < this.nextPruneAt) return;
    this.nextPruneAt = now + PRUNE_INTERVAL_MS;
    this.prune(now);
  }

  /**
   * 定期把 WAL 折叠回主库文件（PRAGMA wal_checkpoint(TRUNCATE)）。
   *
   * WAL 模式下提交的数据先落 WAL，默认 autocheckpoint（~4MB）之前只存在于
   * WAL 里；异常终止时那段窗口靠 WAL 重放恢复。生产实测 tokens 表在异常
   * 重启后丢过数据 —— 定期 checkpoint 把「异常时可能丢的窗口」从「整个未
   * checkpoint 段」压缩到「最近一个间隔」，并让主库文件始终最新：即使 WAL
   * 文件本身损坏，也只会损失一个间隔的数据，而不是整个未折叠段。
   *
   * TRUNCATE 需要无活跃读事务；本模块全是同步单条查询、不持有事务，正常
   * 能成功。若恰好撞上 busy（部署切换时两个进程短暂并存），catch 住回落
   * PASSIVE（尽力折叠，不阻塞）。跟随写入惰性触发，不设常驻定时器。
   */
  private maybeCheckpoint(now: number): void {
    if (now < this.nextCheckpointAt) return;
    this.nextCheckpointAt = now + CHECKPOINT_INTERVAL_MS;
    try {
      this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch {
      try {
        this.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
      } catch (err) {
        this.log(`[usagedb] WAL checkpoint 失败（已忽略）: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** 立即执行一次保留期清理（跳过节流）。`retentionDays=0` 时是空操作。 */
  pruneNow(now: number): void {
    if (!this.enabled || this.retentionMs <= 0) return;
    // 清理按已落库数据判断；批量写入是异步的，先把积压 flush 再删，
    // 否则刚 recordRequest 的旧行会「先逃过清理、后随 flush 落库」。
    this.flush();
    this.nextPruneAt = now + PRUNE_INTERVAL_MS;
    this.prune(now);
  }

  private prune(now: number): void {
    const cutoff = now - this.retentionMs;
    // 删了行，缓存的聚合就不再成立，作废它们。
    this.historyCache = null;
    this.ipStatsCache = null;
    this.tokenUsageCache = null;
    this.trendCache.clear();
    try {
      // DELETE 同一事务：中途失败整体 ROLLBACK，避免删了一半、请求明细
      // 与聚合窗口漂移。
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM requests WHERE at < ?').run(cutoff);
        this.db.prepare('DELETE FROM key_events WHERE at < ?').run(cutoff);
        // 管理审计与请求日志同一保留期（按 at）。
        this.db.prepare('DELETE FROM admin_audit WHERE at < ?').run(cutoff);
        // P2-1：key_totals 增量删，不再整表重建（原 rebuildTotals 是全表
        // GROUP BY，150K 行 646ms / 60 万行最坏 10s，同步阻塞在飞请求）。
        // 删除窗口与 requests 对齐：只删「窗口内已无记账口径请求」的 key。
        // 不能用 `min_at < cutoff` 判断 —— min_at 由增量 upsert 用 MIN 合并
        // （只增不减），存活超过保留期的 key 其 min_at 恒早于 cutoff，会被
        // 误删掉仍有窗口内请求的聚合。NOT EXISTS 子查询走 (key_fp, at)
        // 索引，key_totals 行数 = key 数（几个~几十），每次都是点查级开销。
        // 代价：保留的 key 计数是「进程启动以来累计」而非窗口内精确值
        // （快照不重算），进程重启时 migrate 初始重建会回到精确窗口。
        this.db
          .prepare(
            `DELETE FROM key_totals WHERE NOT EXISTS (
               SELECT 1 FROM requests r
                WHERE r.key_fp = key_totals.fingerprint
                  AND r.at >= ?
                  AND r.endpoint IS NOT NULL
                  AND ${EXCLUDE_OBSERVED}
             )`,
          )
          .run(cutoff);
        this.db.exec('COMMIT');
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // 事务可能已自动回滚，忽略。
        }
        throw err;
      }
    } catch (err) {
      this.log(`[usagedb] 保留期清理失败（已忽略）: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * 账户 CRUD（MULTI-ACCOUNT.md §1.3 / §7）。
   *
   * 与管理面操作对齐：**写操作失败记日志返回 false**（管理面要真相，
   * 静默丢更新会让面板与库不一致）；查询失败返回 null（面板降级展示）。
   * 与 `recordRequest` 不同，这里不吞成 no-op —— 管理面是低频操作，
   * 失败应该显式暴露给调用方。
   */

  /** 全部账户（按 id 升序）。查询失败返回 null。 */
  listAccounts(): AccountRow[] | null {
    if (!this.enabled) return null;
    try {
      const rows = this.db.prepare('SELECT * FROM accounts ORDER BY id').all() as unknown as Array<
        Record<string, unknown>
      >;
      return rows.map(mapAccountRow);
    } catch (err) {
      this.log(`[usagedb] 账户列表查询失败: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** 单个账户。不存在或查询失败都返回 null。 */
  getAccount(id: number): AccountRow | null {
    if (!this.enabled) return null;
    try {
      const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      return row ? mapAccountRow(row) : null;
    } catch (err) {
      this.log(`[usagedb] 账户查询失败（id=${id}）: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * 插入账户，返回新行 id。
   *
   * 返回 `number | false` 而非 boolean：管理面创建账户后必须拿到 id 才能
   * 返回「创建成功 + 该账户」的响应（MULTI-ACCOUNT.md §6.3），失败时 false
   * 与其余写操作口径一致。
   */
  insertAccount(row: InsertAccountParams): number | false {
    if (!this.enabled) return false;
    try {
      const res = this.db
        .prepare(
          `INSERT INTO accounts
             (name, kind, workspace_id, legacy_workspace_id, keys_enc, cookie_enc, status, status_detail,
              retry_until, last_probe_at, last_billing_at, balance_units,
              monthly_limit_units, monthly_usage_units, legacy_cookie_enc, allowed_models, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.name,
          row.kind,
          row.workspaceId ?? null,
          row.legacyWorkspaceId ?? null,
          row.keysEnc,
          row.cookieEnc ?? null,
          row.status ?? 'unknown',
          row.statusDetail ?? null,
          row.retryUntil ?? 0,
          row.lastProbeAt ?? 0,
          row.lastBillingAt ?? 0,
          row.balanceUnits ?? null,
          row.monthlyLimitUnits ?? null,
          row.monthlyUsageUnits ?? null,
          row.legacyCookieEnc ?? null,
          row.allowedModels == null ? null : JSON.stringify(row.allowedModels),
          Date.now(),
        );
      return Number(res.lastInsertRowid);
    } catch (err) {
      this.log(`[usagedb] 账户插入失败: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /**
   * 部分更新：patch 里 undefined 的字段不拼进 SET 子句（SQLite 无 undefined，
   * 必须显式跳过）；null 表示置空。无有效字段时直接算成功（幂等 no-op）。
   */
  updateAccount(id: number, patch: AccountUpdate): boolean {
    if (!this.enabled) return false;
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [field, col] of ACCOUNT_COLUMNS) {
      const v = patch[field];
      if (v === undefined) continue;
      sets.push(`${col} = ?`);
      // allowedModels 是数组，落库序列化成 JSON 字符串（null 保留 null = 清除）。
      vals.push(field === 'allowedModels' && v != null ? JSON.stringify(v) : v);
    }
    if (sets.length === 0) return true;
    try {
      // 先验存在性再 UPDATE：SQLite 的 changes 只统计「值实际被改」的行，
      // 对不存在的 id 更新 0 行会被误判为成功 —— 静默丢更新（探针/billing
      // 写账尤其危险：账户已删，账却「写成功」了）。
      if (!this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) return false;
      vals.push(id);
      this.db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return true;
    } catch (err) {
      this.log(`[usagedb] 账户更新失败（id=${id}）: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** 删除账户。删除不存在/已删的行也返回 true（幂等）。 */
  deleteAccount(id: number): boolean {
    if (!this.enabled) return false;
    try {
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      return true;
    } catch (err) {
      this.log(`[usagedb] 账户删除失败（id=${id}）: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /**
   * 暴露底层 sqlite 句柄给独立存储模块（modelmap.ts 的模型映射表直连，
   * 不把 CRUD 堆进本模块）。db 不可用时返回 null；调用方必须自己 try/catch。
   */
  sqlite(): any | null {
    return this.db;
  }

  /** 关闭底层句柄。幂等。 */
  close(): void {
    // 干净关停时把积压的批量请求记录先落库（优雅退出不丢最后一批；崩溃丢失除外）。
    this.flush();
    if (!this.db) return;
    try {
      // 显式折叠 WAL：干净关停时让主库文件就是最新状态。DatabaseSync.close()
      // 本身也会 checkpoint，但 TRUNCATE 保证 WAL 文件归零，重开零负担。
      this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch {
      // 无所谓，close 本身会完成 checkpoint。
    }
    try {
      this.db.close();
    } catch {
      // 关闭失败无所谓，进程退出时 OS 会回收。
    }
    this.db = null;
    // 关闭后置 enabled=false：句柄已失效，若仍是 true，close 后 recordRequest/
    // flush 会把积压行往已关闭的句柄写、每条刷一行「批量写入失败」错误日志。
    // 幂等：二次 close 里 flush() 因 enabled=false 早退、db 为 null 直接 return。
    this.enabled = false;
  }
}

/**
 * 账户字段名 → 列名映射，`updateAccount` 拼 SET 子句用。
 * 顺序无意义，但必须与 AccountUpdate 的键一一对应，漏一个就是静默丢更新。
 */
const ACCOUNT_COLUMNS: Array<[keyof AccountUpdate, string]> = [
  ['name', 'name'],
  ['kind', 'kind'],
  ['workspaceId', 'workspace_id'],
  ['legacyWorkspaceId', 'legacy_workspace_id'],
  ['keysEnc', 'keys_enc'],
  ['cookieEnc', 'cookie_enc'],
  ['legacyCookieEnc', 'legacy_cookie_enc'],
  ['legacyKeyEnc', 'legacy_key_enc'],
  ['oauthRefreshEnc', 'oauth_refresh_enc'],
  ['status', 'status'],
  ['statusDetail', 'status_detail'],
  ['retryUntil', 'retry_until'],
  ['lastProbeAt', 'last_probe_at'],
  ['lastBillingAt', 'last_billing_at'],
  ['balanceUnits', 'balance_units'],
  ['monthlyLimitUnits', 'monthly_limit_units'],
  ['monthlyUsageUnits', 'monthly_usage_units'],
  ['allowedModels', 'allowed_models'],
];

/** SQLite 行 → AccountRow。全部显式转换（node:sqlite 会返回 bigint/string/null）。 */
function mapAccountRow(r: Record<string, unknown>): AccountRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    kind: String(r.kind),
    workspaceId: r.workspace_id == null ? null : String(r.workspace_id),
    legacyWorkspaceId: r.legacy_workspace_id == null ? null : String(r.legacy_workspace_id),
    keysEnc: String(r.keys_enc),
    cookieEnc: r.cookie_enc == null ? null : String(r.cookie_enc),
    legacyCookieEnc: r.legacy_cookie_enc == null ? null : String(r.legacy_cookie_enc),
    legacyKeyEnc: r.legacy_key_enc == null ? null : String(r.legacy_key_enc),
    oauthRefreshEnc: r.oauth_refresh_enc == null ? null : String(r.oauth_refresh_enc),
    status: String(r.status),
    statusDetail: r.status_detail == null ? null : String(r.status_detail),
    retryUntil: Number(r.retry_until) || 0,
    lastProbeAt: Number(r.last_probe_at) || 0,
    lastBillingAt: Number(r.last_billing_at) || 0,
    balanceUnits: r.balance_units == null ? null : Number(r.balance_units),
    monthlyLimitUnits: r.monthly_limit_units == null ? null : Number(r.monthly_limit_units),
    monthlyUsageUnits: r.monthly_usage_units == null ? null : Number(r.monthly_usage_units),
    allowedModels: parseAllowedModels(r.allowed_models),
    createdAt: Number(r.created_at),
  };
}

/** 解析 accounts.allowed_models 列的 JSON 数组；null/坏数据返回 null（= 不限制）。 */
function parseAllowedModels(raw: unknown): string[] | null {
  if (raw == null || String(raw).trim() === '') return null;
  try {
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return null;
    const models = arr.filter((m): m is string => typeof m === 'string' && m.length > 0);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

/** 默认 db 路径：代码目录旁的 `data/usage.db`。 */
export function defaultDbPath(baseDir: string): string {
  return path.join(baseDir, 'data', 'usage.db');
}

/**
 * 把用户输入转成 LIKE 的字面量模式：转义 `%`/`_`/`\`（ESCAPE '\'），包上 `%`。
 * 关键词搜索里用户输入是内容不是模式 —— 不转义的话搜 `50%` 会被当成通配符。
 * 空输入返回空串（调用方跳过 WHERE 过滤）。
 */
export function escapeLike(input: string): string {
  const s = input.trim();
  if (s.length === 0) return '';
  return `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
