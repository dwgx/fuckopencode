#!/usr/bin/env python3
"""
盾的行为验证（DWGX）—— 不依赖线上，纯本地跑。

起一个假 fuckopencode 上游，按脚本编排的状态码序列作答，然后确认：
   1. 整池被禁的 503（`all upstream keys are disabled`）被盾吸收，
      客户端最终拿到 200 而不是 503。
   2. 502 `upstream unavailable` 同样被吸收。
   3. 客户端自己的错（401 unauthorized）**不**被长窗拖住，快速收敛。
   4. 2xx 直接透传，不预读（SSE 实时性不受影响）。
   5. 403 的**真实原因**（错误体 error.message，如 RegionError）透传到
      诊断信息里，且密钥形态被脱敏；403 无 body 时退回「上游返回 403」。

用法：
  python3 scripts/dwgx/test-shield.py
零第三方依赖，与盾本体一致。
"""

import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeUpstream(BaseHTTPRequestHandler):
    """按 self.server.script 编排作答；耗尽后一律 200。"""

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        if length:
            self.rfile.read(length)
        script = self.server.script
        if script:
            status, body = script.pop(0)
        else:
            status, body = 200, json.dumps({"ok": True, "content": "hi"})
        self.server.hits += 1
        payload = body.encode()
        self.send_response(status)
        if status == 302:
            self.send_header("location", "/__admin")
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass  # 静音，别把测试输出淹掉


def start_fake(script):
    port = free_port()
    srv = HTTPServer(("127.0.0.1", port), FakeUpstream)
    srv.script = list(script)
    srv.hits = 0
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


def start_shield(upstream_port, **env_overrides):
    port = free_port()
    env = dict(os.environ)
    env.update({
        "SHIELD_HOST": "127.0.0.1",
        "SHIELD_PORT": str(port),
        "UPSTREAM": f"http://127.0.0.1:{upstream_port}",
        # 测试用短预算，否则一个用例要等十分钟。
        "MAX_BUDGET_SECS": "25",
        "MAX_ATTEMPTS": "10",
        "SWAP_BUDGET_SECS": "25",
        "SWAP_MAX_ATTEMPTS": "10",
    })
    env.update(env_overrides)
    proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "kiro_shield.py")],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    # 等监听就绪
    for _ in range(100):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return proc, port
        except OSError:
            if proc.poll() is not None:
                err = proc.stderr.read().decode("utf-8", "replace")
                raise RuntimeError(f"盾启动失败:\n{err}")
            time.sleep(0.1)
    raise RuntimeError("盾未在 10 秒内监听")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """测试客户端也不跟随 3xx —— 跟随会让 302 用例跑到假上游的 GET 501 上。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_NOREDIR_OPENER = urllib.request.build_opener(_NoRedirect)


def call(port, path="/v1/messages", body=None, headers=None):
    # host 必须是非回环域名：盾的 `_check_host` 会拒绝 Host 指向本地回环的
    # 请求（防公网伪造 Host:127.0.0.1 骗过网关「本机直连」豁免）。测试客户端
    # 走的是真实公网形态（FurCDN → 盾），Host 用线上域名。
    hdrs = {"content-type": "application/json", "authorization": "Bearer test",
            "host": "fuckopencode.dwgx.top"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(body or {"model": "deepseek-v4-flash",
                                 "messages": [{"role": "user", "content": "hi"}]}).encode(),
        headers=hdrs,
        method="POST",
    )
    started = time.time()
    try:
        with _NOREDIR_OPENER.open(req, timeout=60) as r:
            return r.status, r.read().decode("utf-8", "replace"), time.time() - started
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), time.time() - started


POOL_EMPTY = json.dumps({"error": {"message": "all upstream keys are disabled",
                                   "type": "server_error"}})
UPSTREAM_DOWN = json.dumps({"error": {"message": "upstream unavailable",
                                      "type": "server_error"}})
UNAUTHORIZED = json.dumps({"error": {"message": "unauthorized",
                                     "type": "authentication_error"}})
CONTENT_POLICY = json.dumps({"error": {
    "message": "message content violates content policy",
    "type": "invalid_request_error"}})
# 上游 403 真实原因：模型区域限制（用户反馈的原型）。无标记词，落 auth 兜底。
REGION_403 = json.dumps({"error": {
    "type": "RegionError",
    "message": "The latest version of this model is only available hosted in "
               "China and requires explicit opt in: https://example.com/opt-in"}})
# 带 authentication_error 标记的 403（用户实测形态）：落 client 分支。
# message 里混进假 sk- 密钥，验证脱敏。
REGION_403_CLIENT = json.dumps({"error": {
    "type": "authentication_error",
    "message": "RegionError: The latest version of this model is only available "
               "hosted in China and requires explicit opt in: "
               "https://example.com/opt-in key sk-live-abc123def456ghi789"}})
# 上游额度耗尽（fuckopencode 透传形态）：type + Resets in，应原样透传。
GO_USAGE_LIMIT = json.dumps({"error": {
    "type": "GoUsageLimitError",
    "message": "Weekly usage limit reached. Resets in 3 days."}})

RESULTS = []


def check(name, ok, detail):
    RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}\n      {detail}")


def case_pool_empty_absorbed():
    """整池被禁的 503 必须被吸收，客户端看到 200。"""
    up, up_port = start_fake([(503, POOL_EMPTY), (503, POOL_EMPTY)])
    shield, sh_port = start_shield(up_port)
    try:
        status, body, elapsed = call(sh_port)
        check("整池被禁 503 被盾吸收 → 客户端 200",
              status == 200,
              f"status={status} 上游被打={up.hits} 次 耗时={elapsed:.1f}s")
        check("吸收过程确实重试了（不是一次就过）",
              up.hits >= 3,
              f"上游收到 {up.hits} 次请求（1 次失败 + 重试）")
    finally:
        shield.kill(); up.shutdown()


def case_upstream_unavailable_absorbed():
    """502 upstream unavailable 同样被吸收。"""
    up, up_port = start_fake([(502, UPSTREAM_DOWN)])
    shield, sh_port = start_shield(up_port)
    try:
        status, body, elapsed = call(sh_port)
        check("502 upstream unavailable 被吸收 → 200",
              status == 200,
              f"status={status} 上游被打={up.hits} 次 耗时={elapsed:.1f}s")
    finally:
        shield.kill(); up.shutdown()


def case_client_fault_fast():
    """客户端自己的 401 不该被长窗拖住。"""
    up, up_port = start_fake([(401, UNAUTHORIZED)] * 20)
    shield, sh_port = start_shield(up_port)
    try:
        status, body, elapsed = call(sh_port)
        check("客户端 401 快速收敛（不拖长窗）",
              elapsed < 15,
              f"status={status} 耗时={elapsed:.1f}s（长窗会是 25s+）")
    finally:
        shield.kill(); up.shutdown()


def case_content_policy_fast():
    """网关注入拦截（400 content policy）是确定性错误，不该被 auth 长窗拖住。"""
    up, up_port = start_fake([(400, CONTENT_POLICY)] * 20)
    shield, sh_port = start_shield(up_port)
    try:
        status, body, elapsed = call(sh_port)
        check("400 content policy 快速收敛（不拖 auth 长窗）",
              elapsed < 15,
              f"status={status} 耗时={elapsed:.1f}s（auth 长窗会是 25s+）")
    finally:
        shield.kill(); up.shutdown()


MODEL_NOT_ALLOWED = json.dumps({
    "error": {
        "message": 'model "claude-fable-5" is not allowed (supported models: deepseek-v4-flash, deepseek-v4-flash-free)',
        "type": "invalid_request_error",
    },
})


def case_model_not_allowed_fast():
    """模型门确定性拒绝（400 is not allowed）不该被 auth/risk 长窗拖 90 秒。

    2026-08-15 日志深挖：claude-fable-5 被模型门拒的时段，盾把这类 400 当
    auth/risk 吸收（90s 预算，5s→32.8s 升档），客户端每个请求挂 ~90s 才收到
    错误。模型拒绝换号/重试多少次都是同一个 400，必须归 client 超短窗。
    """
    up, up_port = start_fake([(400, MODEL_NOT_ALLOWED)] * 20)
    shield, sh_port = start_shield(up_port)
    try:
        status, body, elapsed = call(sh_port)
        check("400 模型门拒绝快速收敛（不拖 auth 长窗）",
              elapsed < 15,
              f"status={status} 耗时={elapsed:.1f}s（auth 长窗会是 25s+）")
    finally:
        shield.kill(); up.shutdown()


def case_quota_passthrough():
    """上游额度耗尽（GoUsageLimitError）必须原样透传，不吸收不重试。

    周额度能挂 3 天，重试只白烧预算；用户要求下游知道「是额度问题 + 多久
    恢复」。命中直接 pass，客户端收到的是上游原文（429 + body），而不是
    干等预算耗尽后拿到通用 503。
    """
    up, up_port = start_fake([(429, GO_USAGE_LIMIT)] * 20)
    shield, sh_port = start_shield(up_port)
    try:
        status, body, elapsed = call(sh_port)
        check("GoUsageLimitError 原样透传（状态码 429，不是 503）",
              status == 429 and "GoUsageLimitError" in body,
              f"status={status} body={body[:90]}")
        check("透传 body 带重置时间（下游知道多久恢复）",
              "Resets in" in body,
              f"body={body[:120]}")
        check("不重试：上游只被请求一次（不白烧预算）",
              up.hits == 1,
              f"上游收到 {up.hits} 次请求")
    finally:
        shield.kill(); up.shutdown()


def case_success_passthrough():
    """2xx 直接透传。"""
    up, up_port = start_fake([])
    shield, sh_port = start_shield(up_port)
    try:
        status, body, elapsed = call(sh_port)
        check("2xx 直接透传，不预读",
              status == 200 and '"ok"' in body and elapsed < 3,
              f"status={status} 耗时={elapsed:.2f}s body={body[:60]}")
    finally:
        shield.kill(); up.shutdown()


def load_shield_module():
    """把盾当模块导入，用于直接测纯函数。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "kiro_shield_under_test", os.path.join(HERE, "kiro_shield.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["kiro_shield_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


def case_client_message_chinese():
    """给下游的文案必须是中文、且不漏内部术语。

    盾对下游只回 200/503/透传，信息全在文案里。原来是英文加内部术语
    （`credential swap in progress`），下游只知道「炸了」。
    """
    ks = load_shield_module()

    # 每类原因都要能生成文案，且都得是中文。
    reasons = ["network", "client", "perm", "swap", "budget"]
    msgs = {r: ks.client_message(r, elapsed=89.0, attempts=4) for r in reasons}

    def has_cjk(s):
        return any("一" <= c <= "鿿" for c in s)

    check("五类失败原因都有中文文案",
          all(has_cjk(m) for m in msgs.values()),
          "；".join(f"{r}={len(m)}字" for r, m in msgs.items()))

    # 内部术语不该出现在下游看到的文案里。
    leaks = ["credential swap", "retry budget", "upstream unreachable",
             "keypool", "key pool", "号池", "盾"]
    found = {r: [t for t in leaks if t.lower() in m.lower()]
             for r, m in msgs.items()}
    bad = {r: t for r, t in found.items() if t}
    check("文案不泄漏内部术语（credential swap / 号池 / 盾 等）",
          not bad, f"泄漏情况={bad or '无'}")

    # 每条都要告诉下游「等了多久、试了几次」，否则等于没说。
    check("每条文案都带重试次数与耗时",
          all("4 次" in m and "1 分 29 秒" in m for m in msgs.values()),
          f"样例={msgs['swap'][:70]}")

    # 容量问题和请求问题必须能区分 —— 决定下游是重发还是改配置。
    check("容量问题提示重发，请求问题提示先改对",
          "重发" in msgs["swap"] and "检查" in msgs["client"],
          f"swap={msgs['swap'][:40]}… / client={msgs['client'][:40]}…")

    # markdown 星号在终端客户端里会原样显示，不能留。
    check("文案不含 markdown 标记",
          not any("**" in m for m in msgs.values()),
          "无 ** 包裹")

    # fmt_secs 的边界
    cases = [(0, "0 秒"), (59, "59 秒"), (60, "1 分"), (89, "1 分 29 秒"),
             (3600, "1 小时"), (3661, "1 小时 1 分")]
    wrong = [(s, want, ks.fmt_secs(s)) for s, want in cases
             if ks.fmt_secs(s) != want]
    check("fmt_secs 秒/分/小时换算正确", not wrong, f"不符={wrong or '无'}")

    # 负数不该出现，但真出现了也不能显示成 "-3 秒"
    check("fmt_secs 负数被钳到 0", ks.fmt_secs(-5) == "0 秒",
          f"fmt_secs(-5)={ks.fmt_secs(-5)}")


def case_client_fault_message_delivered():
    """端到端：客户端真的收到中文 503 文案，而不是英文。"""
    up, up_port = start_fake([(401, UNAUTHORIZED)] * 20)
    shield, sh_port = start_shield(up_port)
    try:
        status, body, elapsed = call(sh_port)
        try:
            msg = json.loads(body)["error"]["message"]
        except Exception:
            msg = body
        has_cjk = any("一" <= c <= "鿿" for c in msg)
        check("端到端：401 收敛后下游拿到的是中文文案",
              status == 503 and has_cjk,
              f"status={status} message={msg[:90]}")
        check("端到端：文案里没有 credential swap 这类内部术语",
              "credential swap" not in msg.lower()
              and "check credentials" not in msg.lower(),
              f"message={msg[:90]}")
    finally:
        shield.kill(); up.shutdown()


def case_upstream_detail_message():
    """403 诊断信息带上游 error.message，且脱敏、截断；非 403 行为不变。"""
    ks = load_shield_module()
    prefix = "上游返回 403："

    region = json.dumps({
        "error": {
            "type": "RegionError",
            "message": "RegionError: The latest version of this model is only "
                       "available hosted in China and requires explicit opt in: "
                       "https://example.com/opt-in "
                       "key sk-live-abcdef1234567890abcdef1234567890 "
                       "Bearer fake-token-abcdef",
        }}).encode()
    d = ks.upstream_error_detail(403, region)
    check("403 诊断信息带上游 message 关键部分",
          d.startswith(prefix) and "RegionError" in d
          and "requires explicit opt in" in d,
          f"detail={d[:110]}…")
    check("403 诊断信息中密钥形态被脱敏（sk-/Bearer）",
          "sk-live-abcdef" not in d and "fake-token-abcdef" not in d
          and "***" in d,
          f"detail={d[:110]}…")

    top = json.dumps({"message": "顶层 message 形态也认"}).encode()
    d2 = ks.upstream_error_detail(403, top)
    check("兼容顶层 {message} 形态",
          d2 == prefix + "顶层 message 形态也认", f"detail={d2}")

    d3 = ks.upstream_error_detail(403, b"not json at all")
    check("非 JSON 错误体退回「上游返回 403」",
          d3 == "上游返回 403", f"detail={d3}")

    d4 = ks.upstream_error_detail(401, region)
    check("非 403 状态码不带 message（行为不变）",
          d4 == "上游返回 401", f"detail={d4}")

    long_msg = json.dumps({"error": {"message": "x" * 500}}).encode()
    d5 = ks.upstream_error_detail(403, long_msg)
    check("超长 message 截断到 200 字符",
          len(d5) == len(prefix) + 200, f"len={len(d5)}")


def case_403_region_message_delivered():
    """端到端：403（RegionError，落 auth 兜底）收敛后诊断信息带真实原因。"""
    up, up_port = start_fake([(403, REGION_403)] * 20)
    shield, sh_port = start_shield(
        up_port, AUTH_BUDGET_SECS="6", AUTH_MAX_ATTEMPTS="2")
    try:
        status, body, elapsed = call(sh_port)
        try:
            msg = json.loads(body)["error"]["message"]
        except Exception:
            msg = body
        check("403 收敛后诊断信息包含上游真实原因",
              status == 503 and "hosted in China" in msg
              and "requires explicit opt in" in msg,
              f"status={status} message={msg[:110]}")
    finally:
        shield.kill(); up.shutdown()


def case_403_client_fault_message_delivered():
    """端到端：client 分支的 403 同样带真实原因，且不泄漏 sk- 明文。"""
    up, up_port = start_fake([(403, REGION_403_CLIENT)] * 20)
    shield, sh_port = start_shield(up_port)
    try:
        status, body, elapsed = call(sh_port)
        try:
            msg = json.loads(body)["error"]["message"]
        except Exception:
            msg = body
        check("client 分支 403 带真实原因",
              status == 503 and "RegionError" in msg
              and "requires explicit opt in" in msg,
              f"status={status} message={msg[:110]}")
        check("诊断信息不泄漏 sk- 明文",
              "sk-live-abc123def456ghi789" not in msg
              and "***" in msg,
              f"message={msg[:110]}")
    finally:
        shield.kill(); up.shutdown()


def case_403_no_body_fallback():
    """端到端：403 无 body 时保持「上游返回 403」，不硬凑内容。"""
    up, up_port = start_fake([(403, "")] * 20)
    shield, sh_port = start_shield(
        up_port, AUTH_BUDGET_SECS="6", AUTH_MAX_ATTEMPTS="2")
    try:
        status, body, elapsed = call(sh_port)
        try:
            msg = json.loads(body)["error"]["message"]
        except Exception:
            msg = body
        check("403 无 body 保持「上游返回 403」",
              status == 503 and "上游返回 403" in msg
              and "RegionError" not in msg,
              f"status={status} message={msg[:110]}")
    finally:
        shield.kill(); up.shutdown()




def case_302_passthrough():
    """3xx 重定向直接透传，不跟随、不重试（登录 302 不能被吞）。"""
    up, up_port = start_fake([(302, "")])
    shield, sh_port = start_shield(up_port)
    try:
        status, body, elapsed = call(sh_port)
        check("302 直接透传（不跟随、不重试）",
              status == 302 and up.hits == 1,
              f"status={status} upstream_hits={up.hits} body={body[:60]}")
    finally:
        shield.kill(); up.shutdown()



def case_host_header_forwarded():
    """Host 头必须原样转发（曾误入 HOP_BY_HOP 导致网关 Origin 校验 403）。"""
    seen = {}

    class HostCapture(FakeUpstream):
        def do_POST(self):
            seen["host"] = self.headers.get("host", "")
            super().do_POST()

    port = t_free_port() if False else None
    import socket as _s
    with _s.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    srv = HTTPServer(("127.0.0.1", port), HostCapture)
    srv.script = []
    srv.hits = 0
    import threading as _t
    _t.Thread(target=srv.serve_forever, daemon=True).start()
    shield, sh_port = start_shield(port)
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{sh_port}/v1/messages",
            data=json.dumps({"model": "m", "messages": [{"role": "user", "content": "hi"}]}).encode(),
            headers={"content-type": "application/json", "host": "fuckopencode.dwgx.top"},
            method="POST",
        )
        with _NOREDIR_OPENER.open(req, timeout=30) as r:
            r.read()
        check("Host 头原样转发到上游",
              seen.get("host") == "fuckopencode.dwgx.top",
              f"upstream host={seen.get('host')!r}")
    finally:
        shield.kill(); srv.shutdown()


def case_admin_401_passthrough():
    """管理路径 401 直接透传（不重试、不包成 503）——面板登录失败立刻可见。

    网关登录失败的 401 错误体带 `authentication_error`，原实现会被判成
    `client`（2s×2 次/6s 预算）→ 面板登录失败被拖成「等几秒才 503」。
    管理路径的 401 是业务状态（未登录/密码错），客户端自己知道要登录，
    重试只会把「立刻 401」换成「迟到的 503」。
    """
    up, up_port = start_fake([(401, UNAUTHORIZED)] * 20)
    shield, sh_port = start_shield(up_port)
    try:
        status, body, elapsed = call(sh_port, path="/__admin/api/login",
                                    body={"username": "admin", "password": "x"})
        check("管理路径 401 原样透传（status=401，不是 503）",
              status == 401,
              f"status={status} 耗时={elapsed:.1f}s body={body[:60]}")
        check("管理路径 401 不重试（上游只被打 1 次）",
              up.hits == 1,
              f"上游被打={up.hits} 次（重试会是 2+ 次）")
        check("管理路径 401 秒回（无 client-wait 等待）",
              elapsed < 5,
              f"耗时={elapsed:.1f}s（client-wait 是 6s+ 预算）")
    finally:
        shield.kill(); up.shutdown()


def case_inference_401_still_converged():
    """非管理路径的 401 行为不变（仍快速收敛，不被长窗拖住）。"""
    up, up_port = start_fake([(401, UNAUTHORIZED)] * 20)
    shield, sh_port = start_shield(up_port)
    try:
        status, body, elapsed = call(sh_port)
        check("推理路径 401 仍快速收敛（行为不变）",
              status == 503 and elapsed < 15,
              f"status={status} 耗时={elapsed:.1f}s")
    finally:
        shield.kill(); up.shutdown()


def case_forward_headers_overwritten():
    """盾覆写 cf-connecting-ip 并剥离客户端伪造的转发头（登录限速按真实 IP）。

    攻击者直连盾时轮换 X-Forwarded-For 试图绕过网关登录限速 —— 盾必须把
    这些伪造头剥掉，改成真实对端 IP 写进 cf-connecting-ip，并打上
    X-Shield-Forwarded 标记。网关凭「回环对端 + 覆写后的头」限速。
    """
    seen = {}

    class HeaderCapture(FakeUpstream):
        def do_POST(self):
            seen["cf"] = self.headers.get("cf-connecting-ip", "")
            seen["xff"] = self.headers.get("x-forwarded-for")
            seen["xri"] = self.headers.get("x-real-ip")
            seen["cfray"] = self.headers.get("cf-ray")
            seen["shield"] = self.headers.get("x-shield-forwarded")
            super().do_POST()

    import socket as _s
    with _s.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    srv = HTTPServer(("127.0.0.1", port), HeaderCapture)
    srv.script = []
    srv.hits = 0
    import threading as _t
    _t.Thread(target=srv.serve_forever, daemon=True).start()
    shield, sh_port = start_shield(port)
    try:
        status, _, _ = call(sh_port, headers={
            "x-forwarded-for": "203.0.113.9, 10.0.0.1",
            "x-real-ip": "198.51.100.7",
            "cf-ray": "fake-ray",
        })
        check("cf-connecting-ip 被覆写为真实对端 IP（本机测试 = 127.0.0.1）",
              seen.get("cf") == "127.0.0.1",
              f"upstream cf-connecting-ip={seen.get('cf')!r}")
        check("客户端伪造的 x-forwarded-for 被剥离",
              seen.get("xff") is None,
              f"upstream x-forwarded-for={seen.get('xff')!r}")
        check("客户端伪造的 x-real-ip 被剥离",
              seen.get("xri") is None,
              f"upstream x-real-ip={seen.get('xri')!r}")
        check("客户端伪造的 cf-ray 被剥离",
              seen.get("cfray") is None,
              f"upstream cf-ray={seen.get('cfray')!r}")
        check("注入 X-Shield-Forwarded=1 标记（网关可信代理判定）",
              seen.get("shield") == "1",
              f"upstream x-shield-forwarded={seen.get('shield')!r}")
        check("请求本身成功透传",
              status == 200,
              f"status={status}")
    finally:
        shield.kill(); srv.shutdown()


def main():
    print("=== 盾行为验证（DWGX）===\n")
    case_client_message_chinese()
    case_upstream_detail_message()
    case_success_passthrough()
    case_302_passthrough()
    case_host_header_forwarded()
    case_forward_headers_overwritten()
    case_pool_empty_absorbed()
    case_upstream_unavailable_absorbed()
    case_client_fault_fast()
    case_client_fault_message_delivered()
    case_403_region_message_delivered()
    case_403_client_fault_message_delivered()
    case_403_no_body_fallback()
    case_content_policy_fast()
    case_model_not_allowed_fast()
    case_quota_passthrough()
    case_admin_401_passthrough()
    case_inference_401_still_converged()
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
