import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AppConfig } from '../src/config.js';
import { adminOriginAllowed, checkGlobalRpmLimit, checkTokenIpWhitelist, checkTokenQuota, checkTokenRpmLimit, checkTokenTpmLimit, configureRevokedSessions, createApp, gatewayPoolUsage, handlePerformanceRoute, resetRevokedSessionsForTest, revokedSessionCount, revokeSessionForTest, writeChunk } from '../src/server.js';
import type { KeyPool } from '../src/keypool.js';
import { RpmLimiter, TpmLimiter } from '../src/ratelimit.js';
import { UsageDb } from '../src/usagedb.js';
import type { TokensStore } from '../src/tokens.js';

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

describe('gatewayPoolUsage（审计 P0 口径：聚合排除 count_tokens，不止 probe）', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-gw-pool-usage-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('probe/count_tokens/未归属/超窗都不计入；普通请求的 token 与 cost 正确聚合', async () => {
    const db = new UsageDb(path.join(tmpDir, `u-${Math.random().toString(36).slice(2)}.db`), 30, () => {});
    try {
      const ins = db
        .sqlite()!
        .prepare(
          `INSERT INTO requests (at, key_fp, endpoint, status, input_tokens, output_tokens, cost_micro_cents)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
      const now = Date.now();
      // 普通请求：该计入（2 条）。
      ins.run(now, 'fp-abc1', 'chat', 200, 10, 5, 100);
      ins.run(now, 'fp-abc1', 'chat', 200, 20, 10, 200);
      // probe / count_tokens：不该计入请求数，也不该把 token/cost 算进去。
      ins.run(now, 'fp-abc2', 'probe', 200, 5, 5, 0);
      ins.run(now, 'fp-abc3', 'count_tokens', 200, 30, 0, 0);
      // 未归属：不该计入。
      ins.run(now, '-', 'chat', 200, 50, 50, 999);
      // 超窗：不该计入。
      ins.run(now - 8 * 86_400_000, 'fp-abc1', 'chat', 200, 1, 1, 1);

      const r = await gatewayPoolUsage(db, 7);
      expect(r.requests).toBe(2);
      expect(r.inputTokens).toBe(30);
      expect(r.outputTokens).toBe(15);
      expect(r.costMicroCents).toBe(300);
    } finally {
      db.close();
    }
  });

  it('db 不可用/未启用返回全零', async () => {
    expect(await gatewayPoolUsage(null, 7)).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0, costMicroCents: 0 });
    const off = new UsageDb('', 30, () => {});
    expect(await gatewayPoolUsage(off, 7)).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0, costMicroCents: 0 });
  });
});

/** 捕获 sendJson/响应头的最小 ServerResponse 替身。 */
function captureRes(): { res: ServerResponse; status: number; headers: Record<string, string>; body: string } {
  const state = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res = {
    setHeader: (k: string, v: string): void => {
      state.headers[k] = v;
    },
    writeHead: (s: number, h?: Record<string, string>): void => {
      state.status = s;
      if (h) Object.assign(state.headers, h);
    },
    end: (b?: string | Buffer): void => {
      state.body = String(b ?? '');
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status(): number {
      return state.status;
    },
    headers: state.headers,
    get body(): string {
      return state.body;
    },
  };
}

const fakeReq = { resume: () => {} } as unknown as IncomingMessage;

describe('本地 429 限流/配额（审计 P1；X-Error-Scope 头已删 —— 全仓库零消费者）', () => {
  it('RPM 超限：chat/messages 两路径 429 都带 retry-after，body 按协议分形', () => {
    const limiter = new RpmLimiter();
    limiter.check('fp-rpm', 1); // 占满窗口，下一次 check 必拒
    for (const path of ['/v1/chat/completions', '/v1/messages']) {
      const c = captureRes();
      const allowed = checkTokenRpmLimit(fakeReq, c.res, path, 'fp-rpm', 1, limiter, {
        tokenFp: 'fp-rpm',
        error: null,
      } as never);
      expect(allowed).toBe(false);
      expect(c.status).toBe(429);
      expect(Number(c.headers['retry-after'])).toBeGreaterThan(0);
      if (path === '/v1/messages') {
        const b = JSON.parse(c.body) as { type: string; error: { type: string } };
        expect(b.type).toBe('error');
        expect(b.error.type).toBe('rate_limit_error');
      } else {
        const b = JSON.parse(c.body) as { error: { type: string } };
        expect(b.error.type).toBe('rate_limit_error');
      }
    }
  });

  it('配额耗尽：chat/messages 两路径 429 body 按协议分形', () => {
    const quotaStore = { quotaCheck: () => ({ expired: false, exhausted: true }) } as unknown as TokensStore;
    for (const path of ['/v1/chat/completions', '/v1/messages']) {
      const c = captureRes();
      const allowed = checkTokenQuota(fakeReq, c.res, path, { tokenFp: 'fp-quota', error: null } as never, quotaStore);
      expect(allowed).toBe(false);
      expect(c.status).toBe(429);
      if (path === '/v1/messages') {
        const b = JSON.parse(c.body) as { type: string; error: { type: string } };
        expect(b.type).toBe('error');
        expect(b.error.type).toBe('rate_limit_error'); // Anthropic 兼容：body 仍是 rate_limit_error
      } else {
        const b = JSON.parse(c.body) as { error: { type: string } };
        expect(b.error.type).toBe('insufficient_quota');
      }
    }
  });

  it('M-3：周期配额 429 retry-after = 距下次重置秒数；无周期不带（naive 客户端不死循环）', () => {
    const now = Date.now();
    // daily/monthly 周期：下一重置在 2h 后 → retry-after = 7200s。
    const periodStore = {
      quotaCheck: () => ({ expired: false, exhausted: true, resetAt: now + 7_200_000 }),
    } as unknown as TokensStore;
    for (const path of ['/v1/chat/completions', '/v1/messages']) {
      const c = captureRes();
      const allowed = checkTokenQuota(fakeReq, c.res, path, { tokenFp: 'fp-quota', error: null } as never, periodStore);
      expect(allowed).toBe(false);
      expect(c.status).toBe(429);
      expect(Number(c.headers['retry-after'])).toBe(7200); // ceil((resetAt-now)/1000)
    }
    // 无周期（none，quotaCheck.resetAt=0）：不带 retry-after —— 配额不会自动重置，
    // 硬编码 1s 让 naive 客户端死循环重试刷屏（M-3 对抗审查）。
    const noneStore = { quotaCheck: () => ({ expired: false, exhausted: true, resetAt: 0 }) } as unknown as TokensStore;
    const c = captureRes();
    checkTokenQuota(fakeReq, c.res, '/v1/chat/completions', { tokenFp: 'fp-quota', error: null } as never, noneStore);
    expect(c.status).toBe(429);
    expect(c.headers['retry-after']).toBeUndefined();
    // 下限：距重置不足 1s → retry-after 至少 1。
    const nearStore = {
      quotaCheck: () => ({ expired: false, exhausted: true, resetAt: Date.now() + 100 }),
    } as unknown as TokensStore;
    const c2 = captureRes();
    checkTokenQuota(fakeReq, c2.res, '/v1/chat/completions', { tokenFp: 'fp-quota', error: null } as never, nearStore);
    expect(Number(c2.headers['retry-after'])).toBe(1);
  });

  it('过期 403：不写限流头（403 语义，无 retry-after）', () => {
    const expiredStore = { quotaCheck: () => ({ expired: true, exhausted: false }) } as unknown as TokensStore;
    const c = captureRes();
    checkTokenQuota(fakeReq, c.res, '/v1/chat/completions', { tokenFp: 'fp-quota', error: null } as never, expiredStore);
    expect(c.status).toBe(403);
    expect(c.headers['retry-after']).toBeUndefined();
  });

  it('不限流/无配额放行：不写 429 相关头', () => {
    const limiter = new RpmLimiter();
    const c = captureRes();
    expect(
      checkTokenRpmLimit(fakeReq, c.res, '/v1/chat/completions', 'fp', 0, limiter, { tokenFp: 'fp', error: null } as never),
    ).toBe(true);
    expect(c.headers['retry-after']).toBeUndefined();
    const c2 = captureRes();
    expect(
      checkTokenQuota(fakeReq, c2.res, '/v1/chat/completions', { tokenFp: null, error: null } as never, null),
    ).toBe(true);
    expect(c2.headers['retry-after']).toBeUndefined();
  });

  it('全局 RPM：limit<=0 关闭（恒放行不占窗口）；window 未满放行', () => {
    const limiter = new RpmLimiter();
    const c = captureRes();
    expect(checkGlobalRpmLimit(fakeReq, c.res, '/v1/chat/completions', 0, limiter, { tokenFp: null, error: null } as never)).toBe(true);
    expect(c.headers['retry-after']).toBeUndefined();
    expect(limiter.size()).toBe(0); // 关闭时不占全局窗口
    const c2 = captureRes();
    expect(checkGlobalRpmLimit(fakeReq, c2.res, '/v1/chat/completions', 5, limiter, { tokenFp: null, error: null } as never)).toBe(true);
    expect(c2.status).toBe(0); // 放行不写响应
  });

  it('全局 RPM：窗口打满 → 429 带 retry-after，body 按协议分形', () => {
    for (const path of ['/v1/chat/completions', '/v1/messages']) {
      const limiter = new RpmLimiter();
      limiter.check('__global__', 1); // 占满全局窗口
      const c = captureRes();
      const allowed = checkGlobalRpmLimit(fakeReq, c.res, path, 1, limiter, { tokenFp: null, error: null } as never);
      expect(allowed).toBe(false);
      expect(c.status).toBe(429);
      expect(Number(c.headers['retry-after'])).toBeGreaterThan(0);
      if (path === '/v1/messages') {
        const b = JSON.parse(c.body) as { type: string; error: { type: string; message: string } };
        expect(b.type).toBe('error');
        expect(b.error.type).toBe('rate_limit_error');
        expect(b.error.message).toContain('global rate limit exceeded');
      } else {
        const b = JSON.parse(c.body) as { error: { type: string; message: string } };
        expect(b.error.type).toBe('rate_limit_error');
        expect(b.error.message).toContain('global rate limit exceeded');
      }
    }
  });

  it('TPM：当前分钟已用 >= limit → 429（retry-after 到下一分钟边界），未超放行', () => {
    // quotaCheck mock 返回 tpmLimit=5（复用配额快照的口径）。
    const tpmStore = { quotaCheck: () => ({ tpmLimit: 5 }) } as unknown as TokensStore;
    // 已用 6 >= 5 → 429。
    const limiter = new TpmLimiter();
    limiter.add('fp-tpm', 6, Date.now());
    const c = captureRes();
    const allowed = checkTokenTpmLimit(fakeReq, c.res, '/v1/chat/completions', { tokenFp: 'fp-tpm', error: null } as never, tpmStore, limiter);
    expect(allowed).toBe(false);
    expect(c.status).toBe(429);
    expect(Number(c.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(c.headers['retry-after'])).toBeLessThanOrEqual(60); // 到下一分钟边界 ≤ 60s
    const b = JSON.parse(c.body) as { error: { type: string; message: string } };
    expect(b.error.type).toBe('rate_limit_error');
    expect(b.error.message).toContain('TPM limit exceeded');
    // 已用 3 < 5 → 放行。
    const limiter2 = new TpmLimiter();
    limiter2.add('fp-tpm2', 3, Date.now());
    const c2 = captureRes();
    expect(checkTokenTpmLimit(fakeReq, c2.res, '/v1/chat/completions', { tokenFp: 'fp-tpm2', error: null } as never, tpmStore, limiter2)).toBe(true);
    expect(c2.status).toBe(0);
  });

  it('TPM：quota_tpm=0 不限流；无 token（tokenFp null）跳过', () => {
    const unlimitedStore = { quotaCheck: () => ({ tpmLimit: 0 }) } as unknown as TokensStore;
    const limiter = new TpmLimiter();
    limiter.add('fp', 999, Date.now());
    const c = captureRes();
    expect(checkTokenTpmLimit(fakeReq, c.res, '/v1/chat/completions', { tokenFp: 'fp', error: null } as never, unlimitedStore, limiter)).toBe(true);
    expect(c.status).toBe(0);
    const c2 = captureRes();
    expect(checkTokenTpmLimit(fakeReq, c2.res, '/v1/chat/completions', { tokenFp: null, error: null } as never, null, limiter)).toBe(true);
  });

  it('IP 白名单：命中放行；未命中 403 ip not allowed（OpenAI/Anthropic 形状）；空列表/无 token 放行', () => {
    const reqWithIp = (ip: string): IncomingMessage => ({ resume: () => {}, socket: { remoteAddress: ip } } as unknown as IncomingMessage);
    const whitelisted = { quotaCheck: () => ({ ipWhitelist: ['1.2.3.4', '10.0.0.0/8'] }) } as unknown as TokensStore;
    // 精确命中。
    const c = captureRes();
    expect(checkTokenIpWhitelist(reqWithIp('1.2.3.4'), c.res, '/v1/chat/completions', { tokenFp: 'fp', error: null } as never, whitelisted)).toBe(true);
    expect(c.status).toBe(0);
    // CIDR 命中。
    const c2 = captureRes();
    expect(checkTokenIpWhitelist(reqWithIp('10.20.30.40'), c2.res, '/v1/chat/completions', { tokenFp: 'fp', error: null } as never, whitelisted)).toBe(true);
    // 未命中 → 403（OpenAI 形状）。
    const c3 = captureRes();
    const denied = checkTokenIpWhitelist(reqWithIp('5.6.7.8'), c3.res, '/v1/chat/completions', { tokenFp: 'fp', error: null } as never, whitelisted);
    expect(denied).toBe(false);
    expect(c3.status).toBe(403);
    const b3 = JSON.parse(c3.body) as { error: { message: string; type: string } };
    expect(b3.error.message).toBe('ip not allowed');
    expect(b3.error.type).toBe('invalid_request_error');
    // Anthropic 形状。
    const c4 = captureRes();
    checkTokenIpWhitelist(reqWithIp('5.6.7.8'), c4.res, '/v1/messages', { tokenFp: 'fp', error: null } as never, whitelisted);
    const b4 = JSON.parse(c4.body) as { type: string; error: { type: string; message: string } };
    expect(b4.type).toBe('error');
    expect(b4.error.type).toBe('authentication_error');
    // 空列表 = 不限；无 socket/无 token 放行。
    const open = { quotaCheck: () => ({ ipWhitelist: [] }) } as unknown as TokensStore;
    const c5 = captureRes();
    expect(checkTokenIpWhitelist(fakeReq, c5.res, '/v1/chat/completions', { tokenFp: 'fp', error: null } as never, open)).toBe(true);
    const c6 = captureRes();
    expect(checkTokenIpWhitelist(fakeReq, c6.res, '/v1/chat/completions', { tokenFp: null, error: null } as never, null)).toBe(true);
  });
});

describe('configureRevokedSessions 加载（M-2：加载后只写一次，不再每条全量写盘）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    configureRevokedSessions(null); // 恢复模块级路径为内存态，避免污染其他用例
    resetRevokedSessionsForTest();
  });

  it('加载 N 条未过期条目只写盘一次（writeFileSync/renameSync 各一次）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-revoked-'));
    const file = path.join(dir, 'revoked-sessions.json');
    try {
      const entries: Record<string, number> = {};
      for (let i = 0; i < 5; i++) {
        entries[`${'a'.repeat(62)}${i}`] = Date.now() + 3_600_000; // 未过期签名
      }
      fs.writeFileSync(file, JSON.stringify(entries));
      const writes = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      const renames = vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

      configureRevokedSessions(file);

      expect(revokedSessionCount()).toBe(5);
      // 修复前：每条 addRevokedSession 都全量写盘（tmp+rename）→ 5 条 = 5 次写盘
      // （O(N²) 写放大）。修复后：加载统一写一次。
      expect(writes).toHaveBeenCalledTimes(1);
      expect(renames).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('全是过期条目 → 加载后不写盘（启动即写盘是回归）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-revoked-'));
    const file = path.join(dir, 'revoked-sessions.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ ['b'.repeat(64)]: Date.now() - 1000 }));
      const writes = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      const renames = vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

      configureRevokedSessions(file);

      expect(revokedSessionCount()).toBe(0);
      expect(writes).not.toHaveBeenCalled();
      expect(renames).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P2：持久化写盘失败 → console.warn 含原因（登出撤销丢失必须可见，不再静默吞）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-revoked-'));
    const file = path.join(dir, 'revoked-sessions.json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      configureRevokedSessions(file);
      // 制造写盘失败（rename 阶段抛错），验证失败不再静默、warn 带原因。
      vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('EACCES: permission denied, rename');
      });
      revokeSessionForTest('c'.repeat(64), Date.now() + 3_600_000);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0]?.[0] ?? '');
      expect(msg).toContain('revoked-sessions');
      expect(msg).toContain('EACCES');
    } finally {
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /__admin/api/performance（鉴权 / Origin / 字段契约）', () => {
  let tmpDir: string;
  let db: UsageDb;
  let proxy: ReturnType<typeof createApp>;
  let baseUrl: string;
  const H = { 'x-api-key': 'secret-key' };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-perf-http-'));
    db = new UsageDb(path.join(tmpDir, 'perf.db'), 30, () => {});
    proxy = createApp(baseCfg(), undefined, db);
    baseUrl = await listen(proxy);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('未带管理凭据 → 401', async () => {
    const r = await fetch(`${baseUrl}/__admin/api/performance`);
    expect(r.status).toBe(401);
  });

  it('跨站 Origin → 403（读端点同 requests/audit 门槛）', async () => {
    const r = await fetch(`${baseUrl}/__admin/api/performance`, {
      headers: { ...H, origin: 'https://evil.example' },
    });
    expect(r.status).toBe(403);
  });

  it('200 且返回 process/os/gateway/latency/oom 全字段', async () => {
    const r = await fetch(`${baseUrl}/__admin/api/performance`, { headers: H });
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      ok: boolean;
      data: {
        now: number;
        process: { rss: number; heapUsed: number; heapTotal: number; uptime: number; cpuPercent: number };
        os: { loadAvg: number[]; totalMem: number; freeMem: number; cpuCount: number };
        gateway: { concurrentInFlight: number; maxConcurrent: number; pool: { healthy: number; total: number } };
        latency: { p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number; count: number; sampled: number; windowMs: number; available: boolean };
        oom: null;
      };
    };
    expect(j.ok).toBe(true);
    const d = j.data;
    expect(d.now).toBeGreaterThan(0);
    expect(d.process.rss).toBeGreaterThan(0);
    expect(d.process.heapUsed).toBeGreaterThan(0);
    expect(d.process.heapTotal).toBeGreaterThan(0);
    expect(d.process.uptime).toBeGreaterThanOrEqual(0);
    expect(typeof d.process.cpuPercent).toBe('number');
    expect(d.os.loadAvg).toHaveLength(3);
    expect(d.os.totalMem).toBeGreaterThan(0);
    expect(d.os.freeMem).toBeGreaterThan(0);
    expect(d.os.cpuCount).toBeGreaterThan(0);
    expect(d.gateway.concurrentInFlight).toBe(0);
    expect(d.gateway.maxConcurrent).toBe(400);
    expect(d.gateway.pool.total).toBe(2); // cfg.upstreamKeys 2 个
    expect(d.gateway.pool.healthy).toBe(2);
    expect(d.oom).toBeNull();
    expect(d.latency.available).toBe(true); // 接了 db
    expect(d.latency.windowMs).toBe(5 * 60_000);
    expect(d.latency.count).toBe(0);
  });
});

describe('GET /__admin/api/performance（10s TTL 缓存）', () => {
  let tmpDir: string;
  let db: UsageDb;
  let proxy: ReturnType<typeof createApp>;
  let baseUrl: string;
  const H = { 'x-api-key': 'secret-key' };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-perf-cache-'));
    db = new UsageDb(path.join(tmpDir, 'cache.db'), 30, () => {});
    proxy = createApp(baseCfg(), undefined, db);
    baseUrl = await listen(proxy);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('TTL 窗口内二次调用命中缓存：窗口内新增请求不被重查（count/max 稳定）', async () => {
    const ins = db
      .sqlite()!
      .prepare(`INSERT INTO requests (at, key_fp, endpoint, status, duration_ms) VALUES (?, ?, 'chat', 200, ?)`);
    const now = Date.now();
    ins.run(now, 'fp-perf', 100);
    ins.run(now, 'fp-perf', 300);
    const r1 = await fetch(`${baseUrl}/__admin/api/performance`, { headers: H });
    const d1 = (await r1.json()) as { data: { latency: { count: number; maxMs: number } } };
    expect(d1.data.latency.count).toBe(2);
    expect(d1.data.latency.maxMs).toBe(300);
    // 缓存窗口内插入新行（模拟实时流量）：二次调用应命中 10s 缓存、不重查 DB。
    ins.run(now, 'fp-perf', 900);
    const r2 = await fetch(`${baseUrl}/__admin/api/performance`, { headers: H });
    const d2 = (await r2.json()) as { data: { latency: { count: number; maxMs: number } } };
    expect(d2.data.latency.count).toBe(2);
    expect(d2.data.latency.maxMs).toBe(300);
  });
});

describe('handlePerformanceRoute（注入时钟驱动 10s TTL 过期）', () => {
  it('未过期复用；跨过 TTL 重查并反映新增行', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-perf-ttl-'));
    try {
      const db2 = new UsageDb(path.join(dir, 'ttl.db'), 30, () => {});
      try {
        const ins = db2
          .sqlite()!
          .prepare(`INSERT INTO requests (at, key_fp, endpoint, status, duration_ms) VALUES (?, ?, 'chat', 200, ?)`);
        let clock = 1_000_000;
        const cache = { at: 0, data: null };
        const deps = {
          cfg: baseCfg(),
          db: db2,
          pool: { snapshot: () => [] } as unknown as KeyPool,
          inFlight: () => 0,
          cache,
          cpuSample: { at: 0, usage: { user: 0, system: 0 } },
          now: () => clock,
        };
        const call = async (): Promise<{ latency: { count: number; maxMs: number } }> => {
          const c = captureRes();
          await handlePerformanceRoute({} as IncomingMessage, c.res, deps);
          return (JSON.parse(c.body) as { data: { latency: { count: number; maxMs: number } } }).data;
        };
        ins.run(clock, 'fp-perf', 100);
        ins.run(clock, 'fp-perf', 300);
        const d1 = await call();
        expect(d1.latency.count).toBe(2);
        expect(d1.latency.maxMs).toBe(300);
        // +5s（未过期）：插入新行不重查
        ins.run(clock, 'fp-perf', 900);
        clock += 5_000;
        const d2 = await call();
        expect(d2.latency.count).toBe(2);
        // 跨过 10s TTL：重查，反映新增行
        clock += 5_001;
        const d3 = await call();
        expect(d3.latency.count).toBe(3);
        expect(d3.latency.maxMs).toBe(900);
      } finally {
        db2.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
