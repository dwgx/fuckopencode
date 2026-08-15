import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UsageDb } from '../src/usagedb.js';
import { ModelAccessStore } from '../src/modelaccess.js';
import { allowedModelsMeta, applySettingsToConfig, effectiveGlobalModels } from '../src/settings.js';
import { loadConfig } from '../src/config.js';
import { ALLOWED_MODELS } from '../src/deepseek.js';

let tmpDir: string;
const log = () => {};

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'fc-modelaccess-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeDb(name: string): UsageDb {
  return new UsageDb(path.join(tmpDir, name), 30, log);
}

describe('ModelAccessStore（密钥-模型授权数据层）', () => {
  it('migrate 建表 + 默认无自定义（null）', () => {
    const db = makeDb('ma1.db');
    const store = new ModelAccessStore(db);
    expect(store.enabled).toBe(true);
    expect(store.getCustom('token', 'abc123')).toBeNull();
    expect(store.getCustom('api-key', 'x'.repeat(64))).toBeNull();
    expect(store.getCustom('upstream-key', 'y'.repeat(64))).toBeNull();
    db.close();
  });

  it('setCustom 写入 → getCustom 命中（热路径缓存立即生效）', () => {
    const db = makeDb('ma2.db');
    const store = new ModelAccessStore(db);
    expect(store.setCustom('token', 'fp1', ['deepseek-v4-flash'])).toBe(true);
    expect(store.getCustom('token', 'fp1')).toEqual(['deepseek-v4-flash']);
    // 其他 subject 不受影响。
    expect(store.getCustom('token', 'fp2')).toBeNull();
    expect(store.getCustom('api-key', 'x'.repeat(64))).toBeNull();
    db.close();
  });

  it('models 空数组/null = 删行清除（回退全局）', () => {
    const db = makeDb('ma3.db');
    const store = new ModelAccessStore(db);
    store.setCustom('api-key', 'a'.repeat(64), ['deepseek-v4-flash']);
    expect(store.getCustom('api-key', 'a'.repeat(64))).toEqual(['deepseek-v4-flash']);
    expect(store.setCustom('api-key', 'a'.repeat(64), null)).toBe(true);
    expect(store.getCustom('api-key', 'a'.repeat(64))).toBeNull();
    store.setCustom('upstream-key', 'b'.repeat(64), ['deepseek-v4-flash-free']);
    expect(store.setCustom('upstream-key', 'b'.repeat(64), [])).toBe(true);
    expect(store.getCustom('upstream-key', 'b'.repeat(64))).toBeNull();
    db.close();
  });

  it('setCustom 覆盖更新（替换语义，不是追加）', () => {
    const db = makeDb('ma4.db');
    const store = new ModelAccessStore(db);
    store.setCustom('token', 'fp', ['deepseek-v4-flash']);
    store.setCustom('token', 'fp', ['deepseek-v4-flash-free']);
    expect(store.getCustom('token', 'fp')).toEqual(['deepseek-v4-flash-free']);
    db.close();
  });

  it('listByType 只列该类型 + 坏数据行跳过', () => {
    const db = makeDb('ma5.db');
    const store = new ModelAccessStore(db);
    store.setCustom('token', 'fp-a', ['deepseek-v4-flash']);
    store.setCustom('token', 'fp-b', ['deepseek-v4-flash-free']);
    store.setCustom('api-key', 'c'.repeat(64), ['deepseek-v4-flash']);
    const tokens = store.listByType('token');
    expect(tokens.map((r) => r.subjectId).sort()).toEqual(['fp-a', 'fp-b']);
    expect(tokens[0]!.updatedAt).toBeGreaterThan(0);
    expect(store.listByType('api-key')).toHaveLength(1);
    expect(store.listByType('upstream-key')).toHaveLength(0);
    // 坏数据行（models 不是合法 JSON）跳过。
    const raw = db.sqlite();
    raw!.prepare('INSERT INTO model_access (subject_type, subject_id, models, updated_at) VALUES (?, ?, ?, ?)').run(
      'token', 'fp-bad', 'not-json', Date.now(),
    );
    expect(store.listByType('token').map((r) => r.subjectId)).not.toContain('fp-bad');
    db.close();
  });

  it('invalidate 清缓存：外部写库后旧缓存不残留', () => {
    const db = makeDb('ma6.db');
    const store = new ModelAccessStore(db);
    expect(store.getCustom('token', 'fp')).toBeNull(); // 缓存了 null
    const raw = db.sqlite();
    raw!.prepare('INSERT INTO model_access (subject_type, subject_id, models, updated_at) VALUES (?, ?, ?, ?)').run(
      'token', 'fp', JSON.stringify(['deepseek-v4-flash']), Date.now(),
    );
    expect(store.getCustom('token', 'fp')).toBeNull(); // 旧缓存
    store.invalidate();
    expect(store.getCustom('token', 'fp')).toEqual(['deepseek-v4-flash']); // 缓存清了
    db.close();
  });

  it('降级：db 不可用 → getCustom null / setCustom false / listByType 空，不抛', () => {
    const store = new ModelAccessStore(null);
    expect(store.enabled).toBe(false);
    expect(store.getCustom('token', 'fp')).toBeNull();
    expect(store.setCustom('token', 'fp', ['deepseek-v4-flash'])).toBe(false);
    expect(store.listByType('token')).toEqual([]);
  });
});

describe('settings allowedModels（全局默认白名单）', () => {
  it('校验：任意合法模型名接受（含硬底线外 claude-*/gpt-*）、trim 去重、≤50、空数组 → null', () => {
    const ok = allowedModelsMeta([' deepseek-v4-flash ', 'deepseek-v4-flash-free', 'deepseek-v4-flash']);
    expect(ok).toEqual({ ok: true, value: ['deepseek-v4-flash', 'deepseek-v4-flash-free'] });
    // 硬底线外模型（claude-*/gpt-* 等上游模型）现在合法 —— 白名单可扩展。
    expect(allowedModelsMeta(['claude-opus-5', 'gpt-5.5', 'glm-5.2', 'deepseek-v4-pro'])).toEqual({
      ok: true,
      value: ['claude-opus-5', 'gpt-5.5', 'glm-5.2', 'deepseek-v4-pro'],
    });
    expect(allowedModelsMeta([null])).toMatchObject({ ok: false });
    expect(allowedModelsMeta('x')).toMatchObject({ ok: false });
    // 非法格式：大写/空格/特殊字符 拒绝。
    expect(allowedModelsMeta(['Claude-Opus-5'])).toMatchObject({ ok: false });
    expect(allowedModelsMeta(['claude opus'])).toMatchObject({ ok: false });
    expect(allowedModelsMeta(['claude@opus'])).toMatchObject({ ok: false });
    expect(allowedModelsMeta(['a'.repeat(101)])).toMatchObject({ ok: false });
    // 审查 MAJOR-1：空数组必须归一为 null（= 清键回代码默认），不能是 []（= 全锁）。
    expect(allowedModelsMeta([])).toEqual({ ok: true, value: null });
    expect(allowedModelsMeta(null)).toEqual({ ok: true, value: null });
  });

  it('applySettingsToConfig：数组应用（扩展/收窄）/ null 回代码默认 / 默认 = ALLOWED_MODELS', () => {
    const cfg = loadConfig({});
    expect([...effectiveGlobalModels(cfg)].sort()).toEqual([...ALLOWED_MODELS].sort());
    applySettingsToConfig(cfg, { allowedModels: ['deepseek-v4-flash'] });
    expect(effectiveGlobalModels(cfg).has('deepseek-v4-flash')).toBe(true);
    expect(effectiveGlobalModels(cfg).has('deepseek-v4-flash-free')).toBe(false);
    applySettingsToConfig(cfg, { allowedModels: null });
    expect(effectiveGlobalModels(cfg).has('deepseek-v4-flash-free')).toBe(true); // 回代码默认
    // 扩展：添加硬底线外模型。
    applySettingsToConfig(cfg, { allowedModels: ['deepseek-v4-flash', 'claude-opus-5'] });
    expect(effectiveGlobalModels(cfg).has('claude-opus-5')).toBe(true);
    // MAJOR-1 回归链完整：allowedModelsMeta([]) → null（上一测试）→ apply 收到
    // null → 回默认，空数组永远不会变成空集锁死全部模型。
  });
});
