import type { AnthropicStreamEvent, OpenAIStreamChunk } from './types.js';

/**
 * 上游发来的非 SSE 脏数据。
 *
 * 为什么要单独暴露：`parseOpenAISSE` 一直**静默丢弃**非 JSON 行。丢弃本身是对的
 * （不能把脏字节透给客户端），但完全静默意味着客户端只看到一个「中途没了」的流，
 * 报错是通用的 `Failed to parse JSON`，无从定位是哪一层坏的。
 * 上报之后由 server 层决定发一个明确的 error 事件。
 */
export interface DirtyStreamLine {
  /** 脏数据原文（截断，仅用于日志/诊断） */
  sample: string;
}

/** 脏数据样本上限：只为诊断，不留大块上游内容在内存/日志里。 */
const DIRTY_SAMPLE_MAX_CHARS = 200;

/**
 * 解析 **OpenAI** Chat Completions 流（`data: {...}` 行 + `[DONE]`）为 chunk 序列。
 *
 * 上游 opencode Zen 的 OpenAI 端点收尾会发 `{"choices":[],"cost":"0"}` 记账 chunk，
 * 保留（usage 可能在里面）；`[DONE]` 与非 JSON 行跳过。
 *
 * `onDirty` 在遇到非 SSE 脏行时回调（行被丢弃的行为不变）。实测触发场景：上游
 * 或中间层在流中途插入非 SSE 的错误体（如 kiro2cc 限流时的 502 JSON 文本）。
 */
export async function* parseOpenAISSE(
  body: ReadableStream<Uint8Array> | null,
  onDirty?: (line: DirtyStreamLine) => void,
): AsyncGenerator<OpenAIStreamChunk> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseLine = (line: string): OpenAIStreamChunk | null => {
    let payload = line;
    if (payload.startsWith('data:')) payload = payload.slice(5).replace(/^ /, '');
    if (!payload || payload === '[DONE]') return null;
    if (!payload.startsWith('{')) {
      // 非 JSON 行：可能是 SSE 注释/心跳（`:` 开头，无害），也可能是上游插进来的
      // 裸错误文本（有害，客户端会因此看到断流）。只上报后者。
      if (!payload.startsWith(':')) onDirty?.({ sample: payload.slice(0, DIRTY_SAMPLE_MAX_CHARS) });
      return null;
    }
    try {
      const parsed = JSON.parse(payload) as OpenAIStreamChunk;
      // 上游收尾会发 `{"choices":[],"cost":"0"}` 这类无 choices 的记账 chunk；
      // 保留它（usage 可能在里面），由转换器判断。
      return parsed != null && typeof parsed === 'object' ? parsed : null;
    } catch {
      // `{` 开头但 JSON 解析失败：截断/损坏的 chunk，属于脏数据。
      onDirty?.({ sample: payload.slice(0, DIRTY_SAMPLE_MAX_CHARS) });
      return null;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '').trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        const chunk = parseLine(line);
        if (chunk) yield chunk;
      }
    }
    // EOF：处理最后一行没有换行符的情况。
    const tail = buffer.replace(/\r$/, '').trim();
    if (tail) {
      const chunk = parseLine(tail);
      if (chunk) yield chunk;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 解析 Anthropic SSE 文本流（ReadableStream）为事件对象序列。
 *
 * 兼容两种上游格式：
 * 1. 标准 SSE：`event:`/`data:` 行结构，空行触发事件。
 * 2. 裸 JSON 行（opencode Zen 风格）：直接 `{"type":...}` 或 `{}`，
 *    无 `data:` 前缀。逐行解析，非 JSON / 空对象行静默跳过。
 */
export async function* parseAnthropicSSE(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<AnthropicStreamEvent> {
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  const flush = (): AnthropicStreamEvent[] => {
    if (dataLines.length === 0) return [];
    const raw = dataLines.join('\n');
    dataLines = [];
    if (raw === '[DONE]') return [];
    try {
      const parsed = JSON.parse(raw) as AnthropicStreamEvent | null;
      // `{}` 空对象（opencode 心跳占位）无 type 字段，跳过。
      if (!parsed || typeof (parsed as { type?: unknown }).type !== 'string') return [];
      return [parsed];
    } catch {
      // 非 JSON 行（如 ping 注释），忽略。
      return [];
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        } else if (line === '') {
          yield* flush();
        } else if (line.startsWith('{')) {
          // 裸 JSON 行（opencode 风格）：直接作为一条事件处理。
          dataLines.push(line);
          yield* flush();
        }
        // event: 行只作为辅助，类型以 data 内 JSON 的 type 字段为准。
      }
    }

    // EOF：处理 buffer 里残留的无换行 data 行（最后一行没有换行符时，事件会被丢）。
    if (buffer.length > 0) {
      const tail = buffer.replace(/\r$/, '');
      if (tail.startsWith('data:')) dataLines.push(tail.slice(5).replace(/^ /, ''));
      else if (tail.startsWith('{')) dataLines.push(tail);
      buffer = '';
    }
    yield* flush();
  } finally {
    reader.releaseLock();
  }
}
