# 当前状态

更新时间：2026-08-10 05:12（第四轮会话，自我审计进行中）

## 一句话

OpenAI ↔ Anthropic 协议转换网关（面向 DeepSeek），线上跑在 nbus，前面有一层护盾。
本轮把 **key 池的可观测面**做出来了：面板现在直接显示「几个号在扛并发分流」、
每个 key 的状态与原因、冷却倒计时，以及跨重启的累计用量（SQLite）。
**已部署上线并验证**，线上正在用它观测一次真实的额度耗尽。

## 基线（已验证）

| 项 | 状态 |
|---|---|
| `npm run typecheck` | 干净 |
| `npm test` | 326 passed / 12 files |
| `npm run build` | 干净 |
| 本地面板实机验证 | 三种状态（在飞 / 禁用+倒计时 / 累计）都渲染正确，中英文都对 |
| 线上 | **已上线**。代码对应 `b7f7a29`（vitest 配置那次），进程 04:43:47 重启，两服务 active；`4d0d1b7` 是 docs commit（README/DEPLOY.md），不动 dist，线上无变化 |
| 线上持久化 | `[proxy] usage db: data/usage.db (retention 30d)`，无降级 warn |
| 线上端到端 | 经盾 8787 发 Anthropic 请求 200 有内容，累计计数实时 +1 |

## 线上验证记录（2026-08-10 04:43 部署）

部署后逐项核对，不是只看 `systemctl is-active`：

| 检查 | 结果 |
|---|---|
| Node 版本 | v22.20.0，`node:sqlite` 可用 |
| `WorkingDirectory` | `/root/fuckopencode`，db 落在 `dist/` 外面 |
| `dist/usagedb.js` | 存在（12311 字节） |
| `dist/dashboard.js` | 含 `n-pool`、`max-width: 560px`、`#h-live { min-width` |
| `dist/keypool.js` | 含 `totalAcquired` |
| `data/` | 已建出，`usage.db` + WAL 在增长 |
| `/__metrics` | 5722 字节，**扫过无任何 `sk-` 原文** |
| `pool.history` | 非 null，`historyDisabledReason: null` |

**最该盯的是启动日志那一行。** 必须是
`[proxy] usage db: data/usage.db (retention 30d)`，不能是 `off (...)` ——
usagedb 的降级设计会把失败吞成一行 warn，只看服务 active 根本发现不了它没工作。

部署当时正好抓到一次真实的额度耗尽，说明这套东西解决的是真问题：

```
****ZOBb  quota-exhausted  剩余 3h16m
****0osU  healthy  inFlight=2  本次启动被选中 9 次
```

同一个问题上一轮要翻 journalctl + 读源码找冷却公式 + 在服务器上 `date` 手算，
现在剩余冷却是现成的。

**审计更正**：上一版这里写了「恢复于 2026/8/10 08:01:48」，那是错的 ——
面板**从不渲染绝对恢复时刻**。`snapshot()` 确实同时给了 `disabledUntil` 和
`recoverInMs`，但 `dashboard.ts` 只用了后者，`disabledUntil` 是个死字段
（全文只有 `lifetime.since` 用过 `toLocaleString`）。下面「两个设计点」里
同样的说法也是这个问题。

注意：**当时池子只有 1 个健康 key 扛全部流量**（`size 2, healthy 1`）。
这不是部署造成的，是上游额度，但现在它在面板上可见。

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

## 本轮的四个提交

| commit | 内容 |
|---|---|
| `66914de` | feat: key 池全量上面板，用量落 SQLite |
| `ba9ab77` | fix: 面板 topbar 窄屏不再横向溢出 |
| `b7f7a29` | chore: vitest 排除 .claude，避免扫到 worktree 里的测试 |
| `4d0d1b7` | docs: 记录上线结果与 usagedb 验证步骤 |

`ba9ab77` 是一个并行 worktree agent（`claude/elated-banach-39cfdd`）做的，
它自己 rebase 到了 `66914de` 之上，成果逐字节核对后由我提交、worktree 已删。
它比原任务多做了两件事，都留着：

- 发现 header 在 375px 下不只是按钮被顶出去，**brand 本身已在 46px 条里换行**
  （实测高 39px）
- 发现 `#h-live` 断流时会填入上游错误原文、长度不可控，单独给了省略号。
  我做过对照实验：塞 400 字符不可断行文案时，**没这条规则 scrollWidth 冲到
  2870px，有则稳在 375px** —— 这是个独立的旧 bug，它顺手一起修了

`b7f7a29` 是被那个 worktree 暴露出来的：worktree 建在 `.claude/worktrees/` 下，
vitest 默认 include 会把它里面的整套测试也扫进来（326 变 630），
worktree 的失败会算到主仓库头上。

## 自我审计结论（2026-08-10 06:50）

用户要求「全面自我审计」，按「焚诀」开了 6 路独立视角 agent（只给审计目标和
已确认事实，**不给实现者的辩解理由**）：keypool 正确性 / usagedb 持久化 /
安全与隐私 / 全新视角需求覆盖 / 面板前端渲染 / 测试有效性变异。

**代码全部未改动** —— 这一轮只产出结论，修不修由用户定。

### 修复状态：审计发现的问题**已全部修完**（2026-08-10 07:32，未提交、未上线）

见后面「审计后的修复」一节。下面这张表是审计当时的原始记录，保留作为背景。

### 审计发现的问题（按优先级）

| # | 问题 | 位置 | 严重度 |
|---|---|---|---|
| 1 | `history()` 同步全表 `GROUP BY` 阻塞事件循环，15 万行 p50=646ms；面板 2 秒轮询会周期性冻结代理（60 万行时 max 10s） | `usagedb.ts:253-269` | blocker |
| 2 | 错误路径**双重 `release()`**，把别的在飞请求的 `inFlight` 偷减 —— 面板「几个号在扛并发」会偏低甚至为 0 | `server.ts:576` + `:590` | major |
| 3 | `markFailure` 无条件覆写 `disabledReason`/`disabledUntil`：19h 的额度冷却会被一个迟到的裸 429 冲成 3 秒，且面板**归因错误**（真因额度耗尽，显示 transient） | `keypool.ts:286-291,312-313,326-328` | major |
| 4 | `lastPruneAt = Date.now()` + 6h 节流 ⇒ 进程活不过 6 小时时 30 天保留期**永不执行**，库无限增长（喂大问题 1） | `usagedb.ts:110,313` | major |
| 5 | 冷却倒计时**实际从不生效**：2 秒轮询 `innerHTML` 整段重建，把 1 秒 tick 改的节点丢掉；后台标签页回来后显示陈旧值 | `dashboard.ts:591,654-661` | major |
| 6 | `ctx.error` 从初始化后**从未被赋值** ⇒ `requests.error` 列恒 NULL，失败原因无法从 db 回溯 | `server.ts:287` | major |
| 7 | `pool.history` 结构不完整时 `keypool()` 抛异常，整个面板**永久停止更新**且报成上游故障 | `dashboard.ts:570,634` | 潜在 blocker |
| 8 | 指纹只取末 4 位 + `GROUP BY key_fp`：碰撞时两个 key 用量合并、面板双倍呈现 | `usagedb.ts:266` / `dashboard.ts:570` | major |
| 9 | idle 池只要来 1 个请求进度条就满格（`maxIn` 是当前最大值，纯相对） | `dashboard.ts:572,624` | major |
| 10 | `historyDisabledReason` 把绝对路径回给面板（`mkdir '/root/fuckopencode/data'`），公开模式下泄漏部署路径 + 暴露跑在 root 下 | `server.ts:330` | minor |

另有：`handleCountTokens` 没被 await，落库 tokens 恒 0 / status 恒 200；
换 key 重试时第一个 key 的失败**不产生 requests 行**（恰是诊断额度耗尽最该看的失败）；
`key_events` 缺 `(at)` 索引；`busy_timeout=0` 一撞就丢记录；`journal_size_limit` 未设。

### 测试的真实盲区（最重要的一条）

我自己独立验证过：**在 `dashboard.ts` 的 `String.raw` 模板里塞一个语法错误
（`keypool(m.pool;` + `function {{ BROKEN`），`npm run typecheck`、`npm run build`、
`npm test` 326/326 全部通过。** 这和本轮踩的 `require` 坑是同一类漏洞：
面板那 231 行新代码对 TypeScript 而言只是个字符串，没有任何自动化检查看得见它。

上面 10 条缺陷，现有 326 个测试**一条都没抓到**。

兜底办法很便宜（已验证可行）：
```
node -e "const{DASHBOARD_HTML}=require('./dist/dashboard.js');new Function(DASHBOARD_HTML.match(/<script>([\s\S]*)<\/script>/)[1])"
```
把内联 JS 拿出来 `new Function()` 解析一次，语法错误立刻暴露。建议进测试。

### 经查是「非问题」的（有证据，别重复排查）

- **WAL 4.1MB 不是泄漏**：`wal_autocheckpoint` 默认 1000 页 × 4096 = 4.0MB，
  实测写 20000 行 WAL 稳在 3.95MB 不再涨，`close()` 清零。但**长事务读者会让
  checkpoint 饿死**（实测 30k 行撑到 522MB 且不回落）—— 现在 `.all()`/`.get()`
  不留快照所以安全，是个只差一步的地雷
- **鉴权路径没被动过**：`git show 68fba3d:src/server.ts` 与 HEAD 逐字节相同
- **db 里确实没存 IP/UA**，key 原文在 db + WAL 原始字节里扫不到
- **XSS 全部插值点已过 `esc()`**（畸形 key 确实能带 HTML 元字符，但被兜住）
- **`snapshot()` 无并发撕裂**：全同步无 await，Node 单线程下是一致快照
- **i18n 81 个词条 en/zh 齐备**，`KIND_KEY` 四个值全覆盖
- **双进程写不损坏数据**（实测交替写 200 条零失败）
- **`history()` 每次 prepare 不泄漏内存**（15 万轮 external 持平）

### 需求覆盖：「你能知道的一切」这条只算部分满足

「星号挡住」「自动生成」完全满足。但差集里有几项系统知道、面板看不到：

- **上游原始错误文案哪里都不留** —— 不在面板、不在 db（`error` 恒 NULL）、
  连 journalctl 都没打。用户的原始痛点恰恰是「不想再翻日志」
- 冷却策略本身（倍率规则、`failThreshold`）仍只在源码里 —— 数字给了，
  「为什么是这个数」没给，而用户问的正是「你怎么知道 6 小时」
- per-key 历史禁用次数/时长分布（数据在 `key_events` 里，只返回全局最近 20 条）
- `lastFailAt` 根本没进 snapshot
- 「30 天保留期」与用户说的「所有」有分歧，**没向用户说明过**

### 文档已修正

`disabledUntil` 从不渲染 —— 上一版本文件里「恢复于 08:01:48」和「两个设计点」
两处都在描述一个不存在的界面，已改。`DEPLOY.md:73` 把两个真实指纹写进了
受 git 管理的文档，按「星号挡住」口径不算泄露，但值得知情。

### 审计过程本身的两个教训

- **后台 agent 不可靠**：6 路 agent 首轮全挂（错误信息说 `claude-opus-5`
  不可用，但翻 transcript 发现实际跑的是 `deepseek-v4-flash`，**错误信息是误导的**）。
  同步跑就正常。以后这类审计直接同步跑，别开后台
- 测试有效性那路 agent 中途断连，**在工作区留下了它埋的语法错误变异**。
  已 `git checkout` 还原并复验（typecheck 干净 + 326/326 + dist 里
  `keypool(m.pool)` 在位 + 内联 JS 能解析）。**派 agent 做变异测试要盯着还原**

## 审计后的修复（2026-08-10 07:32）

**改了 5 个源文件 + 3 个测试文件，未提交、未上线。** 测试 326 → **340 全绿**，typecheck 干净。

| 审计 # | 怎么修的 | 文件 |
|---|---|---|
| 1 | `history()` 加 15 秒结果缓存。实测 15 万行：首次真查询 226ms，缓存命中 0.000ms —— 40 秒窗口内本该阻塞 4.7s，现在只 0.23s。`prune` 会作废缓存 | `usagedb.ts` |
| 2 | 在 `UpstreamCall` 层给 `release` 加一次性标志（文件头本来就写着「幂等」，只是没实现）。调用方不必再逐条排查控制流 | `upstream.ts` |
| 3 | 抽出 `disableUntil()` 统一禁用入口：**只延长冷却，绝不缩短**，原因跟着实际生效的冷却走 | `keypool.ts` |
| 4 | `lastPruneAt` 改成 `nextPruneAt`，首次宽限 10 分钟。重启不付全表扫描代价，但进程正常服务 10 分钟以上清理就一定有机会跑 | `usagedb.ts` |
| 5 | 倒计时归零钳到 0 并摘掉 `data-rc`；加 `visibilitychange` 回前台立刻补一次（后台标签页定时器会被浏览器停摆） | `dashboard.ts` |
| 6 | 加 `noteUpstreamError()`，在**能读到 body 的那个分支**记（body 只能读一次）。上游原文现在落进 `error` 列 | `server.ts` |
| 7 | `keypool()` 逐字段兜底（`pool` / `history` / `byKey` / `recentKeyEvents`），不再让半截结构把整个面板打死 | `dashboard.ts` |
| 9 | 进度条刻度从「当前最大并发」改成 `max(4, maxIn)`。1 条在飞画 25% 而不是满格 | `dashboard.ts` |
| 10 | `disabledReason` 对外只给分类标签（`classifyDbFailure`），原始 message（含绝对路径）只进日志 | `usagedb.ts` |
| 附带 | `key_events(at)` 索引、`busy_timeout=200`、`journal_size_limit=16MB` | `usagedb.ts` |

**修 6 的时候顺手逮到一个客户端可见的真 bug**：统一错误出口会对已被消费的 body
再 `.json()` 一次，在「没换 key」的路径上必然拿到空 —— 于是回给客户端的错误文案
退化成按状态码生成的通用句子。现在复用第一次读到的 body，客户端能看到上游原话
（实测：`Weekly usage limit reached. Resets in 6hr 17min.`）。

**修 6 还暴露了一个潜伏的溢出**：`error` 列以前恒 NULL，所以请求日志里那个
`.s-bad` span 从来没有内容；一旦真有长文案，`.ent .r2 span { white-space: nowrap }`
就把 375px 下的 `scrollWidth` 顶到 604px。已给这个 span 单独放开折行。

### 新增的测试（都验证过「去掉修复就变红」）

- `test/keypool.test.ts` +5：额度耗尽后收到迟到的 transient / 裸 429 / auth 被
  rate-limit 冲，冷却与原因都不能被改；更长的冷却仍能延长；到期后能按新原因重新禁用。
  **实测把 `disableUntil` 的守卫删掉，3 条立刻变红**
- `test/e2e.test.ts` +1：假上游加额度耗尽钩子，断言上游原文真的进了 db 的 `error` 列
- **`test/dashboard.test.ts`（新文件，8 条）** —— 补上那个最大的盲区。核心是把内联
  `<script>` 抠出来 `new Function()` 解析一次。**实测：埋进语法错误后 typecheck
  仍然 exit 0，而这条测试报 `SyntaxError: missing ) after argument list`**。
  另外钉住 `keypool(m.pool)` 调用、`setInterval(tickCountdown)`、挂载点、
  以及 en/zh 词条键集合对齐

### 浏览器实测（本地假上游，构造出真实的额度耗尽 + 在飞并发）

- 面板 `2 carrying load of 3 · 3 req`，进度条 `50% / 0% / 25%`（旧代码这里最忙的永远满格）
- 倒计时真的在走：`6h17m28s → 24s → 20s`（旧代码冻结在首帧）
- 禁用卡片显示 `quota exhausted (quota-exhausted)`，中文 `额度耗尽 / 剩余冷却`
- 半截 `history` 结构（缺 `byKey` / 缺 `recentKeyEvents`）灌进去，面板照常渲染
  3 张卡、状态保持 `[*] live`；A/B 对照证明旧写法在同样输入下抛
  `Cannot read properties of undefined (reading 'forEach')`
- 375px 无横向溢出（`scrollWidth` 375 = `clientWidth`），桌面 1280 无溢出，无 console 报错
- 页面不含 key 原文

## 已上线（2026-08-10 07:47:09）

提交 `ecffb30`，已 push 到 origin main，已跑 `./scripts/deploy.sh` 部署。

| 验证项 | 结果 |
|---|---|
| 两服务 | active（网关 + 盾） |
| 新进程 | 07:47:09 重启（原 04:43:47） |
| 启动日志 | `usage db: data/usage.db (retention 30d)` —— **不是** `off (...)` |
| dist 含新代码 | `keypool.js` 有 `policy`、`dashboard.js` 有 `kpol`、`server.js` 有 `noteUpstreamError`、`usagedb.js` 有 `historyCache` |
| `/__metrics` 的 `policy` | 完整返回，`cooldownMs 300000` / `failThreshold 5` / `least-loaded` + 四条规则 |
| 面板 `#kpol` | 挂载点在 |
| key 原文泄漏 | `grep -c "sk-"` = 0 |
| 报错 | 只有 SQLite experimental 警告（预期） |
| 回滚 | `dist.prev` 在位，`./scripts/deploy.sh rollback` 可用 |

### 上线后立刻撞上一次真实的双 key 额度耗尽 —— 顺便验证了两个修复

上线几分钟后两个 key 全额度耗尽（上游账号状态，不是部署问题；池空 503
是预期行为，盾在前面吸收）。这次意外成了真实环境的验证：

**`error` 列修复确认生效** —— 这些原文在上一版任何地方都留不下（列恒 NULL、
也没有任何 console 打它）：

```
****ZOBb 429 upstream 429 GoUsageLimitError: Weekly usage limit reached. Resets in 12min.
****0osU 429 upstream 429 GoUsageLimitError: 5-hour usage limit reached. Resets in 1hr 33min.
```

**`disableUntil` 只延长不缩短确认生效** —— 冷却时长与上游原文完全对得上：

```
****ZOBb  quota-exhausted  cooldown 0.22h（上游说 12min + 60s 余量）  恢复于 08:01:51
****0osU  quota-exhausted  cooldown 1.57h（上游说 1hr 33min + 余量）   恢复于 09:22:36
```

按旧代码，后续每个撞上来的 429 都会把这两个冷却覆写成 3 秒、原因改成
`rate-limit` —— key 会被反复选中、每次先撞一次 429，而面板显示的原因是错的。
现在两个 key 都稳定挂着 `quota-exhausted` 和正确的恢复时刻。

### 排查时踩的一个坑（记下来省下次的时间）

线上 env 文件是 `/root/fuckopencode/fuckopencode.env`，**不是 `.env`**。
我第一次端到端测试取 key 取到空串，网关回 401，盾把 401 转成 503，
看起来像部署炸了 —— 实际是我自己的命令写错。
用 `systemctl show fuckopencode -p EnvironmentFiles --value` 确认路径。

## 下一步

线上已是最新，无阻塞待办。观察项：

- 两个 key 分别在 08:01:51 / 09:22:36 自动恢复，届时面板显示 `2/2`，
  「最近状态变更」会各多一条 recovered
- **保留期清理现在真的会跑了**（进程存活 10 分钟后进入窗口）。
  `data/usage.db` 之前 114KB，留意它是否稳定
- WAL 一直在 4.1MB 左右属正常（autocheckpoint 阈值 1000 页 × 4096 = 4MB），
  已设 `journal_size_limit=16MB` 兜住异常膨胀

## 冷却策略上面板（2026-08-10 07:45，用户要求，已做完）

审计差集里的第 2 条（「数字给了，但为什么是这个数没给」）已补上。这是用户最初
那句「你怎么知道 6 小时」的正解 —— 光有剩余冷却不够，得能当场看出规则。

做法：`KeyPool.policy()` 返回 `PoolPolicy`，经 `/__metrics` 的 `pool.policy` 到面板，
在 key 池小节下新增一块 `#kpol`。

**关键设计：每条规则都用和 `markFailure` 同一套算式从真实配置算出来**，
前端不写死时长。改了 `COOLDOWN_MS` 面板会跟着变，不会说谎。

面板实际显示（英文，`COOLDOWN_MS=300000` / `FAIL_THRESHOLD=5`）：

```
cooldown policy · why a key recovers when it does
quota exhausted   from upstream  首次即禁用 · 上游重置时间+60s余量 · 兜底 1h00m00s
invalid credential  1h00m00s     首次即禁用 · 12x base cooldown
rate limited        3s           首次即禁用 · 刻意很短：429 是账号级，换 key 没用
repeated transient  5m00s        连续 5 次后禁用 · 之后翻倍最多 16 倍，±20% 抖动
base cooldown 5m00s · fail threshold 5 · routing: least in-flight first
```

**测试 +11（351 全绿）**，其中最重要的是「声明 = 实际行为」那组：
逐个失败类型断言 `policy()` 声明的时长/是否累计阈值，与 `markFailure` 跑出来的
`recoverInMs` 一致。面板显示错的规则比不显示更糟，所以这组必须钉住。
另加 `policy(pool.policy)` 接线断言、`#kpol` 挂载点、占位符 `{n}`/`{base}` 真做了替换。

浏览器实测：中英文都对、375px 无溢出（`scrollWidth` 375）、桌面 1280 无溢出、
无 console 报错、占位符没漏给用户看。

顺带修了我自己新写的 i18n 对齐测试的一个假阳性：原来的正则会把词条**内容**里
的英文单词误当成键（`kept short on purpose:` 里的 purpose、`routing:` 里的 routing）。
改成只认行首/逗号后的标识符，并验证过它仍能抓出真的缺词条。

审计里**没修**的，属于需求判断不是缺陷，留给用户决定：

- per-key 历史禁用统计、`lastFailAt` 仍没上面板。要做就是新功能，不是修 bug
- 「30 天保留期」与用户说的「所有」的分歧 —— 现在清理真的会跑了，
  所以这个分歧从「反正不生效」变成真实存在。要改就改 `USAGE_DB_RETENTION_DAYS`
- `handleCountTokens` 没被 await 导致落库 tokens 恒 0（既存 bug，本轮没碰）
- 换 key 重试时第一个 key 的失败不产生 requests 行（`error` 列现在能记到原因了，
  但那条记录仍归属到第二个 key）
- 指纹末 4 位碰撞（审计 #8）—— 线上 2 个 key 碰撞概率极低，真要修得在
  snapshot 和 byKey 里带上池内索引作为真键，改动面比收益大

## 环境须知

- `tsc` / `vitest` 不在 PATH，用 `npx` 或 npm script
- 线上操作走 `ssh nbus`；kirostudio 那台是 `ssh -p 673 root@143.20.230.62`
- 涉及凭证先读 `~/.claude/SECRETS.md`，取到的值不要输出到任何地方
- 盾的观测面板要开隧道：`ssh -L 8787:127.0.0.1:8787 nbus`
- 本地验面板：`.claude/launch.json` 里有 `gateway` 配置（3 个假 key，
  上游指向 127.0.0.1:9911）。假上游要现写一个丢在 `/tmp`，两个钩子就够：
  请求体含 `SLOW` 就 `setTimeout` 25s（造在飞请求），含 `MAKE-QUOTA-ERROR`
  就回 429 + `Weekly usage limit reached. Resets in 6hr 17min.`（造禁用+倒计时）。
  **措辞要用 `hr`/`min`** —— `errors.ts` 的 `parseResetDelayMs` 不认裸 `seconds`，
  写 `22620 seconds` 会落到 1 小时默认冷却，看起来像 bug 其实是测试数据不对

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
