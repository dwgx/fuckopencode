#!/usr/bin/env bash
# =============================================================================
# fuckopencode 部署到 nbus。本地跑。
#
#   ./scripts/deploy.sh             # 构建 + 推 dist + 重启（默认，含备份清理）
#   ./scripts/deploy.sh rollback    # 回滚到上一个 dist.prev
#   ./scripts/deploy.sh clean       # 只清线上旧备份（保留最近一个）
#
# 流程：typecheck+test+build → tar dist → scp → 原子替换 → 重启 → 验证。
# 备份只保留最近一个（dist.prev），不再像过去那样堆 dist.prev2/3/4…。
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."           # 仓库根

HOST="root@38.244.34.15"
PORT=52535
SSHOPTS="-p ${PORT} -i ~/.ssh/id_nbus -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
REMOTE="/root/fuckopencode"

rollback() {
  echo ">> 回滚到上一个 dist.prev ..."
  ssh ${SSHOPTS} "${HOST}" \
    "cd ${REMOTE} && test -d dist.prev && test -f dist.prev/keypool.js || { echo 'FATAL: dist.prev 缺失或不完整（缺 keypool.js），中止回滚'; exit 1; } && rm -rf dist && mv dist.prev dist && rm -f fuckopencode.boot_attempts && systemctl restart fuckopencode && sleep 3 && systemctl is-active fuckopencode" \
    || die "回滚失败"
  echo "  OK 回滚完成"
  exit 0
}

clean() {
  echo ">> 清理线上旧备份（保留最近一个 dist.prev）..."
  ssh ${SSHOPTS} "${HOST}" \
    "cd ${REMOTE} && KEEP=\$(ls -dt dist.prev* 2>/dev/null | head -1); for d in \$(ls -dt dist.prev* 2>/dev/null | tail -n +2); do rm -rf \"\$d\"; done; echo \"  保留: \${KEEP:-无}\"; du -sh ${REMOTE}" \
    || die "清理失败"
  exit 0
}

die() { echo "FAIL: $*" >&2; exit 1; }

case "${1:-}" in
  rollback) rollback ;;
  clean)    clean ;;
  ""|deploy) ;;
  *) die "未知参数: $1（可用 deploy / rollback / clean）" ;;
esac

echo ">> 本地验证 + 构建 ..."
npx tsc --noEmit || die "typecheck 失败"
npx vitest run || die "测试失败"
npm run build || die "build 失败"

echo ">> 打包并上传 ..."
TAR=$(mktemp /tmp/fc-dist.XXXXXX.tar.gz)
tar czf "$TAR" dist
scp -q -P ${PORT} -i ~/.ssh/id_nbus -o IdentitiesOnly=yes "$TAR" "${HOST}:/root/fc-dist.tar.gz"
rm -f "$TAR"

echo ">> 远端原子替换 + 重启 ..."
ssh ${SSHOPTS} "${HOST}" "bash -s" <<EOF
set -euo pipefail
cd ${REMOTE}
rm -rf dist.new && mkdir dist.new
tar xzf /root/fc-dist.tar.gz -C dist.new --strip-components=1 && rm -f /root/fc-dist.tar.gz
# 校验关键产物，缺失则中止（否则 env 里的 OPENSEA_KEYS 没人读，全请求 503）
test -f dist.new/keypool.js || { echo "FATAL: keypool.js 缺失"; exit 1; }
test -f dist.new/dsml.js || { echo "FATAL: dsml.js 缺失"; exit 1; }
# 备份轮转：删掉上一轮的备份，把当前 dist 挪成 dist.prev（回滚点），再上新的。
rm -rf dist.prev
if [ -d dist ]; then mv dist dist.prev; fi
mv dist.new dist
# 审查 M-2：主部署也清 boot 计数 —— 否则 OTA 后新版本曾崩过 2 次（计数 2），
# 手动部署 restart 触发 ExecStartPre 计数变 3 + 刚造出的 dist.prev，
# 守卫会把刚部署的新版当坏版回滚掉。
rm -f fuckopencode.boot_attempts
systemctl restart fuckopencode
sleep 3
systemctl is-active fuckopencode || { echo "FATAL: 服务未起来"; exit 1; }
EOF

echo ">> 健康检查 ..."
# 去盾后（2026-08-15）：fuckopencode-shield 已停，网关监听 0.0.0.0:8787（原盾端口），
# FurCDN 直连网关，链路里不再有盾。只查 8787 网关即可。
ssh ${SSHOPTS} "${HOST}" "curl -s -m 5 http://127.0.0.1:8787/healthz" | grep -q ok \
  || die "网关 8787 健康检查失败"
echo "  OK 网关 8787"
echo "  OK 部署完成"
