# 当前状态

更新时间：2026-08-10 04:05（第四轮会话）

## 一句话

OpenAI ↔ Anthropic 协议转换网关（面向 DeepSeek），线上跑在 nbus，前面有一层护盾。
本轮把 **key 池的可观测面**做出来了：面板现在直接显示「几个号在扛并发分流」、
每个 key 的状态与原因、冷却倒计时，以及跨重启的累计用量（SQLite）。
**代码已全绿，尚未部署**（部署会重启线上服务，等用户点头）。

## 基线（已验证）

| 项 | 状态 |
|---|---|
| `npm run typecheck` | 干净 |
| `npm test` | 326 passed / 12 files |
| `npm run build` | 干净 |
| 本地面板实机验证 | 三种状态（在飞 / 禁用+倒计时 / 累计）都渲染正确，中英文都对 |
| 线上 | 仍是上一版（cf82c9b 之前的产物），**本轮改动未部署** |

## 本轮为什么做这个

用户问「有个 key 是不是用完了」。回答这个问题当时要做三件事：
`journalctl` 翻 `[keypool] disabled` 行 → 读 `keypool.ts` 源码找冷却公式 →
在服务器上用 `date` 手算恢复时刻。用户的要求是：
**「我需要你能知道的一切都需要在面板可以看到」**，key 要星号挡住。

所以这轮的判断标准不是「加了个面板模块」，而是「同样的问题现在能不能一眼看出来」。

## 做了什么

四个文件是主体：

| 文件 | 改动 |
|---|---|
| `src/keypool.ts` | 加 `snapshot(): PoolKeySnapshot[]`；`PooledKey` 加 `disabledReason` / `totalAcquired` |
| `src/usagedb.ts`（新） | SQLite 持久化，用 Node 内置 `node:sqlite`，零 npm 依赖 |
| `src/server.ts` | `/__metrics` 的 `pool` 加 `keys` / `history`；请求结束落库；`keyStateHandler()` 包住日志+落库 |
| `src/dashboard.ts` | 新增 `KEY POOL` 小节（Fig 3，后面的 Fig 号顺移），逐 key 卡片 + 状态变更审计 |

两个设计点值得记：

1. **`snapshot()` 同时给绝对时刻和相对剩余**（`disabledUntil` + `recoverInMs`）。
   面板要「恢复于 08:01:42（还剩 5h58m）」两种表述，给两个值它就不用推算，
   而且能本地每秒倒计时、不依赖 2s 轮询精度。
2. **db 必须在 `dist/` 外面**（默认 `data/usage.db`）。`deploy.sh` 每次
   `mv dist dist.prev`，放里面等于每次部署丢历史。已核对脚本只动 `dist*`，
   `data/` 不受部署和回滚影响。

隐私口径：**只存指纹（末 4 位）+ 不存 key 原文 + 不存 IP/UA**。
e2e 里有断言直接扫 `/__metrics` 原始响应体，确认 `sk-` 原文不出现。

## 踩到的坑（同一类，两次）

**ESM 里写了裸 `require`，单测全绿但生产静默失效。**

`usagedb.ts` 原来用 `require('node:module').createRequire(...)` 去取
`node:sqlite`。vitest 的转换层提供了 `require`，所以 12 个单测 + 2 个 e2e
接线测试**全部通过**；但编译产物是 ESM（`"type": "module"`），生产启动时抛
`require is not defined`，被降级逻辑吞成一行 warn ——
**持久化从未启用过，面板永远没有累计数据**。

是本地起真服务看启动日志才发现的（`[proxy] usage db: off (require is not defined)`）。
修法是顶层 `import { createRequire } from 'node:module'`。

这和上一轮 kirostudio 那个 `rewrite_index_or_passthrough` 回退分支是**同一类**问题：
**降级/兜底设计会把接线错误藏起来**。所以现在有两条防线：

- `test/usagedb.test.ts` 加了源码扫描回归测试（剥注释后断言无裸 `require`）——
  已验证：把 bug 改回去，这条测试会红。
- 教训写进 CONVENTIONS：**观测类改动必须起真服务看启动日志**，
  单测绿 + e2e 绿都不足以证明它接上了。

## 面板现在长什么样

`KEY POOL`（Fig 3）小节标题右边直接写「2 个号在扛并发 / 3 · 6 请求」，
下面每个 key 一张卡片：

```
****e5f6  [!]
在飞请求 0 · 状态 已禁用 · 原因 额度耗尽 (quota-exhausted)
剩余冷却 6h16m49s · 连续失败 0 · 本次启动 6 · 最近使用 03:46:40
累计 8 请求 · 1.3k tok · 1 失败
```

卡片下面是最近 20 条状态变更（时间 / 禁用或恢复 / 指纹+原因 / 冷却时长），
带「累计自 <时刻> · N 请求」。倒计时每秒走，暂停轮询也照走（实测过）。

## 下一步

1. **部署**（要用户点头 —— `deploy.sh` 会重启线上服务）：`./scripts/deploy.sh`
2. 部署后确认三件事：
   - 启动日志是 `[proxy] usage db: data/usage.db (retention 30d)`，不是 `off (...)`
   - `/__metrics` 的 `pool.keys` 有两个指纹、`pool.history` 不是 null
   - `/root/fuckopencode/data/` 建出来了，且不在 `dist/` 内
3. 本轮改动**未提交**，工作区还有上一轮未提交的 `scripts/dwgx/` + `SHIELD.md`

已单独派出的待办（与本轮无关，pre-existing）：面板 header 在 375px 宽度横向溢出
（`#btn` right=409 > 375），不是新小节造成的。

## 环境须知

- `tsc` / `vitest` 不在 PATH，用 `npx` 或 npm script
- 线上操作走 `ssh nbus`；kirostudio 那台是 `ssh -p 673 root@143.20.230.62`
- 涉及凭证先读 `~/.claude/SECRETS.md`，取到的值不要输出到任何地方
- 盾的观测面板要开隧道：`ssh -L 8787:127.0.0.1:8787 nbus`
- 本地验面板：`.claude/launch.json` 里 `gateway` 配置（3 个假 key + 假上游 9911），
  假上游脚本在 `/tmp/fc-fake-upstream.mjs`（可控延迟造在飞、可控 429 造禁用）

## 不要做的事

- **不要以为改 `/etc/cloudflared/config.yml` 能切换 fuckopencode 的路由** ——
  这条隧道是云端管的，本地那段 ingress 是死的。切流靠换端口。
- 端口互换有顺序：先停盾放开 8787，再起网关到 8788，最后起盾占 8787。
- 不要把 db 放进 `dist/`（部署会 mv 掉），也不要给 usagedb 加 npm 依赖
- 不要让观测逻辑抛错影响代理链路 —— usagedb 每个方法都在 try/catch 里，是刻意的
- 不要因为「看起来多余」就删兜底逻辑 —— 基本每条都对应一个 DeepSeek 怪癖，
  删之前查 DEEPSEEK-QUIRKS.md
- 不要只改一条路径的 deepseek 适配（chat 路径与直通路径是两套实现）
- 不要引入运行时依赖（网关零依赖、盾只用 python stdlib，都是刻意的）
- commit 不带任何 Claude / Anthropic 署名，文档不用 emoji（见 CLAUDE.md 铁律）
