# 架构

## 为什么存在

Claude Code 和 Anthropic SDK 只会说 Anthropic Messages 协议。DeepSeek 便宜、
上下文大，但它的 Anthropic 兼容层有一批硬性差异（见 [DEEPSEEK-QUIRKS.md](DEEPSEEK-QUIRKS.md)）。
这个网关吃掉差异，让两边都不用改。

顺带暴露 OpenAI Chat Completions 端点，让 OpenAI 客户端也能用同一个上游。

## 部署形态（2026-08-15 去盾后）

```
客户端 → FurCDN（cdn.taipei，边缘缓存/加速）→ 网关 0.0.0.0:8787（直连，无盾）
```

2026-08-15 起 Python 护盾（kiro_shield.py）退役停用，网关自己监听 `0.0.0.0:8787`
（原盾端口），FurCDN 直连网关，链路中不再有盾。盾的失败重试/并发闸门职责由
网关自身兜住（数据面并发在飞上限 + 错误分级冷却）。盾文档保留在
[SHIELD.md](SHIELD.md) 供回滚/参考。

## 上游协议：为什么走 OpenAI

**2026-08-09 改造。** 上游 opencode Zen 同时提供两套端点，但只有 OpenAI 那套可用：

| 能力 | `/v1/chat/completions` | `/v1/messages` |
|---|---|---|
| 工具调用 | `finish_reason: tool_calls` + 完整 tool_calls | `stop_reason: null`，`content: []` |
| content 字符串 | 接受 | 报 `Empty input messages` |

Claude Code 强依赖工具调用，所以 Anthropic 那条路实际不可用。现在统一从
OpenAI 出去，`/v1/messages` 走 Anthropic → OpenAI → 上游 → Anthropic。

端点还分订阅与按量：`-free` 后缀模型只在 `/zen`（按量）存在，其余走 `/zen/go`
（订阅，响应带 `cost: "0"`）。`resolveUpstreamBaseUrl` 按后缀选。

新增模块（2026-08-09）：`upstream.ts`（OpenAI 上游客户端 + 模型清单）、`toOpenAI.ts`
（Anthropic 请求 → OpenAI）、`toAnthropic.ts`（OpenAI 响应/流 → Anthropic）、
`keypool.ts`（多 key 池）、`keyprobe.ts`（空闲 key 主动探活）、
`usagedb.ts`（用量持久化，SQLite）、`metrics.ts` + `dashboard.ts`（监控面板）。

2026-08-12~14 又新增多账号管理面全量模块（见下方模块表）：`admin.ts`（管理面
路由 + 面板 HTML）、`accounts.ts`（多账号存储）、`console.ts`（新版控制台通道）、
`legacy.ts`（旧版控制台通道）、`oauth.ts`（OAuth 登录）、`tokens.ts`（分发密钥）、
`settings.ts`（热配置）、`modelmap.ts`（模型映射持久化）、`ratelimit.ts`（per-key
RPM）、`secrets.ts`（AES-256-GCM 加密）、`billing.ts`（余额抓取）、`cookie.ts`
（Chrome cookie 导入，仅本机开发）、`compact.ts`（实验性压缩）、`shutdown.ts`
（优雅关停）。

## 两条独立路径

关键设计：两个入口端点走**完全不同**的代码路径。这是最容易理解错的地方。
注意 2026-08-09 改造后 **chat 路径不再做协议转换**（上游本身就是 OpenAI
协议），只有直通路径做完整双向转换（见下方两条 handler：handleChatCompletion /
handleMessagesPassThrough，均在 [server.ts](../../src/server.ts)）：

```
前置链路（两条路径共用，顺序即执行顺序，server.ts 实测）：
  并发在飞上限（2026-08-14 新增）：只数 /v1/chat/completions 与 /v1/messages
    → 计数覆盖整个请求生命周期（响应写完/连接断开才释放）
    → 超限 503 { overloaded_error } + Retry-After: 1 + 消费请求体（防 keep-alive 污染）
    → MAX_CONCURRENT_REQUESTS env 配置，默认 400；count_tokens / models 本地轻量不限
    → 超限记 ctx.error 落 metrics + requests 表（与 RPM 429 同口径）
  → 鉴权（API_KEYS 常量时间比较 / 分发 token sha256 指纹，fail-closed）
  → per-key RPM 限流（只对分发 token 生效，ratelimit.ts 60s 滑动窗口，超限 429）
  → 模型门（全局白名单 + 账号级 allowedModels 过滤，白名单外明确 400）

/v1/messages（直通，完整双向转换）
  客户端说 Anthropic 协议，上游要 OpenAI 协议
  → validateAnthropicRequest        校验
  → normalizeAnthropicRequest       deepseek 归一化（模型名/thinking/effort/剥 beta 字段/注入 thinking 块）
  → scanMessagesForInjection        注入检测
  → anthropicToOpenAIRequest        协议转换（toOpenAI.ts：tool_result 拆独立 tool 消息等）
  → postUpstreamChat                转发（key 池 acquire + 账号级 allowedModels 过滤 + 失败分级；
                                     无换 key 重试，错误原文直接透传——含 GoUsageLimitError 原样透传）
  → 非流式：openAIToAnthropicResponse        转换回 Anthropic（toAnthropic.ts，含 DSML 兜底）
  → 流式：openAIStreamToAnthropic + filterThinkingFromStream → anthropicEventToSSE

/v1/chat/completions（直发 OpenAI，无协议转换）
  客户端说 OpenAI 协议，上游也是 OpenAI 协议
  → validateChatRequest             校验
  → scanMessagesForInjection        注入检测
  → prepareOpenAIUpstreamRequest    模型映射 + buildSystemGuard 护栏 + 剥扩展字段（logit_bias/
                                     logprobs/top_logprobs/n/seed/user/store/metadata，防上游 400）
                                     + -free 模型剥 tool_choice + max_tokens 下限（见 QUIRKS 6/14）
  → postUpstreamChat                转发（与直通路径共用；非流式未写出响应字节时可换 key
                                     重试一次，excludeKey 排除刚失败的 key——server.ts:2628-2646）
  → 非流式：原样回显（只改 model 名）
  → 流式：parseOpenAISSE → 逐 chunk 回显（只改 model 名）→ [DONE]
```

**deepseek 适配的分布已经不对称**：直通路径的适配集中在
`normalizeAnthropicRequest`（deepseek.ts）；chat 路径因为直发 OpenAI 协议，
只剩「模型映射 + 剥扩展字段」这点工作，不再有 thinking/beta 字段适配。
历史上「改一处必须查另一处」的负担主要落在直通路径内部（deepseek.ts 的
归一化与 toOpenAI/toAnthropic 的协议转换各管一层，DSML 兜底在非流式/流式
两处接线）。见 [ISSUES.md](ISSUES.md) 的 I-3。

**两处实现不对称的第 3 处（2026-08-14 核对补充）**：换 key 重试只在 chat
路径有（非流式、未写响应字节时最多一次，excludeKey），直通路径没有。

遗留的历史模块：`request.ts` / `normalize.ts` / `response.ts` / `stream.ts` /
`tool.ts` / `image.ts` / `usage.ts` / `stopReason.ts` / `parseAnthropicSSE`
（sse.ts）是 2026-08-09 改造前的转换链，server 主路径已不引用（只从
`stream.ts` 用 `sseStringify`、从 `sse.ts` 用 `parseOpenAISSE`），仍通过
`index.ts` 导出并在测试里作为行为契约活着。改这些文件只影响库用户和测试，
不影响网关行为。例外：`compact.ts` 是被 normalizeAnthropicRequest 调用的
**在用**模块（实验性压缩，COMPACT_ENABLED），不在历史链里。

## 模块职责

协议转换核心。注意：**server 主路径实际只用到 toOpenAI / toAnthropic /
dsml / deepseek 的直通链 + sse 的 `parseOpenAISSE`**，其余是改造前遗留的
转换链，经 `index.ts` 作为库导出面活着（供测试与外部引用）。

| 模块 | 职责 | 主路径状态 |
|---|---|---|
| `toAnthropic.ts` | OpenAI 响应/流 → Anthropic。含 DSML 兜底与流式文本缓冲、事件骨架生成 | 在用 |
| `toOpenAI.ts` | Anthropic 请求 → OpenAI（tool_result 拆成独立 tool 消息、image 降级占位） | 在用 |
| `dsml.ts` | 上游把工具调用当文本吐时的兜底解析（怪癖 12），非流式/流式两处接线 | 在用（被 toAnthropic 调） |
| `deepseek.ts` | 直通路径的适配层：模型映射、thinking 归一化、剥 beta 字段、thinking 块注入、流式过滤 | 在用 |
| `sse.ts` | OpenAI/Anthropic SSE 文本流 → 事件对象（`parseOpenAISSE` 在用，`parseAnthropicSSE` 历史） | 部分在用 |
| `stream.ts` | SSE 序列化（`sseStringify` 在用）；转换状态机历史 | 部分在用 |
| `request.ts` | OpenAI 请求 → Anthropic 请求，内联 deepseek 适配 | 历史 |
| `normalize.ts` | 消息序列规整：交替、合并、tool_result 紧跟、id FIFO | 历史 |
| `response.ts` | Anthropic 响应 → OpenAI 响应，json_mode 转 content | 历史 |
| `tool.ts` | 工具结构转换 + schema 消毒 + 工具名消毒 | 历史 |
| `image.ts` | 图片块转换 + SSRF 判定 | 历史 |
| `usage.ts` / `stopReason.ts` | 字段换算 | 历史 |

服务层：

| 模块 | 职责 |
|---|---|
| `main.ts` | 进程入口：装配 config/server/AccountsStore/TokensStore/keyprobe/billing loop，注册 shutdown（SIGINT/SIGTERM）。billing SSR 主循环已停用（新版控制台是 SPA，SSR 解析恒失败，见 main.ts 注释） |
| `server.ts` | 路由、鉴权装配、背压写入、流式连接管理、数据面并发在飞上限、legacy TTL 缓存 |
| `upstream.ts` | 上游转发（OpenAI 协议），三段式超时（120s 响应头 / 90s idle / 非流式 150s 总封顶），key 池集成，幂等 release |
| `keypool.ts` | 多 key 公平轮转、失败分级冷却（只延长不缩短）、指纹脱敏、账号级 allowedModels 选号过滤、被动学习 block |
| `keyprobe.ts` | 空闲 key 主动探活（默认 15 分钟一轮，KEY_PROBE_INTERVAL_MS=900_000；空闲判定 idle > 1h），最小 token 探活，只探健康且长时间空闲的 key |
| `usagedb.ts` | 用量持久化（node:sqlite 零依赖，WAL）：用量批量异步落库（100ms/50 条事务）、history 15s 缓存、key_totals 聚合表（flush 同事务 upsert，读端 O(#keys)）、prune 保留期清理、降级不抛 |
| `config.ts` | 环境变量解析，fail-closed 判定 |
| `errors.ts` | 错误映射 + 控制符剥离 + 上游失败分级 |
| `metrics.ts` | 请求事件环形缓冲（喂面板）+ 改写/剥离/压缩计数（观测 400 改写率、被动压缩触发） |
| `dashboard.ts` | 自带的状态面板（HTML 内联，零依赖） |
| `types.ts` | 两套协议的类型定义 |
| `index.ts` | 库导出面（供测试与外部引用） |
| `admin.ts` | 管理面路由总装 + 面板 HTML（ADMIN_HTML/LOGIN_HTML 内联 JS 零依赖）+ 账户/映射输入校验。server.ts 把 /__admin/api/* 其余分派全交给它（5755 行，最大文件） |
| `accounts.ts` | 多账号面板数据层：账户 CRUD 加密落库、明文 key→accountId 映射、探针/billing 结果写账、buildAccountsSection 快照（/__metrics 与 /__admin 共用）、账号级 allowedModels 缓存 |
| `console.ts` | 新版控制台（console.opencode.ai）REST 数据层：billing/usage/keys/members/budgets 等，读缓存 TTL 30s（M2 竞态防挂起 + in-flight 单飞），microCents（1e8=$1）口径 |
| `legacy.ts` | 旧版控制台（opencode.ai，wrk_ 前缀）数据层：SSR 水合 HTML 解析 keys/GO 订阅/计费，/_server 写通道（创建/删除/开关）。key 明文绝不出模块，LegacyPlainCache 15min TTL |
| `oauth.ts` | OAuth device flow 登录（RFC 8628）：start 拿 device_code、poll 轮询换 refresh_token，refresh 由调用方转 AccountsStore 加密落库。device_code 不落库不落日志 |
| `billing.ts` | 余额抓取（SSR 页面解析，units 整数 1e8=$1）：每 15min tick + 失败退避阶梯（15→120min）。主通道已停用，handleRefreshBilling 兜底路径仍用 |
| `tokens.ts` | 分发密钥系统：tk-+64hex 生成，库内只存 sha256 指纹（96-bit，校验全程无解密），token 明文仅创建响应出现一次；按 token 聚合用量/费用（取 requests.cost_micro_cents，不自己定价）；verify prepared 复用 + 10s 缓存。**配额计费**（2026-08-15，QUOTA.md）：tokens 表配额列（$ 存储 microCents / tokens / requests / cycle / expires_at）+ `settleQuota`（完成时逐口径条件 UPDATE，M3 防并发超额）+ `quotaCheck`（expires→403 / 超限→429）+ `TokenQuotaView` 全美元视图 |
| `money.ts` | 单一金额换算权威（2026-08-15 新建）：`MICROCENTS_PER_DOLLAR`（1e8=$1）+ microCentsToUsd/usdToMicroCents；billing 的 UNITS_PER_DOLLAR 是它的别名，console/accounts/legacy 换算系数收敛到这里（B1 复发面根治） |
| `modelaccess.ts` | 密钥-模型授权 store（2026-08-15 新建，MODEL-ACCESS.md）：model_access 表 getCustom/setCustom/listByType，subject=token 指纹 / api-key sha256 / upstream-key sha256；热路径懒加载缓存 + 写操作失效 |
| `settings.ts` | 设置页热配置：settings 表 + 运行时 apply（env 是默认、settings 覆盖、不重启生效）；apiKeys 数组引用替换、adminPass 密码版本进 HMAC。SETTINGS_META 是唯一真源。配额计费的 `model_prices` 定价表（上游模型名 key，支持 `*` 通配）也存这里（2026-08-15，QUOTA.md §4） |
| `modelmap.ts` | 模型映射持久化层（后台设置页「模型映射」）：model_aliases 表 CRUD，调用方同步进 cfg.modelMap 即时生效；db 挂返回空不抛 |
| `ratelimit.ts` | 每 key RPM 限流器：60 个 1 秒桶滑动窗口，拒绝也计数（防攻击者靠连拒永不占窗），惰性清零 + prune 防 Map 膨胀。全同步无 await |
| `secrets.ts` | 管理面加密密钥：secret.key/GATEWAY_SECRET → sha256 派生 32B，AES-256-GCM（1:<b64(iv‖tag‖ct)>）。任何失败返回 null，加密设施绝不成代理链路故障源 |
| `cookie.ts` | 本机开发场景：CDP（Chrome 9223）导入 console.opencode.ai auth cookie，失败细分原因，cookie 值不进日志 |
| `shutdown.ts` | 优雅关停（SIGINT/SIGTERM）：stop 后台任务 → server.close → closeIdleConnections（不掐活跃流式）→ 5s 兜底 exit(0)；closeDb（flush 最后一批 + WAL）推迟到退出时刻执行（窗口期在途请求还能正常落库） |
| `compact.ts` | 实验性请求体被动压缩（COMPACT_ENABLED）：仅对解析后 content 做无损层（空白折叠 + 超长截断），不碰 JSON 结构。被 normalizeAnthropicRequest 调用（在用） |
| `security/auth.ts` | 常量时间鉴权（API_KEYS 哈希预计算缓存）+ 分发 token 指纹校验 + 面板会话 HMAC |
| `security/validate.ts` | 结构校验 + 长度上限 |
| `security/injection.ts` | 注入启发式检测（入口词根预筛）+ system 护栏 |

## normalize 维护的不变量

以下约束属于历史转换链（`normalize.ts`，库导出面），**不约束当前网关主路径**。
直通路径的等价约束由 `toOpenAI.ts` 承担（Anthropic 协议比 OpenAI 严格得多，
这些约束违反了就 400）：

1. 首条必须是 user（开头的 assistant 被丢弃，随之孤立的 tool_result 也丢）
2. 末条不能是 assistant（追加空 user 占位）
3. 严格 user/assistant 交替（相邻同角色合并）
4. tool_result 必须紧跟产生它的 assistant（所以含 tool_result 的 user
   **不与**普通 user 合并 —— [normalize.ts:173](../../src/normalize.ts)）
5. content 不能为空（空消息跳过；全空时兜一条空 user）
6. tool_use.id 与 tool_result.tool_use_id 一一对应（缺 id 时走 FIFO 队列配对）

## 安全分层

- L0 数据面并发在飞上限：请求入口最顶端（鉴权之前），只数代理路径，超限 503
- L1 鉴权：`API_KEYS` 命中才放行，常量时间比较。空 key + 未开
  `ALLOW_UNAUTHENTICATED` 时全部拒绝（`/healthz` 例外，无需鉴权）
- L2 结构校验：role 白名单、长度上限、消息条数上限、tool_choice 结构
- L3 注入检测：启发式复合信号，`block` 模式只拦 high
- L4 system 护栏：声明历史/工具结果为不可信数据（**只在 chat 路径生效**）

`ALLOW_UNAUTHENTICATED` 只在绑定回环地址时才真正生效
（[config.ts:93](../../src/config.ts) `hostnameIsSafe`），绑 `0.0.0.0` 时强制要求鉴权。

## 管理面与数据层

**管理面板** `/__admin`（admin.ts 单文件内联 HTML，与 `/__dash` 共用登录，
默认 admin/13141516，Origin 校验防跨站表单锁定；**i18n 三语 en/zh/ja**，2026-08-15
ja 全量，check-i18n.mjs 三语言对称核对；账号列表卡片网格 + 总览 KPI 卡化 +
设置页分组 + 详情 5 tab + 性能仪表盘区块 + 数字 spinner，全部内联 JS 零依赖）：

- 登录鉴权：`POST /__admin/api/login`、`POST /__admin/api/logout`、`GET /__admin/api/config`
- 账户：`/__admin/api/accounts/*`（CRUD + `:id/usage-gateway` 网关实际用量 + `:id/keys/plain`
  上游 key 明文复制（H2，admin 会话 + Origin 双校验）+ 明文 key 端点，进程内解密）
- 分发密钥：`GET/POST /__admin/api/tokens`、`PATCH/DELETE /__admin/api/tokens/:id`、
  `GET /__admin/api/tokens/stats`（PATCH 额外接受配额字段 `quotaUsd/quotaTokens/quotaRequests/
  quotaCycle/expiresAt`，2026-08-15 QUOTA）
- key 池管理（2026-08-15）：`GET /__admin/api/keys/usage?rangeDays=N`（全部 key 窗口用量）、
  `POST /__admin/api/keys/:fp/disable` / `:fp/reset`（手动启停，掩码指纹，manual 持久化 / reset 恢复）
- 控制台通道：`/__admin/api/console/*`（import-cookie + account/:id/{billing,workspaces,usage,
  usage/cost-by-day,usage/models,usage/users,members,keys,providers,budgets,budgets/users-status,models-pricing}）
- 旧版通道：`/__admin/api/legacy/*`（account/{id}/... keys/go/billing，服务端 TTL 缓存
  LegacyTtlCache 30s；`account/:id/go-toggle` 改 **PUT** 且 body 只带被切换键
  `{useBalance?}|{chinaModels?}`，2026-08-15 契约；`GET /__admin/api/legacy-key/:id/plain`
  旧版 key 明文复制）
- 模型授权（2026-08-15，MODEL-ACCESS.md）：`GET /__admin/api/model-access`（全局+各 key 授权全量，
  含 pricing 可选项）、`PUT /__admin/api/model-access/global`（settings allowedModels，可任意模型名）、
  `PUT /__admin/api/model-access/keys/:type/:subject`（token/api-key/upstream-key 自定义授权）
- 热配置：`GET/PATCH /__admin/api/settings`、`GET /__admin/api/settings/keys/:index/plain`
- 审计/请求：`GET /__admin/api/audit`、`GET /__admin/api/requests`、`GET /__admin/api/requests/stats-by-ip`、
  `GET /__admin/api/overview/trend`
- 模型：`POST /__admin/api/models/refresh`（订阅目录定时刷新 + 手动）、`PUT/DELETE /__admin/api/model-aliases/:alias`
- OAuth：`POST /__admin/api/oauth/start`、`POST /__admin/api/oauth/poll`
- 性能面板（2026-08-15）：`GET /__admin/api/performance`（进程 RSS/CPU/负载/并发门/延迟分位/池状态，
  10s TTL 缓存 + 延迟查询 LIMIT 1000 防扫描）
- OTA（2026-08-15，OTA.md）：`GET /__admin/api/update/check`、`POST /__admin/api/update/perform`

**数据面端点**：`POST /v1/chat/completions`、`POST /v1/messages`、
`POST /v1/messages/count_tokens`（本地估算不转上游，只落库不进内存指标）、
`GET /v1/models`（别名 + 白名单真名合并）、`GET /healthz`（免鉴权）、
`GET /__metrics`、`GET /__dash`。

**数据层表**（usagedb.ts migrate 全表）：

| 表 | 内容 |
|---|---|
| `requests` | 请求明细（at/key_fp/model/endpoint/status/tokens/path/ua/client/ip/cost/token_fp；idx key_fp+at、at、token_fp） |
| `key_events` | key 状态变更（disabled/cooldown，探活观测） |
| `admin_audit` | 管理面操作审计（op/account_id/ok/note/ip，脱敏摘要） |
| `accounts` | 多账号（keys_enc/cookie_enc/oauth_refresh_enc 加密、allowed_models 账号级白名单、legacy_workspace_id） |
| `settings` | 热配置（key-value，settings.ts 唯一真源 SETTINGS_META） |
| `tokens` | 分发密钥（fingerprint sha256 前 24 hex、token_enc 按 DDL 保留恒 NULL、rpm_limit、**配额列**：quota_usd/quota_tokens/quota_requests/quota_used_*/quota_cycle/quota_reset_at/expires_at，2026-08-15 QUOTA.md §1） |
| `model_access` | **2026-08-15 新增**：密钥-模型授权（subject_type token/api-key/upstream-key + subject_id sha256 + models JSON，行存在=已配自定义，MODEL-ACCESS.md） |
| `model_aliases` | 模型映射（alias UNIQUE） |
| `key_totals` | **2026-08-14 新增**：按 key 累计 requests/ok/failed/input/output_tokens/last_at/min_at 聚合表；flush 同事务 upsert（口径与 byKey 一致），prune 随 requests 窗口重建，旧库升级时按 requests 现存量初始重建 |

另有两个进程内持久化小文件（`data/`，原子写，2026-08-15 绊脚石轮）：
- `data/pool-disabled.json`：keypool 冷却持久化（`{fp:{until,reason}}`，重启恢复禁用；manual/auth/
  quota-exhausted 才持久化，reapRecovered/reset 清除；旧 `{"fp":ts}` 格式兼容迁移）
- `data/revoked-sessions.json`：已撤销面板会话（重启后仍生效）
