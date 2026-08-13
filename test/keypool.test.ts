import { describe, expect, it } from 'vitest';
import { KeyPool, PoolEmptyError, keyFingerprint } from '../src/keypool.js';
import { classifyUpstreamFailure } from '../src/errors.js';

/** 可控时间源，避免测试依赖真实时钟。 */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const OPTS = { cooldownMs: 60_000, failThreshold: 3 };

describe('keyFingerprint', () => {
  it('只暴露末 4 位，不泄露原文', () => {
    expect(keyFingerprint('sk-abcdefghijklmnop')).toBe('****mnop');
    expect(keyFingerprint('abc')).toBe('****');
  });
});

describe('KeyPool 构造', () => {
  it('去空去重', () => {
    const pool = new KeyPool(['a', ' a ', '', '  ', 'b'], OPTS);
    expect(pool.size).toBe(2);
    expect(pool.healthyCount).toBe(2);
  });

  it('空池 acquire 抛 PoolEmptyError', () => {
    const pool = new KeyPool([], OPTS);
    expect(pool.size).toBe(0);
    expect(() => pool.acquire()).toThrow(PoolEmptyError);
  });
});

describe('KeyPool least-loaded 分流', () => {
  it('并发全 0 时按 lastUsedAt 最旧优先轮转', () => {
    const clock = fakeClock();
    const pool = new KeyPool(['a', 'b', 'c'], { ...OPTS, now: clock.now });
    // 每次 acquire 后立刻 release，inFlight 归零，应轮转而非固定选同一个。
    const picked: string[] = [];
    for (let i = 0; i < 6; i++) {
      const k = pool.acquire();
      picked.push(k);
      pool.release(k);
      clock.advance(10);
    }
    expect(new Set(picked).size).toBe(3);
    // 轮转应均匀：6 次分给 3 个 key，各 2 次。
    for (const k of ['a', 'b', 'c']) {
      expect(picked.filter((p) => p === k)).toHaveLength(2);
    }
  });

  it('优先选 inFlight 最少的 key', () => {
    const pool = new KeyPool(['a', 'b'], OPTS);
    // 不 release：a 拿走后 inFlight=1，下一个应选 b。
    const first = pool.acquire();
    const second = pool.acquire();
    expect(first).not.toBe(second);
    // 两者都 inFlight=1，第三次回到并列最闲，仍能拿到 key。
    expect(['a', 'b']).toContain(pool.acquire());
  });

  it('release 幂等，不会把 inFlight 压成负数', () => {
    const pool = new KeyPool(['a'], OPTS);
    const k = pool.acquire();
    pool.release(k);
    pool.release(k);
    pool.release(k);
    // 仍可正常 acquire。
    expect(pool.acquire()).toBe('a');
  });
});

describe('KeyPool acquire(excludeKey)（换 key 重试防撞同一把坏 key）', () => {
  it('被排除的 key 不被选中', () => {
    const pool = new KeyPool(['a', 'b', 'c'], OPTS);
    expect(pool.acquire('b')).not.toBe('b');
    expect(pool.acquire('a')).not.toBe('a');
    expect(pool.acquire('c')).not.toBe('c');
  });

  it('exclude 后只剩一个健康 key 时选中它', () => {
    const pool = new KeyPool(['a', 'b'], OPTS);
    expect(pool.acquire('a')).toBe('b');
  });

  it('exclude 后无可用 key 抛 PoolEmptyError（换 key 重试不白撞坏 key）', () => {
    const pool = new KeyPool(['a'], OPTS);
    expect(() => pool.acquire('a')).toThrow(PoolEmptyError);
  });

  it('并发下 exclude 不破坏 least-loaded 语义：排除最闲的 key 时选次闲', () => {
    const pool = new KeyPool(['a', 'b'], OPTS);
    const first = pool.acquire(); // inFlight 1
    // a 在飞、b 空闲；排除 a 后应选 b，而不是把 a 再抓回来。
    expect(pool.acquire('a')).toBe('b');
    pool.release(first);
  });

  it('exclude 不影响后续正常 acquire', () => {
    const pool = new KeyPool(['a', 'b'], OPTS);
    pool.acquire('a');
    expect(pool.acquire()).not.toBe('b'); // 轮转语义仍生效
  });
});

describe('KeyPool 失败分级与禁用', () => {
  it('auth 失败立即禁用，冷却 12 倍', () => {
    const clock = fakeClock();
    const pool = new KeyPool(['a', 'b'], { ...OPTS, now: clock.now });
    pool.markFailure('a', 'auth');
    expect(pool.healthyCount).toBe(1);
    // 未到 12 倍冷却仍禁用。
    clock.advance(OPTS.cooldownMs * 12 - 1);
    expect(pool.healthyCount).toBe(1);
    // 到期自动恢复。
    clock.advance(2);
    expect(pool.healthyCount).toBe(2);
  });

  it('rate-limit 只短冷却，不累计阈值', () => {
    const clock = fakeClock();
    const pool = new KeyPool(['a', 'b'], { ...OPTS, now: clock.now });
    // 连续多次 429 也不该永久禁用，只是短冷却。
    for (let i = 0; i < 10; i++) pool.markFailure('a', 'rate-limit');
    expect(pool.healthyCount).toBe(1);
    // 短冷却上限 3s：429 是账号级状态，冷却太长会把小池打光导致整池 503。
    clock.advance(3001);
    expect(pool.healthyCount).toBe(2);
  });

  it('回归：连续 429 不会让小池长时间整体 503', () => {
    const clock = fakeClock();
    // 线上就是 2 个 key + cooldownMs=300s 的组合，曾导致 2 次 429 打光整池 50 秒。
    const pool = new KeyPool(['a', 'b'], { cooldownMs: 300_000, failThreshold: 5, now: clock.now });
    for (const k of ['a', 'b']) pool.markFailure(k, 'rate-limit');
    expect(pool.healthyCount).toBe(0);
    // 3 秒后必须恢复，而不是 50 秒。
    clock.advance(3001);
    expect(pool.healthyCount).toBe(2);
  });

  it('transient 达到阈值才禁用', () => {
    const clock = fakeClock();
    const pool = new KeyPool(['a', 'b'], { ...OPTS, now: clock.now });
    pool.markFailure('a', 'transient');
    pool.markFailure('a', 'transient');
    // 未达 failThreshold=3，仍健康。
    expect(pool.healthyCount).toBe(2);
    pool.markFailure('a', 'transient');
    expect(pool.healthyCount).toBe(1);
  });

  it('markSuccess 清零连续失败计数', () => {
    const pool = new KeyPool(['a', 'b'], OPTS);
    pool.markFailure('a', 'transient');
    pool.markFailure('a', 'transient');
    pool.markSuccess('a');
    // 计数已清零，再失败 2 次不该触发禁用。
    pool.markFailure('a', 'transient');
    pool.markFailure('a', 'transient');
    expect(pool.healthyCount).toBe(2);
  });

  it('距上次失败超冷却期视为新一轮，计数清零', () => {
    const clock = fakeClock();
    const pool = new KeyPool(['a', 'b'], { ...OPTS, now: clock.now });
    pool.markFailure('a', 'transient');
    pool.markFailure('a', 'transient');
    // 隔了超过 cooldownMs，滑动窗口重置。
    clock.advance(OPTS.cooldownMs + 1);
    pool.markFailure('a', 'transient');
    expect(pool.healthyCount).toBe(2);
  });

  it('全部禁用后 acquire 抛 PoolEmptyError', () => {
    const pool = new KeyPool(['a', 'b'], OPTS);
    pool.markFailure('a', 'auth');
    pool.markFailure('b', 'auth');
    expect(pool.healthyCount).toBe(0);
    expect(() => pool.acquire()).toThrow(PoolEmptyError);
  });

  it('reset 显式恢复', () => {
    const pool = new KeyPool(['a'], OPTS);
    pool.markFailure('a', 'auth');
    expect(pool.healthyCount).toBe(0);
    pool.reset('a');
    expect(pool.healthyCount).toBe(1);
  });

  it('disabledFingerprints 只给指纹不给原文', () => {
    const pool = new KeyPool(['sk-secret-tail1234'], OPTS);
    pool.markFailure('sk-secret-tail1234', 'auth');
    const fps = pool.disabledFingerprints();
    expect(fps).toEqual(['****1234']);
    expect(fps.join()).not.toContain('secret');
  });

  it('未知 key 的上报被安全忽略', () => {
    const pool = new KeyPool(['a'], OPTS);
    expect(() => pool.markFailure('nonexistent', 'auth')).not.toThrow();
    expect(() => pool.markSuccess('nonexistent')).not.toThrow();
    expect(() => pool.release('nonexistent')).not.toThrow();
    expect(pool.healthyCount).toBe(1);
  });
});

describe('KeyPool.quotaEmptyError（池空透传 GoUsageLimitError）', () => {
  const QUOTA_BODY = { error: { type: 'GoUsageLimitError', message: 'Weekly usage limit reached. Resets in 3 days.' } };

  it('整池额度耗尽：返回记过的上游错误（status + body）', () => {
    const clock = fakeClock();
    const pool = new KeyPool(['a', 'b'], { ...OPTS, now: clock.now });
    pool.markFailure('a', 'quota-exhausted', 3 * 86_400_000);
    pool.noteQuotaError(429, QUOTA_BODY);
    pool.markFailure('b', 'quota-exhausted', 3 * 86_400_000);
    pool.noteQuotaError(429, QUOTA_BODY);

    expect(pool.healthyCount).toBe(0);
    expect(pool.quotaEmptyError).toEqual({ status: 429, body: QUOTA_BODY });
  });

  it('禁用原因混着非额度（auth/transient）→ 不伪装成额度问题，返回 null', () => {
    const clock = fakeClock();
    const pool = new KeyPool(['a', 'b'], { ...OPTS, now: clock.now });
    pool.markFailure('a', 'quota-exhausted', 3 * 86_400_000);
    pool.noteQuotaError(429, QUOTA_BODY);
    pool.markFailure('b', 'auth'); // 混入凭据失效禁用

    expect(pool.healthyCount).toBe(0);
    expect(pool.quotaEmptyError).toBeNull();
  });

  it('池里还有健康 key / 从未记过额度错误 → null（回通用 503）', () => {
    const clock = fakeClock();
    const pool = new KeyPool(['a', 'b'], { ...OPTS, now: clock.now });
    // 没记过额度错误
    expect(pool.quotaEmptyError).toBeNull();
    // 记过但池没空
    pool.noteQuotaError(429, QUOTA_BODY);
    pool.markFailure('a', 'quota-exhausted', 3 * 86_400_000);
    expect(pool.quotaEmptyError).toBeNull();
  });
});

describe('KeyPool 状态变更回调（禁用/恢复可观测性）', () => {
  const events: string[] = [];

  function makePool(rawKeys: string[], extra: Partial<ConstructorParameters<typeof KeyPool>[1]> = {}) {
    events.length = 0;
    return new KeyPool(rawKeys, {
      ...OPTS,
      now: clock.now,
      onStateChange: (e) => events.push(JSON.stringify(e)),
      ...extra,
    });
  }

  // 与 fakeClock 同款的可控时钟，供本 describe 使用。
  const clock = fakeClock();

  it('禁用上报：auth 带指纹/原因/冷却/池健康度', () => {
    const pool = makePool(['a', 'b']);
    pool.markFailure('a', 'auth');
    expect(events).toHaveLength(1);
    const ev = JSON.parse(events[0]!) as { type: string; fingerprint: string; kind: string; cooldownMs: number; healthyCount: number; poolSize: number };
    expect(ev.type).toBe('disabled');
    // 单字符 key 长度 ≤4，keyFingerprint 整体打码，不暴露原文。
    expect(ev.fingerprint).toBe('****');
    expect(ev.kind).toBe('auth');
    expect(ev.cooldownMs).toBe(OPTS.cooldownMs * 12);
    expect(ev.healthyCount).toBe(1);
    expect(ev.poolSize).toBe(2);
  });

  it('禁用上报：transient 达到阈值也上报，且不泄露原文', () => {
    const pool = makePool(['sk-secret-tail1234', 'b']);
    pool.markFailure('sk-secret-tail1234', 'transient');
    pool.markFailure('sk-secret-tail1234', 'transient');
    pool.markFailure('sk-secret-tail1234', 'transient');
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('****1234');
    expect(events[0]).not.toContain('secret');
  });

  it('禁用上报：quota-exhausted 带真实重置冷却', () => {
    const pool = makePool(['a']);
    pool.markFailure('a', 'quota-exhausted', 19 * 3_600_000);
    const ev = JSON.parse(events[0]!) as { cooldownMs: number };
    expect(ev.cooldownMs).toBe(19 * 3_600_000 + 60_000);
  });

  it('恢复上报：冷却到期 + acquire 时只报一次', () => {
    const pool = makePool(['a']);
    pool.markFailure('a', 'auth');
    expect(events).toHaveLength(1); // 只报了禁用
    clock.advance(OPTS.cooldownMs * 12);
    pool.acquire();
    expect(events).toHaveLength(2);
    const ev = JSON.parse(events[1]!) as { type: string; fingerprint: string; healthyCount: number };
    expect(ev.type).toBe('recovered');
    expect(ev.fingerprint).toBe('****');
    expect(ev.healthyCount).toBe(1);
    // 二次 acquire 不再重复报恢复
    pool.release('a');
    pool.acquire();
    expect(events).toHaveLength(2);
  });

  it('reset 显式恢复不触发 recovered 事件（绕过冷却，非自然到期）', () => {
    const pool = makePool(['a']);
    pool.markFailure('a', 'auth');
    pool.reset('a');
    expect(events).toHaveLength(1); // 只有禁用
  });

  it('未配置回调时所有上报静默（兼容旧行为）', () => {
    const pool = new KeyPool(['a'], { ...OPTS, now: clock.now });
    expect(() => {
      pool.markFailure('a', 'auth');
      pool.markFailure('a', 'rate-limit');
    }).not.toThrow();
    expect(pool.healthyCount).toBe(0);
  });
});

describe('classifyUpstreamFailure', () => {
  it('429 → rate-limit', () => {
    expect(classifyUpstreamFailure(429, null)).toBe('rate-limit');
  });

  it('401 + authentication_error → auth', () => {
    expect(classifyUpstreamFailure(401, { error: { type: 'authentication_error' } })).toBe('auth');
  });

  it('401 但非 authentication_error → rate-limit（不长期禁用）', () => {
    expect(classifyUpstreamFailure(401, { error: { type: 'something_else' } })).toBe('rate-limit');
  });

  it('余额不足类错误 → rate-limit，不按 auth 长期禁用', () => {
    // 余额不足是「充值即恢复」的账户状态，短冷却即可。
    for (const type of ['billing_error', 'CreditsError', 'insufficient_balance']) {
      expect(classifyUpstreamFailure(400, { error: { type } })).toBe('rate-limit');
    }
  });

  it('配额/额度耗尽类错误 → quota-exhausted，按重置时间长冷却', () => {
    // 与余额不足不同：配额按周/月重置，短冷却只会让请求反复撞同一个已耗尽的 key。
    for (const type of ['quota_exceeded', 'GoUsageLimitError']) {
      expect(classifyUpstreamFailure(400, { error: { type } })).toBe('quota-exhausted');
    }
    // 实测的真实上游形态
    expect(
      classifyUpstreamFailure(429, {
        type: 'GoUsageLimitError',
        message: 'Weekly usage limit reached. Resets in 19hr 22min.',
      }),
    ).toBe('quota-exhausted');
  });

  it('普通并发 429 仍是 rate-limit（短冷却，快速回池）', () => {
    expect(
      classifyUpstreamFailure(429, { error: { type: 'rate_limit_error', message: 'too many requests' } }),
    ).toBe('rate-limit');
  });

  it('回归：含 quota 字样但非额度的错误，不按 quota-exhausted 长冷却', () => {
    // CURRENT.md 曾怀疑「quota 字样误判成额度耗尽 → 1h 长冷却」。
    // 代码里从未有此路径（quota 判定是严格匹配）；这里把常见误判形态固化成测试，
    // 防止未来误伤。
    expect(classifyUpstreamFailure(400, { error: { type: 'invalid_quota_configuration' } })).toBe('transient');
    expect(classifyUpstreamFailure(400, { error: { type: 'quota_check_failed' } })).toBe('transient');
  });

  it('quota_reached / quota_exceeded 形态是额度耗尽', () => {
    for (const type of ['quota_exceeded', 'quota_reached']) {
      expect(classifyUpstreamFailure(400, { error: { type } })).toBe('quota-exhausted');
    }
  });

  it('5xx / 非 JSON → transient', () => {
    expect(classifyUpstreamFailure(500, null)).toBe('transient');
    expect(classifyUpstreamFailure(502, 'html')).toBe('transient');
  });
});

describe('多 key 公平分担（RPM 均摊）', () => {
  it('串行请求在 N 个 key 上精确等分', () => {
    // 回归：原来用 lastUsedAt（毫秒）做轮转依据，串行请求同毫秒完成时时间戳
    // 相同、`<` 不成立，永远选数组第一个 —— 实测 3 key 12 请求分布 10/1/1。
    for (const n of [2, 3, 5]) {
      const keys = Array.from({ length: n }, (_, i) => `k${i + 1}`);
      const pool = new KeyPool(keys, { ...OPTS });
      const counts = new Map<string, number>();
      for (let i = 0; i < n * 4; i++) {
        const k = pool.acquire();
        counts.set(k, (counts.get(k) ?? 0) + 1);
        pool.release(k);
      }
      expect(counts.size).toBe(n);
      for (const c of counts.values()) expect(c).toBe(4);
    }
  });

  it('并发请求优先选最闲的 key', () => {
    const pool = new KeyPool(['a', 'b', 'c'], { ...OPTS });
    // 不释放：a/b/c 各占 1 个并发
    const held = [pool.acquire(), pool.acquire(), pool.acquire()];
    expect(new Set(held).size).toBe(3);
    // 释放 b 后，下一个必须选 b（inFlight 最低）
    pool.release(held[1]!);
    expect(pool.acquire()).toBe(held[1]);
  });

  it('某个 key 被禁用后，流量只在剩余 key 间均分', () => {
    const clock = fakeClock();
    const pool = new KeyPool(['a', 'b', 'c'], { ...OPTS, now: clock.now });
    pool.markFailure('b', 'auth');
    const counts = new Map<string, number>();
    for (let i = 0; i < 8; i++) {
      const k = pool.acquire();
      counts.set(k, (counts.get(k) ?? 0) + 1);
      pool.release(k);
    }
    expect(counts.get('b')).toBeUndefined();
    expect(counts.get('a')).toBe(4);
    expect(counts.get('c')).toBe(4);
  });

  it('额度耗尽的 key 按重置时间长冷却，不反复回池撞墙', () => {
    const clock = fakeClock();
    const pool = new KeyPool(['a', 'b'], { ...OPTS, now: clock.now });
    // 上游实测形态：Resets in 19hr 22min → 应冷却约 19 小时，而非 3 秒
    pool.markFailure('a', 'quota-exhausted', 19 * 3_600_000);
    expect(pool.healthyCount).toBe(1);
    clock.advance(3_600_000); // 1 小时后仍不该恢复
    expect(pool.healthyCount).toBe(1);
    clock.advance(19 * 3_600_000); // 过了重置点才恢复
    expect(pool.healthyCount).toBe(2);
    // 冷却期内所有流量都走 b
    expect(pool.acquire()).toBeTruthy();
  });
});

/**
 * `snapshot()` 是面板的数据源。这组测试的存在理由：2026-08-10 用户问「有个 key
 * 是不是用完了」，回答这个问题要去 journalctl 翻 `[keypool] disabled` 行、再读
 * 源码算冷却公式、再在服务器上手算恢复时刻 —— 而这些信息本来就在内存里。
 * 所以这里逐字段坐实「面板能直接显示，不需要任何推算」。
 */
describe('KeyPool.snapshot（面板可观测面）', () => {
  it('健康池：字段齐全、不含 key 原文', () => {
    const pool = new KeyPool(['sk-secret-tail0osU', 'sk-other-tailZOBb'], OPTS);
    const snap = pool.snapshot();
    expect(snap).toHaveLength(2);
    // 顺序与配置顺序一致，方便对号
    expect(snap.map((s) => s.fingerprint)).toEqual(['****0osU', '****ZOBb']);
    // 绝不泄露原文
    expect(JSON.stringify(snap)).not.toContain('secret');
    expect(JSON.stringify(snap)).not.toContain('sk-');
    for (const s of snap) {
      expect(s.healthy).toBe(true);
      expect(s.inFlight).toBe(0);
      expect(s.failCount).toBe(0);
      expect(s.disabledReason).toBeUndefined();
      expect(s.disabledUntil).toBe(0);
      expect(s.recoverInMs).toBe(0);
      expect(s.totalAcquired).toBe(0);
    }
  });

  it('inFlight 反映当前并发 —— 回答「几个号在扛分流」', () => {
    // key 长于 4 位，否则两个指纹都是 `****`（见下一个用例的说明）。
    const pool = new KeyPool(['sk-key-aaaa', 'sk-key-bbbb'], OPTS);
    const k1 = pool.acquire();
    const k2 = pool.acquire();
    const k3 = pool.acquire(); // 第三个请求回到最闲的那个
    const snap = pool.snapshot();
    expect(snap).toHaveLength(2);
    // 两个 key 各承载并发，总和等于活跃请求数
    expect(snap.reduce((n, s) => n + s.inFlight, 0)).toBe(3);
    // 分流均匀：3 个并发落在 2 个 key 上，没有一个 key 独吞
    expect(snap.every((s) => s.inFlight >= 1)).toBe(true);
    // 每个 key 的 totalAcquired 累计
    expect(snap.reduce((n, s) => n + s.totalAcquired, 0)).toBe(3);
    pool.release(k1);
    pool.release(k2);
    pool.release(k3);
    expect(pool.snapshot().reduce((n, s) => n + s.inFlight, 0)).toBe(0);
    // release 不该回退累计次数
    expect(pool.snapshot().reduce((n, s) => n + s.totalAcquired, 0)).toBe(3);
  });

  it('额度耗尽：带原因 + 恢复时刻 + 剩余毫秒（面板无需推算）', () => {
    const clock = fakeClock();
    const pool = new KeyPool(['a', 'b'], { ...OPTS, now: clock.now });
    // 复刻线上实况：上游给 22620s 重置时间，keypool 加 60s 余量 = 22680s
    pool.markFailure('a', 'quota-exhausted', 22_620_000);
    const s = pool.snapshot().find((x) => !x.healthy)!;
    expect(s.disabledReason).toBe('quota-exhausted');
    expect(s.recoverInMs).toBe(22_680_000);
    expect(s.disabledUntil).toBe(clock.now() + 22_680_000);

    // 时间推进后剩余递减，绝对时刻不变（面板可本地倒计时）
    const until = s.disabledUntil;
    clock.advance(680_000);
    const s2 = pool.snapshot().find((x) => !x.healthy)!;
    expect(s2.recoverInMs).toBe(22_000_000);
    expect(s2.disabledUntil).toBe(until);
  });

  it('各类禁用原因都记下来，恢复后清空', () => {
    const clock = fakeClock();
    // ⚠️ key 必须长于 4 位：keyFingerprint 对 <=4 位统一返回 `****`，
    // 用 'a'/'b'/'c' 会让三个 key 指纹全相同、按指纹建 Map 直接互相覆盖。
    const [ka, kb, kc] = ['sk-key-aaaa', 'sk-key-bbbb', 'sk-key-cccc'];
    const pool = new KeyPool([ka!, kb!, kc!], { ...OPTS, now: clock.now });
    pool.markFailure(ka!, 'auth');
    pool.markFailure(kb!, 'rate-limit');
    for (let i = 0; i < 3; i++) pool.markFailure(kc!, 'transient'); // 达阈值才禁

    const reasons = new Map(pool.snapshot().map((s) => [s.fingerprint, s.disabledReason]));
    expect(reasons.get(keyFingerprint(ka!))).toBe('auth');
    expect(reasons.get(keyFingerprint(kb!))).toBe('rate-limit');
    expect(reasons.get(keyFingerprint(kc!))).toBe('transient');

    // 冷却全部到期 + acquire 触发 reapRecovered → 原因清空，不留「healthy 但带原因」
    clock.advance(OPTS.cooldownMs * 100);
    pool.acquire();
    for (const s of pool.snapshot()) {
      expect(s.healthy).toBe(true);
      expect(s.disabledReason).toBeUndefined();
      expect(s.disabledUntil).toBe(0);
    }
  });

  it('冷却自然到期但还没 acquire：不显示自相矛盾的 healthy+原因', () => {
    const clock = fakeClock();
    const pool = new KeyPool(['a'], { ...OPTS, now: clock.now });
    pool.markFailure('a', 'quota-exhausted', 1000);
    expect(pool.snapshot()[0]!.healthy).toBe(false);
    // 冷却过期，但没调 acquire（reapRecovered 未跑，内部 disabledUntil 仍是旧值）
    clock.advance(999_999);
    const s = pool.snapshot()[0]!;
    expect(s.healthy).toBe(true);
    expect(s.disabledReason).toBeUndefined();
    expect(s.disabledUntil).toBe(0);
    expect(s.recoverInMs).toBe(0);
  });

  it('reset 显式恢复也清掉原因', () => {
    const pool = new KeyPool(['a'], OPTS);
    pool.markFailure('a', 'auth');
    expect(pool.snapshot()[0]!.disabledReason).toBe('auth');
    pool.reset('a');
    expect(pool.snapshot()[0]!.disabledReason).toBeUndefined();
    expect(pool.snapshot()[0]!.healthy).toBe(true);
  });
});

describe('KeyPool.policy（面板要能解释「为什么恢复时刻是这个数」）', () => {
  const KEY = 'sk-key-aaaa';

  it('暴露基础冷却、失败阈值与选路算法', () => {
    const pool = new KeyPool([KEY], OPTS);
    const p = pool.policy();
    expect(p.cooldownMs).toBe(OPTS.cooldownMs);
    expect(p.failThreshold).toBe(OPTS.failThreshold);
    expect(p.strategy).toBe('least-loaded');
    expect(p.rules.map((r) => r.kind).sort()).toEqual(
      ['auth', 'quota-exhausted', 'rate-limit', 'transient'],
    );
  });

  it('跟着配置变，不是写死的常量', () => {
    const p = new KeyPool([KEY], { cooldownMs: 10_000, failThreshold: 7 }).policy();
    expect(p.cooldownMs).toBe(10_000);
    expect(p.failThreshold).toBe(7);
    expect(p.rules.find((r) => r.kind === 'auth')!.ms).toBe(120_000);
  });

  /**
   * 最重要的一条：策略描述必须与 markFailure 的**实际行为**一致。
   * 面板显示错的规则比不显示更糟 —— 会把排查引向错误方向。
   */
  it('auth 的声明时长 = 实际冷却时长', () => {
    const clock = fakeClock();
    const pool = new KeyPool([KEY], { ...OPTS, now: clock.now });
    const declared = pool.policy().rules.find((r) => r.kind === 'auth')!.ms;
    pool.markFailure(KEY, 'auth');
    expect(pool.snapshot()[0]!.recoverInMs).toBe(declared);
  });

  it('rate-limit 的声明时长 = 实际冷却时长', () => {
    const clock = fakeClock();
    const pool = new KeyPool([KEY], { ...OPTS, now: clock.now });
    const declared = pool.policy().rules.find((r) => r.kind === 'rate-limit')!.ms;
    pool.markFailure(KEY, 'rate-limit');
    expect(pool.snapshot()[0]!.recoverInMs).toBe(declared);
  });

  it('transient 声明「累计到阈值才禁用」，行为确实如此', () => {
    const clock = fakeClock();
    const pool = new KeyPool([KEY], { ...OPTS, now: clock.now });
    const rule = pool.policy().rules.find((r) => r.kind === 'transient')!;
    expect(rule.countsToThreshold).toBe(true);
    // 差一次不该被禁用。
    for (let i = 0; i < OPTS.failThreshold - 1; i++) pool.markFailure(KEY, 'transient');
    expect(pool.snapshot()[0]!.healthy).toBe(true);
    pool.markFailure(KEY, 'transient');
    expect(pool.snapshot()[0]!.healthy).toBe(false);
    // 首次触发的退避基数就是声明的 ms（抖动 ±20%）。
    const actual = pool.snapshot()[0]!.recoverInMs;
    expect(actual).toBeGreaterThanOrEqual(Math.floor(rule.ms! * 0.8));
    expect(actual).toBeLessThanOrEqual(Math.ceil(rule.ms! * 1.2));
  });

  it('quota-exhausted 声明「时长由上游决定」+ 兜底值，行为确实如此', () => {
    const clock = fakeClock();
    const pool = new KeyPool([KEY], { ...OPTS, now: clock.now });
    const rule = pool.policy().rules.find((r) => r.kind === 'quota-exhausted')!;
    expect(rule.ms).toBeNull();
    expect(rule.fallbackMs).toBe(3_600_000);

    // 解析不出重置时间 -> 用兜底值。
    pool.markFailure(KEY, 'quota-exhausted');
    expect(pool.snapshot()[0]!.recoverInMs).toBe(rule.fallbackMs);

    // 给了重置时间 -> 上游时间 + 60s 余量。
    const p2 = new KeyPool([KEY], { ...OPTS, now: clock.now });
    p2.markFailure(KEY, 'quota-exhausted', 6 * 3_600_000);
    expect(p2.snapshot()[0]!.recoverInMs).toBe(6 * 3_600_000 + 60_000);
  });

  it('声明的「首次即禁用」与实际一致（auth / rate-limit / quota 都不需累计）', () => {
    for (const kind of ['auth', 'rate-limit', 'quota-exhausted'] as const) {
      const clock = fakeClock();
      const pool = new KeyPool([KEY], { ...OPTS, now: clock.now });
      expect(pool.policy().rules.find((r) => r.kind === kind)!.countsToThreshold).toBe(false);
      pool.markFailure(KEY, kind);
      expect(pool.snapshot()[0]!.healthy, `${kind} 应首次即禁用`).toBe(false);
    }
  });
});

describe('markFailure 只延长冷却，不缩短（迟到的失败上报不能冲掉长冷却）', () => {
  const KEY = 'sk-key-aaaa';

  it('额度耗尽后收到迟到的 transient：19h 冷却不被 4 分钟冲掉，原因也不改', () => {
    const clock = fakeClock();
    const pool = new KeyPool([KEY], { ...OPTS, now: clock.now });
    // 19 小时的周额度冷却（上游给的重置时间 + 60s 余量）。
    pool.markFailure(KEY, 'quota-exhausted', 19 * 3_600_000);
    const long = pool.snapshot()[0]!.recoverInMs;
    expect(long).toBeGreaterThan(18 * 3_600_000);

    // 同一 key 上早于禁用就已 acquire 的流中途断掉，连续上报 transient 直到达阈值。
    for (let i = 0; i < OPTS.failThreshold; i++) pool.markFailure(KEY, 'transient');

    const s = pool.snapshot()[0]!;
    expect(s.disabledReason).toBe('quota-exhausted');
    expect(s.recoverInMs).toBe(long);
  });

  it('额度耗尽后收到迟到的裸 429：不被 3 秒冲掉', () => {
    const clock = fakeClock();
    const pool = new KeyPool([KEY], { ...OPTS, now: clock.now });
    pool.markFailure(KEY, 'quota-exhausted', 19 * 3_600_000);
    const long = pool.snapshot()[0]!.recoverInMs;

    pool.markFailure(KEY, 'rate-limit');

    const s = pool.snapshot()[0]!;
    expect(s.disabledReason).toBe('quota-exhausted');
    expect(s.recoverInMs).toBe(long);
  });

  it('auth 长冷却不被 rate-limit 短冷却冲掉', () => {
    const clock = fakeClock();
    const pool = new KeyPool([KEY], { ...OPTS, now: clock.now });
    pool.markFailure(KEY, 'auth');
    const long = pool.snapshot()[0]!.recoverInMs;
    expect(long).toBe(OPTS.cooldownMs * 12);

    pool.markFailure(KEY, 'rate-limit');
    expect(pool.snapshot()[0]!.recoverInMs).toBe(long);
    expect(pool.snapshot()[0]!.disabledReason).toBe('auth');
  });

  it('但更长的冷却仍然能延长（rate-limit 之后来了额度耗尽）', () => {
    const clock = fakeClock();
    const pool = new KeyPool([KEY], { ...OPTS, now: clock.now });
    pool.markFailure(KEY, 'rate-limit');
    expect(pool.snapshot()[0]!.recoverInMs).toBeLessThanOrEqual(3000);

    pool.markFailure(KEY, 'quota-exhausted', 6 * 3_600_000);
    const s = pool.snapshot()[0]!;
    expect(s.disabledReason).toBe('quota-exhausted');
    expect(s.recoverInMs).toBeGreaterThan(5 * 3_600_000);
  });

  it('冷却自然到期后可以重新按新原因禁用（不会被旧冷却永久挡住）', () => {
    const clock = fakeClock();
    const pool = new KeyPool([KEY], { ...OPTS, now: clock.now });
    pool.markFailure(KEY, 'quota-exhausted', 1000);
    clock.advance(999_999);
    expect(pool.snapshot()[0]!.healthy).toBe(true);

    pool.markFailure(KEY, 'auth');
    const s = pool.snapshot()[0]!;
    expect(s.healthy).toBe(false);
    expect(s.disabledReason).toBe('auth');
  });
});

describe('KeyPool 账户归属（多账号面板）', () => {
  it('构造带 accountIds 映射：snapshot 逐 key 带 accountId', () => {
    const ids = new Map([['sk-aaa-1', 1], ['sk-bbb-2', 2]]);
    const pool = new KeyPool(['sk-aaa-1', 'sk-bbb-2', 'sk-ccc-9'], OPTS, ids);
    const snap = pool.snapshot();
    expect(snap.map((s) => s.accountId)).toEqual([1, 2, 0]);
    // accountIdOf 与 snapshot 同一真源。
    expect(pool.accountIdOf('sk-aaa-1')).toBe(1);
    expect(pool.accountIdOf('sk-bbb-2')).toBe(2);
    expect(pool.accountIdOf('sk-ccc-9')).toBe(0);
    expect(pool.accountIdOf('nonexistent')).toBe(0);
  });

  it('不带 accountIds 时全部归 0（env keys 兜底，旧调用点兼容）', () => {
    const pool = new KeyPool(['sk-aaa-1', 'sk-bbb-2'], OPTS);
    expect(pool.snapshot().every((s) => s.accountId === 0)).toBe(true);
  });

  it('重复 key 去重后 accountId 取第一个命中', () => {
    const pool = new KeyPool(['sk-dup', ' sk-dup '], OPTS, new Map([['sk-dup', 7]]));
    expect(pool.size).toBe(1);
    expect(pool.accountIdOf('sk-dup')).toBe(7);
  });

  it('addKey 热加载：新 key 立即可用且带账户归属', () => {
    const pool = new KeyPool(['sk-aaa-1'], OPTS);
    expect(pool.addKey('sk-new-2', 3)).toBe(true);
    expect(pool.size).toBe(2);
    expect(pool.accountIdOf('sk-new-2')).toBe(3);
    // 新 key lastUsedAt=0 → 下一轮探针会自动探它（staleKeys 语义）。
    expect(pool.staleKeys(3_600_000).some((s) => s.key === 'sk-new-2')).toBe(true);
  });

  it('addKey 去重：同名返回 false，不改原有归属', () => {
    const pool = new KeyPool(['sk-aaa-1'], OPTS, new Map([['sk-aaa-1', 1]]));
    expect(pool.addKey('sk-aaa-1', 9)).toBe(false);
    expect(pool.addKey(' sk-aaa-1 ', 9)).toBe(false);
    expect(pool.addKey('   ', 9)).toBe(false);
    expect(pool.size).toBe(1);
    expect(pool.accountIdOf('sk-aaa-1')).toBe(1);
  });

  it('removeKey：删除成功返回 true，未知 key 返回 false', () => {
    const pool = new KeyPool(['sk-aaa-1', 'sk-bbb-2'], OPTS);
    expect(pool.removeKey('sk-aaa-1')).toBe(true);
    expect(pool.size).toBe(1);
    expect(pool.accountIdOf('sk-aaa-1')).toBe(0);
    expect(pool.removeKey('sk-aaa-1')).toBe(false);
    expect(pool.removeKey('nonexistent')).toBe(false);
  });

  it('removeKey 后在飞请求的 release/markFailure/markSuccess 不崩', () => {
    const pool = new KeyPool(['sk-aaa-1', 'sk-bbb-2'], OPTS);
    const held = pool.acquire(); // 拿到 sk-aaa-1（顺序第一个）
    pool.removeKey(held);
    // 在飞请求结束时上报全部安全忽略，其余 key 不受影响。
    expect(() => {
      pool.release(held);
      pool.markFailure(held, 'auth');
      pool.markSuccess(held);
    }).not.toThrow();
    expect(pool.size).toBe(1);
    expect(pool.healthyCount).toBe(1);
    // 剩余 key 正常工作。
    expect(pool.acquire()).toBe('sk-bbb-2');
  });
});
