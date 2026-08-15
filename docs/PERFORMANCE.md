# 性能报告

实测于 **2026-08-15**，机器为 **nbus VPS（2 核 1.9G）**。本文档只记录网关在真实
生产机器上的资源占用与吞吐表现，全部数字来自服务器端实测，不是基准测试工具的
合成数据。数据面与上游交互的延迟几乎全部来自上游，网关自身是毫秒以下的纯本地
开销，所以本报告重点量化的也是网关本机的处理路径。

## 环境

| 项 | 值 |
|---|---|
| 机器 | 2 核 / 1.9G 内存 VPS，Debian 12 |
| Node | v22.20.0 |
| 进程托管 | systemd：`--max-old-space-size=256` + `MemoryMax=320M` + `OOMScoreAdjust=500` |
| 监听 | `0.0.0.0:8787`（去盾直连，FurCDN 直连网关，链路无盾） |
| 部署形态 | 仅 `dist/`，无 `node_modules`（零运行时依赖） |

## 内存

- 网关进程 RSS ≈ **93MB**（约 36% 的 256M 堆上限）
- cgroup 内存 ≈ 44MB
- 24h 内 **OOM 0 条、崩溃 0 次**
- 优化前基线：同机白天曾出现 693 次 OOM（是同一进程的对比数据）

## CPU

- load average（1 / 5 / 15 分钟）= **0.03 / 0.04 / 0.01**
- 进程 CPU 占用接近 0%（本地轻量路径 + 上游等待为主，几乎不烧 CPU）

## 延迟

本机端点（`127.0.0.1:8787`，去盾直连）实测 p50 / p95 / max：

| 端点 | p50 | p95 | max |
|---|---|---|---|
| `GET /healthz` | 0.47ms | 1.74ms | 16.32ms |
| `GET /v1/models` | 0.58ms | 1.13ms | 3.91ms |
| 面板 API | 2.05ms | 2.79ms | 11.93ms |
| 数据面 TTFB | 1.3s | — | — |

数据面 TTFB 的 1.3s 几乎全部来自上游生成首个 token，网关本地处理 < 1ms。
健康检查与模型发现都是毫秒级以下，属纯本地响应。

## 吞吐与并发

20 并发 × 50 次压测，**错误率 0**：

| 端点 | RPS | 错误率 |
|---|---|---|
| `GET /healthz` | 935 | 0 |
| `GET /v1/models` | 1250 | 0 |

## 并发门

数据面在飞上限 `MAX_CONCURRENT_REQUESTS` 默认 **400**，超限返回 `503` +
`Retry-After: 1`（错误 `type: overloaded_error`），请求体被消费防 keep-alive
污染。`0` = 不限（不推荐：历史上曾是本进程唯一 OOM 向量）。该行为有 e2e 测试
覆盖。

## 功能回归

**13/13 PASS**，覆盖：healthz、面板、登录、accounts、console billing、
legacy Go 订阅 zen、模型目录、模型授权、keys usage、双协议数据面。

## 性能优化点

- **数据面并发在飞门**：超限 503 + `Retry-After`，挡住突发打满
- **零运行时依赖**：部署只有 `dist/`，无 `node_modules`，启动与内存开销最小
- **每请求零 SQLite 同步读**：用量库批量异步落库，数据面路径不碰同步 I/O
- **key 池冷却持久化**：失败分级冷却跨重启保留，探活不空转
- **10s 缓存分层**：上层数据（billing/模型目录等）短 TTL 缓存 + 单飞
- **面板 tick TTL 防抖**：面板轮询不拖累数据面

## 结论

网关本机是毫秒以下的轻量层：内存常驻 ~93MB、24h 零 OOM 零崩溃、本机端点
p50 亚毫秒、千级 RPS 且错误率 0。资源占用几乎可忽略（load < 0.05、进程 CPU
近 0%），性能瓶颈完全在上游生成侧，不在网关。对 2 核 / 1.9G 的共享 VPS 而言，
网关不会挤掉同机其他服务（systemd 限流 + OOMScoreAdjust 保证）。

## 如何复测

**注意：key 不出服务器。** 复测只打本机端点（`127.0.0.1:8787`），命令全部在
服务器上执行；涉及鉴权的端点用服务器本地的 key，只走 loopback，不暴露到外部。

### 延迟计时（curl）

healthz 无需鉴权，直接计时（200 次取 p50 / p95 / max）：

```bash
for i in $(seq 1 200); do
  curl -s -o /dev/null -w '%{time_total}\n' http://127.0.0.1:8787/healthz
done | sort -n \
  | awk 'NR==100{p50=$1} NR==190{p95=$1} {if($1>max)max=$1} END{printf "p50=%.3fms p95=%.3fms max=%.3fms\n", p50*1000, p95*1000, max*1000}'
```

复测 `/v1/models` 时若本机没开 `ALLOW_UNAUTHENTICATED`，带上服务器本地的 key
（`Authorization: Bearer <本地 key>`，只发往 loopback）：

```bash
curl -s -o /dev/null -w '%{time_total}\n' \
  -H "Authorization: Bearer $KEY" http://127.0.0.1:8787/v1/models
```

### 并发压测（node 最小脚本）

保存为 `bench.mjs`（20 并发 × 每 worker 50 次 = 1000 请求，打 healthz，
无 key）：

```js
const URL = 'http://127.0.0.1:8787/healthz';
const CONCURRENCY = 20;
const PER_WORKER = 50;
let done = 0;
let errs = 0;
const t0 = performance.now();
async function worker() {
  while (done < PER_WORKER * CONCURRENCY) {
    done++;
    try { await fetch(URL); } catch { errs++; }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const secs = (performance.now() - t0) / 1000;
console.log(`requests=${done} errors=${errs} rps=${(done / secs).toFixed(0)}`);
```

```bash
node bench.mjs
```

### 内存（ps）

```bash
ps -o rss=,vsz=,cmd= -p $(pgrep -f 'main.js' | head -1)
```

或看 systemd 视角（Memory 即 cgroup 用量）：

```bash
systemctl status fuckopencode.service --no-pager
```

### 系统负载

```bash
uptime    # load 1 / 5 / 15
```

### OOM / 崩溃

```bash
journalctl -u fuckopencode.service --since '24 hours ago' | grep -iE 'oom|killed' || echo 'no oom/killed in last 24h'
dmesg | grep -i oom || echo 'no kernel oom record'
systemctl show fuckopencode.service -p NRestarts   # 重启计数
```
