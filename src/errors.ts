export interface OpenAIApiError {
  status: number;
  body: { error: { message: string; type: string; code?: string } };
}

/** 账户级状态枚举（多账号面板徽标用）。由探针结果写入，见 MULTI-ACCOUNT.md §4.1。 */
export type AccountStatus =
  | 'unknown'
  | 'ok'
  | 'invalid'
  | 'insufficient'
  | 'limit'
  | 'cooldown'
  | 'region'
  | 'error';

// ─── classifyAccountError 的重试常量（MULTI-ACCOUNT.md §4.2 表） ───────────
/** 探针重试下限：15 分钟 = 一个探针 tick 粒度（§4.5 失败重试节奏）。 */
const ACCOUNT_RETRY_FLOOR_MS = 15 * 60_000;
/** 周/月额度解析不出重置时间时的兜底：24 小时。 */
const ACCOUNT_RESET_FALLBACK_24H_MS = 24 * 3_600_000;
/** 日额度（Go）解析不出重置时间时的兜底：1 小时，与 keypool 的 quota 兜底同源。 */
const ACCOUNT_RESET_FALLBACK_1H_MS = 3_600_000;
/** 上游重置时间 + 60s 余量，与 keypool.markFailure 的 quota 分支同口径。 */
const ACCOUNT_RESET_MARGIN_MS = 60_000;
/** 区域限制的冷却：24 小时（区域解禁以天计）。 */
const ACCOUNT_REGION_COOLDOWN_MS = ACCOUNT_RESET_FALLBACK_24H_MS;

/**
 * 上游重置时间的解析上限：30 天。上游可信但单点无防御 —— 恶意/异常错误消息里的
 * 超大数字（实测 "Resets in 999999999999 hours" → 3.6e18 ms）会把 keypool 的
 * disabledUntil 推到 11 万年后、账户 retry_until 溢出超过 MAX_SAFE_INTEGER。
 * 30 天够覆盖所有已知限额窗口（Go 订阅月限额 30 天）+ 余量，超出按上限算。
 */
export const RESET_CLAMP_MS = 30 * 86_400_000;

/** 去掉可能造成日志伪造/终端注入的控制符。 */
export function stripControl(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '');
}

/**
 * 对可能回显凭证的上游错误原文做脱敏，防 key 落日志/数据库/面板。
 *
 * 上游错误体可能把请求头原样回显（实测形态：Authorization 头里的
 * `Bearer sk-xxx` 被包进 error.message 返回），key 一旦落库就会显示在
 * 面板上。覆盖三种形态：OpenAI 风格 sk- 前缀、Bearer 头、auth=Fe26.
 * 签名 token（Dwolla 风格，实测形态 `auth=Fe26.2**<签名>`，`**` 是 token
 * 内嵌分隔符，字符类必须含 `*`，否则签名段会漏出去）。
 */
export function stripSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9_.-]+/g, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(/\bauth=Fe26\.[A-Za-z0-9_*.=-]+/g, 'auth=***');
}

/** 内部错误的固定响应文案：只进日志，绝不向调用方回显内部异常/配置细节。 */
export const INTERNAL_SERVER_ERROR = { message: 'internal server error', type: 'server_error' };

/**
 * 上游响应超时（网关主动掐断 idle watchdog / 非流式总超时）的客户端文案。
 *
 * 为什么单独一条而不是用 INTERNAL_SERVER_ERROR：超时是「网关主动断开」不是
 * 网关内部故障，客户端（Claude Code/curl）看到明确的「上游响应超时」能理解
 * 是上游太慢/挂了，而不是网关出了问题。可读性是有意的（第二十三轮审计口径）。
 */
export const UPSTREAM_TIMEOUT_ERROR = { message: 'upstream response timed out', type: 'server_error' };

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
      // 上下文超限改写（对 Claude Code 兼容）：chat 路径也把 DeepSeek 措辞
      // 改写成 "prompt is too long" 前缀——CC 的自动恢复链只认这个措辞。
      if (/maximum context length|context_length_exceeded|context length is/i.test(message)) {
        message = `prompt is too long: ${message}`;
      }
      if (typeof err.type === 'string' && err.type) type = TYPE_MAP[err.type] ?? err.type;
      code = err.type;
    }
  }

  return {
    status,
    body: {
      error: {
        // 上游错误消息可能回显 Authorization 头（Bearer sk-xxx），回给客户端
        // 前先脱敏（stripControl 只剥控制符，剥不掉 key 明文）。
        message: stripSecrets(stripControl(message)),
        type,
        ...(code ? { code } : {}),
      },
    },
  };
}

/** 从上游错误体提取重置延迟（毫秒）。 */
export function resetDelayFrom(body: unknown): number | null {
  const msg = extractUpstreamErrorMessage(body);
  if (!msg) return null;
  // 实测上游形态："Weekly usage limit reached. Resets in 19hr 22min."
  const m = /Resets? in\s+(\d+)\s*(hr|hour|min|minute)s?/i.exec(msg);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2]!.toLowerCase();
  return unit.startsWith('h')
    ? Math.min(n * 3_600_000, RESET_CLAMP_MS)
    : Math.min(n * 60_000, RESET_CLAMP_MS);
}

/**
 * 从上游错误体直接提取重置延迟（毫秒）。
 *
 * 便于调用方手上只有解析后的错误体时使用；内部复用 [`parseResetDelayMs`]。
 */
export function resetDelayMsFromError(body: unknown): number | null {
  return parseResetDelayMs(extractUpstreamErrorMessage(body));
}

/** 本地安全拦截返回的 4xx 错误。 */
export function rejectionError(message: string, type = 'invalid_request_error'): OpenAIApiError {
  return { status: 400, body: { error: { message: stripControl(message), type } } };
}

/** 从上游错误体提取 message（兼容 `{error:{message}}` 与顶层 `{message}`）。 */
function extractUpstreamErrorMessage(body: unknown): string {
  if (body == null || typeof body !== 'object') return '';
  const err = (body as { error?: unknown }).error;
  if (err != null && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  const top = (body as { message?: unknown }).message;
  return typeof top === 'string' ? top : '';
}

/**
 * 从额度耗尽的错误文案里解析「多久后重置」，返回毫秒。
 *
 * 上游原文形如 `Weekly usage limit reached. Resets in 19hr 22min.`
 * 解析不出来返回 null，由调用方用默认冷却。
 */
export function parseResetDelayMs(message: string): number | null {
  if (!message) return null;
  const m = /resets?\s+in\s+([^.]+)/i.exec(message);
  if (!m) return null;
  const span = m[1]!;
  let ms = 0;
  let hit = false;
  const h = /(\d+)\s*(?:hr|hour)/i.exec(span);
  if (h) { ms += Number(h[1]) * 3_600_000; hit = true; }
  const min = /(\d+)\s*min/i.exec(span);
  if (min) { ms += Number(min[1]) * 60_000; hit = true; }
  const d = /(\d+)\s*day/i.exec(span);
  if (d) { ms += Number(d[1]) * 86_400_000; hit = true; }
  // clamp：超大数字见 RESET_CLAMP_MS 注释，不能照单全收。
  return hit ? Math.min(ms, RESET_CLAMP_MS) : null;
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
): 'auth' | 'rate-limit' | 'quota-exhausted' | 'transient' {
  const errorType = extractUpstreamErrorType(body);
  const errorMessage = extractUpstreamErrorMessage(body);

  // 额度耗尽 ≠ 并发限流。前者按小时/天计（周额度、月配额），短冷却只会让请求
  // 反复去撞同一个已耗尽的 key；后者几秒就恢复。必须分开，否则要么白等、
  // 要么白撞。实测上游形态：429 + {"type":"GoUsageLimitError",
  // "message":"Weekly usage limit reached. Resets in 19hr 22min."}
  const quotaSignals =
    errorType === 'GoUsageLimitError' ||
    errorType === 'MonthlyLimitError' ||
    errorType === 'UserLimitError' ||
    errorType === 'BlackUsageLimitError' ||
    /usage[_ ]?limit|quota[_ ]?exceeded|quota[_ ]?reached|out[_ ]of[_ ]credits/i.test(errorType ?? '') ||
    /usage limit reached|quota exceeded|insufficient (?:balance|credit)/i.test(errorMessage);
  if (quotaSignals) return 'quota-exhausted';

  if (status === 429) return 'rate-limit';
  // 余额不足：HTTP 可能是 401/402/400，但错误体明确指向 billing/credits。
  // 注意这里只匹配 errorType 的**精确枚举**，不做子串模糊匹配 —— 2026-08-09
  // 排查过「含 quota 字样的非额度错误被判成额度耗尽」的假设，代码里从未有这条
  // 路径；宽正则只会把含 quota 的 type 误归 rate-limit（短冷却，无长冷却风险）。
  if (
    errorType === 'billing_error' ||
    errorType === 'CreditsError' ||
    errorType === 'insufficient_balance'
  ) {
    return 'rate-limit';
  }

  if (status === 401 || status === 403) {
    // AuthError 与 authentication_error 同义（订阅端点实测形态），两种都要
    // 判 auth，否则 AuthError 会落进 rate-limit 短冷却（3s），死 key 每个
    // 请求先 401 一次再换号。与 classifyAccountError 的 auth 分支同口径。
    return errorType === 'authentication_error' || errorType === 'AuthError' ? 'auth' : 'rate-limit';
  }

  return 'transient';
}

/**
 * 判定上游错误是否为「该账号不支持该模型」（端点/订阅不含此模型）。
 *
 * 研究结论：订阅端点 /zen/go 只有 25 个可用模型，其余（按量独有）在订阅端点
 * 全 401 ModelError/"not supported"。这类错误是**模型不可用，不是 key 不可用**
 * —— 不该调 pool.markFailure（会把好 key 误禁），而应被动学习记成
 * (account, model) blocked，选号时排除该组合。
 *
 * 判定刻意收敛到「ModelError 类型」与「not supported 措辞」两类，避免把普通
 * authentication_error / 5xx 误判成模型问题。
 */
export function isModelUnsupported(status: number, body: unknown): boolean {
  if (status !== 401 && status !== 400 && status !== 404) return false;
  const errorType = extractUpstreamErrorType(body);
  const errorMessage = extractUpstreamErrorMessage(body);
  if (errorType === 'ModelError') return true;
  return /not supported/i.test(errorMessage) || /model[\s_-]*not[\s_-]*supported/i.test(errorType ?? '');
}

/**
 * 账户级错误分流（探针结论），返回账户状态 + 距下次探针的时间。
 *
 * 与 [`classifyUpstreamFailure`] 共用同一个错误体解析，两张分类表必须一致
 * （MULTI-ACCOUNT.md §4.2，测试钉住）：同一 error.type 不能一边判长冷却、
 * 一边判短冷却。唯一的刻意偏差是 RegionError —— pool 只有 4 种 kind，
 * 区域错误由账户徽标承担展示（§8 取舍）。
 *
 * @param cooldownMs key 池基础冷却（keyCooldownMs），凭据无效用其 12 倍。
 */
export function classifyAccountError(
  status: number,
  body: unknown,
  cooldownMs: number,
): { status: AccountStatus; retryMs: number } {
  const errorType = extractUpstreamErrorType(body);
  const resetMs = parseResetDelayMs(extractUpstreamErrorMessage(body));
  const resetOr = (fallback: number) => (resetMs != null && resetMs > 0 ? resetMs : fallback);

  // 凭据无效：与 pool 的 auth 分支同口径（12 × cooldownMs，之后自动恢复）。
  if (
    (status === 401 || status === 403) &&
    (errorType === 'AuthError' || errorType === 'authentication_error')
  ) {
    return { status: 'invalid', retryMs: cooldownMs * 12 };
  }

  // 余额不足：充值即恢复，15 分钟重探。
  if (
    errorType === 'CreditsError' ||
    errorType === 'billing_error' ||
    errorType === 'insufficient_balance'
  ) {
    return { status: 'insufficient', retryMs: ACCOUNT_RETRY_FLOOR_MS };
  }

  // 周/月配额：按上游重置时间，解析不出 24 小时兜底。
  if (errorType === 'MonthlyLimitError' || errorType === 'UserLimitError') {
    return { status: 'limit', retryMs: resetOr(ACCOUNT_RESET_FALLBACK_24H_MS) };
  }

  // 日额度：重置 + 60s 余量；Go 兜底 1 小时、Black 兜底 24 小时。
  if (errorType === 'GoUsageLimitError') {
    return {
      status: 'cooldown',
      retryMs: resetOr(ACCOUNT_RESET_FALLBACK_1H_MS) + ACCOUNT_RESET_MARGIN_MS,
    };
  }
  if (errorType === 'BlackUsageLimitError') {
    return {
      status: 'cooldown',
      retryMs: resetOr(ACCOUNT_RESET_FALLBACK_24H_MS) + ACCOUNT_RESET_MARGIN_MS,
    };
  }

  // free 模型 IP 日窗限流（实测形态：429 + FreeUsageLimitError，200 请求/天
  // 按 IP 计、UTC 零点重置）：换 key 没用（IP 维度）——冷却到 UTC 零点，
  // 避免「1h 冷却 → 重试还 429 → 又 1h」的循环（VPS IP 被限时全池 503）。
  // 时长 = 到 UTC 零点的毫秒数（最少 1h，最多 24h）。
  if (errorType === 'FreeUsageLimitError') {
    const now = Date.now();
    const utcMidnight = Math.ceil(now / 86_400_000) * 86_400_000;
    return { status: 'cooldown', retryMs: Math.max(3600_000, utcMidnight - now) + ACCOUNT_RESET_MARGIN_MS };
  }

  // 区域限制：24 小时。必须在「裸 429」判定之前 —— RegionError 常以 429/403 形态出现，
  // 按 error.type 精确分流（§4.2 表），不能落进裸 429 的短重试。
  if (errorType === 'RegionError') {
    return { status: 'region', retryMs: ACCOUNT_REGION_COOLDOWN_MS };
  }

  // 限流：15 分钟重探（探针节流下限，见 §4.5）。
  if (status === 429 || errorType === 'RateLimitError') {
    return { status: 'cooldown', retryMs: ACCOUNT_RETRY_FLOOR_MS };
  }

  // 其他 / 网络层失败：15 分钟重探。
  return { status: 'error', retryMs: ACCOUNT_RETRY_FLOOR_MS };
}
