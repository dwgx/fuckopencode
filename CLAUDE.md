# CLAUDE.md

本文件是项目的根本规则，优先于其他所有约定。

## 铁律

1. **绝对禁止**任何 git commit 带有 Claude / claude code 署名。
   包括但不限于：`Co-Authored-By: Claude`、`Co-Authored-By: Anthropic`、提交信息中出现的 `claude`、`claudecode`、`Anthropic` 等署名标记。
   所有提交只署名仓库作者（`dwgx`），或完全不署名。
2. **所有 Markdown 文档禁止使用 emoji**。README、CLAUDE.md、任何 `.md` 文件一律纯文本，不用 emoji 装饰。

## Git 规范

- 提交信息用中文或英文，简洁、说明性，不带署名后缀。
- 提交前确认没有 `Co-Authored-By` 行：`git log --format='%H %an %s%n%b' -1`。
- 不擅自 force push；force push 需用户明确授权。
- 不提交 `dist/`、`node_modules/`、`.env`、密钥文件（已在 `.gitignore`）。

## 项目简介

OpenAI ↔ Anthropic 协议转换网关，面向 DeepSeek。暴露 OpenAI `/v1/chat/completions` 与 Anthropic `/v1/messages` 端点，把 DeepSeek 模型包装成 Anthropic 兼容协议。

## 常用命令

```bash
npm run build      # tsc 构建到 dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest 单测（173 个）
npm run serve      # 构建并启动服务
npm run test:live  # 真实上游端到端 probe
```
