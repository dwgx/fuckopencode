# fuckopencode 接收文档（新会话从这里开始）

更新时间：2026-08-16（最近一轮：**文档全面同步**；此前 v0.3.0 已发，工作树有
38 文件未提交 = 配额计费/UI 重构/绊脚石/性能面板/i18n ja，线上已部署到工作树大部分）。
**本项目继续由主控负责（用户明确：不用 fable，一切由主控）。** 新会话先读本文件，
再读 `.claude/docs/ARCHITECTURE.md`、`DEEPSEEK-QUIRKS.md`、`SHIELD.md`、
`MULTI-ACCOUNT.md`、`OTA.md`、`MODEL-ACCESS.md`、`QUOTA.md`。

---

## 一、项目一句话

OpenAI ↔ Anthropic 协议转换网关（上游 opencode Zen 订阅 + DeepSeek），带**多账号
管理面板**（账号/分发密钥/RPM+配额计费/热配置/观测/审计/密钥-模型授权/OTA 自更新/
性能仪表盘/i18n 三语），生产在 nbus（2GB VPS）。**2026-08-15 去盾**：Python 护盾退役，
FurCDN 直连网关（0.0.0.0:8787）。

**测试基线：1637/1637 全绿**（R1 排查实测，2026-08-16）+ `npm run typecheck` 干净 +
67 commits。CI 已接入（.github/workflows/ci.yml）。

## 二、架构（模块与数据流）

```
客户端(Claude Code/Cursor/kirostudio)
  → FurCDN (cdn.taipei, 边缘缓存/加速)
  → 网关 main.js (0.0.0.0:8787, systemd fuckopencode; 去盾后直连，无盾)
      ├─ 前置链路: 并发在飞上限(MAX_CONCURRENT_REQUESTS=400, 超限 503)
      │   → 鉴权(API_KEYS/分发key) → 配额(expires→403/超限→429) → RPM限流(ratelimit.ts)
      │   → 模型门(resolveModel + 四级授权链: 密钥>账号>全局>硬底线)
      ├─ 代理链路: /v1/chat/completions (OpenAI, 直发) + /v1/messages (Anthropic, 完整双向转换)
      │   → key池选号(keypool.ts, 冷却持久化 pool-disabled.json) → 上游(/zen/go 订阅 | /zen 按量)
      │   → 响应转换(toAnthropic/toOpenAI/sse, 流式) → 错误分类(errors.ts)
      ├─ 管理面: /__admin 面板(admin.ts 单文件内联JS, i18n en/zh/ja) + /__admin/api/* (accounts/
      │   tokens/keys/console/legacy/settings/audit/requests/models/model-access/performance/update)
      ├─ 数据层: usagedb.ts (SQLite, WAL, 用量批量异步落库 + key_totals 聚合表)
      │   accounts/tokens(含配额列)/settings(含 model_prices)/requests/admin_audit/key_totals/
      │   model_access 表
      ├─ 控制台通道: console.ts(新版 opencode REST, cookie/Bearer, OAuth补绑, 读缓存30s+单飞)
      │   legacy.ts(旧版网页抓取 + zen API 免cookie, 服务端TTL缓存30s)
      └─ 观测: metrics.ts keyprobe.ts(探活所有key, 15m) + OTA(ota.ts 自更新) + 性能面板
```

**关键设计**：
- 密钥/明文（cookie/分发 key）AES-256-GCM 加密落库（secret.key）；分发 key 明文加密存储、面板可查看/复制。
- 模型门四级授权：密钥自定义 > 账号级 allowedModels > 全局默认(settings，**可添加任意
  模型**) > 代码硬底线(deepseek 两个)——白名单外明确拒绝 400。
- 请求日志默认过滤噪音（健康检查/probe/count_tokens），「显示全部」开关。
- 错误透传：GoUsageLimitError 原样透传（含 Resets in ...）——下游能看到额度信号。

## 三、当前状态（工作树 38 文件未提交——先看 git status）

**v0.3.0 已发**（tag v0.3.0 + push + GitHub release，commit af7efde/b3b8b27/c2f6933）。
**线上已部署至工作树大部分**（deploy.sh 多轮 + 去盾），但 v0.3.0 之后的这批改动
**从未 commit**：

1. **配额计费**（QUOTA.md，B1/M1/M2/M3+MINOR 全修）：tokens 表 9 配额列（$ 存储
   microCents / tokens / requests / daily·monthly 周期 / expires_at）+ settleQuota
   （完成时逐口径条件 UPDATE，M3 防并发超额）+ quotaCheck（expires→403/超限→429）+
   定价表 settings model_prices + src/money.ts 单一换算权威 + 面板配额 UI。
2. **UI 重构**（admin.ts，1593+ 测试）：账号列表卡片网格、总览 KPI 卡化、设置页分组
   （服务/安全/运行/关于 + 侧边导航）、key 行「用量」弹层 + 禁用/恢复 + 「密钥」引导、
   详情 5 tab、oc-tooltip、数字 spinner、触屏可达。
3. **绊脚石修复批 + 收尾核查批**：pool-disabled.json（keypool 冷却持久化，manual 哨兵
   until=MAX_SAFE_INTEGER）、revoked-sessions.json、指纹碰撞→sha256 全量哈希、money.ts
   收敛、X-Error-Scope 删除、check-i18n.mjs。
4. **性能面板**：GET /__admin/api/performance（RSS/CPU/负载/并发/延迟分位/池状态，
   10s TTL）+ 总览仪表盘 + 设置开关 + i18n。
5. **i18n ja 全量**：admin 572 + LOGIN 8 + dashboard 94 词条，三语（en/zh/ja）对称，
   check-i18n 0 warning；A1/A2/A3 清理（静态 10 处 + 字典中文化 15 条 + 服务端映射）。
6. 新文件：src/money.ts、.claude/docs/QUOTA.md、docs/PERFORMANCE.md、scripts/check-i18n.mjs。

## 四、最近完成

1. **v0.3.0 发版**：模型授权（任意模型可扩展）+ OTA 自更新 + 深度修复 + 懒人式 zen API + 盾退役。
2. **去盾（2026-08-15）**：fuckopencode-shield 已停，网关监听 0.0.0.0:8787，FurCDN 直连。
3. **配额计费系统**（B1 单位错配 1e8 倍 + M1 流式断开扣 0 + M2 缓存读 + M3 并发超额，见 QUOTA.md §8）。
4. **UI 重构 + 模型授权 62 模型网格 + 分发密钥刷新**。
5. **性能实测 + 性能面板**：RSS 93MB、24h 零 OOM、healthz p50 0.47ms / 935rps（docs/PERFORMANCE.md）。
6. **i18n 全面清理 + ja 全量**。
7. **origin/kirostudio 排查**（用户跨项目问题，结论见七）。

## 五、已知遗留 / 待办（新会话从这里继续）

### 立即（提交/发版）
1. **工作树 38 文件 commit + 发版**（配额/UI/绊脚石/性能/i18n ja，一次或分逻辑提交；
   先同步 package.json version 0.3.1/0.4.0，tag + gh release，release.yml 校验
   dist/version.txt == tag）。提交禁 AI 署名、不带 emoji。
2. **ZOBb key 失效**（实测 401）：需用户决定换 key 还是删（已从池移除，等待时 0osU/7qpF 两把）。
3. **OTA 真机验收**：守卫 shell 4 场景已本地实测全对；真机完整跑一次「触发 OTA → 自动重启 →
   journalctl 替换日志 → 崩溃回滚模拟」。
4. **claude-fable-5 客户端 400 决策**（模型白名单轮副作用，8/14 被拒 8h）：设计决策
   （fable 清理授权过）还是面板补回映射，用户定。

### 对标扩展（new-api/sub2api 借鉴）
5. **TPM**（tokens per minute）+ **IP 白名单**（按 token 限定 IP）。已做：token 级配额
   （$/tokens/requests）、过期时间、模型白名单。

### 确认未修（ISSUES.md）
6. I-13 flush 整批丢弃（transient 连坐） / I-14 数据面 401/415/404 早退不消费 body /
   I-12 面板 tick 无 in-flight / I-18 注入围栏降权（已记设计取舍） / I-4 max_tokens
   抬升不记日志。（I-11 空转、I-16 Origin 数组头、I-17 MAX_BODY_BYTES 已修，见 ISSUES.md）

### 前端/体验
7. **a11y**：22 个表单字段无 label、2 个 form 无 id/name、password 不在 form 内。
8. **表单校验文案英文 → 中文**：已修 8 条高频，其余 ~30 条待后续轮次。
9. 前端便捷（H1 tokens 批量复制 / H3 明文 toggle / H4 legacy key 明文 / H5 搜索 /
   H6 深链；M 级 CSV/趋势范围/区块折叠）。(H2 账户 key 复制已做)

### 观察项
- OOM 修复完整周期验证（大 body >512KB 免克隆路径）；tokens WAL 持久性。
- secret.key 必须备份（丢失 = 账户/分发 token 永久不可解）。

## 六、关键操作与信息

- **测试/构建**：`npm test`（R1 实测 1637/1637）、`npm run typecheck`、`npm run build`、
  `node scripts/check-i18n.mjs`（三语对称）。盾测试脚本保留仅供参考（盾已退役）。
- **部署**：`./scripts/deploy.sh`（验证+构建+scp+原子替换+重启+健康检查；rollback/clean 子命令）。
- **线上**：ssh -p 52535 root@38.244.34.15（~/.ssh/id_nbus）。公网 fuckopencode.dwgx.top
  → FurCDN → 网关 0.0.0.0:8787（去盾直连）。面板默认 admin/13141516（有 adminPassIsDefault 徽章）。
- **密钥**：/root/fuckopencode/fuckopencode.env（API_KEYS 管理 key + OPENSEA_KEYS 池 key
  `****0osU` / `****7qpF`——**ZOBb 已失效移除**）。SECRETS 规则：凭证不外泄、只发给归属服务。
- **发版**：CI 已接；`git tag vX.Y.Z`（先同步 package.json version）+ `gh release create`。
- **kirostudio**（同机 8990，api.dwgx.top 公网入口）：fuckopencode 是它的 credential 1 上游
  （**已手动禁用**，当时 v4pro 误路由质量问题）；模型钉死已做。
- **git 规范**：中文提交、无 AI 署名、`feat:/fix:/perf:/docs:/ci:/test:/chore:` 前缀。

## 七、origin/kirostudio 排查结论（用户 08-14 问的，交接给 origin 会话）

- **api.dwgx.top 走 kirostudio（8990）不是 fuckopencode**：DEPLOYMENT.md 权威表 +
  响应形状逐字符一致；fuckopencode 入口是 fuckopencode.dwgx.top。
- **origin claude subagent 报告截断根因**：周额度 87% 用尽（GoUsageLimitError 429 全池）
  → kirostudio failover 到 pigcode（credential 4）→ pigcode 流解码失败 + 502 → 不完整流。
  不是 fuckopencode 的 bug。
- **pigcode 只配了 gpt 却收到 opus/pro**：kirostudio 透传选号 `model` 不参与
  （provider.rs 注释「model 暂不参与 custom_api 选号」）。
- **建议**（未执行，用户在 origin 会话决策）：禁/降权 pigcode credential 4；或等额度恢复。
- **去盾提醒**：fuckopencode 在 kirostudio 的 credential 1（127.0.0.1:8788）已手动禁用，
  暂无需处理；若日后重新启用，注意去盾后网关在 8787（原盾端口）。
