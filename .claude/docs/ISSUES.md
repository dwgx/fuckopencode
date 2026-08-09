# 已知问题

状态：`确认` 有复现路径 / `可疑` 只是读代码推断 / `已修` 本轮修掉 / `设计取舍` 不是 bug

最后核对：2026-08-09，基线 `npm test` 186 passed、`tsc --noEmit` 干净。

## 已修（2026-08-09 部署轮）

### I-0 content 字符串被上游拒为 "Empty input messages" — 已修

opencode Zen 只认内容块数组。Claude Code 发 `content: "hi"` 字符串形式时，
`/v1/messages` 全部失败，错误信息 `Empty input messages` 极具误导性。
**这是线上一直存在的问题**，旧版本同样有，部署验证时实测发现。

- 复现：直连上游对比，`content:"hi"` 失败 / `content:[{type:"text",text:"hi"}]` 成功
- 修法：`normalizeMessageContent` 转成单 text 块（[deepseek.ts](../../src/deepseek.ts)）
- 空字符串不转（转空数组会再次触发同一错误）

## 已修（2026-08-09）

### I-1 chat 端点发顶层 reasoning_effort，DeepSeek 必 400 — 已修

`request.ts` 把 OpenAI `reasoning_effort` 写成 Anthropic 顶层字段，
但 DeepSeek 只认 `output_config.effort`（[deepseek.ts:14](../../src/deepseek.ts) 自己的文档就写了这条）。
直通路径做了转换，chat 路径没做。

- 复现：`POST /v1/chat/completions` 带 `reasoning_effort: 'high'`，
  抓上游请求体，能看到顶层 `reasoning_effort`
- 修法：[request.ts:98](../../src/request.ts) 改为写 `output_config: {effort}`
- 同步更新了 `test/request.test.ts` 里断言旧行为的用例

### I-2 流式漏发 finish_reason — 已修

上游只发 `message_stop` 而没有 `message_delta` 时，`stream.ts` 直接 return，
OpenAI 客户端永远收不到 `finish_reason`，可能一直等或报错。
上游被掐断（两个事件都没有）时同样漏发。

- 复现：喂 `[content_block_delta, message_stop]` 给 `anthropicStreamToOpenAI`，
  所有 chunk 的 `finish_reason` 都是 null
- 修法：加 `emittedFinish` 状态位，`message_stop` 和迭代结束时兜底补发
  （[stream.ts:195](../../src/stream.ts)）

## 确认（未修）

### I-3 chat 路径与直通路径的 deepseek 适配是两套实现

不是单个 bug，是 bug 的来源。`normalizeAnthropicRequest` 只在 `/v1/messages` 上跑，
chat 路径靠 `request.ts` 自己内联。任何 deepseek 怪癖的修复都得写两遍，
漏一边就出单边 bug —— I-1 正是这么产生的。

chat 路径目前**没有**的适配：剥 `context_management`、剥工具的 `strict`/`defer_loading`、
剥 `output_config.format`、剥内置 `web_search` 工具。这些字段 OpenAI 客户端
一般不会发，所以暂时没炸。

2026-08-09 更新：这一轮又被印证一次。keypool 只接在上游转发层（两条路径共用
`postAnthropic` 所以侥幸没事），但 `content` 字符串转换（I-0）只需在直通路径修，
chat 路径因为 `normalizeMessages` 恰好已产出块数组而免疫 —— 属于运气，不是设计。

- 建议：把 deepseek 归一化提成一道统一的出口收尾，两条路径转换完都过一遍
- 优先级：高，属于架构债，不修就会继续出同类 bug

### I-4 max_tokens 下限保护违反客户端意图

thinking 非 disabled 时，`max_tokens` 会被静默抬到 4096
（[deepseek.ts:112](../../src/deepseek.ts)）。客户端显式要 200 却按 4096 计费，
且响应里没有任何提示。

- 这是刻意取舍（空回复 vs 超预算），但客户端无从得知
- 建议：至少在日志里记一行「max_tokens 200 → 4096」，便于排查账单疑问

### I-5 /v1/messages 不加 system 护栏

`buildSystemGuard` 只在 chat 路径调用（[server.ts:263](../../src/server.ts)）。
直通路径的 system 原样转发，L4 防护对 Claude Code 完全不生效。

- 复现：`POST /v1/messages` 带 `system`，上游收到的 system 不含护栏文本
- **但这可能是对的**：直通端点的语义就是不改写请求体，而且往 Claude Code 的
  system prompt 里插入中文安全约束可能干扰它的正常工作
- 需要你定：是补上护栏（安全一致），还是明确写进文档说直通端点不做 L4（保持直通语义）

## 可疑（读代码推断，未构造复现）

### I-6 SSE 解析缓冲区无上界

[sse.ts:36](../../src/sse.ts) 的 `buffer` 只在遇到 `\n` 时才切分。
上游若发一个超长无换行的流，buffer 无限增长。

- 上游是可信的 DeepSeek，实际风险低
- 未验证：没构造过恶意上游

### I-7 writeChunk 的监听器可能累积

[server.ts:46](../../src/server.ts) 每次背压都 `res.once('drain'|'close'|'error')`。
resolve 后另外两个监听器不会被摘掉。长流 + 频繁背压下监听器会累积，
可能触发 MaxListenersExceededWarning。

- 未验证：需要慢客户端 + 长流才能观察到

## 设计取舍（不是 bug）

- **注入检测本质是正则黑名单**，能被改写句式绕过。定位是「降低噪声」不是「安全边界」，
  代码注释也写明了「宁漏报不误伤」。不要指望它拦住有意的攻击者。
- **`isLoopbackHost` 把 `0.0.0.0` 算作回环**（[config.ts:53](../../src/config.ts)）
  看着是 bug，但唯一调用方 `hostnameIsSafe` 会先排除 `0.0.0.0`，当前行为正确。
  这个函数一旦被别处复用就会变成真 bug，建议把 `0.0.0.0` 从里面移出去。
- **SSRF 的十进制/十六进制/八进制 IP 变形已被覆盖**：WHATWG `URL` 会把
  `http://2130706433/` 规范化成 `127.0.0.1`，`parseIpv4` 拿到的已是点分形式。已实测确认。
- **DNS rebinding 不防**：只做字面量判定，域名放行。上游代抓图片，
  真要防得在上游侧做，网关这层做不到。

## 我验证过的、结论是「没问题」的点

这些是我怀疑过、写了探针测试、结果证明实现正确的地方，记下来免得下次重复怀疑：

- 工具名消毒在定义和历史 `tool_use` 两侧一致（`normalize.ts` 已调 `sanitizeToolName`）
- `error` 事件后 `[DONE]` 仍会发出（`openAIStreamToSSE` 的 finally 语义保证）
- 以 `assistant(tool_use)` 开头的历史被丢弃时，孤立 `tool_result` 也会被丢，不会残留
- `count_tokens` 会做模型名映射
