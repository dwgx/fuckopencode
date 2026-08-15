import { describe, expect, it } from 'vitest';
import {
  normalizeAnthropicRequest,
  resolveModel,
  resolveModelName,
  filterThinkingFromStream,
  DEFAULT_FALLBACK_MODEL,
  ALLOWED_MODELS,
  resolveUpstreamBaseUrl,
} from '../src/deepseek.js';
import { compactMessages } from '../src/compact.js';
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

/** 递归冻结对象/数组：normalize 若原地改写入参，在 strict 模式会抛 TypeError。 */
function deepFreeze<T>(obj: T): T {
  if (obj == null || typeof obj !== 'object') return obj;
  for (const key of Object.keys(obj as object)) {
    deepFreeze((obj as Record<string, unknown>)[key]);
  }
  return Object.freeze(obj) as T;
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

describe('resolveModel（全局模型门：白名单外明确拒绝）', () => {
  it('白名单内直传 ok', () => {
    expect(resolveModel('deepseek-v4-flash', {}, 'deepseek-v4-flash')).toEqual({ ok: true, model: 'deepseek-v4-flash' });
    expect(resolveModel('deepseek-v4-flash-free', {}, 'deepseek-v4-flash')).toEqual({ ok: true, model: 'deepseek-v4-flash-free' });
  });

  it('白名单外 → not-allowed（不再回落 flash —— 核心）', () => {
    // 这些名字在旧行为里会静默回落 flash；现在必须明确拒绝。
    for (const m of ['claude-sonnet-4-6', 'claude-opus-5', 'gpt-5.5', 'glm-5.2', 'kimi-k3', 'deepseek-v4-pro']) {
      expect(resolveModel(m, {}, 'deepseek-v4-flash'), m).toEqual({ ok: false, reason: 'not-allowed' });
    }
  });

  it('alias 映射进白名单 → ok；映射到白名单外值 → not-allowed（防配错绕过）', () => {
    expect(resolveModel('gpt-4o', { 'gpt-4o': 'deepseek-v4-flash' }, 'deepseek-v4-flash')).toEqual({ ok: true, model: 'deepseek-v4-flash' });
    expect(resolveModel('x', { x: 'claude-opus-5' }, 'deepseek-v4-flash')).toEqual({ ok: false, reason: 'not-allowed' });
  });

  it('缺省/空 → fallback（fallback 是唯一允许的回落场景）', () => {
    expect(resolveModel(undefined, {}, 'deepseek-v4-flash')).toEqual({ ok: true, model: 'deepseek-v4-flash' });
    expect(resolveModel('', {}, 'deepseek-v4-flash')).toEqual({ ok: true, model: 'deepseek-v4-flash' });
    expect(resolveModel('   ', {}, 'deepseek-v4-flash')).toEqual({ ok: true, model: 'deepseek-v4-flash' });
    // fallback 本身非法时强制回 flash（与 resolveModelName 旧行为一致）。
    expect(resolveModel(undefined, {}, 'claude-opus-5')).toEqual({ ok: true, model: 'deepseek-v4-flash' });
  });

  it('目录门：knownModels 非空且不在其中 → not-in-catalog', () => {
    // 白名单模型但订阅端点目录里没有（如只拉到了按量模型的目录）。
    expect(resolveModel('deepseek-v4-flash', {}, 'deepseek-v4-flash', new Set(['glm-5.2']))).toEqual({
      ok: false,
      reason: 'not-in-catalog',
    });
  });

  it('目录门：目录空/未加载 → 跳过（fail-open）', () => {
    expect(resolveModel('deepseek-v4-flash', {}, 'deepseek-v4-flash', new Set())).toEqual({ ok: true, model: 'deepseek-v4-flash' });
    expect(resolveModel('deepseek-v4-flash', {}, 'deepseek-v4-flash', undefined)).toEqual({ ok: true, model: 'deepseek-v4-flash' });
  });

  it('-free 豁免目录门（按量变体不在订阅端点目录）', () => {
    expect(resolveModel('deepseek-v4-flash-free', {}, 'deepseek-v4-flash', new Set(['deepseek-v4-flash']))).toEqual({
      ok: true,
      model: 'deepseek-v4-flash-free',
    });
  });

  it('resolveModelName 仍是兼容封装：白名单外回落 fallback（旧行为不变）', () => {
    expect(resolveModelName('claude-opus-4-6', {}, 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(resolveModelName('claude-opus-4-6', {}, 'claude-opus-5')).toBe('deepseek-v4-flash');
  });

  it('自定义 allowedModels：硬底线外模型放行（扩展全局白名单后 resolveModel 门开）', () => {
    const expanded = new Set(['deepseek-v4-flash', 'deepseek-v4-flash-free', 'claude-opus-5', 'gpt-5.5']);
    expect(resolveModel('claude-opus-5', {}, 'deepseek-v4-flash', undefined, expanded)).toEqual({
      ok: true,
      model: 'claude-opus-5',
    });
    expect(resolveModel('gpt-5.5', {}, 'deepseek-v4-flash', undefined, expanded)).toEqual({ ok: true, model: 'gpt-5.5' });
    // 仍拒绝扩展集外的模型（含默认 fallback 之外的）。
    expect(resolveModel('glm-5.2', {}, 'deepseek-v4-flash', undefined, expanded)).toEqual({
      ok: false,
      reason: 'not-allowed',
    });
  });

  it('自定义 allowedModels：默认模型不受影响（默认集是 ALLOWED_MODELS 超集）', () => {
    const expanded = new Set(['claude-opus-5']);
    expect(resolveModel('claude-opus-5', {}, 'deepseek-v4-flash', undefined, expanded)).toEqual({
      ok: true,
      model: 'claude-opus-5',
    });
    expect(resolveModel('deepseek-v4-flash', {}, 'deepseek-v4-flash', undefined, expanded)).toEqual({
      ok: false,
      reason: 'not-allowed',
    });
  });

  it('自定义 allowedModels 下目录门只对代码默认模型生效（添加模型透传上游）', () => {
    // claude-opus-5 是用户添加的（∉ ALLOWED_MODELS）：跳过目录门，即使 catalog 不含它。
    const expanded = new Set(['deepseek-v4-flash', 'claude-opus-5']);
    expect(resolveModel('claude-opus-5', {}, 'deepseek-v4-flash', new Set(['deepseek-v4-flash']), expanded)).toEqual({
      ok: true,
      model: 'claude-opus-5',
    });
    // deepseek-v4-flash 是代码默认模型：目录门仍生效。
    expect(resolveModel('deepseek-v4-flash', {}, 'deepseek-v4-flash', new Set(['claude-opus-5']), expanded)).toEqual({
      ok: false,
      reason: 'not-in-catalog',
    });
  });

  it('resolveModelName 传自定义 allowedModels：扩展集内模型直传，不再回落 fallback', () => {
    const expanded = new Set(['claude-opus-5', 'deepseek-v4-flash']);
    expect(resolveModelName('claude-opus-5', {}, 'deepseek-v4-flash', undefined, expanded)).toBe('claude-opus-5');
    expect(resolveModelName('gpt-5.5', {}, 'deepseek-v4-flash', undefined, expanded)).toBe('deepseek-v4-flash');
  });

  it('normalizeAnthropicRequest 传自定义 allowedModels：添加的模型不被静默改写为 fallback', () => {
    const expanded = new Set(['claude-opus-5', 'deepseek-v4-flash']);
    const out = normalizeAnthropicRequest(
      { model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
      undefined,
      expanded,
    );
    expect(out.model).toBe('claude-opus-5');
    // 默认（未传扩展集）仍回落 flash —— 旧行为不变。
    const def = normalizeAnthropicRequest(
      { model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect(def.model).toBe('deepseek-v4-flash');
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

  it('字段级拷贝：深层 messages/tools 与入参完全隔离', () => {
    const input = {
      model: 'claude-opus-4-6',
      thinking: { type: 'adaptive', budget_tokens: 1024 },
      tools: [{ name: 'f', strict: true, defer_loading: true }],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
      ],
    };
    const out = normalizeAnthropicRequest(input, EMPTY_MAP, DEFAULT_FALLBACK_MODEL);
    expect(out).not.toBe(input);
    expect(out.model).toBe('deepseek-v4-flash');
    // 输出归一化到位：字符串 content 转块数组、assistant 注入 thinking、工具剥 strict。
    const msgs = out.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0]!.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect((msgs[1]!.content as Array<{ type: string }>)[0]).toEqual({ type: 'thinking', thinking: '', signature: '' });
    expect(out.tools).toEqual([{ name: 'f' }]);
    // 入参侧完全未被污染（含嵌套对象与数组）。
    expect(input.model).toBe('claude-opus-4-6');
    expect((input.thinking as { type: string }).type).toBe('adaptive');
    expect(input.tools).toEqual([{ name: 'f', strict: true, defer_loading: true }]);
    expect((input.messages[0] as { content: string }).content).toBe('hi');
    expect((input.messages[1] as { content: unknown }).content).toEqual([
      { type: 'tool_use', id: 't1', name: 'f', input: {} },
    ]);
  });

  it('字段级拷贝：深度冻结的入参也能归一化（绝不原地改写入参）', () => {
    // 深拷贝若不覆盖某处原地修改，冻结对象会在 strict 模式下抛 TypeError ——
    // 比逐字段断言更强：直接证明 normalize 对入参零写入。
    const input = deepFreeze({
      model: 'claude-opus-4-6',
      thinking: { type: 'adaptive', budget_tokens: 1024 },
      tools: [{ name: 'f', strict: true }],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
      ],
    });
    const out = normalizeAnthropicRequest(input, EMPTY_MAP, DEFAULT_FALLBACK_MODEL);
    expect(out.model).toBe('deepseek-v4-flash');
    const msgs = out.messages as Array<{ content: Array<{ type: string }> }>;
    expect(msgs[1]!.content[0]!.type).toBe('thinking');
    expect(out.tools).toEqual([{ name: 'f' }]);
  });

  it('触发被动压缩时深度冻结的入参也能归一化（压缩走全量拷贝保契约）', () => {
    const input = deepFreeze({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a   b\n\n  c' }] }],
    });
    // triggerBytes 配到 <512KB：压缩改 content 块内文本，字段级拷贝覆盖不到，
    // 应回退 structuredClone 全量拷贝。
    const out = normalizeAnthropicRequest(input, EMPTY_MAP, DEFAULT_FALLBACK_MODEL, {
      bodyBytes: 4096,
      triggerBytes: 1024,
      maxMessageChars: 8000,
    });
    const outText = (out.messages as Array<{ content: Array<{ text: string }> }>)[0]!.content[0]!.text;
    // M-P2-3：折叠只折空格/制表符（[ \t]+），保留换行 —— tool_result 代码段不被拍平。
    expect(outText).toBe('a b\n\n c');
    // 入参不被压缩改写。
    const inText = (input.messages as Array<{ content: Array<{ text: string }> }>)[0]!.content[0]!.text;
    expect(inText).toBe('a   b\n\n  c');
  });

  it('字段级拷贝输出与触发压缩时的全量拷贝路径等价', () => {
    // 同一 body 分别走「字段级拷贝」（不压缩）与「全量拷贝」（触发压缩）：
    // 压缩只折叠空白，归一化的其余结果必须逐字段一致。
    const make = () => ({
      model: 'claude-opus-4-6',
      thinking: { type: 'adaptive', budget_tokens: 1024 },
      reasoning_effort: 'high',
      context_management: { type: 'auto' },
      max_tokens: 200,
      tools: [{ name: 'web_search_preview', type: 'web_search_2025' }, { name: 'f', strict: true }],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'user', content: [{ type: 'text', text: 'b' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
      ],
    });
    const field = normalizeAnthropicRequest(make(), EMPTY_MAP, DEFAULT_FALLBACK_MODEL);
    const full = normalizeAnthropicRequest(make(), EMPTY_MAP, DEFAULT_FALLBACK_MODEL, {
      bodyBytes: 4096,
      triggerBytes: 1024,
      maxMessageChars: 8000,
    });
    expect(field).toEqual(full);
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

  it('max_tokens 上限钳制：超上游合法范围（393216）钳到 390000（不再白撞 400）', () => {
    // 实测上游报错 "Invalid max_tokens value, the valid range of max_tokens is [1, 393216]"
    const out = normalizeAnthropicRequest(
      { model: 'm', thinking: { type: 'enabled' }, max_tokens: 500000 },
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
    );
    expect(out.max_tokens).toBe(390000);
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
      // 上游要求 thinking 模式下每条 assistant 历史都带 reasoning（纯多轮无工具也会拒），
      // 所以纯文本 assistant 也会被注入空 thinking 块。
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: '' },
          { type: 'text', text: 'b' },
        ],
      },
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

describe('对外模型别名（配置化后走 modelMap）', () => {
  it('别名配置进 modelMap 后映射到真实模型', () => {
    const map = { 'claude-mythos-5': 'deepseek-v4-flash', 'claude-fable-5': 'deepseek-v4-flash' };
    expect(resolveModelName('claude-mythos-5', map, 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(resolveModelName('claude-fable-5', map, 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
  });

  it('别名未配置（db 无映射）时回落 fallback，语义与旧内置一致', () => {
    // seed 前/用户删除映射后：别名按普通未知模型处理，落到 fallback（flash）。
    expect(resolveModelName('claude-mythos-5', {}, 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(resolveModelName('claude-fable-5', {}, 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
  });

  it('真名照样可用，别名不影响', () => {
    expect(resolveModelName('deepseek-v4-flash', {}, 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(resolveModelName('deepseek-v4-flash-free', {}, 'deepseek-v4-flash')).toBe('deepseek-v4-flash-free');
  });

  it('未配置的别名不与真实 Anthropic 模型重名 —— 否则 Claude Code 的默认模型会被误判', () => {
    const real = ['claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-8'];
    for (const r of real) {
      // 空 modelMap 下这些真名只能走回落，不会被当成别名解析。
      expect(resolveModelName(r, {}, 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
    }
  });

  it('别名映射的目标走订阅端点（与真名一致）', () => {
    const SUB = 'https://opencode.ai/zen/go', PAYG = 'https://opencode.ai/zen';
    const mythos = resolveModelName('claude-mythos-5', { 'claude-mythos-5': 'deepseek-v4-flash' }, 'deepseek-v4-flash');
    const fable = resolveModelName('claude-fable-5', { 'claude-fable-5': 'deepseek-v4-flash' }, 'deepseek-v4-flash');
    expect(resolveUpstreamBaseUrl(mythos, SUB, PAYG)).toBe(SUB);
    expect(resolveUpstreamBaseUrl(fable, SUB, PAYG)).toBe(SUB);
  });
});

describe('normalizeAnthropicRequest 被动压缩（实验性 COMPACT_ENABLED）', () => {
  const COMPACT = (bodyBytes: number, maxMessageChars = 8000) => ({
    bodyBytes,
    triggerBytes: 4 * 1024 * 1024,
    maxMessageChars,
  });

  it('不传 compact 参数：完全不做压缩（默认路径）', () => {
    const input = {
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a   b\n\n  c' }] },
      ],
    };
    const out = normalizeAnthropicRequest(input, EMPTY_MAP, DEFAULT_FALLBACK_MODEL);
    const content = (out.messages as { content: { content: string }[] }[])[0]!.content[0]!;
    expect(content.content).toBe('a   b\n\n  c');
  });

  it('未超阈值不触发压缩', () => {
    const input = {
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a   b' }] },
      ],
    };
    const out = normalizeAnthropicRequest(input, EMPTY_MAP, DEFAULT_FALLBACK_MODEL, COMPACT(1024));
    const content = (out.messages as { content: { content: string }[] }[])[0]!.content[0]!;
    expect(content.content).toBe('a   b');
  });

  it('超阈值：tool_result 文本空白折叠 + 超长截断（省略标记）', () => {
    const input = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: `a   b\n\n  c ${'word '.repeat(3000)}` }],
        },
      ],
    };
    const out = normalizeAnthropicRequest(
      input,
      EMPTY_MAP,
      DEFAULT_FALLBACK_MODEL,
      COMPACT(5 * 1024 * 1024, 100),
    );
    const content = (out.messages as { content: { content: string }[] }[])[0]!.content[0]!.content;
    // M-P2-3 后折叠为 'a b\n\n c ' + 'word '.repeat(3000)（换行保留）；截断取前 100 字符 + 省略标记。
    const collapsed = `a b\n\n c ${'word '.repeat(3000)}`;
    expect(content).toBe(collapsed.slice(0, 100) + '…[truncated]');
  });

  it('text 块同样折叠截断，字符串 content 消息也处理', () => {
    const input = {
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'x  y  z' }] },
        { role: 'assistant', content: '  a   b  ' },
      ],
    };
    const out = normalizeAnthropicRequest(input, EMPTY_MAP, DEFAULT_FALLBACK_MODEL, COMPACT(5 * 1024 * 1024));
    const messages = out.messages as { role: string; content: { type: string; text: string }[] }[];
    expect(messages[0]!.content[0]).toEqual({ type: 'text', text: 'x y z' });
    // assistant 消息会被注入空 thinking 块（第 7 步），折叠后的 text 在其后。
    expect(messages[1]!.content[1]).toEqual({ type: 'text', text: ' a b ' });
  });

  it('不碰结构：thinking/image/tool_use 块与工具定义原样', () => {
    const input = {
      model: 'm',
      thinking: { type: 'enabled' },
      tools: [{ name: 'ls', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'q  u' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'step   one', signature: 'sig' },
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 't1', name: 'ls', input: { path: 'a  b' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA  BBBB' } }] },
        ] },
      ],
    };
    const out = normalizeAnthropicRequest(input, EMPTY_MAP, DEFAULT_FALLBACK_MODEL, COMPACT(5 * 1024 * 1024));
    const messages = out.messages as { role: string; content: Record<string, unknown>[] }[];
    // thinking 块文本不动
    expect(messages[1]!.content[0]).toEqual({ type: 'thinking', thinking: 'step   one', signature: 'sig' });
    // tool_use 的 input JSON 不动
    expect(messages[1]!.content[2]).toEqual({ type: 'tool_use', id: 't1', name: 'ls', input: { path: 'a  b' } });
    // tool_result 内的 image 块不动
    expect(messages[2]!.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA  BBBB' } }],
    });
    // 工具定义不动
    expect(out.tools).toEqual([{ name: 'ls', input_schema: { type: 'object' } }]);
    // 压缩后其他字段不受影响（模型映射照常）
    expect(out.model).toBe('deepseek-v4-flash');
  });

  it('compactMessages 直接调用：返回 compressed 标志，短文本不折叠不截断', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
    ] as unknown[];
    const r1 = compactMessages(messages, 8000);
    expect(r1.compressed).toBe(false);
    const r2 = compactMessages([{ role: 'user', content: 'a  b' }] as unknown[], 8000);
    expect(r2.compressed).toBe(true);
    expect(r2.messages[0]).toEqual({ role: 'user', content: 'a b' });
  });
});
