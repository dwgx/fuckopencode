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
    for (const type of ['billing_error', 'CreditsError', 'insufficient_balance', 'quota_exceeded']) {
      expect(classifyUpstreamFailure(400, { error: { type } })).toBe('rate-limit');
    }
  });

  it('5xx / 非 JSON → transient', () => {
    expect(classifyUpstreamFailure(500, null)).toBe('transient');
    expect(classifyUpstreamFailure(502, 'html')).toBe('transient');
  });
});
