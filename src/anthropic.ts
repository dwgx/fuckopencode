import type { AppConfig } from './config.js';

/** 上游响应头到达的超时（流式 body 读取不受此限制）。 */
const UPSTREAM_TIMEOUT_MS = 120_000;

/**
 * 转发 Anthropic Messages 请求。返回原生 fetch Response，
 * 由调用方决定非流式读 json 或流式读 body。
 *
 * - `path`：默认 `/v1/messages`，也用于 `/v1/messages/count_tokens`。
 * - 上游无响应超时：防止慢上游挂住连接（客户端断开仍可用调用方 signal 中止）。
 */
export async function postAnthropic(
  cfg: AppConfig,
  body: unknown,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
  path = '/v1/messages',
): Promise<Response> {
  if (!cfg.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  return fetch(`${cfg.anthropicBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropicApiKey,
      'anthropic-version': '2023-06-01',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: combinedSignal,
  });
}
