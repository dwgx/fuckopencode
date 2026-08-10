import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  it('删掉超过保留期的行，保留期内的不动', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 1, log); // 保留 1 天
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
    const h = db.history()!;
    expect(h.totalRequests).toBe(1);
    expect(h.recentKeyEvents).toHaveLength(0);
    db.close();
  });

  it('retentionDays=0 表示不清理', () => {
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 0, log);
    db.recordRequest(row({ at: 1 })); // 极旧
    db.pruneNow(100 * 86_400_000);
    expect(db.history()!.totalRequests).toBe(1);
    db.close();
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
