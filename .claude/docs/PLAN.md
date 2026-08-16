# 计划

按优先级排。做完一项就从这里移到 ISSUES.md 的「已修」或直接删掉。

最后更新：2026-08-16（v0.3.1 发版完成）。工作树干净，v0.3.0/v0.3.1 均已发版
（tag + release + CI 全绿 + 线上已部署 0.3.1）。以下是剩余低优先项。

## 优先级 1：对标/加固（低优先，无阻塞）

- **key_events 缺口核实**：key_events 表曾停在 07:27（疑似中间构建未接线），
  当前进程从 pool-disabled.json 恢复禁用态无需新事件——下次出现真实 disable 时
  核对一次落行（排除中间构建残留）。
- **verifyCache 惰性清理**（tokens.ts）：一次性 token 条目常驻无周期 prune，
  量级小（千条小对象），观察项；可选加惰性清理或上限。
- **settings PATCH 校验消息 ~8 条英文**：面板表单有 UI 校验、管理端极少触发，
  低优先；translateServerMsg 已覆盖 47 条，可继续扩展。

## 优先级 2：前端/体验（低优先）

- a11y 剩余（表单 label 已做大部分，剩个别的）
- 前端便捷（对比 cursorapi/windsurf/sub2api/kirostudio）：
  H1 tokens 批量复制全部 / H3 明文展示 toggle / H5 账户搜索筛选 / H6 URL 深链；
  M 级 CSV 导出 / 趋势范围切换
- 面板未登录 tick 噪音（INFO，日志量已大减，可后续）

## 优先级 3：ISSUES.md 未修项（确认未修的低优先）

- **I-12** 面板 2s tick 无 in-flight 防护（I-13 已修 flush 重试、I-14 已修早退消费 body）
- **I-18** 注入围栏降权不含 ignore-instr：已记录为设计取舍，改需先论证
- **I-4** max_tokens 抬升记一行日志（便于账单排查）
- config.ts `isLoopbackHost` 里把 `0.0.0.0` 移出去（当前靠调用方兜住，埋雷）

## 长期观察项

- OOM 修复完整周期验证（大 body >512KB 免克隆路径）；tokens WAL 持久性
- GoUsageLimitError 透传实际效果（下游能否看到额度信号）
- **secret.key 必须备份**（丢失/更换 = 全部账户与分发 token 永久不可解，面板有提示）

## 待定方向（需要用户拍板）

- **SSH key 可选**：本机 id_ed25519_github pub 已生成待用户加到 GitHub
  （当前 HTTPS + gh token 已够用，SSH 非必需）
- I-5 `/v1/messages` 是否加 system 护栏：补护栏（安全一致）或写进文档（保持直通语义）

## 不做

- 不给注入检测加更多正则。它是启发式降噪，不是安全边界，加规则只会增加误杀。
- 不引入 express/fastify。零依赖是刻意的。
- 不做 DNS rebinding 防护。网关这层做不到，见 ISSUES.md。
- 不给盾重新启用/重新部署（2026-08-15 已退役，FurCDN 直连网关）。
- 不引入多实例/水平扩展（单进程设计是天花板，SQLite 单写者 + 进程内态）。
