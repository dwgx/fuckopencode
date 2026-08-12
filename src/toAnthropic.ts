import { extractDsmlToolCalls, hasDsmlResidue, stripDsmlResidue } from './dsml.js';
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

/**
 * OpenAI usage → Anthropic usage。
 *
 * `scale`（实验性 SCALE_CLIENT_TOKENS）传入时对 input/output/cache/thinking
 * 统一缩放（Math.round）—— 返回给客户端的用量是失真值，用于诱导 Claude Code
 * 按「假用量」提前本地 compact；真实用量以网关侧 MetricsCtx 计数为准。
 */
export function openAIUsageToAnthropic(
  usage: OpenAIChatResponse['usage'] | undefined,
  scale?: number,
): AnthropicUsage {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const apply = (n: number): number => (scale != null ? Math.round(n * scale) : n);
  const out: AnthropicUsage = {
    // Anthropic 的 input_tokens 是「非缓存」部分，缓存单列。
    input_tokens: apply(Math.max(0, prompt - cached)),
    output_tokens: apply(usage?.completion_tokens ?? 0),
  };
  if (cached > 0) out.cache_read_input_tokens = apply(cached);
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  if (reasoning != null) out.output_tokens_details = { thinking_tokens: apply(reasoning) };
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
  options: { model?: string; id?: string; scale?: number } = {},
): AnthropicResponse {
  const choice = res.choices?.[0];
  const message = choice?.message;
  const content: AnthropicResponseContentBlock[] = [];
  // 上游把工具调用泄漏成文本时 finish_reason 通常是 stop；还原成 tool_use 块后
  // 必须把 stop_reason 一并纠正，否则客户端当成 end_turn，不会执行工具。
  let recoveredToolUse = false;

  if (message?.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content, signature: '' });
  }
  if (typeof message?.content === 'string' && message.content) {
    // 上游偶发把工具调用当文本吐（DSML 包裹）。能解析就还原成 tool_use，
    // 否则保持文本原样。解析出的工具 id 用确定性派生，避免重试不幂等。
    const dsml = extractDsmlToolCalls(message.content);
    if (dsml) {
      if (dsml.text) content.push({ type: 'text', text: dsml.text });
      dsml.toolCalls.forEach((c, i) => {
        // 同名工具可能被调用多次，序号保证 id 唯一。
        content.push({ type: 'tool_use', id: `dsml_${i}_${c.name}`, name: c.name, input: c.input });
      });
      recoveredToolUse = dsml.toolCalls.length > 0;
    } else if (hasDsmlResidue(message.content)) {
      // 残缺 DSML：抽不出 invoke，但标记不能泄漏给客户端。剥掉标记留文本。
      const clean = stripDsmlResidue(message.content);
      if (clean) content.push({ type: 'text', text: clean });
    } else {
      content.push({ type: 'text', text: message.content });
    }
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
    stop_reason: recoveredToolUse ? 'tool_use' : openAIFinishReasonToAnthropic(choice?.finish_reason),
    stop_sequence: null,
    usage: openAIUsageToAnthropic(res.usage, options.scale),
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
  options: { model?: string; id?: string; scale?: number } = {},
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
  /**
   * 流式文本缓冲。上游偶发把工具调用当文本吐（DSML 包裹），流式下边收边吐
   * 无法中途判断，所以**缓冲整个 text 块**到流结束，收尾时统一解析——
   * 解析出 DSML 就还原成 tool_use 块，否则原样补发 text。
   * 代价：流式文本的 TTFB 从「首字」变成「整个 text 块结束」。工具调用场景
   * 本来就要等工具结果，牺牲可接受；纯长文对话会有感知延迟。
   */
  let bufferedText = '';
  /** DSML 还原出工具调用时要把 stop_reason 纠正为 tool_use（同非流式）。 */
  let recoveredToolUse = false;

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
    // 上游错误体（OpenAI `{error:{...}}`）混进流：转换器产不出有效的事件序列，
    // 直接中止流，由 server 层 catch 后发 error 事件。异常消息不带上游内容
    // （错误文案可能回显 Authorization 头，拼进来 key 会随日志泄漏）。
    if (chunk.error != null) {
      throw new Error('upstream returned error chunk in stream');
    }
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

    // 2. content → text 块：缓冲到流结束，收尾统一解析 DSML（见收尾段）。
    if (typeof delta.content === 'string' && delta.content) {
      yield* ensureStart();
      // 首次收到文本时关掉 thinking 块，让收尾能新开独立的 text 块
      // （否则缓冲的文本会被误并入还在开着的 thinking 块）。
      if (openTextBlock && openTextBlock.kind !== 'text') {
        yield { type: 'content_block_stop', index: openTextBlock.index };
        openTextBlock = null;
      }
      bufferedText += delta.content;
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

  // 解析缓冲的文本：DSML → tool_use 块；普通文本 → 补发 text 块。
  if (bufferedText) {
    const dsml = extractDsmlToolCalls(bufferedText);
    if (dsml) {
      // DSML 解析成功：残余文本先发 text 块，再逐个发 tool_use 块。
      if (dsml.text) {
        openTextBlock = { index: nextIndex++, kind: 'text' };
        yield {
          type: 'content_block_start',
          index: openTextBlock.index,
          content_block: { type: 'text', text: '' },
        };
        yield {
          type: 'content_block_delta',
          index: openTextBlock.index,
          delta: { type: 'text_delta', text: dsml.text },
        };
        yield { type: 'content_block_stop', index: openTextBlock.index };
        openTextBlock = null;
      }
      // 每个解析出的调用一个 tool_use 块
      recoveredToolUse = dsml.toolCalls.length > 0;
      for (let i = 0; i < dsml.toolCalls.length; i++) {
        const c = dsml.toolCalls[i]!;
        const idx = nextIndex++;
        yield {
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'tool_use', id: `dsml_${i}_${c.name}`, name: c.name, input: c.input },
        };
        yield { type: 'content_block_stop', index: idx };
      }
    } else if (hasDsmlResidue(bufferedText)) {
      // 残缺 DSML：抽不出 invoke，但标记不能泄漏给客户端。剥掉标记发纯文本。
      const clean = stripDsmlResidue(bufferedText);
      if (!clean) {
        // 剥完空了（纯标记），不发任何 text 块。
      } else if (openTextBlock) {
        yield {
          type: 'content_block_delta',
          index: openTextBlock.index,
          delta: { type: 'text_delta', text: clean },
        };
        yield { type: 'content_block_stop', index: openTextBlock.index };
        openTextBlock = null;
      } else {
        const idx = nextIndex++;
        yield {
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'text', text: '' },
        };
        yield {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'text_delta', text: clean },
        };
        yield { type: 'content_block_stop', index: idx };
      }
    } else if (openTextBlock) {
      // 普通文本：补发已缓冲的内容
      yield {
        type: 'content_block_delta',
        index: openTextBlock.index,
        delta: { type: 'text_delta', text: bufferedText },
      };
      yield { type: 'content_block_stop', index: openTextBlock.index };
      openTextBlock = null;
    } else {
      // 没有 text 块但缓冲了内容：单独开一个 text 块
      const idx = nextIndex++;
      yield {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'text', text: '' },
      };
      yield {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'text_delta', text: bufferedText },
      };
      yield { type: 'content_block_stop', index: idx };
    }
  }
  // 若有残留的 openTextBlock（无内容），关掉
  if (openTextBlock) {
    yield { type: 'content_block_stop', index: openTextBlock.index };
    openTextBlock = null;
  }

  for (const block of toolBlocks.values()) {
    yield { type: 'content_block_stop', index: block.index };
  }

  const anthropicUsage = openAIUsageToAnthropic(usage, options.scale);
  yield {
    type: 'message_delta',
    delta: {
      stop_reason: recoveredToolUse
        ? 'tool_use'
        : (openAIFinishReasonToAnthropic(finishReason) ?? 'end_turn'),
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
