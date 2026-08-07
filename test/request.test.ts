import { describe, expect, it } from 'vitest';
import { openAIToAnthropicRequest } from '../src/request.js';
import { extractSystem, normalizeMessages } from '../src/normalize.js';
import type { OpenAIMessage } from '../src/types.js';
import { richOpenAIRequest } from './fixtures.js';

describe('openAIToAnthropicRequest', () => {
  it('把 system 提取到顶层字段，不进 messages 数组', () => {
    const out = openAIToAnthropicRequest({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: '规则A' }, { role: 'user', content: 'hi' }],
    });
    expect(out.system).toBe('规则A');
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.role).toBe('user');
  });

  it('合并多条 system 消息为顶层字符串', () => {
    const out = openAIToAnthropicRequest({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: '规则A' },
        { role: 'user', content: 'x' },
        { role: 'system', content: '规则B' },
      ],
    });
    expect(out.system).toBe('规则A\n规则B');
  });

  it('max_tokens 缺省时为 8192（Anthropic 必填）', () => {
    const out = openAIToAnthropicRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(out.max_tokens).toBe(8192);
  });

  it('保留显式 max_tokens', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.max_tokens).toBe(100);
  });

  it('丢弃 Anthropic 不支持的参数（frequency_penalty/n）', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      frequency_penalty: 1.2,
      n: 2,
      seed: 42,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect('frequency_penalty' in out).toBe(false);
    expect('n' in out).toBe(false);
    expect('seed' in out).toBe(false);
  });

  it('stop 字符串转 stop_sequences 数组', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      stop: 'END',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.stop_sequences).toEqual(['END']);
  });

  it('tools 扁平化为 input_schema', () => {
    const out = openAIToAnthropicRequest(richOpenAIRequest);
    expect(out.tools).toEqual([
      {
        name: 'get_weather',
        description: '获取天气',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
  });

  it('tool_choice 对象映射为 {type:tool,name}', () => {
    const out = openAIToAnthropicRequest(richOpenAIRequest);
    expect(out.tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
  });

  it('tool_choice 字符串映射', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      tool_choice: 'required',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.tool_choice).toEqual({ type: 'any' });
  });

  it('连续 user 消息合并为一条', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'A' }, { role: 'user', content: 'B' }],
    });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.content).toEqual([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]);
  });

  it('以 assistant 结尾时追加 user 占位', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }],
    });
    expect(out.messages).toHaveLength(3);
    const last = out.messages[out.messages.length - 1]!;
    expect(last.role).toBe('user');
  });

  it('以 assistant 开头时丢弃该条', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'assistant', content: '开头' }, { role: 'user', content: 'A' }],
    });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.role).toBe('user');
  });

  it('tool 消息转 tool_result 且紧跟 tool_use；后续 user 不合并', () => {
    const out = openAIToAnthropicRequest(richOpenAIRequest);
    const assistant = out.messages.find((m) => m.role === 'assistant')!;
    const toolResultIdx = out.messages.findIndex(
      (m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
    );
    expect(toolResultIdx).toBe(out.messages.indexOf(assistant) + 1);
    const toolResultUser = out.messages[toolResultIdx]!;
    expect(toolResultUser.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: '晴' },
    ]);
    // 后续 user('谢谢') 与 tool_result 不合并
    const after = out.messages[toolResultIdx + 1]!;
    expect(after.role).toBe('user');
    expect(after.content).toEqual([{ type: 'text', text: '谢谢' }]);
  });

  it('多条 tool 结果合并进一条 user 消息', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'R1' },
      { role: 'tool', tool_call_id: 'c2', content: 'R2' },
    ];
    const out = normalizeMessages(messages);
    expect(out).toHaveLength(3);
    const toolUser = out[2]!;
    expect(toolUser.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'R1' },
      { type: 'tool_result', tool_use_id: 'c2', content: 'R2' },
    ]);
  });

  it('tool_calls 的 arguments 解析为对象 input；畸形时保持空对象', () => {
    const out = normalizeMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{"x":1}' } }],
      },
    ]);
    const assistant = out[1]!;
    expect(assistant.content).toEqual([
      { type: 'tool_use', id: 'c1', name: 'a', input: { x: 1 } },
    ]);

    const bad = normalizeMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 'a', arguments: 'not-json' } }],
      },
    ]);
    const badAssistant = bad[1]!;
    expect(badAssistant.content).toEqual([
      { type: 'tool_use', id: 'c2', name: 'a', input: {} },
    ]);
  });

  it('data URI 图片转 base64 image block', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
        },
      ],
    });
    const user = out.messages[0]!;
    expect(user.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('http 图片转 url image block', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.png' } }],
        },
      ],
    });
    const user = out.messages[0]!;
    expect(user.content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } },
    ]);
  });

  it('空 user 消息被跳过；只有 system 时保底一条 user', () => {
    expect(extractSystem([{ role: 'system', content: 's' }])).toBe('s');
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: '' }],
    });
    expect(out.messages.length).toBeGreaterThan(0);
    expect(out.messages[0]!.role).toBe('user');
  });

  it('mapModel 钩子生效', () => {
    const out = openAIToAnthropicRequest(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      { mapModel: (m) => (m === 'gpt-4o' ? 'claude-3-5-sonnet' : m) },
    );
    expect(out.model).toBe('claude-3-5-sonnet');
  });

  it('response_format json_schema 注入 json_mode 工具并强制 tool_choice', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'res', schema: { type: 'object', properties: { a: { type: 'string' } } } },
      },
    });
    expect(out.tools).toEqual([
      {
        name: 'json_mode',
        description: 'Respond with JSON matching the given schema',
        input_schema: { type: 'object', properties: { a: { type: 'string' } } },
      },
    ]);
    expect(out.tool_choice).toEqual({ type: 'tool', name: 'json_mode' });
  });

  it('response_format json_object 注入 json_mode 工具且 schema 为 {type:object}', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });
    expect(out.tools).toEqual([
      { name: 'json_mode', description: 'Respond with JSON matching the given schema', input_schema: { type: 'object' } },
    ]);
    expect(out.tool_choice).toEqual({ type: 'tool', name: 'json_mode' });
  });

  it('json_mode 工具追加到已有 tools，不覆盖原 tool_choice 之外逻辑', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      response_format: { type: 'json_object' },
    });
    expect(out.tools?.map((t) => t.name)).toEqual(['get_weather', 'json_mode']);
  });

  it('json_schema 无 schema 时不注入 json_mode 工具', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_schema' },
    });
    expect(out.tools).toBeUndefined();
  });

  it('response_format 时强制 thinking disabled（deepseek 拒绝 thinking+强制 tool_choice）', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });
    expect(out.thinking).toEqual({ type: 'disabled' });
    expect(out.tool_choice).toEqual({ type: 'tool', name: 'json_mode' });
  });

  it('无 response_format 时 thinking 不注入', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.thinking).toBeUndefined();
  });

  it('max_tokens 缺省时回退 max_completion_tokens', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      max_completion_tokens: 321,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.max_tokens).toBe(321);
  });

  it('parallel_tool_calls:false 合并 disable_parallel_tool_use 进 tool_choice', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'a', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });
    expect(out.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });

  it('parallel_tool_calls:false 无 tool_choice 且有 tools 时补 auto + disable_parallel', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'a', parameters: { type: 'object' } } }],
      parallel_tool_calls: false,
    });
    expect(out.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });

  it('tool_choice none 且无 tools 时不下发 tool_choice', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'none',
    });
    expect(out.tool_choice).toBeUndefined();
  });

  it('stop 数组剔除纯空白项', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stop: ['END', '  ', '', '\t'],
    });
    expect(out.stop_sequences).toEqual(['END']);
  });

  it('reasoning_effort 映射到 Anthropic 顶层字段', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      reasoning_effort: 'medium',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.reasoning_effort).toBe('medium');
  });

  it('response_format 时 reasoning_effort 不映射（避免与 thinking disabled 冲突）', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.thinking).toEqual({ type: 'disabled' });
  });

  it('多轮工具启用 thinking 时带 budget_tokens', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'R' },
      ],
    });
    expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });

  it('disable_parallel_tool_use 不并入 {type:tool} tool_choice', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'a', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'a' } },
      parallel_tool_calls: false,
    });
    expect(out.tool_choice).toEqual({ type: 'tool', name: 'a' });
  });

  it('tool_choice any 时忽略 parallel_tool_calls:false', () => {
    const out = openAIToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'a', parameters: { type: 'object' } } }],
      tool_choice: 'required',
      parallel_tool_calls: false,
    });
    expect(out.tool_choice).toEqual({ type: 'any' });
  });

  it('temperature 超出 [0,1] 被钳制', () => {
    const req = (temperature: number) =>
      openAIToAnthropicRequest({ model: 'm', temperature, messages: [{ role: 'user', content: 'hi' }] });
    expect(req(2).temperature).toBe(1);
    expect(req(-0.5).temperature).toBe(0);
    expect(req(0.5).temperature).toBe(0.5);
  });
});
