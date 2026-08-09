import type {
  AnthropicResponse,
  AnthropicResponseContentBlock,
  AnthropicStopReason,
  AnthropicStreamEvent,
  AnthropicUsage,
  OpenAIChatResponse,
  OpenAIFinishReason,
  OpenAIStreamChunk,
} from './types.js';

/** OpenAI finish_reason → Anthropic stop_reason。 */
export function openAIFinishReasonToAnthropic(
  reason: OpenAIFinishReason | null | undefined,
): AnthropicStopReason | null {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return null;
  }
}

/** OpenAI usage → Anthropic usage。 */
export function openAIUsageToAnthropic(usage: OpenAIChatResponse['usage'] | undefined): AnthropicUsage {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const out: AnthropicUsage = {
    // Anthropic 的 input_tokens 是「非缓存」部分，缓存单列。
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: usage?.completion_tokens ?? 0,
  };
  if (cached > 0) out.cache_read_input_tokens = cached;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  if (reasoning != null) out.output_tokens_details = { thinking_tokens: reasoning };
  return out;
}

/**
 * OpenAI Chat Completions 响应（非流式）→ Anthropic Messages 响应。
 *
 * - `reasoning_content` → thinking 块（放最前，Anthropic 要求 thinking 在 text 之前）。
 * - `content` → text 块；`tool_calls` → tool_use 块（arguments JSON 字符串转对象）。
 * - `finish_reason` → `stop_reason`。
 * - 畸形 arguments 不丢工具调用，退化成空 input，保留可诊断性。
 */
export function openAIToAnthropicResponse(
  res: OpenAIChatResponse,
  options: { model?: string; id?: string } = {},
): AnthropicResponse {
  const choice = res.choices?.[0];
  const message = choice?.message;
  const content: AnthropicResponseContentBlock[] = [];

  if (message?.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content, signature: '' });
  }
  if (typeof message?.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content });
  }
  for (const tc of message?.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      // 畸形 arguments：保持空 input，不丢弃工具调用。
      input = {};
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }

  // Anthropic 不接受空 content 数组，补一个空 text 块。
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return {
    id: options.id ?? res.id ?? `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: options.model ?? res.model,
    content,
    stop_reason: openAIFinishReasonToAnthropic(choice?.finish_reason),
    stop_sequence: null,
    usage: openAIUsageToAnthropic(res.usage),
  };
}

interface BlockState {
  /** Anthropic 侧的块 index */
  index: number;
  kind: 'thinking' | 'text' | 'tool_use';
}

/**
 * OpenAI 流式 chunk → Anthropic SSE 事件序列。
 *
 * 产出完整自洽的事件骨架（Claude Code 强依赖）：
 *   message_start → [content_block_start → delta* → content_block_stop]* →
 *   message_delta → message_stop
 *
 * 块分配策略：reasoning_content / content / 每个 tool_call 各占一个 Anthropic 块，
 * 出现即开块、切换时关上一块。OpenAI 的 tool_calls[].index 映射到独立块。
 */
export async function* openAIStreamToAnthropic(
  chunks: AsyncIterable<OpenAIStreamChunk>,
  options: { model?: string; id?: string } = {},
): AsyncGenerator<AnthropicStreamEvent> {
  let started = false;
  let nextIndex = 0;
  /** 当前打开的文本类块（thinking 或 text），同时只允许一个。 */
  let openTextBlock: BlockState | null = null;
  /** OpenAI tool_calls index → Anthropic 块状态 */
  const toolBlocks = new Map<number, BlockState>();
  let finishReason: OpenAIFinishReason | null = null;
  let usage: OpenAIChatResponse['usage'] | undefined;
  let messageId = options.id;
  let model = options.model;

  const ensureStart = function* (): Generator<AnthropicStreamEvent> {
    if (started) return;
    started = true;
    yield {
      type: 'message_start',
      message: {
        id: messageId ?? `msg_${Date.now().toString(36)}`,
        type: 'message',
        role: 'assistant',
        model: model ?? '',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
  };

  const closeTextBlock = function* (): Generator<AnthropicStreamEvent> {
    if (openTextBlock) {
      yield { type: 'content_block_stop', index: openTextBlock.index };
      openTextBlock = null;
    }
  };

  for await (const chunk of chunks) {
    if (!messageId && chunk.id) messageId = chunk.id;
    if (!model && chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (!delta) continue;

    // 1. reasoning_content → thinking 块
    if (delta.reasoning_content) {
      yield* ensureStart();
      if (openTextBlock?.kind !== 'thinking') {
        yield* closeTextBlock();
        openTextBlock = { index: nextIndex++, kind: 'thinking' };
        yield {
          type: 'content_block_start',
          index: openTextBlock.index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        };
      }
      yield {
        type: 'content_block_delta',
        index: openTextBlock.index,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      };
    }

    // 2. content → text 块
    if (typeof delta.content === 'string' && delta.content) {
      yield* ensureStart();
      if (openTextBlock?.kind !== 'text') {
        yield* closeTextBlock();
        openTextBlock = { index: nextIndex++, kind: 'text' };
        yield {
          type: 'content_block_start',
          index: openTextBlock.index,
          content_block: { type: 'text', text: '' },
        };
      }
      yield {
        type: 'content_block_delta',
        index: openTextBlock.index,
        delta: { type: 'text_delta', text: delta.content },
      };
    }

    // 3. tool_calls → tool_use 块（每个 OpenAI index 一个独立块）
    for (const tc of delta.tool_calls ?? []) {
      yield* ensureStart();
      let block = toolBlocks.get(tc.index);
      if (!block) {
        // 新工具调用：先关掉文本块（Anthropic 块不能交错）。
        yield* closeTextBlock();
        block = { index: nextIndex++, kind: 'tool_use' };
        toolBlocks.set(tc.index, block);
        yield {
          type: 'content_block_start',
          index: block.index,
          content_block: {
            type: 'tool_use',
            id: tc.id ?? `toolu_${Date.now().toString(36)}_${tc.index}`,
            name: tc.function?.name ?? '',
            input: {},
          },
        };
      }
      const args = tc.function?.arguments;
      if (args) {
        yield {
          type: 'content_block_delta',
          index: block.index,
          delta: { type: 'input_json_delta', partial_json: args },
        };
      }
    }
  }

  // 收尾：补齐骨架，保证 Claude Code 能闭合 message。
  yield* ensureStart();
  yield* closeTextBlock();
  for (const block of toolBlocks.values()) {
    yield { type: 'content_block_stop', index: block.index };
  }

  const anthropicUsage = openAIUsageToAnthropic(usage);
  yield {
    type: 'message_delta',
    delta: {
      stop_reason: openAIFinishReasonToAnthropic(finishReason) ?? 'end_turn',
      stop_sequence: null,
    },
    usage: { output_tokens: anthropicUsage.output_tokens },
  };
  yield { type: 'message_stop' };
}

/** 把 Anthropic 事件序列化为 SSE 文本（Anthropic 要求带 event: 行）。 */
export function anthropicEventToSSE(ev: AnthropicStreamEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}
