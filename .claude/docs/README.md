# 文档区约定

这个目录是维护者文档区，只给接手这个项目的人（和 Claude）看。
面向外部用户的东西不放这里。

## 分工

| 位置 | 给谁看 | 放什么 |
|---|---|---|
| `/README.md` | 使用者 | 怎么装、怎么跑、有哪些端点和配置项 |
| `/CLAUDE.md` | Claude | 铁律、提交规范、常用命令 |
| `.claude/docs/` | 维护者 | 架构决策、问题清单、计划、接手状态 |
| `.claude/state/CURRENT.md` | 下一个会话 | 当前进度，会话结束前更新 |
| `docs/site/` | 外部访客 | 宣传落地页，独立产物，不是文档 |

## 文件清单

- `ARCHITECTURE.md` — 数据流与模块职责，为什么需要这个网关
- `DEEPSEEK-QUIRKS.md` — DeepSeek/opencode Zen 与真 Anthropic 的差异清单，本项目的真正价值
- `DEPLOY.md` — nbus 线上部署：访问方式、更新流程、验证清单、坑
- `ISSUES.md` — 已知问题，按严重度排，带文件行号和复现条件
- `PLAN.md` — 接下来做什么，按优先级
- `CONVENTIONS.md` — 代码与提交风格
- `SHIELD.md` — 护盾（kiro_shield.py）行为与端口约定（**已退役停用**，2026-08-15 去盾）
- `MULTI-ACCOUNT.md` — 多账号面板实现契约（表结构/API/模块划分/已知取舍/legacy 通道）
- `MODEL-ACCESS.md` — 密钥-模型授权（四级授权链/任意模型可扩展/Model Access tab）
- `QUOTA.md` — 分发密钥配额计费（$ 单位 microCents/周期重置/定价表/B1·M1-M3 修复）
- `OTA.md` — GitHub OTA 自更新（release 管线/守卫回滚/rollback 4 场景）
- `ADMIN-LAYOUT.md` — 管理面板布局设计（tab 结构/设置页/移动端）
- `CONSOLE-PORT.md` — 新版控制台（console.opencode.ai）REST 端点实测记录
- `CONSOLE-P0-ENDPOINTS.md` — console 端点 P0 契约（分页字段/返回形状）
- `docs/PERFORMANCE.md` — 性能实测报告（2026-08-15 nbus 实测：内存/延迟/吞吐/并发门/复测方法；在 `docs/`，不是本目录）

（`WORKFLOW.md` 将由主控另行撰写，届时再补入清单。）

## 规则

写文档时遵守：

1. **不用 emoji**（项目铁律，所有 `.md` 一律纯文本）。
2. **论断要带 `文件:行号`**，没验证过的写明「未验证」。
3. **不写会立刻过期的东西** —— 测试数量、覆盖率这类数字只在 README 出现一次，
   其他地方引用而不复制。
4. **问题清单区分「确认」与「可疑」**，确认的要有复现路径。
5. 相对日期一律转成绝对日期。
