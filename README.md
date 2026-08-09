# fuckopencode

OpenAI ↔ Anthropic 协议转换网关，面向 DeepSeek。

把便宜的 DeepSeek 模型（`deepseek-v4-flash`，100 万 token 上下文）包装成 Anthropic Messages API 兼容端点，同时暴露 OpenAI Chat Completions 端点。Claude Code、Anthropic SDK、任意 OpenAI 客户端，通过一个网关直接使用 DeepSeek，无需关心两种协议之间的差异。

## 特性

- 零运行时依赖的纯 TypeScript 转换核心（strict 模式、零 any）
- OpenAI ↔ Anthropic 双向协议转换
- DeepSeek 思考协议深度适配：
  - `thinking: adaptive` → `enabled` 归一化（Claude Code 默认发 `adaptive`，DeepSeek 直接 400）
  - 多轮工具自动注入 thinking 块（DeepSeek 要求 reasoning 回传，否则间歇 400）
  - `thinking: disabled` 时剥除响应流中多余的 thinking 事件
  - `reasoning_content` ↔ `thinking` 块双向映射
  - `reasoning_effort` 透传
- JSON mode 真实现：`response_format` 经工具强制后转回 `content`，`finish_reason=stop` 与 OpenAI 原生对齐
- 流式转换逐事件打磨：`reasoning_content` 增量、usage 独立尾 chunk、背压、`[DONE]`
- 多轮工具稳定：`tool_use` / `tool_result` id 一一对应（FIFO）
- 生产级安全：常量时间鉴权、提示词注入检测、SSRF 防护（含 IPv6）、CSRF、背压、内部错误不泄漏
- 完整单元/集成测试覆盖 + 真实上游端到端验证

## 快速开始

```bash
npm install
npm run build

# 启动（把 ANTHROPIC_API_KEY 换成你的上游 key）
API_KEYS=demo-key ANTHROPIC_API_KEY=sk-ant-xxx npm run serve
```

### OpenAI 客户端

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer demo-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"1+1=? 只回数字"}]}'
```

模型名按 `MODEL_MAP` 映射，未命中回落 `deepseek-v4-flash`。

### Anthropic / Claude Code

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: demo-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```

Claude Code 直接指过来：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
ANTHROPIC_AUTH_TOKEN=demo-key \
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-flash \
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash \
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash \
claude
```

## 端点

| 路径 | 协议 | 说明 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI | 转换 → DeepSeek，流式/非流式 |
| `POST /v1/messages` | Anthropic | 直通 + DeepSeek 归一化，流式/非流式 |
| `POST /v1/messages/count_tokens` | Anthropic | Claude Code 记账 |
| `GET /v1/models` | OpenAI | 模型发现 |
| `GET /healthz` | — | 健康检查 |

## 配置

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `API_KEYS` | 空 | 调用方鉴权 key，逗号分隔；空则 fail-closed 拒绝 |
| `ANTHROPIC_API_KEY` | 空 | 上游 DeepSeek/Anthropic key |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | 上游 base URL |
| `MODEL_MAP` | 空 | 模型名映射，如 `gpt-4o:deepseek-v4-flash` |
| `DEFAULT_MODEL` | `deepseek-v4-flash` | 未命中映射的兜底模型 |
| `INJECTION_MODE` | `block` | 注入检测：`block`/`log`/`off` |
| `ALLOW_UNAUTHENTICATED` | `0` | 仅本地绑定时可开（fail-closed） |
| `TRUST_CLAUDE_CODE_HEADERS` | `0` | 是否透传 `x-claude-code-*` 会话头 |
| `MAX_BODY_BYTES` | `10485760` | 请求体上限 |
| `MAX_MESSAGE_CHARS` | `200000` | 单条消息文本上限 |
| `STRIP_CONTROL_CHARS` | `1` | 剥离日志/转发内容里的控制符 |

## 架构

```
src/
├── index.ts            # 库导出入口
├── request.ts          # OpenAI 请求 → Anthropic 请求（核心转换）
├── normalize.ts        # 消息规整：交替/tool_result 紧跟/thinking 注入/id FIFO
├── response.ts         # Anthropic 响应 → OpenAI 响应（含 json_mode 转 content）
├── stream.ts           # Anthropic SSE → OpenAI chunk（流式转换器）
├── sse.ts              # Anthropic SSE 行解析
├── deepseek.ts         # DeepSeek 归一化（thinking/effort/过滤/注入）
├── tool.ts             # 工具结构转换 + schema 消毒
├── image.ts            # 图片块转换 + SSRF 防护
├── usage.ts            # usage 换算
├── stopReason.ts       # stop_reason ↔ finish_reason
├── errors.ts           # 错误映射 + 控制符剥离
├── anthropic.ts        # 上游转发（超时/header）
├── config.ts           # 环境配置
├── server.ts           # HTTP 服务 + 路由 + 安全装配
├── security/
│   ├── auth.ts         # 鉴权（timingSafeEqual, fail-closed）
│   ├── validate.ts     # schema 校验 + 长度上限
│   └── injection.ts    # 提示词注入检测 + system 护栏
└── main.ts             # 服务入口
```

维护者文档（架构决策、DeepSeek 怪癖清单、已知问题、计划）在 `.claude/docs/`，
入口见 [.claude/docs/README.md](.claude/docs/README.md)。

## 测试

```bash
npm test           # 单测，全部本地，不碰网络
npm run test:live  # 真实 DeepSeek 上游端到端 probe（需服务在跑）
```

`test:live` 覆盖：基本对话、多轮工具（第二轮必须 200）、JSON mode（`finish_reason=stop` + content 是 JSON）、流式 `[DONE]` + usage、Anthropic 直通多轮工具。

## License

MIT
