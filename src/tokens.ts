/**
 * 分发密钥系统（tokens 表 + TokensStore）。
 *
 * 用途：网关可生成多个客户端用 key（走共享上游池，不绑定账号），管理端可
 * 增删改禁、按 token 看用量（请求数 / tokens / 上游记账费用）。
 *
 * # 安全设计：明文不落库，只存指纹
 *
 * - token 形如 `tk-` + 64 hex（32 字节随机，256-bit 熵）。
 * - 库里只存 `fingerprint = sha256(token)` 前 24 hex（96-bit，不可逆）。
 * - 校验 = 算客户端 token 的指纹 → 查表（active）→ 命中即放行，**全程无解密**。
 *   指纹 96-bit 下碰撞概率可忽略，且 fingerprint UNIQUE 约束兜底。
 * - token 明文**只在创建响应里出现一次**；此后管理端只能看到掩码
 *   （`tk-****` + 指纹末 8 位，可辨认不可逆推）。
 * - tokens 表的 token_enc 列按 DDL 保留但恒为 NULL（见 usagedb.ts 注释）。
 *
 * # 鉴权接线
 *
 * verifyAuth（security/auth.ts）在 API_KEYS 未命中后按 duck-typed TokenVerifier
 * 接口查这里 —— TokensStore 不可用（db 挂）时 verify 恒返回失败（fail-closed：
 * 分发 token 是放行通道，数据面故障时宁可不放行，也不做无校验放行）。
 *
 * # 用量口径
 *
 * 走分发 token 鉴权的请求在落库时带 token_fp（完整指纹），按它聚合请求数/
 * tokens/费用。费用直接取 requests.cost_micro_cents（上游 opencode 记账，
 * 1e8 microCents = $1）——**不自己定价**。
 */

import crypto from 'node:crypto';
import type { KeyFingerprintUsage, UsageDb } from './usagedb.js';
import type { SecretKey } from './secrets.js';

/** 一行分发 token（管理端展示用）。不含 token 明文。 */
export interface TokenRow {
  id: number;
  name: string;
  /** sha256(token) 前 24 hex（校验与用量聚合的键）。 */
  fingerprint: string;
  /** 展示掩码：`tk-****` + 指纹末 8 位。 */
  mask: string;
  status: 'active' | 'disabled';
  note: string | null;
  /** per-key RPM 限流（0 = 不限流；ratelimit.ts 的窗口按此判定）。 */
  rpmLimit: number;
  createdAt: number;
}

/** 生成结果：token 明文（仅此一次返回给调用方）。 */
export interface GeneratedToken {
  id: number;
  name: string;
  /** token 明文，**只在创建响应出现这一次**，此后无法再从任何接口取回。 */
  token: string;
  fingerprint: string;
  /** 掩码前缀（tk- 随机 / sk- 自定义等——指纹派生不出前缀，创建时记录）。 */
  prefix: string;
}

/** token 允许的状态。 */
export type TokenStatus = 'active' | 'disabled';

/** token 可更新字段（undefined = 不动）。 */
export interface TokenUpdate {
  name?: string;
  status?: TokenStatus;
  note?: string | null;
  /** per-key RPM 限流（0 = 不限流）。校验在端点层（非负整数）。 */
  rpmLimit?: number;
  /** 补录明文（老 token 创建时未存）：端点层先校验 sha256 匹配现有指纹，再加密落库。 */
  tokenPlain?: string | null;
}

/** 用量聚合的一行（来自 requests 表的 token_fp 分组）。 */
export interface TokenUsageRow {
  fingerprint: string;
  usage: KeyFingerprintUsage;
}

/** 新 token 的前缀（客户端可一眼认出，且不可能与 sk- 开头的上游 key 混淆）。 */
const TOKEN_PREFIX = 'tk-';

/** 指纹长度：sha256 hex 的前 24 字符 = 96-bit，碰撞概率可忽略。 */
const FINGERPRINT_HEX_LEN = 24;

/** 生成碰撞重试上限（fingerprint UNIQUE 冲突时重生成；概率上永远到不了）。 */
const CREATE_RETRY_LIMIT = 3;

/**
 * 生成一个分发 token：`tk-` + 32 字节随机 hex。
 * 返回 {token 明文, fingerprint}。明文只在创建时给调用方，调用方只允许
 * 在创建响应里回一次。
 */
export function generateToken(): { token: string; fingerprint: string } {
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
  return { token, fingerprint: fingerprintOf(token) };
}

/** token → 指纹（sha256 前 24 hex）。校验与聚合的唯一键。 */
export function fingerprintOf(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, FINGERPRINT_HEX_LEN);
}

/** 指纹 → 展示掩码（`<prefix>-****` + 末 8 位）。prefix 记录在 tokens 表
 * （创建时取 key 前 2 位：tk- 随机 / sk- 自定义等）——指纹派生不出前缀。 */
export function maskOf(fingerprint: string, prefix?: string | null): string {
  const p = prefix && /^[a-z0-9]{2}$/i.test(prefix) ? prefix : 'tk';
  return `${p}-****${fingerprint.slice(-8)}`;
}

/**
 * tokens 表读写。降级：db 不可用 → list 空、verify 恒失败（fail-closed）、
 * 写操作返回 false，绝不抛。与 modelmap.ts 同模式（sqlite 句柄由
 * UsageDb.sqlite() 暴露）。
 */
export class TokensStore {
  readonly enabled: boolean;
  /** sqlite 句柄（UsageDb.sqlite() 的类型是 any 出口，这里不重复写 any 关键字）。 */
  private raw: ReturnType<UsageDb['sqlite']> = null;
  /** 用量聚合走 UsageDb.tokenUsageAll（带 10s 缓存，面板轮询不能每次全表扫）。 */
  private readonly db: UsageDb | null;

  /** 明文加密封存用（同 accounts 的 SecretKey：aes-256-gcm，`1:...` 格式）。null = 密钥不可用。 */
  private readonly secret: SecretKey | null;

  constructor(db: UsageDb | null, secret: SecretKey | null = null) {
    this.enabled = db != null && db.enabled;
    this.raw = db?.sqlite?.() ?? null;
    this.db = db;
    this.secret = secret;
  }

  /** 解密 token 明文（管理面「查看/复制」用）。未存/密钥不可用/解密失败返回 null。 */
  plainOf(id: number): string | null {
    if (!this.enabled || !this.secret) return null;
    try {
      const row = this.raw.prepare('SELECT token_enc FROM tokens WHERE id = ?').get(id) as { token_enc: string | null } | undefined;
      if (!row || !row.token_enc) return null;
      return this.secret.decrypt(row.token_enc);
    } catch {
      return null;
    }
  }

  /** 全部 token（按 id 升序）。db 不可用/查询失败返回空列表。
   *  状态收敛方向与 verify 一致：只有字面 'active' 才算 active，其余（脏数据）
   *  一律显示 disabled —— 显示宽松而校验严格会出现「显示 active 却 401」的鬼影。 */
  list(): TokenRow[] {
    if (!this.enabled) return [];
    try {
      const rows = this.raw
        .prepare('SELECT id, name, fingerprint, status, note, prefix, rpm_limit, created_at FROM tokens ORDER BY id')
        .all() as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: Number(r.id),
        name: String(r.name),
        fingerprint: String(r.fingerprint),
        mask: maskOf(String(r.fingerprint), r.prefix != null ? String(r.prefix) : null),
        status: r.status === 'active' ? 'active' : 'disabled',
        note: r.note == null ? null : String(r.note),
        rpmLimit: Number(r.rpm_limit ?? 0),
        createdAt: Number(r.created_at),
      }));
    } catch (err) {
      console.warn(`[tokens] 列表查询失败（返回空）: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  /** 单个 token。不存在/不可用/查询失败返回 null。状态收敛同 list()。 */
  get(id: number): TokenRow | null {
    if (!this.enabled) return null;
    try {
      const row = this.raw
        .prepare('SELECT id, name, fingerprint, status, note, prefix, rpm_limit, created_at FROM tokens WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: Number(row.id),
        name: String(row.name),
        fingerprint: String(row.fingerprint),
        mask: maskOf(String(row.fingerprint), row.prefix != null ? String(row.prefix) : null),
        status: row.status === 'active' ? 'active' : 'disabled',
        note: row.note == null ? null : String(row.note),
        rpmLimit: Number(row.rpm_limit ?? 0),
        createdAt: Number(row.created_at),
      };
    } catch (err) {
      console.warn(`[tokens] 查询失败（id=${id}）: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * 创建分发 token。name/note 的字段校验在端点层（server.ts）完成，
   * 这里只做存储语义。fingerprint UNIQUE 冲突（概率可忽略）时重生成重试。
   */
  create(
    name: string,
    note: string | null,
    customKey?: string | null,
  ): { ok: true; value: GeneratedToken } | { ok: false } {
    if (!this.enabled) return { ok: false };
    if (customKey != null && customKey.trim() !== '') {
      // 自定义 key 值（用户提供，如 sk-dwgxnbnb）：指纹存储同随机，明文不落库。
      const key = customKey.trim();
      const fingerprint = fingerprintOf(key);
      const prefix = key.slice(0, 2).toLowerCase();
      const enc = this.secret ? this.secret.encrypt(key) : null;
      try {
        const res = this.raw
          .prepare('INSERT INTO tokens (name, token_enc, fingerprint, status, note, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(name, enc, fingerprint, 'active', note, prefix, Date.now());
        return { ok: true, value: { id: Number(res.lastInsertRowid), name, token: key, fingerprint, prefix } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/UNIQUE constraint failed/.test(msg)) {
          return { ok: false }; // 该自定义 key 已存在（指纹碰撞）
        }
        console.warn(`[tokens] 自定义 key 创建失败: ${msg}`);
        return { ok: false };
      }
    }
    for (let attempt = 0; attempt < CREATE_RETRY_LIMIT; attempt++) {
      const { token, fingerprint } = generateToken();
      const enc = this.secret ? this.secret.encrypt(token) : null;
      try {
        const res = this.raw
          .prepare('INSERT INTO tokens (name, token_enc, fingerprint, status, note, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(name, enc, fingerprint, 'active', note, 'tk', Date.now());
        return { ok: true, value: { id: Number(res.lastInsertRowid), name, token, fingerprint, prefix: 'tk' } };
      } catch (err) {
        // UNIQUE 冲突（指纹碰撞）重试；其余错误（表损坏等）直接失败。
        const msg = err instanceof Error ? err.message : String(err);
        if (!/UNIQUE constraint failed/.test(msg)) {
          console.warn(`[tokens] 创建失败: ${msg}`);
          return { ok: false };
        }
      }
    }
    console.warn(`[tokens] 创建失败：指纹碰撞超过 ${CREATE_RETRY_LIMIT} 次（不应发生）`);
    return { ok: false };
  }

  /**
   * 部分更新。undefined 的字段不动。返回：
   * - 'ok'：更新成功
   * - 'missing'：id 不存在（调用方回 404）
   * - false：查询失败（调用方回 500）
   */
  update(id: number, patch: TokenUpdate): 'ok' | 'missing' | false {
    if (!this.enabled) return false;
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      vals.push(patch.name);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      vals.push(patch.status);
    }
    if (patch.note !== undefined) {
      sets.push('note = ?');
      vals.push(patch.note);
    }
    if (patch.rpmLimit !== undefined) {
      sets.push('rpm_limit = ?');
      vals.push(patch.rpmLimit);
    }
    if (patch.tokenPlain !== undefined) {
      // 补录明文：端点层已校验指纹匹配；这里加密落库（密钥不可用则存 null 并提示）。
      sets.push('token_enc = ?');
      vals.push(patch.tokenPlain === null ? null : (this.secret ? this.secret.encrypt(patch.tokenPlain) : null));
    }
    if (sets.length === 0) return this.get(id) != null ? 'ok' : 'missing';
    try {
      // 先验存在性再 UPDATE：SQLite 的 changes 只统计值实际被改的行，
      // 对不存在的 id 更新 0 行会被误判为成功（与 updateAccount 同一思路）。
      if (!this.raw.prepare('SELECT 1 FROM tokens WHERE id = ?').get(id)) return 'missing';
      vals.push(id);
      this.raw.prepare(`UPDATE tokens SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return 'ok';
    } catch (err) {
      console.warn(`[tokens] 更新失败（id=${id}）: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** 删除。删除不存在/已删的行也返回 true（幂等，与 deleteAccount 同口径）。 */
  delete(id: number): boolean {
    if (!this.enabled) return false;
    try {
      this.raw.prepare('DELETE FROM tokens WHERE id = ?').run(id);
      return true;
    } catch (err) {
      console.warn(`[tokens] 删除失败（id=${id}）: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /**
   * 取某个分发 token 的 rpm_limit（per-key 请求频率上限，0 = 不限流）。
   * 数据面入口每次请求都查一次 —— fingerprint UNIQUE 索引，一次点查。
   * 校验路径在 endpoints 层做，这里只做存储语义：非正数统一归一 0
   * （脏数据不产生「负数限流」这类意外行为）。
   */
  getRpmLimit(fingerprint: string): number {
    if (!this.enabled) return 0;
    try {
      const row = this.raw
        .prepare('SELECT rpm_limit FROM tokens WHERE fingerprint = ?')
        .get(fingerprint) as { rpm_limit?: unknown } | undefined;
      const n = Number(row?.rpm_limit);
      return Number.isInteger(n) && n > 0 ? n : 0;
    } catch (err) {
      console.warn(`[tokens] rpm_limit 查询失败（按不限流处理）: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  /**
   * 校验客户端 token：算指纹 → 查表（存在且 active）→ 命中返回指纹。
   * **全程无解密**；db 不可用恒返回失败（fail-closed）。
   */
  verify(token: string): { ok: true; fingerprint: string } | { ok: false } {
    if (!this.enabled) return { ok: false };
    const fingerprint = fingerprintOf(token);
    try {
      const row = this.raw
        .prepare("SELECT status FROM tokens WHERE fingerprint = ? AND status = 'active'")
        .get(fingerprint) as { status: string } | undefined;
      return row ? { ok: true, fingerprint } : { ok: false };
    } catch (err) {
      console.warn(`[tokens] 校验查询失败: ${err instanceof Error ? err.message : err}`);
      return { ok: false };
    }
  }

  /**
   * 全量用量聚合（requests 表按 token_fp 分组，含已删除 token 的历史）。
   * db 不可用/失败返回空数组。费用口径 = 上游 cost_micro_cents（opencode 记账，
   * 1e8 microCents = $1）——不自己定价。
   */
  usage(): TokenUsageRow[] {
    const map = this.db?.tokenUsageAll() ?? new Map<string, KeyFingerprintUsage>();
    return [...map.entries()].map(([fingerprint, usage]) => ({ fingerprint, usage }));
  }
}
