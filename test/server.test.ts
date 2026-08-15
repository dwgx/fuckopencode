import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AppConfig } from '../src/config.js';
import { adminOriginAllowed, createApp, writeChunk } from '../src/server.js';

/**
 * 模拟 ServerResponse 的背压语义：write 恒返回 false（内核缓冲已满）、不主动触发
 * drain（半死连接：TCP 存活但不读）、destroy() 触发 'close'（并发门/上游释放的
 * 挂载点，见 createApp 的 res.on('finish'|'close', release)）。
 */
class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  write(): boolean {
    return false;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

describe('writeChunk（S-P1-1：半死连接 drain 永不触发不再挂死流式循环）', () => {
  it('write 返回 true：立即 resolve，不 destroy', async () => {
    const res = new FakeResponse();
    res.write = () => true;
    await writeChunk(res as unknown as ServerResponse, 'data', 100);
    expect(res.destroyed).toBe(false);
  });

  it('write 返回 false + drain 触发：resolve 且不 destroy（慢但仍在读的客户端不受影响）', async () => {
    const res = new FakeResponse();
    setTimeout(() => res.emit('drain'), 20);
    await writeChunk(res as unknown as ServerResponse, 'data', 500);
    expect(res.destroyed).toBe(false);
    // I-7：监听器收尾移除，长流背压下不累积。
    expect(res.listenerCount('drain')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
    expect(res.listenerCount('error')).toBe(0);
  });

  it('客户端断开（close）：resolve 且不 destroy（调用循环靠 res.destroyed 退出）', async () => {
    const res = new FakeResponse();
    setTimeout(() => res.emit('close'), 20);
    await writeChunk(res as unknown as ServerResponse, 'data', 500);
    expect(res.destroyed).toBe(false);
  });

  it('半死连接：drain 永不触发 → 超时 destroy，触发 close 释放并发门（回归：去掉超时会挂死）', async () => {
    const res = new FakeResponse();
    let gateReleased = 0;
    // 镜像 createApp 的并发门挂载点：res 'close' 释放并发计数。
    res.on('close', () => gateReleased++);
    const started = Date.now();
    await writeChunk(res as unknown as ServerResponse, 'data', 50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(res.destroyed).toBe(true);
    expect(gateReleased).toBe(1);
  });

  it('error 事件：reject（循环进 catch/finally，释放上游计数）', async () => {
    const res = new FakeResponse();
    const p = writeChunk(res as unknown as ServerResponse, 'data', 100);
    const err = new Error('boom');
    setTimeout(() => res.emit('error', err), 10);
    await expect(p).rejects.toBe(err);
    expect(res.destroyed).toBe(false);
  });
});

/** adminOriginAllowed 只读 req.headers，fake req 用最小形状 + as never 断言。 */
function fakeOriginReq(headers: Record<string, unknown>): never {
  return { headers } as never;
}

describe('P1：server adminOriginAllowed 多值 Origin 数组头 fail-closed（对齐 admin.ts originAllowed）', () => {
  it('数组头（多 Origin）按拒绝处理', () => {
    expect(adminOriginAllowed(fakeOriginReq({ origin: ['https://good.example', 'https://evil.example'], host: 'good.example' }))).toBe(false);
    expect(adminOriginAllowed(fakeOriginReq({ origin: ['https://good.example'], host: 'good.example' }))).toBe(false);
  });

  it('单值同源放行；跨站/跨端口拒绝', () => {
    expect(adminOriginAllowed(fakeOriginReq({ origin: 'https://good.example', host: 'good.example' }))).toBe(true);
    expect(adminOriginAllowed(fakeOriginReq({ origin: 'https://good.example:443', host: 'good.example' }))).toBe(true);
    expect(adminOriginAllowed(fakeOriginReq({ origin: 'https://evil.example', host: 'good.example' }))).toBe(false);
    expect(adminOriginAllowed(fakeOriginReq({ origin: 'https://good.example:8443', host: 'good.example' }))).toBe(false);
  });

  it('无 Origin / 空 Origin 放行（curl 等非浏览器场景）', () => {
    expect(adminOriginAllowed(fakeOriginReq({}))).toBe(true);
    expect(adminOriginAllowed(fakeOriginReq({ origin: '', host: 'good.example' }))).toBe(true);
  });
});

function baseCfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    apiKeys: ['secret-key'],
    anthropicApiKey: 'sk-fake',
    upstreamKeys: ['sk-fake-1', 'sk-fake-2'],
    keyFailThreshold: 5,
    keyCooldownMs: 300_000,
    anthropicBaseUrl: 'http://placeholder',
    payAsYouGoBaseUrl: 'http://placeholder-payg',
    modelMap: {},
    fallbackModel: 'deepseek-v4-flash',
    injectionMode: 'block',
    allowUnauthenticated: false,
    maxBodyBytes: 10 * 1024 * 1024,
    maxMessageChars: 200_000,
    maxMessages: 4_000,
    stripControlChars: true,
    trustClaudeCodeHeaders: false,
    dashboardOpen: false,
    dashboardPublic: true,
    usageDbPath: '',
    usageDbRetentionDays: 30,
    keyProbeIntervalMs: 0,
    keyProbeIdleMs: 1_800_000,
    keyProbeTimeoutMs: 5_000,
    gatewaySecret: null,
    secretFilePath: 'data/secret.key',
    billingIntervalMs: 1_800_000,
    billingTimeoutMs: 20_000,
    oauthClientId: 'opencode-cli',
    oauthConsoleUrl: 'https://console.opencode.ai',
    scaleClientTokens: false,
    clientTokenScale: 0.6657,
    compactEnabled: false,
    compactTriggerBytes: 4 * 1024 * 1024,
    compactMaxMessageChars: 8000,
    adminUser: 'admin', adminPass: 'thankyouopencode', adminSessionTtlMs: 86_400_000, adminLoginFailLimit: 5, adminLoginLockMs: 300_000,
    ...over,
  } as unknown as AppConfig;
}

async function listen(server: ReturnType<typeof createApp>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  return `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
}

describe('/__metrics 公网匿名 device 白名单（M-P2-1）', () => {
  let proxy: ReturnType<typeof createApp>;
  let baseUrl: string;

  beforeAll(async () => {
    proxy = createApp(baseCfg());
    baseUrl = await listen(proxy);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  it('匿名 device 只留 client/os/mobile 之类，剥 ip/ua/forwardedFor；管理鉴权保留完整', async () => {
    // 造一条带特征 IP/UA/xff 的真实请求（API key 放行，进 events）。
    const r = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        'x-api-key': 'secret-key',
        'cf-connecting-ip': '9.9.9.9',
        'user-agent': 'Mozilla-test-ua',
        'x-forwarded-for': '4.4.4.4, 5.5.5.5',
      },
    });
    expect(r.status).toBe(200);

    // 匿名（带 CDN 头模拟公网，无 key）→ device 只剩非身份字段。
    const anon = (await (
      await fetch(`${baseUrl}/__metrics`, { headers: { 'cf-connecting-ip': '8.8.8.8' } })
    ).json()) as { events: Array<{ path: string; device: Record<string, unknown> }> };
    const anonEv = anon.events.find((e) => e.path === '/v1/models');
    expect(anonEv).toBeDefined();
    for (const k of ['ip', 'ua', 'forwardedFor']) expect(k in anonEv!.device).toBe(false);
    // 非身份字段保留（面板还能按客户端构成统计）。
    for (const k of ['client', 'os', 'mobile']) expect(k in anonEv!.device).toBe(true);

    // 管理鉴权（API key）→ device 完整，ip/ua/xff 都可见。
    const admin = (await (
      await fetch(`${baseUrl}/__metrics`, { headers: { 'x-api-key': 'secret-key', 'cf-connecting-ip': '8.8.8.8' } })
    ).json()) as { events: Array<{ path: string; device: Record<string, unknown> }> };
    const adminEv = admin.events.find((e) => e.path === '/v1/models');
    expect(adminEv).toBeDefined();
    expect(adminEv!.device.ip).toBe('9.9.9.9');
    expect(adminEv!.device.ua).toBe('Mozilla-test-ua');
    expect(adminEv!.device.forwardedFor).toBe('4.4.4.4, 5.5.5.5');
  });
});

describe('chat 路径限长读上游错误体（S-P2-5 直通路径同款，M-P2-5 同类修复）', () => {
  let fake: { server: Server; calls: number };
  let proxy: ReturnType<typeof createApp>;
  let baseUrl: string;

  beforeAll(async () => {
    // 假上游：第一次回超大非 JSON 错误体（>64KB HTML，旧 `.json()` 会整读进堆），
    // 第二次回正常 200 —— 验证网关限长读取后还能换 key 重试成功。
    fake = {
      calls: 0,
      server: createServer((req: IncomingMessage, res: ServerResponse) => {
        req.resume();
        fake.calls++;
        if (fake.calls === 1) {
          const huge = `<html><body>${'x'.repeat(200_000)}</body></html>`;
          res.writeHead(502, { 'content-type': 'text/html', 'content-length': String(Buffer.byteLength(huge)) });
          res.end(huge);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: 'deepseek-v4-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }),
    };
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    const a = fake.server.address();
    const fakeBase = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;

    proxy = createApp(baseCfg({ anthropicBaseUrl: fakeBase }));
    baseUrl = await listen(proxy);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  it('上游超大错误体 → 限长读取不挂死，换 key 重试成功', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]!.message.content).toBe('hi');
    // 第一次请求确实吃了那个大错误体（路径被真正走到）
    expect(fake.calls).toBeGreaterThanOrEqual(2);
  });
});
