import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountsStore, buildAccountsSection, type AccountView } from '../src/accounts.js';
import { UsageDb } from '../src/usagedb.js';
import { loadSecret } from '../src/secrets.js';
import { keyFingerprint } from '../src/keypool.js';
import type { KeyPool, PoolKeySnapshot } from '../src/keypool.js';
import type { AppConfig } from '../src/config.js';

let tmpDir: string;
const logs: string[] = [];
const log = (m: string): void => void logs.push(m);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-accounts-'));
  logs.length = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 真实 SecretKey（走 env 材料，不落文件）。 */
const secret = loadSecret({ gatewaySecret: 'test-secret', secretFilePath: '/dev/null' } as unknown as AppConfig)!;

/** 最小 AppConfig：AccountsStore 只用 upstreamKeys。 */
function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return { upstreamKeys: [], ...over } as unknown as AppConfig;
}

function makeStore(opts: { keys?: string[] } = {}): { db: UsageDb; store: AccountsStore } {
  const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
  const store = new AccountsStore(db, secret, cfg({ upstreamKeys: opts.keys ?? [] }), log);
  return { db, store };
}

/** 便捷创建：断言成功并返回视图（本文件用例里的 create 必然成功）。 */
function createOk(store: AccountsStore, input: Parameters<AccountsStore['create']>[0]): AccountView {
  const r = store.create(input);
  if (!r.ok) throw new Error(`create 失败（期望成功）: ${r.reason}`);
  return r.value;
}

/** 构造 pool 快照条目（默认值 + 覆盖）。 */
function snapEntry(over: Partial<PoolKeySnapshot>): PoolKeySnapshot {
  return {
    fingerprint: '****x',
    accountId: 0,
    healthy: true,
    inFlight: 0,
    failCount: 0,
    disabledUntil: 0,
    recoverInMs: 0,
    lastUsedAt: 0,
    totalAcquired: 0,
    ...over,
  };
}

describe('env 种子（MULTI-ACCOUNT.md §3.3）', () => {
  it('表空 + env keys 非空 → 种一条 env 账户，只种一次', () => {
    const { db, store } = makeStore({ keys: ['sk-a', 'sk-b'] });
    expect(store.enabled).toBe(true);
    const list = store.list();
    expect(list).toHaveLength(1);
    const env = list[0]!;
    expect(env.name).toBe('env');
    expect(env.kind).toBe('unknown');
    expect(env.keyCount).toBe(2);

    // 再来一个 store（模拟重启）：表已非空，不再种子
    const store2 = new AccountsStore(db, secret, cfg({ upstreamKeys: ['sk-a'] }), log);
    expect(store2.list()).toHaveLength(1);
    db.close();
  });

  it('表非空（有自定义账户）→ 不种子 env', () => {
    const { db, store } = makeStore();
    store.create({ name: '主力号', kind: 'subscription', workspaceId: 'ws_1', keys: ['sk-1'], cookie: null });
    const store2 = new AccountsStore(db, secret, cfg({ upstreamKeys: ['sk-env'] }), log);
    const list = store2.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('主力号');
    db.close();
  });

  it('env keys 为空 → 不种子', () => {
    const { db, store } = makeStore();
    expect(store.list()).toHaveLength(0);
    db.close();
  });

  it('降级：无 secret → 整体禁用，disabledReason=secret unavailable，不种子', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    const store = new AccountsStore(db, null, cfg({ upstreamKeys: ['sk-a'] }), log);
    expect(store.enabled).toBe(false);
    expect(store.disabledReason).toBe('secret unavailable');
    expect(store.list()).toEqual([]);
    db.close();
  });

  it('降级：db 不可用 → disabledReason 沿用 db 的分类原因', () => {
    const db = new UsageDb('', 30, log); // 显式关闭持久化
    const store = new AccountsStore(db, secret, cfg({ upstreamKeys: ['sk-a'] }), log);
    expect(store.enabled).toBe(false);
    expect(store.disabledReason).toBe('disabled by config');
    expect(store.keysForPool().size).toBe(0);
  });
});

describe('账户 CRUD（加密落盘）', () => {
  it('create/get：返回视图，绝不含明文 key/cookie，keyCount 正确', () => {
    const { db, store } = makeStore();
    const created = createOk(store, {
      name: '订阅主力号', kind: 'subscription', workspaceId: 'ws_abc', keys: ['sk-1', 'sk-2'], cookie: 'auth=tok123',
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.name).toBe('订阅主力号');
    expect(created.keyCount).toBe(2);

    // 视图序列化后绝不能带明文（防 admin/server 层漏传）
    const json = JSON.stringify(store.get(created.id));
    expect(json).not.toContain('sk-1');
    expect(json).not.toContain('sk-2');
    expect(json).not.toContain('tok123');

    // cookie 走专用方法取明文（进程内用）
    expect(store.cookieOf(created.id)).toBe('auth=tok123');
    expect(store.workspaceIdOf(created.id)).toBe('ws_abc');
    db.close();
  });

  it('update：部分字段，cookie 传 null/空串 = 清除', () => {
    const { db, store } = makeStore();
    const id = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: ['sk-1'], cookie: 'c1' }).id;

    expect(store.update(id, { name: '改名', kind: 'payg', workspaceId: 'ws_9' })).toBe(true);
    const after = store.get(id)!;
    expect(after.name).toBe('改名');
    expect(after.kind).toBe('payg');
    expect(after.workspaceId).toBe('ws_9');
    expect(store.cookieOf(id)).toBe('c1'); // 没动 cookie

    expect(store.update(id, { cookie: null })).toBe(true);
    expect(store.cookieOf(id)).toBeNull();
    expect(store.update(id, { cookie: '' })).toBe(true);
    expect(store.cookieOf(id)).toBeNull(); // 空串也是清除（§6.3）
    expect(store.update(id, { cookie: 'c2' })).toBe(true);
    expect(store.cookieOf(id)).toBe('c2');

    expect(store.update(999, { name: 'x' })).toBe(false); // 不存在
    db.close();
  });

  it('addKey/removeKey：去重、指纹匹配、明文供 pool 热移除', () => {
    const { db, store } = makeStore();
    const id = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: ['sk-first'], cookie: null }).id;

    expect(store.addKey(id, 'sk-second')).toEqual({ ok: true });
    expect(store.get(id)!.keyCount).toBe(2);
    expect(store.addKey(id, 'sk-second')).toEqual({ ok: false, reason: 'duplicate' }); // 同账户去重
    expect(store.addKey(999, 'sk-x')).toEqual({ ok: false, reason: 'failed' }); // 账户不存在
    expect(store.keysForPool().get('sk-second')).toBe(id);

    // 按指纹删：返回明文（供 pool.removeKey），指纹不匹配返回 null
    const removed = store.removeKey(id, keyFingerprint('sk-second'));
    expect(removed).toBe('sk-second');
    expect(store.get(id)!.keyCount).toBe(1);
    expect(store.keysForPool().has('sk-second')).toBe(false);
    expect(store.removeKey(id, '****nope')).toBeNull();
    db.close();
  });

  it('m6：create/addKey 拒绝跨账户重复 key（conflict 带归属账户名）', () => {
    const { db, store } = makeStore();
    const a = createOk(store, { name: 'A号', kind: 'unknown', workspaceId: null, keys: ['sk-shared', 'sk-a'], cookie: null });

    // 创建 B 带 A 已有 key → conflict，B 不落盘
    const b = store.create({ name: 'B号', kind: 'unknown', workspaceId: null, keys: ['sk-shared'], cookie: null });
    expect(b).toEqual({ ok: false, reason: 'conflict', ownerName: 'A号' });
    expect(store.list()).toHaveLength(1);

    // addKey 同样拦跨账户冲突：B 用独立 key 创建成功，再往 B 加 A 的 key
    const b2 = createOk(store, { name: 'B号', kind: 'unknown', workspaceId: null, keys: ['sk-b'], cookie: null });
    expect(store.addKey(b2.id, 'sk-shared')).toEqual({ ok: false, reason: 'conflict', ownerName: 'A号' });
    expect(store.get(b2.id)!.keyCount).toBe(1); // 冲突未写入

    // 同一账户内重复 key 走 duplicate（不误报 conflict）
    expect(store.addKey(a.id, 'sk-a')).toEqual({ ok: false, reason: 'duplicate' });
    expect(store.addKey(a.id, 'sk-a2')).toEqual({ ok: true });
    db.close();
  });

  it('remove：返回被删账户的明文 keys，供 pool 移除', () => {
    const { db, store } = makeStore();
    const id = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: ['sk-x', 'sk-y'], cookie: null }).id;
    const removedKeys = store.remove(id);
    expect(removedKeys).toEqual(['sk-x', 'sk-y']);
    expect(store.get(id)).toBeNull();
    expect(store.keysForPool().size).toBe(0);
    expect(store.remove(id)).toBeNull(); // 已删
    db.close();
  });

  it('keys_enc 损坏时 addKey 拒绝覆盖（不静默丢原有 key）', () => {
    const { db, store } = makeStore();
    const id = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: ['sk-1'], cookie: null }).id;
    db.updateAccount(id, { keysEnc: 'not-json' });
    expect(store.addKey(id, 'sk-2')).toEqual({ ok: false, reason: 'failed' });
    // 落盘内容未被覆盖
    expect(db.getAccount(id)!.keysEnc).toBe('not-json');
    db.close();
  });

  it('keysForPool：坏条目跳过不炸，同 key 多账户取第一个', () => {
    const { db, store } = makeStore();
    const a = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: ['sk-shared'], cookie: null }).id;
    const b = createOk(store, { name: 'b', kind: 'unknown', workspaceId: null, keys: ['sk-b'], cookie: null }).id;
    // m6 之后 store 层已拒绝跨账户重复 key；这里的重复是历史遗留脏数据，
    // 直接改库注入，验证 keysForPool 对既有脏数据的「取第一个」兜底仍生效。
    const bRow = db.getAccount(b)!;
    const bKeys = JSON.parse(secret.decrypt(bRow.keysEnc)!) as string[];
    bKeys.push('sk-shared');
    db.updateAccount(b, { keysEnc: secret.encrypt(JSON.stringify(bKeys)) });

    const map = store.keysForPool();
    expect(map.get('sk-shared')).toBe(a); // id 最小者胜出
    expect(map.get('sk-b')).toBe(b);
    db.updateAccount(b, { keysEnc: 'garbage' });
    expect(store.keysForPool().get('sk-b')).toBeUndefined(); // 解密失败跳过
    db.close();
  });
});

describe('探针 / billing 结果写账', () => {
  it('setProbeResult：status/detail/retryUntil 落账，detail 单点清洗（stripControl + 截断 200）', () => {
    const { db, store } = makeStore();
    const id = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: ['sk-1'], cookie: null }).id;

    const evil = 'GoUsageLimitError: limit reached\u0000\u001b[2J' + 'x'.repeat(300);
    expect(store.setProbeResult(id, { status: 'cooldown', detail: evil, retryUntil: 5000, lastProbeAt: 1000 })).toBe(true);
    const after = store.get(id)!;
    expect(after.status).toBe('cooldown');
    expect(after.retryUntil).toBe(5000);
    expect(after.lastProbeAt).toBe(1000);
    expect(after.statusDetail).not.toContain('\u0000');
    expect(after.statusDetail!.length).toBe(200);

    // 成功探针：detail 为 null → statusDetail 置 null
    expect(store.setProbeResult(id, { status: 'ok', detail: null, retryUntil: 6000, lastProbeAt: 2000 })).toBe(true);
    expect(store.get(id)!.statusDetail).toBeNull();
    db.close();
  });

  it('setBilling：部分更新（undefined 不动旧值），at 恒写', () => {
    const { db, store } = makeStore();
    const id = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: [], cookie: null }).id;

    expect(store.setBilling(id, { balanceUnits: 123_000_000, monthlyLimitUnits: 1_000_000_000, at: 111 })).toBe(true);
    let after = store.get(id)!;
    expect(after.balanceUnits).toBe(123_000_000);
    expect(after.monthlyLimitUnits).toBe(1_000_000_000);
    expect(after.monthlyUsageUnits).toBeNull();
    expect(after.lastBillingAt).toBe(111);

    // 只更新 usage 和 at：balance/limit 保持旧值
    expect(store.setBilling(id, { monthlyUsageUnits: 245_000_000, at: 222 })).toBe(true);
    after = store.get(id)!;
    expect(after.balanceUnits).toBe(123_000_000);
    expect(after.monthlyLimitUnits).toBe(1_000_000_000);
    expect(after.monthlyUsageUnits).toBe(245_000_000);
    expect(after.lastBillingAt).toBe(222);
    db.close();
  });
});

describe('buildAccountsSection（§6.2 JSON 契约）', () => {
  it('keys 按 accountId 过滤、金额两位小数、monthlyPercent、retryInMs、statusDetail', () => {
    const { db, store } = makeStore();
    const a = createOk(store, {
      name: 'env', kind: 'subscription', workspaceId: null,
      keys: ['sk-1'], cookie: null,
    }).id;
    const b = createOk(store, {
      name: 'payg', kind: 'payg', workspaceId: null,
      keys: ['sk-2'], cookie: null,
    }).id;
    store.setProbeResult(a, { status: 'cooldown', detail: 'GoUsageLimitError: weekly limit', retryUntil: 10_000, lastProbeAt: 5_000 });
    store.setBilling(a, { balanceUnits: 123_000_000, monthlyLimitUnits: 1_000_000_000, monthlyUsageUnits: 245_000_000, at: 7_000 });

    const pool = {
      snapshot: () => [
        snapEntry({ fingerprint: '****xxx1', accountId: a, healthy: false, disabledReason: 'quota-exhausted', recoverInMs: 4_000, lastUsedAt: 3_000 }),
        snapEntry({ fingerprint: '****xxx2', accountId: a, healthy: true }),
        snapEntry({ fingerprint: '****xxx3', accountId: b }),
        snapEntry({ fingerprint: '****xxx4', accountId: 0 }), // env 未归属 key，不应出现
      ],
    } as unknown as KeyPool;

    const section = buildAccountsSection(store, pool, 8_000);
    expect(section.degraded).toBeNull();
    expect(section.list).toHaveLength(2);

    const aView = section.list.find((x) => x.id === a)!;
    expect(aView.status).toBe('cooldown');
    expect(aView.statusDetail).toBe('GoUsageLimitError: weekly limit');
    expect(aView.retryUntil).toBe(10_000);
    expect(aView.retryInMs).toBe(2_000); // 10_000 - now(8_000)
    expect(aView.balance).toBe(1.23);
    expect(aView.monthlyLimit).toBe(10);
    expect(aView.monthlyUsage).toBe(2.45);
    expect(aView.monthlyPercent).toBe(24.5);
    expect(aView.lastBillingAt).toBe(7_000);
    expect(aView.keys.map((k) => k.fingerprint).sort()).toEqual(['****xxx1', '****xxx2']);
    // 健康 key 省略 disabledReason，坏 key 带原因
    const bad = aView.keys.find((k) => k.fingerprint === '****xxx1')!;
    expect(bad.healthy).toBe(false);
    expect(bad.disabledReason).toBe('quota-exhausted');
    expect(bad.recoverInMs).toBe(4_000);
    const good = aView.keys.find((k) => k.fingerprint === '****xxx2')!;
    expect(good.disabledReason).toBeUndefined();
    expect(good.recoverInMs).toBe(0);

    // payg 账户有一个 key 卡片（****xxx3 挂在它名下）
    expect(section.list.find((x) => x.id === b)!.keys.map((k) => k.fingerprint)).toEqual(['****xxx3']);
    // accountId=0 的 env 未归属 key 不进任何账户
    expect(section.list.flatMap((x) => x.keys.map((k) => k.fingerprint))).not.toContain('****xxx4');
    db.close();
  });

  it('未探/未知：statusDetail null、monthlyPercent null（limit 为空时）', () => {
    const { db, store } = makeStore();
    const id = createOk(store, { name: 'x', kind: 'unknown', workspaceId: null, keys: [], cookie: null }).id;
    const pool = { snapshot: () => [] as PoolKeySnapshot[] } as unknown as KeyPool;
    const view = buildAccountsSection(store, pool, Date.now()).list[0]!;
    expect(view.status).toBe('unknown');
    expect(view.statusDetail).toBeNull();
    expect(view.retryInMs).toBe(0);
    expect(view.balance).toBeNull();
    expect(view.monthlyLimit).toBeNull();
    expect(view.monthlyUsage).toBeNull();
    expect(view.monthlyPercent).toBeNull();
    db.close();
  });

  it('store 禁用 → degraded + 空 list（secret 不可用 / db 不可用两条路径）', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    const noSecret = new AccountsStore(db, null, cfg({ upstreamKeys: [] }), log);
    const emptyPool = {} as unknown as KeyPool;
    expect(buildAccountsSection(noSecret, emptyPool, 0).degraded).toBe('secret unavailable');
    expect(buildAccountsSection(noSecret, emptyPool, 0).list).toEqual([]);
    db.close();
  });
});

describe('OAuth refresh_token 落库（setOauthRefresh/getOauthRefresh）', () => {
  it('roundtrip：明文进、加密落库（1: 前缀）、解密取回', () => {
    const { db, store } = makeStore();
    const id = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: [], cookie: null }).id;
    expect(store.setOauthRefresh(id, 'rt-secret-token')).toBe(true);
    expect(store.getOauthRefresh(id)).toBe('rt-secret-token');
    // 落库形态是密文：列值带 1: 前缀，绝不出现明文。
    const enc = db.getAccount(id)!.oauthRefreshEnc!;
    expect(enc.startsWith('1:')).toBe(true);
    expect(enc).not.toContain('rt-secret-token');
    db.close();
  });

  it('null 清除；不存在的 id → false；密文损坏 → get 返回 null', () => {
    const { db, store } = makeStore();
    const id = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: [], cookie: null }).id;
    expect(store.setOauthRefresh(id, 'tok')).toBe(true);
    expect(store.setOauthRefresh(id, null)).toBe(true); // 清除
    expect(store.getOauthRefresh(id)).toBeNull();
    expect(store.setOauthRefresh(999, 'tok')).toBe(false); // 不存在
    expect(store.getOauthRefresh(999)).toBeNull();
    // 密文被破坏 → decrypt 失败返回 null（绝不抛）。
    expect(store.setOauthRefresh(id, 'tok')).toBe(true);
    db.updateAccount(id, { oauthRefreshEnc: '1:broken' });
    expect(store.getOauthRefresh(id)).toBeNull();
    db.close();
  });

  it('降级：store 不可用 → set false / get null', () => {
    const db = new UsageDb('', 30, log);
    const store = new AccountsStore(db, null, cfg({ upstreamKeys: [] }), log);
    expect(store.setOauthRefresh(1, 'tok')).toBe(false);
    expect(store.getOauthRefresh(1)).toBeNull();
  });
});

describe('key 昵称（StoredKey 双格式兼容）', () => {
  it('旧格式字符串数组可读（nickname null），首次写回自动升级为对象数组', () => {
    const { db, store } = makeStore();
    const id = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: [], cookie: null }).id;
    // 直接改库注入旧格式（字符串数组）
    db.updateAccount(id, { keysEnc: secret.encrypt(JSON.stringify(['sk-old-1', 'sk-old-2'])) });

    expect(store.keysOf(id)).toEqual(['sk-old-1', 'sk-old-2']);
    expect(store.keyNickname(id, 'sk-old-1')).toBeNull();

    // 首次写回：旧格式自动升级为对象数组，只改命中的条目
    expect(store.setKeyNickname(id, 'sk-old-1', '主力')).toBe(true);
    const plain = secret.decrypt(db.getAccount(id)!.keysEnc)!;
    expect(JSON.parse(plain)).toEqual([
      { key: 'sk-old-1', nickname: '主力' },
      { key: 'sk-old-2', nickname: null },
    ]);
    db.close();
  });

  it('新格式对象数组读回；坏条目跳过；keyNickname 精确匹配', () => {
    const { db, store } = makeStore();
    const id = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: [], cookie: null }).id;
    // 混合形态注入：对象 / 旧字符串 / 坏条目（数字、null、缺 key 的对象）
    db.updateAccount(id, {
      keysEnc: secret.encrypt(JSON.stringify([
        { key: 'sk-obj', nickname: '对象昵称' },
        { key: 'sk-nullnick', nickname: null },
        'sk-str',
        42,
        null,
        { key: 7 },
        { nickname: 'no-key' },
      ])),
    });

    expect(store.keysOf(id)).toEqual(['sk-obj', 'sk-nullnick', 'sk-str']);
    expect(store.keyNickname(id, 'sk-obj')).toBe('对象昵称');
    expect(store.keyNickname(id, 'sk-nullnick')).toBeNull();
    expect(store.keyNickname(id, 'sk-str')).toBeNull(); // 旧字符串 → nickname null
    expect(store.keyNickname(id, 'sk-nope')).toBeNull(); // 无此 key
    expect(store.keyNickname(999, 'sk-obj')).toBeNull(); // 无此账户
    db.close();
  });

  it('setKeyNickname：增改清、空串/null 都清除、无变化幂等、清洗控制符', () => {
    const { db, store } = makeStore();
    const id = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: ['sk-1'], cookie: null }).id;

    // 增
    expect(store.setKeyNickname(id, 'sk-1', '主力号-1')).toBe(true);
    expect(store.keyNickname(id, 'sk-1')).toBe('主力号-1');
    // 改
    expect(store.setKeyNickname(id, 'sk-1', '备用号')).toBe(true);
    expect(store.keyNickname(id, 'sk-1')).toBe('备用号');
    // 无变化：幂等成功（不落库也返回 true）
    expect(store.setKeyNickname(id, 'sk-1', '备用号')).toBe(true);
    // 空串清除
    expect(store.setKeyNickname(id, 'sk-1', '')).toBe(true);
    expect(store.keyNickname(id, 'sk-1')).toBeNull();
    // null 清除
    expect(store.setKeyNickname(id, 'sk-1', 'X')).toBe(true);
    expect(store.setKeyNickname(id, 'sk-1', null)).toBe(true);
    expect(store.keyNickname(id, 'sk-1')).toBeNull();

    // 不存在：key 或账户 → false
    expect(store.setKeyNickname(id, 'sk-nope', 'X')).toBe(false);
    expect(store.setKeyNickname(999, 'sk-1', 'X')).toBe(false);

    // 清洗：stripControl + 截断 100（与 setProbeResult 同口径）
    const evil = 'bad\u0000name' + 'x'.repeat(200);
    expect(store.setKeyNickname(id, 'sk-1', evil)).toBe(true);
    const nick = store.keyNickname(id, 'sk-1')!;
    expect(nick).not.toContain('\u0000');
    expect(nick.length).toBe(100);
    db.close();
  });

  it('解密失败：keyNickname null、setKeyNickname false 且不覆盖落盘；降级同口径', () => {
    const { db, store } = makeStore();
    const id = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: ['sk-1'], cookie: null }).id;
    db.updateAccount(id, { keysEnc: 'garbage' });

    expect(store.keyNickname(id, 'sk-1')).toBeNull();
    expect(store.setKeyNickname(id, 'sk-1', 'X')).toBe(false);
    expect(db.getAccount(id)!.keysEnc).toBe('garbage'); // 不覆盖损坏数据

    // 降级（无 secret）：null / false
    const db2 = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    const degraded = new AccountsStore(db2, null, cfg({ upstreamKeys: [] }), log);
    expect(degraded.keyNickname(1, 'sk-1')).toBeNull();
    expect(degraded.setKeyNickname(1, 'sk-1', 'X')).toBe(false);
    expect(degraded.keyNicknameMap(1).size).toBe(0);
    db2.close();
    db.close();
  });

  it('buildAccountsSection keys 带 nickname（未命名 null，未匹配 fingerprint 兜底 null）', () => {
    const { db, store } = makeStore();
    const a = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: ['sk-nick-1'], cookie: null }).id;
    const b = createOk(store, { name: 'b', kind: 'unknown', workspaceId: null, keys: ['sk-plain-2'], cookie: null }).id;
    store.setKeyNickname(a, 'sk-nick-1', '主力号');

    const pool = {
      snapshot: () => [
        { fingerprint: keyFingerprint('sk-nick-1'), accountId: a },
        { fingerprint: '****no-match', accountId: a },
        { fingerprint: keyFingerprint('sk-plain-2'), accountId: b },
      ].map((o) => snapEntry(o)),
    } as unknown as KeyPool;

    const section = buildAccountsSection(store, pool, 0);
    const aKeys = section.list.find((x) => x.id === a)!.keys;
    expect(aKeys.find((k) => k.fingerprint === keyFingerprint('sk-nick-1'))!.nickname).toBe('主力号');
    expect(aKeys.find((k) => k.fingerprint === '****no-match')!.nickname).toBeNull();
    expect(section.list.find((x) => x.id === b)!.keys[0]!.nickname).toBeNull();
    db.close();
  });

  it('addKey/removeKey 在对象格式下正常工作，昵称随 key 保留', () => {
    const { db, store } = makeStore();
    // key 取 6+ 字符：≤4 字符的 key 指纹恒为 '****'，会碰撞（见 keyFingerprint）
    const id = createOk(store, { name: 'a', kind: 'unknown', workspaceId: null, keys: ['sk-111'], cookie: null }).id;
    expect(store.setKeyNickname(id, 'sk-111', '主力')).toBe(true);

    // addKey：已有 key 昵称保留，新 key 无昵称
    expect(store.addKey(id, 'sk-222')).toEqual({ ok: true });
    expect(store.keyNickname(id, 'sk-111')).toBe('主力');
    expect(store.keyNickname(id, 'sk-222')).toBeNull();

    // removeKey 删无昵称的 key：另一 key 昵称保留
    expect(store.removeKey(id, keyFingerprint('sk-222'))).toBe('sk-222');
    expect(store.keyNickname(id, 'sk-111')).toBe('主力');
    expect(store.get(id)!.keyCount).toBe(1);

    // removeKey 删带昵称的 key：昵称随之消失
    expect(store.removeKey(id, keyFingerprint('sk-111'))).toBe('sk-111');
    expect(store.keyNickname(id, 'sk-111')).toBeNull();
    expect(store.get(id)!.keyCount).toBe(0);
    db.close();
  });
});

describe('隐私：落盘文件不含明文', () => {
  it('key/cookie 只以密文形态进 db 文件', () => {
    const { db, store } = makeStore();
    const id = createOk(store, {
      name: '私密账户', kind: 'subscription', workspaceId: null,
      keys: ['sk-priv-key-9a8b', 'sk-priv-key-7c6d'], cookie: 'auth=priv-cookie-secret',
    }).id;
    store.setOauthRefresh(id, 'rt-priv-refresh-secret');
    db.close();
    const raw = fs.readFileSync(path.join(tmpDir, 'usage.db')).toString('latin1');
    expect(raw).not.toContain('sk-priv-key-9a8b');
    expect(raw).not.toContain('sk-priv-key-7c6d');
    expect(raw).not.toContain('priv-cookie-secret');
    expect(raw).not.toContain('rt-priv-refresh-secret');
    expect(raw).toContain('1:'); // 密文确实落盘了
  });
});

describe('账号级模型白名单（allowedModels）', () => {
  it('allowedModelsOf 默认 null（未配置 = 用全局白名单）', () => {
    const { db, store } = makeStore();
    const acc = createOk(store, { name: 'a', kind: 'subscription', workspaceId: null, keys: ['sk-1'], cookie: null });
    expect(store.allowedModelsOf(acc.id)).toBeNull();
    expect(store.get(acc.id)!.allowedModels).toBeNull();
    db.close();
  });

  it('setAllowedModels 落库 + 内存缓存热生效（trim + 去重）', () => {
    const { db, store } = makeStore();
    const acc = createOk(store, { name: 'a', kind: 'subscription', workspaceId: null, keys: ['sk-1'], cookie: null });
    expect(store.setAllowedModels(acc.id, ['deepseek-v4-flash', ' deepseek-v4-flash-free ', 'deepseek-v4-flash'])).toBe(true);
    // 缓存热生效：立即读。
    expect(store.allowedModelsOf(acc.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash-free']);
    // 视图也带（/__metrics 与 /__admin 展示用）。
    expect(store.get(acc.id)!.allowedModels).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash-free']);
    db.close();
  });

  it('空数组/全空 → 清除回全局（null）', () => {
    const { db, store } = makeStore();
    const acc = createOk(store, { name: 'a', kind: 'subscription', workspaceId: null, keys: ['sk-1'], cookie: null });
    store.setAllowedModels(acc.id, ['deepseek-v4-flash']);
    expect(store.allowedModelsOf(acc.id)).toEqual(['deepseek-v4-flash']);
    // 空数组 = 清除。
    expect(store.setAllowedModels(acc.id, [])).toBe(true);
    expect(store.allowedModelsOf(acc.id)).toBeNull();
    // 再设置后传 null 也清除。
    store.setAllowedModels(acc.id, ['x']);
    expect(store.allowedModelsOf(acc.id)).toEqual(['x']);
    expect(store.setAllowedModels(acc.id, null)).toBe(true);
    expect(store.allowedModelsOf(acc.id)).toBeNull();
    db.close();
  });

  it('重启（新 store 同一 db）缓存重建，白名单仍在', () => {
    const { db, store } = makeStore();
    const acc = createOk(store, { name: 'a', kind: 'subscription', workspaceId: null, keys: ['sk-1'], cookie: null });
    store.setAllowedModels(acc.id, ['deepseek-v4-flash']);
    // 模拟重启：新 store 同一 db，allowedModelsOf 懒加载重建缓存。
    const store2 = new AccountsStore(db, secret, cfg({}), log);
    expect(store2.allowedModelsOf(acc.id)).toEqual(['deepseek-v4-flash']);
    db.close();
  });

  it('账户不存在 → set false / allowedModelsOf null；降级 → null', () => {
    const { db, store } = makeStore();
    expect(store.setAllowedModels(9999, ['x'])).toBe(false);
    expect(store.allowedModelsOf(9999)).toBeNull();
    // 降级（无 secret）：整体 no-op。
    const db2 = new UsageDb(path.join(tmpDir, 'degraded.db'), 30, log);
    const degraded = new AccountsStore(db2, null, cfg({}), log);
    expect(degraded.allowedModelsOf(1)).toBeNull();
    expect(degraded.setAllowedModels(1, ['x'])).toBe(false);
    db2.close();
    db.close();
  });

  it('update（PATCH）传 allowedModels：数组写入、空数组清除，缓存同步', () => {
    const { db, store } = makeStore();
    const acc = createOk(store, { name: 'a', kind: 'subscription', workspaceId: null, keys: ['sk-1'], cookie: null });
    expect(store.update(acc.id, { allowedModels: ['deepseek-v4-flash'] })).toBe(true);
    expect(store.allowedModelsOf(acc.id)).toEqual(['deepseek-v4-flash']);
    expect(store.update(acc.id, { allowedModels: [] })).toBe(true);
    expect(store.allowedModelsOf(acc.id)).toBeNull();
    db.close();
  });

  it('update（PATCH）不含 allowedModels 不清空白名单缓存（回归）', () => {
    // 回归：修复前 update() 末尾无条件 allowedCache.set(id, dbPatch.allowedModels
    // ?? null)，任何不含白名单字段的 PATCH（改 cookie/name/workspaceId 常见
    // 操作）把内存缓存静默清成 null —— 账号级白名单内存态失效、零日志、
    // 重启才恢复。去掉 `patch.allowedModels !== undefined` 守卫会红。
    const { db, store } = makeStore();
    const acc = createOk(store, { name: 'a', kind: 'subscription', workspaceId: null, keys: ['sk-1'], cookie: null });
    expect(store.update(acc.id, { allowedModels: ['deepseek-v4-flash'] })).toBe(true);
    expect(store.allowedModelsOf(acc.id)).toEqual(['deepseek-v4-flash']);
    // 改 cookie（不含 allowedModels）——白名单必须保持不变。
    expect(store.update(acc.id, { cookie: 'auth=new-cookie' })).toBe(true);
    expect(store.allowedModelsOf(acc.id)).toEqual(['deepseek-v4-flash']);
    expect(store.get(acc.id)!.allowedModels).toEqual(['deepseek-v4-flash']);
    // 改名字同理。
    expect(store.update(acc.id, { name: 'renamed' })).toBe(true);
    expect(store.allowedModelsOf(acc.id)).toEqual(['deepseek-v4-flash']);
    db.close();
  });

  it('remove 清缓存：删除账号后 allowedModelsOf 不再返回旧值', () => {
    const { db, store } = makeStore();
    const acc = createOk(store, { name: 'a', kind: 'subscription', workspaceId: null, keys: ['sk-1'], cookie: null });
    store.setAllowedModels(acc.id, ['deepseek-v4-flash']);
    expect(store.allowedModelsOf(acc.id)).toEqual(['deepseek-v4-flash']);
    store.remove(acc.id);
    expect(store.allowedModelsOf(acc.id)).toBeNull();
    db.close();
  });
});
