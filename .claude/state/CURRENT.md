# fuckopencode 接收文档（新会话从这里开始）

更新时间：2026-08-16（最近一轮：**v0.3.1 发版完成 + 会话收尾交接**）。
**本项目继续由主控负责（用户明确：不用 fable，一切由主控）。** 新会话先读本文件，
再读 `.claude/docs/ARCHITECTURE.md`、`DEEPSEEK-QUIRKS.md`、`QUOTA.md`、
`WORKFLOW.md`、`MODEL-ACCESS.md`、`OTA.md`、`PERFORMANCE.md`（docs/）。

---

## 〇、git 认证（新会话第一件事，最容易踩坑）

- **SSH key 已被用户 revoke（GitHub 上登记的 key 与本机不匹配，SSH push 全拒）**。
- **已切 HTTPS + gh token**：remote = `https://github.com/dwgx/fuckopencode.git`；
  全局 `url.git@github.com:.insteadof` 已删；`credential.https://github.com.helper =
  !gh auth git-credential`（用已登录的 gh token，repo 写权限）。**`git push origin main`
  直接可用，无需 SSH、无需额外参数。**
- 可选：本机已生成 `~/.ssh/id_ed25519_github`（pub 待用户加到 GitHub Settings → SSH
  and GPG keys）；用户加完才能用 SSH（当前不需要）。

## 一、项目一句话

OpenAI ↔ Anthropic 协议转换网关（上游 opencode Zen 订阅 + DeepSeek），带**多账号
管理面板**（账号/分发密钥/RPM+TPM+配额计费/IP 白名单/热配置/观测/审计/密钥-模型授权/
OTA 自更新/性能仪表盘/i18n 三语），生产在 nbus（2GB VPS）。**2026-08-15 去盾**：
Python 护盾退役，FurCDN 直连网关（0.0.0.0:8787）。

**测试基线：1700/1700 全绿**（34 文件）+ `npm run typecheck` 干净 +
`node scripts/check-i18n.mjs`（en/zh/ja 对称 0 warning）+ 72 commits（v0.2.0/v0.3.0/v0.3.1）。
CI 已接入（.github/workflows/ci.yml + release.yml）。

## 二、架构（模块与数据流）

```
客户端(Claude Code/Cursor/kirostudio)
  → FurCDN (cdn.taipei, 边缘缓存/加速)
  → 网关 main.js (0.0.0.0:8787, systemd fuckopencode; 去盾后直连，无盾)
      ├─ 前置链路: 上游熔断(连续5次超时open 30s, 半开放探测, 默认开)
      │   → 并发在飞上限(MAX_CONCURRENT_REQUESTS=400, 超限 503)
      │   → 鉴权(API_KEYS/分发key) → 配额(expires→403/超限→429) → TPM/IP白名单
      │   → 全局RPM(GLOBAL_RPM_LIMIT, 默认关) → 模型门(四级授权链)
      ├─ 代理链路: /v1/chat/completions (OpenAI, 直发) + /v1/messages (Anthropic, 完整双向)
      │   → key池选号(keypool.ts, 冷却持久化 pool-disabled.json, sha256键) → 上游(/zen/go|/zen)
      │   → 响应转换(toAnthropic/toOpenAI/sse, 流式) → 错误分类(errors.ts)
      ├─ 管理面: /__admin 面板(admin.ts 单文件内联JS, i18n en/zh/ja 614词条) + /__admin/api/*
      │   (accounts/tokens/keys/console/legacy/settings/audit/requests/models/
      │    model-access/performance/legacy-key/update)
      ├─ 数据层: usagedb.ts (SQLite, WAL, flush批量落库+失败重试1次 + key_totals 聚合表)
      │   accounts/tokens(配额列: $microCents/tokens/requests/TPM/ip_whitelist/周期/expires)/
      │   settings(model_prices)/requests/admin_audit/key_totals/model_access
      ├─ 控制台通道: console.ts(新版REST, cookie/Bearer, OAuth补绑) + legacy.ts(旧版抓取
      │   + zen API 免cookie, 服务端TTL缓存30s)
      └─ 观测: metrics.ts keyprobe.ts(15m+启动即探) + OTA(ota.ts) + 性能面板(/performance)
```

**关键设计**：
- 密钥/明文（cookie/分发 key）AES-256-GCM 加密落库（secret.key）；分发 key 明文加密存储。
- 模型门四级授权：密钥 > 账号级 > 全局默认（**可添加任意模型，62 模型可选网格**）> 硬底线。
- **单一真源**：money.ts（microCents 换算）、EXCLUDE_OBSERVED（聚合排除口径）、
  check-i18n.mjs（三语对称）、pool-disabled.json（key 冷却持久化）。
- 请求日志默认过滤噪音（probe/count_tokens/FurCDN 探针），「显示全部」开关。
- favicon = opencode logo（svg，`/favicon.svg`）。

## 三、当前状态（v0.3.1 已发版，工作树干净）

**v0.3.1 已发版**（commit 8953fe3/da8b9b1/12f0ffd/74b8d46 全推 + tag v0.3.1 + release
dist tarball + sha256 + CI 全绿 + **线上已部署 0.3.1**：dist/version.txt=0.3.1、
OTA update/check 返回 current=0.3.1 latest=v0.3.1 hasUpdate=false、网关 active 健康）。

v0.3.1 内容（全部落地）：
1. 配额计费（QUOTA.md：$/tokens/requests + daily/monthly 周期 + 定价表 + B1/M1/M2/M3 全修）
2. 上游熔断（默认开）+ count_tokens 并发门 + body 8MB + 全局 RPM + TPM + IP 白名单
3. 性能面板 + 性能实测报告（93MB RSS / 24h 零 OOM / 千级 RPS）
4. UI 重构（卡片网格/5 tab/收展+在飞徽章/3行额度右栏/自绘 spinner/a11y）
5. i18n en/zh/ja 三语（614 词条）+ 表单校验中文化 + secret.key 备份提示
6. 绊脚石根治（money.ts/EXCLUDE_OBSERVED/持久化扩展/source 三元组）
7. 三平台安装（Linux systemd/macOS nohup/Windows install.ps1）+ favicon opencode logo
8. 文档同步（WORKFLOW/QUOTA/PERFORMANCE/ARCHITECTURE/ISSUES/PLAN/DEPLOY + README）

## 四、最近完成（本会话全部轮次摘要）

1. **v0.3.0**（08-15）：模型授权/OTA/深度修复 60+/懒人式 zen API/去盾/一键安装。
2. **v0.3.1**（08-16）：配额计费/UI 重构/绊脚石修复/收尾核查/性能实测+面板/i18n ja/
   上游熔断/全局 RPM/TPM/IP 白名单/三平台/favicon/文档同步。
3. 去盾（08-15）：shield 停用，网关 0.0.0.0:8787，FurCDN 直连。
4. 深度研究轮（08-16）：B1 熔断 + B2 聚合下探（10 万行 86ms）+ I-13 flush 重试 +
   I-14 早退消费 body + FurCDN 探针归观测。
5. 待办推进：ZOBb 已彻底移除（env 0 + 7 天零请求）；OTA 验收（守卫真实环境 3 场景对）；
   claude-fable-5 无流量（保持现状）。

## 五、已知遗留 / 待办（新会话从这里继续）

### 立即
1. （无阻塞项——v0.3.1 已发版，工作树干净）
2. **SSH key 可选**：id_ed25519_github pub 已生成待用户加到 GitHub（当前 HTTPS 已够用）。

### 对标/加固（低优先）
3. key_events 缺口核实（曾停在 07:27，疑似中间构建；下次真实 disable 时核对落行）。
4. verifyCache 惰性清理（tokens.ts 一次性 token 条目常驻，量级小观察项）。
5. settings PATCH 校验消息 ~8 条英文（面板表单有 UI 校验，触发少）。

### 确认未修（ISSUES.md，低优先）
6. I-12 面板 tick 无 in-flight / I-13 已修（flush 重试）/ I-14 已修（早退消费 body）/
   I-18 注入围栏降权（设计取舍）。ISSUES.md 里对应条目标注最新状态。

### 前端/体验（低优先）
7. a11y 剩余（表单 label 已做大部分，剩个别的）。
8. 前端便捷（H1 tokens 批量复制/H3 明文 toggle/H5 搜索/H6 深链；M 级 CSV/趋势范围）。

### 观察项
- OOM 修复完整周期验证（大 body >512KB 免克隆路径）；tokens WAL 持久性。
- **secret.key 必须备份**（丢失 = 账户/分发 token 永久不可解，面板有备份提示）。

## 六、关键操作与信息

- **测试/构建**：`npm test`（1700/1700）、`npm run typecheck`、`npm run build`、
  `node scripts/check-i18n.mjs`（三语对称）、`node scripts/smoke-test.mjs`（19 项真实链路）。
- **部署**：`./scripts/deploy.sh`（验证+构建+scp+原子替换+重启+健康检查）。
- **git**：`git push origin main` 直接可用（HTTPS+gh token，见〇）。提交中文、无 AI 署名、
  `feat:/fix:/perf:/docs:/ci:/test:/chore:` 前缀。
- **发版**：同步 package.json version → `git tag vX.Y.Z`（release.yml 校验 version==tag）→
  `git push origin main` + `git push origin vX.Y.Z`（tag 触发 release.yml 构建 dist tarball）。
- **线上**：ssh -p 52535 root@38.244.34.15（~/.ssh/id_nbus）。公网 fuckopencode.dwgx.top
  → FurCDN → 网关 0.0.0.0:8787。面板默认 admin/13141516（adminPassIsDefault 徽章）。
- **密钥**：/root/fuckopencode/fuckopencode.env（API_KEYS 管理 key + OPENSEA_KEYS 池 key
  `****0osU` / `****7qpF`，**ZOBb 已移除**）。SECRETS 规则：凭证不外泄。
- **kirostudio**（同机 8990）：fuckopencode 是它的 credential 1 上游（已手动禁用，
  去盾后网关在 8787——若重新启用注意端口）。

## 七、origin/kirostudio 排查结论（交接给 origin 会话，见上版记录）

- api.dwgx.top = kirostudio（8990）；fuckopencode = fuckopencode.dwgx.top。
- origin 截断根因：周额度 87% 用尽 → kirostudio failover pigcode → 流解码失败。
- pigcode 透传选号 model 不参与（provider.rs 注释）；建议禁 pigcode 未执行（用户在 origin 决策）。
