# 多账号面板升级设计（实现契约）

面向 `/tmp/fc-arch.md` 草图（已确认方向）的落地设计。本文档是给实现 agent 的契约：
表结构给完整 SQL，接口给完整 JSON 示例，每个决策给理由和取舍。
代码基线：当前 main（第六轮之后，405 tests 全绿）。

总原则（贯穿全文）：

- 观测逻辑绝不阻塞代理链路，延续 usagedb 的三条承重设计（零依赖 / 可降级 / 写不阻塞）。
- key 与 cookie 原文：不入库明文、不出现在任何响应/日志/面板，只以加密形态落盘、只在进程内解密使用。
- 简单优先：不引入预防性抽象；每个新概念都要能回答「不加它有什么具体损失」。

---

## 1. SQLite 表结构（accounts 表）

### 1.1 归属与库文件决策

**accounts 表加在现有 usage.db（`usagedb.ts` 的库），不另开库**。理由：

- 单一连接、单一 `migrate()`、单一 `enabled` 降级标志 —— 盘满/权限/损坏时面板所有
  观测数据一起降级，行为可预期，不用协调两个库的降级状态。
- 库文件已落在 `dist/` 外（`data/usage.db`），部署不丢。
- 账户是运营配置数据，与请求/事件日志同库没有冲突；`prune()` 只删 `requests`/
  `key_events` 两表（按 `at` 删），accounts 是配置不是日志，**天然不会被清理**，无需改 prune。

### 1.2 keys 归属：keys_enc 加密 JSON，不建独立 keys 表

**维持草图方案：`accounts.keys_enc` 存加密 JSON 数组。** 评估过独立 keys 表，否决，理由：

| 独立 keys 表能带来的 | 为什么不需要 |
|---|---|
| key 独立状态持久化 | key 的运行时状态（disabledUntil/failCount/inFlight…）**只活在 KeyPool 内存里**，这是刻意的：keypool 是选路状态机的唯一真源。若落库持久化，重启时要和内存态对账（两套真源），这正是 Karpathy 原则禁止的预防性复杂。跨重启的 key 审计已由 `key_events` 表承担 |
| key 独立探活 | 探活走 `pool.staleKeys()` / 新设计的账户调度器，读内存快照，不读表 |
| key 独立指纹 | 指纹由 key 原文实时派生（`keyFingerprint`），本就不落库 |
| 逐 key SQL 操作 | 面板的增删 key = 重写一行 JSON，账户数 2-5 个、每户 key 1-3 个，行数收益为零 |

隐私口径不变：key 原文以 AES-256-GCM 密文形态落盘，明文只存在于进程内
（池构造时解密一次、探活/新增 key 时按需解密）。`requests.key_fp` 仍只存末 4 位指纹。

### 1.3 完整 DDL

加进 `UsageDb.migrate()`（`src/usagedb.ts:234-262` 的 exec 里）：

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT 'account',
  kind TEXT NOT NULL DEFAULT 'unknown',          -- subscription | payg | unknown（TS 侧收敛）
  workspace_id TEXT,                             -- opencode.ai workspace id，可空
  keys_enc TEXT NOT NULL DEFAULT '[]',           -- 加密 JSON 数组：["sk-...", ...]
  cookie_enc TEXT,                               -- 加密后的 auth cookie 原文，可空
  status TEXT NOT NULL DEFAULT 'unknown',        -- 见 4.1 状态枚举
  status_detail TEXT,                            -- 最近一次失败的上游原文（截断 200，stripControl）
  retry_until INTEGER NOT NULL DEFAULT 0,        -- 探针调度闸门（0 = 立即可探）
  last_probe_at INTEGER NOT NULL DEFAULT 0,
  last_billing_at INTEGER NOT NULL DEFAULT 0,
  balance_units INTEGER,                         -- 余额（units，1e8 units = $1）；null = 未知
  monthly_limit_units INTEGER,
  monthly_usage_units INTEGER,
  created_at INTEGER NOT NULL                    -- 代码里传 Date.now()，与 requests.at 同风格
);
```

**不加 CHECK 约束、不加索引**，理由：

- 现有 `key_events` 同样无 CHECK，TS 类型是枚举唯一真源；CHECK 会让「新增枚举值后
  旧进程写失败被 try/catch 吞掉」变成静默故障。
- accounts 是 2-5 行的小表，PK 即全扫，任何索引都是死代码。显式不加。

### 1.4 与现有表的关系（零改动）

- `requests.key_fp` / `key_events.key_fp` **不加 account_id 列**。key→账户的映射由
  KeyPool 在内存持有（见 §3），面板按需 join：`pool.snapshot()` 带 `accountId`，
  按账户聚合 `history().byKey` 在服务端做，不落库。指纹碰撞（末 4 位）沿用已知
  限制（audit #8 已判定不修）。
- 探活记录 `endpoint='probe'` 落库机制不变，多一个 accountId 用不上。

---

## 2. 密钥管理（secret.key + AES-256-GCM）

### 2.1 密钥来源与生成

新增模块 `src/secrets.ts`：

```ts
export interface SecretKey {
  encrypt(plain: string): string;          // 永不抛
  decrypt(payload: string): string | null; // 任何失败返回 null，绝不抛
}
export function loadSecret(cfg: AppConfig): SecretKey | null; // 失败返回 null（调用方降级）
```

规则（优先级从高到低）：

1. `cfg.gatewaySecret`（env `GATEWAY_SECRET`）非空 → 密钥材料 = 该字符串。
   用途：不想在盘上落 secret 文件的部署/轮换场景。
2. 否则读 `cfg.secretFilePath`（env `SECRET_FILE`，默认 `data/secret.key`）。
   - 文件不存在 → 生成 32 随机字节 base64 写入，`fs.writeFileSync(p, data, { mode: 0o600 })`
     后再 `fs.chmodSync(p, 0o600)` 兜底 umask（创建后显式 chmod，避免 umask 放宽）。
     目录用 `fs.mkdirSync(dirname, { recursive: true })`。
   - 文件已存在且权限比 0600 宽松 → 打一条 warn（不静默改权限，留给运维决定）。
   - 文件读不了（EACCES 等）→ 返回 null。

**统一密钥派生：`key = sha256(secretString)`（32 字节）**。env 值和文件内容都当
字符串走同一条路，无需分支格式。**AES-256-GCM 封装（node:crypto，零依赖）：**

- 每次加密生成 12 字节随机 IV；`cipher = createCipheriv('aes-256-gcm', key, iv)`；
- 输出格式（单字符串，可入 TEXT 列）：

```
1:<base64(iv ‖ authTag ‖ ciphertext)>
```

`decrypt` 解析时校验 `1:` 前缀，失败一律返回 null（不抛、不分类）。前缀就 2 字节，
防将来换格式时静默错解 —— 这是加密持久化格式的卫生习惯，不算预防性抽象。

### 2.2 配置接线（config.ts）

`AppConfig` 新增四个字段（env 白名单照旧）：

```ts
gatewaySecret: string | null;      // env GATEWAY_SECRET，默认 null
secretFilePath: string;            // env SECRET_FILE，默认 'data/secret.key'
billingIntervalMs: number;         // env BILLING_INTERVAL_MS，默认 1_800_000（30min）
billingTimeoutMs: number;          // env BILLING_TIMEOUT_MS，默认 20_000
```

并改两个探针默认值（草图要求，见 §4.5）：
`keyProbeIdleMs` 默认 `3_600_000`（原 1_800_000），`keyProbeIntervalMs` 默认
`900_000`（原 1_800_000）。config.ts:149-152 那段「两个值一致是刻意的」注释
必须重写 —— 新的刻意关系是「轮转 15min（失败重试粒度）、空闲 60min（闲置才探）」。

### 2.3 降级路径

`loadSecret` 返回 null → `AccountsStore` 整体禁用（`enabled=false`，
`disabledReason='secret unavailable'`），keypool 只用 env keys（现状不变），
`/__admin` 返回 503 提示。**代理链路不感知**。

---

## 3. keypool 改造（最小改动方案）

### 3.1 PooledKey 加 accountId + 构造兼容

```ts
interface PooledKey {
  key: string;
  accountId: number;   // 0 = 未归属（env keys 兜底），>0 = accounts.id
  /* 其余字段不变 */
}
```

**构造签名保持不变**，加可选第三参数（现有调用点 `src/main.ts:19`、
`src/server.ts:277` 和 20+ 处测试全部不用动）：

```ts
constructor(
  rawKeys: string[],
  options: KeyPoolOptions,
  accountIds?: ReadonlyMap<string, number>,   // key 原文 → accountId
)
```

构造时 `accountId = accountIds?.get(key) ?? 0`。env keys 与账户 keys 可能重复
（见 §3.3 的种子策略），重复 key 仍按现有 seen 去重，accountId 取第一个命中。

### 3.2 snapshot() 兼容性（只增不改）

`PoolKeySnapshot` 加一个字段：

```ts
/** 所属账户 id；0 = 未归属（仅 env 配置，未进账户表）。 */
accountId: number;
```

这是纯增量：`dashboard.ts` 的 keypool() 忽略未知字段；e2e 只断言已存在字段。
现有 `test/e2e.test.ts:606-637` 的 `/__metrics` 断言不受影响。

新增方法（各约 5 行，全部 null-safe——`release`/`markFailure`/`markSuccess` 已有
`find` 不存在则 return 的守卫，removeKey 时在飞请求安全）：

```ts
addKey(key: string, accountId: number): boolean;      // 已存在同名 key → false
removeKey(key: string): boolean;                       // 不存在 → false
accountIdOf(key: string): number;                      // 默认 0
```

### 3.3 env keys → 账户映射（种子策略）

启动时 `AccountsStore` 构造器内做**一次**种子（`db.enabled && 表空 && cfg.upstreamKeys 非空`）：

```
INSERT 一条账户 { name: 'env', kind: 'unknown', keys_enc: encrypt(JSON(upstreamKeys)) }
```

语义与取舍：

- env 的 `OPENSEA_KEYS`（含合并的 `ANTHROPIC_API_KEY`）仍是初始化来源，种子后
  面板可见、可改名/补 cookie/增删 key。
- **只在表空时种子**：用户若删光全部账户，下次重启会重新从 env 种子（可恢复语义，
  删错了不致命）；只删掉 env 账户但留有其他账户则不再种子（尊重用户操作）。
- 若 db 降级（accounts 不可用）：不种子，pool 仍用 env keys，accountId 全部 0 ——
  「env 兜底」路径下面板账户区显示 degraded，代理不感知。
- `kind='unknown'` 时探针默认打订阅端点（§4.4），用户可在管理面板改成 payg。

### 3.4 面板新增 key：热加载，不重启

**决策：`/__admin` 增删 key 立即生效（热），不重启。** 取舍：

| 方案 | 代价 | 收益 |
|---|---|---|
| 热加载 | `addKey/removeKey` 各 ~5 行；`release/markFailure/markSuccess` 已有 null-safe 守卫 | 换 key/加号不用重启进程、不用改 env、不用 deploy。这正是面板管理账号的核心价值 |
| 重启生效 | 零代码 | 面板改完 key 池没变，用户困惑；且与「面板是运维主界面」的目标矛盾 |

实现是两行接线的顺序问题（`/__admin` handler 里）：
`store.addKey(id, key)` 落盘 → `pool.addKey(key, id)` 进内存。removeKey 同理。
新 key 的 `lastUsedAt=0` → 下一轮探针自动探它（staleKeys 语义白拿）。

---

## 4. 探针增强（账户级状态机）

### 4.1 账户状态枚举

`AccountStatus = 'unknown' | 'ok' | 'invalid' | 'insufficient' | 'limit' | 'cooldown' | 'region' | 'error'`

### 4.2 error.type 分流表（新函数，放 errors.ts）

`errors.ts` 里新增 `classifyAccountError(status, body)`（与现有
`extractUpstreamErrorType` 同文件私有复用，不导出内部函数），返回：

```ts
{ status: AccountStatus; retryMs: number }   // retryMs = 距下次探针的时间
```

| 上游 error.type / 形态 | account.status | retryMs | pool kind（markFailure） |
|---|---|---|---|
| AuthError / authentication_error（401/403） | `invalid` | 12 × keyCooldownMs | auth |
| CreditsError / billing_error / insufficient_balance | `insufficient` | 15min | rate-limit |
| MonthlyLimitError | `limit` | 上游 reset 时间；解析不出 24h | quota-exhausted |
| UserLimitError | `limit` | 同上 | quota-exhausted |
| GoUsageLimitError | `cooldown` | reset + 60s；解析不出 1h | quota-exhausted |
| BlackUsageLimitError | `cooldown` | reset + 60s；解析不出 24h | quota-exhausted |
| RateLimitError / 裸 429 | `cooldown` | 15min（探针节流下限，见 4.5） | rate-limit |
| RegionError | `region` | 24h | rate-limit |
| 其他 / 网络层失败 | `error` | 15min | transient |

**同步小改 `classifyUpstreamFailure`（errors.ts:147-151 的 quotaSignals）**：显式加上
`errorType === 'MonthlyLimitError' || 'UserLimitError' || 'BlackUsageLimitError'`。
理由：否则这些真实流量错误会被归成 rate-limit（3s 短冷却），限流期内每个请求都
撞一次已耗尽的 key —— 正是 keypool.ts:385 注释里警告的「账号级状态用短冷却」反模式。
`RegionError` 不加（pool 只有 4 种 kind，硬塞会污染 key_events 审计；账户徽标承担展示）。

**两条分类函数必须一致**（同 error.type 在两张表里不能结论相反），测试钉住（§8）。

### 4.3 与 keypool 冷却的交互（回答「双重冷却」）

- **探针失败照旧走 `pool.markFailure(key, kind, resetMs)`**（现状不变）。这是必须的：
  探针证明 key 死了，选路绝不能继续挑它。
- **避免双重冷却 = 两个冷却各管各的闸门，互不写入**：
  - `pool.disabledUntil` 闸住**选路**（真实流量）；
  - `account.retry_until` 闸住**探针调度**（面板徽标 + 多久再探一次）。
  - 探针调度器不读 `pool.disabledUntil`；pool 不读 `account.retry_until`。
  - `disableUntil` 只延长不缩短的既有守卫（keypool.ts:428-441）天然防住
    「探针的迟到失败把长冷却冲成短冷却」——同因同果，探针重报同一个 quota 错误时
    `until <= disabledUntil` 直接 return，不重复上报事件。
- 面板上的双重可见是**特性不是 bug**：账户徽标（探针结论）与逐 key 卡片
  （实时流量结论）展示两个层级的健康度。

### 4.4 探针目标与端点选择（按账户而非按 key）

`runProbeRound` 重构为账户驱动（`src/keyprobe.ts`，`probeKey` 保留为单 key 底层函数
但加 `baseUrl`、`model` 参数；`staleKeys` 保留供内部用，测试仍测它）：

```
候选账户 = accounts.list() 过滤：
  1. now >= retry_until - PROBE_EARLY_MS        // 到期（含提前 5min 窗口）；retry_until=0 即到期
  2. 账户至少 1 个 key
  3. 该账户任一 key 的 lastUsedAt > now - keyProbeIdleMs  → 跳过（有真实流量，活着）
代表 key = 账户 keys 里第一个（不因 pool 禁用跳过 —— 禁用中探一次恰好是「到期前确认恢复」的
            主力手段，token 成本一次；重报同类错误不会延长 pool 冷却，见 4.3）
```

端点与模型按 `kind`：

| kind | baseUrl | model |
|---|---|---|
| subscription（默认，含 unknown） | `cfg.anthropicBaseUrl` | `deepseek-v4-flash`（现有 PROBE_MODEL） |
| payg | `cfg.payAsYouGoBaseUrl` | `deepseek-v4-flash-free`（已在 ALLOWED_MODELS，deepseek.ts:38） |

**必须按 kind 分流**：`-free` 模型在订阅端点 401 ModelError（deepseek.ts:89 实测注释），
探错端点会把好号判成 auth 错误。

探针结果落账（`AccountsStore.setProbeResult`）：

- 成功 → `status='ok'`，`retry_until = now + keyProbeIdleMs`，`last_probe_at=now`，
  并 `pool.markSuccess(key)`（沿用现有：刷新 lastUsedAt 防重复探）。
- 失败 → `status/status_detail/retry_until` 按 4.2 表，`last_probe_at=now`；
  `pool.markFailure(key, poolKind, resetMs)`。
- `status_detail` 存 `stripControl(上游 error.type + message).slice(0, 200)`。
  日志照旧 `[keyprobe]` 前缀，格式带账户名：`[keyprobe] account=env probe fail 429 cooldown (...) ...`。

### 4.5 频率策略（草图四项，一个机制实现）

| 草图规则 | 实现 |
|---|---|
| 闲置 60min 探 | 成功探后 `retry_until = now + keyProbeIdleMs`（默认 60min）+ 候选规则 3（真实流量即跳过） |
| 失败 15min 重试 | transient/insufficient/rate-limit 类 `retryMs=15min`；调度 tick 即 `keyProbeIntervalMs` 默认 15min |
| 冷却期不探 | 候选规则 1：`now < retry_until - 5min` 跳过（quota 类 retry_until = reset+60s，冷却期自然被闸住） |
| 到期前 5min 探 | `PROBE_EARLY_MS = 300_000` 硬编码常量：提前窗口内即可探。仍限 → 上游给新 reset 时间，账户与 pool 冷却同步延长；已恢复 → 徽标翻 ok，pool 冷却 5min 后自然 reap |

串联示例（真实流量先撞上额度耗尽）：pool 立即禁用 key（reset+60s）→ 下个 tick 探针
打它 → `cooldown` + `retry_until=reset+60s` → 冷却期不探 → reset-5min 探一次 →
仍限则延长，恢复则翻 ok。整个周期每账户最多 1 次探/tick，token 成本可忽略。

`startKeyProbe` 的 timer `unref`/防重入 `running` 标志沿用（keyprobe.ts:177-202）。

---

## 5. billing 抓取（新模块 billing.ts）

### 5.1 模块职责

```
startBillingLoop(cfg, accounts, log): () => void   // main.ts 启动；timer unref；无账户/禁用则 no-op
fetchAccountBilling(cfg, account): BillingResult    // 单账户抓取（/__admin 手动刷新也调它）
parseBillingPage(html): Partial<{balanceUnits, monthlyLimitUnits, monthlyUsageUnits}> | null
```

### 5.2 抓取

```
GET https://opencode.ai/workspace/{workspace_id}/billing
headers: { cookie: `auth=${cookie}`, accept: 'text/html', 'user-agent': 'fuckopencode/0.1' }
timeout: AbortSignal.timeout(cfg.billingTimeoutMs)   // 默认 20s
```

- 无 `workspace_id` 或无 cookie 的账户直接跳过（不视为失败）。
- 非 2xx → 失败。**失败日志只记状态码和账户名，绝不记响应体**（页面可能含其他
  账户数据）。

### 5.3 解析（SSR 水合 + data-slot 兜底）

页面是 Next.js SSR。两步解析：

1. **主解析（units，水合数据）**：抽出所有 `<script>` 块内容，逐块跑
   `/"?(balance|monthlyLimit|monthlyUsage)"?\s*:\s*(\d+)/g`。带引号锚定防 CSS/
   属性误匹配，只在 script 内扫。
2. **兜底（dollars，data-slot）**：三个值全没找到时，跑
   `data-slot="(balance|monthlyLimit|monthlyUsage)"[^>]*>\s*(?:[$¥€])\s*([\d,]+(?:\.\d{1,2})?)/g`，
   dollar → units = `Math.round(dollar * 1e8)`。

合理性校验（任何一个不满足就丢弃该值）：数值有限且 ≥ 0；`monthlyLimitUnits > 0`；
`monthlyUsageUnits <= monthlyLimitUnits * 1.1`（允许小余量，usage>limit 的页面丢弃这组）。

**换算口径：100,000,000 units = $1**，API 层以美元两位小数呈现（§6.2），库内全程
整数 units 防浮点漂移。

接受规则：三个值至少拿到一个 → 成功（局部更新，缺失字段保持旧值）；一个都没有 →
失败。

### 5.4 缓存与退避（内存态 + 落库）

- 成功：写 `balance_units/monthly_limit_units/monthly_usage_units/last_billing_at`
  （部分更新时只写拿到的字段，`last_billing_at` 恒更新）。
- 频率：`billingIntervalMs` 默认 30min。调度器每 15min tick 一次（复用探针 tick 粒度，
  不新开定时器密度），逐账户判断 `now >= nextDueAt`。
- 失败退避（每账户独立，内存 Map，重启清零）：15min → 30min → 60min → 120min 封顶，
  成功重置为 interval。理由：billing 页面公开，失败大概率是持久的（cookie 过期/
  workspace id 错），30min 一锤子打到天荒地老没有意义。
- 首轮错峰：启动后各账户 `nextDueAt = bootAt + 15s + id * 25s`（防 thundering herd）。
- 手动刷新（`/__admin` 端点）：绕过 nextDueAt 立即抓；成功更新行并重置退避。

**落地前 spike（第一步必做）**：拿真实 cookie 抓一次页面存成 fixture，核对
§5.3 两条正则是否命中（页面结构以实测为准，正则目标来自草图、未实机验证）。
用 `npm run test:live` 风格的临时脚本做，结果写成 `test/fixtures/billing-*.html`
固化进单测。

---

## 6. API 契约

### 6.1 鉴权（/__admin 与 /__metrics 的 accounts 段共用）

新增判定（server.ts 内，紧挨 `isDirectLocalRequest` 定义处）：

```ts
// 管理面鉴权：本机直连免 key，其余必须带 API key；DASHBOARD_PUBLIC 永不豁免。
function isAdminRequest(req: IncomingMessage, cfg: AppConfig, headers): boolean {
  if (cfg.dashboardOpen && isDirectLocalRequest(req)) return true;
  return verifyAuth(cfg, headers).ok;
}
```

规则与理由：

- `/__admin` 全部路径：**必须**过 `isAdminRequest`，否则 401（提示文案复用现有
  ssh 隧道提示模板，server.ts:328-334）。绝不走 `dashboardPublic` 放行 —— 账户
  管理含增删凭据，公开等于裸奔。
- `/__metrics` 的 `accounts` 字段：仅当请求通过 `isAdminRequest` 才包含；
  未通过（含 dashboardPublic 公网模式）时**整个字段不出现**（不是 null —— 公网
  响应保持逐字节不变，e2e 不回归）。`accounts` 模块未接线时同样不出现该字段。
- 浏览器 CSRF 防护（本地恶意网页打 localhost 的 /__admin）：所有
  POST/PATCH/DELETE 请求若带非空 `Origin` 头且不等于 `http://<host>:<port>`
  （回环场景）→ 403。GET 只读不设防（与现有面板一致）。

### 6.2 /__metrics 新增 accounts 段（完整 JSON 示例）

```
GET /__metrics   （仅 isAdminRequest 通过的请求包含此段）
```

```json
{
  "...现有字段不变...",
  "accounts": {
    "degraded": null,
    "list": [
      {
        "id": 1,
        "name": "env",
        "kind": "subscription",
        "status": "cooldown",
        "statusDetail": "GoUsageLimitError: Weekly usage limit reached. Resets in 19hr 22min.",
        "retryUntil": 1782600000000,
        "retryInMs": 69720000,
        "lastProbeAt": 1782528000000,
        "balance": 1.23,
        "monthlyLimit": 10.00,
        "monthlyUsage": 2.45,
        "monthlyPercent": 24.5,
        "lastBillingAt": 1782519000000,
        "keys": [
          {
            "fingerprint": "****ZOBb",
            "healthy": false,
            "inFlight": 0,
            "disabledReason": "quota-exhausted",
            "recoverInMs": 69720000,
            "lastUsedAt": 1782500000000
          }
        ]
      }
    ]
  }
}
```

契约要点：

- `statusDetail` 为 null（ok/unknown 时）；非 null 时已 stripControl + 截断 200。
- 金额一律美元两位小数（`Number(x / 1e8).toFixed(2)` 的 number）；`monthlyPercent`
  = `usage/limit*100`（limit 为 null/0 时为 null）。
- 倒计时双字段沿用 pool 模式：`retryUntil`（绝对）+ `retryInMs`（相对剩余），
  面板本地每秒倒计时用后者（dashboard.ts 的 `data-rc` 模式）。
- `keys[]` 来自 `pool.snapshot().filter(k => k.accountId === account.id)`，
  **服务端组装，不解密任何东西**；某 key 的 `healthy=true` 时省略
  `disabledReason/recoverInMs`（沿用 PoolKeySnapshot 既有约定）。
- `degraded`：db 不可用时为分类原因（复用 `classifyDbFailure` 口径），list 为空数组。
- 组装函数 `buildAccountsSection(store, pool, now)` 放 accounts.ts，
  `/__metrics` 与 `/__admin/api/accounts` 共用，防止两份结构漂移。

### 6.3 /__admin 端点清单

路由块插在 server.ts:373 之后（`/__dash` 分支之后、OPTIONS 之前）。页面与 API 同源：

| 方法与路径 | 鉴权 | 行为 |
|---|---|---|
| GET `/__admin` | isAdminRequest | 返回管理面板 HTML（ADMIN_HTML，见 §7） |
| GET `/__admin/api/accounts` | isAdminRequest | 账户列表（与 §6.2 `accounts` 同构，包在 `{accounts, degraded}`） |
| POST `/__admin/api/accounts` | isAdminRequest + Origin 校验 | 创建账户，201 返回账户 |
| PATCH `/__admin/api/accounts/:id` | 同上 | 改 name/kind/workspaceId/cookie（cookie 传空串 = 清除），200 |
| DELETE `/__admin/api/accounts/:id` | 同上 | 删除账户（从 pool 移除其 key），204 |
| POST `/__admin/api/accounts/:id/keys` | 同上 | 加一个 key（落盘 + pool.addKey 热加载），200 |
| DELETE `/__admin/api/accounts/:id/keys/:fingerprint` | 同上 | 删 key（指纹匹配账户内第一个），204/404 |
| POST `/__admin/api/accounts/:id/billing` | 同上 | 手动刷新余额，200；抓取失败 502 |

`:id` 必须 `/^\d+$/`，否则 400。

请求体示例（POST/PATCH，`readBody` 读取，`maxBodyBytes` 上限）：

```json
{
  "name": "订阅主力号",
  "kind": "subscription",
  "workspaceId": "ws_abc123",
  "keys": ["sk-ant-xxxx", "sk-ant-yyyy"],
  "cookie": "eyJhbGciOiJIUzI1NiJ9..."
}
```

字段校验（任一失败 400 + 现有错误 JSON 形状）：

- `name`：非空字符串，≤ 100 字符
- `kind`：`subscription | payg | unknown`
- `keys`：数组，每项非空 trim 后 ≤ 200 字符，去重，≤ 20 项
- `cookie`：可选，≤ 4096 字符（可整体换）
- `workspaceId`：可选，非空 trim，≤ 200 字符

响应示例（POST 201 / PATCH 200，**绝不含 keys_enc/cookie_enc/任何明文**）：

```json
{
  "account": {
    "id": 2,
    "name": "订阅主力号",
    "kind": "subscription",
    "workspaceId": "ws_abc123",
    "status": "unknown",
    "statusDetail": null,
    "retryUntil": 0,
    "retryInMs": 0,
    "lastProbeAt": 0,
    "balance": null,
    "monthlyLimit": null,
    "monthlyUsage": null,
    "monthlyPercent": null,
    "lastBillingAt": 0,
    "keys": [
      { "fingerprint": "****xxxx", "healthy": true, "inFlight": 0, "lastUsedAt": 0 }
    ]
  }
}
```

错误形状沿用现有约定：`{ "error": { "message": "...", "type": "..." } }`；
`type` 用 `invalid_request_error`（400）/ `authentication_error`（401）/
`server_error`（500/502）/ `not_found_error`（404，id 不存在）。
手工刷新 billing 无 cookie → 400 `"account has no billing cookie"`。

---

## 7. 模块文件划分（新文件 4 个，改动文件 9 个）

### 新文件

| 文件 | 职责（一句话） |
|---|---|
| `src/secrets.ts` | secret.key 生成/读取 + GATEWAY_SECRET 覆盖 + AES-256-GCM 加解密封装（`loadSecret` 返回 null 即降级） |
| `src/accounts.ts` | AccountsStore：账户 CRUD 的加密落库 + keysForPool 解密 + 探针/billing 结果写账 + `buildAccountsSection` 快照组装 |
| `src/billing.ts` | billing 页面抓取 + 解析 + 缓存/退避调度（`startBillingLoop` timer unref，无 cookie 账户跳过） |
| `src/admin.ts` | ADMIN_HTML（管理面板单页，与 dashboard.ts 同风格 String.raw）+ 暴露给 server 的路由处理函数（纯函数式，不持状态） |

### 改动文件（含行号锚点）

| 文件 | 改动点 | 一句话说明 |
|---|---|---|
| `src/usagedb.ts` | migrate() 内 `:234-262` 加 accounts DDL（§1.3）；类尾部加 listAccounts/getAccount/insertAccount/updateAccount/deleteAccount（返回 boolean 的写操作，失败记日志返 false——管理面操作要真相，查询保持 null 降级）；文件头注释「两张表」改「三张表」；**2026-08-14 再加 key_totals 聚合表**（byKey 口径聚合：flush 同事务增量 upsert + 启动初始重建 + prune 随 requests 窗口重建，byKey 读端由实时聚合改为读表 O(#keys)） | accounts 表的底层读写，沿用全部 PRAGMA 与降级哲学 |
| `src/keypool.ts` | `PooledKey` 加 accountId（`:17-36`）；构造加第三参 `accountIds?: ReadonlyMap<string, number>`（`:152`）；新增 addKey/removeKey/accountIdOf（~15 行）；`PoolKeySnapshot` 加 accountId（`:45-64`）并写入 snapshot()（`:249-268`） | 最小改动，全部现有调用点兼容 |
| `src/errors.ts` | 新增 `classifyAccountError(status, body)`（§4.2 表）；quotaSignals 显式加 MonthlyLimitError/UserLimitError/BlackUsageLimitError（`:147-151`） | 账户状态机与 pool 分类共享同一错误体解析，测试钉住两张表一致 |
| `src/keyprobe.ts` | `probeKey` 加 baseUrl/model 参数（`:57-63`）；`runProbeRound` 重构为账户驱动（`:129-170`，候选规则见 §4.4）；`startKeyProbe` 签名加 accounts（`:177`）；PROBE_MODEL 拆出 PAYG 模型常量 | 探针目标从「空闲 key」变为「到期的账户」 |
| `src/config.ts` | AppConfig 加 4 字段（§2.2）；keyProbeIdleMs/keyProbeIntervalMs 默认值改动（`:150-151`） | env 白名单 + 探针节奏对齐草图 |
| `src/main.ts` | 启动序：loadSecret → UsageDb → AccountsStore（含 env 种子）→ pool（env + accounts.keysForPool()，accountIds map）→ startKeyProbe（带 accounts）→ startBillingLoop；shutdown 里加 stopBilling | 全部失败路径都退化为「env keys 现状」 |
| `src/server.ts` | `:373` 后插 `/__admin` 路由块（含 Origin 校验 + isAdminRequest）；`/__metrics` 段 `:339-365` 加 accounts 组装（isAdminRequest 才包含）；文件内加 isAdminRequest | 管理面与 accounts 数据出口 |
| `src/dashboard.ts` | **不改** | 对外面板维持现状（流量+key 池），账户面全在 /__admin |
| `scripts/deploy.sh` | **不改**（data/ 已不随部署动，secret.key 自动落在 data/） | 仅文档说明：备份提醒见 DEPLOY.md |

`index.ts`（库导出面）：不导出新模块（观测/管理面不属于库 API），保持现状。

### 测试（每个新模块配 vitest，沿用现有风格）

| 文件 | 覆盖 |
|---|---|
| `test/secrets.test.ts`（新） | 文件生成 0600/chmod、env 覆盖、roundtrip、错 key/坏格式 decrypt → null、幂等（重复加载同一文件） |
| `test/errors.test.ts`（新或扩） | classifyAccountError 全表 + 与 classifyUpstreamFailure 的一致性（同 error.type 双表断言） |
| `test/keypool.test.ts`（扩） | accountIds map、snapshot.accountId、addKey/removeKey/去重、removeKey 后 release/markFailure 不崩 |
| `test/usagedb.test.ts`（扩） | accounts CRUD、insert 失败返回 false、prune 不碰 accounts |
| `test/accounts.test.ts`（新） | store 层：加密落库 roundtrip、keysForPool 解密、env 种子只种一次、setProbeResult/setBilling 写账 |
| `test/billing.test.ts`（新） | parseBillingPage：水合正则、data-slot 兜底、单位换算、合理性校验、垃圾输入 |
| `test/keyprobe.test.ts`（改） | 账户候选规则（到期/提前窗口/有流量跳过）、payg 走 -free + PAYG base、探针结果写账 |
| `test/e2e.test.ts`（扩） | /__admin 鉴权矩阵（直连放行/cf 头拒绝/公网模式无 accounts 字段）、CRUD 全流程、手动刷新、**扫描无 sk-/auth cookie 原文**（沿用 :606-637 的扫法） |
| `test/dashboard.test.ts`（扩） | ADMIN_HTML 内联 `<script>` 过 `new Function()` 解析（沿用现有盲区兜底测试模式） |

### 实现顺序（建议）

1. secrets.ts + 测试 → 2. usagedb accounts 表 + 测试 → 3. accounts.ts + 测试 →
4. keypool 改造 + 测试 → 5. errors.ts 分类 + 测试 → 6. billing.ts（**先 spike 真实页面**）+ 测试 →
7. keyprobe 账户驱动 + 测试 → 8. server.ts + admin.ts → 9. main.ts 接线 →
10. typecheck + build + 全量测试 + 本地假上游实机验证（.claude/launch.json 已有配置）。

---

## 8. 已知取舍与明确不做的

- **账户徽标新鲜度 ≤ 15min（一个探针 tick）**：账户 status 只由探针写入（不做真实
  流量的 hookup，保持「状态单一写者」）。真实流量故障时逐 key 卡片立即反映（pool
  实时），账户徽标下一轮 tick 追上。这是草图四项频率规则的直接推论，也是保持
  server 热路径零改动的前提。
- **`RegionError` 不进 pool 分类**：pool 只有 4 种 kind，硬加第五种会污染
  `key_events.kind`、`policy()`、面板 kindText 与既有测试；区域错误由账户徽标
  `region` 承担展示，真实流量代价是每 3s 冷却一次（请求会换号重试，行为可接受）。
- **探针代表 key 取第一个**：多 key 账户若第一个 key 坏而其他好，徽标可能误报。
  不建「按 key 投票」机制 —— 账户 key 数 1-3，探针 tick 15min，误报代价一次探针。
- **billing 正则以 spike 实测为准**：§5.3 正则目标是草图方向，落地第一步必须拿真实
  页面固化为 fixture 再写解析。
- **不做**：手动触发探针端点、账户级用量明细页、keys 独立表迁移、dashboard 主面板
  加账户区（对外只展示流量是已确认方向）。

---

## 9. 账号级模型白名单（allowedModels，2026-08-14 上线 d1083b8）

账户级 `allowedModels` 在全局白名单（`ALLOWED_MODELS`，代码常量）之上再收紧
单个账号可用模型；选号时两者取交集（账号不能突破全局底线）。

- **PATCH `/__admin/api/accounts/:id`** body 加 `allowedModels?: string[] | null`：
  ≤ 50 项、空串项剔除（admin.ts:155-159、250-262）。
- **update() PATCH 语义**（accounts.ts:269-282）：`null`/空数组 = 清除回全局默认；
  **只有 patch 显式含 allowedModels 才更新内存 allowedCache** —— 否则不含白名单的
  PATCH（改 cookie/name/kind/workspaceId 常见操作）会把内存缓存静默清成 null
  （d359338 修的「白名单缓存清空」回归，见 accounts.ts:277-282 注释）。
- **拒绝路径**：postUpstreamChat 选号时 `allowedModelsOf(accountId)` 过滤
  （server.ts:1788-1791），白名单外明确 400（`resolveModel` 不再静默回落）。
- 空数组/全空项 = 清除；缓存懒加载重建（重启后从 DB 读）。

## 10. 分发密钥（tokens，2026-08-13 上线 90164db）

- **端点**：`/__admin/api/tokens` 全套（server.ts:1011-1142）：GET 列表 /
  POST 批量创建（1-10）/ PATCH 改名/状态/备注/rpmLimit / DELETE / GET stats。
- **tokens.ts**：`tk-` + 64 hex 生成；库内只存 `sha256(token)` 前 24 hex 指纹
  （校验全程无解密）；**token 明文仅创建响应出现一次**（面板 overlay 只显示一次）。
- **明文加密存储**：自定义 `sk-` 值 create 时 AES-256-GCM 加密落库
  （tokens.ts:220-230）；补录旧 key 走 `tokenPlain`（server.ts:1096-1110）；
  管理面查看/复制 `plainOf`（tokens.ts:149-159）。注意：usagedb.ts:617-621 的
  「token_enc 恒为 NULL」注释已过时。
- **per-key RPM**：`rpmLimit` 列（0 = 不限流，上限 1e6），RpmLimiter 内存滑动窗口
  （ratelimit.ts），数据面每分发 token 请求限流（超限 429）。
- 用量聚合按 `requests.token_fp`（取 cost_micro_cents，不自己定价）。

## 11. legacy 通道（旧版控制台，opencode.ai）

- **legacy.ts**：SSR 水合 HTML 解析三个页面（keys 列表 / GO 订阅+三窗口用量 / billing），
  `/_server` 写通道（创建/删除 key、setGoToggle）。key 明文绝不出模块。
- **服务端 TTL 缓存（2026-08-14，d359338）**：
  - `LegacyPlainCache` 15min（legacy.ts:195）：keys/plain 端点的明文缓存
    （main.ts 适配器每次成功抓取后填充，get 惰性过期，账户上限防膨胀）。
  - `LegacyTtlCache` 30s（server.ts）：keys 列表 / go 状态 / billing 三读端点
    服务端缓存（createApp 内建，只缓存成功响应，写操作成功/账号删除 clear，
    条目存 ws，切换 workspace 不命中旧数据）——面板详情 2s tick 不再每轮打上游 HTML。
  - 前端另有 TTL 门（admin.ts legacyDetailFresh/legacyDetailMark，成功渲染才打点，
    失败保留 2s 自愈重试）。
- 详情端点：`/__admin/api/legacy/account/:id/{keys,go,billing}` + 写操作 + `/keys/plain`。
- **go 开关契约（2026-08-15 改）**：`PUT /__admin/api/legacy/account/:id/go-toggle`，
  body 只带被切换键 `{useBalance?}|{chinaModels?}`（原 `POST /go/use-balance` 已弃用）；
  失败回滚 + sticky 保留。zen API 无「中国区模型」开关字段，go 端点合并数据源
  （zen 窗口 + cookie HTML 开关，`mergeLegacyGoStatus`）。

## 9. 上线与运维注意

- `data/secret.key` 与 usage.db 同在 data/，已 gitignore、不随 deploy 覆盖。
  **备份含 data/ 目录**；secret.key 丢失 = 账户 keys/cookie 全部无法解密
  （env 种子会重建默认账户，但自定义账户与 cookie 需重新录入）——写进 DEPLOY.md。
- 首启日志新增两行：`[proxy] secret: data/secret.key (auto-generated | from env)`、
  `[proxy] accounts: N (env-seeded | from db | off: <reason>)`，供部署核对（沿用
  「最该盯启动日志那一行」的传统）。
- 线上 Node v22，`node:crypto` 的 GCM 无兼容问题；`AbortSignal.timeout` Node ≥17.3 可用。

## 10. 实现状态（2026-08-11 晚，579 tests 全绿）

**已实现**：secrets/accounts/billing/admin 四新模块 + keypool(key 归属+热加载) +
errors(classifyAccountError+AuthError 一致化+reset clamp+stripSecrets) +
keyprobe(账户驱动) + server(/__admin+/__metrics accounts 段+Host 白名单) + main 接线。
本地实机验证：启动日志两行、鉴权矩阵（直连/cf 头/key）、Origin 403、DNS rebinding
防护、创建账号热加载（池 3→5）、探针账户驱动写账、/__metrics accounts 段仅管理可见。

**对抗审查（@reviewer）发现并已修**：M1 DNS rebinding 击穿管理面鉴权（Host 白名单
校验，≤10 行）、M2 AuthError 双表结论相反（补 auth 分支+一致性测试）、m4 畸形 %zz
指纹 500→400、m5 reset 无上限 clamp 30 天、m6 跨账户重复 key 冲突 400、m8 公网
accountId 剥离、m9 billing 端点读 body、m10 BILLING_INTERVAL_MS 支持 0、m11
updateAccount 存在性校验、m12 上游原文脱敏 stripSecrets。

**未做/待办**：
- **billing spike（M3）**：解析器正则从未见过真实页面。上线前需真实 cookie 抓
  opencode.ai/workspace/{id}/billing 固化为 fixture（§5.4 步骤），否则余额可能
  静默不显示。当前功能标注实验性。
- 真实余额的主动刷新只验证到「抓取+解析失败」路径（fake cookie 502）。
- m7 修正：公网无 accounts 段的断言已补测试（store 接线 + dashboardPublic 模式）。

## 11. 第八轮：UI 重构 + OAuth device flow（2026-08-11 晚，628 tests 全绿）

### UI（用户要求，opencode 控制台风格）
- 顶部 tab：总览/账号/用量/设置（sticky，选中 accent 字色 + 底部 2px 横条）
- 左侧 sidebar 240px（active 加粗 + 2px 竖条，hover 字色；≤48rem 收成横滚子导航）
- 下拉菜单（opencode dropdown：160px/border/radius-sm/shadow/data-selected accent-alpha；语言切换 + 账号 ⋮ 操作菜单）
- 用量 tab：summary 统计卡 + key 池 + 最近 30 条事件（吃 /__metrics）
- OAuth 登录弹层：验证 URL（复制按钮）+ 设备码大字 + 倒计时 + 轮询状态 + 错误重试

### OAuth（官方 CLI 同款 device flow，实测跑通）
- 端点：POST /__admin/api/oauth/start | /poll（isAdminRequest + Origin 校验）
- start：console.opencode.ai/auth/device/code → 会话（内存 Map，上限 10，过期清理）
- poll：token 端点 → 并发拉 /api/orgs + /api/user → 自动建账号（email 命名、
  Org.id 即 workspaceId）→ refresh_token AES 加密落库（oauth_refresh_enc 列）
- 实测成功：`[oauth] account=dwgx1337@outlook.com ws=org_01KZPQ6GSTS0H24ARVQCD8ZNBM created (id=2)`
- 关键协议事实（源码确认）：/api/orgs 返回裸数组 [{id,name}]（Org.id=workspace id）；
  email 在 /api/user；verification_uri_complete 是相对路径（官方拼 server base）

### 对抗审查修复（reviewer 二轮）
- M1 verification URL 劫持 → 域名白名单校验（opencode.ai/opencode.dev/consoleUrl，fail-closed）
- M2 2s 轮询清空编辑输入 → render 指纹比对（排除 retryInMs/recoverInMs，data-rc 自走）
- M3 HTTPS 反代 Origin 403 → hostname+端口归一比较（不比较 scheme）
- m1 orgs 失败丢 token → refresh_token 暂存会话，重试走 refresh grant
- m2 start 无限流 → 会话上限 10；m3 相对路径零测试 → 补 5 组 URL 用例
- m6 degraded 双重转义 → textContent 不再 esc
- 留待下轮：slow_down 放慢轮询（RFC 8628）、上游响应体 1MB 上限

## 12. 第九轮：控制台功能搬移（2026-08-11 深夜，710 tests 全绿）

### 重大调研突破（spike 实测）
线上控制台已改版为 **REST API**（源码 dev 分支的 server functions 结构过时）：
- 鉴权：cookie 会话（新版 `__Host-console_session`，旧版 `auth`）+ **x-org-id 头**
- 全部读端点实测：/api/billing/status（余额，microCents 字符串）、billing/{account,
  ledger,invoices,auto-recharge,payment-methods,payment-attempts,seat-billing,
  named-person-billing}、usage/{summary,cost-by-day,rows,models,users}、
  budgets/{org,users/*,service-accounts/*}、members、service-accounts、providers、
  orgs/{current,overview}、access/invites
- 单位：microCents（1e8 = $1），响应是字符串

### 实现（3 路并行 + 集成修复）
- src/console.ts：ConsoleClient（REST 调用 + x-org-id + 30s 缓存 + generation
  防 invalidate 竞态 + 健康态 cookieStatus/lastError + microCents 换算 + 写操作 4 个）
- src/cookie.ts：CDP 从本机共享 Chrome 导入会话 cookie（优先 __Host-console_session
  兜底 auth，返回完整 name=value）
- server.ts：console 读 6 端点 + 写 4 端点（confirm 语义 + Origin 校验 + 金额上限
  100 万 + admin_audit 持久审计表）+ import-cookie
- admin.ts UI v3：账号详情视图（余额 hero/用量 24h-7d/自动充值/预算/成员/服务账号/
  提供方 + cookie 导入/粘贴 + 写操作 confirm 弹层 + 双击锁）+ 设计差距 10 项修复

### 对抗审查（二轮）2 blocker + 4 major 全修
- B1 cookie 格式冲突（billing/console 两通道只能活一个）→ 统一完整 name=value 落库
- B2 前端 auto-recharge 缺 confirm 字段（功能 100% 失效）→ 补 confirm:true
- M1 import-cookie 绕过 Origin（CSRF）→ 分派前统一校验
- M2 invalidate 与 in-flight 读竞态 → 账户 generation 计数
- M3 user 预算假按钮 → 渲染「未接入」；M4 审计不持久 → admin_audit 表
- M-1~M-9 全部修复（金额上限/未知态显示/双击锁/invalid 短路/saId 解码/非 auth 不置失效/tick 节流）

### 实测
- CDP 导入真实 cookie → console 端点真实数据全通（余额 $0/成员 dwgx1337/OpenCode 60 模型）
- 面板详情视图完整渲染 0 错误
- **遗留**：写操作 POST 路径/参数形状未经验证（upstream_error）——需用户在实际
  控制台页面操作时抓包核对（自动充值/月限额/建删服务账号）
