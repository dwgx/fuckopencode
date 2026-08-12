/**
 * 设置页热配置层（settings 表 + 运行时应用）。
 *
 * 哲学：**env 是默认值，settings 覆盖，运行时生效不重启**。
 *
 * - 启动时（main.ts）：把 settings 表里已存的值解析后 apply 进 cfg，覆盖 env 默认。
 * - 运行时（PATCH /__admin/api/settings）：set 落库 → applySettingsToConfig 原地改 cfg。
 * - 鉴权/登录/实验开关读的都是 cfg 字段本身：apiKeys 是**数组引用替换**
 *   （verifyAuth 每次读 cfg.apiKeys），adminPass 登录校验每次读 cfg.adminPass，
 *   开关字段读同对象 —— 全部立即生效，无需任何通知机制。
 *
 * 可热改字段清单（SETTINGS_META）是唯一真源：GET 端点列它、PATCH 校验按它、
 * apply 按它。默认值必须与 config.ts 的 loadConfig 保持一致（两边对照过，
 * 改 env 默认值时记得同步这里，否则设置页显示的「默认值」会说谎）。
 *
 * 降级哲学与 usagedb 一致：db 不可用/查询失败 → get 返回 null、all 返回空，
 * 绝不抛 —— 热配置是管理面增强，缺了只是退回 env 默认。
 *
 * 已知取舍：改面板密码不会让已签发会话失效（签名会话无状态，黑名单只能按
 * 签名值逐个禁，改密码时无法全量枚举）——旧会话 24h 内仍有效，文档注明。
 */

import type { AppConfig } from './config.js';
import type { UsageDb } from './usagedb.js';

/** 校验结果：ok 带规范化后的值，失败带可回给调用方的文案。 */
type SettingValidation = { ok: true; value: unknown } | { ok: false; error: string };

/** 一个可热改字段的元信息：默认值（env 口径）+ 校验函数。 */
interface SettingMeta {
  default: unknown;
  validate(value: unknown): SettingValidation;
}

/** 密码专用：不 trim（用户可能故意带空格，trim 会静默改密码——对抗审查 m7）。 */
function passwordMeta(min: number, max: number): SettingMeta['validate'] {
  return (value: unknown): SettingValidation => {
    if (typeof value !== 'string') return { ok: false, error: 'must be a string' };
    if (value.length < min || value.length > max) {
      return { ok: false, error: `must be ${min}-${max} characters` };
    }
    return { ok: true, value };
  };
}

/** 字符串：trim 后长度在 [min, max]，非空。 */
function stringMeta(min: number, max: number): SettingMeta['validate'] {
  return (value: unknown): SettingValidation => {
    if (typeof value !== 'string') return { ok: false, error: 'must be a string' };
    const t = value.trim();
    if (t.length < min || t.length > max) {
      return { ok: false, error: `must be ${min}-${max} characters` };
    }
    return { ok: true, value: t };
  };
}

/** 严格布尔：只认 true/false 字面量，不搞 truthy 魔法。 */
function boolMeta(value: unknown): SettingValidation {
  return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: 'must be a boolean' };
}

/** 整数：有限、≥ min、取整。 */
function intMeta(min: number): SettingMeta['validate'] {
  return (value: unknown): SettingValidation => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
      return { ok: false, error: `must be a number >= ${min}` };
    }
    return { ok: true, value: Math.floor(value) };
  };
}

/** 浮点：有限且在 [min, max] 内。 */
function floatMeta(min: number, max: number): SettingMeta['validate'] {
  return (value: unknown): SettingValidation => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      return { ok: false, error: `must be a number in [${min}, ${max}]` };
    }
    return { ok: true, value };
  };
}

/** API_KEYS 数组：元素是 1-256 字符的字符串，trim 去空去重，上限 100 个。 */
export function apiKeysMeta(value: unknown): SettingValidation {
  if (!Array.isArray(value)) return { ok: false, error: 'must be an array of strings' };
  if (value.length > 100) return { ok: false, error: 'must be at most 100 keys' };
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, error: 'must be an array of strings' };
    const k = item.trim();
    if (k.length === 0 || k.length > 256) {
      return { ok: false, error: 'each key must be 1-256 characters' };
    }
    // M1（对抗审查）：GET /settings 返回的 apiKeys 是掩码（****XXXX）——
    // 掩码回传会被当成真 key 存进去，一次误操作锁死全部客户端（实测）。
    // 真 key 以 sk- 开头（或至少不以 **** 开头），格式可区分，直接拒绝。
    if (k.startsWith('****')) {
      return { ok: false, error: `masked key cannot be submitted as plaintext: ${k}` };
    }
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return { ok: true, value: keys };
}

/**
 * 可热改字段清单。**默认值必须与 config.ts 的 loadConfig 对齐**
 * （adminUser/adminPass/实验开关那组；apiKeys 的 env 默认是空数组）。
 */
export const SETTINGS_META: Readonly<Record<string, SettingMeta>> = {
  adminUser: { default: 'admin', validate: stringMeta(1, 100) },
  adminPass: { default: '13141516', validate: passwordMeta(8, 200) },
  apiKeys: { default: [], validate: apiKeysMeta },
  scaleClientTokens: { default: false, validate: boolMeta },
  clientTokenScale: { default: 0.6657, validate: floatMeta(0.001, 1) },
  compactEnabled: { default: false, validate: boolMeta },
  compactTriggerBytes: { default: 4 * 1024 * 1024, validate: intMeta(1) },
  compactMaxMessageChars: { default: 8_000, validate: intMeta(1) },
};

/** 校验 + 规范化一个字段值（PATCH 端点与 db 解析共用）。未知键一律失败。 */
export function validateSetting(key: string, value: unknown): SettingValidation {
  const meta = SETTINGS_META[key];
  if (meta == null) return { ok: false, error: `unknown setting key: ${key}` };
  return meta.validate(value);
}

/**
 * 把 db 里存的字符串解析成类型化值（启动合并用）。db 存的是
 * JSON.stringify(规范化值)，坏数据（手工改库/格式漂移）解析失败返回 not ok，
 * 调用方记 warn 跳过该键，不阻塞其余配置。
 */
export function parseSettingValue(key: string, raw: string): SettingValidation {
  if (SETTINGS_META[key] == null) return { ok: false, error: `unknown setting key: ${key}` };
  try {
    return validateSetting(key, JSON.parse(raw));
  } catch {
    return { ok: false, error: `invalid stored value for ${key}` };
  }
}

/**
 * 原地应用一组已验证的值到 AppConfig。
 *
 * **apiKeys 是数组引用替换**（`cfg.apiKeys = keys`）而非原地 push/清空 ——
 * verifyAuth 每次读 cfg.apiKeys 拿的是当前引用，替换后新数组立即对全部
 * 请求生效；原地改数组则遍历中的请求可能看到半截状态（虽然后者概率也低，
 * 但引用替换是零成本的确定性做法）。其余字段是标量直接赋值。
 *
 * 调用方保证值已过 validateSetting/parseSettingValue；这里只做类型窄化，
 * 类型不对的值（不该发生）直接忽略。
 */
export function applySettingsToConfig(cfg: AppConfig, values: Record<string, unknown>): void {
  if (typeof values.adminUser === 'string') cfg.adminUser = values.adminUser;
  if (typeof values.adminPass === 'string') cfg.adminPass = values.adminPass;
  if (Array.isArray(values.apiKeys)) cfg.apiKeys = values.apiKeys as string[];
  if (typeof values.scaleClientTokens === 'boolean') cfg.scaleClientTokens = values.scaleClientTokens;
  if (typeof values.clientTokenScale === 'number') cfg.clientTokenScale = values.clientTokenScale;
  if (typeof values.compactEnabled === 'boolean') cfg.compactEnabled = values.compactEnabled;
  if (typeof values.compactTriggerBytes === 'number') cfg.compactTriggerBytes = values.compactTriggerBytes;
  if (typeof values.compactMaxMessageChars === 'number') cfg.compactMaxMessageChars = values.compactMaxMessageChars;
}

/**
 * settings 表读写。降级：db 不可用/查询失败 → get 返回 null、all 返回空、
 * set/delete 返回 false，绝不抛。与 modelmap.ts 同模式（sqlite 句柄由
 * UsageDb.sqlite() 暴露，不把 CRUD 堆进 usagedb）。
 */
export class SettingsStore {
  readonly enabled: boolean;
  /** sqlite 句柄（UsageDb.sqlite() 的类型是 any 出口，这里不重复写 any 关键字）。 */
  private raw: ReturnType<UsageDb['sqlite']> = null;

  constructor(db: UsageDb | null) {
    this.enabled = db != null && db.enabled;
    this.raw = db?.sqlite?.() ?? null;
  }

  /** 单个键的原始字符串；不存在/不可用/查询失败都返回 null。 */
  get(key: string): string | null {
    if (!this.enabled) return null;
    try {
      const row = this.raw.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row ? row.value : null;
    } catch (err) {
      console.warn(`[settings] 读取 ${key} 失败: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** 写入一个键（value 已是序列化字符串）。失败返回 false。 */
  set(key: string, value: string): boolean {
    if (!this.enabled) return false;
    try {
      this.raw
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, value, Date.now());
      return true;
    } catch (err) {
      console.warn(`[settings] 写入 ${key} 失败: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /**
   * 原子写入多个键（PATCH 多键更新用）。**事务保证全成或全败** —— 单键
   * autocommit 的部分写失败会让 db 与内存分叉（一次「失败」的 PATCH 静默
   * 改变重启后的配置，且 GET 的 value/source 自相矛盾）。任何一键失败
   * ROLLBACK 全部，返回 false，调用方不 apply 内存。
   */
  setMany(values: Record<string, string>): boolean {
    if (!this.enabled) return false;
    const keys = Object.keys(values);
    if (keys.length === 0) return true;
    try {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const stmt = this.raw.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        );
        for (const key of keys) {
          stmt.run(key, values[key]!, Date.now());
        }
        this.raw.exec('COMMIT');
        return true;
      } catch (err) {
        this.raw.exec('ROLLBACK');
        console.warn(`[settings] 批量写入失败（已回滚）: ${err instanceof Error ? err.message : err}`);
        return false;
      }
    } catch (err) {
      console.warn(`[settings] 批量写入失败（事务未开启）: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** 全部键 → 原始字符串。db 不可用/查询失败返回空对象。 */
  all(): Record<string, string> {
    if (!this.enabled) return {};
    try {
      const rows = this.raw.prepare('SELECT key, value FROM settings').all() as Array<Record<string, unknown>>;
      const out: Record<string, string> = {};
      for (const r of rows) {
        out[String(r.key)] = String(r.value);
      }
      return out;
    } catch (err) {
      console.warn(`[settings] 全量读取失败（返回空）: ${err instanceof Error ? err.message : err}`);
      return {};
    }
  }

  /** 删除一个键。删除不存在的行也返回 true（幂等）。失败返回 false。 */
  delete(key: string): boolean {
    if (!this.enabled) return false;
    try {
      this.raw.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return true;
    } catch (err) {
      console.warn(`[settings] 删除 ${key} 失败: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }
}
