# 控制台数据接入提升：OAuth 完整接入 + cookie 失效替代路径

## 目标
1. OAuth 账号 console 数据全覆盖（Bearer 通道确认 + 补测试）
2. OAuth 生命周期：refresh 失效 → 面板明确「OAuth 凭据失效，重新授权」；OAuth 弹层失败文案补全；补绑现状确认+文档化
3. cookie 失效体验：详情页横幅加 OAuth 引导入口
4. 测试：Bearer 通道全端点覆盖 + refresh 失效状态；npm test + typecheck 全绿

## 约束
- 只碰 oauth.ts / console.ts / server.ts 的 console+OAuth 端点区 / admin.ts 的 OAuth 弹层+提示区 / 相关测试
- 不碰鉴权/登录/会话/盾、count_tokens/审计、accounts/tokens/settings 管理逻辑
- 工作区有并行 agent 未提交改动（security/audit 等），我的 diff 要隔离开

## 已确认事实（探查结论）
- console.ts 所有读端点都走 `getCredentials()`（cookie 优先，401 后回退 Bearer）→ **代码层面 OAuth 已全覆盖所有端点**，无 cookie-only 端点。workspaces 端点是 store 推断不查上游。真实上游是否认 Bearer 未实测（需活 OAuth 账号），诚实披露。
- `recordFail(id, auth)` 只记 invalid，**不记哪个通道失败** → cookieStatus 只有 ok/invalid，OAuth 失效也显示「更新 cookie」错误指引（误导）。
- server.ts `consoleCookieState` 返回 ok/invalid/missing；billing invalid 路径写死 cookieState:'invalid'；sendConsoleReadFailure 文案只提 cookie。
- admin.ts `oauthError(reason)`：expired/denied/net 有专文案，**not_found 落到泛 oauthFail**。
- 补绑：`persistOauthAccount` 按 workspaceId 幂等 —— 同 workspaceId 已存在账号 → 更新 oauth refresh（即补绑生效）；不同 workspaceId → 新建。现状=workspaceId 匹配即补绑。
- `ConsoleClientLike`（server.ts:1616）由 ConsoleClient + e2e FakeConsoleClient 实现。
- 工作区未提交改动中 admin.ts/server.ts 有并行 agent 改动，注意别碰区域。

## 改动清单
- [x] src/console.ts：health 加 channel 字段；recordFail 带通道；refresh 401/403 → oauth 失效，5xx/网络 → 不失效；新增 `authChannel(id)`
- [x] src/server.ts：ConsoleClientLike 加 authChannel；consoleCookieState 返回 oauth-invalid；billing invalid 路径区分；sendConsoleReadFailure 文案区分 OAuth；persistOauthAccount 补绑语义注释
- [x] src/admin.ts：detail-cookie 横幅加 OAuth 按钮 + oauth-invalid 文案；oauthError 补 not_found；i18n en/zh 加 oauthInvalid/oauthInstead/oauthNotFound；detail-oauth 事件绑定
- [x] test/console.test.ts：Bearer 全端点覆盖 + authChannel 失效测试（+6）
- [x] test/e2e.test.ts：FakeConsoleClient 加 authChannel；oauth-invalid → billing cookieState + 502 文案（+2）
- [x] 文档化：补绑语义（persistOauthAccount 幂等，server.ts 注释 + CURRENT.md 第二十四轮）

## 验证
- [x] npm run typecheck — 干净
- [x] npm test — 1195/1195 全绿
- [x] npm run build — 干净

## 完成（2026-08-13）
全部完成。未提交（工作区含并行 agent 改动）。遗留：真实上游 Bearer 接受度未实测（需活 OAuth 账号）。
