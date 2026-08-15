# GitHub OTA 自更新设计（OTA.md）

> 对齐参考实现：cursorapi（updater.mjs/guard.mjs）、kirostudio（update.rs +
> rollback-guard.sh + health_marker.rs）、windsurf（fs-atomic.js）。2026-08-14 设计，
> 落地 I-20。
>
> **上线状态（2026-08-16 同步）**：OTA 已上线（nbus systemd drop-in +
> `OTA_ENABLED=1`），v0.3.0 已走 release 管线发布（dist tarball + sha256 资产）。
> rollback 守卫 shell **4 场景实测全对**（boot 计数/版本裁决/无关失败不误回滚/手动
> 部署清计数）；真机端到端验收（真触发一次 OTA + 崩溃回滚模拟）仍待做，见 PLAN.md。

## 0. 关键前提

- 线上 `/root/fuckopencode` 不是 git 仓库，只有 dist/ + data/ + env + dist.prev。
  服务器没有源码/npm/tsc——只有 node。构建只在本地/CI。
- systemd：Restart=always、MemoryMax=320M（实测线上值；曾漂移为 400M）、
  WorkingDirectory=/root/fuckopencode。
- 优雅关停已成型（src/shutdown.ts）：SIGTERM → flush 用量库 → exit(0)。
- 上游公开仓库 dwgx/fuckopencode，已有 release（v0.2.0 / v0.3.0）。

## 1. 更新源与资产

- **资产 = 预构建 dist tarball**（服务器永不 build）：`fuckopencode-v<tag>-dist.tar.gz`
  （tar czf dist/，含 dist/version.txt）+ `<同>.sha256`（单行 64hex + 文件名）。
- `dist/version.txt`：build script 追加 `node scripts/write-version.mjs`（写 package.json 版本）。
- `.github/workflows/release.yml`：push tag `v*` 触发 → npm ci → typecheck+test+build →
  打包 + 算 sha256 → `gh release upload`（release 不存在先 create）。权限 contents: write。

## 2. 版本检查

- 拉 `repos/dwgx/fuckopencode/tags`，`isValidVersionTag`（`v?X.Y.Z`，1-4 段纯数字），
  `compareVersions` 降序取 latest。`hasUpdate = latest > current`；**只升不降**。
- 通道：gh-proxy 镜像链（gh-proxy.org / hk.gh-proxy.org / cdn.gh-proxy.org /
  edgeone.gh-proxy.org）→ 最后直连 api.github.com。全失败 → error 不阻塞面板。
- 后台定时检查（OTA_CHECK_INTERVAL_MS 默认 6h，0=关）：**只检查不自动应用**。
- 版本列表缓存 60s TTL，只缓存成功结果。面板「检查更新」按钮强制绕过缓存。
- `OTA_ENABLED`（默认 0 fail-closed）关着时 perform 403，面板只读状态照常。

## 3. 下载与校验

- 下载 URL：`github.com/dwgx/fuckopencode/releases/download/{tag}/fuckopencode-{tag}-dist.tar.gz`，
  走镜像链 + 直连兜底。**流式写盘 + 增量 sha256**，累计上限 64MB（真实 ~2MB）。
- **sha256 文件只从 github.com 直连取，绝不过镜像**（防镜像同时给后门包+匹配哈希）。
  直连失败宁可中止。expected 必须 `^[0-9a-f]{64}$`，比对不等 → 422 拒绝。
- 解包用系统 `tar`（execFile），解到 `.ota-tmp/`（项目根下同 fs，避免跨卷 EXDEV）：
  1. `tar -tzf` 预读：拒绝 `..`/绝对路径、条目 >5000。
  2. 全树 lstat：拒绝 symlink/特殊文件。
  3. `dist/version.txt` 必须 == tag（反投毒）。
  4. 必需文件：main.js/keypool.js/dsml.js + version.txt。
  5. 解包总量上限 512MB。

## 4. 原子替换 + 自重启

- 阶段目录 `.ota-tmp/`（同 fs），全程持 `.ota-lock`（exclusive-create）；启动时清残留锁。
- 轮转（与 deploy.sh 同语义）：`rm -rf dist.prev; mv dist dist.prev; mv .ota-tmp/out dist`，
  renameSyncWithRetry（EPERM/EBUSY 重试）。替换后立即校验 dist/keypool.js、main.js 存在，
  缺失反向回滚。
- 自重启：**进程内 `setTimeout(() => shutdown(...), 1000)`**（1s 让 HTTP 200 先 flush），
  走现成 shutdown()（flush 用量库 → exit(0)），systemd Restart=always 拉起新版本。
  不用 systemctl restart。换文件前检测 `process.env.INVOCATION_ID`（systemd 标记），
  无 supervisor（裸跑）→ 拒绝重启报错前端。

## 5. 回滚守卫（systemd ExecStartPre，决策放 systemd 层不放进程自己）

服务器新增（与 dist 同级，不进 dist）：
- `fuckopencode.boot_attempts`（守卫 +1；进程**健康确认时清零**，见下 O-P1-1）
- `fuckopencode.health`（进程稳定 30s 后写 version + 时间戳；回滚判定用它做
  **版本裁决**，见下 O-P2-3）
- `dist.failed.<TS>/`（回滚时坏版改名留证）
- `scripts/rollback-guard.sh`（ExecStartPre）：

```
count = read boot_attempts (+1)
if [ -d dist.prev ] && [ count -ge 3 ]; then
  if dist/version.txt == health 记录版本; then
    判定为无关启动失败，不回滚      # O-P2-3
  else
    mv dist dist.failed.$(TS); mv dist.prev dist; rm boot_attempts
  fi
fi
exit 0   # 恒 0 绝不停 ExecStart
```

- systemd unit：`ExecStartPre=/root/fuckopencode/scripts/rollback-guard.sh` +
  `RestartSec=3` + `StartLimitIntervalSec=0`（关 systemd 默认 5次/10s 裸限制，
  让守卫接管 crashloop 裁决）。
- 进程侧 `src/ota-guard.ts`：**稳定运行 30s 后写 health，并在同一时刻清
  boot_attempts**（O-P1-1：不能在 bind 成功就清，否则「能 bind 但运行期崩」的
  坏版计数永远攒不到阈值、守卫无法回滚）。
- **`dist.prev` 健康后不删**（保住 deploy.sh rollback 手动回滚点）；守卫只在
  `dist.prev 存在 && 计数≥3 && dist 版本未被健康确认` 时回滚（O-P2-3：被确认过
  的版本因 env/端口/磁盘等无关原因起不来，不静默降级回 dist.prev）。
  deploy.sh rollback 消费 dist.prev 后守卫无点可滚。
- deploy.sh rollback 子命令建议顺带 `rm -f fuckopencode.boot_attempts`。

## 6. 前端（admin.ts 设置页 About 上方「Update」区）

- 版本行：当前版本（dist/version.txt）+ 远端最新 + 检查按钮 + **新版本红点**（设置 tab 按钮角标）。
- 更新日志：`repos/{repo}/compare/{cur}...{latest}` 取 ≤30 commit（短 sha+标题+日期），弹层展示。
- 确认弹层（复用 confirm-overlay）→ perform → 阶段文案（检查中→下载中→校验中→替换中→即将重启）。
- 回滚状态展示：dist.prev 存在与否、最近 dist.failed.*。
- i18n 成对、new Function 解析防线、无反引号/`${}`。

## 7. 安全

- `/__admin/api/update/*` 过 isAdminRequest；check/perform 再过 adminOriginAllowed（CSRF）；perform 落 admin_audit。
- 下载只走 https 固定域（github.com + 镜像链硬编码），URL 由「白名单 repo（OTA_REPO，
  `^owner/repo$` 无 `.`/`..` 段）+ 合法 tag + 固定资产名」拼装，无用户可控 URL。
- 校验强：sha256 独立信道 + tar 三重校验 + 只升不降 + 无自动应用。
- `OTA_TOKEN` 支持私有仓库，配了只走直连、不交给 gh-proxy，永不进日志/响应。
- 错误分类：400 入参 / 409 冲突（更新中/降级/无 supervisor）/ 422 校验失败 / 502 上游不可达 / 500 内部。

## 8. 实现拆解（步骤 → 验收 → 测试点）

- S1 发布资产管线：release.yml + write-version.mjs。验收：gh release view 有 2 资产、tarball 解出 dist/version.txt==tag。
- S2 版本检查：ota.ts fetchTags/compareVersions/isValidVersionTag/缓存/定时器。测试：test/ota.test.ts（边界/白名单/镜像链 fallback/token 直连/缓存 TTL）。
- S3 下载/校验/解包：流式+增量哈希+tar 校验。测试：mock fetch 注假字节+真 sha、fixture tar（正常/../条目/symlink/version 不符/超条目）、chunked 超限截断。
- S4 原子替换+自重启：swap 轮转+lock+supervisor 检测+延迟 exit。测试：临时项目根真跑 swap、注入 rename 失败回滚、lock 双持 409。
- S5 回滚守卫：rollback-guard.sh + ota-guard.ts + unit 改动。测试：shell 四组合手跑、ota-guard 计数读写单测。
- S6 管理端点+面板 UI。测试：admin.test 风格（注入 fetchImpl 走完整 perform、audit 落库、响应码分类、i18n 成对、new Function）。
- S7 部署与实测（服务器 unit 改动 + 真机 OTA + deploy.sh rollback 仍可用 + 崩溃回滚模拟）。

## 9. 部署 ops（S7，服务器侧一次性操作）

仓库不放 systemd unit 文件；以下改动在 nbus 上一次性完成，**不在代码仓库里**。

1. **装守卫脚本**（与 dist 同级，`ExecStartPre` 用）：

```bash
ssh nbus 'install -m 755 /root/fuckopencode/scripts/rollback-guard.sh /root/fuckopencode/scripts/rollback-guard.sh'
```

   守卫脚本已随仓库提交（scripts/rollback-guard.sh），直接部署即可。若服务器没有
   源码副本，手动创建 `scripts/rollback-guard.sh` 内容同仓库该文件。

2. **改 systemd unit**（`systemctl edit fuckopencode.service`，或直接改
   `/etc/systemd/system/fuckopencode.service`）：

```
[Service]
ExecStartPre=/root/fuckopencode/scripts/rollback-guard.sh
Restart=always
RestartSec=3
StartLimitIntervalSec=0
MemoryMax=320M          # 原有，别删
OOMScoreAdjust=500      # 原有，别删
```

   - `ExecStartPre`：每次启动前把 fuckopencode.boot_attempts +1，计数≥3 且
     dist.prev 存在 → 自动回滚 dist.failed.<TS> 留证（守卫恒 exit 0，绝不挡启动）。
   - `RestartSec=3`：crashloop 节奏，约 10s 攒够 3 次即回滚止损。
   - `StartLimitIntervalSec=0`：关掉 systemd 默认的 5次/10s 裸重启限制，让守卫
     接管 crashloop 裁决（否则 systemd 会先进入 failed 态，守卫根本没机会跑）。

   `systemctl daemon-reload && systemctl restart fuckopencode`。

3. **标记文件**（进程自动维护，无需手动创建）：
   - `fuckopencode.boot_attempts`：守卫 +1；进程**健康确认（稳定运行 30s）时清零**
     （O-P1-1：不能 bind 成功就清，否则运行期崩的坏版攒不到回滚阈值）。
   - `fuckopencode.health`：进程稳定 30s 后写（version + 时间戳）；回滚判定与
     dist/version.txt 比对做版本裁决（O-P2-3，被确认过的版本不因无关原因回滚）。
   - `dist.failed.<TS>/`：守卫回滚时坏版改名留证。
   - `dist.prev`：健康后**刻意不删**（保住 deploy.sh rollback 手动回滚点）。

4. **env 加 OTA 组**（fuckopencode.env，改完 systemctl restart）：

```
OTA_ENABLED=1          # 0 = 只读面板，perform 403（默认 0，fail-closed）
OTA_REPO=dwgx/fuckopencode
OTA_CHECK_INTERVAL_MS=21600000   # 6h，0 = 关闭后台检查（只检查不自动应用）
# OTA_TOKEN=<私有仓库 token>      # 可选；配了只走直连、不交给 gh-proxy
```

5. **deploy.sh rollback 已顺带清 boot 计数**（消费 dist.prev 后守卫无点可滚，
   计数器残留会让下次部署误判 crashloop）。真机验收：触发一次 OTA → 服务自动
   重启到新版本 → `journalctl -u fuckopencode | grep '\[ota\]'` 有替换日志；
   制造崩溃（坏版）验证 dist.failed.* 留证与自动回滚。

6. **审查补的验证步骤**（改 unit 前必须做，否则 ExecStartPre 失败会拒绝启动）：
   - `bash -n scripts/rollback-guard.sh` + 手动跑一次确认恒 exit 0 + `ls -l` 确认 +x。
   - `test -f /root/fuckopencode/dist/version.txt` —— 缺文件时 currentVersion 回落
     '0.0.0' → hasUpdate 恒 true、红点常亮、perform 一直尝试更新。
   - `systemctl cat fuckopencode.service | grep ExecStartPre` 确认 drop-in 生效。
