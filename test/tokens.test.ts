/**
 * 分发密钥系统（src/tokens.ts + /__admin/api/tokens 端点）测试。
 *
 * 覆盖：
 * - generateToken / fingerprintOf / maskOf（前缀、长度、唯一性、确定性）
 * - TokensStore：create/list/get/update/delete/verify（active 匹配、disabled
 *   拒绝、未知拒绝、删除后拒绝）、db 不可用降级（fail-closed）
 * - HTTP：创建（token 明文仅此一次）、列表（掩码）、PATCH 状态/改名、DELETE、
 *   校验矩阵、审计、Origin 校验
 * - e2e 鉴权：分发 token 走数据面（/v1/models 与完整 chat 链路）200；
 *   disabled / 未知 / 无凭据 401；API_KEYS 优先于分发 token
 * - tokens 端点鉴权矩阵：无凭据 401 / API key 200 / 会话 cookie 200
 * - 用量聚合：requests 按 token_fp 聚合（请求数 / tokens / cost）
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AppConfig } from '../src/config.js';
import { UsageDb } from '../src/usagedb.js';
import { fingerprintOf, generateToken, maskOf, TokensStore } from '../src/tokens.js';
import { createApp } from '../src/server.js';

/** 与 e2e.test.ts 同款的最小 AppConfig。 */
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

/** 最小假上游：chat completion 200 + usage（cost 带真实记账值）。hits() 数收到的请求。 */
async function startFakeUpstream(): Promise<{ server: Server; baseUrl: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        cost: '1234',
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  return { server, baseUrl: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`, hits: () => hits };
}

describe('generateToken / fingerprint / mask', () => {
  it('token 形如 tk- + 64 hex（32 字节随机）', () => {
    for (let i = 0; i < 50; i++) {
      const { token, fingerprint } = generateToken();
      expect(token).toMatch(/^tk-[0-9a-f]{64}$/);
      expect(fingerprint).toMatch(/^[0-9a-f]{24}$/);
      expect(fingerprintOf(token)).toBe(fingerprint);
    }
  });

  it('生成结果唯一（128-bit 随机）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { token } = generateToken();
      expect(seen.has(token)).toBe(false);
      seen.add(token);
    }
  });

  it('指纹确定性：同一 token 恒同指纹，且不等于 token', () => {
    const { token, fingerprint } = generateToken();
    expect(fingerprintOf(token)).toBe(fingerprint);
    expect(fingerprint).not.toBe(token);
  });

  it('掩码：tk-**** + 指纹末 8 位（可辨认不可逆推）', () => {
    const { fingerprint } = generateToken();
    expect(maskOf(fingerprint)).toBe(`tk-****${fingerprint.slice(-8)}`);
  });
});

describe('TokensStore', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tokens-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('create/list/get/update/delete 全流程 + verify 状态机', () => {
    const db = new UsageDb(path.join(tmpDir, 'store.db'), 30, () => {});
    const store = new TokensStore(db);
    expect(store.enabled).toBe(true);
    expect(store.list()).toEqual([]);

    const a = store.create('cli-a', '主客户端');
    const b = store.create('cli-b', null);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.token).toMatch(/^tk-[0-9a-f]{64}$/);
    expect(a.value.fingerprint).toBe(fingerprintOf(a.value.token));

    // 列表：掩码、状态、note；不含 token 明文。
    const rows = store.list();
    expect(rows).toHaveLength(2);
    const rowA = rows.find((r) => r.id === a.value.id)!;
    expect(rowA.name).toBe('cli-a');
    expect(rowA.fingerprint).toBe(a.value.fingerprint);
    expect(rowA.mask).toBe(maskOf(a.value.fingerprint));
    expect(rowA.status).toBe('active');
    expect(rowA.note).toBe('主客户端');
    expect(rowA.createdAt).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(a.value.token);

    // verify：active 匹配、未知拒绝。
    expect(store.verify(a.value.token)).toEqual({ ok: true, fingerprint: a.value.fingerprint, rpmLimit: 0 });
    expect(store.verify('tk-' + '0'.repeat(64)).ok).toBe(false);

    // 禁用 → verify 拒绝；恢复 → 放行；改名生效。
    expect(store.update(a.value.id, { status: 'disabled' })).toBe('ok');
    expect(store.verify(a.value.token).ok).toBe(false);
    expect(store.update(a.value.id, { status: 'active', name: 'cli-a-renamed' })).toBe('ok');
    expect(store.verify(a.value.token).ok).toBe(true);
    expect(store.get(a.value.id)!.name).toBe('cli-a-renamed');

    // 不存在的 id：update 返回 missing、get null。
    expect(store.update(9999, { name: 'x' })).toBe('missing');
    expect(store.get(9999)).toBeNull();

    // 删除：幂等；删除后 verify 拒绝。
    expect(store.delete(a.value.id)).toBe(true);
    expect(store.delete(a.value.id)).toBe(true);
    expect(store.verify(a.value.token).ok).toBe(false);
    expect(store.list()).toHaveLength(1);
    db.close();
  });

  it('降级：db 不可用 → verify 恒失败（fail-closed）、list 空、写操作 false', () => {
    const db = new UsageDb('', 30, () => {});
    const store = new TokensStore(db);
    expect(store.enabled).toBe(false);
    expect(store.verify('tk-' + 'a'.repeat(64)).ok).toBe(false);
    expect(store.list()).toEqual([]);
    expect(store.create('x', null).ok).toBe(false);
    expect(store.update(1, { name: 'x' })).toBe(false);
    expect(store.delete(1)).toBe(false);
    expect(store.usage()).toEqual([]);
    expect(store.getRpmLimit('abc')).toBe(0);
    const store2 = new TokensStore(null);
    expect(store2.verify('anything').ok).toBe(false);
  });

  it('rpmLimit：默认 0，update 持久化，getRpmLimit 按指纹读（未知/不可用归 0）', () => {
    const db = new UsageDb(path.join(tmpDir, 'rpm.db'), 30, () => {});
    const store = new TokensStore(db);
    const a = store.create('rpm-key', null);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(store.get(a.value.id)!.rpmLimit).toBe(0);
    expect(store.getRpmLimit(a.value.fingerprint)).toBe(0);
    expect(store.update(a.value.id, { rpmLimit: 5 })).toBe('ok');
    expect(store.get(a.value.id)!.rpmLimit).toBe(5);
    expect(store.getRpmLimit(a.value.fingerprint)).toBe(5);
    // 未知指纹 / 脏数据（负值）都归 0，不产生「负数限流」意外行为。
    expect(store.getRpmLimit('000000000000000000000000')).toBe(0);
    expect(store.verify(a.value.token).ok).toBe(true); // rpmLimit 不影响校验
    db.close();
  });

  it('verify 单次点查即带回 rpmLimit（与 getRpmLimit 同口径，0 = 不限流）', () => {
    const db = new UsageDb(path.join(tmpDir, 'verify-rpm.db'), 30, () => {});
    const store = new TokensStore(db);
    const a = store.create('verify-rpm', null);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    // 默认 rpm_limit=0：verify 返回 0（不限流），与 getRpmLimit 一致。
    expect(store.verify(a.value.token)).toEqual({ ok: true, fingerprint: a.value.fingerprint, rpmLimit: 0 });
    // 设 7 后 verify 在同一次点查里带出 7 —— 调用方不再需要为同一指纹做第二次
    // getRpmLimit。回归：把 rpm_limit 从 verify 的 SELECT 里拿掉这条会红。
    expect(store.update(a.value.id, { rpmLimit: 7 })).toBe('ok');
    expect(store.verify(a.value.token)).toEqual({ ok: true, fingerprint: a.value.fingerprint, rpmLimit: 7 });
    // 脏数据（负值）归一 0：verify 与 getRpmLimit 共用同一套归一化。
    // 经 store.update 写脏值会失效 verify 缓存，verify 重新查库时归一化为 0
    // （P2-4 缓存只存已归一化结果，命中缓存时不会读到原始脏值）。
    expect(store.update(a.value.id, { rpmLimit: -3 })).toBe('ok');
    const dirty = store.verify(a.value.token);
    expect(dirty.ok).toBe(true);
    if (dirty.ok) expect(dirty.rpmLimit).toBe(0);
    if (dirty.ok) expect(dirty.rpmLimit).toBe(store.getRpmLimit(a.value.fingerprint));
    // 未知指纹仍是 fail-closed。
    expect(store.verify('tk-' + 'f'.repeat(64))).toEqual({ ok: false });
    db.close();
  });

  it('P2-2：自定义 key 去前缀后不足 16 位拒绝；≥16 位接受', () => {
    const db = new UsageDb(path.join(tmpDir, 'len.db'), 30, () => {});
    const store = new TokensStore(db);
    // 短 key（去 sk-/tk- 前缀后 < 16）：拒绝，不落库。
    expect(store.create('short', null, 'sk-short').ok).toBe(false);
    expect(store.create('short', null, 'tk-short').ok).toBe(false);
    // 无前缀但整体过短：同样拒绝。
    expect(store.create('short', null, 'only14charkey?').ok).toBe(false);
    expect(store.list()).toEqual([]);
    // 去前缀后恰好 16：接受（自定义 key 校验只看下限，不查熵）。
    const ok = store.create('ok', null, 'sk-1234567890abcdef');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.token).toBe('sk-1234567890abcdef');
    expect(store.create('ok', null, 'tk-1234567890abcdef').ok).toBe(true);
    // 空白 customKey = 走随机生成（原有语义，不受长度校验影响）。
    const rnd = store.create('rnd', null, '   ');
    expect(rnd.ok).toBe(true);
    if (rnd.ok) expect(rnd.value.token).toMatch(/^tk-/);
    expect(store.list()).toHaveLength(3);
    db.close();
  });

  it('P2-4：verify 10s TTL 缓存 —— 命中不查库、写操作即时失效、TTL 过期重查', () => {
    vi.useFakeTimers();
    try {
      const db = new UsageDb(path.join(tmpDir, 'verify-cache.db'), 30, () => {});
      const store = new TokensStore(db);
      const a = store.create('cache', null);
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      const fp = a.value.fingerprint;
      // 首次 verify 查库并写缓存。
      expect(store.verify(a.value.token)).toEqual({ ok: true, fingerprint: fp, rpmLimit: 0 });

      // 绕过 store 直接改库（rpm_limit=99）：命中缓存时 verify 返回旧值 0
      // （证明没有重新查库 —— 若查库会读到 99）。
      db.sqlite()!.prepare('UPDATE tokens SET rpm_limit = 99 WHERE id = ?').run(a.value.id);
      const cached = store.verify(a.value.token);
      expect(cached.ok).toBe(true);
      if (cached.ok) expect(cached.rpmLimit).toBe(0);

      // 直接改 status='disabled'：缓存命中仍放行（禁用不即时生效，直到失效/过期）。
      db.sqlite()!.prepare("UPDATE tokens SET status = 'disabled' WHERE id = ?").run(a.value.id);
      expect(store.verify(a.value.token).ok).toBe(true);

      // 写操作（update）即时失效：改回 active + rpmLimit=7 后 verify 重新查库。
      expect(store.update(a.value.id, { status: 'active', rpmLimit: 7 })).toBe('ok');
      const afterUpdate = store.verify(a.value.token);
      expect(afterUpdate.ok).toBe(true);
      if (afterUpdate.ok) expect(afterUpdate.rpmLimit).toBe(7);

      // delete 即时失效：删除后 verify 拒绝（缓存不再放行已删 token）。
      store.delete(a.value.id);
      expect(store.verify(a.value.token).ok).toBe(false);

      // TTL 过期重查：新 key 入缓存后直接改库，未过期命中旧值、过期后读到新值。
      const b = store.create('cache2', null);
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      expect(store.verify(b.value.token).ok).toBe(true); // 入缓存（rpmLimit 0）
      db.sqlite()!.prepare('UPDATE tokens SET rpm_limit = 42 WHERE id = ?').run(b.value.id);
      const beforeExpire = store.verify(b.value.token);
      expect(beforeExpire.ok).toBe(true);
      if (beforeExpire.ok) expect(beforeExpire.rpmLimit).toBe(0);
      vi.advanceTimersByTime(TokensStore.VERIFY_CACHE_TTL_MS + 1);
      const afterExpire = store.verify(b.value.token);
      expect(afterExpire.ok).toBe(true);
      if (afterExpire.ok) expect(afterExpire.rpmLimit).toBe(42);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP e2e：CRUD / 鉴权矩阵 / token 明文仅一次
// ---------------------------------------------------------------------------

interface TokenItem {
  id: number;
  name: string;
  fingerprint: string;
  mask: string;
  status: string;
  note: string | null;
  rpmLimit: number;
  createdAt: number;
  usage: { requests: number; inputTokens: number; outputTokens: number; costMicroCents: number };
}

describe('tokens 端点 e2e', () => {
  let tmpDir: string;
  let db: UsageDb;
  let cfg: AppConfig;
  let store: TokensStore;
  let server: Server;
  let baseUrl: string;
  let token: string;
  let tokenFp: string;
  let tokenId: number;
  let sessionCookie: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tokens-e2e-'));
    db = new UsageDb(path.join(tmpDir, 'tokens.db'), 30, () => {});
    cfg = makeCfg({ dashboardOpen: false });
    store = new TokensStore(db);
    server = createApp(cfg, undefined, db, null, undefined, undefined, undefined, undefined, store);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    // 登录拿会话 cookie（端点鉴权矩阵用）。
    const login = await fetch(`${baseUrl}/__admin/api/login`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'thankyouopencode' }),
    });
    expect(login.status).toBe(200);
    sessionCookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const adminKey = { 'x-api-key': 'env-key-1' };

  it('端点鉴权矩阵：无凭据 401、API key 200、会话 cookie 200、跨站 Origin 403（写）', async () => {
    // dashboardOpen=false → 本机直连也不豁免，强制鉴权。
    const anon = await fetch(`${baseUrl}/__admin/api/tokens`);
    expect(anon.status).toBe(401);
    const keyed = await fetch(`${baseUrl}/__admin/api/tokens`, { headers: adminKey });
    expect(keyed.status).toBe(200);
    const cooked = await fetch(`${baseUrl}/__admin/api/tokens`, { headers: { cookie: sessionCookie } });
    expect(cooked.status).toBe(200);
    // 跨站 Origin 写操作（读端点同口径也拒）。
    const cross = await fetch(`${baseUrl}/__admin/api/tokens`, {
      method: 'POST',
      headers: { ...adminKey, 'content-type': 'application/json', origin: 'https://evil.example', host: 'localhost' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(cross.status).toBe(403);
    const crossGet = await fetch(`${baseUrl}/__admin/api/tokens`, {
      headers: { ...adminKey, origin: 'https://evil.example', host: 'localhost' },
    });
    expect(crossGet.status).toBe(403);
  });

  it('POST：创建返回 token 明文 + 指纹；审计落库', async () => {
    const res = await fetch(`${baseUrl}/__admin/api/tokens`, {
      method: 'POST',
      headers: { ...adminKey, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'main-client', note: '用户主设备' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { id: number; name: string; token: string; fingerprint: string } };
    expect(body.ok).toBe(true);
    expect(body.data.token).toMatch(/^tk-[0-9a-f]{64}$/);
    expect(body.data.fingerprint).toBe(fingerprintOf(body.data.token));
    token = body.data.token;
    tokenFp = body.data.fingerprint;
    tokenId = body.data.id;
    // 审计。
    const audit = db
      .sqlite()!
      .prepare("SELECT op, ok, note FROM admin_audit WHERE op = 'token.create' ORDER BY id DESC LIMIT 1")
      .get() as { op: string; ok: number; note: string };
    expect(audit.op).toBe('token.create');
    expect(audit.ok).toBe(1);
    expect(audit.note).toBe('main-client');
  });

  it('POST 校验：缺 name / name 超长 / note 超长 → 400', async () => {
    const bad = [
      {},
      { name: '' },
      { name: 'x'.repeat(101) },
      { name: 'ok', note: 'x'.repeat(201) },
      { name: 42 },
    ];
    for (const body of bad) {
      const res = await fetch(`${baseUrl}/__admin/api/tokens`, {
        method: 'POST',
        headers: { ...adminKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('GET 列表：掩码展示、**token 明文不在任何响应**、usage 初始为零', async () => {
    const res = await fetch(`${baseUrl}/__admin/api/tokens`, { headers: adminKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { items: TokenItem[] } };
    expect(body.ok).toBe(true);
    const row = body.data.items.find((i) => i.id === tokenId)!;
    expect(row.name).toBe('main-client');
    expect(row.fingerprint).toBe(tokenFp);
    expect(row.mask).toBe(maskOf(tokenFp));
    expect(row.status).toBe('active');
    expect(row.note).toBe('用户主设备');
    expect(row.usage).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0, costMicroCents: 0 });
    // 明文只出现在创建响应：列表/任何 JSON 都不得含 token 明文。
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it('e2e 鉴权：分发 token 可走数据面（200）；API_KEYS 优先；未知 401；无凭据 401', async () => {
    const withToken = await fetch(`${baseUrl}/v1/models`, { headers: { 'x-api-key': token } });
    expect(withToken.status).toBe(200);
    const withBearer = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
    expect(withBearer.status).toBe(200);
    const withApiKey = await fetch(`${baseUrl}/v1/models`, { headers: adminKey });
    expect(withApiKey.status).toBe(200);
    const unknown = await fetch(`${baseUrl}/v1/models`, { headers: { 'x-api-key': 'tk-' + 'f'.repeat(64) } });
    expect(unknown.status).toBe(401);
    const none = await fetch(`${baseUrl}/v1/models`);
    expect(none.status).toBe(401);
  });

  it('安全不变量：分发 token **不能**访问管理面（isAdminRequest 不传 tokensStore）', async () => {
    // 分发 token 是客户端数据面凭据；管理面只认 API key / 会话 / 本机直连。
    // 这条钉住「管理面绝不接受分发 token」——未来接线改错会在这里变红。
    const admin = await fetch(`${baseUrl}/__admin/api/tokens`, { headers: { 'x-api-key': token } });
    expect(admin.status).toBe(401);
    const settings = await fetch(`${baseUrl}/__admin/api/settings`, { headers: { 'x-api-key': token } });
    expect(settings.status).toBe(401);
    const accounts = await fetch(`${baseUrl}/__admin/api/accounts`, { headers: { 'x-api-key': token } });
    expect(accounts.status).toBe(401);
  });

  it('PATCH：status 禁/启切换即时影响鉴权；改名生效；审计', async () => {
    const disable = await fetch(`${baseUrl}/__admin/api/tokens/${tokenId}`, {
      method: 'PATCH',
      headers: { ...adminKey, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(disable.status).toBe(200);
    const denied = await fetch(`${baseUrl}/v1/models`, { headers: { 'x-api-key': token } });
    expect(denied.status).toBe(401);

    const rename = await fetch(`${baseUrl}/__admin/api/tokens/${tokenId}`, {
      method: 'PATCH',
      headers: { ...adminKey, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active', name: 'main-renamed' }),
    });
    expect(rename.status).toBe(200);
    const allowed = await fetch(`${baseUrl}/v1/models`, { headers: { 'x-api-key': token } });
    expect(allowed.status).toBe(200);

    const audit = db
      .sqlite()!
      .prepare("SELECT op, ok, note FROM admin_audit WHERE op = 'token.update' ORDER BY id DESC LIMIT 1")
      .get() as { op: string; ok: number; note: string };
    expect(audit.ok).toBe(1);
    expect(audit.note).toBe(`id=${tokenId} name,status`);
  });

  it('PATCH 校验：status 非法 / 空 body / name 类型错 → 400；不存在 id → 404', async () => {
    const bad = [{ status: 'bogus' }, {}, { name: '' }, { name: 7 }, { note: 5 }];
    for (const body of bad) {
      const res = await fetch(`${baseUrl}/__admin/api/tokens/${tokenId}`, {
        method: 'PATCH',
        headers: { ...adminKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    // note: null 是合法清除语义（与错误消息一致），空串等价。
    const clear = await fetch(`${baseUrl}/__admin/api/tokens/${tokenId}`, {
      method: 'PATCH',
      headers: { ...adminKey, 'content-type': 'application/json' },
      body: JSON.stringify({ note: null }),
    });
    expect(clear.status).toBe(200);
    const missing = await fetch(`${baseUrl}/__admin/api/tokens/9999`, {
      method: 'PATCH',
      headers: { ...adminKey, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(missing.status).toBe(404);
    const badId = await fetch(`${baseUrl}/__admin/api/tokens/abc`, {
      method: 'PATCH',
      headers: { ...adminKey, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(badId.status).toBe(400);
  });

  it('PATCH rpmLimit：更新后 GET 列表回读；非法值 400', async () => {
    const patch = await fetch(`${baseUrl}/__admin/api/tokens/${tokenId}`, {
      method: 'PATCH',
      headers: { ...adminKey, 'content-type': 'application/json' },
      body: JSON.stringify({ rpmLimit: 120 }),
    });
    expect(patch.status).toBe(200);
    const list = await fetch(`${baseUrl}/__admin/api/tokens`, { headers: adminKey });
    const body = (await list.json()) as { ok: boolean; data: { items: TokenItem[] } };
    const row = body.data.items.find((i) => i.id === tokenId)!;
    expect(row.rpmLimit).toBe(120);
    // 非法值：负数 / 小数 / 字符串 / 超上限 → 400。
    for (const v of [-1, 1.5, '5', 1000001]) {
      const r = await fetch(`${baseUrl}/__admin/api/tokens/${tokenId}`, {
        method: 'PATCH',
        headers: { ...adminKey, 'content-type': 'application/json' },
        body: JSON.stringify({ rpmLimit: v }),
      });
      expect(r.status).toBe(400);
    }
    // 恢复 0（不限流），不影响后续用例。
    const reset = await fetch(`${baseUrl}/__admin/api/tokens/${tokenId}`, {
      method: 'PATCH',
      headers: { ...adminKey, 'content-type': 'application/json' },
      body: JSON.stringify({ rpmLimit: 0 }),
    });
    expect(reset.status).toBe(200);
  });

  it('DELETE：删除后鉴权失效；幂等；审计', async () => {
    const del = await fetch(`${baseUrl}/__admin/api/tokens/${tokenId}`, { method: 'DELETE', headers: adminKey });
    expect(del.status).toBe(200);
    const denied = await fetch(`${baseUrl}/v1/models`, { headers: { 'x-api-key': token } });
    expect(denied.status).toBe(401);
    // 幂等：再删一次也 200（第二次删除时 token 已不存在，审计只有 id）。
    const again = await fetch(`${baseUrl}/__admin/api/tokens/${tokenId}`, { method: 'DELETE', headers: adminKey });
    expect(again.status).toBe(200);
    const audits = db
      .sqlite()!
      .prepare("SELECT op, ok, note FROM admin_audit WHERE op = 'token.delete' ORDER BY id DESC LIMIT 2")
      .all() as Array<{ op: string; ok: number; note: string }>;
    expect(audits.map((x) => x.note)).toContain(`id=${tokenId} name=main-renamed`);
    expect(audits.map((x) => x.note)).toContain(`id=${tokenId}`);
    expect(audits.every((x) => x.ok === 1)).toBe(true);
  });

  it('db 未接线：tokens 端点 503，且 verifyAuth 跳过分发 token（fail-closed）', async () => {
    const cfgNoDb = makeCfg({ apiKeys: ['k'] });
    const noDb = createApp(cfgNoDb); // 不传 tokensStore
    await new Promise<void>((r) => noDb.listen(0, '127.0.0.1', r));
    const a = noDb.address();
    const url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    const list = await fetch(`${url}/__admin/api/tokens`, { headers: { 'x-api-key': 'k' } });
    expect(list.status).toBe(503);
    // 未接线时分发 token 不是有效凭据（连空跑都没有）。
    const proxy = await fetch(`${url}/v1/models`, { headers: { 'x-api-key': 'tk-' + 'a'.repeat(64) } });
    expect(proxy.status).toBe(401);
    await new Promise<void>((r) => noDb.close(() => r()));
  });
});

// ---------------------------------------------------------------------------
// 用量聚合（每个用例独立 app —— tokenUsageAll 有 10s 缓存，用例间会串值）
// ---------------------------------------------------------------------------

describe('tokens 用量统计', () => {
  let fake: { server: Server; baseUrl: string };

  beforeAll(async () => {
    fake = await startFakeUpstream();
  });

  afterAll(async () => {
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  /** 新库新 app：缓存实例级，首查即真值。 */
  async function freshStack(over: Partial<AppConfig> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tokens-usage-'));
    const db = new UsageDb(path.join(dir, 'u.db'), 30, () => {});
    const cfg = makeCfg({ anthropicBaseUrl: fake.baseUrl, payAsYouGoBaseUrl: fake.baseUrl, ...over });
    const store = new TokensStore(db);
    const server = createApp(cfg, undefined, db, null, undefined, undefined, undefined, undefined, store);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    const baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    return {
      db,
      cfg,
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

  it('GET /v1/models 请求计入该 token 的聚合（请求数），API key 请求不计入', async () => {
    const s = await freshStack();
    try {
      const created = s.store.create('cli', null);
      if (!created.ok) throw new Error('create failed');
      const t = created.value.token;
      // 3 次 token 请求 + 1 次 API key 请求。
      for (let i = 0; i < 3; i++) {
        const r = await fetch(`${s.baseUrl}/v1/models`, { headers: { 'x-api-key': t } });
        expect(r.status).toBe(200);
      }
      await fetch(`${s.baseUrl}/v1/models`, { headers: { 'x-api-key': 'env-key-1' } });

      // stats 端点：只有 token 的 3 次。
      const stats = await fetch(`${s.baseUrl}/__admin/api/tokens/stats`, { headers: { 'x-api-key': 'env-key-1' } });
      expect(stats.status).toBe(200);
      const body = (await stats.json()) as {
        ok: boolean;
        data: { items: Array<{ fingerprint: string; requests: number; inputTokens: number; outputTokens: number; costMicroCents: number }> };
      };
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0]!.fingerprint).toBe(created.value.fingerprint);
      expect(body.data.items[0]!.requests).toBe(3);
      expect(body.data.items[0]!.inputTokens).toBe(0);

      // 列表端点每个 token 附 usage。
      const list = await fetch(`${s.baseUrl}/__admin/api/tokens`, { headers: { 'x-api-key': 'env-key-1' } });
      const listBody = (await list.json()) as { ok: boolean; data: { items: TokenItem[] } };
      expect(listBody.data.items[0]!.usage.requests).toBe(3);
    } finally {
      await s.close();
    }
  });

  it('完整 chat 链路：input/output tokens 与上游 cost 落库并聚合', async () => {
    const s = await freshStack();
    try {
      const created = s.store.create('cli', null);
      if (!created.ok) throw new Error('create failed');
      const t = created.value.token;
      const chat = await fetch(`${s.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'x-api-key': t, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(chat.status).toBe(200);

      const stats = await fetch(`${s.baseUrl}/__admin/api/tokens/stats`, { headers: { 'x-api-key': 'env-key-1' } });
      const body = (await stats.json()) as { data: { items: Array<{ requests: number; inputTokens: number; outputTokens: number; costMicroCents: number }> } };
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0]!.requests).toBe(1);
      expect(body.data.items[0]!.inputTokens).toBe(5);
      expect(body.data.items[0]!.outputTokens).toBe(2);
      // cost 是上游记账口径（microCents），不自己定价。
      expect(body.data.items[0]!.costMicroCents).toBe(1234);
    } finally {
      await s.close();
    }
  });

  it('token 删除后历史仍留在 stats（聚合按指纹，不按现存 token）', async () => {
    const s = await freshStack();
    try {
      const created = s.store.create('cli', null);
      if (!created.ok) throw new Error('create failed');
      const t = created.value.token;
      await fetch(`${s.baseUrl}/v1/models`, { headers: { 'x-api-key': t } });
      s.store.delete(created.value.id);
      const stats = await fetch(`${s.baseUrl}/__admin/api/tokens/stats`, { headers: { 'x-api-key': 'env-key-1' } });
      const body = (await stats.json()) as { data: { items: Array<{ fingerprint: string; requests: number }> } };
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0]!.fingerprint).toBe(created.value.fingerprint);
      expect(body.data.items[0]!.requests).toBe(1);
      // 但列表里已经没有该 token（历史不归任何现存 token）。
      const list = await fetch(`${s.baseUrl}/__admin/api/tokens`, { headers: { 'x-api-key': 'env-key-1' } });
      const listBody = (await list.json()) as { ok: boolean; data: { items: TokenItem[] } };
      expect(listBody.data.items).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it('未鉴权请求（401）不产生 token 聚合', async () => {
    const s = await freshStack();
    try {
      await fetch(`${s.baseUrl}/v1/models`, { headers: { 'x-api-key': 'tk-' + 'b'.repeat(64) } });
      const stats = await fetch(`${s.baseUrl}/__admin/api/tokens/stats`, { headers: { 'x-api-key': 'env-key-1' } });
      const body = (await stats.json()) as { data: { items: unknown[] } };
      expect(body.data.items).toEqual([]);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// per-key RPM 限流 e2e：入口 429（协议对应格式）+ 不计入实际转发 + 不限流
// ---------------------------------------------------------------------------

describe('tokens RPM 限流（入口 429，不计入上游）', () => {
  let fake: { server: Server; baseUrl: string; hits: () => number };

  beforeAll(async () => {
    fake = await startFakeUpstream();
  });

  afterAll(async () => {
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  /** 新库新 app：限流器实例独立，用例间不串计数。 */
  async function freshStack(over: Partial<AppConfig> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tokens-rpm-'));
    const db = new UsageDb(path.join(dir, 'rpm.db'), 30, () => {});
    const cfg = makeCfg({ anthropicBaseUrl: fake.baseUrl, payAsYouGoBaseUrl: fake.baseUrl, ...over });
    const store = new TokensStore(db);
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

  /** 创建一个分发 token 并 PATCH 它的 rpmLimit。返回 token 明文 + id。 */
  async function createLimited(
    s: Awaited<ReturnType<typeof freshStack>>,
    rpmLimit: number,
  ): Promise<{ token: string; id: number }> {
    const created = s.store.create('rpm-' + rpmLimit, null);
    if (!created.ok) throw new Error('create failed');
    const patch = await fetch(`${s.baseUrl}/__admin/api/tokens/${created.value.id}`, {
      method: 'PATCH',
      headers: { 'x-api-key': 'env-key-1', 'content-type': 'application/json' },
      body: JSON.stringify({ rpmLimit }),
    });
    expect(patch.status).toBe(200);
    return { token: created.value.token, id: created.value.id };
  }

  function chatReq(token: string, baseUrl: string, body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }) {
    return fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('rpm_limit=2：前 2 个 chat 请求 200，第 3 个 429（OpenAI 格式 + retry-after），且不转发上游', async () => {
    const s = await freshStack();
    try {
      const { token } = await createLimited(s, 2);
      const before = fake.hits();
      const r1 = await chatReq(token, s.baseUrl);
      expect(r1.status).toBe(200);
      const r2 = await chatReq(token, s.baseUrl);
      expect(r2.status).toBe(200);
      const r3 = await chatReq(token, s.baseUrl);
      expect(r3.status).toBe(429);
      const body = (await r3.json()) as { error: { message: string; type: string } };
      expect(body.error.type).toBe('rate_limit_error');
      expect(body.error.message).toContain('rate limit exceeded');
      const retryAfter = Number(r3.headers.get('retry-after'));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      // 被限流的第 3 个请求没到上游（不计入实际转发，不消耗额度）。
      expect(fake.hits() - before).toBe(2);
      // 持续请求仍 429（拒绝也计数，不会自动解锁）。
      const r4 = await chatReq(token, s.baseUrl);
      expect(r4.status).toBe(429);
    } finally {
      await s.close();
    }
  });

  it('rpm_limit=2：超限后的 /v1/messages 请求回 Anthropic 429 格式', async () => {
    const s = await freshStack();
    try {
      const { token } = await createLimited(s, 2);
      expect((await chatReq(token, s.baseUrl)).status).toBe(200);
      expect((await chatReq(token, s.baseUrl)).status).toBe(200);
      const m = await fetch(`${s.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': token,
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 50,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(m.status).toBe(429);
      const body = (await m.json()) as { type: string; error: { type: string; message: string } };
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('rate_limit_error');
      expect(Number(m.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
  });

  it('rpm_limit=0（默认）不限流：连续 5 个请求全 200', async () => {
    const s = await freshStack();
    try {
      const { token } = await createLimited(s, 0);
      for (let i = 0; i < 5; i++) {
        expect((await chatReq(token, s.baseUrl)).status).toBe(200);
      }
    } finally {
      await s.close();
    }
  });

  it('限流按指纹独立：token A 超限不牵连 token B', async () => {
    const s = await freshStack();
    try {
      const a = await createLimited(s, 1);
      const b = await createLimited(s, 1);
      expect((await chatReq(a.token, s.baseUrl)).status).toBe(200);
      expect((await chatReq(a.token, s.baseUrl)).status).toBe(429);
      // B 不受 A 影响（同一 app 内的独立窗口）。
      expect((await chatReq(b.token, s.baseUrl)).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('API key 鉴权的请求不受分发 key 限流影响', async () => {
    const s = await freshStack();
    try {
      // 建一个 rpm_limit=1 的 token 并超限，但 API key（env-key-1）请求不共享该窗口。
      const { token } = await createLimited(s, 1);
      expect((await chatReq(token, s.baseUrl)).status).toBe(200);
      expect((await chatReq(token, s.baseUrl)).status).toBe(429);
      const r = await chatReq('env-key-1', s.baseUrl);
      expect(r.status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('热路径不再调 getRpmLimit：限流值来自 verify 同一次点查（少一次同步查询）', async () => {
    const s = await freshStack();
    try {
      // 给 store.getRpmLimit 套计数 —— 若 server 仍为每个请求单独查一次，
      // 这个计数会 >0；现在限流判定直接用 verify 带回的 rpmLimit，应为 0。
      let getRpmLimitCalls = 0;
      const orig = s.store.getRpmLimit.bind(s.store);
      s.store.getRpmLimit = (fp: string) => {
        getRpmLimitCalls++;
        return orig(fp);
      };
      const { token } = await createLimited(s, 2);
      expect((await chatReq(token, s.baseUrl)).status).toBe(200);
      expect((await chatReq(token, s.baseUrl)).status).toBe(200);
      const r3 = await chatReq(token, s.baseUrl);
      expect(r3.status).toBe(429);
      expect(getRpmLimitCalls).toBe(0);
    } finally {
      await s.close();
    }
  });
});

describe('分发密钥明文存储与查看（token_enc 加密 + /plain 端点 + 补录指纹校验）', () => {
  it('创建后明文加密落库，plainOf 能解密还原', async () => {
    const { TokensStore, fingerprintOf } = await import('../src/tokens.js');
    const { loadSecret } = await import('../src/secrets.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenc-'));
    const secFile = path.join(dir, 'secret.key');
    fs.writeFileSync(secFile, 'test-secret-material-xyz');
    const secret = loadSecret({ secretFilePath: secFile } as never);
    const { UsageDb } = await import('../src/usagedb.js');
    const db = new UsageDb(path.join(dir, 't.db'));
    const store = new TokensStore(db as never, secret as never);
    const created = store.create('plain-test', null, 'sk-mytestkey1234567890');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // 明文能解密还原（与新创建一致）
    expect(store.plainOf(created.value.id)).toBe('sk-mytestkey1234567890');
    // 指纹仍按明文派生（校验不受影响）
    expect(fingerprintOf('sk-mytestkey1234567890')).toBe(created.value.fingerprint);
    db.close();
  });

  it('未存储明文的 token plainOf 返回 null（老 token 兼容）', async () => {
    const { TokensStore } = await import('../src/tokens.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokennull-'));
    const { UsageDb } = await import('../src/usagedb.js');
    const db = new UsageDb(path.join(dir, 't.db'));
    // 无 secret：create 时 token_enc 存 null
    const store = new TokensStore(db as never, null);
    const created = store.create('null-plain', null, 'sk-another-long-key-000');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(store.plainOf(created.value.id)).toBeNull();
    db.close();
  });
});
