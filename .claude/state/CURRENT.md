# fuckopencode 接收文档（新会话从这里开始）

更新时间：2026-08-15（最近一轮：密钥-模型授权 + OTA 已实现、部署 NBUS；假冷却修复已上线；大量改动**未提交**）。
**本项目继续由主控负责（用户明确：不用 fable，一切由主控）。** 新会话先读本文件，
再读 `.claude/docs/ARCHITECTURE.md`、`DEEPSEEK-QUIRKS.md`、`SHIELD.md`、
`MULTI-ACCOUNT.md`、`OTA.md`、`MODEL-ACCESS.md`。

---

## 一、项目一句话

OpenAI ↔ Anthropic 协议转换网关（上游 opencode Zen 订阅 + DeepSeek），带**多账号
管理面板**（账号/分发密钥/RPM/热配置/观测/审计/密钥-模型授权/OTA 自更新），生产在
nbus（2GB VPS），前面有 Python 护盾（FurCDN 直连回源）。

**测试基线：1402 条全绿**（32 文件）+ 盾测试 40/40。`npm run typecheck` 干净。
CI 已接入（.github/workflows/ci.yml，push main 自动跑 typecheck+test+build）。

## 二、架构（模块与数据流）

```
客户端(Claude Code/Cursor/kirostudio)
  → FurCDN (cdn.taipei, 边缘缓存/加速)
  → 盾 kiro_shield.py (8787, Python, 并发闸门 200/重试吸收/观测端点仅回环/管理路径 401 透传)
  → 网关 main.js (8788, systemd fuckopencode)
      ├─ 前置链路: 并发在飞上限(MAX_CONCURRENT_REQUESTS=400, 超限 503)
      │   → 鉴权(API_KEYS/分发key) → RPM限流(ratelimit.ts) → 模型门(resolveModel
      │   + 密钥级授权 checkModelGate keyAllowed)
      ├─ 代理链路: /v1/chat/completions (OpenAI, 直发) + /v1/messages (Anthropic, 完整双向转换)
      │   → key池选号(keypool.ts, 账号级+密钥级模型过滤) → 上游(/zen/go 订阅 | /zen 按量)
      │   → 响应转换(toAnthropic/toOpenAI/sse, 流式) → 错误分类(errors.ts)
      ├─ 管理面: /__admin 面板(admin.ts 单文件内联JS) + /__admin/api/* (accounts/tokens/
      │   console/legacy/settings/audit/requests/models/oauth/model-access/update)
      ├─ 数据层: usagedb.ts (SQLite, WAL, 用量批量异步落库 + key_totals 聚合表)
      │   accounts/tokens/settings/requests/admin_audit/key_totals/model_access 表
      ├─ 控制台通道: console.ts(新版 opencode REST, cookie/Bearer, OAuth补绑, 读缓存30s+单飞)
      │   legacy.ts(旧版网页抓取: keys/GO订阅/计费, 服务端TTL缓存30s)
      └─ 观测: metrics.ts keyprobe.ts(探活所有key, 15m) + OTA(ota.ts 自更新)
```

## 三、当前状态（⚠️ 大量改动未提交——先看 git status）

**工作树有 8+ 个未提交功能/修复，从未 commit/发版**（v0.2.0 是上一个 tag）：
1. **密钥-模型授权**（MODEL-ACCESS.md）：model_access 表（token/api-key/upstream-key 三类
   subject）+ 优先级链「密钥自定义 > 账号级 > 全局默认(settings allowedModels) > 硬底线」+
   双数据面门 + 3 个管理端点 + 面板 Model Access tab（chip 编辑/搜索/徽章）。verifyAuth 加 apiKeyFp。
2. **OTA 自更新**（OTA.md）：release.yml（tag 触发+版本校验）+ ota.ts（镜像链检查/流式下载/
   sha256 独立信道/tar 三重校验/原子替换/INVOCATION_ID 自重启）+ ota-guard.ts + rollback-guard.sh
   （systemd ExecStartPre 崩溃回滚）+ 面板 sec-update UI。OTA_ENABLED 默认 0。
3. **账户 key 复制（H2）**：GET /__admin/api/accounts/:id/keys/plain + keyRow 复制按钮。
4. **订阅/zen 引导**：服务账号/旧版 API key（zen 按量扣余额）vs Go 订阅（周/月窗口）文案。
5. **fable 映射清理**：DEFAULT_MODEL_ALIASES 清空（不再 seed mythos/fable）；**线上
   model_aliases 表已删这 2 条**（用户授权；删除后请求流通验证正常）。
6. **假冷却修复（最新）**：FreeUsageLimitError 归 rate-limit（pool 3s/账户 15min，不再 24h 冻
   能用的 key——实测 7qpF 被冻后直接请求上游 200）；GoUsageLimitError 兜底 1h→24h；quota
   兜底 QUOTA_FALLBACK_COOLDOWN_MS 1h→24h。errors.test/keypool.test 同步。

**2026-08-15 深度挖掘轮已修清单**（缺陷编号见 `.opencode/state.md` 与源码注释）：
A-P2-1/3/4/5/6/7（admin.ts 七项）、D-P2-1/2/3/4（数据层四项）、S-P1-1（writeChunk 半死连接
挂死流式 + 监听器累积，顺带 I-7）、S-P2-1~5（server.ts 五项）、O-P1-1/O-P2-1/2/3（OTA 守卫
四项：boot_attempts 守卫管理（进程只写 health）+ 版本裁决）。另有清理轮（I-15 缓存返回副本、getRpmLimit/
request/response 死代码标注、keypool 冷却注释修正等），详 `.claude/docs/ISSUES.md`。

**已部署 NBUS**（deploy.sh 多轮，最新假冷却修复 08-15 03:39 + restart）：网关 8788 健康、
公网 fuckopencode.dwgx.top 全 200。OTA ops 已落地（rollback-guard.sh + systemd drop-in +
OTA_ENABLED=1）。

**去盾（2026-08-15）**：fuckopencode-shield 已停。网关改监听 `0.0.0.0:8787`（原盾端口），
FurCDN 直连网关，链路不再有盾。deploy.sh / smoke-test.mjs 已同步（盾检查项移除，
健康检查只查 8787）；SHIELD.md 标退役，盾运维脚本保留仅供回滚/参考。

## 四、最近完成（08-14 大轮）

1. 审计轮 P0+P1（console 单飞/shutdown flush/legacy TTL 缓存/密码徽章/白名单缓存清空/
   transient 误记/tool_choice 对齐/并发上限/key_totals 聚合表/max_tokens 下限/性能四项）→ v0.2.0 发版。
2. 文档全量同步（QUIRKS 行号重定位/ARCHITECTURE 模块表/README env 全量/ISSUES I-11~I-20/
   MULTI-ACCOUNT 补 3 章/CURRENT 重写）。
3. 密钥-模型授权 + OTA 两大功能（对抗式审查 2 波，B-1/M-1 等全修）。
4. 假冷却修复（FreeUsageLimitError 误伤 7qpF 实测 200 的教训）。
5. **origin/kirostudio 排查**（用户跨项目问题，结论见七）。

## 五、已知遗留 / 待办（新会话从这里继续）

### 立即（提交/发版）
1. **未提交代码要 commit + 发版**（模型授权 + OTA + 复制 + 引导 + fable + 假冷却，一次或分
   逻辑提交；CI 已接，tag v0.3.0 走 release 流程，注意 release.yml 校验 package.json version）。
2. **ZOBb key 失效**（实测 401 Invalid API key）：面板现显示 quota-exhausted（旧标记），重启后
   探活会转 auth；**需用户决定换 key 还是删**（OPENSEA_KEYS/env 账号里的配置）。

### 部署/运维
3. 生产 env MAX_BODY_BYTES=0 改回 33554432（I-17，认证客户端 DoS 面）。
4. OTA 真机验收（触发一次 OTA → 自动重启 → journalctl 有替换日志；崩溃回滚模拟）。

### 确认未修（ISSUES.md）
5. I-11 面板用量 tab 三请求空转 / I-13 flush 整批丢弃 / I-14 401/415 不消费 body /
   I-12 面板 tick 无 in-flight / I-16 Origin 数组头 / I-18 注入围栏降权。
   （I-15 缓存内部引用、I-7 writeChunk 监听器累积、I-20 OTA 已在深度挖掘轮修掉，见上清单）

### 前端便捷功能（对比 cursorapi/windsurf/sub2api/kirostudio）
6. H1 tokens 批量复制全部 / H3 明文展示 toggle / H4 legacy key 创建后展示明文 /
   H5 账户搜索筛选 / H6 URL 深链；M 级 CSV 导出/趋势范围切换/区块折叠。
   （H2 账户 key 复制已做）

### 观察项
- OOM 修复完整周期验证；tokens WAL 持久性；GoUsageLimitError 透传实际效果。
- secret.key 必须备份（丢失 = 账户/分发 token 永久不可解）。

## 六、关键操作与信息

- **测试/构建**：`npm test`（1402 基线）、`npm run typecheck`、`npm run build`、
  盾 `python3 scripts/dwgx/test-shield.py`（40/40）。
- **部署**：`./scripts/deploy.sh`（验证+构建+scp+原子替换+重启+健康检查；rollback/clean 子命令）。
- **线上**：ssh -p 52535 root@38.244.34.15（~/.ssh/id_nbus）。公网 fuckopencode.dwgx.top
  → 盾 8787 → 网关 8788。面板默认 admin/13141516（有 adminPassIsDefault 徽章）。
- **密钥**：/root/fuckopencode/fuckopencode.env（API_KEYS 管理 key + OPENSEA_KEYS 3 个池 key
  ZOBb/0osU/7qpF——**ZOBb 已失效 401**）。SECRETS 规则：凭证不外泄、只发给归属服务。
- **发版**：CI 已接；`git tag vX.Y.Z`（先同步 package.json version）+ `gh release create`。
- **kirostudio**（同机 8990，api.dwgx.top 公网入口）：fuckopencode 是它的 credential 1 上游
  （127.0.0.1:8788）；模型钉死已做（adversarial-reviewer/codebase-scout/gateway-probe → deepseek-v4-flash）。
- **git 规范**：中文提交、无 AI 署名、`feat:/fix:/perf:/docs:/ci:/test:/chore:` 前缀。

## 七、origin/kirostudio 排查结论（用户 08-14 问的，交接给 origin 会话）

- **api.dwgx.top 走 kirostudio（8990）不是 fuckopencode**：DEPLOYMENT.md 权威表 +
  响应形状逐字符一致（`{"error":{"type":"authentication_error","message":"Invalid API key"}}`）+
  fuckopencode 是 `unauthorized`。fuckopencode 入口是 fuckopencode.dwgx.top。
- **origin claude subagent 报告截断根因**：周额度 87% 用尽（GoUsageLimitError 429 全池）
  → kirostudio failover 到 pigcode（credential 4）→ pigcode 流解码失败
  （`error decoding response body`）+ 502 → Claude Code 收到不完整流（stop_reason null）。
  不是 fuckopencode 的 bug（该时段 fuckopencode 零请求）。
- **pigcode 只配了 gpt 却收到 opus/pro**：kirostudio 透传选号 `model` 不参与
  （provider.rs 注释「model 暂不参与 custom_api 选号」），白名单门只在 model 非 None 时生效
  （`model.is_none_or` 放行）。
- **建议**（未执行，用户在 origin 会话决策）：禁/降权 pigcode credential 4；或等额度恢复。
