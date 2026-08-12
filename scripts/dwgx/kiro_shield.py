#!/usr/bin/env python3
"""
kiro_shield —— 429 拦截层（DWGX 维护）

原始实现来自 skiapi 栈的 shield / shield-k2cc（.62 上同一份代码跑两个实例，
靠 UPSTREAM/SHIELD_PORT 区分）。本副本由 **DWGX** 移植到 nbus，用来护住
`kirostudio(代挂 1439) → fuckopencode → DeepSeek` 这一跳 —— 那条链此前没有盾，
上游抖一下就直接把下游会话打断。

移植改动（全部集中在 FUCKOPENCODE_* 标记与本段说明，主逻辑保持与 .62 一致，
便于两边对照排查）：
  - 补 fuckopencode 自己的错误文案标记，见 `FUCKOPENCODE_TRANSIENT_MARKERS`。
    最关键的是 `all upstream keys are disabled`（key 池整池被禁时的 503）——
    2026-08-09 实测线上因此打出 295 个 503，盾装上后这类波动对下游不可见。
  - 其余分类逻辑、退避节奏、观测面板一字未改。

在 .62 上它放在 Caddy 与 KiroStudio 之间；在 nbus 上它放在 cloudflared 与
fuckopencode 网关之间（盾占 8787，网关退到 8788 —— 详见 .claude/docs/SHIELD.md）。
收到上游 429/5xx 时自己等待并重试，成功后才把响应交给客户端。
客户端（Cursor / Claude Code）永远看不到这些波动。

设计要点:
  - 429 是 HTTP 状态码，在流式响应开始之前返回，所以重试是安全的：
    重试期间一个字节都还没发给客户端。
  - 重试 429/5xx，外加**响应体里带明确瞬态标记**的 400
    （Kiro 把容量不足塞进 400，跟"请求写错了"同一状态码）。
  - 反过来，响应体带永久性标记（账号被封、请求非法）的一律不重试，
    即使状态码是 5xx —— 重试只是徒劳烧预算。
  - 2xx 永不预读，直接流式转发，保证 SSE 实时性。
  - 有总时间预算，超预算返回 503（不是 429）—— Cursor 对 503 不会
    像对 429 那样立刻停止会话。
  - 零第三方依赖，只用标准库。

用法:
  python3 kiro_shield.py
环境变量（默认值沿用 .62 那边的形态，nbus 上由 systemd unit 显式覆盖）:
  SHIELD_HOST        监听地址        默认 127.0.0.1
  SHIELD_PORT        监听端口        默认 8993（nbus 实际用 8787）
  UPSTREAM           上游地址        默认 http://172.30.0.1:8990
                                     （nbus 实际用 http://127.0.0.1:8788）
  MAX_BUDGET_SECS    总重试预算(秒)   默认 600
  MAX_ATTEMPTS       最大尝试次数     默认 60
  MAX_CONCURRENCY    最大并发请求数   默认 200（超出直接回 503，不为风暴开线程）
"""

import collections
import http.server
import itertools
import json
import os
import re
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """不跟随 3xx 重定向（见 Handler._attempt 的注释：登录 302 不能被吞）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HOST = os.environ.get("SHIELD_HOST", "127.0.0.1")
PORT = int(os.environ.get("SHIELD_PORT", "8993"))
UPSTREAM = os.environ.get("UPSTREAM", "http://172.30.0.1:8990").rstrip("/")
MAX_BUDGET = float(os.environ.get("MAX_BUDGET_SECS", "600"))
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "60"))

# 并发上限：ThreadingMixIn 每请求一线程，请求风暴期会无限开线程直到把进程
# 打死（MemoryMax=128M，实测挂过，只能靠重启恢复）。这里给并发加闸：满时
# 直接回 503，不排队、不再开线程 —— 503 对客户端可重试，比把盾整个拖死好。
MAX_CONCURRENCY = max(1, int(os.environ.get("MAX_CONCURRENCY", "200")))

# 逐跳头，不能转发。
# 注意：**host 不在这里** —— 代理必须转发原始 Host。曾把 host 误放进这张表，
# 导致转发后 urllib 自动补 `Host: 127.0.0.1:8788`，网关的 Origin 校验
# （Origin hostname vs Host hostname）全部 403 —— 面板任何写操作都失败。
# content-length 由 urllib 按 body 自动重算，删掉避免不一致。
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-length",
}

_stats_lock = threading.Lock()
STATS = {"requests": 0, "retries": 0, "absorbed": 0, "gave_up": 0,
         "rejected": 0, "swap_waits": 0, "swap_gave_up": 0, "cool_waits": 0,
         "auth_waits": 0, "perm_waits": 0, "perm_gave_up": 0,
         "client_waits": 0, "client_gave_up": 0, "by_status": {}}

# 异常事件环形缓冲。只留最近 N 条，够看「刚才发生了什么」，
# 又不会在长跑进程里无限吃内存（每条约 1KB，600 条 ≈ 600KB）。
EVENTS_MAX = int(os.environ.get("SHIELD_EVENTS_MAX", "600"))
_events_lock = threading.Lock()
EVENTS = collections.deque(maxlen=EVENTS_MAX)
_event_seq = itertools.count(1)

# 每种分类的中文名与处置说明。界面直接用这份，避免前端再抄一遍口径。
VERDICT_META = {
    "retry": {
        "name": "瞬态错误",
        "how": "指数退避重试（1s 起，1.7 倍增长，上限 12s），最多 60 次 / 600 秒预算",
        "why": "限速或上游抖动，等一下就好",
    },
    "cool": {
        "name": "号池冷却",
        "how": "按网关给的 Retry-After 等待（典型 10s），反复不恢复才 1.6 倍升档，上限 60s",
        "why": "网关自己算得出恢复秒数，听它的真值比本地猜准",
    },
    "swap": {
        "name": "换号空窗",
        "how": "长退避（20s 起，1.4 倍增长，上限 60s），独立 900 秒预算",
        "why": "账号被封或 region 错配，恢复要等补号，约 10 分钟",
    },
    "auth": {
        "name": "未知 4xx（兜底拦截）",
        "how": "与冷却同节奏：听 Retry-After + 升档，独立 900 秒预算",
        "why": "措辞不认识的 4xx，默认拦住而不是放走；403 多是凭据/风控，不能用 1 秒退避猛打",
    },
    "pass": {
        "name": "直接透传",
        "how": "原样返回给客户端，不重试",
        "why": "仅护盾自身观测端点会走到这里；业务路径已全部改为拦截",
    },
    # 注：这里不能用 f-string 引用 PERM_* 常量 —— 本字典在文件顶部求值，
    # 而那些常量定义在下方约 200 行处，会直接 NameError。
    # 真实数值通过 /_shield/events 的 config 字段给界面，此处只留文字说明。
    "client": {
        "name": "客户端自身错误（极短窗）",
        "how": "短退避 2s × 2 次 / 6s 预算，耗尽返回 503（不透传原始错误）",
        "why": "API key 填错、路径不存在 —— 实测这类请求 0.0003 秒就被网关鉴权门拒绝，"
               "压根没取凭据，号池的禁号换号机制救不了它；久等只是空转",
    },
    "perm": {
        "name": "确定性错误（短窗拦截）",
        "how": "短退避 8s × 5 次 / 45s 预算，耗尽后返回 503（不透传原始错误）",
        "why": "key 填错、上下文超限、凭据类型不支持、面板操作 —— 等待不改变结果，"
               "但按要求不透传；用短预算避免客户端白等 15 分钟",
    },
    "network": {
        "name": "网络层失败",
        "how": "当瞬态处理，指数退避重试",
        "why": "连不上上游，通常是上游重启或网络抖动",
    },
}


def record_event(status, verdict, path, payload, attempts, waited,
                 outcome, retry_after=None, note=""):
    """记一条异常事件。

    outcome 是**最终**处置：absorbed(重试后成功) / passed(透传给客户端) /
    gave_up(预算耗尽返 503) / retrying(还在重试中) / client_gone(客户端先断了)。
    """
    body = ""
    if payload:
        try:
            body = payload[:1200].decode("utf-8", "replace")
        except Exception:
            body = repr(payload[:1200])
    evt = {
        "seq": next(_event_seq),
        "ts": time.time(),
        "status": status,
        "verdict": verdict,
        "path": path,
        "body": body,
        "attempts": attempts,
        "waited": round(waited, 1),
        "outcome": outcome,
        "retry_after": retry_after,
        "note": note,
    }
    with _events_lock:
        EVENTS.append(evt)
    return evt


def log(msg):
    sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    sys.stderr.flush()


# 这些状态码视为瞬态，重试。
#   429           = 限速
#   500/502/503/504 = 网关/上游抖动，也含"凭据全禁用"这类换号空窗
# 4xx（401/403/400 等）默认不重试 —— 那是配置错误，等 10 分钟也不会好。
RETRYABLE = {429, 500, 502, 503, 504}

# 客户端**自己**的错误：请求还没碰到凭据就被网关拒了。
#
# 实测（2026-08-07 直连 8990）：这类响应 0.0003 秒返回，KiroStudio 日志
# 不产生任何上游调用记录 —— 压根没取凭据，所以「禁号换号」这套机制
# 对它完全不适用，号池换一百个号也还是同一个 401。
#
# 与之相对的是**上游凭据失效**（body 带 bearer token invalid /
# AccessDeniedException），那类会进 provider、触发失败计数与 auto_disable，
# 实测 3 次失败后**同一秒**就切到下一个凭据，秒级可恢复。
#
# 两者都不透传（用户要求），但等待时长必须分开：
# 对前者做长等待是纯空转，只是把「立刻报错」变成「卡住再报错」。
CLIENT_FAULT_BODY_MARKERS = (
    "Invalid API key",                   # 网关鉴权门拒绝，未取凭据
    "authentication_error",
    "Missing API key",
    "not_found_error",                   # 路径/资源不存在
    # fuckopencode 网关注入检测（injectionMode=block）的确定性拦截：内容是
    # 扫描出来的结果，重试多少次都是同一个 400。实测 2026-08-11 有 31 次
    # 这类响应落进 auth 长窗（5s→32.8s 升档，90s 预算）空转，客户端白挂
    # 一分半才收到错误。归 client 超短窗快速收敛。
    "message content violates content policy",
    # 网关 JSON 解析失败：请求体本身就坏，重试不会变好。
    "invalid JSON body",
)

# 这些 4xx 是**客户端自己**的问题，与上游无关，永不重试。
# 401 尤其关键：护盾前面就是 KiroStudio 的鉴权，key 填错就该立刻报错，
# 不能被兜底的 auth 节奏拖 900 秒。
CLIENT_FAULT_STATUSES = {401, 404, 405, 413, 414, 431}

# 例外：Kiro 会把一部分**瞬态**故障塞进 400，跟"请求写错了"同一个状态码。
# 实测 6 小时样本里 400 共 165 次，其中容量类 101 次、格式错 80 次。
# 只认这些明确的瞬态标记，其余 400 一律透传，避免把真正的格式错误
# 重试 60 次（那样只会让客户端干等 10 分钟才看到同一个错）。
TRANSIENT_BODY_MARKERS = (
    "INSUFFICIENT_MODEL_CAPACITY",       # 模型容量不足，等一下就有
    "MODEL_TEMPORARILY_UNAVAILABLE",     # 字面意思：临时不可用
    "ThrottlingException",               # 限速，有时不配 429
    "ServiceUnavailable",
    "InternalServerException",
    "InternalFailure",
    "SlowDown",
)

# DWGX 移植补充：fuckopencode（nbus 上的 OpenAI↔Anthropic 网关）自己产生的
# 瞬态文案。这些都会**自然恢复**，属于典型的"等一下就好"，绝不能透给下游。
#
# 为什么必须显式列出：这几条虽然状态码已落在 RETRYABLE（503/502）里、
# 靠兜底也能重试，但显式列举让观测面板能按文案归类，排查时一眼看出
# 「这次波动是 key 池空还是上游连不上」。文案取自 fuckopencode/src/server.ts。
FUCKOPENCODE_TRANSIENT_MARKERS = (
    # key 池整池被禁（含冷却未到期）。2026-08-09 实测：两个 key 双双被禁约
    # 3 分钟，打出 295 个 503。冷却到期会自动恢复，正是盾该吸收的形态。
    "all upstream keys are disabled",
    # 池内 key 瞬时 fetch 失败（网络错误/上游 TCP 层抖动）→ 502。
    "upstream unavailable",
    # 上游返回的 body 不是合法 JSON（截断/坏响应）→ 502。重试通常就好了。
    "upstream returned malformed body",
    # 直通流式路径检测到上游插入脏数据后主动中止的信号（见 src/sse.ts 的
    # onDirty）。非流式场景下会以错误体出现，同样值得重试。
    "upstream interrupted the stream",
)

# 账号被封 / 全池禁用。**要重试**，但节奏完全不同：
# KiroStudio 换号（auto_disable + 切下一个凭据 + 推送补号）实测有约 10 分钟
# 的空窗，期间所有请求都是 403。这类等得起，所以给长退避 + 长预算，
# 让客户端在换号完成后自动恢复，而不是当场断会话。
# 关键：绝不能用限速那套 1 秒退避 —— 那是拿一个已被封的账号去猛打上游，
# 只会加重风控。
SWAP_WINDOW_MARKERS = (
    "AccessDeniedException",             # 账号被封（实测 6h 内 3615 次）
    "TEMPORARILY_SUSPENDED",
    "no available credential",
    # region 错配：KiroStudio 判定凭据的 region 猜错了(eu-central-1 → us-east-1)，
    # 换区重试后仍 403。它会把上游的 AccessDeniedException 包进
    # `403 permission_error`，措辞是「疑似 region 错配，已换区…重试」。
    # 恢复依赖换号/补号，节奏与封号同级，所以归 swap 而非 auth。
    "region 错配",
    "bearer token included in the request is invalid",
)

# 号池**冷却**（不是封号）。网关自己算得出恢复秒数并放进 `Retry-After`，
# 所以这类**必须听网关的真值**，不能套 SWAP 的 20~60 秒阶梯。
#
# 为什么必须和 SWAP 分开（2026-08-04 实测）：
#   KiroStudio 全池不可用时返回 429 + `Retry-After: 10`，body 是
#   "All credentials are temporarily cooling down. Please retry after the indicated delay."
#   而 `"All credentials"` 原先挂在 SWAP_WINDOW_MARKERS 里 → 判 swap →
#   走 swap_delay() 的 20→28→39→55→60 秒阶梯，**把 Retry-After 完全丢掉**，
#   等了真实恢复时间的 2~6 倍。线上日志即 `429 swap-wait 55s, try 4`。
#   当晚 1753 次「所有凭据均已禁用」失败就是这么来的。
#
# 冷却与封号的恢复时间差一个数量级（秒 vs ~10 分钟），用同一套退避必然一头错。
COOLING_MARKERS = (
    "temporarily cooling down",          # handlers.rs 全池冷却分支的客户端文案
    "All credentials are temporarily",
    # 网关**自己**的入站整形背压(handlers.rs 的 inbound_admission_timeout 分支)。
    #
    # 为什么归到 cool 而不是 retry(2026-08-04 实测):两条路径都听 Retry-After,
    # 差别在**升不升档** —— retry 路径是恒定 10s,600s 预算能砸 60 次;
    # cool 路径 10→16→25.6→41→60s 升档,约 18 次就用完。恒定砸 60 次
    # 正是"无视背压":网关说"我满了",却以固定频率继续敲同一个满桶。
    #
    # 为什么不归到 PERMANENT(永不重试):准入超时是"等容量"信号而非"请求非法",
    # 队列排空后重试是会成功的。带升档退避的重试才是对背压的正确响应。
    #
    # 注:网关**内置**吸收层对这条的判定相反(不可吸收) —— 那是因为内层重试会
    # 重新穿越同一个准入闸门(单请求吃 N 个令牌);而 shield 在网关**外面**,
    # 它的重试是一次全新的客户端请求,走正门,不破坏那个不变量。两层结论不同是对的。
    "inbound rate shaping",
)

# 注：**不要**再加 `所有凭据均已禁用` 这类中文标记。那是 KiroStudio 的内部 bail 串，
# 只出现在它自己的日志/traces 里；经 map_provider_error 渲染后客户端收到的是上面那句英文。
# 原先写的 `所有凭据均已被` 更是连内部串都对不上（实际是「均已禁用」），双重失效。

# 这些出现在响应体里就**绝不**重试，即使状态码落在 RETRYABLE 里。
# 请求本身非法，等多久都一样，重试只是让客户端白等。
PERMANENT_BODY_MARKERS = (
    "REQUEST_BODY_INVALID",              # 工具格式错，就是 Agent 模式那个坑
    "INVALID_MODEL_ID",
    "CONTENT_LENGTH_EXCEEDS_THRESHOLD",  # 上下文超限，重试也超
    # 凭据类型本身不支持的操作。实测 2026-08-06 23:39 面板批量点刷新时，
    # custom_api 类型的号回这个 400，被兜底的 auth 节奏重试了 19 次 / 851 秒。
    # 号的类型不会因为等待而改变，这是**定义域**错误，不是瞬态故障。
    "凭据不支持刷新",
    "不支持刷新 Token",
    # 模型不在该号池的订阅档位/成本白名单内。换号也解决不了（是档位问题），
    # 客户端应当立刻知道并换模型，而不是干等预算耗尽。
    "不被本号池支持",
    "stats_disabled",                    # 用量统计未启用，是配置状态而非故障
)

# 只有**推理请求**值得长窗重试。
#
# 护盾的职责是替推理请求吸收上游抖动：那类请求是 Cursor / Claude Code 发的，
# 客户端拿不到 200 就会断会话，所以等 10 分钟也比当场失败好。
#
# 面板与管理接口完全相反 —— 那是人点出来的交互操作，背后有人盯着转圈。
# 实测把 /api/admin/credentials/1033/refresh 重试 19 次、拖 851 秒，
# 最后仍返回 503：既没救回来，还让面板卡死 14 分钟。
#
# 所以非推理路径只吸收**明确瞬态**的 429/5xx（短退避，够扛住一次网关重启），
# 4xx 一律立刻透传。
INFERENCE_PATH_HINTS = (
    "/v1/messages",
    "/v1/chat/completions",
    "/v1/complete",
    "/v1/responses",
)


def is_inference_path(path):
    """这条请求是不是推理调用（值得为它等 10 分钟）。"""
    base = path.split("?", 1)[0]
    return any(h in base for h in INFERENCE_PATH_HINTS)


# 上游凭据失效：**能**被 KiroStudio 的禁号/换号机制救活。
#
# 实测换号是秒级的（连续失败 3 次 → 同一秒切换到下一个凭据），
# 所以这类给 90 秒预算足够覆盖「失败计数攒够 → 换号 → 重试成功」，
# 不需要 900 秒 —— 那是号池**全空**等人工补号的量级。
UPSTREAM_CRED_MARKERS = (
    "bearer token included in the request is invalid",
    "AccessDeniedException",
    "region 错配",
    "TEMPORARILY_SUSPENDED",
)


# 判定要看响应体，但不能把大响应整个读进内存。错误体都很小。
MAX_PEEK_BYTES = 4096

# 退避下限。低于这个值的等待毫无意义，只会空转烧预算。
MIN_DELAY = 1.0

# 流式请求在重试等待期间的心跳间隔。Cursor 实测 180 秒无字节即断连，
# 5 秒一次心跳留足余量，且对 SSE 客户端是无害的注释行。
KEEPALIVE_INTERVAL = float(os.environ.get("KEEPALIVE_INTERVAL_SECS", "5"))

# 换号期专用退避：起步就 20 秒，逐步拉到 60 秒。
# 换号要 10 分钟，1 秒一次等于 600 次无效请求；20-60 秒一次约 15-20 次，
# 既能及时发现恢复，又不会把上游打烂。
SWAP_DELAY_FIRST = 20.0
SWAP_DELAY_MAX = 60.0

# 号池冷却但网关**没给** Retry-After 时的兜底首轮等待。
# 取 5s 而非 SWAP_DELAY_FIRST(20s)：冷却是秒级现象，实测网关给的值典型为 10s，
# 没给值时按更短的起点试探，靠升档兜住长冷却。
COOL_DELAY_FALLBACK = float(os.environ.get("COOL_DELAY_FALLBACK_SECS", "5"))

# 换号期总预算，独立于普通瞬态错误的预算。
#
# 900 → 150（2026-08-07 实测修正）。原值基于「换号有约 10 分钟空窗」的假设，
# 实测该假设不成立：
#     01:19:59 凭据 #1103 已连续失败 3 次，已被禁用
#     01:19:59 已切换到凭据 #1095（优先级 0）
# 换号在**同一秒**完成。那 10 分钟是号池**全空**等补号的时间，是另一回事。
#
# 这个区别决定了预算该给多少：
#   - 真的在换号 → 秒级恢复，150s 绰绰有余
#   - 号池全空   → 等下去也没用，且此时**所有**请求都在等同一件事，
#                 长窗只会把连接堆在护盾里，不如快速回 503 让客户端重试
#                 （Cursor 对 503 会重试；挂 15 分钟则直接超时断会话）
#
# 150s 覆盖「连续失败 3 次触发禁号 → 换号 → 重试成功」，
# 按每次失败间隔 20 秒的最坏情况算也够两轮。
SWAP_BUDGET = float(os.environ.get("SWAP_BUDGET_SECS", "150"))

# auth（措辞不认识的 4xx 兜底）此前与 swap 共用 SWAP_BUDGET，实测有害：
# k2cc 会把上游原文包装成 "Upstream API call failed"，护盾看不到
# INVALID_MODEL_ID / REQUEST_BODY_INVALID 等永久标记（perm_waits 恒为 0），
# 于是 230 次确定性 400 全落进 auth，按 3600s 长窗空转 —— 换号一百次
# 也还是同一个 400，客户端只是白挂着。给 auth 独立短窗；真瞬态的
# 429/502 走 retry/swap 的长预算，0 透传不受影响。
AUTH_BUDGET = float(os.environ.get("AUTH_BUDGET_SECS", "90"))
AUTH_MAX_ATTEMPTS = int(os.environ.get("AUTH_MAX_ATTEMPTS", "8"))

# ---------------------------------------------------------------- 运行时可调
# 为什么需要热改：这些预算直接决定「客户端要挂多久」。之前把 auth 设成 3600s
# 导致确定性 400 空转一小时，而修正它却要改 compose + 重启容器 —— 重启会打断
# 正在进行的流式请求，且 20~60 秒内服务不可用。既然护盾是 Python，
# 参数就该能在线改：出问题当场调回来，不用重启、不影响在途请求。
#
# 只允许调「等多久」这类数值，不允许在线改判定表（标记表改错会让分类整体失效，
# 那种改动必须走代码评审 + 重新部署）。
_config_lock = threading.Lock()

# 可在线调整的键 → (最小值, 最大值)。范围是护栏：防止手滑填 0 或 999999
# 把服务设成「立刻放弃」或「永远挂住」。
# 被放行（不拦截、原样透传）的类别集合。面板上把某一类的开关关掉就写到这里。
#
# 为什么要能关：这些拦截规则都是在猜「等一下会不会好」。猜错时的表现是
# 客户端干挂着而不是收到错误 —— 而挂着比报错更难排查。留一个开关，
# 出问题当场把那一类放行，让原始报错直接暴露出来。
PASSTHROUGH = set()

TUNABLE = {
    "max_budget": (5.0, 7200.0),
    "max_attempts": (1, 5000),
    "swap_budget": (5.0, 7200.0),
    "swap_max_attempts": (1, 5000),
    "auth_budget": (5.0, 3600.0),
    "auth_max_attempts": (1, 500),
    "perm_budget": (5.0, 1800.0),
    "perm_max_attempts": (1, 200),
    "client_budget": (1.0, 600.0),
    "client_max_attempts": (1, 100),
}


def current_config():
    """当前生效值。加锁读，避免读到半改状态。"""
    with _config_lock:
        return {
            "max_budget": MAX_BUDGET,
            "max_attempts": MAX_ATTEMPTS,
            "swap_budget": SWAP_BUDGET,
            "swap_max_attempts": SWAP_MAX_ATTEMPTS,
            "auth_budget": AUTH_BUDGET,
            "auth_max_attempts": AUTH_MAX_ATTEMPTS,
            "perm_budget": PERM_BUDGET,
            "perm_max_attempts": PERM_MAX_ATTEMPTS,
            "client_budget": CLIENT_BUDGET,
            "client_max_attempts": CLIENT_MAX_ATTEMPTS,
            "passthrough": sorted(PASSTHROUGH),
        }


def apply_config(patch):
    """按 patch 更新可调项。返回 (已改字典, 错误列表)。

    只认 TUNABLE 里的键，且必须落在范围内 —— 未知键与越界值一律拒绝并回报，
    不做「静默忽略」：静默会让人以为改生效了，实际没变。
    """
    global MAX_BUDGET, MAX_ATTEMPTS, SWAP_BUDGET, SWAP_MAX_ATTEMPTS
    global AUTH_BUDGET, AUTH_MAX_ATTEMPTS, PERM_BUDGET, PERM_MAX_ATTEMPTS
    global CLIENT_BUDGET, CLIENT_MAX_ATTEMPTS

    global PASSTHROUGH

    applied, errors = {}, []

    # passthrough 单独处理：它是类别名列表，不是数值
    if "passthrough" in (patch or {}):
        raw_list = patch.get("passthrough") or []
        if not isinstance(raw_list, (list, tuple)):
            errors.append("passthrough 必须是数组")
        else:
            valid = {"retry", "cool", "swap", "auth", "perm", "client", "network"}
            bad = [v for v in raw_list if v not in valid]
            if bad:
                errors.append(f"未知类别: {', '.join(map(str, bad))}")
            keep = {v for v in raw_list if v in valid}
            with _config_lock:
                PASSTHROUGH = keep
            applied["passthrough"] = sorted(keep)
            log(f"[config] 放行类别更新为: {sorted(keep) or '（无，全部拦截）'}")

    for key, raw in (patch or {}).items():
        if key == "passthrough":
            continue
        if key not in TUNABLE:
            errors.append(f"未知配置项: {key}")
            continue
        lo, hi = TUNABLE[key]
        try:
            val = int(raw) if isinstance(lo, int) else float(raw)
        except (TypeError, ValueError):
            errors.append(f"{key}: 不是数字 ({raw!r})")
            continue
        if not (lo <= val <= hi):
            errors.append(f"{key}: {val} 超出允许范围 [{lo}, {hi}]")
            continue
        applied[key] = val

    if not applied:
        return {}, errors

    with _config_lock:
        for key, val in applied.items():
            if key == "max_budget":
                MAX_BUDGET = val
            elif key == "max_attempts":
                MAX_ATTEMPTS = val
            elif key == "swap_budget":
                SWAP_BUDGET = val
            elif key == "swap_max_attempts":
                SWAP_MAX_ATTEMPTS = val
            elif key == "auth_budget":
                AUTH_BUDGET = val
            elif key == "auth_max_attempts":
                AUTH_MAX_ATTEMPTS = val
            elif key == "perm_budget":
                PERM_BUDGET = val
            elif key == "perm_max_attempts":
                PERM_MAX_ATTEMPTS = val
            elif key == "client_budget":
                CLIENT_BUDGET = val
            elif key == "client_max_attempts":
                CLIENT_MAX_ATTEMPTS = val

    log(f"[config] 已在线更新: {applied}")
    return applied, errors

# 次数硬上限。正常退避下 900s 预算约 18 次就用完，这个上限只是
# 防御性兜底：万一退避被配成极小值，别把上游打成筛子。
SWAP_MAX_ATTEMPTS = int(os.environ.get("SWAP_MAX_ATTEMPTS", "30"))

# `perm` 节奏：确定性错误 + 面板路径专用的**短**预算。
#
# 这类错误不会因为等待而改变结果（key 填错、上下文超限、凭据类型不支持），
# 但用户要求不透传，所以仍然重试。既然重试注定无效，就别烧 900 秒 ——
# 给 45 秒 / 5 次，够覆盖「号池刚好在这几秒内补上号」的窄窗口，
# 又不至于让面板转圈到超时、让 Cursor 卡一刻钟。
# 客户端自身错误的窗口。给一次极短的重试机会（覆盖「刚好在改配置」
# 这种窄场景），然后立刻收敛 —— 号池对它无能为力，久等无意义。
CLIENT_BUDGET = float(os.environ.get("CLIENT_BUDGET_SECS", "6"))
CLIENT_MAX_ATTEMPTS = int(os.environ.get("CLIENT_MAX_ATTEMPTS", "2"))
CLIENT_DELAY = float(os.environ.get("CLIENT_DELAY_SECS", "2"))

PERM_BUDGET = float(os.environ.get("PERM_BUDGET_SECS", "45"))
PERM_MAX_ATTEMPTS = int(os.environ.get("PERM_MAX_ATTEMPTS", "5"))
PERM_DELAY = float(os.environ.get("PERM_DELAY_SECS", "8"))


def fmt_secs(s):
    """把秒数写成人话：89 -> 1 分 29 秒。"""
    s = int(round(max(0.0, s)))
    if s < 60:
        return f"{s} 秒"
    m, sec = divmod(s, 60)
    if m < 60:
        return f"{m} 分 {sec} 秒" if sec else f"{m} 分"
    h, m = divmod(m, 60)
    return f"{h} 小时 {m} 分" if m else f"{h} 小时"


# 上游错误体里可能混进的密钥形态。命中即打码，防诊断信息泄漏真实凭据。
_SECRET_PATTERNS = (
    # sk- 开头（OpenAI/DeepSeek 等）
    re.compile(r"(?i)sk-[a-z0-9][a-z0-9_-]{5,}"),
    # Authorization 头形态
    re.compile(r"(?i)bearer\s+[a-z0-9._-]{8,}"),
    # auth=/apikey=/key=/token= 参数形态
    re.compile(r"(?i)\b(?:auth|apikey|key|token)[=:]\s*[a-z0-9._-]{8,}"),
)


def _redact(text):
    """把密钥形态统一替换成 ***。"""
    for pat in _SECRET_PATTERNS:
        text = pat.sub("***", text)
    return text


def upstream_error_detail(status, payload):
    """错误诊断信息：403 时带上游 error.message 的关键部分，其余只报状态码。

    上游 403 的 body 里往往藏着真实原因（如 RegionError: 模型仅限中国区
    托管、需显式 opt-in），只有状态码时客户端会误以为是登录问题。
    兼容 {error:{message}} 与顶层 {message} 两种形态；非 JSON / 无 message /
    非 403 一律退回「上游返回 <status>」，行为与原来完全一致。
    """
    if status == 403:
        try:
            data = json.loads(payload[:MAX_PEEK_BYTES].decode("utf-8", "replace"))
        except (ValueError, TypeError):
            data = None
        msg = None
        if isinstance(data, dict):
            err = data.get("error")
            if isinstance(err, dict):
                msg = err.get("message")
            if not isinstance(msg, str):
                msg = data.get("message")
        if isinstance(msg, str) and msg.strip():
            # 先脱敏再截断：顺序不能反，否则截断可能把密钥切成半截漏出去
            detail = _redact(msg.strip())[:200]
            return f"上游返回 403：{detail}"
    return f"上游返回 {status}"


def client_message(reason, *, elapsed, attempts, detail=""):
    """给下游客户端的中文说明。

    为什么要单独做一层：盾对下游只回三种状态码（200/503/透传），
    真正的信息全在文案里。原来的文案是英文加内部术语
    （`credential swap in progress`），下游看到只知道「炸了」，
    不知道炸在哪一层、盾做过什么、自己该怎么办。

    每条都回答三件事：谁的问题、替你试了多久多少次、你该做什么。
    盾在下游眼里就是上游，所以措辞上不暴露「号池」「盾」这类内部实现，
    只说「上游」。诊断细节（凭据轮换中之类）放 detail，能说的才说。

    文案里不用 markdown 标记 —— 终端客户端会把 ** 原样显示出来。
    """
    tried = f"已替你重试 {attempts} 次、等了 {fmt_secs(elapsed)}"
    base = {
        # 网络层根本没连上：DNS、连接被拒、TLS 失败。
        "network": (
            f"连不上上游服务。{tried}，仍然没连上。"
            "这通常是上游临时抽风或网络波动，一般几分钟内自愈 —— "
            "直接重发这条请求即可，不用改任何配置。"
        ),
        # 4xx：请求本身或凭据有问题，重试无意义。
        "client": (
            f"上游拒绝了这个请求，判定是请求本身或凭据的问题（不是容量问题）。"
            f"{tried}，结果一样，所以不再等了。"
            "请检查：请求体格式、模型名是否写对、API key 是否有效或过期。"
            "这类问题重发通常没用，需要先改对再发。"
        ),
        # 确定性 5xx：上游明确报错，短窗内没恢复。
        "perm": (
            f"上游持续返回错误。{tried}，短窗内没等到恢复，先把结果交回给你，"
            "避免你这边一直挂着。上游侧的问题，你的请求和配置没错 —— "
            "过一会儿重发即可。"
        ),
        # 凭据轮换 / 池冷却：最常见的一类，盾的主战场。
        "swap": (
            f"上游正在轮换凭据或处于限流冷却，暂时接不了新请求。"
            f"{tried}，还没轮到可用额度。这是容量问题，不是你的请求出错 —— "
            "稍等片刻重发就好，通常一两分钟内恢复。"
        ),
        # 总预算耗尽：所有类型都没收敛。
        "budget": (
            f"上游一直繁忙。{tried}，已用尽重试预算，"
            "只能把结果交回给你（再等下去你的客户端可能自己超时）。"
            "上游负载问题，稍后重发即可。"
        ),
    }[reason]
    if detail:
        base += f"（诊断信息：{detail}）"
    return base


def swap_delay(attempt):
    """换号期退避：20s 起，1.4 倍增长，上限 60s。"""
    return min(SWAP_DELAY_FIRST * (1.4 ** max(0, attempt - 1)), SWAP_DELAY_MAX)


def cool_delay(attempt, retry_after):
    """号池冷却退避：**以网关给的 `Retry-After` 为基准**，只在反复不恢复时才升档。

    与 `swap_delay` 的根本差别：这里有权威真值可用 —— `Retry-After` 是
    KiroStudio 的 cooldown.rs 算出来的剩余秒数，比任何本地阶梯都准。
    首轮就按它睡（典型 10s），恢复即走，不再白等 20~60 秒。

    仍保留升档：池子**真空**（0/0，没有任何凭据）时网关每次都回同一个 10s，
    照 10s 死等会在预算内空转几十次。故第 2 轮起 1.6 倍递增、上限沿用
    `SWAP_DELAY_MAX`，既尊重真值又能在长时间无号时收敛。
    """
    base = MIN_DELAY
    if retry_after is not None:
        try:
            base = max(MIN_DELAY, min(float(retry_after), SWAP_DELAY_MAX))
        except (TypeError, ValueError):
            base = COOL_DELAY_FALLBACK
    else:
        base = COOL_DELAY_FALLBACK
    return min(base * (1.6 ** max(0, attempt - 1)), SWAP_DELAY_MAX)


def classify(status, peek, path=""):
    """决定这次响应要不要重试，以及按哪种节奏重试。

    返回 "retry" / "cool" / "swap" / "auth" / "pass"。判定顺序很重要：
    先看永久标记（请求非法，等也没用），
    再看**冷却**标记（秒级恢复，听 Retry-After）——必须在 swap 之前，
    否则 "All credentials are temporarily cooling down" 会被 swap 抢走判成封号；
    再看换号标记（分钟级，长退避），再看瞬态标记，最后落兜底。

    兜底是**拦**而不是放：只有 PERMANENT_BODY_MARKERS 命中才回 "pass"。
    "auth" 是 4xx 的兜底节奏，与 cool 共用「听 Retry-After + 升档」。
    """
    # 3xx（重定向）直接透传：重试只会无限循环 —— 网关管理面登录成功返回
    # 302 → /__admin（带 Set-Cookie），重试 POST 同一个 login 还是 302。
    # 实测：面板登录被重试循环吞掉后客户端拿到 200 登录页 =「无法登录」。
    if 300 <= status < 400:
        return "pass"
    text = peek.decode("utf-8", "replace") if peek else ""
    if text:
        # 先分流「号池救不了」的：客户端自己的错，等待纯属空转。
        # 仍然不透传原文（用户要求），但用最短窗口，别让客户端白卡。
        #
        # 为什么放在最前面：`authentication_error` 这类措辞只可能来自网关
        # 自己的鉴权门，不会与上游凭据错误的措辞共存。放前面可以保证
        # 「客户端 key 填错」永远不会被后面的 swap 长窗误捕 —— 那会让一个
        # 拼写错误卡 900 秒。
        #
        # 限定 4xx 是必要的：5xx 即使 body 里偶然出现这些词也该按服务端
        # 故障重试，不能当成客户端的错草率收敛。
        if 400 <= status < 500:
            for marker in CLIENT_FAULT_BODY_MARKERS:
                if marker in text:
                    return "client"
        # PERMANENT_BODY_MARKERS 不再触发 pass。
        #
        # 2026-08-07 用户决策：任何错误都不返回给客户端，号池会自然恢复。
        # 这些标记改为走 `perm` 节奏 —— 仍然重试（不透传），但用最短预算
        # 快速收敛：它们确定性地不会因为等待而改变结果，长窗只是白等。
        # 保留这张表的意义从「放走」变成了「别浪费 900 秒」。
        for marker in PERMANENT_BODY_MARKERS:
            if marker in text:
                return "perm"
        for marker in COOLING_MARKERS:
            if marker in text:
                return "cool"
        # DWGX：fuckopencode 的 key 池整池被禁 —— 归 `cool` 而不是 `retry`。
        #
        # 理由和 KiroStudio 全池冷却同构：冷却时长由 fuckopencode 的
        # KEY_COOLDOWN_MS（线上 300s）与失败类型决定，是**分钟级**的。
        # 用 retry 的 1 秒退避去猛打一个已知在冷却的池子，只是空转烧预算；
        # cool 节奏会升档（10→16→25→41→60s），既能及时发现恢复又不浪费。
        # 注意 fuckopencode 不发 Retry-After，所以这里靠升档而非真值。
        if "all upstream keys are disabled" in text:
            return "cool"
        for marker in SWAP_WINDOW_MARKERS:
            if marker in text:
                return "swap"
        # 上游凭据失效但措辞不在上面那张表里 —— 仍归 swap，
        # 让它享受「等换号」的长窗，因为这类**确实**能被换号救活。
        for marker in UPSTREAM_CRED_MARKERS:
            if marker in text:
                return "swap"
        # DWGX：fuckopencode 的其余瞬态文案（上游连不上 / 坏 body / 脏流中止）。
        # 这些是秒级抖动，用 retry 的短退避即可。
        for marker in FUCKOPENCODE_TRANSIENT_MARKERS:
            if marker in text:
                return "retry"
        for marker in TRANSIENT_BODY_MARKERS:
            if marker in text:
                return "retry"
    # 兜底：**默认拦，不默认放**。
    #
    # 原先这里是 `retry if status in RETRYABLE else pass`，即没匹配到任何标记
    # 的 4xx 一律透传给客户端。实测这条兜底放走了整批 403：
    # KiroStudio 把 region 错配包装成 `403 permission_error` 后，响应体的
    # 措辞与 SWAP/COOLING/TRANSIENT 的标记都对不上，于是落进兜底 → pass →
    # 客户端当场看到 403 断会话。
    #
    # 反转之后，判定不再依赖"标记表是否穷举完整"这个不可能保证的前提：
    # 只有 PERMANENT_BODY_MARKERS 里那三个（请求体非法、模型 ID 错、
    # 上下文超限）会透传 —— 它们必须透传，因为重试 60 次也是同一个错，
    # 只会让客户端白等十分钟。其余一切非 2xx 都进重试。
    #
    # 4xx 用 auth 节奏而非 retry 节奏：403/401 多是凭据/风控问题，
    # 拿 1 秒退避猛打只会加重上游风控；auth 节奏听 Retry-After 并升档。
    # 非推理路径（面板/管理 API / /__admin/* / /healthz）：**直接透传不重试**。
    # 这些是网关自己的管理面（有独立鉴权），盾不该拦截 —— 实测 502（如
    # console 通道无 cookie）被重试拖到 cloudflared 100s 超时（524），
    # 面板用户等的是「失败原因」而不是「转圈 2 分钟」。
    if path and not is_inference_path(path):
        return "pass"
    if status in RETRYABLE:
        return "retry"
    if status in CLIENT_FAULT_STATUSES:
        # 401/404/405 这类确定性错误现在也拦（用户要求，号池自然恢复）。
        # 走 `perm` 短预算：等待不会让 key 变正确，但至少不把 900 秒烧掉。
        return "perm"
    if 400 <= status < 500:
        return "auth"
    return "retry"


def network_delay(attempt):
    """网络层失败（连不上上游）专用退避：5s 起、1.5 倍、上限 30s。

    曾用 backoff_delay（1s 起 12s 上限）：网关 OOM 崩溃/重启窗口内，盾 2s 间隔
    重试 42 次，新进程一启动就被重试请求淹没 → 更快 OOM（死亡螺旋，实测 119 次
    循环崩溃）。网关重启要几秒到几十秒，退避必须比启动时间长才有意义。
    """
    return max(5.0, min(5.0 * (1.5 ** max(0, attempt - 1)), 30.0))


def backoff_delay(attempt, retry_after):
    """重试等待时长。优先用上游给的 Retry-After，否则指数退避。"""
    if retry_after is not None:
        try:
            v = float(retry_after)
            # 上游有时给很大的值，截断以免超预算
            return max(MIN_DELAY, min(v, 15.0))
        except (TypeError, ValueError):
            pass
    return max(MIN_DELAY, min(1.0 * (1.7 ** (attempt - 1)), 12.0))


from shield.ui import UI_HTML


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "kiro-shield/1.0"

    def setup(self):
        http.server.BaseHTTPRequestHandler.setup(self)
        # 是否已经发出保活响应头。一旦为真，状态码就锁定成 200 了。
        self._ka_open = False
        # 不跟随 3xx 重定向的 opener（见 _attempt 注释：跟随会吞掉登录 302）。
        self._opener = urllib.request.build_opener(_NoRedirectHandler())

    def log_message(self, fmt, *args):
        pass  # 用自己的 log()

    def _collect_request(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {
            k: v for k, v in self.headers.items()
            if k.lower() not in HOP_BY_HOP
        }
        return headers, body

    def _wants_stream(self, body):
        """这个请求是不是 SSE 流式？

        判据两条，任一命中即算：Accept 头声明 event-stream，或请求体里
        "stream":true。后者是 Cursor / Claude Code 的实际形态。
        """
        accept = (self.headers.get("Accept") or "").lower()
        if "text/event-stream" in accept:
            return True
        if not body:
            return False
        try:
            head = body[:2048].decode("utf-8", "replace")
        except Exception:
            return False
        return '"stream":true' in head.replace(" ", "")

    def _open_keepalive(self):
        """发出 SSE 响应头，之后可以持续写心跳保持连接活跃。

        一旦调用就锁定了 200 状态码，所以只在**确定要重试**之后才调。
        """
        if self._ka_open:
            return True
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Kiro-Shield", "waiting-for-upstream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self._ka_open = True
            return True
        except (BrokenPipeError, ConnectionResetError, OSError):
            return False

    def _keepalive_ping(self):
        """写一个 SSE 注释行。客户端按协议忽略它，但连接不会被判超时。"""
        if not self._ka_open:
            return True
        try:
            chunk = b": kiro-shield waiting\n\n"
            self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, OSError):
            return False

    def _sleep_with_keepalive(self, delay, streaming):
        """等待 delay 秒。流式请求期间每隔几秒发一次心跳。

        返回 False 表示客户端已经断开，调用方应当放弃。
        """
        if not streaming:
            time.sleep(delay)
            return True
        if not self._open_keepalive():
            return False
        end = time.monotonic() + delay
        while True:
            remaining = end - time.monotonic()
            if remaining <= 0:
                return True
            time.sleep(min(KEEPALIVE_INTERVAL, remaining))
            if not self._keepalive_ping():
                return False

    def _attempt(self, headers, body):
        """打一次上游。返回 (status, resp_headers, reader) 或抛异常。

        必须禁用重定向跟随：urllib 默认会跟随 3xx（POST→GET、丢 Set-Cookie）。
        网关管理面登录成功返回 302 → /__admin + Set-Cookie，被跟随后客户端
        拿到的是页面而不是重定向 —— 「无法登录」的根源（2026-08-11 实测）。
        不跟随时 3xx 会以 HTTPError 形式抛回，e.code 即状态码，照常分类透传。
        """
        req = urllib.request.Request(
            UPSTREAM + self.path, data=body, headers=headers, method=self.command
        )
        try:
            resp = self._opener.open(req, timeout=600)
            return resp.status, resp.headers, resp
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e

    def _reject_busy(self):
        """并发满：立刻回 503，不排队、不占上游、不耗重试预算。

        回 503 而非 429 的原因与预算耗尽相同：Cursor 对 503 会重试、
        对 429 会停会话。文案沿用「盾在下游眼里就是上游」的口径，
        不暴露并发/盾这类内部实现。

        先 `_collect_request()` 把请求体读掉再回 —— 这是关键：如果在客户端
        还没写完请求体时就发响应+关连接，内核看到 socket 里还有没读的数据
        会发 RST，客户端在自己的 sendall 上撞 BrokenPipe，拿不到这个 503。
        """
        self._collect_request()
        with _stats_lock:
            STATS["rejected"] += 1
        log(f"503 busy: concurrency cap {MAX_CONCURRENCY} reached {self.path}")
        self._fail(503, "上游瞬时负载过高，暂时无法接受更多请求，请稍后重发。")

    def _proxy(self):
        with _stats_lock:
            STATS["requests"] += 1

        headers, body = self._collect_request()
        streaming = self._wants_stream(body)
        deadline = time.monotonic() + MAX_BUDGET
        attempt = 0
        last_status = None
        retried = False
        # 换号期用独立的计数与预算：它的等待很长，不该和限速重试
        # 抢同一个 MAX_ATTEMPTS 配额。
        swap_attempt = 0
        swap_deadline = None
        # 事件记录用：进入时刻与累计等待，用于算「客户端被拖了多久」。
        t_start = time.monotonic()
        waited_total = 0.0
        # 最后一次**错误**的完整快照 (status, verdict, payload)。
        # 必须是元组而非三个变量，否则跨轮次会串（见下方 classify 调用处注释）。
        last_err = None
        # perm（确定性错误 / 面板路径）用独立的短预算，不与长窗共享配额。
        perm_attempt = 0
        perm_deadline = None
        client_attempt = 0
        client_deadline = None

        while attempt < MAX_ATTEMPTS:
            attempt += 1
            try:
                status, resp_headers, reader = self._attempt(headers, body)
            except Exception as e:
                # 网络层失败，当瞬态处理，重试
                last_status = 502
                last_err = (502, "network", b"")
                if time.monotonic() >= deadline:
                    record_event(502, "network", self.path, b"", attempt,
                                 time.monotonic() - t_start, "gave_up",
                                 note=f"upstream unreachable: {e}")
                    self._fail(503, client_message(
                        "network", elapsed=time.monotonic() - t_start,
                        attempts=attempt, detail=str(e)[:120]))
                    return
                if not self._sleep_with_keepalive(
                        network_delay(attempt), streaming):
                    log(f"client gone during backoff {self.path}")
                    return
                retried = True
                continue

            last_status = status

            # 2xx 直接流式转发：绝不预读，否则会破坏 SSE 的实时性。
            if 200 <= status < 300:
                if retried:
                    with _stats_lock:
                        STATS["absorbed"] += 1
                    log(f"resolved {status} after {attempt} attempts {self.path}")
                    # 记成 absorbed：这条错误客户端**没看到**，是护盾吃掉的。
                    # 记的是**被吸收掉的那个错误**，不是当前这个 200 ——
                    # 事件表要回答的是「刚才挡住了什么」。
                    e_status, e_verdict, e_payload = last_err or (0, "retry", b"")
                    record_event(e_status, e_verdict, self.path,
                                 e_payload, attempt,
                                 time.monotonic() - t_start, "absorbed",
                                 note=f"重试 {attempt} 次后成功，客户端未感知")
                if self._ka_open:
                    # 头已经发过了（保活期间），只能续着写 body。
                    self._relay_after_keepalive(reader)
                else:
                    self._relay(status, resp_headers, reader)
                return

            # 非 2xx：错误体都很小，读一小段用于判定。读完就得整体
            # 转发这段内容，不能再交给 _relay 重读（流已被消费）。
            # 上限 4KB：错误体远小于此，防畸形上游给超大 body 拖内存；
            # 判定与事件记录只用前 4KB，超限部分直接丢弃。
            payload = b""
            try:
                payload = reader.read(MAX_PEEK_BYTES)
            except Exception:
                pass
            try:
                reader.close()
            except Exception:
                pass

            verdict = classify(status, payload[:MAX_PEEK_BYTES], self.path)
            # 三者必须**同时**更新：曾经它们是独立变量，跨轮次各自为政，
            # 于是出现「状态码取自本轮 200、verdict 取自上上轮 network、
            # payload 取自上轮」这种自相矛盾的事件记录。
            last_err = (status, verdict, payload)

            # 面板上把这一类的开关关掉 → 不拦，原样把上游响应交给客户端。
            # 放在所有分支之前：一旦放行就不该再做任何等待或改写。
            # 注意 keepalive 已发出的情况：状态码锁死在 200 了，只能靠
            # _relay_body 走 SSE 收尾，做不到真正的原样透传（这是流式的固有限制）。
            if verdict in PASSTHROUGH:
                log(f"[passthrough] {verdict} 已被放行，原样返回 {status} {self.path}")
                record_event(status, verdict, self.path, payload, attempt,
                             time.monotonic() - t_start, "passthrough",
                             note="该类别开关已关闭，未拦截")
                self._relay_body(status, resp_headers, payload)
                return

            if verdict == "client":
                # 客户端自己的错：号池救不了，给极短窗口后收敛。
                client_attempt += 1
                if client_deadline is None:
                    client_deadline = time.monotonic() + CLIENT_BUDGET
                    log(f"client-fault ({status}) intercepted, tiny window "
                        f"{CLIENT_BUDGET:.0f}s {self.path}")
                c_remaining = client_deadline - time.monotonic()
                if (client_attempt > CLIENT_MAX_ATTEMPTS
                        or c_remaining < CLIENT_DELAY):
                    with _stats_lock:
                        STATS["gave_up"] += 1
                        STATS["client_gave_up"] += 1
                    record_event(status, verdict, self.path, payload,
                                 client_attempt, time.monotonic() - t_start,
                                 "gave_up",
                                 note="客户端自身错误（号池无法处理），"
                                      f"{CLIENT_BUDGET:.0f}s 后返回 503；"
                                      "原始错误未透传，详情见本条响应原文")
                    self._fail(503, client_message(
                        "client", elapsed=time.monotonic() - t_start,
                        attempts=client_attempt,
                        detail=upstream_error_detail(status, payload)))
                    return
                with _stats_lock:
                    STATS["retries"] += 1
                    STATS["client_waits"] += 1
                    k = str(status)
                    STATS["by_status"][k] = STATS["by_status"].get(k, 0) + 1
                retried = True
                log(f"{status} client-wait {CLIENT_DELAY:.0f}s, "
                    f"try {client_attempt}/{CLIENT_MAX_ATTEMPTS} {self.path}")
                if not self._sleep_with_keepalive(CLIENT_DELAY, streaming):
                    record_event(status, verdict, self.path, payload,
                                 client_attempt, time.monotonic() - t_start,
                                 "client_gone", note="等待期间客户端主动断开")
                    return
                continue

            if verdict == "perm":
                # 确定性错误 / 面板路径：拦住不透传，但用短预算快速收敛。
                perm_attempt += 1
                if perm_deadline is None:
                    perm_deadline = time.monotonic() + PERM_BUDGET
                    log(f"deterministic error ({status}) intercepted, short window "
                        f"{PERM_BUDGET:.0f}s {self.path}")
                perm_remaining = perm_deadline - time.monotonic()
                if (perm_attempt > PERM_MAX_ATTEMPTS
                        or perm_remaining < PERM_DELAY):
                    with _stats_lock:
                        STATS["gave_up"] += 1
                        STATS["perm_gave_up"] += 1
                    record_event(status, verdict, self.path, payload,
                                 perm_attempt, time.monotonic() - t_start,
                                 "gave_up",
                                 retry_after=resp_headers.get("Retry-After"),
                                 note=f"确定性错误，{PERM_BUDGET:.0f}s 短窗内未恢复，"
                                      "返回 503（未透传原始错误）")
                    self._fail(503, client_message(
                        "perm", elapsed=time.monotonic() - t_start,
                        attempts=perm_attempt,
                        detail=upstream_error_detail(status, payload)))
                    return
                with _stats_lock:
                    STATS["retries"] += 1
                    STATS["perm_waits"] += 1
                    k = str(status)
                    STATS["by_status"][k] = STATS["by_status"].get(k, 0) + 1
                retried = True
                log(f"{status} perm-wait {PERM_DELAY:.0f}s, try {perm_attempt}"
                    f"/{PERM_MAX_ATTEMPTS} {self.path}")
                if not self._sleep_with_keepalive(PERM_DELAY, streaming):
                    log(f"client gone during perm wait {self.path}")
                    record_event(status, verdict, self.path, payload,
                                 perm_attempt, time.monotonic() - t_start,
                                 "client_gone", note="等待期间客户端主动断开")
                    return
                continue

            if verdict == "pass":
                if retried:
                    log(f"giving up on {status} (permanent) after {attempt} "
                        f"attempts {self.path}")
                if status >= 400:
                    record_event(status, "pass", self.path, payload, attempt,
                                 time.monotonic() - t_start, "passed",
                                 retry_after=resp_headers.get("Retry-After"),
                                 note="客户端会看到这个错误")
                self._relay_body(status, resp_headers, payload)
                return

            if verdict in ("swap", "cool", "auth"):
                # 换号 / 冷却：长退避、独立预算。不消耗 attempt 配额，
                # 否则 60 次限速重试的额度会被 10 分钟的等待挤光。
                attempt -= 1
                swap_attempt += 1
                # auth 用独立的短预算：这类 4xx 等待救不回来（见 AUTH_BUDGET 注释）
                _budget = AUTH_BUDGET if verdict == "auth" else SWAP_BUDGET
                _max_attempts = (AUTH_MAX_ATTEMPTS if verdict == "auth"
                                 else SWAP_MAX_ATTEMPTS)
                if swap_deadline is None:
                    swap_deadline = time.monotonic() + _budget
                    _label = {"cool": "cooling", "auth": "auth/risk",
                              "swap": "credential swap"}[verdict]
                    log(f"{_label} window detected ({status}), waiting up to "
                        f"{_budget:.0f}s {self.path}")
                remaining = swap_deadline - time.monotonic()
                # 冷却听网关的 Retry-After（权威真值）；换号无真值可用，走本地阶梯。
                if verdict in ("cool", "auth"):
                    delay = cool_delay(swap_attempt, resp_headers.get("Retry-After"))
                else:
                    delay = swap_delay(swap_attempt)
                if remaining < delay or swap_attempt > _max_attempts:
                    with _stats_lock:
                        STATS["gave_up"] += 1
                        STATS["swap_gave_up"] += 1
                    log(f"{verdict} window did not recover in {_budget:.0f}s "
                        f"(last={status}) {self.path}")
                    record_event(status, verdict, self.path, payload,
                                 swap_attempt, time.monotonic() - t_start,
                                 "gave_up",
                                 retry_after=resp_headers.get("Retry-After"),
                                 note=f"{_budget:.0f}s 内未恢复，返回 503")
                    # cool/auth 是上游明确给了冷却信号，swap 是凭据轮换 —— 都归到
                    # 「容量问题」这类文案，但把判定写进诊断信息便于对账。
                    _why = {"swap": "凭据轮换中", "cool": "上游要求冷却",
                            "auth": "凭据需要刷新"}[verdict]
                    self._fail(503, client_message(
                        "swap", elapsed=time.monotonic() - t_start,
                        attempts=swap_attempt,
                        detail=f"{_why}，{upstream_error_detail(status, payload)}"))
                    return
                with _stats_lock:
                    STATS["retries"] += 1
                    STATS["swap_waits"] += 1
                    # 冷却与封号分开计数：两者恢复时间差一个数量级，混在一个
                    # 计数器里就看不出「等久了是因为池子空还是因为号被封」。
                    if verdict == "cool":
                        STATS["cool_waits"] += 1
                    elif verdict == "auth":
                        STATS["auth_waits"] += 1
                    k = str(status)
                    STATS["by_status"][k] = STATS["by_status"].get(k, 0) + 1
                retried = True
                log(f"{status} {verdict}-wait {delay:.1f}s, "
                    f"try {swap_attempt} ({remaining:.0f}s of swap budget left)")
                waited_total += delay
                if not self._sleep_with_keepalive(delay, streaming):
                    log(f"client gone during swap wait {self.path}")
                    record_event(status, verdict, self.path, payload,
                                 swap_attempt, time.monotonic() - t_start,
                                 "client_gone", note="等待期间客户端主动断开")
                    return
                continue

            remaining = deadline - time.monotonic()
            delay = backoff_delay(attempt, resp_headers.get("Retry-After"))

            # 预算不足以完成一次有意义的等待就别硬撑，避免 0.x 秒空转
            if attempt >= MAX_ATTEMPTS or remaining < delay:
                break

            with _stats_lock:
                STATS["retries"] += 1
                k = str(status)
                STATS["by_status"][k] = STATS["by_status"].get(k, 0) + 1
            retried = True
            log(f"{status} -> wait {delay:.1f}s, attempt {attempt}/{MAX_ATTEMPTS}"
                f" (budget {remaining:.0f}s left)")
            waited_total += delay
            if not self._sleep_with_keepalive(delay, streaming):
                log(f"client gone during backoff {self.path}")
                record_event(status, verdict, self.path, payload, attempt,
                             time.monotonic() - t_start, "client_gone",
                             note="等待期间客户端主动断开")
                return

        # 预算耗尽。关键：返回 503 而不是 429，Cursor 不会因此停会话
        with _stats_lock:
            STATS["gave_up"] += 1
        log(f"gave up after {attempt} attempts (last={last_status}) {self.path}")
        e_status, e_verdict, e_payload = last_err or (last_status or 0, "retry", b"")
        record_event(e_status, e_verdict, self.path,
                     e_payload, attempt, time.monotonic() - t_start,
                     "gave_up",
                     note=f"{MAX_ATTEMPTS} 次 / {MAX_BUDGET:.0f}s 预算用尽，返回 503")
        self._fail(503, client_message(
            "budget", elapsed=time.monotonic() - t_start, attempts=attempt,
            detail=f"上游最后返回 {last_status}" if last_status else ""))

    def _relay_body(self, status, resp_headers, payload):
        """转发一个已经完整读入内存的响应体（错误响应走这条）。"""
        try:
            self.send_response(status)
            for k, v in resp_headers.items():
                if k.lower() not in HOP_BY_HOP:
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            if payload:
                self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _relay_after_keepalive(self, reader):
        """保活头已发出的情况下，把上游 body 接着写进同一个 chunked 流。

        状态码和头都已经锁定在 200/event-stream 了，所以这里只搬 body。
        对 SSE 来说这是无损的：客户端把之前的心跳注释行丢掉，从这里开始
        读到真正的 data: 事件。
        """
        # read1 而非 read：理由与 `_relay` 里那段注释相同（read(n) 会阻塞到攒满 n
        # 字节，把小帧长间隔的 SSE 卡成分钟级延迟）。两处都得改，否则走过保活的
        # 请求照样卡。
        reader_read = getattr(reader, "read1", None) or reader.read
        try:
            while True:
                chunk = reader_read(8192)
                if not chunk:
                    break
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            try:
                reader.close()
            except Exception:
                pass

    def _relay(self, status, resp_headers, reader):
        """把上游响应流式转给客户端。"""
        self.send_response(status)
        for k, v in resp_headers.items():
            if k.lower() not in HOP_BY_HOP:
                self.send_header(k, v)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        # ⚠️ 必须 read1 而不是 read：`read(n)` 在缓冲流上会**阻塞到攒满 n 字节或 EOF**，
        # 而 SSE 是"小帧 + 长间隔"。实测面板 /api/admin/stream/live 每帧约 200 字节、
        # 每 1.5s 一帧 → read(8192) 要攒够约 40 帧 ≈ 60s 才吐出第一块，浏览器在此之前
        # 一帧都收不到 → 运维页「全局 RPM / 在途 / 当前 RPS / TOKENS/S」四个卡片恒为 0
        # （前端是 `frame?.globalRpm ?? 0`，frame 一直是 null）。
        #
        # 为什么一直没被发现：/v1/messages 的 token 流密度高，8KB 很快填满，看起来就是
        # 实时的。只有低码率 SSE（面板监控流）才暴露它。
        #
        # read1 语义：底层缓冲有多少就返回多少，绝不等攒满 —— 这才是流式代理该有的行为。
        reader_read = getattr(reader, "read1", None) or reader.read
        try:
            while True:
                chunk = reader_read(8192)
                if not chunk:
                    break
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # 客户端断了
        finally:
            try:
                reader.close()
            except Exception:
                pass

    def _fail(self, status, msg):
        body = {"error": {"type": "api_error", "message": msg}}
        # 保活头已经发出去了 -> 状态码锁死在 200，只能用 SSE error 事件收尾。
        if self._ka_open:
            try:
                evt = ("event: error\ndata: %s\n\n"
                       % json.dumps(body)).encode("utf-8")
                self.wfile.write(b"%x\r\n%s\r\n" % (len(evt), evt))
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return
        payload = json.dumps(body).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _is_loopback(self):
        """回环客户端判定：本机（cloudflared/隧道）或 ::1。FurCDN 公网回源是外网 IP，返回 False。"""
        ip = getattr(self, "client_address", (None, None))[0]
        return ip in ("127.0.0.1", "::1", "localhost")

    # 观测端点走前缀匹配：/_shield/events 可以带 ?verdict=&outcome=&limit=
    def _shield_route(self):
        """命中观测端点则处理并返回 True，否则 False（继续代理）。

        安全：观测端点只对回环客户端开放（本机 ssh 隧道 / cloudflared 同机）。
        FurCDN 公网回源打 /_shield/* 一律 404，不泄露面板也不占线程。
        """
        if not self._is_loopback():
            if self.path.startswith("/_shield/"):
                self._send_json({"error": "not found"}, 404)
                return True
            return False
        base = self.path.split("?", 1)[0]
        if base == "/_shield/stats":
            self._stats()
            return True
        if base == "/_shield/events":
            self._events()
            return True
        if base in ("/_shield/ui", "/_shield/ui/"):
            self._ui()
            return True
        if base == "/_shield/config":
            # GET 读当前值，POST/PUT 在线改。放在代理之前拦掉，
            # 否则会被当成推理请求转给上游。
            if self.command in ("POST", "PUT"):
                self._set_config()
            else:
                self._send_json({"config": current_config(),
                                 "tunable": {k: list(v) for k, v in TUNABLE.items()}})
            return True
        return False

    def _set_config(self):
        """在线更新可调预算。请求体是 {"auth_budget": 90, ...} 这样的 JSON。"""
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            patch = json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, TypeError) as exc:
            self._send_json({"ok": False, "errors": [f"请求体不是合法 JSON: {exc}"]}, 400)
            return
        if not isinstance(patch, dict):
            self._send_json({"ok": False, "errors": ["请求体必须是 JSON 对象"]}, 400)
            return

        applied, errors = apply_config(patch)
        # 部分成功也返回 200 并列出错误项：调用方需要知道「哪几项没生效」，
        # 整体报错会让人误以为一项都没改。
        self._send_json({
            "ok": not errors,
            "applied": applied,
            "errors": errors,
            "config": current_config(),
            # 必须带上 tunable：前端保存后会用它重绘控件，缺了会让输入框消失
            "tunable": {k: list(v) for k, v in TUNABLE.items()},
        }, 200 if applied or not errors else 400)

    def do_POST(self):
        if self._shield_route():
            return
        if not Server._concurrency.acquire(blocking=False):
            self._reject_busy()
            return
        try:
            self._proxy()
        finally:
            Server._concurrency.release()

    def do_GET(self):
        if self._shield_route():
            return
        if not Server._concurrency.acquire(blocking=False):
            self._reject_busy()
            return
        try:
            self._proxy()
        finally:
            Server._concurrency.release()

    do_PUT = do_POST
    do_DELETE = do_POST
    do_PATCH = do_POST

    def _send_json(self, obj, status=200):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _stats(self):
        with _stats_lock:
            d = dict(STATS)
        # 并发上限的观测：当前活跃线程数（含主线程）。压测/排查风暴时看它
        # 是否被 MAX_CONCURRENCY 卡住 —— 线程数有上限是盾不再被打死的证据。
        d["threads"] = threading.active_count()
        self._send_json(d)

    def _events(self):
        """异常事件列表。支持 ?verdict= &outcome= &limit= 过滤。"""
        q = {}
        if "?" in self.path:
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1])

        def one(key):
            v = q.get(key, [""])[0].strip()
            return v or None

        f_verdict, f_outcome = one("verdict"), one("outcome")
        try:
            limit = max(1, min(int(one("limit") or 300), EVENTS_MAX))
        except ValueError:
            limit = 300

        with _events_lock:
            items = list(EVENTS)
        if f_verdict:
            items = [e for e in items if e["verdict"] == f_verdict]
        if f_outcome:
            items = [e for e in items if e["outcome"] == f_outcome]
        items = items[-limit:]
        items.reverse()  # 新的在前

        # 按分类聚合，界面顶部的分组卡片用这份
        groups = {}
        with _events_lock:
            allitems = list(EVENTS)
        for e in allitems:
            g = groups.setdefault(e["verdict"], {
                "verdict": e["verdict"],
                "count": 0, "outcomes": {}, "statuses": {},
                "last_ts": 0, "max_waited": 0,
            })
            g["count"] += 1
            g["outcomes"][e["outcome"]] = g["outcomes"].get(e["outcome"], 0) + 1
            k = str(e["status"])
            g["statuses"][k] = g["statuses"].get(k, 0) + 1
            g["last_ts"] = max(g["last_ts"], e["ts"])
            g["max_waited"] = max(g["max_waited"], e["waited"])

        with _stats_lock:
            stats = dict(STATS)

        self._send_json({
            "now": time.time(),
            "stats": stats,
            "meta": VERDICT_META,
            "groups": sorted(groups.values(), key=lambda g: -g["count"]),
            "events": items,
            "total_buffered": len(allitems),
            "buffer_max": EVENTS_MAX,
            "config": {
                "upstream": UPSTREAM,
                "permanent_markers": list(PERMANENT_BODY_MARKERS),
                # DWGX 移植补充：fuckopencode 专用瞬态标记，面板里可见，
                # 方便排查「这次波动是 key 池空还是上游连不上」。
                "fuckopencode_markers": list(FUCKOPENCODE_TRANSIENT_MARKERS),
                "client_fault_statuses": sorted(CLIENT_FAULT_STATUSES),
                "perm_delay": PERM_DELAY,
                "inference_hints": list(INFERENCE_PATH_HINTS),
                # 可在线调整的项统一走 current_config()，避免这里读到
                # 模块级旧值（热改后两处不一致会让面板显示错的数字）
                **current_config(),
            },
            "tunable": {k: list(v) for k, v in TUNABLE.items()},
        })

    def _ui(self):
        page = UI_HTML.encode("utf-8")
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(page)
        except (BrokenPipeError, ConnectionResetError):
            pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    # accept 队列长度。**必须显式设置** —— Python socketserver 的默认值是 5，
    # 而本进程挂在 Caddy 的 4 条 API 路由后面承载全部并发。
    #
    # 300 并发实测（修前 / 修后）：成功率 61.3% → 100.0%，连接被 RST 116 → 0。
    # 队列满时内核直接 RST，客户端看到的是连接被拒而不是排队，重试逻辑救不回来。
    #
    # 1024 远低于 somaxconn(32768)，不会被内核截断。
    # ⚠️ 这个值已经丢过两次（本文件被整体重写时带走）——所以本文件现已纳入
    # ws-vps 仓库管理，改完务必 commit，不要只改服务器上的副本。
    request_queue_size = 1024

    # 并发闸门：ThreadingMixIn 每请求一线程，并发数 = 线程数。风暴期不给上限
    # 的话线程会一路涨到把 128M 进程打死（实测挂过、靠重启恢复）。信号量卡住
    # 同时进行的代理请求数，满了立刻回 503（见 Handler._reject_busy）——
    # 超出的请求不排队、不占上游，线程自然也就不会累积。
    _concurrency = threading.BoundedSemaphore(MAX_CONCURRENCY)


if __name__ == "__main__":
    log(f"kiro_shield on {HOST}:{PORT} -> {UPSTREAM}")
    log(f"budget={MAX_BUDGET}s max_attempts={MAX_ATTEMPTS}")
    Server((HOST, PORT), Handler).serve_forever()
