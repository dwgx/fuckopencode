import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { shutdown } from '../src/shutdown.js';

/**
 * shutdown() 时序契约单测。
 *
 * 回归语义（P0-2）：修复前 flush 依赖 server.close 回调，活跃 SSE 连接时
 * 回调不可达、5s 兜底 exit(1) 先跑 → 最后一批用量丢失。本测试断言：
 * 1. closeDb 在兜底 exit 之前被调用（无论连接是否关完）；
 * 2. 兜底退出码是 0（flush 已完成，不是失败语义）；
 * 3. closeIdleConnections 被调用以加速 close 回调。
 */

interface FakeServer {
  close: Mock<(cb: () => void) => void>;
  closeIdleConnections: Mock<() => void>;
  /** close 回调被记录但不触发（模拟活跃连接阻止回调）。 */
  closeCb: (() => void) | null;
}

function fakeServer(triggerCallback: boolean): FakeServer {
  const s: FakeServer = {
    close: vi.fn<(cb: () => void) => void>(),
    closeIdleConnections: vi.fn<() => void>(),
    closeCb: null,
  };
  s.close.mockImplementation((cb: () => void) => {
    s.closeCb = cb;
    if (triggerCallback) cb();
  });
  return s;
}

function fakeTimers(ms = 5000): { advance: () => void } {
  vi.useFakeTimers();
  return {
    advance: () => vi.advanceTimersByTime(ms),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('shutdown()', () => {
  it('活跃连接（close 回调不可达）时兜底 exit(0)，closeDb 在退出前调用', () => {
    // 回归：修复前 flush 在 close 回调里，活跃 SSE 连接让回调永远等不到，
    // 5s 兜底 exit(1) 先跑 → 最后一批用量丢失。修复后两条退出路径都经
    // exitOnce（先 closeDb 再 exit），且 closeDb 推迟到退出时刻 —— 信号后
    // 窗口期在途请求的 recordRequest 不会落到已关闭的库上（M-1）。
    const timers = fakeTimers();
    const server = fakeServer(false); // 回调不触发 = 活跃连接
    const closeDb = vi.fn();
    const exit = vi.fn();
    const stop = vi.fn();

    shutdown('SIGTERM', { server, closeDb, stop, exit });

    // 连接还挂着：closeDb 不急于执行（窗口期数据还能正常落库）。
    expect(stop).toHaveBeenCalledTimes(1);
    expect(closeDb).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    timers.advance();
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledBefore(exit as never);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0); // 兜底必须 exit(0)，不是 exit(1)
  });

  it('正常关闭：close 回调里先 closeDb 再 exit(0)', () => {
    const timers = fakeTimers();
    const server = fakeServer(true); // 回调立即触发
    const closeDb = vi.fn();
    const exit = vi.fn();

    shutdown('SIGINT', { server, closeDb, exit });

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledBefore(exit as never);
    expect(exit).toHaveBeenCalledWith(0);
    timers.advance();
    expect(exit).toHaveBeenCalledTimes(1); // 兜底不再触发（已 exit）
  });

  it('closeIdleConnections 在 close 之后被调用（加速空闲 keep-alive 回收）', () => {
    fakeTimers();
    const server = fakeServer(false);
    shutdown('SIGTERM', { server, closeDb: vi.fn(), exit: vi.fn() });

    expect(server.close).toHaveBeenCalled();
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(server.closeIdleConnections.mock.invocationCallOrder[0]).toBeGreaterThan(
      server.close.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('无 closeIdleConnections 的 server（旧 Node）也安全', () => {
    fakeTimers();
    const server = fakeServer(false);
    delete (server as { closeIdleConnections?: unknown }).closeIdleConnections;
    shutdown('SIGTERM', { server, closeDb: vi.fn(), exit: vi.fn() });
    expect(server.close).toHaveBeenCalled();
  });

  it('兜底 timer 被 unref（不拖住进程）', () => {
    const timers = fakeTimers();
    const server = fakeServer(false);
    shutdown('SIGTERM', { server, closeDb: vi.fn(), exit: vi.fn() });
    const pending = vi.getTimerCount();
    expect(pending).toBeGreaterThan(0);
    timers.advance();
  });
});
