# Key 池可观测面板 —— 把「只有我能算出来的东西」搬到面板上

## 起因

用户问「有个 key 是不是用完了」，我给出了答案（`****ZOBb` 额度耗尽、08:01:42 恢复、
还剩 6 小时）。但这个答案的来源是：

1. `journalctl` 里翻到一行 `[keypool] disabled key=****ZOBb reason=quota-exhausted cooldown=22680s`
2. 读 `src/keypool.ts:210-219` 源码，搞清 22680s = 上游给的 22620s + 60s 余量
3. 在服务器上手算 `date -d @$((S+22680))`

**面板上只有一行 `pool 1/2`。** 用户的要求：我能知道的一切都要在面板看到 ——
当前几个号在扛并发分流、每个 key 的状态备注、以及历史累计用量（要落 SQL）。
Key 本身继续用星号挡住（现有 `keyFingerprint()` 只留末 4 位，已符合）。

## 现状（已核实）

| 层 | 现在有什么 | 缺什么 |
|---|---|---|
| `keypool.ts` | `PooledKey` 内部有 `disabledUntil`/`failCount`/`inFlight`/`lastUsedAt`/`lastFailAt` | 只暴露 `size`/`healthyCount`/`disabledFingerprints()` 三个聚合值；**禁用原因没存**（只在 `KeyStateEvent` 里飘过） |
| `metrics.ts` | 每条 `RequestEvent` 带 `keyFingerprint`，窗口 200 条 | 无 per-key 聚合；窗口滚过就没了；重启清零 |
| `server.ts:296` | `/__metrics` 回 `pool: {size, healthy, disabled[]}` | 无 per-key 明细 |
| `dashboard.ts:209,524` | 顶栏 `pool 1/2` 一行 | 无 key 池分节 |

线上事实（已实测）：Node **22.20.0**，`node:sqlite` 免 flag 可用（有 ExperimentalWarning）；
磁盘 15G 可用；网关常驻 92MB / `MemoryMax=400M`。`package.json` 零 `dependencies`。

## 设计

### 1. `keypool.ts` —— 暴露 per-key 快照 + 记住禁用原因

`PooledKey` 加两个字段（都是**记录**用，不参与选路逻辑）：

- `disabledReason?: UpstreamFailureKind` —— 禁用原因，`markFailure` 里赋值，恢复时清空
- `totalAcquired: number` —— 该 key 被选中次数（进程级累计，`acquire()` 里自增）

新增 `snapshot(): PoolKeySnapshot[]`，每项：

```ts
{
  fingerprint: string;        // ****ZOBb，已脱敏
  healthy: boolean;
  inFlight: number;           // 当前并发 —— 「几个号在扛分流」的直接答案
  failCount: number;          // 连续失败数
  disabledReason?: string;    // quota-exhausted / auth / rate-limit / transient
  disabledUntil: number;      // 0 = 未禁用；否则恢复时刻的绝对时间戳
  recoverInMs: number;        // 还剩多久（面板直接倒计时，不用自己算）
  lastUsedAt: number;
  totalAcquired: number;
}
```

**要点**：`disabledUntil` 给绝对时间戳 + `recoverInMs` 给相对值，两者都给。
面板显示「恢复于 08:01:42（还剩 5h58m）」不需要任何推算 —— 这正是我这次手算的那步。

### 2. `usagedb.ts`（新文件）—— 历史累计落 SQLite

用 **`node:sqlite`**（Node 22 内置，**不引入任何 npm 依赖**，守住"零运行时依赖"卖点）。

```
/root/fuckopencode/data/usage.db     # 注意：不在 dist/ 下
```

**为什么不在 `dist/`**：`scripts/deploy.sh:67-69` 每次部署 `rm -rf dist.prev; mv dist dist.prev; mv dist.new dist`，
db 放 dist 里会随部署被换走/被回滚带走。放 `data/` 与部署产物解耦。

表结构（两张，都极小）：

```sql
-- 每请求一行，用于任意区间回溯（这是「历史所有请求」）
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,              -- epoch ms
  key_fp TEXT NOT NULL,             -- ****ZOBb，只存指纹，绝不存原文
  model TEXT, upstream_model TEXT, endpoint TEXT,
  status INTEGER, duration_ms INTEGER, stream INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, thinking_tokens INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_key_at ON requests(key_fp, at);
CREATE INDEX IF NOT EXISTS idx_requests_at ON requests(at);

-- key 状态变更审计（禁用/恢复），回答「这个 key 今天被禁过几次」
CREATE TABLE IF NOT EXISTS key_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  key_fp TEXT NOT NULL,
  type TEXT NOT NULL,               -- disabled | recovered
  kind TEXT,                        -- quota-exhausted / auth / ...
  cooldown_ms INTEGER,
  healthy_count INTEGER, pool_size INTEGER
);
CREATE INDEX IF NOT EXISTS idx_key_events_key_at ON key_events(key_fp, at);
```

**三条承重设计**：

1. **可降级，绝不因为落盘失败影响代理。** `node:sqlite` 不可用（Node 20）或
   打开失败（盘满/权限）→ 记一条 warn，`usagedb` 退化成 no-op，面板照常工作、
   只是没有历史累计。`engines: >=20` 的承诺不破。**代理链路一个字节都不受影响。**
2. **写入必须 fire-and-forget，不能卡请求。** 单条 `INSERT` 用 prepared statement，
   包在 try/catch 里；`node:sqlite` 是同步 API，单条插入亚毫秒级，且开
   `PRAGMA journal_mode=WAL` + `synchronous=NORMAL`（这台机器是 VPS，不追求
   断电零丢失，追求不阻塞）。
3. **保留期封顶。** 每天清一次 `at < now - RETENTION` 的行（默认 30 天），
   防止 db 无限长。1.9G 内存的小机器，按当前 ~700 req/9h 算，30 天约 5.6 万行、
   几 MB，可控。

新增 env（都有默认值，不配也能跑）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `USAGE_DB_PATH` | `<代码目录>/data/usage.db` | 空串 = 显式关闭持久化 |
| `USAGE_DB_RETENTION_DAYS` | `30` | 0 = 不清理 |

### 3. `/__metrics` 扩展

`pool` 从三个标量扩成：

```jsonc
"pool": {
  "size": 2, "healthy": 1,
  "disabled": ["****ZOBb"],          // 保留，向后兼容（面板顶栏与既有测试在用）
  "keys": [ /* PoolKeySnapshot[]，见上 */ ],
  "history": {                        // 来自 SQLite；不可用时为 null
    "since": 1786250000000,
    "byKey": [{ "fingerprint": "****0osU", "requests": 604, "tokens": 1240000,
                "ok": 598, "failed": 6, "lastAt": 1786298007940 }],
    "recentKeyEvents": [{ "at": …, "fingerprint": "****ZOBb",
                          "type": "disabled", "kind": "quota-exhausted" }]
  }
}
```

`history: null` 时面板隐藏累计列，只显示窗口内数据 —— 降级路径在 UI 上也是干净的。

### 4. 面板新增 `KEY POOL` 分节

插在 Pipeline（Fig 2）之后、Models（Fig 3）之前，后续 Fig 编号顺移。
沿用现有 ASCII 终端风格与 `data-i18n` 双语机制（`I18N.en` / `I18N.zh` 各加词条）。

每个 key 一张卡：

```
 ****0osU   healthy                    in-flight 2
   window   118 req · 241k tok         累计 604 req · 1.24M tok
   last used 3s ago · fail 0

 ****ZOBb   disabled  quota-exhausted
   恢复于 08:01:42  (还剩 5h58m)       ← 前端按 recoverInMs 本地倒计时
   window   82 req · 190k tok          累计 118 req · 302k tok
   last used 12m ago
```

- `in-flight` 数值直接回答「几个号在扛并发分流」
- 状态备注**全自动生成**（用户已定：不用手编 env 标签）：
  `healthy` / `disabled` + 原因 + 恢复倒计时 + 连续失败数 + 最后使用
- 倒计时用 `recoverInMs` 在前端每秒自减，不依赖服务端轮询精度
- 颜色沿用现有 `.ok` / `.bad` class
- key 只以 `****XXXX` 出现（**贯穿全链路：日志、db、面板、API 都只有指纹**）

### 5. 测试

- `test/keypool.test.ts` 扩：`snapshot()` 各字段正确、`disabledReason` 随
  禁用/恢复正确置位与清空、`totalAcquired` 累计、**指纹不泄露原文**（沿用现有断言风格）
- `test/usagedb.test.ts` 新增：临时目录建 db → 写入 → 聚合查询正确 → 保留期清理生效 →
  **`node:sqlite` 不可用时降级成 no-op 不抛**
- `/__metrics` 的 `pool.keys` 形状断言（放 `test/e2e.test.ts`）

## 落地顺序

1. `keypool.ts`：加 `disabledReason` / `totalAcquired` / `snapshot()`（纯内存，先自洽）
2. `test/keypool.test.ts` 补测 → 跑 `npm test`
3. `usagedb.ts` + `config.ts` 两个 env + `test/usagedb.test.ts`
4. `server.ts`：`/__metrics` 接 `pool.keys` + `history`；请求结束处与
   `logKeyStateChange` 处接 db 写入
5. `dashboard.ts`：KEY POOL 分节 + i18n 词条 + 倒计时
6. `npm run typecheck` + `npm test` 全绿
7. 文档：`.claude/docs/DEPLOY.md` 补 `data/usage.db` 与两个新 env；
   `.claude/state/CURRENT.md` 记这次改动
8. 部署前**先问用户**（涉及线上重启），不擅自 `deploy.sh`

## 不做（避免顺手扩大）

- 不做 env 人工标签（用户已明确：自动生成）
- 不动 keypool 的**选路逻辑**（least-loaded / 冷却策略一行不改，只加记录字段）
- 不引入任何 npm 依赖（`node:sqlite` 是内置）
- 不做面板写操作（手动禁用/启用 key 属于运维动作，用户没要求，且面板暴露在公网隧道后）
- 不动 `DASHBOARD_OPEN=0` 的鉴权约束（面板含调用方 IP/UA，必须继续要 API key）
