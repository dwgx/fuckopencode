# DeepSeek 上游怪癖清单

这是整个项目存在的理由。DeepSeek（经 opencodezen 网关）声称兼容 Anthropic
Messages API，但有一批硬性差异，标准 Anthropic 客户端直接打过去会 400/401。

下面每条都对应代码里的一处 workaround。改动这些代码前先读这里，
否则很容易把「看起来多余的兜底」删掉，然后线上间歇 400。

行号核对日期：2026-08-14（对照当前 main，deepseek.ts 现 533 行）。

## 0. 上游 Anthropic 兼容层工具调用是坏的（直通端点转 OpenAI 协议的动机）

opencode Zen 的 Anthropic 兼容层工具调用返回**空 content + stop_reason:null**
（实测），Claude Code 收到无法执行工具。因此直通端点不直接打上游的
Anthropic 端点，而是把 Anthropic 请求转成 OpenAI 协议（anthropicToOpenAIRequest）
发给上游的 OpenAI 端点，再把响应转回 Anthropic —— 这是整个 toOpenAI.ts /
toAnthropic.ts 转换链存在的理由，删掉任何一环直通路径就回到坏的兼容层。

- 动机注记：[toOpenAI.ts:12-26](../../src/toOpenAI.ts) 文件头注释 + `anthropicToOpenAIRequest`（[toOpenAI.ts:27](../../src/toOpenAI.ts)）
- 请求侧关键转换：`tool_use` → `tool_calls`（[toOpenAI.ts:126-132](../../src/toOpenAI.ts)）、
  `tool_result` → 独立 `role:'tool'` 消息（[toOpenAI.ts:161-168](../../src/toOpenAI.ts)）、
  空 thinking 块也输出 `reasoning_content`（[toOpenAI.ts:119-125](../../src/toOpenAI.ts)，DeepSeek 要求
  assistant 历史带该字段，空块不能丢）
- 响应侧：[openAIToAnthropicResponse](../../src/toAnthropic.ts:82) / [openAIStreamToAnthropic](../../src/toAnthropic.ts:159)
- 接线：[server.ts:2966](../../src/server.ts)（请求转换）、[server.ts:3072](../../src/server.ts)（流式响应）、
  [server.ts:3160](../../src/server.ts)（非流式响应）

## 1. 只认精确模型名

`claude-sonnet-4-6` 这类名字上游 401。必须映射成 `deepseek-v4-flash`。

- 实现：[deepseek.ts:66](../../src/deepseek.ts) `resolveModelName`，未命中 `MODEL_MAP`
  回落 `DEFAULT_FALLBACK_MODEL`（常量在 [deepseek.ts:20](../../src/deepseek.ts)）
- 白名单语义（2026-08-14 起）：`resolveModel`（[deepseek.ts:93](../../src/deepseek.ts)）对白名单外
  模型是**明确拒绝**（返回 `not-allowed`，不再静默回落 flash，[deepseek.ts:107-109](../../src/deepseek.ts)）；
  `resolveModelName` 是兼容封装，仅在其失败时回落 fallback（[deepseek.ts:74-77](../../src/deepseek.ts)）
- 两条数据面路径都要做映射：`/v1/messages`（[deepseek.ts:184](../../src/deepseek.ts)）、
  `/v1/chat/completions`（[server.ts:2809](../../src/server.ts) prepareOpenAIUpstreamRequest 内 resolveModel）。
  `count_tokens` 是纯本地估算、不打上游（见 Quirk 10），无需映射

## 2. thinking: adaptive 直接 400

Claude Code 默认发 `thinking: {type: 'adaptive'}`，DeepSeek 不认这个枚举。

- 归一化：`adaptive` / `enabled` → `{type: 'enabled'}`，并删掉 `budget_tokens`
- `disabled` → `{type: 'disabled'}`；未知类型删掉整个 `thinking` 字段；字符串 thinking 也删
- 实现：[deepseek.ts:187-202](../../src/deepseek.ts)（normalizeAnthropicRequest 第 2 步）

## 3. reasoning_effort 必须是 output_config.effort

顶层 `reasoning_effort` 会 400。要转成 `output_config: {effort}`。

- 直通路径：[deepseek.ts:204-211](../../src/deepseek.ts)（第 3 步）；disabled 时连 effort 删在 [deepseek.ts:205-207](../../src/deepseek.ts)
- chat 路径：**request.ts 已退役**（2026-08-09 改造，chat 路径直发 OpenAI 协议），
  `reasoning_effort` 是 OpenAI 合法字段原样透传，无需转换
- Anthropic→OpenAI 转换里的 effort 提取在 [toOpenAI.ts:68-75](../../src/toOpenAI.ts)

同时：`thinking: disabled` 时**连 effort 一起删**，否则 DeepSeek 报
`cannot be disabled when reasoning_effort is set`。

## 4. beta 配对字段会 400（Extra inputs are not permitted）

Claude Code 会带一堆 beta 字段，DeepSeek 一律拒绝：

- `context_management`
- `output_config.format` / `task_budget`（只留 `effort`）
- 工具上的 `strict` / `defer_loading`

剥离实现：[deepseek.ts:213-222](../../src/deepseek.ts)（第 4 步）、[deepseek.ts:224-242](../../src/deepseek.ts)（第 5 步，工具字段）

## 5. thinking 模式下每条 assistant 历史都要求回传 reasoning

**注入范围 2026-08-14 前已扩大**：不只「带 tool_use 的 assistant 历史」，而是
thinking 模式下**所有缺 thinking 块的 assistant 历史消息**都要注入 —— 纯多轮
对话无工具也会被上游拒（`The reasoning_content in the thinking mode must be
passed back to the API`）。Claude Code 不回传 reasoning。

- 解法：给这类历史消息 unshift 一个空 thinking 块 `{type:'thinking', thinking:'', signature:''}`
- 实现：[deepseek.ts:351](../../src/deepseek.ts) `injectMissingThinkingBlocks`；
  调用点 [deepseek.ts:273](../../src/deepseek.ts)（normalizeAnthropicRequest 第 7 步）
- 注入判定在 [deepseek.ts:368-374](../../src/deepseek.ts)（缺块即注入，与工具无关）

## 6. thinking 吃光 max_tokens 预算

DeepSeek 的 thinking token 计入 `max_tokens`。客户端给小预算（如 200）时，
预算被 thinking 吃光，正文为空。实测 `max_tokens=30` 只有 thinking 没有 text，4096 正常。

- 解法：thinking 非 disabled 时把 `max_tokens` 抬到 `DEEPSEEK_MIN_MAX_TOKENS = 4096`
  （常量 [deepseek.ts:27](../../src/deepseek.ts)）
- 直通路径：[deepseek.ts:278-283](../../src/deepseek.ts)（第 8 步，thinking disabled 不抬）
- chat 路径（2026-08-14 补回，P1-G）：[server.ts:2837-2857](../../src/server.ts)
  prepareOpenAIUpstreamRequest 内，`response_format`（JSON mode，thinking 强制关）存在时不抬；
  `max_completion_tokens`/`max_tokens` 双字段同源处理，只抬一个避免双字段并存 400
- **注意这违反了客户端意图**：用户显式要 200 token 却拿到 4096 的账单。
  取舍是「空回复」vs「超预算」，选了后者。thinking disabled 时不抬，尊重客户端。

## 7. thinking disabled 时仍吐 thinking 事件

即使请求 `thinking: disabled`，DeepSeek 的流式响应里还会有
`thinking` 块和 `signature_delta`。Claude Code 收到会报「Tool result missing」。

- 解法：显式 disabled 时解析流、剥掉 thinking 相关事件、重新序列化
- 实现：[deepseek.ts:385](../../src/deepseek.ts) `filterThinkingFromStream`；
  调用点 [server.ts:3070](../../src/server.ts)，keepThinking 判定 [server.ts:3055](../../src/server.ts)
- 形态：上游现为 OpenAI 流，thinking 以 `reasoning_content` 出现，
  `openAIStreamToAnthropic` 转成 thinking 块后由 filterThinkingFromStream 剥
- enabled/默认时保留 thinking + signature 原样回传（Claude Code 需要）

## 8. thinking enabled 时不能指定 tool_choice

DeepSeek 报 `Thinking mode does not support this tool_choice`。

- **2026-08-09 改造后解法更换**：旧解法（`response_format` 存在时强制
  `thinking: {type:'disabled'}`，request.ts）已随 request.ts 退役删除。
  现在统一是「**剥 tool_choice**」——直通路径无条件不输出（[toOpenAI.ts:61-66](../../src/toOpenAI.ts)，
  实测 190+ 条 400）；chat 路径对 `-free` 模型剥、订阅端点保留（[server.ts:2830-2836](../../src/server.ts)，
  见 Quirk 14）
- 上游「thinking 下 tool_choice 400」的事实仍在，只是解决方式变了

## 8b. 内置 web_search 工具会 400

Claude Code 会带服务端 `web_search` 工具（`type` 以 `web_search` 开头），
DeepSeek 不认。指向它的 `tool_choice` 也会悬空导致 400。

- 解法：按 `type.startsWith('web_search') || name === 'web_search'` 剥工具，
  同时剥掉指向它的 `tool_choice`
- 实现：[deepseek.ts:232-254](../../src/deepseek.ts)（第 5.1 / 5.2 段）

## 9. content 必须是内容块数组，不能是字符串

**这条是 2026-08-09 部署时实测发现的。** opencode Zen 只接受
`content: [{type:'text', text:'hi'}]`，收到 `content: "hi"` 会报
`Empty input messages` —— 错误信息极具误导性，messages 明明不为空。

Anthropic 官方两种形式都支持，Claude Code 发的是字符串形式，所以直通端点必须转。

- 验证方式：直连上游对比两种形态，字符串失败、块数组成功
- 解法：归一化时把非空字符串 content 转成单个 text 块
- 实现：[deepseek.ts:333](../../src/deepseek.ts) `normalizeMessageContent`；
  调用点 [deepseek.ts:260](../../src/deepseek.ts)（第 6 步）
- 空字符串**不转**：转成空数组会再次触发 `Empty input messages`
- chat 路径直发 OpenAI 协议（OpenAI 的 content 字符串是合法形态），不经此转换

## 10. count_tokens 端点不存在

opencode Zen 对 `/v1/messages/count_tokens` 返回 404 HTML。
Claude Code 靠这个端点记账，拿不到结果会出问题。

- 解法：**本地估算**（字符数 / 4），不打上游 —— 既省往返也避免烧订阅额度
  （[server.ts:3183-3185](../../src/server.ts) 注释）
- 实现：[server.ts:3218](../../src/server.ts) `estimateInputTokens`；
  handler [server.ts:3194](../../src/server.ts) `handleCountTokens`；路由分发 [server.ts:2371](../../src/server.ts)
- 因为不打上游，Quirk 1 的「count_tokens 做模型映射」已无意义（只记录客户端模型名，[server.ts:3211](../../src/server.ts)）

## 11. 上游是 OpenAI 流：脏行与记账 chunk

**2026-08-09 改造后上游协议切到 OpenAI，本条形态整体更换**（旧的 Anthropic
SSE 裸 JSON 行 + 缺骨架解法已退出直通路径）。现在的问题形态：

- 裸 JSON 行（无 `data:` 前缀）仍可能出现（[sse.ts:54-71](../../src/sse.ts) parseOpenAISSE 支持）
- `[DONE]` 行跳过（[sse.ts:47](../../src/sse.ts)）
- 记账 chunk `{"choices":[],"cost":"0"}` 保留（[sse.ts:60-70](../../src/sse.ts)）
- 脏行上报 onDirty（[sse.ts:51/67/76](../../src/sse.ts)）
- 事件骨架由 `openAIStreamToAnthropic` 自产（[toAnthropic.ts:159](../../src/toAnthropic.ts)，[server.ts:3053](../../src/server.ts) 注释「自带完整骨架」）

- 因此直通路径**总是解析 + 重新序列化**，不做字节透传（[server.ts:3046-3136](../../src/server.ts) 全链路）
- 旧 `parseAnthropicSSE`（[sse.ts:119](../../src/sse.ts)）已无调用，死代码；
  `completeStreamEvents`（[deepseek.ts:433](../../src/deepseek.ts)）仅库导出（index.ts），直通路径不再用

## 12. 偶发把工具调用当文本吐（DSML 泄漏）

**2026-08-09 线上实测发现。** DeepSeek 偶发不吐结构化 `tool_calls`，而是把工具
调用当普通文本吐出来。实测形态——**每个标签自己带命名空间前缀**，不是外层包一层：

```
< | DSML | function_calls
< | DSML | invoke name="Bash">
< | DSML | parameter name="command" string="true">echo hi</ | DSML | parameter>
</ | DSML | invoke>
</ | DSML | function_calls>
```

客户端（Claude Code / opencode）看到的就是一堆裸文本 `invoke`，工具不会被执行。
且泄漏时 `finish_reason` 是 `stop`（上游不认为这是工具调用）。

- 解法：文本里同时出现 `function_calls` + `<invoke` 时，兜底解析还原成
  `tool_use` 块，并把 `stop_reason` 纠正为 `tool_use`
- 实现：[dsml.ts:138](../../src/dsml.ts) `extractDsmlToolCalls`
- 接线：[toAnthropic.ts:99](../../src/toAnthropic.ts)（非流式 openAIToAnthropicResponse）、
  [toAnthropic.ts:375](../../src/toAnthropic.ts)（流式 openAIStreamToAnthropic 收尾），**两处都要接**
- 前缀形态不稳定（`|DSML|` / `antml:` / 全角 `｜` / 无前缀），匹配统一走宽松模式
  （[dsml.ts:42](../../src/dsml.ts) NS 正则）
- 流式下文本缓冲到流结束再解析（增量转发无法中途判断分片），代价是文本 TTFB
  从「首字」变「整个 text 块结束」；工具场景本就要等工具结果，取舍可接受

### 12b. 残缺 DSML 标记仍会泄漏（2026-08-09 二次实测）

上面那条的「保守原则」原本是**解析不出任何 invoke 就原样返回**。这条原则在
「上游只吐了半截标签」时会把标记直接泄漏给客户端 —— 用户实测看到裸的：

```
现在绝对还有<｜DSML｜function_calls
```

这类形态抽不出任何 `invoke`（上游被 `max_tokens` 截断，或只吐了开头/闭合标记），
所以 `extractDsmlToolCalls` 返回 null，走 else 分支把原文完整透出。

解法分两层，别混在一起：

| 情况 | 处理 | 函数 |
|---|---|---|
| 能抽出 invoke | 还原成 `tool_use` + 纠正 `stop_reason` | `extractDsmlToolCalls` |
| 抽不出但带 DSML 标记 | **只剥标记，保留周围正常文本** | `stripDsmlResidue` |
| 不带 DSML 标记 | 原样返回，绝不改写 | — |

- 实现：[dsml.ts:118](../../src/dsml.ts) `hasDsmlResidue` / [dsml.ts:130](../../src/dsml.ts) `stripDsmlResidue`
- 接线：[toAnthropic.ts:107-109](../../src/toAnthropic.ts)（非流式）、[toAnthropic.ts:405-407](../../src/toAnthropic.ts)（流式）
- 剥离覆盖开/闭标签，以及被截断成「没有 `>`」的半截标签
- 关键边界：正常提到 `function_calls` 这个词的对话**不能被改写**。判据是标记形态
  （`[<⟨]` + 命名空间 + 标签名），不是关键词命中，有回归测试守住

### 12c. 半截标签跨行贪婪吞文本（2026-08-09 三次实测，最隐蔽的一个）

12b 的剥离正则第一版有 bug：半截标签（没有 `>` 收尾）时，`[^>⟩]*` 会
**跨行贪婪吃到字符串末尾**，把标记**和后面整段正常回答一起吞掉**。

用户贴的真实形态——标记后面永远跟着正常文本（工具结果 / 思考过程）：

```
<｜DSML｜function_calls
阅读
binary_patch_19.py
我理解了 ReleaseVR 的模式。

<｜DSML｜function_calls
<｜DSML｜function_calls
Found header for GetMaxDesktopBitrate

<｜DSML｜function_calls
已运行 2 命令
workflow 超级大并发 开始 剩下的都做完
```

修复前 `stripDsmlResidue` 对这三段全返回空字符串 `""` —— 客户端从「看到裸标记」
变成「看到空白回答」。12b 的测试只覆盖了「半截标签是最后一个 token」的场景
（后面没内容可吞），恰好没暴露这个 bug。

- 修复：`DSML_RESIDUE` 拆成三支（完整开标签 / 完整闭标签 / 半截标签），
  半截标签只吃到**行尾**（`[^>⟩\n]*`），不能跨行（[dsml.ts:104-115](../../src/dsml.ts)）
- 回归测试：`test/toAnthropic.test.ts:658-698`「标记不吞后面文本」组（it.each 在 689），5 条真实形态样本
- 教训：残缺标签处理要同时防**泄漏**（标记透出）和**吞文本**（标记把内容吃掉），
  两者都是用户可见的错误，一个测试覆盖到的不代表另一个也覆盖

## 13. `-free` 模型只在按量端点（/zen）存在，订阅端点 401

`deepseek-v4-flash-free` 这类 `-free` 后缀模型在订阅端点（/zen/go）401
`Model ... is not supported`，只在按量付费端点（/zen）200；普通模型反之
（订阅端点 cost=0 不烧额度）。所以按模型后缀选 base URL，两者都要能用。

- 实现：[deepseek.ts:129-135](../../src/deepseek.ts) `resolveUpstreamBaseUrl`
  （`endsWith('-free') ? payAsYouGoBaseUrl : subscriptionBaseUrl`），实测依据注释见
  [deepseek.ts:122-128](../../src/deepseek.ts)
- 调用点：[upstream.ts:98](../../src/upstream.ts)（上游请求 baseUrl 选择）
- 记账侧同步：ctx.endpoint 按 `endsWith('-free')` 标 `payg`/`subscription`
  （[server.ts:2561](../../src/server.ts)、[server.ts:2970](../../src/server.ts)）；
  按量端点的 cost 才是真实成本（[server.ts:3060-3068](../../src/server.ts)）
- payAsYouGoBaseUrl 默认 https://opencode.ai/zen（[config.ts:256](../../src/config.ts)）

## 14. 显式 tool_choice 在按量端点（-free）400

与 Quirk 8 同源的上游事实：按量端点对显式 tool_choice 直接 400
（"Thinking mode does not support this tool_choice"，直通路径实测 190+ 条）。
订阅端点接受（OpenAI 合法字段），所以按端点有差别地剥。

- 直通路径：[toOpenAI.ts:61-66](../../src/toOpenAI.ts) —— tool_choice **无条件不输出**
  （剥掉 = OpenAI 默认 auto，与 Claude Code 默认行为一致；显式单工具的罕见场景
  退化为 auto，可接受，400 是实际伤害）
- chat 路径：[server.ts:2830-2836](../../src/server.ts) —— prepareOpenAIUpstreamRequest 内，
  仅 `-free` 模型剥 tool_choice，订阅端点保留（与直通路径语义对齐，修 chat 路径 400）
- 注意与 Quirk 8 的关系：Quirk 8 的旧解法（response_format 强制 thinking disabled）
  已随 request.ts 退役删除，现在的解法统一是「剥 tool_choice」
