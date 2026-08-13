# fuckopencode 接收文档（新会话从这里开始）

更新时间：2026-08-14（最近一轮：审计轮修复 P0+P1 全部完成，v0.2.0 已发版）。
**本项目继续由主控负责（用户明确：不用 fable，一切由主控）。** 新会话先读本文件，
再读 `.claude/docs/ARCHITECTURE.md`、`DEEPSEEK-QUIRKS.md`、`SHIELD.md`、
`MULTI-ACCOUNT.md`。

---

## 一、项目一句话

OpenAI ↔ Anthropic 协议转换网关（上游 opencode Zen 订阅 + DeepSeek），带**多账号
管理面板**（账号/分发密钥/RPM/热配置/观测/审计），生产在 nbus（2GB VPS），
前面有 Python 护盾（FurCDN 直连回源）。

**测试基线：1297 条全绿**（29 文件）+ 盾测试 40/40。`npm run typecheck` 干净。
CI 已接入（.github/workflows/ci.yml，push main 自动跑 typecheck+test+build）。

## 二、架构（模块与数据流）

```
客户端(Claude Code/Cursor/kirostudio)
  → FurCDN (cdn.taipei, 边缘缓存/加速)
  → 盾 kiro_shield.py (8787, Python, 并发闸门 200/重试吸收/观测端点仅回环/管理路径 401 透传)
  → 网关 main.js (8788, systemd fuckopencode)
      ├─ 前置链路: 并发在飞上限(MAX_CONCURRENT_REQUESTS=400, 超限 503)
      │   → 鉴权(API_KEYS/分发key) → RPM限流(ratelimit.ts) → 模型门(resolveModel)
      ├─ 代理链路: /v1/chat/completions (OpenAI, 直发) + /v1/messages (Anthropic, 完整双向转换)
      │   → key池选号(keypool.ts, 账号级allowedModels过滤) → 上游(/zen/go 订阅 | /zen 按量)
      │   → 响应转换(toAnthropic/toOpenAI/sse, 流式) → 错误分类(errors.ts)
      ├─ 管理面: /__admin 面板(admin.ts 单文件内联JS) + /__admin/api/* (accounts/tokens/
      │   console/legacy/settings/audit/requests/models/oauth)
      ├─ 数据层: usagedb.ts (SQLite, WAL, 用量批量异步落库 100ms/50条事务 + key_totals 聚合表)
      │   accounts表(cookie/oauth加密+allowed_models) tokens表(分发key 明文AES加密存)
      │   settings表(热配置) requests表(用量) admin_audit表(审计) key_totals表(byKey聚合)
      ├─ 控制台通道: console.ts(新版 opencode REST, cookie/Bearer fallback, OAuth补绑, 读缓存30s+单飞)
      │   legacy.ts(旧版网页抓取: keys/GO订阅/计费, 服务端TTL缓存30s)
      └─ 观测: metrics.ts(改写/剥离/压缩计数) keyprobe.ts(探活所有key, 15m)
```

**关键设计**：
- 密钥/明文（cookie/分发 key）AES-256-GCM 加密落库（secret.key，`1:...` 格式）；分发 key 明文加密存储、面板可查看/复制。
- 模型门：`ALLOWED_MODELS`（deepseek-v4-flash/free 全局底线）+ **账号级 allowedModels**
  （accounts 表列，选号过滤）——白名单外**明确拒绝 400**（不再静默降级）；池冷却才是 503。
  订阅实际可用 21 模型（探测清单见下）。
- 上游订阅模型（**实测可用 21 个**）：deepseek-v4-flash/pro、glm-5/5.1/5.2、kimi-k2.5/2.6/2.7-code/k3、minimax-m2.5/2.7/m3、qwen3.5/3.6/3.7/3.7-max/3.8-max-plus、gpt-5.6-luna、mimo-v2.5/2.5-pro、hy3。不可用：grok-4.5(503)、mimo-v2-pro/omni(400)、hy3-preview(400)。
- 请求日志默认过滤噪音（健康检查/probe/count_tokens），「显示全部」开关。
- 错误透传：GoUsageLimitError 原样透传（含 Resets in ...，盾 passthrough）——下游能看到额度信号。

## 三、当前状态

- **最新 commit**：`a8de584 docs: 记录 review 波 2 结论与 v0.2.0 版本收尾`（已 push main）。
- **版本**：v0.2.0 已 tag + GitHub release（github.com/dwgx/fuckopencode/releases/tag/v0.2.0）。
  CI（node 22/24 × typecheck+test+build）两轮全绿。
- **线上已部署**：网关 + 盾都 active（最近部署 08-14，模型白名单轮）。公网面板 200。
- **本机压测基线**（假上游）：并发 100 → 664 RPS / 200 → 1435 RPS，错误率 0，内存 113-133MB。
- **工作树**：待提交（文档同步轮，见 git status）。

## 四、最近完成（08-12 ~ 08-14 大轮）

1. **多账号面板全量**：账号层 AES/OAuth/探活、双控制台通道（console 新版 + legacy 旧版）、
   分发密钥（RPM/明文加密查看/复制/补录）、热配置（settings 运行时）、面板全量。
2. **线上稳定**：OOM 修复（structuredClone）、400 改写、盾并发闸门、GoUsageLimitError 透传、
   探活覆盖所有 key、非流式 150s 超时封顶。
3. **安全加固**：伪造 Host 免鉴权（B1）、DASHBOARD_OPEN 默认关、会话密码版本、登录 Origin 校验、
   转发头剥离、登录 body 上限、默认密码徽章（adminPassIsDefault）。
4. **性能**：热路径查询合并 + 批量异步落库、流式 O(n²) 消除 + 缓冲上限、SSE 上限、高并发回归测试。
5. **监控**：操作审计（admin_audit）、count_tokens 记账修正、趋势真实聚合。
6. **模型白名单**：账号级 allowedModels + 白名单外明确拒绝 400 + 被动学习 blocked + 目录定时刷新。
7. **审计轮（08-14，v0.2.0）**：console 单飞、shutdown flush（抽 src/shutdown.ts）、legacy TTL 缓存、
   密码徽章、allowedCache 清空修复、upstream transient、tool_choice 对齐、**并发在飞上限**、
   **key_totals 聚合表**、chat max_tokens 下限、注入预筛/鉴权哈希/tokens prepared/UA 缓存。
   对抗式审查（reviewer）无 BLOCKER，M-1 + m-1~m-11 全修。
8. **文档同步（08-14）**：DEEPSEEK-QUIRKS 行号全面重定位 + 3 条新 quirk（0/13/14）、
   ARCHITECTURE 模块表补 14 个、README env 全量 + 管理面端点、ISSUES I-6 标已修 + 新增 I-11~I-20、
   MULTI-ACCOUNT 补 3 章、DEPLOY 补 MAX_BODY/并发/CI/发版、SHIELD 401 透传修正。
9. **outlook key**（sk-HwTc...7qpF）：已补进 env 账号 + 昵称「dwgx outlook key」；探活覆盖全部 3 key。

## 五、已知遗留 / 待办（按优先级——新会话从这里继续）

### 部署/运维（用户动作）
1. **生产 env MAX_BODY_BYTES=0 改回 33554432**（I-17，认证客户端 DoS 面；代码默认已 64MB）。
2. **OTA 自更新未实现**（I-20）：需要明确「不做（手动 scp+systemctl 够用）」或「做
   （轮询 GitHub release，tag 门禁 + SHA256 + 原子替换 + 回滚）」——用户关注项。

### 确认未修（ISSUES.md 有细节）
3. I-11 面板用量 tab 三请求非 usage 视图每 2s 空转（一行 `if (curView==='usage')`）。
4. I-13 flush() 整批丢弃面宽（transient 连坐丢整批）——放回队首重试 1 次。
5. I-14 早期错误（401/415）不消费 body 不关连接 → keep-alive 污染（req.resume + connection: close）。
6. I-12 面板 2s tick 无 in-flight 防护；I-15 缓存返回内部引用；I-16 Origin 数组头放行；
   I-18 注入围栏降权吞 ignore-instr；I-7 writeChunk 监听器累积。

### P2（体验/观测）
7. 前端便捷功能（对比 cursorapi/windsurf/sub2api/kirostudio 候选，见 .opencode/state.md 七）：
   H1 tokens 批量复制全部 / H2 账户上游 key 复制（唯一无法从面板取回的密钥类型）/ H3 明文展示
   toggle / H4 legacy key 创建后展示明文 / H5 账户搜索筛选 / H6 URL 深链；M 级 CSV 导出、
   趋势范围切换、区块折叠、错误重试按钮；中远期批量操作条/批量文本导入/错误行动指引/
   状态标签增强/SSE 日志/半开恢复。
8. 订阅模型探测结果的使用：env 账号默认 allowedModels 是否配成订阅 21 个（用户未决定）。

### 观察项
- OOM 修复完整周期验证（大 body >512KB 免克隆路径）。
- 盾高并发内存；tokens WAL 持久性（曾丢一次，checkpoint 已加固）。
- kirostudio 的 GoUsageLimitError 透传实际效果。
- secret.key 必须备份（丢失/更换 = 全部账户与分发 token 永久不可解，无迁移指引）。

## 六、关键操作与信息

- **测试/构建**：`npm test`（1297 基线）、`npm run typecheck`、`npm run build`、盾 `python3 scripts/dwgx/test-shield.py`（40/40）。
- **部署**：`./scripts/deploy.sh`（构建→scp→原子替换→重启→健康检查；rollback/clean 子命令）。
- **线上**：ssh -p 52535 root@38.244.34.15。面板密码 `13141516`（admin/admin？——登录用 username=admin, password=13141516）。本地调试隧道：`ssh -f -N -L 8788:127.0.0.1:8788 root@38.244.34.15 -p 52535 -o ServerAliveInterval=60`。
- **密钥**：`/root/fuckopencode/fuckopencode.env`（API_KEYS 1 个管理 key + OPENSEA_KEYS 3 个池 key ZOBb/0osU/7qpF）。**SECRETS.md 规则**：凭证不外泄、只发给归属服务。
- **发版**：CI 已接入；发版走 `git tag vX.Y.Z` + `gh release create`（版本号 package.json）。
- **kirostudio**（nbus 同机，systemd kirostudio.service，配置 /opt/kirostudio/config/）：fuckopencode 是它的上游之一（credential 1，已手动禁用——当时 v4pro 误路由质量问题）；v4pro 走官方 DeepSeek（credential 2）。
- **git 规范**：中文提交、无 AI 署名、`feat:/fix:/perf:/docs:/ci:/test:/chore:` 前缀 + 逗号描述。

## 七、约定（项目铁律）

- 零运行时依赖（node: 内置 + 已装）；改动最小、外科手术式；每项修复配回归测试（去掉修复会红）；`npm test + typecheck` 全绿是底线。
- 面板内联 JS 有 `new Function()` 解析测试防线（改 admin.ts 内联 JS 保持绿）；i18n 中英键集合一致。
- 提交信息不带 emoji、不带 AI 署名；只提交用户要求的内容。
- 诚实报告：测试真实输出、没跑过的不说跑过、改了什么/为什么/验证证据。
