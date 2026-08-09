# 计划

按优先级排。做完一项就从这里移到 ISSUES.md 的「已修」或直接删掉。

## 优先级 1：消掉双路径适配债

`I-3`：deepseek 归一化写了两遍，漏一边就出单边 bug。

做法：把归一化提成统一出口收尾，两条路径转换完都过同一道。
需要先想清楚 `normalizeAnthropicRequest` 现在混了两件事
（协议归一化 + 模型名映射），拆开再复用。

验收：chat 路径也剥 `context_management` / 工具 `strict`；
两条路径的 deepseek 行为有对照测试，改一边不改另一边测试就红。

## 优先级 2：定 I-5 的方向

`/v1/messages` 是否加 system 护栏。需要你拍板，两个方向都合理：
补护栏（安全一致）或写进文档（保持直通语义）。

## 优先级 3：补测试缺口

当前 186 个测试，缺的是：

- `config.ts` 的环境变量解析（`MODEL_MAP` 畸形输入、数字解析失败回落、
  `ALLOW_UNAUTHENTICATED` + 非回环 host 的组合）
- `errors.ts` 的 `anthropicErrorToOpenAI` 全表映射
- `anthropic.ts` 的超时与 signal 组合行为
- 流式路径的客户端提前断开（`res.destroyed` 分支）
- `sse.ts` 的跨包半行、`\r\n`、多行 data 拼接

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
