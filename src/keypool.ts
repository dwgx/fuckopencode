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
}

export interface KeyPoolOptions {
  /** 冷却期基础时长（毫秒）。凭据无效 key 用该值的 12 倍。 */
  cooldownMs: number;
  /** 连续失败多少次后禁用。401/403 立即禁用，不受此限。 */
  failThreshold: number;
  /** 时间源，可注入以便测试。 */
  now?: () => number;
}

export type UpstreamFailureKind = 'auth' | 'rate-limit' | 'transient';

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
        lastFailAt: -1,
      });
    }
    this.opts = {
      cooldownMs: options.cooldownMs,
      failThreshold: options.failThreshold,
      now: options.now ?? Date.now,
    };
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
   * 选择一个 key 并递增 inFlight。同步完成（无 await），保证原子性。
   * least-loaded：优先选 inFlight 最少的健康 key；全 0 时按 lastUsedAt 最旧优先轮转。
   * 所有 key 都禁用时抛 PoolEmptyError。
   */
  acquire(): string {
    const now = this.now();
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
    // 并发全 0（或并列最闲）：按 lastUsedAt 最旧优先，均匀轮转。
    let selected = candidates[0]!;
    for (const k of candidates) {
      if (k.lastUsedAt < selected.lastUsedAt) selected = k;
    }
    selected.inFlight += 1;
    selected.lastUsedAt = now;
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
  markFailure(key: string, kind: UpstreamFailureKind): void {
    const k = this.keys.find((p) => p.key === key);
    if (!k) return;
    const now = this.now();

    // 距上次失败超过冷却期：视为新的一轮，清零计数（廉价的滑动窗口近似）。
    // lastFailAt=-1 表示从未失败；lastFailAt>=0 且超期才清零。
    if (k.lastFailAt >= 0 && now - k.lastFailAt > this.opts.cooldownMs) {
      k.failCount = 0;
    }
    k.lastFailAt = now;

    if (kind === 'auth') {
      // 凭据无效：立即禁用，超长冷却（12 × cooldownMs），之后自动恢复（可能被重新配额）。
      k.disabledUntil = now + this.opts.cooldownMs * 12;
      k.failCount = 0;
      return;
    }

    if (kind === 'rate-limit') {
      // 429 不累计禁用计数：只给该 key 一个短冷却，让其他 key 顶上。
      k.disabledUntil = now + Math.max(1000, Math.floor(this.opts.cooldownMs / 6));
      return;
    }

    // transient：累计连续失败，达到阈值禁用 + 指数退避冷却。
    k.failCount += 1;
    if (k.failCount >= this.opts.failThreshold) {
      const backoff = this.opts.cooldownMs * 2 ** Math.min(k.failCount - this.opts.failThreshold, 4);
      // 加 ±20% 抖动，避免整池冷却同时到期后 thundering herd。
      const jittered = Math.floor(backoff * (0.8 + Math.random() * 0.4));
      k.disabledUntil = now + jittered;
      k.failCount = 0;
    }
  }

  /** 显式恢复一个 key（测试/运维用）。 */
  reset(key: string): void {
    const k = this.keys.find((p) => p.key === key);
    if (!k) return;
    k.disabledUntil = 0;
    k.failCount = 0;
    k.lastFailAt = -1;
  }
}
