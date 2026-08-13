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

## 五、已知遗留 / 待办（按优先级——新会话从这里继续）

### P0（应修，都在 fable 提示词里——桌面 `fuckopencode-缺陷审计优化-提示词.md`）
1. **console 读缓存无单飞**（src/console.ts cachedGet ~326 行）：30s TTL 过期瞬间多并发各打上游——加 in-flight promise 去重。配并发测试（5 并发 → 上游 1 次）。
2. **shutdown flush 不可达**（src/main.ts ~210-219）：usageDb.close()（flush 最后一批）在 server.close 回调里，活跃 SSE 连接时 5s 兜底 exit(1) 先跑 → **每次部署丢最后一批用量**。修复：shutdown 先显式 flush + closeIdleConnections + 兜底 exit 0。
3. **legacy keys/billing 无服务端缓存**（server.ts handleLegacyKeysList/Billing + legacy.ts fetchLegacyKeys）：面板详情 2s tick 每 2s 打上游 HTML——加服务端 TTL 缓存 + 前端 TTL 门。
4. **默认密码弱**（13141516）：面板设置页加「默认密码建议修改」强提示徽章（读 adminPassIsDefault 字段——UI 层还没做）。

### P1（性能/健壮）
5. 注入检测预筛（injection.ts 入口 includes 词根短路——1.5KB 文本 185µs→30µs）。
6. 鉴权 key 哈希预计算 Map（auth.ts safeEqualHex——8 key 129µs→46ns）+ apiKeys 热更新重建。
7. tokens.verify 复用 prepared statement（38µs→2.3µs）。
8. UA 解析 Map 缓存（上限 1000）、recordEvent 环形缓冲、RPM check 惰性分配、SSE offset 索引。
9. 并发在飞上限（upstream.ts，超限 503，压测定阈值）。

### P2（体验/观测）
10. 面板多 tab tick 去重；gatewayPoolUsage 读 requests 未先 flush；usageTrend 失败不写缓存（瞬时 503 十秒）。
11. 文档同步：新功能（RPM/审计/OAuth/明文存储/请求过滤/模型白名单）进 `.claude/docs/`。
12. 订阅模型探测结果的使用：是否把 env 账号默认 allowedModels 配成订阅 21 个（用户未决定——问用户）。

### 观察项
- OOM 修复完整周期验证（大 body >512KB 免克隆路径）。
- 盾高并发内存；tokens WAL 持久性（曾丢一次，checkpoint 已加固）。
- kirostudio 的 GoUsageLimitError 透传实际效果（下游能否看到额度信号）。

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
