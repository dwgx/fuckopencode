#!/usr/bin/env bash
# =============================================================================
# 盾 + 切流脚本一键部署到 nbus（DWGX 维护）。本地跑。
#
#   ./scripts/dwgx/shield-deploy.sh          # 安装/更新盾 + 运维脚本 + systemd unit
#
# 做三件事：
#   1. 本地语法检查（shellcheck / python 编译）
#   2. 推 kiro_shield.py + shield/ + shield-status.sh 到 /opt/fuckopencode-shield
#   3. 装 /etc/systemd/system/fuckopencode-shield.service 并 restart
#
# 拓扑（端口互换，见下方 unit 注释）：
#   cloudflared -> 127.0.0.1:8787（盾）-> 127.0.0.1:8788（fuckopencode 网关）
#
# 幂等：重复跑只是覆盖 + restart。线上 unit 若被手改过会被覆盖，先看 diff 再决定。
# 注意：盾重启会清零统计，但不影响在途请求以外的东西。
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

HOST="root@38.244.34.15"
PORT=52535
SSHOPTS="-p ${PORT} -i ~/.ssh/id_nbus -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
REMOTE="/opt/fuckopencode-shield"

die() { echo "FAIL: $*" >&2; exit 1; }

echo ">> 本地检查 ..."
python3 -c "import ast; ast.parse(open('kiro_shield.py').read())"   || die "kiro_shield.py 语法错"
command -v shellcheck >/dev/null && shellcheck shield-status.sh || true

echo ">> 打包上传盾 ..."
# COPYFILE_DISABLE：否则 macOS 会把 ._* AppleDouble 元数据打进包，落到线上是垃圾文件
TAR=$(mktemp /tmp/fc-shield.XXXXXX)
# --no-xattrs 压掉 macOS 的 com.apple.provenance 警告；COPYFILE_DISABLE 防 ._* 元数据文件
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TAR.tar.gz" \
  kiro_shield.py shield/__init__.py shield/ui.py shield-status.sh
TAR="$TAR.tar.gz"
# scp 的端口参数是 -P（大写），与 ssh 的 -p 不同，所以不能直接复用 SSHOPTS
scp -q -P ${PORT} -i ~/.ssh/id_nbus -o IdentitiesOnly=yes "$TAR" "${HOST}:/tmp/fc-shield.tar.gz"
rm -f "$TAR"

ssh ${SSHOPTS} "${HOST}" "bash -s" <<EOF
set -euo pipefail
install -d -m 755 ${REMOTE}
tar xzf /tmp/fc-shield.tar.gz -C ${REMOTE} && rm -f /tmp/fc-shield.tar.gz
# tar 会带进本地 uid（501:staff），归一成 root，并清掉 macOS 可能漏进来的元数据
find ${REMOTE} -name '._*' -delete
chown -R root:root ${REMOTE}
chmod 644 ${REMOTE}/kiro_shield.py ${REMOTE}/shield/*.py
chmod 755 ${REMOTE}/shield-status.sh

# 盾现在就是网关入口：云端隧道直指 8787，盾监听 8787 并把上游转到 8788（网关）。
# 端口互换的动机：云端 public hostname 把 fuckopencode.dwgx.top 定死在 127.0.0.1:8787，
# 本地 config.yml 的 ingress 对 report 隧道不生效（cloudflared_config_local_config_pushes=0）。
# 所以让盾接管 8787、网关退到 8788，不改云端即可让流量过盾。回滚：改回两端口即可。
# unit 幂等安装
cat > /etc/systemd/system/fuckopencode-shield.service << 'UNIT'
[Unit]
Description=fuckopencode upstream shield (DWGX) - absorb 5xx/429 noise before it reaches clients
After=network.target fuckopencode.service
Wants=fuckopencode.service

[Service]
Type=simple
WorkingDirectory=/opt/fuckopencode-shield
ExecStart=/usr/bin/python3 /opt/fuckopencode-shield/kiro_shield.py
Restart=always
RestartSec=5
Environment=SHIELD_HOST=127.0.0.1
Environment=SHIELD_PORT=8787
Environment=UPSTREAM=http://127.0.0.1:8788
# DWGX: fuckopencode key pool all-disabled (503) -> 吸收为 200 后重试
# 资源约束：盾挂在 nbus，绝不允许挤掉 xray / fuckopencode
MemoryMax=128M
CPUQuota=80%
TasksMax=32
OOMScoreAdjust=400

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now fuckopencode-shield >/dev/null 2>&1 || true
systemctl restart fuckopencode-shield
sleep 2
systemctl is-active fuckopencode-shield || { echo "FATAL: 盾未起来"; exit 1; }
echo "  OK 盾已更新：\$(systemctl show fuckopencode-shield -p ActiveState -p MemoryCurrent --value | tr '\n' ' ')"
EOF

echo ">> 校验盾观测端点（8787）..."
ssh ${SSHOPTS} "${HOST}" "curl -s -m 8 http://127.0.0.1:8787/_shield/stats" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  OK 盾统计可读:', d['requests'], 'requests')"

echo "  完成。盾在 8787（网关入口）-> 网关 8788。盾观测面板：ssh -L 8787:127.0.0.1:8787 nbus"
echo "  shield-route.py 已不再适用（端口互换后隧道恒指 8787）。"
