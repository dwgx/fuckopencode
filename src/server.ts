import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AppConfig } from './config.js';
import { fetchUpstreamModels, postUpstreamChat, type UpstreamCall } from './upstream.js';
import { KeyPool, PoolEmptyError, keyFingerprint, type KeyStateEvent } from './keypool.js';
import {
  anthropicErrorToOpenAI,
  classifyUpstreamFailure,
  resetDelayMsFromError,
  INTERNAL_SERVER_ERROR,
  rejectionError,
  stripControl,
} from './errors.js';
import { verifyAuth } from './security/auth.js';
import { buildSystemGuard, detectInjection, extractAllText, scanMessagesForInjection } from './security/injection.js';
import { isJsonContentType, validateAnthropicRequest, validateChatRequest } from './security/validate.js';
import { extractDevice, recordEvent, snapshot, type RequestEvent } from './metrics.js';
import { UsageDb } from './usagedb.js';
import { DASHBOARD_HTML } from './dashboard.js';
import { anthropicToOpenAIRequest } from './toOpenAI.js';
import { anthropicEventToSSE, openAIStreamToAnthropic, openAIToAnthropicResponse } from './toAnthropic.js';
import { sseStringify } from './stream.js';
import { parseOpenAISSE } from './sse.js';
import {
  ALLOWED_MODELS,
  MODEL_ALIASES,
  filterThinkingFromStream,
  normalizeAnthropicRequest,
  resolveModelName,
} from './deepseek.js';
import type { OpenAIChatRequest, OpenAIChatResponse } from './types.js';

/** 直通模式总是转发的头（Claude Code 依赖的 beta 标记）。 */
const FORWARD_HEADERS = ['anthropic-beta'];
/** 会话标记头：默认不透传（共享部署可被客户端冒充会话），TRUST_CLAUDE_CODE_HEADERS=1 才转发。 */
const CLAUDE_CODE_HEADERS = ['x-claude-code-session-id', 'x-claude-code-agent-id', 'x-claude-code-parent-agent-id'];

/** 转发 header 值上限：防恶意客户端塞超大 header 借上游。 */
const MAX_FORWARD_HEADER_CHARS = 500;

function collectForwardHeaders(
  headers: IncomingMessage['headers'],
  cfg: AppConfig,
): Record<string, string> {
  const out: Record<string, string> = {};
  const names = cfg.trustClaudeCodeHeaders
    ? [...FORWARD_HEADERS, ...CLAUDE_CODE_HEADERS]
    : FORWARD_HEADERS;
  for (const name of names) {
    const value = headers[name];
    if (typeof value === 'string' && value) {
      const cleaned = stripControl(value).slice(0, MAX_FORWARD_HEADER_CHARS);
      if (cleaned) out[name] = cleaned;
    }
  }
  return out;
}

/**
 * 带背压的响应写入：`res.write()` 返回 false 表示内核缓冲已满，
 * 等待 'drain' 再继续，避免慢客户端把内存推到无界。
 * 客户端断开（'close'/'error'）时也解除等待，让调用循环检查 res.destroyed 退出。
 */
function writeChunk(res: ServerResponse, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (res.write(data)) {
      resolve();
      return;
    }
    res.once('drain', resolve);
    res.once('close', resolve);
    res.once('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

// 日志/转发清洗复用 errors.ts 的 stripControl（剥控制符防日志伪造）。

const BODY_READ_TIMEOUT_MS = 30_000;

function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: { ok: true; text: string } | { ok: false; status: number }): void => {
      if (done) return;
      done = true;
      resolve(result);
    };
    // 慢客户端/半开连接：30s 读不完直接 408 断连。
    req.setTimeout(BODY_READ_TIMEOUT_MS, () => {
      finish({ ok: false, status: 408 });
      req.destroy();
    });
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // maxBytes=0 表示不限制（对齐 kirostudio：大请求体常见，限制反而误伤）。
      if (maxBytes > 0 && size > maxBytes) {
        finish({ ok: false, status: 413 });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      req.setTimeout(0); // 读完就撤掉闲置超时，别误杀 keep-alive 连接。
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => {
      req.setTimeout(0);
      finish({ ok: false, status: 400 });
    });
  });
}

const BODY_READ_STATUS_MESSAGE: Record<number, string> = {
  408: 'request body read timed out',
  413: 'request body too large',
};

function parseJson(text: string): { ok: true; body: unknown } | { ok: false; empty: boolean } {
  // 区分「请求体为空」与「JSON 写错」：空 body 通常意味着上游代理/透传层把
  // 请求体丢了（实测 kirostudio 透传曾发出 0 字节 body），而不是客户端写错 JSON。
  // 报错文案不同才能一眼定位是哪一层的问题。
  if (text.length === 0) return { ok: false, empty: true };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, empty: false };
  }
}

/** 空 body / 畸形 JSON 的统一错误响应。 */
function badBodyError(empty: boolean): { error: { message: string; type: string } } {
  return {
    error: {
      message: empty
        ? 'request body is empty — a proxy or relay in front of this gateway likely dropped it'
        : 'invalid JSON body',
      type: 'invalid_request_error',
    },
  };
}

/**
 * 上游已知模型清单。启动时异步拉一次，用于判断客户端请求的模型名能否直传
 * （上游支持 61 个模型，不该被 fallback 一律吃掉）。拉取失败保持为空集，
 * 此时退化成老行为：只认 MODEL_MAP，其余回落 fallback。
 */
let upstreamModels: ReadonlySet<string> = new Set();

/**
 * 是否为「直连本机」的请求：socket 源地址是回环，且没有任何反代/CDN 转发头。
 *
 * cloudflared 反代进来的请求 socket 也是 127.0.0.1，光看源地址会误判成本机，
 * 从而把含 IP/UA 的面板暴露到公网。所以额外要求不带 cf-* / x-forwarded-*
 * 这类头 —— 走 SSH 隧道时不会有这些头，走隧道/CDN 时一定有。
 */
function isDirectLocalRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!loopback) return false;
  const h = req.headers;
  return (
    h['cf-connecting-ip'] == null &&
    h['cf-ray'] == null &&
    h['x-forwarded-for'] == null &&
    h['x-real-ip'] == null
  );
}

/** 单次请求的指标上下文，由各 handler 逐步填充。 */
type MetricsCtx = Pick<
  RequestEvent,
  | 'protocol' | 'model' | 'upstreamModel' | 'endpoint' | 'stream'
  | 'inputTokens' | 'outputTokens' | 'thinkingTokens' | 'requestBytes'
  | 'keyFingerprint' | 'error'
>;

/**
 * key 池状态变更日志。禁用/恢复都记一行，带指纹、原因、冷却时长与池健康度。
 *
 * 为什么必须有：2026-08-09 线上出过 295 个 503（`/v1/messages` 整池被禁约 3 分钟），
 * 但当时日志里只有 access 行，禁用原因完全没有记录 —— 事后无法区分是 transient
 * 累积、auth 还是额度耗尽。池健康度打在同一行，能直接看出何时跌到 0。
 */
export function logKeyStateChange(ev: KeyStateEvent): void {
  const health = `pool=${ev.healthyCount}/${ev.poolSize}`;
  if (ev.type === 'recovered') {
    console.warn(`[keypool] recovered key=${ev.fingerprint} ${health}`);
    return;
  }
  const cooldown = ev.cooldownMs != null ? `${Math.round(ev.cooldownMs / 1000)}s` : '?';
  console.warn(`[keypool] disabled key=${ev.fingerprint} reason=${ev.kind ?? '?'} cooldown=${cooldown} ${health}`);
}

/**
 * 把状态变更同时写进日志和用量库。
 *
 * 为什么要包一层：日志只在 `journalctl` 里，重启后面板拿不到任何历史 ——
 * 「这个 key 昨天被禁过几次」这类问题此前只能翻日志。落库之后面板能直接列
 * 最近的禁用/恢复。db 不可用时 `recordKeyEvent` 是空操作，日志照旧。
 */
export function keyStateHandler(db: UsageDb): (ev: KeyStateEvent) => void {
  return (ev) => {
    logKeyStateChange(ev);
    db.recordKeyEvent({
      at: Date.now(),
      keyFingerprint: ev.fingerprint,
      type: ev.type,
      kind: ev.kind,
      cooldownMs: ev.cooldownMs,
      healthyCount: ev.healthyCount,
      poolSize: ev.poolSize,
    });
  };
}

/** 池空日志的节流窗口：整池被禁时请求会连续撞上来，不必每条都记。 */
const POOL_EMPTY_LOG_INTERVAL_MS = 10_000;
let lastPoolEmptyLogAt = 0;
let suppressedPoolEmptyCount = 0;

/**
 * 记录一次「整池被禁」。这是此前唯一完全静默的 503 路径 —— 2026-08-09 那 295 个
 * 503 就是从这里出去的，日志里却只有 access 行。
 *
 * 节流到 10s 一行，被压掉的次数累加在下一行里，避免刷屏又不丢量级信息。
 */
function logPoolEmpty(pool: KeyPool): void {
  suppressedPoolEmptyCount += 1;
  const now = Date.now();
  if (now - lastPoolEmptyLogAt < POOL_EMPTY_LOG_INTERVAL_MS) return;
  lastPoolEmptyLogAt = now;
  const disabled = pool.disabledFingerprints().join(',') || 'none';
  console.error(
    `[keypool] pool empty — all ${pool.size} keys disabled (requests rejected: ${suppressedPoolEmptyCount}, disabled: ${disabled})`,
  );
  suppressedPoolEmptyCount = 0;
}

export function createApp(cfg: AppConfig, pool?: KeyPool, usageDb?: UsageDb) {
  // 用量库：未显式传时按配置建。构造永不抛，不可用就退化成 no-op（面板无累计列）。
  const db = usageDb ?? new UsageDb(cfg.usageDbPath, cfg.usageDbRetentionDays);
  // 未显式传 pool 时，用 cfg.upstreamKeys 建默认池（兼容测试直连场景）。
  const keyPool =
    pool ??
    new KeyPool(cfg.upstreamKeys, {
      cooldownMs: cfg.keyCooldownMs,
      failThreshold: cfg.keyFailThreshold,
      onStateChange: keyStateHandler(db),
    });

  // 后台拉一次上游模型清单，失败不影响服务启动。
  void fetchUpstreamModels(cfg, keyPool).then((models) => {
    if (models?.length) {
      upstreamModels = new Set(models);
      console.log(`[proxy] upstream models: ${models.length}`);
    }
  });

  return createServer(async (req, res) => {
    const startTime = Date.now();
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';
    // handler 边跑边往这里填，finally 统一记一条指标事件。
    const ctx: MetricsCtx = {
      protocol: path === '/v1/messages' || path.startsWith('/v1/messages/') ? 'anthropic'
        : path === '/v1/chat/completions' ? 'openai' : 'other',
      model: '',
      upstreamModel: '',
      endpoint: '-',
      stream: false,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      requestBytes: 0,
      keyFingerprint: '',
      error: null,
    };

    try {
      // 健康检查不需要鉴权。
      if (req.method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // 监控面板：公开访问，无需鉴权（用户明确要求 HTML 公开）。
      //
      // 注意这意味着**任何人都能看到全部调用方的 IP、完整 UA、转发链**。
      // 这是刻意的选择，不是漏配。想收回去就把 DASHBOARD_PUBLIC 设成 0，
      // 那时会退回「本机直连免 key、其余要 key」的行为。
      if (req.method === 'GET' && (path === '/__dash' || path === '/__metrics')) {
        if (!cfg.dashboardPublic && !(cfg.dashboardOpen && isDirectLocalRequest(req))) {
          const auth = verifyAuth(cfg, req.headers as Record<string, string | undefined>);
          if (!auth.ok) {
            // 浏览器地址栏没法带 header，所以给一句能照做的提示，而不是干巴巴的 401。
            sendJson(res, 401, {
              error: {
                message:
                  'dashboard requires an API key. open it over an ssh tunnel for key-free local access: ' +
                  'ssh -N -L 8899:127.0.0.1:' + cfg.port + ' <host>  then visit http://127.0.0.1:8899' + path,
                type: 'authentication_error',
              },
            });
            return;
          }
        }
        if (path === '/__metrics') {
          const snap = snapshot();
          sendJson(res, 200, {
            ...snap,
            pool: {
              size: keyPool.size,
              healthy: keyPool.healthyCount,
              disabled: keyPool.disabledFingerprints(),
              // 逐 key 明细：在飞请求数（= 几个号在扛并发）、禁用原因、剩余冷却。
              keys: keyPool.snapshot(),
              // 跨重启累计。db 不可用时为 null，面板据此隐藏累计列。
              history: db.history(),
              historyDisabledReason: db.enabled ? null : db.disabledReason,
            },
            config: {
              subscriptionBaseUrl: cfg.anthropicBaseUrl,
              paygBaseUrl: cfg.payAsYouGoBaseUrl,
              fallbackModel: cfg.fallbackModel,
              injectionMode: cfg.injectionMode,
              upstreamModels: [...Object.keys(MODEL_ALIASES), ...ALLOWED_MODELS],
              aliases: MODEL_ALIASES,
            },
          });
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(DASHBOARD_HTML);
        return;
      }

      // CORS preflight：不授信任何跨域来源（不设 access-control-allow-origin），
      // 浏览器里非简单请求会因缺 ACAO 被拒；配合下方 Origin 校验兜住简单请求。
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization, x-api-key, anthropic-version',
        });
        res.end();
        return;
      }

      // CSRF：未鉴权放行模式下，浏览器跨站请求必带非空 Origin，直接拒绝。
      // 带 API key 时攻击者页面拿不到 key，天然免疫。
      if (cfg.allowUnauthenticated) {
        const origin = req.headers.origin;
        if (typeof origin === 'string' && origin.length > 0) {
          sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
          return;
        }
      }

      // 鉴权（fail-closed）。
      const auth = verifyAuth(cfg, req.headers as Record<string, string | undefined>);
      if (!auth.ok) {
        sendJson(res, 401, { error: { message: 'unauthorized', type: 'authentication_error' } });
        return;
      }

      if (req.method === 'POST' && path === '/v1/chat/completions') {
        if (!isJsonContentType(req.headers['content-type'])) {
          sendJson(res, 415, { error: { message: 'content-type must be application/json', type: 'invalid_request_error' } });
          return;
        }
        await handleChatCompletion(req, res, cfg, keyPool, auth.keyId, ctx);
        return;
      }

      if (req.method === 'POST' && path === '/v1/messages') {
        if (!isJsonContentType(req.headers['content-type'])) {
          sendJson(res, 415, { error: { message: 'content-type must be application/json', type: 'invalid_request_error' } });
          return;
        }
        await handleMessagesPassThrough(req, res, cfg, keyPool, auth.keyId, ctx);
        return;
      }

      // Claude Code 记账端点：本地估算（上游无此端点）。
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        if (!isJsonContentType(req.headers['content-type'])) {
          sendJson(res, 415, { error: { message: 'content-type must be application/json', type: 'invalid_request_error' } });
          return;
        }
        handleCountTokens(req, res, cfg, ctx);
        return;
      }

      // 模型发现（OpenAI 兼容）：只暴露白名单里的模型，与实际放行范围一致。
      if (req.method === 'GET' && path === '/v1/models') {
        // 别名排前面（更像 Anthropic 命名），真名跟后，两种都可用。
        const ids = new Set([...Object.keys(MODEL_ALIASES), ...ALLOWED_MODELS]);
        sendJson(res, 200, {
          object: 'list',
          data: [...ids].map((id) => ({ id, object: 'model', owned_by: 'proxy' })),
        });
        return;
      }

      sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
    } catch (err) {
      // 内部异常只进日志，回给调用方的统一固定文案（防配置/堆栈细节泄露）。
      const message = err instanceof Error ? err.message : 'internal error';
      console.error(`[proxy] ${stripControl(message)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: INTERNAL_SERVER_ERROR });
      } else {
        res.end();
      }
    } finally {
      const elapsed = Date.now() - startTime;
      console.log(`[proxy] ${req.method ?? '?'} ${path} ${res.statusCode} ${elapsed}ms`);
      // /healthz 与面板自身的轮询不记账，否则面板会把自己刷满。
      if (path !== '/healthz' && !path.startsWith('/__')) {
        recordEvent({
          at: startTime,
          method: req.method ?? '?',
          path,
          protocol: ctx.protocol,
          status: res.statusCode,
          durationMs: elapsed,
          model: ctx.model,
          upstreamModel: ctx.upstreamModel,
          endpoint: ctx.endpoint,
          stream: ctx.stream,
          inputTokens: ctx.inputTokens,
          outputTokens: ctx.outputTokens,
          thinkingTokens: ctx.thinkingTokens,
          requestBytes: ctx.requestBytes,
          device: extractDevice(req),
          keyFingerprint: ctx.keyFingerprint,
          error: ctx.error,
        });
        // 同一份数据落库。内存指标环形缓冲重启即清零，落库的才能回答
        // 「这个 key 这个月一共扛了多少」。不记 IP/UA —— 那是内存面板的事，
        // 长期留存反而是隐私负担。
        db.recordRequest({
          at: startTime,
          keyFingerprint: ctx.keyFingerprint,
          model: ctx.model,
          upstreamModel: ctx.upstreamModel,
          endpoint: ctx.endpoint,
          status: res.statusCode,
          durationMs: elapsed,
          stream: ctx.stream,
          inputTokens: ctx.inputTokens,
          outputTokens: ctx.outputTokens,
          thinkingTokens: ctx.thinkingTokens,
          error: ctx.error,
        });
      }
    }
  });
}

async function handleChatCompletion(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AppConfig,
  pool: KeyPool,
  keyId: string,
  ctx: MetricsCtx,
): Promise<void> {
  const read = await readBody(req, cfg.maxBodyBytes);
  if (!read.ok) {
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    sendJson(res, 400, badBodyError(parsed.empty));
    return;
  }

  const body = parsed.body as Record<string, unknown>;

  // L2：schema 校验。
  const v = validateChatRequest(body, cfg);
  if (!v.ok) {
    sendJson(res, 400, rejectionError(v.error).body);
    return;
  }

  const messages = body.messages as Array<{ role: string; content: unknown }>;

  // L3：注入检测（user/tool 顶层文本）。
  const hits = scanMessagesForInjection(messages);
  if (hits.length > 0) {
    for (const h of hits) {
      console.warn(`[inject] key=${keyId} msg#${h.index} level=${h.level} signals=${h.signals.join(',')}`);
    }
    if (cfg.injectionMode === 'block') {
      const high = hits.some((h) => h.level === 'high');
      if (high) {
        sendJson(res, 400, rejectionError('message content violates content policy').body);
        return;
      }
    }
  }

  // 上游本身就是 OpenAI 协议，这条路径不再绕 Anthropic：只做模型名解析、
  // 剥不支持的字段、加 system 护栏，然后原样转发。
  const upstreamReq = prepareOpenAIUpstreamRequest(body as unknown as OpenAIChatRequest, cfg);
  ctx.requestBytes = Buffer.byteLength(read.text);
  ctx.model = typeof body.model === 'string' ? body.model : '';
  ctx.upstreamModel = typeof upstreamReq.model === 'string' ? upstreamReq.model : '';
  ctx.endpoint = ctx.upstreamModel.endsWith('-free') ? 'payg' : 'subscription';
  ctx.stream = upstreamReq.stream === true;

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  // 用 key 池转发。非流式在「未写出任何响应字节」时可换 key 重试一次。
  let upstream: UpstreamCall;
  try {
    upstream = await postUpstreamChat(cfg, pool, upstreamReq, controller.signal);
    ctx.keyFingerprint = keyFingerprint(upstream.key);
  } catch (err) {
    if (err instanceof PoolEmptyError) {
      logPoolEmpty(pool);
      sendJson(res, 503, { error: { message: 'all upstream keys are disabled', type: 'server_error' } });
      return;
    }
    // 池内所有 key 瞬时失败（fetch 网络错误），postAnthropic 已自动 release + 上报。
    sendJson(res, 502, { error: { message: 'upstream unavailable', type: 'server_error' } });
    return;
  }

  // 非流式：上游返回错误状态时，若尚未写响应字节，可换 key 重试一次。
  if (!upstream.response.ok && !res.headersSent) {
    // 读取错误体用于分级（余额不足 → rate-limit，而非 auth 长期禁用）。
    let errBody: unknown = null;
    try {
      errBody = await upstream.response.json();
    } catch {
      // body 不是 JSON（如空/HTML）：忽略，按状态码分级。
    }
    const kind = classifyUpstreamFailure(upstream.response.status, errBody);
    upstream.markFailure(kind, resetDelayMsFromError(errBody) ?? undefined);
    if (pool.healthyCount > 0 && !res.headersSent) {
      upstream.release();
      // 换 key 重试（最多一次）。
      try {
        upstream = await postUpstreamChat(cfg, pool, upstreamReq, controller.signal);
        ctx.keyFingerprint = keyFingerprint(upstream.key);
      } catch (err) {
        if (err instanceof PoolEmptyError) {
          logPoolEmpty(pool);
          sendJson(res, 503, { error: { message: 'all upstream keys are disabled', type: 'server_error' } });
          return;
        }
        sendJson(res, 502, { error: { message: 'upstream unavailable', type: 'server_error' } });
        return;
      }
    } else {
      upstream.release();
    }
  }

  if (!upstream.response.ok) {
    let errBody: unknown = null;
    try {
      errBody = await upstream.response.json();
    } catch {
      // ignore
    }
    const err = anthropicErrorToOpenAI(upstream.response.status, errBody);
    const retryAfter = upstream.response.headers.get('retry-after');
    if (retryAfter) res.setHeader('retry-after', retryAfter);
    upstream.release();
    sendJson(res, err.status, err.body);
    return;
  }

  const requestedModel = typeof body.model === 'string' ? body.model : undefined;
  const isStream = upstreamReq.stream === true;

  if (isStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    try {
      // 上游已是 OpenAI 流，逐 chunk 回显（只改写 model 名回显客户端请求的名字），
      // 收尾补 [DONE]。上游的 `{"choices":[],"cost":...}` 记账 chunk 不转发给客户端。
      // 脏数据（非 SSE 行）由 parseOpenAISSE 丢弃并回调：收到即中止流并发错误事件，
      // 避免客户端看到断流后报通用 Failed to parse JSON。
      let dirtySample: string | null = null;
      for await (const chunk of parseOpenAISSE(upstream.response.body, (d) => {
        if (dirtySample === null) dirtySample = d.sample;
      })) {
        if (res.writableEnded || res.destroyed) break;
        if (requestedModel) chunk.model = requestedModel;
        if (chunk.usage) {
          ctx.inputTokens = chunk.usage.prompt_tokens ?? ctx.inputTokens;
          ctx.outputTokens = chunk.usage.completion_tokens ?? ctx.outputTokens;
          ctx.thinkingTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? ctx.thinkingTokens;
        }
        // 脏行检测放在写出**之前**：onDirty 在 parseOpenAISSE 产出下一个 chunk 的
        // 途中触发，此时该 chunk 已越过脏数据边界，不能再写给客户端。
        if (dirtySample !== null) {
          console.error(`[proxy] chat stream aborted on dirty line: ${stripControl(dirtySample)}`);
          break;
        }
        if (!chunk.choices?.length && !chunk.usage) continue;
        await writeChunk(res, sseStringify(chunk));
      }
      if (dirtySample === null && !res.writableEnded && !res.destroyed) {
        await writeChunk(res, 'data: [DONE]\n\n');
      }
      if (dirtySample === null) upstream.markSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'stream error';
      console.error(`[proxy] stream error: ${stripControl(message)}`);
      upstream.markFailure('transient');
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ error: INTERNAL_SERVER_ERROR })}\n\n`);
      }
    } finally {
      upstream.release();
      res.end();
    }
    return;
  }

  const data = (await upstream.response.json().catch(() => null)) as OpenAIChatResponse | null;
  upstream.markSuccess();
  upstream.release();
  if (data === null) {
    sendJson(res, 502, { error: { message: 'upstream returned malformed body', type: 'server_error' } });
    return;
  }
  // 回显客户端请求的模型名，而非上游实际模型名。
  if (requestedModel) data.model = requestedModel;
  ctx.inputTokens = data.usage?.prompt_tokens ?? 0;
  ctx.outputTokens = data.usage?.completion_tokens ?? 0;
  ctx.thinkingTokens = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  sendJson(res, 200, data);
}

/**
 * OpenAI 请求 → 发给上游的 OpenAI 请求。
 *
 * 上游同为 OpenAI 协议，所以不做协议转换，只做三件事：
 * 1. 模型名解析（MODEL_MAP → 上游已知模型直传 → 回落 fallback）。
 * 2. 加 system 指令隔离护栏（把历史/工具结果声明为不可信数据）。
 * 3. 剥掉上游不认的字段，避免 400。
 */
function prepareOpenAIUpstreamRequest(
  req: OpenAIChatRequest,
  cfg: AppConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(req as unknown as Record<string, unknown>) };
  out.model = resolveModelName(req.model, cfg.modelMap, cfg.fallbackModel, upstreamModels);

  // system 护栏：已有 system 消息就追加，没有就插一条到最前面。
  const messages = Array.isArray(req.messages) ? [...req.messages] : [];
  const firstSystem = messages.findIndex((m) => m?.role === 'system');
  if (firstSystem >= 0) {
    const m = messages[firstSystem]!;
    const text = typeof m.content === 'string' ? m.content : '';
    messages[firstSystem] = { ...m, content: buildSystemGuard(text) };
  } else {
    messages.unshift({ role: 'system', content: buildSystemGuard('') });
  }
  out.messages = messages;

  // 上游不认的 OpenAI 扩展字段：剥掉防 400。
  for (const k of ['logit_bias', 'logprobs', 'top_logprobs', 'n', 'seed', 'user', 'store', 'metadata']) {
    delete out[k];
  }
  return out;
}

async function handleMessagesPassThrough(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AppConfig,
  pool: KeyPool,
  keyId: string,
  ctx: MetricsCtx,
): Promise<void> {
  const read = await readBody(req, cfg.maxBodyBytes);
  if (!read.ok) {
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    sendJson(res, 400, badBodyError(parsed.empty));
    return;
  }
  const body = parsed.body as Record<string, unknown>;

  const v = validateAnthropicRequest(body, cfg);
  if (!v.ok) {
    sendJson(res, 400, { error: { message: v.error, type: 'invalid_request_error' } });
    return;
  }

  // deepseek 归一化：模型名映射 + thinking 归一化（adaptive→enabled 等）。
  let normalized: Record<string, unknown>;
  try {
    normalized = normalizeAnthropicRequest(body, cfg.modelMap, cfg.fallbackModel);
  } catch {
    sendJson(res, 400, { error: { message: 'invalid request body', type: 'invalid_request_error' } });
    return;
  }

  // 注入检测：对 user 消息递归提取文本做启发式扫描（含 tool_result 内嵌 content）。
  const anthroMessages = normalized.messages as Array<{ role: string; content: unknown }>;
  for (let i = 0; i < anthroMessages.length; i++) {
    const m = anthroMessages[i]!;
    if (m.role !== 'user') continue;
    const verdict = detectInjection(extractAllText(m.content));
    if (verdict.level !== 'none') {
      console.warn(`[inject] key=${keyId} msg#${i} level=${verdict.level} signals=${verdict.signals.join(',')}`);
      if (cfg.injectionMode === 'block' && verdict.level === 'high') {
        sendJson(res, 400, { error: { message: 'message content violates content policy', type: 'invalid_request_error' } });
        return;
      }
    }
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  // 转成 OpenAI 请求再发上游。上游的 Anthropic 兼容层工具调用是坏的
  // （返回空 content + stop_reason:null），OpenAI 端点才可用，见 DEEPSEEK-QUIRKS.md。
  const openAIReq = anthropicToOpenAIRequest(normalized as unknown as Parameters<typeof anthropicToOpenAIRequest>[0]);
  ctx.requestBytes = Buffer.byteLength(read.text);
  ctx.model = typeof body.model === 'string' ? body.model : '';
  ctx.upstreamModel = openAIReq.model;
  ctx.endpoint = openAIReq.model.endsWith('-free') ? 'payg' : 'subscription';
  ctx.stream = normalized.stream === true;

  // 转发额外 headers（anthropic-beta、x-claude-code-*），并保留上游 request-id。
  const extraHeaders = collectForwardHeaders(req.headers, cfg);
  let upstream: UpstreamCall;
  try {
    upstream = await postUpstreamChat(
      cfg,
      pool,
      openAIReq as unknown as Record<string, unknown>,
      controller.signal,
      extraHeaders,
    );
    ctx.keyFingerprint = keyFingerprint(upstream.key);
  } catch (err) {
    if (err instanceof PoolEmptyError) {
      logPoolEmpty(pool);
      sendJson(res, 503, { error: { message: 'all upstream keys are disabled', type: 'server_error' } });
      return;
    }
    sendJson(res, 502, { error: { message: 'upstream unavailable', type: 'server_error' } });
    return;
  }

  if (!upstream.response.ok) {
    // Claude Code 期望 Anthropic 原生错误格式，直通透传（限长 + 剥控制符防泄漏/日志注入），
    // 保留 request-id 与 retry-after。
    const raw = (await upstream.response.text().catch(() => '')).slice(0, 64 * 1024);
    let errBody: unknown = null;
    try {
      errBody = JSON.parse(raw);
    } catch {
      /* 非 JSON，按状态码分级 */
    }
    const kind = classifyUpstreamFailure(upstream.response.status, errBody);
    upstream.markFailure(kind, resetDelayMsFromError(errBody) ?? undefined);
    const requestId = upstream.response.headers.get('request-id');
    const retryAfter = upstream.response.headers.get('retry-after');
    res.writeHead(upstream.response.status, {
      'content-type': 'application/json; charset=utf-8',
      ...(requestId ? { 'request-id': requestId } : {}),
      ...(retryAfter ? { 'retry-after': retryAfter } : {}),
    });
    upstream.release();
    res.end(stripControl(raw));
    return;
  }
  const requestId = upstream.response.headers.get('request-id');
  if (requestId) res.setHeader('request-id', requestId);

  const isStream = normalized.stream === true;
  if (isStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // 上游是 OpenAI 流：解析 chunk → 转成 Anthropic 事件序列（自带完整骨架）。
    // thinking 显式 disabled 时剥掉 thinking 块事件（Claude Code 会因多余 thinking 报错）。
    const keepThinking = (normalized.thinking as { type?: string } | undefined)?.type !== 'disabled';
    const requestedModel = typeof body.model === 'string' ? body.model : undefined;
    // 上游在流中途插入脏数据（非 SSE 行/坏 JSON）时：中止流并发明确 error 事件，
    // 否则客户端只会看到一个「断流」的响应，报出通用的 Failed to parse JSON。
    // 行本身仍被 parseOpenAISSE 丢弃（不透传），这里只是让「断流」可解释。
    let dirtySample: string | null = null;
    const events = filterThinkingFromStream(
      openAIStreamToAnthropic(
        parseOpenAISSE(upstream.response.body, (d) => {
          if (dirtySample === null) dirtySample = d.sample;
        }),
        { model: requestedModel },
      ),
      keepThinking,
    );
    /** 发一个 Anthropic error 事件，告知客户端流被上游打断。 */
    const emitStreamError = (sample: string): void => {
      console.error(`[proxy] passthrough stream aborted on dirty line: ${stripControl(sample)}`);
      if (!res.writableEnded && !res.destroyed) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'upstream interrupted the stream' } })}\n\n`,
        );
      }
    };
    try {
      for await (const ev of events) {
        if (res.writableEnded || res.destroyed) break;
        // 脏行检测放在写出**之前**：收到脏行时不再写给客户端后续事件。
        if (dirtySample !== null) break;
        if (ev.type === 'message_delta' && ev.usage) ctx.outputTokens = ev.usage.output_tokens;
        await writeChunk(res, anthropicEventToSSE(ev));
      }
      // 循环结束后再查一次：openAIStreamToAnthropic 会缓冲整个 text 块到流末尾
      // 收尾统一产出，脏行可能在最后一次迭代之后才被上报。
      if (dirtySample !== null) {
        emitStreamError(dirtySample);
        upstream.markFailure('transient');
      } else {
        upstream.markSuccess();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'passthrough stream error';
      console.error(`[proxy] passthrough stream error: ${stripControl(message)}`);
      upstream.markFailure('transient');
    } finally {
      upstream.release();
      res.end();
    }
    return;
  }

  // 非流式：上游 OpenAI 响应 → Anthropic 响应。
  const data = (await upstream.response.json().catch(() => null)) as OpenAIChatResponse | null;
  upstream.markSuccess();
  upstream.release();
  if (data === null) {
    sendJson(res, 502, { error: { message: 'upstream returned malformed body', type: 'server_error' } });
    return;
  }
  // 回显客户端请求的模型名（映射前的名字），而非上游实际模型。
  const requestedModel = typeof body.model === 'string' ? body.model : undefined;
  const anthropicRes = openAIToAnthropicResponse(data, { model: requestedModel });
  ctx.inputTokens = anthropicRes.usage.input_tokens;
  ctx.outputTokens = anthropicRes.usage.output_tokens;
  ctx.thinkingTokens = anthropicRes.usage.output_tokens_details?.thinking_tokens ?? 0;

  // thinking 显式 disabled 时剥掉 thinking 块（Claude Code 会因多余 thinking 报错）。
  if ((normalized.thinking as { type?: string } | undefined)?.type === 'disabled') {
    anthropicRes.content = anthropicRes.content.filter((b) => b.type !== 'thinking');
    if (anthropicRes.content.length === 0) {
      anthropicRes.content.push({ type: 'text', text: '' });
    }
  }

  sendJson(res, 200, anthropicRes);
}

/**
 * Claude Code 记账端点。
 *
 * 上游走的是 OpenAI 协议，没有 count_tokens（Anthropic 端点也只返回 404 HTML），
 * 所以这里纯本地估算，不打上游 —— 既省一次往返，也避免烧订阅额度。
 * 估算口径：messages/system 的文本字符数 / 4。
 */
function handleCountTokens(req: IncomingMessage, res: ServerResponse, cfg: AppConfig, ctx: MetricsCtx): void {
  void readBody(req, cfg.maxBodyBytes).then((read) => {
    if (!read.ok) {
      sendJson(res, read.status, {
        error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
      });
      return;
    }
    const parsed = parseJson(read.text);
    if (!parsed.ok) {
      sendJson(res, 400, badBodyError(parsed.empty));
      return;
    }
    const bodyObj = parsed.body as Record<string, unknown> | null;
    if (bodyObj != null && typeof bodyObj.model === 'string') ctx.model = bodyObj.model;
    const inputTokens = estimateInputTokens(parsed.body);
    ctx.inputTokens = inputTokens;
    sendJson(res, 200, { input_tokens: inputTokens });
  });
}

/** 本地估算 input_tokens：messages/system 文本字符数 / 4（约 4 字符/token）。 */
function estimateInputTokens(body: unknown): number {
  let chars = 0;
  const countText = (value: unknown): void => {
    if (typeof value === 'string') {
      chars += value.length;
    } else if (Array.isArray(value)) {
      for (const item of value) countText(item);
    } else if (value != null && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        countText((value as Record<string, unknown>)[key]);
      }
    }
  };

  const bodyObj = body as Record<string, unknown> | null;
  if (bodyObj != null && typeof bodyObj === 'object') {
    if (typeof bodyObj.system === 'string') chars += bodyObj.system.length;
    countText(bodyObj.messages);
  }
  return Math.max(1, Math.ceil(chars / 4));
}
