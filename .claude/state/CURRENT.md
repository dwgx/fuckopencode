# 当前状态

更新时间：2026-08-09 22:35（第三轮会话）

## 一句话

OpenAI ↔ Anthropic 协议转换网关（面向 DeepSeek），线上跑在 nbus。
本轮在网关**前面**加了一层护盾（DWGX 移植自 .62 的 `kiro_shield.py`），
上游波动先被盾吸收再交给客户端，下游会话不会因为几分钟的抖动而断开。
**已上线并接管全部公网流量，真机验证过吸收。**

## 基线（已验证）

| 项 | 状态 |
|---|---|
| 上一轮代码改动（cf32666） | 已部署，线上跑着 |
| 盾 `fuckopencode-shield.service` | `active`，常驻约 14M |
| 网关 `fuckopencode.service` | `active`，key pool 2/2 healthy |
| 公网四项验证 | 全 200（非流式 / adaptive / OpenAI 端点 / 流式） |
| `test-shield.py` | 5/5 通过 |
| 工作区 | `scripts/dwgx/` + `.claude/docs/SHIELD.md` **未提交** |

## 本轮做了什么

把盾装在了 nbus 上，细节见 [SHIELD.md](../docs/SHIELD.md)。三个要点：

1. **端口是互换过的**：`cloudflared -> 8787（盾）-> 8788（网关）`。
   网关不再监听 8787。
2. **为什么互换**：`fuckopencode.dwgx.top` 的路由由 Cloudflare **云端**管理，
   本地 `config.yml` 的 ingress 对这条隧道不生效（实测 `Updated to new
   configuration` 恒为 8787、`local_config_pushes` 恒为 0、盾 requests 恒为 0）。
   走不了「改隧道指向盾」，改成让盾去占云端认定的 8787。
3. **DWGX 加的判定**：`all upstream keys are disabled` → `cool`（整池被禁，
   冷却自然恢复），另三条 fuckopencode 措辞 → `retry`。这条正是 20:16 那 295 个
   503 的形态。

配套三个脚本（`scripts/dwgx/`）：

| 脚本 | 用途 |
|---|---|
| `shield-deploy.sh` | 本地跑，推盾 + 装 unit + restart，幂等 |
| `shield-status.sh` | 只读探活：存活/内存/盾吞了什么/异常事件 |
| `test-shield.py` | 本地假上游验证盾行为，不碰线上 |

## 吸收实测（决定性证据）

停掉网关 8788 共 12 秒，期间经**公网域名**发请求：客户端拿到正常 200
（25.65s，含盾的等待窗口），**从未断开**，盾统计 `absorbed=1`。

注意测法：得**先停上游、再发请求**。反了的话请求在上游还活着时就完成了，
盾一次过、不计吸收，会误判成盾没工作。

## 下一步

盾已上线，无待办。可选的观察项：

- 隔一段时间跑 `./scripts/dwgx/shield-status.sh`，看 `absorbed` 有没有增长 ——
  有增长说明盾在真实波动里救回了会话。
- 上一轮加的 `[keypool]` 日志还没等到真实复发。下次整池被禁时，
  盾会吸收（客户端无感），同时 journal 里会留下禁用原因与冷却时长，
  那时才能定位 295 个 503 的真实触发条件。

## 环境须知

- `tsc` / `vitest` 不在 PATH，用 `npx` 或 npm script
- 线上操作走 `ssh nbus`；kirostudio 那台是 `ssh -p 673 root@143.20.230.62`
- 涉及凭证先读 `~/.claude/SECRETS.md`，取到的值不要输出到任何地方
- 盾的观测面板要开隧道：`ssh -L 8787:127.0.0.1:8787 nbus`

## 不要做的事

- **不要以为改 `/etc/cloudflared/config.yml` 能切换 fuckopencode 的路由** ——
  这条隧道是云端管的，本地那段 ingress 是死的。切流靠换端口。
- 端口互换有顺序：先停盾放开 8787，再起网关到 8788，最后起盾占 8787。
- 不要因为「看起来多余」就删兜底逻辑 —— 基本每条都对应一个 DeepSeek 怪癖，
  删之前查 DEEPSEEK-QUIRKS.md
- 不要只改一条路径的 deepseek 适配（chat 路径与直通路径是两套实现）
- 不要引入运行时依赖（网关零依赖、盾只用 python stdlib，都是刻意的）
- commit 不带任何 Claude / Anthropic 署名，文档不用 emoji（见 CLAUDE.md 铁律）
