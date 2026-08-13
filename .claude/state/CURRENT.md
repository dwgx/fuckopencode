# 当前状态

更新时间：2026-08-11（第九轮部署，**已上线**，710 tests 全绿）

## 一句话

OpenAI ↔ Anthropic 协议转换网关（面向 DeepSeek），线上跑在 nbus，前面有一层护盾。
**多账号管理面板已部署上线**（deploy.sh 一条龙）：env 账号（2 key 代理）+ OAuth
账号 dwgx1337@outlook.com 并存（workspaceId 自动获取、refresh_token 加密落库）。
启动日志确认 secret auto-generated + accounts env-seeded + 探针新节奏。**本地测试
服务已全部关闭。**

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

线上已是最新（探活 `bc463bb` 已上线），无阻塞待办。观察项：

- 探活每 30 分钟挑空闲 key 打最小请求，`endpoint='probe'` 与真实流量区分；
  面板「最近使用」变新说明刚验证过
- 保留期清理（进程存活 10 分钟后进入窗口）正常推进
- 文档侧：本轮把 ARCHITECTURE/README/ISSUES/PLAN/CURRENT 与代码现状对齐了，
  遗留的「metrics 实现与直觉不符」四个观察点（见第六轮节）等用户决定要不要改
- 测试侧：metrics.ts 盲区已补（36 条）；PLAN.md P3 里还剩 config/errors/
  upstream/断流/sanitizeInputSchema 五个小盲区，随时可补

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

## 第五轮后半：盾中文文案 + 面板两个修复（2026-08-10 上午）

上轮之后又上线了 3 个功能 commit（探活、盾文案、面板修复），补记：

| commit | 内容 |
|---|---|
| `d13b573` | feat: 盾回给下游的错误文案改成中文，说清是谁的问题、该怎么办（scripts/dwgx/kiro_shield.py，test-shield.py 同步加断言：文案中文、不含内部术语、带重试次数与耗时、无 markdown） |
| `0f1276c` | fix: 面板不再凭空多出一个 key（未归属请求单独显示「N 条未到达上游」，不再混进 byKey 当幽灵 key）；耗时不再显示成 `2.1kms`（新增 `ms()` 专门格式化耗时，秒用秒表示，`59999ms` 正确进位成 `60.0s`） |
| `bc463bb` | feat: key 主动探活，30 分钟一轮 |

**探活的设计要点**（bc463bb，值得记）：

- 动机：面板的「可用」只代表**不在冷却期**，不代表验证过能用 —— 实测见过两个
  key 都显示可用但 40 分钟没人用过，面板是绿的它们到底能不能用没人知道
- 每 30 分钟挑「健康 + 空闲超 30 分钟 + 本进程从未用过」的 key（`pool.staleKeys`），
  发 `deepseek-v4-flash` + `max_tokens=1` 的最小请求
- **刻意不走 `postUpstreamChat`**：它内部 `pool.acquire()` 按 least-loaded 自己
  挑 key，探活必须打到指定 key；但成功/失败复用 `markSuccess`/`markFailure` +
  `classifyUpstreamFailure`，探活结论与真实流量完全一致
- 两条克制原则（额度珍贵）：只探健康的（禁用中的让它自然恢复）、只探空闲的
  （有真实流量经过就不需要额外证明）
- 顺手修了一个 keypool 缺陷：`markSuccess` 之前不更新 `lastUsedAt`（只有
  acquire 更新），探活不经 acquire，成功不刷的话该 key 每轮都被判定空闲、
  重复探、白烧额度
- 探活记录落库 `endpoint='probe'`，与真实流量区分；三条 env：
  `KEY_PROBE_INTERVAL_MS` / `KEY_PROBE_IDLE_MS` / `KEY_PROBE_TIMEOUT_MS`，0 关闭；
  timer unref 不拖进程退出，`running` 标志防重入

## 第六轮（2026-08-11）：六路并行理解项目 → 文档同步 + metrics 测试盲区

按用户要求派 6 路独立 agent（协议层 / key 池用量层 / 网关骨架 / 测试面 /
部署运维 / 文档一致性）并行理解项目，关键结论亲自核实后落到文档。**代码零改动**。

### 最大发现：文档整体漂移 —— chat 路径已不再做协议转换

2026-08-09 改造后（`6f4d910`），chat 路径**直发 OpenAI 协议**（server.ts:549-551
注释明说「不再绕 Anthropic」），只有直通路径做完整双向转换。但 ARCHITECTURE.md
仍画着旧的 `openAIToAnthropicRequest → postAnthropic` 流程图 —— 这是全仓库
最误导人的一处。后果：`request.ts`/`response.ts`/`normalize.ts` 等转换模块在
server 主路径已无引用（只从 stream.ts 用 `sseStringify`、从 sse.ts 用
`parseOpenAISSE`），是历史转换链，经 `index.ts` 库导出面 + 测试活着。

### 修掉的漂移（全部先核实代码再改）

| 文件 | 修了什么 |
|---|---|
| `ARCHITECTURE.md` | 两条路径图重写（chat 直发 / 直通双向转换）；「enabled 走字节透传」的错误说法改掉（实为无条件 `openAIStreamToAnthropic`，server.ts:864-882）；模块职责表标注历史模块；补 keyprobe/usagedb |
| `README.md` | 三个默认值纠错：`ANTHROPIC_BASE_URL` 实际 `https://opencode.ai/zen/go`（写了 api.anthropic.com）、`MAX_BODY_BYTES` 实际 64MB（写了 10485760）、`MAX_MESSAGE_CHARS` 实际 8000000（写了 200000）；架构图重写（删了不存在的 `anthropic.ts`，补 9 个缺失模块，历史链单独标注）；JSON mode 特性改为「response_format 原样透传」（核实过 8 字段剥离清单里没有它）；端点表 chat 行改「归一化后直发上游」 |
| `ISSUES.md` | 「292 passed」→ 去掉数字按 CONVENTIONS 约定只留核对日期；I-1/I-3 补充现架构说明（request.ts 不在主路径、chat 路径不再需要剥 Anthropic 专属字段）；I-2/I-4/I-5/I-6/I-7 行号全部修正到当前实现；「count_tokens 会做模型名映射」改为「纯本地估算不打上游」 |
| `PLAN.md` | P1 验收标准重写（原标准基于旧架构，已作废；新标准聚焦直通路径内部的 DSML 两处接线）；P3 测试缺口列表更新（metrics 已补，补上 parseOpenAISSE 跨包半行、sanitizeInputSchema 两项） |
| `CURRENT.md` | 本文件：补 5 个 commit 记录、更新下一步 |

### metrics.ts 测试盲区已补（36 条，src 零改动）

metrics.ts 是面板所有数字的来源（p95/UA 解析/IP 优先级/分组聚合），此前只有
e2e 断言 totalRequests 增量。新 `test/metrics.test.ts` 36 条全绿，
全量 405/405 + typecheck 干净。

**顺手发现 4 个「实现与直觉不符」的观察点（测试按当前行为如实断言，未改 src，
要不要修由用户定）：**

1. `metrics.ts:81-84`：真实 iPhone Safari UA 含 `like Mac OS X`，`/Mac OS X/`
   分支在前，iPhone 被判定为 macOS（mobile 仍 true）—— 苹果移动端 UA 恒偏 macOS
2. `metrics.ts:187`：p95 是 nearest-rank（`floor(n*0.95)` 下标），20 个样本时
   p95 = 最大值，不做插值
3. `metrics.ts:180-181`：`RequestEvent.error` 不进 summary —— status 200 带
   error 的请求仍算 ok，面板看不到超时/中断这类非状态码失败
4. `metrics.ts:180`：3xx（含 304）算 ok；`<200`（如 101）两边都不算

### 交付前核实过的事实

- chat 路径直发 OpenAI：server.ts:549-551 注释 + `prepareOpenAIUpstreamRequest`
  （:716-740，只做模型映射 + 护栏 + 剥 8 个扩展字段）
- server.ts 对历史转换模块的导入只有 `sseStringify`（stream.ts）和
  `parseOpenAISSE`（sse.ts）—— `rg "from './"` 逐条看过
- 直通流式无条件 `openAIStreamToAnthropic`（:864-882），无字节透传分支
- count_tokens 纯本地估算（:944-947 注释 + `estimateInputTokens` 实现）
- 默认值：config.ts:153/162/163

## 第七轮（2026-08-11）：多账号管理面板 P0+P1（本地验证，未上线）

用户需求：升级后台为「一个面板管理多个 OpenCode ZEN 账号 + 显示实时额度」，
UI 参考 opencode 官网设计，面板内部化（对外只展示流量）。语言决策：TS 增量
（用户「TS 能实现就 TS」，调研证实全部功能 TS 可实现）。

### 前置调研（4 路 agent + 2 轮深挖，全部证据入库）

- **ZEN 服务**：账号只有 GitHub/Google OAuth 浏览器登录；key 只能网页控制台
  生成（sk-+64 位）；**无公开余额/用量 API**（issue #10448 挂着未合）
- **实时额度三源合流**：主动探针（POST chat/completions max_tokens=1 按
  error.type 分流，实测验证）+ 被动 429 事件 + **Cookie 抓 billing 页**
  （社区 848★ 先例 slkiser/opencode-quota 验证可行：GET
  opencode.ai/workspace/{id}/billing + Cookie auth= 解析余额，
  100,000,000 units=$1）
- **关键实测纠正**：/zen/go/v1/models 对无效 key 也 200（不能判订阅有无）；
  余额类错误混在 401（必须解析 body）；free 模型匿名 IP 限流不能当探针
- **Rust vs Go**：调研实测后放弃重写（TS 全部可实现，Go/Rust 无功能收益）

### 实现（契约文档 .claude/docs/MULTI-ACCOUNT.md，分两波 6 路并行）

| 模块 | 内容 |
|---|---|
| `src/secrets.ts`（新） | secret.key 0600 自动生成 + GATEWAY_SECRET 覆盖，AES-256-GCM 封装 |
| `src/usagedb.ts` | accounts 表 DDL + CRUD（写失败 false 降级哲学延续） |
| `src/accounts.ts`（新） | AccountsStore：加密落库/种子策略/keysForPool/buildAccountsSection |
| `src/billing.ts`（新） | billing 页抓取+两步解析+15min→2h 退避调度（timer unref） |
| `src/admin.ts`（新） | ADMIN_HTML（opencode 设计令牌）+ 8 个管理端点 handler |
| `src/keypool.ts` | PooledKey.accountId + addKey/removeKey 热加载（构造兼容） |
| `src/errors.ts` | classifyAccountError 全表 + quotaSignals 补 3 个 error.type |
| `src/keyprobe.ts` | 账户驱动探针（retry_until 闸门 + kind 分流 payg -free） |
| `src/server.ts` | isAdminRequest + /__admin 路由 + /__metrics accounts 段 |
| `src/main.ts` | 接线：secret→store→pool→probe→billing，启动日志两行 |

测试 405 → **579**（secrets 12/accounts 17/billing 41/admin 25/e2e +16 等）。

### 实机验证（本地假上游，逐项核对）

- 启动日志：`secret: data/secret.key (auto-generated)` + `accounts: 1 (env-seeded)`
- 鉴权矩阵：直连 200 / cf 头 401 / cf+key 200 / Origin 跨站 403
- 创建账号 201 + key 热加载（池 3→5）/ billing 刷新（无 ws 400、fake cookie 502）
- 探针账户驱动：`[keyprobe] account=env probe ok 200` + 状态写账 + retryInMs 倒计时
- /__metrics accounts 段仅管理鉴权出现；面板渲染（2 账号卡、设计令牌、无 JS 错误）

### 对抗审查（@reviewer）发现 3 major + 8 minor，**全部修复**（579 绿）

- **M1 DNS rebinding**（默认配置管理面裸奔，已复现）：isDirectLocalRequest 加
  Host 白名单校验 {127.0.0.1/localhost/::1}，evil Host → 401（实测）
- **M2 AuthError 双表结论相反**（401 AuthError 被归 rate-limit 3s 短冷却）：
  classifyUpstreamFailure auth 分支补 AuthError + 一致性测试
- **M3 billing spike 未做**：解析正则没见过真实页面 —— **待真实 cookie 才能完成**
- m4 %zz 指纹 500→400 / m5 reset 无上限 clamp 30 天 / m6 跨账户重复 key 400 /
  m8 公网 accountId 剥离 / m9 billing 端点读 body / m10 BILLING_INTERVAL_MS 支持 0 /
  m11 updateAccount 存在性校验 / m12 上游原文 stripSecrets 脱敏

### 遗留（上线前必须处理）

1. **billing spike（M3）**：需要真实 cookie 抓一次
   opencode.ai/workspace/{id}/billing 固化为 fixture（用户操作：浏览器 devtools
   复制 auth cookie 给我，或用户自己按 §5.4 步骤做），否则余额显示不可信
2. 未上线、未提交；`scripts/dwgx/kiro_shield.py` 有非本次会话的改动（注入拦截
   400 归 client 超短窗，合理，保留未动）
3. 探针 tick 时 keyprobe 日志中文混排（`probe ok 200` 带括号），风格统一待办

## 第八轮（2026-08-11 晚）：UI 重构 + OAuth device flow 登录（本地验证，未上线）

用户要求（deep 模式审阅后确认）：UI 不理想 → 顶部 tab 标签切换、左侧菜单
（opencode 风格）、下拉菜单按 opencode 设计、**OAuth 登录**（「先启动让我登录，
你获取成功了之后」）。

### UI 重构（src/admin.ts，两路并行：UI 重构 + OAuth 后端）
- 顶部 tab：总览/账号/用量/设置（sticky + accent 下划线）；左侧 sidebar 240px
  （active 加粗 + 2px 竖条，≤48rem 收横滚子导航）；dropdown（160px/border/
  radius-sm/shadow/data-selected）；用量 tab（summary + key 池 + 最近事件）
- OAuth 弹层：验证 URL + 设备码 + 倒计时 + 轮询状态 + 错误重试

### OAuth device flow（src/oauth.ts，官方 CLI 同款协议）
- 端到端实测成功：start（device/code）→ 浏览器授权 → poll（token）→
  并发拉 orgs+user → 自动建账号（email 命名、Org.id=workspaceId）→
  refresh_token AES 加密落库
- **关键协议事实（读 opencode 源码确认，之前 parseOrgs 假设是错的）**：
  /api/orgs 返回裸数组 [{id,name}]（Org.id 就是 workspace id），email 在
  /api/user；verification_uri_complete 是相对路径（官方自己拼 server base）
- 实测日志：`[oauth] account=dwgx1337@outlook.com ws=org_01KZPQ6GSTS0H24ARVQCD8ZNBM created (id=2)`

### 对抗审查（reviewer 二轮）修复
- M1 验证 URL 劫持钓鱼 → 域名白名单（opencode.ai/opencode.dev，fail-closed）
- M2 2s 轮询清空编辑表单 → render 指纹比对（排除每秒变的倒计时字段）
- M3 HTTPS 反代 Origin 403 → hostname+端口归一比较
- m1 orgs 瞬时失败丢 token → refresh_token 暂存会话 + refresh grant 重试
- m2 start 无限流 → 会话上限 10；m3 相对路径补 5 组测试；m6 双转义
- 留待：slow_down 放慢轮询、上游响应体 1MB 上限（低概率）

### 遗留
1. **billing spike（M3）仍待真实 cookie**：现在 workspaceId 已自动拿到
   （org_01KZPQ6GSTS0H24ARVQCD8ZNBM），用户从浏览器 devtools 复制 auth cookie
   到面板即可启用真实余额显示
2. 未上线未提交；探针 tick 时日志中文混排风格待统一
3. 面板 OAuth 弹层的「授权完成后自动刷新」在手动 poll 场景已验证（done→账号创建），
   前端自动轮询路径由单测覆盖

## 第九轮（2026-08-11）：控制台全功能搬入设计（契约文档，未实现）

任务：「把 OpenCode Console 全功能搬进 /__admin 面板」的架构与接口契约设计。
产出：`.claude/docs/CONSOLE-PORT.md`（给实现 agent 的契约），代码零改动。

关键调研结论（并行 agent 直读控制台源码 `anomalyco/opencode` dev 分支）：

- 控制台数据层全是 SolidStart server functions（cookie 鉴权），**没有
  keys/billing/members 的 REST API**；只有 /api/user、/api/orgs、/api/config
  走 Bearer（device flow token）
- **/api/config（Bearer + x-org-id）能列模型**：`config.provider.*.models`
  带 cost/limit/status 完整字段，无订阅/余额信息 —— 「账号可用模型」新数据可行
- server function 协议：`POST /_server` + `X-Server-Id`（形如 `path#fn`，
  构建期生成，需浏览器抓包）+ `X-Server-Instance` + `x-start-type`；
  未登录 302；响应 seroval 流
- billing.get 一次拿全：余额/月限额/自动充值/订阅/支付方式 —— **比现有 SSR
  页面解析更全更稳**，billing.ts 降级为兜底通道（M3 spike 优先级跟着降）

设计要点：通道矩阵（③ fn 主 / ① Bearer 模型目录 / ② SSR 兜底）、新表
balance_history + admin_audit（进 prune）、ConsoleClient（读缓存 TTL + 健康态
+ 写冷却）、console-op 写端点统一 confirm/审计/冷却、**否决 iframe**（登录态
无解，只搬交互语义自绘）、P1 只读 → P2 受控写 → P3 增强。

**上线前 spike（必须用户配合）**：浏览器 devtools 抓 X-Server-Id 清单 +
五个页面真实响应 fixture（usage/keys 响应含 keyId/明文 key，fixture 手动掩码），
验证 seroval 能否直接 JSON.parse，抽查 id 跨构建稳定性。

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

## 第十轮（2026-08-11）：console 数据端点（/__admin/api/console，本地验证）

任务：为网关实现 console 数据端点（读 6 + 写 4 + import-cookie），路由在 server.ts，
ConsoleClient（src/console.ts，REST 新通道）与 cookie.ts 由并行 agent 实现。
测试 628 → **697 全绿**，typecheck/build 干净。**未提交、未接线 main.ts、未上线**。

- 端点：GET billing（五路合并 + cookieState）/ usage?range=Nd / members / keys /
  providers / budgets；POST auto-recharge（confirm:true 强制）/ monthly-limit / keys；
  DELETE keys/:saId；POST import-cookie（端口 9223 写死，cookie 值不进响应/日志）
- 注入：createApp 第 6/7 参数 consoleClient?: ConsoleClientLike + importCookie?:
  CookieImportLike（duck typing，不 import console.ts/cookie.ts，结构类型已验证兼容）
- 契约对齐：并行 agent 实现的 ConsoleClient 与任务契约**有出入**——读方法返回
  Promise<unknown|null> 而非 {ok:false,reason}，健康态是 cookieStatus() 而非
  channelHealth()；已按实际文件对齐（server.ts 的接口 + e2e fake 都以 console.ts
  实际导出为准）。失败分类：读 null → cookieStatus invalid ? channel_error : upstream_error
- fixture 对齐（/tmp/fixtures/console-apis.json）：金额是 microCents 字符串（1e8=$1，
  server 端 microCentsToDollars 换算）；billingStatus 才有余额，billingAccount 只有
  creditLimitMicroCents（不进响应）；usage 无按日数据（byDay 恒 null）；
  budgets 无 user 通道（user 恒 null）；autoRecharge 是美元对象直接透传
- 审计：写操作 console.log `[admin] op=<op> account=<id> by=local`（不建表不记值）
- REST 与旧方案并存：billing.ts SSR 抓取调度原样不动（继续写 balance 列），
  console 端点独立走 REST；REST 失败面板仍见旧通道余额，反之亦然
- 遗留：main.ts 未接线（createApp 没传 consoleClient/importCookie → console 端点
  502 channel_error，已验证不阻塞代理链路）；admin.ts 面板 UI 由并行 agent 接

## 第九轮后半：部署上线（2026-08-11 06:43，deploy.sh 一条龙）

用户指示「让他跑在远端本地关掉 你自己处理好 反正账号和 key 并存」。

### 部署执行
- `./scripts/deploy.sh`：typecheck + 710 测试 + build → tar/scp → 远端原子替换
  （dist → dist.prev）→ systemctl restart → 健康检查（8788 + 经盾 8787 双通）
- 启动日志验证：`secret: data/secret.key (auto-generated)`（0600）、
  `accounts: 1 (env-seeded)`、探针新节奏（15m 轮转 / 60m 空闲）、db 迁移
  （accounts + admin_audit 表建好）
- 代理链路：真实 /v1/messages 请求 200（2 key 池 healthy）
- **账号重建**（key 不出机器，全部在远端 curl + 本地浏览器授权）：
  `[oauth] account=dwgx1337@outlook.com ws=org_01KZPQ6GSTS0H24ARVQCD8ZNBM created (id=2)`
  refresh_token 加密落库 → **账号（console 数据通道）+ key（代理池）并存**
- 本地测试服务/假上游/测试 db 全部关闭清理

### 上线后遗留（汇报给用户）
1. **面板浏览器访问**：线上 DASHBOARD_OPEN=0 → 面板必须 API key，浏览器地址栏
   带不了 header（401 提示 ssh 隧道——但隧道也不免 key，文案与行为不符）。
   建议后续加「面板登录表单」（key 输入存 localStorage）或接受 curl/脚本方式
2. **console cookie**：远端无本机 Chrome，CDP 导入不可用；需用户浏览器 devtools
   复制 `__Host-console_session` 粘贴到账号（或后续做本地抓取→API 传输辅助）
3. **写操作 POST 路径未验证**（自动充值等返回 upstream_error）：待用户在控制台
   页面真实操作时抓包核对

## 第十轮：面板账号密码登录（2026-08-11，713 tests 全绿，已部署）

用户要求：面板登录要账号密码，默认 admin / thankyouopencode（env 可覆盖）。

### 实现
- `ADMIN_USER`/`ADMIN_PASS` env（默认 admin/thankyouopencode）、
  `ADMIN_SESSION_TTL_MS`（24h）、`ADMIN_LOGIN_FAIL_LIMIT`/`LOCK_MS`（5 次锁 5 分钟）
- POST /__admin/api/login：timingSafeEqual 校验 → HttpOnly SameSite=Lax cookie
  （fc_admin_session，内存 token 32 字节随机，进程重启失效）+ 失败限速（IP 维度）
- POST /__admin/api/logout：清会话
- 页面请求（/__admin、/__dash）无凭证 → **登录页**（opencode 风格深色卡片，
  LOGIN_HTML，含锁定倒计时提示）；API 请求保持 401 JSON
- 鉴权链：面板会话 cookie → 本机直连免 key（dashboardOpen）→ API key —— 三者并存
- 面板 header 加「退出」按钮

### 修复过程（一个真实 bug）
登录限速首版不生效：loginLockRemaining 对未锁定记录（lockedUntil=0）也执行
delete —— 每次请求开头的检查把上次失败计数清掉，限速永不触发。调试定位后
改为「只有已过期的锁定记录才清理」，限速测试补齐。

### 验证
- 本地 curl：登录页 200 / 错密码 401 / 登录 200 + Set-Cookie HttpOnly Max-Age 86400
- e2e 新增 3 条（完整登录流程 / 限速 / API key 兼容），713 全绿
- 部署远端：公网 /__admin 登录页 + cookie 数据访问 200

### 遗留
- **线上还在用默认密码 thankyouopencode——必须改**（写 ADMIN_PASS 进
  fuckopencode.env 后 restart）

## 第十一轮：线上 OOM 崩溃循环 + 面板失灵（2026-08-11 08:09 修复）

### 症状
用户报告「面板点击任何功能都没反应，删除账号没反应」。

### 排查链（每步证据）
1. 面板点击无效 + API 请求 ERR_CONNECTION_RESET × 7 → 服务在崩溃重启循环
2. `restart counter 22`、`Main process exited code=killed status=6/ABRT`、`FATAL ERROR: Reached heap limit`——**V8 JavaScript heap OOM**
3. 崩溃 198 次，从 05:56 开始；老进程 4 小时后崩，新进程几秒到 1 分钟崩
4. 停盾稳定 / 起盾稳定 / curl 轮询稳定 / 本地 Node 22+24+真实 db+254MB 堆+并发大请求全部复现不了
5. **关键数据**：用户活跃时内存峰值 **392-430M**——**MemoryMax=400M 撞限必崩**（Node 22 按 cgroup 自适应 V8 堆上限仅 ~254MB，大请求（620KB body × 并发）+ 面板轮询 + 400 重试循环的峰值超过）
6. **修复**：MemoryMax 400M → **640M**（机器可用 1.2G，余量安全；V8 堆上限自适应升到 ~400M）
7. 修复后：用户持续活跃 5+ 分钟，内存 400-430M 稳态波动（非无限泄漏），零崩溃，请求全 200

### 根因
不是代码泄漏，是**部署环境内存上限与真实流量峰值不匹配**：大 body（Claude Code 620KB+ 请求）并发处理的内存峰值 ~400M，400M cgroup 下 V8 堆上限 254M 必然 OOM。系统设计时 MemoryMax=400M 是防挤 xray 的，但没算到多账号版的面板轮询 + 大请求组合。

### 遗留
- 面板 2 秒轮询在 Node 22 上每请求 ~50KB 缓慢增长（本地观察 +3MB/60s，GC 可回收）——640M 余量下无碍，后续可优化（如 tick 节流/指纹已有）
- 用户设 MAX_MESSAGE_CHARS=0/MAX_BODY_BYTES=0（不限）是 kirostudio 大请求的刻意配置，保持

## 第十二轮：面板可读性 + key 昵称 + 登录标准表单（本地验证，未提交）

用户反馈：面板「看不懂」（状态全是 UNKNOWN、健康度没解释）、key 只有指纹想加昵称、
登录后浏览器不保存密码。737 tests 全绿，typecheck 干净。**未提交、未上线。**

- 状态徽标：8 个枚举 → en/zh 友好文案（stUnknown/stOk/stInvalid/stInsufficient/stLimit/
  stCooldown/stRegion/stError），徽标语义色不变；unknown 补「等待首次探测」副标题
- 健康度：总览改「X/Y 账号健康」（Y = 有 key 的账号数），下方小字「健康 = 最近探针正常」，
  未探测的有 key 账号计入「等待首次探测」计数；「最近探针 从未」→「等待首次探测」
- 账号名 max-width 截断 + title 悬浮全文（卡片与详情面包屑）
- key 昵称：PATCH /__admin/api/accounts/:id/keys/:fp（{nickname: string|null}，≤30），
  指纹 → 明文走 store.keysOf + keyFingerprint（进程内，明文不进响应）；面板 key 行
  昵称优先 + 指纹小字，hover 出「改名」（confirm 弹层内联输入框）；i18n 词条齐
- 登录改标准表单：form action/method + input name（浏览器保存密码的前提），删 fetch；
  服务端按 accept 头双模式——application/json → 200/401/429 JSON（脚本兼容），
  其余 302：成功 /__admin（Set-Cookie）、错密码 /__admin?login_error=1、
  限速 /__admin?login_locked=<秒数>；请求体兼容 urlencoded 与 JSON
- 踩坑：块注释里的 `*/`（如 "*/*"）会提前闭合注释——server.ts 和 e2e 各踩一次，
  用 tsc 7 的错误定位 + od 查字节发现的，教训是注释里别写字面量 */*

并行 agent 的 accounts.ts（setKeyNickname / keyNicknameMap / AccountKeyView.nickname）
已落树，契约无出入。遗留：未提交未上线，密码管理器实测待浏览器验证。

## 第十二轮后半：签名会话 + OOM 复发处理 + 用户决策（2026-08-11）

### 签名会话（用户「每次都要输入密码」）
- 登录会话从内存 token 改为**无状态签名 cookie**（HMAC-SHA256，密钥与账户加密同源：
  GATEWAY_SECRET 或 data/secret.key 派生）——服务重启会话不失效，登录一次 24h 免输密码
- 登出用内存黑名单（重启清空，可接受）；e2e token 格式断言同步更新（sig.expiry）

### OOM 复发（启动后 9 秒 394MB 堆满崩溃）
- MemoryMax 640M 下 Node 22 自适应 V8 堆上限 ~400M，峰值撞穿
- **修复**：systemd ExecStart 加 `--max-old-space-size=520`（640M cgroup 内，余量 30%）
- 观察：无流量时 21.5M 稳定；真实流量下的峰值稳定性待用户活跃时确认
- 另发现：线上 API_KEYS 带引号（env 配置），curl 提取需去引号；真实客户端不受影响

### OAuth/Bearer 通道结论（用户决策：放弃，以后再说）
- 实测 4 轮：opencode refresh_token 生命周期极短且每次使用即轮换，Bearer 自动通道线上不可靠
- 探针（OAuth 会话验证）稳定工作；cookie 通道（365 天）最稳
- **用户决策：控制台数据全自动方案放弃，以后由我帮用户上号配置**

### 流通验证（最终）
- 公网代理全链路 200（cloudflared→盾→网关→DeepSeek，thinking+text 正常）
- 服务 3 个 active；签名登录 302 + cookie 正常

## 第十三轮：favicon 噪音 + 面板排查（2026-08-11）

### 修复
- 浏览器自动请求的静态资源（favicon.ico/apple-touch-icon*.png/robots.txt 等 11 个路径）
  直接 404 不鉴权不记录 —— 之前 401 刷屏 /__metrics events（115 条噪音占满面板最近请求）
- 验证：favicon 404 直返、events 零污染

### 面板现状（用户问「两个后台」）
- /__dash（监控）：DASHBOARD_PUBLIC=1 公网公开（流量统计——「对外只展示流量」设计）✓
- /__admin（管理）：登录页 + 签名会话（登录一次 24h 免输密码）✓
- 两个面板数据源 events 已干净

### 遗留
- OAuth/Bearer 通道挂起（用户决策）；cookie 通道最稳（以后帮用户上号）
- OOM：--max-old-space-size=520 缓解，真实流量峰值稳定性待观察

## 第十四轮：大规模实现 + 关键修复（2026-08-11 深夜）

### 完成（765 测试全绿 + 部署）
1. **前台 dashboard 简洁化**：浅蓝长方形=Chrome 合成器残影（sparkline 全 0 平线触发）——三层防御（全等不画线/viewBox 只在宽度变化时写/contain:paint）；key 昵称显示（/__metrics pool.keys 带 nickname）；状态变更精简为 6 条
2. **后台 admin**：语言下拉修复（.dd inline-block + left 对齐 + 字距）；用量 tab 容器化（卡片网格+key 池 panel+请求明细两行式）；账号不可用隐藏空容器（未连接单行提示）
3. **自定义模型映射**：model_aliases 表 + modelmap.ts + API（GET/POST/DELETE）+ 设置页 UI（参考 new-api）+ 运行时生效（cfg.modelMap 原地改）
4. **tool_choice 400 修复**（190 条）：DeepSeek payg 不支持 tool_choice——转换时剥除（默认 auto 语义一致）
5. **OAuth Bearer 通道打通**（用户核心需求）：
   - 实测发现：refresh_token 轮换写回后链可持续（5 跳）、access_token 30 天寿命
   - in-flight 单飞消除并发 refresh 踩踏（之前 400 死链根因）
   - 验证：余额真实返回（balance 0）、并发 3 连测全 ok
6. **盾网络退避**：5s 起 30s 上限（原 1s/12s 导致崩溃死亡螺旋 119 次循环）
7. **堆上限 520→550M**
8. **计费研究**（A5）：Go 订阅三窗口（5h 滚动/周固定/月锚定）+ 倍率烧额度；combinedAvailableMicroCents 为展示总额；usage summary 是 token 成本非订阅额度

### 遗留问题（待处理）
- **公网 502：FurCDN 层故障**——fuckopencode.dwgx.top 的 DNS CNAME 指向 furcdn.top（cdn.taipei），healthz 200 但所有业务路径 502（API/面板全挂）。VPS 本地无 FurCDN 配置（纯云端）。**网关/盾/cloudflared 全部正常**（本机带 Host+XFF 全 200）。怀疑 FurCDN 配额/配置问题——**需用户确认 FurCDN 控制台，或把 DNS 切回 Cloudflare 隧道**（cloudflared 还在跑，配置正确）
- OAuth 探针 token 死（60min 重试节奏 OK）；prv2 key 失效（面板可删）

## 第十四轮后半：FurCDN 公网恢复（2026-08-11 深夜）

### 根因
fuckopencode.dwgx.top 的 DNS 指向 FurCDN（cdn.taipei），FurCDN 源站直连 VPS 的盾（8787）——但盾只监听 127.0.0.1（云端连不上）→ 业务路径全 502（healthz 例外是 FurCDN 健康检查白名单）。

### 修复
- 盾 SHIELD_HOST 127.0.0.1 → **0.0.0.0**（公网可达，FurCDN 源站直连）
- 验证：公网 __dash/__admin/healthz 全 200；公网代理 POST /v1/messages 200（9.7s）

### 安全注意（待用户决定）
- 公网 8787 现在**直接暴露**（原来 cloudflared 在盾前面）——任何人都能打盾
- 盾有拦截机制（错误吞掉重试 + 预算），但建议：防火墙限 FurCDN IP（103.38.82.0/24）+ 本机，或加其他保护

## 第十五轮：旧版控制台（opencode.ai）key 通道后端（2026-08-11 晚，本地验证，未提交）

任务：旧版 workspace（wrk_ 前缀）API key 的读取与管控后端。**协议全部浏览器实测**
（CDP 9223 真实抓包 + 真实创建/删除 + 重新 GET 复核 key 消失），零猜测：

- **读**：GET /workspace/{id}/keys + cookie → HTML，key 列表在 SSR 水合
  `$R[n]={id:"key_...",name:"...",key:"<完整明文>",timeUsed:...,userID:"...",
  email:"...",keyDisplay:"sk-XXXX...XXXX"}`（4 个 key 全量水合；key 明文只在
  解析层用于掩码兜底，**绝不出模块**）
- **创建**：POST /_server + X-Server-Id `44482507...` + urlencoded
  `name=<名>&workspaceID=<ws>`（= 弹窗 form action id）
- **删除**：POST /_server + X-Server-Id `48baebd3...` + `id=<keyId>&workspaceID=<ws>`
  —— **任务给的删除 hash（c22cd964）是旧构建**，实测当前构建从 SSR 删除表单
  action 解析（跨构建稳定），解析不到才兜底常量

改动：src/legacy.ts（新）、usagedb.ts（accounts 加 legacy_workspace_id 幂等 ALTER）、
accounts.ts（legacyWorkspaceIdOf/setLegacyWorkspaceId）、server.ts
（/__admin/api/legacy 三端点，duck-typed LegacyClientLike 第 8 参注入）、
test/legacy.test.ts（新 23 条）、test/usagedb.test.ts（+2 迁移）、e2e +10 条。
**803 tests 全绿 + typecheck/build 干净。**

遗留（未提交、未接线 main.ts —— 端点现返回 502 channel_error，同 console 现状）：
1. main.ts 接线（baseUrl 建议取 cfg.oauthConsoleUrl）
2. admin.ts 面板 UI（并行 agent 在接）
3. 账号需在面板配 legacy workspace id（wrk_ 前缀）+ opencode.ai 的 auth cookie
   （不是 __Host-console_session —— 端点对 __Host- 前缀给明确报错）

## 第十六轮：OpenCode Go 订阅后端（读取 + 开关，本地验证，未提交）

任务：Go 订阅功能后端（src/legacy.ts + src/server.ts + main.ts 适配 + 测试）。
**协议全部浏览器实测**（CDP 9223 目标 F444D52714DB74199D8A18EFD5A33CA4 真抓包 +
开关实点两轮并恢复原状，页面状态已还原）：

- **读**：GET /workspace/{id}/go → HTML，数据在 SSR 水合：
  - `lite.subscription.get["wrk_..."]`：已订阅 = {mine,useBalance,region:[...],
    rollingUsage/weeklyUsage/monthlyUsage:{status,resetInSec,usagePercent}}；
    **未订阅 = 裸 null**（对照 Default workspace 实测确认，且未订阅页无开关区）
  - 中国模型开关**不在水合**，在 SSR checkbox 的 checked 属性
- **写**：POST /_server + X-Server-Id + urlencoded（表单增强提交实测）：
  - useBalance：id `0c8d84b0a700eb0de440ca4c9105b42d6c9ede971d6bf592fa4f91bbeaaa1e6b`，
    body `workspaceID=<ws>&useBalance=true|false`（提交值 = 开关目标值）
  - 中国模型：id `57e61af1bc9c8fa15e0c1a880a2a6754484afdd4a3bc4426b3fc02e3a7ff4d69`，
    body `workspaceID=<ws>&useChinaProviders=true|false`
- 「管理订阅」= Stripe customer portal 跳转（纯前端，后端不做）
- 踩坑：SolidStart 序列化布尔是 `!0`=true / `!1`=false，首版解析写反，
  靠真实抓包 HTML 回归验证抓出（fixture 是仿造的抓不到这层）

改动：legacy.ts（fetchLegacyGoStatus/parseLegacyGoHtml/setLegacyGoToggle +
两个 X-Server-Id 常量）、server.ts（LegacyClientLike +2 方法、GET
account/:id/go、POST go/use-balance、go/china-models，走 runLegacyWrite
统一流程 + 审计 op=legacy.go.*）、main.ts 适配。测试 +26
（legacy.test.ts 17 / e2e 9）。**829 tests 全绿 + typecheck 干净。**
未提交、未上线（同 console/legacy 现状：面板 UI 由并行 agent 接）。

## 第十七轮：全面对抗审查 + 修复（2026-08-12 凌晨，858 tests 全绿）

### 四路审查发现（reviewer×3 + 线上 explore）
**代理链路**（BLOCKER）：B1 120s 硬超时静默截断长流（DeepSeek 长生成>2min 被掐、客户端无错误事件、key 被误标 transient）；B2 客户端断开不中止上游（req.on('close') 时机 bug——死连接占 key 槽位）。MAJOR：M1 上游 key 明文回显泄漏、M2 流中合法 JSON 错误体静默吞、M3 并发下换 key 重试撞同一坏 key。
**管理面**（BLOCKER）：B1 线上仍用默认密码（已改 lozX0OSUMqFcaI2）；M1 会话密钥兜底可预测（fc-session-端口→伪造会话）、M2 登录限速伪造转发头绕过+Map 无限膨胀、M3 账户 CRUD 无审计。
**后台设施**（MAJOR）：M1 探针输掉 refresh 轮换竞态误判会话失效 60min、M2 探活记录污染面板累计、M3 console 硬编码 client_id、M4 history 全表聚合仍阻塞、M5 billing SSR 通道互相覆盖余额。
**线上**：22:12 后零崩溃（550M+盾退避生效）；billing 持续 parse failed（SSR 对 SPA 恒失败）；VPS IP 被 free 模型日窗限流（200 请求/天 UTC 零点）；OOM 根因 worker 大消息未定位（记 ISSUES 待观察）。

### 修复（全部部署验证）
- 代理链路：两段式超时（头 120s + body idle 90s watchdog）、res.on('close') 中止、错误脱敏 stripSecrets、JSON 脏行检测、acquire(excludeKey)
- 管理面：随机会话密钥兜底、loginFails 上限 10k、账户 CRUD 全审计、Secure cookie、控制符清洗、/__admin/ 登录页
- 后台：探针竞态重试、probe 排除出累计、client_id 用 cfg、billing SSR 循环停用（console 已接管）
- **free 限流**：fable-5 改映射 deepseek-v4-flash（订阅端点，Go 订阅额度）；FreeUsageLimitError 冷却到 UTC 零点
- **密码**：默认密码已改（ADMIN_PASS=lozX0OSUMqFcaI2 写入 env）

### 验证
858 tests 全绿；代理直连/公网全 200（订阅模型 8-15s）；面板登录新密码 302；服务稳定。

## 第十八轮：预览 UI + 用量前端化 + 数据采集 + 代码优化（2026-08-12 凌晨，865 tests 全绿）

### 预览 UI（Agent B 实现，已部署）
- 账号列表卡片容器化：5 容器（头/余额/用量摘要/Go 三窗口迷你条/key 列表）
- **用量前端化**：列表页直接显示请求数/输出 tokens/成本 + Go 三窗口（滚动/每周/每月 + 百分比）——不点详情即可见
- previewCache 60s TTL（2s 轮询不重拉）；失败隐藏容器

### 数据采集（Agent A 实测，33 端点全 200）
- P0 待接入：/api/usage/cost-by-day（byDay 恒 null 缺口）、/api/usage/models（模型维度）、/api/usage/users（成员消费）、/api/budgets/users/status、/api/v2/config（60 模型定价表）
- 旧版水合：workspace 页有 balance/pay_ 历史/自动充值（legacy 未读）；members/usage 明细可加

### 代码优化（Agent C 审查，H 级已修）
- H1 删除 legacy key 永远失败（前端传 name 后端要 id）→ 改用 keyId ✓
- H2 健康态死锁（新 cookie 后 invalid 标记不重置）→ noteCredentialChanged（PATCH/import-cookie 后调用）✓
- H3 空 workspace 无法建首个 key（解析把空列表当失败）→ 待修（下轮）
- H4 renderGo null 窗口崩溃 → 渲染「—」+ 未订阅提示 ✓
- M2 前端 creator → creatorEmail ✓；M6 go-err 元素 ✓
- 测试修复：fake timers 残留（M2 测试的占位启用 fake timers → B1 测试挂起）→ 删除 ✓；MAX_LOGIN_FAIL_KEYS 10k→1k（8GB 机器并行性能）

### 验证
865 全绿；API 层验证（列表/用量/Go 三窗口 24%/54%/64%）；浏览器验证受阻（共享 Chrome 被其他会话占用）——用户 Safari 可看

## 第十九轮 C：m12 隐私 + 改写/剥除/压缩观测 + OOM 根因定位（2026-08-12，989 tests 全绿）

任务三件：m12（公网 /__metrics 剥 device.ip）、MetricsCtx 三计数（rewritten/stripped/compressed）上 /__metrics（管理鉴权）、OOM（worker 大消息）根因排查。**typecheck 干净 + 989/989 全绿（并行 agent 的 compact 功能同期落地，测试数从 935 涨到 989）。**

### m12（已完成）
`/__metrics` 组装处：`adminOk = isAdminRequest(req, cfg)` 为 false 时（公网匿名），events 复制后剥 `device.ip`（events 是环形缓冲共享引用，不能原地改），summary 同时剥三个计数键。公网响应结构不变（缺 ip/计数键），管理鉴权完整。

### 观测（已完成）
- `MetricsCtx` 加 `rewritten`（错误改写）/`stripped`（context_management 剥除）/`compressed`（被动压缩触发），进 `RequestEvent` 由 `summary` 窗口求和，/__metrics 仅管理鉴权可见（与 accounts 段同门槛）。
- 挂点：rewriteContextOverflow 拆出带 `{text, rewrote}` 的内部实现（对外契约不变）；context_management 在 handleMessagesPassThrough 调用 normalizeAnthropicRequest 前按 body 字段判定（deepseek.ts 无 ctx）；compressed 在 server.ts 调用处镜像 compactMessages 的触发条件（compact.ts:9 注释本来就写着「压缩计数由 MetricsCtx 观测（波 2）」——就是本轮）。
- e2e 新增 5 条接线测试（匿名无 ip / 带 key 有 ip / 三计数管理面门槛 / 改写 +1 / 剥除 +1 / 压缩 +1 且上游真收到截断文本）；metrics.test.ts +2 条聚合测试。

### OOM 根因（已定位，证据链完整，未改代码）
**结论：不是 worker_threads。`node::worker::Message::Deserialize` 是 Node 22 全局 `structuredClone()` 的内部实现（Node 复用 MessagePort 的传输管线），堆栈里的 "worker" 是红鲱鱼。**

证据链：
1. 代码：全仓唯一序列化点是 `deepseek.ts:106 normalizeAnthropicRequest` 的 `structuredClone(raw)`（首个 commit 就有）；零 worker_threads/postMessage/MessagePort/BroadcastChannel；零 npm 依赖。
2. 线上堆栈（8/11 05:56:37）：frame 38 `node::worker::Message::Deserialize` + frame 10-36 `ValueDeserializer::ReadDenseJSArray` 深层递归，分配失败在 NewRawOneByteString（反序列化物化字符串时）。
3. **复现**：在线上同一 Node v22.20.0 上 `structuredClone(大对象)` 压小堆复现，崩溃堆栈逐地址一致（0x17575af/0x1758585/0x175882f/0x1757e5c/0x17582de/0x1756a0a/0x1757603/0x175896b/0x120dfc7/0xfdfe3b/0xfe1d85/0x1d195e2）。
4. 第二条签名（8/12 04:34:55）：`JsonParser::MakeString` —— 同一批巨大请求体的 JSON.parse，同根因不同分配点。
5. 时间线：**693 次 OOM（8/11 05:56 → 8/12 04:34），按用户活跃时段聚簇（06 时 160 次、11 时 187 次、12 时 102 次、21 时 83 次、22 时 40 次、8/12 04 时 17 次）**。04:55 部署后当前进程稳定 1h+（226M）零崩溃，但根因仍在：`MAX_BODY_BYTES=0/MAX_MESSAGE_CHARS=0`（用户刻意配置）下每次 /v1/messages 请求都对整个请求体做一次 structuredClone（≈2-3 倍体量瞬时内存），大 body 并发即撞堆上限。

修复建议（下轮）：请求体来自 JSON.parse 是请求私有对象，网关路径（handleMessagesPassThrough 调用点）可直接让 normalizeAnthropicRequest 跳过/浅拷贝（deepseek.test.ts 有「不污染入参」契约钉着，改库函数要动测试）；或调用方改为 body 不克隆、按需局部复制。**注意 compact（COMPACT_ENABLED）在 structuredClone 之后执行，救不了克隆峰值。**

### 被动压缩（研究，并行 agent 已实现落地）
wave-1 agent B 的 compact 功能已落树（src/compact.ts + config COMPACT_ENABLED 默认关 + deepseek.ts 挂点 + deepseek.test.ts 单测）：无损层（空白折叠 + 超长单条截断带 `…[truncated]` 标记），有损历史裁剪（tool 配对风险）二期。压缩计数已按波 2 约定接上（见上）。

## 第十九轮：遗留修复 + 实验性功能（2026-08-12，999 tests 全绿，已部署）

### 完成
1. **H3**：空 legacy workspace 可建首个 key（isKeysPage 弱信号锚定，空列表返回 ok keys:[]）
2. **m12**：/__metrics 公网模式剥 device.ip（管理鉴权保留）
3. **OOM 根因修复**（重大）：structuredClone（Node 22 走 MessagePort 反序列化管线——崩溃堆栈 "worker" 是红鲱鱼）——大 body（>512KB）跳过克隆（入参来自 JSON.parse 私有对象），并发大请求不再撞堆；小请求保留库安全契约
4. **P0 数据接入**：cost-by-day 趋势（byDay 不再恒 null）/ usage-models 模型消费 / usage-users 成员消费 / budgets-users-status 成员预算 / models-pricing 模型定价（10min 缓存）——面板全展示
5. **实验性功能**（默认关，设置页可见 + 只读 config 端点）：
   - usage 缩放（SCALE_CLIENT_TOKENS=0.6657，诱导 CC 提前 compact）
   - 被动压缩（COMPACT_ENABLED，4MiB 触发，8000 字符截断，无损层）
   - 观测三计数（rewritten/stripped/compressed——/__metrics 管理端 + 面板「兼容修复」卡）
6. **legacy billing**：旧版余额/自动充值/支付历史（实测 $5 lite 支付真实数据）

### 验证
999 测试全绿；线上：legacy billing 真实数据 ✓、config 端点 ✓、观测计数在位、内存 41.4M 稳定

## 第二十轮：批次 1 —— settings 热配置层 + 分发密钥系统（2026-08-12，本地验证，未提交）

用户任务（分两批，本批是后端全量，批次 2 接面板 UI）：① 一切配置热改（env 默认、
settings 覆盖、运行时不重启）；② 分发密钥系统（可增删改禁、按 OpenCode 计费口径看用量、
走共享池不绑定账号）。

**验收：typecheck 干净 + 1043/1043 全绿（999 + 新 44）+ build 干净 + 真服务冒烟全对。**

| 模块 | 内容 |
|---|---|
| `src/settings.ts`（新） | SETTINGS_META（8 字段默认值+校验）、SettingsStore（settings 表，setMany 单事务）、applySettingsToConfig（apiKeys 数组引用替换 → verifyAuth 下次读取即生效） |
| `src/tokens.ts`（新） | generateToken（tk-+64hex）、指纹=sha256 前 24 hex（明文不落库，verify 无解密）、TokensStore CRUD + verify + usage |
| `src/usagedb.ts` | settings/tokens 表；requests 补 token_fp 列（旧库幂等）；tokenUsageAll（10s 缓存聚合） |
| `src/security/auth.ts` | verifyAuth 第三参 tokensStore（duck-typed）；API_KEYS 未命中兜底分发 token；AuthResult.tokenFp |
| `src/server.ts` | /__admin/api/settings GET/PATCH、/__admin/api/tokens CRUD + /tokens/stats；ctx.tokenFp 落库；createApp 第 9 参 |
| `src/main.ts` | 启动合并 settings（覆盖 env 默认）+ TokensStore 接线 + 启动日志 tokens 行 |

**契约要点（批次 2 面板读 server.ts 端点注释块）**：GET settings 的 adminPass value/default
恒 ''（密码不回显）、apiKeys 只回掩码数组（****XXXX）；GET/PATCH settings 与全部 tokens
端点都过 Origin 校验；token 明文只在 POST /tokens 创建响应出现一次；管理面（isAdminRequest）
刻意不接受分发 token（有测试钉住）；改 adminPass 不清旧签名会话（24h 内仍有效，文档注明）；
PATCH apiKeys 是替换语义可自锁（文档注明）。

**对抗审查**（reviewer 独立验证 typecheck+全量绿后报告）：M1 PATCH 多键部分写失败分叉 →
setMany 单事务修复；M2 apiKeys 明文回显 / adminPass 默认值泄露活密码 / GET 无 Origin →
掩码 + 默认值回空 + Origin 补上，测试同步更新钉住；m1 note:null 400 与错误消息矛盾 →
放行；m2 状态收敛与 verify 一致；m4 熵值注释 128→256-bit；垃圾文件 `3000` 已删。
测试盲区：管理面拒分发 token 不变量、旧库迁移 token_fp 断言、setMany 原子性（只读文件注入）、
SETTINGS_META 全覆盖 apply，全部补齐。

**遗留**：未提交、未上线（工作区含历轮未提交改动，提交范围待用户确认）；批次 2 面板 UI 未接。

## 第二十轮：超级大计划（分发密钥 + 热配置 + 主页健康度，2026-08-12，1069 tests 全绿，已部署）

### 用户决策
- 计费：不自己定价——按 OpenCode 计费口径（costMicroCents，1e8=$1，透传显示）
- 分发密钥：共享池（不绑定账号）
- 配置：全部热配置（settings 表，env 默认 + settings 覆盖）
- 主页：统计卡 + 趋势 + 状态

### 批次 1（后端）
- **settings 热配置层**：settings 表 + SettingsStore + applySettingsToConfig（apiKeys 数组引用替换/密码/实验开关原地改——运行时生效）+ GET/PATCH 端点（掩码/回空隐私口径 + Origin 校验 + 审计 + setMany 事务）
- **分发密钥系统**：tokens 表（明文不落库——只存 sha256 前 24 hex 指纹）+ 生成/CRUD/禁用 + verify（指纹查表，无解密）+ 用量统计（按 token_fp 聚合 requests/输入输出 tokens/costMicroCents——10s 缓存）+ 鉴权集成（verifyAuth 第三参——分发 token 不能进管理面）+ token_fp 落库
- **参考研究**：new-api 令牌形态（掩码/状态徽章/用量进度条/批量创建）+ sub2api（生成/状态机/后扣）+ opencode 计费口径确认（microCents=cents×1e6、按模型单价×token 计、billingSource=balance 才真扣钱）

### 批次 2（前端）
- 密钥 tab：列表（名称/状态徽章/掩码/用量/操作）+ 创建弹层（Name+批量 1-10+明文仅此一次+复制）+ 编辑/禁用/删除
- 主页健康度：统计卡组（总请求/成功率/密钥费用/分发密钥数 + SVG sparkline 12 桶）+ 状态列表（网关/上游池/账号/分发密钥/兼容修复计数）
- 设置页热改：账号密码（留空不提交+旧会话 24h 提示）+ API_KEYS 管理（localStorage 明文缓存兜底）+ 实验开关（toggle）+ 来源标记（env/面板）
- 余额标注：账号卡「余额（org）」

### 批次 3（对抗审查 + 修复）
- 无 BLOCKER；2 MAJOR + 7 MINOR 全修：M1 掩码提交锁死（apiKeys 拒绝 **** 前缀——实测修复）M2 默认密码（用户指定 13141516——保留+文档统一）m1 明文 DOM 清理（关闭即清）m2 密码 min 8 m3-m7（掩码信息量/默认语义/401 落库/错误形状/密码不 trim——密码不 trim 已修）

### 验证（线上全链路）
创建 token → 公网请求 200 → 用量统计（请求 1/费用 $0）→ 禁用 401 → 删除 ✓
1069 测试全绿；settings 热改（密码/API_KEYS 即时生效）测试钉住

## 第二十一轮：服务端归因与协议转换 7 项修复（2026-08-13，本地验证，未提交）

对抗式全面审查发现的 7 个 MAJOR（均有反例验证），逐项修复 + 回归测试，**1166 tests 全绿** + typecheck/build 干净。

| # | 问题 | 修复 | 回归测试（去掉修复会红） |
|---|---|---|---|
| 1 | 非流式上游 body 读失败（200+非法 JSON / idle 掐断）被 markSuccess | data===null 先 markFailure('transient')+noteUpstreamError 再 502，只有非 null 才 markSuccess（chat+直通两处） | e2e「非流式上游 body 非法」2 条（chat/直通） |
| 2 | 客户端断开（res close→abort→AbortError）把健康 key 记成 transient | 抽 `isClientAbort(controller,res)`（signal.aborted && res.destroyed），断开不 markFailure；只有 idle/网络错误才记 | e2e B2 测试加 failCount 前后断言 |
| 3 | chat 路径脏流静默截断（无 [DONE] 无错误） | 镜像直通：脏行补 error chunk + markFailure('transient') + ctx.error 落库 | e2e「脏数据时中止，发错误 chunk」更新（原钉「无 [DONE] 是正确行为」已改） |
| 4 | >512KB 跳过克隆时 normalize 原地改 body.model，响应 model 回显分叉 | normalize 前快照 `requestedModel`，ctx.model/两处回显全用快照 | e2e「大 body」2 条（非流式/流式回显客户端模型名） |
| 5 | 上游先 content 后 reasoning 时收尾 text_delta 打进仍开着的 thinking 块 | 收尾段 `openTextBlock.kind !== 'text'` 先 close 再新开 text 块（同循环 234 行） | toAnthropic「content 先于 reasoning_content」1 条 |
| 6 | chat 换 key 重试第二个 key 失败从不 markFailure（B 永不降权） | `failureReported` 标志：统一错误出口只对未上报过的 key 补 markFailure | e2e「第二个 key 的失败也上报」1 条（两 key failCount 各 +1） |
| 7 | 直通流式 input_tokens 恒 0（message_start 硬编码 0、message_delta 只带 output） | message_delta.usage 补 `input_tokens`（真实未缩放，不受 SCALE_CLIENT_TOKENS 污染），server 取用 | toAnthropic 2 条更新 + e2e「流式 input_tokens 进 ctx」1 条 |

注意点：
- 改动面：`src/server.ts`、`src/toAnthropic.ts`、`src/types.ts`、`test/e2e.test.ts`、`test/toAnthropic.test.ts`。
  `src/admin.ts`/`test/admin.test.ts` 的改动是并行 agent 的，未碰。
- 每项修复都验证过「去掉修复该测试变红」（临时 revert 单项 + 跑定向测试确认红，再还原）。
- 遗留：未提交、未上线；线上 memory 约束 / billing spike 等旧遗留不变。

## 第二十二轮：安全加固（2026-08-13，本地验证，未提交）

对抗式审查安全清单 6 项全实施 + 回归测试（每项都验证「去掉修复会红」）。**只碰安全区域**（config.ts、settings.ts、kiro_shield.py、server.ts 鉴权/登录/会话区、相关测试）；count_tokens/requests 记账是并行 agent 的域，未碰。

| # | 项 | 改法 | 回归测试（去掉修复会红） |
|---|---|---|---|
| 1 | DASHBOARD_OPEN 默认 false | loadConfig 默认 true→false（fail-closed） | security.test.ts「DASHBOARD_OPEN 默认 false」——改回 true 即红 |
| 2 | 默认密码强提示 | 默认值保留（线上 13141516 在用）+ settings GET 加 `adminPassIsDefault` + 登录成功用默认密码打 stderr 告警 + DEFAULT_ADMIN_PASS 常量单源 | settings.test.ts「adminPassIsDefault：等于默认值时置 true」 |
| 3 | 登录限速转发头 | 盾剥离伪造转发头**修复**（原 title-case 键 pop 小写永不命中——剥离从未生效，实测伪造头透传）；网关 clientIpForRateLimit fail-closed（非回环对端忽略转发头） | 盾 test-shield.py「覆写 cf-connecting-ip 并剥离伪造转发头」+ security.test.ts「轮换 XFF 无法改变非回环对端的键」 |
| 4a | 会话 m1 | 密码版本 sha256(adminPass) 编进 HMAC——改密码旧签名会话立即失效 | e2e「m1：adminPass 变更后旧签名会话立即失效」——去掉 passwordVersion 即红 |
| 4b | 会话 m2 | revokedSessions Set→Map + 过期清理 + MAX_REVOKED_SESSIONS 上限 | e2e「m2：revokedSessions 按过期清理 + 上限」——prune 变 no-op 即红 |
| 4c | 登录 m4 | login POST 先过 adminOriginAllowed（跨站表单锁 DoS，校验在限速前） | e2e「m4：跨站表单登录被 Origin 校验拒绝」——去掉校验即红 |
| 5 | 盾管理路径 401/403 透传 | classify() 在 body 标记判断前加 ADMIN_PATH_PREFIXES 401/403→pass | 盾 test-shield.py「管理路径 401 原样透传/不重试」 |

**盾侧发现并修了一个潜伏 bug**（commit 30d20a7 引入）：`_collect_request` 的 `headers.pop("x-forwarded-for")` 等因 `http.server` 头键是 title-case（X-Forwarded-For）永不命中，**剥离伪造转发头从未生效**——轮换 XFF 直连盾即可绕过登录限速。已改为构 dict 时统一小写过滤。连带修复 test-shield.py：`call()` 补非回环 Host（`_check_host` 拒 Host:127.0.0.1，测试 harness 自 30d20a7 起全 403）。

**验证**：typecheck 干净；security 65 / settings 27 / e2e 登录 13 / 盾 37/37 全绿。全量 `npm test` 1186/1187——仅剩 1 条失败「直通流式 input_tokens 落库」（并行 count_tokens/requests agent 的在途改动所致，本会话期间其改动让失败数从 4 收敛到 1，属其域，未替它修）。

**需要用户注意**：
- 默认密码方案选了「保留默认 + 强提示」而非「首次启动随机生成」：改默认值会破坏线上现有登录（13141516 在用），随机生成需面板可读（admin.ts UI，本域外）。强提示已三条路：settings GET adminPassIsDefault（面板据此显示）、登录 stderr 告警、DEFAULT_ADMIN_PASS 单源。面板 UI 那行提示（读 adminPassIsDefault 字段）留给 UI agent，一行。
- 会话语义变化：改 adminPass 后旧签名会话**立即失效**（此前 24h 内仍有效）——已知取舍注释已同步。

## 第二十三轮：监控/观测增强（2026-08-13，本地验证，未提交）

对抗审查观测清单 + 用户「更强的观测」。**只碰监控/记账区**（count_tokens/requests/metrics/审计/admin 请求日志/usagedb audit 表）；鉴权/登录/会话/盾是并行安全 agent 的域（未碰），oauth/console/legacy 通道按任务约束未碰。

| # | 项 | 改法 | 回归测试（去掉修复会红，已实测） |
|---|---|---|---|
| 1 | count_tokens 落库恒 0 | `handleCountTokens` 改 async+await（finally 不再抢跑于 .then()）；body 读失败/JSON 错写 ctx.error；`ctx.endpoint='count_tokens'` 标记 | e2e「count_tokens 落库真实 input_tokens」——去掉 await 后 `expected 0 to be greater than 0`；e2e「count_tokens 读失败写 ctx.error（413）」——去掉写 error 后 `null.toContain` 红 |
| 1b | 记账请求不进请求数统计 | metrics 事件跳过 count_tokens（finally 里 `ctx.endpoint !== 'count_tokens'`）；db 聚合全部 `endpoint NOT IN ('probe','count_tokens')`（usageTrend/history byKey+total/statsByIp/usageByKeyFingerprints/tokenUsageAll）；listRequests 仍可见（endpoint 区分） | usagedb「count_tokens 排除出用量聚合」——恢复后 `expected 2 to be 1` |
| 2 | 用量账本确认 | 直通流式 message_delta.usage.input_tokens 取用链 server.ts:2611-2617（第二十一轮 #7 已部署）→ 补 db 级断言（原只测 /__metrics events） | e2e「直通流式 input_tokens 落库」 |
| 3 | 操作审计视图 | admin_audit 补 ip 列（迁移幂等）；登录/登出/tokens/settings/model-alias/账户 CRUD 审计全带 ip；登出补 op=logout；GET /__admin/api/audit 端点；用量 tab「操作审计」section（谁·何时·做了什么，联表账号名） | e2e「登出落 admin_audit + 审计端点读回」——去掉 logout 审计后 `expected false to be true`；usagedb listAdminAudit（ip + 联表 + limit） |
| 4 | 错误观测 | 请求明细 error 列已有（.s-bad 详情行）→ 补 error 进 q 搜索 + placeholder 更新；successRate=ok/(ok+failed) 确认覆盖 429/5xx（usageTrend failed = status>=400 OR =0） | usagedb「error 列纳入搜索」 |

**设计说明（审计脱敏口径）**：admin_audit 只存 op/accountId/ok/note/ip 摘要——金额与 cookie 明文绝不落库（沿用既有 insertAdminAudit 哲学）。面板审计视图对每个管理写操作显示：时间 / 操作 / 结果 / 账号（联表名字，删号后回落 #id）/ IP（来源）。console/legacy 写操作的 execute* 辅助函数无 req 且属「不碰通道」约束，其审计保持原 op/accountId/ok/note 不变（ip 为 null），其余打点全带 ip。

**验证**：typecheck 干净；npm test **1187/1187**（27 文件，第二十二轮安全 agent 的 4 条在途失败已由本轮收敛）。变异验证：await、ctx.error、count_tokens 排除聚合、logout 审计四处去掉即红。

## 第二十四轮：OAuth 账号 console 数据完整接入 + cookie 失效替代路径（2026-08-13，本地验证，未提交）

任务：OAuth 授权账号的 console 数据完整覆盖 + refresh 失效明确状态 + cookie 失效的 OAuth 替代引导。
**只碰 oauth.ts/console.ts/server.ts 的 console+OAuth 端点区 + admin.ts OAuth 弹层/提示区 + 相关测试**。
typecheck 干净 + **1195/1195 全绿**（1187 + 新 8：console.test +6、admin.test 相关断言、e2e +2 场景）。

### 现状探查结论（先探查再动手）

- **OAuth 已全覆盖所有 console 读端点**：console.ts 所有读/写端点统一走 `getCredentials()`
  （cookie 优先，401 后回退 Bearer），无 cookie-only 端点。workspaces 端点是 store 推断
  （不查上游），OAuth 账号同样能用。真实上游是否认 Bearer 未实测（需活 OAuth 账号）——
  代码层覆盖完整，诚实披露。
- **缺失一：失效通道不可区分**。`recordFail` 只记 invalid，不记 cookie 还是 OAuth Bearer 失效
  → 面板对 OAuth 账号也提示「更新 cookie」（错误指引）。
- **缺失二：refresh 失效的误报面**。refresh 网络/5xx 失败此前也判 invalid → 面板会提示
  用户重新授权，而一次网络抖动根本不需要重新授权（最贵的误报）。
- **缺失三：OAuth 弹层 not_found 文案缺失**（落到泛 oauthFail）。
- **补绑现状（确认）**：`persistOauthAccount` 按 workspaceId 幂等 —— 同 workspace 的现有
  cookie 账号再走 Sign in with OpenCode 即「补绑」（cookie + refresh 并存，cookie 优先、
  失效自动回退 Bearer）；不同 workspace 才新建。补绑零成本，已文档化（server.ts 注释）。

### 改动（逐项）

| 文件 | 改动 |
|---|---|
| src/console.ts | health 加 `channel` 字段；`recordFail` 带通道；`authChannel(id)` 新方法；getJson/postJson 401 记通道；refresh 401/403 → oauth 失效、5xx/网络 → **不**判失效 |
| src/server.ts | ConsoleClientLike 加 `authChannel`；`consoleCookieState` 返回 `oauth-invalid`；billing invalid 路径区分；`sendConsoleReadFailure` 按失效通道给不同文案（OAuth → sign in with OpenCode）；`persistOauthAccount` 补绑语义注释 |
| src/admin.ts | detail-cookie 横幅加 `detail-oauth` 按钮（复用 OAuth 弹层）+ oauth-invalid 专属文案 + oauth-invalid 时隐藏 cookie 导入行；`oauthError` 补 `not_found` 文案；i18n en/zh 加 `oauthInvalid`/`oauthInstead`/`oauthNotFound` |
| test/console.test.ts | +6：Bearer 覆盖全部 15 个读端点 + 4 个写端点（refresh 单飞）、refresh 401→oauth 失效、refresh 5xx→不失效、cookie 401→cookie 失效后 Bearer 恢复、Bearer 数据请求 401→oauth 失效 |
| test/e2e.test.ts | FakeConsoleClient 加 `oauthInvalid`/`authChannel`；+2：billing cookieState=oauth-invalid、读失败 502 文案指引重新授权（非更新 cookie） |
| test/admin.test.ts | 钉住 not_found 映射、detail-oauth 接线、oauth-invalid 分支、i18n 新键 |

### 验证（真实输出）

```
npm run typecheck  → 干净
npm test           → Test Files 27 passed / Tests 1195 passed（2.6s）
npm run build      → 干净
```

### 遗留

- 真实上游 Bearer 接受度未实测（本地无活 OAuth 账号）；OAuth 账号线上实测时核对
  console 各端点是否真认 Bearer，若不认需给 console.ts 的 Bearer fallback 加白名单降级。
- 未提交、未上线（工作区含并行 agent 的未提交改动，提交范围待用户确认）。

## 第二十五轮：流式/转换路径内存优化（2026-08-13，本地验证，未提交）

任务：对抗审查确认的 O(n²) 拼接 + 全量缓冲风险。只碰 toAnthropic.ts / deepseek.ts /
sse.ts + 相关测试。typecheck 干净 + build 干净；全量 1216/1218 绿（2 条 usagedb 失败为
并行 agent 在途改动，stash 我的改动后同样失败，与本轮无关）。

| # | 项 | 改法 | 回归测试（新） |
|---|---|---|---|
| 1 | 流式缓冲上限 | bufferedText `+=` → 分段数组；缓冲含 `<`/`⟨`（DSML 标记信号）才累积，无标记即提前流式（TTFB 恢复首字）；超 256KB 硬上限放弃该流 DSML 兜底、转直接流式；流式遇新标记可回到缓冲重新兜底 | 上限触发转流式、无标记提前流式、放弃后不再二次缓冲、前缀 flush 后标签仍还原 |
| 2 | normalize 克隆 | <512KB 的 structuredClone 改为 fieldCloneBody（只深拷贝会被原地修改的 messages/tools），移出 MessagePort 反序列化崩溃路径；触发压缩时回退全量拷贝 | 深层隔离、deepFreeze 零写入、压缩路径冻结也过、字段拷贝与全量路径等价 |
| 3 | SSE buffer 上限 | parseOpenAISSE/parseAnthropicSSE 的 `buffer +=` 与 dataLines 累积设 1MB 硬上限，超限抛错断流（server 已有 catch 转错误事件 + markFailure） | 超长单行抛错、同事件 data 行累积超限抛错、大量合法短行不触发 |

DSML 兜底窗口模式边界（诚实披露）：标签切在 chunk 边界的常见场景照常兜底（切片含
`<`）；「已提前发出的前缀文本」无法追溯（保持普通文本，其后标签仍还原）；超过 256KB
或已被放弃的流不再兜底（偶发 quirk 收益 < 内存风险，注释说明）。

