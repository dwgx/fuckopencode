# 密钥-模型授权（Key-Model Authorization）设计文档

> 面向 windsurf 参考实现的「模型白名单 + 密钥授权」逻辑，语义对齐：
> `windsurf/src/dashboard/model-access.js`（全局 allowlist/blocklist + defaultModel）、
> `windsurf/src/auth.js isModelAllowedForAccount`（账号层过滤）、
> `windsurf/src/handlers/chat.js:2824-2849`（模型门 403 + fallback）、
> `windsurf/src/dashboard/index.html:7430-7543`（模型 tab 的 chip 编辑 UI）。
> 本网关侧语义取舍见 §3。

## 0. 需求拆解

1. **核心**：管理「哪一个密钥可以生成哪一个模型」——密钥→模型授权矩阵。
2. **两类密钥都要可配**：
   - 上游 key：`OPENSEA_KEYS` / `ANTHROPIC_API_KEY` / 账户 keys（keypool 池里的，打上游用）。
   - 客户端接入 key：分发 token（tokens 表）+ `API_KEYS`（客户端调网关用）。
3. **授权语义**：全局模型白名单（默认集）+ 某密钥配了自定义授权就用自定义（覆盖全局），
   没配的用全局。

## 1. 现状与证据（已确认事实）

模型门现状（两条路径共用前置链，见 `ARCHITECTURE.md` §两条独立路径）：

- 硬底线 = 代码常量 `ALLOWED_MODELS`（`src/deepseek.ts:37-40`，仅 flash/free 两个）。
  `resolveModel`（`src/deepseek.ts:93-120`）做别名映射 + 白名单门 + 目录门（fail-open），
  白名单外明确返回 `not-allowed`。
- 全局门 `checkModelGate`（`src/server.ts:1687-1704`）：白名单/目录外统一 400
  `sendModelNotAllowed`（`src/server.ts:1670-1678`），message 列出 `ALLOWED_MODELS`。
  两个 handler 都调它：chat `src/server.ts:2551`、messages `src/server.ts:2894`。
  池空时跳过（503 优先，`src/server.ts:1694-1697`）。
- 账号级过滤：`accounts.allowedModelsOf`（`src/accounts.ts:443-449`，缓存懒加载），
  PATCH 时同步缓存（`src/accounts.ts:456-466`、`update` `src/accounts.ts:269-281`）。
  消费点在选号闭包 `eligible`（`src/upstream.ts:105-111`）：
  `allowed != null && allowed.length > 0 && !allowed.includes(model) → false`。
  全被滤掉抛 `ModelNotAllowedError`（`src/keypool.ts:152-159`）→ 400
  （`src/server.ts:2583-2586` / `2994-2996` / 重试路径 `2650-2653`）。
- 选号：`KeyPool.acquire(excludeKey?, isEligible?, model)`（`src/keypool.ts:414-444`），
  `isEligible` 目前只收 `accountId`（`src/keypool.ts:422`）。
  转发入口 `postUpstreamChat`（`src/upstream.ts:84-208`），
  `UpstreamCallOptions.allowedModelsOf`（`src/upstream.ts:69`）注入账号白名单。
- 客户端鉴权：`verifyAuth`（`src/security/auth.ts:82-115`）返回 `AuthResult`
  （`src/security/auth.ts:4-6`）。**API key 命中时 `keyId` 是 `randomUUID()` 随机值**
  （`src/security/auth.ts:96`），每请求不同、不是稳定身份——这是本次必须改的点。
  分发 token 命中时 `tokenFp` 是稳定指纹（`src/security/auth.ts:101`）。
  数据面分派 `src/server.ts:2341-2366`：`auth.keyId` 进 handler（只用于注入检测日志）、
  `ctx.tokenFp = auth.tokenFp`（`src/server.ts:2346`）。
- 请求记账：`finally` 统一 `recordRequest`（`src/server.ts:2405-2467`），
  字段见 `src/usagedb.ts:533-544`；`token_fp` 已有列，**API key 身份无列**。
  模型拒绝已记 `ctx.error`（`src/server.ts:1701`）→ 落 `requests.error`。
- 管理面鉴权：`isAdminRequest`（`src/server.ts:285-289`）；读端点也过 Origin
  （`adminOriginAllowed` `src/server.ts:3258-3275`，财务/配置级读防跨站）。
- 设置热配置：`SETTINGS_META`（`src/settings.ts:114-123`）+ `applySettingsToConfig`
  （`src/settings.ts:157-166`），env 是默认、settings 覆盖、运行时不重启生效。
- 面板：tab 栏 `src/admin.ts:1578-1582`，内联 JS 解析防线 `test/admin.test.ts:26-40`
  （`new Function(inlineScript())` 不抛）、i18n 中英键集合一致、反引号/`${}` 检查。
  账号详情已有 chip 白名单编辑器（`src/admin.ts:4493-4552`，PATCH accounts/:id），
  可复用作密钥级编辑交互。

## 2. 数据模型

### 2.1 新增表 `model_access`（usagedb.ts `migrate()` DDL 里加）

```
CREATE TABLE IF NOT EXISTS model_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL,   -- 'token' | 'api-key' | 'upstream-key'
  subject_id   TEXT NOT NULL,   -- 见 2.2
  models       TEXT NOT NULL,   -- JSON 数组，非空（行存在 = 已配置自定义授权）
  updated_at   INTEGER NOT NULL,
  UNIQUE(subject_type, subject_id)
);
```

- **行存在 = 该密钥配了自定义授权；删行 = 清除自定义、回退全局**（与
  `accounts.allowed_models` 的「null = 用全局」同一语义，`src/usagedb.ts:604`）。
- 小表、UNIQUE 即查询键，不建多余索引（与 `model_aliases` 同哲学，`src/usagedb.ts:578-585`）。
- 降级哲学与 modelmap 一致（`src/modelmap.ts:22-38`）：db 不可用返回空/失败，绝不抛。

### 2.2 subject 身份（稳定、不泄明文）

| subject_type | subject_id | 生成方式 | 证据 |
|---|---|---|---|
| `token` | `tokens.fingerprint`（sha256 前 24 hex） | 已存在且 UNIQUE | `src/tokens.ts:100-102`、`src/usagedb.ts:625` |
| `api-key` | `sha256(apiKey)` 全 hex（64） | 运行时对 `cfg.apiKeys` 逐个算 | 面板掩码格式同 settings 的 `****XXXX`（`src/settings.ts:99`） |
| `upstream-key` | `sha256(upstreamKey)` 全 hex（64） | 池 key 原文不出进程、不落库 | 账户 key 明文只在进程内（`src/accounts.ts:8-12`） |

选择理由：token 已用指纹做校验/聚合键，直接复用；API key / 上游 key 没有现成稳定 id，
用 sha256 既不泄明文（上游 key 绝不能明文落库，账户 keys 是加密整体），又能跨配置数组
（key 不变则身份不变）稳定匹配。

### 2.3 全局默认白名单（新）：settings 热配置 `allowedModels`

- 存在 `settings` 表（`src/usagedb.ts:611-615`），加入 `SETTINGS_META`：
  `allowedModels: { default: [...ALLOWED_MODELS], validate: allowedModelsMeta }`。
  值 = JSON 数组（null/空数组 = 清键回代码默认）。**实现收紧（审查 MAJOR-1 同步）**：
  校验层（allowedModelsMeta）对**硬底线外的模型直接拒绝**（400），对**空数组归一为
  null**（= 清键回默认，绝不产生「全锁」的空集合）——与专用端点 handlePutModelAccessGlobal
  语义一致，通用 settings PATCH 与专用端点共用同一校验，无分叉。
- `applySettingsToConfig`（`src/settings.ts:157-166`）加一行：命中时设置
  `cfg.globalAllowedModels: ReadonlySet<string>`（AppConfig 新字段），默认 = `ALLOWED_MODELS`。
- 启动合并、运行时 PATCH 走 settings 既有机制，无需新装配（`src/main.ts` 已 apply，
  见 settings.ts 文件头哲学 `src/settings.ts:4`）。
- **硬底线不变**：`ALLOWED_MODELS` 代码常量仍是绝对上限（`checkModelGate` 原样跑）。
  全局白名单只能收窄、不能放宽到常量之外——**常量外的模型在校验层就被拒绝**，
  加了也存不进去（比「存了但过不了门」更省排查）。

### 2.4 requests 表加列 `api_key_fp`（审计用）

`requests.api_key_fp TEXT`（sha256(apiKey) hex，token/免鉴权为 null）。
DDL（`src/usagedb.ts:533-544`）+ `ensureRequestsColumns`（`src/usagedb.ts:716-741`）
补列，幂等。配套 `MetricsCtx.apiKeyFp`（镜像 `tokenFp`，`src/server.ts:1880`）+
`recordRequest`（`src/server.ts:2443-2466`）。

### 2.5 模块：新建 `src/modelaccess.ts`

仿 `modelmap.ts` / `settings.ts` 模式（sqlite 句柄由 `UsageDb.sqlite()` 暴露，降级不抛）：

```
ModelAccessStore {
  getCustom(type, subjectId): string[] | null      // 命中行返回解析后的数组
  setCustom(type, subjectId, models|null): boolean // 写行 / 删行；null=清除
  listByType(type): Array<{subjectId, models}>     // 面板展示
  globalDefault(): ReadonlySet<string>             // cfg.globalAllowedModels
  // 热路径缓存：与 accounts.allowedCache 同款懒加载 + 写操作失效
}
```

## 3. 优先级链（授权语义，核心决策）

**推荐：最具体的已配置层生效（替换语义），逐层回退；硬底线 `ALLOWED_MODELS` 恒在最外层。**

```
客户端请求模型名
  → resolveModel（别名→真名，src/deepseek.ts:93-120）→ 硬门：∉ ALLOWED_MODELS 或目录外 → 400（现有）
  → 客户端密钥授权：自定义(token/api-key) ?? 全局默认            [数据面入口 A]
  → 上游选号过滤（keypool acquire）：
      上游 key 自定义 ?? 账号级 allowedModels ?? 全局默认          [数据面入口 B]
  → 全被滤掉 → ModelNotAllowedError → 400（现有，src/keypool.ts:152-159）
```

理由：

- 与需求 4 一致：「自定义覆盖全局」= 配置了就用配置的（**可以比全局更宽**，只要在硬底线内）。
- 与现有账号级语义一致：账号配了 `allowedModels` 就是该账号 key 的默认（`src/upstream.ts:108-109`
  当前即替换而非交集），密钥级是更细一层、盖过账号级。
- **账号级位置**：作为上游 key 的**中位默认**（`key ?? account ?? global`），
  `PATCH accounts/:id allowedModels`（`src/admin.ts:224-227`）完全保留，不冲突。
- 硬底线不变 → 默认情况下（全局=ALLOWED_MODELS、无任何 key 自定义）行为与现状逐字节一致，
  迁移零风险。

替代方案（不推荐，记档）：每层取交集。会让「自定义比全局更宽」失效，违背需求 4。

## 4. 数据面接入

### 4.1 入口 A：客户端密钥 → 模型门

1. `verifyAuth` 改：`AuthResult` 加 `apiKeyFp: string | null`（`src/security/auth.ts:4-6`）。
   API key 命中时返回 `sha256Hex(token)`（把 `randomUUID()` 那行换掉，`src/security/auth.ts:96`）；
   token 命中时 `tokenFp` 已有（`src/security/auth.ts:101`）；免鉴权两者皆 null。
2. 分派处（`src/server.ts:2341-2366`）：
   `ctx.apiKeyFp = auth.apiKeyFp`；把 `clientSubject = {type, id}` 传进两个 handler。
3. `checkModelGate`（`src/server.ts:1687-1704`）加可选参 `keyAllowed: ReadonlySet<string> | null`：
   在 `d.ok` 分支后加一道 `if (keyAllowed && !keyAllowed.has(d.model)) → 400`。
   错误形状沿用 `sendModelNotAllowed`（400 / `invalid_request_error`），message 改为
   `model "X" is not allowed for this key (allowed models: ...)`，`ctx.error` 记
   `model X not-allowed-for-key <type>:<subject末8>`（区分审计：`src/server.ts:1701` 同款）。
   **类型不变**（不新造 client 可见的 error type），拒绝归因靠 message + `requests.error`。
4. handler 内计算 `keyAllowed`：`effective = custom(token/api-key) ?? cfg.globalAllowedModels`。
5. **count_tokens 不设门**（`src/server.ts:3194-3216`）：本地估算不产生生成、不消费额度，
   门住它会打断 Claude Code 的记账预检（chat 主调用仍被 4.1 门住）。
6. `/v1/models`（`src/server.ts:2382-2389`）按密钥过滤列为 **P2**（见 §8），P1 保持全局。

### 4.2 入口 B：上游选号 → key 级过滤

1. `KeyPool.acquire`（`src/keypool.ts:414-444`）的 `isEligible` 签名扩为
   `(accountId: number, key: string) => boolean`（`src/keypool.ts:422` 的 filter 改传 `k.key`）。
   可选参数、向后兼容；池内只有 `fetchUpstreamModels` 一处裸 `acquire()`（`src/upstream.ts:219`）不受影响。
2. `UpstreamCallOptions`（`src/upstream.ts:52-70`）加
   `keyModelAccess?: (rawKey: string) => string[] | null`（按 sha256(rawKey) 查 `model_access`）。
   `eligible` 闭包（`src/upstream.ts:105-111`）改为：
   ```
   if (!model) return true;
   if (pool.isModelBlocked(accountId, model)) return false;
   const keyCustom = opts.keyModelAccess?.(key);
   if (keyCustom != null) return keyCustom.includes(model);          // key 自定义 > 一切
   const allowed = opts.allowedModelsOf?.(accountId);
   if (allowed != null && allowed.length > 0) return allowed.includes(model);  // 账号级
   return cfg.globalAllowedModels.has(model);                        // 全局默认
   ```
3. server.ts 把 store 解析函数注入两处 `postUpstreamChat` 调用：
   chat `src/server.ts:2574` 与重试 `2633`、messages `src/server.ts:2977-2984`。
4. 全被滤掉 → `ModelNotAllowedError` → 400（现有路径 `src/server.ts:2583` / `2994` 原样复用）。

### 4.3 审计 / 请求日志

- 模型授权拒绝的请求照常落 `requests`（status 400 + `ctx.error`，`src/server.ts:2405-2467`）；
  新增 `api_key_fp` 列让 API-key 调用也能按客户端凭据归因（token 已有 `token_fp`）。
- 管理操作（全局/密钥授权变更）落 `admin_audit`（op `model-access.global` / `model-access.key`，
  只记脱敏 subject，不记模型外任何敏感信息；沿用 `src/admin.ts:593` 同款调用）。

## 5. API（新增）

全部在 `/__admin` 块，鉴权 = `isAdminRequest`（`src/server.ts:2038` 已统一）+ **读也过
`adminOriginAllowed`**（与 tokens/requests 同口径，`src/server.ts:2121-2132`）。

| 方法 | 路径 | 请求体 | 响应 | 说明 |
|---|---|---|---|---|
| GET | `/__admin/api/model-access` | — | `{ok, data:{global:{models,source:'settings'\|'code',core}, models:[可选项], keys:{tokens:[...], apiKeys:[...], upstreamKeys:[...]}}}` | 面板全量数据。`models` = `[...Object.keys(cfg.modelMap), ...ALLOWED_MODELS]`（与 `/v1/models` 同源，`src/server.ts:2383`）。每 key 带 `custom: string[]\|null`（null=跟随全局/账号） |
| PUT | `/__admin/api/model-access/global` | `{models: string[]\|null}` | `{ok, data:{global}}` | null/空 = 删 settings 键回代码默认；否则校验（复用 `validateAllowedModels` 规则：≤50、非空项、trim 去重，`src/admin.ts:250-263`）后写 `settings['allowedModels']` + 应用 `cfg.globalAllowedModels` + 审计 |
| PUT | `/__admin/api/model-access/keys/:type/:subject` | `{models: string[]\|null}` | `{ok, data:{...}}` / 404 | `type ∈ {token, api-key, upstream-key}`；`models:null` = 删行清除自定义。校验 subject 真实存在：token 查 tokens 表、api-key 对 `cfg.apiKeys` 逐 sha256 比对、upstream-key 经新加的 `KeyPool.hasKeyWithHash(hash)`（池内 sha256 比对，不外泄原文）。审计 + 缓存失效 |

- 面板侧掩码显示：token 用 `maskOf`（`src/tokens.ts:106-109`）、API key 用 `****XXXX` 格式、
  上游 key 用 `keyFingerprint`（`src/keypool.ts:165-168`，****末4位）。
- 新增 `KeyPool.hasKeyWithHash(sha256Hex: string): boolean`：遍历 `this.keys` 对 `k.key`
  算 sha256 比对，纯内部比对、不返回任何 key 材料。

## 6. 管理页面

**新 tab「Model Access」**（`data-tab="access"`，加在 `src/admin.ts:1581` tokens 之后），
不是独立页面（与现有单页 tab 结构一致，`src/admin.ts:5314-5318` 的 tabs 点击分派）。

功能清单（对照需求）：

- **列表**：四段——全局白名单编辑器 + 上游 key 授权 + 分发 token 授权 + API key 授权。
  每 key 行显示：身份（掩码/名称/昵称）、所属账号（上游 key，来自 `store.list()`）、
  token 状态徽章（active/disabled）、当前生效模式徽章。
- **全局白名单编辑区**：windsurf 式 chip 编辑（`windsurf/index.html:7468-7510` 同款：
  chip 点击 toggle、search + provider 过滤、已选项单独一排带 ×）。附「重置为代码默认」
  按钮与硬底线提示（ALLOWED_MODELS 中不可移除项灰显）。
- **密钥级编辑**：每行「编辑」→ modal（复用 `openConfirm` + chip 面板，同账号详情
  `src/admin.ts:4531-4552` 的交互），含「跟随全局/跟随账号」清除按钮。
- **搜索/筛选**：按名称/昵称/指纹搜索；按类型、按「已自定义/跟随默认」、按账号、按 token 状态筛选。
- **状态徽章**：`自定义` / `跟随账号`（仅上游 key）/ `跟随全局`；token active/disabled。
- **复制/导入导出/批量**：P2。导出/导入 = 整个 `model_access` + 全局的 JSON（当前
  `CURRENT.md` 已有 CSV/批量导入待办，`src/../../.claude/state/CURRENT.md` §五.7）。P1 只做单 key 编辑。

融合约束：

- 内联 JS 必须仍过 `new Function` 解析（`test/admin.test.ts:26-40`）、不引入反引号/`${}`、
  i18n 中英键集合一致（照 `src/admin.ts:2063` / `2309` 两侧同步加键）。
- 轮询：Model Access 数据静态（配置），不做 2s tick 轮询；改完局部刷新 + 失效缓存
  （参照 `loadTokens` 的 TTL 缓存 `src/admin.ts:3505-3522`）。tick 里可不加，避免空转
  （呼应 CURRENT.md 已知问题 I-11）。

## 7. 与现有功能冲突点

1. **账号级 allowedModels 保留**：`PATCH accounts/:id`（`src/admin.ts:224-227`）不动；
   成为上游 key 的中位默认（§3）。密钥级自定义只盖住单 key。无 schema/语义冲突。
2. **全局白名单 vs ALLOWED_MODELS 常量**：常量是硬底线（不迁移、不可放宽）；
   settings 白名单是可变默认。设 null 即回常量 → 行为与现状一致。
3. **双入口编辑同一密钥**（token 既在 Keys tab 管 RPM，又在 Model Access 管模型）：
   互不干扰，RPM 在 `tokens.rpm_limit`（`src/usagedb.ts:629`），模型在 `model_access`。
4. **审计归因**：模型拒绝此前只能看到 status=400 + 全局 message；本次加 `api_key_fp` 列 +
   结构化 `ctx.error`，token 侧已有 `token_fp`（`src/server.ts:2346`），两类客户端凭据都可归因。
5. **被动学习 block 与授权的关系**：`pool.blockModel`（`src/keypool.ts:294-297`）是「该账号
   端点不支持该模型」的观测性排除，与授权过滤正交，两者在 `eligible` 里都查、顺序不变
   （`src/upstream.ts:105-111` 的 block 检查在最前）。

## 8. 实现拆解（每步验收标准）

### 步骤 1：数据层
- usagedb：`model_access` DDL + `requests.api_key_fp` 列（DDL + `ensureRequestsColumns` 幂等补列）。
- 新建 `src/modelaccess.ts`（getCustom/setCustom/listByType + 缓存 + 降级）。
- settings：`SETTINGS_META.allowedModels` + `applySettingsToConfig` 应用 `cfg.globalAllowedModels`；
  AppConfig 加字段。
- **验收**：`npm test` 新增——migrate 建表、store CRUD/清除/降级、settings 往返（设→重启→生效、
  清键→回 ALLOWED_MODELS）；旧库（无 `model_access`/无 `api_key_fp`）升级不炸。
- **回归**：删除上述 store/settings 改动 → 新测试红。

### 步骤 2：客户端身份
- `verifyAuth` 加 `apiKeyFp`（API key 命中算 sha256，替换随机 UUID）。
- **验收**：`security.test.ts` 新增——同一 API key 两次调用 `apiKeyFp` 相同、token 命中
  `tokenFp` 有值 `apiKeyFp` 为 null、免鉴权皆 null。
- **回归**：去掉 sha256 改动 → 测试红（身份不稳定）。

### 步骤 3：数据面入口 A（客户端密钥门）
- `checkModelGate` 加 `keyAllowed` 参数 + 两道 handler 接线 + `MetricsCtx.apiKeyFp` + `recordRequest`。
- **验收**（e2e 假上游）：token 配自定义 {pro} → 打 pro 200、打 flash 400（message 含
  `for this key`）、`requests.error` 含 `not-allowed-for-key`；无自定义 token → 打 flash 200；
  settings 全局收窄为 {free} → 所有无自定义密钥打 flash 400；API key 配自定义生效。
- **回归**：去掉 `keyAllowed` 检查 → 上述 400 变 200。

### 步骤 4：数据面入口 B（上游 key 级）
- `KeyPool.acquire` isEligible 加 key 参数；`UpstreamCallOptions.keyModelAccess`；
  `eligible` 闭包三段式；两处 `postUpstreamChat` 注入 resolver；`KeyPool.hasKeyWithHash`。
- **验收**（keypool/upstream 单测 + e2e）：keyA 自定义 {X}、keyB 无 → 打 X 必选 keyA；
  打 X 外模型 → `ModelNotAllowedError`→400；key 无自定义、账号有 → 走账号集；key 自定义
  盖过账号集；`excludeKey` 重试路径仍对。
- **回归**：去掉 `keyModelAccess` 分支 → keyA 被选但模型不符时 400 消失（选号不再过滤）。

### 步骤 5：API + admin 接线
- server.ts 三个端点（GET + PUT global + PUT keys/:type/:subject），鉴权 + Origin + 校验 + 审计。
- **验收**（admin.test.ts 端点级）：未鉴权 401、跨 Origin 403、type/body 校验 400、
  subject 不存在 404、成功 200 + audit 行 + 缓存失效。
- **回归**：端点删除 → 对应测试红。

### 步骤 6：面板 tab
- admin.ts 加 tab 按钮 + section + JS（load/render/编辑 modal/chip/搜索筛选/徽章/重置全局）+ i18n 双侧键。
- **验收**：`new Function(inlineScript())` 不抛（`test/admin.test.ts:26-40` 保持绿）；
  i18n 中英键集合一致（现有检查保持绿）；HTML 含 `data-tab="access"` 与关键 id；
  无反引号/`${}` 泄漏。手动过一遍四段编辑闭环。
- **回归**：tab 按钮缺失 → 检查红。

### 步骤 7：全量
`npm test`（1297 基线 + 新增全绿）、`npm run typecheck`、`npm run build`。
CURRENT.md 更新（新功能 + 端点 + 表结构）。

## 9. 明确决策点（已拍板，实现时别回退）

1. 授权是**替换语义**（配置层覆盖低层），不是交集。
2. 硬底线 `ALLOWED_MODELS` 不可被任何配置放宽；全局白名单只收窄。
3. 客户端密钥门在**选号之前**（入口 A 前置，400 语义与现有全局门一致）。
4. `count_tokens`、`/v1/models` **不设门**（P1）；`/v1/models` 按密钥过滤列为 P2。
5. 上游 key / API key 的 subject = sha256 全 hex；token 复用现有指纹。
6. 全局白名单存 settings 表（热配置），经 `SETTINGS_META` 进出。
7. 拒绝 HTTP 形状保持 400 + `invalid_request_error`，不新增 client 可见 error type。
