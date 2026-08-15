/**
 * 密钥-模型授权层（MODEL-ACCESS.md）。
 *
 * 管理「哪一个密钥可以生成哪一个模型」：三类 subject（token / api-key /
 * upstream-key）各自可配自定义允许模型，行存在 = 已配置（覆盖全局/账号层），
 * 删行 = 清除自定义、回退。
 *
 * 表 `model_access(subject_type, subject_id, models, updated_at)` 建在 usage db
 * 里（usagedb.ts 的 migrate），这里只做 CRUD。降级哲学与 modelmap/settings
 * 一致：db 不可用或查询失败返回 null/空/失败，绝不抛 —— 授权是管理面配置，
 * 缺了只是回退到全局白名单（ALLOWED_MODELS 硬底线不变，行为与无此功能时一致）。
 *
 * 热路径：getCustom 是数据面每请求调用（选号过滤 + 模型门），用内存缓存
 * （与 accounts.allowedCache 同款懒加载）；管理写操作后 invalidate 全清
 * （小表，全清成本可忽略）。
 */

import type { UsageDb } from './usagedb.js';

/** subject 类型。token = tokens.fingerprint；api-key / upstream-key = sha256 全 hex。 */
export type ModelAccessSubjectType = 'token' | 'api-key' | 'upstream-key';

export const MODEL_ACCESS_TYPES: ReadonlyArray<ModelAccessSubjectType> = ['token', 'api-key', 'upstream-key'];

/** 一行授权（面板展示用）。 */
export interface ModelAccessRow {
  subjectType: ModelAccessSubjectType;
  subjectId: string;
  models: string[];
  updatedAt: number;
}

/**
 * 解析库里的 models JSON。坏数据返回 null（调用方按「无自定义」处理，
 * 与 settings 的坏值跳过同哲学）。
 */
function parseModels(raw: string | null): string[] | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    const models = v.map((m) => (typeof m === 'string' ? m : '')).filter(Boolean);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

export class ModelAccessStore {
  readonly enabled: boolean;
  /** sqlite 句柄（UsageDb.sqlite() 的类型是 any 出口，这里不重复写 any 关键字）。 */
  private raw: ReturnType<UsageDb['sqlite']> = null;
  /** 热路径缓存：`${type}:${subjectId}` → models[] | null（null = 无自定义）。 */
  private readonly cache = new Map<string, string[] | null>();

  constructor(db: UsageDb | null) {
    this.enabled = db != null && db.enabled;
    this.raw = db?.sqlite?.() ?? null;
  }

  /**
   * 某 subject 的自定义允许模型。null = 无自定义（跟随全局/账号层）。
   * 命中缓存直接返回；数据面每请求调用，不落库查询。
   */
  getCustom(type: ModelAccessSubjectType, subjectId: string): string[] | null {
    const key = `${type}:${subjectId}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    if (!this.enabled) return null;
    let result: string[] | null = null;
    try {
      const row = this.raw
        .prepare('SELECT models FROM model_access WHERE subject_type = ? AND subject_id = ?')
        .get(type, subjectId) as { models: string } | undefined;
      result = parseModels(row?.models ?? null);
    } catch (err) {
      console.warn(`[modelaccess] 查询失败（按无自定义处理）: ${err instanceof Error ? err.message : err}`);
      // 查询失败不落缓存（审查 MINOR-3）：瞬时 DB 故障只回退一次，下次再查——
      // 把 null 缓存成「永久无自定义」会让一次故障静默放宽所有密钥的授权。
      return null;
    }
    // null（无自定义）也缓存：避免未配置的密钥每次都查库。
    this.cache.set(key, result);
    return result;
  }

  /**
   * 写入/清除某 subject 的自定义授权。models 为 null 或空数组 = 删行（清除）。
   * 返回是否成功。成功后失效缓存（该 subject 的热路径立即读到新值）。
   */
  setCustom(type: ModelAccessSubjectType, subjectId: string, models: string[] | null): boolean {
    if (!this.enabled) return false;
    try {
      if (models == null || models.length === 0) {
        this.raw.prepare('DELETE FROM model_access WHERE subject_type = ? AND subject_id = ?').run(type, subjectId);
      } else {
        this.raw
          .prepare(
            `INSERT INTO model_access (subject_type, subject_id, models, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(subject_type, subject_id) DO UPDATE SET
               models = excluded.models, updated_at = excluded.updated_at`,
          )
          .run(type, subjectId, JSON.stringify(models), Date.now());
      }
      this.invalidate();
      return true;
    } catch (err) {
      console.warn(`[modelaccess] 写入失败: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** 某类型全部自定义（面板展示）。db 不可用/失败返回空数组。 */
  listByType(type: ModelAccessSubjectType): ModelAccessRow[] {
    if (!this.enabled) return [];
    try {
      const rows = this.raw
        .prepare('SELECT subject_type, subject_id, models, updated_at FROM model_access WHERE subject_type = ?')
        .all(type) as Array<Record<string, unknown>>;
      const out: ModelAccessRow[] = [];
      for (const r of rows) {
        const models = parseModels(r.models == null ? null : String(r.models));
        if (models == null) continue; // 坏数据行跳过
        out.push({
          subjectType: String(r.subject_type) as ModelAccessSubjectType,
          subjectId: String(r.subject_id),
          models,
          updatedAt: Number(r.updated_at) || 0,
        });
      }
      return out;
    } catch (err) {
      console.warn(`[modelaccess] 列表查询失败（返回空）: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  /** 管理写操作后调用：清空热路径缓存（小表，全清成本可忽略）。 */
  invalidate(): void {
    this.cache.clear();
  }
}
