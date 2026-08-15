# 计划

按优先级排。做完一项就从这里移到 ISSUES.md 的「已修」或直接删掉。

最后更新：2026-08-16（文档同步轮）。v0.3.0 已发（tag + push + release），
**工作树还有 38 个文件未提交**（配额计费/UI 重构/绊脚石/性能面板/i18n ja），
这是接下来所有工作的前置项。

## 优先级 1：把工作树落盘（38 文件，v0.3.0 之后）

已部署到线上大部分，但从未 commit。一次或分逻辑提交：

- 配额计费（B1/M1/M2/M3 + MINOR，QUOTA.md §8）+ 5 文件 money.ts 收敛
- UI 重构（账号卡片网格/总览 KPI/设置分组/key 用量弹层/详情 5 tab/spinner/oc-tooltip）
- 绊脚石修复批 + 收尾核查批（pool-disabled 持久化/revoked-sessions/sha256 指纹/哨兵 until）
- 性能面板（GET /__admin/api/performance + 总览仪表盘）
- i18n ja 全量（admin 572 + LOGIN 8 + dashboard 94，三语对称）
- 新文件：src/money.ts、.claude/docs/QUOTA.md、docs/PERFORMANCE.md、
  scripts/check-i18n.mjs

发版：先同步 package.json version（0.3.1 或 0.4.0），`git tag` + `gh release create`
（release.yml 校验 dist/version.txt == tag，OTA 分发物）。提交禁 AI 署名、不带 emoji。

## 优先级 2：需要用户决策的三件事

1. **ZOBb key 失效**（实测 401 Invalid API key）：换新 key 还是删掉。等待时池里
   只有 0osU/7qpF 两把，0osU 周额度已满，主流量全压 7qpF。
2. **OTA 真机验收**：线上已配 OTA_ENABLED=1 + systemd drop-in，rollback 守卫
   shell 4 场景已本地实测全对；还没在真机完整跑一次「触发 OTA → 自动重启 →
   journalctl 替换日志 → 崩溃回滚模拟」。
3. **claude-fable-5 客户端 400**（2026-08-14 模型白名单轮副作用，被拒 8h）：
   是设计决策（fable 清理授权过）还是在面板补回映射，用户定。

## 优先级 3：对标扩展（new-api/sub2api 借鉴，见 state.md §二十）

- **TPM**（tokens per minute）限流
- **IP 白名单**（按分发 token 限定调用 IP）
- 已做：token 级配额（$ / tokens / requests）、过期时间（expires_at）、模型白名单；
  `token 级额度` 与 `过期时间` 已落地，无需再做

## 优先级 4：ISSUES.md 未修项（按影响排序）

- **I-13** flush 整批丢弃（transient 连坐丢最多 50 条）：失败放回队首重试 1 次
- **I-14** 数据面 401/415/404 早退不消费 body（keep-alive 污染）：对齐限流路径
  `req.resume()` + `connection: close`
- **I-12** 面板 2s tick 无 in-flight 防护：给 tick 请求组加 in-flight 门
- **I-18** 注入围栏降权不含 ignore-instr：已记录为设计取舍，改需先论证
- **I-4** max_tokens 抬升记一行日志（`max_tokens 200 → 4096`，便于账单排查）
- config.ts `isLoopbackHost` 里把 `0.0.0.0` 移出去（当前靠调用方兜住，埋雷）

## 优先级 5：前端/体验小项

- **a11y**：22 个表单字段无 label、2 个 form 字段无 id/name、password 不在 form 内
  （Chrome accessibility 建议，不影响功能）
- **表单校验文案英文 → 中文**：已修 8 条高频，其余 ~30 条待后续轮次
- 前端便捷功能（对比 cursorapi/windsurf/sub2api/kirostudio，H1-H6 等）：
  H1 tokens 批量复制全部 / H3 明文展示 toggle / H4 legacy key 创建后展示明文 /
  H5 账户搜索筛选 / H6 URL 深链；M 级 CSV 导出/趋势范围切换/区块折叠
- 面板未登录 tick 噪音（INFO，可后续砍日志量）

## 长期观察项

- OOM 修复完整周期验证（大 body >512KB 免克隆路径）；tokens WAL 持久性
- GoUsageLimitError 透传实际效果（下游能否看到额度信号）
- secret.key 必须备份（丢失/更换 = 全部账户与分发 token 永久不可解，无迁移指引）

## 待定方向（需要拍板）

- I-5 `/v1/messages` 是否加 system 护栏：补护栏（安全一致）或写进文档（保持直通语义）

## 不做

- 不给注入检测加更多正则。它是启发式降噪，不是安全边界，
  加规则只会增加误杀，收益递减。
- 不引入 express/fastify。零依赖是刻意的。
- 不做 DNS rebinding 防护。网关这层做不到，见 ISSUES.md。
- 不给盾重新启用/重新部署（2026-08-15 已退役，FurCDN 直连网关）。
