# 热路径性能优化（2026-08-13）

## 目标
2GB VPS / Node 单线程 / 全同步 SQLite 的防御性优化。对抗审查已确认三个热点，逐一优化 + 回归测试。

## 已确认事实（读文档+codegraph 核实）
- 热路径每请求：`verifyAuth` → `tokens.verify()`（同步点查 status）→ `checkTokenRpmLimit`
  → `tokens.getRpmLimit()`（同一行第二次同步点查 rpm_limit）→ finally `db.recordRequest`
  （同步 INSERT + `parseUserAgent(ua)` 重复解析）。
- `getRpmLimit` 只被 `server.ts`（checkTokenRpmLimit 内）+ test 使用。verify 的查询
  是 `SELECT status FROM tokens WHERE fingerprint=? AND status='active'`。
- `recordRequest` 调用方：`server.ts` finally（已有 `device=extractDevice(req)` 解析过 UA）、
  `keyprobe.ts`（无 UA 解析）。
- 读 requests 表的 UsageDb 方法：listRequests/statsByIp/usageByKeyFingerprints/tokenUsageAll/
  usageTrend/history（加 flush-on-read 保持既有测试读逻辑不改）。
- e2e「用量持久化接线」describe 有 4 条测试用裸只读连接直读 requests 表 → 注入 UsageDb
  实例 + 测试里显式 flush。

## 改动方案（全部落地）
1. tokens.verify 返回 `{ok:true,fingerprint,rpmLimit}`（单次点查取 status+rpm_limit），
   归一化与 getRpmLimit 共用 `normalizeRpmLimit`；auth.verifyAuth 透传 rpmLimit
   （AuthResult 加字段）；server.checkTokenRpmLimit 去掉 tokens 参数改收 rpmLimit。
2. recordRequest 改内存队列：100ms 定时器 / 攒满 50 条 / 读路径 / close() 触发 flush，
   单事务批量 INSERT。崩溃最多丢最后一批。pruneNow 也先 flush（防旧行逃过清理后落库）。
3. UsageRow 加可选 `client`，server finally 传 `device.client`（已解析），不再二次 parse。

## 验证（真实输出）
- npm run typecheck：干净
- npm test：27 files / 1218 passed（3.36s）
- npm run build：干净
- 变异验证（去掉优化会红，已实测）：
  - recordRequest 强制同步 flush → 「只入队不落库」测试红
  - verify 不再返回 rpmLimit → 「单次点查即带回 rpmLimit」测试红

## 热路径查询次数对比（每分发 key 请求）
- 改前：2 次同步点查（verify + getRpmLimit）+ 1 次同步 INSERT + 1 次 parseUserAgent
- 改后：1 次同步点查（verify 带回 rpmLimit）+ 0 次 INSERT（挪批量）+ 0 次 parse（复用 device.client）

## 边界/诚实披露
- server 传 device.client（raw UA 解析）与旧实现 parse(stripControl(ua)) 对含 ASCII
  控制符的 UA 理论有差异；stripControl 只删控制符，parseUserAgent 正则不受影响，现实等价。
- flush-on-read 保持读一致性（强于「批量延迟<1s」要求），读路径队列空时零开销。
- 写失败整批回滚丢弃（观测数据非关键），不重试避免拖事件循环。
- 会话期间并行 agent 的改动（deepseek/sse/toAnthropic + 其测试 + CURRENT.md）落树，未碰。
  一次误用 `git checkout -- src/tokens.ts` 把 tokens.ts 整文件还原，已重做，最终 diff 正确。
- 未碰 toAnthropic/deepseek/oauth/console/legacy/盾。

---

## 上游慢响应处理（2026-08-13，独立会话）

目标：网关对上游慢/卡的处理分级（上游本身推理耗时不可控，只动网关侧）。
硬约束只改 `upstream.ts` / `keypool.ts` / `server.ts` 上游请求区 / `errors.ts` / 相关测试。
**未提交**（工作区含并行 agent 的在途改动）。

### 改动（逐项）
1. **非流式总超时**（upstream.ts）：新增 `UPSTREAM_NONSTREAM_TOTAL_MS=150_000`。
   非流式（`body.stream !== true`）从请求起算 total 封顶（比 idle 90s 更宽但封顶），
   流式保持 header 120s + idle 90s（touch 续命，长生成合法）。`UpstreamCallOptions.timeouts`
   加 `totalMs`（测试注入用）。超时触发 → abort → server 非流式 data===null → markFailure('transient')。
2. **markFailure 归因确认**：非流式总超时/idle 掐断 → `controller.signal.aborted && !res.destroyed`
   （`isClientAbort`=aborted && destroyed，客户端断开仍不记失败，维持既有修复）。
3. **长响应观测**：`isUpstreamWatchdog()` 区分「网关主动掐断」→ 502 文案 `upstream response
   timed out`（errors.ts 新增 `UPSTREAM_TIMEOUT_ERROR`），ctx.error 记 `upstream response timed out`；
   非超时非法 body 保持 `upstream returned malformed body`。流式超时错误 chunk / passthrough
   error 事件同步用超时文案。duration 本就在 db/面板（慢响应 e2e 钉住）。
4. **面板通道并发（item 3）审计，未改文件**：console.ts `cachedGet` 有 30s TTL 缓存但**无读单飞**
   （只有 OAuth refresh 单飞）——多 tab 缓存过期瞬间会各打一次上游；legacy.ts `fetchLegacyKeys`
   等**无缓存无单飞**（仅 plain 15min 缓存）。属 console.ts/legacy.ts 域，按硬约束未动，已报告。

### 验证
- npm run typecheck：干净
- npm test：27 files / 1224 passed（改前 1218 = 本会话 +6：upstream 非流式总超时 2 条、
  e2e 文案 + 慢响应 2 条、errors 常量 2 条）
- npm run build：干净
- 超时参数表（改前 → 改后）：header 120s→120s（不变）；idle 90s→90s（流式，不变）；
  非流式 total 新增 150s（原来无 total，只靠 idle 90s-from-headers 死线）

