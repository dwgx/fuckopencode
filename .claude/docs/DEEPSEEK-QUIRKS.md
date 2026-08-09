# DeepSeek 上游怪癖清单

这是整个项目存在的理由。DeepSeek（经 opencodezen 网关）声称兼容 Anthropic
Messages API，但有一批硬性差异，标准 Anthropic 客户端直接打过去会 400/401。

下面每条都对应代码里的一处 workaround。改动这些代码前先读这里，
否则很容易把「看起来多余的兜底」删掉，然后线上间歇 400。

## 1. 只认精确模型名

`claude-sonnet-4-6` 这类名字上游 401。必须映射成 `deepseek-v4-flash`。

- 实现：[deepseek.ts:29](../../src/deepseek.ts) `resolveModelName`，未命中 `MODEL_MAP` 回落 `DEFAULT_MODEL`
- 三条路径都要做映射：`/v1/messages`、`/v1/chat/completions`、`/v1/messages/count_tokens`
- count_tokens 曾漏做，导致 Claude Code 记账 401（已修，见 [server.ts:462](../../src/server.ts)）

## 2. thinking: adaptive 直接 400

Claude Code 默认发 `thinking: {type: 'adaptive'}`，DeepSeek 不认这个枚举。

- 归一化：`adaptive` / `enabled` → `{type: 'enabled'}`，并删掉 `budget_tokens`
- 未知类型直接删掉整个 `thinking` 字段
- 实现：[deepseek.ts:57-71](../../src/deepseek.ts)

## 3. reasoning_effort 必须是 output_config.effort

顶层 `reasoning_effort` 会 400。要转成 `output_config: {effort}`。

- 直通路径：[deepseek.ts:77-80](../../src/deepseek.ts)
- chat 路径：[request.ts:98](../../src/request.ts)（原先发顶层字段，已修）

同时：`thinking: disabled` 时**连 effort 一起删**，否则 DeepSeek 报
`cannot be disabled when reasoning_effort is set`（[deepseek.ts:74-76](../../src/deepseek.ts)）。

## 4. beta 配对字段会 400（Extra inputs are not permitted）

Claude Code 会带一堆 beta 字段，DeepSeek 一律拒绝：

- `context_management`
- `output_config.format` / `task_budget`（只留 `effort`）
- 工具上的 `strict` / `defer_loading`

剥离实现：[deepseek.ts:83-103](../../src/deepseek.ts)

## 5. 多轮工具要求回传 reasoning

带 `tool_use` 的 assistant 历史消息里如果没有 `thinking` 块，
DeepSeek 次轮**间歇性** 400（取决于上游启发式检查）。Claude Code 不回传 reasoning。

- 解法：给这类历史消息 unshift 一个空 thinking 块 `{type:'thinking', thinking:'', signature:''}`
- 实现：[deepseek.ts:128](../../src/deepseek.ts) `injectMissingThinkingBlocks`
- 「间歇性」意味着这个 bug 很难复现，不要因为一次没复现就删掉注入逻辑

## 6. thinking 吃光 max_tokens 预算

DeepSeek 的 thinking token 计入 `max_tokens`。客户端给小预算（如 200）时，
预算被 thinking 吃光，正文为空。实测 `max_tokens=30` 只有 thinking 没有 text，4096 正常。

- 解法：thinking 非 disabled 时把 `max_tokens` 抬到 `DEEPSEEK_MIN_MAX_TOKENS = 4096`
- 直通路径：[deepseek.ts:112-117](../../src/deepseek.ts)
- chat 路径：[request.ts:150](../../src/request.ts)（仅在因工具历史刚开启 thinking 时抬）
- **注意这违反了客户端意图**：用户显式要 200 token 却拿到 4096 的账单。
  取舍是「空回复」vs「超预算」，选了后者。thinking disabled 时不抬，尊重客户端。

## 7. thinking disabled 时仍吐 thinking 事件

即使请求 `thinking: disabled`，DeepSeek 的流式响应里还会有
`thinking` 块和 `signature_delta`。Claude Code 收到会报「Tool result missing」。

- 解法：显式 disabled 时解析 SSE、剥掉 thinking 相关事件、重新序列化
- 实现：[deepseek.ts:157](../../src/deepseek.ts) `filterThinkingFromStream`
- enabled/默认时走字节透传，保留 thinking + signature 原样回传（Claude Code 需要）

## 8. thinking enabled 时不能指定 tool_choice

DeepSeek 报 `Thinking mode does not support this tool_choice`。
这影响 JSON mode —— JSON mode 靠强制单工具实现。

- 解法：`response_format` 存在时强制 `thinking: {type:'disabled'}`
- 实现：[request.ts:87-89](../../src/request.ts)

## 8b. 内置 web_search 工具会 400

Claude Code 会带服务端 `web_search` 工具（`type` 以 `web_search` 开头），
DeepSeek 不认。指向它的 `tool_choice` 也会悬空导致 400。

- 解法：按 `type` 前缀剥工具（避免误剥名字碰巧含 web_search 的自定义工具），
  同时剥掉指向它的 `tool_choice`
- 实现：[deepseek.ts:94](../../src/deepseek.ts) 的 5.1 / 5.2 段

## 9. content 必须是内容块数组，不能是字符串

**这条是 2026-08-09 部署时实测发现的。** opencode Zen 只接受
`content: [{type:'text', text:'hi'}]`，收到 `content: "hi"` 会报
`Empty input messages` —— 错误信息极具误导性，messages 明明不为空。

Anthropic 官方两种形式都支持，Claude Code 发的是字符串形式，所以直通端点必须转。

- 验证方式：直连上游对比两种形态，字符串失败、块数组成功
- 解法：归一化时把非空字符串 content 转成单个 text 块
- 实现：[deepseek.ts](../../src/deepseek.ts) `normalizeMessageContent`
- 空字符串**不转**：转成空数组会再次触发 `Empty input messages`
- chat 路径不受影响（`normalizeMessages` 本来就产出块数组）

## 10. count_tokens 端点不存在

opencode Zen 对 `/v1/messages/count_tokens` 返回 404 HTML。
Claude Code 靠这个端点记账，拿不到结果会出问题。

- 解法：上游返回非法响应时，本地按「字符数 / 4」估算 input_tokens 回退
- 实现：[server.ts](../../src/server.ts) `estimateInputTokens`

## 11. 流式可能返回裸 JSON 行，且缺事件骨架

opencode Zen 的流有时不是标准 SSE：直接一行 `{"type":...}` 没有 `data:` 前缀，
还会夹 `{}` 空对象心跳。并且可能缺 `message_start` / `content_block_start` /
`content_block_stop` / `message_stop`，Claude Code 收到后无法初始化 message 对象。

- 解法一：SSE 解析器同时支持裸 JSON 行，`{}`（无 type 字段）跳过
  （[sse.ts](../../src/sse.ts)）
- 解法二：`completeStreamEvents` 按需补全缺失的事件骨架
  （[deepseek.ts](../../src/deepseek.ts)）
- 因此直通路径**总是解析 + 重新序列化**，不做字节透传
