# 当前状态

更新时间：2026-08-09 20:30

## 一句话

OpenAI ↔ Anthropic 协议转换网关（面向 DeepSeek），线上跑在 nbus，功能完整、测试全绿。
最近一轮工作全在修 DeepSeek 上游怪癖，不是加功能。

## 基线（已验证）

| 项 | 状态 |
|---|---|
| `npx tsc --noEmit` | 干净 |
| `npx vitest run` | 275 passed（11 files） |
| 线上 nbus | `active`，`/healthz` ok，key 池 2/2 |
| 最新 commit | `3f844a7` |

线上部署方式见 [DEPLOY.md](../docs/DEPLOY.md)。改代码前先读
[DEEPSEEK-QUIRKS.md](../docs/DEEPSEEK-QUIRKS.md)。

## 未提交

- `.claude/docs/DEEPSEEK-QUIRKS.md` — 新增第 12 条（DSML 泄漏）
- `src/anthropic.ts` 已 `git rm` — 死代码（被 `upstream.ts` 取代，全仓零引用，
  删后 typecheck + 275 测试均通过）

这两项可以直接提交，不需要额外验证。

## 这轮做完的事（2026-08-09）

按时间倒序，每条都已部署到 nbus 并验证：

1. **DSML 泄漏兜底**（`3f844a7` + `b3ace1a`）— 上游偶发把工具调用当文本吐，
   客户端看到裸 `invoke` 文本、工具不执行。新增 [dsml.ts](../../src/dsml.ts)
   还原成 `tool_use` 块并纠正 `stop_reason`。**注意两版的区别**：第一版正则假设
   「外层包一层 DSML」，实测格式是「每个标签自带前缀」，第一版等于空操作，
   `3f844a7` 才是有效的那版。
2. **图片块降级**（`6826069`）— 上游解析图片失败打成 400，改为降级文本占位。
3. **system 消息放行 + thinking 全量回传**（`0baac21`）。
4. **key 池公平轮转 + 额度耗尽长冷却**（`8cc54cb`）。

## 下一步（按价值排序）

见 [PLAN.md](../docs/PLAN.md) 的完整清单。当前最该做的：

1. **修 key 池 `quota-exhausted` 误判**（有实证，未修）。
   [errors.ts:155-159](../../src/errors.ts) 的 `/balance|credit|billing|quota/i`
   正则过宽，把含 "quota" 字样的非额度错误也判成额度耗尽 → 1 小时长冷却。
   **实测后果**：两个 key 直连上游都返回 200，却双双被禁，网关整池返回
   `all upstream keys are disabled`。重启服务才恢复。
   修法方向：收窄正则，或让 `quota-exhausted` 只在明确的 `GoUsageLimitError` /
   带 reset 时间的响应上生效，其余归 `rate-limit`（短冷却）。
2. 消掉双路径适配债（PLAN 优先级 1）— chat 路径和直通路径是两套 deepseek 适配
   实现，改一处必须检查另一处。这是当前最大的维护风险。

## 环境须知

- `tsc` / `vitest` 不在 PATH，用 `npx` 或 npm script
- 线上操作走 `ssh nbus`
- 常用命令见 [CLAUDE.md](../../CLAUDE.md)

## 不要做的事

- 不要因为「看起来多余」就删兜底逻辑 —— 基本每条都对应一个 DeepSeek 怪癖，
  删之前查 DEEPSEEK-QUIRKS.md
- 不要只改一条路径的 deepseek 适配
- 不要引入运行时依赖（零依赖是刻意的）
