import type { AppConfig } from './config.js';
import { KeyPool, PoolEmptyError, type UpstreamFailureKind } from './keypool.js';
import { resolveUpstreamBaseUrl } from './deepseek.js';

/** 上游响应头到达的超时（流式 body 读取不受此限制）。 */
const UPSTREAM_TIMEOUT_MS = 120_000;

/**
 * 上游调用句柄：Response + key 释放/失败上报。
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
  markFailure: (kind: UpstreamFailureKind, resetDelayMs?: number) => void;
  /** 上报成功 */
  markSuccess: () => void;
}

/**
 * 用 key 池转发 **OpenAI Chat Completions** 请求到上游。
 *
 * 为什么走 OpenAI 而不是 Anthropic：opencode Zen 的 Anthropic 兼容层是半成品——
 * 工具调用会返回空 `content` 且 `stop_reason: null`（实测），Claude Code 强依赖
 * 工具调用，那条路实际不可用。OpenAI 端点的工具调用、reasoning_content、流式
 * 都正常，所以统一从 OpenAI 出去，再由本网关转回 Anthropic 协议。
 *
 * - 认证用 `Authorization: Bearer`（OpenAI 风格），不是 `x-api-key`。
 * - 端点按模型名选：`-free` 走按量付费，其余走订阅（cost=0）。
 * - 池空（全部 key 禁用）抛 PoolEmptyError，server 层应转 503。
 */
export async function postUpstreamChat(
  cfg: AppConfig,
  pool: KeyPool,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
  path = '/v1/chat/completions',
): Promise<UpstreamCall> {
  if (pool.size === 0) {
    throw new PoolEmptyError();
  }

  const model = typeof body.model === 'string' ? body.model : '';
  const baseUrl = resolveUpstreamBaseUrl(model, cfg.anthropicBaseUrl, cfg.payAsYouGoBaseUrl);

  const key = pool.acquire();
  // release 的契约是幂等（见文件头注释）。`pool.release` 只防负数，防不住重复调用
  // 偷减**别的在飞请求**的计数 —— 错误路径上确实存在连续两次 release 的调用序列
  // （整池无健康 key 时先 release，再落到统一错误出口又 release），会把面板
  // 「几个号在扛并发」的数字压低甚至压到 0，并污染 least-loaded 选路。
  // 用一次性标志兜住，调用方就不必逐条排查控制流。
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    pool.release(key);
  };
  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
    return {
      response,
      key,
      release: releaseOnce,
      markFailure: (kind: UpstreamFailureKind, resetDelayMs?: number) => pool.markFailure(key, kind, resetDelayMs),
      markSuccess: () => pool.markSuccess(key),
    };
  } catch (err) {
    // fetch 阶段失败（网络错误/超时）：并发计数已 acquire，必须释放。
    releaseOnce();
    pool.markFailure(key, 'transient');
    throw err;
  }
}

/** 拉上游模型清单（GET，用订阅端点）。失败返回 null，由调用方兜底。 */
export async function fetchUpstreamModels(
  cfg: AppConfig,
  pool: KeyPool,
  signal?: AbortSignal,
): Promise<string[] | null> {
  if (pool.size === 0) return null;
  let key: string;
  try {
    key = pool.acquire();
  } catch {
    return null;
  }
  try {
    const res = await fetch(`${cfg.anthropicBaseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: signal ?? AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(data.data)) return null;
    return data.data.map((m) => m.id).filter((id): id is string => typeof id === 'string');
  } catch {
    return null;
  } finally {
    pool.release(key);
  }
}
