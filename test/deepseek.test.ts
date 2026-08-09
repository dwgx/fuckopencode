import { describe, expect, it } from 'vitest';
import {
  normalizeAnthropicRequest,
  resolveModelName,
  filterThinkingFromStream,
  DEFAULT_FALLBACK_MODEL,
  ALLOWED_MODELS,
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

describe('模型白名单（只放行 DeepSeek V4 两个变体）', () => {
  it('白名单就是这两个', () => {
    expect([...ALLOWED_MODELS].sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash-free']);
  });

  it('两个允许的模型直传', () => {
    for (const m of ['deepseek-v4-flash', 'deepseek-v4-flash-free']) {
      expect(resolveModelName(m, {}, 'deepseek-v4-flash')).toBe(m);
    }
  });

  it('Claude Code 发的 claude-* 被回落，不透传给上游', () => {
    for (const m of ['claude-sonnet-4-6', 'claude-opus-5', 'claude-haiku-4-5']) {
      expect(resolveModelName(m, {}, 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
    }
  });

  it('其他上游模型（gpt/glm/kimi）也被拦下回落', () => {
    for (const m of ['gpt-5.5', 'glm-5.2', 'kimi-k3', 'deepseek-v4-pro']) {
      expect(resolveModelName(m, {}, 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
    }
  });

  it('MODEL_MAP 映射到白名单外的值同样被拦（防配错绕过）', () => {
    expect(resolveModelName('x', { x: 'claude-opus-5' }, 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(resolveModelName('x', { x: 'deepseek-v4-flash-free' }, 'deepseek-v4-flash')).toBe('deepseek-v4-flash-free');
  });

  it('fallback 本身非法时强制回到 flash', () => {
    expect(resolveModelName('zzz', {}, 'claude-opus-5')).toBe('deepseek-v4-flash');
  });
});

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

  it('max_tokens 下限保护：thinking 非 disabled 时 < 4096 抬到 4096', () => {
    const out = normalizeAnthropicRequest(
      { model: 'm', thinking: { type: 'enabled' }, max_tokens: 200 },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect(out.max_tokens).toBe(4096);
  });

  it('adaptive thinking 归一化后同样抬升 max_tokens', () => {
    const out = normalizeAnthropicRequest(
      { model: 'm', thinking: { type: 'adaptive' }, max_tokens: 30 },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect(out.max_tokens).toBe(4096);
  });

  it('thinking enabled 且缺失 max_tokens 时补 4096', () => {
    const out = normalizeAnthropicRequest(
      { model: 'm', thinking: { type: 'enabled' } },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect(out.max_tokens).toBe(4096);
  });

  it('max_tokens ≥ 4096 时保持', () => {
    const out = normalizeAnthropicRequest(
      { model: 'm', thinking: { type: 'enabled' }, max_tokens: 5000 },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect(out.max_tokens).toBe(5000);
  });

  it('thinking disabled 时不抬升 max_tokens', () => {
    const out = normalizeAnthropicRequest(
      { model: 'm', thinking: { type: 'disabled' }, max_tokens: 100 },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect(out.max_tokens).toBe(100);
  });

  it('thinking disabled 且缺失 max_tokens 时不补', () => {
    const out = normalizeAnthropicRequest(
      { model: 'm', thinking: { type: 'disabled' } },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect('max_tokens' in out).toBe(false);
  });

  // opencode Zen 只认内容块数组，收到 content 字符串会报 "Empty input messages"。
  it('content 字符串转成内容块数组', () => {
    const out = normalizeAnthropicRequest(
      { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect(out.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('已是内容块数组时保持不变', () => {
    const blocks = [{ type: 'text', text: 'hi' }];
    const out = normalizeAnthropicRequest(
      { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: blocks }] },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect((out.messages as Array<{ content: unknown }>)[0]!.content).toEqual(blocks);
  });

  it('空字符串 content 不转（转成空数组会再次触发 Empty input messages）', () => {
    const out = normalizeAnthropicRequest(
      { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: '' }] },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect((out.messages as Array<{ content: unknown }>)[0]!.content).toBe('');
  });

  it('多条消息都转，assistant 与 user 一致处理', () => {
    const out = normalizeAnthropicRequest(
      {
        model: 'm',
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect(out.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    ]);
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
