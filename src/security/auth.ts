import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.js';

export type AuthResult =
  | { ok: true; keyId: string; tokenFp: string | null; rpmLimit: number }
  | { ok: false };

/**
 * 分发 token 校验器的最小接口假设（tokens.ts 的 TokensStore 满足）。
 * duck typing：auth.ts 不 import tokens.ts，避免模块耦合 —— 与 console/legacy
 * 的注入点同一套路。返回指纹供落库聚合（requests.token_fp）；rpmLimit 是
 * verify 同一次点查带回来的（tokens 行同一列的 per-key 限流值，0 = 不限流），
 * 让数据面入口不用为同一指纹再查一次。
 */
export interface TokenVerifier {
  verify(token: string): { ok: true; fingerprint: string; rpmLimit: number } | { ok: false };
}

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
 * - 配置了 API_KEYS：token 必须命中其一（常量时间比较）；未命中再查分发
 *   token（tokensStore 未接线则跳过）。
 * - 未配置 API_KEYS：仍先查分发 token（token 独立生效），否则仅在
 *   allowUnauthenticated 时放行（由 config 保证只在安全绑定下为 true）。
 *
 * tokenFp：分发 token 命中时为完整指纹（sha256 前 24 hex，落库聚合用）；
 * API key / 免鉴权放行时为 null。keyId 保持既有语义：API key 用随机值防
 * 日志读者对低熵 key 做离线核对；分发 token 是高熵随机串，用指纹末 8 位
 * （与掩码一致，日志可对应用量，不可逆推 token）。
 *
 * 注意：**管理面鉴权（isAdminRequest）不传 tokensStore** —— 分发 token 是
 * 给客户端数据面的，管理面只认 API key / 会话 / 本机直连，刻意收紧。
 */
export function verifyAuth(
  cfg: AppConfig,
  headers: Record<string, string | undefined>,
  tokensStore?: TokenVerifier | null,
): AuthResult {
  const token = extractToken(headers);

  if (cfg.apiKeys.length > 0) {
    if (!token) return { ok: false };
    for (const allowed of cfg.apiKeys) {
      if (safeEqualHex(token, allowed)) {
        return { ok: true, keyId: randomUUID().slice(0, 8), tokenFp: null, rpmLimit: 0 };
      }
    }
    if (tokensStore != null) {
      const r = tokensStore.verify(token);
      if (r.ok) return { ok: true, keyId: r.fingerprint.slice(-8), tokenFp: r.fingerprint, rpmLimit: r.rpmLimit };
    }
    return { ok: false };
  }

  if (token != null && tokensStore != null) {
    const r = tokensStore.verify(token);
    if (r.ok) return { ok: true, keyId: r.fingerprint.slice(-8), tokenFp: r.fingerprint, rpmLimit: r.rpmLimit };
  }

  if (cfg.allowUnauthenticated) {
    return { ok: true, keyId: randomUUID().slice(0, 8), tokenFp: null, rpmLimit: 0 };
  }
  return { ok: false };
}
