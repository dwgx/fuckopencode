import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.js';

export type AuthResult = { ok: true; keyId: string } | { ok: false };

/**
 * 提取请求里的 API key。
 * 只取 Bearer 的第一个逗号段，防止 `Bearer a, Bearer b` 走私第二凭据；
 * 无 Authorization 时回落到 x-api-key。
 */
export function extractToken(headers: Record<string, string | undefined>): string | null {
  const auth = headers['authorization'];
  if (auth) {
    if (auth.toLowerCase().startsWith('bearer ')) {
      const token = auth.slice(7).trim();
      const firstSegment = token.split(',')[0]?.trim();
      if (firstSegment) return firstSegment;
    }
  }
  const apiKey = headers['x-api-key'];
  if (apiKey) return apiKey.trim();
  return null;
}

function sha256Hex(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function safeEqualHex(a: string, b: string): boolean {
  const ha = sha256Hex(a);
  const hb = sha256Hex(b);
  return timingSafeEqual(ha, hb);
}

/**
 * 鉴权（fail-closed）：
 * - 配置了 API_KEYS：token 必须命中其一（常量时间比较）。
 * - 未配置 API_KEYS：仅在 allowUnauthenticated 时放行（由 config 保证只在安全绑定下为 true）。
 */
export function verifyAuth(cfg: AppConfig, headers: Record<string, string | undefined>): AuthResult {
  const token = extractToken(headers);

  if (cfg.apiKeys.length > 0) {
    if (!token) return { ok: false };
    for (const allowed of cfg.apiKeys) {
      if (safeEqualHex(token, allowed)) {
        // keyId 用随机值而非 token 指纹，防止日志读者对低熵 key 做离线核对。
        return { ok: true, keyId: randomUUID().slice(0, 8) };
      }
    }
    return { ok: false };
  }

  if (cfg.allowUnauthenticated) {
    return { ok: true, keyId: randomUUID().slice(0, 8) };
  }
  return { ok: false };
}
