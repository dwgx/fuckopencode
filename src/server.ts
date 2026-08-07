import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AppConfig } from './config.js';
import { postAnthropic } from './anthropic.js';
import { anthropicErrorToOpenAI, INTERNAL_SERVER_ERROR, rejectionError, stripControl } from './errors.js';
import { verifyAuth } from './security/auth.js';
import { buildSystemGuard, detectInjection, extractAllText, scanMessagesForInjection } from './security/injection.js';
import { isJsonContentType, validateAnthropicRequest, validateChatRequest } from './security/validate.js';
import { openAIToAnthropicRequest } from './request.js';
import { anthropicToOpenAIResponse } from './response.js';
import { anthropicStreamToOpenAI, openAIStreamToSSE } from './stream.js';
import { parseAnthropicSSE } from './sse.js';
import { filterThinkingFromStream, normalizeAnthropicRequest, resolveModelName } from './deepseek.js';
import type { OpenAIChatRequest } from './types.js';

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
      if (size > maxBytes) {
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

function parseJson(text: string): { ok: true; body: unknown } | { ok: false } {
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function createApp(cfg: AppConfig) {
  return createServer(async (req, res) => {
    const startTime = Date.now();
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';

    try {
      // 健康检查不需要鉴权。
      if (req.method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
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
        await handleChatCompletion(req, res, cfg, auth.keyId);
        return;
      }

      if (req.method === 'POST' && path === '/v1/messages') {
        if (!isJsonContentType(req.headers['content-type'])) {
          sendJson(res, 415, { error: { message: 'content-type must be application/json', type: 'invalid_request_error' } });
          return;
        }
        await handleMessagesPassThrough(req, res, cfg, auth.keyId);
        return;
      }

      // Claude Code 记账端点：转发上游 count_tokens，回传 Anthropic 原生结果。
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        if (!isJsonContentType(req.headers['content-type'])) {
          sendJson(res, 415, { error: { message: 'content-type must be application/json', type: 'invalid_request_error' } });
          return;
        }
        await handleCountTokens(req, res, cfg);
        return;
      }

      // 模型发现（OpenAI 兼容）：列出 fallback 模型与 MODEL_MAP 配置的模型。
      if (req.method === 'GET' && path === '/v1/models') {
        const ids = new Set([cfg.fallbackModel, ...Object.keys(cfg.modelMap)]);
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
    }
  });
}

async function handleChatCompletion(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AppConfig,
  keyId: string,
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
    sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
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

  // 转换 + 指令隔离护栏。模型名按 MODEL_MAP 映射，未命中回落 fallback。
  const mapModel = (m: string): string => resolveModelName(m, cfg.modelMap, cfg.fallbackModel);
  const anthropicReq = openAIToAnthropicRequest(body as unknown as OpenAIChatRequest, { mapModel });
  if (anthropicReq.system != null) {
    anthropicReq.system = buildSystemGuard(anthropicReq.system);
  } else {
    anthropicReq.system = buildSystemGuard('');
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const upstream = await postAnthropic(cfg, anthropicReq, controller.signal);
  if (!upstream.ok) {
    let errBody: unknown = null;
    try {
      errBody = await upstream.json();
    } catch {
      // ignore
    }
    const err = anthropicErrorToOpenAI(upstream.status, errBody);
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) res.setHeader('retry-after', retryAfter);
    sendJson(res, err.status, err.body);
    return;
  }

  const isStream = anthropicReq.stream === true;
  if (isStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    try {
      // stream_options.include_usage → 流式转换器把 usage 放独立尾 chunk（choices:[]）。
      const includeUsage =
        (body as { stream_options?: { include_usage?: boolean } }).stream_options?.include_usage === true;
      const chunks = anthropicStreamToOpenAI(parseAnthropicSSE(upstream.body), { includeUsage });
      for await (const line of openAIStreamToSSE(chunks)) {
        if (res.writableEnded || res.destroyed) break;
        await writeChunk(res, line);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'stream error';
      console.error(`[proxy] stream error: ${stripControl(message)}`);
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ error: INTERNAL_SERVER_ERROR })}\n\n`);
      }
    } finally {
      res.end();
    }
    return;
  }

  const data: unknown = await upstream.json();
  // 回显客户端请求的模型名（映射前的 OpenAI 名），而非上游 Anthropic 名。
  const requestedModel = typeof body.model === 'string' ? body.model : undefined;
  sendJson(res, 200, anthropicToOpenAIResponse(data as Parameters<typeof anthropicToOpenAIResponse>[0], { model: requestedModel }));
}

async function handleMessagesPassThrough(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AppConfig,
  keyId: string,
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
    sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
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

  // 转发额外 headers（anthropic-beta、x-claude-code-*），并保留上游 request-id。
  const extraHeaders = collectForwardHeaders(req.headers, cfg);
  const upstream = await postAnthropic(cfg, normalized, controller.signal, extraHeaders);
  if (!upstream.ok) {
    // Claude Code 期望 Anthropic 原生错误格式，直通透传（限长 + 剥控制符防泄漏/日志注入），
    // 保留 request-id 与 retry-after。
    const raw = (await upstream.text()).slice(0, 64 * 1024);
    const requestId = upstream.headers.get('request-id');
    const retryAfter = upstream.headers.get('retry-after');
    res.writeHead(upstream.status, {
      'content-type': 'application/json; charset=utf-8',
      ...(requestId ? { 'request-id': requestId } : {}),
      ...(retryAfter ? { 'retry-after': retryAfter } : {}),
    });
    res.end(stripControl(raw));
    return;
  }
  const requestId = upstream.headers.get('request-id');
  if (requestId) res.setHeader('request-id', requestId);

  const isStream = normalized.stream === true;
  if (isStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // 显式 disabled 时剥掉 deepseek 仍吐的 thinking/signature 事件（多轮 400 主因）；
    // 默认/enabled 时字节透传，保留 Claude Code 需要的 thinking+signature 原样回传。
    const keepThinking = (normalized.thinking as { type?: string } | undefined)?.type !== 'disabled';

    if (keepThinking) {
      const reader = upstream.body?.getReader();
      if (!reader) {
        res.end();
        return;
      }
      try {
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (res.writableEnded || res.destroyed) break;
          await writeChunk(res, decoder.decode(value, { stream: true }));
        }
      } finally {
        reader.releaseLock();
        res.end();
      }
      return;
    }

    // thinking disabled：解析 SSE → 过滤 → 重新序列化。
    const events = filterThinkingFromStream(parseAnthropicSSE(upstream.body), false);
    try {
      for await (const ev of events) {
        if (res.writableEnded || res.destroyed) break;
        await writeChunk(res, `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'passthrough stream error';
      console.error(`[proxy] passthrough stream error: ${stripControl(message)}`);
    } finally {
      res.end();
    }
    return;
  }

  const raw = await upstream.text();
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(stripControl(raw));
}

/** Claude Code 记账：转发 /v1/messages/count_tokens，回传 Anthropic 原生结果。 */
async function handleCountTokens(req: IncomingMessage, res: ServerResponse, cfg: AppConfig): Promise<void> {
  const read = await readBody(req, cfg.maxBodyBytes);
  if (!read.ok) {
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
    return;
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const upstream = await postAnthropic(cfg, parsed.body, controller.signal, {}, '/v1/messages/count_tokens');
  const raw = await upstream.text();
  res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(stripControl(raw));
}
