# 分发密钥配额计费设计（QUOTA）

对标：sub2api（完成时结算、原子 UPDATE、失败不扣）× new-api（预扣→结算→退款、精确不超支）。
我们的约束：零依赖 + node:sqlite 单写者 + flush 批量落库 + 已有四级模型授权链 + RPM。

## 核心决策

### 1. 配额字段（tokens 表新增，migrate 幂等补列）
```
quota_usd         REAL     -- $ 配额，0 = 无限。**存储 microCents**（1e8 = $1，B1 修复）
quota_tokens      INTEGER  -- token 配额（M 单位输入？不——按实际 token 数），0 = 无限
quota_requests    INTEGER  -- 请求数配额，0 = 无限
quota_used_usd    REAL     -- 已用（microCents，与 cost_micro_cents 同单位）
quota_used_tokens INTEGER  -- 已用 token 数（input+output+缓存读，thinking 已含 output）
quota_used_requests INTEGER -- 已用请求数
quota_cycle       TEXT     -- none | daily | monthly（周期重置）
quota_reset_at    INTEGER  -- 周期窗口起点（跨周期结算时归零 used + 刷新起点；**cycle 值变化时无条件刷新**，MINOR m2）
expires_at        INTEGER  -- 过期时间，0 = 永不过期
model_limits      TEXT     -- 逗号分隔模型白名单，空 = 继承账号级/全局（复用现有四级链）
```
- **单位约定（B1 修复，2026-08-15）**：`quota_usd` 列与 `quota_used_usd` **同单位 microCents**
  （1e8 = $1）。API/UI 入参是**美元**（面板 step=0.01 输入），存储边界 ×1e8；list/get
  视图 ÷1e8 回美元。校验（`usedUsd >= quotaUsd`）与结算两侧都是 microCents，不存在
  1e8 倍单位错配。**旧数据风险**：B1 上线前落库的 `quota_usd` 是美元语义，会被按
  microCents 解读（数值变小 1e8 倍）——功能当日上线、生产无存量配额 key，未做迁移，
  如需旧数据请手动 ×1e8。
- **视图层全美元输出（2026-08-15，B1 复发面根治）**：`TokenQuotaView`（tokens.ts）改为
  **全部美元**——`quotaUsd` / `usedUsd` / `remainingUsd` 都是美元，且服务端把
  `exhausted` / `expired` / `remainingUsd` 按校验口径（computeQuotaStatus）**算好下发**，
  前端不再手写 ×1e8 比较。`remainingUsd` 在 quotaUsd=0（无限）时为 null。内部存储
  microCents 不变（只改视图层输出）。换算单一权威在 `src/money.ts`（MICROCENTS_PER_DOLLAR
  + microCentsToUsd / usdToMicroCents），billing 的 UNITS_PER_DOLLAR 是它的别名，
  console/accounts/legacy 的换算系数统一收敛到它。
- **旧数据迁移（待接）**：存量旧美元语义 `quota_usd` 无法可靠自动判别（值看起来合法）。
  如需要迁移，实现在 `src/tokens.ts` 加 `migrateLegacyQuotaUsd(db)`（按「值为 microCents
  量级但用户确认曾按美元录入」条件 ×1e8），并在 usagedb 迁移里显式调用；未实现前靠
  手动 ×1e8。读取后果已用 tokens.test.ts「B1 旧数据读取」测试文档化。
- 三种口径独立判定：谁先满谁拒（任一超限即 429）。
- count_tokens / probe 不消耗配额（对齐现有聚合口径）。
- **model_limits 复用现有 model_access 的 token subject 自定义**（已有！不重复建表）——面板已有 token 级模型编辑。

### 2. 扣减：完成时同步条件 UPDATE（sub2api 式，不走 flush）
- 请求完成后立即 `UPDATE tokens SET quota_used_* = quota_used_* + ? , quota_reset_at = CASE WHEN 跨周期 THEN now ELSE quota_reset_at END, quota_used_* = CASE WHEN 跨周期 THEN 0 ELSE quota_used_* END WHERE fingerprint = ?`。
- **M3 条件防超支（并发 N 倍超额修复，2026-08-15）**：settle 改为**逐口径独立条件**
  UPDATE —— `limit=0` 不限制；`quota_used_* < limit` 才累加；**已超限的该口径不再扣**
  （其他口径照常扣）。verify 有 10s 缓存，N 并发可同时通过校验，但 settle 串行化
  条件更新把已受理请求封顶在配额内（单请求生命周期内的小额超额仍可接受，N 倍
  超额被消灭）。被跳过的口径记 warn 日志（requests 表已落该请求，可审计）。
- SQLite 单写者串行化 = 天然原子；条件更新防超支（超限请求仍落 requests 表 status=429 可审计）。
- **不做预扣**（new-api 式）：预扣需估算 tokens 且要结算/退款状态机，我们完成即知真实用量，扣一次无误差。
- 结算后对该 key 的 verify 缓存即时失效（现有「写操作失效」机制）。
- 在飞请求可小额超额（单请求生命周期内），个人/小团队分发可接受；极端场景可加「在飞计数粗估」退化。

### 3. 校验：verify 时同步（数据面请求开始）
顺序（现有 status/过期检查之后）：
1. `expires_at` 过期 → 403（或 401，客户端兼容优先 401 语义？——定 403，与 new-api 对齐）。
2. `quota_used_*` 任一口径 ≥ 上限 → **429 insufficient_quota**（OpenAI 形状）/ Anthropic 路径包 Anthropic error 形状。
3. `model_limits`（model_access token subject）不含请求模型 → **400 "is not allowed"**（保持现状，盾已把该文案当确定性拒绝快速收敛，勿改 403 重引 90s 风暴）。

### 4. $ 口径（真实计费）
- `cost_micro_cents`（上游记账，1e8 = $1）是**真实成本**，但**订阅端点恒 0**（只有 -free 按量端点非零，实测）。
- **$ 配额扣减口径**：
  a. `cost_micro_cents > 0` → 用上游真实成本（-free 模型真实扣费）。
  b. `= 0`（订阅模型，deepseek-v4-flash 等主流量）→ **定价表兜底**：`input/1M × inPrice + output/1M × outPrice + cachedRead/1M × readPrice + cachedWrite/1M × writePrice`（v2/config 上游同源定价，10min 缓存；未来可 settings `model_prices` 覆盖）。
- tokens 配额 = input + output + 缓存读（thinking 已折进 output，勿再加）。
- **M2 缓存读口径（2026-08-15）**：Anthropic 路径的 `cache_read_input_tokens` 单独计入
  —— $ 定价补 `cachedRead × readPrice`（read 字段此前已存在但未用），tokens 口径补回
  cacheRead。chat 路径的 prompt_tokens 已含缓存、cacheRead=0（不双算）；两条路径
  「总输入」一致（chat = prompt + output；messages = (prompt−cached) + cacheRead + output）。
- 定价来源优先级：settings model_prices（可配）→ v2/config 缓存（上游同源）→ 无则 0（只记 token/requests 配额）。
- **m3 文档提示（2026-08-15）**：`model_prices` 的 **key 必须是上游模型名**（非客户端
  别名）—— settle 侧 `resolveModelPrice` 用 `ctx.upstreamModel || ctx.model` 查表，
  客户端请求的别名（如 gpt-4o）映射到上游后才有价格命中。
- **MINOR m1（2026-08-15）**：`model_prices` 校验放行 `'*'` 通配键（`resolveModelPrice`
  一直有 `modelPricesCache['*']` 兜底分支，校验层曾拒绝落库）。

### 5. 超限行为
- 429 + Retry-After（复用现有 RPM 429 路径）；type：OpenAI `insufficient_quota`，Anthropic `rate_limit_error`。
- 超限请求落 requests 表（status=429）——面板可见拒绝计数。
- **m4 文档提示（2026-08-15）**：上游故障（502/超时等）的**已受理请求同样消耗配额**——
  settle 只在真实转发到上游（`ctx.keyFingerprint !== ''`）后结算，上游故障也照实结算；
  这是设计取舍（避免「上游故障免费蹭」），已受理照实扣，请求的失败状态在 requests 表可见。

### 6. 周期重置
- none（不重置）/ daily / monthly。结算时判断跨周期（quota_reset_at 过期）→ 同事务归零 used + 刷新起点（仿 sub2api 滚窗 SQL）。
- **MINOR m2（2026-08-15）**：PATCH 切 cycle（值变化，如 none→daily 或 daily→monthly）
  时**无条件刷新 quota_reset_at = now** —— 窗口起点必须是切周期的时刻，否则窗口被错误
  拉长（旧实现只在 reset_at=0 时刷起点，token 创建即定起点，切 cycle 后不生效）。
  同值 PATCH（daily→daily）不刷新。

### 7. 面板 UI（密钥页）
- 每 token 配置：quotaUsd / quotaTokens / quotaRequests / quotaCycle / expiresAt / modelLimits（复用 token 模型编辑）。
- 列表显示：已用/剩余（$ / tokens / 请求）+ 状态（正常/已耗尽/已过期）。
- i18n en/zh 对称；明文 token 只在创建时显示（现状保留）。

## 分期
- M1：quota_usd + expires_at + 校验 + 结算 + 面板配置/显示。
- M2：quota_tokens / quota_requests + quota_cycle 周期重置 + model_limits 展示整合。
- 每项配回归测试（去掉修复会红）。完成对抗式 review。

## 关键不变量
- 超限 429 不进「错误分类冷却」链（quota-exhausted 是客户端配额，不是上游 key 冷却——与 keypool 的 quota 冷却无关，分发 key 配额独立）。
- 结算失败（DB 写失败）不阻断请求链路（降级：本次不扣，下次结算补？——记录，不抛）。
- count_tokens/probe 不消耗任何配额。

## M1+M2 实现同步（2026-08-15）与设计偏离

已实现：配额列迁移（usagedb.ts `ensureTokensQuotaColumns`）、create/patch/list 配额读写、
`TokensStore.settleQuota`（三口径独立累加 + 跨周期滚窗）、`quotaCheck`（expires→403 /
超限→429）、server 数据面接线（checkTokenQuota + finally settle）、settings `model_prices`
定价表。偏离设计处如实记录：

1. **定价表 fallback（§4）**：只实现 settings `model_prices` 为主、无则 0 兜底。
   v2/config 上游同源定价 fallback **未接** —— 需要改 console.ts（本轮不在改动清单内），
   且 settle 路径（finally）没有可靠的账户上下文（分发 token 不绑定 account id，
   keypool 只支持 key 明文 → accountId 反查，settle 只有指纹）。后续要接：给
   ConsoleClient 加缓存只读访问器 + server 侧按池内代表账户读。
2. **settle 的口径（§2）**：**只对真实转发到上游的请求结算**（`ctx.keyFingerprint !== ''`）
   —— verify 拒绝的请求（401/403/429）不消耗配额（避免耗尽 token 被拒绝时请求数配额
   继续涨）。这也让 count_tokens / /v1/models 天然不结算（前者 endpoint 过滤、后者不选
   key）。**M3 修复（2026-08-15）**：settle 从「无条件累加」改为「逐口径条件 UPDATE」——
   已超限口径不再扣（其余口径正常扣），并发 N 倍超额被封顶；已受理请求仍照实结算
   （在额度的 `quota_used_* < limit` 内），单请求小额超额语义不变。
3. **$ 计价的 read/write 项（§4 公式）**：**M2 修复（2026-08-15）**：read 价已生效 ——
   Anthropic 路径的 `cache_read_input_tokens` 单独计入 settle（$ 补 `cacheRead × readPrice`，
   tokens 口径补回 cacheRead）。write 仍不入账（上游用量不区分 cache write）。
4. **tokens 口径与 SCALE_CLIENT_TOKENS**：settle 用 ctx.inputTokens/outputTokens
   （与 requests 表/面板观测同源）。实验开关开启时该值为缩放后数字，token 配额随之
   缩水 —— 默认关闭，接受该失真（不另开 real-usage 通道）。
5. **monthly 滚窗**：自然月同日；目标月无该日（如 1/31 → 2 月）钳到当月最后一天，
   不用 JS `setUTCMonth` 溢出翻月（1/31 → 3/3 会把窗口拉长一个月）。
6. **quotaCheck 缓存**：配额列随 verify 同一次点查缓存（10s TTL，复用 verifyCache），
   settle/update 即时失效。跨周期窗口在 quotaCheck 读缓存时按 used=0 重算 —— 窗口
   到期后第一个请求在 verify 阶段即按未超限放行，随后 settle 真正归零（≤10s 误阻窗口
   可忽略）。
7. **API 字段命名**：`quotaUsd / quotaTokens / quotaRequests / quotaCycle / expiresAt`
   （camelCase，ms 纪元；0 = 无限/永不过期）。model_limits 未建列 —— 复用现有
   model_access 的 token subject（getCustom，server 层模型门已接，无需新增）。
8. **model_prices settings**：不写进 AppConfig（config.ts 不在改动清单），settings
   GET/PATCH 正常校验存储，settle 时按需读（5s TTL 缓存）。

## §8 M1 流式断开估算（对抗审查 2026-08-15）

**问题**：流式客户端中途断开（res close → controller.abort），usage 尾 chunk（含
prompt/completion/cost）读不到，`ctx.outputTokens` 停在 0/旧值 → settle 按 0 扣
（少收绕过面：客户端停生成/断网即免单）。

**修**：chat / messages 两条流式路径累计**已回显给客户端的文本字符数**
（`streamedText`），断开时按 `Math.max(已记 outputTokens, textChars/4)` 兜底
（textChars/4 估算约 4 字符/token，复用 stream.ts `Math.ceil(textChars/4)` 机制）。
chat 路径计入 delta.content + reasoning_content；messages 路径计入 text_delta /
thinking_delta / input_json_delta。

**语义**：这是**估算下限**（客户端实际已收到的文本不会比记录更多），只在已记
outputTokens 更低时覆盖；正常完成（读到 usage）不受影响。cost（$ 口径）断开时
拿不到上游记账 → 走定价表兜底（input×in + output×out + cacheRead×read），已含
估算 output。

## §9 状态与关联契约（2026-08-16 同步）

- **B1/M1/M2/M3 + 3 MINOR 全部修复落地**（2026-08-15，见 §8 与上文 §1/§2/§4/§6
  各条目）；全量测试 + 部署上线。旧数据风险（B1 前美元语义 `quota_usd`）生产无存量
  配额 key，未迁移。
- **同批 UI 重构的 legacy go-toggle 契约**（2026-08-15，非配额范围，记录在此防查漏）：
  前端 change 委托改走 `PUT /__admin/api/legacy/account/:id/go-toggle`，body 只带被
  切换键 `{useBalance?}|{chinaModels?}`（原 POST `/go/use-balance` 已弃用）；失败回滚
  + sticky 保留。服务端实现见 server.ts `runLegacyGoToggle`（测试覆盖）。
