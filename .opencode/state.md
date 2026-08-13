# fuckopencode 接收文档（新会话从这里开始）

更新时间：2026-08-14（最近一次大改动：账号级模型白名单 + 订阅探测）。**本项目继续由主控负责（用户明确：不用 fable，一切由主控）。** 新会话先读本文件，再读 `.claude/docs/ARCHITECTURE.md`、`DEEPSEEK-QUIRKS.md`、`SHIELD.md`、`MULTI-ACCOUNT.md`。

---

## 一、项目一句话

OpenAI ↔ Anthropic 协议转换网关（上游 opencode Zen 订阅 + DeepSeek），带**多账号管理面板**（账号/分发密钥/RPM/热配置/观测/审计），生产在 nbus（2GB VPS），前面有 Python 护盾（FurCDN 直连回源）。

**测试基线：1278 条全绿**（28 文件）+ 盾测试 40/40。`npm run typecheck` 干净。

## 二、架构（模块与数据流）

```
客户端(Claude Code/Cursor/kirostudio)
  → FurCDN (cdn.taipei, 边缘缓存/加速)
  → 盾 kiro_shield.py (8787, Python, 并发闸门 200/重试吸收/观测端点仅回环)
  → 网关 main.js (8788, systemd fuckopencode)
      ├─ 代理链路: /v1/chat/completions (OpenAI) + /v1/messages (Anthropic)
      │   鉴权(API_KEYS/分发key) → RPM限流(ratelimit.ts) → 模型门(resolveModel)
      │   → key池选号(keypool.ts, 账号级allowedModels过滤) → 上游(/zen/go 订阅 | /zen 按量)
      │   → 响应转换(toAnthropic/toOpenAI/sse, 流式) → 错误分类(errors.ts)
      ├─ 管理面: /__admin 面板(admin.ts 单文件内联JS) + /__admin/api/* (accounts/tokens/
      │   console/legacy/settings/audit/requests/models)
      ├─ 数据层: usagedb.ts (SQLite, WAL, 用量批量异步落库 100ms/50条事务)
      │   accounts表(cookie/oauth加密) tokens表(分发key 明文AES加密存) settings表(热配置)
      │   requests表(用量) admin_audit表(操作审计)
      ├─ 控制台通道: console.ts(新版 opencode REST, cookie/Bearer fallback, OAuth补绑)
      │   legacy.ts(旧版网页抓取: keys/GO订阅/计费)
      └─ 观测: metrics.ts(改写/剥离/压缩计数) keyprobe.ts(探活所有key, 15m)
```

**关键设计**：
- 密钥/明文（cookie/分发 key）AES-256-GCM 加密落库（secret.key，`1:...` 格式）；分发 key 明文加密存储、面板可查看/复制。
- 模型门：`ALLOWED_MODELS`（deepseek-v4-flash/free 全局底线）+ **账号级 allowedModels**（accounts 表列，选号过滤，对齐 kirostudio 语义）——白名单外**明确拒绝 400**（不再静默降级）；池冷却才是 503。订阅实际可用 21 模型（探测清单见下）。
- 上游订阅模型（**实测可用 21 个**）：deepseek-v4-flash/pro、glm-5/5.1/5.2、kimi-k2.5/2.6/2.7-code/k3、minimax-m2.5/2.7/m3、qwen3.5/3.6/3.7/3.7-max/3.8-max-plus、gpt-5.6-luna、mimo-v2.5/2.5-pro、hy3。不可用：grok-4.5(503)、mimo-v2-pro/omni(400)、hy3-preview(400)。
- 请求日志默认过滤噪音（健康检查/probe/count_tokens），「显示全部」开关。
- 错误透传：GoUsageLimitError 原样透传（含 Resets in ...，盾 passthrough）——下游能看到额度信号。

## 三、当前状态

- **最新 commit**：`d1083b8 feat: 账号级模型白名单与白名单外明确拒绝`（已 push 到 github.com:dwgx/fuckopencode main）。
- **线上已部署**：网关 + 盾都 active（最近部署 08-14，模型白名单轮）。公网面板 200。
- **本机压测基线**（假上游）：并发 100 → 664 RPS / 200 → 1435 RPS，错误率 0，内存 113-133MB。完整报告在 `/tmp/perf/report-baseline.json`（并发梯度/流式/分发key/混合场景）。
- **工作树**：干净（无未提交）。

## 四、最近完成（08-12 ~ 08-14 大轮）

1. **多账号面板全量**：账号层 AES/OAuth/探活、双控制台通道（console 新版 + legacy 旧版）、分发密钥（RPM/明文加密查看/复制/补录）、热配置（settings 运行时）、面板全量（趋势/workspace 切换/右键详情/loading/错误中性化/请求过滤）。
2. **线上稳定**：OOM 修复（structuredClone）、400 改写、盾并发闸门/观测回环/管理路径 401 透传/quota passthrough、GoUsageLimitError 透传、探活覆盖所有 key、非流式 150s 超时封顶。
3. **安全加固**：伪造 Host 免鉴权（B1）、DASHBOARD_OPEN 默认关、会话密码版本、登录 Origin 校验、转发头剥离、登录 body 上限。
4. **性能 3 轮**：热路径查询合并 + 批量异步落库、流式 O(n²) 消除 + 缓冲上限 + 字段级克隆、SSE 上限；高并发回归测试。
5. **监控**：操作审计（admin_audit + 面板视图）、count_tokens 记账修正、趋势真实聚合。
6. **模型白名单**（本轮）：账号级 allowedModels + 白名单外明确拒绝 400 + 被动学习 blocked + 目录定时刷新 + 面板可用模型区块。订阅 21 模型实测清单（见上）。
7. **OTA 研究**：cursorapi/windsurf/kirostudio 三项目 OTA 对比 + 改进提示词（桌面 `OTA-改进提示词/`）。
8. **outlook key**（sk-HwTc...7qpF）：已补进 env 账号 + 昵称「dwgx outlook key」；探活现在覆盖全部 3 key（ZOBb/0osU/7qpF）。

## 五、2026-08-14 深度审计结论（10 个并行 subagent，已核实 + 新发现）

### P0 核实：4 项全部属实（修复方案已定，见各条）
1. **console 读缓存无单飞**（console.ts cachedGet ~326）：属实，触发面比描述宽（冷启动/慢上游 2s 轮询 × 15s 超时可叠 5-7 并发）。修复：in-flight promise 去重（仿 refreshInflight 先例）。**红线：naive 去重会重新引入 M2 竞态——必须「只有 leader 写缓存」+「invalidate 时清该账户 in-flight 条目」+ finally 身份判断删除**。
2. **shutdown flush 不可达**（main.ts 210-219）：属实。丢的是 exit 前最后 ~100ms-5s 的行（非整个部署周期）。修复：shutdown 开头同步 usageDb.flush() → server.close → closeIdleConnections() → 兜底 exit(0)（flush 已安全，exit(0) 消除 systemd FAILURE 噪音）。close() 幂等可重复调。抽 src/shutdown.ts 可单测。
3. **legacy keys/billing 无服务端缓存**（server.ts 4542/4599/4617 + admin.ts tick 2982-2985）：属实。详情页每 2s 打 3 次上游 HTML（keys/go/billing），每分钟 90 次。纠正：LegacyPlainCache 其实有 15min TTL（legacy.ts:195），keys/plain 有缓存、keys 列表/go/billing 零缓存。修复：server.ts 内部 LegacyTtlCache（30s TTL、只缓存成功、写操作成功失效、legacyGuard 清删号）+ 前端 TTL 门（loadGo/loadLegacyKeys/loadLegacyBilling 加 fromTick 门，loadLegacyBilling 需补 fromTick 参数）。**e2e 风险：现有 legacy 用例共用 proxy 实例，加缓存后互相污染——需 beforeEach 清缓存**。
4. **默认密码弱**（13141516）：属实。服务端 adminPassIsDefault 已就绪（server.ts:928/1004），UI 用 source==='env' 判断（admin.ts:3950）——生产 env 显式强密码必误报（settings.test.ts:302-318 就是反例锚点）。修复：loadSettings 缓存补 adminPassIsDefault + renderSettings 改判定 + oc-chip st-error 徽章 + i18n 键（en/zh 对称）。**测试风险：admin.test.ts:1715 硬编码断言旧逻辑，必须同步改**。

### 审计新发现（文档没覆盖，按严重度）
**P1-A. 账号级白名单缓存被任意 PATCH 静默清空**（accounts.ts:277，最严重新发现）：`update()` 末尾无条件 `allowedCache.set(id, dbPatch.allowedModels ?? null)`，任何不含 allowedModels 的 PATCH（改 cookie/name/workspaceId 常见操作）把白名单覆盖成 null → 最新 commit 功能内存态失效，零日志、重启才恢复。修复一行 + 回归测试。

**P1-B. 客户端连接/响应头阶段断开被误记 transient，累计禁健康 key**（upstream.ts:199）：postUpstreamChat catch 无条件 markFailure('transient')，isClientAbort 只护 body 消费阶段（server.ts:2441）。修复：catch 里 `if (!signal?.aborted)` 才记。

**P1-C. tool_choice 两路径不对称**：直通剥（toOpenAI.ts:61，实测 -free/payg 400），chat 原样转发（server.ts:2785 剥除列表不含）→ -free 模型 + 显式 tool_choice = 上游 400。修复：prepareOpenAIUpstreamRequest 对 -free 模型剥 tool_choice（或无条件剥，对齐直通）。

**P1-D. 全链路无并发在飞上限**（P1-9 原待办，审计确认现状=无）：undici 全局 fetch 无 per-origin 连接上限（实测 40 并发=40 socket），大 body 2-4× 拷贝滞留整个流时长 → 唯一 OOM 向量。修复：数据面入口计数 + 超限 503（Retry-After）+ finally 减计数；限流响应照 RPM 429 写法（req.resume + connection: close）。

**P1-E. 生产 MAX_BODY_BYTES=0（无上限）+ 注入扫描/count_tokens 放大 = 认证客户端内存/CPU DoS**（config.ts:256，server.ts:565 注释）。修复：生产设回具体值（如 32MB）或扫描字节预算。

**P1-F. history() 每 15s 全表 GROUP BY 同步阻塞事件循环**（usagedb.ts:1274-1369）：150K 行 646ms、60 万行最坏 10s，期间所有在飞 SSE 冻住。15s 缓存只降频不降耗。修复：flush 事务内维护 key_totals 聚合表（中等改动）。

**P1-G. chat 路径 max_tokens 下限保护丢失**（quirk 6 随 request.ts 退役未迁移，server.ts:2759-2789 不碰 max_tokens）：小预算 + thinking = 空输出，与直通不一致。修复：补回或文档明确废弃（至少消文档漂移）。

**P2（加固/一致性，审计确认）**：
- 面板用量 tab 三请求（requests/ipstats/audit）非 usage 视图每 2s 空转（admin.ts:2968-2970）——`if (curView==='usage')` 一行
- 2s tick 无 in-flight 防护，慢网络请求叠加（admin + dashboard）
- 面板 loadLegacyBilling 未接 sticky/fromTick（admin.ts:4836）
- Origin 校验数组头放行（server.ts:3190）——语义错误当前不可利用
- flush() 整批丢弃面比文档宣称宽（transient 写失败也丢，usagedb.ts:830-850）——放回队首重试 1 次
- 早期错误（401/415）不消费 body 不关连接 → keep-alive 污染（F7）
- writeChunk 监听器累积（F5，ISSUES I-7 仍在）
- 流式含 `<` 文本 + tool_calls 内容重排（toAnthropic.ts 缓冲到收尾）
- 注入检测围栏降权吞 ignore-instr（injection.ts CODE_FENCE_SIGNAL_IDS）
- history/trend 缓存返回内部引用（usagedb.ts:1280/1049/1105）
- admin sparkline 缺 dashboard 已修的 SVG 重写防护

### 文档漂移（P2-11 确认）
- DEEPSEEK-QUIRKS.md 行号系统性过期（9 处中 8 处错，deepseek.ts 160→533 行）
- 模型白名单（d1083b8）零文档；tokens/RPM/审计/请求过滤未入档
- ISSUES.md I-6（SSE 缓冲无上界）已修（eac0f43 + stream.test.ts:330-343）仍标「可疑/未验证」
- ARCHITECTURE.md 模块表缺 accounts/billing/console/legacy/oauth/ratelimit/settings/tokens/modelmap 等 13 个主力模块
- /healthz 唯一无测试端点（风险低）

## 六、2026-08-14 本轮修复进度（全部完成，全量 1297 绿）

- **P0-1 console 单飞** ✅：cachedGet in-flight 去重（只有 leader 写缓存 + invalidate 清 in-flight + finally 身份判断），console.test.ts +3（5 并发→1 次 / invalidate 不搭旧 in-flight / noteCredentialChanged 不搭旧凭据）。
- **P0-2 shutdown flush** ✅：抽 src/shutdown.ts（先显式 closeDb → server.close → closeIdleConnections → 兜底 exit(0) + exitOnce 去重），main.ts 接线，test/shutdown.test.ts +5。
- **P0-3 legacy TTL 缓存** ✅：server.ts LegacyTtlCache（30s、keys/go/billing 三端点、写成功失效、legacyGuard 清删号、createApp 可注入第 11 参），admin.ts 前端 TTL 门（legacyDetailFresh + loadLegacyBilling 补 fromTick），e2e +5（命中 ×3 + createKey/setGoToggle 失效），beforeEach 清缓存防污染。
- **P0-4 默认密码徽章** ✅：loadSettings 缓存补 adminPassIsDefault + renderSettings 精确判定（替代 source==='env' 误报）+ oc-chip-danger 红底徽章 + i18n adminPassDefaultBadge（en/zh），admin.test 同步 +2。
- **P1-A accounts allowedCache** ✅：update() 只在 patch 含 allowedModels 时写缓存（修非白名单 PATCH 静默清空），accounts.test +1。
- **P1-B upstream transient** ✅：catch 里 clientAbort（signal.aborted && 内部 controller 未 abort）不记 transient，e2e +1（响应头阶段断开 failCount 不变）。
- **P1-C tool_choice 两路径对齐** ✅：prepareOpenAIUpstreamRequest 对 -free 模型剥 tool_choice，e2e +1。
- **P1-D 并发在飞上限** ✅：config maxConcurrentRequests（env MAX_CONCURRENT_REQUESTS，默认 400，0=不限，可选字段 server 兜底 400）；server handler 对 /v1/chat/completions + /v1/messages 计数（finish/close 释放），超限 503 overloaded_error + Retry-After + req.resume + connection close，e2e +1。
- **P1-E MAX_BODY_BYTES**：代码默认已 64MB；生产 env 设了 0（不限）——**需用户改线上 env**（fuckopencode.env 里 MAX_BODY_BYTES=0 → 建议 33554432）。
- **P1-F history 聚合表** ✅：key_totals 表（flush 同事务 upsert，口径与 byKey 一致），queryHistory byKey/meta 改读聚合表（未归属走索引），prune 删行后整表重建（保持 30d 窗口），migrate 建表后初始重建。现有 71 usagedb 测试即回归防线（全绿）。
- **P1-G chat max_tokens 下限** ✅：prepareOpenAIUpstreamRequest 对 response_format 之外的小/缺 max_tokens 抬到 4096（对齐直通 quirk 6），e2e +1。
- **P1 性能四项** ✅：注入预筛（normalizeForDetect 后词根短路，严格等价不漏报）、鉴权哈希预计算（apiKeyHashes 缓存 + token 哈希一次）、tokens.verify prepared 复用（构造器缓存 verifyStmt）、UA 解析 Map 缓存（上限 1000 超限清空）。recordEvent 环形缓冲审计实测降 P2、RPM 惰性分配审计确认无缺陷——跳过。

**待办（review 波 2 结论落地后更新）**：
- 生产 env 改 MAX_BODY_BYTES（P1-E）
- 全面 review：对比本地 gateway 项目 + 本轮改动实用性 + 前端便捷功能

## 七、review 波 2 结论 + 版本收尾（2026-08-14）

**review 波 2（4 个并行：对比本地 gateway 项目 / 对抗式审查 / 实用性审视 / 前端便捷功能盘点）**：

对抗式审查（reviewer）结论：无 BLOCKER。已修 MAJOR M-1（shutdown 关库推迟到 exitOnce——开头关库会让窗口期 recordRequest 落到 null 库丢行刷屏）+ MINOR m-1（预筛补 startoftext）/ m-2（聚合表 endpoint null 跳过，JS 与 SQL 口径对齐）/ m-3（max_tokens 抬升兼容 max_completion_tokens，防双字段并存 400）/ m-4（legacy 缓存条目存 ws，切换 workspace 不命中旧数据）/ m-5（并发门 503 记 ctx.error，finally 统一落观测）/ m-6（auth 哈希缓存上限 16 清空重建）/ m-7（UA 结果 Object.freeze）/ m-8（upsertTotals prepared 缓存）/ m-11（前端 TTL 门失败不打点，保留 2s 自愈）。m-9（模块级 exited）回退——防御性过度且污染测试；m-10（预筛词根宽、短路率低于宣称）记录不改（无正确性影响）。

实用性审视：净价值约 60%——真正高价值 2 项（accounts allowedCache、upstream transient），中等 5 项，低价值 6 项（性能四项 µs 级/徽章/并发上限被盾 200 闸门稀释）。下一轮止损优先级：改线上 env MAX_BODY_BYTES → 面板用量 tab 三请求空转一行 gate → flush 整批丢弃重试 1 次。**引入的隐性回归已修**：legacy 前端 TTL 门曾挡死 2s 自愈（失败后 30s 不重试）。

前端便捷功能（对比 cursorapi/windsurf/sub2api/kirostudio）候选，按价值：
- **H1 tokens 批量创建「复制全部」**（数据已在 dataset.plain，纯前端 10 行）
- **H2 账户上游 key 复制**（后端 1 端点 + keyRow 1 按钮——目前唯一无法从面板取回的密钥类型，用户点名）
- H3 plain-overlay 明文完整展示 toggle；H4 legacy key 创建后展示明文 + 复制全部；H5 账户列表搜索 + kind/status 筛选；H6 URL 深链（hash）
- M 级：请求明细 CSV 导出、总览趋势范围切换、详情区块折叠、错误重试按钮、accounts 手动刷新 + 上次同步时间
- 中远期：批量账号操作条、批量文本导入账号、错误行动指引、账号状态标签增强（冷却倒计时/手动解除）、SSE 实时日志、半开恢复

**版本收尾**：v0.2.0 已 tag + push + GitHub release（github.com/dwgx/fuckopencode/releases/tag/v0.2.0）。CI（.github/workflows/ci.yml，node 22/24 × typecheck+test+build）两轮全绿。commit：d359338（fix 审计轮）/ c856f3a（ci+版本 0.2.0）/ 088a31d（actions v5）。

### 观察项
- OOM 修复完整周期验证（大 body >512KB 免克隆路径）。
- 盾高并发内存；tokens WAL 持久性（曾丢一次，checkpoint 已加固）。
- kirostudio 的 GoUsageLimitError 透传实际效果（下游能否看到额度信号）。
- secret.key 必须备份（丢失/更换 = 全部账户与分发 token 永久不可解，无迁移指引）。

## 六、关键操作与信息

- **测试/构建**：`npm test`（1278 基线）、`npm run typecheck`、`npm run build`、盾 `python3 scripts/dwgx/test-shield.py`（40/40）。
- **部署**：`scp -P 52535 -r dist root@38.244.34.15:/root/fuckopencode/dist.new` → ssh `mv dist.prev dist; mv dist.new dist; systemctl restart fuckopencode`；盾同理 `/opt/fuckopencode-shield/kiro_shield.py` + `systemctl restart fuckopencode-shield`。
- **线上**：ssh -p 52535 root@38.244.34.15。面板密码 `13141516`（admin/admin？——登录用 username=admin, password=13141516）。本地调试隧道：`ssh -f -N -L 8788:127.0.0.1:8788 root@38.244.34.15 -p 52535 -o ServerAliveInterval=60`（隧道不稳，每次用前 curl 检查）。
- **密钥**：`/root/fuckopencode/fuckopencode.env`（API_KEYS 1 个管理 key + OPENSEA_KEYS 3 个池 key ZOBb/0osU/7qpF）。**SECRETS.md 规则**：凭证不外泄、只发给归属服务。
- **kirostudio**（nbus 同机，systemd kirostudio.service，配置 /opt/kirostudio/config/）：fuckopencode 是它的上游之一（credential 1，已手动禁用——当时 v4pro 误路由质量问题）；v4pro 走官方 DeepSeek（credential 2）。
- **git 规范**：中文提交、无 AI 署名、`feat:/fix:/perf:/docs:/test:` 前缀 + 逗号描述。

## 七、约定（项目铁律）

- 零运行时依赖（node: 内置 + 已装）；改动最小、外科手术式；每项修复配回归测试（去掉修复会红）；`npm test + typecheck` 全绿是底线。
- 面板内联 JS 有 `new Function()` 解析测试防线（改 admin.ts 内联 JS 保持绿）；i18n 中英键集合一致。
- 提交信息不带 emoji、不带 AI 署名；只提交用户要求的内容。
- 诚实报告：测试真实输出、没跑过的不说跑过、改了什么/为什么/验证证据。
