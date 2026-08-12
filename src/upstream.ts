import type { AppConfig } from './config.js';
import { KeyPool, PoolEmptyError, type UpstreamFailureKind } from './keypool.js';
import { resolveUpstreamBaseUrl } from './deepseek.js';

/** 上游响应头到达的超时（流式 body 读取不受此限制）。 */
const UPSTREAM_TIMEOUT_MS = 120_000;
/** 上游响应 body 的空闲超时：流式下超过该时长没有新数据即中止（防上游挂死拖住客户端）。 */
const UPSTREAM_IDLE_TIMEOUT_MS = 90_000;

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
  /**
   * 重置 body 空闲 watchdog（每次读到上游数据时调用）。
   *
   * 非流式一次性读完 body 不用调；流式消费循环每次迭代调一次，
   * 否则 90s 无数据会被判「上游挂死」而中止。
   */
  touch: () => void;
  /** 释放并发计数（幂等），body 消费完后必须调用 */
  release: () => void;
  /** 上报失败（body 消费阶段传输错误） */
  markFailure: (kind: UpstreamFailureKind, resetDelayMs?: number) => void;
  /** 上报成功 */
  markSuccess: () => void;
}

/**
 * 上游调用的可选控制项。
 *
 * `timeouts` 只在测试里注入短值用：生产恒走 UPSTREAM_TIMEOUT_MS /
 * UPSTREAM_IDLE_TIMEOUT_MS 两个模块级常量。
 */
export interface UpstreamCallOptions {
  /** 换 key 重试时排除刚失败的 key（见 KeyPool.acquire 的 excludeKey） */
  excludeKey?: string;
  /** 响应头超时 / body 空闲超时（毫秒），默认 120s / 90s */
  timeouts?: { headerMs?: number; idleMs?: number };
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
  opts: UpstreamCallOptions = {},
): Promise<UpstreamCall> {
  if (pool.size === 0) {
    throw new PoolEmptyError();
  }

  const model = typeof body.model === 'string' ? body.model : '';
  const baseUrl = resolveUpstreamBaseUrl(model, cfg.anthropicBaseUrl, cfg.payAsYouGoBaseUrl);

  const key = pool.acquire(opts.excludeKey);
  // release 的契约是幂等（见文件头注释）。`pool.release` 只防负数，防不住重复调用
  // 偷减**别的在飞请求**的计数 —— 错误路径上确实存在连续两次 release 的调用序列
  // （整池无健康 key 时先 release，再落到统一错误出口又 release），会把面板
  // 「几个号在扛并发」的数字压低甚至压到 0，并污染 least-loaded 选路。
  // 用一次性标志兜住，调用方就不必逐条排查控制流。
  let released = false;

  // 超时是两段式的，不能用一个 AbortSignal.timeout 全程挂着：
  // 1. 响应头阶段：超过 headerMs 没拿到响应头 → abort（长生成不在这段）。
  // 2. body 阶段：不再限制总时长，只盯「空闲」—— idleMs 无新数据才 abort。
  //    fetch resolve 后 AbortSignal.timeout 没法撤（它一旦触发就 abort 整个
  //    fetch 含 body），所以自己造 controller 管理两个定时器。
  const controller = new AbortController();
  const headerMs = opts.timeouts?.headerMs ?? UPSTREAM_TIMEOUT_MS;
  const idleMs = opts.timeouts?.idleMs ?? UPSTREAM_IDLE_TIMEOUT_MS;
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = (): void => {
    if (headerTimer !== undefined) clearTimeout(headerTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    headerTimer = undefined;
    idleTimer = undefined;
  };
  headerTimer = setTimeout(() => controller.abort(), headerMs);
  /** 重置 body 空闲计时：调用方每次读到上游数据时调（即 UpstreamCall.touch）。 */
  const resetIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleMs);
  };
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    // 生命周期终点：清掉两个定时器，防测试/服务进程被残留 timer 挂住。
    clearTimers();
    pool.release(key);
  };
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

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
    // 响应头已到：头超时撤下，换 idle watchdog 接管 body 阶段。
    if (headerTimer !== undefined) clearTimeout(headerTimer);
    headerTimer = undefined;
    resetIdle();
    return {
      response,
      key,
      touch: resetIdle,
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
