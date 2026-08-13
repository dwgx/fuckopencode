# 控制台全功能搬入设计（实现契约）

面向「把 OpenCode Console（console.opencode.ai）能展示、能编辑、能点击的功能
全部搬进自建 /__admin 管理面板」的落地设计。本文档是给实现 agent 的契约：
通道矩阵标注证据等级，接口给完整 JSON 示例，每个决策给理由与取舍。
代码基线：当前 main（多账号面板 + OAuth 已上线；测试数量见 README，不在此复制）。

总原则（沿用 MULTI-ACCOUNT.md）：

- 观测逻辑绝不阻塞代理链路；上游调用全部可降级、可缓存、有退避。
- 凭证明文只在进程内：cookie / key / token 加密落盘，绝不出现在任何响应与日志。
- 简单优先：能内存缓存就不落库；能常量就不建表；每个新概念要能回答
  「不加它有什么具体损失」。

---

## 0. 调研结论（证据等级标注）

来源：并行调研 agent 直读控制台源码仓库 `anomalyco/opencode`（dev 分支，
`packages/console/`，SolidStart SSR 应用，生产域 opencode.ai）+ solid-start
`packages/start/src/fns/{client,handler,shared,registration,server}.ts`
（控制台用 pkg.pr.new 预览构建 dfb2020，协议同源）。

| # | 事实 | 证据等级 |
|---|---|---|
| F1 | 控制台是 SolidStart，数据层全是 "use server" server functions；**没有** keys/billing/members 的 REST API | 确定（源码） |
| F2 | server function 鉴权 = `auth` cookie（h3 sealed session，httpOnly，365 天），**不认 Bearer token**；token 只走 /api/user、/api/orgs、/api/config | 确定（源码 context/auth.ts） |
| F3 | server function HTTP 形态：`POST {origin}/_server`，头 `X-Server-Id: <id>`（形如 `path#fn`）、`X-Server-Instance: server-fn:0`、`x-start-type`（0=seroval JSON 多参 / 1=单字符串 text/plain / 2=FormData）；响应 seroval 流 + `x-start-type: 0`；错误走 `X-Error` 头；未登录 302 到 /auth/authorize | 确定（solid-start 源码）；线上预览构建可能微调，spike 验证 |
| F4 | **X-Server-Id 是构建期生成的，不在源码明文**；`query(fn, "key.list")` 里的字符串只是客户端缓存键不是服务端 id | 确定（源码）；id 是否跨构建稳定 = 待验证（spike 抓两次对比） |
| F5 | /api/config（Bearer + 可选 x-org-id）返回 `{config: {provider: {<providerId>: {name, models: {<modelId>: Model}}}}}`；Model 含 cost（input/output/cache）、limit（context/output）、status、modalities 等完整字段。**能列出模型目录，但没有订阅/余额字段**；404 = 无远程配置（CLI 客户端语义） | 基本确定（CLI 消费方源码 opencode.ts + Config.Info schema）；服务端实现不在公开仓库，实际响应以 spike 为准 |
| F6 | billing.get server function 一次返回：余额、月限额、月用量、自动充值配置（开关/金额/触发阈值/错误）、订阅信息、支付方式 last4 —— **比 SSR 页面解析更全更稳** | 确定（源码 workspace/common.tsx:93 + billing.sql.ts） |
| F7 | 金额单位全程 micro-cents：1e8 = $1（与现有 UNITS_PER_DOLLAR 完全一致） | 确定（源码 + 社区实现） |
| F8 | key.create 生成 `sk-`+64 随机；响应带新 key 明文（控制台只在创建时展示一次）；key.list 对非本人 key 隐藏明文 | 确定（源码 key.ts:42）；create 响应是否含 key 原文待 spike 确认 |
| F9 | 充值 = checkoutUrl server function → Stripe Checkout URL（mode=payment，下限 $10），用户在自己浏览器完成支付，webhook 入账；**无余额直充 API** | 确定（源码 billing.ts:219） |
| F10 | 自动充值：`billing.setReload`（开关+金额+触发阈值）写库；`billing.reload` 用已存卡 off_session 立即扣款（重试失败扣款用） | 确定（源码 reload-section.tsx） |
| F11 | redeem 兑换码白名单（BUILDATHON=$500 等，按 email 一次） | 确定（源码 billing.ts:178） |
| F12 | usage.list 分页（50/页）、usage.costs 按月按日/模型聚合、payment.list 最近 100 条 + receipt URL | 确定（源码 usage-section / payment-section） |
| F13 | 模型开关：model.info 返回 `{all:[{id,name}], disabled:string[]}`（过滤 alpha-/claude-3-5-haiku/:global）；model.toggle 按模型开关 | 确定（源码 model-section.tsx） |
| F14 | /zen/v1/models 与 /zen/go/v1/models 是**推理网关路由**（无鉴权 200，global 目录，不区分账号） | 确定（源码 routes/zen/）+ 已有实测 |
| F15 | 角色门禁：admin 才能删他人 key / 开关模型 / 管理成员；非 admin 只列自己的 key | 确定（源码） |

---

## 1. 数据通道矩阵（功能 × 通道 × 可用性）

通道定义：

- **① Bearer**：OAuth device flow 的 access token（refresh_token 加密落库，按需
  refresh，进程内缓存）。只通 /api/user、/api/orgs、/api/config。
- **② Cookie SSR**：`auth` cookie 抓页面（现有 billing.ts，解析水合数据，只读）。
- **③ Server function**：`auth` cookie + X-Server-Id 调 /_server（读写全支持）。

| 控制台功能 | 通道 | 调研结论 | 面板落点 |
|---|---|---|---|
| 余额 / 月限额 / 月用量 | ③ billing.get（首选）；② billing 页 SSR（兜底，现有代码） | 确定（F6/F2）；X-Server-Id 待 spike | 账户详情·余额卡 + 趋势图 |
| 自动充值配置与错误 | ③ billing.get（读）+ setReload/reload（写） | 确定（F6/F10） | 账户详情·余额卡 |
| 订阅状态（Black/Lite） | ③ subscription.get / lite.subscription.get | 确定（源码）；Lite 细节待 spike | 账户详情·订阅卡（P2） |
| Keys 列表/创建/删除 | ③ key.list / key.create / key.remove | 确定（F8/F15） | 账户详情·Keys 子视图 |
| 模型列表（账号可用） | ③ model.info（disabled 列表）＋① /api/config（完整目录带 cost/limit） | 确定（F5/F13） | 账户详情·模型子视图 |
| 模型开关 | ③ model.toggle（admin） | 确定 | 账户详情·模型（P2） |
| 用量明细（分页） | ③ usage.list | 确定（F12） | 账户详情·用量子视图 |
| 用量聚合（按日/模型） | ③ usage.costs | 确定（F12） | 同上，图表 |
| 支付记录 + 收据 | ③ payment.list / receipt.download | 确定（F12） | 账户详情·支付记录（P2 展示） |
| 成员列表/邀请/移除 | ③ member.list / create / update / remove | 确定（F15） | 账户详情·成员子视图（P2） |
| 充值发起 | ③ checkoutUrl → Stripe Checkout URL | 确定（F9） | 账户详情·充值按钮（P2） |
| redeem 兑换码 | ③ billing.redeemCoupon | 确定（F11） | 账户详情·redeem 输入（P2） |
| 月限额设置 | ③ billing.setMonthlyLimit | 确定 | 账户详情·限额输入（P2） |
| 组织/workspace 列表 | ① /api/orgs | 确定（现有 OAuth 已用） | 账户详情·orgs 卡片（P3 多 ws） |
| 用户信息 | ① /api/user | 确定（现有） | 设置页 |
| 推理模型目录（global） | /zen/v1/models（sk key） | 确定（F14），**不区分账号** | 不做（已有网关 ALLOWED_MODELS） |

**关键结论（改变实现优先级的事实）**：

1. **③ 是唯一全功能通道，② 只是兜底**。billing.get 一次拿到 SSR 页面全部字段
   还多（自动充值/订阅/支付方式），且不依赖 HTML 结构。所以 billing.ts 的
   SSR 解析从「主通道」降级为「③ 不可用时的 fallback」，spike 优先级跟着降。
2. **① Bearer 与 ②③ Cookie 是两套体系，互不替代**：token 换不了 cookie，
   cookie 换不了 token。两条通道各自独立失效、各自降级。
3. **模型目录两个来源各有用处**：① /api/config 给完整目录（含 cost/limit，
   只要 refresh_token 有效就能拿，cookie 挂了也不影响）；③ model.info 给
   本 workspace 的 disabled 集合（「账号实际可用」）。合并展示。
4. **server function 的一切前提是 X-Server-Id 清单**（F4）。这是本设计的
   最大外部依赖，必须先 spike 抓到、固化成 fixture，并设计「控制台改版
   后 id 变了怎么办」的降级路径（§9 风险 2）。

---

## 2. 数据模型扩展

### 2.1 accounts 表：**不改结构**（两个新表就够）

评估过的选项与决策：

| 候选 | 决策 | 理由 |
|---|---|---|
| accounts 加 orgs 列 | 不做 | /api/orgs 变化极少，内存缓存 TTL 1h 足够；落库制造两份真相 |
| accounts 加 models 列 | 不做 | 模型目录放内存缓存（TTL 10min），重启重抓，无持久价值 |
| accounts 加 console 通道健康列 | 不做 | 通道健康是运行时态，放 ConsoleClient 内存（§2.3），与探针 status 分离 |
| 多 workspace（一 cookie 多 org） | P3 用「复制 cookie 建新账户行」实现，不加列 | 现有 accounts 行语义 =（用户, workspace）对，cookie 是用户级可直接复用；改表反而复杂 |

### 2.2 新表：balance_history + admin_audit

加进 `UsageDb.migrate()`（usagedb.ts:234-262 的 exec 里），沿用「无 CHECK、
小表不加索引」哲学。**两条表都要进现有 prune()**（balance_history 90 天 /
admin_audit 180 天，env 可配，默认值写在 §2.4）。

```sql
CREATE TABLE IF NOT EXISTS balance_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  at INTEGER NOT NULL,                -- 采集时刻（ms）
  balance_units INTEGER NOT NULL,     -- 整数 units，1e8 = $1（与现有口径一致）
  monthly_usage_units INTEGER,        -- 可空：SSR 兜底可能拿不到
  source TEXT NOT NULL DEFAULT 'fn'   -- fn=server function | ssr=页面解析
);
CREATE INDEX IF NOT EXISTS idx_balance_history_acct
  ON balance_history(account_id, at);

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  account_id INTEGER,                 -- 可空：非账户级操作
  action TEXT NOT NULL,               -- 'console.key.create' 等
  detail TEXT,                        -- JSON 字符串，脱敏（见 §6.3）
  ok INTEGER NOT NULL DEFAULT 1
);
```

写入时机：

- **balance_history**：每次 billing 抓取成功都插一行（定时轮询 + 手动刷新共用
  同一落点）。SSR 兜底抓到也插（source='ssr'）。用途：余额趋势图 + 「最近
  30 天余额变化」洞察。90 天保留：48 行/天/账户 × 5 账户 × 90 天 ≈ 2.2 万行，
  与 requests 同数量级，prune 机制现成。
- **admin_audit**：所有 console 写操作 + 手动 billing 刷新 + OAuth 登录成功
  各记一行（detail 存 action 专属脱敏字段，见 §6.3）。写操作失败也记（ok=0）。
  用途：花钱操作可追溯 + 面板「设置 → 审计日志」展示最近 50 条。

### 2.3 内存态（ConsoleClient）

新模块 `src/console.ts`（单例，main.ts 接线）：

```ts
interface ConsoleState {
  accessToken: { token: string; expiresAt: number } | null;   // ① Bearer 缓存，TTL 10min
  fnIds: Map<string, string>;                                 // 逻辑名 → X-Server-Id（fixture 加载）
  cache: Map<string, { at: number; data: unknown }>;          // 读缓存：`${accountId}:${fn}`
  health: Map<number, { lastError: string | null; staleAt: number | null; lastOkAt: number }>;
  writeCooldowns: Map<string, number>;                        // 写操作限流：`${accountId}:${action}` → until
}
```

- **读缓存 TTL**：billing 60s / keys 60s / members 120s / usage 60s / models 600s /
  payments 300s / orgs 3600s。面板 2s 轮询打的是缓存，上游调用频率 = 人类操作频率。
- **健康态**：每个账户记录 console 通道的 lastOkAt / lastError / staleAt，
  面板账户卡与详情页据此显示「控制台通道失效（cookie 过期）」横幅，
  与探针 status（key 健康）是两个独立维度。
- **写冷却**：按 `accountId:action` 的 token bucket，见 §6.2。

### 2.4 config.ts 新增（env 白名单照旧）

```ts
consoleFnIdsFile: string;    // env CONSOLE_FN_IDS，默认 'test/fixtures/server-fn-ids.json'（见 §8.1）
balanceHistoryRetentionDays: number;  // env BALANCE_HISTORY_RETENTION_DAYS，默认 90
auditRetentionDays: number;           // env AUDIT_RETENTION_DAYS，默认 180
consoleReadCacheMs: Record<string, number>;  // 不暴露 env，常量写在 console.ts
```

---

## 3. 上游调用层（src/console.ts，协议契约）

### 3.1 两条通道的凭据处理

**① Bearer**：进程内持有 access token（refresh grant 换得），缓存 10min；
401 时用存储的 oauth_refresh_enc 重新 refresh 再试一次（复用 oauth.ts 已实测
的 refresh grant 路径）；refresh 也失败 → 记健康态 error，标记 oauth 过期
（面板提示重新 OAuth 登录）。**access token 永不落库**；refresh 响应若带新
refresh_token 则回写落库（轮换处理，预留）。

**②③ Cookie**：解密 cookie_enc 后进程内使用，只发给 opencode.ai。302
（redirect 到 /auth/authorize，fetch 用 `redirect: 'manual'`）→ 判定 stale：
记健康态，后续该账户所有 console 读请求直接返回 stale 结果不重复打上游
（1h 内不再尝试，防雪崩）。

### 3.2 server function 调用契约

```ts
type ConsoleFnResult =
  | { ok: true; data: unknown }
  | { ok: true; stale: true }                 // cookie 失效（302）
  | { ok: false; reason: 'no-cookie' | 'no-fn-id' | 'upstream' | 'parse' | 'auth'; detail: string }
```

请求构造（全部 server function 用 POST）：

```
POST https://opencode.ai/_server
headers:
  X-Server-Id: <fnId>            // 形如 "path#fn"
  X-Server-Instance: server-fn:0
  x-start-type: "1"              // 单字符串参数（绝大多数查询，参数=workspaceId）
  content-type: text/plain
  cookie: auth=<cookie>
body: <参数原文字符串>
```

多参数/FormData 写操作：`x-start-type: "2"` + multipart form-data（Node ≥18
原生 FormData，零依赖满足）。响应处理：

- 200 + seroval 流 → 解析（§3.3）；
- 302 → `{ ok: true, stale: true }`；
- 2xx 但带 `X-Error` 头 → 失败（detail = 头值，截断 200）；
- 非 2xx → `reason: 'upstream'`（detail 只记状态码，绝不记响应体）。

超时：`AbortSignal.timeout(cfg.billingTimeoutMs)` 复用（默认 20s）。

### 3.3 seroval 解析器（新文件 src/seroval.ts，或并入 console.ts）

响应是 seroval 序列化流。seroval 对纯对象/数组/字符串/数字的输出与 JSON 兼容
（特殊类型才带 tag），**先写 spike 拿真实响应固化 fixture，再按 fixture 写解析器**：

- 步骤 1：`JSON.parse(body)` —— 若 spike 证实纯数据响应就是合法 JSON，
  解析器到此为止（预期大概率成立，seroval 的 tag 只出现在 Date/Map/undefined
  等类型上，我们的数据面全是 JSON 安全类型）。
- 步骤 2：若 fixture 显示有 tag 包装（如 `{"t":"...","v":...}`），写最小
  deserializer：识别 tag 名 → 展开（只支持我们数据里实际出现的类型，遇未知
  tag 返回 parse 失败并记日志 —— 宁可降级不猜）。
- 测试：fixture 驱动（§8.1），解析器改动必须回归全量 fixture。

### 3.4 函数 ID 清单（fixture 驱动，缺失即降级）

`test/fixtures/server-fn-ids.json`：

```json
{
  "captured_at": "2026-08-11",
  "billing.get": "workspace/common.tsx#getBilling",
  "key.list": "[id]/keys/key-section.tsx#listKeys",
  "key.create": "[id]/keys/key-section.tsx#createKey",
  "key.remove": "[id]/keys/key-section.tsx#removeKey",
  "member.list": "[id]/members/member-section.tsx#listMembers",
  "member.create": "[id]/members/member-section.tsx#inviteMember",
  "member.update": "[id]/members/member-section.tsx#updateMember",
  "member.remove": "[id]/members/member-section.tsx#removeMember",
  "usage.list": "[id]/usage/usage-section.tsx#listUsage",
  "usage.costs": "[id]/usage/graph-section.tsx#getCosts",
  "payment.list": "[id]/billing/payment-section.tsx#listPayments",
  "receipt.download": "[id]/billing/payment-section.tsx#downloadReceipt",
  "model.info": "[id]/model-section.tsx#getModelInfo",
  "model.toggle": "[id]/model-section.tsx#toggleModel",
  "billing.setMonthlyLimit": "[id]/billing/monthly-limit-section.tsx#setMonthlyLimit",
  "billing.redeemCoupon": "[id]/billing/redeem-section.tsx#redeemCoupon",
  "billing.setReload": "[id]/billing/reload-section.tsx#setReload",
  "billing.reload": "[id]/billing/reload-section.tsx#reloadNow",
  "checkoutUrl": "workspace/common.tsx#generateCheckoutUrl",
  "subscription.get": "[id]/billing/black-section.tsx#getSubscription"
}
```

**fixture 里的 id 是占位示例，不是结论** —— 真实 id 必须 spike 从浏览器
Network 面板抓（过滤 `_server` 看 X-Server-Id 头）。加载策略：

- 文件存在且能解析 → 用；某个逻辑名缺失 → 该函数降级（读接口返回
  `{ ok: false, reason: 'no-fn-id' }`，面板对应区块显示「控制台接口未就绪」，
  其他区块不受影响）。
- 文件缺失 → 全部 console 功能降级，启动日志一行 `[console] fn ids missing:
  console channel disabled`。**billing.ts 的 SSR 兜底照常工作**（② 通道与
  X-Server-Id 无关）。

### 3.5 /api/config 调用契约（① Bearer）

```
GET https://opencode.ai/api/config
headers: authorization: Bearer <accessToken>, x-org-id: <workspace_id>, accept: application/json
```

- 404 → `{ ok: true, data: null }`（无远程配置，F5，面板显示「无远程配置」）。
- 缓存 600s；解析出 `config.provider` 后拍平为 `{ <modelId>: { name, cost, limit, status } }`
  供面板使用。**所有值过 stripControl + 截断**，绝不直接进 HTML。

### 3.6 与 billing.ts 的关系（最小改动）

- billing.ts 的 SSR 抓取保持原样，作为 ③ 不可用时的兜底（现有 `refreshBilling`
  与调度器不动）。
- 新增 `consoleFetchBilling(cfg, accounts, console, id)`：优先 ③ billing.get；
  成功 → 走现有 `setBilling` 写账 + 插 balance_history；失败 → 回落现有
  `fetchAccountBilling`（SSR），插 balance_history（source='ssr'）。
- 手动刷新端点（/__admin/api/accounts/:id/billing）改为调 consoleFetchBilling。
- **两个通道写同一组列**（balance_units/monthly_limit/monthly_usage），
  不引入第二套余额字段。

---

## 4. API 契约（/__admin 扩展）

### 4.1 通用约定

- 全部沿用现有鉴权：isAdminRequest + 写操作 Origin 校验（server.ts 现有逻辑）。
- 错误形状沿用 `{ "error": { "message": "...", "type": "..." } }`；新增
  `type: 'upstream_error'`（502，上游调用失败，message = 分类原因）与
  `type: 'channel_error'`（502，通道未就绪：no-fn-id / no-cookie）。
- 读接口统一响应包装（新增字段不影响旧客户端）：

```json
{ "ok": true, "stale": false, "source": "fn", "data": { ... } }
```

  `stale: true` 时 `data` 为 null，面板据此显示「登录态失效，请更新 cookie」
  横幅（不弹窗、不打断轮询）。

- 路由前缀：`/__admin/api/accounts/:id/console/*`（读）与 `/__admin/api/accounts/:id/console-op/*`（写，语义上强调是操作，触发审计与冷却）。

### 4.2 读端点

#### GET /__admin/api/accounts/:id/console/billing

```json
{
  "ok": true,
  "stale": false,
  "source": "fn",
  "data": {
    "balance": 42.18,
    "monthlyLimit": 100.0,
    "monthlyUsage": 27.31,
    "monthlyPercent": 27.3,
    "autoReload": { "enabled": true, "amount": 20.0, "amountMin": 10.0, "trigger": 5.0, "triggerMin": 5.0, "lastError": null },
    "subscription": { "plan": "pro", "subscriptionId": "sub_xxx", "status": "active" },
    "paymentMethod": { "type": "card", "last4": "4242" },
    "timeUsageUpdated": 1782519000000
  }
}
```

- 来自 billing.get 全量字段（F6）；金额统一 `units/1e8` 两位小数；
  subscription 字段缺失（免费账号）时整个对象为 null。
- source='ssr' 时只有 balance/monthlyLimit/monthlyUsage 三个字段，其余 null。

#### GET /__admin/api/accounts/:id/console/keys

```json
{
  "ok": true,
  "stale": false,
  "source": "fn",
  "data": {
    "keys": [
      { "id": "key_123", "name": "prod", "display": "sk-…abcd", "timeUsed": 1782400000000, "email": "me@x.com", "mine": true }
    ]
  }
}
```

- **`key` 明文字段服务端剥掉，绝不进响应**（F8）。`display` 用 keyDisplay
  （控制台自带的掩码）。`mine` 派生自 email == 当前账户 owner（F15）。

#### GET /__admin/api/accounts/:id/console/members

```json
{ "ok": true, "stale": false, "source": "fn",
  "data": { "members": [ { "id": "u_1", "email": "a@x.com", "role": "admin", "limit": null } ],
            "actorRole": "admin" } }
```

#### GET /__admin/api/accounts/:id/console/usage?page=1

```json
{ "ok": true, "stale": false, "source": "fn",
  "data": { "page": 1, "pageSize": 50, "rows": [
    { "timeCreated": 1782400000000, "model": "deepseek-v4-flash", "provider": "opencode",
      "inputTokens": 1200, "outputTokens": 800, "reasoningTokens": 0,
      "cacheReadTokens": 0, "cacheWrite5mTokens": 0, "cacheWrite1hTokens": 0,
      "cost": 0.0123, "keyId": "key_1", "sessionId": "s_1", "plan": "sub" } ] } }
```

- cost 由 micro-cents 换算成美元（×1e-8）。前端分页翻页缓存失效（翻新页
  打上游一次，已翻过的页内存缓存）。

#### GET /__admin/api/accounts/:id/console/usage/costs?year=2026&month=8

```json
{ "ok": true, "stale": false, "source": "fn",
  "data": { "days": [ { "date": "2026-08-01", "cost": 1.23, "byModel": { "deepseek-v4-flash": 1.23 } } ],
            "keys": [ { "id": "key_1", "displayName": "prod", "deleted": false } ] } }
```

#### GET /__admin/api/accounts/:id/console/models

```json
{ "ok": true, "stale": false, "source": "fn",
  "data": { "models": [
    { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "disabled": false,
      "cost": { "input": 0.5, "output": 1.5 }, "limit": { "context": 200000 } } ] } }
```

- 合并两个来源：model.info 的 disabled 集合（③）+ /api/config 的目录与
  cost/limit（①）。③ 失效时 `source: "config"` 且所有 disabled=false；
  ①②③ 全挂 → 502 channel_error。

#### GET /__admin/api/accounts/:id/console/payments

```json
{ "ok": true, "stale": false, "source": "fn",
  "data": { "payments": [ { "id": "pay_1", "timeCreated": 1782400000000, "amount": 20.0,
             "type": "charge", "receiptUrl": "https://pay.stripe.com/receipts/xxx" } ] } }
```

#### GET /__admin/api/accounts/:id/console/orgs

```json
{ "ok": true, "stale": false, "source": "bearer",
  "data": { "orgs": [ { "id": "org_01KZPQ6GSTS0H24ARVQCD8ZNBM", "name": "dwgx" } ] } }
```

#### GET /__admin/api/accounts/:id/balance/history?days=30

```json
{ "ok": true, "data": [
  { "at": 1782400000000, "balance": 42.18, "monthlyUsage": 27.31, "source": "fn" },
  { "at": 1782401800000, "balance": 42.01, "monthlyUsage": 27.54, "source": "fn" }
] }
```

- 只读本地 balance_history 表，不打上游；days 上限 90。

### 4.3 写端点（console-op 前缀，全部审计 + 冷却）

> 请求体统一要求 `"confirm": true`（§6.2 定义哪些必须）。响应统一
> `{ "ok": true, "data": ... }` 或错误形状。

#### POST /__admin/api/accounts/:id/console-op/keys   ← P2

```json
// 请求
{ "name": "面板新建", "confirm": true }
// 201 响应 —— key 明文只出现这一次
{ "ok": true, "data": { "key": { "id": "key_2", "name": "面板新建", "keyPlain": "sk-<64 位>" } } }
```

- keyPlain 仅本次响应携带（F8 同款 UX）；前端展示一次 + 复制按钮，
  面板内不落任何本地缓存。审计 detail 记 `{name}` 不记 key 明文。

#### DELETE /__admin/api/accounts/:id/console-op/keys/:keyId

```
204（成功）/ 404（key 不存在）
```

#### POST /__admin/api/accounts/:id/console-op/limit   ← P2

```json
// 请求：limit 美元两位小数，0 = 取消限额
{ "limit": 50.0, "confirm": true }
// 200
{ "ok": true, "data": { "monthlyLimit": 50.0 } }
```

#### POST /__admin/api/accounts/:id/console-op/redeem   ← P2

```json
// 请求
{ "code": "BUILDATHON", "confirm": true }
// 200 —— 成功即入账，立即刷新 billing 缓存 + 插 balance_history
{ "ok": true, "data": { "credited": 500.0 } }
```

#### POST /__admin/api/accounts/:id/console-op/auto-reload   ← P2

```json
// 请求：enabled=false 时 amount/trigger 忽略
{ "enabled": true, "amount": 20.0, "trigger": 5.0, "confirm": true }
// 200
{ "ok": true, "data": { "enabled": true, "amount": 20.0, "trigger": 5.0 } }
```

#### POST /__admin/api/accounts/:id/console-op/reload-now   ← P3（真扣款）

```json
// 请求：立即用已存卡扣款（F10）。最重的确认档：confirm + 5min 冷却
{ "confirm": true }
// 200
{ "ok": true, "data": { "charged": 20.0 } }
```

#### POST /__admin/api/accounts/:id/console-op/checkout   ← P2（发起充值）

```json
// 请求：amount 美元，≥ 10；successUrl 可选，缺省指向控制台 billing 页
{ "amount": 20.0, "confirm": true, "successUrl": "https://<面板地址>/__admin#accounts" }
// 200 —— 前端 window.open 这个 URL，Stripe 托管页完成支付
{ "ok": true, "data": { "checkoutUrl": "https://checkout.stripe.com/c/pay/..." } }
```

- 面板侧 UI：确认对话框明示「将打开 Stripe 支付页，完成支付后余额入账」。
- successUrl 域名由面板前端传（不落库），服务端只透传。

#### POST /__admin/api/accounts/:id/console-op/models/:modelId/toggle   ← P2

```json
// 请求
{ "enabled": false, "confirm": true }
// 200
{ "ok": true, "data": { "modelId": "deepseek-v4-flash", "enabled": false } }
```

#### POST /__admin/api/accounts/:id/console-op/members   ← P2（邀请）

```json
{ "email": "b@x.com", "role": "member", "limit": 10.0, "confirm": true }
```

### 4.4 汇总路由表

| 方法与路径 | 鉴权 | 行为 |
|---|---|---|
| GET `/__admin/api/accounts/:id/console/billing` | isAdminRequest | 余额/限额/自动充值/订阅（fn 首选，ssr 兜底） |
| GET `…/console/keys` | 同上 | 远程 keys 列表（明文剥离） |
| GET `…/console/members` | 同上 | 成员列表 |
| GET `…/console/usage` | 同上 | 用量分页 |
| GET `…/console/usage/costs` | 同上 | 按日/模型聚合 |
| GET `…/console/models` | 同上 | 账号可用模型（合并两个来源） |
| GET `…/console/payments` | 同上 | 支付记录 |
| GET `…/console/orgs` | 同上 | orgs 列表（Bearer） |
| GET `…/balance/history` | 同上 | 本地余额时序 |
| POST `…/console-op/keys` / DELETE `…/console-op/keys/:id` | + Origin | 创建/删除远程 key |
| POST `…/console-op/limit` | 同上 | 设月限额 |
| POST `…/console-op/redeem` | 同上 | 兑换码 |
| POST `…/console-op/auto-reload` | 同上 | 自动充值配置 |
| POST `…/console-op/reload-now` | 同上 | 已存卡立即扣款（P3） |
| POST `…/console-op/checkout` | 同上 | 生成 Stripe 充值 URL |
| POST `…/console-op/models/:modelId/toggle` | 同上 | 模型开关 |
| POST `…/console-op/members` / PATCH / DELETE `…/console-op/members/:id` | 同上 | 成员管理（P2） |

`console-op` 写端点在服务端统一过：`confirm` 校验 → 冷却 → 执行 → 审计。
**审计失败不阻断操作**（审计是观测，写失败记日志）。

---

## 5. 前端面板结构 v3（src/admin.ts 扩展）

### 5.1 导航结构

现有：顶部 tab（总览/账号/用量/设置）+ 左侧 sidebar。v3 的容量方案：

- **顶部 tab 不变**。新增内容全在「账号」tab 内部展开，避免导航层膨胀。
- **账号 tab**：默认账户卡列表（现状保留）；点卡片进入**账户详情**（面包屑
  「账号 / dwgx1337@outlook.com」+ 返回按钮），详情内顶部一行子导航：
  `余额 | Keys | 用量 | 成员 | 模型`（复用现有 tab 样式令牌）。
- **sidebar**：账号 tab 下 sidebar 列出账户名（快捷切换，点击直达该账户详情
  对应子视图），详情子导航在 main 区。窄屏时 sidebar 收起（现有 ≤48rem 横滚
  模式沿用）。
- **用量 tab**（本地代理流量）与**账户详情·用量**（上游用量）并存，标题旁
  各自标注「本地」/「上游」，概念不合并 —— 两个数据源本来就是两个问题。
- **设置 tab** 新增两块：控制台通道健康（每账户 fn/stale/最后成功时刻）+ 审计
  日志最近 50 条。

### 5.2 账户详情子视图

| 子视图 | 内容 | 数据 |
|---|---|---|
| 余额 | 大数字余额 + 月限额进度条（现有样式）+ **余额趋势图**（§5.3）+ 自动充值卡片（开关/金额/触发阈值/最近错误）+ 订阅卡 + 支付方式 last4 + 充值按钮 + redeem 输入 + 手动刷新 | console/billing + balance/history |
| Keys | 双列表：本地池 keys（现有 keyRow，健康度）+ 远程 keys（名称/掩码/最后使用/归属）+ 创建按钮（弹层输名字，成功显示一次明文 + 复制）| console/keys |
| 用量 | 月度聚合柱状图 + 分页明细表（每行：时间/模型/输入/输出/成本/plan）| usage/costs + usage/list |
| 成员 | 成员表（邮箱/角色/限额）+ 邀请表单（P2）| console/members |
| 模型 | 模型表（id/名称/上下文/成本/状态）+ 每行开关（P2，admin）| console/models |

### 5.3 余额趋势图（零依赖）

- 数据：balance/history（§4.2）。SVG polyline 手绘（现有面板全是手绘
  DOM/SVG，无 canvas 先例，polyline 与现有风格一致）：视口 100%×120px，
  归一化到 [min,max]，点间距均分；最多画 30 天（超了取末 30 天）。
- 折线末端 hover 显示最近余额 + 更新时间（title 属性即可，不引入 tooltip
  框架）。历史缺失（新账户）显示「暂无历史，首次抓取后生成」。
- 与所有图表类展示一致：不自动缩放太激进（min 取 0 与真实 min 之较小语义：
  余额趋势看的是「跌了多少」，基线 0 更有直觉 —— 决策：基线取
  `min(0, dataMin)`，余额恒 ≥0 所以就是 0 基线）。

### 5.4 iframe 评估（结论：**不嵌**）

用户原话「可以包装复用他们的控件」的落地方式评估：

| 方案 | 评估 |
|---|---|
| iframe 嵌 console.opencode.ai/workspace/{id}/billing | **否决**。① 登录态：iframe 内是用户浏览器，控制台要求自己的 auth cookie —— 用户必须在该浏览器额外登录一次控制台，且我们面板的账户 cookie 存在服务端、无法注入 iframe（httpOnly sealed session，JS 改不了）；② 可嵌入性未知：控制台很可能设 X-Frame-Options/CSP frame-ancestors（spike 可测，但即便可嵌，登录态问题无解）；③ 一个 iframe 只能看一个账号，面板的多账号聚合价值为零；④ 无法换肤、无法控制事件。 |
| 自建组件「复刻」交互模式 | **采纳**。复用的是控制台的**交互语义**（reload 开关、金额+触发阈值输入、redeem 输入框、Stripe 跳转充值、key 创建后显示一次），数据从 server function 拿，UI 用现有设计令牌自绘。 |
| 中间态：iframe + 服务端代理页面 | 否决。等于再造一个控制台，双重维护，收益为零。 |

一句话：**数据搬过来（server function），控件只搬交互语义（自绘），
不搬 DOM（iframe）。**

---

## 6. 安全

### 6.1 存储（现状已覆盖，无新增）

- cookie / refresh_token / key 已 AES-256-GCM 加密落库，明文只在进程内。
- 新增：**无任何新明文落库**。balance_history 只存数值；admin_audit 只存
  脱敏 detail；access token 只活内存。

### 6.2 上游调用频率限制（服务端，防滥用 + 防触发上游风控）

- **读缓存先行**：所有 console 读端点先查内存缓存（§2.3 TTL），命中不打
  上游。面板 2s 轮询的并发 = 0 上游调用。
- **手动刷新令牌桶**：每账户读操作 1 次/5s、全局 10 次/10s（绕过缓存的手动
  刷新也走桶）。超限 → 429 现有错误形状，message 带「try again shortly」。
- **写冷却**：非金钱写操作 1 次/10s/账户；checkout 与 redeem 1 次/60s/账户；
  **reload-now（真扣款）1 次/5min/账户**。冷却存 ConsoleState.writeCooldowns
  （内存，重启清零 —— 攻防上可接受：冷却防的是误操作与脚本，不是持久攻击，
  持久攻击由鉴权 + 审计兜底）。
- 上游失败退避沿用 billing 的阶梯模式（15→30→60→120min），stale 判定后
  1h 内不再打该账户（§3.1）。

### 6.3 审计（admin_audit）

| action | detail 内容 | 脱敏 |
|---|---|---|
| console.key.create | `{name}` | 不记 key 明文 |
| console.key.remove | `{keyId}` | — |
| console.limit.set | `{limit}` | — |
| console.redeem | `{codeLen, codeHash8}` | 不记 code 原文 |
| console.autoReload.set | `{enabled, amount, trigger}` | — |
| console.reloadNow | `{amount}` | — |
| console.checkout | `{amount}` | — |
| console.model.toggle | `{modelId, enabled}` | — |
| console.member.invite/update/remove | `{email, role}` | — |
| billing.manualRefresh | `{ok, source}` | — |
| oauth.login | `{email, workspaceId}` | — |

detail 统一 `JSON.stringify` 落 TEXT 列，面板渲染前 stripControl + 截断 200。

### 6.4 花钱操作的双重确认（UI + 服务端双层）

| 操作 | UI 确认 | 服务端强制 | 冷却 |
|---|---|---|---|
| checkout（发起充值） | 弹层显示金额 + 「将打开 Stripe」 | `confirm:true` 必填，否则 400 | 60s |
| redeem | 弹层显示 code + 「成功立即入账」 | `confirm:true` | 60s |
| auto-reload 开启 | 弹层显示金额/阈值 + 「低于阈值将自动扣款」 | `confirm:true` | 10s |
| reload-now | 红弹层「立即从已存卡扣款，不可撤销」+ 输入确认词 | `confirm:true` + 5min 冷却 | 5min |
| limit / key / member / model | 普通确认对话框 | 无（可逆、不花钱） | 10s |

服务端校验 `confirm === true` 只是第一道；真正防「点了就扣钱」的是冷却 +
审计 + Stripe 侧的可撤销性（reload-now 走 Stripe 扣款记录可查）。**设计上不
做「输入金额 + 输入确认词」这种更强的拦截** —— 面板的使用者是管理员本人，
双确认的核心价值是防误触与留痕，不是防持证攻击者（持证者绕不过鉴权层，
但面板外还有盾与 SSH 隧道）。

### 6.5 面板展示红线（延续既有口径）

- key 明文只在创建响应出现一次（§4.3），绝不进缓存/列表/审计/日志。
- cookie / refresh_token / access token 绝不出现在任何响应。
- 上游错误原文过 stripControl + 截断 200（现有 statusDetail 口径沿用）。
- e2e 增加扫描断言：/__admin 全部响应（含 console 端点）无 `sk-` 与
  cookie 原文（沿用 test/e2e.test.ts:606-637 的扫法）。

---

## 7. 分期与验收标准

### P1：只读展示（console 读端点 + 面板详情页）

范围：console.ts（Bearer + fn 双通道 + seroval 解析 + 缓存/健康态）、
balance_history 落账、billing 主通道切换（fn 首选 SSR 兜底）、读端点 9 个、
账户详情页（余额/Keys/用量/模型 + 趋势图）、设置页通道健康。

验收：

- [ ] spike fixture 就绪：server-fn-ids.json 全清单 + 至少 billing.get /
      key.list / usage.list / model.info / member.list 五个真实响应 fixture
- [ ] 真实 cookie 下 9 个读端点全部返回预期 JSON（本地实测，与 console 页面
      数值一致，误差 ≤ 1 cent）
- [ ] cookie 过期时：stale=true 正确返回、1h 不再打上游、面板横幅出现、
      SSR 兜底余额仍在更新（balance_history 有 ssr 行）
- [ ] 模型合并逻辑：/api/config 404（无远程配置）与 fn 失效分别有正确降级
- [ ] 余额趋势图渲染正确（空历史 / 单点 / 30 天满），375px 无横向溢出
- [ ] 轮询 5 分钟：上游 _server 调用次数 = 手动刷新次数（缓存生效证明）
- [ ] e2e 扫描无 sk-/cookie 明文；`npm run typecheck` + `npm test` 全绿
- [ ] billing.ts 现有 41 条测试不回归（SSR 兜底路径行为不变）

### P2：受控写操作

范围：console-op 写端点（key 创建/删除、限额、redeem、auto-reload、checkout、
model.toggle、members）+ 审计表 + 写冷却 + UI 双确认 + 设置页审计日志。

验收：

- [ ] 每个写端点：confirm 缺失 → 400；成功 → audit 行（ok=1）；上游失败 →
      502 upstream_error + audit 行（ok=0）
- [ ] 冷却生效：同账户连续操作按表拒绝（429）
- [ ] key 创建全流程：面板出现一次明文 + 复制按钮，刷新后列表只剩掩码，
      e2e 扫描无明文残留
- [ ] checkout 全流程：生成 Stripe URL → 浏览器打开 → 完成支付 → 手动刷新
      余额入账（本地实测一次小额）
- [ ] redeem 用真 code 成功入账一次（或用户决定不测真钱，用 mock 断言调用
      构造正确）
- [ ] model.toggle 生效后 model.info 的 disabled 集合变化可见

### P3：增强

范围：reload-now（真扣款，最重确认）、订阅详情（Black/Lite 两个
subscription.get）、支付记录/收据展示、多 workspace（/api/orgs 列表 →
「复制 cookie 绑定第二个 workspace」创建流程）、余额低于阈值的面板内提醒
（消费 balance_history）。

验收（各功能对应 P1/P2 同类标准 + 用户验收）。

---

## 8. 实现顺序与测试

### 8.1 前置 spike（上线前必做，同 M3 的纪律）

1. **抓 X-Server-Id 清单**：用户浏览器登录 console.opencode.ai，打开
   billing / keys / usage / members / models 五个页面，DevTools Network
   过滤 `_server`，记录每个请求的 `X-Server-Id` 头 → 填进
   `test/fixtures/server-fn-ids.json`。
2. **抓真实响应 fixture**：同样五类页面各存一次响应体（纯数据、无敏感
   内容？—— 注意：usage.list 响应含 keyId/sessionId，keys 响应含明文 key
   **不能入库**，fixture 里手动掩码后固化），确认 seroval 是否可直接
   JSON.parse。billing.get 响应可以完整固化（金额非敏感）。
3. **验证 id 稳定性**：过一天/跨控制台部署后抽查一个 id 是否变化，评估
   §9 风险 2 的真实频率。
4. 若用户愿意，顺带把 billing SSR 页 fixture 抓了（M3 遗留，billing.ts
   两条正则可顺带核对 —— 现在它是兜底通道，优先级降了但迟早要补）。

### 8.2 模块文件划分

| 文件 | 职责 |
|---|---|
| `src/console.ts`（新） | ConsoleClient：Bearer refresh + /api/config 拉取、server function 调用、seroval 解析接线、读缓存、健康态、写冷却 |
| `src/seroval.ts`（新，或并入 console.ts） | 最小 seroval 响应解析（fixture 驱动） |
| `src/usagedb.ts` | balance_history + admin_audit DDL、insertBalanceHistory / recentBalanceHistory / insertAudit / recentAudit、prune 扩展 |
| `src/billing.ts` | 加 consoleFetchBilling（fn 首选）与 balance_history 落点 |
| `src/admin.ts` | 读/写端点 handler + 账户详情页 + 趋势图 + 审计视图 |
| `src/server.ts` | 新路由接线（console 前缀） |
| `src/config.ts` | §2.4 三个字段 |
| `src/main.ts` | ConsoleClient 构造接线 + 启动日志 `[console] fn ids: 20/20` |

### 8.3 测试

- `test/seroval.test.ts`：fixture 驱动，垃圾输入、未知 tag 降级
- `test/console.test.ts`：fn 调用构造（头/体/302→stale/X-Error）、Bearer
  refresh 与 401 重试、缓存 TTL 与失效、健康态、写冷却
- `test/usagedb.test.ts` 扩：两个新表 CRUD + prune 只删新表不动 accounts
- `test/billing.test.ts` 扩：consoleFetchBilling 首选/兜底切换 + balance_history 落账
- `test/admin.test.ts` 扩：全部新端点（含 confirm 缺失 400、冷却 429、
  明文剥离断言、stale 包装）
- `test/dashboard.test.ts` 扩：ADMIN_HTML 内联 JS 继续过 new Function() 解析
- `test/e2e.test.ts` 扩：console 端点端到端（fake upstream） + 明文扫描

### 8.4 实现顺序

1. spike 拿 fixture → 2. usagedb 新表 + 测试 → 3. console.ts（Bearer 通道 +
   /api/config）+ 测试 → 4. seroval 解析 + 测试 → 5. fn 通道 + 缓存/健康 + 测试 →
   6. billing 主通道切换 + 测试 → 7. 读端点 + admin 详情页 → 8. P2 写端点 +
   审计 + 冷却 + UI 确认 → 9. typecheck + build + 全量测试 + 本地假上游实机验证。

---

## 9. 风险清单

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| 1 | **X-Server-Id 跨构建漂移**（控制台发版改代码路径/函数名 → id 变） | 中（发版频繁） | 对应功能静默失效 | fixture 集中管理 + 缺失即降级（§3.4）+ 启动日志报 `fn ids: n/20` 一眼可见 + 设置页显示捕获时间；spike 评估真实频率后决定是否加「从 bundle 自动提取 id」的脚本（P3 可选） |
| 2 | **server function 协议变更**（solid-start 升级、header 名/响应格式改） | 低 | 全部 fn 功能失效 | 调用全收敛在 console.ts 一处；seroval fixture 回归测试；降级链完整（billing 有 SSR 兜底） |
| 3 | **auth cookie 过期/被吊销**（365 天 + 改密/风控） | 中 | console 通道读不到数据 | stale 检测（302）+ 1h 退避 + 面板横幅引导更新 cookie（现有 edit 表单已支持） |
| 4 | **sealed session 格式变更**（ZEN_SESSION_SECRET 轮换） | 低 | 全量 cookie 失效 | 同 #3，面板可见批量 stale |
| 5 | **billing SSR 页面结构变更**（Next.js 改版） | 中 | 兜底通道失效 | 已降级为兜底（fn 主通道）；fixture + 退避 + 面板「余额未知」而非报错 |
| 6 | **上游反爬/风控**（/_server 频率限制、封 cookie） | 中 | 账号级封禁（严重） | 缓存先行 + 令牌桶 + 失败退避（§6.2）—— 频率设计成「人类操作频率」而非脚本频率；不做并发抓取（串行）；文档明示这是自用观测 + 受控操作，频率远低于人工使用 |
| 7 | **ToS 合规**：程序化调 server function | 低 | 账号风控 | 只读为主、频率克制、不绕过任何登录（用本人 cookie）、不批量创建资源；P2 写操作全部等价于控制台 UI 能做的手工操作 |
| 8 | **usage.list 分页深翻**（多页循环打上游） | 低 | 上游压力 | 翻页缓存（§4.2）+ 每账户读桶 |
| 9 | **oauth refresh 失效**（refresh_token 过期/撤销） | 低 | /api/config 与 orgs 失效 | 健康态标记 + 面板提示重新 OAuth；cookie 通道不受影响 |
| 10 | **key.list 响应含他人 key 明文**（管理员的 workspace 有他人 key 时） | 中 | 明文泄露面 | 服务端强制剥离 `key` 字段（§4.2），只透传掩码 display；e2e 扫描兜底 |

---

## 10. 明确不做的

- **不嵌 iframe**（§5.4）；不复刻控制台的聊天/会话等非账户管理功能（本次
  范围 = 账户级数据面：billing/keys/usage/members/models）。
- **不建 keys/members/models 的本地表** —— 都是上游状态，读时拉取 +
  内存缓存，落库制造两份真相。
- **不做 balance_history 的采样压缩/合并**（90 天 × 48 行/天 ≈ 2 万行，
  SQLite 无压力）。
- **不做多 workspace 的表结构扩展**（P3 用现有账户行 + cookie 复用实现）。
- **不做 key 同步**（远程 keys 与本地 pool keys 是两个概念：远程是控制台
  的 key 档案，本地是网关实际在用的 key。面板分两列表，不自动同步 ——
  删远程 key 不会动本地池，反之亦然；探针会在本地 key 失效时自然降级）。
- **不加任何 npm 依赖**：FormData（Node ≥18 原生）、AbortSignal.timeout、
  node:crypto、node:sqlite 全部够用。
