import type {
  AnthropicResponse,
  AnthropicStreamEvent,
  OpenAIChatRequest,
} from '../src/types.js';

/** 数组 → AsyncIterable，用于喂流式转换器。 */
export function iter<T>(arr: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const x of arr) yield x;
    },
  };
}

/** 含 system、图片、工具、连续 user 的典型 OpenAI 请求。 */
export const richOpenAIRequest: OpenAIChatRequest = {
  model: 'gpt-4o',
  stream: true,
  temperature: 0.3,
  max_tokens: 500,
  stop: ['END'],
  frequency_penalty: 1.2,
  n: 2,
  messages: [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '第一问' },
    { role: 'user', content: '第二问' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"上海"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '晴' },
    { role: 'user', content: '谢谢' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '获取天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    },
  ],
  tool_choice: { type: 'function', function: { name: 'get_weather' } },
};

/** 含 text + tool_use 的 Anthropic 非流式响应。 */
export const anthropicResponse: AnthropicResponse = {
  id: 'msg_abc123',
  type: 'message',
  role: 'assistant',
  model: 'claude-3-5-sonnet',
  content: [
    { type: 'text', text: '以下是结果：' },
    { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '上海' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 20 },
};

/** 典型 text 流事件序列。 */
export const textStreamEvents: AnthropicStreamEvent[] = [
  {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-x',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
];

/** 工具调用流事件序列（input_json_delta 增量）。 */
export const toolStreamEvents: AnthropicStreamEvent[] = [
  {
    type: 'message_start',
    message: {
      id: 'msg_t',
      type: 'message',
      role: 'assistant',
      model: 'claude-x',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 0 },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ci' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ty":"上海"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } },
  { type: 'message_stop' },
];
