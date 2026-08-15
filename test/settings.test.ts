/**
 * 设置页热配置层（src/settings.ts + /__admin/api/settings 端点）测试。
 *
 * 覆盖：
 * - SettingsStore 读写/降级（db 不可用 → get null、all 空、set false）
 * - validateSetting / parseSettingValue 的校验矩阵
 * - applySettingsToConfig：apiKeys 引用替换、密码、实验开关
 * - HTTP：GET 视图（默认值+来源标记+密码不回显）、PATCH 校验/落库/生效
 * - e2e：PATCH apiKeys 后鉴权即时生效、PATCH adminPass 后新密码可登录
 * - 审计落库、Origin 校验、db 不可用 503
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AppConfig } from '../src/config.js';
import { UsageDb } from '../src/usagedb.js';
import {
  applySettingsToConfig,
  parseSettingValue,
  SETTINGS_META,
  SettingsStore,
  validateSetting,
  apiKeysMeta,
  allowedModelsMeta,
  modelPricesMeta,
} from '../src/settings.js';
import { createApp } from '../src/server.js';
import { DEFAULT_ADMIN_PASS } from '../src/config.js';

/** 与 e2e.test.ts 同款的最小 AppConfig（测试用假上游/空池）。 */
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
    gatewaySecret: 'settings-test-secret',
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

describe('SettingsStore', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-settings-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('set/get/all/delete 往返（upsert 语义）', () => {
    const db = new UsageDb(path.join(tmpDir, 'store.db'), 30, () => {});
    const store = new SettingsStore(db);
    expect(store.enabled).toBe(true);
    expect(store.all()).toEqual({});
    expect(store.set('adminPass', JSON.stringify('x'))).toBe(true);
    expect(store.set('adminPass', JSON.stringify('y'))).toBe(true);
    expect(store.get('adminPass')).toBe(JSON.stringify('y'));
    expect(store.all()).toEqual({ adminPass: JSON.stringify('y') });
    expect(store.delete('adminPass')).toBe(true);
    expect(store.delete('adminPass')).toBe(true);
    expect(store.all()).toEqual({});
    db.close();
  });

  it('setMany：事务原子性 —— 任一键写失败则全部回滚，无部分写入', () => {
    const dbPath = path.join(tmpDir, 'atomic.db');
    const db = new UsageDb(dbPath, 30, () => {});
    const store = new SettingsStore(db);
    expect(store.setMany({ a: '1', b: '2' })).toBe(true);
    expect(store.all()).toEqual({ a: '1', b: '2' });
    db.close();

    // 写失败注入：把 db 文件改成只读（SQLITE_READONLY）→ setMany 必须整体失败。
    fs.chmodSync(dbPath, 0o444);
    const dbRo = new UsageDb(dbPath, 30, () => {});
    // WAL 模式下只读文件也能打开（可读），写才失败 —— 正是要测的路径。
    const storeRo = new SettingsStore(dbRo);
    const ok = storeRo.setMany({ c: '3' });
    fs.chmodSync(dbPath, 0o644);
    dbRo.close();
    expect(ok).toBe(false);
    // 只读期间没有任何部分写入（失败前已存在的 a/b 保持原值，c 不存在）。
    const db2 = new UsageDb(dbPath, 30, () => {});
    expect(new SettingsStore(db2).all()).toEqual({ a: '1', b: '2' });
    db2.close();
  });

  it('降级：db 不可用 → get null、all 空、set/delete false', () => {
    const db = new UsageDb('', 30, () => {}); // 显式关闭持久化
    expect(db.enabled).toBe(false);
    const store = new SettingsStore(db);
    expect(store.enabled).toBe(false);
    expect(store.get('adminPass')).toBeNull();
    expect(store.all()).toEqual({});
    expect(store.set('adminPass', 'x')).toBe(false);
    expect(store.delete('adminPass')).toBe(false);
    const store2 = new SettingsStore(null);
    expect(store2.all()).toEqual({});
  });
});

describe('validateSetting / parseSettingValue', () => {
  it('SETTINGS_META 覆盖全部热改字段，default 与 config.ts 对齐', () => {
    expect(Object.keys(SETTINGS_META)).toEqual([
      'adminUser',
      'adminPass',
      'apiKeys',
      'allowedModels',
      'scaleClientTokens',
      'clientTokenScale',
      'compactEnabled',
      'compactTriggerBytes',
      'compactMaxMessageChars',
      'globalRpmLimit',
      'modelPrices',
    ]);
    expect(SETTINGS_META.adminUser?.default).toBe('admin');
    // 默认密码与 config.ts 同源（DEFAULT_ADMIN_PASS 常量，改 env 默认值两边不会漂移）。
    expect(SETTINGS_META.adminPass?.default).toBe(DEFAULT_ADMIN_PASS);
    expect(SETTINGS_META.adminPass?.default).toBe('13141516');
    expect(SETTINGS_META.clientTokenScale?.default).toBe(0.6657);
    expect(SETTINGS_META.compactTriggerBytes?.default).toBe(4 * 1024 * 1024);
    expect(SETTINGS_META.compactMaxMessageChars?.default).toBe(8000);
    expect(SETTINGS_META.globalRpmLimit?.default).toBe(0);
  });

  it('字符串：trim、长度边界', () => {
    expect(validateSetting('adminUser', '  bob  ')).toEqual({ ok: true, value: 'bob' });
    expect(validateSetting('adminUser', 5).ok).toBe(false);
    expect(validateSetting('adminUser', '').ok).toBe(false);
    expect(validateSetting('adminPass', 'x'.repeat(201)).ok).toBe(false);
    expect(validateSetting('adminPass', 'x'.repeat(200)).ok).toBe(true);
  });

  it('布尔：只认 true/false 字面量', () => {
    expect(validateSetting('scaleClientTokens', true)).toEqual({ ok: true, value: true });
    expect(validateSetting('compactEnabled', false)).toEqual({ ok: true, value: false });
    expect(validateSetting('scaleClientTokens', 'true').ok).toBe(false);
    expect(validateSetting('scaleClientTokens', 1).ok).toBe(false);
  });

  it('数字：范围与取整', () => {
    expect(validateSetting('clientTokenScale', 0.5)).toEqual({ ok: true, value: 0.5 });
    expect(validateSetting('clientTokenScale', 0).ok).toBe(false);
    expect(validateSetting('clientTokenScale', 1.5).ok).toBe(false);
    expect(validateSetting('compactTriggerBytes', 4096.9)).toEqual({ ok: true, value: 4096 });
    expect(validateSetting('compactTriggerBytes', 0).ok).toBe(false);
    expect(validateSetting('compactTriggerBytes', '4096').ok).toBe(false);
    expect(validateSetting('compactTriggerBytes', NaN).ok).toBe(false);
    // 全局 RPM：0 = 关闭（合法）；负值/字符串/NaN 拒绝。
    expect(validateSetting('globalRpmLimit', 0)).toEqual({ ok: true, value: 0 });
    expect(validateSetting('globalRpmLimit', 2000)).toEqual({ ok: true, value: 2000 });
    expect(validateSetting('globalRpmLimit', -1).ok).toBe(false);
    expect(validateSetting('globalRpmLimit', '100').ok).toBe(false);
  });

  it('apiKeys：字符串数组、trim、去空、去重、上限', () => {
    expect(validateSetting('apiKeys', [' a ', 'b', 'a'])).toEqual({ ok: true, value: ['a', 'b'] });
    expect(validateSetting('apiKeys', 'abc').ok).toBe(false);
    expect(validateSetting('apiKeys', ['a', 5]).ok).toBe(false);
    expect(validateSetting('apiKeys', ['']).ok).toBe(false);
    expect(validateSetting('apiKeys', new Array(101).fill('a')).ok).toBe(false);
    expect(validateSetting('apiKeys', new Array(100).fill('a')).ok).toBe(true);
  });

  it('allowedModelsMeta：接受任意合法模型名（含硬底线外 claude-*/gpt-*）', () => {
    expect(allowedModelsMeta(['claude-opus-5', 'gpt-5.5', 'glm-5.2', 'deepseek-v4-pro'])).toEqual({
      ok: true,
      value: ['claude-opus-5', 'gpt-5.5', 'glm-5.2', 'deepseek-v4-pro'],
    });
    expect(allowedModelsMeta(['deepseek-v4-flash', 'deepseek-v4-flash-free'])).toEqual({
      ok: true,
      value: ['deepseek-v4-flash', 'deepseek-v4-flash-free'],
    });
    // 大写/空格/特殊字符/超长 → 拒绝。
    expect(allowedModelsMeta(['Claude-Opus-5']).ok).toBe(false);
    expect(allowedModelsMeta(['claude opus']).ok).toBe(false);
    expect(allowedModelsMeta(['claude@opus']).ok).toBe(false);
    expect(allowedModelsMeta(['x'.repeat(101)]).ok).toBe(false);
    expect(allowedModelsMeta('x').ok).toBe(false);
    expect(allowedModelsMeta([42]).ok).toBe(false);
  });

  it('allowedModelsMeta：≤50 项、trim 去重、空数组/null 回代码默认', () => {
    expect(allowedModelsMeta([' a ', 'a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] });
    expect(allowedModelsMeta(Array.from({ length: 51 }, (_, i) => `m${i}`)).ok).toBe(false);
    expect(allowedModelsMeta(Array.from({ length: 50 }, (_, i) => `m${i}`)).ok).toBe(true);
    expect(allowedModelsMeta([])).toEqual({ ok: true, value: null });
    expect(allowedModelsMeta(null)).toEqual({ ok: true, value: null });
  });

  it('未知键一律拒绝', () => {
    expect(validateSetting('nope', 1).ok).toBe(false);
    expect(validateSetting('apiKey', 'x').ok).toBe(false);
  });

  it('modelPricesMeta：合法模型名 + 只读 read/write 字段；MINOR m1 放行 "*" 通配', () => {
    // 常规模型名：input/output/read/write 可选，缺省 0。
    expect(
      modelPricesMeta({ 'deepseek-v4-flash': { input: 0.25, output: 1.0, read: 0.5 } }),
    ).toEqual({
      ok: true,
      value: { 'deepseek-v4-flash': { input: 0.25, output: 1.0, read: 0.5, write: 0 } },
    });
    // '*' 通配键：QUOTA.md §4 的 resolveModelPrice 兜底分支，校验曾拒绝（MINOR m1）。
    expect(modelPricesMeta({ '*': { input: 0.1, output: 0.4 } }).ok).toBe(true);
    // 非法模型名 / 未知字段 / 负值仍拒绝。
    expect(modelPricesMeta({ 'Bad Model': { input: 1 } }).ok).toBe(false);
    expect(modelPricesMeta({ 'gpt-4o': { nope: 1 } }).ok).toBe(false);
    expect(modelPricesMeta({ 'gpt-4o': { input: -1 } }).ok).toBe(false);
    expect(modelPricesMeta(null)).toEqual({ ok: true, value: null });
  });

  it('parseSettingValue：db 字符串往返；坏 JSON / 坏值失败', () => {
    expect(parseSettingValue('scaleClientTokens', JSON.stringify(true))).toEqual({ ok: true, value: true });
    expect(parseSettingValue('apiKeys', JSON.stringify(['k1', 'k2']))).toEqual({ ok: true, value: ['k1', 'k2'] });
    expect(parseSettingValue('scaleClientTokens', 'not-json').ok).toBe(false);
    expect(parseSettingValue('scaleClientTokens', JSON.stringify('yes')).ok).toBe(false);
    expect(parseSettingValue('unknown-key', '1').ok).toBe(false);
  });
});

describe('applySettingsToConfig', () => {
  it('apiKeys 是引用替换：verifyAuth 下一次读取即生效', () => {
    const cfg = makeCfg({ apiKeys: ['old'] });
    const original = cfg.apiKeys;
    applySettingsToConfig(cfg, { apiKeys: ['new-a', 'new-b'] });
    expect(cfg.apiKeys).toEqual(['new-a', 'new-b']);
    expect(cfg.apiKeys).not.toBe(original); // 引用被替换而非原地改
  });

  it('密码/账号/实验开关全部原地生效', () => {
    const cfg = makeCfg();
    applySettingsToConfig(cfg, {
      adminUser: 'boss',
      adminPass: 'secret2',
      scaleClientTokens: true,
      clientTokenScale: 0.5,
      compactEnabled: true,
      compactTriggerBytes: 1024,
      compactMaxMessageChars: 100,
    });
    expect(cfg.adminUser).toBe('boss');
    expect(cfg.adminPass).toBe('secret2');
    expect(cfg.scaleClientTokens).toBe(true);
    expect(cfg.clientTokenScale).toBe(0.5);
    expect(cfg.compactEnabled).toBe(true);
    expect(cfg.compactTriggerBytes).toBe(1024);
    expect(cfg.compactMaxMessageChars).toBe(100);
  });

  it('未知键/错误类型被忽略（apply 不做校验，值应来自 validate）', () => {
    const cfg = makeCfg({ adminPass: 'keep' });
    applySettingsToConfig(cfg, { nope: 1, adminPass: 42 });
    expect(cfg.adminPass).toBe('keep');
  });

  it('SETTINGS_META 每个键都能被 applySettingsToConfig 生效（防手工同步漂移）', () => {
    const cfg = makeCfg({ adminUser: 'u', adminPass: 'p', apiKeys: ['k0'], scaleClientTokens: false, clientTokenScale: 0.9, compactEnabled: false, compactTriggerBytes: 1, compactMaxMessageChars: 1, globalRpmLimit: 0 });
    applySettingsToConfig(cfg, {
      adminUser: 'u2',
      adminPass: 'p2',
      apiKeys: ['k1'],
      scaleClientTokens: true,
      clientTokenScale: 0.5,
      compactEnabled: true,
      compactTriggerBytes: 999,
      compactMaxMessageChars: 888,
      globalRpmLimit: 2000,
    });
    expect(cfg.adminUser).toBe('u2');
    expect(cfg.adminPass).toBe('p2');
    expect(cfg.apiKeys).toEqual(['k1']);
    expect(cfg.scaleClientTokens).toBe(true);
    expect(cfg.clientTokenScale).toBe(0.5);
    expect(cfg.compactEnabled).toBe(true);
    expect(cfg.compactTriggerBytes).toBe(999);
    expect(cfg.compactMaxMessageChars).toBe(888);
    expect(cfg.globalRpmLimit).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// HTTP e2e：真实 app + 真实 db + 真实请求
// ---------------------------------------------------------------------------

describe('settings 端点 e2e', () => {
  let tmpDir: string;
  let db: UsageDb;
  let cfg: AppConfig;
  let server: Server;
  let baseUrl: string;

  /** 管理面鉴权头。初始用 env key；apiKeys 热改后切到新 key（管理面鉴权同读 cfg.apiKeys）。 */
  let adminHeaders: Record<string, string>;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-settings-e2e-'));
    db = new UsageDb(path.join(tmpDir, 'settings.db'), 30, () => {});
    cfg = makeCfg({ dashboardOpen: false });
    adminHeaders = { 'x-api-key': 'env-key-1' };
    server = createApp(cfg, undefined, db);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const envKeyHeaders = { 'x-api-key': 'env-key-1' };

  it('GET：默认视图（code-default 来源、默认值、密码与 apiKeys 明文都不回显）', async () => {
    const res = await fetch(`${baseUrl}/__admin/api/settings`, { headers: envKeyHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        settings: Record<string, { value: unknown; default: unknown; source: string }>;
        adminPassIsDefault: boolean;
      };
    };
    expect(body.ok).toBe(true);
    const s = body.data.settings;
    // 什么都没配（settings 表空）且 cfg 值 == 代码默认 → code-default（真实来源，
    // 不再一律标 env——审计 P0：source 不许撒谎）。
    expect(s.adminUser).toEqual({ value: 'admin', default: 'admin', source: 'code-default' });
    // 密码不回显：value 与 default 都恒空串，source 才是有效信息。当前生效密码
    // 是 env 显式值（thankyouopencode，非默认）→ env。
    expect(s.adminPass).toEqual({ value: '', default: '', source: 'env' });
    // 当前生效密码是自定义值（thankyouopencode），不是默认密码 → 标记 false。
    expect(body.data.adminPassIsDefault).toBe(false);
    // apiKeys 只回掩码（****XXXX），明文不离开 PATCH 请求体。env 显式配了 key → env。
    expect(s.apiKeys).toEqual({ value: ['****ey-1'], default: [], source: 'env' });
    expect(s.scaleClientTokens).toEqual({ value: false, default: false, source: 'code-default' });
    expect(s.clientTokenScale).toEqual({ value: 0.6657, default: 0.6657, source: 'code-default' });
    expect(s.compactEnabled).toEqual({ value: false, default: false, source: 'code-default' });
    expect(s.compactTriggerBytes).toEqual({ value: 4 * 1024 * 1024, default: 4 * 1024 * 1024, source: 'code-default' });
    expect(s.compactMaxMessageChars).toEqual({ value: 8000, default: 8000, source: 'code-default' });
    expect(s.globalRpmLimit).toEqual({ value: 0, default: 0, source: 'code-default' });
  });

  it('source 三元组：env 显式非默认值标 env；settings 表有键标 db（P0 source 不撒谎）', async () => {
    // 用「非默认值但不在 db」的 cfg 验证 env 分支：adminUser 改 boss（非默认）不入库。
    const cfgEnv = makeCfg({ adminUser: 'boss', apiKeys: ['env-key-1'], scaleClientTokens: true });
    const srv = createApp(cfgEnv, undefined, db);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const a = srv.address();
    const url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    try {
      const res = await fetch(`${url}/__admin/api/settings`, { headers: envKeyHeaders });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { settings: Record<string, { value: unknown; default: unknown; source: string }> };
      };
      const s = body.data.settings;
      // env 显式（cfg 值非默认、settings 表无键）→ 'env'。
      expect(s.adminUser).toEqual({ value: 'boss', default: 'admin', source: 'env' });
      expect(s.scaleClientTokens).toEqual({ value: true, default: false, source: 'env' });
      expect(s.apiKeys).toEqual({ value: ['****ey-1'], default: [], source: 'env' });
      // 未配的仍 code-default。
      expect(s.compactEnabled!.source).toBe('code-default');
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('adminPassIsDefault：生效密码等于默认值时置 true（面板强提示的依据）', async () => {
    const cfgDefault = makeCfg({ adminPass: DEFAULT_ADMIN_PASS });
    const srv = createApp(cfgDefault, undefined, db);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const a = srv.address();
    const url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    try {
      const res = await fetch(`${url}/__admin/api/settings`, { headers: envKeyHeaders });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { adminPassIsDefault?: boolean } };
      expect(body.data.adminPassIsDefault).toBe(true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('PATCH 校验：未知键 / 类型错 / 值越界 → 400，什么都不改', async () => {
    const bad: Array<Record<string, unknown>> = [
      { nope: 1 },
      { scaleClientTokens: 'yes' },
      { clientTokenScale: 2 },
      { apiKeys: 'k1' },
      { apiKeys: ['a', 5] },
      { compactTriggerBytes: 0 },
      { adminPass: '' },
    ];
    for (const body of bad) {
      const res = await fetch(`${baseUrl}/__admin/api/settings`, {
        method: 'PATCH',
        headers: { ...envKeyHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    // 全部失败 → cfg 未被污染。
    expect(cfg.scaleClientTokens).toBe(false);
    expect(cfg.adminPass).toBe('thankyouopencode');
  });

  it('PATCH 成功：落库 + cfg 生效 + GET source 变 db + 审计', async () => {
    const res = await fetch(`${baseUrl}/__admin/api/settings`, {
      method: 'PATCH',
      headers: { ...envKeyHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        adminUser: 'boss',
        apiKeys: ['new-key-1', 'new-key-2'],
        scaleClientTokens: true,
        clientTokenScale: 0.42,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { settings: Record<string, { value: unknown; default: unknown; source: string }> };
    };
    expect(body.ok).toBe(true);
    // 响应即全量视图，source 已翻转。
    expect(body.data.settings.adminUser).toEqual({ value: 'boss', default: 'admin', source: 'db' });
    // apiKeys 只回掩码（末 4 位），明文不回显。
    expect(body.data.settings.apiKeys).toEqual({ value: ['****ey-1', '****ey-2'], default: [], source: 'db' });
    expect(body.data.settings.scaleClientTokens).toEqual({ value: true, default: false, source: 'db' });
    expect(body.data.settings.adminPass).toEqual({ value: '', default: '', source: 'env' });

    // cfg 原地生效（createApp 持有同一对象）。
    expect(cfg.adminUser).toBe('boss');
    expect(cfg.apiKeys).toEqual(['new-key-1', 'new-key-2']);
    expect(cfg.scaleClientTokens).toBe(true);
    expect(cfg.clientTokenScale).toBe(0.42);

    // 审计落库。
    const audits = db
      .sqlite()!
      .prepare("SELECT op, ok, note FROM admin_audit WHERE op = 'settings.update' ORDER BY id DESC LIMIT 1")
      .get() as { op: string; ok: number; note: string };
    expect(audits.op).toBe('settings.update');
    expect(audits.ok).toBe(1);
    expect(audits.note).toBe('adminUser,apiKeys,scaleClientTokens,clientTokenScale');
  });

  it('e2e：apiKeys 热改后鉴权即时生效（新 key 200、旧 key 401，无需重启）', async () => {
    // 上一用例已把 apiKeys 换成 new-key-*。
    const withNew = await fetch(`${baseUrl}/v1/models`, { headers: { 'x-api-key': 'new-key-2' } });
    expect(withNew.status).toBe(200);
    const withOld = await fetch(`${baseUrl}/v1/models`, { headers: { 'x-api-key': 'env-key-1' } });
    expect(withOld.status).toBe(401);
    // 管理面鉴权同读 cfg.apiKeys —— 后续用例切换到新 key。
    adminHeaders = { 'x-api-key': 'new-key-1' };
  });

  it('e2e：adminPass 热改后新密码可登录、旧密码 401（限速计数被成功登录清零）', async () => {
    // apiKeys 已热改为 new-key-*，管理面鉴权用新 key。
    const patch = await fetch(`${baseUrl}/__admin/api/settings`, {
      method: 'PATCH',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ adminPass: 'brand-new-pass' }),
    });
    expect(patch.status).toBe(200);
    expect(cfg.adminPass).toBe('brand-new-pass');

    // 旧密码一次失败（不能多刷 —— 登录失败限速按 IP 记键，5 次锁 5 分钟）。
    // 注意：adminUser 已在前面用例热改为 boss，登录要用新账号。
    const old = await fetch(`${baseUrl}/__admin/api/login`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'thankyouopencode' }),
    });
    expect(old.status).toBe(401);

    const fresh = await fetch(`${baseUrl}/__admin/api/login`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'brand-new-pass' }),
    });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('set-cookie')).toContain('fc_admin_session=');
    // 成功登录清掉失败计数，后续用例不会撞限速锁。
  });

  it('PATCH 跨站 Origin → 403', async () => {
    const res = await fetch(`${baseUrl}/__admin/api/settings`, {
      method: 'PATCH',
      headers: {
        ...adminHeaders,
        'content-type': 'application/json',
        origin: 'https://evil.example',
        host: 'localhost',
      },
      body: JSON.stringify({ adminPass: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('GET 跨站 Origin → 403（读也防跨站）', async () => {
    const res = await fetch(`${baseUrl}/__admin/api/settings`, {
      headers: { ...adminHeaders, origin: 'https://evil.example', host: 'localhost' },
    });
    expect(res.status).toBe(403);
  });

  it('PATCH 不设 Origin（curl 场景）放行', async () => {
    const res = await fetch(`${baseUrl}/__admin/api/settings`, {
      method: 'PATCH',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ compactEnabled: true }),
    });
    expect(res.status).toBe(200);
    expect(cfg.compactEnabled).toBe(true);
  });

  it('重启等价：新 app 用同一 db，settings 启动合并覆盖 env 默认', async () => {
    // main.ts 的启动合并逻辑（SettingsStore.all → parseSettingValue → apply）。
    const cfg2 = makeCfg({ scaleClientTokens: false });
    const store = new SettingsStore(db);
    const values: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(store.all())) {
      const parsed = parseSettingValue(key, raw);
      if (parsed.ok) values[key] = parsed.value;
    }
    applySettingsToConfig(cfg2, values);
    expect(cfg2.scaleClientTokens).toBe(true);
    expect(cfg2.adminUser).toBe('boss');
    expect(cfg2.adminPass).toBe('brand-new-pass');
    expect(cfg2.apiKeys).toEqual(['new-key-1', 'new-key-2']);
  });

  it('db 未接线：GET 降级 200（全 env），PATCH 503', async () => {
    const cfgNoDb = makeCfg({ apiKeys: ['k'] });
    const noDb = createApp(cfgNoDb);
    await new Promise<void>((r) => noDb.listen(0, '127.0.0.1', r));
    const a = noDb.address();
    const url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    const get = await fetch(`${url}/__admin/api/settings`, { headers: { 'x-api-key': 'k' } });
    expect(get.status).toBe(200);
    const body = (await get.json()) as { data: { settings: Record<string, { source: string }> } };
    expect(body.data.settings.scaleClientTokens?.source).toBe('code-default');
    const patch = await fetch(`${url}/__admin/api/settings`, {
      method: 'PATCH',
      headers: { 'x-api-key': 'k', 'content-type': 'application/json' },
      body: JSON.stringify({ scaleClientTokens: true }),
    });
    expect(patch.status).toBe(503);
    await new Promise<void>((r) => noDb.close(() => r()));
  });
});

describe('apiKeys 掩码防护（对抗审查 M1）', () => {
  it('掩码（**** 前缀）提交被拒——防误操作锁死全部客户端', () => {
    const r = apiKeysMeta(['sk-real-key', '****dk']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('masked');
  });

  it('正常 key（sk- 前缀）通过', () => {
    const r = apiKeysMeta(['sk-real-key']);
    expect(r.ok).toBe(true);
  });
});
