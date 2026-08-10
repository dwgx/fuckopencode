# 上游护盾（DWGX）

盾是挂在网关**前面**的一层重试代理：上游波动（整池被禁的 503、网关抖动的 502、
限速 429）先被它吸收，重试到恢复后再把成功的响应交给客户端。目的是让
kirostudio / Claude Code 这类下游**不会因为上游几分钟的波动而断开会话**。

来源是 `.62` 机器上给 kirostudio 用的同一个 `kiro_shield.py`，本副本由 DWGX
移植到 nbus，加了 fuckopencode 专用的错误标记。

## 拓扑（重要：端口是互换过的）

```
cloudflared -> 127.0.0.1:8787（盾）-> 127.0.0.1:8788（fuckopencode 网关）
```

网关**不再监听 8787**，它退到了 8788；盾接管了 8787。

为什么这么绕：`fuckopencode.dwgx.top` 的路由由 **Cloudflare 云端管理**，
本地 `/etc/cloudflared/config.yml` 里那段 ingress 对这条隧道**不生效**。
实测证据：改本地配置指向盾并重启 cloudflared 后，启动日志里的
`Updated to new configuration` 仍是 `127.0.0.1:8787`，而
`cloudflared_config_local_config_pushes` 恒为 0（本地配置从未推给 edge），
盾的 `requests` 一直是 0。

所以走不了「改隧道指向盾」这条路，改成**让盾去占云端认定的那个端口**：
盾监听 8787，网关退到 8788。不需要碰任何云端配置。

回滚就是把两个端口换回来：网关 env 的 `PORT=8787`，盾 unit 的
`SHIELD_PORT=8993` + `UPSTREAM=http://127.0.0.1:8787`（盾变回旁路，不承载流量）。

## 线上形态

| 项 | 值 |
|---|---|
| 代码目录 | `/opt/fuckopencode-shield`（`kiro_shield.py` + `shield/` 包） |
| 服务 | `fuckopencode-shield.service`（systemd，`Restart=always`） |
| 监听 | `127.0.0.1:8787` |
| 上游 | `http://127.0.0.1:8788`（网关） |
| 运行时 | 系统 python3（3.11），**零第三方依赖** |
| 资源 | `MemoryMax=128M` / `CPUQuota=80%` / `OOMScoreAdjust=400`（实测常驻约 14M） |
| 观测 | `/_shield/stats`、`/_shield/events`、`/_shield/ui`、`/_shield/config` |

盾只监听回环，观测面板**不经隧道对外**。要看面板：

```bash
ssh -L 8787:127.0.0.1:8787 nbus
```

然后浏览器开 `http://127.0.0.1:8787/_shield/ui`。

## DWGX 为 fuckopencode 加的东西

原版盾是给 kirostudio 的上游（Kiro）调的，判定表里没有 fuckopencode 的错误措辞。
移植时加了 `FUCKOPENCODE_TRANSIENT_MARKERS`，并在 `classify()` 里分了两档：

| 上游 body 里的措辞 | 判定 | 为什么 |
|---|---|---|
| `all upstream keys are disabled` | `cool` | key 池整池被禁，冷却到期会自动恢复（默认 300s）。走 cool 是为了听 `Retry-After` 并升档退避，而不是密集重试 |
| `upstream unavailable` | `retry` | 网关连不上 opencode Zen，秒级抖动 |
| `upstream returned malformed body` | `retry` | 上游回了坏 JSON |
| `upstream interrupted the stream` | `retry` | 流被中断（对应 I-10 的脏数据兜底） |

`all upstream keys are disabled` 是最关键的一条：2026-08-09 线上因此打出
**295 个 503**（20:16–20:19 整池被禁约 3 分钟）。盾装上后这类波动对下游不可见。

判定顺序在 `classify()` 的 docstring 里写了，改之前先读 —— 顺序错了会让
「客户端 key 填错」被 swap 长窗卡 900 秒。

## 常用操作

部署/更新盾（本地跑，幂等）：

```bash
./scripts/dwgx/shield-deploy.sh
```

探活与看盾吞了什么（只读，不改任何开关）：

```bash
./scripts/dwgx/shield-status.sh
```

本地验证盾的行为（不碰线上，起假上游模拟故障）：

```bash
python3 scripts/dwgx/test-shield.py
```

## 已验证的行为

`test-shield.py` 14/14 通过（本地假上游）：

- 2xx 直接透传、不预读（SSE 实时性不受影响）
- 整池被禁 503 被吸收 → 客户端 200，且确实重试了多次
- 502 `upstream unavailable` 被吸收 → 200
- 客户端自己的 401 快速收敛（约 4s），不被长窗拖住
- 下游文案是中文、不含内部术语、带重试次数与耗时、无 markdown 标记
- 端到端：401 收敛后客户端实际收到的 body 是中文（回退英文会变红）

真机（nbus，经公网域名）：

- 非流式 / `thinking:adaptive` / OpenAI `/v1/chat/completions` / 流式，四项全 200
- **吸收实测**：停掉网关 8788 共 12 秒，公网请求经盾拿到正常 200（25.65s，
  含等待窗口），客户端从未断开，盾 `absorbed=1`

## 坑

- **盾 restart 会清零统计**（`requests`/`absorbed` 都在内存里）。看到 0 不代表没流量，
  先看 unit 的启动时间。
- **端口互换有顺序**：必须先停盾放开 8787，再把网关起到 8788，最后起盾占 8787。
  顺序错了盾会因端口被占启动失败。
- **`absorbed=0` 不一定是盾没工作**。如果上游在请求发出时还活着，盾一次就过，
  不计吸收。要验证吸收得先把上游停掉、再发请求（顺序反了测不到）。
- 客户端自身的错误（401 之类）盾**不透传原文**，统一回 503。这是 2026-08-07
  的既有决策（任何错误都不返回给客户端，号池会自然恢复），不是 bug。
  正因为原文不透传，下游能看到的只有盾自己那句话 —— 所以文案由
  `client_message()` 统一生成，五类失败各一条中文说明，写清是谁的问题、
  盾替它试了多久多少次、该重发还是该改配置。**改文案就是改下游的唯一信息源**，
  别在里面写「号池」「盾」这类内部术语（盾在下游眼里就是上游），
  也别用 markdown —— 终端客户端会把 `**` 原样显示出来。
- 盾把 `MemoryMax` 压在 128M 是刻意的 —— nbus 只有 1.9G，上面还跑着 xray。
  别把这行删了。
