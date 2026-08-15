/**
 * 每 key 的 RPM（每分钟请求数）限流器 —— 内存滑动窗口计数。
 *
 * 为什么存在：网关侧此前对分发 token 没有任何 per-key 请求频率限制
 * （上游 429 是账号级冷却，管不到单个分发 key 的滥用）。这里给每个分发
 * token 一个 60 秒窗口内的请求计数，超限回 429，保护上游额度。
 *
 * # 算法：60 个 1 秒桶的滑动窗口计数
 *
 * - 每个 key 一个 { counts: Int32Array(60), lastWrites: Int32Array(60) }，
 *   桶按 `second % 60` 索引（second = floor(now/1000)），精确到秒。
 * - 每次 check 先求和：对每个桶，若 `now.second - lastWrites[i] >= 60`
 *   说明该桶最后一次写入已滑出窗口，就地清零（惰性清理，桶不会无限堆积）。
 * - 计数 = 窗口内所有桶之和；`total >= limit` → 拒绝（拒绝的请求**也计数**，
 *   标准滑动窗口语义，否则攻击者靠连续拒绝请求永不占窗口）。
 * - 整表清理：每 CLEANUP_EVERY 次 check 顺手 `prune()` 一次，删掉 `lastSeen`
 *   超过一整窗未见的 key —— 防 Map 无限增长（长驻进程挂一年的内存泄漏）。
 *
 * # 并发安全
 *
 * Node 单线程事件循环，check() 全同步无 await，天然串行。唯一要防的
 * 异步间隙是把「先算后写」保持在同一同步块里 —— 本类没有任何 await，
 * 不会出现两个请求读到同一个中间态。
 *
 * # 精度取舍
 *
 * 秒级桶 = 近似滑动窗口（60s 内按秒离散）。对 RPM 场景足够精确，且
 * 内存 O(60)/key、与请求速率无关 —— 换成「精确时间戳列表」会随
 * 高频被拒请求无限膨胀。
 */

/** 窗口长度：60 秒。 */
export const WINDOW_MS = 60_000;
/** 桶粒度：1 秒。 */
const BUCKET_MS = 1_000;
/** 桶数 = 窗口长度 / 桶粒度。 */
const BUCKETS = WINDOW_MS / BUCKET_MS;
/** 每多少次 check 顺手整表清理一次（防 Map 无限增长）。 */
const CLEANUP_EVERY = 256;

/** 单 key 的窗口状态。 */
interface RpmWindow {
  /** 每秒计数桶，index = second % 60。 */
  counts: Int32Array;
  /** 每个桶最近一次写入的绝对秒（用于判断该桶是否已滑出窗口）。 */
  lastWrites: Int32Array;
  /** 最近一次 check 的绝对秒（整表清理用）。 */
  lastSeen: number;
}

/** 一次 check 的判定结果。 */
export interface RpmVerdict {
  allowed: boolean;
  /**
   * 拒绝时的等待提示（毫秒，advisory）：最旧一个仍被计数的请求滑出窗口的
   * 大致时长。客户端按它设 retry-after / 间隔重试；不保证一次性恢复
   * （窗口内请求密集时可能仍超限，再收一次 429）。
   */
  retryAfterMs: number;
}

export class RpmLimiter {
  private windows = new Map<string, RpmWindow>();
  private checks = 0;

  /** 当前跟踪的 key 数（测试/观测用）。 */
  size(): number {
    return this.windows.size;
  }

  /**
   * 判定一次请求是否允许。`limit <= 0` = 不限流（恒放行、不计数）。
   * `now` 可注入（测试）。允许与拒绝的请求都计入窗口。
   */
  check(key: string, limit: number, now: number = Date.now()): RpmVerdict {
    if (limit <= 0) return { allowed: true, retryAfterMs: 0 };
    const second = Math.floor(now / 1000);
    let w = this.windows.get(key);
    if (!w) {
      w = { counts: new Int32Array(BUCKETS), lastWrites: new Int32Array(BUCKETS), lastSeen: second };
      this.windows.set(key, w);
    }

    // 求和 + 惰性清理：滑出窗口的桶清零再计；活跃桶按写入秒记下（供 retry-after 计算）。
    let total = 0;
    const active: Array<{ lw: number; c: number }> = [];
    for (let i = 0; i < BUCKETS; i++) {
      const lw = w.lastWrites[i]!;
      if (second - lw >= BUCKETS) {
        w.counts[i] = 0;
        w.lastWrites[i] = 0;
      } else if (second - lw < BUCKETS) {
        // 窗口内活跃桶。用窗口判定而非 lw>0：lw=0 既可能是「从未写入」也
        // 可能是「second=0 时刻写入」（注入 now=0 的测试/时钟边界），
        // 后者计数有效，lw>0 守卫会漏计导致窗口破防。
        total += w.counts[i]!;
        active.push({ lw, c: w.counts[i]! });
      }
    }
    const denied = total >= limit;
    const slot = second % BUCKETS;
    w.counts[slot] = w.counts[slot]! + 1;
    w.lastWrites[slot] = second;
    w.lastSeen = second;

    if (denied) {
      // retry-after：从最旧桶起累减，找到「滑出后窗口降到 limit 以下」的那个桶。
      // 用「最旧桶滑出时刻」会让饱和窗口恒报 ~1s，客户端按 header 重试会把
      // 窗口重新钉满（每次重试也计数），永远等不到可放行信号。
      active.sort((a, b) => a.lw - b.lw);
      let remaining = total;
      let retryAfterMs = 0;
      for (const b of active) {
        remaining -= b.c;
        retryAfterMs = Math.max(0, WINDOW_MS - (now - b.lw * BUCKET_MS));
        if (remaining < limit) break;
      }
      return { allowed: false, retryAfterMs };
    }
    if (++this.checks % CLEANUP_EVERY === 0) this.prune(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  /**
   * 删除 `now` 之前一整窗未见的 key。惰性：只在 check 定期触发，不设常驻
   * 定时器（8GB 机器，避免 unref 定时器维护成本）。也可测试直接调用。
   */
  prune(now: number = Date.now()): void {
    const second = Math.floor(now / 1000);
    for (const [key, w] of this.windows) {
      if (second - w.lastSeen >= BUCKETS) this.windows.delete(key);
    }
  }
}

/**
 * 每 key 的 TPM（每分钟 token 消耗）限流器 —— 固定自然分钟窗口。
 *
 * 与 RpmLimiter 的差异：RPM 数请求，TPM 数 token（输入+输出+缓存读），
 * 对齐 new-api 的 TPM 概念（QUOTA 扩展）。窗口是「自然分钟」：
 * windowStart = floor(now/60000)*60000，跨分钟即归零 —— TPM 是软预算，
 * 分钟窗口语义足够，不需要 RPM 的秒级滑动窗精度。
 *
 * # 语义（TPM 预估取舍，主控任务：请求前检查已用，不做预扣/预估）
 *
 * - 数据面校验（verify）：`used >= limit` → 429。**不预估**本次请求会消耗
 *   多少 token —— 当前分钟已用超过上限就拒，未超就放行；放行后 settle 累加，
 *   过量就过量（窗口滚动即恢复）。不做「max_tokens + input 粗估」预扣：
 *   预扣要么低估（被流式长输出打穿）要么高估（误拒正常请求），而完成时
 *   累加真实用量零误差 —— 与 settle 配额同哲学（QUOTA.md §2 不做预扣）。
 * - settle：请求完成时 add 真实用量（input+output+cacheRead，与配额 tokens
 *   口径一致）。并发在飞的多个请求共享同一分钟窗口，先到先得，可能小幅
 *   超额 —— 与 RPM 429 的「拒绝也计数」不同，被 429 拒的请求**不消耗**
 *   TPM（check 只读不改窗口），窗口滚动后自动恢复。
 *
 * # 并发安全
 *
 * 同 RpmLimiter：全同步无 await，事件循环天然串行。
 *
 * # 清理
 *
 * 惰性：每 CLEANUP_EVERY 次 check 顺手 prune 掉已滑出窗口的 key（复用
 * RpmLimiter 的 CLEANUP_EVERY 节奏），防 Map 无限增长。
 */
export class TpmLimiter {
  private windows = new Map<string, { windowStart: number; used: number }>();
  private checks = 0;

  /** 当前跟踪的 key 数（测试/观测用）。 */
  size(): number {
    return this.windows.size;
  }

  /** 当前分钟已用 token（视图/校验共用）。窗口跨分钟自动归零。 */
  used(key: string, now: number = Date.now()): number {
    const w = this.windows.get(key);
    if (!w) return 0;
    if (now >= w.windowStart + WINDOW_MS) return 0;
    return w.used;
  }

  /**
   * 判定一次请求是否允许（请求前检查已用，不预扣）。`limit <= 0` = 不限流
   * （恒放行；check 不写窗口 —— 被拒请求不消耗 TPM）。`now` 可注入（测试）。
   */
  check(key: string, limit: number, now: number = Date.now()): { allowed: boolean; used: number } {
    const used = this.used(key, now);
    const allowed = limit <= 0 || used < limit;
    if (++this.checks % CLEANUP_EVERY === 0) this.prune(now);
    return { allowed, used };
  }

  /** 结算：累加本次用量到当前分钟窗口（跨分钟自动开新窗口）。 */
  add(key: string, tokens: number, now: number = Date.now()): void {
    if (tokens <= 0) return;
    const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const w = this.windows.get(key);
    if (!w || now >= w.windowStart + WINDOW_MS) {
      this.windows.set(key, { windowStart, used: tokens });
    } else {
      w.used += tokens;
    }
  }

  /** 删除 `now` 之前已滑出窗口的 key。惰性：只在 check 定期触发。 */
  prune(now: number = Date.now()): void {
    for (const [key, w] of this.windows) {
      if (now >= w.windowStart + WINDOW_MS) this.windows.delete(key);
    }
  }
}
