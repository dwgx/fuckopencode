/**
 * 多账号管理面的加密密钥（secret.key + AES-256-GCM）。
 *
 * 职责：把账户 key 与 billing cookie 以密文形态落库。明文只在进程内出现
 * （池构造时解密一次、探活/抓取时按需解密），任何响应、日志、面板都不得
 * 出现明文 —— 这是 MULTI-ACCOUNT.md §2 的隐私口径。
 *
 * 降级约定：`loadSecret` 任何失败都返回 null，调用方（AccountsStore）整体
 * 禁用、keypool 退回只用 env keys。**加密设施绝不能成为代理链路的故障源。**
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';

/** AES-256-GCM 的 12 字节随机 IV。 */
const IV_LEN = 12;
/** GCM 认证标签长度（node:crypto 的 aes-256-gcm 固定 16 字节）。 */
const TAG_LEN = 16;

export interface SecretKey {
  /** 加密为 `1:<base64(iv‖tag‖ct)>`。永不抛；失败返回空串（解密必 null，可检测）。 */
  encrypt(plain: string): string;
  /** 任何失败（前缀不符/格式坏/认证失败/密文损坏）返回 null，绝不抛。 */
  decrypt(payload: string): string | null;
}

/**
 * 从配置加载密钥材料，派生统一 32 字节 AES 密钥。
 *
 * 优先级（MULTI-ACCOUNT.md §2.1）：
 * 1. `cfg.gatewaySecret`（GATEWAY_SECRET env）非空 → 直接当材料。
 * 2. 否则读 `cfg.secretFilePath`（SECRET_FILE env，默认 data/secret.key）：
 *    - 文件不存在 → 生成 32 随机字节 base64 写入（0600 + 显式 chmod 兜 umask）。
 *    - 存在但权限比 0600 宽松 → 打一条 warn，不静默改权限（留给运维决定）。
 *    - 读不了（EACCES 等）→ 返回 null。
 *
 * env 值和文件内容都当字符串走同一条 sha256 派生，无需分支格式。
 */
export function loadSecret(
  cfg: AppConfig,
  log: (msg: string) => void = (m) => console.warn(m),
): SecretKey | null {
  try {
    let material: string | null = null;
    if (cfg.gatewaySecret) {
      material = cfg.gatewaySecret;
    } else {
      material = readSecretFile(cfg.secretFilePath, log);
    }
    if (!material) return null;
    // 统一密钥派生：sha256(字符串) → 32 字节。env 值与文件内容同路。
    const key = createHash('sha256').update(material, 'utf8').digest();
    return {
      encrypt(plain: string): string {
        try {
          const iv = randomBytes(IV_LEN);
          const cipher = createCipheriv('aes-256-gcm', key, iv);
          const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
          const tag = cipher.getAuthTag();
          return `1:${Buffer.concat([iv, tag, ct]).toString('base64')}`;
        } catch {
          // 理论不可达（key 固定、IV 随机失败概率为零），但绝不抛 ——
          // 空串不满足 `1:` 前缀，decrypt 必返 null，落盘后能检测出来。
          return '';
        }
      },
      decrypt(payload: string): string | null {
        try {
          // 前缀校验是刻意的卫生习惯：防将来换格式时静默错解旧数据。
          if (!payload.startsWith('1:')) return null;
          const raw = Buffer.from(payload.slice(2), 'base64');
          if (raw.length < IV_LEN + TAG_LEN) return null;
          const iv = raw.subarray(0, IV_LEN);
          const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
          const ct = raw.subarray(IV_LEN + TAG_LEN);
          const decipher = createDecipheriv('aes-256-gcm', key, iv);
          decipher.setAuthTag(tag);
          // final() 在校验 GCM 认证标签，任何篡改/错 key 都会在这里抛 → 返回 null。
          return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
        } catch {
          return null;
        }
      },
    };
  } catch (err) {
    log(`[secrets] 密钥加载失败（账户数据不可用）: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * 读取 secret 文件；不存在则自动生成（0600）。返回密钥材料字符串；失败返回 null。
 */
function readSecretFile(filePath: string, log: (msg: string) => void): string | null {
  const p = path.resolve(filePath);
  try {
    let content: string;
    try {
      const st = fs.statSync(p);
      // 0600 或更严格都接受；group/other 有任何权限位就告警。
      // 创建时已显式 chmod 0600，只有人为放宽过才会触发 —— 静默改回去
      // 会覆盖运维意图，所以只提示（MULTI-ACCOUNT.md §2.1 明确不静默改权限）。
      if ((st.mode & 0o077) !== 0) {
        log(`[secrets] ${p} 权限比 0600 宽松（实际 0${(st.mode & 0o777).toString(8)}），账户密钥有泄露风险`);
      }
      content = fs.readFileSync(p, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 不存在 → 生成并落盘。先 mkdirSync recursive（data/ 可能还没建）。
        const secret = randomBytes(32).toString('base64');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        // mode 0o600 受 umask 约束，写完后必须显式 chmod 兜底 ——
        // 否则 umask 022 时 0600 会被放宽成 0644，group/other 可读密钥。
        fs.writeFileSync(p, secret, { mode: 0o600 });
        fs.chmodSync(p, 0o600);
        return secret;
      }
      // EACCES 等：读不了。不重试、不降级生成（会覆盖已有文件造成混乱）。
      log(`[secrets] 读取 ${p} 失败: ${err instanceof Error ? err.message : err}`);
      return null;
    }
    content = content.trim();
    if (!content) {
      log(`[secrets] ${p} 内容为空，账户加密不可用`);
      return null;
    }
    return content;
  } catch (err) {
    log(`[secrets] 处理 ${p} 失败: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
