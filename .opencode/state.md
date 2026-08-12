# fuckopencode 任务状态

更新时间：2026-08-12 14:20（本轮：RPM 限流 + UI 全站模板化 + 错误修复 + 安全，已部署，1151 测试绿）

## 目标
OpenCode 能力复刻到自建网关面板 + 线上稳定 + 全站控件模板化。用户已出门（2026-08-12），不问、按决策执行。

## 本轮完成（已部署 + 1151 测试全绿）
1. **per-key RPM 限流**（用户核心需求）：tokens 表 rpm_limit 列（0=不限流）+ RpmLimiter（src/ratelimit.ts：60 桶滑动窗口、拒绝也计数、惰性清理）+ chat/messages 入口限流（429 协议正确 Anthropic/OpenAI + retry-after + 不触发 keypool 冷却 + 不计入转发）+ 密钥 tab RPM 配置 UI（输入 + 保存 PATCH）。
2. **UI 全站控件模板化**（用户硬要求「不许有一个控件不走模板」）：oc-btn/primary/ghost/danger/sm、oc-input/select/textarea/field/form、oc-hint/oc-hint-err、oc-modal 系列（confirm-ok 改 data-variant）、oc-check（GO checkbox）+ oc-switch（实验开关）、oc-chip/oc-dot（徽章/状态点）；旧类名 CSS 兼容别名；内联 JS new Function() 解析测试防线。
3. **错误修复**：
   - 详情页 loading 态（用户「点进啥也看不到」——是加载中无提示）
   - 右键账号卡片进详情（contextmenu，输入框内放过）
   - 错误 sticky 持久化（go/legacy/billing 等——不被 2s 轮询刷掉，用户手动操作成功才清）
   - RPM 输入不被轮询清（tokenFingerprint 守卫——对抗审查 B1）
   - set-rpm/toggle-token 失败走 flash（不写隐藏弹层——M2）
   - consoleBlock 重复渲染（M3）
   - legacy key 复制按钮（/keys/plain 明文端点——内存缓存 + 实时抓取 + TTL + 上限 + 鉴权）
   - gmail auth failed 具体指引、billing 无 balance 显示 —、import-cookie 补 noteCredentialChanged
   - LOGIN_HTML i18n（硬编码英文修复）
4. **服务端正确性**（对抗审查修复）：retry-after 改为「窗口降到 limit 以下」时刻（饱和时 50s 而非恒 1s——实测验证）+ 429 前 drain body + Connection: close（防 keep-alive 假 400）+ now=0 边界（lw>0 漏计——真实场景不触发但已修）。
5. **线上安全**：盾观测端点 /_shield/* 仅回环可访问（公网 404 实测）。

## 线上关键事实
- 架构：FurCDN（cdn.taipei）直连 nbus:8787 回源（不是 cloudflared！）——**盾不能改回环监听**（面板 502 已踩坑）。
- 网关 127.0.0.1:8788（systemd fuckopencode，/root/fuckopencode/dist），盾 0.0.0.0:8787（fuckopencode-shield，/opt/fuckopencode-shield/kiro_shield.py），面板密码 13141516。
- 公网面板 200 稳定。本地隧道 8788 调试用。
- 分发 key：dwgxnbnb（sk-****239d8bcd）RPM 默认 0。

## 遗留/待办（重要）
1. **gmail/outlook console cookie 失效**（线上实测 __Host-console_session 过期）：面板已给指引（更新 cookie/从浏览器导入）——**需要用户重新登录 opencode.ai 粘贴 cookie**（共享 Chrome 是 gmail 会话——导入路径已修 noteCredentialChanged）。这是用户侧动作，等用户回来。
2. **OOM 修复观察**：693 次崩溃全在 10:00 修复前，之后 0 次，触发条件大 body——需完整周期。
3. **tokens 持久性**：checkpoint 加固已部署，WAL 丢失未复现。
4. **工作树大量未提交**（历轮 + 本轮——69 文件），用户没让提交。
5. 盾公网直连口子仍在（FurCDN 需公网回源，无 IP 白名单——并发闸门兜底 503，记录为已知）。
6. 总览 24h/7d 切换按钮（端点已支持 range，一行接上）。

## 下一轮候选
1. 用户回来：更新 gmail/outlook cookie → 验证 legacy/console 数据恢复
2. 提交工作树（等指示）
3. 观察 OOM/盾/tokens
4. 文档同步
