# fuckopencode —— 项目背景（给 subagent 看）

本文件是**专门给 subagent 的项目背景**。主会话和 subagent 都应该先读这里再动手，
避免每次从零摸索、重复理解。读到的内容当作已确认事实，不要重新验证。
详细文档见 `.claude/docs/`，本文件只是浓缩。

## 这是什么

OpenAI ↔ Anthropic 协议转换网关，面向 DeepSeek。暴露 OpenAI `/v1/chat/completions`
和 Anthropic `/v1/messages` 端点，把 DeepSeek 模型包装成 Anthropic 兼容协议。
纯 TypeScript、**零运行时依赖**（无 express/fastify，用 Node 原生 `http`）、
strict 模式、ESM、Node >= 20。测试用 vitest。部署在 2 核/1.9G 内存 VPS，
systemd 限制 `MemoryMax`，经 Cloudflare 隧道公网暴露。

## 为什么存在（这个项目的核心价值）

DeepSeek（经 opencodezen 网关）声称兼容 Anthropic Messages API，但有一批硬性差异，
标准 Anthropic 客户端直接打过去会 400/401。**每一条差异都对应代码里的一处 workaround。**

**改任何协议适配代码前，必读 `.claude/docs/DEEPSEEK-QUIRKS.md`。** 否则很容易把
「看起来多余的兜底」删掉，然后线上间歇 400。那个文件里每条都标了对应源码位置。

几个已知怪癖（完整清单看 DEEPSEEK-QUIRKS.md）：
- 只认精确模型名：`claude-sonnet-4-6` 上游 401，必须映射成 `deepseek-v4-flash`
- 工具调用返回空 content 是坏的（opencodezen 的 Anthropic 兼容层），需要 workaround
- **协议转换在 chat 路径和直通路径是两套实现**，改一处必须查另一处

## 代码结构（已确认）

- `src/` 下有 index/m/deepseek 等模块。`src/deepseek.ts` 有 `resolveModelName` 和
  `MODEL_MAP`，未命中回落 `DEFAULT_MODEL`。三条路径都要做模型映射：
  `/v1/messages`、`/v1/chat/completions`、`/v1/messages/count_tokens`
- count_tokens 曾漏做模型映射，导致 Claude Code 记账 401（已修）

## 已知问题与部署

- 已知问题见 `.claude/docs/ISSUES.md`，**别重复排查**已记录的问题
- 部署方式见 `.claude/docs/DEPLOY.md`，改线上前必读
- 当前进度见 `.claude/state/CURRENT.md`
- 所有 git 提交禁止带 Claude 署名；所有 Markdown 禁止 emoji

## 给 subagent 的提醒

- 有 `.codegraph/` 索引，先 `codegraph explore` 再 grep
- 搜内容用 `rg` 不用 `grep`，找文件用 `fd` 不用 `find`
- 读文件用 Read 工具不用 `cat`/`head`
- 涉及 key/secret 先读 `~/.claude/SECRETS.md`，值绝不 echo/写文件/进 commit
