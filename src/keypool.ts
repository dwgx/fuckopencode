/**
 * 上游 key 池：多 key 自动分流 + 失败自动禁用 + 冷却恢复。
 *
 * 目标：
 * - 多个上游 key 分摊并发（least-loaded），避免单 key 吃满限流。
 * - 失效 key（401/403 凭据无效、连续失败超阈值）自动禁用，冷却后恢复。
 * - 请求失败时换下一个可用 key 重试一次，避免单 key 故障拖垮所有请求。
 *
 * 状态机（每个 key）：
 * - `disabledUntil`：禁用截止时间戳（0 = 未禁用）。由失败计数/凭据错误触发。
 * - `failCount`：连续失败次数（距上次成功清零；距上次失败超过冷却期也清零）。
 * - `inFlight`：当前活跃请求数。least-loaded 选择依据，body 读完/中断后释放。
 * - `lastFailAt`：最后一次失败时间戳（-1 = 从未失败），用于滑动窗口近似。
 * - `lastUsedAt`：最后被选中时间戳，并发全 0 时按最旧优先轮转。
 */

interface PooledKey {
  key: string;
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

export type UpstreamFailureKind = 'auth' | 'rate-limit' | 'quota-exhausted' | 'transient';

/** 额度耗尽但解析不出重置时间时的默认冷却：1 小时。 */
const QUOTA_FALLBACK_COOLDOWN_MS = 3_600_000;

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
  /** 连续失败多少次触发禁用（transient 类）。 */
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

/** 从 key 派生指纹（末 4 位），日志用，不落原文。 */
export function keyFingerprint(key: string): string {
  if (key.length <= 4) return '****';
  return `****${key.slice(-4)}`;
}

export class KeyPool {
  private keys: PooledKey[];
  private readonly opts: Required<KeyPoolOptions>;
  /** 单调递增的选中序号，驱动公平轮转（见 PooledKey.lastUsedSeq）。 */
  private seq = 0;

  constructor(rawKeys: string[], options: KeyPoolOptions) {
    const seen = new Set<string>();
    this.keys = [];
    for (const raw of rawKeys) {
      const key = raw.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      this.keys.push({
        key,
        disabledUntil: 0,
        failCount: 0,
        inFlight: 0,
        lastUsedAt: 0,
        lastUsedSeq: 0,
        lastFailAt: -1,
        totalAcquired: 0,
      });
    }
    this.opts = {
      cooldownMs: options.cooldownMs,
      failThreshold: options.failThreshold,
      now: options.now ?? Date.now,
      onStateChange: options.onStateChange ?? (() => {}),
    };
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
   * 冷却策略描述，喂 `/__metrics` 与面板。
   *
   * 每个 `ms` 都用和 `markFailure` **同一套算式**从当前配置算出来，
   * 而不是另抄一份常量 —— 否则改了冷却规则面板会继续显示旧数字。
   * transient 给的是首次触发禁用时的时长（退避基数，之后按 2 的幂增长）。
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
        { kind: 'transient', ms: base, countsToThreshold: true },
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
   * 选择一个 key 并递增 inFlight。同步完成（无 await），保证原子性。
   * least-loaded：优先选 inFlight 最少的健康 key；全 0 时按 lastUsedAt 最旧优先轮转。
   * 所有 key 都禁用时抛 PoolEmptyError。
   */
  acquire(): string {
    const now = this.now();
    this.reapRecovered(now);
    const healthy = this.keys.filter((k) => this.isAvailable(k));
    if (healthy.length === 0) {
      // 池空：抛 typed error，server 层转 503。
      throw new PoolEmptyError();
    }

    let minInFlight = Infinity;
    for (const k of healthy) {
      if (k.inFlight < minInFlight) minInFlight = k.inFlight;
    }
    const candidates = healthy.filter((k) => k.inFlight === minInFlight);
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
  }

  /**
   * 记录一次失败。按类型分级：
   * - auth（401/403）：立即禁用 + 超长冷却（12 × cooldownMs），冷却后可自动恢复。
   * - rate-limit（429）：不计入禁用计数，只打一个短冷却（避免账号级 429 打爆全池）。
   * - transient（网络错误/超时/5xx）：计入连续失败，达到阈值禁用；冷却指数退避。
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
      // 而 key 数量往往很少（线上 2 个）。用 cooldownMs/6（默认 50s）会让
      // 连续两次 429 就把整池打光、之后 50 秒全部 503 —— Claude Code 遇 503
      // 直接报错中断，表现为「用一会儿就挂」。所以这里固定 3 秒上限，
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

    // transient：累计连续失败，达到阈值禁用 + 指数退避冷却。
    k.failCount += 1;
    if (k.failCount >= this.opts.failThreshold) {
      const backoff = this.opts.cooldownMs * 2 ** Math.min(k.failCount - this.opts.failThreshold, 4);
      // 加 ±20% 抖动，避免整池冷却同时到期后 thundering herd。
      const jittered = Math.floor(backoff * (0.8 + Math.random() * 0.4));
      k.failCount = 0;
      this.disableUntil(k, kind, now, now + jittered);
    }
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
    this.emitDisabled(k, kind, until - now);
  }

  /** 显式恢复一个 key（测试/运维用）。 */
  reset(key: string): void {
    const k = this.keys.find((p) => p.key === key);
    if (!k) return;
    k.disabledUntil = 0;
    k.failCount = 0;
    k.lastFailAt = -1;
    delete k.disabledReason;
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
