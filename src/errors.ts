export interface OpenAIApiError {
  status: number;
  body: { error: { message: string; type: string; code?: string } };
}

/** 去掉可能造成日志伪造/终端注入的控制符。 */
export function stripControl(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '');
}

/** 内部错误的固定响应文案：只进日志，绝不向调用方回显内部异常/配置细节。 */
export const INTERNAL_SERVER_ERROR = { message: 'internal server error', type: 'server_error' };

// Anthropic 错误 type → OpenAI 常见 type。透传语义但收敛到 OpenAI 客户端认识的枚举。
const TYPE_MAP: Record<string, string> = {
  invalid_request_error: 'invalid_request_error',
  authentication_error: 'authentication_error',
  billing_error: 'invalid_request_error',
  permission_error: 'permission_error',
  not_found_error: 'invalid_request_error',
  conflict_error: 'invalid_request_error',
  request_too_large: 'invalid_request_error',
  rate_limit_error: 'rate_limit_error',
  api_error: 'server_error',
  timeout_error: 'server_error',
  overloaded_error: 'server_error',
};

/**
 * Anthropic 错误响应 → OpenAI 错误格式。保留原始 HTTP 状态码
 * （含 529 overloaded，OpenAI SDK 对 5xx 会自动退避重试）。
 */
export function anthropicErrorToOpenAI(status: number, body: unknown): OpenAIApiError {
  let message = 'upstream error';
  let type = 'server_error';
  let code: string | undefined;

  if (body != null && typeof body === 'object') {
    const err = (body as { error?: { type?: string; message?: string } }).error;
    if (err) {
      if (typeof err.message === 'string' && err.message) message = err.message;
      if (typeof err.type === 'string' && err.type) type = TYPE_MAP[err.type] ?? err.type;
      code = err.type;
    }
  }

  return {
    status,
    body: {
      error: {
        message: stripControl(message),
        type,
        ...(code ? { code } : {}),
      },
    },
  };
}

/** 本地安全拦截返回的 4xx 错误。 */
export function rejectionError(message: string, type = 'invalid_request_error'): OpenAIApiError {
  return { status: 400, body: { error: { message: stripControl(message), type } } };
}

/** 从上游错误体提取 error.type（兼容 Anthropic `{error:{type}}` 与 OpenAI `{error:{type}}`）。 */
function extractUpstreamErrorType(body: unknown): string | undefined {
  if (body == null || typeof body !== 'object') return undefined;
  const err = (body as { error?: unknown }).error;
  if (err == null || typeof err !== 'object') return undefined;
  const type = (err as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

/**
 * 上游失败分级，供 key 池决定禁用策略：
 * - auth：凭据无效（401/403 + authentication_error），立即禁用 + 超长冷却。
 * - rate-limit：限流/余额不足（429，或 billing_error/CreditsError/insufficient balance），
 *   只打短冷却、不计阈值——余额不足是账户级临时状态，充值即恢复，不应长期禁用。
 * - transient：其他（5xx/网络错误/超时），累计失败计数。
 */
export function classifyUpstreamFailure(
  status: number,
  body: unknown,
): 'auth' | 'rate-limit' | 'transient' {
  if (status === 429) return 'rate-limit';

  const errorType = extractUpstreamErrorType(body);
  // 余额不足：HTTP 可能是 401/402/400，但错误体明确指向 billing/credits。
  if (
    errorType === 'billing_error' ||
    errorType === 'CreditsError' ||
    errorType === 'insufficient_balance' ||
    (typeof errorType === 'string' && /balance|credit|billing|quota/i.test(errorType))
  ) {
    return 'rate-limit';
  }

  if (status === 401 || status === 403) {
    return errorType === 'authentication_error' ? 'auth' : 'rate-limit';
  }

  return 'transient';
}
