# fuckopencode

OpenAI ↔ Anthropic 协议转换网关，面向 DeepSeek。

把便宜的 DeepSeek 模型（`deepseek-v4-flash`，100 万 token 上下文）包装成 Anthropic Messages API 兼容端点，同时暴露 OpenAI Chat Completions 端点。Claude Code、Anthropic SDK、任意 OpenAI 客户端，通过一个网关直接使用 DeepSeek，无需关心两种协议之间的差异。

## 特性

- 零运行时依赖的纯 TypeScript 转换核心（strict 模式、零 any）
- OpenAI ↔ Anthropic 双向协议转换
- DeepSeek 思考协议深度适配：
  - `thinking: adaptive` → `enabled` 归一化（Claude Code 默认发 `adaptive`，DeepSeek 直接 400）
  - 多轮工具自动注入 thinking 块（DeepSeek 要求 reasoning 回传，否则间歇 400）
  - `thinking: disabled` 时剥除响应流中多余的 thinking 事件
  - `reasoning_content` ↔ `thinking` 块双向映射
  - `reasoning_effort` 透传
- JSON mode：`response_format` 原样透传给上游（OpenAI 端点原生支持，
  不再经工具强制转换）
- 流式转换逐事件打磨：`reasoning_content` 增量、usage 独立尾 chunk、背压、`[DONE]`
- 多轮工具稳定：`tool_use` / `tool_result` id 一一对应（FIFO）
- 生产级安全：常量时间鉴权、提示词注入检测、SSRF 防护（含 IPv6）、CSRF、背压、内部错误不泄漏
- 多账号管理面板（`/__admin`）：账号 CRUD、分发密钥（per-key RPM 限流）、
  热配置（settings 表，运行时生效不重启）、操作审计、请求明细/搜索、IP 统计、
  用量趋势、OAuth device flow 登录
- 数据面并发保护：`MAX_CONCURRENT_REQUESTS` 在飞上限（默认 400），超限
  503 + `Retry-After`
- 模型白名单双层防线：全局白名单（仅 `deepseek-v4-flash` 两个变体，白名单外
  明确 400）+ 账号级 `allowedModels`（面板可配）
- 生产级安全：AES-256-GCM 加密落库（账户 key / billing cookie / 分发 token）、
  请求日志凭证脱敏（`sk-*` / `Bearer` / `auth=Fe26.*`）、面板登录限速 +
  Origin 校验、默认密码告警（`adminPassIsDefault` 徽章）
- 完整单元/集成测试覆盖 + 真实上游端到端验证

## 快速开始

### 一键部署

clone 仓库（上游 `dwgx/fuckopencode` 或你自己的 fork）后运行安装脚本：

```bash
git clone <仓库地址>
cd fuckopencode
./scripts/install.sh
```

`scripts/install.sh` 支持两种模式：`release`（默认，从 GitHub release 下载预构建
dist tarball，服务器不需要 npm/tsc）与 `source`（本机构建源码）。需要 **Node >= 22**。

装完复制模板配置并按需修改：`cp .env.example .env`，必填项只有
`API_KEYS`（调用方 key）+ `OPENSEA_KEYS` 或 `ANTHROPIC_API_KEY`（上游 key）。

### 手动部署

```bash
npm install
npm run build

# 启动（把 ANTHROPIC_API_KEY 换成你的上游 key）
API_KEYS=demo-key ANTHROPIC_API_KEY=sk-ant-xxx npm run serve
```

### OpenAI 客户端

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer demo-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"1+1=? 只回数字"}]}'
```

模型名按 `MODEL_MAP` 映射，最终名必须在白名单（`deepseek-v4-flash` /
`deepseek-v4-flash-free`）内，否则明确拒绝（400）——不再静默回落；
请求未带模型名时才落回 `DEFAULT_MODEL`。

服务起来后，本机打开 `http://127.0.0.1:8787/__admin` 进入管理面板
（默认账号 `admin` / `ADMIN_PASS`，首次登录请立即改密码）。

### Anthropic / Claude Code

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: demo-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```

Claude Code 直接指过来：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
ANTHROPIC_AUTH_TOKEN=demo-key \
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-flash \
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash \
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash \
claude
```

## 端点

数据面：

| 路径 | 协议 | 说明 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI | 归一化后直发上游（OpenAI 协议），流式/非流式 |
| `POST /v1/messages` | Anthropic | 直通 + DeepSeek 归一化，流式/非流式 |
| `POST /v1/messages/count_tokens` | Anthropic | Claude Code 记账（本地估算，不打上游） |
| `GET /v1/models` | OpenAI | 模型发现（别名 + 白名单模型） |
| `GET /healthz` | — | 健康检查 |

监控面板：

| 路径 | 说明 |
|---|---|
| `GET /__dash` | 监控面板 HTML（需鉴权，本机直连可免） |
| `GET /__metrics` | 监控面板数据（匿名公网模式剥掉 IP 等管理面字段） |

管理面板（`/__admin`，登录：`POST /__admin/api/login`，默认账号 `admin`，
密码见 `ADMIN_PASS`，默认密码有 `adminPassIsDefault` 告警徽章）：

| 路径 | 说明 |
|---|---|
| `GET /__admin` | 管理面板页面（未登录返回登录页） |
| `POST /__admin/api/login` / `logout` | 登录 / 登出（HttpOnly 会话 cookie，24h） |
| `GET`/`POST /__admin/api/accounts` | 账号列表 / 创建 |
| `PATCH`/`DELETE /__admin/api/accounts/:id` | 账号更新（含 `allowedModels` 账号级白名单）/ 删除 |
| `POST /__admin/api/accounts/:id/keys` | 为账号添加上游 key |
| `PATCH`/`DELETE /__admin/api/accounts/:id/keys/:fp` | 重命名 / 删除账号 key |
| `GET`/`POST /__admin/api/tokens` | 分发密钥列表 / 创建（token 明文**仅此一次**返回） |
| `PATCH`/`DELETE /__admin/api/tokens/:id` | 改名 / 状态 / 备注 / `rpmLimit` / 删除 |
| `GET /__admin/api/tokens/stats` | 分发密钥用量聚合 |
| `GET`/`PATCH /__admin/api/settings` | 热配置只读 / 热改（apiKeys 替换语义，改密码使旧会话全部失效） |
| `GET /__admin/api/audit` | 操作审计（登录/登出/账户/密钥/设置，脱敏摘要） |
| `GET /__admin/api/requests` | 请求明细分页（`?page=&pageSize=&q=`，对 path/status/model/client/ua/ip/error 搜索） |
| `GET /__admin/api/requests/stats-by-ip` | 按调用方 IP 聚合统计 |
| `GET /__admin/api/overview/trend` | 用量趋势（24h 按小时 / 7d 按天） |
| `POST /__admin/api/oauth/start` / `poll` | OAuth device flow 登录（RFC 8628，自动建号） |
| `GET`/`POST /__admin/api/model-aliases`、`PUT`/`DELETE /__admin/api/model-aliases/:alias` | 模型映射（别名）管理 |
| `GET /__admin/api/config` | 实验开关只读状态（env 配置，运行时不可改） |
| `POST /__admin/api/models/refresh` | 手动刷新上游模型目录 |

管理面鉴权：本机直连免 key（`DASHBOARD_OPEN`），或 API key，或面板登录会话
cookie；写操作与敏感读端点一律再做 Origin 校验（防跨站）。`DASHBOARD_PUBLIC`
公网模式不豁免管理面（账户管理含增删凭据）。

## 数据面

### 并发保护

数据面代理路径（`/v1/chat/completions` + `/v1/messages`）有并发在飞上限
`MAX_CONCURRENT_REQUESTS`（默认 400）。超限时返回 `503` + `Retry-After: 1`
（错误 `type: overloaded_error`），请求体被消费防 keep-alive 污染。
`0` = 不限（不推荐：曾是该进程唯一 OOM 向量）。`count_tokens` / `models`
是本地轻量处理，不受限。

### 模型白名单

全局白名单是**代码常量**（非环境变量）：仅 `deepseek-v4-flash`（订阅端点，
cost=0）与 `deepseek-v4-flash-free`（按量端点）两个变体。白名单外的模型名
明确 400（不再静默回落），错误响应列出可用模型。别名（`MODEL_MAP` env +
后台 `model-aliases` 管理）映射结果必须落在白名单内。

账号级 `allowedModels`（面板 `PATCH /__admin/api/accounts/:id`，上限 50 项）
进一步收紧单个账号可用模型；选号时与全局白名单取交集（账号不能突破全局底线）。

## 安全

- **提示词注入检测**（`INJECTION_MODE`）：`block`（默认，高置信命中拒绝 400）/
  `log`（只记录）/ `off`。两条数据面路径独立实现，user 消息递归提取文本做
  启发式扫描（含 tool_result 内嵌 content）。
- **凭证脱敏**：上游错误原文回显 Authorization 头时（`Bearer sk-xxx` 等），
  落日志/落库/回给客户端前一律 `stripSecrets` 脱敏（`sk-*` / `Bearer` /
  `auth=Fe26.*` 签名 token 三种形态）。
- **加密落库**：账户上游 key、billing cookie、分发 token 以 **AES-256-GCM**
  密文落库（`1:` 前缀 + 12 字节 IV + 认证标签）。密钥材料取 `GATEWAY_SECRET`
  env，或 `SECRET_FILE`（默认 `data/secret.key`，不存在自动生成 0600）。
  明文只在进程内出现；加密设施不可用时账户数据整体禁用，代理链路退回 env
  keys（加密绝不成为故障源）。
- **面板登录防护**：默认账号 `admin`，登录失败按 IP 限速（
  `ADMIN_LOGIN_FAIL_LIMIT` 次后锁 `ADMIN_LOGIN_LOCK_MS`，`429`）；
  跨站表单锁定 DoS 靠 Origin 校验拦截（校验先于限速，避免攻击者借限速锁死
  受害者）；会话是无状态 HMAC 签名 cookie（HttpOnly + SameSite=Lax + Secure），
  密码版本编进签名，改密码后旧会话立即失效。使用默认密码时设置页显示
  `adminPassIsDefault` 徽章 + 登录日志 stderr 告警。
- 另有：常量时间鉴权（`timingSafeEqual`，fail-closed）、SSRF 防护（含 IPv6）、
  CSRF（未鉴权放行模式下拒绝带 Origin 的跨站请求）、DNS rebinding 白名单、
  背压、内部错误不泄漏。

## 配置

完整带注释模板见 [.env.example](.env.example)，复制为 `.env` 后按需修改；
本节的表是逐项说明（默认值以代码为准，见 `src/config.ts`）。

环境变量：

### 服务与上游

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `API_KEYS` | 空 | 调用方鉴权 key，逗号分隔；空则 fail-closed 拒绝（可被 settings 表热改覆盖） |
| `OPENSEA_KEYS` | 空 | 上游 key 池，逗号分隔；与 `ANTHROPIC_API_KEY` 合并去重（单 key 排最前） |
| `ANTHROPIC_API_KEY` | 空 | 上游单 key（并入 key 池） |
| `ANTHROPIC_BASE_URL` | `https://opencode.ai/zen/go` | 订阅端点 base URL（末尾斜杠自动剥） |
| `PAYG_BASE_URL` | `https://opencode.ai/zen` | 按量付费端点 base URL；`-free` 模型只存在于这里 |
| `MODEL_MAP` | 空 | 模型名映射，如 `gpt-4o:deepseek-v4-flash`（映射结果必须在白名单内） |
| `DEFAULT_MODEL` | `deepseek-v4-flash` | 请求缺省模型名时的兜底（仅缺省回落，白名单外不再静默回落） |

### 数据面与安全

| 变量 | 默认值 | 说明 |
|---|---|---|
| `INJECTION_MODE` | `block` | 注入检测：`block`（high 命中拒 400）/`log`/`off` |
| `ALLOW_UNAUTHENTICATED` | `0` | 仅绑定回环地址时生效（fail-closed） |
| `MAX_BODY_BYTES` | `67108864`（64MB） | 请求体字节上限，`0` = 不限 |
| `MAX_MESSAGE_CHARS` | `8000000` | 单条消息文本字符上限，`0` = 不限 |
| `MAX_MESSAGES` | `4000` | messages 条数上限（防超长列表 DoS），`0` = 不限 |
| `MAX_CONCURRENT_REQUESTS` | `400` | 数据面并发在飞上限；超限 503 + `Retry-After`，`0` = 不限 |
| `STRIP_CONTROL_CHARS` | `1` | 剥离日志/转发内容里的控制符 |
| `TRUST_CLAUDE_CODE_HEADERS` | `0` | 是否透传 `x-claude-code-*` 会话头（共享部署默认不透传） |

### 用量与 key 池

| 变量 | 默认值 | 说明 |
|---|---|---|
| `USAGE_DB_PATH` | `data/usage.db` | 用量库路径（相对 cwd）；空串 = 关闭持久化 |
| `USAGE_DB_RETENTION_DAYS` | `30` | 用量/审计记录保留天数，`0` = 不清理 |
| `KEY_FAIL_THRESHOLD` | `5` | key 池连续失败多少次禁用 |
| `KEY_COOLDOWN_MS` | `300000`（5 分钟） | key 冷却期（auth/transient 等分级，此为基准） |
| `KEY_PROBE_INTERVAL_MS` | `900000`（15 分钟） | key 探活周期，`0` = 关闭 |
| `KEY_PROBE_IDLE_MS` | `3600000`（60 分钟） | key 空闲多久才值得探活 |
| `KEY_PROBE_TIMEOUT_MS` | `30000` | 单次探活请求超时 |
| `MODEL_CATALOG_REFRESH_MS` | `21600000`（6 小时） | 上游模型目录刷新周期，`0` = 仅启动拉一次 |

### 管理面（面板/加密/OAuth）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `GATEWAY_SECRET` | 空 | 管理面加密密钥（AES-256-GCM 材料），非空时优先于 `SECRET_FILE` |
| `SECRET_FILE` | `data/secret.key` | secret 文件路径，不存在自动生成 0600 |
| `ADMIN_USER` | `admin` | 面板登录账号 |
| `ADMIN_PASS` | `13141516` | 面板登录密码；使用默认值时有 `adminPassIsDefault` 徽章 + stderr 告警，请改为强密码 |
| `ADMIN_SESSION_TTL_MS` | `86400000`（24h） | 会话 cookie 有效期 |
| `ADMIN_LOGIN_FAIL_LIMIT` | `5` | 同 IP 登录失败 N 次后锁定 |
| `ADMIN_LOGIN_LOCK_MS` | `300000`（5 分钟） | 登录锁定时长 |
| `DASHBOARD_OPEN` | `0` | 面板本机直连免 key（仅绑定回环地址生效；fail-closed） |
| `DASHBOARD_PUBLIC` | `0` | 面板完全公开（含公网；匿名响应剥 IP 等管理面字段，管理面不豁免） |
| `BILLING_INTERVAL_MS` | `1800000`（30 分钟） | billing 余额抓取周期，`0` = 关闭循环 |
| `BILLING_TIMEOUT_MS` | `20000` | 单次 billing 抓取超时 |
| `OAUTH_CLIENT_ID` | `opencode-cli` | OAuth device flow 的 client_id（官方 CLI 同款） |
| `OAUTH_CONSOLE_URL` | `https://console.opencode.ai` | OAuth 控制台端点 base URL |

### 实验性（默认全关；开启即接受失真/丢字）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SCALE_CLIENT_TOKENS` | `0` | 返回给客户端的 usage 缩放（诱导 Claude Code 提前本地 compact） |
| `CLIENT_TOKEN_SCALE` | `0.6657` | usage 缩放系数，范围 `(0, 1]` |
| `COMPACT_ENABLED` | `0` | 请求体被动压缩（空白折叠 + 超长单条截断，无损） |
| `COMPACT_TRIGGER_BYTES` | `4194304`（4MB） | 被动压缩触发阈值（请求体字节数） |
| `COMPACT_MAX_MESSAGE_CHARS` | `8000` | 被动压缩的单条消息字符上限（超长截断） |

说明：

- `ALLOWED_MODELS`（`deepseek-v4-flash` / `deepseek-v4-flash-free`）是**代码常量**
  （`src/deepseek.ts`），不是环境变量，没有对应 env。
- 热配置（settings）可改键：`adminUser` / `adminPass` / `apiKeys` /
  `scaleClientTokens` / `clientTokenScale` / `compactEnabled` /
  `compactTriggerBytes` / `compactMaxMessageChars`——运行时 PATCH 生效不重启。

用量库用 Node 内置 `node:sqlite`（Node 22.5+，之前该模块不存在），
**不引入任何 npm 依赖**。Node 20 上自动降级：只记一条 warn，面板不显示历史
累计，代理功能不受影响。库里 API key 只存脱敏指纹（`****XXXX` 末 4 位），
**分发 token 存完整指纹**；requests 表同时落 path/ua/client/ip/cost，详细请求页
与 IP 统计即来源于此（管理鉴权后才可见）。

## OTA 自更新

OTA（over-the-air）自更新：后台检查 GitHub release，发现更高版本时从 release
下载预构建 dist tarball（`fuckopencode-v<tag>-dist.tar.gz` + 独立信道取的
sha256），校验通过后原子替换并自重启，实现免登录更新。默认全关（`OTA_ENABLED=0`，
fail-closed）；关着时面板仍显示更新状态，只是 perform（写盘 + 自重启）403。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OTA_ENABLED` | `0` | 总开关；`1` = 允许写盘 + 自重启 |
| `OTA_REPO` | `dwgx/fuckopencode` | 更新源仓库 owner/repo |
| `OTA_TOKEN` | 空 | 私有仓库 token；配了只走直连、不交给 gh-proxy，永不进日志/响应 |
| `OTA_CHECK_INTERVAL_MS` | `21600000`（6h） | 后台版本检查周期；`0` = 关闭（只检查不自动应用） |

第三方部署注意：

- `OTA_REPO` 必须指向你自己的仓库，且仓库要配 `.github/workflows/release.yml`
  （push `vX.Y.Z` tag 触发：typecheck + test + build + 打包 dist tarball +
  算 sha256 + 上传 release 资产）。OTA 会校验 `dist/version.txt == tag`，
  版本只升不降。
- 自重启需要 supervisor（systemd/launchd）托管；裸跑前台进程时 perform 会拒绝。

## 架构

```
src/
├── index.ts            # 库导出入口
├── main.ts             # 服务入口（装配 config/server/AccountsStore/TokensStore/探活/billing + shutdown）
├── server.ts           # HTTP 服务 + 路由 + 安全装配 + 用量落库 + 并发在飞上限
├── config.ts           # 环境配置（白名单化解析）
├── errors.ts           # 错误映射 + 控制符剥离 + 上游失败分级
├── upstream.ts         # OpenAI 上游客户端（key 池集成 + 幂等 release + 三段式超时）
├── keypool.ts          # 多 key 池（失败分级冷却、指纹脱敏、账号级白名单选号）
├── keyprobe.ts         # 空闲 key 主动探活（15 分钟一轮）
├── usagedb.ts          # 用量持久化（node:sqlite 零依赖，批量落库 + key_totals 聚合表）
├── deepseek.ts         # DeepSeek 归一化（直通路径适配层）
├── toOpenAI.ts         # Anthropic 请求 → OpenAI 请求
├── toAnthropic.ts      # OpenAI 响应/流 → Anthropic 事件
├── dsml.ts             # 工具调用泄漏兜底解析
├── sse.ts              # OpenAI SSE 行解析（parseOpenAISSE）
├── metrics.ts          # 请求事件环形缓冲（喂面板）
├── dashboard.ts        # 自带状态面板（HTML 内联，零依赖）
├── types.ts            # 两套协议的类型定义
├── admin.ts            # 管理面板（HTML 内联 + 账户/映射 CRUD + Origin 校验）
├── accounts.ts         # 多账号存储（env 种子 + 账号级白名单）
├── console.ts          # 新版控制台 REST 数据通道
├── legacy.ts           # 旧版控制台（opencode.ai）key 通道
├── oauth.ts            # OAuth device flow 登录（RFC 8628）
├── tokens.ts           # 分发密钥（AES 加密落库 + 用量聚合）
├── settings.ts         # 热配置（settings 表，env 为默认、db 覆盖）
├── modelmap.ts         # 模型映射 db 持久化 + 默认别名种子
├── ratelimit.ts        # 分发 token 的 per-key RPM 限流（滑动窗口）
├── secrets.ts          # AES-256-GCM 加密（GATEWAY_SECRET / SECRET_FILE）
├── billing.ts          # billing 抓取（新版控制台 + SSR 兜底）
├── cookie.ts           # Chrome cookie 导入（仅本机开发）
├── compact.ts          # 实验性请求体被动压缩
├── shutdown.ts         # 优雅关停（先 flush 用量库）
├── security/
│   ├── auth.ts         # 鉴权（timingSafeEqual, fail-closed）+ 面板会话 HMAC
│   ├── validate.ts     # schema 校验 + 长度上限
│   └── injection.ts    # 提示词注入检测 + system 护栏
└── 历史转换链（2026-08-09 改造前遗留，经 index.ts 导出，主路径不再调用）：
    request.ts  normalize.ts  response.ts  stream.ts
    tool.ts  image.ts  usage.ts  stopReason.ts
```

维护者文档（架构决策、DeepSeek 怪癖清单、已知问题、计划）在 `.claude/docs/`，
入口见 [.claude/docs/README.md](.claude/docs/README.md)。

## 运行

- 零 npm 运行时依赖（devDependencies 仅 typescript / vitest / @types/node）；
  用量库走 Node 内置 `node:sqlite`（Node 22.5+），Node 20 自动降级。
- `Node >= 20`（`engines`）。

| 命令 | 说明 |
|---|---|
| `npm run build` | tsc 构建到 `dist/` |
| `npm run serve` | 构建并启动服务 |
| `npm run dev` | 构建 + `node --watch` 热重启 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | vitest 单测（全本地，不碰网络） |
| `npm run test:live` | 真实上游端到端 probe（需服务在跑 + 真 key） |

## 测试

```bash
npm test           # 单测，全部本地，不碰网络
npm run test:live  # 真实 DeepSeek 上游端到端 probe（需服务在跑）
```

`test:live` 覆盖：基本对话、多轮工具（第二轮必须 200）、JSON mode（`finish_reason=stop` + content 是 JSON）、流式 `[DONE]` + usage、Anthropic 直通多轮工具。

## License

MIT
