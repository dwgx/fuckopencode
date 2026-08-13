/**
 * 多账号面板的数据层（MULTI-ACCOUNT.md §3.3 / §7）。
 *
 * 职责：账户 CRUD 的加密落库、给 keypool 构造提供「明文 key → accountId」映射、
 * 探针/billing 结果写账、以及 `/__metrics` 与 `/__admin` 共用的
 * `buildAccountsSection` 快照组装。
 *
 * 隐私口径：key/cookie 明文只存在于进程内（加密落盘、按需解密、用完即弃），
 * 任何导出给 HTTP 层的数据（list/get/buildAccountsSection）都不含明文。
 * 返回明文的方法只有三个，且全部注明「进程内使用」：keysForPool（池构造）、
 * remove/removeKey（pool 热移除必须按原文匹配）、cookieOf/keysOf（探针/billing）。
 */

import { stripControl } from './errors.js';
import { keyFingerprint } from './keypool.js';
import type { KeyPool, PoolKeySnapshot, UpstreamFailureKind } from './keypool.js';
import type { SecretKey } from './secrets.js';
import type { AccountRow, AccountUpdate, UsageDb } from './usagedb.js';
import type { AppConfig } from './config.js';

/** 账户类型。`unknown` 时探针默认打订阅端点（MULTI-ACCOUNT.md §4.4）。 */
export type AccountKind = 'subscription' | 'payg' | 'unknown';

/** 账户状态枚举（MULTI-ACCOUNT.md §4.1）。只由探针写入，TS 侧收敛。 */
export type AccountStatus =
  | 'unknown'
  | 'ok'
  | 'invalid'
  | 'insufficient'
  | 'limit'
  | 'cooldown'
  | 'region'
  | 'error';

/** 对外账户视图。**绝不含 key/cookie 明文**，只给解密后的数量。 */
export interface AccountView {
  id: number;
  name: string;
  kind: string;
  workspaceId: string | null;
  /** 旧版控制台（opencode.ai，wrk_ 前缀）workspace id；未配置 null。 */
  legacyWorkspaceId: string | null;
  status: AccountStatus;
  statusDetail: string | null;
  retryUntil: number;
  lastProbeAt: number;
  lastBillingAt: number;
  balanceUnits: number | null;
  monthlyLimitUnits: number | null;
  monthlyUsageUnits: number | null;
  createdAt: number;
  /** 解密后的 key 数量（明文本身不外发）。 */
  keyCount: number;
  /** 账号级模型白名单；null = 未配置（用全局白名单）。 */
  allowedModels: string[] | null;
}

/** 管理面可更新字段（§6.3 PATCH）。cookie 传 null = 清除。 */
export interface AccountPatch {
  name?: string;
  kind?: AccountKind;
  workspaceId?: string | null;
  legacyWorkspaceId?: string | null;
  cookie?: string | null;
  legacyCookie?: string | null;
  /** 账号级模型白名单；null/空数组 = 清除（退回全局白名单）。 */
  allowedModels?: string[] | null;
}

/** buildAccountsSection 的输出（§6.2 JSON 契约）。 */
export interface AccountsSection {
  /** 数据面不可用时的分类原因；正常为 null。 */
  degraded: string | null;
  list: AccountSectionItem[];
}

export interface AccountSectionItem {
  id: number;
  name: string;
  kind: string;
  status: AccountStatus;
  statusDetail: string | null;
  retryUntil: number;
  retryInMs: number;
  lastProbeAt: number;
  /** 新版控制台（console.opencode.ai，org_ 前缀）workspace id；未配置 null。 */
  workspaceId: string | null;
  /** 旧版控制台（opencode.ai，wrk_ 前缀）workspace id；未配置 null。 */
  legacyWorkspaceId: string | null;
  /** 控制台凭据（cookie 或 OAuth）是否存在。 */
  hasConsole: boolean;
  balance: number | null;
  monthlyLimit: number | null;
  monthlyUsage: number | null;
  monthlyPercent: number | null;
  lastBillingAt: number;
  /** 账号级模型白名单；null = 未配置（用全局白名单）。 */
  allowedModels: string[] | null;
  /** 该账户的 key 卡片（来自 pool 快照，服务端组装，不解密任何东西）。 */
  keys: AccountKeyView[];
}

/** 单个 key 的展示字段（§6.2 示例省略了 failCount/totalAcquired）。 */
export interface AccountKeyView {
  fingerprint: string;
  healthy: boolean;
  inFlight: number;
  disabledReason?: UpstreamFailureKind;
  recoverInMs: number;
  lastUsedAt: number;
  /** key 昵称（面板显示/编辑用）；未命名 null。 */
  nickname: string | null;
}

/**
 * keys_enc 解密后的内部统一表示（对象数组）。
 *
 * 兼容两种落盘形态（旧数据首次写入自动升级）：
 * - 旧：字符串 `"sk-xxx"`（读时转 `{ key, nickname: null }`）
 * - 新：对象 `{"key":"sk-xxx","nickname":"主力号-1"}`
 */
export interface StoredKey {
  key: string;
  nickname: string | null;
}

/**
 * key 写入失败的细分（create/addKey 共用）。reason 语义：
 * - `unavailable`：数据面降级（db/密钥不可用）。
 * - `duplicate`：同一账户内已存在同名 key（仅 addKey 会出现）。
 * - `conflict`：key 已属于**其他**账户 —— 跨账户唯一性（m6）。
 * - `failed`：账户不存在 / 解密损坏 / 落库失败。
 * `conflict` 带归属账户名，供管理面转 400 时说明「key 已属于账户 X」。
 */
export type KeyWriteFailure =
  | { ok: false; reason: 'unavailable' | 'duplicate' | 'failed' }
  | { ok: false; reason: 'conflict'; ownerName: string };

/** create 的结果：成功带新账户视图，失败带细分原因。 */
export type CreateAccountResult =
  | { ok: true; value: AccountView }
  | { ok: false; reason: 'unavailable' | 'failed' }
  | { ok: false; reason: 'conflict'; ownerName: string };

/** addKey 的结果。 */
export type AddKeyResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'duplicate' | 'failed' }
  | { ok: false; reason: 'conflict'; ownerName: string };

export class AccountsStore {
  /** 数据面是否可用（db 可用 && 密钥可用）。false = 全部方法 no-op 降级。 */
  readonly enabled: boolean;
  /** 降级原因（面板「degraded」字段的数据源）。 */
  readonly disabledReason: string | null;
  private readonly log: (msg: string) => void;
  /**
   * 账号级模型白名单的内存缓存。选号过滤（postUpstreamChat 的 isEligible）是
   * 每请求热路径，node:sqlite 同步读每请求一次不可接受 —— 首次读 db，之后走
   * 缓存；setAllowedModels/update/remove 同步更新。启动后首次请求前自动填充。
   */
  private allowedCache = new Map<number, string[] | null>();

  constructor(
    private readonly db: UsageDb,
    private readonly secret: SecretKey | null,
    cfg: AppConfig,
    log: (msg: string) => void = (m) => console.warn(m),
  ) {
    this.log = log;
    // 两条降级路径（MULTI-ACCOUNT.md §2.3）：db 不可用 / 密钥不可用。
    this.enabled = db.enabled && secret != null;
    this.disabledReason = db.enabled
      ? secret == null
        ? 'secret unavailable'
        : null
      : db.disabledReason;
    // §3.3 种子：构造器内一次（db 可用 && 表空 && env keys 非空）。
    if (this.enabled) this.seedFromEnv(cfg.upstreamKeys);
  }

  /**
   * env keys 种子：表空时插入 `{ name: 'env', kind: 'unknown' }` 一条。
   * 只在表空时种（用户删光全部账户后重启可恢复；留着其他账户则尊重用户操作）。
   * 查询失败视为非空（保守，不覆盖已有数据）。
   */
  seedFromEnv(upstreamKeys: string[]): boolean {
    const secret = this.secret;
    if (!this.enabled || !secret) return false;
    if (upstreamKeys.length === 0) return false;
    const existing = this.db.listAccounts();
    if (!existing || existing.length > 0) return false;
    const id = this.db.insertAccount({
      name: 'env',
      kind: 'unknown',
      workspaceId: null,
      // 统一写对象数组（nickname 初始 null），与 addKey 等写回格式一致。
      keysEnc: secret.encrypt(JSON.stringify(upstreamKeys.map((k) => ({ key: k, nickname: null })))),
      cookieEnc: null,
    });
    if (id === false) return false;
    this.log(`[accounts] 已从 env keys 种子默认账户（${upstreamKeys.length} 个 key）`);
    return true;
  }

  /** 全部账户视图（无明文）。降级时返回空数组。 */
  list(): AccountView[] {
    if (!this.enabled) return [];
    const rows = this.db.listAccounts();
    if (!rows) return [];
    return rows.map((r) => this.toView(r));
  }

  /** 单个账户视图。不存在/降级返回 null。 */
  get(id: number): AccountView | null {
    if (!this.enabled) return null;
    const row = this.db.getAccount(id);
    return row ? this.toView(row) : null;
  }

  /**
   * 创建账户（加密落盘）。成功返回新账户视图；失败返回细分原因。
   * m6：任一 key 已属于其他账户 → `conflict`，不落盘 —— 否则 pool 按 key 去重
   * 时归属落在先入者，后入账户面板 keys 空但 keyCount 非零，删先入账户还会
   * 连坐杀掉后入的 key（状态错位）。
   */
  create(input: {
    name: string;
    kind: AccountKind;
    workspaceId: string | null;
    keys: string[];
    cookie: string | null;
  }): CreateAccountResult {
    const secret = this.secret;
    if (!this.enabled || !secret) return { ok: false, reason: 'unavailable' };
    for (const key of input.keys) {
      const owner = this.keyOwner(key, -1);
      if (owner) return { ok: false, reason: 'conflict', ownerName: owner.name };
    }
    const id = this.db.insertAccount({
      name: input.name,
      kind: input.kind,
      workspaceId: input.workspaceId,
      keysEnc: secret.encrypt(JSON.stringify(input.keys.map((k) => ({ key: k, nickname: null })))),
      cookieEnc: input.cookie ? secret.encrypt(input.cookie) : null,
    });
    if (id === false) return { ok: false, reason: 'failed' };
    const row = this.db.getAccount(id);
    return row ? { ok: true, value: this.toView(row) } : { ok: false, reason: 'failed' };
  }

  /**
   * 部分更新（§6.3 PATCH）：undefined 不更新，cookie 传 null = 清除。
   * 账户不存在返回 false。
   */
  update(id: number, patch: AccountPatch): boolean {
    const secret = this.secret;
    if (!this.enabled || !secret) return false;
    if (!this.db.getAccount(id)) return false;
    const dbPatch: AccountUpdate = {};
    if (patch.name !== undefined) dbPatch.name = patch.name;
    if (patch.kind !== undefined) dbPatch.kind = patch.kind;
    if (patch.workspaceId !== undefined) dbPatch.workspaceId = patch.workspaceId;
    if (patch.legacyWorkspaceId !== undefined) dbPatch.legacyWorkspaceId = patch.legacyWorkspaceId;
    if (patch.cookie !== undefined) {
      // cookie 只能整体替换：空串/null 都是清除，非空才加密。
      dbPatch.cookieEnc = patch.cookie === null || patch.cookie === '' ? null : secret.encrypt(patch.cookie);
    }
    if (patch.allowedModels !== undefined) {
      // 空数组 = 清除（与 null 同语义，退回全局白名单）；非空去空去重后落库。
      dbPatch.allowedModels =
        patch.allowedModels == null || patch.allowedModels.length === 0
          ? null
          : [...new Set(patch.allowedModels.map((m) => m.trim()).filter(Boolean))];
    }
    const ok = this.db.updateAccount(id, dbPatch);
    if (ok) this.allowedCache.set(id, dbPatch.allowedModels ?? null);
    return ok;
  }

  /**
   * 删除账户，返回被删账户的明文 keys（供调用方从 pool 热移除）。
   * 失败/不存在返回 null。明文只在进程内流转，绝不进响应/日志。
   */
  remove(id: number): string[] | null {
    if (!this.enabled) return null;
    const row = this.db.getAccount(id);
    if (!row) return null;
    if (!this.db.deleteAccount(id)) return null;
    this.allowedCache.delete(id);
    return this.decryptKeys(row) ?? [];
  }

  /**
   * 明文 key → accountId 映射，喂 KeyPool 构造第三参数（MULTI-ACCOUNT.md §3.1）。
   * 解密失败/损坏的条目跳过（log），绝不让坏数据拖垮池构造。**进程内使用。**
   */
  keysForPool(): Map<string, number> {
    const out = new Map<string, number>();
    if (!this.enabled) return out;
    for (const row of this.db.listAccounts() ?? []) {
      for (const key of this.decryptKeys(row) ?? []) {
        // 同一 key 出现在多个账户时取第一个（id 升序）—— 与 KeyPool 构造的
        // seen 去重语义一致（MULTI-ACCOUNT.md §3.1「accountId 取第一个命中」）。
        if (!out.has(key)) out.set(key, row.id);
      }
    }
    return out;
  }

  /** 加一个 key（加密落盘）。同一账户内已存在 → duplicate；已属他户 → conflict（m6）。 */
  addKey(id: number, key: string): AddKeyResult {
    const secret = this.secret;
    if (!this.enabled || !secret) return { ok: false, reason: 'unavailable' };
    const row = this.db.getAccount(id);
    if (!row) return { ok: false, reason: 'failed' };
    const keys = this.decryptStoredKeys(row);
    // 解密失败（损坏）时拒绝写入而不是拿 [key] 覆盖 —— 覆盖会静默丢原有 key。
    if (keys === null) return { ok: false, reason: 'failed' };
    if (keys.some((k) => k.key === key)) return { ok: false, reason: 'duplicate' };
    const owner = this.keyOwner(key, id);
    if (owner) return { ok: false, reason: 'conflict', ownerName: owner.name };
    keys.push({ key, nickname: null });
    return this.db.updateAccount(id, { keysEnc: secret.encrypt(JSON.stringify(keys)) })
      ? { ok: true }
      : { ok: false, reason: 'failed' };
  }

  /**
   * 按指纹删 key（匹配账户内第一个，§6.3）。返回被删的明文 key（供 pool
   * 热移除）；不存在/失败返回 null。**进程内使用。**
   */
  removeKey(id: number, fingerprint: string): string | null {
    const secret = this.secret;
    if (!this.enabled || !secret) return null;
    const row = this.db.getAccount(id);
    if (!row) return null;
    const keys = this.decryptStoredKeys(row);
    if (keys === null) return null;
    const idx = keys.findIndex((k) => keyFingerprint(k.key) === fingerprint);
    if (idx < 0) return null;
    const removed = keys[idx]!.key;
    keys.splice(idx, 1);
    if (!this.db.updateAccount(id, { keysEnc: secret.encrypt(JSON.stringify(keys)) })) return null;
    return removed;
  }

  /**
   * 进程内查 key 昵称（按明文 key 精确匹配）。无此 key / 解密失败 / 降级 → null。
   * **进程内使用**（key 明文只作匹配用，不外发）。
   */
  keyNickname(id: number, key: string): string | null {
    if (!this.enabled) return null;
    const keys = this.decryptStoredKeys(this.db.getAccount(id));
    if (keys === null) return null;
    return keys.find((k) => k.key === key)?.nickname ?? null;
  }

  /**
   * 设置 key 昵称（按明文 key 匹配）。昵称为空串/null = 清除；成功 true，失败
   * （账户不存在 / key 不存在 / 解密失败拒绝覆盖 / 落库失败 / 降级）false。
   * 写回统一走对象数组：旧字符串格式的账户在此首次写入时自动升级。
   */
  setKeyNickname(id: number, key: string, nickname: string | null): boolean {
    const secret = this.secret;
    if (!this.enabled || !secret) return false;
    const row = this.db.getAccount(id);
    if (!row) return false;
    const keys = this.decryptStoredKeys(row);
    if (keys === null) return false;
    const hit = keys.find((k) => k.key === key);
    if (!hit) return false;
    // 单点清洗：与 setProbeResult 同口径（stripControl + 截断 100），防控制符注入。
    const clean = nickname == null || nickname === '' ? null : stripControl(nickname).slice(0, 100);
    if (hit.nickname === clean) return true; // 无变化：幂等成功，不落库
    hit.nickname = clean;
    return this.db.updateAccount(id, { keysEnc: secret.encrypt(JSON.stringify(keys)) });
  }

  /** fingerprint → nickname 映射（buildAccountsSection 组装用，不流转明文 key）。 */
  keyNicknameMap(id: number): Map<string, string | null> {
    const out = new Map<string, string | null>();
    if (!this.enabled) return out;
    const keys = this.decryptStoredKeys(this.db.getAccount(id));
    if (keys === null) return out;
    for (const k of keys) {
      // 指纹碰撞（末 4 位相同）时取第一个 —— 与 removeKey 按指纹匹配的语义一致。
      const fp = keyFingerprint(k.key);
      if (!out.has(fp)) out.set(fp, k.nickname);
    }
    return out;
  }

  /** 探针结果写账（§4.4）。detail 在这里统一 stripControl + 截断 200。 */
  setProbeResult(
    id: number,
    result: { status: AccountStatus; detail: string | null; retryUntil: number; lastProbeAt: number },
  ): boolean {
    if (!this.enabled) return false;
    // 单点清洗：所有写 status_detail 的路径都过这里，防控制符伪造/超长入库。
    const detail = result.detail == null ? null : stripControl(result.detail).slice(0, 200);
    return this.db.updateAccount(id, {
      status: result.status,
      statusDetail: detail,
      retryUntil: result.retryUntil,
      lastProbeAt: result.lastProbeAt,
    });
  }

  /** billing 结果写账（§5.4）。undefined 字段保持旧值，at 恒写入 lastBillingAt。 */
  setBilling(
    id: number,
    result: {
      balanceUnits?: number | null;
      monthlyLimitUnits?: number | null;
      monthlyUsageUnits?: number | null;
      at: number;
    },
  ): boolean {
    if (!this.enabled) return false;
    const patch: AccountUpdate = { lastBillingAt: result.at };
    if (result.balanceUnits !== undefined) patch.balanceUnits = result.balanceUnits;
    if (result.monthlyLimitUnits !== undefined) patch.monthlyLimitUnits = result.monthlyLimitUnits;
    if (result.monthlyUsageUnits !== undefined) patch.monthlyUsageUnits = result.monthlyUsageUnits;
    return this.db.updateAccount(id, patch);
  }

  /** workspace id（billing 抓取用）。无/不存在返回 null。 */
  workspaceIdOf(id: number): string | null {
    if (!this.enabled) return null;
    return this.db.getAccount(id)?.workspaceId ?? null;
  }

  /**
   * 账号级模型白名单（选号过滤热路径读这个缓存）。null/空 = 不限制（退回
   * 全局白名单）。首次读 db 后进缓存，之后不再碰同步 sqlite。
   */
  allowedModelsOf(id: number): string[] | null {
    if (!this.enabled) return null;
    if (this.allowedCache.has(id)) return this.allowedCache.get(id) ?? null;
    const val = this.db.getAccount(id)?.allowedModels ?? null;
    this.allowedCache.set(id, val);
    return val;
  }

  /**
   * 设置账号级模型白名单（落库 + 内存缓存热生效）。null/空数组 = 清除
   * （退回全局白名单）。非空去空去重后精确匹配（大小写不敏感在配置侧收敛）。
   * 账户不存在/降级/落库失败返回 false。
   */
  setAllowedModels(id: number, models: string[] | null): boolean {
    if (!this.enabled) return false;
    if (!this.db.getAccount(id)) return false;
    const clean =
      models == null || models.length === 0
        ? null
        : [...new Set(models.map((m) => m.trim()).filter(Boolean))];
    if (!this.db.updateAccount(id, { allowedModels: clean })) return false;
    this.allowedCache.set(id, clean);
    return true;
  }

  /** 旧版控制台 workspace id（wrk_ 前缀，legacy 通道用）。无/不存在返回 null。 */
  legacyWorkspaceIdOf(id: number): string | null {
    if (!this.enabled) return null;
    return this.db.getAccount(id)?.legacyWorkspaceId ?? null;
  }

  /** 设置旧版控制台 workspace id。传 null/空串 = 清除。账户不存在返回 false。 */
  setLegacyWorkspaceId(id: number, workspaceId: string | null): boolean {
    if (!this.enabled) return false;
    if (!this.db.getAccount(id)) return false;
    const clean = workspaceId == null || workspaceId.trim() === '' ? null : workspaceId.trim();
    return this.db.updateAccount(id, { legacyWorkspaceId: clean });
  }

  /** 解密 cookie 明文（billing 抓取用）。无 cookie/解密失败返回 null。**进程内使用。** */
  cookieOf(id: number): string | null {
    const secret = this.secret;
    if (!this.enabled || !secret) return null;
    const row = this.db.getAccount(id);
    if (!row || !row.cookieEnc) return null;
    return secret.decrypt(row.cookieEnc);
  }

  /** 旧版控制台（opencode.ai）独立会话 cookie（M1：与主 cookie 槽互斥的槽位）。
   *  有则 legacy 通道用它；无则回落主 cookie。解密失败/未接线返回 null。 */
  legacyCookieOf(id: number): string | null {
    const secret = this.secret;
    if (!this.enabled || !secret) return null;
    const row = this.db.getAccount(id);
    if (!row || !row.legacyCookieEnc) return null;
    return secret.decrypt(row.legacyCookieEnc);
  }

  /** 写旧版 cookie（明文进、加密落库）；null/空串清除。 */
  setLegacyCookie(id: number, cookie: string | null): boolean {
    const secret = this.secret;
    if (!this.enabled || !secret || this.db.getAccount(id) == null) return false;
    const enc = cookie == null || cookie === '' ? null : secret.encrypt(cookie);
    return this.db.updateAccount(id, { legacyCookieEnc: enc } as never);
  }

  /**
   * 写 OAuth refresh_token：明文进、加密落库（`1:` 格式）。token 传 null = 清除。
   * 仅 OAuth device flow 调用：poll 成功后 refresh_token 从内存直接落库随即弃用；
   * access_token 从不落库（一次性换 /api/orgs 用）。账户不存在返回 false。
   */
  setOauthRefresh(id: number, token: string | null): boolean {
    const secret = this.secret;
    if (!this.enabled || !secret) return false;
    if (!this.db.getAccount(id)) return false;
    const enc = token == null ? null : secret.encrypt(token);
    return this.db.updateAccount(id, { oauthRefreshEnc: enc });
  }

  /** 解密 OAuth refresh_token 明文。无 token/解密失败返回 null。**进程内使用。** */
  getOauthRefresh(id: number): string | null {
    const secret = this.secret;
    if (!this.enabled || !secret) return null;
    const row = this.db.getAccount(id);
    if (!row || !row.oauthRefreshEnc) return null;
    return secret.decrypt(row.oauthRefreshEnc);
  }

  /** 解密账户 keys 明文（探针代表 key 用，MULTI-ACCOUNT.md §4.4）。**进程内使用。** */
  keysOf(id: number): string[] | null {
    if (!this.enabled) return null;
    const row = this.db.getAccount(id);
    if (!row) return null;
    return this.decryptKeys(row);
  }

  private toView(row: AccountRow): AccountView {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      workspaceId: row.workspaceId,
      legacyWorkspaceId: row.legacyWorkspaceId,
      status: row.status as AccountStatus,
      statusDetail: row.statusDetail,
      retryUntil: row.retryUntil,
      lastProbeAt: row.lastProbeAt,
      lastBillingAt: row.lastBillingAt,
      balanceUnits: row.balanceUnits,
      monthlyLimitUnits: row.monthlyLimitUnits,
      monthlyUsageUnits: row.monthlyUsageUnits,
      createdAt: row.createdAt,
      keyCount: this.decryptKeys(row)?.length ?? 0,
      allowedModels: row.allowedModels,
    };
  }

  /**
   * 明文 key 当前归属的账户（跳过 skipId；addKey 检查本账户时传自身 id）。
   * 跨账户扫描：解密失败/损坏的行跳过，绝不让坏数据阻断判断。
   * 进程内使用（key 明文只在内存流转）。
   */
  private keyOwner(key: string, skipId: number): AccountRow | null {
    for (const row of this.db.listAccounts() ?? []) {
      if (row.id === skipId) continue;
      const keys = this.decryptKeys(row);
      if (keys === null) continue;
      if (keys.includes(key)) return row;
    }
    return null;
  }

  /**
   * 解密 keys_enc（整体一个密文串：encrypt(JSON.stringify(keys))，见 §1.2）。
   * 解密或结构损坏返回 null（调用方拒绝覆盖写入）。
   * 内部统一为对象数组（旧字符串条目转 {key, nickname:null}），返回明文 key 列表。
   */
  private decryptKeys(row: AccountRow): string[] | null {
    return this.decryptStoredKeys(row)?.map((k) => k.key) ?? null;
  }

  /**
   * 解密 keys_enc 并解析为对象数组。兼容两种条目形态：
   * - 字符串 → `{ key, nickname: null }`（旧格式）
   * - 对象 → 取 key（必须是字符串）与 nickname（非字符串昵称视为 null）
   * 解密失败 / 非 JSON / 非数组返回 null；坏条目（非字符串非对象、key 缺失）跳过。
   */
  private decryptStoredKeys(row: AccountRow | null | undefined): StoredKey[] | null {
    const secret = this.secret;
    if (!secret || !row) return null;
    const plain = secret.decrypt(row.keysEnc);
    if (plain === null) {
      this.log(`[accounts] 账户 ${row.id} keys_enc 解密失败，已跳过`);
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(plain);
    } catch {
      this.log(`[accounts] 账户 ${row.id} keys_enc 解密后不是合法 JSON，已跳过`);
      return null;
    }
    if (!Array.isArray(raw)) {
      this.log(`[accounts] 账户 ${row.id} keys_enc 不是数组，已跳过`);
      return null;
    }
    const out: StoredKey[] = [];
    for (const item of raw) {
      if (typeof item === 'string') {
        out.push({ key: item, nickname: null });
      } else if (item != null && typeof item === 'object') {
        const key = (item as { key?: unknown }).key;
        if (typeof key !== 'string') continue;
        const nick = (item as { nickname?: unknown }).nickname;
        out.push({ key, nickname: typeof nick === 'string' ? nick : null });
      }
    }
    return out;
  }
}

/**
 * 组装 `/__metrics` 与 `/__admin/api/accounts` 共用的 accounts 段（§6.2）。
 * 两份输出共用这一个函数，防止结构漂移。
 *
 * keys 来自 `pool.snapshot()` 按 accountId 过滤 —— 服务端组装，不解密任何东西
 * （§3.1 约定：accountId 0 = 未归属，永远不会命中任何账户行，天然被滤掉）。
 */
export function buildAccountsSection(store: AccountsStore, pool: KeyPool, now: number): AccountsSection {
  if (!store.enabled) {
    return { degraded: store.disabledReason, list: [] };
  }
  const snap = pool.snapshot();
  const list: AccountSectionItem[] = store.list().map((acc) => {
    // nickname 由 store 解密映射（fingerprint → nickname），不外发明文 key。
    const nicknames = store.keyNicknameMap(acc.id);
    return {
      id: acc.id,
      name: acc.name,
      kind: acc.kind,
      status: acc.status,
      statusDetail: acc.statusDetail,
      retryUntil: acc.retryUntil,
      retryInMs: Math.max(0, acc.retryUntil - now),
      lastProbeAt: acc.lastProbeAt,
      workspaceId: acc.workspaceId,
      legacyWorkspaceId: acc.legacyWorkspaceId,
      // 控制台凭据是否存在（cookie 或 OAuth refresh）——前端用它区分
      // 「未接入（无凭据）」vs「已连接待同步（有凭据但余额还没抓到）」。
      hasConsole: store.cookieOf(acc.id) != null || store.getOauthRefresh(acc.id) != null,
      // 库内全程整数 units（1e8 = $1），API 层以美元两位小数呈现（§6.2）。
      balance: acc.balanceUnits == null ? null : Number((acc.balanceUnits / 1e8).toFixed(2)),
      monthlyLimit: acc.monthlyLimitUnits == null ? null : Number((acc.monthlyLimitUnits / 1e8).toFixed(2)),
      monthlyUsage: acc.monthlyUsageUnits == null ? null : Number((acc.monthlyUsageUnits / 1e8).toFixed(2)),
      monthlyPercent:
        acc.monthlyLimitUnits == null || acc.monthlyLimitUnits <= 0 || acc.monthlyUsageUnits == null
          ? null
          : Number(((acc.monthlyUsageUnits / acc.monthlyLimitUnits) * 100).toFixed(1)),
      lastBillingAt: acc.lastBillingAt,
      allowedModels: acc.allowedModels,
      keys: snap
        .filter((k) => k.accountId === acc.id)
        .map((k) => ({
          fingerprint: k.fingerprint,
          healthy: k.healthy,
          inFlight: k.inFlight,
          // 健康的 key 不带原因/倒计时（沿用 PoolKeySnapshot 既有约定）。
          ...(k.healthy ? {} : { disabledReason: k.disabledReason }),
          recoverInMs: k.recoverInMs,
          lastUsedAt: k.lastUsedAt,
          nickname: nicknames.get(k.fingerprint) ?? null,
        })),
    };
  });
  return { degraded: null, list };
}
