#!/usr/bin/env bash
# =============================================================================
# fuckopencode 一键安装/更新/卸载脚本（面向第三方部署者）。
#
#   install.sh                     # release 模式：下载 GitHub release 最新版
#   install.sh --source            # 源码模式：git clone + npm ci + npm run build
#   install.sh update              # 更新（release 重下 / source git pull + 构建）并重启
#   install.sh restart             # 重启服务
#   install.sh status              # 查看服务状态
#   install.sh uninstall           # 卸载（保留 data/ 与 fuckopencode.env）
#   install.sh --version <tag>     # 指定 release 版本（如 v0.2.0）
#
# 环境变量：
#   FC_INSTALL_DIR   安装目录（默认 Linux root=/opt/fuckopencode，否则 $HOME/fuckopencode）
#   FC_REPO          GitHub 仓库 owner/repo（默认 dwgx/fuckopencode）
#   FC_VERSION       release 版本 tag（等价 --version）
#
# 说明：
#   - release 资产名固定为 fuckopencode-v<tag>-dist.tar.gz + .sha256（见
#     .github/workflows/release.yml，tarball 只含 dist/，不含 scripts/）。
#     故 scripts/rollback-guard.sh 与 .env.example 需从源码仓库 raw 拉取；
#     拉不到时 rollback-guard.sh 缺失仅影响 OTA 回滚守卫（不影响正常启动），
#     .env.example 缺失则用内置最小模板兜底。
#   - 零外部依赖：bash + curl + tar + awk + grep + node。不需要 git/rsync。
#   - 生产形态：dist/ + data/ + scripts/ + fuckopencode.env，由 systemd 托管。
# =============================================================================
set -euo pipefail

REPO="${FC_REPO:-dwgx/fuckopencode}"
API_BASE="https://api.github.com/repos/${REPO}"
RAW_BASE="https://raw.githubusercontent.com/${REPO}"
REL_BASE="https://github.com/${REPO}/releases/download"

# ─── 终端颜色（非 tty 自动禁用） ───
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BLUE=$'\033[1;34m'; C_CYAN=$'\033[1;36m'; C_GREEN=$'\033[1;32m'
  C_YELLOW=$'\033[1;33m'; C_RED=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_BLUE=''; C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_OFF=''
fi

log()  { printf "${C_BLUE}==>${C_OFF} %s\n" "$*"; }
ok()   { printf "${C_GREEN}  OK${C_OFF} %s\n" "$*"; }
warn() { printf "${C_YELLOW} WARN${C_OFF} %s\n" "$*"; }
err()  { printf "${C_RED} FAIL${C_OFF} %s\n" "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<'EOF'
fuckopencode 一键安装脚本（OpenAI<->Anthropic 协议转换网关）

用法:
  install.sh [命令] [选项]

命令（默认 install）:
  install     安装。release 模式下载 GitHub release；--source 走源码构建
  update      更新到最新版本并重启（release 重下 / source git pull + 构建）
  restart     重启服务
  status      查看服务状态
  uninstall   卸载：停服务 + 删 systemd unit 与 OTA drop-in，保留 data/ 与 env

选项:
  --source        源码模式：clone 仓库 + npm ci + npm run build
  --version <tag> 指定 release 版本 tag（如 v0.2.0；默认最新 release）
  -h, --help      帮助

环境变量:
  FC_INSTALL_DIR   安装目录（Linux root 默认 /opt/fuckopencode，否则 $HOME/fuckopencode）
  FC_REPO          GitHub 仓库 owner/repo（默认 dwgx/fuckopencode）
  FC_VERSION       release 版本 tag（等价 --version）

示例:
  ./scripts/install.sh                     # 装最新 release 到 /opt/fuckopencode
  ./scripts/install.sh --source            # 从源码构建
  ./scripts/install.sh --version v0.2.0    # 装指定版本
  ./scripts/install.sh update              # 更新并重启
EOF
}

# ─── 平台/环境检测 ───
OS="$(uname -s)"
IS_MAC=0; SYSTEMD=0
case "$OS" in
  Darwin) IS_MAC=1 ;;
  Linux)  [ -d /run/systemd/system ] && SYSTEMD=1 ;;
  *) die "不支持的系统：$OS（仅 Linux / macOS）" ;;
esac

IS_ROOT=0
[ "$(id -u)" = "0" ] && IS_ROOT=1

NODE_BIN=""

# ─── 工具函数 ───

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "缺少 sha256sum / shasum 工具"
  fi
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    die "未找到 Node.js。需要 Node >= 22.5（node:sqlite）。安装指引：
  Debian/Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
  RHEL/Fedora:    sudo dnf install -y nodejs
  macOS:          brew install node  （或 nvm install 22）
  Windows/WSL:    建议 WSL2 + 上面任一 Linux 指引，或用 nvm-windows"
  fi
  local v major minor
  v="$(node -v | sed 's/^v//')"
  major="${v%%.*}"
  minor="$(printf '%s' "$v" | cut -d. -f2)"
  if [ "$major" -lt 22 ]; then
    die "Node.js 版本过低：v${v}（需要 >= 22.5）。安装指引见上。"
  fi
  if [ "$major" -eq 22 ] && [ "$minor" -lt 5 ]; then
    warn "Node v${v}：node:sqlite 需要 22.5+，用量持久化将降级为内存窗口（代理功能不受影响）。建议升级到 22.5+。"
  fi
  NODE_BIN="$(command -v node)"
}

detect_dir() {
  if [ -n "${FC_INSTALL_DIR:-}" ]; then
    printf '%s' "${FC_INSTALL_DIR%/}"
    return
  fi
  if [ "$IS_MAC" = "1" ]; then
    printf '%s' "$HOME/fuckopencode"
  elif [ "$IS_ROOT" = "1" ]; then
    printf '%s' "/opt/fuckopencode"
  else
    printf '%s' "$HOME/fuckopencode"
  fi
}

env_port() {
  local dir="$1" p
  p="$(grep -E '^[[:space:]]*PORT=' "$dir/fuckopencode.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')"
  printf '%s' "${p:-8787}"
}

latest_tag() {
  local t
  t="$(curl -fsSL --connect-timeout 10 "${API_BASE}/releases/latest" 2>/dev/null \
      | awk -F'"' '/"tag_name"[[:space:]]*:[[:space:]]*"/{print $4; exit}')" || true
  [ -n "$t" ] || die "无法获取最新 release tag。网络不通或仓库不存在（${REPO}）；可设 FC_VERSION 指定版本。"
  printf '%s' "$t"
}

normalize_tag() {
  local t="$1"
  case "$t" in v*) printf '%s' "$t" ;; *) printf 'v%s' "$t" ;; esac
}

# 下载 dist tarball + sha256 校验 + 解压到 dist.new + 轮转 dist → dist.prev。
# 供 install / update 的 release 模式共用。成功时把安装的版本号写进
# 全局 FC_VERSION_INSTALLED（不往 stdout 打版本号，避免被命令替换捕获）。
release_install() {
  local dir="$1" tag asset url tmp expected actual
  tag="$(normalize_tag "${FC_VERSION:-$(latest_tag)}")"
  asset="fuckopencode-${tag}-dist.tar.gz"
  url="${REL_BASE}/${tag}/${asset}"

  log "下载 release ${tag}: ${asset}"
  tmp="$(mktemp "${TMPDIR:-/tmp}/fc.XXXXXX.tar.gz")"
  if ! curl -fL --connect-timeout 10 --progress-bar -o "$tmp" "$url" 2>/dev/null; then
    rm -f "$tmp"
    die "下载失败：${url}（网络不通或该 tag 无此资产；国内网络可开代理后重试）"
  fi

  # sha256 校验（对标 release.yml 产出的 .sha256，shasum 格式：<hash>  <name>）
  if curl -fsSL --connect-timeout 10 -o "$tmp.sha256" "${url}.sha256" 2>/dev/null; then
    expected="$(awk 'NR==1{print $1}' "$tmp.sha256")"
    actual="$(sha256_file "$tmp")"
    rm -f "$tmp.sha256"
    if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
      rm -f "$tmp"
      die "sha256 校验失败（expected=${expected:-缺失} actual=${actual}）。已中止，未改动安装目录。"
    fi
    ok "sha256 校验通过（${actual:0:16}...）"
  else
    warn "无 ${asset}.sha256，跳过校验（建议从官方仓库安装以确保完整性）"
  fi

  rm -rf "$dir/dist.new"; mkdir -p "$dir/dist.new"
  tar xzf "$tmp" -C "$dir/dist.new" --strip-components=1
  rm -f "$tmp"

  # 关键产物校验，缺失则中止（否则 env 里的 OPENSEA_KEYS 没人读，全请求 503）
  [ -f "$dir/dist.new/main.js" ]   || { rm -rf "$dir/dist.new"; die "dist 缺少 main.js，产物异常"; }
  [ -f "$dir/dist.new/keypool.js" ] || { rm -rf "$dir/dist.new"; die "dist 缺少 keypool.js，产物异常"; }

  fetch_scripts "$dir" "$tag"
  fetch_env_example "$dir" "$tag"
  swap_dist "$dir" from_new
  FC_VERSION_INSTALLED="${tag#v}"
}

# 从源码仓库 raw 拉 .env.example（release tarball 不含 env 模板）。
# 拉不到只警告：generate_env 会用内置最小模板兜底。
fetch_env_example() {
  local dir="$1" tag="$2"
  if curl -fsSL --connect-timeout 10 -o "$dir/.env.example" \
        "${RAW_BASE}/${tag}/.env.example" 2>/dev/null; then
    ok "已获取 .env.example（${tag}）"
  else
    rm -f "$dir/.env.example"
    warn "无法获取 .env.example（${RAW_BASE}/${tag}/.env.example），将使用内置最小模板"
  fi
}

# 从源码仓库 raw 拉 scripts/rollback-guard.sh（release tarball 不含 scripts/）。
# 拉不到只警告：正常启动不依赖它，仅 OTA 崩溃回滚守卫缺失。
fetch_scripts() {
  local dir="$1" tag="$2"
  if curl -fsSL --connect-timeout 10 -o "$dir/scripts/rollback-guard.sh" \
        "${RAW_BASE}/${tag}/scripts/rollback-guard.sh" 2>/dev/null; then
    chmod +x "$dir/scripts/rollback-guard.sh"
    ok "已获取 scripts/rollback-guard.sh（${tag}）"
  else
    rm -f "$dir/scripts/rollback-guard.sh"
    warn "无法获取 scripts/rollback-guard.sh（${RAW_BASE}/${tag}/scripts/...），OTA 崩溃回滚守卫不可用（不影响正常启动）"
  fi
}

# 原子替换：删上一轮备份 → 当前 dist 挪成 dist.prev（回滚点）→ 上新的。
# 顺带清 boot 计数（M-2：否则 restart 后计数达到阈值会被守卫误判回滚）。
swap_dist() {
  local dir="$1"
  rm -rf "$dir/dist.prev"
  [ -d "$dir/dist" ] && mv "$dir/dist" "$dir/dist.prev"
  if [ "${2:-}" = "from_new" ]; then
    mv "$dir/dist.new" "$dir/dist"
  fi
  rm -f "$dir/fuckopencode.boot_attempts"
}

# ─── 源码模式 ───

source_install() {
  local dir="$1"
  if [ -f package.json ] && grep -qE '"name"[[:space:]]*:[[:space:]]*"fuckopencode"' package.json; then
    log "使用当前目录作为源码（${PWD}）"
    mkdir -p "$dir"
    tar --exclude='./.git' --exclude='./node_modules' --exclude='./dist' \
        --exclude='./dist.prev' --exclude='./data' --exclude='./fuckopencode.env' \
        -cf - . | ( cd "$dir" && tar xf - )
  else
    log "git clone ${REPO}（--depth 1）"
    mkdir -p "$dir"
    if ! git clone --depth 1 "https://github.com/${REPO}.git" "$dir"; then
      die "git clone 失败（网络不通或仓库不存在：${REPO}）"
    fi
  fi
  source_build "$dir"
  log "源码构建完成，版本：$(cat "$dir/dist/version.txt" 2>/dev/null || echo unknown)"
}

source_update() {
  local dir="$1"
  if [ -d "$dir/.git" ]; then
    log "源码更新：git pull + npm ci + npm run build（${dir}）"
    ( cd "$dir" && git pull --ff-only ) || die "git pull 失败"
  else
    # 用「当前目录拷贝」装进来的没有 .git（source_install 排除了它），
    # git pull 无从谈起——回退到从当前目录重新拷贝源码再构建。
    if [ -f package.json ] && grep -qE '"name"[[:space:]]*:[[:space:]]*"fuckopencode"' package.json; then
      log "源码更新：从当前目录重新拷贝（${PWD}）+ npm ci + npm run build"
      mkdir -p "$dir"
      tar --exclude='./.git' --exclude='./node_modules' --exclude='./dist' \
          --exclude='./dist.prev' --exclude='./data' --exclude='./fuckopencode.env' \
          -cf - . | ( cd "$dir" && tar xf - )
    else
      die "安装目录 ${dir} 不是 git 仓库且当前目录也不是源码，无法更新。请回到源码目录再跑 update，或改用 --source 重新安装。"
    fi
  fi
  source_build "$dir"
  log "构建完成，版本：$(cat "$dir/dist/version.txt" 2>/dev/null || echo unknown)"
}

# 源码构建：构建前先把旧 dist 挪成 dist.prev（回滚点），并清 boot 计数。
# 与 release 模式语义一致：dist.prev 永远指「上一个可运行版本」。
source_build() {
  local dir="$1"
  ( cd "$dir" && rm -rf dist.prev && [ -d dist ] && mv dist dist.prev; rm -f fuckopencode.boot_attempts )
  ( cd "$dir" && npm ci ) || die "npm ci 失败（需网络拉取 devDependencies）"
  ( cd "$dir" && npm run build ) || die "npm run build 失败"
}

# ─── env 生成 ───

generate_env() {
  local dir="$1"
  if [ -f "$dir/fuckopencode.env" ]; then
    ok "fuckopencode.env 已存在，跳过生成（保持你的配置不动）"
  elif [ -f "$dir/.env.example" ]; then
    cp "$dir/.env.example" "$dir/fuckopencode.env"
    ok "已从 .env.example 生成 fuckopencode.env"
  else
    warn ".env.example 不可用，写入内置最小模板（完整清单见 README「配置」章节）"
    cat > "$dir/fuckopencode.env" <<'ENVEOF'
# fuckopencode 最小配置模板（完整清单见 README「配置」章节）
# 必填：调用方鉴权 key，逗号分隔。空 = fail-closed 拒绝所有请求。
API_KEYS=
# 必填（二选一）：上游 DeepSeek key 池，逗号分隔
OPENSEA_KEYS=
# 或单 key（并入 key 池）
ANTHROPIC_API_KEY=

HOST=127.0.0.1
PORT=8787

# 管理面板
ADMIN_USER=admin
ADMIN_PASS=13141516
# 仅绑定回环地址时生效：本机直连面板免 key
DASHBOARD_OPEN=0

# GitHub OTA 自更新（默认关；开启后把 OTA_REPO 改成你自己的 fork 仓库）
OTA_REPO=dwgx/fuckopencode
OTA_ENABLED=0
ENVEOF
    ok "已写入最小模板 fuckopencode.env"
  fi
  check_required "$dir"
}

# 必填项缺失：醒目警告但不退出（对标 windsurf setup.sh「生成后提示编辑」——
# 安装本身成功，缺 key 时网关 fail-closed 自动拒绝请求，安全有兜底；
# 用户改完 env 后 restart 即可）。fail-hard 会打断安装流程，对一次性脚本
# 部署者不友好。
check_required() {
  local dir="$1" missing=()
  grep -qE '^[[:space:]]*API_KEYS=[^[:space:]]' "$dir/fuckopencode.env" 2>/dev/null \
    || missing+=("API_KEYS")
  grep -qE '^[[:space:]]*(OPENSEA_KEYS|ANTHROPIC_API_KEY)=[^[:space:]]' "$dir/fuckopencode.env" 2>/dev/null \
    || missing+=("OPENSEA_KEYS / ANTHROPIC_API_KEY")
  if [ "${#missing[@]}" -gt 0 ]; then
    warn ""
    warn "必填项未配置：${missing[*]}"
    warn "  编辑 ${dir}/fuckopencode.env 后执行：install.sh restart"
    warn "  网关对缺配置 fail-closed（无 API_KEYS 会拒绝所有请求），这是安全行为，非 bug。"
    warn ""
  fi
}

# ─── systemd unit 与 OTA drop-in ───

write_unit() {
  local dir="$1"
  if [ "$SYSTEMD" = "1" ] && [ "$IS_ROOT" = "1" ]; then
    cat > /etc/systemd/system/fuckopencode.service <<EOF
[Unit]
Description=fuckopencode OpenAI<->Anthropic protocol gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=${dir}
ExecStart=${NODE_BIN} --max-old-space-size=256 ${dir}/dist/main.js
Restart=always
RestartSec=5
MemoryMax=320M
OOMScoreAdjust=500
EnvironmentFile=${dir}/fuckopencode.env
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
    ok "已写入 /etc/systemd/system/fuckopencode.service"
  else
    warn "非 root/systemd 环境，跳过 systemd unit 写入（下方会以 nohup 启动，适合开发场景）"
  fi
}

write_ota_dropin() {
  local dir="$1"
  # rollback-guard.sh 默认 WORKDIR=/root/fuckopencode（源码写死），这里必须显式
  # 用 Environment=FC_WORKDIR 指到实际安装目录，否则守卫在错目录里找 dist.prev。
  if [ "$SYSTEMD" = "1" ] && [ "$IS_ROOT" = "1" ] && [ -f "$dir/scripts/rollback-guard.sh" ]; then
    mkdir -p /etc/systemd/system/fuckopencode.service.d
    cat > /etc/systemd/system/fuckopencode.service.d/ota.conf <<EOF
[Service]
ExecStartPre=${dir}/scripts/rollback-guard.sh
StartLimitIntervalSec=0
Environment=FC_WORKDIR=${dir}
EOF
    ok "已写入 OTA drop-in /etc/systemd/system/fuckopencode.service.d/ota.conf"
  fi
}

# ─── 启动 / 健康检查 ───

start_systemd() {
  local dir="$1" port
  systemctl daemon-reload
  systemctl enable fuckopencode >/dev/null 2>&1 || true
  systemctl restart fuckopencode
  port="$(env_port "$dir")"
  sleep 3
  if curl -fsS -m 5 "http://127.0.0.1:${port}/healthz" 2>/dev/null | grep -q ok; then
    ok "服务已启动，健康检查通过（http://127.0.0.1:${port}/healthz）"
  else
    warn "健康检查未通过。诊断："
    warn "  systemctl status fuckopencode"
    warn "  journalctl -u fuckopencode -n 50 --no-pager"
    warn "  curl -v http://127.0.0.1:${port}/healthz"
    warn "  node -v（需 >= 22.5，node:sqlite）"
    exit 1
  fi
}

start_nohup() {
  local dir="$1" port pid old
  if [ -f "$dir/fuckopencode.pid" ]; then
    old="$(cat "$dir/fuckopencode.pid" 2>/dev/null || true)"
    [ -n "$old" ] && kill "$old" 2>/dev/null || true
    sleep 1
    rm -f "$dir/fuckopencode.pid"
  fi
  port="$(env_port "$dir")"
  log "以 nohup 方式启动（日志 ${dir}/data/fuckopencode.log）"
  # 等价于 systemd 的 EnvironmentFile：把 env 文件内容导进进程环境，
  # 否则 nohup 直接跑 node 会忽略 fuckopencode.env（PORT 等全走默认值）。
  # 注意：这里用 source 解析 env，值含特殊字符（# / 空格 / 引号）会解析错。
  # nohup 模式仅供开发场景；生产或 env 值含特殊字符请用 systemd（EnvironmentFile）。
  set -a
  # shellcheck disable=SC1091
  . "$dir/fuckopencode.env"
  set +a
  nohup "$NODE_BIN" --max-old-space-size=256 "$dir/dist/main.js" \
      >> "$dir/data/fuckopencode.log" 2>&1 &
  pid=$!
  echo "$pid" > "$dir/fuckopencode.pid"
  sleep 2
  if curl -fsS -m 5 "http://127.0.0.1:${port}/healthz" 2>/dev/null | grep -q ok; then
    ok "启动成功（PID ${pid}）"
  else
    warn "健康检查未通过。日志：${dir}/data/fuckopencode.log"
    warn "  tail -n 50 ${dir}/data/fuckopencode.log"
    warn "  node -v（需 >= 22.5）"
    exit 1
  fi
}

start_service() {
  local dir="$1"
  if [ "$SYSTEMD" = "1" ] && [ "$IS_ROOT" = "1" ]; then
    start_systemd "$dir"
  else
    start_nohup "$dir"
  fi
}

# ─── 元数据（记录安装目录/模式，供 update/status/uninstall 定位） ───

write_meta() {
  cat > "$1/.fuckopencode.meta" <<EOF
INSTALL_DIR=$1
MODE=$2
REPO=${REPO}
EOF
}

meta_mode() {
  local dir="$1"
  grep -E '^MODE=' "$dir/.fuckopencode.meta" 2>/dev/null | cut -d= -f2- || printf 'release'
}

# ─── 子命令 ───

cmd_install() {
  local dir mode
  dir="$(detect_dir)"
  mode="$MODE"
  require_node
  log "安装 fuckopencode 到 ${dir}（模式：${mode}）"
  mkdir -p "$dir/data" "$dir/scripts"
  if [ "$mode" = "source" ]; then
    source_install "$dir"
  else
    release_install "$dir"
    log "已安装版本 v${FC_VERSION_INSTALLED}"
  fi
  generate_env "$dir"
  write_unit "$dir"
  write_ota_dropin "$dir"
  write_meta "$dir" "$mode"
  start_service "$dir"
  print_next "$dir"
}

cmd_update() {
  local dir mode
  dir="$(detect_dir)"
  [ -d "$dir" ] || die "安装目录 ${dir} 不存在，请先 install"
  require_node
  mode="$(meta_mode "$dir")"
  log "更新 ${dir}（模式：${mode}）"
  if [ "$mode" = "source" ]; then
    source_update "$dir"
  else
    release_install "$dir"
  fi
  generate_env "$dir"
  write_unit "$dir"
  write_ota_dropin "$dir"
  write_meta "$dir" "$mode"
  start_service "$dir"
  print_next "$dir"
}

cmd_restart() {
  local dir
  dir="$(detect_dir)"
  [ -d "$dir" ] || die "安装目录 ${dir} 不存在，请先 install"
  require_node
  log "重启 ${dir}"
  start_service "$dir"
}

cmd_status() {
  local dir pid
  dir="$(detect_dir)"
  if [ "$SYSTEMD" = "1" ] && [ "$IS_ROOT" = "1" ]; then
    if systemctl is-active --quiet fuckopencode 2>/dev/null; then
      ok "fuckopencode 运行中（systemd）"
    else
      warn "fuckopencode 未运行（systemd）"
    fi
    systemctl --no-pager -l --lines=8 status fuckopencode 2>/dev/null || true
  elif [ -f "$dir/fuckopencode.pid" ]; then
    pid="$(cat "$dir/fuckopencode.pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      ok "fuckopencode 运行中（PID ${pid}）"
    else
      warn "PID ${pid:-缺失} 不存在，服务未运行"
    fi
    echo "  安装目录：${dir}"
    echo "  日志：${dir}/data/fuckopencode.log"
  else
    warn "安装目录 ${dir} 未找到运行状态（未安装，或不是 systemd/pid 文件环境）"
  fi
}

cmd_uninstall() {
  local dir
  dir="$(detect_dir)"
  [ -d "$dir" ] || die "安装目录不存在：${dir}"
  if [ "$SYSTEMD" = "1" ] && [ "$IS_ROOT" = "1" ]; then
    log "停止并禁用服务"
    systemctl disable --now fuckopencode >/dev/null 2>&1 || systemctl stop fuckopencode 2>/dev/null || true
    rm -f /etc/systemd/system/fuckopencode.service
    rm -rf /etc/systemd/system/fuckopencode.service.d
    systemctl daemon-reload
    ok "已删除 systemd unit 与 OTA drop-in"
  elif [ -f "$dir/fuckopencode.pid" ]; then
    kill "$(cat "$dir/fuckopencode.pid")" 2>/dev/null || true
    rm -f "$dir/fuckopencode.pid"
    ok "已停止 nohup 进程"
  fi
  warn "已保留 ${dir}/data/（含 secret.key 与 usage.db，勿删）和 ${dir}/fuckopencode.env。"
  warn "确认不需要后手动删除整个目录：rm -rf ${dir}"
  ok "卸载完成"
}

print_next() {
  local dir="$1"
  echo ""
  ok "安装完成。下一步："
  echo ""
  echo "  1. 编辑配置：${C_CYAN}${dir}/fuckopencode.env${C_OFF}"
  echo "     必填：API_KEYS（客户端管理 key）、OPENSEA_KEYS 或 ANTHROPIC_API_KEY（上游 key）"
  echo "     保存后：install.sh restart"
  echo "  2. 管理面板：http://127.0.0.1:$(env_port "$dir")/__admin"
  echo "     默认账号 admin / ADMIN_PASS（默认密码 13141516，首次登录请立即改强密码）"
  echo "  3. 客户端用法："
  echo "     Claude Code: ANTHROPIC_BASE_URL=http://127.0.0.1:$(env_port "$dir") \\"
  echo "                   ANTHROPIC_AUTH_TOKEN=<API_KEYS 之一> \\"
  echo "                   ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-flash claude"
  echo "     OpenAI 兼容: curl http://127.0.0.1:$(env_port "$dir")/v1/chat/completions -H \"Authorization: Bearer <API_KEYS 之一>\" -d '...'"
  echo "  4. OTA 自更新（可选）：OTA_REPO 改成你自己的 fork/仓库 + OTA_ENABLED=1，"
  echo "     面板 Sec-Update 页可触发检查/更新（需 systemd + rollback-guard.sh 就位）"
  echo "  5. DASHBOARD_OPEN=1 注意事项：仅绑定回环地址（HOST=127.0.0.1）时免 key；"
  echo "     面板含调用方 IP/UA，绑定公网地址时不要开 DASHBOARD_OPEN/DASHBOARD_PUBLIC。"
  echo "  6. secret.key（${dir}/data/secret.key）请备份——丢失后账户/分发 token 永久不可解。"
  echo ""
}

# ─── 参数解析 ───

MODE="release"
COMMAND="install"
FC_VERSION="${FC_VERSION:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --source)      MODE="source" ;;
    --version)     shift; FC_VERSION="${1:-}" ;;
    --restart)     COMMAND="restart" ;;
    -h|--help)     usage; exit 0 ;;
    install|update|restart|status|uninstall) COMMAND="$1" ;;
    *) die "未知参数：$1（install.sh --help 查看用法）" ;;
  esac
  shift
done

case "$COMMAND" in
  install)   cmd_install ;;
  update)    cmd_update ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  uninstall) cmd_uninstall ;;
esac
