#!/bin/bash
# fuckopencode OTA crashloop 回滚守卫（systemd ExecStartPre）。
#
# 由 systemd `ExecStartPre=` 在每次 ExecStart 之前运行。与进程侧
# src/ota-guard.ts（稳定运行 30s 后清计数）配合，构成「新版启动即崩 → 自动回滚
# dist.prev 旧版」闭环。回滚决策放这里（systemd 层），绝不放可能已崩的
# 进程自己——见 .claude/docs/OTA.md §5。
#
# 机制：
#   - fuckopencode.boot_attempts 计数器：本脚本每次启动前 +1；**不由进程清**
#     （进程侧稳定 30s 只写 health 标记，见 src/ota-guard.ts confirmHealth）。
#     「能 bind 但运行期崩」的坏版靠跨重启累积计数触发回滚；计数重置只发生在
#     守卫裁决后（版本相等且 confirmed_at 不新鲜 = 无关失败）或 deploy.sh 手动部署。
#   - 判定 crashloop：dist.prev 存在（有可回滚的旧版）且计数 >= 阈值，且满足
#     「该版本从未被健康确认」（health 版本 != dist 版本）或「刚被健康确认又崩」
#     （confirmed_at 距今 <= FRESH_WINDOW，运行期崩 = 版本自身问题，OOM 史主要
#     崩溃形态）——稳定版本因 env/端口/磁盘等无关原因起不来不会静默降级。
#   - 回滚：把坏版 dist 改名 dist.failed.$TS 留证，用 dist.prev 覆盖回旧版，
#     删计数器。本次 ExecStart 随即拉起回滚后的旧版。
#
# 安全：只在 WORKDIR 内做 mv/rm，不调 systemctl。幂等 + fail-safe：任何异常
# （缺 dist.prev / 首次部署 / 读计数失败）一律放行启动，绝不因守卫挡住服务。
set -uo pipefail

WORKDIR="${FC_WORKDIR:-/root/fuckopencode}"
DIST="$WORKDIR/dist"
PREV="$WORKDIR/dist.prev"
COUNTER="$WORKDIR/fuckopencode.boot_attempts"
HEALTH="$WORKDIR/fuckopencode.health"
# 连续启动阶段崩溃达到此次数即回滚（RestartSec=3 下约 10s 内攒够）。
THRESHOLD="${FC_ROLLBACK_THRESHOLD:-3}"

log() { echo "[rollback-guard] $*"; }

# 读当前计数（缺失/非法按 0）
attempts=0
if [ -f "$COUNTER" ]; then
  read -r attempts < "$COUNTER" 2>/dev/null || attempts=0
  case "$attempts" in
    ''|*[!0-9]*) attempts=0 ;;
  esac
fi

# 本次启动前 +1
attempts=$((attempts + 1))
echo "$attempts" > "$COUNTER" 2>/dev/null || log "警告：无法写计数器 ${COUNTER}（继续放行）"
# 注意：${var} 必须加花括号 —— bash set -u 下 `$var` 紧跟全角字符会误判 unbound
# （实测 bash 5.2/5.3 都中招），线上是 Debian 12 的 bash 5.2。
log "启动尝试计数=${attempts}（阈值=${THRESHOLD}）"

# O-P2-3 + M-1：判定「当前 dist 是否从未被健康确认 / 刚确认过又崩」。health 文件
# 由进程稳定 30s 后写入（version=<版本> + confirmed_at=<unix 秒>）。版本一致 =
# 该版本至少稳定跑过 30s；此时再看 confirmed_at 新鲜度——**刚确认过（距今 <=
# FRESH_WINDOW）又攒满计数 = 运行期反复崩（版本自身问题，OOM 史主要形态），仍回滚**；
# confirmed_at 不新鲜（确认后正常跑了很久）才判「无关失败」不回滚。
DIST_VERSION=""
[ -f "$DIST/version.txt" ] && read -r DIST_VERSION < "$DIST/version.txt"
HEALTH_VERSION=""
HEALTH_CONFIRMED_AT=""
if [ -f "$HEALTH" ]; then
  HEALTH_VERSION="$(grep -m1 '^version=' "$HEALTH" 2>/dev/null | cut -d= -f2-)"
  HEALTH_CONFIRMED_AT="$(grep -m1 '^confirmed_at=' "$HEALTH" 2>/dev/null | cut -d= -f2-)"
fi
NOW="$(date +%s)"
FRESH_WINDOW="${FC_FRESH_WINDOW:-600}"
CONFIRMED_FRESH=0
case "$HEALTH_CONFIRMED_AT" in
  ''|*[!0-9]*) CONFIRMED_FRESH=0 ;;
  *) [ $((NOW - HEALTH_CONFIRMED_AT)) -le "$FRESH_WINDOW" ] && CONFIRMED_FRESH=1 ;;
esac

# 判定 crashloop：有回滚点 且 计数达阈值
if [ -d "$PREV" ] && [ "$attempts" -ge "$THRESHOLD" ]; then
  SAME_VERSION=0
  if [ -n "$DIST_VERSION" ] && [ -n "$HEALTH_VERSION" ] && [ "$DIST_VERSION" = "$HEALTH_VERSION" ]; then
    SAME_VERSION=1
  fi
  if [ "$SAME_VERSION" -eq 1 ] && [ "$CONFIRMED_FRESH" -ne 1 ]; then
    log "计数已达 ${THRESHOLD}，dist 版本 ${DIST_VERSION} 已被健康确认（confirmed_at=${HEALTH_CONFIRMED_AT:-缺失}，距今 $((NOW - HEALTH_CONFIRMED_AT))s，不新鲜）"
    log "判定为 env/端口/磁盘等无关启动失败，不触发回滚"
    # M-2：无关失败判定后重置计数——陈旧计数残留会在下次 OTA 新版本首次启动失败时
    # （新版本未健康确认 → dist != health → 判坏版）误触发回滚，撤销一次正常升级。
    echo 0 > "$COUNTER" 2>/dev/null || log "警告：无法重置计数器 ${COUNTER}"
  else
    # %N 纳秒防撞名：RestartSec=3 下崩溃重试可能落在同一秒，秒级时间戳会把
    # 两次留证写进同一个 dist.failed.* 目录（GNU/BSD date 都支持 %N）。
    TS=$(date +%Y%m%d-%H%M%S%N)
    FAILED="$WORKDIR/dist.failed.$TS"
    log "检测到 crashloop（新版连续 $attempts 次启动阶段崩溃），开始回滚到 dist.prev 旧版"
    log "当前 dist 版本=${DIST_VERSION:-缺失}，health 记录版本=${HEALTH_VERSION:-缺失}，confirmed_at 新鲜=${CONFIRMED_FRESH}"

    # 坏版留证（便于事后排查），失败不阻断回滚主流程
    if [ -d "$DIST" ]; then
      mv -f "$DIST" "$FAILED" 2>/dev/null && log "坏版已留证：${FAILED}（版本=${DIST_VERSION:-缺失}）" || log "警告：坏版留证失败（继续回滚）"
    fi

    if mv -f "$PREV" "$DIST" 2>/dev/null; then
      rm -f "$COUNTER" 2>/dev/null  # 清零，给回滚后旧版干净起点
      log "回滚完成：已用 dist.prev 覆盖 dist，本次 ExecStart 将拉起旧版"
    else
      # 回滚失败：把留证的坏版还原回去（至少让服务能按原样起，别两头空）
      log "错误：回滚 mv 失败，尝试还原坏版以免缺 dist"
      [ -d "$FAILED" ] && mv -f "$FAILED" "$DIST" 2>/dev/null
    fi
  fi
fi

# 守卫永远以 0 退出：绝不因自身逻辑挡住 ExecStart（fail-safe）。
exit 0
