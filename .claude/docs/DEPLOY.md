# 部署

线上只有一台机器：nbus。

## 机器与访问

`ssh nbus`（别名已配在 `~/.ssh/config`）。`38.244.34.15:52535`，root 账号，Debian 12。

**只接受公钥认证**，密码登录已在 sshd 关闭 —— 所以 `ssh-copy-id` 那条路走不通
（它需要密码登录才能装公钥）。私钥 `~/.ssh/id_nbus`，注释 `minis-id_nbus`，
指纹 `SHA256:mVOAaVRFfKZrlGLAzrnBNgDcHOgWLw6kClOS/z+BgOg`。

**这是唯一进入通道，务必备份。** 丢了只能走 VPS 控制台（VNC / 网页终端）重新植入公钥。

机器资源紧（2 核 / 1.9G 内存），上面还跑着 xray、x-ui、cloudflared、blog、fail2ban。
网关的 systemd unit 里有 `MemoryMax=400M` + `OOMScoreAdjust=500`，
刻意保证网关绝不挤掉 xray。改 unit 时别把这两行删了。

## 部署形态

| 项 | 值 |
|---|---|
| 代码目录 | `/root/fuckopencode`（**不是 git 仓库**，只有 `dist/`） |
| 服务 | `fuckopencode.service`（systemd，`Restart=always`） |
| 监听 | `0.0.0.0:8787` —— **去盾后**（2026-08-15）FurCDN 直连网关 |
| 盾 | **已退役（2026-08-15）**：`fuckopencode-shield.service` 已停，不再占端口 |
| 公网链路 | `FurCDN -> 0.0.0.0:8787（网关，直连，无盾）` |
| 对外域名 | `fuckopencode.dwgx.top`（路由由 Cloudflare 云端管理，本地 ingress 不生效） |
| 监控面板 | 网关 `/__dash` + `/__metrics`（要求 API key）；盾面板 `/_shield/*` 随盾退役 |
| env | `/root/fuckopencode/fuckopencode.env`，权限 600 |
| node | v22.20.0（`/usr/local/bin/node`） |
| 依赖 | 无 `node_modules` —— 零运行时依赖，只需 `dist/` |

服务器上没有源码，也没有 git remote，**所以不能 `git pull` 更新**，
只能从本地构建后推 `dist/`。

## 第三方一键部署（install.sh）

上面全是 nbus 专属现状。**通用安装路径是 [scripts/install.sh](../../scripts/install.sh)**，
第三方/新机器部署直接走它，不需要手动搭 systemd + 推 dist：

```bash
git clone <仓库地址>   # 上游 dwgx/fuckopencode 或你自己的 fork
cd fuckopencode
./scripts/install.sh
```

- 两种模式：`release`（默认，从 GitHub release 下载预构建 dist tarball，
  服务器不需要 npm/tsc）与 `source`（本机构建）。需要 **Node >= 22**。
- 装完 `cp .env.example .env`，必填项三件：`API_KEYS`（客户端 key）、
  `OPENSEA_KEYS` 或 `ANTHROPIC_API_KEY`（上游 key，至少一个）、`HOST`/`PORT`。
- OTA 配置：`OTA_REPO` 改指向你自己的仓库，且仓库要配
  `.github/workflows/release.yml`（tag `vX.Y.Z` 触发构建 dist tarball + sha256 +
  上传 release 资产）。开 `OTA_ENABLED=1` 前先确认有 supervisor 托管
  （systemd/launchd），裸跑前台进程时 perform 会拒绝自重启。

与 nbus 的关系：install.sh 是通用路径，nbus 是实际生产——nbus 维护仍走本页的
[deploy.sh](../../scripts/deploy.sh)（本地构建 → 推 dist → 原子替换 → 重启 →
健康检查），不走 install.sh。OTA 自更新到货后，nbus 的日常小版本也可靠 OTA
免登录更新，deploy.sh 保留为手动回滚点。

## 更新流程

用脚本，不要手敲。[scripts/deploy.sh](../../scripts/deploy.sh) 把
「本地验证 → 构建 → 推产物 → 原子替换 → 重启 → 健康检查」串成一条：

```bash
./scripts/deploy.sh
```

回滚到上一个版本：

```bash
./scripts/deploy.sh rollback
```

只清线上旧备份：

```bash
./scripts/deploy.sh clean
```

脚本里有两条承重设计，改它之前先理解：

1. **替换前校验 `dist.new/keypool.js` 与 `dist.new/dsml.js` 存在。**
   少了 keypool 就没人读 env 里的 `OPENSEA_KEYS`，服务以零上游 key 启动，
   所有请求 503。缺失时脚本中止，不会把坏产物换上去。
2. **备份只保留一个 `dist.prev`。** 早期手敲部署留下了 `dist.prev2` 一路到
   `dist.prevJ` 共 17 份陈旧备份（占 9.9M，已清理到 1.3M）。脚本每次轮转时
   先删旧备份再挪当前 dist，不再堆积。

重启语义（2026-08-14 起，src/shutdown.ts）：SIGINT/SIGTERM → 停后台任务 →
`server.close` → `closeIdleConnections`（掐空闲 keep-alive，活跃流式不掐）→
5s 兜底 **exit(0)**；用量库 flush（最后一批 + WAL 收尾）推迟到退出时刻执行。
带活跃连接重启是常态，systemd 不再记 FAILURE，最后一批用量先 flush 再退出不丢。

**CI 与发版**（2026-08-14 起）：`.github/workflows/ci.yml` 已接入（push main +
PR 触发，node 22/24 × typecheck + test + build）。发版走 tag：
`git tag vX.Y.Z` + `gh release create vX.Y.Z`（版本号在 package.json）。

## 环境变量

上游是 **opencode Zen**（`https://opencode.ai/zen`），不是 Anthropic 官方。

| 变量 | 说明 |
|---|---|
| `OPENSEA_KEYS` | 上游 key 池，逗号分隔。当前 2 个（`****0osU` / `****ZOBb`，面板可见状态）|
| `API_KEYS` | 客户端 key。当前 1 个 |
| `ANTHROPIC_BASE_URL` | `https://opencode.ai/zen/go`（**订阅**端点，cost=0）|
| `PAYG_BASE_URL` | `https://opencode.ai/zen`（按量付费，仅 `-free` 模型走这里）|
| `DEFAULT_MODEL` | `deepseek-v4-flash` |
| `DASHBOARD_OPEN` | `0` —— 隧道整体暴露 8787，面板含调用方 IP/UA，必须鉴权 |
| `KEY_FAIL_THRESHOLD` | 5 |
| `KEY_COOLDOWN_MS` | 300000 |
| `HOST` / `PORT` | `0.0.0.0` / `8787`（去盾后：FurCDN 直连网关，见 SHIELD.md 退役标注） |
| `INJECTION_MODE` | `block` |
| `USAGE_DB_PATH` | 不设 = `data/usage.db`（相对 `WorkingDirectory`）。设为空串关闭持久化 |
| `USAGE_DB_RETENTION_DAYS` | 不设 = 30。`0` = 不清理 |
| `KEY_PROBE_INTERVAL_MS` | 不设 = 900000（15 分钟）。`0` = 关闭探活 |
| `KEY_PROBE_IDLE_MS` | 不设 = 3600000（60 分钟）。key 空闲超过这个时长才探 |
| `KEY_PROBE_TIMEOUT_MS` | 不设 = 30000 |
| `MAX_BODY_BYTES` | 不设 = 64MB（67108864）。**线上当前设 0（无上限）是认证客户端内存 DoS 面，建议改 33554432**（改 env 后 systemctl restart） |
| `MAX_CONCURRENT_REQUESTS` | 数据面并发在飞上限，不设 = 400，`0` = 不限（不推荐：曾是该进程唯一 OOM 向量） |
| `ADMIN_USER` | 面板登录账号，不设 = `admin` |
| `ADMIN_PASS` | 面板登录密码，不设 = `13141516`（DEFAULT_ADMIN_PASS）。使用默认值时有 `adminPassIsDefault` 徽章 + stderr 告警，**上线必改** |
| `ADMIN_SESSION_TTL_MS` | 面板会话 cookie 有效期，不设 = 24h |
| `ADMIN_LOGIN_FAIL_LIMIT` / `ADMIN_LOGIN_LOCK_MS` | 登录失败限速（默认 5 次锁 5 分钟） |

面板访问（2026-08-11 起）：浏览器打开 `/__admin` 或 `/__dash` 无凭证时显示
**账号密码登录页**（默认 admin/13141516，`ADMIN_PASS` 可改）。登录成功
签发 HttpOnly 会话 cookie（内存 token，进程重启即失效需重登）。API key
（`x-api-key` 头）仍然有效，curl/脚本不受影响。**线上必须改默认密码**：
`ADMIN_PASS` 写进 fuckopencode.env（600 权限），改完 `systemctl restart`。

改 env 后要 `systemctl restart`（`EnvironmentFile` 只在启动时读）。

## 用量库（data/usage.db）

面板的「累计」列和「最近状态变更」来自 SQLite，用 Node 内置 `node:sqlite`
（**不引入任何 npm 包** —— `dependencies` 保持为空是刻意的）。

三件关于位置的事，改部署脚本前必须知道：

1. **db 必须在 `dist/` 外面。** `deploy.sh` 每次做
   `rm -rf dist.prev; mv dist dist.prev; mv dist.new dist`。放 `dist/` 里
   等于每次部署丢历史、回滚还会把旧数据带回来。
2. 路径相对 **`WorkingDirectory`**（systemd unit 里是 `/root/fuckopencode`），
   所以默认落在 `/root/fuckopencode/data/usage.db`。
3. WAL 模式会额外产生 `usage.db-wal` / `usage.db-shm`。备份要一起拿，
   或者先 `sqlite3 usage.db "PRAGMA wal_checkpoint(TRUNCATE)"`。

**降级是设计的一部分，不是故障：** Node 20 没有 `node:sqlite`、盘满、权限不足、
db 损坏 —— 任何一种情况都只打一行 warn，然后整个模块退化成 no-op。面板照常工作，
只是不显示累计列（会显示降级原因）。**代理链路一个字节都不受影响。**

启动日志能直接看出状态：

```
[proxy] usage db: data/usage.db (retention 30d)   # 正常
[proxy] usage db: off (<原因>)                     # 降级
```

盘占用量级：每条请求约 100 字节，30 天保留期下几万行 ≈ 几 MB。清理是惰性触发的
（跟着写入走，每 6 小时一次），不占常驻定时器 —— 那台机器 1.9 GB 内存、
网关 `MemoryMax=400M`。

隐私口径与日志/面板一致：**只存 key 指纹（末 4 位），不存 key 原文，不存 IP/UA。**
IP 和 UA 只在内存窗口里（200 条），长期留存反而是负担。

改 env 的正确姿势：**不要把凭证写进命令行**（`ps` 可见，也会进 shell 历史）。
scp 一个临时文件上去，远端处理完 `shred -u` 删掉。

## 多账号管理面（2026-08-11 起）

管理面板在 `/__admin`（只本机直连或带 API key 可访问，公网永不豁免）。
启动日志两行能直接看出状态：

```
[proxy] secret: data/secret.key (auto-generated | from file | from env)   # 正常
[proxy] secret: unavailable                                                # 降级
[proxy] accounts: 1 (env-seeded | from db)                                 # 正常
[proxy] accounts: off (secret unavailable)                                 # 降级
```

- **`data/secret.key` 与 usage.db 同在 `data/`**，已 gitignore、不随部署覆盖。
  **备份必须含 `data/` 目录。** secret.key 丢失 = 账户 keys/cookie 全部无法解密
  （env 种子会重建默认账户，但自定义账户与 cookie 需重新录入）。
- 凭证口径升级：账户 key 与 billing cookie 以 AES-256-GCM 密文落库
  （`GATEWAY_SECRET` env 可替代文件密钥），明文绝不入响应/日志/面板。
- billing 余额抓取走 `https://opencode.ai/workspace/{id}/billing` 页面
  （cookie 来自用户浏览器 devtools），**实验性**：解析器未对真实页面验证
  （需真实 cookie spike 固化成 fixture），失败按 15min→2h 退避且只记状态码。
  真实余额显示不出来时，先查 `[proxy] billing` 日志。
- 探针改为账户驱动（每 tick 挑到期账户，`retry_until` 闸门），
  `KEY_PROBE_INTERVAL_MS` 默认 15min、`KEY_PROBE_IDLE_MS` 默认 60min。

## 验证清单

改完必须跑这四条，只看「服务 active」不够：

```bash
ssh nbus 'K=$(grep ^API_KEYS= /root/fuckopencode/fuckopencode.env | sed s/^API_KEYS=//| cut -d, -f1); curl -s -m 60 -X POST http://127.0.0.1:8787/v1/messages -H "x-api-key: $K" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d "{\"model\":\"claude-sonnet-4-6\",\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" | head -c 200'
```

1. Anthropic `/v1/messages` 非流式 → 200 + 有 content
2. `thinking: adaptive` → 200（验证归一化）
3. OpenAI `/v1/chat/completions` 带 `reasoning_effort` → 200（验证 output_config 转换）
4. 流式 → 事件序列含 `message_start` 与 `message_stop`

启动日志应该有 `upstream key pool: N keys (N healthy)`：

```bash
ssh nbus 'journalctl -u fuckopencode -n 20 --no-pager'
```

第五条，动过 usagedb 相关代码时必须加上 —— **确认持久化真的启用了**：

```bash
ssh nbus 'journalctl -u fuckopencode --since "3 minutes ago" --no-pager | grep "usage db"'
```

必须是 `[proxy] usage db: data/usage.db (retention 30d)`，**不能是 `off (...)`**。
2026-08-10 踩过：sqlite 加载用了裸 `require`，326 个测试全绿、构建干净、
服务 active、健康检查过 —— 但生产 ESM 下抛 `require is not defined`，
被降级逻辑吞成一行 warn，持久化从未启用。**只看服务状态发现不了这类失败。**

同时核对落库位置与隐私口径：

```bash
ssh nbus 'ls -la /root/fuckopencode/data/'
ssh nbus 'K=$(grep ^API_KEYS= /root/fuckopencode/fuckopencode.env | sed s/^API_KEYS=//| cut -d, -f1); curl -s http://127.0.0.1:8787/__metrics -H "x-api-key: $K" | grep -c "sk-"'
```

`data/` 里应有 `usage.db` + WAL 两个副本文件；`grep -c "sk-"` 必须是 0。
注意服务器上**没有 `rg`**，只有 `grep`。

## 坑

- **服务 active 不等于能用。** 零上游 key 也能正常启动监听，只是每个请求 503。
  一定要发真实请求验证。
- **上游走 OpenAI 协议，不走 Anthropic。** 上游的 Anthropic 兼容层工具调用是坏的
  （空 content + stop_reason:null），Claude Code 用不了。见 ARCHITECTURE.md。
- **`-free` 模型只在按量端点存在**，订阅端点会 401 `Model ... is not supported`。
  按模型名后缀自动路由，两者都能用。
- **count_tokens 纯本地估算**，不打上游（上游 OpenAI 端点没这个接口），省往返也不烧额度。
- **面板路径以 `__` 开头**，不计入指标，否则轮询会把自己刷满。
- `deepseek-v4-flash-free` 的 output_tokens 有时异常高（实测一次 2139 token
  回一个「部署成功」），可能是 thinking 计入。不影响可用性，但记账会偏高。
