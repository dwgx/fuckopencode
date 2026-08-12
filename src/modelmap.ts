/**
 * 模型映射的持久化层（后台设置页「模型映射」）。
 *
 * 表 `model_aliases(alias UNIQUE, target, note)` 建在 usage db 里（usagedb.ts
 * 的 migrate），这里只做 CRUD。降级哲学与 usagedb 一致：db 不可用或查询失败
 * 返回空/失败，绝不抛 —— 映射是网关的可选项，缺了只是回落默认模型。
 *
 * 运行时生效靠调用方（admin.ts / server.ts）把结果同步进 cfg.modelMap：
 * resolveModelName 每次读的都是同一个 cfg.modelMap 对象引用，原地改立即生效。
 */

import type { UsageDb } from './usagedb.js';

/** 一行映射（面板展示用）。 */
export interface ModelAlias {
  alias: string;
  target: string;
  note: string | null;
}

/** 全部映射（按 alias 字典序）。db 不可用/查询失败返回空列表。 */
export function loadModelAliases(db: UsageDb | null): ModelAlias[] {
  const raw = db?.sqlite?.() ?? null;
  if (!raw) return [];
  try {
    const rows = raw
      .prepare('SELECT alias, target, note FROM model_aliases ORDER BY alias')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      alias: String(r.alias),
      target: String(r.target),
      note: r.note == null ? null : String(r.note),
    }));
  } catch (err) {
    console.warn(`[modelmap] 模型映射查询失败（返回空）: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/**
 * 保存（alias 已存在则更新 target/note，UNIQUE 靠 ON CONFLICT 幂等）。
 * 失败返回 false，不抛。
 */
export function saveModelAlias(
  db: UsageDb | null,
  alias: string,
  target: string,
  note?: string | null,
): boolean {
  const raw = db?.sqlite?.() ?? null;
  if (!raw) return false;
  try {
    raw
      .prepare(
        `INSERT INTO model_aliases (alias, target, note) VALUES (?, ?, ?)
         ON CONFLICT(alias) DO UPDATE SET target = excluded.target, note = excluded.note`,
      )
      .run(alias, target, note ?? null);
    return true;
  } catch (err) {
    console.warn(`[modelmap] 模型映射保存失败: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/** 删除一条映射。删除不存在的行也返回 true（幂等）。失败返回 false。 */
export function deleteModelAlias(db: UsageDb | null, alias: string): boolean {
  const raw = db?.sqlite?.() ?? null;
  if (!raw) return false;
  try {
    raw.prepare('DELETE FROM model_aliases WHERE alias = ?').run(alias);
    return true;
  } catch (err) {
    console.warn(`[modelmap] 模型映射删除失败: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * PUT 语义的更新：只改已存在的映射（alias 不存在返回 'missing'，不插入 ——
 * 与 POST 的 upsert 语义区分，调用方据此回 404）。失败返回 false。
 */
export function updateModelAlias(
  db: UsageDb | null,
  alias: string,
  target: string,
  note: string | null,
): 'updated' | 'missing' | false {
  const raw = db?.sqlite?.() ?? null;
  if (!raw) return false;
  try {
    const res = raw
      .prepare('UPDATE model_aliases SET target = ?, note = ? WHERE alias = ?')
      .run(target, note, alias);
    // changes=0 可能是「alias 不存在」也可能是「值没变」；SQLite 的 changes
    // 只统计值实际被改的行，先验存在性再下结论（与 updateAccount 同一思路）。
    if (Number(res.changes) === 0) {
      const exists = raw.prepare('SELECT 1 FROM model_aliases WHERE alias = ?').get(alias);
      return exists ? 'updated' : 'missing';
    }
    return 'updated';
  } catch (err) {
    console.warn(`[modelmap] 模型映射更新失败: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * 默认模型映射（seed 用）。历史上这两个别名内置在 deepseek.ts 的 MODEL_ALIASES
 * 里，改造为 db 配置清单后由首次启动种子进来 —— 表空时 seed，行为与旧版一致：
 * 两个 Anthropic 风格名字都映射到订阅端点的 deepseek-v4-flash（fable-5 曾映射
 * free，但 free 是 IP 日窗限流，VPS IP 被限时全池 503，已改走订阅端点）。
 * 一旦用户手动增删改过（表非空），不再 seed —— 配置归属用户。
 */
export const DEFAULT_MODEL_ALIASES: ReadonlyArray<{ alias: string; target: string; note: string | null }> = [
  { alias: 'claude-mythos-5', target: 'deepseek-v4-flash', note: '默认映射（seed）' },
  { alias: 'claude-fable-5', target: 'deepseek-v4-flash', note: '默认映射（seed）' },
];

/**
 * 首次启动 seed：model_aliases 表空时写入默认映射，返回是否真的执行了 seed。
 * db 不可用/表已有数据 → 不写，返回 false。任何单条失败都不抛（与其余
 * 映射函数同哲学）—— seed 是「保持默认行为」的锦上添花，缺了只是回到
 * fallback 解析，代理链路不受影响。
 */
export function seedDefaultModelAliases(db: UsageDb | null): boolean {
  if (db == null || !db.enabled) return false;
  if (loadModelAliases(db).length > 0) return false;
  let seeded = true;
  for (const m of DEFAULT_MODEL_ALIASES) {
    if (!saveModelAlias(db, m.alias, m.target, m.note)) seeded = false;
  }
  return seeded;
}
