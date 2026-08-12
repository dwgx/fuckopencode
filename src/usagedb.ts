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
  /** OAuth refresh_token 的密文（AES-256-GCM，`1:...` 格式）。access_token 从不落库。 */
  oauthRefreshEnc: string | null;
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
  oauthRefreshEnc?: string | null;
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

/** 趋势聚合的缓存时长（usageTrend，同 statsByIp 承重设计）。 */
const TREND_CACHE_MS = 10_000;

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
 * 用量库。构造**永不抛**：任何失败都退化成 `enabled === false` 的 no-op 实例。
 */
export class UsageDb {
  /** 持久化是否真的可用。false = 所有方法都是空操作。 */
  readonly enabled: boolean;
  private db: any = null;
  private insertRequest: any = null;
  private insertKeyEvent: any = null;
  private insertAdminAuditStmt: any = null;
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
      this.insertRequest = this.db.prepare(
        `INSERT INTO requests
           (at, key_fp, model, upstream_model, endpoint, status, duration_ms, stream,
            input_tokens, output_tokens, thinking_tokens, error, path, ua, client, ip,
            cost_micro_cents, token_fp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      this.insertKeyEvent = this.db.prepare(
        `INSERT INTO key_events
           (at, key_fp, type, kind, cooldown_ms, healthy_count, pool_size)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      this.insertAdminAuditStmt = this.db.prepare(
        `INSERT INTO admin_audit (at, op, account_id, ok, note, ip) VALUES (?, ?, ?, ?, ?, ?)`,
      );
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
        token_fp TEXT
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
        created_at INTEGER NOT NULL
      );
    `);
    // 旧库升级：accounts 表在早期版本没有 oauth_refresh_enc 列，缺了才 ALTER
    // （PRAGMA table_info 检查，幂等；列已存在时 ALTER 会报 duplicate column）。
    this.ensureOauthColumn();
    this.ensureLegacyWorkspaceColumn();
    this.ensureLegacyCookieColumn();
    // requests 表补详细请求列（path/ua/client）。补列失败只记日志：历史聚合
    // 不依赖这三列；失败时 listRequests 会因缺列走 catch 返回 null（503），
    // 代理链路与面板累计都不受影响 —— 观测设施降级哲学。
    this.ensureRequestsColumns();
    this.ensureTokensPrefixColumn();
    this.ensureTokensRpmColumn();
    // 旧库升级：admin_audit 表补 ip 列（面板审计视图展示「谁」）。失败只记
    // 日志 —— 审计是观测设施，缺 ip 只是那列恒 null，不影响其他列。
    this.ensureAdminAuditIpColumn();
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

  private ensureRequestsColumns(): void {
    try {
      const cols = this.db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      for (const col of ['path', 'ua', 'client', 'ip', 'token_fp']) {
        if (!names.has(col)) {
          this.db.exec(`ALTER TABLE requests ADD COLUMN ${col} TEXT`);
        }
      }
      // cost_micro_cents 是数字列：新库 DDL 里是 INTEGER，旧库补列必须同类型
      // （统一走 TEXT 会让新老库形态漂移，SUM 能算但语义不干净）。
      if (!names.has('cost_micro_cents')) {
        this.db.exec('ALTER TABLE requests ADD COLUMN cost_micro_cents INTEGER');
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

  /** 记一条请求。失败只记日志，不上抛（观测不能拖垮代理）。 */
  recordRequest(row: UsageRow): void {
    if (!this.enabled) return;
    try {
      this.insertRequest.run(
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
        // client 写时解析：同一 ua 只解析一次，详细请求查询直接读列。
        parseUserAgent(row.ua).client,
        row.ip ?? null,
        row.costMicroCents ?? 0,
        row.tokenFp ?? null,
      );
      this.maybePrune(row.at);
      this.maybeCheckpoint(row.at);
    } catch (err) {
      this.log(`[usagedb] 写入请求记录失败（已忽略）: ${err instanceof Error ? err.message : err}`);
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
  listRequests(page: number, pageSize: number, q?: string): RequestPage | null {
    if (!this.enabled) return null;
    const offset = Math.max(0, (page - 1) * pageSize);
    // LIKE 的 %/_/\ 是模式字符；用户输入是字面关键词，先转义再包 %（ESCAPE '\'）。
    const like = escapeLike(q ?? '');
    const where = like
      ? `WHERE endpoint != 'probe' AND (
           path LIKE ? ESCAPE '\\' OR CAST(status AS TEXT) LIKE ? ESCAPE '\\' OR
           model LIKE ? ESCAPE '\\' OR COALESCE(client, '') LIKE ? ESCAPE '\\' OR
           COALESCE(ua, '') LIKE ? ESCAPE '\\' OR COALESCE(ip, '') LIKE ? ESCAPE '\\' OR
           COALESCE(error, '') LIKE ? ESCAPE '\\')`
      : `WHERE endpoint != 'probe'`;
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
      items: all.slice(offset, offset + pageSize),
    };
  }

  /** statsByIp 的真查询（聚合全量，分页由调用方切片）。失败返回 null。 */
  private queryIpStats(): IpStatRow[] | null {
    try {
      const rows = this.db
        .prepare(
          `SELECT ip,
                  COUNT(*)                                   AS requests,
                  COALESCE(SUM(input_tokens), 0)             AS inputTokens,
                  COALESCE(SUM(output_tokens), 0)            AS outputTokens,
                  COALESCE(GROUP_CONCAT(DISTINCT client), '') AS clients,
                  MAX(at)                                    AS lastAt
             FROM requests
            WHERE endpoint NOT IN ('probe', 'count_tokens') AND ip IS NOT NULL AND ip != ''
            GROUP BY ip
            ORDER BY requests DESC, ip ASC`,
        )
        .all() as Array<Record<string, unknown>>;
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
            WHERE at >= ? AND endpoint NOT IN ('probe', 'count_tokens') AND (${placeholders})`,
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
   * 按分发 token 指纹聚合用量（GET /__admin/api/tokens 与 /tokens/stats 的数据源）。
   * 精确匹配完整指纹（sha256 前 24 hex），不排除探活——探针请求不经过 verifyAuth，
   * token_fp 恒为 null，天然不在结果里。失败/不可用返回空 Map（观测降级，不抛）。
   *
   * 带 10 秒缓存（与 statsByIp 同款承重设计）：底层是 GROUP BY 聚合，
   * node:sqlite 同步 API，面板轮询不能每次全表扫。
   */
  tokenUsageAll(): Map<string, KeyFingerprintUsage> {
    const empty = new Map<string, KeyFingerprintUsage>();
    if (!this.enabled) return empty;
    const now = Date.now();
    if (this.tokenUsageCache != null && now - this.tokenUsageCacheAt < TOKEN_USAGE_CACHE_MS) {
      return this.tokenUsageCache;
    }
    try {
      const rows = this.db
        .prepare(
          `SELECT token_fp AS fingerprint,
                  COUNT(*)                                AS requests,
                  COALESCE(SUM(input_tokens), 0)          AS inputTokens,
                  COALESCE(SUM(output_tokens), 0)         AS outputTokens,
                  COALESCE(SUM(cost_micro_cents), 0)      AS costMicroCents
             FROM requests
            WHERE token_fp IS NOT NULL AND token_fp != '' AND endpoint != 'count_tokens'
            GROUP BY token_fp
            ORDER BY requests DESC`,
        )
        .all() as Array<Record<string, unknown>>;
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
      return map;
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
    const days = Number.isFinite(rangeDays) ? Math.max(1, Math.floor(rangeDays)) : 7;
    const nowMs = now ?? Date.now();
    const cached = this.trendCache.get(days);
    if (cached && nowMs - cached.at < TREND_CACHE_MS) return cached.data;
    const fresh = this.queryTrend(days, nowMs);
    this.trendCache.set(days, { at: nowMs, data: fresh });
    return fresh;
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
            WHERE at >= ? AND at < ? AND endpoint NOT IN ('probe', 'count_tokens')
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
    const now = Date.now();
    if (this.historyCache && now - this.historyCacheAt < HISTORY_CACHE_MS) {
      return this.historyCache;
    }
    const fresh = this.queryHistory();
    // 查询失败（返回 null）时不写缓存，下次调用会重试。
    if (fresh) {
      this.historyCache = fresh;
      this.historyCacheAt = now;
    }
    return fresh;
  }

  private queryHistory(): UsageHistory | null {
    try {
      // 排除 key_fp = '-'：那是**还没选到 key 就被拒**的请求（客户端 400 格式
      // 错误、401 鉴权失败、池空 503），它们不属于任何 key。混进 byKey 会在
      // 面板上凭空多出一个「幽灵 key」—— 实测线上出现过 fp='-' 288 条排在
      // 真 key 中间，让人以为池子里有三个号。
      // 同时排除 endpoint = 'probe'：探活是后台维护动作（keyprobe 落库），
      // 不是用户的「累计请求」—— 混进 byKey/totalRequests 会让面板累计数
      // 虚高，且探针每轮都打会给「最近使用」制造假新鲜。
      // 同口径排除 endpoint = 'count_tokens'：记账请求是纯本地估算（Claude Code
      // 每条消息前都调一次），不是真实上游流量，混进按 key 的用量账本会虚高。
      const byKey = this.db
        .prepare(
          `SELECT key_fp                                    AS fingerprint,
                  COUNT(*)                                   AS requests,
                  SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS ok,
                  SUM(CASE WHEN status >= 400 OR status = 0 THEN 1 ELSE 0 END)    AS failed,
                  COALESCE(SUM(input_tokens), 0)             AS inputTokens,
                  COALESCE(SUM(output_tokens), 0)            AS outputTokens,
                  MAX(at)                                    AS lastAt
             FROM requests
            WHERE key_fp != '-' AND endpoint NOT IN ('probe', 'count_tokens')
            GROUP BY key_fp
            ORDER BY requests DESC`,
        )
        .all() as Array<Record<string, number | string>>;

      // 未归属请求单独给一个数，面板可以显示「另有 N 条未到达上游」。
      // 不能直接丢掉：它们是真实发生的请求，丢了总数就对不上。
      const unattributed = this.db
        .prepare(
          `SELECT COUNT(*) AS requests,
                  SUM(CASE WHEN status >= 400 OR status = 0 THEN 1 ELSE 0 END) AS failed
             FROM requests WHERE key_fp = '-'`,
        )
        .get() as { requests: number; failed: number };

      // 总数与 byKey 同口径：排除探活与记账请求（都是维护动作，不是用户流量）。
      const meta = this.db
        .prepare(
          `SELECT COALESCE(MIN(at), 0) AS since, COUNT(*) AS total FROM requests WHERE endpoint NOT IN ('probe', 'count_tokens')`,
        )
        .get() as { since: number; total: number };

      const recent = this.db
        .prepare(
          `SELECT at, key_fp AS fingerprint, type, kind, cooldown_ms AS cooldownMs
             FROM key_events ORDER BY at DESC LIMIT 20`,
        )
        .all() as Array<Record<string, never>>;

      return {
        since: Number(meta.since) || 0,
        totalRequests: Number(meta.total) || 0,
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
      this.db.prepare('DELETE FROM requests WHERE at < ?').run(cutoff);
      this.db.prepare('DELETE FROM key_events WHERE at < ?').run(cutoff);
      // 管理审计与请求日志同一保留期（按 at）。
      this.db.prepare('DELETE FROM admin_audit WHERE at < ?').run(cutoff);
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
              monthly_limit_units, monthly_usage_units, legacy_cookie_enc, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      vals.push(v);
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
  ['oauthRefreshEnc', 'oauth_refresh_enc'],
  ['status', 'status'],
  ['statusDetail', 'status_detail'],
  ['retryUntil', 'retry_until'],
  ['lastProbeAt', 'last_probe_at'],
  ['lastBillingAt', 'last_billing_at'],
  ['balanceUnits', 'balance_units'],
  ['monthlyLimitUnits', 'monthly_limit_units'],
  ['monthlyUsageUnits', 'monthly_usage_units'],
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
    oauthRefreshEnc: r.oauth_refresh_enc == null ? null : String(r.oauth_refresh_enc),
    status: String(r.status),
    statusDetail: r.status_detail == null ? null : String(r.status_detail),
    retryUntil: Number(r.retry_until) || 0,
    lastProbeAt: Number(r.last_probe_at) || 0,
    lastBillingAt: Number(r.last_billing_at) || 0,
    balanceUnits: r.balance_units == null ? null : Number(r.balance_units),
    monthlyLimitUnits: r.monthly_limit_units == null ? null : Number(r.monthly_limit_units),
    monthlyUsageUnits: r.monthly_usage_units == null ? null : Number(r.monthly_usage_units),
    createdAt: Number(r.created_at),
  };
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
