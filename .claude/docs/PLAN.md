# 计划

按优先级排。做完一项就从这里移到 ISSUES.md 的「已修」或直接删掉。

## 优先级 1：消掉双路径适配债

`I-3`：deepseek 归一化写了两遍，漏一边就出单边 bug。

2026-08-11 更新：改造后 chat 路径直发 OpenAI 协议，这个债的形态变了——不再
是「chat 路径 vs 直通路径」的对称重复，而是集中在直通路径内部：
`normalizeAnthropicRequest`（deepseek.ts）与 `toOpenAI`/`toAnthropic`
（协议转换）各管一层，DSML 兜底在非流式/流式两处接线。原验收标准
（「chat 路径也剥 `context_management` / 工具 `strict`」）基于旧架构，已作废。

做法：直通路径的 deepseek 归一化收敛到 `normalizeAnthropicRequest` 一处，
`toOpenAI`/`toAnthropic` 不再各自内联 deepseek 适配。

验收：直通路径的非流式/流式两处输出行为有对照测试（同输入同输出），
DSML 兜底逻辑只有一处实现，改归一化逻辑时测试能覆盖两条输出分支。

## 优先级 2：定 I-5 的方向

`/v1/messages` 是否加 system 护栏。需要你拍板，两个方向都合理：
补护栏（安全一致）或写进文档（保持直通语义）。

## 优先级 3：补测试缺口

缺的是：

- `config.ts` 的环境变量解析（`MODEL_MAP` 畸形输入、数字解析失败回落、
  `ALLOW_UNAUTHENTICATED` + 非回环 host 的组合）
- `errors.ts` 的 `anthropicErrorToOpenAI` 全表映射、`parseResetDelayMs` 边界
- `upstream.ts` 的超时与 signal 组合行为
- 流式路径的客户端提前断开（`res.destroyed` 分支）
- `tool.ts` 的 `sanitizeInputSchema`（$ref 降级、白名单剥离）
- `sse.ts` 的 `parseOpenAISSE` 跨包半行、`\r\n`、多行 data 拼接
  （脏行检测已覆盖，见 `test/stream.test.ts` 的 `parseOpenAISSE 脏行检测`）
  （`metrics.ts` 已补：2026-08-11 加 36 条，覆盖 p95/UA 解析/IP 优先级/环形缓冲）

## 优先级 4：小修

- `isLoopbackHost` 里把 `0.0.0.0` 移出去（[config.ts:53](../../src/config.ts)），
  当前靠调用方兜住，属于埋雷
- `max_tokens` 被抬高时记一行日志（`I-4`）
- `writeChunk` 用具名函数 + `removeListener` 收尾（`I-7`）

## 不做

- 不给注入检测加更多正则。它是启发式降噪，不是安全边界，
  加规则只会增加误杀，收益递减。
- 不引入 express/fastify。零依赖是刻意的。
- 不做 DNS rebinding 防护。网关这层做不到，见 ISSUES.md。
