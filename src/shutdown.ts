/**
 * 优雅关停（SIGINT/SIGTERM）。
 *
 * 为什么单独成模块：main.ts 是进程入口（副作用重），shutdown 的时序契约
 * （先 flush → close → closeIdleConnections → 兜底 exit）需要可单测。
 *
 * 时序契约：
 * 1. 先显式 closeDb()（内部 flush 最后一批用量 + WAL 收尾）—— 不依赖
 *    server.close 回调。该回调要等**所有**连接断开才触发，活跃 SSE 长连接
 *    会让它永远等不到，5s 兜底先跑 → 最后一批用量丢失（P0-2）。
 * 2. server.close(cb)：停新连接，等现有连接自然结束。
 * 3. closeIdleConnections()：掐空闲 keep-alive，加速回调触发；活跃流式
 *    连接不掐（不中断在途响应）。
 * 4. 兜底 timer：超时未关完强制退出。exit(0) 而非 exit(1)：flush 已显式
 *    完成、数据安全，「还有长连接挂着」是优雅停机常态，不是失败语义
 *    （exit(1) 会让 systemd 每次带活跃连接的部署记 FAILURE）。
 */
export interface ShutdownDeps {
  server: {
    close(cb: () => void): void;
    closeIdleConnections?: () => void;
  };
  /** 显式 flush + 关闭持久层（UsageDb.close()，幂等）。必须在 close 回调之前。 */
  closeDb: () => void;
  /** 停止后台任务（keyprobe 等）。 */
  stop?: () => void;
  /** 进程退出（默认 process.exit）。 */
  exit?: (code: number) => void;
  /** 兜底超时 ms。默认 5000。 */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

// 退出只发生一次：close 回调与兜底 timer 都可能触发。用局部变量（真实进程
// 第一次 process.exit 即结束，SIGINT 后 SIGTERM 的第二条 shutdown 不会执行；
// 模块级标志会跨测试/跨调用残留，反而制造状态污染）。
export function shutdown(signal: string, deps: ShutdownDeps): void {
  deps.log?.(`[proxy] ${signal} — shutting down`);
  deps.stop?.();
  let exited = false;
  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    // 关库（flush 最后一批 + WAL 收尾）推迟到退出时刻：开头就关会让
    // 「信号 → 退出」窗口期内在途请求的 recordRequest 落到已关闭的库上
    // （丢行 + flush 对 null 库抛错的日志刷屏）。close() 幂等，close 回调
    // 与兜底两条路径都经这里，只关一次；窗口期新完成的行一并 flush。
    deps.closeDb();
    deps.exit?.(code);
  };
  deps.server.close(() => exitOnce(0));
  // 掐 idle keep-alive 连接加速 close 回调；活跃流式连接不掐（等客户端断开）。
  deps.server.closeIdleConnections?.();
  const timer = setTimeout(() => exitOnce(0), deps.timeoutMs ?? 5000);
  timer.unref?.();
}
