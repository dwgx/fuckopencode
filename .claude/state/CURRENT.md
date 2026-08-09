# 当前状态

更新时间：2026-08-09

## 基线

`npx tsc --noEmit` 干净，`npx vitest run` 210 passed（10 files）。
依赖已装。注意 `tsc`/`vitest` 不在 PATH，用 `npx`。

## 线上

nbus（`ssh nbus`）已部署并验证，见 [DEPLOY.md](../docs/DEPLOY.md)。
上游改走 **OpenAI 协议 + 订阅端点** `/zen/go`（cost=0），`-free` 模型自动走按量端点。

验证过的：messages 非流式返回正文、工具调用 `stop_reason: tool_use` +
`input: {"city":"北京"}`、chat 带 reasoning_effort、流式 74 个事件、
监控面板无 key 401 / 带 key 200。key 池 2/2，上游模型 25 个。

## 这轮做了什么

**文档整理**

建了 `.claude/docs/` 维护者文档区。宣传落地页从 `docs/index.html` 降级到
`docs/site/index.html` 并重写（左右对照「直连会撞什么报错 → 网关做了什么」），
浏览器验证过桌面/移动布局。README 去掉会过期的测试数字，补了漏掉的
`STRIP_CONTROL_CHARS`。

**keypool 重建（关键）**

线上跑的版本比本地新，带一个本地完全没有的 `keypool` 模块（多 key 池 +
失败熔断 + 冷却），而服务器上没有源码、没有 git remote。从 `dist/` 的
`.js` + `.d.ts` 反推重建了 `src/keypool.ts`，并补回四处一起丢失的逻辑：

- `errors.ts` 的 `classifyUpstreamFailure`（失败分级）
- `deepseek.ts` 的 `completeStreamEvents`（补全 SSE 事件骨架）+ web_search 剥离
- `sse.ts` 的裸 JSON 行解析 + `{}` 心跳跳过
- `tool.ts` 的 `$ref` 降级 + 七键白名单 + properties 特殊处理
- `stream.ts` 的 `partial_json` 计入 token 估算

重建后逐文件对比编译产物与线上 `dist/`（忽略注释/空白），确认只剩有意的改动。
新增 20 个 keypool 测试。

**修的 bug**

- chat 端点发顶层 `reasoning_effort`（DeepSeek 必 400）→ 改 `output_config.effort`
- 流式漏发 `finish_reason`（上游只发 `message_stop` 时）→ 加 `emittedFinish` 兜底
- **content 字符串上游报 Empty input messages** → 归一化转内容块数组。
  这条是部署时实测发现的，旧版本同样有，不是本轮回归

## 未提交

工作区有大量改动没提交，包括 keypool 重建、bug 修复、文档区、落地页重写。
提交前 `git diff` 确认范围。`.deploy-backup/` 是线上 dist 备份，**不要提交**
（需要加进 `.gitignore`）。

## 下一步

看 [PLAN.md](../docs/PLAN.md)。优先级 1 仍是消掉双路径适配债（I-3）——
本轮又一次印证了它的危害：keypool 只接在直通路径，chat 路径的 deepseek
适配是另一套。

## 监控面板

`/__dash`（页面）+ `/__metrics`（JSON）。设计对齐 opencode 的 token 体系
（爬他们编译 CSS 与 `packages/ui/src/styles/theme.css` 得到）：全站等宽、
零渐变零阴影、圆角 4px、文字用 rgba 透明度分级、单一强调色 `#9dbefe`、
`[*]` 与 `Fig n.` 记号、`█▀▄`+`_^~` 半块 ASCII banner（照 `packages/tui/src/logo.ts` 的写法）。

**面板要求 API key**（`DASHBOARD_OPEN=0`）—— cloudflared 隧道把 8787 整体
暴露成 `fuckopencode.dwgx.top`，而面板含调用方 IP 与 UA。

请求日志从 15 列宽表改成两行式条目：第一行固定列扫读，第二行细节 flex-wrap
自动换行。之前宽表 15 列挤在 1080px 里会叠字，footer 也只有 4px 间距贴住表格。

## 待你决定

- `I-5`：`/v1/messages` 要不要加 system 护栏
- 上游 key 与客户端 key 曾以明文进对话，建议轮换（SECRETS.md 第 126 行记过同类教训）
- `deepseek-v4-flash-free` 的 output_tokens 偏高（一次「部署成功」耗 2139 token），
  要不要查是不是 thinking 计入

## 坑

- 这个项目约 3000 行源码，直接读比派 subagent 稳。本轮曾派 6 个 agent，
  5 个因 API 错误死掉、1 个丢失进程状态。
- **判断线上与本地差异时，要对比编译产物，不能只读源码。** 本轮靠逐文件
  diff 才发现四处本地缺失的逻辑，只看 keypool 会漏掉。
- 服务 active 不代表能用 —— 零上游 key 也能正常启动监听。必须发真实请求。
