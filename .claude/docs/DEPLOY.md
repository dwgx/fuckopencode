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
| 监听 | `127.0.0.1:8788` —— **注意不再是 8787**，8787 已被盾接管（见 SHIELD.md） |
| 盾 | `fuckopencode-shield.service`，监听 `127.0.0.1:8787`，上游指 8788 |
| 公网链路 | `cloudflared -> 127.0.0.1:8787（盾）-> 127.0.0.1:8788（网关）` |
| 对外域名 | `fuckopencode.dwgx.top`（路由由 Cloudflare 云端管理，本地 ingress 不生效） |
| 监控面板 | 网关 `/__dash` + `/__metrics`（要求 API key）；盾 `/_shield/*`（仅回环） |
| env | `/root/fuckopencode/fuckopencode.env`，权限 600 |
| node | v22.20.0（`/usr/local/bin/node`） |
| 依赖 | 无 `node_modules` —— 零运行时依赖，只需 `dist/` |

服务器上没有源码，也没有 git remote，**所以不能 `git pull` 更新**，
只能从本地构建后推 `dist/`。

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
| `HOST` / `PORT` | `127.0.0.1` / `8788`（8787 已被盾接管，见 SHIELD.md） |
| `INJECTION_MODE` | `block` |
| `USAGE_DB_PATH` | 不设 = `data/usage.db`（相对 `WorkingDirectory`）。设为空串关闭持久化 |
| `USAGE_DB_RETENTION_DAYS` | 不设 = 30。`0` = 不清理 |

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
ssh nbus 'K=$(grep ^API_KEYS= /root/fuckopencode/fuckopencode.env | sed s/^API_KEYS=//| cut -d, -f1); curl -s http://127.0.0.1:8788/__metrics -H "x-api-key: $K" | grep -c "sk-"'
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
