# 当前状态

更新时间：2026-08-09 21:30（第二轮会话）

## 一句话

OpenAI ↔ Anthropic 协议转换网关（面向 DeepSeek），线上跑在 nbus，功能完整。
上一轮遗留两个待办（quota 误判 + 流式兜底），本轮深挖后发现**两件事的定位都不准**，
已重构为真实根因 + 修复，待部署。

## 基线（已验证）

| 项 | 状态 |
|---|---|
| `npx tsc --noEmit` | 干净 |
| `npx vitest run` | 292 passed（11 files，+16 vs 上轮 276） |
| 线上 nbus | `active`，`/healthz` ok |
| 工作区 | 4 个文件有改动，**未提交、未部署** |

## 本轮最重要的发现：待办 1 的定位是错的

CURRENT.md 上一轮把线上 503 归因于 errors.ts 的 `/balance|credit|billing|quota/i`
过宽正则「把含 quota 字样的错误判成额度耗尽 → 1h 长冷却」。

**查证后这条路径从未存在**：quota-exhausted 的判定全是严格匹配；那个宽正则只扫
`errorType` 且返回的是 `rate-limit`（3s 短冷却），方向相反。见
[ISSUES.md](../docs/ISSUES.md) 的 **I-8 已证伪**。

真实情况（journal 实测）：
- **295 个 503**（不是 5 次），20:16–20:19 `/v1/messages` 整池被禁约 3 分钟
- 上游 429 全在 12:35–12:48，与 503 相隔 8 小时，**无因果关系**
- **关键盲区：当时日志里没有任何禁用记录** —— 池空 → 503 的三个分支全部静默返回

## 本轮改了什么（已过测试，待部署）

1. **key 池禁用/恢复可观测性**（I-9）：`KeyPool` 加 `onStateChange` 回调（注入式），
   四种失败类型的禁用 + 冷却自然到期恢复都上报，只带指纹；
   `server.ts` 打 `[keypool] disabled key=**** reason=... cooldown=...s pool=n/m`；
   池空单独打 `[keypool] pool empty`（10s 节流 + 累计被拒数，防 295 行刷屏）。
2. **流式脏数据兜底**（I-10）：`parseOpenAISSE` 加 `onDirty` 回调（SSE 注释行不算脏，
   `{` 开头但 JSON 解析失败也算脏，样本截断 200 字符）。两条流式路径：
   - chat 路径：中止且**不补 `[DONE]`**
   - 直通路径：中止并发 `event: error`（`overloaded_error`），标记 transient
   - 检测点在**写出之前**；直通路径循环后必须再查一次（text 块缓冲到收尾才产出）
3. **正则收窄**（顺手）：`/balance|credit|billing|quota/i` → 精确枚举，加回归测试。

## 下一步（部署）

```bash
./scripts/deploy.sh        # 本地验证→构建→推 dist→原子替换→重启→健康检查
```

部署后验证：
- 启动日志有 `upstream key pool: N keys (N healthy)`
- 真实请求 4 条（DEPLOY.md 验证清单）
- **观察日志里的 `[keypool]` 行**：下次任何 key 禁用/恢复都会留下原因与冷却。
  真实根因（大概率 transient 累积，`failThreshold=5`/`cooldownMs=300s`）待下次复发时定位。

## 文档分工

- [ISSUES.md](../docs/ISSUES.md)：I-8 已证伪、I-9/I-10 已修，均附完整证据
- 其余文档（ARCHITECTURE/CONVENTIONS/DEPLOY）本轮未动，仍准确

## 环境须知

- `tsc` / `vitest` 不在 PATH，用 `npx` 或 npm script
- 线上操作走 `ssh nbus`；kirostudio 那台是 `ssh -p 673 root@143.20.230.62`
- 涉及凭证先读 `~/.claude/SECRETS.md`，取到的值不要输出到任何地方

## 不要做的事

- 不要因为「看起来多余」就删兜底逻辑 —— 基本每条都对应一个 DeepSeek 怪癖，
  删之前查 DEEPSEEK-QUIRKS.md
- 不要只改一条路径的 deepseek 适配（chat 路径与直通路径是两套实现）
- 不要引入运行时依赖（零依赖是刻意的）
- commit 不带任何 Claude / Anthropic 署名，文档不用 emoji（见 CLAUDE.md 铁律）
