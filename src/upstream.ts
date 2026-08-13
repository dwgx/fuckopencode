import type { AppConfig } from './config.js';
import { KeyPool, PoolEmptyError, type UpstreamFailureKind } from './keypool.js';
import { resolveUpstreamBaseUrl } from './deepseek.js';

/** 上游响应头到达的超时（流式 body 读取不受此限制）。 */
const UPSTREAM_TIMEOUT_MS = 120_000;
/** 上游响应 body 的空闲超时：流式下超过该时长没有新数据即中止（防上游挂死拖住客户端）。 */
const UPSTREAM_IDLE_TIMEOUT_MS = 90_000;
/**
 * 非流式请求的总超时（从请求发出起算）：一次性 JSON 响应等待的封顶。
 *
 * 为什么非流式不能只靠 idle 90s：非流式没有「持续吐 chunk」可续命（touch 不会被
 * 调用），idle 实际是「响应头到达后 90s」的固定死线 —— 头到得早（常见）反而比
 * 流式更早掐断合法长生成。改用总超时：比 idle 90s 更宽（头到得早时 body 有最多
 * ~150s），但整体封顶 —— 客户端（Claude Code/curl）大概率在 120s 级已放弃，
 * 网关继续挂着只占内存/连接，超时即 abort + markFailure。流式不适用（长生成合法）。
 */
const UPSTREAM_NONSTREAM_TOTAL_MS = 150_000;

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
 * UPSTREAM_IDLE_TIMEOUT_MS / UPSTREAM_NONSTREAM_TOTAL_MS 三个模块级常量。
 */
export interface UpstreamCallOptions {
  /** 换 key 重试时排除刚失败的 key（见 KeyPool.acquire 的 excludeKey） */
  excludeKey?: string;
  /**
   * 超时（毫秒），默认 headerMs 120s / idleMs 90s / totalMs 0（无总超时）。
   *
   * 非流式请求（body.stream !== true）生产默认走 UPSTREAM_NONSTREAM_TOTAL_MS
   * （150s）封顶整体时长；流式仍靠 idle watchdog。测试注入短值验证行为。
   */
  timeouts?: { headerMs?: number; idleMs?: number; totalMs?: number };
  /**
   * 账号级模型白名单查询（选号过滤用）。未提供 = 只走全局白名单（账号不限制）。
   *
   * 返回 null/空数组 = 该账号不限制（退回全局白名单）；非空 = 精确匹配（大小写
   * 不敏感在配置侧收敛，这里按字符串比较）。isEligible 闭包同时检查账号白名单
   * 与池的被动学习 block（pool.isModelBlocked）。
   */
  allowedModelsOf?: (accountId: number) => string[] | null;
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

  const model = typeof body.model === 'string' && body.model ? body.model : '';
  const baseUrl = resolveUpstreamBaseUrl(model, cfg.anthropicBaseUrl, cfg.payAsYouGoBaseUrl);

  // 账号级选号过滤：健康过滤后逐 key 按 accountId 判断。两个条件都读的是
  // 「账号归属知道后」才可见的信息 —— 账号模型白名单（accounts.allowedModelsOf
  // 缓存）与被动学习 block（pool.isModelBlocked）。空模型（缺省走 fallback，
  // 正常由 server 层在 body.model 里解析完）不做账号级过滤 —— 没有任何
  // 白名单能匹配空串，硬过滤会把所有配了白名单的账号排除掉。
  const eligible = (accountId: number): boolean => {
    if (!model) return true;
    if (pool.isModelBlocked(accountId, model)) return false;
    const allowed = opts.allowedModelsOf?.(accountId);
    if (allowed != null && allowed.length > 0 && !allowed.includes(model)) return false;
    return true;
  };

  const key = pool.acquire(opts.excludeKey, eligible, model);
  // release 的契约是幂等（见文件头注释）。`pool.release` 只防负数，防不住重复调用
  // 偷减**别的在飞请求**的计数 —— 错误路径上确实存在连续两次 release 的调用序列
  // （整池无健康 key 时先 release，再落到统一错误出口又 release），会把面板
  // 「几个号在扛并发」的数字压低甚至压到 0，并污染 least-loaded 选路。
  // 用一次性标志兜住，调用方就不必逐条排查控制流。
  let released = false;

  // 超时是三段式的，不能用一个 AbortSignal.timeout 全程挂着：
  // 1. 响应头阶段：超过 headerMs 没拿到响应头 → abort（长生成不在这段）。
  // 2. body 阶段：流式不再限制总时长，只盯「空闲」—— idleMs 无新数据才 abort；
  //    非流式（一次性 JSON）没有 chunk 可续命，改用一个从请求发出起算的
  //    totalMs 封顶整体（比 idle 90s 更宽但封顶，客户端大概率已放弃）。
  //    fetch resolve 后 AbortSignal.timeout 没法撤（它一旦触发就 abort 整个
  //    fetch 含 body），所以自己造 controller 管理三个定时器。
  const isStream = body.stream === true;
  const controller = new AbortController();
  const headerMs = opts.timeouts?.headerMs ?? UPSTREAM_TIMEOUT_MS;
  const idleMs = opts.timeouts?.idleMs ?? UPSTREAM_IDLE_TIMEOUT_MS;
  // 非流式才设总超时；流式恒 0（长生成合法，只靠 idle watchdog 续命）。
  const totalMs = opts.timeouts?.totalMs ?? (isStream ? 0 : UPSTREAM_NONSTREAM_TOTAL_MS);
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = (): void => {
    if (headerTimer !== undefined) clearTimeout(headerTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    headerTimer = undefined;
    idleTimer = undefined;
    totalTimer = undefined;
  };
  headerTimer = setTimeout(() => controller.abort(), headerMs);
  if (totalMs > 0) {
    totalTimer = setTimeout(() => controller.abort(), totalMs);
  }
  /** 重置 body 空闲计时：调用方每次读到上游数据时调（即 UpstreamCall.touch）。 */
  const resetIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleMs);
  };
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    // 生命周期终点：清掉全部定时器，防测试/服务进程被残留 timer 挂住。
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
    // 响应头已到：头超时撤下。流式换 idle watchdog 接管 body 阶段（touch 续命）；
    // 非流式不设 idle（touch 不会被调用，idle 对一次性 JSON 没有意义），
    // 由 totalTimer 从请求起算封顶整体。
    if (headerTimer !== undefined) clearTimeout(headerTimer);
    headerTimer = undefined;
    if (isStream) {
      resetIdle();
    }
    return {
      response,
      key,
      touch: resetIdle,
      release: releaseOnce,
      markFailure: (kind: UpstreamFailureKind, resetDelayMs?: number) => pool.markFailure(key, kind, resetDelayMs),
      // 成功请求清除 (account, model) 被动学习 block：模型在该账号实际可用，
      // 恢复选号。blockModel 的调用方（server）只在上游明确「不支持」时记录，
      // 所以任何一次成功都足以证明该组合可用。
      markSuccess: () => {
        pool.markSuccess(key);
        pool.clearModelBlock(pool.accountIdOf(key), model);
      },
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
