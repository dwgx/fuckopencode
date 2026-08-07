import { describe, expect, it } from 'vitest';
import { normalizeMessages } from '../src/normalize.js';
import { openAIImageToAnthropic } from '../src/image.js';
import type { AnthropicContentBlock, OpenAIMessage } from '../src/types.js';

describe('normalizeMessages reasoning_content → thinking 块', () => {
  it('assistant 的 reasoning_content 转成 thinking 块（多轮工具回传用）', () => {
    const out = normalizeMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '查到了',
        reasoning_content: '我需要先调用工具',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }],
      },
    ]);
    const assistant = out[1]!;
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: '我需要先调用工具' },
      { type: 'text', text: '查到了' },
      { type: 'tool_use', id: 'c1', name: 'a', input: {} },
    ]);
  });

  it('无 reasoning_content 时不产生 thinking 块', () => {
    const out = normalizeMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '好', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] },
    ]);
    const assistant = out[1]!;
    expect(Array.isArray(assistant.content)).toBe(true);
    expect((assistant.content as AnthropicContentBlock[]).some((b) => b.type === 'thinking')).toBe(false);
  });
});

describe('normalizeMessages tool_use id 对应', () => {
  it('assistant tool_call 缺 id 时，tool 消息缺 tool_call_id 复用同一生成的 id', () => {
    const out = normalizeMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: '', type: 'function', function: { name: 'a', arguments: '{}' } }],
      },
      { role: 'tool', content: 'R' },
    ]);
    expect(out).toHaveLength(3);
    const assistant = out[1]!;
    const toolUser = out[2]!;
    const toolUse = assistant.content[0] as Extract<AnthropicContentBlock, { type: 'tool_use' }>;
    const toolResult = (toolUser.content as Extract<AnthropicContentBlock, { type: 'tool_result' }>[])[0]!;
    expect(toolUse.id).toMatch(/^toolu_/);
    // P0：tool_result.tool_use_id 必须与 assistant 的 tool_use.id 一致
    expect(toolResult.tool_use_id).toBe(toolUse.id);
  });

  it('tool 消息缺 tool_call_id 且前面无生成 id 时，自生成并记录', () => {
    const out = normalizeMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'explicit', type: 'function', function: { name: 'a', arguments: '{}' } }],
      },
      { role: 'tool', content: 'R' },
    ]);
    const toolResult = (out[2]!.content as Extract<AnthropicContentBlock, { type: 'tool_result' }>[])[0]!;
    expect(toolResult.tool_use_id).toMatch(/^toolu_/);
  });
});

describe('normalizeMessages 孤立/乱序 tool_result', () => {
  it('孤立 tool_result（前面无 tool_use assistant）被 drop', () => {
    const out = normalizeMessages([
      { role: 'user', content: 'go' },
      { role: 'tool', tool_call_id: 'x', content: 'R' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('user');
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'go' }]);
  });

  it('乱序 tool_result（tool_use 后夹 user 文本）被 drop', () => {
    const out = normalizeMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }],
      },
      { role: 'user', content: '穿插' },
      { role: 'tool', tool_call_id: 'c1', content: 'R' },
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('连续 tool_result 链不被误 drop，且多条结果合并', () => {
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
});

describe('serializeToolResultContent 图片块', () => {
  it('tool_result 的 content 里 image_url 转 image block（保留 text）', () => {
    const out = normalizeMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: [
          { type: 'text', text: '图：' },
          { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
        ],
      },
    ]);
    const toolUser = out[2]!;
    expect(toolUser.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'c1',
        content: [
          { type: 'text', text: '图：' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
        ],
      },
    ]);
  });

  it('tool_result 里私网 image_url 被丢弃（SSRF），空块回落空串', () => {
    const out = normalizeMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: [{ type: 'image_url', image_url: { url: 'http://169.254.169.254/latest/meta-data' } }],
      },
    ]);
    const toolUser = out[2]!;
    const toolResult = (toolUser.content as Extract<AnthropicContentBlock, { type: 'tool_result' }>[])[0]!;
    expect(toolResult.content).toBe('');
  });
});

describe('openAIImageToAnthropic SSRF 防护', () => {
  it('私网/保留/环回 URL 返回 null（不转 url source）', () => {
    expect(openAIImageToAnthropic({ url: 'http://169.254.169.254/latest/meta-data' })).toBeNull();
    expect(openAIImageToAnthropic({ url: 'http://10.0.0.1/x.png' })).toBeNull();
    expect(openAIImageToAnthropic({ url: 'https://127.0.0.1/x.png' })).toBeNull();
    expect(openAIImageToAnthropic({ url: 'https://192.168.1.1/x.png' })).toBeNull();
    expect(openAIImageToAnthropic({ url: 'https://172.16.0.1/x.png' })).toBeNull();
    expect(openAIImageToAnthropic({ url: 'https://172.31.255.255/x.png' })).toBeNull();
    expect(openAIImageToAnthropic({ url: 'http://[::1]/x.png' })).toBeNull();
    expect(openAIImageToAnthropic({ url: 'https://localhost/x.png' })).toBeNull();
    expect(openAIImageToAnthropic({ url: 'http://0.0.0.0/x.png' })).toBeNull();
  });

  it('公网 URL 仍转 url source；data URI 不受影响', () => {
    expect(openAIImageToAnthropic({ url: 'https://example.com/img.png' })).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/img.png' },
    });
    // 172.16/12 范围外（172.32 起）属公网
    expect(openAIImageToAnthropic({ url: 'http://172.32.0.1/x.png' })).toEqual({
      type: 'image',
      source: { type: 'url', url: 'http://172.32.0.1/x.png' },
    });
    expect(openAIImageToAnthropic({ url: 'data:image/png;base64,AAAA' })).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });
});

describe('normalizeMessages 多条缺 id tool_calls FIFO', () => {
  it('多条 tool_use 缺 id 时，tool 结果按 FIFO 一一对应（不复用同一 id）', () => {
    const out = normalizeMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: '', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: '', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'R1' },
      { role: 'tool', content: 'R2' },
    ]);
    const assistant = out[1]!;
    const toolUser = out[2]!;
    const toolUses = assistant.content as Extract<AnthropicContentBlock, { type: 'tool_use' }>[];
    const toolResults = toolUser.content as Extract<AnthropicContentBlock, { type: 'tool_result' }>[];
    expect(toolUses).toHaveLength(2);
    expect(toolUses[0]!.id).not.toBe(toolUses[1]!.id);
    // FIFO：首条 tool 结果对应第一个 tool_use，第二条对应第二个
    expect(toolResults.map((r) => r.tool_use_id)).toEqual([toolUses[0]!.id, toolUses[1]!.id]);
  });

  it('队列耗尽后缺 tool_call_id 才新生成（不回用已消费的 id）', () => {
    const out = normalizeMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: '', type: 'function', function: { name: 'a', arguments: '{}' } }],
      },
      { role: 'tool', content: 'R1' },
      { role: 'tool', content: 'R2' },
    ]);
    const toolUser = out[2]!;
    const toolResults = toolUser.content as Extract<AnthropicContentBlock, { type: 'tool_result' }>[];
    expect(toolResults).toHaveLength(2);
    // 首条对应生成的 tool_use id；第二条队列已空，必须新生成而非复用
    expect(toolResults[0]!.tool_use_id).not.toBe(toolResults[1]!.tool_use_id);
  });
});

describe('normalizeMessages 空 assistant', () => {
  it('content 空串且无 tool_calls 的 assistant 被跳过，两侧 user 正常合并', () => {
    const out = normalizeMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'next' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user']);
    expect(out[0]!.content).toEqual([
      { type: 'text', text: 'go' },
      { type: 'text', text: 'next' },
    ]);
  });

  it('content 空数组且无 tool_calls 的 assistant 被跳过', () => {
    const out = normalizeMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('user');
  });
});

describe('normalizeMessages 丢弃开头 assistant 后的孤立 tool_result', () => {
  it('开头 assistant（含 tool_use）+ tool_result user：两者均丢弃', () => {
    const out = normalizeMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'R' },
      { role: 'user', content: '真正开头' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user']);
    expect(out[0]!.content).toEqual([{ type: 'text', text: '真正开头' }]);
  });

  it('开头 assistant + 普通 user 时仅丢 assistant，保留普通 user', () => {
    const out = normalizeMessages([
      { role: 'assistant', content: '开头' },
      { role: 'user', content: 'A' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user']);
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'A' }]);
  });
});
