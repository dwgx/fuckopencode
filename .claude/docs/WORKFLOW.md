# fuckopencode 开发工作流（WORKFLOW）

> 本文件是项目定制的 AI 辅助开发工作流——基于主流实践研究（Anthropic 官方 best-practices /
> memory / sub-agents + 社区共识）与项目自身实战教训（state.md 三十节的反复事故）定制。
> 参考过 origin 的层级配置（covenant/lexicon/chronicle 分层），只取其「分层组织」精神，
> 不照搬其业务层。**目标是：稳定、可验证、不返工。**

## 核心循环

```
Plan（写 spec）→ 拆 Task → 派发（fresh subagent）→ 实现（TDD 红绿）→
每 Task 门禁 review → 全套验证 → 文档/状态同步 → 波次复盘（记教训）
```

- **小改动直接做，跳过 Plan**（一行式 diff 不配走完整循环）。
- **Plan 只在三种情况必须**：多文件改动 / 陌生代码 / 有不确定性。Plan 是假设不是合同——
  探索推翻计划就改计划，并记录为什么改。

## 各阶段关键实践

### 1. Plan
- spec 点名：涉及文件、接口签名（type 一致性是 plan 最常见的 bug）、边界、out-of-scope、
  「端到端验证步骤」收尾。写精确 spec 的时间比盯着实现返工的时间值。
- **两条领域硬规则必须进 plan**：
  - 改 chat 路径要检查直通路径（两套实现，改一处忘另一处是反复事故根因）。
  - 删「看起来多余的兜底逻辑」前查 `DEEPSEEK-QUIRKS.md`（兜底基本对应 DeepSeek 怪癖）。

### 2. 派发（subagent）
- 每个 task 一个 fresh subagent，prompt 五要素：真实目标 / 负责的具体问题 / 已确认事实 /
  相关文件路径 / 验收标准与证据要求。
- **固定以「先读 .claude/CONTEXT.md（或项目 AGENTS.md）当作已确认事实」开头**——
  文件存在 ≠ 被读了。
- 并行纪律（8GB 机器）：探查类放开；执行/构建类 ≤5；嵌套 ≤3 层。写进委派约定，不口头说。
- 易错：把整段会话历史倒进 prompt（99% 是历史噪音）；委派后不核实（证据优于自信——
  空返回 = 失败要重派）。

### 3. 实现（TDD 是默认）
- 每 task 先写失败测试（红）→ 最小实现 → 跑过（绿）。bug 修复先写复现测试。
- 「应该能过」不是证据——报告必须带命令输出（测试数字 / exit code）。
- 跑单文件/单测试，不整套全跑（1600 个全跑拖垮迭代）。

### 4. Review（门禁）
- 每 task 一个 review（fresh reviewer，给原始目标/验收标准/diff/证据，**不给作者自辩**）。
- **review prompt 必须写「只报影响正确性或需求的问题，样式偏好一律不算」**——
  这是防 over-engineering 的官方明确手段（被要求「找 gap」的 reviewer 总会找些东西）。
- fix loop 最多 5 轮；3 轮未收敛换 fresh + 更强模型（当前实现者看不见自己的问题）。
- Minor 发现记 ledger 延迟到终审统一 triage，不追着修。

### 5. 验证（verification before completion）
| 门禁 | 时机 | 谁跑 |
|---|---|---|
| 失败测试 | 实现前 | 实现 subagent（先红） |
| typecheck / 单测 | task 完成时 | 实现 subagent（自带输出） |
| per-task review | 每 task 后 | fresh reviewer |
| 全套测试 + typecheck + i18n | 合并/部署前 | 主控 |
| 真实端到端（smoke 19 项） | 部署后 | 主控 |
| 浏览器逐元素 | UI 改动 | 主控 |

### 6. 文档/状态同步
- **代码合入那一刻同步文档**，不等功能完成（文档漂移的最大来源是「等会儿再写」）。
- 每波次结束更新状态文件：记决策 + 进度 + 证据（commit hash / file:line），**不带指代词**。
- 压缩后第一动作读状态文件恢复（`.opencode/state.md` + `.claude/state/CURRENT.md` 双份）。

### 7. 复盘/记忆（每波次结束）
- 记 learnings（什么有效/什么避免）+ 用证据决定是否更新 AGENTS.md 规则。
- **被纠正两次的错误才进规则**；规则精简（否则等于没有）。
- 分层组织参考 origin 精神：原则（CLAUDE.md）/ 术语（CONVENTIONS）/ 教训（ISSUES + state）。
  不为分层而分层——我们规模用两层（项目根规则 + 维护者文档）足够。

## 避免的坑（对照本项目实战教训）

| 坑 | 防护 |
|---|---|
| 幻觉修复（说修好了没真跑） | 红绿循环 + 报告带命令输出 |
| over-engineering | review 限范围 + YAGNI 进 rubric |
| 文档漂移 | 文档和代码同轮合入；改代码先查被引用的 docs |
| 上下文污染 | 大任务按波次开新会话；压缩后先读状态文件 |
| subagent 静默失败 | 要求报证据；写盘关键步骤主控用 git diff 亲自核实 |
| context rot | 跨多域复杂任务，主控留在编排层不下场实现 |
| 单位/口径散落 | 单一真源（money.ts / EXCLUDE_OBSERVED / i18n 脚本） |
| 双路径漂移 | 抽公共函数 + 「改一处查另一处」进 plan |

## 质量门禁清单（部署前必跑）

```
npm run typecheck     # tsc --noEmit
npm run check:i18n    # 三语言对称核对（en/zh/ja）
npm test              # 全量 vitest
node scripts/smoke-test.mjs  # 19 项真实链路（部署后）
scripts/check-i18n.mjs       # 见 package.json check:i18n
```
