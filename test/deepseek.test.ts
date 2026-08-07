import { describe, expect, it } from 'vitest';
import {
  normalizeAnthropicRequest,
  resolveModelName,
  filterThinkingFromStream,
  DEFAULT_FALLBACK_MODEL,
} from '../src/deepseek.js';
import type { AnthropicStreamEvent } from '../src/types.js';

const EMPTY_MAP: Record<string, string> = {};

/** 数组 → AsyncIterable。 */
function iter<T>(arr: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const x of arr) yield x;
    },
  };
}

describe('resolveModelName', () => {
  it('命中映射返回映射值', () => {
    expect(resolveModelName('gpt-4o', { 'gpt-4o': 'deepseek-v4-flash' }, DEFAULT_FALLBACK_MODEL)).toBe('deepseek-v4-flash');
  });

  it('未命中回落 fallback（opencodezen 只认 deepseek-v4-flash）', () => {
    expect(resolveModelName('claude-opus-4-6', EMPTY_MAP, DEFAULT_FALLBACK_MODEL)).toBe('deepseek-v4-flash');
  });
});

describe('normalizeAnthropicRequest', () => {
  it('thinking adaptive + budget_tokens → enabled，去掉 budget_tokens', () => {
    const out = normalizeAnthropicRequest(
      { model: 'claude-opus-4-6', thinking: { type: 'adaptive', budget_tokens: 1024 } },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect(out.model).toBe('deepseek-v4-flash');
    expect(out.thinking).toEqual({ type: 'enabled' });
  });

  it('thinking disabled 保留', () => {
    const out = normalizeAnthropicRequest(
      { model: 'm', thinking: { type: 'disabled' } },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect(out.thinking).toEqual({ type: 'disabled' });
  });

  it('thinking enabled 保留 type 但去 budget_tokens', () => {
    const out = normalizeAnthropicRequest(
      { model: 'm', thinking: { type: 'enabled', budget_tokens: 4096 } },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect(out.thinking).toEqual({ type: 'enabled' });
  });

  it('未知 thinking 形态删除', () => {
    const out = normalizeAnthropicRequest(
      { model: 'm', thinking: 'custom-mode' },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect('thinking' in out).toBe(false);
  });

  it('reasoning_effort → output_config.effort', () => {
    const out = normalizeAnthropicRequest(
      { model: 'm', reasoning_effort: 'high' },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect(out.output_config).toEqual({ effort: 'high' });
    expect('reasoning_effort' in out).toBe(false);
  });

  it('不污染入参（深拷贝）', () => {
    const input = { model: 'claude-opus-4-6', thinking: { type: 'adaptive', budget_tokens: 1024 } };
    const out = normalizeAnthropicRequest(input, EMPTY_MAP, DEFAULT_FALLBACK_MODEL);
    expect(out).not.toBe(input);
    expect(input.model).toBe('claude-opus-4-6');
    expect((input.thinking as { type: string }).type).toBe('adaptive');
  });

  it('非法 body 抛错', () => {
    expect(() => normalizeAnthropicRequest('nope', EMPTY_MAP, DEFAULT_FALLBACK_MODEL)).toThrow();
    expect(() => normalizeAnthropicRequest(null, EMPTY_MAP, DEFAULT_FALLBACK_MODEL)).toThrow();
  });

  it('thinking enabled + tool_use assistant 缺 thinking 块时注入空块', () => {
    const out = normalizeAnthropicRequest(
      {
        model: 'm',
        thinking: { type: 'enabled' },
        messages: [
          { role: 'user', content: '查一下' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'search', input: {} }],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '结果' }] },
        ],
      },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    const messages = out.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const assistant = messages[1]!;
    expect(assistant.content[0]).toEqual({ type: 'thinking', thinking: '', signature: '' });
    expect(assistant.content[1]).toEqual({ type: 'tool_use', id: 't1', name: 'search', input: {} });
  });

  it('thinking enabled + 已有 thinking 块时不重复注入', () => {
    const out = normalizeAnthropicRequest(
      {
        model: 'm',
        thinking: { type: 'enabled' },
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '想过了', signature: 'sig' },
              { type: 'tool_use', id: 't1', name: 'a', input: {} },
            ],
          },
        ],
      },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    const messages = out.messages as Array<{ content: Array<{ type: string }> }>;
    const assistant = messages[0]!;
    expect(assistant.content.filter((b) => b.type === 'thinking')).toHaveLength(1);
  });

  it('thinking disabled 时不注入 thinking 块', () => {
    const out = normalizeAnthropicRequest(
      {
        model: 'm',
        thinking: { type: 'disabled' },
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'a', input: {} }],
          },
        ],
      },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    const messages = out.messages as Array<{ content: Array<{ type: string }> }>;
    const assistant = messages[0]!;
    expect(assistant.content.some((b) => b.type === 'thinking')).toBe(false);
  });
});

describe('filterThinkingFromStream', () => {
  async function collect(keep: boolean): Promise<AnthropicStreamEvent[]> {
    const events: AnthropicStreamEvent[] = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答案' } },
      { type: 'content_block_stop', index: 1 },
    ];
    const out: AnthropicStreamEvent[] = [];
    for await (const ev of filterThinkingFromStream(iter(events), keep)) out.push(ev);
    return out;
  }

  it('keepThinking=false：剥掉 thinking 块相关事件，保留 text', async () => {
    const events = await collect(false);
    expect(events).toHaveLength(3);
    expect(events).toEqual([
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答案' } },
      { type: 'content_block_stop', index: 1 },
    ]);
  });

  it('keepThinking=true：原样透传', async () => {
    const events = await collect(true);
    expect(events).toHaveLength(7);
  });
});
