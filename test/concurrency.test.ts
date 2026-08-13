/**
 * 高并发回归测试（防倒退）。
 *
 * 生产是 2GB VPS + Node 单线程。热路径已优化：verify 单查询、用量批量异步落库
 * （REQUEST_BATCH_MS/REQUEST_BATCH_MAX）、流式缓冲分段。本文件钉住高并发下的
 * 行为不倒退：
 *
 * - 并发 50 个非流式 /v1/chat/completions → 全 200、错误率 0、上游收到全部请求
 * - 并发 30 个流式 /v1/messages → 全部完整读完（message_stop 收尾）、无断流、
 *   错误率 0
 * - 混合负载（30 非流式 + 20 流式 + 10 面板轮询）→ 全部成功
 * - 高并发 + RPM 滑动窗口（rpm_limit=50，并发 80 → 恰好 50×200 + 30×429）
 * - 高并发下用量批量落库：并发 50 请求完成后 flush → requests 表行数 = 50
 *   （防批量队列丢行）
 *
 * 断言严格：错误率必须 0，不允许任何失败容忍。发现真实并发 bug 时该用例标
 * `it.skip` + 标注「发现 bug：<描述>」，不修 src（由统一修复波处理）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AppConfig } from '../src/config.js';
import { UsageDb } from '../src/usagedb.js';
import { TokensStore } from '../src/tokens.js';
import { createApp } from '../src/server.js';

/** 与 tokens.test.ts 同款的最小 AppConfig。 */
function makeCfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    apiKeys: ['env-key-1'],
    anthropicApiKey: 'sk-ant-fake',
    upstreamKeys: ['sk-ant-fake'],
    keyFailThreshold: 5,
    keyCooldownMs: 300_000,
    anthropicBaseUrl: 'http://placeholder',
    payAsYouGoBaseUrl: 'http://placeholder-payg',
    modelMap: { 'gpt-4o': 'deepseek-v4-flash' },
    fallbackModel: 'deepseek-v4-flash',
    injectionMode: 'block',
    allowUnauthenticated: false,
    maxBodyBytes: 10 * 1024 * 1024,
    maxMessageChars: 200_000,
    maxMessages: 4_000,
    stripControlChars: true,
    trustClaudeCodeHeaders: false,
    dashboardOpen: false,
    dashboardPublic: false,
    usageDbPath: '',
    usageDbRetentionDays: 30,
    keyProbeIntervalMs: 0,
    keyProbeIdleMs: 1_800_000,
    keyProbeTimeoutMs: 5_000,
    gatewaySecret: 'tokens-test-secret',
    secretFilePath: '/dev/null',
    billingIntervalMs: 1_800_000,
    billingTimeoutMs: 20_000,
    oauthClientId: 'opencode-cli',
    oauthConsoleUrl: 'https://console.opencode.ai',
    scaleClientTokens: false,
    clientTokenScale: 0.6657,
    compactEnabled: false,
    compactTriggerBytes: 4 * 1024 * 1024,
    compactMaxMessageChars: 8000,
    adminUser: 'admin',
    adminPass: 'thankyouopencode',
    adminSessionTtlMs: 86_400_000,
    adminLoginFailLimit: 5,
    adminLoginLockMs: 300_000,
    ...over,
  };
}

interface FakeUpstream {
  server: Server;
  baseUrl: string;
  /** 已收到的 chat/completions 请求数。 */
  hits: () => number;
  received: Array<{ model: string; stream: boolean }>;
}

/** 最小假上游：chat completion 非流式 200 JSON / 流式 200 SSE，都带 usage。 */
async function startFakeUpstream(): Promise<FakeUpstream> {
  let hits = 0;
  const received: Array<{ model: string; stream: boolean }> = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-flash-free' }],
        }),
      );
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    hits += 1;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { model?: string; stream?: boolean };
      received.push({ model: parsed.model ?? '', stream: parsed.stream === true });
      if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const base = { id: 'chatcmpl-c', object: 'chat.completion.chunk', created: 1, model: parsed.model };
        const chunks: unknown[] = [
          { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: { content: '你' }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { ...base, choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
        ];
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-fake',
            object: 'chat.completion',
            created: 1,
            model: parsed.model ?? 'deepseek-v4-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`,
    hits: () => hits,
    received,
  };
}

interface Stack {
  db: UsageDb;
  store?: TokensStore;
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
}

describe('高并发回归', () => {
  let fake: FakeUpstream;

  beforeAll(async () => {
    fake = await startFakeUpstream();
  });

  afterAll(async () => {
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  /** 新库新 app：每个用例独立实例，互不串计数。 */
  async function freshStack(over: Partial<AppConfig> = {}, withTokens = false): Promise<Stack> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-conc-'));
    const db = new UsageDb(path.join(dir, 'conc.db'), 30, () => {});
    const cfg = makeCfg({ anthropicBaseUrl: fake.baseUrl, payAsYouGoBaseUrl: fake.baseUrl, ...over });
    const store = withTokens ? new TokensStore(db) : undefined;
    const server = createApp(cfg, undefined, db, null, undefined, undefined, undefined, undefined, store);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    const baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    return {
      db,
      store,
      server,
      baseUrl,
      close: async () => {
        await new Promise<void>((r) => server.close(() => r()));
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  function chatReq(baseUrl: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify(body),
    });
  }

  it(
    '并发 50 个非流式 /v1/chat/completions：全 200、错误率 0、上游收到全部请求',
    { timeout: 30_000 },
    async () => {
      const s = await freshStack();
      try {
        const before = fake.hits();
        const results = await Promise.all(
          Array.from({ length: 50 }, (_, i) =>
            chatReq(s.baseUrl, 'env-key-1', { model: 'gpt-4o', messages: [{ role: 'user', content: `并发-${i}` }] }),
          ),
        );
        expect(results).toHaveLength(50);
        // 错误率必须 0：不允许任何非 200。
        expect(results.map((r) => r.status).filter((st) => st !== 200)).toEqual([]);
        // 每条响应都解析出完整内容（非流式 200 必带 choices[0].message.content）。
        for (const r of results) {
          const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
          expect(j.choices?.[0]?.message?.content).toBeDefined();
        }
        // fake 上游收到全部 50 个请求（无丢请求）。
        expect(fake.hits() - before).toBe(50);
      } finally {
        await s.close();
      }
    },
  );

  it(
    '并发 30 个流式 /v1/messages：全部完整读完（message_stop 收尾）、无断流、错误率 0',
    { timeout: 30_000 },
    async () => {
      const s = await freshStack();
      try {
        const before = fake.hits();
        const results = await Promise.all(
          Array.from({ length: 30 }, (_, i) =>
            fetch(`${s.baseUrl}/v1/messages`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-api-key': 'env-key-1',
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'messages-2023-12-01',
              },
              body: JSON.stringify({
                model: 'deepseek-v4-flash',
                stream: true,
                max_tokens: 256,
                messages: [{ role: 'user', content: `并发流式-${i}` }],
              }),
            }),
          ),
        );
        expect(results).toHaveLength(30);
        for (const r of results) {
          expect(r.status).toBe(200);
          expect(r.headers.get('content-type')).toContain('text/event-stream');
          const text = await r.text();
          // 无断流：message_start 骨架 + message_stop 收尾（断流的流不会有收尾）。
          expect(text).toContain('event: message_start');
          expect(text).toContain('event: message_stop');
          // 内容确实到达。
          expect(text).toContain('text_delta');
          // 干净流：不得出现 error 事件。
          expect(text).not.toContain('event: error');
        }
        // 上游收到全部 30 个流式请求。
        expect(fake.hits() - before).toBe(30);
      } finally {
        await s.close();
      }
    },
  );

  it(
    '混合负载：30 非流式 + 20 流式 + 10 面板轮询全部成功、错误率 0',
    { timeout: 30_000 },
    async () => {
      const s = await freshStack();
      try {
        const before = fake.hits();
        const tasks: Array<Promise<Response>> = [];
        for (let i = 0; i < 30; i++) {
          tasks.push(chatReq(s.baseUrl, 'env-key-1', { model: 'gpt-4o', messages: [{ role: 'user', content: `混合-${i}` }] }));
        }
        for (let i = 0; i < 20; i++) {
          tasks.push(
            chatReq(s.baseUrl, 'env-key-1', { model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: `混合流-${i}` }] }),
          );
        }
        for (let i = 0; i < 10; i++) {
          // 面板轮询：/__metrics（真实面板 2s 轮询的目标，带 API key——
          // dashboardOpen=0 时监控面板要鉴权，生产面板走登录会话/API key）。
          tasks.push(fetch(`${s.baseUrl}/__metrics`, { headers: { 'x-api-key': 'env-key-1' } }));
        }
        const results = await Promise.all(tasks);
        expect(results).toHaveLength(60);
        const nonPanel = results.slice(0, 50);
        const panel = results.slice(50);
        // 面板轮询全部 200。
        for (const r of panel) expect(r.status).toBe(200);
        // 30 非流式 + 20 流式全部 200、错误率 0。
        for (const r of nonPanel) expect(r.status).toBe(200);
        for (const r of nonPanel.slice(0, 30)) {
          const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
          expect(j.choices?.[0]?.message?.content).toBeDefined();
        }
        for (const r of nonPanel.slice(30)) {
          const text = await r.text();
          expect(text).toContain('data: [DONE]');
          expect(text).toContain('你');
        }
        // 上游收到 30 非流式 + 20 流式 = 50 个请求（面板轮询不打上游）。
        expect(fake.hits() - before).toBe(50);
      } finally {
        await s.close();
      }
    },
  );

  it(
    'RPM 滑动窗口：rpm_limit=50 并发 80 → 恰好 50×200 + 30×429，限流的不到上游',
    { timeout: 30_000 },
    async () => {
      const s = await freshStack({}, true);
      try {
        const created = s.store!.create('rpm-conc', null);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const patch = await fetch(`${s.baseUrl}/__admin/api/tokens/${created.value.id}`, {
          method: 'PATCH',
          headers: { 'x-api-key': 'env-key-1', 'content-type': 'application/json' },
          body: JSON.stringify({ rpmLimit: 50 }),
        });
        expect(patch.status).toBe(200);
        const token = created.value.token;

        const before = fake.hits();
        const results = await Promise.all(
          Array.from({ length: 80 }, () =>
            chatReq(s.baseUrl, token, { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
          ),
        );
        expect(results).toHaveLength(80);
        const statuses = results.map((r) => r.status);
        const ok = statuses.filter((st) => st === 200).length;
        const limited = statuses.filter((st) => st === 429).length;
        // 窗口语义：恰好 50 放行、30 拒绝（拒绝也计数，80 个都在同一窗口内）。
        expect(ok).toBe(50);
        expect(limited).toBe(30);
        // 不允许出现 200/429 之外的任何状态。
        expect(statuses.filter((st) => st !== 200 && st !== 429)).toEqual([]);
        // 被限流的 30 个没到上游：上游只收到 50 个。
        expect(fake.hits() - before).toBe(50);
        // 429 全部带 retry-after + OpenAI rate_limit_error 格式。
        for (const r of results.filter((r) => r.status === 429)) {
          const retryAfter = Number(r.headers.get('retry-after'));
          expect(Number.isInteger(retryAfter)).toBe(true);
          expect(retryAfter).toBeGreaterThan(0);
          const j = (await r.json()) as { error: { type: string } };
          expect(j.error.type).toBe('rate_limit_error');
        }
      } finally {
        await s.close();
      }
    },
  );

  it(
    '高并发下用量批量落库：并发 50 请求完成后 flush → requests 表行数 = 50（防批量队列丢行）',
    { timeout: 30_000 },
    async () => {
      const s = await freshStack();
      try {
        const results = await Promise.all(
          Array.from({ length: 50 }, (_, i) =>
            chatReq(s.baseUrl, 'env-key-1', { model: 'gpt-4o', messages: [{ role: 'user', content: `落库-${i}` }] }),
          ),
        );
        // 全部 200，错误率 0。
        for (const r of results) expect(r.status).toBe(200);
        // 批量落库是异步攒批（REQUEST_BATCH_MS=100 / REQUEST_BATCH_MAX=50）：
        // 请求完成时行可能还挂在内存队列里。显式 flush 把积压写空再数行，
        // 钉住「批量队列不丢行」——丢了这里就是 49 或更少。
        const rows = await countRequests(s, 50);
        expect(rows).toBe(50);
      } finally {
        await s.close();
      }
    },
  );
});

/**
 * 轮询等待请求记录全部落库（最多 ~3s），返回 requests 表行数。
 * recordRequest 在响应结束后的 finally 里同步调用，但落库走异步攒批，
 * 显式 flush + 轮询比裸 setTimeout 更稳，避免调度时序导致偶发少计。
 */
async function countRequests(s: Stack, expected: number): Promise<number> {
  const deadline = Date.now() + 3_000;
  let n = 0;
  for (;;) {
    s.db.flush();
    const row = s.db.sqlite()!.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number };
    n = Number(row.n);
    if (n >= expected) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return n;
}
