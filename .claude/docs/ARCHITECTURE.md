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
`keypool.ts`（多 key 池）、`metrics.ts` + `dashboard.ts`（监控面板）。

## 两条独立路径

关键设计：两个入口端点走**完全不同**的代码路径。这是最容易理解错的地方。

```
/v1/messages（直通）
  客户端已经在说 Anthropic 协议
  → validateAnthropicRequest        校验
  → normalizeAnthropicRequest       deepseek 归一化（模型名/thinking/effort/剥 beta 字段）
  → postAnthropic                   转发
  → 响应：enabled 走字节透传；disabled 走 SSE 解析→剥 thinking→重新序列化

/v1/chat/completions（转换）
  客户端说 OpenAI 协议
  → validateChatRequest             校验
  → scanMessagesForInjection        注入检测
  → openAIToAnthropicRequest        协议转换（这里内联了 deepseek 适配）
  → buildSystemGuard                加指令隔离护栏
  → postAnthropic                   转发
  → anthropicToOpenAIResponse       非流式转换
  → anthropicStreamToOpenAI         流式转换 → openAIStreamToSSE → [DONE]
```

**deepseek 适配在两条路径上是分别实现的**：直通路径调
`normalizeAnthropicRequest`，chat 路径靠 `request.ts` 自己内联处理。
这是已知的重复，改 deepseek 行为时**两边都要改**，否则出现单边 bug
（历史上 `reasoning_effort` 就是这么坏的）。见 [ISSUES.md](ISSUES.md) 的 I-1。

## 模块职责

协议转换核心（纯函数，零依赖，可独立作为库用）：

| 模块 | 职责 |
|---|---|
| `request.ts` | OpenAI 请求 → Anthropic 请求，内联 deepseek 适配 |
| `normalize.ts` | 消息序列规整：交替、合并、tool_result 紧跟、id FIFO |
| `response.ts` | Anthropic 响应 → OpenAI 响应，json_mode 转 content |
| `stream.ts` | Anthropic SSE 事件 → OpenAI chunk 状态机 |
| `sse.ts` | Anthropic SSE 文本流 → 事件对象（处理跨包半行） |
| `tool.ts` | 工具结构转换 + schema 消毒 + 工具名消毒 |
| `image.ts` | 图片块转换 + SSRF 判定 |
| `usage.ts` / `stopReason.ts` | 字段换算 |
| `deepseek.ts` | DeepSeek 归一化，直通路径的适配层 |

反向转换（OpenAI → Anthropic，直通路径用）：

| 模块 | 职责 |
|---|---|
| `toAnthropic.ts` | OpenAI 响应/流 → Anthropic。含 DSML 兜底与流式文本缓冲 |
| `toOpenAI.ts` | Anthropic 请求 → OpenAI（tool_result 拆成独立 tool 消息） |
| `dsml.ts` | 上游把工具调用当文本吐时的兜底解析（怪癖 12） |

服务层：

| 模块 | 职责 |
|---|---|
| `main.ts` | 进程入口，装配 config + server |
| `server.ts` | 路由、鉴权装配、背压写入、流式连接管理 |
| `upstream.ts` | 上游转发（OpenAI 协议），120s 响应头超时，key 池集成 |
| `keypool.ts` | 多 key 公平轮转、失败分级冷却、指纹脱敏 |
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

Anthropic 协议比 OpenAI 严格得多，这些约束违反了就 400：

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
