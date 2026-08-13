import { describe, expect, it, vi } from 'vitest';
import { anthropicStreamToOpenAI, openAIStreamToSSE, sseStringify } from '../src/stream.js';
import { openAIStreamToAnthropic } from '../src/toAnthropic.js';
import { parseAnthropicSSE, parseOpenAISSE } from '../src/sse.js';
import type { AnthropicStreamEvent, OpenAIStreamChunk } from '../src/types.js';
import { iter, textStreamEvents, toolStreamEvents } from './fixtures.js';

async function collect(gen: AsyncGenerator<OpenAIStreamChunk>): Promise<OpenAIStreamChunk[]> {
  const out: OpenAIStreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('anthropicStreamToOpenAI', () => {
  it('text 流：首 chunk role + 内容增量 + 收尾 finish_reason/usage', async () => {
    const chunks = await collect(anthropicStreamToOpenAI(iter(textStreamEvents)));

    expect(chunks).toHaveLength(4);

    // message_start → 首 chunk
    expect(chunks[0]!.id).toBe('chatcmpl-1');
    expect(chunks[0]!.model).toBe('claude-x');
    expect(chunks[0]!.choices[0]!.delta).toEqual({ role: 'assistant', content: '' });
    expect(chunks[0]!.choices[0]!.finish_reason).toBeNull();

    // text_delta ×2
    expect(chunks[1]!.choices[0]!.delta.content).toBe('你');
    expect(chunks[2]!.choices[0]!.delta.content).toBe('好');

    // message_delta → 收尾
    expect(chunks[3]!.choices[0]!.delta).toEqual({});
    expect(chunks[3]!.choices[0]!.finish_reason).toBe('stop');
    expect(chunks[3]!.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('所有 chunk 的 id/model/created 一致', async () => {
    const chunks = await collect(anthropicStreamToOpenAI(iter(textStreamEvents)));
    for (const c of chunks) {
      expect(c.id).toBe('chatcmpl-1');
      expect(c.model).toBe('claude-x');
      expect(c.object).toBe('chat.completion.chunk');
    }
  });

  it('tool 流：id+name 首发，arguments 为增量 fragment，收尾 finish_reason=tool_calls', async () => {
    const chunks = await collect(anthropicStreamToOpenAI(iter(toolStreamEvents)));

    expect(chunks).toHaveLength(5);

    const start = chunks[1]!.choices[0]!.delta.tool_calls![0]!;
    expect(start).toEqual({
      index: 0,
      id: 'toolu_1',
      function: { name: 'get_weather', arguments: '' },
    });

    // 增量 fragment 原样透传
    expect(chunks[2]!.choices[0]!.delta.tool_calls![0]!.function!.arguments).toBe('{"ci');
    expect(chunks[3]!.choices[0]!.delta.tool_calls![0]!.function!.arguments).toBe('ty":"上海"}' );

    const finish = chunks[4]!;
    expect(finish.choices[0]!.delta).toEqual({});
    expect(finish.choices[0]!.finish_reason).toBe('tool_calls');
  });

  it('没有 message_start 时用默认 id/model，不崩溃', async () => {
    const chunks = await collect(
      anthropicStreamToOpenAI(iter([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }])),
    );
    // 内容 chunk + 补发的收尾 chunk（上游没给 message_delta/message_stop 也要有 finish_reason）。
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.model).toBe('');
    expect(typeof chunks[0]!.id).toBe('string');
    expect(chunks[1]!.choices[0]!.finish_reason).toBe('stop');
  });

  it('上游只发 message_stop（漏 message_delta）时补发 finish_reason', async () => {
    const chunks = await collect(
      anthropicStreamToOpenAI(
        iter([
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
          { type: 'message_stop' },
        ]),
      ),
    );
    const last = chunks.at(-1)!;
    expect(last.choices[0]!.finish_reason).toBe('stop');
    // 只补一个收尾 chunk，不重复发。
    expect(chunks.filter((c) => c.choices[0]?.finish_reason != null)).toHaveLength(1);
  });

  it('includeUsage=true：usage 拆到独立尾 chunk（choices:[]），finish chunk 不带 usage', async () => {
    const chunks = await collect(anthropicStreamToOpenAI(iter(textStreamEvents), { includeUsage: true }));
    expect(chunks).toHaveLength(5);
    const finish = chunks[3]!;
    expect(finish.choices[0]!.delta).toEqual({});
    expect(finish.choices[0]!.finish_reason).toBe('stop');
    expect(finish.usage).toBeUndefined();
    const usageChunk = chunks[4]!;
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('includeUsage=false（默认）：usage 仍并入 finish chunk', async () => {
    const chunks = await collect(anthropicStreamToOpenAI(iter(textStreamEvents)));
    expect(chunks).toHaveLength(4);
    expect(chunks[3]!.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('thinking_delta → delta.reasoning_content；signature_delta 丢弃不崩', async () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_t1', type: 'message', role: 'assistant', model: 'claude-x',
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '让我想想' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_abc' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '答案' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ];
    const chunks = await collect(anthropicStreamToOpenAI(iter(events)));
    expect(chunks).toHaveLength(4);
    expect(chunks[1]!.choices[0]!.delta.reasoning_content).toBe('让我想想');
    expect(chunks[2]!.choices[0]!.delta.content).toBe('答案');
  });

  it('error 事件：发终止 chunk（finish_reason=stop）后结束，error.message 记 warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const events: AnthropicStreamEvent[] = [
        {
          type: 'message_start',
          message: {
            id: 'msg_e1', type: 'message', role: 'assistant', model: 'claude-x',
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '部分输出' } },
        { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } },
      ];
      const chunks = await collect(anthropicStreamToOpenAI(iter(events)));
      expect(chunks).toHaveLength(3);
      expect(chunks[2]!.choices[0]!.delta).toEqual({});
      expect(chunks[2]!.choices[0]!.finish_reason).toBe('stop');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('overloaded'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ping 事件跳过，不产出 chunk', async () => {
    const events: AnthropicStreamEvent[] = [
      { type: 'ping' },
      {
        type: 'message_start',
        message: {
          id: 'msg_p1', type: 'message', role: 'assistant', model: 'claude-x',
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
      { type: 'ping' },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    const chunks = await collect(anthropicStreamToOpenAI(iter(events)));
    expect(chunks).toHaveLength(3);
    expect(chunks[1]!.choices[0]!.delta.content).toBe('hi');
  });

  it('json_mode 流式：参数累积后作为 content 发出，finish_reason=stop', async () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_j1', type: 'message', role: 'assistant', model: 'claude-x',
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_j', name: 'json_mode', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ok":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'true}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ];
    const chunks = await collect(anthropicStreamToOpenAI(iter(events)));
    // role chunk + content(JSON) chunk + finish chunk
    expect(chunks).toHaveLength(3);
    expect(chunks[1]!.choices[0]!.delta.content).toBe('{"ok":true}');
    expect(chunks[2]!.choices[0]!.finish_reason).toBe('stop');
    expect(chunks[2]!.choices[0]!.delta.tool_calls).toBeUndefined();
  });

  it('message_delta 无 usage：用已累积文本长度估算 output_tokens', async () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_u1', type: 'message', role: 'assistant', model: 'claude-x',
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
      { type: 'message_stop' },
    ];
    const chunks = await collect(anthropicStreamToOpenAI(iter(events)));
    // textChars=2，Math.ceil(2/4)=1
    expect(chunks[2]!.usage).toEqual({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 });
  });
});

describe('parseAnthropicSSE', () => {
  function sseBody(raw: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    });
  }

  async function parse(raw: string): Promise<AnthropicStreamEvent[]> {
    const out: AnthropicStreamEvent[] = [];
    for await (const ev of parseAnthropicSSE(sseBody(raw))) out.push(ev);
    return out;
  }

  it('event: ping 与 event: error 都能解析出 JSON 事件，非 JSON 行不丢弃后续', async () => {
    const events = await parse(
      'event: ping\ndata: {"type":"ping"}\n\n' +
      'data: : 注释行\n\n' +
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"boom"}}\n\n',
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('ping');
    expect(events[1]!.type).toBe('error');
    if (events[1]!.type === 'error') expect(events[1]!.error.message).toBe('boom');
  });

  it('空 data（data: 无内容）不崩', async () => {
    const events = await parse('event: ping\ndata: \n\n');
    expect(events).toHaveLength(0);
  });
});

describe('parseOpenAISSE 脏行检测', () => {
  function sseBody(raw: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    });
  }

  const okChunk =
    'data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n';

  async function dirty(raw: string): Promise<{ chunks: OpenAIStreamChunk[]; samples: string[] }> {
    const chunks: OpenAIStreamChunk[] = [];
    const samples: string[] = [];
    for await (const c of parseOpenAISSE(sseBody(raw), (d) => samples.push(d.sample))) chunks.push(c);
    return { chunks, samples };
  }

  it('SSE 注释行（: 开头）不上报，[DONE] 不上报', async () => {
    const { chunks, samples } = await dirty(': keepalive\n\n' + okChunk + 'data: [DONE]\n\n');
    expect(chunks.length).toBe(1);
    expect(samples).toHaveLength(0);
  });

  it('非 JSON 脏行上报样本，行仍被丢弃', async () => {
    const { chunks, samples } = await dirty(okChunk + 'data: <html>502 bad gateway</html>\n\n' + okChunk);
    expect(chunks.length).toBe(2); // 脏行被丢，前后 chunk 都在
    expect(samples).toEqual(['<html>502 bad gateway</html>']);
  });

  it('JSON 解析失败（截断 chunk）上报样本', async () => {
    const { chunks, samples } = await dirty(okChunk + 'data: {"id":"x","choices":\n\n');
    expect(chunks.length).toBe(1);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toContain('"id":"x"');
  });

  it('脏样本截断到 200 字符，不把大块内容留在内存', async () => {
    const big = 'B'.repeat(500);
    const { samples } = await dirty(okChunk + `data: ${big}\n\n`);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.length).toBe(200);
  });

  it('未传 onDirty 时脏行静默丢弃（兼容旧行为）', async () => {
    const chunks: OpenAIStreamChunk[] = [];
    for await (const c of parseOpenAISSE(sseBody(okChunk + 'data: garbage\n\n'))) chunks.push(c);
    expect(chunks.length).toBe(1);
  });

  it('合法 JSON 错误体（{error:...}）按脏数据上报并丢弃，前后 chunk 不受影响', async () => {
    const { chunks, samples } = await dirty(
      okChunk + 'data: {"error":{"message":"rate limited","type":"server_error"}}\n\n' + okChunk,
    );
    expect(chunks.length).toBe(2);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toContain('"error"');
  });

  it('收尾记账 chunk（{"choices":[],"cost":"0"}）不误报为脏', async () => {
    const { chunks, samples } = await dirty(okChunk + 'data: {"choices":[],"cost":"0"}\n\n' + okChunk);
    expect(chunks.length).toBe(3); // 记账 chunk 保留（usage 可能在里面，由转换器判断）
    expect(samples).toHaveLength(0);
  });

  it('顶层非标准字段的合法 JSON chunk（如 {message:...}）按脏数据上报', async () => {
    const { chunks, samples } = await dirty(okChunk + 'data: {"message":"quota exceeded"}\n\n');
    expect(chunks.length).toBe(1);
    expect(samples).toHaveLength(1);
  });

  it('超长单行（>1MB 无换行）触发 buffer 上限：断流抛错', async () => {
    const big = 'data: ' + 'A'.repeat(1024 * 1024 + 10) + '\n\n';
    await expect(collect(parseOpenAISSE(sseBody(big)))).rejects.toThrow('SSE buffer exceeded limit');
  });

  it('大量合法短行（总长>1MB）不触发上限（逐行即时处理）', async () => {
    // 上限是「未换行的累积 buffer」，不是总字节数：每行即时消费则不触发。
    const body = okChunk.repeat(7000); // ~1MB+
    const { chunks } = await dirty(body);
    expect(chunks.length).toBe(7000);
  });
});

describe('parseAnthropicSSE buffer 上限', () => {
  function sseBody(raw: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    });
  }

  async function parse(raw: string): Promise<AnthropicStreamEvent[]> {
    const out: AnthropicStreamEvent[] = [];
    for await (const ev of parseAnthropicSSE(sseBody(raw))) out.push(ev);
    return out;
  }

  it('超长单行 data（>1MB）触发上限：断流抛错', async () => {
    const big = 'data: ' + 'A'.repeat(1024 * 1024 + 10) + '\n\n';
    await expect(parse(big)).rejects.toThrow('SSE buffer exceeded limit');
  });

  it('同一事件累积超 1MB 的 data 行（无空行分隔）触发上限', async () => {
    const line = 'data: ' + 'A'.repeat(8 * 1024) + '\n';
    const big = line.repeat(140); // ~1.15MB，从不出现空行
    await expect(parse(big)).rejects.toThrow('SSE buffer exceeded limit');
  });

  it('接近上限的合法事件仍能解析（8KB × 100 行 + 空行）', async () => {
    const line = 'data: ' + 'A'.repeat(8 * 1024) + '\n';
    const events = await parse(line.repeat(100) + '\n');
    // 100 行拼成一个 >800KB 的 data，JSON 解析失败被静默跳过（不是断流）。
    expect(events).toHaveLength(0);
  });
});

describe('openAIStreamToAnthropic 错误 chunk（M2）', () => {
  it('带 error 的 chunk 中止流：抛错而非静默拼接', async () => {
    const errorChunk = { error: { message: 'boom', type: 'server_error' } } as unknown as OpenAIStreamChunk;
    const gen = openAIStreamToAnthropic(
      iter([
        {
          id: 'x',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'm',
          choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }],
        },
        errorChunk,
      ]),
    );
    const events: AnthropicStreamEvent[] = [];
    await expect(async () => {
      for await (const ev of gen) events.push(ev);
    }).rejects.toThrow('upstream returned error chunk in stream');
    // 错误 chunk 前的合法内容已产出（message_start 骨架），不丢。
    expect(events.some((e) => e.type === 'message_start')).toBe(true);
  });
});

describe('SSE 包装', () => {
  it('sseStringify 产出 data: 行', () => {
    const chunk: OpenAIStreamChunk = { id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: null }] };
    expect(sseStringify(chunk)).toBe(`data: ${JSON.stringify(chunk)}\n\n`);
  });

  it('openAIStreamToSSE 结尾补 [DONE]', async () => {
    const chunk: OpenAIStreamChunk = { id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] };
    const lines: string[] = [];
    const gen = openAIStreamToSSE(iter([chunk]));
    for await (const line of gen) lines.push(line);
    expect(lines).toHaveLength(2);
    expect(lines[0]!).toMatch(/^data: \{/);
    expect(lines[1]!).toBe('data: [DONE]\n\n');
  });
});
