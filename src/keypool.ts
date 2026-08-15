import { createHash } from 'node:crypto';

/**
 * 上游 key 池：多 key 自动分流 + 失败自动禁用 + 冷却恢复。
 *
 * 目标：
 * - 多个上游 key 分摊并发（least-loaded），避免单 key 吃满限流。
 * - 失效 key（401/403 凭据无效）自动禁用，冷却后恢复。
 * - 请求失败时换下一个可用 key 重试一次，避免单 key 故障拖垮所有请求。
 * - key 可归属账户（accountId），供面板按账户聚合；增删 key 热生效（不重启）。
 *
 * 状态机（每个 key）：
 * - `disabledUntil`：禁用截止时间戳（0 = 未禁用）。由额度耗尽/凭据错误/限流触发。
 * - `failCount`：连续失败次数（距上次成功清零；距上次失败超过冷却期也清零）。
 * - `inFlight`：当前活跃请求数。least-loaded 选择依据，body 读完/中断后释放。
 * - `lastFailAt`：最后一次失败时间戳（-1 = 从未失败），用于滑动窗口近似。
 * - `lastUsedAt`：最后被选中时间戳，并发全 0 时按最旧优先轮转。
 */

interface PooledKey {
  key: string;
  /** 所属账户 id；0 = 未归属（仅 env 配置，未进账户表）。 */
  accountId: number;
  disabledUntil: number;
  failCount: number;
  inFlight: number;
  lastUsedAt: number;
  lastFailAt: number;
  /** 上次被选中的单调序号，用于并发相同时的公平轮转。 */
  lastUsedSeq: number;
  /**
   * 当前禁用的原因（未禁用时 undefined）。**只用于展示/审计，不参与选路。**
   *
   * 为什么要存：原因此前只出现在 `KeyStateEvent` 里飘过一次（进日志），
   * 面板拿不到 —— 排查「这个 key 怎么了」得去 `journalctl` 翻日志再读源码
   * 算冷却时间。存下来才能在面板上直接显示「disabled · quota-exhausted」。
   */
  disabledReason?: UpstreamFailureKind;
  /** 被 `acquire()` 选中的累计次数（进程级，重启清零）。判断分流是否均匀用。 */
  totalAcquired: number;
}

/**
 * 单个 key 的对外快照（面板 / `/__metrics` 用）。**key 只以指纹出现，绝不含原文。**
 *
 * 设计要点：`disabledUntil`（绝对时刻）与 `recoverInMs`（相对剩余）**两个都给**。
 * 面板要显示「恢复于 08:01:42（还剩 5h58m）」，给绝对值它不用推算日期、
 * 给相对值它能本地每秒倒计时，不依赖轮询精度。
 */
export interface PoolKeySnapshot {
  /** key 指纹（末 4 位），如 `****ZOBb`。 */
  fingerprint: string;
  /** 所属账户 id；0 = 未归属（仅 env 配置，未进账户表）。 */
  accountId: number;
  /** 当前是否可用（冷却已过）。 */
  healthy: boolean;
  /** 当前活跃请求数 —— 「几个号在扛并发分流」的直接答案。 */
  inFlight: number;
  /** 连续失败计数（距上次成功清零）。 */
  failCount: number;
  /** 禁用原因；健康时为 undefined。 */
  disabledReason?: UpstreamFailureKind;
  /** 禁用截止的绝对时间戳；0 = 未禁用。 */
  disabledUntil: number;
  /** 距恢复还剩多少毫秒；未禁用为 0。 */
  recoverInMs: number;
  /** 最后被选中的时间戳；0 = 从未使用。 */
  lastUsedAt: number;
  /** 被选中的累计次数（进程级）。 */
  totalAcquired: number;
}

export interface KeyPoolOptions {
  /** 冷却期基础时长（毫秒）。凭据无效 key 用该值的 12 倍。 */
  cooldownMs: number;
  /** 连续失败多少次后禁用。401/403 立即禁用，不受此限。 */
  failThreshold: number;
  /** 时间源，可注入以便测试。 */
  now?: () => number;
  /**
   * 长冷却持久化（2026-08-15 扩展）：quota-exhausted / auth / manual 的禁用写入
   * 磁盘，重启恢复——否则重启后冷却丢失，额度耗尽的 key 被重新选号、每个请求
   * 先撞一次 429 再换号（实测 0osU 14:35 禁 → 重启 → 15:13 又被选再禁），auth
   * 坏 key 回池再撞 401，manual 操作员停用的 key 复活（与 0osU 事故同构）。
   * rate-limit/transient 短冷却不持久化（本就该重启即过）。
   * map: sha256(key) 全 hex → `{until, reason}`（2026-08-16 P1 从末 4 位指纹改全量
   * 哈希——两把同尾 key 会互踩条目）。**旧格式兼容**：load 可能返回旧版 `{fp: until}`
   * （纯 number）或旧键 `****XXXX`（指纹），构造与每次写入时按 reason='quota-exhausted'
   * 归一，指纹键按 keyFingerprint 匹配迁移到 sha256 键。load/save 失败静默（不阻断）。
   */
  persistDisabled?: {
    load(): Record<string, number | PersistedDisable>;
    save(m: Record<string, PersistedDisable>): void;
  };
  /**
   * key 状态变更回调（禁用/恢复），用于日志与可观测性。
   *
   * 为什么需要：2026-08-09 线上出过 295 个 503（整池被禁 ~3 分钟），但日志里
   * 只有 access 行，没有任何禁用记录 —— 无法区分是 transient 累积、auth 还是
   * 额度耗尽导致的。事后只能靠推断。注入回调而不是直接 console，保持本类可测。
   */
  onStateChange?: (event: KeyStateEvent) => void;
}

/** key 被禁用或恢复的事件，喂日志用。key 只以指纹形式出现，不落原文。 */
export interface KeyStateEvent {
  type: 'disabled' | 'recovered';
  /** key 指纹（末 4 位） */
  fingerprint: string;
  /** 触发禁用的失败类型；恢复事件为 undefined */
  kind?: UpstreamFailureKind;
  /** 冷却时长（毫秒）；恢复事件为 undefined */
  cooldownMs?: number;
  /** 事件发生后池内健康 key 数 */
  healthyCount: number;
  /** 池内 key 总数 */
  poolSize: number;
}

export type UpstreamFailureKind = 'auth' | 'rate-limit' | 'quota-exhausted' | 'transient' | 'manual';

/**
 * 持久化禁用的磁盘结构（pool-disabled.json 条目）：until + 原因。
 * 2026-08-15 扩展：旧版只存 quota-exhausted（值即 until 数字）；现把 auth/manual
 * 一并持久化，值改对象以便重启后按原因恢复 disabledReason（auth 坏 key 不回池
 * 撞 401、manual 操作员停用不复活）。
 */
export interface PersistedDisable {
  until: number;
  reason: 'quota-exhausted' | 'auth' | 'manual';
}

/**
 * 额度耗尽但解析不出重置时间时的默认冷却：24 小时（2026-08-14 从 1h 提升）。
 *
 * 为什么是 24h 而不是 1h：实测上游（opencode zen）的额度错误绝大多数没有
 * `Resets in` 时间（FreeUsageLimitError 的 message 是 "Rate limit exceeded.
 * Please try again later."），1 小时兜底让 key 每小时回池再撞一次 429 ——
 * 用户实测面板显示「quota-exhausted · 5m26s」这种假冷却，每几分钟一轮失败。
 * 额度窗口的真实恢复时长：free 日窗 24h、周额度 2 天。24h 覆盖两者下界，
 * 回池后若仍未恢复会再解析（有 Resets 的走精确时长）。代价：真并发限流
 * （几秒恢复）被冻 24h —— 但 429 并发限流在 classify 里是 rate-limit 分支
 * （3 秒），只有明确额度类型/额度文案才走到这里，不会误伤。
 */
const QUOTA_FALLBACK_COOLDOWN_MS = 24 * 3_600_000;

/**
 * 冷却策略的对外描述（面板用）。
 *
 * 为什么要暴露：面板此前只显示「剩余 3h16m」这个**结果**，
 * 得出结果的规则（哪种失败冷却多久、连续几次才禁用、选路怎么挑）只在源码里。
 * 用户最初的问题恰恰是「你怎么知道 6 小时」—— 光给数字不够，
 * 还得能当场看出这个数字是按什么规则算出来的、正常不正常。
 *
 * 每条都从**真实配置值**算出来，不写死文案 —— 否则改了 cooldownMs 面板会说谎。
 */
export interface PoolPolicy {
  /** 基础冷却（毫秒），即 `COOLDOWN_MS` 配置值。 */
  cooldownMs: number;
  /** 连续失败多少次触发禁用（历史 transient 类阈值；2026-08-15 起瞬时波动不再禁用，保留供面板展示）。 */
  failThreshold: number;
  /** 选路算法的稳定标识，面板据此显示对应说明。 */
  strategy: 'least-loaded';
  /** 逐失败类型的冷却规则。`ms` 为 null 表示时长由上游给的重置时间决定。 */
  rules: Array<{
    kind: UpstreamFailureKind;
    /** 该类型实际冷却时长（毫秒）；null = 取决于上游返回的重置时间。 */
    ms: number | null;
    /** 是否累计 failCount 到阈值才禁用（false = 首次即禁用）。 */
    countsToThreshold: boolean;
    /** 兜底时长（仅 quota-exhausted 解析失败时用）。 */
    fallbackMs?: number;
  }>;
}

/** 池空时抛出的错误。server 层应转成 503，而不是被兜底 catch 吞成 500。 */
export class PoolEmptyError extends Error {
  constructor() {
    super('all upstream keys are disabled');
    this.name = 'PoolEmptyError';
  }
}

/**
 * 选号过滤把全部健康 key 都滤掉时抛出的错误。server 层应转成 400。
 *
 * 与 PoolEmptyError 的区别：池空是**健康问题**（key 全被禁/没配），回 503 让
 * 客户端重试；模型拒绝是**配置问题**（该账号的模型白名单/被动学习排除了所有
 * key），回 400 让客户端换模型，重试没有意义。
 */
export class ModelNotAllowedError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`model "${model}" is not allowed`);
    this.name = 'ModelNotAllowedError';
    this.model = model;
  }
}

/** 被动学习 (account, model) blocked 的默认 TTL：1 小时（内存态，重启清零）。 */
export const MODEL_BLOCK_TTL_MS = 3_600_000;

/** 从 key 派生指纹（末 4 位），日志用，不落原文。 */
export function keyFingerprint(key: string): string {
  if (key.length <= 4) return '****';
  return `****${key.slice(-4)}`;
}

/**
 * 归一持久化禁用结构：旧格式 `{fp: number}`（2026-08-15 前的 pool-disabled.json）
 * → `{fp: {until, reason}}`。新格式非法条目丢弃。构造加载与每次写入都过这里，
 * 保证写入永远是新结构（旧文件自愈）。
 *
 * m-3（对抗审查）：reason 也校验枚举 —— 手改/损坏的 `reason:'xxx'` 若直接进
 * disabledReason，面板会显示脏值；校验不过的条目整体丢弃（宁可不恢复禁用，
 * 也不把未知原因的 key 悄悄冻起来 —— 原因错比没禁更误导排查）。
 */
const PERSISTED_DISABLE_REASONS: ReadonlySet<string> = new Set(['quota-exhausted', 'auth', 'manual']);

function normalizePersistedDisabled(
  m: Record<string, number | PersistedDisable>,
): Record<string, PersistedDisable> {
  const out: Record<string, PersistedDisable> = {};
  for (const [fp, v] of Object.entries(m)) {
    if (typeof v === 'number') out[fp] = { until: v, reason: 'quota-exhausted' };
    else if (v != null && typeof v.until === 'number' && PERSISTED_DISABLE_REASONS.has(v.reason)) out[fp] = v;
  }
  return out;
}

export class KeyPool {
  private keys: PooledKey[];
  private readonly opts: Required<KeyPoolOptions>;
  /** 单调递增的选中序号，驱动公平轮转（见 PooledKey.lastUsedSeq）。 */
  private seq = 0;
  /**
   * 最近一次额度耗尽的完整上游错误（status + body），池空透传用。
   * 只在分类为 quota-exhausted 时由 [`noteQuotaError`] 写入。
   */
  private lastQuotaError: { status: number; body: unknown } | null = null;
  /**
   * 被动学习：上游对某账号某模型判定「永久不可用」（401 ModelError / not
   * supported，见 errors.isModelUnsupported）后，记 (accountId, model) blocked，
   * 选号时排除该组合。TTL 到期自动失效（探测豁免，见 blockModel）。
   * **纯内存态**（2026-08-16 回退：原持久化重启恢复被判定过度工程——1h TTL 的
   * 被动学习组合重启后重撞一次成本可忽略，不值得磁盘文件）。
   */
  private modelBlocks = new Map<string, number>();

  /**
   * sha256 指纹预计算索引（P2-4）：sha256(key) 全 hex → key。构造/addKey 时
   * 维护，removeKey 时删除。原 hasKeyWithHash 每调用遍历全部 key 逐把重算
   * sha256（O(n) 次哈希）；预计算后 O(1) 点查。key 原文只作 Map value 内部
   * 持有，对外仍只暴露指纹 —— 与 snapshot/disabledFingerprints 同一约束。
   */
  private readonly sha256ByKey = new Map<string, string>();

  /** sha256(key) 全 hex。持久化键与预计算索引共用的同一哈希口径。 */
  private sha256Hex(key: string): string {
    return createHash('sha256').update(key, 'utf8').digest('hex');
  }

  private indexSha256(key: string): void {
    this.sha256ByKey.set(this.sha256Hex(key), key);
  }

  constructor(
    rawKeys: string[],
    options: KeyPoolOptions,
    accountIds?: ReadonlyMap<string, number>,
  ) {
    const seen = new Set<string>();
    this.keys = [];
    for (const raw of rawKeys) {
      const key = raw.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      this.keys.push({
        key,
        // 账户映射可选：未给或没命中一律 0（env keys 兜底）。重复 key 取第一个命中。
        accountId: accountIds?.get(key) ?? 0,
        disabledUntil: 0,
        failCount: 0,
        inFlight: 0,
        lastUsedAt: 0,
        lastUsedSeq: 0,
        lastFailAt: -1,
        totalAcquired: 0,
      });
      this.indexSha256(key);
    }
    this.opts = {
      cooldownMs: options.cooldownMs,
      failThreshold: options.failThreshold,
      now: options.now ?? Date.now,
      onStateChange: options.onStateChange ?? (() => {}),
      persistDisabled: options.persistDisabled ?? { load: () => ({}), save: () => {} },
    };
    // 重启恢复持久化的长冷却：quota-exhausted / auth / manual 禁用的 key 不参与
    // 选号，直到冷却到期（避免重启后坏 key 回池撞 429/401、操作员停用复活）。
    // 旧格式（{fp: until}）在此归一为 {until, reason}，reason 按 quota-exhausted。
    if (this.opts.persistDisabled) {
      try {
        const persisted = normalizePersistedDisabled(this.opts.persistDisabled.load());
        const now = this.now();
        // 新格式：键 = sha256(key) 全 hex，按 key 精确命中（P1：末 4 位会碰撞，
        // 两把同尾 key 互踩条目，已改全量哈希）。
        for (const k of this.keys) {
          const entry = persisted[this.sha256Hex(k.key)];
          if (entry != null && entry.until > now) {
            k.disabledUntil = entry.until;
            k.disabledReason = entry.reason;
            k.lastFailAt = now;
          }
        }
        // 旧格式迁移：键 = ****XXXX 指纹（线上 pool-disabled.json 是 ****0osU 形态）。
        // 按 keyFingerprint 匹配到池内 key 恢复冷却；写入时才归一为新格式键
        // （见 setPersistedDisabled/dropPersistedDisabled 的双键清理）。
        for (const [oldFp, entry] of Object.entries(persisted)) {
          if (!oldFp.startsWith('****') || entry == null || entry.until <= now) continue;
          for (const k of this.keys) {
            if (keyFingerprint(k.key) !== oldFp) continue;
            // 只延长不缩短：新格式已应用更长冷却时不覆盖。
            if (entry.until > k.disabledUntil) {
              k.disabledUntil = entry.until;
              k.disabledReason = entry.reason;
              k.lastFailAt = now;
            }
          }
        }
      } catch {
        // 持久化加载失败不阻断（池照常构建，代价是冷却丢失一次）。
      }
    }
  }

  /**
   * 上报一次禁用事件。在 `disabledUntil` 赋值**之后**调用，
   * 这样 `healthyCount` 已反映禁用后的真实状态。
   */
  private emitDisabled(k: PooledKey, kind: UpstreamFailureKind, cooldownMs: number): void {
    this.opts.onStateChange({
      type: 'disabled',
      fingerprint: keyFingerprint(k.key),
      kind,
      cooldownMs,
      healthyCount: this.healthyCount,
      poolSize: this.keys.length,
    });
  }

  get size(): number {
    return this.keys.length;
  }

  /** 健康（可用）key 数。 */
  get healthyCount(): number {
    return this.keys.filter((k) => this.isAvailable(k)).length;
  }

  private now(): number {
    return this.opts.now();
  }

  private isAvailable(k: PooledKey): boolean {
    return k.disabledUntil <= this.now();
  }

  /** 当前禁用（含冷却未到期）的 key 指纹列表，日志用。 */
  disabledFingerprints(): string[] {
    return this.keys.filter((k) => !this.isAvailable(k)).map((k) => keyFingerprint(k.key));
  }

  /**
   * 记录一次真实的额度耗尽错误。调用方在 `classifyUpstreamFailure` 判出
   * `quota-exhausted` 且持有上游错误体时调。
   *
   * 为什么要有它：整池同时额度耗尽时 `acquire` 直接抛 `PoolEmptyError`，
   * 没有任何上游响应能带上错误信息 —— 下游（kirostudio 等）只看到通用 503
   * 「all upstream keys are disabled」，不知道是额度问题、更不知道多久恢复。
   * 池空时 [`quotaEmptyError`] 用它把上游的 GoUsageLimitError 原样透传出去。
   */
  noteQuotaError(status: number, body: unknown): void {
    this.lastQuotaError = { status, body };
  }

  /**
   * 池空且**所有**禁用 key 的原因都是额度耗尽时，返回要透传的上游错误；
   * 否则返回 null（调用方回通用 503）。
   *
   * 只透传「纯额度耗尽」的场景 —— 混着 auth/rate-limit 禁用的池空不该伪装成
   * 额度问题，否则下游会误以为重置时间到了就恢复，实际可能另有故障。
   */
  get quotaEmptyError(): { status: number; body: unknown } | null {
    if (this.lastQuotaError == null) return null;
    const disabled = this.keys.filter((k) => !this.isAvailable(k));
    // 只在「池真的空了」时透传：没有任何健康 key 可用（还有健康 key 的话
    // 轮不到把额度耗尽当全池结论；池里没有 key 时也不该拿陈旧的额度错误）。
    const poolEmpty = this.keys.length > 0 && disabled.length === this.keys.length;
    if (!poolEmpty) return null;
    const allQuota = disabled.every((k) => k.disabledReason === 'quota-exhausted');
    return allQuota ? this.lastQuotaError : null;
  }

  /**
   * 记录 (accountId, model) 为被动学习 blocked（模型不可用 ≠ key 不可用）。
   *
   * 调用方在 `isModelUnsupported(status, body)` 判定后调 —— 此时**不**调
   * markFailure（那是 key 的问题，这里 key 是好的，只是该账号端点不带这个
   * 模型）。TTL 由调用方传（默认 MODEL_BLOCK_TTL_MS 1h），到期/clear 时移除。
   * 纯内存态（TTL 短，重启后重撞一次成本可忽略，不持久化）。
   */
  blockModel(accountId: number, model: string, ttlMs: number = MODEL_BLOCK_TTL_MS): void {
    if (!model) return;
    const until = this.now() + ttlMs;
    this.modelBlocks.set(`${accountId}:${model}`, until);
  }

  /** (accountId, model) 是否处于被动学习 blocked 期。到期自动失效。 */
  isModelBlocked(accountId: number, model: string): boolean {
    if (!model) return false;
    const key = `${accountId}:${model}`;
    const until = this.modelBlocks.get(key);
    if (until == null) return false;
    if (until <= this.now()) {
      this.modelBlocks.delete(key);
      return false;
    }
    return true;
  }

  /** 成功请求清除该组合（模型在该账号实际可用，恢复选号）。 */
  clearModelBlock(accountId: number, model: string): void {
    if (!model) return;
    this.modelBlocks.delete(`${accountId}:${model}`);
  }

  /**
   * 冷却策略描述，喂 `/__metrics` 与面板。
   *
   * 每个 `ms` 都用和 `markFailure` **同一套算式**从当前配置算出来，
   * 而不是另抄一份常量 —— 否则改了冷却规则面板会继续显示旧数字。
   * transient 不在规则里（2026-08-15 起瞬时波动不禁用，面板不显示该说明）。
   */
  policy(): PoolPolicy {
    const base = this.opts.cooldownMs;
    return {
      cooldownMs: base,
      failThreshold: this.opts.failThreshold,
      strategy: 'least-loaded',
      rules: [
        // 与 markFailure 的 quota-exhausted 分支一致：上游重置时间 + 60s 余量。
        { kind: 'quota-exhausted', ms: null, countsToThreshold: false, fallbackMs: QUOTA_FALLBACK_COOLDOWN_MS },
        { kind: 'auth', ms: base * 12, countsToThreshold: false },
        { kind: 'rate-limit', ms: Math.min(3000, Math.max(500, Math.floor(base / 100))), countsToThreshold: false },
      ],
    };
  }

  /**
   * 每个 key 的当前状态快照，喂 `/__metrics` 与面板。
   *
   * 为什么需要：此前对外只有 `size`/`healthyCount`/`disabledFingerprints()` 三个
   * 聚合值，面板上就是一行 `pool 1/2`。要回答「哪个 key 在扛并发」「为什么被禁」
   * 「什么时候恢复」，得去 journalctl 翻 `[keypool]` 行、再读源码算冷却公式 ——
   * 那些信息本来就在内存里，只是没暴露。
   *
   * **不含 key 原文**：只输出 `keyFingerprint()` 的末 4 位形式。
   * 顺序与 `OPENSEA_KEYS` 的配置顺序一致（构造时去重后的顺序），方便对号。
   */
  snapshot(): PoolKeySnapshot[] {
    const now = this.now();
    return this.keys.map((k) => {
      const healthy = k.disabledUntil <= now;
      return {
        fingerprint: keyFingerprint(k.key),
        accountId: k.accountId,
        healthy,
        inFlight: k.inFlight,
        failCount: k.failCount,
        // 健康的 key 不带原因（禁用字段在 reapRecovered/reset 里清，但冷却自然到期
        // 而还没走到 acquire 时 disabledUntil 仍是旧值 —— 用 healthy 兜住，
        // 保证面板不会显示「healthy 但带着 quota-exhausted」这种自相矛盾的状态）。
        ...(healthy ? {} : { disabledReason: k.disabledReason }),
        disabledUntil: healthy ? 0 : k.disabledUntil,
        recoverInMs: healthy ? 0 : k.disabledUntil - now,
        lastUsedAt: k.lastUsedAt,
        totalAcquired: k.totalAcquired,
      };
    });
  }

  /**
   * 探活用：列出「健康但长时间没接过真实请求」的 key。
   *
   * 为什么需要：面板上的「可用」只代表**不在冷却期**，不代表验证过能用。
   * 实测遇到过两个 key 都显示可用、但 40 分钟内谁都没接过真请求的情况 ——
   * 那时候面板是绿的，可它们到底还能不能用没人知道。
   *
   * 只挑健康的：禁用中的 key 有明确的冷却到期时间，让它自然恢复就行，
   * 拿真实请求去撞一个已知额度耗尽的 key 纯属浪费额度。
   *
   * @param idleMs 多久没被用过就算需要探活
   * @returns 每项含 key 原文（调用方要发请求）与指纹（用于日志/落库）
   */
  staleKeys(idleMs: number): Array<{ key: string; fingerprint: string; idleForMs: number }> {
    const now = this.now();
    const out: Array<{ key: string; fingerprint: string; idleForMs: number }> = [];
    for (const k of this.keys) {
      if (k.disabledUntil > now) continue; // 禁用中，等自然恢复
      if (k.inFlight > 0) continue; // 正在干活，不用探
      // lastUsedAt = 0 表示本进程内从未被选中过（刚重启）—— 也要探，
      // 否则重启后一个从没用过的坏 key 会一直挂着「可用」直到真实流量撞上它。
      const idleFor = k.lastUsedAt === 0 ? Infinity : now - k.lastUsedAt;
      if (idleFor < idleMs) continue;
      out.push({ key: k.key, fingerprint: keyFingerprint(k.key), idleForMs: idleFor });
    }
    return out;
  }

  /**
   * 选择一个 key 并递增 inFlight。同步完成（无 await），保证原子性。
   * least-loaded：优先选 inFlight 最少的健康 key；全 0 时按 lastUsedAt 最旧优先轮转。
   * 所有 key 都禁用时抛 PoolEmptyError。
   *
   * @param excludeKey 本次不参与选路的 key（换 key 重试用：刚失败的 key 刚 release，
   *   inFlight 归 0 会被 least-loaded 立即重选，白撞一次错误再换号）。
   * @param isEligible 账号级/密钥级过滤（账号模型白名单 + 密钥级自定义授权 +
   *   被动学习 block）。健康过滤后再逐 key 按 (accountId, key) 判断；未提供 = 不过滤。
   *   全部健康 key 都被滤掉 → 抛 ModelNotAllowedError（配置问题，区别于池空的健康问题）。
   * @param model 携带进 ModelNotAllowedError 的模型名（选号过滤是账号归属知道后
   *   才做的，error 要能告诉调用方「哪个模型被拒」）。
   */
  acquire(excludeKey?: string, isEligible?: (accountId: number, key: string) => boolean, model = ''): string {
    const now = this.now();
    this.reapRecovered(now);
    const healthy = this.keys.filter((k) => this.isAvailable(k) && k.key !== excludeKey);
    if (healthy.length === 0) {
      // 池空：抛 typed error，server 层转 503。
      throw new PoolEmptyError();
    }
    const eligible = isEligible == null ? healthy : healthy.filter((k) => isEligible(k.accountId, k.key));
    if (eligible.length === 0) {
      // 有健康 key 但全被账号级过滤排除：模型拒绝（配置问题），不是池空（健康问题）。
      throw new ModelNotAllowedError(model);
    }

    let minInFlight = Infinity;
    for (const k of eligible) {
      if (k.inFlight < minInFlight) minInFlight = k.inFlight;
    }
    const candidates = eligible.filter((k) => k.inFlight === minInFlight);
    // 并发并列最闲：按单调序号最旧优先，实现真正均匀的轮转（不能用毫秒时间戳，
    // 串行请求同毫秒会导致永远选第一个 —— 实测 3 key 分布 10/1/1）。
    let selected = candidates[0]!;
    for (const k of candidates) {
      if (k.lastUsedSeq < selected.lastUsedSeq) selected = k;
    }
    selected.inFlight += 1;
    selected.lastUsedAt = now;
    selected.lastUsedSeq = ++this.seq;
    selected.totalAcquired += 1;
    return selected.key;
  }

  /** 请求结束（无论成败）释放并发计数。幂等。 */
  release(key: string): void {
    const k = this.keys.find((p) => p.key === key);
    if (k && k.inFlight > 0) k.inFlight -= 1;
  }

  /** 记录一次成功：清零连续失败计数。 */
  markSuccess(key: string): void {
    const k = this.keys.find((p) => p.key === key);
    if (!k) return;
    k.failCount = 0;
    k.lastFailAt = -1;
    // 记一次「确实成功过」的时刻。真实流量走 acquire() 时已经设过 lastUsedAt，
    // 这里重复设一次无害；但探活（keyprobe）是直接打指定 key、不经 acquire() 的，
    // 少了这行探活成功后 lastUsedAt 仍是旧值 —— 那个 key 会被判定为一直空闲，
    // 每轮都重复探，白烧额度。
    k.lastUsedAt = this.now();
  }

  /**
   * 记录一次失败。按类型分级：
   * - auth（401/403）：立即禁用 + 超长冷却（12 × cooldownMs），冷却后可自动恢复。
   * - rate-limit（429）：不计入禁用计数，只打一个短冷却（避免账号级 429 打爆全池）。
   * - transient（网络错误/超时/5xx）：不禁用（2026-08-15 起瞬时波动不再禁 key、
   *   面板不显示 transient 状态），只累计 failCount 供观测。
   */
  markFailure(key: string, kind: UpstreamFailureKind, resetDelayMs?: number): void {
    const k = this.keys.find((p) => p.key === key);
    if (!k) return;
    const now = this.now();

    // 距上次失败超过冷却期：视为新的一轮，清零计数（廉价的滑动窗口近似）。
    // lastFailAt=-1 表示从未失败；lastFailAt>=0 且超期才清零。
    if (k.lastFailAt >= 0 && now - k.lastFailAt > this.opts.cooldownMs) {
      k.failCount = 0;
    }
    k.lastFailAt = now;

    if (kind === 'quota-exhausted') {
      // 周/月额度耗尽：按上游给的重置时间冷却（解析不出用 1 小时兜底）。
      // 这类 key 短时间内不可能恢复，放它回池只会让每个请求都先撞一次 429
      // 再换号 —— 既慢又白耗。加 60s 余量，避免边界抖动反复试探。
      k.failCount = 0;
      this.disableUntil(k, kind, now, now + (resetDelayMs != null && resetDelayMs > 0
        ? resetDelayMs + 60_000
        : QUOTA_FALLBACK_COOLDOWN_MS));
      return;
    }

    if (kind === 'auth') {
      // 凭据无效：立即禁用，超长冷却（12 × cooldownMs），之后自动恢复（可能被重新配额）。
      k.failCount = 0;
      this.disableUntil(k, kind, now, now + this.opts.cooldownMs * 12);
      return;
    }

    if (kind === 'rate-limit') {
      // 429 / 余额不足：只打**很短**的冷却，不累计禁用计数。
      //
      // 冷却必须短：429 与余额不足通常是**账号级**状态，换 key 也解决不了，
      // 而 key 数量往往很少（线上 2 个）。实际公式 `cooldownMs/100` 并钳到
      // [500ms, 3s]（默认 cooldownMs=300s → 3s）。若冷却过长（如 50s），
      // 连续两次 429 就会把整池打光、之后几十秒全部 503 —— Claude Code 遇 503
      // 直接报错中断，表现为「用一会儿就挂」。所以固定 3 秒上限，
      // 让请求快速重回池子，把重试节奏交给客户端而不是拖死整池。
      // 短冷却也上报：整池同时 rate-limit 一样会造成 503 空窗，
      // 而这恰好是排查 2026-08-09 那 295 个 503 时最大的盲区。
      this.disableUntil(
        k,
        kind,
        now,
        now + Math.min(3000, Math.max(500, Math.floor(this.opts.cooldownMs / 100))),
      );
      return;
    }

    // transient：网络错误/超时/5xx 瞬时波动。不禁用、不设冷却、不显示状态
    // （2026-08-15 用户决定：面板显示「transient · 1m02s」让使用不佳，瞬时波动
    // 不该禁 key；换 key 重试已由 acquire(excludeKey) 承担）。只累计 failCount
    // 供观测（面板「连续失败」列），永不触发禁用。
    k.failCount += 1;
  }

  /**
   * 统一的禁用入口：**只延长冷却，绝不缩短**，原因跟着实际生效的冷却走。
   *
   * 为什么必须这样：`markFailure` 原本四个分支都无条件覆写 `disabledUntil`
   * 和 `disabledReason`。一个已被 19 小时额度冷却禁用的 key，只要再收到一次
   * 迟到的失败上报（同一 key 上早于禁用就已 acquire 的请求断流 → transient，
   * 或一个裸 429 → rate-limit），冷却就会被冲成 4 分钟甚至 3 秒，原因也被改写。
   * 后果正是 `quota-exhausted` 分支注释想避免的：额度耗尽的 key 反复被选中，
   * 每个请求先撞一次 429 再换号；而面板会把「额度耗尽」显示成「临时故障」，
   * 把排查引向反面。
   *
   * 冷却相同或更短时保留原状（含原因），只在真正延长时才更新并上报事件。
   */
  private disableUntil(
    k: PooledKey,
    kind: UpstreamFailureKind,
    now: number,
    until: number,
  ): void {
    if (k.disabledUntil > now && until <= k.disabledUntil) {
      // 已在更长的冷却里：不缩短、不改原因、不重复上报。
      return;
    }
    k.disabledUntil = until;
    k.disabledReason = kind;
    // 长冷却（quota-exhausted / auth / manual）落盘，重启恢复；rate-limit/transient
    // 短冷却不持久化（本就该重启即过）。
    if (kind === 'quota-exhausted' || kind === 'auth' || kind === 'manual') {
      this.setPersistedDisabled(k, kind, until);
    }
    this.emitDisabled(k, kind, until - now);
  }

  /** 持久化长冷却禁用（sha256 键 → {until, reason}），写入前归一旧格式并迁移旧指纹键。 */
  private setPersistedDisabled(k: PooledKey, kind: PersistedDisable['reason'], until: number): void {
    if (!this.opts.persistDisabled) return;
    try {
      const m = normalizePersistedDisabled(this.opts.persistDisabled.load());
      // 迁移：同 key 的旧格式指纹条目（****XXXX）一并移除，写入后文件只含 sha256 键
      //（P1：末 4 位会碰撞，持久化键统一用 sha256 全 hex）。
      delete m[keyFingerprint(k.key)];
      m[this.sha256Hex(k.key)] = { until, reason: kind };
      this.opts.persistDisabled.save(m);
    } catch {
      // 持久化失败不阻断（代价：重启后冷却丢失一次）。
    }
  }

  /** 从持久化移除已恢复的 key（冷却到期/显式 reset）。新键 sha256 + 旧指纹键一并清。 */
  private dropPersistedDisabled(k: PooledKey): void {
    if (!this.opts.persistDisabled) return;
    try {
      const m = normalizePersistedDisabled(this.opts.persistDisabled.load());
      const hash = this.sha256Hex(k.key);
      const fp = keyFingerprint(k.key);
      let changed = false;
      if (m[hash] != null) {
        delete m[hash];
        changed = true;
      }
      // 旧格式残留（****XXXX 键）一并清：否则 reset/移除后重启又被旧条目复活禁用。
      if (m[fp] != null) {
        delete m[fp];
        changed = true;
      }
      if (changed) this.opts.persistDisabled.save(m);
    } catch {
      // 忽略。
    }
  }

  /** 显式恢复一个 key（测试/运维用）。 */
  reset(key: string): void {
    const k = this.keys.find((p) => p.key === key);
    if (!k) return;
    k.disabledUntil = 0;
    k.failCount = 0;
    k.lastFailAt = -1;
    delete k.disabledReason;
    this.dropPersistedDisabled(k);
  }

  /**
   * 手动禁用（面板「禁用」按钮）：无论当前冷却状态，直接把该 key 置为停用
   * 至 `until`（默认**哨兵** `Number.MAX_SAFE_INTEGER`，即永不过期、只有 reset 恢复）。
   *
   * 为什么用哨兵而不是 365 天（MINOR）：`MANUAL_DISABLE_HORIZON_MS` 让 manual
   * 一年后自动回池复活——操作员显式停用不该有「自动到期」。哨兵令 isAvailable
   * （disabledUntil <= now）恒 false、reapRecovered（<= now）永不触发；且哨兵是
   * 任意自动冷却的上界，disableUntil 的「只延长不缩短」守卫在它之后不会把 manual
   * 覆盖成更短的自动冷却。`until` 显式传值时按传值停用（可做限时停用）。
   *
   * 与失败冷却的关系：统一走 disableUntil（2026-08-15 起）——其「只延长不缩短」
   * 守卫在 manual 哨兵下正常不会触发，操作员显式停用照样生效；reason='manual'，
   * 面板据此显示「manual」。**持久化**：manual 与其他长冷却一样写入磁盘（until 存
   * MAX_SAFE_INTEGER 大数，JSON 无损），重启后仍停用——否则操作员停用的 key 重启
   * 复活，探活/流量把它拉起烧额度（0osU 事故同构）。返回是否找到该 key。
   */
  disable(key: string, until?: number): boolean {
    const k = this.keys.find((p) => p.key === key);
    if (!k) return false;
    const now = this.now();
    const horizon = until ?? Number.MAX_SAFE_INTEGER;
    // 操作员显式停用：接管状态，清空失败累计（与旧行为一致），统一走
    // disableUntil 获得持久化 + 原因标记 + 事件上报。
    k.failCount = 0;
    k.lastFailAt = -1;
    this.disableUntil(k, 'manual', now, horizon);
    return true;
  }

  /**
   * 指纹（****XXXX）→ 明文 key 的解析（管理面手动启停端点用）。返回的明文
   * **只在进程内流转**（立即用于 disable/reset），绝不进响应/日志/落库 ——
   * 与 snapshot/disabledFingerprints 同一不泄明文约束。多个 key 共享同指纹
   * （末 4 位碰撞）时取池内第一个；未命中返回 null。
   */
  keyByFingerprint(fp: string): string | null {
    const target = fp.trim();
    for (const k of this.keys) {
      if (keyFingerprint(k.key) === target) return k.key;
    }
    return null;
  }

  /**
   * 指纹（****XXXX）→ 该 key 是否处于「操作员手动停用」（reason='manual'）。
   *
   * keyprobe 探活前用（m-1 对抗审查）：manual 是操作员显式停用（哨兵 until，
   * 只有 reset() 恢复），探活去撞它纯属白打上游调用 —— 它不会因探活恢复，
   * 也不会因上游响应改变状态。quota-exhausted / auth 冷却的 key 探活是「到期前
   * 确认恢复」的主力手段（保留），**只跳过 manual**。未命中指纹返回 false。
   */
  isManuallyDisabled(fingerprint: string): boolean {
    const target = fingerprint.trim();
    for (const k of this.keys) {
      if (keyFingerprint(k.key) !== target) continue;
      return k.disabledReason === 'manual' && k.disabledUntil > this.now();
    }
    return false;
  }

  /**
   * 热加载新增一个 key（面板加号用）。与构造同口径：trim、去空、去重。
   * 新 key 的 lastUsedAt=0 → 下一轮探针会自动探它（staleKeys 语义白拿）。
   */
  addKey(key: string, accountId: number): boolean {
    const trimmed = key.trim();
    if (!trimmed || this.keys.some((p) => p.key === trimmed)) return false;
    this.keys.push({
      key: trimmed,
      accountId,
      disabledUntil: 0,
      failCount: 0,
      inFlight: 0,
      lastUsedAt: 0,
      lastUsedSeq: 0,
      lastFailAt: -1,
      totalAcquired: 0,
    });
    this.indexSha256(trimmed);
    return true;
  }

  /**
   * 热加载删除一个 key（面板删除用）。在飞请求安全：删掉后
   * release/markFailure/markSuccess 的 find 守卫直接 return，不崩。
   */
  removeKey(key: string): boolean {
    const idx = this.keys.findIndex((p) => p.key === key.trim());
    if (idx === -1) return false;
    const removed = this.keys[idx]!;
    this.sha256ByKey.delete(this.sha256Hex(key.trim()));
    this.keys.splice(idx, 1);
    // 移除时清掉持久化禁用（2026-08-15）：否则该指纹的 quota-exhausted 条目留在
    // pool-disabled.json，重加同一把 key 时本进程内健康、重启后又恢复禁用——
    // 面板会看到「突然都健康 / 重启后变禁用」的来回跳。
    this.dropPersistedDisabled(removed);
    return true;
  }

  /** key 所属账户 id；未知 key 返回 0（未归属）。 */
  accountIdOf(key: string): number {
    return this.keys.find((p) => p.key === key.trim())?.accountId ?? 0;
  }

  /**
   * 池内是否存在 sha256(key) 全 hex = 给定值的 key（MODEL-ACCESS 管理面校验
   * upstream-key subject 用）。纯内部比对，不返回任何 key 材料 —— 与
   * snapshot/disabledFingerprints 同一不泄明文约束。
   * P2-4：sha256 在构造/addKey 时预计算进 Map，O(1) 点查（不再每调用遍历
   * 全部 key 逐把重算哈希）。
   */
  hasKeyWithHash(sha256Hex: string): boolean {
    return this.sha256ByKey.has(sha256Hex);
  }

  /**
   * 冷却到期的 key 恢复为可用。在 acquire 前调用，让「恢复」这个关键状态
   * 变更也有日志（线上排查过整池被禁 3 分钟，只有 503 没有原因）。
   * 只上报一次，避免冷却在 acquire 前自然到期导致重复报。
   */
  private reapRecovered(now: number): void {
    for (const k of this.keys) {
      if (k.disabledUntil !== 0 && k.disabledUntil <= now) {
        k.disabledUntil = 0;
        k.failCount = 0;
        k.lastFailAt = -1;
        delete k.disabledReason;
        this.dropPersistedDisabled(k);
        this.opts.onStateChange({
          type: 'recovered',
          fingerprint: keyFingerprint(k.key),
          healthyCount: this.healthyCount,
          poolSize: this.keys.length,
        });
      }
    }
  }
}
