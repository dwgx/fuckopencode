# Console P0 数据端点契约（第十轮追加，2026-08-12）

给面板（admin.ts）接线用的端点契约。路由在 `src/server.ts` 的
`/__admin/api/console/account/:id/...`（已实现、已测试），数据层在
`src/console.ts` 的 `ConsoleClient`（5 个新方法）。

**证据等级**：除注明「推断」外，全部来自线上真实实测 —— ① 远端网关已存 cookie
直接 curl console.opencode.ai（33 端点全 200 那次采集的同一通道）；② console
前端 bundle（index-*.js）里抽出的 schema 源码（字段名/枚举/正则逐字核对）。

## 通用约定

- 读端点全部过 `isAdminRequest`；GET 不做 Origin 校验（与既有 console 端点一致）。
- 成功统一 `{ok:true, data:...}`；失败 `{error:{message,type}}`：
  `400 invalid_request_error`（参数）/ `404`（账户不存在）/ `502 channel_error`
  （cookie 失效或通道未接线）/ `502 upstream_error`（上游非 auth 失败）。
- **金额全是 microCents 字符串**（1e8 = $1），与既有 usage summary / billing
  同口径 —— 面板用现有 `money()`（admin.ts 里 1e8 换算）显示，服务端不换算。
- 列表分页字段：`pageInfo` 恒为 `{page, pageSize, total, pageCount}`（实测）。
- range 参数：只认 `24h` / `Nd`（1-90），缺省 `7d`。**ConsoleClient 会把天数
  就近取档成上游只认的三档 `24h|7d|30d`**（1→24h，2-7→7d，8-30→30d；
  31-90 也压成 30d —— 上游实测 60d/90d/365d 全 400）。面板按钮档位 24h/7d 直接可用。

## 端点清单

### 1. GET .../usage/cost-by-day?range=7d&bucket=day

按日/小时成本时间序列（**趋势图数据**）。bucket 只认 `day|hour`（缺省 day，
非法 400）。

```
{ok:true, data:{items:[DailyCost]}}
DailyCost（实测 schema "DailyCost"）：{
  date: string,                      // "2026-08-11"（YYYY-MM-DD，推断为本地/UTC 日期）
  totalCostMicroCents: string,       // microCents 字符串
  totalTokens: string,
  totalRequests: string,
}
```

**面板接线捷径**：既有 `/usage?range=Nd` 端点已并行调 cost-by-day，`data.byDay`
从恒 null 变成 `DailyCost[]`（子通道失败时回 null、不拖垮 summary）——
admin.ts 里现成的 `renderUsageDetail` 的 `data.byDay` 渲染直接生效，无需改面板。
新面板趋势图也可以单独打这个端点拿原始数组。

### 2. GET .../usage/models?range=7d

按模型拆分（含 pageInfo）。

```
{ok:true, data:{items:[ModelSummary], pageInfo}}
ModelSummary（实测 schema "ModelSummary"）：{
  model: string,                       // 模型 id，如 "deepseek-v4-flash"
  provider: string,                    // 供应商 id
  totalRequests: string,
  totalInputTokens: string,
  totalOutputTokens: string,
  totalCacheReadTokens: string,
  totalCacheWrite5mTokens: string,
  totalCacheWrite1hTokens: string,
  totalCostMicroCents: string,
}
```

### 3. GET .../usage/users?range=7d

按用户拆分（含 pageInfo）。

```
{ok:true, data:{items:[UserUsageSummary], pageInfo}}
UserUsageSummary（实测 schema "UserUsageSummary"）：{
  userId: string,
  principalType: string,               // 枚举值未实测（推断 member/service_account）
  serviceUserId: string | null,        // 服务账号场景才有（推断）
  email: string | null,
  name: string | null,
  totalRequests: string,
  totalInputTokens: string,
  totalOutputTokens: string,
  totalCacheReadTokens: string,
  totalCacheWrite5mTokens: string,
  totalCacheWrite1hTokens: string,
  totalCostMicroCents: string,
  lastActiveAt: string | null,         // ISO 时间
}
```

### 4. GET .../budgets/users-status

用户预算状态（**exceeded 即额度用尽预警**）。上游返回**裸数组**（非 {items}），
服务端包成 {items}。无预算的用户也有一条（limitMicroCents=null）。

```
{ok:true, data:{items:[UserBudgetStatusWithUser]}}
UserBudgetStatusWithUser（实测 schema "UserBudgetStatusWithUser"）：{
  scope: "user",
  userId: string,
  email: string | null,
  limitMicroCents: string | null,      // 未设预算 → null
  spentMicroCents: string,             // microCents 字符串
  exceeded: boolean,                   // 是否超限（面板可做红色徽标）
  resetsAt: string | null,             // ISO，如 "2026-09-01T00:00:00.000Z"（重置时刻）
  source: "custom" | "default" | null, // 预算来源；null = 未设
  updatedAt: string | null,            // ISO
}
```

### 5. GET .../models-pricing

AI SDK 格式模型定价表（模型下拉定价、capabilities 展示）。实测 61 模型约
20KB；**ConsoleClient 侧 10 分钟长缓存**（MODEL_PRICING_TTL_MS），面板随便轮询。

```
{ok:true, data:{providers:{<providerId>:{...}}}}
provider 结构（实测，opencode 单供应商）：{
  name: string,                        // "Personal (OpenCode)"
  env: string[],                       // 环境变量名清单
  api: {type, package, url, settings}  // SDK 接线信息
  request: {headers}                   // 含 x-org-id
  models: {<modelId>: ModelInfo}       // 61 个
}
ModelInfo：{
  family: string,
  name: string,
  capabilities: {tools: boolean, input: string[], output: string[]},
  cost: [{input: number, output: number, cache: {read: number, write: number}}],  // 每百万 token 美元
  limit: {context: number, input?: number, output: number},                       // token 数
}
```

## 已修的面板侧既有问题（不用再动 admin.ts）

面板 usage 详情的 range 按钮是 `24h`/`7d`，但旧 `/usage` 端点的 range 校验只认
`Nd` —— **24h 一直 400**。本轮把解析器换成共享版（接受 24h），现有面板按钮直接
生效。e2e 有测试钉住（`usage?range=24h` → 200）。

## 未实测字段（别过度依赖）

两个账户的用量窗口都是 0，usage models/users/cost-by-day 的**条目**形状来自
前端 bundle 的 schema 声明（字段名逐字核对），不是真实条目；日期字段格式
（date 是 YYYY-MM-DD）与 principalType 枚举是推断。字段名错配的风险很低，
但面板渲染要带兜底（字段缺失显示 '—'，admin.ts 现有渲染已有这个习惯）。
