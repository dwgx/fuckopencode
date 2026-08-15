import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { UsageDb, defaultDbPath, type UsageRow } from '../src/usagedb.js';

/** 每个用例一个独立临时目录，避免 db 文件互相污染。 */
let tmpDir: string;
/** 静音日志，只在断言降级原因时才看。 */
const logs: string[] = [];
const log = (m: string): void => void logs.push(m);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-usagedb-'));
  logs.length = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function row(over: Partial<UsageRow> = {}): UsageRow {
  return {
    at: 1_700_000_000_000,
    keyFingerprint: '****0osU',
    model: 'claude-mythos-5',
    upstreamModel: 'deepseek-v4-flash',
    endpoint: 'subscription',
    status: 200,
    durationMs: 1234,
    stream: false,
    inputTokens: 100,
    outputTokens: 500,
    thinkingTokens: 400,
    error: null,
    path: '/v1/messages',
    ua: 'claude-cli/1.0.27 (external, cli)',
    ...over,
  };
}

describe('UsageDb 基础读写', () => {
  it('建库建表、写请求、按 key 聚合', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    expect(db.enabled).toBe(true);
    expect(db.disabledReason).toBeNull();

    db.recordRequest(row({ at: 1000, keyFingerprint: '****0osU', inputTokens: 10, outputTokens: 20 }));
    db.recordRequest(row({ at: 2000, keyFingerprint: '****0osU', inputTokens: 30, outputTokens: 40 }));
    db.recordRequest(row({ at: 3000, keyFingerprint: '****ZOBb', inputTokens: 5, outputTokens: 5 }));

    const h = db.history()!;
    expect(h).not.toBeNull();
    expect(h.totalRequests).toBe(3);
    expect(h.since).toBe(1000);

    const byFp = new Map(h.byKey.map((k) => [k.fingerprint, k]));
    const a = byFp.get('****0osU')!;
    expect(a.requests).toBe(2);
    expect(a.inputTokens).toBe(40);
    expect(a.outputTokens).toBe(60);
    expect(a.tokens).toBe(100);
    expect(a.lastAt).toBe(2000);
    expect(byFp.get('****ZOBb')!.requests).toBe(1);

    db.close();
  });

  it('未归属请求不冒充成一个 key（幽灵 key 回归测试）', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);

    // 真 key 的请求
    db.recordRequest(row({ at: 1000, keyFingerprint: '****0osU' }));
    db.recordRequest(row({ at: 2000, keyFingerprint: '****ZOBb' }));
    // 还没选到 key 就被拒的：keyFingerprint 为空 -> 落库写成 '-'
    // 线上真实出现过 288 条这种（客户端 400 格式错误 / 401 鉴权失败），
    // 修复前它们会作为一个指纹为 '-' 的「第三个 key」出现在面板上。
    db.recordRequest(row({ at: 3000, keyFingerprint: '', status: 400 }));
    db.recordRequest(row({ at: 4000, keyFingerprint: '', status: 401 }));
    db.recordRequest(row({ at: 5000, keyFingerprint: '', status: 503 }));

    const h = db.history()!;
    expect(h.byKey.map((k) => k.fingerprint).sort()).toEqual(['****0osU', '****ZOBb']);
    expect(h.byKey.some((k) => k.fingerprint === '-')).toBe(false);

    // 但不能丢：总数要能对上账，否则面板数字自相矛盾。
    expect(h.totalRequests).toBe(5);
    expect(h.unattributedRequests).toBe(3);
    expect(h.unattributedFailed).toBe(3);
    const sum = h.byKey.reduce((n, k) => n + k.requests, 0);
    expect(sum + h.unattributedRequests).toBe(h.totalRequests);

    db.close();
  });

  it('D-P2-1：count_tokens/探活 的未归属请求不计入 unattributed（与 totalRequests 同口径）', () => {
    // count_tokens 请求落库时 keyFingerprint 为 '-'（server.ts 只设 endpoint），
    // 修复前 unattributed 查询没有 endpoint 过滤，会把它们算进「未归属请求数」，
    // 而 totalRequests 用的是 meta.unattrib（有过滤）→ 不变量 sum(byKey)+unattrib=total 被违反。
    const db = new UsageDb(path.join(tmpDir, 'unattrib-noise.db'), 30, log);
    db.recordRequest(row({ at: 1000, keyFingerprint: '', endpoint: 'count_tokens', status: 200 }));
    db.recordRequest(row({ at: 2000, keyFingerprint: '', endpoint: 'probe', status: 429 }));
    db.recordRequest(row({ at: 3000, keyFingerprint: '', endpoint: 'subscription', status: 503 }));

    const h = db.history()!;
    // 修复前：unattributedRequests=3（把 count_tokens/probe 也算进去了），
    // totalRequests=1 → sum+unattrib=4 ≠ 1。
    expect(h.unattributedRequests).toBe(1);
    expect(h.unattributedFailed).toBe(1);
    expect(h.totalRequests).toBe(1);
    const sum = h.byKey.reduce((n, k) => n + k.requests, 0);
    expect(sum + h.unattributedRequests).toBe(h.totalRequests);
    db.close();
  });

  it('ok / failed 按状态码分类', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    db.recordRequest(row({ at: 1, status: 200 }));
    db.recordRequest(row({ at: 2, status: 201 }));
    db.recordRequest(row({ at: 3, status: 429 }));
    db.recordRequest(row({ at: 4, status: 503, error: 'pool empty' }));
    db.recordRequest(row({ at: 5, status: 0, error: 'aborted' })); // 客户端断开

    const k = db.history()!.byKey[0]!;
    expect(k.requests).toBe(5);
    expect(k.ok).toBe(2);
    expect(k.failed).toBe(3); // 429 + 503 + status=0
    db.close();
  });

  it('探活记录（endpoint=probe）不计入 byKey/totalRequests（面板累计只算真实请求）', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    db.recordRequest(row({ at: 1000, keyFingerprint: '****0osU', endpoint: 'subscription' }));
    db.recordRequest(row({ at: 2000, keyFingerprint: '****0osU', endpoint: 'probe', status: 200 }));
    db.recordRequest(row({ at: 3000, keyFingerprint: '****ZOBb', endpoint: 'probe', status: 429 }));
    db.recordRequest(row({ at: 4000, keyFingerprint: '****ZOBb', endpoint: 'subscription', status: 200 }));

    const h = db.history()!;
    // 探活 2 条不计入总数（面板「累计 N 请求」只含真实流量）。
    expect(h.totalRequests).toBe(2);
    const a = h.byKey.find((k) => k.fingerprint === '****0osU')!;
    expect(a.requests).toBe(1);
    expect(a.lastAt).toBe(1000); // probe 的 lastAt 不覆盖「最近使用」
    const b = h.byKey.find((k) => k.fingerprint === '****ZOBb')!;
    expect(b.requests).toBe(1);
    expect(b.ok).toBe(1); // 429 探活不算失败
    expect(b.failed).toBe(0);
    // 总数对账：byKey 之和 = totalRequests（探活被排除后两边一致）
    const sum = h.byKey.reduce((n, k) => n + k.requests, 0);
    expect(sum + h.unattributedRequests).toBe(h.totalRequests);
    db.close();
  });

  it('key 状态变更审计：最新在前，含原因与冷却', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    db.recordKeyEvent({
      at: 1000, keyFingerprint: '****ZOBb', type: 'disabled',
      kind: 'quota-exhausted', cooldownMs: 22_680_000, healthyCount: 1, poolSize: 2,
    });
    db.recordKeyEvent({
      at: 2000, keyFingerprint: '****ZOBb', type: 'recovered',
      healthyCount: 2, poolSize: 2,
    });

    const evs = db.history()!.recentKeyEvents;
    expect(evs).toHaveLength(2);
    expect(evs[0]!.type).toBe('recovered'); // 最新在前
    expect(evs[0]!.kind).toBeNull();
    expect(evs[0]!.cooldownMs).toBeNull();
    expect(evs[1]!.type).toBe('disabled');
    expect(evs[1]!.kind).toBe('quota-exhausted');
    expect(evs[1]!.cooldownMs).toBe(22_680_000);
    db.close();
  });

  it('管理审计：写入行（op/accountId/ok/note），只读重开可回读', () => {
    const p = path.join(tmpDir, 'usage.db');
    const db = new UsageDb(p, 30, log);
    db.insertAdminAudit({ at: 1000, op: 'monthly-limit', accountId: 3, ok: true, note: null });
    db.insertAdminAudit({ at: 2000, op: 'import-cookie', accountId: null, ok: false, note: 'no-target' });
    db.close();

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => any;
    };
    const raw = new DatabaseSync(p, { readOnly: true });
    const rows = raw
      .prepare('SELECT at, op, account_id, ok, note FROM admin_audit ORDER BY id')
      .all() as Array<Record<string, unknown>>;
    raw.close();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ at: 1000, op: 'monthly-limit', account_id: 3, ok: 1, note: null });
    expect(rows[1]).toMatchObject({ at: 2000, op: 'import-cookie', account_id: null, ok: 0, note: 'no-target' });
  });

  it('管理审计：ip 列落库 + listAdminAudit 回读（联表账号名）', () => {
    const p = path.join(tmpDir, 'usage.db');
    const db = new UsageDb(p, 30, log);
    db.insertAdminAudit({ at: 1000, op: 'login', accountId: null, ok: true, note: null, ip: '127.0.0.1' });
    db.insertAdminAudit({ at: 2000, op: 'account.patch', accountId: 7, ok: false, note: 'update failed', ip: '10.0.0.2' });
    db.close();

    const list = new UsageDb(p, 30, log);
    const items = list.listAdminAudit(50);
    expect(items).not.toBeNull();
    expect(items).toHaveLength(2);
    expect(items![0]).toMatchObject({ at: 2000, op: 'account.patch', accountId: 7, ok: false, note: 'update failed', ip: '10.0.0.2' });
    expect(items![1]).toMatchObject({ at: 1000, op: 'login', accountId: null, ok: true, note: null, ip: '127.0.0.1' });
    // 有账号关联时联表带名字；无账号（accountId null）则名字为 null。
    expect(items![0]!.accountName).toBeNull();
    expect(items![1]!.accountName).toBeNull();
    list.close();
  });

  it('listAdminAudit：账号存在时联表出账号名，limit 生效', () => {
    const p = path.join(tmpDir, 'usage.db');
    const db = new UsageDb(p, 30, log);
    // 先建账号（accounts 表 DDL 由 UsageDb 负责），再写审计行。
    db.close();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string) => any;
    };
    const raw = new DatabaseSync(p);
    raw.exec(`INSERT INTO accounts (name, keys_enc, created_at) VALUES ('audit-acc', '[]', 1)`);
    raw.close();

    const db2 = new UsageDb(p, 30, log);
    db2.insertAdminAudit({ at: 5000, op: 'account.delete', accountId: 1, ok: true, note: null, ip: '127.0.0.1' });
    db2.insertAdminAudit({ at: 4000, op: 'login', accountId: null, ok: false, note: 'invalid', ip: '127.0.0.1' });
    const items = db2.listAdminAudit(1)!;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ op: 'account.delete', accountId: 1, accountName: 'audit-acc', ok: true });
    db2.close();
  });

  it('count_tokens 记账请求被排除出用量聚合（不混进请求数统计）', () => {
    const p = path.join(tmpDir, 'usage.db');
    const db = new UsageDb(p, 30, log);
    const now = 1_700_000_000_000;
    db.recordRequest(row({ endpoint: 'subscription', at: now, inputTokens: 10 }));
    db.recordRequest(row({ endpoint: 'count_tokens', at: now + 1000, inputTokens: 5000 }));
    db.recordRequest(row({ endpoint: 'probe', at: now + 2000, inputTokens: 50 }));

    const h = db.history()!;
    expect(h.totalRequests).toBe(1); // 只有 subscription 那条
    // usageTrend 同样排除 count_tokens：仅 subscription 计入。
    const t = db.usageTrend(7, now + 3000)!;
    expect(t.requests).toBe(1);
    expect(t.inputTokens).toBe(10);
    db.close();
  });

  it('跨实例持久化：重开同一文件数据还在（这正是内存 metrics 做不到的）', () => {
    const p = path.join(tmpDir, 'usage.db');
    const db1 = new UsageDb(p, 30, log);
    db1.recordRequest(row({ at: 500 }));
    db1.close();

    const db2 = new UsageDb(p, 30, log);
    expect(db2.history()!.totalRequests).toBe(1);
    db2.close();
  });

  it('自动建父目录（data/ 不存在也能起）', () => {
    const p = path.join(tmpDir, 'nested', 'deep', 'usage.db');
    const db = new UsageDb(p, 30, log);
    expect(db.enabled).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
    db.close();
  });

  it('不存 key 原文，只存指纹', () => {
    const p = path.join(tmpDir, 'usage.db');
    const db = new UsageDb(p, 30, log);
    db.recordRequest(row({ keyFingerprint: '****0osU' }));
    db.close();
    // 直接扫文件字节：绝不能出现 key 原文形态
    const raw = fs.readFileSync(p).toString('latin1');
    expect(raw).toContain('****0osU');
    expect(raw).not.toContain('sk-');
  });
});

describe('UsageDb 保留期清理', () => {
  /** 只读连接直查 requests 表行数（绕过 UsageDb 读方法/缓存，断言真实删除）。 */
  function requestCount(p: string): number {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => any;
    };
    const raw = new DatabaseSync(p, { readOnly: true });
    const n = (raw.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n;
    raw.close();
    return n;
  }

  /** 只读连接直查 key_totals 的 fingerprint（P2-1：断言增量删后聚合表内容）。 */
  function keyTotalsRows(p: string): Array<{ fingerprint: string; requests: number }> {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => any;
    };
    const raw = new DatabaseSync(p, { readOnly: true });
    const rows = raw
      .prepare('SELECT fingerprint, requests FROM key_totals ORDER BY fingerprint')
      .all() as Array<{ fingerprint: string; requests: number }>;
    raw.close();
    return rows;
  }

  it('删掉超过保留期的行，保留期内的不动（增量删聚合：key_totals 不清零，只删无窗口内请求的 key）', () => {
    const p = path.join(tmpDir, 'usage.db');
    const db = new UsageDb(p, 1, log); // 保留 1 天
    const now = 10 * 86_400_000;
    db.recordRequest(row({ at: now - 5 * 86_400_000 })); // 5 天前，该删
    db.recordRequest(row({ at: now - 2 * 86_400_000 })); // 2 天前，该删
    db.recordRequest(row({ at: now - 3_600_000 })); // 1 小时前，保留
    db.recordKeyEvent({
      at: now - 5 * 86_400_000, keyFingerprint: '****ZOBb',
      type: 'disabled', healthyCount: 1, poolSize: 2,
    });

    expect(db.history()!.totalRequests).toBe(3);
    db.pruneNow(now);
    // requests 明细：3 → 1（窗口内只剩 1 小时前那行）——prune 真的删了旧行。
    expect(requestCount(p)).toBe(1);
    // 聚合表是快照：窗口内仍有请求的 key（****0osU）保留，计数不清零
    // （P2-1 增量删不整表重建的固有语义，重启后 migrate 重建回到精确窗口）。
    expect(db.history()!.totalRequests).toBe(3);
    expect(db.history()!.recentKeyEvents).toHaveLength(0);
    db.close();
  });

  it('P2-1：prune 增量删 key_totals —— 窗口内仍有请求的 key 保留，仅窗口外请求的 key 删除', () => {
    const p = path.join(tmpDir, 'prune-totals.db');
    const db = new UsageDb(p, 1, log); // 保留 1 天
    const now = 10 * 86_400_000;
    // key A：窗口内（1 小时前）+ 窗口外（5 天前）都有请求 → prune 后保留。
    db.recordRequest(row({ at: now - 5 * 86_400_000, keyFingerprint: '****keepA' }));
    db.recordRequest(row({ at: now - 3_600_000, keyFingerprint: '****keepA' }));
    // key B：只有窗口外请求（5 天前）→ prune 后删除。
    db.recordRequest(row({ at: now - 5 * 86_400_000, keyFingerprint: '****dropB' }));
    db.flush();
    expect(keyTotalsRows(p).map((r) => r.fingerprint)).toEqual(['****dropB', '****keepA']);

    db.pruneNow(now);
    // 只删掉已无窗口内请求的 key（dropB）；keepA 因窗口内仍有请求而保留。
    expect(keyTotalsRows(p).map((r) => r.fingerprint)).toEqual(['****keepA']);
    // 保留的 key 计数是快照（2 条都 upsert 过，含已删的窗口外行，不清零）。
    expect(keyTotalsRows(p)[0]!.requests).toBe(2);
    db.close();
  });

  it('管理审计随保留期清理（按 at，与 requests 同一 retention）', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 1, log); // 保留 1 天
    const now = 10 * 86_400_000;
    db.insertAdminAudit({ at: now - 5 * 86_400_000, op: 'monthly-limit', accountId: 1, ok: true, note: null });
    db.insertAdminAudit({ at: now - 3_600_000, op: 'import-cookie', accountId: 2, ok: false, note: 'ws' });
    db.pruneNow(now);
    db.close();

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => any;
    };
    const raw = new DatabaseSync(path.join(tmpDir, 'usage.db'), { readOnly: true });
    const rows = raw.prepare('SELECT op FROM admin_audit').all() as Array<{ op: string }>;
    raw.close();
    expect(rows).toEqual([{ op: 'import-cookie' }]);
  });

  it('retentionDays=0 表示不清理', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 0, log);
    db.recordRequest(row({ at: 1 })); // 极旧
    db.pruneNow(100 * 86_400_000);
    expect(db.history()!.totalRequests).toBe(1);
    db.close();
  });

  it('D-P2-2：rebuildTotals 非原子修复 —— 重建 INSERT 失败时 key_totals 不整表清空', () => {
    const db = new UsageDb(path.join(tmpDir, 'rebuild-atomic.db'), 30, log);
    db.recordRequest(row({ at: 1000, keyFingerprint: '****keep' }));
    db.recordRequest(row({ at: 2000, keyFingerprint: '****keep' }));
    db.flush();
    expect(db.history()!.totalRequests).toBe(2);

    // 让 rebuildTotals 的 INSERT 步骤抛错（模拟 SQLITE_BUSY/ENOSPC）。exec 是
    // DatabaseSync 原型方法，直接替换实例引用即可拦到 this.db.exec。
    // 关键：先执行 DELETE 部分再抛（模拟 SQLite 按语句 autocommit —— 旧实现里
    // DELETE 已生效、INSERT 才失败），不能整串直接抛（那样 DELETE 也没跑过）。
    const raw = db.sqlite()!;
    const origExec = raw.exec.bind(raw);
    let shouldFail = false;
    raw.exec = ((sql: string) => {
      if (shouldFail && /INSERT INTO key_totals/.test(sql)) {
        origExec(sql.split('INSERT INTO key_totals')[0]!);
        throw new Error('simulated ENOSPC');
      }
      return origExec(sql);
    }) as typeof raw.exec;

    shouldFail = true;
    // prune 会走到 rebuildTotals（retention=30d 下 cutoff 为负，requests 不会被删）。
    db.pruneNow(10 * 86_400_000);
    shouldFail = false;
    raw.exec = origExec;

    // 修复前：DELETE 先提交、INSERT 失败 → key_totals 整表清空 → 聚合永久偏低。
    // 修复后：BEGIN IMMEDIATE + ROLLBACK → 旧聚合保留。
    expect(db.history()!.totalRequests).toBe(2);
    db.close();
  });
});

describe('UsageDb 批量异步落库（热路径优化）', () => {
  /** 用第二个只读连接看「已提交」的行数（不经 UsageDb 读方法，绕过 flush-on-read）。 */
  function committedCount(p: string): number {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => any;
    };
    const raw = new DatabaseSync(p, { readOnly: true });
    const n = (raw.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n;
    raw.close();
    return n;
  }

  it('recordRequest 只入队不落库：flush 前第二个连接看不到，flush 后可见', () => {
    // 回归：去掉批量（recordRequest 改回同步 INSERT）这条会红 —— 未 flush 就不该
    // 有已提交行，这正是「写挪出热路径」的断言。
    const p = path.join(tmpDir, 'batch.db');
    const db = new UsageDb(p, 30, log);
    db.recordRequest(row({ at: 1000, keyFingerprint: '****batch' }));
    expect(committedCount(p)).toBe(0);
    db.flush();
    expect(committedCount(p)).toBe(1);
    db.close();
  });

  it('攒满 50 条自动批量落库（不等定时器）', () => {
    const p = path.join(tmpDir, 'batch50.db');
    const db = new UsageDb(p, 30, log);
    for (let i = 0; i < 50; i++) db.recordRequest(row({ at: 1000 + i, keyFingerprint: '****b50' }));
    expect(committedCount(p)).toBe(50);
    db.close();
  });

  it('100ms 定时器驱动批量落库', () => {
    vi.useFakeTimers();
    try {
      const p = path.join(tmpDir, 'batch-timer.db');
      const db = new UsageDb(p, 30, log);
      db.recordRequest(row({ at: 5, keyFingerprint: '****t' }));
      expect(committedCount(p)).toBe(0);
      vi.advanceTimersByTime(100);
      expect(committedCount(p)).toBe(1);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() 前自动 flush（干净关停不丢最后一批）', () => {
    const p = path.join(tmpDir, 'batch-close.db');
    const db = new UsageDb(p, 30, log);
    db.recordRequest(row({ at: 9, keyFingerprint: '****c' }));
    expect(committedCount(p)).toBe(0);
    db.close();
    expect(committedCount(p)).toBe(1);
  });

  it('D-I3：close() 后 enabled=false，recordRequest/flush 不往已关闭句柄写、不刷错日志', () => {
    const db = new UsageDb(path.join(tmpDir, 'close-enabled.db'), 30, log);
    db.recordRequest(row({ at: 1 }));
    db.close();
    expect(db.enabled).toBe(false);
    logs.length = 0;
    // 修复前：enabled 仍为 true，recordRequest 入队后 flush() 会对已关闭的
    // 句柄执行写库、每条刷一行「批量写入请求记录失败」。
    db.recordRequest(row({ at: 2 }));
    db.flush();
    expect(logs).toHaveLength(0);
    // 幂等：二次 close 直接早退，不抛、不刷日志。
    expect(() => db.close()).not.toThrow();
    expect(logs).toHaveLength(0);
  });

  it('读路径先 flush：recordRequest 后直接 listRequests 能看到（面板语义）', () => {
    const db = new UsageDb(path.join(tmpDir, 'batch-read.db'), 30, log);
    db.recordRequest(row({ at: 1234, keyFingerprint: '****read', endpoint: 'subscription' }));
    const page = db.listRequests(1, 10)!;
    expect(page.items[0]!.fingerprint).toBe('****read');
    expect(db.history()!.totalRequests).toBe(1);
    db.close();
  });

  it('UA 解析复用：调用方已给 client 就用它，不再从 ua 重解析', () => {
    // 回归：去掉复用（recordRequest 一律 parseUserAgent(row.ua)）这条会红 ——
    // 落库的 client 应是调用方给的值，而不是从 ua 重解析出的 Chrome。
    const db = new UsageDb(path.join(tmpDir, 'batch-ua.db'), 30, log);
    db.recordRequest(row({ at: 7, ua: 'Mozilla/5.0 (X11; Linux) Chrome/120', client: 'Preparsed' }));
    db.flush();
    const page = db.listRequests(1, 10)!;
    expect(page.items[0]!.client).toBe('Preparsed');
    db.close();
  });

  it('I-13：flush 首次失败（mock busy）→ 放回队首重试成功 → 行不丢', () => {
    vi.useFakeTimers();
    try {
      const p = path.join(tmpDir, 'flush-retry.db');
      const db = new UsageDb(p, 30, log);
      db.recordRequest(row({ at: Date.now() - 1000, keyFingerprint: '****retry' }));
      const raw = db.sqlite()!;
      const origExec = raw.exec.bind(raw);
      // 只让第一次 COMMIT 抛错（模拟 SQLITE_BUSY），事务 ROLLBACK 后整批放回队首。
      let commitFails = 1;
      raw.exec = ((sql: string) => {
        if (typeof sql === 'string' && sql === 'COMMIT' && commitFails > 0) {
          commitFails -= 1;
          throw new Error('simulated SQLITE_BUSY on commit');
        }
        return origExec(sql);
      }) as typeof raw.exec;

      db.flush();
      // 首次失败：行未提交（已回滚），放回队首等 200ms 重试，不丢弃。
      expect(committedCount(p)).toBe(0);
      expect(logs.some((l) => l.includes('放回队首'))).toBe(true);

      // 200ms 后重试：busy 消失，重试成功，行落库（修复前整批丢弃）。
      vi.advanceTimersByTime(250);
      expect(committedCount(p)).toBe(1);
      expect(db.history()!.totalRequests).toBe(1);
      raw.exec = origExec;
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('I-13：连续两次失败 → 丢弃整批 + 记日志（不无限重试）', () => {
    vi.useFakeTimers();
    try {
      const p = path.join(tmpDir, 'flush-drop.db');
      const db = new UsageDb(p, 30, log);
      db.recordRequest(row({ at: Date.now() - 1000, keyFingerprint: '****drop2' }));
      const raw = db.sqlite()!;
      const origExec = raw.exec.bind(raw);
      // 连续两次 COMMIT 都失败：首次失败放回队首，重试仍失败才丢弃。
      let commitFails = 2;
      raw.exec = ((sql: string) => {
        if (typeof sql === 'string' && sql === 'COMMIT' && commitFails > 0) {
          commitFails -= 1;
          throw new Error('simulated SQLITE_BUSY on commit');
        }
        return origExec(sql);
      }) as typeof raw.exec;

      db.flush(); // 第一次失败 → 放回队首
      vi.advanceTimersByTime(250); // 重试又失败 → 丢弃整批
      expect(committedCount(p)).toBe(0);
      expect(logs.some((l) => l.includes('仍失败') && l.includes('丢 1 条'))).toBe(true);
      raw.exec = origExec;

      // 丢弃后重试计数清零：后续正常写入不受影响。
      db.recordRequest(row({ at: Date.now() - 500, keyFingerprint: '****drop2' }));
      db.flush();
      expect(committedCount(p)).toBe(1);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('UsageDb 降级路径（观测设施绝不拖垮代理）', () => {
  it('空路径 = 显式关闭，所有方法都是 no-op 且不抛', () => {
    const db = new UsageDb('', 30, log);
    expect(db.enabled).toBe(false);
    expect(db.disabledReason).toBe('disabled by config');
    expect(() => db.recordRequest(row())).not.toThrow();
    expect(() => db.recordKeyEvent({
      at: 1, keyFingerprint: '****x', type: 'disabled', healthyCount: 0, poolSize: 1,
    })).not.toThrow();
    expect(() => db.insertAdminAudit({ at: 1, op: 'monthly-limit', accountId: 1, ok: true, note: null })).not.toThrow();
    expect(db.history()).toBeNull();
    expect(() => db.pruneNow(1)).not.toThrow();
    expect(() => db.close()).not.toThrow();
    // 关闭时不该刷日志（这是正常配置，不是故障）
    expect(logs).toHaveLength(0);
  });

  it('路径不可写：降级但不抛，记一条 warn', () => {
    // 把文件路径的父级指向一个**普通文件**，mkdirSync 必然失败
    const blocker = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const db = new UsageDb(path.join(blocker, 'usage.db'), 30, log);
    expect(db.enabled).toBe(false);
    expect(db.disabledReason).toBeTruthy();
    expect(logs.some((l) => l.includes('[usagedb]'))).toBe(true);
    // 降级后照常可调用
    expect(() => db.recordRequest(row())).not.toThrow();
    expect(db.history()).toBeNull();
  });

  it('写入失败（库已关闭）只记日志不上抛', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    expect(db.enabled).toBe(true);
    db.close(); // 句柄关掉，后续 prepared statement 执行会抛
    logs.length = 0;
    expect(() => db.recordRequest(row())).not.toThrow();
    expect(() => db.recordKeyEvent({
      at: 1, keyFingerprint: '****x', type: 'disabled', healthyCount: 0, poolSize: 1,
    })).not.toThrow();
    // history 失败也只降级为 null，不抛
    expect(() => db.history()).not.toThrow();
  });
});

describe('UsageDb 账户 CRUD（多账号面板数据层）', () => {
  it('insert 返回自增 id，get/list/delete 全流程', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    const id1 = db.insertAccount({ name: 'env', kind: 'unknown', keysEnc: '[]' });
    const id2 = db.insertAccount({ name: '主力号', kind: 'subscription', workspaceId: 'ws_1', keysEnc: '[enc]', cookieEnc: '[enc-cookie]' });
    expect(id1).toBe(1);
    expect(id2).toBe(2);
    if (id1 === false || id2 === false) throw new Error('insert failed');

    const row = db.getAccount(id2)!;
    expect(row.id).toBe(2);
    expect(row.name).toBe('主力号');
    expect(row.kind).toBe('subscription');
    expect(row.workspaceId).toBe('ws_1');
    expect(row.keysEnc).toBe('[enc]');
    expect(row.cookieEnc).toBe('[enc-cookie]');
    expect(row.status).toBe('unknown');
    expect(row.statusDetail).toBeNull();
    expect(row.retryUntil).toBe(0);
    expect(row.lastProbeAt).toBe(0);
    expect(row.lastBillingAt).toBe(0);
    expect(row.balanceUnits).toBeNull();
    // created_at 由模块内部填 Date.now()（与 requests.at 同风格）
    expect(row.createdAt).toBeGreaterThan(0);

    // 默认值落库（不全传时）
    const defaults = db.getAccount(id1)!;
    expect(defaults.kind).toBe('unknown');
    expect(defaults.workspaceId).toBeNull();
    expect(defaults.keysEnc).toBe('[]');
    expect(defaults.cookieEnc).toBeNull();
    expect(defaults.status).toBe('unknown');

    const list = db.listAccounts()!;
    expect(list.map((r) => r.id)).toEqual([id1, id2]); // 按 id 升序

    expect(db.deleteAccount(id1)).toBe(true);
    expect(db.getAccount(id1)).toBeNull();
    expect(db.listAccounts()!.map((r) => r.id)).toEqual([id2]);
    expect(db.deleteAccount(id2)).toBe(true);
    expect(db.listAccounts()).toHaveLength(0);
    db.close();
  });

  it('update 部分字段：undefined 不更新，null 置空', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    const inserted = db.insertAccount({ name: 'a', kind: 'unknown', keysEnc: '[]' });
    if (inserted === false) throw new Error('insert failed');
    const id = inserted;

    expect(db.updateAccount(id, { name: '改名', status: 'cooldown', retryUntil: 999 })).toBe(true);
    let row = db.getAccount(id)!;
    expect(row.name).toBe('改名');
    expect(row.kind).toBe('unknown'); // 没传的字段不动
    expect(row.retryUntil).toBe(999);
    expect(row.lastProbeAt).toBe(0);

    expect(db.updateAccount(id, { workspaceId: 'ws_x' })).toBe(true);
    expect(db.getAccount(id)!.workspaceId).toBe('ws_x');
    expect(db.updateAccount(id, { workspaceId: null })).toBe(true); // null = 置空
    expect(db.getAccount(id)!.workspaceId).toBeNull();

    // 空 patch（全 undefined）：幂等 no-op 也算成功
    expect(db.updateAccount(id, {})).toBe(true);
    row = db.getAccount(id)!;
    expect(row.name).toBe('改名');
    expect(row.status).toBe('cooldown');
    db.close();
  });

  it('m11：不存在的 id 更新 → false（0 行更新不能伪装成成功）', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    const inserted = db.insertAccount({ name: 'a', kind: 'unknown', keysEnc: '[]' });
    expect(inserted).not.toBe(false);
    if (inserted === false) throw new Error('insert failed');
    const id = inserted;
    // 账户存在：更新成功
    expect(db.updateAccount(id, { name: '改名' })).toBe(true);
    // 账户不存在：UPDATE 影响 0 行 → false（修复前会静默返回 true）
    expect(db.updateAccount(9999, { name: 'x' })).toBe(false);
    expect(db.updateAccount(id + 1, { status: 'ok', retryUntil: 1 })).toBe(false);
    db.close();
  });

  it('insert/update 失败返回 false、查询失败返回 null（不抛）', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    const inserted = db.insertAccount({ name: 'a', kind: 'unknown', keysEnc: '[]' });
    if (inserted === false) throw new Error('insert failed');
    const id = inserted;
    // 模拟底层句柄故障（盘满/只读）但保持 enabled=true：prepare 抛错 →
    // 写方法 catch 记日志返回 false、查询 catch 记日志返回 null，都不上抛。
    // （D-I3 修复后 close() 会置 enabled=false，不能用「先 close 再操作」
    //   来触发这条路径 —— 那是静默 no-op，不会走到 catch。）
    const raw = db.sqlite()!;
    const origPrepare = raw.prepare;
    raw.prepare = () => {
      throw new Error('simulated disk error');
    };
    logs.length = 0;

    expect(() => db.insertAccount({ name: 'b', kind: 'unknown', keysEnc: '[]' })).not.toThrow();
    expect(db.insertAccount({ name: 'b', kind: 'unknown', keysEnc: '[]' })).toBe(false);
    expect(db.updateAccount(id, { name: 'x' })).toBe(false);
    expect(db.deleteAccount(id)).toBe(false);
    expect(() => db.listAccounts()).not.toThrow();
    expect(db.listAccounts()).toBeNull();
    expect(() => db.getAccount(id)).not.toThrow();
    expect(db.getAccount(id)).toBeNull();
    expect(logs.some((l) => l.includes('[usagedb]'))).toBe(true);
    raw.prepare = origPrepare;
    db.close();
  });

  it('降级实例（持久化关闭）：写 false、查 null', () => {
    const db = new UsageDb('', 30, log);
    expect(db.insertAccount({ name: 'a', kind: 'unknown', keysEnc: '[]' })).toBe(false);
    expect(db.listAccounts()).toBeNull();
    expect(db.getAccount(1)).toBeNull();
    expect(db.updateAccount(1, { name: 'x' })).toBe(false);
    expect(db.deleteAccount(1)).toBe(false);
  });

  it('prune 只删请求/事件日志，不碰 accounts（配置不是日志）', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 1, log); // 保留 1 天
    const inserted = db.insertAccount({ name: 'env', kind: 'unknown', keysEnc: '[]' });
    if (inserted === false) throw new Error('insert failed');
    const id = inserted;
    const now = 10 * 86_400_000;
    db.recordRequest(row({ at: now - 5 * 86_400_000 })); // 5 天前，该删

    db.pruneNow(now);
    expect(db.history()!.totalRequests).toBe(0);
    expect(db.getAccount(id)).not.toBeNull(); // 账户还在
    db.close();
  });

  it('跨实例持久化：账户数据重开同一文件还在', () => {
    const p = path.join(tmpDir, 'usage.db');
    const db1 = new UsageDb(p, 30, log);
    const inserted = db1.insertAccount({ name: 'env', kind: 'unknown', keysEnc: '[enc]' });
    if (inserted === false) throw new Error('insert failed');
    const id = inserted;
    db1.close();

    const db2 = new UsageDb(p, 30, log);
    const row = db2.getAccount(id)!;
    expect(row.name).toBe('env');
    expect(row.keysEnc).toBe('[enc]');
    db2.close();
  });
});

describe('UsageDb oauth_refresh_enc 列（OAuth device flow 落库）', () => {
  it('新库：建表即带 oauth_refresh_enc，roundtrip 读写', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    const id = db.insertAccount({ name: 'a', kind: 'unknown', keysEnc: '[]' });
    if (id === false) throw new Error('insert failed');
    // 默认 null（可空列）
    expect(db.getAccount(id)!.oauthRefreshEnc).toBeNull();
    expect(db.updateAccount(id, { oauthRefreshEnc: '1:enc' })).toBe(true);
    expect(db.getAccount(id)!.oauthRefreshEnc).toBe('1:enc');
    expect(db.updateAccount(id, { oauthRefreshEnc: null })).toBe(true); // null = 置空
    expect(db.getAccount(id)!.oauthRefreshEnc).toBeNull();
    // 不存在的 id 更新 → false
    expect(db.updateAccount(9999, { oauthRefreshEnc: '1:x' })).toBe(false);
    db.close();
  });

  it('旧库迁移：无该列的 accounts 表打开即 ALTER，补列后读写正常', () => {
    const p = path.join(tmpDir, 'legacy.db');
    // 手工建一张早期版本的表（没有 oauth_refresh_enc），模拟线上已存在的旧库。
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => any;
    };
    const raw = new DatabaseSync(p);
    raw.exec(`CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'account',
      kind TEXT NOT NULL DEFAULT 'unknown',
      workspace_id TEXT,
      keys_enc TEXT NOT NULL DEFAULT '[]',
      cookie_enc TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      status_detail TEXT,
      retry_until INTEGER NOT NULL DEFAULT 0,
      last_probe_at INTEGER NOT NULL DEFAULT 0,
      last_billing_at INTEGER NOT NULL DEFAULT 0,
      balance_units INTEGER,
      monthly_limit_units INTEGER,
      monthly_usage_units INTEGER,
      created_at INTEGER NOT NULL
    );`);
    raw.close();

    const db = new UsageDb(p, 30, log);
    expect(db.enabled).toBe(true);
    const id = db.insertAccount({ name: 'a', kind: 'unknown', keysEnc: '[]' });
    if (id === false) throw new Error('insert failed');
    expect(db.updateAccount(id, { oauthRefreshEnc: '1:legacy-enc' })).toBe(true);
    expect(db.getAccount(id)!.oauthRefreshEnc).toBe('1:legacy-enc');
    db.close();

    // 幂等：再开一次（migrate 重复跑）不炸，列还在、数据还在。
    const db2 = new UsageDb(p, 30, log);
    expect(db2.getAccount(id)!.oauthRefreshEnc).toBe('1:legacy-enc');
    db2.close();
  });
});

describe('UsageDb legacy_workspace_id 列（旧版控制台通道）', () => {
  it('新库：建表即带 legacy_workspace_id，roundtrip 读写', () => {
    const db = new UsageDb(path.join(tmpDir, 'legacy-ws.db'), 30, log);
    const id = db.insertAccount({ name: 'a', kind: 'unknown', keysEnc: '[]' });
    if (id === false) throw new Error('insert failed');
    // 默认 null（可空列）
    expect(db.getAccount(id)!.legacyWorkspaceId).toBeNull();
    expect(db.updateAccount(id, { legacyWorkspaceId: 'wrk_01KZEQCBJ59Y3T34CSJNRVQJV7' })).toBe(true);
    expect(db.getAccount(id)!.legacyWorkspaceId).toBe('wrk_01KZEQCBJ59Y3T34CSJNRVQJV7');
    expect(db.updateAccount(id, { legacyWorkspaceId: null })).toBe(true); // null = 置空
    expect(db.getAccount(id)!.legacyWorkspaceId).toBeNull();
    // 与 workspace_id 互不干扰
    expect(db.updateAccount(id, { workspaceId: 'org_01KZPQ6GSTS0H24ARVQCD8ZNBM' })).toBe(true);
    expect(db.getAccount(id)!.workspaceId).toBe('org_01KZPQ6GSTS0H24ARVQCD8ZNBM');
    expect(db.getAccount(id)!.legacyWorkspaceId).toBeNull();
    // 不存在的 id 更新 → false
    expect(db.updateAccount(9999, { legacyWorkspaceId: 'wrk_x' })).toBe(false);
    db.close();
  });

  it('旧库迁移：无该列的 accounts 表打开即 ALTER，补列后读写正常（幂等）', () => {
    const p = path.join(tmpDir, 'legacy-ws-old.db');
    // 手工建一张早期版本的表（没有 legacy_workspace_id），模拟线上已存在的旧库。
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => any;
    };
    const raw = new DatabaseSync(p);
    raw.exec(`CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'account',
      kind TEXT NOT NULL DEFAULT 'unknown',
      workspace_id TEXT,
      keys_enc TEXT NOT NULL DEFAULT '[]',
      cookie_enc TEXT,
      oauth_refresh_enc TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      status_detail TEXT,
      retry_until INTEGER NOT NULL DEFAULT 0,
      last_probe_at INTEGER NOT NULL DEFAULT 0,
      last_billing_at INTEGER NOT NULL DEFAULT 0,
      balance_units INTEGER,
      monthly_limit_units INTEGER,
      monthly_usage_units INTEGER,
      created_at INTEGER NOT NULL
    );`);
    raw.close();

    const db = new UsageDb(p, 30, log);
    expect(db.enabled).toBe(true);
    const id = db.insertAccount({ name: 'a', kind: 'unknown', keysEnc: '[]' });
    if (id === false) throw new Error('insert failed');
    expect(db.updateAccount(id, { legacyWorkspaceId: 'wrk_01KZEQCBJ59Y3T34CSJNRVQJV7' })).toBe(true);
    expect(db.getAccount(id)!.legacyWorkspaceId).toBe('wrk_01KZEQCBJ59Y3T34CSJNRVQJV7');
    db.close();

    // 幂等：再开一次（migrate 重复跑）不炸，列还在、数据还在。
    const db2 = new UsageDb(p, 30, log);
    expect(db2.getAccount(id)!.legacyWorkspaceId).toBe('wrk_01KZEQCBJ59Y3T34CSJNRVQJV7');
    db2.close();
  });
});

describe('UsageDb legacy_key_enc 列（旧版 Default API Key，zen usage 通道）', () => {
  it('新库：建表即带 legacy_key_enc，roundtrip 读写（null 清除 + 互不干扰）', () => {
    const db = new UsageDb(path.join(tmpDir, 'lk.db'), 30, log);
    const id = db.insertAccount({ name: 'a', kind: 'unknown', keysEnc: '[]' });
    if (id === false) throw new Error('insert failed');
    expect(db.getAccount(id)!.legacyKeyEnc).toBeNull();
    expect(db.updateAccount(id, { legacyKeyEnc: '1:enc-legacy-key' })).toBe(true);
    expect(db.getAccount(id)!.legacyKeyEnc).toBe('1:enc-legacy-key');
    expect(db.updateAccount(id, { legacyKeyEnc: null })).toBe(true); // null = 置空
    expect(db.getAccount(id)!.legacyKeyEnc).toBeNull();
    // 与 legacy_cookie_enc 互不干扰
    expect(db.updateAccount(id, { legacyCookieEnc: '1:enc-cookie' })).toBe(true);
    expect(db.getAccount(id)!.legacyCookieEnc).toBe('1:enc-cookie');
    expect(db.getAccount(id)!.legacyKeyEnc).toBeNull();
    expect(db.updateAccount(9999, { legacyKeyEnc: '1:x' })).toBe(false);
    db.close();
  });

  it('旧库迁移：无该列的 accounts 表打开即 ALTER，补列后读写正常（幂等）', () => {
    const p = path.join(tmpDir, 'lk-old.db');
    // 手工建一张早期版本的表（没有 legacy_key_enc），模拟线上已存在的旧库。
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => any;
    };
    const raw = new DatabaseSync(p);
    raw.exec(`CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'account',
      kind TEXT NOT NULL DEFAULT 'unknown',
      workspace_id TEXT,
      legacy_workspace_id TEXT,
      legacy_cookie_enc TEXT,
      keys_enc TEXT NOT NULL DEFAULT '[]',
      cookie_enc TEXT,
      oauth_refresh_enc TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      status_detail TEXT,
      retry_until INTEGER NOT NULL DEFAULT 0,
      last_probe_at INTEGER NOT NULL DEFAULT 0,
      last_billing_at INTEGER NOT NULL DEFAULT 0,
      balance_units INTEGER,
      monthly_limit_units INTEGER,
      monthly_usage_units INTEGER,
      created_at INTEGER NOT NULL
    );`);
    raw.close();

    const db = new UsageDb(p, 30, log);
    expect(db.enabled).toBe(true);
    const id = db.insertAccount({ name: 'a', kind: 'unknown', keysEnc: '[]' });
    if (id === false) throw new Error('insert failed');
    expect(db.updateAccount(id, { legacyKeyEnc: '1:legacy-key-enc' })).toBe(true);
    expect(db.getAccount(id)!.legacyKeyEnc).toBe('1:legacy-key-enc');
    db.close();

    // 幂等：再开一次（migrate 重复跑）不炸，列还在、数据还在。
    const db2 = new UsageDb(p, 30, log);
    expect(db2.getAccount(id)!.legacyKeyEnc).toBe('1:legacy-key-enc');
    db2.close();
  });
});

describe('UsageDb allowed_models 列（账号级模型白名单）', () => {
  it('新库：建表即带 allowed_models，roundtrip 读写', () => {
    const db = new UsageDb(path.join(tmpDir, 'am.db'), 30, log);
    const id = db.insertAccount({ name: 'a', kind: 'unknown', keysEnc: '[]' });
    if (id === false) throw new Error('insert failed');
    // 默认 null（未配置 = 用全局白名单）。
    expect(db.getAccount(id)!.allowedModels).toBeNull();
    expect(db.updateAccount(id, { allowedModels: ['deepseek-v4-flash', 'deepseek-v4-flash-free'] })).toBe(true);
    expect(db.getAccount(id)!.allowedModels).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash-free']);
    // null = 清除回全局。
    expect(db.updateAccount(id, { allowedModels: null })).toBe(true);
    expect(db.getAccount(id)!.allowedModels).toBeNull();
    // 不存在的 id 更新 → false。
    expect(db.updateAccount(9999, { allowedModels: ['x'] })).toBe(false);
    db.close();
  });

  it('insertAccount 带 allowedModels 直接落库', () => {
    const db = new UsageDb(path.join(tmpDir, 'am-insert.db'), 30, log);
    const id = db.insertAccount({ name: 'a', kind: 'unknown', keysEnc: '[]', allowedModels: ['deepseek-v4-flash'] });
    if (id === false) throw new Error('insert failed');
    expect(db.getAccount(id)!.allowedModels).toEqual(['deepseek-v4-flash']);
    db.close();
  });

  it('坏数据容错：非 JSON / 空数组 → null（= 不限制，不拖垮账户读取）', () => {
    const db = new UsageDb(path.join(tmpDir, 'am-bad.db'), 30, log);
    const id = db.insertAccount({ name: 'a', kind: 'unknown', keysEnc: '[]' });
    if (id === false) throw new Error('insert failed');
    const sqlite = db.sqlite();
    sqlite.prepare('UPDATE accounts SET allowed_models = ? WHERE id = ?').run('not-json{{', id);
    expect(db.getAccount(id)!.allowedModels).toBeNull();
    expect(db.getAccount(id)!.name).toBe('a'); // 其他字段不受影响
    sqlite.prepare('UPDATE accounts SET allowed_models = ? WHERE id = ?').run('[]', id);
    expect(db.getAccount(id)!.allowedModels).toBeNull();
    db.close();
  });

  it('旧库迁移：无该列的 accounts 表打开即 ALTER，补列后读写正常（幂等）', () => {
    const p = path.join(tmpDir, 'am-old.db');
    // 手工建一张早期版本的表（没有 allowed_models），模拟线上已存在的旧库。
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => any;
    };
    const raw = new DatabaseSync(p);
    raw.exec(`CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'account',
      kind TEXT NOT NULL DEFAULT 'unknown',
      workspace_id TEXT,
      keys_enc TEXT NOT NULL DEFAULT '[]',
      cookie_enc TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      status_detail TEXT,
      retry_until INTEGER NOT NULL DEFAULT 0,
      last_probe_at INTEGER NOT NULL DEFAULT 0,
      last_billing_at INTEGER NOT NULL DEFAULT 0,
      balance_units INTEGER,
      monthly_limit_units INTEGER,
      monthly_usage_units INTEGER,
      created_at INTEGER NOT NULL
    );`);
    raw.close();

    const db = new UsageDb(p, 30, log);
    expect(db.enabled).toBe(true);
    const id = db.insertAccount({ name: 'a', kind: 'unknown', keysEnc: '[]' });
    if (id === false) throw new Error('insert failed');
    expect(db.updateAccount(id, { allowedModels: ['deepseek-v4-flash'] })).toBe(true);
    expect(db.getAccount(id)!.allowedModels).toEqual(['deepseek-v4-flash']);
    db.close();

    // 幂等：再开一次（migrate 重复跑）不炸，列还在、数据还在。
    const db2 = new UsageDb(p, 30, log);
    expect(db2.getAccount(id)!.allowedModels).toEqual(['deepseek-v4-flash']);
    db2.close();
  });
});

describe('ESM 兼容（回归测试）', () => {
  /**
   * 这里防的是一个真实事故：原实现在构造函数里写了裸 `require('node:module')`。
   * vitest 的转换层给了 `require`，所以**单测全绿**；但编译产物是 ESM
   * （package.json "type": "module"），生产启动时抛 "require is not defined"，
   * 被降级逻辑吞掉 → 持久化静默失效，面板永远没有累计数据。
   *
   * 断言编译前的源码里没有裸 require，比断言运行行为可靠 ——
   * 因为在 vitest 里运行时它「能跑」，正是这一点让 bug 藏了下来。
   */
  it('源码不含裸 require（ESM 产物里不存在这个全局）', () => {
    const src = fs.readFileSync(new URL('../src/usagedb.ts', import.meta.url), 'utf8');
    // 先剥注释：上面那段解释性注释里就写着 require(，扫原文会自己撞自己。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const bare = code.match(/(^|[^.\w])require\s*\(/g) ?? [];
    expect(bare).toEqual([]);
    // 正确做法是 createRequire(import.meta.url)。
    expect(src).toContain('createRequire(import.meta.url)');
  });
});

describe('defaultDbPath', () => {
  it('落在代码目录旁的 data/ 下 —— 刻意不在 dist/ 里', () => {
    // deploy.sh 每次 `mv dist dist.prev; mv dist.new dist`，
    // db 放 dist 内会随部署被换走/被回滚带走。
    const p = defaultDbPath('/root/fuckopencode');
    expect(p).toBe(path.join('/root/fuckopencode', 'data', 'usage.db'));
    expect(p).not.toContain('/dist/');
  });
});

describe('UsageDb WAL 持久性加固（tokens 丢数据回归）', () => {
  it('写入 → 显式 checkpoint → 重开同一文件 → 数据还在（requests + tokens）', () => {
    const p = path.join(tmpDir, 'wal-harden.db');
    const db = new UsageDb(p, 30, log);
    db.recordRequest(row({ at: 1000, keyFingerprint: '****0osU' }));
    // tokens 是曾丢数据的表：用 sqlite() 直连句柄写入（与 tokens.ts 同路径）。
    db.sqlite()!
      .prepare(`INSERT INTO tokens (name, token_enc, fingerprint, status, note, prefix, created_at)
                VALUES ('t1', NULL, 'fp-harden-1', 'active', NULL, 'tk', 1000)`)
      .run();
    // 模拟「异常终止前唯一的机会就是下一次写入时惰性触发的显式 checkpoint」：
    // 把内部计时拨回过去（0 恒早于任何 now），下一次批量 flush 即触发 TRUNCATE。
    (db as unknown as { nextCheckpointAt: number }).nextCheckpointAt = 0;
    db.recordRequest(row({ at: 2000, keyFingerprint: '****ZOBb' }));
    // 批量写入是异步的：checkpoint 跟着 flush 走，先把这批落库 + 折叠 WAL。
    db.flush();

    // TRUNCATE 后 WAL 被折回主库，文件应基本为空（缺失按 0 处理）。
    const walSize = fs.existsSync(p + '-wal') ? fs.statSync(p + '-wal').size : 0;
    expect(walSize).toBeLessThan(4096);

    db.close();
    const db2 = new UsageDb(p, 30, log);
    expect(db2.history()!.totalRequests).toBe(2);
    const tok = db2.sqlite()!.prepare('SELECT name FROM tokens WHERE fingerprint = ?').get('fp-harden-1') as
      | { name: string }
      | undefined;
    expect(tok?.name).toBe('t1');
    db2.close();
  });

  it('checkpoint 按间隔惰性触发，不是每条写入都跑（cadence）', () => {
    const p = path.join(tmpDir, 'wal-cadence.db');
    const db = new UsageDb(p, 30, log);
    // 先手动 PASSIVE 把建表/迁移留下的帧折掉，WAL 归零。
    db.sqlite()!.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    // nextCheckpointAt 默认是 Date.now()+60s，这条写入（at=1000）不该触发
    // 我们的显式 checkpoint —— 于是手动 PASSIVE 还能查到刚写进去的帧。
    db.recordRequest(row({ at: 1000 }));
    const after = db.sqlite()!.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as {
      checkpointed: number;
    };
    expect(after.checkpointed).toBeGreaterThan(0);
    db.close();
  });

  it('同步级别可用 USAGE_DB_SYNCHRONOUS 覆盖（默认 NORMAL，FULL 可升）', () => {
    const p = path.join(tmpDir, 'wal-sync.db');
    process.env.USAGE_DB_SYNCHRONOUS = 'FULL';
    try {
      const db = new UsageDb(p, 30, log);
      db.recordRequest(row({ at: 1000 }));
      const s = db.sqlite()!.prepare('PRAGMA synchronous').get() as { synchronous: number };
      expect(s.synchronous).toBe(2); // SQLite 的 FULL = 2
      db.close();
    } finally {
      delete process.env.USAGE_DB_SYNCHRONOUS;
    }
    // 默认（无 env）仍是 NORMAL = 1，行为不变。
    const db2 = new UsageDb(p, 30, log);
    const s2 = db2.sqlite()!.prepare('PRAGMA synchronous').get() as { synchronous: number };
    expect(s2.synchronous).toBe(1);
    db2.close();
  });
});

describe('listRequests 详细请求分页', () => {
  it('按 at 倒序分页，total 为总条数，client 写时从 ua 解析', () => {
    const db = new UsageDb(path.join(tmpDir, 'detail.db'), 30, log);
    for (let i = 1; i <= 5; i++) {
      db.recordRequest(row({
        at: 1000 + i,
        keyFingerprint: `****fp${i}`,
        model: 'claude-mythos-5',
        path: '/v1/messages',
        ua: i % 2 === 0 ? 'cursor/0.42.3 Chrome/124' : 'claude-cli/1.0.27',
        status: 200,
        durationMs: i * 10,
        inputTokens: i,
        outputTokens: i * 2,
        error: null,
      }));
    }
    const page = db.listRequests(1, 2)!;
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
    // 最新在前：at 1005 → 1004。
    expect(page.items.map((r) => r.at)).toEqual([1005, 1004]);
    expect(page.items[0]).toMatchObject({
      status: 200,
      path: '/v1/messages',
      durationMs: 50,
      inputTokens: 5,
      outputTokens: 10,
      model: 'claude-mythos-5',
      fingerprint: '****fp5',
      endpoint: 'subscription',
      error: null,
    });
    // client 是写库时解析好的（奇数条 ua 是 claude-cli，偶数条是 cursor）。
    expect(page.items[0]!.client).toBe('Claude Code');
    expect(page.items[1]!.client).toBe('Cursor');
    // 第二页剩下 3 条。
    const page2 = db.listRequests(2, 2)!;
    expect(page2.items.map((r) => r.at)).toEqual([1003, 1002]);
    // 超出范围的页返回空 items，total 不变。
    const page3 = db.listRequests(99, 2)!;
    expect(page3.items).toEqual([]);
    expect(page3.total).toBe(5);
    db.close();
  });

  it('排除探活（endpoint=probe），total 同口径', () => {
    const db = new UsageDb(path.join(tmpDir, 'detail-probe.db'), 30, log);
    db.recordRequest(row({ at: 1000, path: '/v1/messages', ua: 'claude-cli/1.0.27' }));
    db.recordRequest(row({ at: 2000, path: '/v1/messages', ua: 'claude-cli/1.0.27' }));
    db.recordRequest(row({ at: 3000, endpoint: 'probe', path: '/v1/chat/completions', ua: '' }));
    const page = db.listRequests(1, 20)!;
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.items.every((r) => r.endpoint !== 'probe')).toBe(true);
    db.close();
  });

  it('error 列纳入搜索（q 命中 error 文案，如 rate-limited/额度耗尽）', () => {
    const db = new UsageDb(path.join(tmpDir, 'detail-err-search.db'), 30, log);
    db.recordRequest(row({ at: 1000, error: 'upstream 429 rate_limit_error: Weekly usage limit reached' }));
    db.recordRequest(row({ at: 2000, error: 'upstream 500 overloaded' }));
    db.recordRequest(row({ at: 3000, error: null }));
    const hit = db.listRequests(1, 20, 'Weekly usage')!;
    expect(hit.total).toBe(1);
    expect(hit.items[0]!.error).toContain('Weekly usage limit reached');
    const miss = db.listRequests(1, 20, 'no-such-string')!;
    expect(miss.total).toBe(0);
    db.close();
  });

  it('count_tokens 记账请求默认被 important 过滤、filter=all 时可见（endpoint 标记区分）', () => {
    const db = new UsageDb(path.join(tmpDir, 'detail-count.db'), 30, log);
    db.recordRequest(row({ at: 1000, endpoint: 'count_tokens', path: '/v1/messages/count_tokens', inputTokens: 4321 }));
    db.recordRequest(row({ at: 2000, path: '/v1/messages', ua: 'claude-cli/1.0.27' }));
    // 默认 important 过滤：count_tokens 被排除，只剩真实请求
    const page = db.listRequests(1, 20)!;
    expect(page.total).toBe(1);
    expect(page.items[0]!.endpoint).not.toBe('count_tokens');
    // filter=all 保留 count_tokens（endpoint 标记区分）
    const all = db.listRequests(1, 20, undefined, 'all')!;
    expect(all.total).toBe(2);
    expect(all.items.some((r) => r.endpoint === 'count_tokens' && r.inputTokens === 4321)).toBe(true);
    db.close();
  });

  it('ua 为空时 client 落 unknown，ua 落 null，不抛', () => {
    const db = new UsageDb(path.join(tmpDir, 'detail-ua.db'), 30, log);
    db.recordRequest(row({ at: 1000, ua: '' }));
    const page = db.listRequests(1, 20)!;
    expect(page.items[0]!.client).toBe('unknown');
    // 空串按 null 存（与 error 列口径一致：null = 没有）。
    expect(page.items[0]!.ua).toBeNull();
    db.close();
  });

  it('db 不可用时返回 null', () => {
    const db = new UsageDb('', 30, log);
    expect(db.listRequests(1, 20)).toBeNull();
  });

  it('旧库迁移：requests 表缺 path/ua/client 列 → 打开即补列，旧数据三列 null，写入后正常', () => {
    const p = path.join(tmpDir, 'detail-legacy.db');
    // 手工建早期版本的表（无 path/ua/client），模拟线上已存在的旧库。
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => any;
    };
    const raw = new DatabaseSync(p);
    raw.exec(`CREATE TABLE requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      key_fp TEXT NOT NULL,
      model TEXT, upstream_model TEXT, endpoint TEXT,
      status INTEGER, duration_ms INTEGER, stream INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, thinking_tokens INTEGER,
      error TEXT
    );`);
    raw.prepare(
      `INSERT INTO requests (at, key_fp, model, endpoint, status, duration_ms)
       VALUES (1, '****old', 'deepseek-v4-flash', 'subscription', 200, 5)`,
    ).run();
    raw.close();

    const db = new UsageDb(p, 30, log);
    expect(db.enabled).toBe(true);
    // 旧数据三列 null（查得到，不炸）。
    const page = db.listRequests(1, 20, undefined, 'all')!;
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ path: null, ua: null, client: null });
    // 补列后写入正常（新数据带 path/ua/client）。
    db.recordRequest(row({ at: 2000, path: '/v1/messages', ua: 'cursor/0.42' }));
    const page2 = db.listRequests(1, 20, undefined, 'all')!;
    expect(page2.items[0]).toMatchObject({ path: '/v1/messages', ua: 'cursor/0.42', client: 'Cursor' });
    db.close();

    // 幂等：再开一次（migrate/补列重复跑）不炸。
    const db2 = new UsageDb(p, 30, log);
    expect(db2.listRequests(1, 20, undefined, 'all')!.total).toBe(2);
    db2.close();
  });
});

describe('listRequests 关键词搜索（q）', () => {
  function seed(db: UsageDb): void {
    db.recordRequest(row({ at: 1000, path: '/v1/messages', ua: 'claude-cli/1.0.27', model: 'claude-mythos-5', status: 200, ip: '1.2.3.4' }));
    db.recordRequest(row({ at: 2000, path: '/v1/chat/completions', ua: 'cursor/0.42.3 Chrome/124', model: 'deepseek-v4-flash', status: 429 }));
    db.recordRequest(row({ at: 3000, path: '/v1/messages', ua: 'KiroIDE-1.0.0-abc', model: 'claude-fable-5', status: 200, ip: '5.6.7.8' }));
  }

  it('q 匹配 path/client/ua/model，不区分大小写', () => {
    const db = new UsageDb(path.join(tmpDir, 'q1.db'), 30, log);
    seed(db);
    // path 包含（大小写不敏感）。
    const p1 = db.listRequests(1, 20, 'CHAT')!;
    expect(p1.total).toBe(1);
    expect(p1.items[0]!.path).toBe('/v1/chat/completions');
    // client 列（写库时从 ua 解析）。
    const p2 = db.listRequests(1, 20, 'cursor')!;
    expect(p2.total).toBe(1);
    expect(p2.items[0]!.client).toBe('Cursor');
    // ua 原文。
    const p3 = db.listRequests(1, 20, 'KIROIDE')!;
    expect(p3.total).toBe(1);
    expect(p3.items[0]!.ua).toBe('KiroIDE-1.0.0-abc');
    // model。
    const p4 = db.listRequests(1, 20, 'fable')!;
    expect(p4.total).toBe(1);
    db.close();
  });

  it('q 匹配 status 数字（CAST 成文本包含）', () => {
    const db = new UsageDb(path.join(tmpDir, 'q2.db'), 30, log);
    seed(db);
    const p = db.listRequests(1, 20, '429')!;
    expect(p.total).toBe(1);
    expect(p.items[0]!.status).toBe(429);
    db.close();
  });

  it('通配符转义：%/_ 当字面量，不做 LIKE 模式', () => {
    const db = new UsageDb(path.join(tmpDir, 'q3.db'), 30, log);
    db.recordRequest(row({ at: 1000, path: '/v1/messages', ua: 'claude-cli/1.0.27' }));
    // % 若不当转义会匹配任意串，total 会是 1；转义后匹配不到 → 0。
    expect(db.listRequests(1, 20, '%')!.total).toBe(0);
    expect(db.listRequests(1, 20, '_')!.total).toBe(0);
    expect(db.listRequests(1, 20, '\\')!.total).toBe(0);
    // 正常关键词仍命中。
    expect(db.listRequests(1, 20, 'messages')!.total).toBe(1);
    db.close();
  });

  it('通配符转义正向：数据里含 %/_/\\ 时按字面量搜得到', () => {
    const db = new UsageDb(path.join(tmpDir, 'q3b.db'), 30, log);
    db.recordRequest(row({ at: 1000, path: '/v1/messages', ua: 'weird%ua/1.0' }));
    db.recordRequest(row({ at: 2000, path: '/v1/messages', ua: 'under_score/1.0' }));
    db.recordRequest(row({ at: 3000, path: '/v1/messages', ua: 'back\\slash/1.0' }));
    // 字面 %：不转义的话 'weird%ua' 会因 % 通配而误命中 under_score 那条。
    expect(db.listRequests(1, 20, 'weird%ua')!.total).toBe(1);
    expect(db.listRequests(1, 20, 'under_score')!.total).toBe(1);
    expect(db.listRequests(1, 20, 'back\\slash')!.total).toBe(1);
    db.close();
  });

  it('q 匹配 ip 字段（面板「点 IP → 过滤明细」契约：q=<ip>）', () => {
    const db = new UsageDb(path.join(tmpDir, 'q-ip.db'), 30, log);
    db.recordRequest(row({ at: 1000, ip: '203.0.113.7', ua: 'claude-cli/1.0.27' }));
    db.recordRequest(row({ at: 2000, ip: '198.51.100.9', ua: 'claude-cli/1.0.27' }));
    expect(db.listRequests(1, 20, '113.7')!.total).toBe(1);
    expect(db.listRequests(1, 20, '203.0.113.7')!.items[0]!.ip).toBe('203.0.113.7');
    db.close();
  });

  it('q 为空/纯空白等价于不过滤', () => {
    const db = new UsageDb(path.join(tmpDir, 'q4.db'), 30, log);
    seed(db);
    const base = db.listRequests(1, 20)!;
    for (const q of [undefined, '', '   ']) {
      const p = db.listRequests(1, 20, q)!;
      expect(p.total).toBe(base.total);
      expect(p.items).toHaveLength(base.items.length);
    }
    db.close();
  });

  it('q 与排除探活叠加', () => {
    const db = new UsageDb(path.join(tmpDir, 'q5.db'), 30, log);
    seed(db);
    db.recordRequest(row({ at: 4000, endpoint: 'probe', path: '/v1/chat/completions', ua: '', model: 'deepseek-v4-flash' }));
    // probe 的 path 含 chat/completions，但不该被搜出来。
    const p = db.listRequests(1, 20, 'chat')!;
    expect(p.total).toBe(1);
    db.close();
  });
});

describe('statsByIp 按 IP 聚合', () => {
  it('聚合 requests/inputTokens/outputTokens/clients/lastAt，按 requests 倒序', () => {
    const db = new UsageDb(path.join(tmpDir, 'ip1.db'), 30, log);
    const now = Date.now();
    db.recordRequest(row({ at: now - 3000, ip: '1.2.3.4', ua: 'claude-cli/1.0.27', inputTokens: 10, outputTokens: 20 }));
    db.recordRequest(row({ at: now - 2000, ip: '1.2.3.4', ua: 'claude-cli/1.0.27', inputTokens: 30, outputTokens: 40 }));
    db.recordRequest(row({ at: now - 1000, ip: '1.2.3.4', ua: 'cursor/0.42', inputTokens: 5, outputTokens: 5 }));
    db.recordRequest(row({ at: now, ip: '5.6.7.8', ua: 'opencode/0.1.0', inputTokens: 1, outputTokens: 1 }));
    const page = db.statsByIp(1, 20)!;
    expect(page.total).toBe(2);
    // 1.2.3.4 有 3 条排第一；clients 去重保序；lastAt 取最大值。
    expect(page.items[0]).toMatchObject({ ip: '1.2.3.4', requests: 3, inputTokens: 45, outputTokens: 65, lastAt: now - 1000 });
    expect(page.items[0]!.clients).toEqual(['Claude Code', 'Cursor']);
    expect(page.items[1]).toMatchObject({ ip: '5.6.7.8', requests: 1, inputTokens: 1, outputTokens: 1, lastAt: now });
    db.close();
  });

  it('排除未落 ip（旧数据 null/空串）与探活', () => {
    const db = new UsageDb(path.join(tmpDir, 'ip2.db'), 30, log);
    const now = Date.now();
    db.recordRequest(row({ at: now - 4000, ip: null, ua: 'claude-cli/1.0.27' }));
    db.recordRequest(row({ at: now - 3000, ip: '', ua: 'claude-cli/1.0.27' }));
    db.recordRequest(row({ at: now - 2000, ip: '1.2.3.4', ua: 'claude-cli/1.0.27' }));
    db.recordRequest(row({ at: now - 1000, ip: '1.2.3.4', endpoint: 'probe', ua: '' }));
    const page = db.statsByIp(1, 20)!;
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ ip: '1.2.3.4', requests: 1 });
    db.close();
  });

  it('分页与 db 不可用', () => {
    const db = new UsageDb(path.join(tmpDir, 'ip3.db'), 30, log);
    const now = Date.now();
    for (let i = 1; i <= 3; i++) {
      db.recordRequest(row({ at: now - 100 + i, ip: `10.0.0.${i}`, ua: 'claude-cli/1.0.27' }));
    }
    const p2 = db.statsByIp(2, 2)!;
    expect(p2.items).toHaveLength(1);
    expect(p2.total).toBe(3);
    expect(p2.items[0]!.ip).toBe('10.0.0.3');
    const off = new UsageDb('', 30, log);
    expect(off.statsByIp(1, 20)).toBeNull();
    db.close();
  });

  it('聚合结果缓存（10s TTL）：缓存期内新写入不可见，过期后可见', () => {
    const db = new UsageDb(path.join(tmpDir, 'ip-cache.db'), 30, log);
    const now = Date.now();
    db.recordRequest(row({ at: now - 2000, ip: '1.2.3.4', ua: 'claude-cli/1.0.27' }));
    const first = db.statsByIp(1, 20)!;
    expect(first.total).toBe(1);
    // 缓存期内写入：聚合结果不变（面板 2s 轮询不再每轮全表扫）。
    db.recordRequest(row({ at: now - 1000, ip: '5.6.7.8', ua: 'claude-cli/1.0.27' }));
    expect(db.statsByIp(1, 20)!.total).toBe(1);
    // 缓存过期后重新聚合（直接改内部缓存时间戳模拟 10s 流逝）。
    (db as unknown as { ipStatsCacheAt: number }).ipStatsCacheAt -= 11_000;
    expect(db.statsByIp(1, 20)!.total).toBe(2);
    db.close();
  });
});

describe('usageByKeyFingerprints 网关实际用量归属', () => {
  it('按指纹末 4 位匹配、rangeDays 过滤、排除探活、cost 聚合', () => {
    const db = new UsageDb(path.join(tmpDir, 'fp1.db'), 30, log);
    const now = 1_700_000_000_000;
    db.recordRequest(row({ at: now - 3 * 86_400_000, keyFingerprint: '****0osU', costMicroCents: 100 }));
    db.recordRequest(row({ at: now - 1 * 86_400_000, keyFingerprint: '****0osU', inputTokens: 10, outputTokens: 20, costMicroCents: 250 }));
    db.recordRequest(row({ at: now - 1 * 86_400_000, keyFingerprint: '****ZOBb', costMicroCents: 500 })); // 不属于该 key
    db.recordRequest(row({ at: now - 1 * 86_400_000, keyFingerprint: '****0osU', endpoint: 'probe', costMicroCents: 999 })); // 探活不算
    db.recordRequest(row({ at: now - 30 * 86_400_000, keyFingerprint: '****0osU', costMicroCents: 777 })); // 超出 7 天窗口
    const u = db.usageByKeyFingerprints(['0osU'], now - 7 * 86_400_000);
    // 命中两条 ****0osU：第一条（3 天前）tokens 是 row() 默认 100/500 + cost 100，
    // 第二条（1 天前）10/20 + cost 250；probe 与 30 天前的不算。
    expect(u).toEqual({ requests: 2, inputTokens: 110, outputTokens: 520, costMicroCents: 350 });
    db.close();
  });

  it('空指纹集合 / 短尾（<4 字符）返回全零', () => {
    const db = new UsageDb(path.join(tmpDir, 'fp2.db'), 30, log);
    db.recordRequest(row({ at: 1000, keyFingerprint: '****0osU', costMicroCents: 100 }));
    expect(db.usageByKeyFingerprints([], 0)).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0, costMicroCents: 0 });
    expect(db.usageByKeyFingerprints(['os'], 0)).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0, costMicroCents: 0 });
    db.close();
  });

  it('指纹 LIKE 匹配不串 key：末 4 位必须完全一致', () => {
    const db = new UsageDb(path.join(tmpDir, 'fp3.db'), 30, log);
    db.recordRequest(row({ at: 1000, keyFingerprint: '****0osU' }));
    db.recordRequest(row({ at: 2000, keyFingerprint: '****0osV' }));
    const u = db.usageByKeyFingerprints(['0osU'], 0);
    expect(u.requests).toBe(1);
    db.close();
  });
});

describe('keyUsageAll 全 key 用量聚合（key 详情服务端数据源）', () => {
  const now = 1_700_000_000_000;

  it('按 key_fp 聚合：ok/failed 口径、tokens/cost/lastAt，排除 probe/count_tokens/未归属', () => {
    const db = new UsageDb(path.join(tmpDir, 'ka1.db'), 30, log);
    // ****0osU：3 条（1 ok + 1 failed 429 + 1 count_tokens），cost 只计真实请求。
    db.recordRequest(row({ at: now - 2 * 86_400_000, keyFingerprint: '****0osU', status: 200, inputTokens: 10, outputTokens: 20, costMicroCents: 100 }));
    db.recordRequest(row({ at: now - 1 * 86_400_000, keyFingerprint: '****0osU', status: 429, inputTokens: 0, outputTokens: 0, costMicroCents: 50 }));
    db.recordRequest(row({ at: now - 1 * 86_400_000, keyFingerprint: '****0osU', endpoint: 'count_tokens', status: 200, inputTokens: 5000, costMicroCents: 999 }));
    // ****ZOBb：1 条探活（排除）+ 1 条真实。
    db.recordRequest(row({ at: now - 1 * 86_400_000, keyFingerprint: '****ZOBb', endpoint: 'probe', status: 429, costMicroCents: 777 }));
    db.recordRequest(row({ at: now - 1 * 86_400_000, keyFingerprint: '****ZOBb', status: 200, inputTokens: 5, outputTokens: 5, costMicroCents: 300 }));
    // 未归属（key_fp '-'）不算成 key。
    db.recordRequest(row({ at: now - 1 * 86_400_000, keyFingerprint: '', status: 401 }));
    // 超窗（30 天前）不算。
    db.recordRequest(row({ at: now - 30 * 86_400_000, keyFingerprint: '****0osU', costMicroCents: 777 }));

    const rows = db.keyUsageAll(7, now)!;
    expect(rows).not.toBeNull();
    const byFp = new Map(rows.map((r) => [r.fingerprint, r]));
    const a = byFp.get('****0osU')!;
    expect(a.requests).toBe(2);
    expect(a.ok).toBe(1);
    expect(a.failed).toBe(1);
    expect(a.inputTokens).toBe(10);
    expect(a.outputTokens).toBe(20);
    expect(a.tokens).toBe(30);
    expect(a.costMicroCents).toBe(150); // count_tokens 的 999 不算
    expect(a.lastAt).toBe(now - 1 * 86_400_000);
    const b = byFp.get('****ZOBb')!;
    expect(b.requests).toBe(1);
    expect(b.ok).toBe(1);
    expect(b.costMicroCents).toBe(300); // probe 的 777 不算
    expect(byFp.size).toBe(2);
    db.close();
  });

  it('rangeDays 窗口过滤：窗口外的指纹不出现', () => {
    const db = new UsageDb(path.join(tmpDir, 'ka2.db'), 30, log);
    db.recordRequest(row({ at: now - 3 * 86_400_000, keyFingerprint: '****oldA', costMicroCents: 1 }));
    db.recordRequest(row({ at: now - 1 * 86_400_000, keyFingerprint: '****newB', costMicroCents: 2 }));
    const rows = db.keyUsageAll(2, now)!;
    const fps = rows.map((r) => r.fingerprint);
    expect(fps).toEqual(['****newB']);
    db.close();
  });

  it('按 rangeDays 分桶缓存 + 命中返回副本（改返回值不污染缓存，I-15 同款）', () => {
    const db = new UsageDb(path.join(tmpDir, 'ka3.db'), 30, log);
    db.recordRequest(row({ at: now, keyFingerprint: '****0osU', costMicroCents: 1 }));
    const first = db.keyUsageAll(7, now)!;
    expect(first[0]!.requests).toBe(1);
    first[0]!.requests = 999;
    // 缓存窗口内（10s）命中缓存，且返回的是副本。
    const second = db.keyUsageAll(7, now + 1000)!;
    expect(second).not.toBe(first);
    expect(second[0]!.requests).toBe(1);
    db.close();
  });

  it('降级（db 不可用）返回 null', () => {
    const off = new UsageDb('', 30, log);
    expect(off.keyUsageAll(7, now)).toBeNull();
    off.close();
  });
});


describe('UsageDb 聚合缓存引用安全（D-P2-4）', () => {
  it('tokenUsageAll 缓存命中返回副本：调用方改 value 不污染缓存', () => {
    const db = new UsageDb(path.join(tmpDir, 'token-cache.db'), 30, log);
    db.recordRequest(row({ at: Date.now() - 1000, tokenFp: 'abc123' }));

    const first = db.tokenUsageAll();
    expect(first.get('abc123')?.requests).toBe(1);
    // 缓存窗口内（10s）第二次调用命中缓存。修复前返回的就是内部缓存 Map 本体，
    // 改动 value 会污染缓存，后续所有读取（含历史数据）都变 999。
    first.get('abc123')!.requests = 999;

    const second = db.tokenUsageAll();
    expect(second).not.toBe(first);
    expect(second.get('abc123')?.requests).toBe(1);
    db.close();
  });
});

describe('UsageDb tokenUsageAll 观测流量排除（EXCLUDE_OBSERVED）', () => {
  it('count_tokens 记账与 probe 探活均不计入分发 token 用量（含带 token_fp 的 probe）', () => {
    const db = new UsageDb(path.join(tmpDir, 'token-usage-observed.db'), 30, log);
    // 真实分发 token 请求：应计入。
    db.recordRequest(row({ at: Date.now() - 3000, tokenFp: 'abc123', endpoint: 'subscription' }));
    // count_tokens 记账请求带 token_fp：不应计入（即使现实里 count_tokens 也走
    // verifyAuth、token_fp 可能非 null，聚合口径仍排除）。
    db.recordRequest(row({ at: Date.now() - 2000, tokenFp: 'abc123', endpoint: 'count_tokens', inputTokens: 5000, costMicroCents: 999 }));
    // probe 探活请求带 token_fp：显式排除的防御场景——现实里 probe 不走 verifyAuth、
    // token_fp 恒 null 天然排除，但若未来 probe 路径带上 token_fp，显式 endpoint 排除
    // 保证它不混入 token 用量。
    db.recordRequest(row({ at: Date.now() - 1000, tokenFp: 'probe-fp', endpoint: 'probe', inputTokens: 50, costMicroCents: 777 }));

    const usage = db.tokenUsageAll();
    expect(usage.get('abc123')?.requests).toBe(1);
    expect(usage.get('abc123')?.inputTokens).toBe(100);
    expect(usage.get('abc123')?.costMicroCents).toBe(0);
    expect(usage.get('probe-fp')).toBeUndefined();
    db.close();
  });
});

describe('UsageDb 聚合缓存返回副本（I-15）', () => {
  it('history 缓存命中返回副本：改 byKey/recentKeyEvents 不污染缓存', () => {
    const db = new UsageDb(path.join(tmpDir, 'hist-cache.db'), 30, log);
    db.recordRequest(row({ at: 1000, keyFingerprint: '****0osU' }));
    const first = db.history()!;
    expect(first.byKey[0]!.requests).toBe(1);
    // 缓存窗口内（15s）第二次调用命中缓存。修复前返回内部缓存本体，
    // 改 byKey 元素/往 recentKeyEvents push 会污染缓存，后续读取全变。
    first.byKey[0]!.requests = 999;
    first.recentKeyEvents.push({ at: 1, fingerprint: 'x', type: 'disabled', kind: null, cooldownMs: null });
    const second = db.history()!;
    expect(second).not.toBe(first);
    expect(second.byKey[0]!.requests).toBe(1);
    expect(second.recentKeyEvents).toHaveLength(0);
    db.close();
  });

  it('usageTrend 缓存命中返回副本：改 items/顶层 totals 不污染缓存', () => {
    const db = new UsageDb(path.join(tmpDir, 'trend-cache.db'), 30, log);
    const now = 1_700_000_000_000;
    db.recordRequest(row({ at: now, inputTokens: 10, status: 200 }));
    const t1 = db.usageTrend(1, now)!;
    expect(t1.requests).toBe(1);
    t1.requests = 999;
    t1.items[23]!.requests = 999;
    const t2 = db.usageTrend(1, now + 1)!; // 同一缓存窗口
    expect(t2).not.toBe(t1);
    expect(t2.requests).toBe(1);
    expect(t2.items[23]!.requests).toBe(1);
    db.close();
  });

  it('statsByIp 返回的元素是副本：改 items 元素不污染缓存', () => {
    const db = new UsageDb(path.join(tmpDir, 'ipstat-cache.db'), 30, log);
    db.recordRequest(row({ at: Date.now() - 1000, ip: '1.2.3.4', ua: 'claude-cli/1.0.27' }));
    const p1 = db.statsByIp(1, 20)!;
    expect(p1.items[0]!.requests).toBe(1);
    // 缓存窗口内（10s）第二次调用命中缓存。修复前元素是缓存内同一对象，
    // 改 requests/clients 会污染缓存内所有后续读取。
    p1.items[0]!.requests = 999;
    p1.items[0]!.clients.push('Fake');
    const p2 = db.statsByIp(1, 20)!;
    expect(p2.items[0]!.requests).toBe(1);
    expect(p2.items[0]!.clients).toEqual(['Claude Code']);
    db.close();
  });
});

describe('requests 表 ip / cost_micro_cents 列', () => {
  it('落库与读取：listRequests 返回 ip；cost 累计进 usageByKeyFingerprints', () => {
    const db = new UsageDb(path.join(tmpDir, 'ipcol.db'), 30, log);
    db.recordRequest(row({ at: 1000, ip: '9.9.9.9', costMicroCents: 42, ua: 'claude-cli/1.0.27' }));
    const page = db.listRequests(1, 20)!;
    expect(page.items[0]!.ip).toBe('9.9.9.9');
    const u = db.usageByKeyFingerprints(['0osU'], 0);
    expect(u.costMicroCents).toBe(42);
    db.close();
  });

  it('旧库迁移：缺 ip/cost_micro_cents 列 → 打开即补列，旧数据两列 null', () => {
    const p = path.join(tmpDir, 'ipcol-legacy.db');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => any;
    };
    const raw = new DatabaseSync(p);
    raw.exec(`CREATE TABLE requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL, key_fp TEXT NOT NULL, model TEXT,
      upstream_model TEXT, endpoint TEXT, status INTEGER, duration_ms INTEGER,
      stream INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      thinking_tokens INTEGER, error TEXT, path TEXT, ua TEXT, client TEXT
    );`);
    raw.prepare(`INSERT INTO requests (at, key_fp, endpoint, status) VALUES (1, '****old', 'subscription', 200)`).run();
    raw.close();

    const db = new UsageDb(p, 30, log);
    expect(db.enabled).toBe(true);
    const page = db.listRequests(1, 20, undefined, 'all')!;
    expect(page.items[0]!.ip).toBeNull();
    // 旧数据 cost 为 NULL，聚合按 0 处理。
    expect(db.usageByKeyFingerprints(['old'], 0).costMicroCents).toBe(0);
    // token_fp 列与索引也被补上（分发 token 用量聚合依赖它；旧库迁移回归）。
    const cols = db.sqlite()!.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'token_fp')).toBe(true);
    db.recordRequest(row({ at: Date.now() - 1000, tokenFp: 'abc123' }));
    const usage = db.tokenUsageAll();
    expect(usage.get('abc123')?.requests).toBe(1);
    db.close();
  });
});

describe('requests 表 api_key_fp 列（D-I4）', () => {
  it('新库建表即含 api_key_fp（CREATE TABLE 自带，不依赖补列 ALTER），roundtrip 落库', () => {
    // 修复前：新库 DDL 没有 api_key_fp，靠 ensureRequestsColumns 的 ALTER 补。
    // 若 ALTER 失败，insertRequest 的 prepare 引用不存在的列 → 整库降级 disabled，
    // 与「补列失败只记日志」的承诺不符。修复后：DDL 自带该列，ALTER 只服务旧库。
    const db = new UsageDb(path.join(tmpDir, 'api-key-fp-new.db'), 30, log);
    expect(db.enabled).toBe(true);
    const cols = db.sqlite()!.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'api_key_fp')).toBe(true);
    // roundtrip：api_key_fp 落库可读。
    db.recordRequest(row({ at: 1000, apiKeyFp: 'aabbccddeeff' }));
    db.flush();
    const raw = db.sqlite()!.prepare('SELECT api_key_fp FROM requests LIMIT 1').get() as { api_key_fp: string | null };
    expect(raw.api_key_fp).toBe('aabbccddeeff');
    db.close();
  });

  it('新库补列 ALTER 失败不拖垮整库（DDL 自带列 → 根本不会发 ALTER）', () => {
    // 模拟 node:sqlite 的 exec 在补 api_key_fp 列的 ALTER 上抛错。修复前该 ALTER
    // 一定会发（新库缺列）且失败后 insertRequest prepare 级联失败 → enabled=false。
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string) => any;
    };
    const proto = DatabaseSync.prototype;
    const origExec = proto.exec;
    const spy = vi.spyOn(proto, 'exec').mockImplementation(function (this: any, sql: unknown) {
      if (typeof sql === 'string' && /ALTER TABLE requests ADD COLUMN api_key_fp/.test(sql)) {
        throw new Error('simulated ALTER failure');
      }
      return origExec.call(this, sql);
    });
    try {
      const db = new UsageDb(path.join(tmpDir, 'api-key-fp-ddl.db'), 30, log);
      expect(db.enabled).toBe(true); // 修复前这里会是 false（级联 prepare 失败）
      db.recordRequest(row({ at: 1000, apiKeyFp: 'x' }));
      expect(db.history()!.totalRequests).toBe(1);
      db.close();
    } finally {
      spy.mockRestore();
    }
  });

  it('旧库缺 api_key_fp 列 + ALTER 失败 → 降级 INSERT 不拖垮整库（对抗审查 M-1）', () => {
    // 真实旧库升级路径：requests 表已存在且无 api_key_fp 列（老 schema），
    // ensureRequestsColumns 必须发 ALTER；ALTER 失败（部署重叠 busy）时 insertRequest
    // 的 prepare 引用缺失列本会级联整库 disabled。修复后：每列单独补 + api_key_fp
    // 重试一次 + prepare 回退 18 列降级 INSERT，库照常可用（只丢 api_key_fp 数据）。
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string) => any;
    };
    const legacyPath = path.join(tmpDir, 'api-key-fp-legacy.db');
    // 先建一个不含 api_key_fp 的旧 schema requests 表（其余表由 migrate 自动建）。
    const raw = new DatabaseSync(legacyPath);
    raw.exec(`CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL, key_fp TEXT NOT NULL, model TEXT, upstream_model TEXT,
      endpoint TEXT, status INTEGER, duration_ms INTEGER, stream INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, thinking_tokens INTEGER,
      error TEXT, path TEXT, ua TEXT, client TEXT, ip TEXT, cost_micro_cents INTEGER,
      token_fp TEXT
    )`);
    raw.close();
    const proto = DatabaseSync.prototype;
    const origExec = proto.exec;
    const spy = vi.spyOn(proto, 'exec').mockImplementation(function (this: any, sql: unknown) {
      if (typeof sql === 'string' && /ALTER TABLE requests ADD COLUMN api_key_fp/.test(sql)) {
        throw new Error('simulated ALTER failure');
      }
      return origExec.call(this, sql);
    });
    try {
      const db = new UsageDb(legacyPath, 30, log);
      expect(db.enabled).toBe(true); // 修复前：prepare 级联失败 → false
      db.recordRequest(row({ at: 1000, apiKeyFp: 'x' }));
      db.flush();
      expect(db.history()!.totalRequests).toBe(1);
      db.close();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('UsageDb 真实趋势聚合（usageTrend）', () => {
  const H = 3_600_000;
  const D = 86_400_000;
  /** 整点基准：让窗口边界落在整点上，桶数可精确断言。 */
  const hourStart = Math.floor(1_700_000_000_000 / H) * H;
  const dayStart = Math.floor(1_700_000_000_000 / D) * D;

  it('24h：按小时分桶（连续 24 桶），探活排除，totals = items 求和', () => {
    const db = new UsageDb(path.join(tmpDir, 'trend1.db'), 30, log);
    const now = hourStart + H;
    // 当前小时（最后一桶，at=now 处）、上一小时、窗口首桶各一条。
    db.recordRequest(row({ at: now, inputTokens: 10, outputTokens: 20, costMicroCents: 500, status: 200 }));
    db.recordRequest(row({ at: now - H, inputTokens: 1, outputTokens: 2, costMicroCents: 100, status: 429 }));
    db.recordRequest(row({ at: hourStart - 22 * H, inputTokens: 5, outputTokens: 0, costMicroCents: 50, status: 200 }));
    // 探活与窗口外（24 小时前）不计入。
    db.recordRequest(row({ at: now, endpoint: 'probe', status: 200, inputTokens: 999 }));
    db.recordRequest(row({ at: hourStart - 24 * H, status: 200, inputTokens: 999 }));

    const t = db.usageTrend(1, now)!;
    expect(t).not.toBeNull();
    expect(t.bucket).toBe('hour');
    expect(t.items).toHaveLength(24);
    // 桶起点整点对齐、连续。
    for (let i = 0; i < t.items.length; i++) {
      expect(t.items[i]!.at).toBe(hourStart - 22 * H + i * H);
    }
    expect(t.items[23]).toMatchObject({ at: now, requests: 1, ok: 1, failed: 0, inputTokens: 10, outputTokens: 20, costMicroCents: 500 });
    expect(t.items[22]).toMatchObject({ at: now - H, requests: 1, ok: 0, failed: 1, inputTokens: 1, outputTokens: 2, costMicroCents: 100 });
    expect(t.items[0]).toMatchObject({ at: hourStart - 22 * H, requests: 1, ok: 1, failed: 0, inputTokens: 5, costMicroCents: 50 });
    // 缺桶补 0。
    expect(t.items[10]).toMatchObject({ at: hourStart - 12 * H, requests: 0, ok: 0, failed: 0, costMicroCents: 0 });
    // totals 与 items 求和一致（探活/窗口外不计）。
    expect(t.requests).toBe(3);
    expect(t.ok).toBe(2);
    expect(t.failed).toBe(1);
    expect(t.inputTokens).toBe(16);
    expect(t.outputTokens).toBe(22);
    expect(t.costMicroCents).toBe(650);
    expect(t.since).toBe(hourStart - 22 * H);
    expect(t.until).toBe(hourStart + 2 * H);
    db.close();
  });

  it('7d：按天分桶（连续 7 桶），窗口外排除', () => {
    const db = new UsageDb(path.join(tmpDir, 'trend2.db'), 30, log);
    db.recordRequest(row({ at: dayStart, inputTokens: 10 }));
    db.recordRequest(row({ at: dayStart - 5 * D, inputTokens: 5 }));
    db.recordRequest(row({ at: dayStart - 7 * D, inputTokens: 999 })); // 窗口外

    const t = db.usageTrend(7, dayStart + D)!;
    expect(t.bucket).toBe('day');
    expect(t.items).toHaveLength(7);
    expect(t.items[0]!.at).toBe(dayStart - 5 * D);
    expect(t.items[5]!.at).toBe(dayStart);
    expect(t.items[0]!.requests).toBe(1);
    expect(t.items[5]!.requests).toBe(1);
    // 当前天（含 now 的桶）无数据 → 补 0。
    expect(t.items[6]).toMatchObject({ at: dayStart + D, requests: 0 });
    expect(t.requests).toBe(2);
    expect(t.inputTokens).toBe(15);
    db.close();
  });

  it('空库边界：连续序列全 0，totals 0（不抛）', () => {
    const db = new UsageDb(path.join(tmpDir, 'trend3.db'), 30, log);
    const hour = db.usageTrend(1, hourStart + H)!;
    expect(hour.items).toHaveLength(24);
    expect(hour.items.every((b) => b.requests === 0 && b.ok === 0 && b.failed === 0 && b.costMicroCents === 0)).toBe(true);
    expect(hour.requests).toBe(0);
    const day = db.usageTrend(7, dayStart + D)!;
    expect(day.items).toHaveLength(7);
    expect(day.requests).toBe(0);
    db.close();
  });

  it('10s 缓存：同 rangeDays 短时间内复用结果', () => {
    const db = new UsageDb(path.join(tmpDir, 'trend4.db'), 30, log);
    db.recordRequest(row({ at: hourStart, status: 200 }));
    const t1 = db.usageTrend(1, hourStart + H)!;
    const t2 = db.usageTrend(1, hourStart + H + 1)!; // 同一缓存窗口
    // I-15 修复后返回副本：内容相等但引用不同（原来 `toBe(t1)` 断言内部缓存引用）。
    expect(t2).toEqual(t1);
    expect(t2).not.toBe(t1);
    // 缓存过期后（>10s）重新查询。
    const t3 = db.usageTrend(1, hourStart + H + 11_000)!;
    expect(t3).not.toBeNull();
    expect(t3).not.toBe(t1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// tokens 表配额列（QUOTA.md §1）迁移
// ---------------------------------------------------------------------------

describe('tokens 表配额列（QUOTA.md）', () => {
  it('旧库迁移：无配额列的 tokens 表打开即补列，默认全无限 + 永不过期（幂等）', () => {
    const p = path.join(tmpDir, 'tokens-quota-legacy.db');
    // 手工建早期版本的表（无配额列），模拟线上已存在的旧库。
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => any;
    };
    const raw = new DatabaseSync(p);
    raw.exec(`CREATE TABLE tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token_enc TEXT,
      fingerprint TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      note TEXT,
      prefix TEXT NOT NULL DEFAULT 'tk',
      rpm_limit INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );`);
    raw.close();

    const db = new UsageDb(p, 30, log);
    expect(db.enabled).toBe(true);
    const cols = db.sqlite()!.prepare("SELECT name FROM pragma_table_info('tokens')").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const col of [
      'quota_usd', 'quota_tokens', 'quota_requests',
      'quota_used_usd', 'quota_used_tokens', 'quota_used_requests',
      'quota_cycle', 'quota_reset_at', 'expires_at',
    ]) {
      expect(names.has(col)).toBe(true);
    }
    db.close();

    // 幂等：再开一次（migrate/补列重复跑）不炸。
    const db2 = new UsageDb(p, 30, log);
    expect(db2.enabled).toBe(true);
    const cols2 = db2.sqlite()!.prepare("SELECT name FROM pragma_table_info('tokens')").all() as Array<{ name: string }>;
    expect(cols2.length).toBe(cols.length);
    db2.close();
  });

  it('新库建表即含配额列（CREATE TABLE 自带，不依赖补列 ALTER）', () => {
    const db = new UsageDb(path.join(tmpDir, 'tokens-quota-fresh.db'), 30, log);
    expect(db.enabled).toBe(true);
    const cols = db.sqlite()!.prepare("SELECT name FROM pragma_table_info('tokens')").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const col of ['quota_usd', 'quota_tokens', 'quota_requests', 'quota_cycle', 'quota_reset_at', 'expires_at']) {
      expect(names.has(col)).toBe(true);
    }
    db.close();
  });
});

describe('B2 面板热查询 at 窗口（retention 内过滤）', () => {
  it('queryIpStats：超 retention 的旧行不计入，窗口内计入（prune 未跑也生效）', () => {
    const db = new UsageDb(path.join(tmpDir, 'b2-ip-window.db'), 30, log);
    const now = Date.now();
    db.recordRequest(row({ at: now - 60 * 86_400_000, ip: '9.9.9.9', ua: 'claude-cli/1.0.27' }));
    db.recordRequest(row({ at: now - 3_600_000, ip: '1.2.3.4', ua: 'claude-cli/1.0.27' }));
    const page = db.statsByIp(1, 20)!;
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ ip: '1.2.3.4', requests: 1 });
    db.close();
  });

  it('queryIpStats：retention=0（永不清理）保持全量，不加窗口', () => {
    const db = new UsageDb(path.join(tmpDir, 'b2-ip-alltime.db'), 0, log);
    const now = Date.now();
    db.recordRequest(row({ at: now - 60 * 86_400_000, ip: '9.9.9.9', ua: 'claude-cli/1.0.27' }));
    const page = db.statsByIp(1, 20)!;
    expect(page.total).toBe(1);
    expect(page.items[0]!.ip).toBe('9.9.9.9');
    db.close();
  });

  it('tokenUsageAll：超 retention 的旧行不计入，窗口内计入', () => {
    const db = new UsageDb(path.join(tmpDir, 'b2-tok-window.db'), 30, log);
    const now = Date.now();
    db.recordRequest(row({ at: now - 60 * 86_400_000, tokenFp: 'old-fp' }));
    db.recordRequest(row({ at: now - 3_600_000, tokenFp: 'new-fp' }));
    const usage = db.tokenUsageAll();
    expect(usage.size).toBe(1);
    expect(usage.has('new-fp')).toBe(true);
    expect(usage.has('old-fp')).toBe(false);
    db.close();
  });
});

describe('B2 面板热查询性能回归（10 万行，对齐 history 修复做法）', () => {
  /** 直插（单事务）避免 recordRequest 攒批/UA 解析开销污染计时。 */
  function bulkSeed(db: UsageDb, n: number, mk: (i: number) => unknown[]): void {
    const raw = db.sqlite()!;
    const stmt = raw.prepare(
      `INSERT INTO requests (at, key_fp, model, upstream_model, endpoint, status,
        duration_ms, stream, input_tokens, output_tokens, thinking_tokens, error,
        path, ua, client, ip, cost_micro_cents, token_fp, api_key_fp)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    raw.exec('BEGIN');
    for (let i = 0; i < n; i++) stmt.run(...mk(i));
    raw.exec('COMMIT');
  }

  it('queryIpStats：10 万行窗口内聚合 < 200ms', { timeout: 60_000 }, () => {
    const db = new UsageDb(path.join(tmpDir, 'b2-perf-ip.db'), 30, log);
    const now = Date.now();
    const clients = ['Claude Code', 'Cursor', 'opencode', 'other'];
    bulkSeed(db, 100_000, (i) => [
      now - (i % 60_000), // at：全部窗口内
      '****0osU', // key_fp
      'claude-mythos-5', // model
      'deepseek-v4-flash', // upstream_model
      'subscription', // endpoint
      200, // status
      1234, // duration_ms
      0, // stream
      i % 500, // input_tokens
      i % 300, // output_tokens
      0, // thinking_tokens
      null, // error
      '/v1/messages', // path
      'claude-cli/1.0.27', // ua
      clients[i % clients.length]!, // client
      `10.0.${i % 8}.${i % 5}`, // ip → 40 个不同 IP
      0, // cost_micro_cents
      null, // token_fp
      null, // api_key_fp
    ]);
    db.flush(); // 清空 pending（直插后无积压，空操作）
    const query = db as unknown as {
      queryIpStats(): Array<{ ip: string; requests: number; clients: string[]; lastAt: number }> | null;
    };
    // warm 一次（prepare/JIT 不计入计时）。
    query.queryIpStats();
    const t0 = performance.now();
    const rows = query.queryIpStats();
    const elapsed = performance.now() - t0;
    expect(rows).not.toBeNull();
    expect(rows!.length).toBe(40);
    expect(elapsed).toBeLessThan(500); // 性能回归（单跑 ~86ms；全量并行环境 8GB 机器有 CPU 竞争，500ms 仍能抓秒级冻结）
    db.close();
  });

  it('tokenUsageAll：10 万行窗口内聚合 < 200ms', { timeout: 60_000 }, () => {
    const db = new UsageDb(path.join(tmpDir, 'b2-perf-tok.db'), 30, log);
    const now = Date.now();
    bulkSeed(db, 100_000, (i) => [
      now - (i % 60_000),
      `****k${i % 50}`,
      'claude-mythos-5',
      'deepseek-v4-flash',
      'subscription',
      200,
      1234,
      0,
      i % 500,
      i % 300,
      0,
      null,
      '/v1/messages',
      'claude-cli/1.0.27',
      'Claude Code',
      `10.0.${i % 8}.${i % 5}`,
      0,
      `tok${i % 100}`, // token_fp → 100 个不同 token
      null,
    ]);
    db.flush();
    db.tokenUsageAll(); // warm（prepare + 建缓存）
    (db as unknown as { tokenUsageCacheAt: number }).tokenUsageCacheAt = 0;
    const t0 = performance.now();
    const usage = db.tokenUsageAll();
    const elapsed = performance.now() - t0;
    expect(usage.size).toBe(100);
    expect(elapsed).toBeLessThan(500); // 性能回归（单跑 ~86ms；全量并行环境 8GB 机器有 CPU 竞争，500ms 仍能抓秒级冻结）
    db.close();
  });
});

