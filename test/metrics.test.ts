import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { extractDevice, parseUserAgent } from '../src/metrics.js';
import type { DeviceInfo, RequestEvent } from '../src/metrics.js';

/**
 * metrics.ts 是监控面板所有数字的来源，但聚合逻辑（p95、UA 分类、IP 优先级、
 * byModel/byClient/byEndpoint 分组）此前零直接断言 —— e2e 只验证了
 * totalRequests 增量。这是本项目最大的测试盲区。
 *
 * 实现细节：模块级状态（seq / events 环形缓冲）跨测试共享，无法手动重置。
 * 需要精确控制缓冲内容的用例（p95、分组、环形窗口）用 vi.resetModules() +
 * 动态 import 拿全新模块实例；纯函数（parseUserAgent / extractDevice）静态导入。
 */

type MetricsModule = typeof import('../src/metrics.js');

/** 全新模块实例：seq 归零、环形缓冲清空。 */
async function fresh(): Promise<MetricsModule> {
  vi.resetModules();
  return import('../src/metrics.js');
}

function device(over: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    ua: '',
    client: 'unknown',
    os: 'unknown',
    mobile: false,
    ip: '',
    forwardedFor: '',
    language: '',
    viaProxy: false,
    ...over,
  };
}

/** 构造一条除 id 外齐全的请求事件。 */
function ev(over: Partial<Omit<RequestEvent, 'id'>> = {}): Omit<RequestEvent, 'id'> {
  return {
    at: 1_700_000_000_000,
    method: 'POST',
    path: '/v1/messages',
    protocol: 'anthropic',
    status: 200,
    durationMs: 100,
    model: 'claude-sonnet-4-6',
    upstreamModel: 'deepseek-v4-flash',
    endpoint: 'subscription',
    stream: false,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    requestBytes: 0,
    device: device(),
    keyFingerprint: '****',
    error: null,
    rewritten: 0,
    stripped: 0,
    compressed: 0,
    ...over,
  };
}

/** 构造最小 IncomingMessage（只用到 headers + socket.remoteAddress）。 */
function makeReq(
  headers: Record<string, string | string[] | undefined> = {},
  remoteAddress = '',
): IncomingMessage {
  return { headers: { ...headers }, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe('parseUserAgent 客户端分类', () => {
  it('anthropic 官方 CLI：claude-cli / claude-code → Claude Code', () => {
    expect(parseUserAgent('claude-cli/1.0.27 (external, cli)').client).toBe('Claude Code');
    expect(parseUserAgent('claude-code/1.0.27 (external, cli)').client).toBe('Claude Code');
  });

  it('anthropic-sdk / anthropic-ai → Anthropic SDK', () => {
    expect(parseUserAgent('anthropic-sdk/0.30.1 typescript').client).toBe('Anthropic SDK');
    expect(parseUserAgent('anthropic-ai/0.30.1 python').client).toBe('Anthropic SDK');
  });

  it('openai-python / openai-node / openai/ 前缀 → OpenAI SDK', () => {
    expect(parseUserAgent('openai-python/1.30.0').client).toBe('OpenAI SDK');
    expect(parseUserAgent('openai-node/4.52.0').client).toBe('OpenAI SDK');
    expect(parseUserAgent('openai/1.30.0').client).toBe('OpenAI SDK');
  });

  it('^curl → curl', () => {
    expect(parseUserAgent('curl/8.5.0').client).toBe('curl');
  });

  it('HTTPie / python-requests / aiohttp / httpx → 各自分类', () => {
    expect(parseUserAgent('HTTPie/3.2.1').client).toBe('HTTPie');
    expect(parseUserAgent('python-requests/2.31.0').client).toBe('Python HTTP');
    expect(parseUserAgent('aiohttp/3.9.1').client).toBe('Python HTTP');
    expect(parseUserAgent('httpx/0.26.0').client).toBe('Python HTTP');
  });

  it('Postman / node-fetch / undici → 各自分类', () => {
    expect(parseUserAgent('PostmanRuntime/7.36.0').client).toBe('Postman');
    expect(parseUserAgent('node-fetch/3.3.2').client).toBe('Node fetch');
    expect(parseUserAgent('undici/6.6.0').client).toBe('Node fetch');
  });

  it('浏览器：Chrome 优先于 Safari，Edg 优先于 Chrome（都含对方关键字）', () => {
    const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    expect(parseUserAgent(chrome).client).toBe('Chrome');
    const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
    expect(parseUserAgent(edge).client).toBe('Edge');
    const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    expect(parseUserAgent(safari).client).toBe('Safari');
    const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
    expect(parseUserAgent(firefox).client).toBe('Firefox');
  });

  it('空 UA → unknown；无关键字 UA → 取首段截断 24 字符', () => {
    expect(parseUserAgent('').client).toBe('unknown');
    expect(parseUserAgent('').os).toBe('unknown');
    // 'Mozilla/5.0' 没有 Safari//Chrome/ 等关键字，走 split('/')[0] 兜底。
    expect(parseUserAgent('Mozilla/5.0').client).toBe('Mozilla');
    const long = 'some-very-long-client-token-abcdefghijklmnop/9.9';
    expect(parseUserAgent(long).client).toBe('some-very-long-client-to');
  });

  it('AI 客户端：Cursor/Windsurf/Cline/Continue 等具体品牌先判，不塌陷进 vscode/浏览器', () => {
    // Cursor 的 UA 同时含 Chrome/Electron，必须命中 Cursor 而不是 Chrome。
    expect(parseUserAgent('Cursor/0.42.3 Chrome/124 Electron/30 Safari/537.36').client).toBe('Cursor');
    // Cursor 装 Mozilla 前缀（含 vscode/Chrome），仍命中 Cursor。
    expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Cursor/0.42.3 Chrome/124.0.0.0 Safari/537.36').client).toBe('Cursor');
    expect(parseUserAgent('Windsurf/1.0.0 (vscode)').client).toBe('Windsurf');
    expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Codeium/1.0.0 Chrome/124.0.0.0').client).toBe('Windsurf');
    // Cline / Roo-Cline（UA 含 vscode + cline，品牌先判）。
    expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) vscode Cline/3.0.0').client).toBe('Cline');
    expect(parseUserAgent('Roo-Cline/3.0.0').client).toBe('Cline');
    expect(parseUserAgent('Continue/0.9.0 vscode').client).toBe('Continue');
    expect(parseUserAgent('GitHub Copilot/1.0.0').client).toBe('Copilot');
    expect(parseUserAgent('opencode/0.1.0').client).toBe('OpenCode');
    expect(parseUserAgent('Aider/0.50.0').client).toBe('Aider');
    // zed 词边界：authorized/optimized 等常见子串不误伤。
    expect(parseUserAgent('Zed/0.150.0').client).toBe('Zed');
    expect(parseUserAgent('custom-optimized-agent/1.0').client).toBe('custom-optimized-agent');
    expect(parseUserAgent('Kiro/1.0.0').client).toBe('Kiro');
    // Kiro IDE（kiro2cc-proxy 取证的 UA 形态：aws-sdk-js + KiroIDE-{version}-{machine_id}）。
    expect(parseUserAgent('aws-sdk-js/1.0.27 KiroIDE-1.0.0-abcdef123456').client).toBe('Kiro IDE');
    expect(parseUserAgent('aws-sdk-js/1.0.27 ua/2.1 os/mac lang/js md/nodejs#22 api/codewhispererstreaming#1.0.27 m/E KiroIDE-2.5.6-xyz789').client).toBe('Kiro IDE');
    // 泛 kiro 子串（非 KiroIDE）仍落通用 Kiro。
    expect(parseUserAgent('kiro-cli/0.1.0').client).toBe('Kiro');
    expect(parseUserAgent('kiro-tui/0.3.0').client).toBe('Kiro');
    expect(parseUserAgent('JetBrains IntelliJ IDEA/2024.1').client).toBe('JetBrains');
    expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) vscode/1.90.0').client).toBe('VSCode');
  });

  it('Codex 客户端家族（codex_cli_rs / codex-tui / codex_vscode / Codex Desktop）', () => {
    expect(parseUserAgent('codex_cli_rs/0.1.2').client).toBe('Codex');
    expect(parseUserAgent('codex-tui/0.142.0 (macos; arm64)').client).toBe('Codex');
    expect(parseUserAgent('codex_vscode/1.0.0').client).toBe('Codex');
    expect(parseUserAgent('codex_vscode_copilot/1.0.0').client).toBe('Codex');
    expect(parseUserAgent('Codex Desktop/0.1.0').client).toBe('Codex');
  });

  it('os 识别：Mac/Windows/Android/iOS/Linux', () => {
    expect(parseUserAgent('curl/8.5.0').os).toBe('unknown');
    expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0').os).toBe('macOS');
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0').os).toBe('Windows');
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 13) Chrome/120.0.0.0 Mobile').os).toBe('Android');
    expect(parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1').os).toBe('iOS');
    expect(parseUserAgent('Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0').os).toBe('Linux');
  });

  it('os 修复：真实 iPhone UA 含 "like Mac OS X" 也被判 iOS（移动端优先）', () => {
    // 修复过：原实现 /Mac OS X/ 分支在 /iPhone/ 之前，真实 iPhone Safari UA
    // 自报 "CPU iPhone OS 17_0 like Mac OS X"，os 被误判为 macOS。
    // 现在移动端（iOS/Android）在桌面 OS 之前短路，与 kirostudio 同款。
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    const r = parseUserAgent(ua);
    expect(r.os).toBe('iOS');
    expect(r.mobile).toBe(true);
    expect(r.client).toBe('Safari');
  });

  it('os 修复：iPad 含 "Mac OS X"、Android 含 "Linux"，均不被桌面分支误判', () => {
    const ipad = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    expect(parseUserAgent(ipad).os).toBe('iOS');
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
    expect(parseUserAgent(android).os).toBe('Android');
  });

  it('os 词边界：axios 这类 Node 库 UA 含裸 ios 子串，不误判 iOS', () => {
    // kirostudio 实测踩过：/ios/ 子串匹配让 `axios/1.6.0` 被判成 iOS。
    // 这里 ios 分支用词边界（\b），axios 中 ios 前是单词字符 x，不命中。
    expect(parseUserAgent('axios/1.6.0').os).toBe('unknown');
    expect(parseUserAgent('Kiosk/1.0').os).toBe('unknown');
  });

  it('mobile：Android/iPhone/Mobile 关键字命中即 true', () => {
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 13) Chrome/120.0.0.0 Mobile').mobile).toBe(true);
    expect(parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1').mobile).toBe(true);
    expect(parseUserAgent('curl/8.5.0').mobile).toBe(false);
    expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0').mobile).toBe(false);
  });
});

describe('extractDevice IP 优先级', () => {
  it('CDN 头（cf-connecting-ip）优先于其他一切', () => {
    const d = extractDevice(
      makeReq({
        'cf-connecting-ip': '1.1.1.1',
        'x-real-ip': '2.2.2.2',
        'x-forwarded-for': '3.3.3.3, 4.4.4.4',
      }, '5.5.5.5'),
    );
    expect(d.ip).toBe('1.1.1.1');
  });

  it('无 CDN 头时 x-real-ip 优先于 xff 与 socket', () => {
    const d = extractDevice(makeReq({ 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' }, '5.5.5.5'));
    expect(d.ip).toBe('2.2.2.2');
  });

  it('只有 xff 时取首段并 trim', () => {
    const d = extractDevice(makeReq({ 'x-forwarded-for': ' 3.3.3.3 , 4.4.4.4' }));
    expect(d.ip).toBe('3.3.3.3');
  });

  it('只剩 socket.remoteAddress 时兜底用它', () => {
    const d = extractDevice(makeReq({}, '::ffff:10.0.0.8'));
    expect(d.ip).toBe('::ffff:10.0.0.8');
  });

  it('全部缺省时 ip 为空串', () => {
    expect(extractDevice(makeReq({})).ip).toBe('');
  });

  it('viaProxy：有 cf-connecting-ip 或 cf-ray 即 true', () => {
    expect(extractDevice(makeReq({ 'cf-connecting-ip': '1.1.1.1' })).viaProxy).toBe(true);
    expect(extractDevice(makeReq({ 'cf-ray': '8a2f9c1dabc' })).viaProxy).toBe(true);
    expect(extractDevice(makeReq({ 'x-forwarded-for': '3.3.3.3' })).viaProxy).toBe(false);
  });

  it('language 取 accept-language 首段；forwardedFor 保留 xff 全链', () => {
    const d = extractDevice(makeReq({ 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', 'x-forwarded-for': '3.3.3.3, 4.4.4.4' }));
    expect(d.language).toBe('zh-CN');
    expect(d.forwardedFor).toBe('3.3.3.3, 4.4.4.4');
    expect(extractDevice(makeReq({})).language).toBe('');
  });

  it('ua 原样透传，client 复用 parseUserAgent 结果', () => {
    const d = extractDevice(makeReq({ 'user-agent': 'curl/8.5.0' }));
    expect(d.ua).toBe('curl/8.5.0');
    expect(d.client).toBe('curl');
    // 非字符串头（数组）安全降级为空串，不抛错。
    const arr = extractDevice(makeReq({ 'x-forwarded-for': ['a', 'b'] }));
    expect(arr.forwardedFor).toBe('');
  });
});

describe('recordEvent 与环形缓冲', () => {
  it('id 从 1 单调递增', async () => {
    const m = await fresh();
    m.recordEvent(ev());
    m.recordEvent(ev());
    const snap = m.snapshot();
    expect(snap.events).toHaveLength(2);
    expect(snap.events[0]!.id).toBe(2);
    expect(snap.events[1]!.id).toBe(1);
  });

  it('snapshot().events 最新在前（reverse）', async () => {
    const m = await fresh();
    m.recordEvent(ev({ model: 'first' }));
    m.recordEvent(ev({ model: 'second' }));
    expect(m.snapshot().events.map((e) => e.model)).toEqual(['second', 'first']);
  });

  it('超过 200 条丢最旧：窗口滑到最近的 200 条', async () => {
    const m = await fresh();
    for (let i = 1; i <= 205; i++) m.recordEvent(ev({ model: `m${i}` }));
    const snap = m.snapshot();
    expect(snap.events).toHaveLength(200);
    // 最新在前：第一个是 205，最旧保留的是 6。
    expect(snap.events[0]!.id).toBe(205);
    expect(snap.events[199]!.id).toBe(6);
    // totalRequests 是累计计数，不被窗口截断。
    expect(snap.totalRequests).toBe(205);
    // 窗口外的 1~5 已丢：任何聚合都不该包含它们。
    expect(snap.summary.byModel.some((g) => g.model === 'm1')).toBe(false);
  });
});

describe('snapshot 的 summary 聚合', () => {
  it('ok/failed 按状态码分：2xx 与 3xx 算 ok，>=400 算 failed，101 两边都不算', async () => {
    const m = await fresh();
    m.recordEvent(ev({ status: 200 }));
    m.recordEvent(ev({ status: 201 }));
    m.recordEvent(ev({ status: 399 }));
    m.recordEvent(ev({ status: 400 }));
    m.recordEvent(ev({ status: 500 }));
    m.recordEvent(ev({ status: 101 }));
    const s = m.snapshot().summary;
    expect(s.ok).toBe(3);
    expect(s.failed).toBe(2);
  });

  it('streaming 计数只认 stream 标志', async () => {
    const m = await fresh();
    m.recordEvent(ev({ stream: true, status: 200 }));
    m.recordEvent(ev({ stream: true, status: 500 }));
    m.recordEvent(ev({ stream: false, status: 200 }));
    expect(m.snapshot().summary.streaming).toBe(2);
  });

  it('tokens 分别累计 input/output/thinking', async () => {
    const m = await fresh();
    m.recordEvent(ev({ inputTokens: 100, outputTokens: 50, thinkingTokens: 25 }));
    m.recordEvent(ev({ inputTokens: 200, outputTokens: 100, thinkingTokens: 0 }));
    m.recordEvent(ev({ inputTokens: 300, outputTokens: 30, thinkingTokens: 10 }));
    const s = m.snapshot().summary;
    expect(s.inputTokens).toBe(600);
    expect(s.outputTokens).toBe(180);
    expect(s.thinkingTokens).toBe(35);
  });

  it('实现口径：error 字段不参与计数——status 200 带 error 仍算 ok', async () => {
    // snapshot 只看 status 与 stream，RequestEvent.error 不进 summary。
    const m = await fresh();
    m.recordEvent(ev({ status: 200, error: 'upstream timeout' }));
    const s = m.snapshot().summary;
    expect(s.ok).toBe(1);
    expect(s.failed).toBe(0);
  });

  it('空缓冲：totalRequests 0、avg/p95 0、分组为空', async () => {
    const m = await fresh();
    const snap = m.snapshot();
    expect(snap.totalRequests).toBe(0);
    expect(snap.summary.avgDurationMs).toBe(0);
    expect(snap.summary.p95DurationMs).toBe(0);
    expect(snap.summary.byModel).toEqual([]);
    expect(snap.summary.byClient).toEqual([]);
    expect(snap.summary.byEndpoint).toEqual([]);
    expect(snap.events).toEqual([]);
    expect(typeof snap.uptimeMs).toBe('number');
  });
});

describe('snapshot 的 avg/p95 分位（手算期望值）', () => {
  it('1 个样本：avg 与 p95 都等于该样本', async () => {
    const m = await fresh();
    m.recordEvent(ev({ durationMs: 777 }));
    const s = m.snapshot().summary;
    expect(s.avgDurationMs).toBe(777);
    expect(s.p95DurationMs).toBe(777);
  });

  it('100 个样本 1..100：avg = round(50.5) = 51，p95 = 96', async () => {
    const m = await fresh();
    for (let i = 1; i <= 100; i++) m.recordEvent(ev({ durationMs: i }));
    const s = m.snapshot().summary;
    expect(s.avgDurationMs).toBe(51);
    // floor(100 * 0.95) = 95 → 排序后下标 95 → 第 96 个值。
    expect(s.p95DurationMs).toBe(96);
  });

  it('实现口径：p95 是 nearest-rank（floor 下标），偶数样本不插值', async () => {
    // 20 个样本 1..20：floor(0.95*20)=19 → 取最大值 20。
    // 经典 p95 对 20 个样本通常会插值，这里如实固化「取最大值」的行为。
    const m = await fresh();
    for (let i = 1; i <= 20; i++) m.recordEvent(ev({ durationMs: i }));
    expect(m.snapshot().summary.p95DurationMs).toBe(20);
  });

  it('21 个样本 1..21：floor(19.95)=19 → p95 = 20（不是最大值 21）', async () => {
    const m = await fresh();
    for (let i = 1; i <= 21; i++) m.recordEvent(ev({ durationMs: i }));
    expect(m.snapshot().summary.p95DurationMs).toBe(20);
  });

  it('乱序记录不影响分位（内部先排序）', async () => {
    const m = await fresh();
    for (const d of [50, 10, 40, 20, 30]) m.recordEvent(ev({ durationMs: d }));
    // 排序后 [10,20,30,40,50]，floor(0.95*5)=4 → 50；avg = 150/5 = 30。
    const s = m.snapshot().summary;
    expect(s.p95DurationMs).toBe(50);
    expect(s.avgDurationMs).toBe(30);
  });
});

describe('改写/剥除/压缩计数聚合（summary 窗口求和）', () => {
  it('空缓冲三者都是 0', async () => {
    const m = await fresh();
    const s = m.snapshot().summary;
    expect(s.rewritten).toBe(0);
    expect(s.stripped).toBe(0);
    expect(s.compressed).toBe(0);
  });

  it('按事件求和（每条请求 0/1 触发语义，多事件叠加）', async () => {
    const m = await fresh();
    m.recordEvent(ev({ rewritten: 1, stripped: 1, compressed: 1 }));
    m.recordEvent(ev({ rewritten: 0, stripped: 1, compressed: 0 }));
    m.recordEvent(ev({ rewritten: 1, stripped: 0, compressed: 0 }));
    const s = m.snapshot().summary;
    expect(s.rewritten).toBe(2);
    expect(s.stripped).toBe(2);
    expect(s.compressed).toBe(1);
  });
});

describe('byModel / byClient / byEndpoint 分组与 topN 截断', () => {
  it('byModel 按 count 降序、截断前 8，tokens 是 input+output 之和', async () => {
    const m = await fresh();
    // 10 个模型，count 从 10 递减到 1。
    for (let c = 10; c >= 1; c--) {
      for (let i = 0; i < c; i++) {
        m.recordEvent(ev({ model: `model-${c}`, inputTokens: 1, outputTokens: 2 }));
      }
    }
    const byModel = m.snapshot().summary.byModel;
    expect(byModel).toHaveLength(8);
    expect(byModel[0]).toEqual({ model: 'model-10', count: 10, tokens: 30 });
    expect(byModel[7]).toEqual({ model: 'model-3', count: 3, tokens: 9 });
    // 被截断的 model-2 / model-1 不在结果里。
    expect(byModel.some((g) => g.model === 'model-2')).toBe(false);
  });

  it('byClient 按 count 降序、截断前 6', async () => {
    const m = await fresh();
    for (let c = 8; c >= 1; c--) {
      for (let i = 0; i < c; i++) {
        m.recordEvent(ev({ device: device({ client: `client-${c}` }) }));
      }
    }
    const byClient = m.snapshot().summary.byClient;
    expect(byClient).toHaveLength(6);
    expect(byClient[0]).toEqual({ client: 'client-8', count: 8 });
    expect(byClient[5]).toEqual({ client: 'client-3', count: 3 });
  });

  it('byEndpoint 不截断，按 count 降序，未归属 endpoint 归到 "-" 分组', async () => {
    const m = await fresh();
    m.recordEvent(ev({ endpoint: 'payg' }));
    m.recordEvent(ev({ endpoint: 'payg' }));
    m.recordEvent(ev({ endpoint: 'subscription' }));
    m.recordEvent(ev({ endpoint: '-' }));
    expect(m.snapshot().summary.byEndpoint).toEqual([
      { endpoint: 'payg', count: 2 },
      { endpoint: 'subscription', count: 1 },
      { endpoint: '-', count: 1 },
    ]);
  });

  it('model 空串归到 "-" 分组', async () => {
    const m = await fresh();
    m.recordEvent(ev({ model: '' }));
    expect(m.snapshot().summary.byModel).toEqual([{ model: '-', count: 1, tokens: 0 }]);
  });
});
