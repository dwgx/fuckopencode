import type { AppConfig } from './config.js';
import { KeyPool, PoolEmptyError, type UpstreamFailureKind } from './keypool.js';

/** 上游响应头到达的超时（流式 body 读取不受此限制）。 */
const UPSTREAM_TIMEOUT_MS = 120_000;

/**
 * postAnthropic 的返回值：上游 Response + key 释放/失败上报句柄。
 *
 * 调用方在 body 读完/中断后**必须**调用 `release()` 释放并发计数
 * （幂等，放 finally 里）；body 消费阶段失败时调 `markFailure(kind)`。
 */
export interface UpstreamCall {
  /** 原生 fetch Response（含 status/headers/body） */
  response: Response;
  /** 本次请求使用的上游 key */
  key: string;
  /** 释放并发计数（幂等），body 消费完后必须调用 */
  release: () => void;
  /** 上报失败（body 消费阶段传输错误） */
  markFailure: (kind: UpstreamFailureKind) => void;
  /** 上报成功 */
  markSuccess: () => void;
}

/**
 * 用 key 池转发 Anthropic Messages 请求。
 *
 * - 池里 least-loaded 选 key；`fetch` 抛错（网络/超时）时自动 release 并上报 transient 失败。
 * - 池空（全部 key 禁用）抛 PoolEmptyError，server 层应转 503。
 * - 返回 UpstreamCall：调用方在 body 消费完后 `release()`，body 消费阶段失败调 `markFailure(kind)`。
 */
export async function postAnthropic(
  cfg: AppConfig,
  pool: KeyPool,
  body: unknown,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
  path = '/v1/messages',
): Promise<UpstreamCall> {
  if (pool.size === 0) {
    throw new PoolEmptyError();
  }
  const key = pool.acquire();
  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    const response = await fetch(`${cfg.anthropicBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
    return {
      response,
      key,
      release: () => pool.release(key),
      markFailure: (kind: UpstreamFailureKind) => pool.markFailure(key, kind),
      markSuccess: () => pool.markSuccess(key),
    };
  } catch (err) {
    // fetch 阶段失败（网络错误/超时）：并发计数已 acquire，必须释放。
    pool.release(key);
    pool.markFailure(key, 'transient');
    throw err;
  }
}
