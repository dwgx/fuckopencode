#!/usr/bin/env bash
# =============================================================================
# fuckopencode-shield 运维探活（DWGX 维护）
#
# 一屏看清盾 + 网关 + 隧道三者的存活、内存、以及盾吞掉了哪些上游波动。
# **只读**：不 restart、不改 unit。
#
#   ./scripts/dwgx/shield-status.sh          # 概览（默认）
#   ./scripts/dwgx/shield-status.sh events   # 盾捕获的异常事件明细
#   ./scripts/dwgx/shield-status.sh full     # 全量 dump（含 systemd status）
#
# 拓扑：cloudflared -> 127.0.0.1:8787（盾）-> 127.0.0.1:8788（fuckopencode 网关）
# 依赖：nbus ssh 可达（DEPLOY.md：root@38.244.34.15:52535 / ~/.ssh/id_nbus）
# =============================================================================
set -uo pipefail

SHIELD_URL="http://127.0.0.1:8787"

ssh_nbus() {
  ssh -o ConnectTimeout=10 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
    -i ~/.ssh/id_nbus -p 52535 root@38.244.34.15 "$@"
}

section() { printf '\n== %s ==\n' "$1"; }

# 一次 ssh 取三个服务的状态，避免每个服务一次往返
svc_table() {
  ssh_nbus '
    for u in fuckopencode fuckopencode-shield cloudflared; do
      state=$(systemctl show "$u" -p ActiveState --value 2>/dev/null)
      mem=$(systemctl show "$u" -p MemoryCurrent --value 2>/dev/null)
      case "$mem" in
        ""|"[not set]"|18446744073709551615) memh="-" ;;
        *) memh=$(awk -v b="$mem" "BEGIN{printf \"%.0fM\", b/1048576}") ;;
      esac
      printf "  %-22s %-10s %s\n" "$u" "${state:-unknown}" "$memh"
    done
  '
}

# 事件明细：ts 是 epoch，转成本地可读时间。用 %-format 避免引号转义。
fmt_events() {
  python3 -c '
import sys, json, time
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("  （盾未响应或返回非 JSON: %s）" % e); sys.exit(0)
evts = d.get("events") or []
if not evts:
    print("  （暂无异常事件 —— 上游一直健康）"); sys.exit(0)
for e in evts:
    t = time.strftime("%m-%d %H:%M:%S", time.localtime(e["ts"]))
    print("  [%s] %7s status=%-4s %-10s waited=%ss attempts=%s %s"
          % (t, e["verdict"], e["status"], e["outcome"], e["waited"],
             e["attempts"], e["path"]))
    if e.get("note"):
        print("            note: %s" % e["note"])
'
}

fmt_stats() {
  python3 -c '
import sys, json
try:
    s = json.load(sys.stdin)
except Exception as e:
    print("  （盾未响应: %s）" % e); sys.exit(0)
print("  收到请求 %s   重试 %s   吸收成功 %s   预算耗尽 %s"
      % (s["requests"], s["retries"], s["absorbed"], s["gave_up"]))
waits = {k: v for k, v in s.items() if k.endswith("_waits") and v}
if waits:
    print("  等待分布： " + "  ".join("%s=%s" % (k[:-6], v) for k, v in waits.items()))
if s.get("by_status"):
    print("  错误状态码： " + "  ".join("%sx%s" % (k, v) for k, v in sorted(s["by_status"].items())))
'
}

overview() {
  section "服务存活（unit / 状态 / 内存）"
  svc_table

  section "盾吞掉的上游波动（统计自盾上次启动）"
  ssh_nbus "curl -s -m 8 $SHIELD_URL/_shield/stats" | fmt_stats

  section "最近异常事件（最多 10 条）"
  ssh_nbus "curl -s -m 8 '$SHIELD_URL/_shield/events?limit=10'" | fmt_events

  section "盾面板（只监听回环，不经隧道对外）"
  echo "  ssh -L 8787:127.0.0.1:8787 nbus     然后开 http://127.0.0.1:8787/_shield/ui"
}

case "${1:-overview}" in
  overview)
    overview ;;
  events)
    section "盾捕获的异常事件（最多 50 条）"
    ssh_nbus "curl -s -m 8 '$SHIELD_URL/_shield/events?limit=50'" | fmt_events ;;
  full)
    section "机器内存"
    ssh_nbus 'free -m | head -2'
    section "服务存活"
    svc_table
    section "盾统计"
    ssh_nbus "curl -s -m 8 $SHIELD_URL/_shield/stats" | fmt_stats
    section "盾事件"
    ssh_nbus "curl -s -m 8 '$SHIELD_URL/_shield/events?limit=50'" | fmt_events
    section "systemd 详情"
    ssh_nbus 'systemctl status fuckopencode fuckopencode-shield --no-pager -l | head -40' ;;
  *)
    echo "用法: $0 [overview|events|full]" >&2; exit 2 ;;
esac
