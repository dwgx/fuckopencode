import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from '../src/config.js';
import { createApp, setOtaRestartStub } from '../src/server.js';
import { UsageDb } from '../src/usagedb.js';
import { resetOtaState } from '../src/ota.js';

const execFileP = promisify(execFile);

/** 等一个宏任务：performUpdate 的 scheduleRestart 现在是延后触发的（O-I6）。 */
function flushMacrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * /__admin/api/update/* 端点测试（OTA.md §6-§7）：
 * 鉴权矩阵（isAdminRequest + Origin）、OTA_ENABLED=0 → 403、perform 落 admin_audit、
 * 完整 perform 走通（注入 fake fetch + 真实 tar 解包 + 临时项目根真 swap）。
 */

let cfg: AppConfig;
let db: UsageDb;
let disabledDb: UsageDb;
let proxy: ReturnType<typeof createApp>;
let disabledProxy: ReturnType<typeof createApp>;
let baseUrl: string;
let disabledBaseUrl: string;
let tmpDir: string;
let otaRoot: string;
let disabledOtaRoot: string;
let restarted: Mock<() => void>;

async function buildDistTar(root: string): Promise<{ tarBytes: Buffer; sha256: string }> {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'main.js'), '// new main\n');
  fs.writeFileSync(path.join(root, 'dist', 'keypool.js'), '// new keypool\n');
  fs.writeFileSync(path.join(root, 'dist', 'dsml.js'), '// new dsml\n');
  fs.writeFileSync(path.join(root, 'dist', 'version.txt'), '1.2.3\n');
  const tar = path.join(root, 'pkg.tar.gz');
  await execFileP('tar', ['-czf', tar, '-C', root, 'dist']);
  const tarBytes = fs.readFileSync(tar);
  return { tarBytes, sha256: createHash('sha256').update(tarBytes).digest('hex') };
}

function seedOldDist(root: string, version = '1.0.0'): void {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'version.txt'), `${version}\n`);
  fs.writeFileSync(path.join(root, 'dist', 'main.js'), '// old main\n');
  fs.writeFileSync(path.join(root, 'dist', 'keypool.js'), '// old keypool\n');
  fs.writeFileSync(path.join(root, 'dist', 'dsml.js'), '// old dsml\n');
}

function makeConfig(otaEnabled: boolean): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    apiKeys: ['admin-key'],
    anthropicApiKey: null,
    upstreamKeys: [],
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
    dashboardOpen: true,
    dashboardPublic: false,
    usageDbPath: '',
    usageDbRetentionDays: 30,
    keyProbeIntervalMs: 0,
    keyProbeIdleMs: 1_800_000,
    keyProbeTimeoutMs: 5_000,
    gatewaySecret: 'ota-admin-secret',
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
    // OTA 配置：测试显式开关，定时检查关闭（不拖测试）。
    otaEnabled,
    otaRepo: 'dwgx/fuckopencode',
    otaToken: '',
    otaCheckIntervalMs: 0,
  };
}

let tarBytes: Buffer;
let tarSha: string;

function makeFakeFetch(): { fetchImpl: (url: string, init?: RequestInit) => Promise<Response>; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.includes('/tags')) {
      return new Response(JSON.stringify([{ name: 'v1.2.3' }, { name: 'v1.0.0' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/compare/')) {
      return new Response(
        JSON.stringify({
          commits: [
            { sha: 'aabbccdd', commit: { message: 'fix: something\n\nbody', author: { date: '2026-08-13T00:00:00Z' } } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('.tar.gz.sha256')) {
      return new Response(`${tarSha}  fuckopencode-v1.2.3-dist.tar.gz\n`, { status: 200 });
    }
    if (url.endsWith('.tar.gz')) {
      return new Response(new Uint8Array(tarBytes), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  return { fetchImpl, calls };
}

async function listen(server: ReturnType<typeof createApp>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  return `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-admin-'));
  otaRoot = path.join(tmpDir, 'root');
  disabledOtaRoot = path.join(tmpDir, 'root-disabled');
  seedOldDist(otaRoot, '1.0.0');
  seedOldDist(disabledOtaRoot, '1.0.0');
  const built = await buildDistTar(path.join(tmpDir, 'pkg'));
  tarBytes = built.tarBytes;
  tarSha = built.sha256;

  // performUpdate 用真实 supervisor 判定（process.env.INVOCATION_ID = systemd
  // 标记）。测试里注入它，走生产同一条路径。
  process.env.INVOCATION_ID = 'ota-admin-test';

  db = new UsageDb(path.join(tmpDir, 'audit.db'), 30, () => {});
  disabledDb = new UsageDb(path.join(tmpDir, 'audit-disabled.db'), 30, () => {});
  cfg = makeConfig(true);
  const disabledCfg = makeConfig(false);

  const { fetchImpl } = makeFakeFetch();
  proxy = createApp(cfg, undefined, db, null, fetchImpl, undefined, undefined, undefined, undefined, undefined, undefined, undefined, otaRoot);
  disabledProxy = createApp(disabledCfg, undefined, disabledDb, null, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, disabledOtaRoot);

  baseUrl = await listen(proxy);
  disabledBaseUrl = await listen(disabledProxy);
});

afterAll(async () => {
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await new Promise<void>((resolve) => disabledProxy.close(() => resolve()));
  db.close();
  disabledDb.close();
  delete process.env.INVOCATION_ID;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetOtaState();
  setOtaRestartStub(null);
  restarted = vi.fn<() => void>();
});

function auditOps(d: UsageDb): Array<{ op: string; ok: boolean; note: string | null }> {
  const rows = d.listAdminAudit(50);
  return rows == null ? [] : rows.map((r) => ({ op: r.op, ok: r.ok, note: r.note }));
}

describe('/__admin/api/update/status 鉴权矩阵', () => {
  it('本机直连免 key 放行；带 CDN 头必须带 key', async () => {
    const direct = await fetch(`${baseUrl}/__admin/api/update/status`);
    expect(direct.status).toBe(200);
    const body = (await direct.json()) as { ok: boolean; data: { current: string; enabled: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.current).toBe('1.0.0');
    expect(body.data.enabled).toBe(true);

    const cdnNoKey = await fetch(`${baseUrl}/__admin/api/update/status`, { headers: { 'cf-connecting-ip': '9.9.9.9' } });
    expect(cdnNoKey.status).toBe(401);

    const cdnKey = await fetch(`${baseUrl}/__admin/api/update/status`, {
      headers: { 'cf-connecting-ip': '9.9.9.9', 'x-api-key': 'admin-key' },
    });
    expect(cdnKey.status).toBe(200);
  });

  it('status 只读：无更新时不报错，返回回滚状态', async () => {
    const r = await fetch(`${baseUrl}/__admin/api/update/status`);
    const body = (await r.json()) as { data: { latest: string | null; hasUpdate: boolean; rollback: { rollbackPointPresent: boolean } } };
    expect(body.data.hasUpdate).toBe(false);
    expect(body.data.rollback.rollbackPointPresent).toBe(false);
  });

  it('非 GET → 404', async () => {
    const r = await fetch(`${baseUrl}/__admin/api/update/status`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(404);
  });
});

describe('/__admin/api/update/check（Origin 校验 + 结果）', () => {
  it('无 Origin（curl 场景）→ 200，发现新版本', async () => {
    const r = await fetch(`${baseUrl}/__admin/api/update/check`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; data: { latest: string; hasUpdate: boolean; commits: Array<{ sha: string }> } };
    expect(body.ok).toBe(true);
    expect(body.data.latest).toBe('v1.2.3');
    expect(body.data.hasUpdate).toBe(true);
    expect(body.data.commits.length).toBeGreaterThan(0);
    expect(body.data.commits[0]!.sha).toBe('aabbccd');
  });

  it('跨站 Origin → 403', async () => {
    const r = await fetch(`${baseUrl}/__admin/api/update/check`, {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
      body: '{}',
    });
    expect(r.status).toBe(403);
  });

  it('同源 Origin → 200', async () => {
    const r = await fetch(`${baseUrl}/__admin/api/update/check`, {
      method: 'POST',
      headers: { origin: baseUrl },
      body: '{}',
    });
    expect(r.status).toBe(200);
  });

  it('GET（非 POST）→ 404', async () => {
    const r = await fetch(`${baseUrl}/__admin/api/update/check`);
    expect(r.status).toBe(404);
  });
});

describe('/__admin/api/update/check OTA_ENABLED=0（M-P2-1 附带：disabled 不外联）', () => {
  it('disabled 时 check 直接返回 disabled 状态，latest 恒 null、不发远程请求', async () => {
    // disabledProxy 构造时没注入 fetchImpl：若这里外联 GitHub 会走真实网络
    // （慢/抖动/依赖外部），回归钉住「关闭态不检查更新」。
    const r = await fetch(`${disabledBaseUrl}/__admin/api/update/check`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      data: { current: string; latest: string | null; hasUpdate: boolean; enabled: boolean; commits: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.enabled).toBe(false);
    expect(body.data.latest).toBeNull();
    expect(body.data.hasUpdate).toBe(false);
    expect(body.data.commits).toEqual([]);
    expect(body.data.current).toBe('1.0.0');
  });
});

describe('/__admin/api/update/perform', () => {
  it('完整走通：替换 dist + 安排重启 + 审计落库', async () => {
    setOtaRestartStub(() => restarted());
    const r = await fetch(`${baseUrl}/__admin/api/update/perform`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; data: { updated: boolean; before: string; after: string } };
    expect(body.ok).toBe(true);
    expect(body.data.updated).toBe(true);
    expect(body.data.before).toBe('1.0.0');
    expect(body.data.after).toBe('v1.2.3');
    // scheduleRestart 延后到宏任务（O-I6：响应 200 发出后才触发）。
    await flushMacrotasks();
    expect(restarted).toHaveBeenCalledTimes(1);
    // dist 已替换；旧版进 dist.prev。
    expect(fs.readFileSync(path.join(otaRoot, 'dist', 'version.txt'), 'utf8').trim()).toBe('1.2.3');
    expect(fs.readFileSync(path.join(otaRoot, 'dist', 'main.js'), 'utf8')).toBe('// new main\n');
    expect(fs.readFileSync(path.join(otaRoot, 'dist.prev', 'version.txt'), 'utf8').trim()).toBe('1.0.0');
    // 审计落库（成功）。
    const ops = auditOps(db);
    const hit = ops.find((o) => o.op === 'ota.perform');
    expect(hit).toBeTruthy();
    expect(hit!.ok).toBe(true);
    expect(hit!.note).toContain('1.0.0 -> v1.2.3');
  });

  it('跨站 Origin → 403（不落审计）', async () => {
    const r = await fetch(`${baseUrl}/__admin/api/update/perform`, {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
      body: '{}',
    });
    expect(r.status).toBe(403);
  });

  it('OTA_ENABLED=0 → 403 + 审计失败记录', async () => {
    const r = await fetch(`${disabledBaseUrl}/__admin/api/update/perform`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: { type: string } };
    expect(body.error.type).toBe('authentication_error');
    const ops = auditOps(disabledDb);
    const hit = ops.find((o) => o.op === 'ota.perform');
    expect(hit).toBeTruthy();
    expect(hit!.ok).toBe(false);
  });

  it('OTA_ENABLED=0 时 status 只读照常', async () => {
    const r = await fetch(`${disabledBaseUrl}/__admin/api/update/status`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: { enabled: boolean; current: string } };
    expect(body.data.enabled).toBe(false);
    expect(body.data.current).toBe('1.0.0');
  });

  it('校验失败（sha256 不符）→ 422 且审计失败', async () => {
    // 换一个返回假哈希的 app：单独起一个临时实例。
    const badSha = 'f'.repeat(64);
    const fake = async (url: string): Promise<Response> => {
      if (url.includes('/tags')) {
        return new Response(JSON.stringify([{ name: 'v1.2.3' }, { name: 'v1.0.0' }]), { status: 200 });
      }
      if (url.endsWith('.tar.gz.sha256')) return new Response(`${badSha}  x\n`, { status: 200 });
      if (url.endsWith('.tar.gz')) return new Response(new Uint8Array(tarBytes), { status: 200 });
      return new Response('{}', { status: 200 });
    };
    const badDb = new UsageDb(path.join(tmpDir, 'audit-bad.db'), 30, () => {});
    const badRoot = path.join(tmpDir, 'root-bad');
    seedOldDist(badRoot, '1.0.0');
    const badServer = createApp(makeConfig(true), undefined, badDb, null, fake, undefined, undefined, undefined, undefined, undefined, undefined, undefined, badRoot);
    const badUrl = await listen(badServer);
    try {
      const r = await fetch(`${badUrl}/__admin/api/update/perform`, { method: 'POST', body: '{}' });
      expect(r.status).toBe(422);
      const ops = auditOps(badDb);
      expect(ops.some((o) => o.op === 'ota.perform' && o.ok === false)).toBe(true);
      // dist 未动。
      expect(fs.readFileSync(path.join(badRoot, 'dist', 'version.txt'), 'utf8').trim()).toBe('1.0.0');
    } finally {
      await new Promise<void>((resolve) => badServer.close(() => resolve()));
      badDb.close();
    }
  });
});
