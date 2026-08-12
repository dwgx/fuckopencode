/**
 * per-key RPM 限流器（src/ratelimit.ts）单测。
 *
 * 覆盖：limit<=0 不限流、窗口内计数、超限拒绝、窗口滑动（60s 边界）、
 * 跨秒边界、不同 key 独立、惰性清理（prune 整表 + 定期自动）。
 * 时间全部注入固定 now（秒级对齐），避免真实时钟抖动。
 */

import { describe, expect, it } from 'vitest';
import { RpmLimiter } from '../src/ratelimit.js';

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
