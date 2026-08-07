#!/usr/bin/env node
/**
 * 真实上游端到端 live probe。
 *
 * 前提：代理服务已在本机运行（API_KEYS=xxx ANTHROPIC_API_KEY=xxx npm run serve），
 * 且 BASE 指向它的地址。用小请求礼貌探测，覆盖协议转换最容易暴露的严重问题：
 *   1. 基本对话
 *   2. 多轮工具调用（OpenAI 方向，验证 thinking 块注入，第二轮不得 400）
 *   3. JSON mode（response_format json_object → content 应为 JSON 字符串 + finish_reason=stop）
 *   4. 流式 usage
 *   5. Anthropic /v1/messages 直通多轮工具（thinking enabled）
 *
 * 用法：node scripts/live-probe.mjs [baseUrl]
 * 退出码：0 = 全部通过；1 = 有失败。
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const KEY = process.env.API_KEY ?? 'demo-key';
const H = { 'content-type': 'application/json', authorization: `Bearer ${KEY}` };
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '获取城市天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
];

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures += 1;
}

async function chat(body) {
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

async function main() {
  // 1. 基本对话
  const r1 = await chat({ model: 'gpt-4o', max_tokens: 50, messages: [{ role: 'user', content: '回复:ok' }] });
  check('基本对话 200', r1.status === 200 && r1.json?.choices?.[0]?.message?.content != null, `status=${r1.status}`);

  // 2. 多轮工具（OpenAI 方向）
  const r2a = await chat({ model: 'gpt-4o', max_tokens: 100, tools: TOOLS, messages: [{ role: 'user', content: '北京天气？用工具查' }] });
  const tc = r2a.json?.choices?.[0]?.message?.tool_calls?.[0];
  if (r2a.status === 200 && tc) {
    const r2b = await chat({
      model: 'gpt-4o', max_tokens: 100, tools: TOOLS,
      messages: [
        { role: 'user', content: '北京天气？用工具查' },
        { role: 'assistant', content: null, tool_calls: [{ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] },
        { role: 'tool', tool_call_id: tc.id, content: '晴' },
        { role: 'user', content: '总结' },
      ],
    });
    check('多轮工具第二轮 200（不带 reasoning 也应过）', r2b.status === 200, `status=${r2b.status}`);
  } else {
    check('多轮工具第一轮触发 tool_calls', false, `status=${r2a.status} tool_calls=${!!tc}`);
  }

  // 3. JSON mode
  const r3 = await chat({ model: 'gpt-4o', max_tokens: 100, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: '返回JSON {"ok":true}' }] });
  const c3 = r3.json?.choices?.[0];
  check('JSON mode finish_reason=stop', r3.status === 200 && c3?.finish_reason === 'stop', `status=${r3.status}`);
  check('JSON mode content 是 JSON 字符串', typeof c3?.message?.content === 'string' && c3.message.content.startsWith('{'), `content=${String(c3?.message?.content).slice(0, 60)}`);
  check('JSON mode 无 tool_calls', c3?.message?.tool_calls == null);

  // 4. 流式 usage
  const r4 = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify({ model: 'gpt-4o', max_tokens: 30, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: '回复:hi' }] }) });
  const text4 = await r4.text();
  const hasDone = text4.includes('[DONE]');
  const usageChunk = text4.split('\n').map(l => l.startsWith('data: ') ? l.slice(6) : null).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).find(c => c && c.usage);
  check('流式结尾有 [DONE]', r4.status === 200 && hasDone);
  check('流式 usage 存在', usageChunk?.usage?.completion_tokens != null, `prompt=${usageChunk?.usage?.prompt_tokens} completion=${usageChunk?.usage?.completion_tokens}`);

  // 5. Anthropic 直通多轮工具
  const AH = { ...H, 'anthropic-version': '2023-06-01' };
  const antTools = [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }];
  const ra = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: AH, body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 200, thinking: { type: 'enabled' }, tools: antTools, messages: [{ role: 'user', content: '北京天气？用工具' }] }) });
  const ja = await ra.json();
  const toolUse = ja.content?.find(b => b.type === 'tool_use');
  if (ra.status === 200 && toolUse) {
    const rb = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: AH, body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 200, thinking: { type: 'enabled' }, tools: antTools, messages: [{ role: 'user', content: '北京天气？用工具' }, { role: 'assistant', content: ja.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '晴' }] }, { role: 'user', content: '总结' }] }) });
    check('直通多轮工具第二轮 200', rb.status === 200, `status=${rb.status}`);
  } else {
    check('直通第一轮触发 tool_use', false, `status=${ra.status}`);
  }

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('PROBE ERROR', e); process.exit(1); });
