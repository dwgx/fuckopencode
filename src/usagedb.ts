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
 * 所以这里落盘两张表：每请求一行（可任意区间回溯）+ key 状态变更审计
 * （回答「这个 key 今天被禁过几次」）。
 *
 * # 三条承重设计（改之前先理解）
 *
 * 1. **零运行时依赖**：用 Node 内置 `node:sqlite`（Node 22+），**不引入任何 npm 包**。
 *    本项目 `package.json` 的 `dependencies` 是空的，这是刻意的卖点（线上无 node_modules）。
 * 2. **可降级，绝不影响代理**：`node:sqlite` 不存在（Node 20，`engines` 允许）或打开
 *    失败（盘满/权限）→ 记一条 warn，整个模块退化成 no-op。面板照常工作，只是没有
 *    历史累计。**代理链路一个字节都不受影响** —— 观测设施永远不能成为主链路的故障源。
 * 3. **写入不阻塞请求**：`node:sqlite` 是同步 API，单条 prepared INSERT 亚毫秒级；
 *    开 WAL + `synchronous=NORMAL`（VPS 上不追求断电零丢失，追求不卡请求）。
 *    每次写入都在 try/catch 里，抛错只记日志不上抛。
 *
 * # 隐私
 *
 * **只存 key 指纹（末 4 位 `****XXXX`），绝不存 key 原文。** 与日志、面板、
 * `/__metrics` 全链路口径一致。
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

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
 * `history()` 结果的缓存时长。面板每 2 秒轮询，但那条全表 `GROUP BY` 在
 * 十万行量级要几百毫秒且同步阻塞事件循环 —— 详见 `history()` 的注释。
 */
const HISTORY_CACHE_MS = 15_000;

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
  private historyCache: UsageHistory | null = null;
  private historyCacheAt = 0;
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
      // synchronous=NORMAL：不为每次提交等 fsync —— VPS 上断电丢最后几条用量
      // 完全可接受，卡住代理请求不可接受。
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
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
            input_tokens, output_tokens, thinking_tokens, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      this.insertKeyEvent = this.db.prepare(
        `INSERT INTO key_events
           (at, key_fp, type, kind, cooldown_ms, healthy_count, pool_size)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
        error TEXT
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
    `);
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
      );
      this.maybePrune(row.at);
    } catch (err) {
      this.log(`[usagedb] 写入请求记录失败（已忽略）: ${err instanceof Error ? err.message : err}`);
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
            WHERE key_fp != '-'
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

      const meta = this.db
        .prepare('SELECT COALESCE(MIN(at), 0) AS since, COUNT(*) AS total FROM requests')
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

  /** 立即执行一次保留期清理（跳过节流）。`retentionDays=0` 时是空操作。 */
  pruneNow(now: number): void {
    if (!this.enabled || this.retentionMs <= 0) return;
    this.nextPruneAt = now + PRUNE_INTERVAL_MS;
    this.prune(now);
  }

  private prune(now: number): void {
    const cutoff = now - this.retentionMs;
    // 删了行，缓存的聚合就不再成立，作废它。
    this.historyCache = null;
    try {
      this.db.prepare('DELETE FROM requests WHERE at < ?').run(cutoff);
      this.db.prepare('DELETE FROM key_events WHERE at < ?').run(cutoff);
    } catch (err) {
      this.log(`[usagedb] 保留期清理失败（已忽略）: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** 关闭底层句柄。幂等。 */
  close(): void {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {
      // 关闭失败无所谓，进程退出时 OS 会回收。
    }
    this.db = null;
  }
}

/** 默认 db 路径：代码目录旁的 `data/usage.db`。 */
export function defaultDbPath(baseDir: string): string {
  return path.join(baseDir, 'data', 'usage.db');
}
