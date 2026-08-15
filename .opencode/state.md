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

**八、文档同步轮（2026-08-14，用户指令「深度回顾 + 整理同步清理所有文档 + 同步 status」）**
- DEEPSEEK-QUIRKS.md 重写：行号全面重定位（9 处 8 处过期，主因 08-09 协议改造 + request.ts 退役）+ 语义更新（Quirk 3/8/9/11 已变）+ 3 条新 quirk（0 上游工具坏/13 -free 端点/14 tool_choice 400）。
- ARCHITECTURE.md：模块表补 14 个（admin/accounts/console/legacy/oauth/tokens/settings/modelmap/ratelimit/secrets/billing/cookie/shutdown/compact）+ 前置链路（并发上限/鉴权/RPM/模型门）+ 管理面端点/表清单 + 安全 L0 + 换 key 重试不对称。
- README.md（根）：特性/端点（管理面板表）/数据面/安全/运行章节 + env 全量清单（40 项）+ 架构树补 14 模块 + KEY_PROBE 默认值修正。
- ISSUES.md：I-6 标已修（eac0f43）、I-7 确认仍在 + 行号更新、I-4/I-5 行号更新、新增 I-11~I-20（面板空转/flush 连坐/keep-alive 污染/缓存内部引用/Origin 数组头/MAX_BODY_BYTES/围栏降权/文档漂移/OTA）。
- MULTI-ACCOUNT.md 补 3 章（allowedModels/tokens/legacy 通道）+ key_totals 一行；ADMIN-LAYOUT 补徽章 + 第五 tab；DEPLOY 补 MAX_BODY/并发/CI/发版/shutdown 语义 + ADMIN_PASS 默认值修正（13141516）；SHIELD 401 透传修正；CONVENTIONS 前缀列表；docs/README 文件清单补全；CONSOLE-PORT 基线数字去除。
- CURRENT.md 重写（待办全清 + 新待办）；.opencode/state.md 本文件。

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

---

## 十、假冷却修复（2026-08-15 凌晨，用户实测触发）

- 用户质疑面板 ZOBb/7qpF 显示 quota-exhausted 假冷却。实测（服务器直打上游）：7qpF 200 正常（被 24h 冻是误伤）、ZOBb 401 key 失效、0osU 429 真周额度。
- 修复：errors.ts FreeUsageLimitError 从 quotaSignals 摘出 → pool 归 rate-limit（3s）、账户级 15min；GoUsageLimitError 兜底 1h→24h；keypool QUOTA_FALLBACK_COOLDOWN_MS 1h→24h。1402 全绿，已部署重启。
- 教训：把「Rate limit exceeded」当日窗额度是错的——先实测再定冷却时长（用户现场打脸两次）。

## 十一、origin/kirostudio 排查（2026-08-14，交接 origin 会话）

- api.dwgx.top → kirostudio 8990（DEPLOYMENT.md + 响应形状铁证）；fuckopencode 是 fuckopencode.dwgx.top。origin claude subagent 截断 = kirostudio→pigcode 流解码失败 + 周额度 429 failover；pigcode 收到 opus/pro 因 kirostudio 透传选号 model 不参与白名单。用户已在 origin 侧模型钉死。建议禁 pigcode 未执行。

---

## 十二、2026-08-15 深度挖掘轮（用户指令：主线读代码建缺陷清单 + 大量派发 sub agent 找问题/修问题 + 少量实测 token）

### 任务定义与验收
- 主线通读核心链路建缺陷清单；sub agent 并行审计所有角落 + 修已确认缺陷 + 实测网关流通（少量 token）。验收：清单更新、确认项修复+回归测试、全量 test+typecheck 绿。
- 主线已读：main/config/errors/keypool/upstream/settings/security-auth/ratelimit/modelmap/deepseek/security-validate/shutdown。

### 实测结论（general agent 服务器实测，key 未出服务器）
- fetchUpstreamModels 端点 `/zen/go/v1/models` **正确**（200，26 模型，形状匹配）——主线疑点 U1 排除。
- 网关流通：B1 deepseek-v4-flash 200（in 154/out 66，共 220 tokens）；B2 -free 429 FreeUsageLimitError（符合假冷却修复预期）；max_tokens 抬升 4096 正常。

### 第一批审计（7 并行 explore/general，全回收）发现汇总
**P1**：
- S-P1-1 writeChunk 等 drain 挂起 → 并发门+keypool inFlight 双泄漏（半死连接可耗光全站并发 DoS），server.ts:111-121/3345-3406/3737-3783/2435-2441
- O-P1-1 OTA 回滚守卫只覆盖 bind 前崩溃（main.ts:194 clearBootAttempts 在 bind 清 + health 文件无人消费）→ 运行期崩坏版无限 crashloop
- O-P1-2 OTA 信任锚=GitHub 账号无代码签名（设计面，建议 attest-build-provenance，记录待用户决策）
**P2（20+ 项，详见 git diff 与各修复描述）**：S-P2-1~5（body 消费/整读）、A-P2-1~7（Origin 数组头/cookie 清空陷阱/审计缺失/tick 门控）、D-P2-1~4（unattributed 口径/rebuildTotals 非原子/model_access 残留/tokenUsageAll 引用）、C-P2-1/2（oauth 轮换死 token/plainCache 无 ws 维度）、O-P2-1~3（tar symlink/预算/回滚误伤）、M-P2-1~5（面板剥字段/注入误拒/compact 代理对/json_mode O(n²)/keyprobe 豁免）
**INFO 30+ 项**：死代码（hasToolUse/getRpmLimit/request-response 双套）、注释漂移（keypool rate-limit/plainCache/close 幂等/token_enc）、I-15 实际未修（history/usageTrend/statsByIp 内部引用）、文档行号漂移等

### 第二批修复（F1~F7，7 个 general 执行类，按文件独占划分）→ 全部完成
- F1 server.ts：writeChunk 60s 超时 destroy（S-P1-1）/ 四个 body 消费（S-P2-1~4）/ 直通错误体流式限长 64KB（S-P2-5）/ OAuth 审计（A-P2-2）/ chat .json() 限长 / OTA check enabled 门
- F2 admin.ts：originAllowed fail-closed（A-P2-1）/ cookie 留空不更新+显式清除 checkbox（A-P2-4，语义变更）/ 审计补全+note 填充（A-P2-3/5/6）/ tick hidden 门控（A-P2-7）/ 删账户删 key 清 model_access（D-P2-3）
- F3 usagedb.ts：unattributed 口径（D-P2-1）/ rebuildTotals+prune 事务化（D-P2-2）/ tokenUsageAll 深拷贝（D-P2-4）/ close 置 enabled=false（D-I3）/ DDL 加 api_key_fp（D-I4 新库）
- F4 oauth/legacy/billing：oauth 轮换写回（C-P2-1）/ plainCache ws 维度（C-P2-2）/ maskKey ≤11（C-I3）/ billing 正则（C-I1）
- F5 OTA：clearBootAttempts 移 30s 健康确认（O-P1-1）/ tar -tvzf 预读（O-P2-1/2）/ 版本裁决（O-P2-3）/ O-I2/3/6
- F6 协议/流式/注入：注入强信号约束（M-P2-2）/ compact 码点+换行（M-P2-3）/ json_mode segment（M-P2-4）/ keyprobe 豁免（M-P2-5）/ 匿名 device 白名单（M-P2-1）
- F7 清理：hasToolUse 死代码 / keypool 注释 / **I-15 补齐（实测确认三处真返回内部引用）** / request-response 死代码标注 / 文档同步
- 主控接线：C-P2-2 的 main.ts:127 set 传 ws + server.ts get 两处 + LegacyPlainCacheLike 接口签名
- 断言同步：deepseek.test 换行保留、e2e 审计 note 非空（3 处过期断言）

### 对抗式 review（2 reviewer 拆半）→ 5 MAJOR 全部修复（主控）
- **M1（R1）D-P2-3 数据面缓存不失效**（实证复现）：server.ts:2975 handleAdminRoutes 补传共享 modelAccess + D-P2-3b 测试
- **M1（R2a）D-I4 旧库路径**：ensureRequestsColumns 每列单独 try + api_key_fp 重试；insertRequest prepare 回退 18 列降级（insertRequestArity）；旧库 ALTER 失败测试
- **M1（R2b）OTA「30s 后崩」永不回滚 × 版本裁决缺口**：main.ts 健康确认不再清计数（计数完全归守卫）；rollback-guard.sh 加 confirmed_at 新鲜度裁决（≤600s 刚确认过又崩=版本问题仍回滚）+ 无关失败判定后重置计数；ota.ts 替换后清 boot 计数；shell 实测 4 场景全对
- **M2（R2b）计数污染**：随 M1 修（版本相等分支重置 + OTA 替换清计数）
- **M3（R2b）注入安全回归**：新增 content-theft/content-theft-zh 强信号（窃取动词+目标组合）；hasAction 只查普通文本（fenced 动作词不升级）；单信号 high 收紧为「单强信号+动作词」；ignore-instr-zh 修「的」字；预筛词根同步；M-3 回归测试 4+2 例
- R2a m-3/m-4：unattributed 补 `endpoint IS NULL OR` 护栏；e2e FakeLegacyClient 传 ws
- 未修记录：R1 m2（adminOriginAllowed fail-open，实测数组头不可达，文档漂移）、R1 m5（destroy 后 late error，未构造出触发路径）、R2b MINOR 全部（手动部署误回滚/匿名 dedup 合并/firstFail 掩盖/json_mode EOF 既有/中文「的」字既有）、R2a m-2/m-5（billing 嵌套键/oauth 并发 poll，低优先）

### 最终验证（2026-08-15 05:08）
- **全量 1463/1463 通过（34 文件）** + typecheck 干净 + build 通过（dist/version.txt=0.2.0）；基线 1402 → 净增 61 条
- OTA 守卫 shell 实测 4 场景全部符合预期
- **注意：本文件曾被 subagent（F2）整个覆盖，已从 git 恢复重建**——以后派 agent 写状态文件时明确「只 append 不覆盖」
- 全部改动未提交（工作树）；CURRENT.md 待办「commit + 发版 v0.3.0」仍有效，且本轮 60+ 修复应纳入

---

## 十三、日志研究 + smoke test + 一键部署轮（2026-08-15，用户指令三连）

### A. 日志深挖（general agent 服务器实测，journalctl 被 SystemMaxUse=50M 裁剪约 11h，requests 表补全 24h）
- **噪音**（无需处理）：401×13410/3h 中 98% 是「一直开着的未登录面板」2s tick 轮询（~86000/24h，日志量 80% 来源，INFO 可砍）；FurCDN 回源恢复探测（_?furcdn_recovery=）401；legacy/account/1 404 轮询（env 账号无 legacy cookie）；数据面 34 个 59s 超时 502（本地压测期残留，已消失）；33s/101s 慢请求=正常长生成；OOM 无迹象（RSS 107MB/320M 稳定）；RPM 限流 0 触发（429 全是池空透传）
- **新问题 P1：claude-fable-5 客户端 8/14 12:42-19:31 被 400 拒 8h**（103.38.82.215 + 15.204.112.147，Claude Code）——模型白名单轮（DEFAULT_MODEL_ALIASES 清空 + 表空 + 无 MODEL_MAP）副作用；当前客户端已切 deepseek-v4-flash（200 正常），不阻塞。**需用户确认意图**：是设计决策（fable 清理授权过）还是要在面板补回映射
- **新问题 P2：盾把模型门 400 当 auth/risk 吸收 90s×3**（8/14 19:22-19:31）——kiro_shield.py classify 400 兜底 auth，确定性模型拒绝（`is not allowed`）被重试 5 次共 ~79s。**已修**：CLIENT_FAULT_BODY_MARKERS 加 `"is not allowed"`（与跨站 403 的 "are not allowed" 区分，只命中模型门）+ test-shield.py 新增 case_model_not_allowed_fast（手动复现 4.0s 快速收敛）→ **41/41 全过**（原 40 + 1）
- **已验证**：假冷却修复生效（7qpF 只 3s 冷却自动恢复，不再 24h 误伤）；keypool 时间线完整（ZOBb auth 禁用/0osU quota/7qpF 正常，池 2/3）
- 面板 401 来源 IP 查不到（网关日志不带 IP）——INFO

### B. 网页 smoke test 初始化（general agent）
- **scripts/smoke-test.mjs**（零依赖 Node）：链路分层（公网 healthz/面板/登录/会话/模型目录/数据面 + ssh 本机 8787/8788 全套），`--only-public`/`--only-local` 模式，凭据经 ssh 在服务器展开（key/密码不出服务器），超时+退出码 0/1
- **实测全链路 12/12 PASS**（公网 6 + 本机 6）；发现：公网 healthz 被 FurCDN 边缘拦截（只验证边缘，真网关健康靠盾 8787）；面板密码在 DB settings（env 旧值，登录按「DB 覆盖 env」解析）；盾对回环 Host 反伪造（需带 Host 头）；Secure cookie 需显式提取
- 数据面每次运行只发 1 次最小请求（耗 ~220 tokens）

### C. 一键部署 + OTA 参数（对标 Windsurf API，2 个 general agent）
- **scripts/install.sh**（619 行 bash，set -euo pipefail，零外部依赖）：release/source 双模式；目录 Linux /opt/fuckopencode / macOS $HOME/fuckopencode（FC_INSTALL_DIR 覆盖）；端口默认 8787；env 模板 .env.example → fuckopencode.env（存在不覆盖）；必填缺失警告不退出（fail-closed 兜底）；无 systemd 走 nohup+PID；uninstall 保留 data/env；update 原子替换（对齐 deploy.sh + 清 boot 计数）；**release 资产只含 dist/ 不含 scripts/**（release.yml tar czf dist），release 模式从 raw.githubusercontent 单独拉 rollback-guard.sh + .env.example（拉不到降级）；OTA drop-in 强制 Environment=FC_WORKDIR=<安装目录>（rollback-guard.sh 默认 WORKDIR 写死 /root/fuckopencode，不覆盖会找错目录）。mock 验证全过（release 安装/sha256/update/restart/uninstall/source 构建/校验失败 fail-closed）
- **.env.example**（189 行 8 组 42 项，默认值逐项对照 config.ts）：必填 API_KEYS/OPENSEA_KEYS、服务、数据面安全、用量 key 池、管理面、OAuth、实验性、OTA（每项带第三方部署注意：fork 改 OTA_REPO + 仓库配 release.yml + supervisor 托管）
- **README.md**：一键部署小节（install.sh 两模式 + Node>=22）+ 配置章节指 .env.example + 新增「OTA 自更新」章节
- **DEPLOY.md**：第三方一键部署小节（install.sh 通用路径 vs deploy.sh nbus 专用）
- **未部署**：install.sh 的 systemd 真实写入未验证（本机 macOS 无 root，只 dry-run 渲染）；盾修复未部署线上（本地测试过，部署需用户确认）
- **遗留**：Node engines >=20 vs 实际 22.5+（README 已说明 20 降级，口径一致不用改）；claude-fable-5 需用户决策；面板未登录 tick 噪音（INFO，可后续砍）

---

## 十四、legacy 404 根治 + 一键 cookie 导入（2026-08-15 晚，用户实测触发）

### 问题复现（用户反馈）
1. 面板操作时反复看到「上游返回 404，已重试 3 次等 4 秒」错误文案（用户：很多版本没修）
2. 账号 dwgx1337@outlook.com（账号 6）看不到 Go 订阅/旧版 API key，用户称有订阅

### 根治研究结论（服务器 + 本机 Chrome 实测）
- **404 根因**：面板 tick 每 2s 对当前详情账号无条件发 3 个 legacy 请求（/go、/keys、/billing）；OAuth/env 账号无 legacy workspace → 网关 404 → 盾把 404 当 client-fault 重试 3 次等 4 秒（kiro_shield.py client_message "client" 文案）→ 用户看到错误文案。**前端已修**：loadGo/loadLegacyKeys/loadLegacyBilling 加 legacyEligible 守卫（state.list 的 legacyWorkspaceId 判断，无则不发请求），404 噪音根除
- **旧版控制台活着**：账号 5 的 auth cookie（544 字符，存 cookieEnc 槽）请求 opencode.ai/workspace/wrk_xxx/go → **200**（18KB 含 rolling/weekly = Go 订阅实时数据）。legacy 通道 = 有效旧版会话（auth=xxx）+ legacyWorkspaceId（wrk_ 前缀）
- **用户浏览器 auth cookie 已失效**（362 天未过期但服务端会话无效：旧版页 302 → /auth/authorize）；__Host-console_session（新版）不兼容旧版通道。新版 API（/api/orgs + /api/user）能反查 org id/email 但无 wrk_（旧版无列表 API 可反查）
- **账号 5 vs 6**：账号 5（gmail，org_01KZQ9E92...）已配 legacy（wrk_01KZE... + 有效 cookie，Go 额度 0%/87% 实时显示）；账号 6（outlook，org_01KZPQ6GSTS...）legacyWs 空。用户浏览器当前登录 gmail（= 账号 5），outlook 需切账号登录才有会话

### 交付
- **scripts/import-cookie.mjs**（一键导入，零依赖）：CDP 拿 cookies → 新版 API 反查 org/email → 匹配面板账号（--account 覆盖）→ **auth 有效性验证（fail-closed：302/404 判定失效绝不覆盖现有有效配置）** → PATCH /__admin/api/accounts/:id（legacyCookie/workspaceId/legacyWorkspaceId）。实测：gmail 会话 → 匹配账号 5 → auth 302 被拒（EXIT=2，现有配置未动）——保护验证通过
- **smoke-test.mjs** 加「面板账号列表含 legacyWorkspaceId（前端守卫依据）」断言（7/7 通过）
- 登录端点字段是 **username/password**（server.ts:629-630），脚本踩坑已修

### 用户要 outlook 订阅的下一步
1. 浏览器打开 https://opencode.ai 用 outlook 邮箱登录（旧版控制台，URL 呈 /workspace/wrk_xxx 形式）
2. 跑 `node scripts/import-cookie.mjs --panel https://fuckopencode.dwgx.top --user admin --pass <面板密码>`（自动匹配账号 6；wrk_ 由旧版控制台 URL 提供）
3. auth 有效 → 自动导入 → 面板显示 Go 订阅

### 验证
- typecheck + 1463/1463 全绿 + smoke 7/7 + import-cookie 语法 OK
- 未部署线上（legacyEligible 修复 + 盾模型门修复 + 本轮全部改动都在工作树）

### 十五、一键登录打通（2026-08-15，outlook 账号 legacy 绑定成功）
- **旧版控制台登录入口**：opencode.ai/workspace/{wrk}/go → 302 auth.opencode.ai/authorize → **Continue with GitHub / Google**（opencode 登录只走这两个 OAuth，无邮箱密码直登；outlook 是用户名）
- **GitHub 登录成功**（之前「登录不了」= authorize 入口点 GitHub 失败；隔离测试已证 GitHub 本体没问题，重试成功）
- **outlook 账号（6）legacy 配置完成**：legacyWorkspaceId=wrk_01KZJDZGYQ7EHKXFCVKFF2ADNB + cookie 槽（auth，766B 加密）。**Go 订阅 subscribed=true**（滚动 22%/周 39%/月 19%）+ 旧版 Default API Key（sk-...7qpF——7qpF 归属即 outlook 账号，之前显示在账号 5 池是池配置）
- **脚本实测全流程**：CDP 抓 cookies → --account 6 --workspace wrk_01KZJDZG... → auth 验证 200 → PATCH 成功（返回 {account} 非 {ok:true}，判定已修）
- **关键认知**：新版 console 会话（__Host-console_session）与旧版 auth 会话独立——GitHub 登录只更新旧版 auth（新版 console 会话仍是 gmail）；legacy 通道只认旧版 auth（Bearer 302 拒绝实测）；auth cookie 长寿命（362 天）但可被服务端作废，失效时跑一键脚本重新登录即可
- 遗留：__Host-console_session（gmail 新版会话）未动；账号 5 的 cookie 槽未受影响

### 十六、主账号（outlook/账号 6）全面上线检查 + OAuth 死锁修复
- **账号 6（org_01KZPQ6GSTS0H24ARVQCD8ZNBM + wrk_01KZJDZGYQ7EHKXFCVKFF2ADNB）现状**：
  - legacy 通道 ✓（Go 订阅 subscribed=true 滚动 22%/周 39%/月 19%，旧版 Default API Key sk-...7qpF）
  - 新版通道 oauthRefresh ✓（服务器实测 refresh 换 access 200，orgs 返回账号 6 org）
  - 主 key 7qpF 健康（池 env OPENSEA_KEYS，nick dwgxoutlook）；0osU quota-exhausted（真周额度，假冷却修复后正确）
  - 数据面 smoke 200（走 7qpF）
- **新发现 + 已修（OAuth invalid 死锁，P1）**：console.ts doRefresh 成功路径不清除 health.invalid → 账号 6 曾一次历史 refresh 失败被标 oauth-invalid → billing/usage 端点「invalid 不打上游直接给空」（server.ts:4480）→ 不触发 refresh → invalid 永不更新（refresh 实际有效但面板永远报 OAuth expired）。**修复**：doRefresh 成功清除 invalid（health.invalid=false + channel/consecutiveFails 重置）+ 回归测试（invalid 后成功 refresh → cookieStatus 恢复 ok）。部署重启后账号 6 面板恢复真实余额/用量。
- 遗留：账号 6 模型授权=全局默认（deepseek-v4-flash/free，账号覆盖空）——用户若要更多模型需面板配置；pricing 端点 404（端点路径问题，低优先）

### 十七、部署上线 + 主账号全通道打通（2026-08-15 完成）
- **部署**（deploy.sh ×2 + 盾 scp）：盾模型门 400 修复 + 网关（legacyEligible 404 修复、OAuth invalid 死锁修复、未登录 401 噪音修复、legacy 槽位架构修正）全部上线。网关 8788 OK，盾 active + healthz ok
- **legacy 槽位架构修正（重要）**：一个 cookie 槽放不下「旧版 auth（legacy 通道用）+ 新版 __Host-console_session（console 通道用）」两个，且 auth 对新版 console API 无效（实测 401）。修正：server.ts 6 处 legacy 端点 cookie 来源 `cookieOf` → `legacyCookieOf?.(id) ?? cookieOf(id)`（legacy 槽优先 + 回退兼容老配置）；import-cookie.mjs 改为 auth→legacyCookie 槽、__Host-console_session→cookie 槽（仅当会话 org 与账号 workspace 匹配，防串数据）
- **账号 6（outlook 主账号）全通道打通**：
  - legacy ✓：Go 订阅 subscribed=true（滚动 1%/周 39%/月 19%）+ 旧版 Default API Key（sk-...7qpF）
  - console ✓：cookieState=ok（billing balance=0 + usage 真实数据）——OAuth invalid 死锁修复 + **refresh_token 轮换写回**（实测消耗旧 rt 导致 400，重走 OAuth device flow 授权（用户点 Authorize，Signed in as dwgx1337@outlook.com）拿全新 rt 落库）
  - 主 key 7qpF 健康；smoke test 13/13 全过
- **遗留**：deploy.sh 盾健康检查不带 Host 头（WARN 误报，盾实际正常，低优先修）；账号 6 模型授权=全局默认（deepseek-v4-flash/free）；余额 $0.00 是 prepaid 账号真实值

### 十八、懒人式一键配置研究 + zen usage API 化（2026-08-15 核心突破）
- **研究结论（2 agent 并行）**：
  - R1 协议研究：rt/st 换 Iron cookie **物理不可行**（console 与旧版控制台是两套独立身份系统，无桥接；Iron cookie 只能浏览器 OAuth 在 /auth/callback 签发；旧版无 JSON API）。**但发现 `GET /zen/go/v1/usage` 用旧版 Default API Key（Bearer）返回 Go 订阅三窗口 JSON**——与 legacy HTML 抓取数据一致（实测 7qpF→outlook、0osU→gmail 均匹配）
  - R2 CDP 研究：纯网页直连 CDP **不可行**（Chrome 151：/json/list 无 CORS + WS 拒带 Origin 403 两道硬墙）；可行路径=本地中继（~60 行）/Chrome 扩展（chrome.debugger）；**绝不加 --remote-allow-origins=***（全 cookie 裸奔）
- **实现（agent 完成，1478 全绿）**：legacy.ts 新增 `fetchZenGoUsage`（GET /zen/go/v1/usage → LegacyGo，401/畸形→null）；accounts 加 legacyKey 字段（加密落库 legacy_key_enc + masked 视图 + PATCH 校验）；server.go 端点 **zen usage 优先**（有 legacyKey → zen JSON 零 cookie；失败 fallback cookie HTML）；面板前端「旧版 API key」配置框（i18n en/zh）
- **已部署 + 配置**：账号 6 legacyKey=7qpF、账号 7 legacyKey=0osU（值不出服务器）→ **Go 订阅零 cookie 显示**（账号 6：6%/41%/20%；账号 7：0%/100% rate-limited/87%）
- **懒人式最终形态**：面板 OAuth 授权（console 通道）+ 配 legacyKey（用户手上有 sk-）→ Go 订阅自动；cookie 仅剩旧版 key 列表/计费明细（可选，不配不影响核心）
- **教训固化**：refresh_token 一次性轮换——**任何外部实测都会作废 DB 值**，rt 只能网关自己轮换；OAuth invalid 死锁已修（不短路+doRefresh 清除+重启清 accessCache）

### 十九、smoke test + 全网页巡检 + 报错修复（2026-08-15）
- **smoke test 13/13 全过**（公网 7 + 本机 6）
- **全网页翻阅**（共享 Chrome 逐个 tab）：账号列表/账号详情（6、7 全部区块）/总览/用量/密钥/模型授权/设置——全部渲染正常，Go 订阅走 zen API（8%/42%/21% + 0%/100%/87%），「旧版 API KEY」配置区显示已配置
- **修复 3 类报错**：
  1. env 账号（无凭据）发 console usage → **502**：前端 loadPreviewData 按 `hasConsole` 跳过（2026-08-15 实测 reqid=11）
  2. env 账号（无 legacyWorkspaceId）发 legacy go/keys → 网关 404 经盾转 **503**：前端按 `legacyWorkspaceId` 跳过（reqid=12/14）
  3. favicon.ico **404**（浏览器自动请求）：STATIC_ASSET_PATHS 从 404 改 **204**（静默无内容，浏览器 console 不再报错；e2e 断言同步更新 404→204）
- **验证**：浏览器 console **零 error**、网络请求全 200（env 账号不再请求无凭据端点）
- **遗留（低优先，非 error）**：a11y issues——22 个表单字段无 label、2 个 form 字段无 id/name、password 不在 form 内（Chrome accessibility 建议，不影响功能）

### 二十、对标 sub2api/new-api + 去盾 + 深度优化（2026-08-15）
- **对标研究（2 agent 读 sub2api/new-api 白名单+分发密钥）**：sub2api=账号层 model_mapping（空=全放行）、404/503 独立 DB 复查诊断；new-api=ability 物化表（O(1) 选渠道）+ token 显式白名单 + 原子预扣额度。**我们更强**：四级模型授权（硬底线>全局>账号>密钥）、tokens AES 指纹存储（他们明文）、降级哲学。**可借鉴**：token 级额度（quota）、TPM、IP 白名单、token 过期（已记待办）
- **深度探索（4 agent 报告）**：数据面/管理面/数据层/运维各一份深度报告——发现 P1×1（server Origin fail-open）+ P2×13 + INFO×15
- **修复落地（4 agent + 主控，全量 1497/1497 已部署）**：
  - P1 Origin 统一 fail-closed（数组头拒绝）+ 测试
  - F1 直通流式 thinking 记账（message_delta 带 thinking_tokens）+ F2 错误体 Anthropic 包装（type:error）+ F3 两路径校验顺序统一（validate 先于模型门）
  - 管理面：改密码文案（立即失效）、移动端 .ops 可达、刷新余额部分更新（防清历史）、非 usage 视图停白打 3 请求、401 停 OTA 轮询、dashboard hidden 门控
  - 数据层：prune 增量删 key_totals（NOT EXISTS，不再 10s 全表冻结）、customKey ≥16 强度、tokens.verify TTL 缓存（写操作即时失效）、keypool sha256 预计算 Map
  - 运维：deploy.sh rollback 校验 dist.prev、rollback 时间戳纳秒、install.sh nohup 警告、文档漂移修正（tokens 注释/O-P1-1 表述）
- **去盾（用户决定，已完成）**：盾服务停（disable）+ 网关接管 0.0.0.0:8787（FurCDN 直连）+ MAX_BODY_BYTES 0→32MB + deploy.sh/smoke/SHIELD.md/DEPLOY.md 更新 + 公网验证 200。smoke 12/12 全过（去盾后）
- **部署**：全部修复 + 去盾上线（健康检查 OK 网关 8787）
- **遗留**：token 级额度/TPM/IP 白名单/过期时间（对标 new-api 的扩展，记待办）；release.yml 无改动

### 二十一、账号详情改版（订阅置顶 + 复制 + 锚点导航 + 网络文案）
- **需求**：Go 订阅及旧版 key 相关放账号详情最上面 + 旧版 API key 可复制 + 导航更新
- **实现（admin.ts + server.ts，已部署 + 浏览器验证）**：
  1. 详情页模板重排：detail-go → detail-legacy-key → detail-legacy → detail-legacy-billing 置顶（crumb 后、工作区前）；DETAIL_BLOCK_KEYS 同步重排
  2. 锚点导航条 detail-nav（16 区块 chip，点击平滑滚动；oc-chip 复用 + .detail-nav-row CSS）
  3. 旧版 API key 配置区「复制」按钮 → 新端点 GET /__admin/api/legacy-key/:id/plain（admin 会话 + Origin 双校验，同 tokens plain；注意必须独立 if 不能插在 /tokens/ 块内——第一次插错位置 404，已修正）→ 验证 200 返回完整 key
  4. errMsg 对 status 0（fetch 网络失败）显示「网络波动，自动重试中…」而非「请求失败 (0)」（用户看到的 0 是 fetch status=0，根因是 FurCDN 边缘抖动，非服务端）
- **验证**：typecheck + admin 227 + 部署 + 浏览器快照（订阅置顶 ✓ 复制按钮 ✓ 导航 ✓）+ 端点 200
- **遗留**：用户浏览器访问时的「请求失败 (0)」根因=FurCDN 边缘抖动（服务器全 200 + 共享 Chrome 正常），文案已友好化

### 二十二、review 修复轮（M3 + 3 MINOR + I-16 文档，2026-08-15）
- **M3 renderLegacyKey 跨账号残留输入**（admin.ts）：detailState.legacyKeyInputFor 记录输入框归属账号，切账号（id 变化）强制清 input.value 再走渲染——防「B 显示 A 的输入」「saveLegacyKey 把 A 的值写进 B」。测试：admin.test.ts M3 组（切账号清空 + 同账号正在输入保留 + 源码守卫断言）
- **MINOR oauth 失败路径 refresh 轮换丢失**（oauth.ts + server.ts）：重试路径 refresh 轮换后 orgs 再失败，失败结果带回新 rt（refreshToken+prevRefreshToken）；server 按「旧值==账号现存 rt」匹配落库（persistOauthRefreshRotation）。测试：oauth.test.ts M3-oauth（orgs 二次失败 identity 仍带新 rt）+ C-P2-1 断言更新
- **MINOR 无效 legacyKey 每 2s 打 zen**（admin.ts loadGo）：401/403 确定性配置错误打点 legacyDetailMark(id,'go')（30s TTL 门）；网络失败不打点保留自愈。测试：admin.test.ts MINOR 项
- **MINOR favicon 静态路径双保险**（server.ts:2439）：静态 204 加 `connection: 'close'`（与限流路径同款）
- **I-16 标已修**（ISSUES.md）：origin 数组头 fail-closed 两处已实现 + A-P2-1 测试
- **验证**：tsc --noEmit 干净；`npx vitest run test/admin.test.ts test/oauth.test.ts` 263/263 全绿
- **未做**：M3 的「保存写入 B 而非 A」端到端断言（evalFn 沙箱无 api/global fetch，用「输入框被清空」+源码守卫兜底，按任务允许）

### 二十二、核验轮 + 三个真实问题修复（2026-08-15）
- **全面核验（A1 agent）**：state.md 十二~二十一节声明 66 项修复——代码/测试/逻辑全部落实 ✅（0 ❌）；线上核验（主控）全部确认（MAX_BODY_BYTES 32MB ✓ ZOBb 移除 ✓ 盾停 ✓ legacy 配置 ✓ 健康 ✓）
- **对抗 review（A2 agent）**：BLOCKER 无；MAJOR 3 个已修：
  - M1 content-theft 误报（`copy the previous command and run it` 被 400）→ 强/弱两档动词 + 距离 ≤20 + 强目标才命中
  - M2 两弱信号+中性动作词仍 high（与注释承诺矛盾）→ STRONG_ACTION_WORDS（reveal/leak）才升级，run/执行 归中性
  - M3 renderLegacyKey 跨账号残留输入 → detailState.legacyKeyInputFor 归属检测，切账号清输入
  - MINOR 已修：oauth 失败路径 rt 轮换写回、zen 失败 TTL 门、favicon connection:close、ISSUES I-16 标已修
- **新发现三问题（用户实测）**：
  1. **OAuth invalid 死锁变体**：accessCache 失效 access 复用 → 恒 401 → invalid 永久（keyprobe 直接 refresh 成功但清不掉）。修复：getJson 401/403 清 accessCache（下次自动 refresh 自愈）+ 回归测试（refreshCalls 1→2）
  2. **「启用中国区模型」显示错**：zen API 无开关字段 → chinaModels 恒 false（用户实际启用）。修复：legacy go 端点**合并数据源**（Promise.all：zen 窗口 + cookie HTML 开关，mergeLegacyGoStatus）+ 测试 309 绿
  3. **smoke test 对照官网增强**：面板 Go 结构与官网 zen 直调对比（±5%，实测 Δ0）+ 开关与 cookie 页一致（抓到过真实 bug）+ 错误如实传递（400 + 模型名 + not allowed）
- **验证**：全量 1511/1511 + typecheck + 部署 + smoke **19/19**（账号 6/7 chinaModels=true 正确、billing 恢复、Go 用量与官网一致）

### 二十三、模型授权可添加任意模型 + 分发密钥刷新（用户实测）
- **模型授权（agent 实现，1519 全绿）**：allowedModelsMeta 校验从「限硬底线」放宽为「任意合法模型名」（/^[a-z0-9._-]+$/ ≤100 ≤50）；**关键发现：resolveModel 原查硬常量 ALLOWED_MODELS 而非 globalAllowedModels**——加了 allowedModels 参数 + server 三处接线（checkModelGate/prepareOpenAIUpstreamRequest/handleMessagesPassThrough）传 effectiveGlobalModels(cfg)；目录门只对代码默认模型生效；前端全局白名单加「添加模型」输入 + datalist 补全（62 模型）+ chip 移除 + 重置回默认；默认行为不变（不配置 = deepseek 两模型）；e2e 3 处断言调整（glm-5 从拒绝变可扩展）
- **分发密钥「没同步」**：tokenFingerprint 已含用量（非 fp 问题）；两个 token 用量不同是真实的（dwgxnbnb 5 请求 814 tokens，kirostudioapi 0——真没用过）；改进：进密钥页 loadTokens(true) 强制刷新（用量实时，60s TTL 仅限 tick）
- **已部署**（v0.3.0 之后的工作树改动，未提交——下个版本 v0.3.1 或 v0.4.0）

---

## 二十四、配额计费系统对抗审查修复（2026-08-15，B1+M1+M2+M3+MINOR）

对抗审查实锤 1 BLOCKER + 3 MAJOR + 3 MINOR，全部修复（详见 .claude/docs/QUOTA.md §8）：
- **B1（$ 配额单位错配 1e8 倍，一用即满）**：quota_usd 存美元、used 累加 microCents、比较直接对上。
  修复：存储层统一 microCents —— TokensStore create/update 入参美元 ×1e8（tokens.ts
  usdToMicroCents/microCentsToUsd），view ÷1e8 回美元；admin.ts quotaParts 比较 ×1e8 对齐；
  e2e「quotaUsd=5 + $1 → 不超限；跨 $5 → 429」。
- **M1（流式断开 usage 不更新 → settle 扣 0）**：chat/messages 两流式路径累计已回显文本
  字符数，断开时 Math.max(已记 outputTokens, textChars/4) 兜底（server.ts applyStreamedOutputEstimate）。
- **M2（messages 缓存读免计 + 双路径 input 不一致）**：cache_read_input_tokens 入 settle ——
  $ 定价补 read 价、tokens 口径补回 cacheRead；chat 路径 cacheRead=0（input 已含缓存不双算）。
- **M3（verify 10s 缓存 + 无条件累加 = 并发 N 倍超额）**：settle 改逐口径条件 UPDATE
  （已超限口径不扣，其余正常扣）+ 跳过日志。
- **MINOR**：m1 model_prices 放行 '*' 通配；m2 cycle 值变化无条件刷新 quota_reset_at；
  m3/m4 QUOTA.md 文档（pricing key 用上游模型名 / 上游故障照实结算消耗配额）。

验证：`npx tsc --noEmit` 干净 + `vitest run test/{tokens,usagedb,e2e,admin,settings}.test.ts`
656/656 全绿（另跑 toAnthropic/stream 87 绿）。未部署线上（工作树）。**B1 旧数据风险**：
上线前 quota_usd 是美元语义会被按 microCents 解读（生产无存量配额 key，未迁移）。

### 二十四、分发密钥配额计费系统 + UI 重构（2026-08-15）
- **研究（2 agent）**：opencode 计费文档（cost_micro_cents=上游真实成本但订阅端点恒 0，需定价表兜底；上游 per-key 配额形态=member budgets）+ sub2api/new-api 配额架构（sub2api 完成时结算原子 UPDATE vs new-api 预扣→结算→退款）
- **设计定稿 QUOTA.md**：完成时同步条件 UPDATE（不走 flush）+ verify 校验（expires 403 / 配额满 429 / model_limits 复用四级链）+ 三种配额（$ / tokens / requests）+ 周期重置（daily/monthly）+ 定价表（settings model_prices，上游模型名 key）+ count_tokens/probe 不消耗
- **实现（2 agent + 修复 agent）**：tokens 表 9 配额列迁移 + settleQuota（条件 UPDATE + 滚窗）+ quotaCheck + server 数据面接线（429/403 形状）+ $ 口径（cost>0 用成本、=0 定价表）+ 面板配额 UI（编辑弹层/列表徽章/指纹）+ 详情页 5 组 tab（订阅&Keys/工作区&模型/财务/组织/定价，load* 全保留）
- **对抗 review（1 agent）→ 1 BLOCKER + 3 MAJOR 已修**：
  - B1 $ 单位错配 1e8 倍（quota_usd 美元 vs used microCents 直接比 → 一用即满）→ 存储边界统一 microCents + UI 语义 e2e
  - M1 流式断开扣 0（usage 在尾 chunk）→ 断开按已回显文本估算 output（textChars/4）
  - M2 messages 缓存读免费（input 减缓存）→ settle 补 cacheRead（read 价）+ 双路径总输入一致
  - M3 并发 N 倍超额（10s 缓存 + 无条件累加）→ settle 逐口径条件 UPDATE（超限不扣）
  - MINOR：`*` 通配定价放行、cycle 切换刷窗口起点、文档（上游模型名/上游故障消耗配额）
- **验证**：全量 1563+ 全绿（修复后），typecheck + 部署上线

### 二十五、quota-exhausted key 反复被选 + max_tokens 400（用户实测）
- **问题**：① 0osU（gmail 周额度 100%）重启后冷却丢失重新被选（14:35 禁→重启→15:13 再撞 429）——keypool 冷却是进程内态 ② 客户端 max_tokens 超上限（如 500000）→ 上游 400 "Invalid max_tokens [1,393216]" 风暴（面板 15:14 一堆 400）
- **根因**：keypool 冷却不持久化（重启即丢）；池 key（OPENSEA_KEYS 挂 env 账号）探活被「有真实流量活着」跳过（kirostudio 持续打）→ 只靠真实流量撞
- **修复**：
  1. **max_tokens 上限钳制**：deepseek.ts DEEPSEEK_MAX_MAX_TOKENS=390000（留余量），直通 + chat 两路径钳制（实测 500000 → 200）
  2. **keypool quota-exhausted 长冷却持久化**：KeyPoolOptions.persistDisabled（load/save）+ 构造恢复（重启加载禁用）+ disableUntil 写入（quota-exhausted 才持久化）+ reapRecovered/reset 清除；main.ts 接线 data/pool-disabled.json 原子写
  3. **keyprobe 启动即探**（startKeyProbe void tick()——重启立即发现坏 key，不等 interval）
- **验证**：全量测试 + 部署 + 线上实测（500000→200；4 请求 1 个 429 撞 0osU → 禁 24h → pool-disabled.json 写入 {"****0osU":...} → 后续 200 走 7qpF；重启后从持久化恢复禁用）
- **7qpF transient 286s**（15:14 池空）= 上游瞬时波动短冷却自动恢复（非持久问题，当前健康）

### 二十六、面板 UI 重构轮（2026-08-15，只改 admin.ts + admin.test.ts）
- **账号列表卡片网格**：`#accounts` → `grid repeat(auto-fill, minmax(min(100%,400px),1fr))`，一排 2-3 张紧凑卡；空态 `grid-column:1/-1`；≤40rem 单列。`.stats .stat, .d-stats .stat` KPI 卡化。
- **设置页分组卡片**：4 组 `.settings-group`（服务=语言+模型映射 / 安全=管理员+API 密钥 / 运行=实验+OTA / 关于），全部 section id 保留（测试钉住）。
- **Key 详情丰富**：keyRow 加「用量」弹层（GET /__admin/api/keys/usage?rangeDays=7，按 accountId+fingerprint 双条件匹配 data.keys[]，显示 requests/tokens/costMicroCents/lastAt）+「禁用/恢复」（POST /__admin/api/keys/:fp/disable|reset，掩码指纹）+ 卡片 keys 头「密钥」引导按钮（data-action=goto-tokens → switchView('tokens')）。
- **go 开关接线**：change 委托改 `PUT /__admin/api/legacy/account/:id/go-toggle`，body 只带被切换键 `{useBalance?}|{chinaModels?}`（**服务端待并行 agent 实现，旧 POST /go/use-balance 已弃用**；失败回滚+sticky 保留）。
- **控件体系**：全量 oc-*（oc-select/oc-check/oc-switch/oc-chip/oc-dot/oc-modal 已齐）；新写 `oc-tooltip`（纯 CSS data-tip 气泡）。触屏 `@media(hover:none)` 下 key-row 行内按钮常显。
- **契约对齐**：keyUsage/toggleKeyState 原按任务草稿写 `/accounts/:id/keys/...`，review 发现服务端（并行 agent）实现是 `/keys/usage` + `/keys/:fp/disable|reset` → 已对齐到真实服务端契约。
- **验证**：typecheck 干净；`npx vitest run test/admin.test.ts` 259/259；全量 1593/1593（34 文件）。新增 4 条 contract-guard 测试（keys 端点路径/掩码、PUT go-toggle、settings 分组、#accounts grid）。
- **接口约定（给并行服务端 agent）**：① `PUT /__admin/api/legacy/account/:id/go-toggle`（body 单键）待实现；② keys/usage + disable/reset 已实现勿改路径；③ 手动 disable 为内存态（重启失效）——是否要持久化由服务端决策。

### 二十六、UI 全面重构 + 全面 review（2026-08-15）
- **UI 重构（agent）**：账号列表卡片网格（一排 2-3 张紧凑卡，≤40rem 单列）、总览 KPI 卡化、设置页分组（服务/安全/运行/关于 + 侧边导航）、key 行加「用量」弹层 + 禁用/恢复 + 「密钥」引导按钮、详情页 5 tab 保留、oc-tooltip 新控件、触屏可达
- **transient 逻辑简化（用户明确）**：markFailure transient 分支去掉禁用（5xx/超时不禁用不显示，仅 failCount 累计）；policy 移除 transient 规则；auth/rate-limit/quota-exhausted 不变。面板不再出现「transient · 1m02s」
- **0osU 突然健康核实**：代码无误清路径（reapRecovered/持久化加载/disableUntil 正确）；顺手修 removeKey 不移除持久化条目（面板移除重加后重启仍禁——来回跳的根因）
- **go 开关 checkbox**：服务端链路已存在（setLegacyGoToggle + POST /legacy/account/:id/go/use-balance|china-models，测试覆盖）——之前「没做」是旧部署；前端已接线
- **key 详情服务端**：keyUsageAll 聚合（usagedb）+ keypool disable/reset（manual reason）+ GET /keys/usage + POST /keys/:fp/disable|reset 端点 + 审计
- **全面 review（主控浏览器逐页逐元素）**：总览/账号（卡片网格 + 新功能）/详情（5 tab）/用量（Key 池 transient 消失 + 0osU 持久化冷却 + 请求明细无新 400）/密钥/模型授权/设置（分组）——**console 零 error、Failed to fetch 消失、i18n 全对**（用户看到的 key 原文 = 旧 dist 缓存错配，新部署解决）
- **验证**：全量测试（UI 重构 agent 1593 + 服务端 496 + 主控全量）+ 部署 + 浏览器逐页 review

### 二十七、模型授权全局白名单可选模型网格（用户实测）
- **问题**：全局白名单区块只显示已选的 2 个模型 + 手动「添加」输入（datalist 依赖详情页 pricing 缓存，跨视图不共享）——用户要「列出所有可以选择白名单的模型」
- **实现**：服务端 GET /model-access 响应加 `pricing`（62 个上游模型名，从第一个有 console 凭据账号的 v2/config pricing 解析，失败空数组）；前端全局白名单区块加「可选模型（上游全部）」网格（已选高亮带 × / 未选点击添加 / 搜索过滤 / 缺失时回退 datalist）
- **验证**：typecheck + 259 测试 + 部署 + 浏览器确认（62 模型全列出，deepseek 已选高亮，搜索可用）

### 二十八、前端适配服务端新契约（2026-08-15，只改 admin.ts + 测试）
- **quotaParts/quotaBadge 适配**（admin.ts ~4088-4128）：usedUsd 现在是美元（B1 后视图统一），直接 `'$'+toFixed(2)`，不再过 money()（会压成 $0.00）；删掉 `uUsd >= qUsd * 1e8` 手写比较，改读服务端算好的 `t.quota.exhausted/expired/remainingUsd`（跨周期窗口服务端按校验口径算好，前端推导会误报）；徽章过期红/耗尽 amber 直接读服务端字段；`t.quota || {}` 兜底保留。
- **settings source 三元组**（admin.ts ~4851/4882）：SETTINGS_SRC 加 `'code-default': 'codeDefault'`，srcOf 改为 `T(SETTINGS_SRC[src] || 'sourceEnv')`——code-default 不再吞成 env。i18n 新增 codeDefault（'code default'/'代码默认'）en/zh 对称。
- **money() 收敛**：内联 JS 无法 import TS 模块（零构建约束），保留独立 money()，注释标注「与 src/money.ts microCentsToUsd 同口径，勿改系数」；测试已断言 `/ 1e8` + money(4218000000)==='$42.18'。
- **死词条清理**：8 个（previewBalance/legacyCount/cookieClear/otaConfirmBody/hFp/hUa/amount/tokenSaved）确认只在测试断言里引用（页面无 T()/data-i18n/间接引用），从 en/zh 字典删除 + 测试断言同步移除 → check-i18n 0 死词条 exit 0。
- **验证**：typecheck 干净、`npx vitest run test/admin.test.ts` 259/259、`node scripts/check-i18n.mjs` exit 0（en/zh 534 对称）。

### 二十八、绊脚石修复批（一批修复 + 一批 review + 真实测试，2026-08-15）
- **架构审计（6 agent）**：六大绊脚石——状态管理分散重启丢、双路径镜像、单位口径散落、巨型单文件无构建、测试盲区、语义纠缠（详见对话报告）
- **修复批（7 agent 并行）**：
  - F1：gatewayPoolUsage 补 count_tokens / settings source 三元组（db/env/code-default）/ 429 X-Error-Scope 头（client-rpm/client-quota）/ revokedSessions 文件持久化（data/revoked-sessions.json 原子写）
  - F2：新建 src/money.ts 单一换算（MICROCENTS_PER_DOLLAR + microCentsToUsd/usdToMicroCents）+ 5 文件收敛 + TokenQuotaView 全美元输出 + exhausted/expired/remainingUsd 服务端算好（B1 复发面根治）
  - F3：persistDisabled 结构扩展 {fp:{until,reason}}（旧格式兼容迁移）+ auth/manual 持久化 + modelBlocks 持久化（data/model-blocks.json）
  - F4：前端 quota 读 exhausted/expired（删 ×1e8 手写比较）+ settings source 三元组显示 + 死词条清理 8 个
  - F5：EXCLUDE_OBSERVED 单一常量（10 处 SQL 收敛 + JS 谓词）+ tokenUsageAll 补 probe
  - F6：scripts/check-i18n.mjs（vm 真执行核对 data-i18n/T()/en==zh/LOGIN_HTML）+ package.json verify script
  - M 批：quotaView 跨周期 used 三口径归零（M-1）/ revokedSessions 加载单次写盘（M-2）/ client-quota retry-after = 距重置秒数（M-3）/ keyprobe 跳过 manual 禁用 key（m-1）/ persisted reason 枚举校验（m-3）
- **review 批（1 agent）**：无 BLOCKER；3 MAJOR + V-1 全处理（V-1 确认生产无存量配额 key）
- **真实测试批**：全量 1610+ 测试 + typecheck + check-i18n 0 warning + 部署 + **smoke 19/19**（对照官网 Go 用量 Δ0 + 开关一致 + 错误如实传递）+ 浏览器逐页（模型授权 62 网格 + 密钥页美元配额格式 + 设置分组 + 账号卡片）

### 二十九、收尾核查修复（用户「最高质量」批准全修）
- **3 个核查 agent + 主线**：点出 11 项（无 BLOCKER/MAJOR；无幻觉）
- **修复（2 agent + 主线）**：
  - P1 持久化键指纹碰撞 → **sha256 全量哈希**（旧 ****XXXX 键加载兼容 + 写入迁移 + drop 双删）
  - MINOR manual 365 天复活 → **哨兵 until（MAX_SAFE_INTEGER）**，只有 reset 恢复；manual 显示「永久停用」（admin ×2 + dashboard ×1 + i18n）——修掉 9e15 超大地狱副作用
  - modelBlocks 持久化**回退**（过度工程，恢复纯内存态，删 persistModelBlocks + 测试）
  - X-Error-Scope **删除**（无消费者，含 CSRF 第三处死头）；M-3 retry-after 保留
  - money.ts 收敛补全（server.ts:5128 改 import microCentsToUsd）
  - P2 写失败 warn（diskStore + revoked catch）+ P3 tmp 唯一后缀（pid+时间戳）+ 路径统一（persistDir 参数，三文件同目录）
- **验证**：全量 1618+ 测试 + typecheck + check-i18n 0 warning + 部署 + **smoke 19/19** + 线上旧格式迁移验证（0osU 冷却保留）

### 三十、性能实测 + 性能面板 + i18n 全面清理 + ja 语言（2026-08-15）
- **nbus 性能实测（agent 服务器实测）**：RSS 93MB（36% of 256M）、cgroup 44MB、**24h 零 OOM 零崩溃**（优化前白天 693 次 OOM）；load 0.03；healthz p50 0.47ms / models 0.58ms / 面板 2.05ms / 数据面 1.3s（网关本地 <1ms）；吞吐 healthz 935 rps / models 1250 rps 0 错误；**13/13 功能回归 PASS**（性能优化未破坏功能）。**docs/PERFORMANCE.md 落盘 + README 性能章节 + 复测命令**（开源展示）
- **性能面板（总览 + 设置开关）**：GET /__admin/api/performance（进程 RSS/CPU/负载/并发门/延迟分位/池状态 + 10s TTL 缓存 + 延迟查询 LIMIT 1000 防扫描）→ 总览「性能」区块（仪表盘卡：内存条/CPU/负载 3 条/并发 bar/延迟 P50-P99/池健康）+ 设置「性能面板」开关（localStorage fc-perf 默认开）+ 侧边「性能」锚点 + i18n 15 词条
- **i18n 全面清理（agent 审计 + 修复）**：A1 静态 10 处（kind 下拉/placeholder/title/key 前缀/登录页 title）；A2 字典 zh 值 15 条中文化（tokens→令牌/KEY→密钥/API key→API 密钥/旧版 API key→旧版 API 密钥等）；A3 服务端映射（disabledReason 枚举→中文（额度耗尽/凭据无效/限流/手动停用）、friendlyQuota resets in X days→X 天、表单校验 8 条高频）；**浏览器验证全部生效**（额度耗尽 · 10h17m06s / resets in 3 天 / 订阅下拉 / 令牌 / 密钥）
- **ja 语言全量**：admin 572 词条 + LOGIN 8 + dashboard 94 + 三处接线（lang 检测/navigator/三态切换 zh→en→ja→zh + langJa 词条）；check-i18n.mjs 扩展三语言对称核对（en==zh==ja 572==572==572，0 warning）+ 修了 die 未定义 + IS_MAIN 符号链接 bug
- **验证**：全量测试（+1 修正 LOGIN_HTML 三态断言）+ typecheck + check-i18n 0 warning + 部署 + smoke 19/19 + 浏览器（性能面板数据正确 + i18n 中文干净）
- **遗留标注**：DEPLOY.md 的 MemoryMax=400M 是文档漂移（线上实际 320M）；表单校验其余 ~30 条英文待后续轮次

---

## 三十一、文档同步轮（2026-08-16，主控）

**依据**：R1 排查报告（测试 1637/1637、typecheck 干净、工作树 38 文件未提交、
67 commits、tag v0.2.0/v0.3.0、线上 0.0.0.0:8787 去盾后）+ `.claude/docs/*` 逐文档核对。
只改文档，未动代码。

- **ARCHITECTURE.md**：补去盾拓扑（FurCDN → 0.0.0.0:8787 直连无盾）；模块表补
  money.ts（单一换算权威）/ modelaccess.ts（四级授权 store）；管理面补新端点
  （model-access/performance/keys usage+disable+reset/legacy-key plain/go-toggle/update）；
  数据层 tokens 配额列 + model_access 表 + pool-disabled/revoked-sessions 持久化文件；
  面板 i18n 三语标注。
- **ISSUES.md**：I-11 改已修（admin.ts:4165 `curView==='usage'` 门）；I-17 改已修
  （线上 MAX_BODY_BYTES=32MB）；I-18 补部分进展（STRONG_SIGNAL 含 ignore-instr，但
  围栏降权 CODE_FENCE_SIGNAL_IDS 仍不含，保持设计取舍）；I-12/I-13/I-14 源码实证仍未修
  （各补 2026-08-16 核对行）；新增「配额 BLOCKER/MAJOR + 绊脚石 + 收尾核查」已修段。
- **PLAN.md**：整体重写为当前待办（38 文件 commit+发版 v0.3.1/0.4.0 / ZOBb / OTA 真机
  验收 / claude-fable-5 / TPM+IP 白名单 / a11y / 表单校验英文 / I-12·13·14）。
- **DEPLOY.md**：MemoryMax 400M→**320M**（文档漂移修正，2 处）+ 版本行；MAX_BODY_BYTES
  改已设 32MB；OPENSEA_KEYS 0osU/7qpF（ZOBb 移除）。
- **QUOTA.md**：§9 补状态与 go-toggle 契约（PUT /legacy/account/:id/go-toggle，body 只带
  被切换键 {useBalance?}|{chinaModels?}）。
- **MULTI-ACCOUNT.md**：§11 legacy 补 go-toggle 契约（同批 UI 重构落地）。
- **MODEL-ACCESS.md**：顶部补实现状态；§6 补 62 模型「可选模型」网格；步骤 7 测试基线去硬编码。
- **OTA.md**：MemoryMax 修正（2 处）+ v0.3.0 已上线 + rollback 守卫 shell 4 场景实测全对
  + 真机端到端验收待做。
- **README.md**：特性补配额计费/模型授权/性能面板/懒人式 zen API/i18n 三语/OTA；
  模型白名单改四级授权链（可扩展任意模型）；端点表补新端点；架构树补 money/modelaccess。
- **CURRENT.md**：重写（v0.3.0 已发 + 工作树 38 文件待提交清单 + 待办 + 去盾后拓扑）。
- **SHIELD.md**：已退役标注核对无误，未改；**docs/PERFORMANCE.md**：刚建、实测值准确，未改。

---

## 二十五、RPM 整体保护 + TPM + IP 白名单 + 过期确认（2026-08-16，主控直做）

任务（对标 new-api 扩展，CURRENT.md 待办 5）：全局 RPM / per-token TPM / per-token IP 白名单 / token 过期时间确认。全部完成，验证全绿。

### 交付
1. **全局 RPM**（大量 RPM 不冲垮后端）：settings `globalRpmLimit`（默认 0 = 关闭，env GLOBAL_RPM_LIMIT 启动默认，面板热配）+ config.ts 可选字段。数据面 chat/messages 请求共用 RpmLimiter 的 `__global__` 滑窗（server.ts `checkGlobalRpmLimit`，GLOBAL_RPM_KEY=server.ts:2085），超限 429 rate_limit_error + Retry-After。count_tokens/healthz/静态不计入。与并发门（400）互补：并发门防同时堆积、RPM 防单位时间洪峰。
2. **TPM**（per token 每分钟 token 上限）：tokens 表 `quota_tpm`（0=无限）+ ratelimit.ts `TpmLimiter`（固定自然分钟窗口）。**取舍：请求前检查已用（used>=limit→429），不做 max_tokens+input 预估预扣**（完成时累加真实用量零误差，与 settle 配额同哲学）；settle 时累加 input+output+cacheRead（与 tokens 配额口径一致）。TokenQuotaView + `quotaTpm/usedTpm`（usedTpm 是内存窗口，server 端点层填，store 视图恒 0）。
3. **IP 白名单**（per token）：tokens 表 `ip_whitelist`（逗号分隔 IP/CIDR）+ tokens.ts `ipInList`（手写位运算 CIDR：IPv4/8、IPv6、`::ffff:` 映射归一）。**IP 来源 = remoteAddress（网关直连对端），不是转发头**——转发头可伪造；FurCDN 场景白名单填 CDN 边缘段。未命中 403 `ip not allowed`（Anthropic authentication_error / OpenAI invalid_request_error）。TokenQuotaView + `ipWhitelist`（数组）；create/patch 接受逗号分隔字符串。
4. **token 过期**：**已有**（expires_at 列 + TokenQuotaInput/View/Update.expiresAt + quotaCheck expired→403 + 测试 `expires_at 过期：数据面 403`）。未改，确认跳过。

### 契约（前端 agent 对接）
- TokenQuotaView 新增：`quotaTpm`（0=无限）、`usedTpm`（当前分钟，内存窗口）、`ipWhitelist`（数组）、`expiresAt`（已有）。
- POST/PATCH /__admin/api/tokens 新增接受：`quotaTpm`（非负整数）、`ipWhitelist`（逗号分隔字符串或 null/''=清除）、`expiresAt`（已有）。
- settings 新增：`globalRpmLimit`（0=关闭默认）。
- verify 顺序：status → quota(expires/exhausted) → TPM → IP → token RPM → 全局 RPM。

### 文件
src/tokens.ts（字段/视图/quotaCheck 扩展 + ipInList）、src/server.ts（三个 check 函数 + 接线 + 端点 + usedTpm）、src/ratelimit.ts（TpmLimiter）、src/usagedb.ts（quota_tpm/ip_whitelist 列）、src/settings.ts + src/config.ts（globalRpmLimit）。

### 验证
typecheck 干净；`tokens+ratelimit+server+settings+e2e` 395/395 绿 + usagedb+admin 358/358 绿（schema/settings 安全网）。
**环境注记**：vitest 在本机并行 transform 偶发 admin.ts PARSE_ERROR（oxc 内存压力，非代码问题）——跑测试用 `--maxWorkers=1 --no-file-parallelism`。

### 三十二、UI 优化 + RPM 保护 + 待办推进 + 深度研究修复（2026-08-16）
- **UI（agent）**：收起状态卡片显示「在飞 n」徽章（就地刷新不重建）+ 标准 3 行额度压缩到右侧两栏 + a11y 22 处表单 label + 表单校验英文 47 条映射 + secret.key 备份提示（高亮警告）+ TPM/IP 白名单配置 UI
- **RPM 后端保护 + 对标扩展（agent）**：全局 RPM（GLOBAL_RPM_LIMIT 默认关 + settings 热配，滑窗复用）+ **TPM**（quota_tpm + TpmLimiter 自然分钟窗口 + settle 累加真实用量）+ **IP 白名单**（ipInList 精确/CIDR/IPv6/::ffff: 归一，匹配 remoteAddress——FurCDN 语义已注明）+ 过期时间确认已有
- **深度研究（explore）→ 最高价值修复**：
  - **B1 上游熔断（默认开）**：连续 5 次头超时/网络错 → open 30s → 直接 502+Retry-After（不占并发槽不发上游）→ 半开放探测（60s 看门狗）→ 成功 close；上游 4xx/5xx 不计入
  - F3 count_tokens 门（10 在飞并发门 + body 8MB）
  - I-14 401/415/404 早退加 resume+connection:close（keep-alive 不污染）
  - FurCDN-OriginRecovery 探针归观测口径（失败率不再 32% 吓人）
  - **B2 聚合下探**：queryIpStats/tokenUsageAll 加 retention 窗口 + INDEXED BY 强制 at 索引（10 万行 86ms/79ms，对齐 history 修复）
  - **I-13 flush 失败重试 1 次**（放回队首 + 200ms 重试，仍失败才丢）
- **待办推进**：ZOBb 已彻底移除（env 0 + 7 天零请求）✓；OTA 验收（守卫 3 场景真实环境对 + 检查链 latest=v0.3.0 已最新，真实 OTA 更新待 v0.3.1 发版后触发）；claude-fable-5 无流量（客户端已切走，保持现状）
- **验证**：全量 **1700/1700** + typecheck + 部署 + smoke 19/19（性能回归阈值 500ms 容并行负载）
- **遗留**：key_events 缺口待验证（下次真实 disable 核对落行）；verifyCache 惰性清理（tokens 侧）；settings PATCH 校验消息 ~8 条英文；a11y 部分
