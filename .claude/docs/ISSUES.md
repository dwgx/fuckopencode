# 已知问题

状态：`确认` 有复现路径 / `可疑` 只是读代码推断 / `已修` 本轮修掉 / `设计取舍` 不是 bug
/ `已证伪` 曾被记为缺陷，但查证后不存在

最后核对：2026-08-14（审计轮，`npm test` 1297 全绿、`tsc --noEmit` 干净），
行号已按当前 main 重新定位。

## 已证伪（2026-08-09 第二轮核查）

### I-8 「quota 正则过宽导致 key 被误判额度耗尽」— 不存在

CURRENT.md 曾把线上 503 归因于 [errors.ts](../../src/errors.ts) 的
`/balance|credit|billing|quota/i` 过宽，说它把含 quota 字样的错误判成
`quota-exhausted` → 1 小时长冷却。**查证后这条路径从未存在**：

- `quota-exhausted` 的三条判定信号都是严格匹配（`GoUsageLimitError` 类型、
  `usage[_ ]?limit|quota[_ ]?exceeded` 之类的词边界正则、message 里的确定短语）
- 那个宽正则只扫 `errorType` 字段，且优先级在后，命中后返回的是
  **`rate-limit`（3 秒短冷却）**，不是 quota-exhausted —— 方向刚好相反
- `git log -L` 确认自 `6f4d910` 引入起就是这个形态，没有中间版本

已顺手把宽正则收窄成精确枚举（`billing_error` / `CreditsError` /
`insufficient_balance`），并加了两条回归测试固化「含 quota 字样的非额度错误不长冷却」。

## 确认（2026-08-09 第二轮，已修）

### I-9 整池被禁时无任何日志 — 已修

线上 journal 实测：2026-08-09 20:16–20:19 有 **295 个 503**（不是先前记的 5 次），
`/v1/messages` 整池被禁约 3 分钟，窗口内只有 3 个 200。但**日志里只有 access 行**，
没有任何禁用记录，事后无法区分是 transient 累积、auth 还是额度耗尽。

反证上游 429：429 全部发生在 **12:35–12:48**，与 503 窗口相隔 8 小时，
不存在因果关系。所以 503 不是配额/限流触发的禁用。

- 根因：`PoolEmptyError` → 503 的三个分支（[server.ts](../../src/server.ts) 两条路径）
  全部静默返回，`markFailure` 里的禁用决策也没有任何输出
- 修法：
  - `KeyPool` 加 `onStateChange` 回调（注入式，保持纯逻辑可测），
    四种失败类型的禁用 + 冷却自然到期的恢复都上报，只带 key 指纹
  - `server.ts` 的 `logKeyStateChange` 打 `[keypool] disabled key=**** reason=... cooldown=...s pool=n/m`
  - 池空单独打 `[keypool] pool empty`，10s 节流并累计被拒次数，避免 295 行刷屏
- 待观察：真实根因仍未定（大概率是 transient 累积，`failThreshold=5`、
  `cooldownMs=300s`）。下次复发时日志会直接给出 reason 与 cooldown。

### I-10 流式脏数据被静默丢弃，客户端只看到断流 — 已修

`parseOpenAISSE` 一直静默丢弃非 JSON 行（自 `6f4d910` 起）。丢弃本身是对的
（不能把脏字节透给客户端），但**完全静默**：客户端拿到一个内容缺失却正常收尾的流，
报出的是通用 `Failed to parse JSON`，无从定位哪一层坏的。

注意 CURRENT.md 原先记的是「脏数据透传给客户端」，这个描述不准 —— 脏行从未透传。

- 修法：`parseOpenAISSE` 加 `onDirty` 回调（SSE 注释行 `:` 开头不算脏，
  `{` 开头但 JSON 解析失败也算脏，样本截断 200 字符）
- 两条流式路径都接上，**检测点在写出之前**（onDirty 在产出下一个 chunk 途中触发，
  那个 chunk 已越过脏数据边界，不能再写）：
  - chat 路径：中止且**不补 `[DONE]`**
  - 直通路径：中止并发 `event: error`（`overloaded_error`），标记 `transient` 失败
- 直通路径循环后**必须再查一次**：`openAIStreamToAnthropic` 缓冲整个 text 块到
  收尾统一产出，脏行在流末尾时最后一次迭代之后才触发 onDirty

## 已修（2026-08-09 部署轮）

### I-0 content 字符串被上游拒为 "Empty input messages" — 已修

opencode Zen 只认内容块数组。Claude Code 发 `content: "hi"` 字符串形式时，
`/v1/messages` 全部失败，错误信息 `Empty input messages` 极具误导性。
**这是线上一直存在的问题**，旧版本同样有，部署验证时实测发现。

- 复现：直连上游对比，`content:"hi"` 失败 / `content:[{type:"text",text:"hi"}]` 成功
- 修法：`normalizeMessageContent` 转成单 text 块（[deepseek.ts](../../src/deepseek.ts)）
- 空字符串不转（转空数组会再次触发同一错误）

## 已修（2026-08-09）

### I-1 chat 端点发顶层 reasoning_effort，DeepSeek 必 400 — 已修`request.ts` 把 OpenAI `reasoning_effort` 写成 Anthropic 顶层字段，
但 DeepSeek 只认 `output_config.effort`（[deepseek.ts:14](../../src/deepseek.ts) 自己的文档就写了这条）。
直通路径做了转换，chat 路径没做。

- 复现：`POST /v1/chat/completions` 带 `reasoning_effort: 'high'`，
  抓上游请求体，能看到顶层 `reasoning_effort`
- 修法：[request.ts:98](../../src/request.ts) 改为写 `output_config: {effort}`
- 同步更新了 `test/request.test.ts` 里断言旧行为的用例

现状（2026-08-09 改造后）：chat 路径直发 OpenAI 协议，`reasoning_effort`
原样透传、不再需要转换；直通路径的映射在
[deepseek.ts:136-143](../../src/deepseek.ts)（`output_config.effort`，
disabled 时连 effort 一起删）。本条作为「双路径适配漏一边就出单边 bug」
的历史教训保留。

### I-2 流式漏发 finish_reason — 已修

上游只发 `message_stop` 而没有 `message_delta` 时，`stream.ts` 直接 return，
OpenAI 客户端永远收不到 `finish_reason`，可能一直等或报错。
上游被掐断（两个事件都没有）时同样漏发。

- 复现：喂 `[content_block_delta, message_stop]` 给 `anthropicStreamToOpenAI`，
  所有 chunk 的 `finish_reason` 都是 null
- 修法：加 `emittedFinish` 状态位，`message_stop` 和迭代结束时兜底补发
  （[stream.ts:205-208](../../src/stream.ts)）

### I-6 SSE 解析缓冲区无上界 — 已修（2026-08-09，eac0f43）

`sse.ts` 的 `buffer` 只在遇到 `\n` 时才切分。上游若发一个超长无换行的流，
buffer 无限增长。修复后 `SSE_BUFFER_MAX_CHARS=1MB`（[sse.ts:24](../../src/sse.ts)）：
`parseOpenAISSE` 超限抛错（[sse.ts:87-89](../../src/sse.ts)）、
历史 `parseAnthropicSSE` 三处上限（[sse.ts:154-156/166-168/194-196](../../src/sse.ts)）。

- 回归测试：`test/stream.test.ts:330-333`（超长单行断流）、`:335-340`（合法短行不触发）

## 确认（未修）

### I-3 chat 路径与直通路径的 deepseek 适配是两套实现

不是单个 bug，是 bug 的来源。`normalizeAnthropicRequest` 只在 `/v1/messages` 上跑，
chat 路径靠 `request.ts` 自己内联。任何 deepseek 怪癖的修复都得写两遍，
漏一边就出单边 bug —— I-1 正是这么产生的。

chat 路径目前**没有**的适配：剥 `context_management`、剥工具的 `strict`/`defer_loading`、
剥 `output_config.format`、剥内置 `web_search` 工具。这些字段 OpenAI 客户端
一般不会发，所以暂时没炸。

2026-08-09 更新：这一轮又被印证一次。keypool 只接在上游转发层（两条路径共用
`postAnthropic` 所以侥幸没事），但 `content` 字符串转换（I-0）只需在直通路径修，
chat 路径因为 `normalizeMessages` 恰好已产出块数组而免疫 —— 属于运气，不是设计。

- 建议：把 deepseek 归一化提成一道统一的出口收尾，两条路径转换完都过一遍
- 优先级：高，属于架构债，不修就会继续出同类 bug

2026-08-11 更新：改造后 chat 路径直发 OpenAI 协议，适配面已不对称——
直通路径的适配集中在 `normalizeAnthropicRequest`（deepseek.ts），chat 路径只剩
「模型映射 + 剥扩展字段」；上面「chat 路径没有的适配」清单（`context_management`/
`strict` 等 Anthropic 专属字段）对现架构已无意义，OpenAI 请求里不会出现。
残余的双路径债主要在直通路径内部（归一化 vs toOpenAI/toAnthropic 各管一层，
DSML 兜底非流式/流式两处接线）。见 [ARCHITECTURE.md](ARCHITECTURE.md)。

### I-4 max_tokens 下限保护违反客户端意图

thinking 非 disabled 时，`max_tokens` 会被静默抬到 4096
（直通 [deepseek.ts:275-281](../../src/deepseek.ts)；chat 路径已对齐，[server.ts:2837-2854](../../src/server.ts)，d359338）。
客户端显式要 200 却按 4096 计费，且响应里没有任何提示。

- 这是刻意取舍（空回复 vs 超预算），但客户端无从得知
- 2026-08-14 更新：chat 路径已补回对齐（P1-G），「静默抬升、无提示」核心问题两条路径都仍在
- 建议：至少在日志里记一行「max_tokens 200 → 4096」，便于排查账单疑问

### I-5 /v1/messages 不加 system 护栏

`buildSystemGuard` 只在 chat 路径调用（[server.ts:2820-2822](../../src/server.ts)）。
直通路径的 system 原样转发，L4 防护对 Claude Code 完全不生效。

- 复现：`POST /v1/messages` 带 `system`，上游收到的 system 不含护栏文本
- **但这可能是对的**：直通端点的语义就是不改写请求体，而且往 Claude Code 的
  system prompt 里插入中文安全约束可能干扰它的正常工作
- 需要你定：是补上护栏（安全一致），还是明确写进文档说直通端点不做 L4（保持直通语义）

### I-7 writeChunk 的监听器可能累积 — 确认（仍在）

[server.ts:96-106](../../src/server.ts) 每次背压都 `res.once('drain'|'close'|'error')`。
resolve 后另外两个监听器不会被摘掉。长流 + 频繁背压下监听器会累积，
可能触发 MaxListenersExceededWarning。

- 2026-08-14 审计确认仍在（state.md P2 F5）
- 修法：用具名函数 + `removeListener` 收尾
- 未构造复现（需要慢客户端 + 长流）

### I-11 面板用量 tab 三请求非 usage 视图每 2s 空转 — 确认（未修）

`admin.ts` 的 `tick()`（[admin.ts:2958-2992](../../src/admin.ts)）每 2 秒无条件调用
`fetchRequests()`/`fetchIpStats()`/`fetchAudit()`（`:2973-2975`），这三个请求渲染的
全是 `view-usage`（用量 tab）内容。`curView` 在非 `usage` 视图（总览/账户/密钥等）
时，每次 tick 都白打 3 个请求，只更新隐藏 DOM，无人可见。

- 审计 P2 确认（不涉及正确性，纯浪费；慢网络下还在 2s 无 in-flight 防护叠加，见 I-12）
- 修法一行：tick 里 `if (curView === 'usage')` 才发这三个请求

### I-12 面板 2s tick 无 in-flight 防护，慢网络请求叠加 — 确认（未修）

`admin.ts` 的 `tick()` 与 `dashboard.ts` 每 2s 发一批请求，没有 in-flight 去重。
慢网络下上一轮请求未返回，下一轮又发出，积压可叠加（与 I-11 同一批 tick 调用）。
审计 P2 确认，建议给 tick 请求组加 in-flight 门（进行中跳过本轮）。

### I-13 flush() 整批丢弃面宽：transient 写失败连坐丢整批 — 确认（未修）

`usagedb.ts` 的 `flush()`（[usagedb.ts:863-893](../../src/usagedb.ts)）在 `:870` 先把
`pendingRows` 清空再写事务，`:887-890` catch 里整批丢弃并记日志。任何一条写入
transient 失败（如 SQLite busy/lock）都连坐丢掉整个批（最多 50 条真实请求记录），
后续积压照常但这一批不再重试。

- 比文档宣称的「崩溃最多丢最后一批」更宽：transient 错误也丢
- 修法：失败时把该批放回队首重试 1 次（仍失败再丢），避免无限重试拖住事件循环

### I-14 早期错误（401/415）不消费 body 不关连接 → keep-alive 污染 — 确认（未修）

`server.ts` 数据面鉴权失败/类型校验失败路径直接 `sendJson` 后 `return`，
不读请求体也不关连接：[server.ts:2343](../../src/server.ts)（401）、
`:2350-2352`/`:2361-2363`/`:2373-2375`（415，三条路径）。

对比同文件已修的先例：限流响应（[server.ts:1149-1153](../../src/server.ts)）
有 `connection: close` + `req.resume()` 双保险，注释明说「未消费的 body 残留在
socket 上，被当成下一个请求解析（keep-alive 假 400）」；并发超限 503 也做了
`req.resume()`（`:1907`）。401/415 路径漏了同样的处理 —— 带 body 的失败请求
（客户端重试/脚本）会污染 keep-alive 连接，下一条请求可能被残留字节打挂。

- 审计 F7 确认；修法与限流路径对齐：`req.resume()` + `connection: close`

### I-15 history/trend/ipStats 缓存返回内部引用 — 确认（未修）

`usagedb.ts` 三个带缓存的读方法直接把内部缓存对象返回给调用方：
- `history()` [usagedb.ts:1382-1383](../../src/usagedb.ts) 直接 `return this.historyCache`
- `usageTrend()` [usagedb.ts:1207-1208](../../src/usagedb.ts) 直接 `return cached.data`
- `statsByIp()` [usagedb.ts:1056-1061](../../src/usagedb.ts) 返回 `all.slice()` 切片
  （数组是新引用，但元素是缓存内同一对象）

任何调用方改动返回结构会污染缓存，后续 15s 内所有请求读到脏数据。当前调用方
都是只读渲染，所以是隐患不是故障；修法：返回前浅拷贝（或 `structuredClone`）。

### I-16 Origin 校验数组头放行 — 确认（未修，语义错误当前不可利用）

`adminOriginAllowed`（[server.ts:3258-3275](../../src/server.ts)）读
`req.headers.origin`，`:3260` 处 `typeof origin !== 'string'` 直接 `return true`。
攻击者发 `Origin: <valid>, <evil>` 逗号分隔数组头时，Node 会把多值头解析成数组，
校验直接放行 —— 语义上「多 Origin 任一匹配即放行」未被实现，而是全放行。

- 审计 P2 确认；浏览器发不出多值 Origin（fetch 只允许单值），所以当前不可利用
- 修法：origin 非 string 时按拒绝处理（fail-closed），与 host 缺失时 `return false` 对齐

### I-17 生产 MAX_BODY_BYTES=0（无上限）— 确认（部署配置问题，代码已安全）

代码默认 `maxBodyBytes = 64MB`（[config.ts:264](../../src/config.ts)），但线上
`fuckopencode.env` 设了 `MAX_BODY_BYTES=0`（无上限）。大 body 整读进堆 +
注入扫描/count_tokens 放大 = 认证客户端的内存/CPU DoS 面（配合 OOM 史）。
审计 P1-E 确认，代码默认值已是 64MB，**待办是改线上 env**：`0 → 33554432`。

### I-18 注入检测围栏降权吞 ignore-instr — 确认（未修）

`injection.ts` 的 `CODE_FENCE_SIGNAL_IDS`（[injection.ts:88-94](../../src/security/injection.ts)）
只含 `fake-system-tag`/`role-takeover`/`leak-prompt` 等高危标记，**不含**
`ignore-instr`/`ignore-instr-zh`（`:27/:32` 定义）。带语言标签的代码围栏整体降权、
只查这 5 个标记 —— 围栏内的「忽略以上指令」句式检测不到。定位是「降噪」不是
安全边界（设计取舍区内已注明），但 ignore-instr 正是注入句式里最常用的，降权后
基本失效。

### I-19 文档漂移：DEEPSEEK-QUIRKS 行号过期 + 模型白名单零文档 — 已修（2026-08-14）

- DEEPSEEK-QUIRKS.md 引用的 deepseek.ts 行号系统性过期（9 处 8 处错）——本轮已
  全部重新定位（deepseek.ts 现 533 行），并补 3 条新 quirk（0/13/14）。
- 账号级模型白名单（commit d1083b8）零文档——本轮已补进 MULTI-ACCOUNT.md。

### I-20 OTA 自更新未实现 — 确认（只有研究记录）

只有研究没有实现：CURRENT.md 记录「OTA 研究：cursorapi/windsurf/kirostudio 三项目
OTA 对比 + 改进提示词」，代码里没有任何自更新机制（无版本检查、无自动拉取发布、
无更新通道）。当前部署靠手动 scp + systemctl。
需要明确：不做（手动部署够用，但每次部署要人工介入）或做（轮询 GitHub release，
tag 门禁 + SHA256 校验 + 原子替换 + 崩溃回滚，参考对比项目的四段式 UX）。

## 设计取舍（不是 bug）

- **注入检测本质是正则黑名单**，能被改写句式绕过。定位是「降低噪声」不是「安全边界」，
  代码注释也写明了「宁漏报不误伤」。不要指望它拦住有意的攻击者。
- **`isLoopbackHost` 把 `0.0.0.0` 算作回环**（[config.ts:53](../../src/config.ts)）
  看着是 bug，但唯一调用方 `hostnameIsSafe` 会先排除 `0.0.0.0`，当前行为正确。
  这个函数一旦被别处复用就会变成真 bug，建议把 `0.0.0.0` 从里面移出去。
- **SSRF 的十进制/十六进制/八进制 IP 变形已被覆盖**：WHATWG `URL` 会把
  `http://2130706433/` 规范化成 `127.0.0.1`，`parseIpv4` 拿到的已是点分形式。已实测确认。
- **DNS rebinding 不防**：只做字面量判定，域名放行。上游代抓图片，
  真要防得在上游侧做，网关这层做不到。

## 我验证过的、结论是「没问题」的点

这些是我怀疑过、写了探针测试、结果证明实现正确的地方，记下来免得下次重复怀疑：

- 工具名消毒在定义和历史 `tool_use` 两侧一致（`normalize.ts` 已调 `sanitizeToolName`）
- `error` 事件后 `[DONE]` 仍会发出（`openAIStreamToSSE` 的 finally 语义保证）
- 以 `assistant(tool_use)` 开头的历史被丢弃时，孤立 `tool_result` 也会被丢，不会残留
- `count_tokens` 纯本地估算（字符数 / 4），不打上游，不涉及模型映射
