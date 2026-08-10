#!/usr/bin/env python3
"""
盾的行为验证（DWGX）—— 不依赖线上，纯本地跑。

起一个假 fuckopencode 上游，按脚本编排的状态码序列作答，然后确认：
  1. 整池被禁的 503（`all upstream keys are disabled`）被盾吸收，
     客户端最终拿到 200 而不是 503。
  2. 502 `upstream unavailable` 同样被吸收。
  3. 客户端自己的错（401 unauthorized）**不**被长窗拖住，快速收敛。
  4. 2xx 直接透传，不预读（SSE 实时性不受影响）。

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


def call(port, path="/v1/messages", body=None):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(body or {"model": "deepseek-v4-flash",
                                 "messages": [{"role": "user", "content": "hi"}]}).encode(),
        headers={"content-type": "application/json", "authorization": "Bearer test"},
        method="POST",
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode("utf-8", "replace"), time.time() - started
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), time.time() - started


POOL_EMPTY = json.dumps({"error": {"message": "all upstream keys are disabled",
                                   "type": "server_error"}})
UPSTREAM_DOWN = json.dumps({"error": {"message": "upstream unavailable",
                                      "type": "server_error"}})
UNAUTHORIZED = json.dumps({"error": {"message": "unauthorized",
                                     "type": "authentication_error"}})

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


def main():
    print("=== 盾行为验证（DWGX）===\n")
    case_client_message_chinese()
    case_success_passthrough()
    case_pool_empty_absorbed()
    case_upstream_unavailable_absorbed()
    case_client_fault_fast()
    case_client_fault_message_delivered()
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
