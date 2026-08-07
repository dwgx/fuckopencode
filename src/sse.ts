import type { AnthropicStreamEvent } from './types.js';

/**
 * 解析 Anthropic SSE 文本流（ReadableStream）为事件对象序列。
 * 兼容 event:/data: 行结构；data 可能跨多行；空行触发事件；
 * 无法解析的行静默跳过。
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
      return [JSON.parse(raw) as AnthropicStreamEvent];
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
        }
        // event: 行只作为辅助，类型以 data 内 JSON 的 type 字段为准。
      }
    }

    // EOF：处理 buffer 里残留的无换行 data 行（最后一行没有换行符时，事件会被丢）。
    if (buffer.length > 0) {
      const tail = buffer.replace(/\r$/, '');
      if (tail.startsWith('data:')) dataLines.push(tail.slice(5).replace(/^ /, ''));
      buffer = '';
    }
    yield* flush();
  } finally {
    reader.releaseLock();
  }
}
