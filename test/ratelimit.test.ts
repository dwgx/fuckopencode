/**
 * per-key RPM 限流器（src/ratelimit.ts）单测。
 *
 * 覆盖：limit<=0 不限流、窗口内计数、超限拒绝、窗口滑动（60s 边界）、
 * 跨秒边界、不同 key 独立、惰性清理（prune 整表 + 定期自动）。
 * 时间全部注入固定 now（秒级对齐），避免真实时钟抖动。
 */

import { describe, expect, it } from 'vitest';
import { RpmLimiter, TpmLimiter } from '../src/ratelimit.js';

/** 任意基准时刻（秒级对齐，秒索引 = T0/1000）。 */
const T0 = 1_700_000_000_000;

describe('RpmLimiter', () => {
  it('limit<=0 = 不限流：恒放行且不占窗口', () => {
    const l = new RpmLimiter();
    for (let i = 0; i < 100; i++) {
      expect(l.check('k', 0, T0 + i * 1000).allowed).toBe(true);
    }
    expect(l.size()).toBe(0);
  });

  it('limit=2：前 2 个放行，第 3 个拒绝，拒绝带 retryAfterMs', () => {
    const l = new RpmLimiter();
    expect(l.check('k', 2, T0).allowed).toBe(true);
    expect(l.check('k', 2, T0 + 10_000).allowed).toBe(true);
    const third = l.check('k', 2, T0 + 20_000);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
    // 拒绝的请求也计数：持续请求不会自动解锁
    expect(l.check('k', 2, T0 + 30_000).allowed).toBe(false);
  });

  it('窗口滑动：单请求 60s 后滑出配额恢复（59s 仍在窗口内）', () => {
    const l = new RpmLimiter();
    // 59s 边界：仍在窗口内 → 拒绝。
    expect(l.check('a', 1, T0).allowed).toBe(true);
    expect(l.check('a', 1, T0 + 59_000).allowed).toBe(false);
    // 60s 边界：恰好一整窗 → 滑出 → 恢复（新 key 不被上面拒绝计数污染）。
    expect(l.check('b', 1, T0).allowed).toBe(true);
    expect(l.check('b', 1, T0 + 60_000).allowed).toBe(true);
  });

  it('被拒请求也计数：停止发送后滑出才恢复', () => {
    const l = new RpmLimiter();
    expect(l.check('k', 1, T0).allowed).toBe(true); // 占用窗口
    expect(l.check('k', 1, T0 + 1_000).allowed).toBe(false); // 拒绝也计数
    expect(l.check('k', 1, T0 + 60_000).allowed).toBe(false); // 拒绝计数仍在窗内
    expect(l.check('k', 1, T0 + 121_000).allowed).toBe(true); // 全部滑出 → 恢复
  });

  it('跨秒边界：59s 前请求仍在窗口内，第 60s 滑出', () => {
    const l = new RpmLimiter();
    expect(l.check('k', 2, T0).allowed).toBe(true); // second S
    expect(l.check('k', 2, T0 + 59_000).allowed).toBe(true); // second S+59
    // second S+60：S 的请求已滑出，窗口只剩 S+59 一个 → 放行
    expect(l.check('k', 2, T0 + 60_000).allowed).toBe(true);
    // second S+61：S+59 与 S+60 都在窗内 → 超限拒绝
    expect(l.check('k', 2, T0 + 61_000).allowed).toBe(false);
  });

  it('不同 key 独立计数', () => {
    const l = new RpmLimiter();
    expect(l.check('a', 1, T0).allowed).toBe(true);
    expect(l.check('a', 1, T0 + 1000).allowed).toBe(false);
    expect(l.check('b', 1, T0 + 1000).allowed).toBe(true); // b 不受 a 影响
    expect(l.size()).toBe(2);
  });

  it('惰性清理：prune 删掉一整窗未见的 key，窗口内的保留', () => {
    const l = new RpmLimiter();
    l.check('a', 1, T0);
    l.check('b', 1, T0);
    l.check('c', 1, T0 + 10_000);
    l.prune(T0 + 59_000);
    expect(l.size()).toBe(3); // 59s < 60s，都在
    l.prune(T0 + 69_000); // a/b 已 69s 未见 → 删；c 只 59s → 留
    expect(l.size()).toBe(1);
    l.prune(T0 + 70_001);
    expect(l.size()).toBe(0); // c 也滑出
  });

  it('定期自动清理：连续 check 超过阈值后过期 key 被删', () => {
    const l = new RpmLimiter();
    l.check('stale', 1, T0);
    // 61s 后同一个活 key 连续大量 check（限流上限放高，全放行），
    // 期间内部触发 prune —— stale 自 T0 后再没被碰过，应被删。
    for (let i = 0; i < 300; i++) {
      expect(l.check('live', 1000, T0 + 61_000 + i).allowed).toBe(true);
    }
    expect(l.size()).toBe(1);
    // 被删的 key 重建后从零计数（窗口不会残留旧计数）
    expect(l.check('stale', 1, T0 + 61_000 + 300).allowed).toBe(true);
  });
});

describe('TpmLimiter（每分钟 token 上限，固定自然分钟窗口）', () => {
  /** 分钟边界对齐的基准时刻（M0 % 60000 === 0，自然分钟起点）。 */
  const M0 = 1_700_000_040_000;

  it('limit<=0 = 不限流：恒放行，不消耗窗口', () => {
    const l = new TpmLimiter();
    expect(l.check('k', 0, M0)).toEqual({ allowed: true, used: 0 });
    expect(l.check('k', 0, M0 + 1000)).toEqual({ allowed: true, used: 0 });
    expect(l.size()).toBe(0);
  });

  it('add 累加；check 已用 >= limit → 拒绝（used 未达则放行）', () => {
    const l = new TpmLimiter();
    expect(l.used('k', M0)).toBe(0);
    l.add('k', 7, M0);
    expect(l.used('k', M0)).toBe(7);
    // 已用 7 < limit 10 → 放行（soft budget，不预扣）。
    expect(l.check('k', 10, M0)).toEqual({ allowed: true, used: 7 });
    l.add('k', 4, M0 + 1000);
    // 已用 11 >= limit 10 → 拒绝。
    expect(l.check('k', 10, M0 + 1000)).toEqual({ allowed: false, used: 11 });
  });

  it('被拒请求不消耗 TPM（check 只读不改窗口）', () => {
    const l = new TpmLimiter();
    l.add('k', 10, M0);
    expect(l.check('k', 10, M0 + 5000).allowed).toBe(false);
    // 拒绝不 add：used 仍是 10（若 check 误写窗口会变 11）。
    expect(l.used('k', M0 + 5000)).toBe(10);
  });

  it('窗口滚动：跨自然分钟 used 归零，自动恢复配额', () => {
    const l = new TpmLimiter();
    l.add('k', 50, M0); // 分钟 0-1
    expect(l.check('k', 40, M0 + 30_000).allowed).toBe(false); // 同分钟 50>=40
    expect(l.used('k', M0 + 59_999)).toBe(50); // 边界前仍算该分钟
    // 下一分钟（M0+60s）：窗口滚动 → used=0 → 放行。
    expect(l.check('k', 40, M0 + 60_000)).toEqual({ allowed: true, used: 0 });
    l.add('k', 20, M0 + 60_000);
    expect(l.used('k', M0 + 60_000)).toBe(20); // 新窗口从新用量起算
  });

  it('不同 key 独立窗口', () => {
    const l = new TpmLimiter();
    l.add('a', 100, M0);
    expect(l.check('a', 50, M0).allowed).toBe(false);
    expect(l.check('b', 50, M0).allowed).toBe(true); // b 不受 a 影响
    expect(l.size()).toBe(1);
  });

  it('prune：滑出窗口的 key 被删，窗口内的保留', () => {
    const l = new TpmLimiter();
    l.add('a', 1, M0);
    l.add('b', 1, M0 + 10_000);
    l.prune(M0 + 59_000);
    expect(l.size()).toBe(2); // 都在当前分钟窗口内
    l.prune(M0 + 61_000); // a 的窗口(M0)已滑出 → 删；b 窗口(M0)同 → 删
    expect(l.size()).toBe(0);
  });

  it('定期自动清理：连续 check 超过阈值后过期 key 被删', () => {
    const l = new TpmLimiter();
    l.add('stale', 5, M0);
    for (let i = 0; i < 300; i++) {
      l.check('live', 1000, M0 + 61_000 + i);
    }
    // check 是只读的（不建窗口），stale 已滑出被 prune → 窗口清空。
    expect(l.size()).toBe(0);
    expect(l.used('stale', M0 + 61_000 + 300)).toBe(0);
  });

  it('add 0/负数无操作（不建窗口）', () => {
    const l = new TpmLimiter();
    l.add('k', 0, M0);
    l.add('k', -3, M0);
    expect(l.size()).toBe(0);
  });
});
