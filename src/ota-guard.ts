/**
 * OTA 启动健康守卫（OTA.md §5）。进程侧只负责三件事：
 *
 * 1. 启动时清残留 .ota-lock（OTA.md §4：崩溃留下的锁是陈旧锁，持有者已死）；
 * 2. 稳定运行 30s 后写 fuckopencode.health（版本 + 时间戳）；
 * 3. 与 2 同一时刻清 fuckopencode.boot_attempts（O-P1-1：不能在 bind 成功就清，
 *    否则「能 bind 但运行期崩」的坏版计数永远攒不到 3，守卫无法回滚）。
 *
 * 回滚决策放 systemd 层（scripts/rollback-guard.sh，ExecStartPre），绝不放
 * 可能已崩的进程自己 —— 这里只写标记，不读计数做裁决。与 kirostudio 的
 * health_marker.rs 同构。
 */
import fs from 'node:fs';
import path from 'node:path';

export const BOOT_COUNTER = 'fuckopencode.boot_attempts';
export const HEALTH_MARKER = 'fuckopencode.health';
export const FAILED_PREFIX = 'dist.failed.';

function counterFile(dir: string): string {
  return path.join(dir, BOOT_COUNTER);
}

export function readBootAttempts(dir: string): number {
  try {
    return parseInt(fs.readFileSync(counterFile(dir), 'utf8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/** 写计数器（正常由 rollback-guard.sh 维护；这里供测试/运维用）。 */
export function writeBootAttempts(dir: string, n: number): void {
  try {
    fs.writeFileSync(counterFile(dir), String(n), 'utf8');
  } catch {
    // 标记写失败不阻塞启动
  }
}

/** 健康确认（稳定运行 30s）时调用：清零计数器，向守卫脚本表明「该版本已越过 crashloop 窗口」。 */
export function clearBootAttempts(dir: string): void {
  try {
    fs.rmSync(counterFile(dir), { force: true });
  } catch {
    // 忽略
  }
}

/** 启动时清残留 .ota-lock（崩溃留下的陈旧锁会永久 409 阻断下一次 OTA）。 */
export function clearStaleLock(dir: string): void {
  try {
    fs.rmSync(path.join(dir, '.ota-lock'), { force: true });
  } catch {
    // 忽略
  }
}

/** 稳定运行 30s 后写健康标记。dist.prev 刻意不删（保住 deploy.sh 手动回滚点）。 */
export function confirmHealth(dir: string, version: string): void {
  try {
    fs.writeFileSync(
      path.join(dir, HEALTH_MARKER),
      `version=${version}\nconfirmed_at=${Math.floor(Date.now() / 1000)}\n`,
      'utf8',
    );
  } catch {
    // 健康标记写失败不影响运行
  }
}

export interface OtaGuardStatus {
  healthConfirmed: boolean;
  healthDetail: string | null;
  rollbackPointPresent: boolean;
  rolledBackBinaryPresent: boolean;
}

/** /__admin/api/update/status 的回滚状态快照。 */
export function readStatus(dir: string): OtaGuardStatus {
  let health = null;
  try {
    health = fs.readFileSync(path.join(dir, HEALTH_MARKER), 'utf8');
  } catch {
    // 无 = 未确认
  }
  let evidence = false;
  try {
    evidence = fs.readdirSync(dir).some((f) => f.startsWith(FAILED_PREFIX));
  } catch {
    // 忽略
  }
  return {
    healthConfirmed: Boolean(health),
    healthDetail: health?.trim() || null,
    rollbackPointPresent: fs.existsSync(path.join(dir, 'dist.prev')),
    rolledBackBinaryPresent: evidence,
  };
}
