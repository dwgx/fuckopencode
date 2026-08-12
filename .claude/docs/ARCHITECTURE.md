# 架构

## 为什么存在

Claude Code 和 Anthropic SDK 只会说 Anthropic Messages 协议。DeepSeek 便宜、
上下文大，但它的 Anthropic 兼容层有一批硬性差异（见 [DEEPSEEK-QUIRKS.md](DEEPSEEK-QUIRKS.md)）。
这个网关吃掉差异，让两边都不用改。

顺带暴露 OpenAI Chat Completions 端点，让 OpenAI 客户端也能用同一个上游。

## 上游协议：为什么走 OpenAI

**2026-08-09 改造。** 上游 opencode Zen 同时提供两套端点，但只有 OpenAI 那套可用：

| 能力 | `/v1/chat/completions` | `/v1/messages` |
|---|---|---|
| 工具调用 | `finish_reason: tool_calls` + 完整 tool_calls | `stop_reason: null`，`content: []` |
| content 字符串 | 接受 | 报 `Empty input messages` |

Claude Code 强依赖工具调用，所以 Anthropic 那条路实际不可用。现在统一从
OpenAI 出去，`/v1/messages` 走 Anthropic → OpenAI → 上游 → Anthropic。

端点还分订阅与按量：`-free` 后缀模型只在 `/zen`（按量）存在，其余走 `/zen/go`
（订阅，响应带 `cost: "0"`）。`resolveUpstreamBaseUrl` 按后缀选。

新增模块：`upstream.ts`（OpenAI 上游客户端 + 模型清单）、`toOpenAI.ts`
（Anthropic 请求 → OpenAI）、`toAnthropic.ts`（OpenAI 响应/流 → Anthropic）、
`keypool.ts`（多 key 池）、`keyprobe.ts`（空闲 key 主动探活）、
`usagedb.ts`（用量持久化，SQLite）、`metrics.ts` + `dashboard.ts`（监控面板）。

## 两条独立路径

关键设计：两个入口端点走**完全不同**的代码路径。这是最容易理解错的地方。
注意 2026-08-09 改造后 **chat 路径不再做协议转换**（上游本身就是 OpenAI
协议），只有直通路径做完整双向转换（[server.ts:549-551](../../src/server.ts)）：

```
/v1/messages（直通，完整双向转换）
  客户端说 Anthropic 协议，上游要 OpenAI 协议
  → validateAnthropicRequest        校验
  → normalizeAnthropicRequest       deepseek 归一化（模型名/thinking/effort/剥 beta 字段/注入 thinking 块）
  → scanMessagesForInjection        注入检测
  → anthropicToOpenAIRequest        协议转换（toOpenAI.ts：tool_result 拆独立 tool 消息等）
  → postUpstreamChat                转发（key 池 acquire + 失败分级；无换 key 重试，错误原文直接透传）
  → 非流式：openAIToAnthropicResponse        转换回 Anthropic（toAnthropic.ts，含 DSML 兜底）
  → 流式：openAIStreamToAnthropic + filterThinkingFromStream → anthropicEventToSSE

/v1/chat/completions（直发 OpenAI，无协议转换）
  客户端说 OpenAI 协议，上游也是 OpenAI 协议
  → validateChatRequest             校验
  → scanMessagesForInjection        注入检测
  → prepareOpenAIUpstreamRequest    模型映射 + buildSystemGuard 护栏 + 剥 8 个扩展字段（logit_bias/logprobs/top_logprobs/n/seed/user/store/metadata，防上游 400）
  → postUpstreamChat                转发（与直通路径共用）
  → 非流式：原样回显（只改 model 名）
  → 流式：parseOpenAISSE → 逐 chunk 回显（只改 model 名）→ [DONE]
```

**deepseek 适配的分布已经不对称**：直通路径的适配集中在
`normalizeAnthropicRequest`（deepseek.ts）；chat 路径因为直发 OpenAI 协议，
只剩「模型映射 + 剥扩展字段」这点工作，不再有 thinking/beta 字段适配。
历史上「改一处必须查另一处」的负担主要落在直通路径内部（deepseek.ts 的
归一化与 toOpenAI/toAnthropic 的协议转换各管一层，DSML 兜底在非流式/流式
两处接线）。见 [ISSUES.md](ISSUES.md) 的 I-3。

遗留的历史模块：`request.ts` / `normalize.ts` / `response.ts` / `stream.ts` /
`tool.ts` / `image.ts` / `usage.ts` / `stopReason.ts` / `parseAnthropicSSE`
（sse.ts）是 2026-08-09 改造前的转换链，server 主路径已不引用（只从
`stream.ts` 用 `sseStringify`、从 `sse.ts` 用 `parseOpenAISSE`），仍通过
`index.ts` 导出并在测试里作为行为契约活着。改这些文件只影响库用户和测试，
不影响网关行为。

## 模块职责

协议转换核心。注意：**server 主路径实际只用到 toOpenAI / toAnthropic /
dsml / deepseek 的直通链 + sse 的 `parseOpenAISSE`**，其余是改造前遗留的
转换链，经 `index.ts` 作为库导出面活着（供测试与外部引用）。

| 模块 | 职责 | 主路径状态 |
|---|---|---|
| `toAnthropic.ts` | OpenAI 响应/流 → Anthropic。含 DSML 兜底与流式文本缓冲、事件骨架生成 | 在用 |
| `toOpenAI.ts` | Anthropic 请求 → OpenAI（tool_result 拆成独立 tool 消息、image 降级占位） | 在用 |
| `dsml.ts` | 上游把工具调用当文本吐时的兜底解析（怪癖 12），非流式/流式两处接线 | 在用（被 toAnthropic 调） |
| `deepseek.ts` | 直通路径的适配层：模型映射、thinking 归一化、剥 beta 字段、thinking 块注入、流式过滤 | 在用 |
| `sse.ts` | OpenAI/Anthropic SSE 文本流 → 事件对象（`parseOpenAISSE` 在用，`parseAnthropicSSE` 历史） | 部分在用 |
| `stream.ts` | SSE 序列化（`sseStringify` 在用）；转换状态机历史 | 部分在用 |
| `request.ts` | OpenAI 请求 → Anthropic 请求，内联 deepseek 适配 | 历史 |
| `normalize.ts` | 消息序列规整：交替、合并、tool_result 紧跟、id FIFO | 历史 |
| `response.ts` | Anthropic 响应 → OpenAI 响应，json_mode 转 content | 历史 |
| `tool.ts` | 工具结构转换 + schema 消毒 + 工具名消毒 | 历史 |
| `image.ts` | 图片块转换 + SSRF 判定 | 历史 |
| `usage.ts` / `stopReason.ts` | 字段换算 | 历史 |

服务层：

| 模块 | 职责 |
|---|---|
| `main.ts` | 进程入口，装配 config + server |
| `server.ts` | 路由、鉴权装配、背压写入、流式连接管理 |
| `upstream.ts` | 上游转发（OpenAI 协议），120s 响应头超时，key 池集成，幂等 release |
| `keypool.ts` | 多 key 公平轮转、失败分级冷却（只延长不缩短）、指纹脱敏 |
| `keyprobe.ts` | 空闲 key 主动探活（默认 30 分钟一轮，最小 token） |
| `usagedb.ts` | 用量持久化（node:sqlite，零依赖），降级不抛，history 15s 缓存 |
| `config.ts` | 环境变量解析，fail-closed 判定 |
| `errors.ts` | 错误映射 + 控制符剥离 + 上游失败分级 |
| `metrics.ts` | 请求事件环形缓冲（喂面板） |
| `dashboard.ts` | 自带的状态面板（HTML 内联，零依赖） |
| `types.ts` | 两套协议的类型定义 |
| `index.ts` | 库导出面（供测试与外部引用） |
| `security/auth.ts` | 常量时间鉴权 |
| `security/validate.ts` | 结构校验 + 长度上限 |
| `security/injection.ts` | 注入启发式检测 + system 护栏 |

## normalize 维护的不变量

以下约束属于历史转换链（`normalize.ts`，库导出面），**不约束当前网关主路径**。
直通路径的等价约束由 `toOpenAI.ts` 承担（Anthropic 协议比 OpenAI 严格得多，
这些约束违反了就 400）：

1. 首条必须是 user（开头的 assistant 被丢弃，随之孤立的 tool_result 也丢）
2. 末条不能是 assistant（追加空 user 占位）
3. 严格 user/assistant 交替（相邻同角色合并）
4. tool_result 必须紧跟产生它的 assistant（所以含 tool_result 的 user
   **不与**普通 user 合并 —— [normalize.ts:173](../../src/normalize.ts)）
5. content 不能为空（空消息跳过；全空时兜一条空 user）
6. tool_use.id 与 tool_result.tool_use_id 一一对应（缺 id 时走 FIFO 队列配对）

## 安全分层

- L1 鉴权：`API_KEYS` 命中才放行，常量时间比较。空 key + 未开
  `ALLOW_UNAUTHENTICATED` 时全部拒绝（`/healthz` 例外，无需鉴权）
- L2 结构校验：role 白名单、长度上限、消息条数上限、tool_choice 结构
- L3 注入检测：启发式复合信号，`block` 模式只拦 high
- L4 system 护栏：声明历史/工具结果为不可信数据（**只在 chat 路径生效**）

`ALLOW_UNAUTHENTICATED` 只在绑定回环地址时才真正生效
（[config.ts:93](../../src/config.ts) `hostnameIsSafe`），绑 `0.0.0.0` 时强制要求鉴权。
