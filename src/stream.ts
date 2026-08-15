import type {
  AnthropicStreamEvent,
  OpenAIFinishReason,
  OpenAIStreamChunk,
  OpenAIUsage,
  StreamConvertOptions,
} from './types.js';
import { anthropicStopReasonToOpenAI } from './stopReason.js';
import { stripControl } from './errors.js';

interface StreamState {
  id: string;
  model: string;
  created: number;
  inputTokens: number;
  /** Anthropic 块 index → OpenAI tool_calls 数组 index */
  toolBlockIndex: Map<number, number>;
  /** message_delta 无 usage 时，用已累积文本长度估算 output_tokens */
  textChars: number;
  /** JSON mode：被转换为 content 的 json_mode 工具块（不暴露 tool_calls） */
  jsonModeBlocks: Set<number>;
  /** JSON mode：每块累积的 arguments（segment 数组，收尾一次 join，避免逐段 `+` 的 O(n²)） */
  jsonModeArgs: Map<number, string[]>;
  /** 流里出现过 json_mode 工具（收尾 finish_reason 用 stop 而非 tool_calls） */
  emittedJsonMode: boolean;
  /** 是否已发出带 finish_reason 的收尾 chunk（防漏发/重复发） */
  emittedFinish: boolean;
}

export interface StreamToOpenAIOptions extends StreamConvertOptions {
  /** 为 true 时 usage 放在独立尾 chunk（choices: []），而非并入 finish chunk。 */
  includeUsage?: boolean;
}

/**
 * Anthropic Messages 流式 SSE 事件 → OpenAI chat.completion.chunk 序列。
 *
 * 事件映射：
 * - message_start → 首 chunk（delta.role='assistant'），并固定整流的 id/model。
 * - content_block_start(text) → 不发（OpenAI 首 chunk 已含 role）。
 * - content_block_start(tool_use) → delta.tool_calls[0]（id + name + arguments:''）。
 * - content_block_delta(text_delta) → delta.content。
 * - content_block_delta(input_json_delta) → delta.tool_calls（arguments 为**增量**
 *   fragment，OpenAI SDK 内部累积拼接；Anthropic 的 partial_json 恰为增量，直接透传）。
 * - content_block_delta(thinking_delta) → delta.reasoning_content（OpenAI/DeepSeek 兼容字段）。
 * - content_block_delta(signature_delta) → 丢弃。
 * - message_delta → 收尾 chunk（delta:{} + finish_reason），usage 默认并入；
 *   includeUsage=true 时 usage 拆到独立尾 chunk（choices:[]）。
 * - ping → 跳过。error → console.warn + 终止 chunk 后结束。
 * - message_stop → 流自然结束（不产出）。
 */
export async function* anthropicStreamToOpenAI(
  events: AsyncIterable<AnthropicStreamEvent>,
  options: StreamToOpenAIOptions = {},
): AsyncGenerator<OpenAIStreamChunk> {
  const state: StreamState = {
    id: options.id ?? `chatcmpl-${genId()}`,
    model: options.model ?? '',
    created: options.created ?? Math.floor(Date.now() / 1000),
    inputTokens: 0,
    toolBlockIndex: new Map(),
    textChars: 0,
    jsonModeBlocks: new Set(),
    jsonModeArgs: new Map(),
    emittedJsonMode: false,
    emittedFinish: false,
  };

  for await (const ev of events) {
    switch (ev.type) {
      case 'message_start': {
        state.id = options.id ?? `chatcmpl-${ev.message.id.replace(/^msg_/, '')}`;
        state.model = options.model ?? ev.message.model;
        state.inputTokens = ev.message.usage.input_tokens ?? 0;
        yield makeChunk(state, { delta: { role: 'assistant', content: '' }, finish_reason: null });
        break;
      }

      case 'content_block_start': {
        if (ev.content_block.type === 'tool_use') {
          if (ev.content_block.name === 'json_mode') {
            // JSON mode：不暴露工具调用，累积参数后转 content；不占用 tool_calls 槽位。
            state.jsonModeBlocks.add(ev.index);
            state.jsonModeArgs.set(ev.index, []);
            break;
          }
          const toolIndex = state.toolBlockIndex.size;
          state.toolBlockIndex.set(ev.index, toolIndex);
          yield makeChunk(state, {
            delta: {
              tool_calls: [
                {
                  index: toolIndex,
                  id: ev.content_block.id,
                  function: { name: ev.content_block.name, arguments: '' },
                },
              ],
            },
            finish_reason: null,
          });
        }
        // text/thinking 块 start：不产出。
        break;
      }

      case 'content_block_delta': {
        if (ev.delta.type === 'text_delta') {
          state.textChars += ev.delta.text.length;
          yield makeChunk(state, { delta: { content: ev.delta.text }, finish_reason: null });
        } else if (ev.delta.type === 'thinking_delta') {
          state.textChars += ev.delta.thinking.length;
          yield makeChunk(state, { delta: { reasoning_content: ev.delta.thinking }, finish_reason: null });
        } else if (ev.delta.type === 'input_json_delta') {
          if (state.jsonModeBlocks.has(ev.index)) {
            // JSON mode：segment 数组累积（收尾一次 join），不产出 tool_calls delta。
            // 逐段 `(get ?? '') + partial_json` 拼接是 O(n²)（M-P2-4）。
            state.jsonModeArgs.get(ev.index)?.push(ev.delta.partial_json);
            state.textChars += ev.delta.partial_json.length;
            break;
          }
          const toolIndex = state.toolBlockIndex.get(ev.index);
          if (toolIndex != null) {
            state.textChars += ev.delta.partial_json.length;
            yield makeChunk(state, {
              delta: {
                tool_calls: [
                  { index: toolIndex, function: { arguments: ev.delta.partial_json } },
                ],
              },
              finish_reason: null,
            });
          }
        }
        // signature_delta：丢弃。
        break;
      }

      case 'content_block_stop': {
        if (state.jsonModeBlocks.has(ev.index)) {
          // JSON mode：块结束，把完整 JSON 作为 content 发出（OpenAI json_object 语义）。
          state.jsonModeBlocks.delete(ev.index);
          state.emittedJsonMode = true;
          const acc = (state.jsonModeArgs.get(ev.index) ?? []).join('');
          state.jsonModeArgs.delete(ev.index);
          let jsonText = acc;
          try {
            jsonText = JSON.stringify(JSON.parse(acc));
          } catch {
            // 畸形参数：按原样输出，避免丢内容。
          }
          yield makeChunk(state, { delta: { content: jsonText }, finish_reason: null });
        }
        break;
      }

      case 'message_delta': {
        // 无 usage 时用已累积文本长度估算 output_tokens，避免 OpenAI 客户端收到 0。
        const outputTokens = ev.usage?.output_tokens ?? Math.ceil(state.textChars / 4);
        const usage: OpenAIUsage = {
          prompt_tokens: state.inputTokens,
          completion_tokens: outputTokens,
          total_tokens: state.inputTokens + outputTokens,
        };
        // JSON mode 收尾用 stop（OpenAI json_object 语义），否则映射上游 stop_reason。
        const finishReason: OpenAIFinishReason = state.emittedJsonMode
          ? 'stop'
          : anthropicStopReasonToOpenAI(ev.delta.stop_reason);
        if (options.includeUsage) {
          // 先发 finish chunk，usage 放独立尾 chunk（choices: []）。
          yield makeChunk(state, {
            delta: {},
            finish_reason: finishReason,
          });
          yield {
            id: state.id,
            object: 'chat.completion.chunk',
            created: state.created,
            model: state.model,
            choices: [],
            usage,
          };
        } else {
          yield makeChunk(
            state,
            { delta: {}, finish_reason: finishReason },
            usage,
          );
        }
        state.emittedFinish = true;
        break;
      }

      case 'ping':
        break;

      case 'error': {
        console.warn(`[anthropicStreamToOpenAI] stream error: ${stripControl(ev.error.message)}`);
        yield makeChunk(state, { delta: {}, finish_reason: 'stop' });
        state.emittedFinish = true;
        return;
      }

      case 'message_stop':
        // 上游漏发 message_delta 时（只有 message_stop）也必须补一个带 finish_reason
        // 的收尾 chunk，否则 OpenAI 客户端拿不到 finish_reason 会一直等或报错。
        if (!state.emittedFinish) {
          yield makeChunk(state, { delta: {}, finish_reason: 'stop' });
          state.emittedFinish = true;
        }
        return;
    }
  }

  // 流被上游直接掐断（既无 message_delta 也无 message_stop）：同样补收尾。
  if (!state.emittedFinish) {
    yield makeChunk(state, { delta: {}, finish_reason: 'stop' });
  }
}

function makeChunk(
  state: StreamState,
  choice: { delta: OpenAIStreamChunk['choices'][number]['delta']; finish_reason: OpenAIStreamChunk['choices'][number]['finish_reason'] },
  usage?: OpenAIUsage,
): OpenAIStreamChunk {
  const chunk: OpenAIStreamChunk = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta: choice.delta, finish_reason: choice.finish_reason }],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

function genId(): string {
  const hex = Math.random().toString(16).slice(2, 14);
  return `${hex}`;
}

/** 把 OpenAI chunk 序列化为 SSE `data: {...}` 行。 */
export function sseStringify(chunk: OpenAIStreamChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * 把 OpenAI chunk 序列包装为 SSE 文本流，结束时补 `data: [DONE]\n\n`。
 */
export async function* openAIStreamToSSE(
  chunks: AsyncIterable<OpenAIStreamChunk>,
): AsyncGenerator<string> {
  for await (const chunk of chunks) {
    yield sseStringify(chunk);
  }
  yield 'data: [DONE]\n\n';
}
