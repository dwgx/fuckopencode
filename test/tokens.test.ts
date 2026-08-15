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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AppConfig } from '../src/config.js';
import { UsageDb } from '../src/usagedb.js';
import { fingerprintOf, generateToken, ipInList, maskOf, quotaWindowExpired, TokensStore } from '../src/tokens.js';
import { SettingsStore } from '../src/settings.js';
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

describe('ipInList（token 级 IP/CIDR 白名单匹配）', () => {
  it('空列表 = 不限（恒真）', () => {
    expect(ipInList('1.2.3.4', [])).toBe(true);
  });

  it('精确 IPv4 命中；不同 IP 拒绝', () => {
    expect(ipInList('1.2.3.4', ['1.2.3.4'])).toBe(true);
    expect(ipInList('1.2.3.5', ['1.2.3.4'])).toBe(false);
    expect(ipInList('1.2.3.4', ['9.9.9.9', '1.2.3.4'])).toBe(true);
  });

  it('IPv4 映射（::ffff:x.x.x.x）与裸 IPv4 互通', () => {
    expect(ipInList('::ffff:1.2.3.4', ['1.2.3.4'])).toBe(true);
    expect(ipInList('1.2.3.4', ['::ffff:1.2.3.4'])).toBe(true);
  });

  it('CIDR 命中/不命中（位运算前缀匹配）', () => {
    expect(ipInList('192.168.1.55', ['192.168.1.0/24'])).toBe(true);
    expect(ipInList('192.168.2.1', ['192.168.1.0/24'])).toBe(false);
    expect(ipInList('10.0.0.7', ['10.0.0.0/8'])).toBe(true);
    expect(ipInList('11.0.0.7', ['10.0.0.0/8'])).toBe(false);
    // /32 = 精确；/0 = 恒真。
    expect(ipInList('8.8.8.8', ['8.8.8.8/32'])).toBe(true);
    expect(ipInList('8.8.8.9', ['8.8.8.8/32'])).toBe(false);
    expect(ipInList('1.2.3.4', ['0.0.0.0/0'])).toBe(true);
  });

  it('IPv6：精确 + CIDR 基础', () => {
    expect(ipInList('2001:db8::1', ['2001:db8::1'])).toBe(true);
    expect(ipInList('2001:db8::2', ['2001:db8::1'])).toBe(false);
    expect(ipInList('2001:db8::2', ['2001:db8::/32'])).toBe(true);
    expect(ipInList('2001:db9::1', ['2001:db8::/32'])).toBe(false);
  });

  it('非法项/非法 IP：fail-closed（拒绝不误放）', () => {
    // 白名单里混进非法项不影响其余命中。
    expect(ipInList('1.2.3.4', ['not-an-ip', '1.2.3.4'])).toBe(true);
    // 非法 CIDR 恒不命中。
    expect(ipInList('1.2.3.4', ['1.2.3.4/999'])).toBe(false);
    expect(ipInList('1.2.3.4', ['1.2.3.0/'])).toBe(false);
    // 客户端 IP 非法（空/畸形）→ 拒绝。
    expect(ipInList('', ['1.2.3.4'])).toBe(false);
    expect(ipInList('bogus', ['1.2.3.4'])).toBe(false);
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

// ---------------------------------------------------------------------------
// 配额计费（QUOTA.md）：quotaWindowExpired 单元 + TokensStore settle/quotaCheck
// ---------------------------------------------------------------------------

describe('quotaWindowExpired 周期判定', () => {
  const T0 = 1_000_000_000_000;
  it('daily：reset_at + 24h 为界；none / reset_at<=0 恒不过期', () => {
    expect(quotaWindowExpired(T0, 'daily', T0)).toBe(false);
    expect(quotaWindowExpired(T0, 'daily', T0 + 86_400_000 - 1)).toBe(false);
    expect(quotaWindowExpired(T0, 'daily', T0 + 86_400_000)).toBe(true);
    expect(quotaWindowExpired(T0, 'none', T0 + 999 * 86_400_000)).toBe(false);
    expect(quotaWindowExpired(0, 'daily', T0)).toBe(false);
  });

  it('monthly：自然月同日为界（保留时分秒）', () => {
    // T0 = 2001-09-09T01:46:40Z。下月同日 = 2001-10-09T01:46:40Z。
    const nextMonth = Date.UTC(2001, 9, 9, 1, 46, 40);
    expect(quotaWindowExpired(T0, 'monthly', nextMonth - 1)).toBe(false);
    expect(quotaWindowExpired(T0, 'monthly', nextMonth)).toBe(true);
  });

  it('monthly：1 月 31 日 → 钳到 2 月 28 日（目标月无该日，防 setUTCMonth 翻月）', () => {
    const jan31 = Date.UTC(2001, 0, 31);
    const feb28 = Date.UTC(2001, 1, 28);
    expect(quotaWindowExpired(jan31, 'monthly', feb28 - 1)).toBe(false);
    expect(quotaWindowExpired(jan31, 'monthly', feb28)).toBe(true);
  });
});

describe('TokensStore 配额（QUOTA.md）', () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tokens-quota-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('create 带配额：list/get 返回 quota 视图（配置 + 已用）；默认全 0 无限', () => {
    const db = new UsageDb(path.join(tmpDir, 'q1.db'), 30, () => {});
    const store = new TokensStore(db);
    const a = store.create('q', null, undefined, {
      quotaUsd: 2.5,
      quotaTokens: 10_000,
      quotaRequests: 50,
      cycle: 'daily',
      expiresAt: 4_000_000_000_000,
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const view = store.get(a.value.id)!.quota;
    expect(view).toMatchObject({
      quotaUsd: 2.5,
      quotaTokens: 10_000,
      quotaRequests: 50,
      usedUsd: 0,
      usedTokens: 0,
      usedRequests: 0,
      cycle: 'daily',
      expiresAt: 4_000_000_000_000,
    });
    expect(view.resetAt).toBeGreaterThan(0); // 创建即定窗口起点
    expect(store.list()[0]!.quota).toEqual(view);
    // 默认（不传 quota）：全 0 无限 + none + 永不过期。
    const b = store.create('plain', null);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(store.get(b.value.id)!.quota).toMatchObject({
      quotaUsd: 0,
      quotaTokens: 0,
      quotaRequests: 0,
      cycle: 'none',
      expiresAt: 0,
    });
    db.close();
  });

  it('settle 三口径独立累加；无条件累加（已受理请求照实结算）', () => {
    const db = new UsageDb(path.join(tmpDir, 'q2.db'), 30, () => {});
    const store = new TokensStore(db);
    const a = store.create('acc', null);
    if (!a.ok) return;
    const fp = a.value.fingerprint;
    store.settleQuota(fp, { costMicroCents: 123, inputTokens: 10, outputTokens: 5 });
    store.settleQuota(fp, { costMicroCents: 7, inputTokens: 0, outputTokens: 3 });
    const q = store.get(a.value.id)!.quota;
    // 视图 usedUsd 是美元（microCents ÷1e8），不是 microCents。
    expect(q.usedUsd).toBe(130 / 1e8);
    expect(q.usedTokens).toBe(18); // (10+5) + (0+3)
    expect(q.usedRequests).toBe(2);
    expect(q.remainingUsd).toBeNull(); // 未设 $ 配额（quotaUsd=0 无限）→ null
    expect(q.exhausted).toBe(false);
    expect(q.expired).toBe(false);
    db.close();
  });

  it('B1：$ 单位统一 —— quotaUsd 入参美元 ×1e8 落库，视图回美元，比较用 microCents', () => {
    const db = new UsageDb(path.join(tmpDir, 'q-b1.db'), 30, () => {});
    const store = new TokensStore(db);
    const a = store.create('usd', null, undefined, { quotaUsd: 5 });
    if (!a.ok) return;
    const fp = a.value.fingerprint;
    // 视图：quotaUsd 回美元（入参原样），usedUsd 也回美元（microCents ÷1e8）。
    const view = store.get(a.value.id)!.quota;
    expect(view.quotaUsd).toBe(5);
    expect(view.usedUsd).toBe(0);
    expect(view.remainingUsd).toBe(5); // 未消费：剩余 = 配额 - 已用 = $5
    expect(view.exhausted).toBe(false);
    expect(view.expired).toBe(false);
    // 存储层（直接查库）：5 美元 = 5e8 microCents —— 与 quota_used_usd 同单位。
    const raw = db.sqlite()!.prepare('SELECT quota_usd FROM tokens WHERE id = ?').get(a.value.id) as { quota_usd: number };
    expect(raw.quota_usd).toBe(500_000_000);
    // 消费 $1（1e8 microCents）：used=100M < 500M → 未超限。
    store.settleQuota(fp, { costMicroCents: 100_000_000, inputTokens: 0, outputTokens: 0 });
    expect(store.quotaCheck(fp)).toEqual({ expired: false, exhausted: false, resetAt: 0, tpmLimit: 0, ipWhitelist: [] });
    // 再消费 $4（累计 $5 = 5e8）：used=500M ≥ 500M → 超限（回归：旧实现 used≥$5
    // 按 microCents 比较，$5 配额一次 $0.000001 就耗尽 —— 一用即满）。
    for (let i = 0; i < 4; i++) {
      store.settleQuota(fp, { costMicroCents: 100_000_000, inputTokens: 0, outputTokens: 0 });
    }
    expect(store.quotaCheck(fp)).toEqual({ expired: false, exhausted: true, resetAt: 0, tpmLimit: 0, ipWhitelist: [] });
    // 视图与校验口径一致：usedUsd 是美元（5e8 microCents = $5）、remainingUsd=0、exhausted=true。
    const spentView = store.get(a.value.id)!.quota;
    expect(spentView.usedUsd).toBe(5);
    expect(spentView.remainingUsd).toBe(0);
    expect(spentView.exhausted).toBe(true);
    expect(spentView.expired).toBe(false);
    // PATCH 更新 $ 配额同样按美元入参 → microCents 落库。
    expect(store.update(a.value.id, { quotaUsd: 0.5 })).toBe('ok');
    const raw2 = db.sqlite()!.prepare('SELECT quota_usd FROM tokens WHERE id = ?').get(a.value.id) as { quota_usd: number };
    expect(raw2.quota_usd).toBe(50_000_000);
    expect(store.get(a.value.id)!.quota.quotaUsd).toBe(0.5);
    db.close();
  });

  it('M3：并发超额封顶 —— 已超限口径不再扣，其余口径正常扣', () => {
    const db = new UsageDb(path.join(tmpDir, 'q-m3.db'), 30, () => {});
    const store = new TokensStore(db);
    const a = store.create('cap', null, undefined, { quotaRequests: 1, quotaTokens: 1000 });
    if (!a.ok) return;
    const fp = a.value.fingerprint;
    // 探针场景：quotaRequests=1 + 10 个并发 settle（verify 10s 缓存全放行，
    // settle 无条件累加 → used=10）。修复后条件 UPDATE 串行化 → used=1。
    for (let i = 0; i < 10; i++) {
      store.settleQuota(fp, { costMicroCents: 0, inputTokens: 10, outputTokens: 0 });
    }
    const q = store.get(a.value.id)!.quota;
    expect(q.usedRequests).toBe(1); // 请求数口径封顶（不再 N 倍超额）
    // 其他口径不受牵连：tokens 继续累加（10×10 = 100 < 1000）。
    expect(q.usedTokens).toBe(100);
    // 已超限的请求数口径：后续 settle 不扣（verify 10s 缓存窗口内的漏网请求）。
    store.settleQuota(fp, { costMicroCents: 0, inputTokens: 1, outputTokens: 1 });
    const q2 = store.get(a.value.id)!.quota;
    expect(q2.usedRequests).toBe(1);
    expect(q2.usedTokens).toBe(102); // tokens 口径仍正常扣
    db.close();
  });

  it('M2：cacheReadTokens 计入 tokens 口径（messages 路径总输入一致）', () => {
    const db = new UsageDb(path.join(tmpDir, 'q-m2.db'), 30, () => {});
    const store = new TokensStore(db);
    const a = store.create('cache', null, undefined, { quotaTokens: 1000 });
    if (!a.ok) return;
    const fp = a.value.fingerprint;
    // messages 路径 input 已减缓存（prompt−cached），cacheRead 单独补回：
    // input=2 + output=2 + cacheRead=3 = 7 —— 与 chat 路径（prompt=5 + output=2）一致。
    store.settleQuota(fp, { costMicroCents: 0, inputTokens: 2, outputTokens: 2, cacheReadTokens: 3 });
    expect(store.get(a.value.id)!.quota.usedTokens).toBe(7);
    // 缺省 cacheRead（chat 路径/旧调用）按 0，不影响既有口径。
    store.settleQuota(fp, { costMicroCents: 0, inputTokens: 5, outputTokens: 2 });
    expect(store.get(a.value.id)!.quota.usedTokens).toBe(14);
    db.close();
  });

  it('跨周期滚窗（daily）：周期到期后 settle 归零再累加 + 刷新 reset_at', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000_000_000);
      const db = new UsageDb(path.join(tmpDir, 'q3.db'), 30, () => {});
      const store = new TokensStore(db);
      const a = store.create('daily', null, undefined, { quotaTokens: 100, cycle: 'daily' });
      if (!a.ok) return;
      const fp = a.value.fingerprint;
      store.settleQuota(fp, { costMicroCents: 0, inputTokens: 10, outputTokens: 5 });
      expect(store.get(a.value.id)!.quota.usedTokens).toBe(15);
      // 跨过 24h：滚窗 → used 归零只记本次，reset_at 刷新为 now。
      vi.setSystemTime(1_000_000_000_000 + 86_400_000 + 1);
      store.settleQuota(fp, { costMicroCents: 0, inputTokens: 3, outputTokens: 4 });
      const q = store.get(a.value.id)!.quota;
      expect(q.usedTokens).toBe(7);
      expect(q.resetAt).toBe(1_000_000_000_000 + 86_400_000 + 1);
      // 新窗口内：继续累加。
      store.settleQuota(fp, { costMicroCents: 0, inputTokens: 1, outputTokens: 1 });
      expect(store.get(a.value.id)!.quota.usedTokens).toBe(9);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('M-1：跨周期窗口下 list/get 视图 used 三口径都归零（只 $ 归零是对抗审查 bug）', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000_000_000);
      const db = new UsageDb(path.join(tmpDir, 'q-m1view.db'), 30, () => {});
      const store = new TokensStore(db);
      const a = store.create('m1', null, undefined, {
        quotaUsd: 5,
        quotaTokens: 100,
        quotaRequests: 10,
        cycle: 'daily',
      });
      if (!a.ok) return;
      const fp = a.value.fingerprint;
      // 周期内消费：三口径都有已用。
      store.settleQuota(fp, { costMicroCents: 100_000_000, inputTokens: 10, outputTokens: 5 });
      const q0 = store.get(a.value.id)!.quota;
      expect(q0.usedUsd).toBe(1); // $1（1e8 microCents）
      expect(q0.usedTokens).toBe(15);
      expect(q0.usedRequests).toBe(1);
      // 跨过 24h（不新结算）：视图（list/get 同一 quotaView）三口径必须都归零 ——
      // 与 computeQuotaStatus 的校验口径一致（旧实现只归零 $，面板显示旧用量
      // 「已用 80%」而校验已重置）。
      vi.setSystemTime(1_000_000_000_000 + 86_400_000 + 1);
      const view = store.list()[0]!.quota;
      expect(view.usedUsd).toBe(0);
      expect(view.usedTokens).toBe(0);
      expect(view.usedRequests).toBe(0);
      expect(view.exhausted).toBe(false);
      expect(view.remainingUsd).toBe(5); // 滚窗后剩余回到满额
      expect(view.resetAt).toBeLessThan(Date.now()); // 窗口起点仍在过去
      expect(store.get(a.value.id)!.quota).toEqual(view);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('M-3：quotaCheck 返回下一周期重置时刻（daily/monthly 计算，none=0）', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000_000_000); // = 2001-09-09T01:46:40Z
      const db = new UsageDb(path.join(tmpDir, 'q-m3reset.db'), 30, () => {});
      const store = new TokensStore(db);
      const daily = store.create('d', null, undefined, { quotaRequests: 5, cycle: 'daily' });
      const monthly = store.create('m', null, undefined, { quotaRequests: 5, cycle: 'monthly' });
      const none = store.create('n', null, undefined, { quotaRequests: 5 });
      if (!daily.ok || !monthly.ok || !none.ok) return;
      // daily：reset_at(T0) + 24h；monthly：自然月同日（下月 9 日同一时刻）；none：0。
      expect(store.quotaCheck(daily.value.fingerprint)).toEqual({
        expired: false,
        exhausted: false,
        resetAt: 1_000_000_000_000 + 86_400_000,
        tpmLimit: 0,
        ipWhitelist: [],
      });
      expect(store.quotaCheck(monthly.value.fingerprint)).toEqual({
        expired: false,
        exhausted: false,
        resetAt: Date.UTC(2001, 9, 9, 1, 46, 40),
        tpmLimit: 0,
        ipWhitelist: [],
      });
      expect(store.quotaCheck(none.value.fingerprint)).toEqual({ expired: false, exhausted: false, resetAt: 0, tpmLimit: 0, ipWhitelist: [] });
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('跨周期滚窗（monthly）：自然月到期滚窗', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2001, 0, 15, 12));
      const db = new UsageDb(path.join(tmpDir, 'q4.db'), 30, () => {});
      const store = new TokensStore(db);
      const a = store.create('monthly', null, undefined, { quotaTokens: 100, cycle: 'monthly' });
      if (!a.ok) return;
      const fp = a.value.fingerprint;
      store.settleQuota(fp, { costMicroCents: 0, inputTokens: 60, outputTokens: 0 });
      expect(store.get(a.value.id)!.quota.usedTokens).toBe(60);
      // 跨到次月 15 日：滚窗归零。
      vi.setSystemTime(Date.UTC(2001, 1, 15, 12));
      store.settleQuota(fp, { costMicroCents: 0, inputTokens: 5, outputTokens: 0 });
      expect(store.get(a.value.id)!.quota.usedTokens).toBe(5);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('quotaCheck：expires_at 过期 → expired；任一口径超限 → exhausted；全 0 → 放行', () => {
    const db = new UsageDb(path.join(tmpDir, 'q5.db'), 30, () => {});
    const store = new TokensStore(db);
    const now = Date.now();
    const gone = store.create('gone', null, undefined, { expiresAt: now - 1000 });
    if (!gone.ok) return;
    expect(store.quotaCheck(gone.value.fingerprint)).toMatchObject({ expired: true });

    const limited = store.create('lim', null, undefined, { quotaRequests: 1, quotaUsd: 5 });
    if (!limited.ok) return;
    expect(store.quotaCheck(limited.value.fingerprint)).toEqual({ expired: false, exhausted: false, resetAt: 0, tpmLimit: 0, ipWhitelist: [] });
    // 结算 1 个请求 → 请求数口径超限（$ 口径：500 microCents < $5，未超）。
    store.settleQuota(limited.value.fingerprint, { costMicroCents: 500, inputTokens: 1, outputTokens: 1 });
    expect(store.quotaCheck(limited.value.fingerprint)).toEqual({ expired: false, exhausted: true, resetAt: 0, tpmLimit: 0, ipWhitelist: [] });

    const plain = store.create('plain', null);
    if (!plain.ok) return;
    expect(store.quotaCheck(plain.value.fingerprint)).toEqual({ expired: false, exhausted: false, resetAt: 0, tpmLimit: 0, ipWhitelist: [] });

    // 未知指纹：null（调用方放行 —— 反正 verify 已拒）。
    expect(store.quotaCheck('0'.repeat(24))).toBeNull();
    db.close();
  });

  it('结算后 verify 缓存即时失效：quotaCheck 读到扣减后新值', () => {
    const db = new UsageDb(path.join(tmpDir, 'q6.db'), 30, () => {});
    const store = new TokensStore(db);
    const a = store.create('inv', null, undefined, { quotaRequests: 1 });
    if (!a.ok) return;
    const fp = a.value.fingerprint;
    // verify 填缓存（used=0）。
    expect(store.verify(a.value.token).ok).toBe(true);
    expect(store.quotaCheck(fp)!.exhausted).toBe(false);
    // 绕过 store 直接改库把 used 顶到 1：若缓存未失效，quotaCheck 读到旧值 0。
    db.sqlite()!.prepare('UPDATE tokens SET quota_used_requests = 1 WHERE id = ?').run(a.value.id);
    expect(store.quotaCheck(fp)!.exhausted).toBe(false); // 缓存命中旧值（10s TTL 内）
    // 结算（真实路径会 invalidate）→ 缓存失效 → quotaCheck 读到新值。
    store.settleQuota(fp, { costMicroCents: 0, inputTokens: 0, outputTokens: 0 });
    expect(store.quotaCheck(fp)!.exhausted).toBe(true);
    db.close();
  });

  it('update 改配额字段即时失效缓存；cycle 切非 none 且 reset_at=0 自动定起点', () => {
    const db = new UsageDb(path.join(tmpDir, 'q7.db'), 30, () => {});
    const store = new TokensStore(db);
    const a = store.create('upd', null);
    if (!a.ok) return;
    // 绕过 store 把 reset_at 清零（模拟旧库切周期场景），再 PATCH cycle=daily。
    db.sqlite()!.prepare('UPDATE tokens SET quota_reset_at = 0 WHERE id = ?').run(a.value.id);
    expect(store.update(a.value.id, { cycle: 'daily' })).toBe('ok');
    const q = store.get(a.value.id)!.quota;
    expect(q.cycle).toBe('daily');
    expect(q.resetAt).toBeGreaterThan(0);
    // 配额字段变化会失效缓存：改 expiresAt 后 quotaCheck 立即反映。
    const past = Date.now() - 1000;
    expect(store.update(a.value.id, { expiresAt: past })).toBe('ok');
    expect(store.quotaCheck(a.value.fingerprint)!.expired).toBe(true);
    db.close();
  });

  it('MINOR m2：cycle 值变化 → 无条件刷新窗口起点（不再保持创建时刻）', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000_000_000);
      const db = new UsageDb(path.join(tmpDir, 'q-m2cycle.db'), 30, () => {});
      const store = new TokensStore(db);
      const a = store.create('cyc', null); // 创建即定 reset_at=now
      if (!a.ok) return;
      // 创建时起点 = T0；切 daily 后起点必须刷新为当前时刻（旧实现只在 reset_at=0
      // 时刷，切周期后窗口起点仍是创建时刻 —— 窗口被错误拉长）。
      vi.setSystemTime(1_000_000_000_000 + 60_000);
      expect(store.update(a.value.id, { cycle: 'daily' })).toBe('ok');
      expect(store.get(a.value.id)!.quota.resetAt).toBe(1_000_000_000_000 + 60_000);
      // 同值 PATCH（daily→daily）不刷新（「值变化」才生效）。
      vi.setSystemTime(1_000_000_000_000 + 120_000);
      expect(store.update(a.value.id, { cycle: 'daily' })).toBe('ok');
      expect(store.get(a.value.id)!.quota.resetAt).toBe(1_000_000_000_000 + 60_000);
      // daily→monthly：值变化 → 再刷新。
      vi.setSystemTime(1_000_000_000_000 + 180_000);
      expect(store.update(a.value.id, { cycle: 'monthly' })).toBe('ok');
      expect(store.get(a.value.id)!.quota.resetAt).toBe(1_000_000_000_000 + 180_000);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('quotaCheck 写缓存不冲掉 rpmLimit（与 verify 共用缓存槽位的回归）', () => {
    const db = new UsageDb(path.join(tmpDir, 'q8.db'), 30, () => {});
    const store = new TokensStore(db);
    const a = store.create('rp', null, undefined, { quotaRequests: 10 });
    if (!a.ok) return;
    expect(store.update(a.value.id, { rpmLimit: 5 })).toBe('ok'); // 失效缓存
    // 绕过 verify 直接 quotaCheck（冷缓存写路径）；随后 verify 读缓存必须带 rpmLimit。
    expect(store.quotaCheck(a.value.fingerprint)!.exhausted).toBe(false);
    expect(store.verify(a.value.token)).toEqual({ ok: true, fingerprint: a.value.fingerprint, rpmLimit: 5 });
    db.close();
  });

  it('B1 视图状态字段：expired/exhausted/remainingUsd 由服务端按校验口径算好下发', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000_000_000_000);
      const db = new UsageDb(path.join(tmpDir, 'q-viewstate.db'), 30, () => {});
      const store = new TokensStore(db);
      // 过期 token：expired=true，exhausted 不看 used（过期优先，仍给 false）。
      const gone = store.create('gone', null, undefined, { expiresAt: 2_000_000_000_000 - 1000 });
      if (!gone.ok) return;
      const g = store.get(gone.value.id)!.quota;
      expect(g.expired).toBe(true);
      expect(g.exhausted).toBe(false);
      expect(g.remainingUsd).toBeNull(); // 未设 $ 配额 → null

      // 未超限：quota $2，用 $0.5 → remainingUsd = 1.5。
      const ok = store.create('ok', null, undefined, { quotaUsd: 2 });
      if (!ok.ok) return;
      store.settleQuota(ok.value.fingerprint, { costMicroCents: 50_000_000, inputTokens: 0, outputTokens: 0 });
      const o = store.get(ok.value.id)!.quota;
      expect(o.usedUsd).toBe(0.5); // 5000 万 microCents = $0.5
      expect(o.remainingUsd).toBe(1.5);
      expect(o.exhausted).toBe(false);
      expect(o.expired).toBe(false);

      // 超限：quota $0.5，用 $0.5 → remainingUsd=0、exhausted=true。
      const full = store.create('full', null, undefined, { quotaUsd: 0.5 });
      if (!full.ok) return;
      store.settleQuota(full.value.fingerprint, { costMicroCents: 50_000_000, inputTokens: 0, outputTokens: 0 });
      const f = store.get(full.value.id)!.quota;
      expect(f.usedUsd).toBe(0.5);
      expect(f.remainingUsd).toBe(0);
      expect(f.exhausted).toBe(true);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('B1 旧数据读取：旧美元语义 quota_usd 落库后按 microCents 读的后果（文档化）', () => {
    // QUOTA.md §1：B1 上线前 quota_usd 是美元语义，会被按 microCents 解读
    // （数值缩小 1e8 倍）——功能当日上线、生产无存量配额 key，未做迁移。
    // 本测试把旧美元值直接落库，断言当前读取层确实按 microCents 解读，
    // 供将来迁移函数（migrateLegacyQuotaUsd）回归对照。
    const db = new UsageDb(path.join(tmpDir, 'q-legacy.db'), 30, () => {});
    const store = new TokensStore(db);
    const a = store.create('old', null);
    if (!a.ok) return;
    // 旧语义：quota_usd=5 意为 $5；新语义：5 microCents = $0.00000005。
    db.sqlite()!.prepare('UPDATE tokens SET quota_usd = 5 WHERE id = ?').run(a.value.id);
    const view = store.get(a.value.id)!.quota;
    expect(view.quotaUsd).toBe(5 / 1e8); // $0.00000005 —— 旧美元值被读成几乎 0
    expect(view.remainingUsd).toBe(5 / 1e8);
    expect(view.exhausted).toBe(false);
    db.close();
  });
});

describe('TokensStore TPM / IP 白名单（QUOTA 扩展，quotaTpm/ipWhitelist）', () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tokens-tpm-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('create 带 quotaTpm/ipWhitelist：视图回读 + verify 同一次点查带回 tpmLimit', () => {
    const db = new UsageDb(path.join(tmpDir, 'tpm1.db'), 30, () => {});
    const store = new TokensStore(db);
    const a = store.create('tpm', null, undefined, { quotaTpm: 2000, ipWhitelist: ['1.2.3.4', '10.0.0.0/8'] });
    if (!a.ok) return;
    const v = store.get(a.value.id)!.quota;
    expect(v.quotaTpm).toBe(2000);
    expect(v.usedTpm).toBe(0);
    expect(v.ipWhitelist).toEqual(['1.2.3.4', '10.0.0.0/8']);
    // quotaCheck 快照带 tpmLimit/ipWhitelist（TPM/IP 检查复用）。
    expect(store.quotaCheck(a.value.fingerprint)).toEqual({
      expired: false,
      exhausted: false,
      resetAt: 0,
      tpmLimit: 2000,
      ipWhitelist: ['1.2.3.4', '10.0.0.0/8'],
    });
    // verify 不改变（指纹 + rpmLimit 仍是原形状，TPM/IP 走 quotaCheck 快照）。
    expect(store.verify(a.value.token)).toEqual({ ok: true, fingerprint: a.value.fingerprint, rpmLimit: 0 });
    db.close();
  });

  it('默认/脏数据归一：quotaTpm=0 无限、ipWhitelist 空 = 不限；负数/非法归 0', () => {
    const db = new UsageDb(path.join(tmpDir, 'tpm2.db'), 30, () => {});
    const store = new TokensStore(db);
    const a = store.create('plain', null);
    if (!a.ok) return;
    expect(store.get(a.value.id)!.quota.quotaTpm).toBe(0);
    expect(store.get(a.value.id)!.quota.ipWhitelist).toEqual([]);
    // 绕过 store 写脏数据（负数 tpm / 空白名单）→ 视图/快照归一。
    db.sqlite()!.prepare("UPDATE tokens SET quota_tpm = -5, ip_whitelist = ' ' WHERE id = ?").run(a.value.id);
    store.update(a.value.id, { note: 'x' }); // 失效缓存
    expect(store.get(a.value.id)!.quota.quotaTpm).toBe(0);
    expect(store.get(a.value.id)!.quota.ipWhitelist).toEqual([]);
    db.close();
  });

  it('update 改 quotaTpm/ipWhitelist：即时生效（缓存失效）+ 视图回读', () => {
    const db = new UsageDb(path.join(tmpDir, 'tpm3.db'), 30, () => {});
    const store = new TokensStore(db);
    const a = store.create('upd', null);
    if (!a.ok) return;
    expect(store.update(a.value.id, { quotaTpm: 100, ipWhitelist: ['5.6.7.8'] })).toBe('ok');
    const v = store.get(a.value.id)!.quota;
    expect(v.quotaTpm).toBe(100);
    expect(v.ipWhitelist).toEqual(['5.6.7.8']);
    // 清空 = 不限。
    expect(store.update(a.value.id, { quotaTpm: 0, ipWhitelist: [] })).toBe('ok');
    expect(store.get(a.value.id)!.quota.quotaTpm).toBe(0);
    expect(store.get(a.value.id)!.quota.ipWhitelist).toEqual([]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 配额 e2e：请求消耗配额 → 再请求 429；count_tokens 不消耗；定价表兜底
// ---------------------------------------------------------------------------

describe('tokens 配额 e2e（QUOTA.md）', () => {
  /** 假上游：返回 cost '0'（订阅端点恒 0 的实测形态，走定价表兜底）。 */
  async function startZeroCostUpstream(): Promise<{ server: Server; baseUrl: string }> {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-v4-flash',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          cost: '0',
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    return { server, baseUrl: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}` };
  }

  /** 假上游：返回可配置的上游记账 cost（microCents 字符串），供 B1 $ 配额 e2e。 */
  async function startCostUpstream(cost: string): Promise<{ server: Server; baseUrl: string }> {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-v4-flash',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          cost,
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    return { server, baseUrl: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}` };
  }

  /** 假上游：usage 带缓存命中（prompt_tokens_details.cached_tokens），供 M2 e2e。 */
  async function startCachedUpstream(): Promise<{ server: Server; baseUrl: string }> {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-cache',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-v4-flash',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7,
            prompt_tokens_details: { cached_tokens: 3 },
          },
          cost: '0',
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    return { server, baseUrl: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}` };
  }

  /** 假上游：流式 SSE，首个 content chunk 立即发出，usage 尾 chunk 延迟 500ms
   *  （客户端可在中途断开，M1 断开估算 e2e 用）。 */
  async function startStreamingUpstream(): Promise<{ server: Server; baseUrl: string }> {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash' };
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'abcdefgh' }, finish_reason: null }] })}\n\n`,
      );
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 5, completion_tokens: 100, total_tokens: 105 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }, 500);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    return { server, baseUrl: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}` };
  }

  /** 轮询等待条件（settle 在响应 flush 后的 finally 同步执行，客户端的 await 可能先返回）。 */
  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('waitFor timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  let fake: { server: Server; baseUrl: string };
  let tmpDir: string;

  beforeAll(async () => {
    fake = await startZeroCostUpstream();
  });
  afterAll(async () => {
    await new Promise<void>((r) => fake.server.close(() => r()));
  });
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tokens-quota-e2e-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 新库新 app：缓存/限流实例独立，用例间不串值。 */
  async function freshStack(over: Partial<AppConfig> = {}) {
    const db = new UsageDb(path.join(tmpDir, `u-${Math.random().toString(36).slice(2)}.db`), 30, () => {});
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
      },
    };
  }

  function chatReq(token: string, baseUrl: string, body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }) {
    return fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('quota_requests=1：配额内请求 200 → 消耗后 verify 拒（OpenAI 429 insufficient_quota）', async () => {
    const s = await freshStack();
    try {
      const created = s.store.create('req1', null, undefined, { quotaRequests: 1 });
      if (!created.ok) throw new Error('create failed');
      expect((await chatReq(created.value.token, s.baseUrl)).status).toBe(200);
      await waitFor(() => s.store.get(created.value.id)!.quota.usedRequests === 1);
      const second = await chatReq(created.value.token, s.baseUrl);
      expect(second.status).toBe(429);
      const body = (await second.json()) as { error: { message: string; type: string } };
      expect(body.error.type).toBe('insufficient_quota');
      // M-3：none 周期（配额不会自动重置）不带 retry-after —— 硬编码 1s 让
      // naive 客户端死循环重试刷屏。有周期的 429 才带（见下面 daily 用例）。
      expect(second.headers.get('retry-after')).toBeNull();
    } finally {
      await s.close();
    }
  });

  it('M-3 e2e：daily 周期耗尽 429 带 retry-after（距下次重置秒数），none 不带', async () => {
    const s = await freshStack();
    try {
      const daily = s.store.create('daily429', null, undefined, { quotaRequests: 1, cycle: 'daily' });
      if (!daily.ok) throw new Error('create failed');
      expect((await chatReq(daily.value.token, s.baseUrl)).status).toBe(200);
      await waitFor(() => s.store.get(daily.value.id)!.quota.usedRequests === 1);
      const second = await chatReq(daily.value.token, s.baseUrl);
      expect(second.status).toBe(429);
      const ra = Number(second.headers.get('retry-after'));
      // daily 窗口 24h：retry-after 应落在 ~86400s 附近（不是硬编码 1）。
      expect(ra).toBeGreaterThan(80_000);
      expect(ra).toBeLessThanOrEqual(86_400);
    } finally {
      await s.close();
    }
  });

  it('超限后的 /v1/messages 请求回 Anthropic 429 形状（rate_limit_error）', async () => {
    const s = await freshStack();
    try {
      const created = s.store.create('msg1', null, undefined, { quotaRequests: 1 });
      if (!created.ok) throw new Error('create failed');
      expect((await chatReq(created.value.token, s.baseUrl)).status).toBe(200);
      await waitFor(() => s.store.get(created.value.id)!.quota.usedRequests === 1);
      const m = await fetch(`${s.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': created.value.token, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'gpt-4o', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(m.status).toBe(429);
      const body = (await m.json()) as { type: string; error: { type: string; message: string } };
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('rate_limit_error');
    } finally {
      await s.close();
    }
  });

  it('expires_at 过期：数据面 403（OpenAI 形状）', async () => {
    const s = await freshStack();
    try {
      const created = s.store.create('exp', null, undefined, { expiresAt: Date.now() - 1000 });
      if (!created.ok) throw new Error('create failed');
      const r = await chatReq(created.value.token, s.baseUrl);
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: { message: string; type: string } };
      expect(body.error.message).toContain('expired');
    } finally {
      await s.close();
    }
  });

  it('count_tokens 不消耗配额（对齐现有聚合口径）；models 列表不受配额闸门影响', async () => {
    const s = await freshStack();
    try {
      const created = s.store.create('ct', null, undefined, { quotaRequests: 1 });
      if (!created.ok) throw new Error('create failed');
      const t = created.value.token;
      // count_tokens 两次：若它消耗配额，随后的 chat 会被 429；不消耗 → chat 200。
      for (let i = 0; i < 2; i++) {
        const r = await fetch(`${s.baseUrl}/v1/messages/count_tokens`, {
          method: 'POST',
          headers: { 'x-api-key': t, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(r.status).toBe(200);
      }
      expect(s.store.get(created.value.id)!.quota.usedRequests).toBe(0);
      expect((await chatReq(t, s.baseUrl)).status).toBe(200); // 配额仍满可用
      await waitFor(() => s.store.get(created.value.id)!.quota.usedRequests === 1);
      // 已耗尽：/v1/models 列表仍 200（配额闸门只对代理路径生效）。
      expect((await fetch(`${s.baseUrl}/v1/models`, { headers: { 'x-api-key': t } })).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('$ 口径：上游 cost=0（订阅模型）走 settings model_prices 定价表兜底', async () => {
    const s = await freshStack();
    try {
      // 配置定价表：deepseek-v4-flash input $0.25/M output $1.0/M。
      const res = await fetch(`${s.baseUrl}/__admin/api/settings`, {
        method: 'PATCH',
        headers: { 'x-api-key': 'env-key-1', 'content-type': 'application/json' },
        body: JSON.stringify({ modelPrices: { 'deepseek-v4-flash': { input: 0.25, output: 1.0, read: 0, write: 0 } } }),
      });
      expect(res.status).toBe(200);
      const created = s.store.create('price', null, undefined, { quotaUsd: 10 });
      if (!created.ok) throw new Error('create failed');
      // 一次 chat：input 5 × 0.25 + output 2 × 1.0 = 3.25 $/M → 325 microCents。
      expect((await chatReq(created.value.token, s.baseUrl)).status).toBe(200);
      await waitFor(() => s.store.get(created.value.id)!.quota.usedUsd === 325 / 1e8);
      // 定价表同时记录 token/requests 口径。
      const q = s.store.get(created.value.id)!.quota;
      expect(q.usedTokens).toBe(7);
      expect(q.usedRequests).toBe(1);
    } finally {
      await s.close();
    }
  });

  it('B1 UI 语义：quotaUsd=5（美元）→ 消费 $1 不超限，累计跨 $5 后 429（不再一用即满）', async () => {
    const costFake = await startCostUpstream('100000000'); // $1 / 请求（microCents）
    const s = await freshStack({ anthropicBaseUrl: costFake.baseUrl, payAsYouGoBaseUrl: costFake.baseUrl });
    try {
      const created = s.store.create('usd-e2e', null, undefined, { quotaUsd: 5 });
      if (!created.ok) throw new Error('create failed');
      const t = created.value.token;
      // 旧实现：quotaUsd=5 美元 vs used=1e8 microCents → 首个请求就 429（一用即满）。
      // 修复后：$1 < $5 → 200；连续 5 次（$5）后超限。
      for (let i = 0; i < 5; i++) {
        const r = await chatReq(t, s.baseUrl);
        expect(r.status, `第 ${i + 1} 个 $1 请求`).toBe(200);
      }
      await waitFor(() => s.store.get(created.value.id)!.quota.usedUsd === 5); // 5e8 microCents = $5
      // 累计 $5 = 配额上限 → 第 6 个请求 429（insufficient_quota）。
      const sixth = await chatReq(t, s.baseUrl);
      expect(sixth.status).toBe(429);
      const body = (await sixth.json()) as { error: { type: string } };
      expect(body.error.type).toBe('insufficient_quota');
    } finally {
      await s.close();
      await new Promise<void>((r) => costFake.server.close(() => r()));
    }
  });

  it('M2：messages 路径缓存读按 read 价计入 $ 配额（read 字段从定价表读）', async () => {
    const cacheFake = await startCachedUpstream();
    const s = await freshStack({ anthropicBaseUrl: cacheFake.baseUrl, payAsYouGoBaseUrl: cacheFake.baseUrl });
    try {
      const res = await fetch(`${s.baseUrl}/__admin/api/settings`, {
        method: 'PATCH',
        headers: { 'x-api-key': 'env-key-1', 'content-type': 'application/json' },
        body: JSON.stringify({ modelPrices: { 'deepseek-v4-flash': { input: 0.25, output: 1.0, read: 0.5, write: 0 } } }),
      });
      expect(res.status).toBe(200);
      const created = s.store.create('m2-e2e', null, undefined, { quotaUsd: 10 });
      if (!created.ok) throw new Error('create failed');
      // /v1/messages：prompt=5、cached=3、completion=2。
      // $ 口径 = (5−3)×0.25 + 3×0.5 + 2×1.0 = 0.5+1.5+2.0 = 4.0 $/M → 400 microCents。
      // tokens 口径 = (5−3) + 2 + 3 = 7（与 chat 路径 prompt+output 一致）。
      const m = await fetch(`${s.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': created.value.token, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'gpt-4o', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(m.status).toBe(200);
      await waitFor(() => s.store.get(created.value.id)!.quota.usedUsd === 400 / 1e8);
      const q = s.store.get(created.value.id)!.quota;
      expect(q.usedTokens).toBe(7);
      expect(q.usedRequests).toBe(1);
    } finally {
      await s.close();
      await new Promise<void>((r) => cacheFake.server.close(() => r()));
    }
  });

  it('M1：流式客户端中途断开 → 按已回显文本估算 output 计入配额（不再扣 0）', async () => {
    const streamFake = await startStreamingUpstream();
    const s = await freshStack({ anthropicBaseUrl: streamFake.baseUrl, payAsYouGoBaseUrl: streamFake.baseUrl });
    try {
      const created = s.store.create('m1-e2e', null, undefined, { quotaTokens: 1000 });
      if (!created.ok) throw new Error('create failed');
      const t = created.value.token;
      // 客户端读到首 chunk 后立即断开：usage 尾 chunk（completion=100）拿不到，
      // 旧实现 settle 按 0 扣；修复后按已回显文本（8 字符 → 2 tokens）估算兜底。
      const ac = new AbortController();
      const r = await fetch(`${s.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'x-api-key': t, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        signal: ac.signal,
      });
      expect(r.status).toBe(200);
      const reader = r.body!.getReader();
      await reader.read(); // 收到首 chunk（8 字符文本）
      ac.abort(); // 客户端断开
      // 结算后 usedTokens 必须是估算下限（≥2，来自 8 字符/4），绝不是 0。
      await waitFor(() => s.store.get(created.value.id)!.quota.usedTokens >= 2);
      const used = s.store.get(created.value.id)!.quota.usedTokens;
      expect(used).toBeGreaterThanOrEqual(2);
      expect(used).toBeLessThan(100); // 没等到 usage 尾 chunk（100）
    } finally {
      await s.close();
      await new Promise<void>((r) => streamFake.server.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// TPM / IP 白名单 / 全局 RPM e2e（QUOTA 扩展；每用例新 app，窗口/缓存独立）
// ---------------------------------------------------------------------------

describe('tokens TPM e2e（每分钟 token 上限，请求前检查已用 + settle 累加）', () => {
  let fake: { server: Server; baseUrl: string; hits: () => number };
  let tmpDir: string;

  beforeAll(async () => {
    fake = await startFakeUpstream();
  });
  afterAll(async () => {
    await new Promise<void>((r) => fake.server.close(() => r()));
  });
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tokens-tpm-e2e-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function freshStack(over: Partial<AppConfig> = {}) {
    const db = new UsageDb(path.join(tmpDir, `u-${Math.random().toString(36).slice(2)}.db`), 30, () => {});
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
      },
    };
  }

  /** 轮询等待（settle 在响应 flush 后的 finally 同步执行，客户端的 await 可能先返回）。 */
  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('waitFor timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  function chatReq(token: string, baseUrl: string) {
    return fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
  }

  it('quotaTpm=6（假上游 usage 5+2）：首个请求放行并 settle 累加 → 第二个请求 429', async () => {
    const s = await freshStack();
    try {
      const created = s.store.create('tpm', null, undefined, { quotaTpm: 6 });
      if (!created.ok) return;
      const t = created.value.token;
      // 第 1 个：请求前 used=0 < 6 → 放行；settle 累加 input5+output2=7。
      expect((await chatReq(t, s.baseUrl)).status).toBe(200);
      // 等 settle 完成（usedTpm 是内存窗口，store 视图恒 0 —— 用 usedRequests 作
      // 结算完成的信号，usedTpm 真实值走 HTTP 列表端点读）。
      await waitFor(() => s.store.get(created.value.id)!.quota.usedRequests === 1);
      // 第 2 个：请求前 used=7 >= 6 → 429。
      const second = await chatReq(t, s.baseUrl);
      expect(second.status).toBe(429);
      const body = (await second.json()) as { error: { message: string; type: string } };
      expect(body.error.type).toBe('rate_limit_error');
      expect(body.error.message).toContain('TPM limit exceeded');
      expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
      // 视图 usedTpm 由端点层用 TpmLimiter 填（内存窗口）。
      const list = (await (await fetch(`${s.baseUrl}/__admin/api/tokens`, { headers: { 'x-api-key': 'env-key-1' } })).json()) as {
        ok: boolean;
        data: { items: Array<{ id: number; quota: { quotaTpm: number; usedTpm: number } }> };
      };
      const row = list.data.items.find((i) => i.id === created.value.id)!;
      expect(row.quota.quotaTpm).toBe(6);
      expect(row.quota.usedTpm).toBeGreaterThanOrEqual(7);
    } finally {
      await s.close();
    }
  });

  it('quotaTpm=0（默认）不限流：连续请求全 200', async () => {
    const s = await freshStack();
    try {
      const created = s.store.create('tpm0', null);
      if (!created.ok) return;
      for (let i = 0; i < 5; i++) {
        expect((await chatReq(created.value.token, s.baseUrl)).status).toBe(200);
      }
    } finally {
      await s.close();
    }
  });

  it('TPM 按指纹独立：token A 超限不牵连 token B', async () => {
    const s = await freshStack();
    try {
      const a = s.store.create('a', null, undefined, { quotaTpm: 1 });
      const b = s.store.create('b', null, undefined, { quotaTpm: 1 });
      if (!a.ok || !b.ok) return;
      expect((await chatReq(a.value.token, s.baseUrl)).status).toBe(200); // settle 累加 7 ≥ 1
      await waitFor(() => s.store.get(a.value.id)!.quota.usedRequests === 1);
      expect((await chatReq(a.value.token, s.baseUrl)).status).toBe(429);
      expect((await chatReq(b.value.token, s.baseUrl)).status).toBe(200); // B 不受 A 影响
    } finally {
      await s.close();
    }
  });

  it('PATCH 支持 quotaTpm；非法值 400', async () => {
    const s = await freshStack();
    try {
      const created = s.store.create('pt', null);
      if (!created.ok) return;
      const ok = await fetch(`${s.baseUrl}/__admin/api/tokens/${created.value.id}`, {
        method: 'PATCH',
        headers: { 'x-api-key': 'env-key-1', 'content-type': 'application/json' },
        body: JSON.stringify({ quotaTpm: 50 }),
      });
      expect(ok.status).toBe(200);
      const row = (await ok.json()) as { data: { quota: { quotaTpm: number } } };
      expect(row.data.quota.quotaTpm).toBe(50);
      for (const v of [-1, 1.5, '5']) {
        const bad = await fetch(`${s.baseUrl}/__admin/api/tokens/${created.value.id}`, {
          method: 'PATCH',
          headers: { 'x-api-key': 'env-key-1', 'content-type': 'application/json' },
          body: JSON.stringify({ quotaTpm: v }),
        });
        expect(bad.status).toBe(400);
      }
    } finally {
      await s.close();
    }
  });
});

describe('tokens IP 白名单 e2e（remoteAddress 匹配，命中放行 / 未命中 403）', () => {
  let fake: { server: Server; baseUrl: string; hits: () => number };
  let tmpDir: string;

  beforeAll(async () => {
    fake = await startFakeUpstream();
  });
  afterAll(async () => {
    await new Promise<void>((r) => fake.server.close(() => r()));
  });
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tokens-ip-e2e-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function freshStack(over: Partial<AppConfig> = {}) {
    const db = new UsageDb(path.join(tmpDir, `u-${Math.random().toString(36).slice(2)}.db`), 30, () => {});
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
      },
    };
  }

  function chatReq(token: string, baseUrl: string) {
    return fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
  }

  it('白名单含回环（测试直连 = 127.0.0.1）：放行；白名单不含本机 IP：403 ip not allowed', async () => {
    const s = await freshStack();
    try {
      // 命中：白名单含 127.0.0.1（测试客户端直连网关的 remoteAddress）。
      const hit = s.store.create('hit', null, undefined, { ipWhitelist: ['127.0.0.1', '10.0.0.0/8'] });
      if (!hit.ok) return;
      expect((await chatReq(hit.value.token, s.baseUrl)).status).toBe(200);

      // 未命中：白名单只有别的 IP → 403。
      const miss = s.store.create('miss', null, undefined, { ipWhitelist: ['203.0.113.9'] });
      if (!miss.ok) return;
      const r = await chatReq(miss.value.token, s.baseUrl);
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: { message: string; type: string } };
      expect(body.error.message).toBe('ip not allowed');
      expect(body.error.type).toBe('invalid_request_error');
      // 403 不转发上游（命中那次之后 hits 不再增长）。
      const before = fake.hits();
      expect(fake.hits() - before).toBe(0);

      // 空白名单（默认）= 不限。
      const open = s.store.create('open', null);
      if (!open.ok) return;
      expect((await chatReq(open.value.token, s.baseUrl)).status).toBe(200);

      // 视图回读：ipWhitelist 是数组。
      const list = (await (await fetch(`${s.baseUrl}/__admin/api/tokens`, { headers: { 'x-api-key': 'env-key-1' } })).json()) as {
        ok: boolean;
        data: { items: Array<{ id: number; quota: { ipWhitelist: string[] } }> };
      };
      const row = list.data.items.find((i) => i.id === miss.value.id)!;
      expect(row.quota.ipWhitelist).toEqual(['203.0.113.9']);
    } finally {
      await s.close();
    }
  });

  it('/v1/messages 未命中回 Anthropic 403 形状；PATCH ipWhitelist 清空 = 解除', async () => {
    const s = await freshStack();
    try {
      const created = s.store.create('msg-ip', null, undefined, { ipWhitelist: ['203.0.113.9'] });
      if (!created.ok) return;
      const m = await fetch(`${s.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': created.value.token, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'gpt-4o', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(m.status).toBe(403);
      const body = (await m.json()) as { type: string; error: { type: string; message: string } };
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('authentication_error');
      expect(body.error.message).toBe('ip not allowed');
      // PATCH 清空（空串）→ 解除白名单 → 放行。
      const clear = await fetch(`${s.baseUrl}/__admin/api/tokens/${created.value.id}`, {
        method: 'PATCH',
        headers: { 'x-api-key': 'env-key-1', 'content-type': 'application/json' },
        body: JSON.stringify({ ipWhitelist: '' }),
      });
      expect(clear.status).toBe(200);
      expect((await chatReq(created.value.token, s.baseUrl)).status).toBe(200);
      // 非法值：数组/超长 → 400。
      for (const v of [{ a: 1 }, 'x'.repeat(401)]) {
        const bad = await fetch(`${s.baseUrl}/__admin/api/tokens/${created.value.id}`, {
          method: 'PATCH',
          headers: { 'x-api-key': 'env-key-1', 'content-type': 'application/json' },
          body: JSON.stringify({ ipWhitelist: v }),
        });
        expect(bad.status).toBe(400);
      }
    } finally {
      await s.close();
    }
  });
});

describe('全局 RPM e2e（数据面整体保护：跨 token/API key 共享窗口）', () => {
  let fake: { server: Server; baseUrl: string; hits: () => number };
  let tmpDir: string;

  beforeAll(async () => {
    fake = await startFakeUpstream();
  });
  afterAll(async () => {
    await new Promise<void>((r) => fake.server.close(() => r()));
  });
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tokens-global-rpm-e2e-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function freshStack(over: Partial<AppConfig> = {}) {
    const db = new UsageDb(path.join(tmpDir, `u-${Math.random().toString(36).slice(2)}.db`), 30, () => {});
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
      },
    };
  }

  function chatReq(token: string, baseUrl: string) {
    return fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
  }

  it('globalRpmLimit=2：两个不同 token 各 1 个请求后，第 3 个请求（任意凭据）429', async () => {
    const s = await freshStack({ globalRpmLimit: 2 });
    try {
      const a = s.store.create('ga', null);
      const b = s.store.create('gb', null);
      if (!a.ok || !b.ok) return;
      // 两个不同 token 打满全局窗口（整体维度：单个 token 各自 RPM 都没超）。
      expect((await chatReq(a.value.token, s.baseUrl)).status).toBe(200);
      expect((await chatReq(b.value.token, s.baseUrl)).status).toBe(200);
      // 第 3 个：全局窗口打满 → 429（哪怕用 API key / 第 3 个 token）。
      const hitsBeforeThird = fake.hits();
      const third = await chatReq('env-key-1', s.baseUrl);
      expect(third.status).toBe(429);
      const body = (await third.json()) as { error: { message: string; type: string } };
      expect(body.error.type).toBe('rate_limit_error');
      expect(body.error.message).toContain('global rate limit exceeded');
      expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
      // 被全局限流的请求不转发上游（启动目录刷新可能异步打点，只量第三个请求前后）。
      expect(fake.hits() - hitsBeforeThird).toBe(0);
    } finally {
      await s.close();
    }
  });

  it('globalRpmLimit=0（默认）关闭：大量请求不受全局窗口限制', async () => {
    const s = await freshStack(); // 默认 globalRpmLimit=0
    try {
      for (let i = 0; i < 5; i++) {
        expect((await chatReq('env-key-1', s.baseUrl)).status).toBe(200);
      }
    } finally {
      await s.close();
    }
  });

  it('settings PATCH globalRpmLimit 热生效（2000 → 生效；切 0 关闭）', async () => {
    const s = await freshStack();
    try {
      const patch = await fetch(`${s.baseUrl}/__admin/api/settings`, {
        method: 'PATCH',
        headers: { 'x-api-key': 'env-key-1', 'content-type': 'application/json' },
        body: JSON.stringify({ globalRpmLimit: 2000 }),
      });
      expect(patch.status).toBe(200);
      // GET /settings 回读。
      const get = (await (await fetch(`${s.baseUrl}/__admin/api/settings`, { headers: { 'x-api-key': 'env-key-1' } })).json()) as {
        data: { settings: Record<string, { value: number; default: number; source: string } | undefined> };
      };
      const gr = get.data.settings.globalRpmLimit;
      expect(gr).toBeDefined();
      expect(gr!.value).toBe(2000);
      expect(gr!.default).toBe(0);
      expect(gr!.source).toBe('db');
      // 非法值 400（未知键 / 负值）。
      const bad = await fetch(`${s.baseUrl}/__admin/api/settings`, {
        method: 'PATCH',
        headers: { 'x-api-key': 'env-key-1', 'content-type': 'application/json' },
        body: JSON.stringify({ globalRpmLimit: -1 }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await s.close();
    }
  });
});
