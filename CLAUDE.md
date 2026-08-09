# CLAUDE.md

本文件是项目的根本规则，优先于其他所有约定。

## 铁律

1. **绝对禁止**任何 git commit 带有 Claude / claude code 署名。
   包括但不限于：`Co-Authored-By: Claude`、`Co-Authored-By: Anthropic`、提交信息中出现的 `claude`、`claudecode`、`Anthropic` 等署名标记。
   所有提交只署名仓库作者（`dwgx`），或完全不署名。
2. **所有 Markdown 文档禁止使用 emoji**。README、CLAUDE.md、任何 `.md` 文件一律纯文本，不用 emoji 装饰。

## 工具优先级

本仓库已配好工具，优先用它们，别用低配替代（全局铁律里违反最多的就是这几条）：

- **查代码用 CodeGraph**：本仓库有 `.codegraph/` 索引。搞清符号、调用链、改动影响面时，先 `codegraph explore "<问题>"` 或 `codegraph_explore`，再决定要不要读文件。别一上来就 `grep`。
- **搜文件用 `rg`，不用 `grep`**；找文件用 `fd`，不用 `find`。
- **读文件用 Read 工具**，不用 `cat`/`head` 去读代码。
- **跑完 `gradle` 记得 `gradle --stop`**（全局铁律，8 GB 机器扛不住常驻 daemon）。

## Git 规范

- 提交信息用中文或英文，简洁、说明性，不带署名后缀。
- 提交前确认没有 `Co-Authored-By` 行：`git log --format='%H %an %s%n%b' -1`。
- 不擅自 force push；force push 需用户明确授权。
- 不提交 `dist/`、`node_modules/`、`.env`、密钥文件（已在 `.gitignore`）。

## 项目简介

OpenAI ↔ Anthropic 协议转换网关，面向 DeepSeek。暴露 OpenAI `/v1/chat/completions` 与 Anthropic `/v1/messages` 端点，把 DeepSeek 模型包装成 Anthropic 兼容协议。

## 文档区

**动代码前先读 `.claude/docs/`。** 那里是维护者文档，规划见 [.claude/docs/README.md](.claude/docs/README.md)。

| 文件 | 什么时候读 |
|---|---|
| [.claude/state/CURRENT.md](.claude/state/CURRENT.md) | 会话开始必读，交代当前进度；会话结束前更新它 |
| [.claude/docs/DEEPSEEK-QUIRKS.md](.claude/docs/DEEPSEEK-QUIRKS.md) | 改任何 deepseek 适配逻辑前必读 |
| [.claude/docs/ARCHITECTURE.md](.claude/docs/ARCHITECTURE.md) | 搞清两条端点路径的差异 |
| [.claude/docs/ISSUES.md](.claude/docs/ISSUES.md) | 已知问题，别重复排查 |
| [.claude/docs/DEPLOY.md](.claude/docs/DEPLOY.md) | 部署或改线上前必读（nbus） |
| [.claude/docs/PLAN.md](.claude/docs/PLAN.md) | 接下来做什么 |
| [.claude/docs/CONVENTIONS.md](.claude/docs/CONVENTIONS.md) | 写代码/提交前对一遍风格 |

文档分工：`README.md` 给使用者，`.claude/docs/` 给维护者，`docs/site/` 是对外宣传页（独立产物，不是文档）。

两条硬约束：

- 那些「看起来多余」的兜底逻辑基本都对应一个 DeepSeek 怪癖，删之前先查 DEEPSEEK-QUIRKS.md。
- deepseek 适配在 chat 路径和直通路径是**两套实现**，改一处要检查另一处。

## 常用命令

`tsc` 和 `vitest` 不在 PATH，用 `npx` 或 npm script。

```bash
npm run build      # tsc 构建到 dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest 单测
npm run serve      # 构建并启动服务
npm run test:live  # 真实上游端到端 probe（需服务在跑 + 真 key）
```
