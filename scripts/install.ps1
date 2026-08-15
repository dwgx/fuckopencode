<#
.SYNOPSIS
fuckopencode Windows 一键安装/更新脚本（OpenAI<->Anthropic 协议转换网关）。

.DESCRIPTION
从 GitHub release 下载最新 dist tarball，校验 sha256，解压到安装目录，生成
fuckopencode.env 最小模板并后台启动网关。Windows 10 17063+ 内置 tar 支持 .tar.gz。
与 scripts/install.sh 同源，仅平台启动方式不同（systemd/nohup -> Start-Process）。

.PARAMETER SkipStart
只安装不启动（适合先配好 env 再手动启动）。

.PARAMETER Help
显示本帮助。

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\install.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipStart

.NOTES
环境变量（PowerShell 里用 $env:FC_INSTALL_DIR 等）：
  FC_INSTALL_DIR   安装目录（默认管理员 %ProgramFiles%\fuckopencode，否则 %USERPROFILE%\fuckopencode）
  FC_REPO          GitHub 仓库 owner/repo（默认 dwgx/fuckopencode）
  FC_VERSION       release 版本 tag（默认最新 release）
#>
param(
    [switch]$Help,
    [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

# ─── 仓库与 URL ───
$Repo = if ($env:FC_REPO) { $env:FC_REPO } else { 'dwgx/fuckopencode' }
$ApiBase = "https://api.github.com/repos/$Repo"

# ─── 输出函数 ───
function Write-Step { Write-Host ("==> " + ($args -join ' ')) -ForegroundColor Blue }
function Write-OK   { Write-Host ("  OK " + ($args -join ' ')) -ForegroundColor Green }
function Write-Warn { Write-Host (" WARN " + ($args -join ' ')) -ForegroundColor Yellow }
function Write-Err  { Write-Host (" FAIL " + ($args -join ' ')) -ForegroundColor Red }
function Die {
    Write-Err $args
    if ($script:tmpDir) { Remove-Item -Path $script:tmpDir -Recurse -Force -ErrorAction SilentlyContinue }
    exit 1
}

$script:tmpDir = $null
trap {
    if ($script:tmpDir) { Remove-Item -Path $script:tmpDir -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Err "脚本异常终止：$_"
    exit 1
}

if ($Help) { Get-Help $PSCommandPath; exit 0 }

# ─── 平台检查 ───
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    Die "此脚本仅支持 Windows。Linux/macOS 请用 scripts\install.sh"
}

# ─── 工具函数 ───

# 取 release 信息（最新或指定 tag）。GitHub API 需要 User-Agent，超时 30s。
function Get-Release {
    param([string]$Tag)
    $uri = if ($Tag) { "$ApiBase/releases/tags/$Tag" } else { "$ApiBase/releases/latest" }
    try {
        return Invoke-RestMethod -Uri $uri -Headers @{ 'User-Agent' = 'fuckopencode-install' } -TimeoutSec 30
    } catch {
        Die "无法获取 release 信息：$($_.Exception.Message)（网络不通或仓库不存在：$Repo）"
    }
}

# 把 fuckopencode.env 加载进当前进程环境。网关只读 process.env，
# 与 systemd EnvironmentFile / install.sh nohup 的 source 语义一致。
function Import-EnvFile {
    param([string]$Path)
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        $line = $line.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $idx = $line.IndexOf('=')
        if ($idx -le 0) { continue }
        $key = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        if ($key -and $value) { Set-Item -Path "Env:$key" -Value $value }
    }
}

# ─── 1. Node.js 检查（node:sqlite 需要 22.5+） ───
Write-Step "检查 Node.js（>= 22.5）"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Die "未找到 Node.js。需要 Node >= 22.5（node:sqlite）。安装：https://nodejs.org 或 winget install OpenJS.NodeJS.LTS"
}
$nodeVer = (& node -v 2>$null)
if (-not $nodeVer) { Die "node -v 执行失败" }
$nodeVer = $nodeVer.Trim().TrimStart('v')
$parts = $nodeVer.Split('.')
if ($parts.Length -lt 2) { Die "无法解析 Node 版本：$nodeVer" }
$major = [int]$parts[0]
$minor = [int]$parts[1]
if ($major -lt 22) { Die "Node.js 版本过低：v$nodeVer（需要 >= 22.5）。请升级后重跑。" }
if ($major -eq 22 -and $minor -lt 5) {
    Write-Warn "Node v$nodeVer：node:sqlite 需要 22.5+，用量持久化将降级为内存窗口（代理功能不受影响）。建议升级到 22.5+。"
}
Write-OK "Node.js v$nodeVer"

# ─── 2. 安装目录（管理员 Program Files，否则用户目录；FC_INSTALL_DIR 覆盖） ───
Write-Step "确定安装目录"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($env:FC_INSTALL_DIR) {
    $installDir = $env:FC_INSTALL_DIR.TrimEnd('\')
} elseif ($isAdmin) {
    $installDir = Join-Path $env:ProgramFiles 'fuckopencode'
} else {
    $installDir = Join-Path $env:USERPROFILE 'fuckopencode'
}
Write-OK "安装目录：$installDir"

# ─── 3. release 信息 + 资产定位 ───
$FC_VERSION = $env:FC_VERSION
if ($FC_VERSION -and $FC_VERSION -notlike 'v*') { $FC_VERSION = "v$FC_VERSION" }
$rel = Get-Release $FC_VERSION
$tag = $rel.tag_name
$assetName = "fuckopencode-$tag-dist.tar.gz"
$asset = $rel.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
$shaAsset = $rel.assets | Where-Object { $_.name -eq "$assetName.sha256" } | Select-Object -First 1
if (-not $asset -or -not $asset.browser_download_url) {
    Die "release $tag 无资产 $assetName（release.yml 产物缺失或 release 未完成）"
}
Write-Step "release $tag：$assetName"

# ─── 4. 下载 + sha256 校验 ───
$script:tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("fc-install-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:tmpDir | Out-Null
$tarball = Join-Path $script:tmpDir $assetName
$shaFile = Join-Path $script:tmpDir "$assetName.sha256"

Write-Step "下载 $assetName"
try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tarball -Headers @{ 'User-Agent' = 'fuckopencode-install' } -TimeoutSec 120
} catch {
    Die "下载失败：$($_.Exception.Message)。网络不通或该资产不可用（国内网络可开代理后重试）"
}

if ($shaAsset -and $shaAsset.browser_download_url) {
    Write-Step "下载 sha256（$assetName.sha256）"
    try {
        Invoke-WebRequest -Uri $shaAsset.browser_download_url -OutFile $shaFile -Headers @{ 'User-Agent' = 'fuckopencode-install' } -TimeoutSec 60
    } catch {
        Remove-Item -Path $shaFile -Force -ErrorAction SilentlyContinue
        Write-Warn "无法下载 $assetName.sha256，跳过校验（建议从官方仓库安装以确保完整性）"
    }
}
if (Test-Path $shaFile) {
    $expected = (Get-Content $shaFile -Raw).Trim() -split '\s+' | Select-Object -First 1
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tarball).Hash
    if (-not $expected -or ($actual -ine $expected)) {
        Die "sha256 校验失败（expected=${expected} actual=${actual}）。已中止，未改动安装目录。"
    }
    Write-OK "sha256 校验通过（$($actual.Substring(0, 16))...）"
} else {
    Write-Warn "无 $assetName.sha256，跳过校验"
}

# ─── 5. 解压 + 关键产物校验（dist 缺 keypool.js 则无人读上游 key，全请求 503） ───
Write-Step "解压到临时目录"
$extractDir = Join-Path $script:tmpDir 'extract'
New-Item -ItemType Directory -Path $extractDir | Out-Null
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    Die "未找到 tar.exe（Windows 10 17063+ 内置；或安装 Git for Windows / BusyBox 提供）"
}
tar -xzf $tarball -C $extractDir --strip-components=1
if ($LASTEXITCODE -ne 0) { Die "tar 解压失败（exit=$LASTEXITCODE）" }
if (-not (Test-Path (Join-Path $extractDir 'main.js')) -or -not (Test-Path (Join-Path $extractDir 'keypool.js'))) {
    Die "解压产物缺少 main.js / keypool.js，dist tarball 异常"
}

# ─── 6. 安装到目标目录（dist.prev 轮转，与 install.sh 语义一致） ───
Write-Step "安装到 $installDir"
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $installDir 'data') -Force | Out-Null
$distDir = Join-Path $installDir 'dist'
if (Test-Path $distDir) {
    Write-Warn "已有 $distDir，备份为 dist.prev"
    if (Test-Path (Join-Path $installDir 'dist.prev')) { Remove-Item (Join-Path $installDir 'dist.prev') -Recurse -Force }
    Move-Item -Path $distDir -Destination (Join-Path $installDir 'dist.prev')
}
Copy-Item -Path (Join-Path $extractDir '*') -Destination $distDir -Recurse -Force
Write-OK "已安装 dist（$tag）"

# ─── 7. fuckopencode.env（最小模板，已有则跳过；UTF-8 无 BOM） ───
$envFile = Join-Path $installDir 'fuckopencode.env'
if (-not (Test-Path $envFile)) {
    Write-Step "生成 fuckopencode.env（最小模板，完整清单见 README「配置」章节）"
    $envContent = @'
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
'@
    [System.IO.File]::WriteAllText($envFile, $envContent)
    Write-OK "已生成 $envFile"
} else {
    Write-OK "fuckopencode.env 已存在，跳过生成（保持你的配置不动）"
}

# ─── 8. 加载 env 到当前进程 + 必填项提示 ───
Import-EnvFile $envFile
$missing = @()
if (-not $env:API_KEYS) { $missing += 'API_KEYS' }
if (-not $env:OPENSEA_KEYS -and -not $env:ANTHROPIC_API_KEY) { $missing += 'OPENSEA_KEYS / ANTHROPIC_API_KEY' }
if ($missing.Count -gt 0) {
    Write-Warn ""
    Write-Warn ("必填项未配置：" + ($missing -join ', '))
    Write-Warn "  编辑 $envFile 后重新启动（start-fuckopencode.cmd）"
    Write-Warn "  网关对缺配置 fail-closed（无 API_KEYS 会拒绝所有请求），这是安全行为，非 bug。"
    Write-Warn ""
}

# ─── 9. 启动包装脚本（手动重启 / 开机自启 schtasks 用；负责加载 env 再跑 node） ───
$wrapperPath = Join-Path $installDir 'start-fuckopencode.cmd'
$wrapper = @'
@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0fuckopencode.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~dp0fuckopencode.env") do (
    if not "%%B"=="" set "%%A=%%B"
  )
)
where node >nul 2>nul
if errorlevel 1 goto :nonode
if not exist "%~dp0dist\main.js" goto :nodist
node --max-old-space-size=256 "%~dp0dist\main.js" >> "%~dp0data\fuckopencode.log" 2>&1
exit /b %errorlevel%

:nonode
echo [FAIL] node not found in PATH. Install Node.js ^>= 22.5 from https://nodejs.org
exit /b 1

:nodist
echo [FAIL] missing dist\main.js. Re-run scripts\install.ps1.
exit /b 1
'@
[System.IO.File]::WriteAllText($wrapperPath, $wrapper)
Write-OK "已生成 $wrapperPath"

# ─── 10. 启动（Start-Process 继承当前进程已加载的 env） ───
$port = if ($env:PORT) { $env:PORT } else { '8787' }
$pidFile = Join-Path $installDir 'fuckopencode.pid'
$logOut = Join-Path $installDir 'data\fuckopencode.out.log'
$logErr = Join-Path $installDir 'data\fuckopencode.err.log'
$mainJsAbs = Join-Path $installDir 'dist\main.js'

if ($SkipStart) {
    Write-Warn "已跳过启动（-SkipStart）。手动启动：& `"$wrapperPath`""
} else {
    Write-Step "后台启动网关"
    # 更新语义：先停旧实例（pid 文件指向的进程），避免端口冲突。
    if (Test-Path $pidFile) {
        $oldPid = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
        if ($oldPid -match '^\d+$' -and (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue)) {
            Write-Warn "停止旧实例（PID $oldPid）"
            Stop-Process -Id ([int]$oldPid) -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        }
    }
    # -ArgumentList 单字符串原样传给 CreateProcess，路径含空格需自带引号。
    $argStr = "--max-old-space-size=256 `"$mainJsAbs`""
    $proc = Start-Process -FilePath $nodeCmd.Source -ArgumentList $argStr -WorkingDirectory $installDir -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr -PassThru
    Set-Content -Path $pidFile -Value $proc.Id
    $healthy = $false
    for ($i = 0; $i -lt 15; $i++) {
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 3
            if ($resp.Content -match 'ok') { $healthy = $true; break }
        } catch { Start-Sleep -Seconds 1 }
    }
    if ($healthy) {
        Write-OK "服务已启动（PID $($proc.Id)），健康检查通过（http://127.0.0.1:$port/healthz）"
    } else {
        Write-Warn "健康检查未通过（PID $($proc.Id)）。日志："
        Write-Warn "  $logOut"
        Write-Warn "  $logErr"
        Write-Warn "  node -v（需 >= 22.5）"
    }
}

# ─── 11. 完成提示 ───
# schtasks 对含空格路径会剥一层引号，故 /TR 用 \"...\" 双引号写法（标准 workaround）。
$autoStartCmd = 'schtasks /Create /TN "fuckopencode" /TR "\"{0}\"" /SC ONLOGON /RL LIMITED /F' -f $wrapperPath
$stopLine = if ($SkipStart) { "  4. 未启动（-SkipStart）。手动启动：& `"$wrapperPath`"" } else { "  4. 停止网关：Stop-Process -Id (Get-Content '$pidFile')" }
$next = @"
  1. 编辑配置：$envFile
     必填：API_KEYS（客户端管理 key）、OPENSEA_KEYS 或 ANTHROPIC_API_KEY（上游 key）
     保存后重新启动：& "$wrapperPath"
  2. 管理面板：http://127.0.0.1:$port/__admin
     默认账号 admin / ADMIN_PASS（默认密码 13141516，首次登录请立即改强密码）
  3. 客户端用法（Claude Code，PowerShell）：
     `$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:$port'
     `$env:ANTHROPIC_AUTH_TOKEN = '<API_KEYS 之一>'
     `$env:ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-v4-flash'
     claude
     OpenAI 兼容：curl http://127.0.0.1:$port/v1/chat/completions -H "Authorization: Bearer <API_KEYS 之一>" -d "..."
$stopLine
  5. 开机自启（可选，当前用户登录时启动；无需管理员）：
     $autoStartCmd
     删除：schtasks /Delete /TN fuckopencode /F
  6. secret.key（$installDir\data\secret.key）请备份——丢失后账户/分发 token 永久不可解。
"@
Write-Host ""
Write-OK "安装完成。下一步："
Write-Host $next

# ─── 12. 清理 ───
Remove-Item -Path $script:tmpDir -Recurse -Force -ErrorAction SilentlyContinue
