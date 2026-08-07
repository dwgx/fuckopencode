import { describe, expect, it } from 'vitest';
import { anthropicToOpenAIResponse } from '../src/response.js';
import { anthropicStopReasonToOpenAI } from '../src/stopReason.js';
import { anthropicUsageToOpenAI } from '../src/usage.js';
import type { AnthropicResponse } from '../src/types.js';
import { anthropicResponse } from './fixtures.js';

describe('anthropicToOpenAIResponse', () => {
  it('包 OpenAI 外壳并映射 usage', () => {
    const out = anthropicToOpenAIResponse(anthropicResponse, { created: 1000 });
    expect(out).toEqual({
      id: 'msg_abc123',
      object: 'chat.completion',
      created: 1000,
      model: 'claude-3-5-sonnet',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '以下是结果：',
            tool_calls: [
              {
                id: 'toolu_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"上海"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
  });

  it('纯文本响应时 content 为字符串、无 tool_calls', () => {
    const res: AnthropicResponse = {
      ...anthropicResponse,
      content: [{ type: 'text', text: '你好' }],
      stop_reason: 'end_turn',
    };
    const out = anthropicToOpenAIResponse(res, { created: 1000 });
    expect(out.choices[0]!.message.content).toBe('你好');
    expect(out.choices[0]!.message.tool_calls).toBeUndefined();
    expect(out.choices[0]!.finish_reason).toBe('stop');
  });

  it('thinking 块拼接为 reasoning_content，不污染 content', () => {
    const res: AnthropicResponse = {
      ...anthropicResponse,
      content: [
        { type: 'thinking', thinking: '内部推理', signature: 'sig' },
        { type: 'text', text: '答案' },
      ],
      stop_reason: 'end_turn',
    };
    const out = anthropicToOpenAIResponse(res, { created: 1000 });
    expect(out.choices[0]!.message.reasoning_content).toBe('内部推理');
    expect(out.choices[0]!.message.content).toBe('答案');
  });

  it('多个 thinking 块按序 join 为 reasoning_content', () => {
    const res: AnthropicResponse = {
      ...anthropicResponse,
      content: [
        { type: 'thinking', thinking: '推理A', signature: 's1' },
        { type: 'thinking', thinking: '推理B', signature: 's2' },
        { type: 'text', text: '答案' },
      ],
      stop_reason: 'end_turn',
    };
    const out = anthropicToOpenAIResponse(res);
    expect(out.choices[0]!.message.reasoning_content).toBe('推理A推理B');
    expect(out.choices[0]!.message.content).toBe('答案');
  });

  it('model 回显客户端请求的模型名（options.model 优先）', () => {
    const out = anthropicToOpenAIResponse(anthropicResponse, { model: 'gpt-4o' });
    expect(out.model).toBe('gpt-4o');
  });

  it('未传 model 时沿用上游 Anthropic 模型名', () => {
    const out = anthropicToOpenAIResponse(anthropicResponse);
    expect(out.model).toBe('claude-3-5-sonnet');
  });

  it('无 content 仅 tool_use 时 content 为 null', () => {
    const res: AnthropicResponse = {
      ...anthropicResponse,
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'a', input: { x: 1 } }],
      stop_reason: 'tool_use',
    };
    const out = anthropicToOpenAIResponse(res, { created: 1000 });
    expect(out.choices[0]!.message.content).toBeNull();
    expect(out.choices[0]!.message.tool_calls).toHaveLength(1);
  });

  it('输入为空对象时 arguments 序列化为 {}', () => {
    const res: AnthropicResponse = {
      ...anthropicResponse,
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'a', input: {} }],
      stop_reason: 'tool_use',
    };
    const out = anthropicToOpenAIResponse(res, { created: 1000 });
    expect(out.choices[0]!.message.tool_calls![0]!.function.arguments).toBe('{}');
  });

  it('stop_reason 全映射正确', () => {
    expect(anthropicStopReasonToOpenAI('end_turn')).toBe('stop');
    expect(anthropicStopReasonToOpenAI('max_tokens')).toBe('length');
    expect(anthropicStopReasonToOpenAI('stop_sequence')).toBe('stop');
    expect(anthropicStopReasonToOpenAI('tool_use')).toBe('tool_calls');
    expect(anthropicStopReasonToOpenAI('refusal')).toBe('content_filter');
    expect(anthropicStopReasonToOpenAI(null)).toBe('stop');
  });

  it('覆盖 id 生效', () => {
    const out = anthropicToOpenAIResponse(anthropicResponse, { id: 'chatcmpl-x', created: 1000 });
    expect(out.id).toBe('chatcmpl-x');
  });

  it('json_mode 工具调用转成 content + finish_reason=stop（OpenAI json_object 语义）', () => {
    const res: AnthropicResponse = {
      ...anthropicResponse,
      content: [{ type: 'tool_use', id: 'toolu_json', name: 'json_mode', input: { ok: true } }],
      stop_reason: 'tool_use',
    };
    const out = anthropicToOpenAIResponse(res);
    expect(out.choices[0]!.message.content).toBe('{"ok":true}');
    expect(out.choices[0]!.message.tool_calls).toBeUndefined();
    expect(out.choices[0]!.finish_reason).toBe('stop');
  });

  it('非 json_mode 工具调用保持 tool_calls + finish_reason=tool_calls', () => {
    const res: AnthropicResponse = {
      ...anthropicResponse,
      content: [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: '北京' } }],
      stop_reason: 'tool_use',
    };
    const out = anthropicToOpenAIResponse(res);
    expect(out.choices[0]!.message.tool_calls).toHaveLength(1);
    expect(out.choices[0]!.message.tool_calls![0]!.function.name).toBe('get_weather');
    expect(out.choices[0]!.finish_reason).toBe('tool_calls');
  });

  it('usage 的 thinking_tokens 映射到 OpenAI reasoning_tokens', () => {
    const res: AnthropicResponse = {
      ...anthropicResponse,
      content: [{ type: 'text', text: '答案' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 25, output_tokens_details: { thinking_tokens: 5 } },
    };
    const out = anthropicToOpenAIResponse(res);
    expect(out.usage.completion_tokens_details).toEqual({ reasoning_tokens: 5 });
    expect(out.usage.completion_tokens).toBe(25); // thinking 已计入 output，不额外加
  });
});

describe('anthropicUsageToOpenAI thinking_tokens → reasoning_tokens', () => {
  it('output_tokens_details.thinking_tokens 透传为 completion_tokens_details.reasoning_tokens', () => {
    const out = anthropicUsageToOpenAI({
      input_tokens: 10,
      output_tokens: 25,
      output_tokens_details: { thinking_tokens: 5 },
    });
    expect(out.completion_tokens_details).toEqual({ reasoning_tokens: 5 });
    expect(out.completion_tokens).toBe(25);
    expect(out.total_tokens).toBe(35);
  });

  it('无 thinking_tokens 时不下发 completion_tokens_details', () => {
    const out = anthropicUsageToOpenAI({ input_tokens: 10, output_tokens: 20 });
    expect(out.completion_tokens_details).toBeUndefined();
  });
});
