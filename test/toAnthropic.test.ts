import { describe, expect, it } from 'vitest';
import { anthropicToOpenAIRequest } from '../src/toOpenAI.js';
import {
  openAIFinishReasonToAnthropic,
  openAIStreamToAnthropic,
  openAIToAnthropicResponse,
  openAIUsageToAnthropic,
} from '../src/toAnthropic.js';
import { resolveUpstreamBaseUrl } from '../src/deepseek.js';
import type {
  AnthropicContentBlock,
  AnthropicRequest,
  AnthropicStreamEvent,
  OpenAIStreamChunk,
} from '../src/types.js';

async function* chunks(list: OpenAIStreamChunk[]): AsyncGenerator<OpenAIStreamChunk> {
  for (const c of list) yield c;
}
async function collect(it: AsyncIterable<AnthropicStreamEvent>): Promise<AnthropicStreamEvent[]> {
  const out: AnthropicStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const chunk = (delta: Record<string, unknown>, finish: string | null = null): OpenAIStreamChunk =>
  ({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) as OpenAIStreamChunk;

describe('resolveUpstreamBaseUrl', () => {
  const SUB = 'https://opencode.ai/zen/go';
  const PAYG = 'https://opencode.ai/zen';

  it('-free 模型走按量付费端点（订阅端点不认，会 401）', () => {
    expect(resolveUpstreamBaseUrl('deepseek-v4-flash-free', SUB, PAYG)).toBe(PAYG);
    expect(resolveUpstreamBaseUrl('mimo-v2.5-free', SUB, PAYG)).toBe(PAYG);
  });

  it('其余模型走订阅端点（cost=0，不烧额度）', () => {
    expect(resolveUpstreamBaseUrl('deepseek-v4-flash', SUB, PAYG)).toBe(SUB);
    expect(resolveUpstreamBaseUrl('claude-opus-5', SUB, PAYG)).toBe(SUB);
    expect(resolveUpstreamBaseUrl('', SUB, PAYG)).toBe(SUB);
  });
});

describe('anthropicToOpenAIRequest', () => {
  const base: AnthropicRequest = { model: 'm', max_tokens: 100, messages: [] };

  it('顶层 system 字符串 → 首条 system 消息', () => {
    const out = anthropicToOpenAIRequest({
      ...base,
      system: '你是助手',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(out.messages[0]).toEqual({ role: 'system', content: '你是助手' });
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('system 块数组（Claude Code 形式）也能提取', () => {
    const out = anthropicToOpenAIRequest({
      ...base,
      system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] as never,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.messages[0]!.content).toBe('a\nb');
  });

  it('thinking 块 → reasoning_content，tool_use → tool_calls', () => {
    const out = anthropicToOpenAIRequest({
      ...base,
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '想一下' },
            { type: 'text', text: '好' },
            { type: 'tool_use', id: 'tu_1', name: 'f', input: { a: 1 } },
          ],
        },
      ],
    });
    const asst = out.messages[1]!;
    expect(asst.reasoning_content).toBe('想一下');
    expect(asst.content).toBe('好');
    expect(asst.tool_calls).toEqual([
      { id: 'tu_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
    ]);
  });

  it('tool_result 拆成独立的 role:tool 消息', () => {
    const out = anthropicToOpenAIRequest({
      ...base,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'f', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: '结果' },
            { type: 'text', text: '继续' },
          ],
        },
      ],
    });
    const toolMsg = out.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.tool_call_id).toBe('tu_1');
    expect(toolMsg.content).toBe('结果');
    // tool 消息必须排在同批文本之前（它对应上一条 assistant 的 tool_call）。
    expect(out.messages.indexOf(toolMsg)).toBeLessThan(
      out.messages.findIndex((m) => m.role === 'user' && m.content === '继续'),
    );
  });

  it('tools 与 tool_choice 转 OpenAI 形态', () => {
    const out = anthropicToOpenAIRequest({
      ...base,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'f' },
    });
    expect(out.tools).toEqual([
      { type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } },
    ]);
    expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'f' } });
  });

  it('tool_choice any → required，none → none', () => {
    const mk = (tc: AnthropicRequest['tool_choice']) =>
      anthropicToOpenAIRequest({ ...base, messages: [{ role: 'user', content: 'x' }], tool_choice: tc }).tool_choice;
    expect(mk({ type: 'any' })).toBe('required');
    expect(mk({ type: 'none' })).toBe('none');
    expect(mk({ type: 'auto' })).toBe('auto');
  });

  it('output_config.effort 与顶层 reasoning_effort 都能映射', () => {
    const a = anthropicToOpenAIRequest({ ...base, messages: [{ role: 'user', content: 'x' }], output_config: { effort: 'high' } });
    expect(a.reasoning_effort).toBe('high');
    const b = anthropicToOpenAIRequest({ ...base, messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'low' });
    expect(b.reasoning_effort).toBe('low');
  });

  it('stop_sequences → stop，max_tokens 透传', () => {
    const out = anthropicToOpenAIRequest({
      ...base,
      max_tokens: 55,
      stop_sequences: ['END'],
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(out.stop).toEqual(['END']);
    expect(out.max_tokens).toBe(55);
  });

  it('image 块 → 文本占位（上游不支持图片）', () => {
    const out = anthropicToOpenAIRequest({
      ...base,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          ],
        },
      ],
    });
    // 上游 opencode Zen 报 "unknown variant `image_url`, expected `text`"，
    // 所以图片降级成文本占位，避免整条会话 400。
    // 全是 text 块时会合并成字符串形式（更兼容）。
    expect(out.messages[0]!.content).toBe('看图\n[图片内容暂不支持，已省略]');
  });
});

describe('openAIToAnthropicResponse', () => {
  const mk = (message: Record<string, unknown>, finish = 'stop', usage?: Record<string, number>) =>
    openAIToAnthropicResponse({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as never);

  it('content → text 块，finish_reason → stop_reason', () => {
    const out = mk({ role: 'assistant', content: '你好' });
    expect(out.content).toEqual([{ type: 'text', text: '你好' }]);
    expect(out.stop_reason).toBe('end_turn');
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('reasoning_content → thinking 块，且排在 text 之前', () => {
    const out = mk({ role: 'assistant', content: '答', reasoning_content: '想' });
    expect(out.content[0]).toEqual({ type: 'thinking', thinking: '想', signature: '' });
    expect(out.content[1]).toEqual({ type: 'text', text: '答' });
  });

  it('tool_calls → tool_use 块，arguments 转对象', () => {
    const out = mk(
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
      },
      'tool_calls',
    );
    expect(out.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } }]);
    expect(out.stop_reason).toBe('tool_use');
  });

  it('畸形 arguments 不丢工具调用，退化空 input', () => {
    const out = mk(
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{bad' } }] },
      'tool_calls',
    );
    expect(out.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'f', input: {} }]);
  });

  it('空响应补空 text 块（Anthropic 不接受空 content）', () => {
    const out = mk({ role: 'assistant', content: null });
    expect(out.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('length → max_tokens，content_filter → refusal', () => {
    expect(mk({ content: 'x' }, 'length').stop_reason).toBe('max_tokens');
    expect(mk({ content: 'x' }, 'content_filter').stop_reason).toBe('refusal');
  });
});

describe('openAIUsageToAnthropic', () => {
  it('cached_tokens 从 input_tokens 里拆出来', () => {
    const out = openAIUsageToAnthropic({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 },
    });
    expect(out.input_tokens).toBe(60);
    expect(out.cache_read_input_tokens).toBe(40);
  });

  it('reasoning_tokens → thinking_tokens', () => {
    const out = openAIUsageToAnthropic({
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
      completion_tokens_details: { reasoning_tokens: 7 },
    });
    expect(out.output_tokens_details).toEqual({ thinking_tokens: 7 });
  });

  it('usage 缺失时全 0，不崩', () => {
    expect(openAIUsageToAnthropic(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe('openAIFinishReasonToAnthropic', () => {
  it('全表映射', () => {
    expect(openAIFinishReasonToAnthropic('stop')).toBe('end_turn');
    expect(openAIFinishReasonToAnthropic('length')).toBe('max_tokens');
    expect(openAIFinishReasonToAnthropic('tool_calls')).toBe('tool_use');
    expect(openAIFinishReasonToAnthropic('content_filter')).toBe('refusal');
    expect(openAIFinishReasonToAnthropic(null)).toBeNull();
  });
});

describe('openAIStreamToAnthropic', () => {
  it('产出完整自洽的事件骨架', async () => {
    const events = await collect(
      openAIStreamToAnthropic(
        chunks([chunk({ role: 'assistant', content: '' }), chunk({ content: '你' }), chunk({ content: '好' }), chunk({}, 'stop')]),
      ),
    );
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('message_start');
    expect(types).toContain('content_block_start');
    expect(types).toContain('content_block_delta');
    expect(types).toContain('content_block_stop');
    expect(types.at(-2)).toBe('message_delta');
    expect(types.at(-1)).toBe('message_stop');
  });

  it('文本增量按序转成 text_delta', async () => {
    const events = await collect(
      openAIStreamToAnthropic(chunks([chunk({ content: '你' }), chunk({ content: '好' }), chunk({}, 'stop')])),
    );
    const texts = events
      .filter((e): e is Extract<AnthropicStreamEvent, { type: 'content_block_delta' }> => e.type === 'content_block_delta')
      .map((e) => ('text' in e.delta ? e.delta.text : ''));
    expect(texts.join('')).toBe('你好');
  });

  it('reasoning_content → thinking 块；content 缓冲到收尾统一发', async () => {
    // 流式文本改为缓冲到流结束（为 DSML 兜底解析），所以 text 块在收尾才出现。
    const events = await collect(
      openAIStreamToAnthropic(
        chunks([chunk({ reasoning_content: '想' }), chunk({ content: '答' }), chunk({}, 'stop')]),
      ),
    );
    const starts = events.filter(
      (e): e is Extract<AnthropicStreamEvent, { type: 'content_block_start' }> => e.type === 'content_block_start',
    );
    expect(starts[0]!.content_block.type).toBe('thinking');
    // text 块在收尾才发（缓冲后），位于 thinking 块之后。
    expect(starts[1]!.content_block.type).toBe('text');
    expect(starts[0]!.index).not.toBe(starts[1]!.index);
    // 文本内容最终到达。
    const text = events
      .filter((e): e is Extract<AnthropicStreamEvent, { type: 'content_block_delta' }> => e.type === 'content_block_delta')
      .filter((e) => 'text' in e.delta)
      .map((e) => ('text' in e.delta ? e.delta.text : ''))
      .join('');
    expect(text).toBe('答');
  });

  it('tool_calls → tool_use 块 + input_json_delta', async () => {
    const events = await collect(
      openAIStreamToAnthropic(
        chunks([
          chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
          chunk({}, 'tool_calls'),
        ]),
      ),
    );
    const start = events.find(
      (e): e is Extract<AnthropicStreamEvent, { type: 'content_block_start' }> => e.type === 'content_block_start',
    )!;
    expect(start.content_block).toMatchObject({ type: 'tool_use', id: 'c1', name: 'f' });
    const args = events
      .filter((e): e is Extract<AnthropicStreamEvent, { type: 'content_block_delta' }> => e.type === 'content_block_delta')
      .map((e) => ('partial_json' in e.delta ? e.delta.partial_json : ''));
    expect(args.join('')).toBe('{"a":1}');
    const last = events.at(-2) as Extract<AnthropicStreamEvent, { type: 'message_delta' }>;
    expect(last.delta.stop_reason).toBe('tool_use');
  });

  it('并行多个 tool_calls 各占独立块', async () => {
    const events = await collect(
      openAIStreamToAnthropic(
        chunks([
          chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'f1', arguments: '{}' } }] }),
          chunk({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'f2', arguments: '{}' } }] }),
          chunk({}, 'tool_calls'),
        ]),
      ),
    );
    const starts = events.filter((e) => e.type === 'content_block_start');
    expect(starts).toHaveLength(2);
    const stops = events.filter((e) => e.type === 'content_block_stop');
    expect(stops).toHaveLength(2);
  });

  it('usage 记账 chunk 进 message_delta', async () => {
    const usageChunk = {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'm',
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
    } as OpenAIStreamChunk;
    const events = await collect(
      openAIStreamToAnthropic(chunks([chunk({ content: 'x' }), chunk({}, 'stop'), usageChunk])),
    );
    const delta = events.find(
      (e): e is Extract<AnthropicStreamEvent, { type: 'message_delta' }> => e.type === 'message_delta',
    )!;
    expect(delta.usage).toEqual({ output_tokens: 9 });
  });

  it('空流也补出自洽骨架，不让客户端挂死', async () => {
    const events = await collect(openAIStreamToAnthropic(chunks([])));
    expect(events.map((e) => e.type)).toEqual(['message_start', 'message_delta', 'message_stop']);
  });
});

describe('DSML 泄漏兜底解析', () => {
  it('流式：DSML 包裹的工具调用被还原成 tool_use 块', async () => {
    // 线上实测格式：每个标签自己带 |DSML| 前缀（见 DEEPSEEK-QUIRKS 第 12 条）。
    const leaked = [
      '< | DSML | function_calls',
      '< | DSML | invoke name="Bash">',
      '< | DSML | parameter name="command" string="true">ls -la</ | DSML | parameter>',
      '</ | DSML | invoke>',
      '</ | DSML | function_calls>',
    ].join('\n');
    const events = await collect(
      openAIStreamToAnthropic(
        chunks([
          // 分片发：真实上游会按 chunk 增量吐出
          chunk({ content: leaked.slice(0, 20) }),
          chunk({ content: leaked.slice(20, 60) }),
          chunk({ content: leaked.slice(60) }),
          chunk({}, 'stop'),
        ]),
      ),
    );
    const toolUse = events.find(
      (e): e is Extract<AnthropicStreamEvent, { type: 'content_block_start' }> =>
        e.type === 'content_block_start' && e.content_block.type === 'tool_use',
    );
    expect(toolUse).toBeDefined();
    const tb = toolUse!.content_block as Extract<AnthropicContentBlock, { type: 'tool_use' }>;
    expect(tb.name).toBe('Bash');
    expect(tb.input).toEqual({ command: 'ls -la' });
    // 不残留 DSML 文本。
    const text = events
      .filter((e): e is Extract<AnthropicStreamEvent, { type: 'content_block_delta' }> => e.type === 'content_block_delta')
      .filter((e) => 'text' in e.delta)
      .map((e) => ('text' in e.delta ? e.delta.text : ''))
      .join('');
    expect(text).not.toContain('DSML');
    expect(text).not.toContain('<invoke');
  });

  it('普通文本流式不被缓冲改动', async () => {
    const events = await collect(
      openAIStreamToAnthropic(chunks([chunk({ content: '你好' }), chunk({ content: '世界' }), chunk({}, 'stop')])),
    );
    const text = events
      .filter((e): e is Extract<AnthropicStreamEvent, { type: 'content_block_delta' }> => e.type === 'content_block_delta')
      .filter((e) => 'text' in e.delta)
      .map((e) => ('text' in e.delta ? e.delta.text : ''))
      .join('');
    expect(text).toBe('你好世界');
  });

  it('混合形态（function_calls 带前缀、标签闭口多竖线）不残留标记', () => {
    // 2026-08-09 第三次形态：`function_calls` 带 |DSML| 前缀，`invoke`/`parameter`
    // 开标签无前缀，`parameter` 闭标签带前缀且**多一根竖线**（`</ | DSML | | parameter>`）。
    // 之前两版正则分别栽在「外层包裹」和「每标签单竖线」，这里锁住不规则形态。
    const leaked =
      '<|DSML|function_calls\n' +
      '<invoke name="Bash">' +
      '<parameter name="command" string="true">echo hi</ | DSML | | parameter>' +
      '</invoke>\n' +
      '</|DSML|function_calls>';
    const out = openAIToAnthropicResponse({
      id: 'c1',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: leaked },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } as never);
    const tu = out.content.find((b) => b.type === 'tool_use');
    expect(tu).toBeDefined();
    expect((tu as { name: string }).name).toBe('Bash');
    // command 必须干净，不能带 DSML/闭标签残留（否则客户端拿到脏参数）。
    const input = (tu as { input: { command?: string } }).input;
    expect(input.command).toBe('echo hi');
    expect(String(input.command)).not.toMatch(/DSML|<\/|parameter/);
    expect(out.stop_reason).toBe('tool_use');
    // 残余文本不含 DSML 标记。
    const textBlocks = out.content.filter((b) => b.type === 'text');
    const text = textBlocks.map((b) => (b as { text: string }).text).join('');
    expect(text).not.toMatch(/DSML|invoke|function_calls/);
  });

  it('非流式：DSML 文本被还原成 tool_use', () => {
    const leaked =
      '<|DSML|function_calls>\n<|DSML|invoke name="Bash"><|DSML|parameter name="command">ls</|DSML|parameter></|DSML|invoke>\n</|DSML|function_calls>';
    const out = openAIToAnthropicResponse({
      id: 'c1',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: leaked },
          // 泄漏场景上游给的是 stop（它自己不认为这是工具调用）。
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } as never);
    const tu = out.content.find((b) => b.type === 'tool_use');
    expect(tu).toBeDefined();
    expect((tu as { name: string }).name).toBe('Bash');
    expect((tu as { input: unknown }).input).toEqual({ command: 'ls' });
    // 泄漏成文本时 finish_reason 是 stop；还原成工具调用后必须纠正为 tool_use，
    // 否则客户端当成 end_turn 不会执行工具。
    expect(out.stop_reason).toBe('tool_use');
  });
});

describe('DSML 残缺标记剥离（抽不出 invoke 时不能泄漏标记）', () => {
  // 2026-08-09 用户实测：客户端看到裸的 `<｜DSML｜function_calls`。
  // 这类形态抽不出任何 invoke（上游被 max_tokens 截断，或只吐了半截标签），
  // 此前走 else 分支把原文完整透出 —— 标记就泄漏了。
  const nonStream = (content: string) =>
    openAIToAnthropicResponse({
      id: 'c1',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    } as never);

  it.each([
    ['半截开标签（全角，用户报的形态）', '现在绝对还有<｜DSML｜function_calls', '现在绝对还有'],
    ['半截开标签（半角）', 'text before <|DSML|function_calls', 'text before'],
    ['只有闭合标记', '好的</｜DSML｜function_calls>', '好的'],
    ['invoke 名字为空', '<｜DSML｜function_calls>\n<｜DSML｜invoke>\n</｜DSML｜invoke>', ''],
    ['纯标记无正文', '<｜DSML｜function_calls', ''],
  ])('非流式：%s', (_label, leaked, expectedText) => {
    const out = nonStream(leaked);
    const text = out.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    expect(text).not.toContain('DSML');
    expect(text).not.toContain('function_calls');
    expect(text.trim()).toBe(expectedText);
  });

  it('非流式：正常提到 function_calls 的文本不被改写', () => {
    const normal = '我们来讨论一下 function_calls 这个概念吧';
    const out = nonStream(normal);
    const text = out.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    expect(text).toBe(normal);
  });

  // 2026-08-09 二次实测：这些是用户贴的真实形态。半截标签**后面还有正常文本**，
  // 此前 `DSML_RESIDUE` 的 `[^>⟩]*` 会跨行贪婪吃到字符串末尾，把标记**和后面的
  // 整段回答一起吞掉**，客户端从「看到裸标记」变成「看到空白回答」。
  it.each([
    // 半截 function_calls + 换行 + 正常文本
    [
      '半截 function_calls 后换行接正常文本',
      '<｜DSML｜function_calls\n阅读\nbinary_patch_19.py\n我理解了 ReleaseVR 的模式。',
      '阅读\nbinary_patch_19.py\n我理解了 ReleaseVR 的模式。',
    ],
    // 双重半截标记
    [
      '双重半截 function_calls',
      '<｜DSML｜function_calls\n<｜DSML｜function_calls\nFound header for GetMaxDesktopBitrate',
      'Found header for GetMaxDesktopBitrate',
    ],
    // 半截标记 + 工具结果文本（真实上下文里最常见的形态）
    [
      '半截 function_calls + 工具结果',
      '<｜DSML｜function_calls\n已运行 2 命令\nworkflow 超级大并发 开始 剩下的都做完',
      '已运行 2 命令\nworkflow 超级大并发 开始 剩下的都做完',
    ],
    // 完整开标签（同一行）后紧跟正常文本
    [
      '完整开标签后紧跟文本',
      '<｜DSML｜function_calls>Found header\n后续正常内容',
      'Found header\n后续正常内容',
    ],
    // 半截 parameter 标签 + 换行 + 正常文本
    [
      '半截 parameter 标签 + 正常文本',
      '<｜DSML｜parameter name="command" string="true">echo hi\n这是正常回答',
      'echo hi\n这是正常回答',
    ],
  ])('非流式：%s（标记不吞后面文本）', (_label, leaked, expectedText) => {
    const out = nonStream(leaked);
    const text = out.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    expect(text).not.toContain('DSML');
    expect(text).not.toContain('function_calls');
    expect(text.trim()).toBe(expectedText);
  });

  it('流式：残缺 DSML 标记同样被剥掉', async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { content: '好的，' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: '<｜DSML｜function_calls' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    async function* src() {
      for (const c of chunks) {
        yield { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', ...c } as never;
      }
    }
    const events: unknown[] = [];
    for await (const e of openAIStreamToAnthropic(src(), { model: 'm' })) events.push(e);
    const text = events
      .filter((e) => (e as { type: string }).type === 'content_block_delta')
      .map((e) => (e as { delta?: { text?: string } }).delta?.text ?? '')
      .join('');
    expect(text).not.toContain('DSML');
    expect(text).not.toContain('function_calls');
    expect(text.trim()).toBe('好的，');
  });
});
