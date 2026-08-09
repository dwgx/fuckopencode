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
| 监听 | `127.0.0.1:8787`，由 cloudflared 反代出去 |
| 对外域名 | `fuckopencode.dwgx.top`（隧道**整体**代理 8787，所有路径都可达）|
| 监控面板 | `/__dash` + `/__metrics`，**要求 API key**（`DASHBOARD_OPEN=0`）|
| env | `/root/fuckopencode/fuckopencode.env`，权限 600 |
| node | v22.20.0（`/usr/local/bin/node`） |
| 依赖 | 无 `node_modules` —— 零运行时依赖，只需 `dist/` |

服务器上没有源码，也没有 git remote，**所以不能 `git pull` 更新**，
只能从本地构建后推 `dist/`。

## 更新流程

本地验证 → 构建 → 推产物 → 原子替换 → 重启 → 验证。

```bash
npm run typecheck && npm test && npm run build
```

```bash
tar czf /tmp/fc.tar.gz dist && scp -P 52535 -i ~/.ssh/id_nbus /tmp/fc.tar.gz root@38.244.34.15:/root/
```

远端替换（保留 `dist.prev2` 可回滚）：

```bash
ssh nbus 'cd /root/fuckopencode && rm -rf dist.new && mkdir dist.new && tar xzf /root/fc.tar.gz -C dist.new --strip-components=1 && test -f dist.new/keypool.js && rm -rf dist.prev2 && mv dist dist.prev2 && mv dist.new dist && systemctl restart fuckopencode && sleep 3 && systemctl is-active fuckopencode'
```

**替换前一定要校验 `dist.new/keypool.js` 存在。** 少了它 env 里的
`OPENSEA_KEYS` 就没人读，服务会以零上游 key 启动，所有请求 503。

回滚：

```bash
ssh nbus 'cd /root/fuckopencode && rm -rf dist && mv dist.prev2 dist && systemctl restart fuckopencode'
```

## 环境变量

上游是 **opencode Zen**（`https://opencode.ai/zen`），不是 Anthropic 官方。

| 变量 | 说明 |
|---|---|
| `OPENSEA_KEYS` | 上游 key 池，逗号分隔。当前 2 个 |
| `API_KEYS` | 客户端 key。当前 1 个 |
| `ANTHROPIC_BASE_URL` | `https://opencode.ai/zen/go`（**订阅**端点，cost=0）|
| `PAYG_BASE_URL` | `https://opencode.ai/zen`（按量付费，仅 `-free` 模型走这里）|
| `DEFAULT_MODEL` | `deepseek-v4-flash` |
| `DASHBOARD_OPEN` | `0` —— 隧道整体暴露 8787，面板含调用方 IP/UA，必须鉴权 |
| `KEY_FAIL_THRESHOLD` | 5 |
| `KEY_COOLDOWN_MS` | 300000 |
| `HOST` / `PORT` | `127.0.0.1` / `8787` |
| `INJECTION_MODE` | `block` |

改 env 后要 `systemctl restart`（`EnvironmentFile` 只在启动时读）。

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
