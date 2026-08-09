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


def main():
    print("=== 盾行为验证（DWGX）===\n")
    case_success_passthrough()
    case_pool_empty_absorbed()
    case_upstream_unavailable_absorbed()
    case_client_fault_fast()
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
