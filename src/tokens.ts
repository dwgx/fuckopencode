/**
 * 分发密钥系统（tokens 表 + TokensStore）。
 *
 * 用途：网关可生成多个客户端用 key（走共享上游池，不绑定账号），管理端可
 * 增删改禁、按 token 看用量（请求数 / tokens / 上游记账费用）。
 *
 * # 安全设计：校验靠指纹，明文加密供面板取回
 *
 * - token 形如 `tk-` + 64 hex（32 字节随机，256-bit 熵），或用户自定义
 *   （如 `sk-...`，强度由创建方自担 —— 见 create 的长度校验）。
 * - 库里存 `fingerprint = sha256(token)` 前 24 hex（96-bit，不可逆），
 *   校验/用量聚合都以指纹为键。
 * - 校验 = 算客户端 token 的指纹 → 查表（active）→ 命中即放行。指纹
 *   96-bit 下碰撞概率可忽略，且 fingerprint UNIQUE 约束兜底。
 * - `token_enc` 列：**加密存储 token 明文**（aes-256-gcm，`1:...` 格式，
 *   同 accounts 的 cookie/keys），供面板「查看/复制」用 plainOf 解密取回、
 *   以及老 token 补录明文。secret 不可用时创建时存 NULL —— 此时只存指纹，
 *   明文仅创建响应出现一次，面板无法取回。
 * - 随机 token 明文**只在创建响应里出现一次**；此后管理端只能看到掩码
 *   （`tk-****` + 指纹末 8 位，可辨认不可逆推）。自定义 key 因显式提供、
 *   又加密落了库，创建后仍可经 plainOf 取回。
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
import { microCentsToUsd, usdToMicroCents as usdToMicroCentsRaw } from './money.js';

/** 分发 token 的配额周期（QUOTA.md §6）。none = 不重置。 */
export type QuotaCycle = 'none' | 'daily' | 'monthly';

/** 创建/更新时可配的配额字段（undefined = 不设置/不动；0 = 无限）。
 *  quotaUsd 单位是**美元**（面板 step=0.01 输入），存储时 ×1e8 转 microCents。 */
export interface TokenQuotaInput {
  quotaUsd?: number;
  quotaTokens?: number;
  quotaRequests?: number;
  cycle?: QuotaCycle;
  expiresAt?: number;
  /** 每分钟 token 上限（0 = 无限；ratelimit.ts TpmLimiter 软预算，请求前检查已用）。 */
  quotaTpm?: number;
  /** IP/CIDR 白名单（空数组 = 不限；存储为逗号分隔字符串，视图回数组）。 */
  ipWhitelist?: string[];
}

/** 单口径配额的读写视图（列表/单查返回，含已用与算好的状态）。
 *  **全部美元输出**（B1 复发面根治）：quotaUsd / usedUsd / remainingUsd 都是美元，
 *  前端不再手写 ×1e8；exhausted / expired 由服务端按校验口径算好下发（QUOTA.md §1）。
 */
export interface TokenQuotaView {
  /** $ 配额上限，美元（视图口径；存储是 microCents，见 QUOTA.md §1）。 */
  quotaUsd: number;
  quotaTokens: number;
  quotaRequests: number;
  /** 已用 $，**美元**（microCents ÷1e8；跨周期窗口时按 0 算，与结算口径一致）。 */
  usedUsd: number;
  usedTokens: number;
  usedRequests: number;
  cycle: QuotaCycle;
  /** 周期窗口起点（ms）。跨周期结算/校验时 used 视为归零。 */
  resetAt: number;
  /** 过期时间（ms，0 = 永不过期）。 */
  expiresAt: number;
  /** 每分钟 token 上限（0 = 无限）。 */
  quotaTpm: number;
  /**
   * 当前分钟已用 token（ratelimit.ts TpmLimiter 的实时窗口）。**内存态**：
   * tokens.ts 无限流器引用，视图恒 0 —— server 端点层用 TpmLimiter 填真实值。
   */
  usedTpm: number;
  /** IP/CIDR 白名单（空数组 = 不限）。 */
  ipWhitelist: string[];
  /** 当前 $ 剩余（美元）。quotaUsd=0（无限配额）时为 null。 */
  remainingUsd: number | null;
  /** 任一口径已耗尽（used ≥ limit；跨周期按 used=0 算）——与 quotaCheck 校验口径一致。 */
  exhausted: boolean;
  /** 已过期（expiresAt 非 0 且已到）——与 quotaCheck 校验口径一致。 */
  expired: boolean;
}

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
  /** 配额配置 + 已用（masked 视图：指纹/明文都不含，仅配置与计数）。 */
  quota: TokenQuotaView;
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
  /** 配额字段（0 = 无限；quotaUsd 单位是**美元**，存储时 ×1e8 转 microCents；
   *  cycle 切非 none 且值变化时自动刷新窗口起点到当前时刻）。 */
  quotaUsd?: number;
  quotaTokens?: number;
  quotaRequests?: number;
  cycle?: QuotaCycle;
  expiresAt?: number;
  /** 每分钟 token 上限（0 = 无限）。 */
  quotaTpm?: number;
  /** IP/CIDR 白名单（空数组 = 清空 = 不限）。 */
  ipWhitelist?: string[];
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

/**
 * $ 配额单位换算（QUOTA.md §1 / B1 修复）：`quota_usd` 列**存储 microCents**
 * （1e8 = $1，与 `cost_micro_cents`、`quota_used_usd` 同单位），API/UI 入参
 * 是美元（step=0.01 的小数）。create/patch 入参美元 ×1e8 落库，list/get 视图
 * ÷1e8 回美元 —— 校验/结算两边都是 microCents，不存在 1e8 倍单位错配。
 * 换算系数与基础转换来自 `money.ts`（单一权威模块）；这里只保留配额入参的
 * 「非正数/非法按 0（0 = 无限）」守卫语义。
 */
/** 美元（API/UI 入参）→ microCents（存储/比较）。非正数/非法按 0。 */
function usdToMicroCents(usd: number | undefined): number {
  const n = Number(usd);
  return Number.isFinite(n) && n > 0 ? usdToMicroCentsRaw(n) : 0;
}

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

/** rpm_limit 归一化：非正数/脏数据一律归 0（rpm_limit=0 语义 = 不限流）。
 *  verify 与 getRpmLimit 共用同一套规则，保证两处口径完全一致。 */
function normalizeRpmLimit(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** 配额周期归一化：只认 daily/monthly，其余一律 none（脏数据不产生未知周期行为）。 */
function normalizeQuotaCycle(v: unknown): QuotaCycle {
  return v === 'daily' || v === 'monthly' ? v : 'none';
}

// ---------------------------------------------------------------------------
// IP/CIDR 白名单匹配（token 级 ip_whitelist，QUOTA 扩展）。
//
// 语义：列表项 = 精确 IP 或 CIDR（`1.2.3.4` / `1.2.3.0/24`），逗号分隔存储。
// IPv4 为主；IPv6 基础支持（含 `::ffff:` 的 IPv4 映射统一归一成点分四段）。
// node 无内建 CIDR 匹配，这里手写位运算（IPv4 32-bit / IPv6 8×16-bit 组）。
// 非法项（格式错/CIDR 越界）恒不匹配 —— 白名单是 fail-closed，宁可拒不可放。
// ---------------------------------------------------------------------------

/** 逗号分隔存储串 → 数组（trim 去空；空串/非串 → 空数组 = 不限）。 */
function parseIpWhitelist(v: unknown): string[] {
  if (typeof v !== 'string' || v.trim() === '') return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 归一化一个 IP：trim + 小写；IPv4 映射（::ffff:1.2.3.4）剥成点分四段。
 *  非法返回 null（匹配判否，fail-closed）。 */
function normalizeIp(ip: string): string | null {
  const s = ip.trim().toLowerCase();
  if (!s) return null;
  const v4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (s.startsWith('::ffff:') && v4.test(s.slice(7))) return s.slice(7);
  if (v4.test(s)) return s;
  if (s.includes(':')) return s; // 原生 IPv6 原样保留
  return null;
}

/** IPv4 点分四段 → 32-bit 无符号整数；非法返回 null。 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/** IPv6 → 8 个 16-bit 组（处理 `::` 压缩）；非法返回 null。 */
function ipv6ToGroups(ip: string): number[] | null {
  if (ip.includes(':::')) return null;
  const [headRaw, tailRaw] = ip.split('::');
  const parse = (part: string | undefined): number[] | null => {
    if (part == null || part === '') return [];
    const groups: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = parse(headRaw);
  const tail = parse(tailRaw);
  if (head == null || tail == null || head.length + tail.length > 8) return null;
  if (ip.includes('::')) {
    return [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

/** 精确 IP 或 CIDR 网络前缀匹配（IPv4 /1-/32，IPv6 /1-/128；/0 恒真）。 */
function ipMatchesCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash <= 0) return false;
  const prefixRaw = cidr.slice(slash + 1);
  // 前缀必须是非空纯数字（Number('')=0 会把 '1.2.3.0/' 误判成 /0 恒真）。
  if (!/^\d+$/.test(prefixRaw)) return false;
  const prefix = Number(prefixRaw);
  const net = cidr.slice(0, slash);
  if (ip.includes(':')) {
    const a = ipv6ToGroups(ip);
    const b = ipv6ToGroups(net);
    if (a == null || b == null || prefix < 0 || prefix > 128) return false;
    let remaining = prefix;
    for (let i = 0; i < 8; i++) {
      if (remaining <= 0) return true;
      const bits = Math.min(16, remaining);
      const mask = bits === 16 ? 0xffff : ((1 << bits) - 1) << (16 - bits);
      if ((a[i]! & mask) !== (b[i]! & mask)) return false;
      remaining -= bits;
    }
    return true;
  }
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(net);
  if (a == null || b == null || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (a & mask) === (b & mask);
}

/**
 * IP 是否命中白名单。`list` 空 = 不限（恒真）；命中精确 IP 或任一 CIDR = 真。
 * 两侧都过 normalizeIp（IPv4 映射与裸 IPv4 互通）。ip 非法（空/格式错）恒否。
 */
export function ipInList(ip: string, list: string[]): boolean {
  if (list.length === 0) return true;
  const norm = normalizeIp(ip);
  if (!norm) return false;
  for (const entry of list) {
    const e = entry.trim();
    if (!e) continue;
    if (e.includes('/')) {
      if (ipMatchesCidr(norm, e)) return true;
    } else if (norm === normalizeIp(e)) {
      return true;
    }
  }
  return false;
}

/** 窗口内某口径的当前已用（quotaUsd 与 usedUsd 都是 microCents，同单位比较）。 */
interface QuotaState {
  /** $ 上限（microCents，与 quota_used_usd 同单位 —— B1 后存储层统一）。 */
  quotaUsd: number;
  quotaTokens: number;
  quotaRequests: number;
  usedUsd: number;
  usedTokens: number;
  usedRequests: number;
  cycle: string;
  resetAt: number;
  expiresAt: number;
  /** 每分钟 token 上限（0 = 无限；ratelimit.ts TpmLimiter 校验/视图共用）。 */
  quotaTpm: number;
  /** IP/CIDR 白名单（空数组 = 不限；解析自逗号分隔存储列）。 */
  ipWhitelist: string[];
}

/**
 * 下一周期重置时刻（ms；0 = 无周期/未初始化，不重置）。daily = reset_at + 1 天；
 * monthly = 自然月同日（目标月没有该日时钳到当月最后一天，如 1/31 → 2/28，
 * 避免 JS setUTCMonth 溢出翻月把窗口拉长一个月）。
 * 周期 429 的 retry-after（M-3）与滚窗判定共用这套算式，保证「客户端等多久再
 * 重试」与「结算/校验何时归零」口径一致。
 */
export function quotaNextResetAt(resetAt: number, cycle: string): number {
  if ((cycle !== 'daily' && cycle !== 'monthly') || resetAt <= 0) return 0;
  if (cycle === 'daily') return resetAt + 86_400_000;
  const d = new Date(resetAt);
  const targetMonth = d.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastDay);
  // setUTCFullYear 保留时分秒（Date.UTC(y,m,d) 会把时分秒清零）—— 与旧
  // quotaWindowExpired 的「自然月同日，保留时分秒」语义一致。
  const out = new Date(d);
  out.setUTCFullYear(d.getUTCFullYear(), targetMonth, day);
  return out.getTime();
}

/**
 * 周期窗口是否已过期（QUOTA.md §6 滚窗判定）。settle 与 quotaCheck 共用，
 * 保证「结算归零」与「校验时按归零算」口径一致。等价于「now ≥ 下一重置时刻」。
 * cycle none / reset_at<=0（未初始化）恒不跨周期。
 */
export function quotaWindowExpired(resetAt: number, cycle: string, now: number): boolean {
  const next = quotaNextResetAt(resetAt, cycle);
  return next !== 0 && now >= next;
}

/** 校验口径：过期（expires_at）→ 403 信号；任一口径 used ≥ limit → 429 信号。
 *  跨周期窗口时 used 按 0 算（滚窗语义：窗口起点已过，配额应已归零）。 */
function computeQuotaStatus(q: QuotaState, now: number): { expired: boolean; exhausted: boolean } {
  const expired = q.expiresAt !== 0 && q.expiresAt <= now;
  const rolled = quotaWindowExpired(q.resetAt, q.cycle, now);
  const usedUsd = rolled ? 0 : q.usedUsd;
  const usedTokens = rolled ? 0 : q.usedTokens;
  const usedRequests = rolled ? 0 : q.usedRequests;
  const exhausted =
    (q.quotaUsd !== 0 && usedUsd >= q.quotaUsd) ||
    (q.quotaTokens !== 0 && usedTokens >= q.quotaTokens) ||
    (q.quotaRequests !== 0 && usedRequests >= q.quotaRequests);
  return { expired, exhausted };
}

/** SQL 行 → QuotaState（数字列全部显式转换，脏数据归 0；cycle 归一化）。 */
function quotaStateFromRow(r: Record<string, unknown>): QuotaState {
  const tpm = Number(r.quota_tpm ?? 0);
  return {
    quotaUsd: Number(r.quota_usd ?? 0) || 0,
    quotaTokens: Number(r.quota_tokens ?? 0) || 0,
    quotaRequests: Number(r.quota_requests ?? 0) || 0,
    usedUsd: Number(r.quota_used_usd ?? 0) || 0,
    usedTokens: Number(r.quota_used_tokens ?? 0) || 0,
    usedRequests: Number(r.quota_used_requests ?? 0) || 0,
    cycle: normalizeQuotaCycle(r.quota_cycle),
    resetAt: Number(r.quota_reset_at ?? 0) || 0,
    expiresAt: Number(r.expires_at ?? 0) || 0,
    quotaTpm: Number.isInteger(tpm) && tpm > 0 ? tpm : 0,
    ipWhitelist: parseIpWhitelist(r.ip_whitelist),
  };
}

/** QuotaState → 管理端视图（list/get 用）。全美元输出 + 算好的 exhausted/expired/
 *  remainingUsd（与 quotaCheck 同一套 computeQuotaStatus，前端不再自己比较单位）。
 *  跨周期窗口（rolled）时**三口径** used 都按 0 算（与结算/校验口径一致 —— 只归零
 *  $ 会让视图显示旧用量「已用 80%」而校验已重置，M-1 对抗审查发现）。
 */
function quotaView(q: QuotaState, now: number): TokenQuotaView {
  const { expired, exhausted } = computeQuotaStatus(q, now);
  const rolled = quotaWindowExpired(q.resetAt, q.cycle, now);
  const usedUsd = rolled ? 0 : q.usedUsd;
  const usedTokens = rolled ? 0 : q.usedTokens;
  const usedRequests = rolled ? 0 : q.usedRequests;
  return {
    quotaUsd: microCentsToUsd(q.quotaUsd),
    quotaTokens: q.quotaTokens,
    quotaRequests: q.quotaRequests,
    usedUsd: microCentsToUsd(usedUsd),
    usedTokens,
    usedRequests,
    cycle: q.cycle as QuotaCycle,
    resetAt: q.resetAt,
    expiresAt: q.expiresAt,
    quotaTpm: q.quotaTpm,
    usedTpm: 0,
    ipWhitelist: q.ipWhitelist,
    remainingUsd: q.quotaUsd === 0 ? null : microCentsToUsd(q.quotaUsd - usedUsd),
    exhausted,
    expired,
  };
}

/** 生成或校验入参的配额字段拼进 INSERT 的值：缺省 0 / 'none' / now。
 *  quotaUsd 入参是美元，×1e8 转 microCents 存储（B1：存储层统一单位）。 */
function quotaInsertValues(quota: TokenQuotaInput | undefined, now: number): {
  values: number[];
  cycle: string;
  tpm: number;
  ipWhitelist: string;
} {
  const tpm = Number(quota?.quotaTpm ?? 0);
  return {
    values: [
      usdToMicroCents(quota?.quotaUsd),
      Number(quota?.quotaTokens ?? 0) || 0,
      Number(quota?.quotaRequests ?? 0) || 0,
    ],
    cycle: normalizeQuotaCycle(quota?.cycle),
    tpm: Number.isInteger(tpm) && tpm > 0 ? tpm : 0,
    ipWhitelist: (quota?.ipWhitelist ?? []).join(','),
  };
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

  /** verify 的 prepared statement（P1-7）：数据面每分发 token 请求都调 verify，
   *   prepared 缓存避免每请求一次同步 prepare（38µs→2.3µs）。null = db 不可用。 */
  private readonly verifyStmt: ReturnType<UsageDb['sqlite']> extends null
    ? null
    : ReturnType<NonNullable<ReturnType<UsageDb['sqlite']>>['prepare']> | null;

  /**
   * verify 结果缓存（P2-4 热路径优化）：数据面每分发 token 请求都调 verify，
   * 即使走 prepared 点查仍是一次同步查库。**只缓存命中且 active 的结果**；
   * miss/disabled 不入缓存 —— 新建 token 立即生效、禁用立即生效（不缓存
   * 负面结果就不会有 10s 的「新 key 401 / 禁用还放行」幽灵）。
   * 写操作（update 改 status/rpmLimit/quota、delete）成功后即时失效；
   * settleQuota 结算后也即时失效（配额扣减立即反映到下次校验）。
   * 降级：缓存读写异常一律回退直接查询（缓存绝不能拖垮校验）。
   * 配额列随 verify 同一次点查取回缓存（QUOTA.md §3），quotaCheck 复用，
   * 避免数据面每请求为配额再做第二次同步点查。
   */
  private verifyCache = new Map<string, { rpmLimit: number; quota: QuotaState; expiresAt: number }>();

  /** verify 缓存 TTL：10 秒（管理写操作即时失效，TTL 只是兜底窗口）。 */
  static readonly VERIFY_CACHE_TTL_MS = 10_000;

  private invalidateVerifyCache(fingerprint: string): void {
    try {
      this.verifyCache.delete(fingerprint);
    } catch {
      // 缓存异常不影响校验正确性。
    }
  }

  constructor(db: UsageDb | null, secret: SecretKey | null = null) {
    this.enabled = db != null && db.enabled;
    this.raw = db?.sqlite?.() ?? null;
    this.db = db;
    this.secret = secret;
    this.verifyStmt = this.raw
      ? this.raw.prepare(
          `SELECT status, rpm_limit, quota_usd, quota_tokens, quota_requests,
                  quota_used_usd, quota_used_tokens, quota_used_requests,
                  quota_cycle, quota_reset_at, expires_at, quota_tpm, ip_whitelist
             FROM tokens WHERE fingerprint = ? AND status = 'active'`,
        )
      : null;
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
        .prepare(
          `SELECT id, name, fingerprint, status, note, prefix, rpm_limit, created_at,
                  quota_usd, quota_tokens, quota_requests,
                  quota_used_usd, quota_used_tokens, quota_used_requests,
                  quota_cycle, quota_reset_at, expires_at, quota_tpm, ip_whitelist
             FROM tokens ORDER BY id`,
        )
        .all() as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: Number(r.id),
        name: String(r.name),
        fingerprint: String(r.fingerprint),
        mask: maskOf(String(r.fingerprint), r.prefix != null ? String(r.prefix) : null),
        status: r.status === 'active' ? 'active' : 'disabled',
        note: r.note == null ? null : String(r.note),
        rpmLimit: Number(r.rpm_limit ?? 0),
        quota: quotaView(quotaStateFromRow(r), Date.now()),
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
        .prepare(
          `SELECT id, name, fingerprint, status, note, prefix, rpm_limit, created_at,
                  quota_usd, quota_tokens, quota_requests,
                  quota_used_usd, quota_used_tokens, quota_used_requests,
                  quota_cycle, quota_reset_at, expires_at, quota_tpm, ip_whitelist
             FROM tokens WHERE id = ?`,
        )
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
        quota: quotaView(quotaStateFromRow(row), Date.now()),
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
    quota?: TokenQuotaInput,
  ): { ok: true; value: GeneratedToken } | { ok: false } {
    if (!this.enabled) return { ok: false };
    if (customKey != null && customKey.trim() !== '') {
      // 自定义 key 值（用户提供，如 sk-dwgxnbnb）：指纹存储同随机，明文不落库。
      const key = customKey.trim();
      // P2-2：自定义 key 低熵防护。短 key + 96-bit 指纹 = 可离线枚举爆破
      // （攻击者枚举候选 key、算指纹对表）。去掉 sk-/tk- 前缀后不足 16 位
      // 就拒绝。**自定义 key 需自行保证强度**——网关只校验长度下限，不做
      // 熵检测（sk- 开头的 key 往往来自别处，命中即复用之）。
      const bare = key.replace(/^(sk|tk)-/i, '');
      if (bare.length < 16) {
        console.warn('[tokens] 自定义 key 过短被拒绝（去前缀后至少 16 位）');
        return { ok: false };
      }
      const fingerprint = fingerprintOf(key);
      const prefix = key.slice(0, 2).toLowerCase();
      const enc = this.secret ? this.secret.encrypt(key) : null;
      const now = Date.now();
      const q = quotaInsertValues(quota, now);
      try {
        const res = this.raw
          .prepare(
            `INSERT INTO tokens (name, token_enc, fingerprint, status, note, prefix,
                                 quota_usd, quota_tokens, quota_requests, quota_cycle, quota_reset_at, expires_at,
                                 quota_tpm, ip_whitelist, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(name, enc, fingerprint, 'active', note, prefix, ...q.values, q.cycle, now, Number(quota?.expiresAt ?? 0) || 0, q.tpm, q.ipWhitelist, now);
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
      const now = Date.now();
      const q = quotaInsertValues(quota, now);
      try {
        const res = this.raw
          .prepare(
            `INSERT INTO tokens (name, token_enc, fingerprint, status, note, prefix,
                                 quota_usd, quota_tokens, quota_requests, quota_cycle, quota_reset_at, expires_at,
                                 quota_tpm, ip_whitelist, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(name, enc, fingerprint, 'active', note, 'tk', ...q.values, q.cycle, now, Number(quota?.expiresAt ?? 0) || 0, q.tpm, q.ipWhitelist, now);
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
    if (patch.quotaUsd !== undefined) {
      // B1：$ 配额入参是美元，×1e8 转 microCents 存储（比较/结算同单位）。
      sets.push('quota_usd = ?');
      vals.push(usdToMicroCents(patch.quotaUsd));
    }
    if (patch.quotaTokens !== undefined) {
      sets.push('quota_tokens = ?');
      vals.push(patch.quotaTokens);
    }
    if (patch.quotaRequests !== undefined) {
      sets.push('quota_requests = ?');
      vals.push(patch.quotaRequests);
    }
    if (patch.cycle !== undefined) {
      sets.push('quota_cycle = ?');
      vals.push(patch.cycle);
      // MINOR m2：cycle 值变化时窗口起点刷新到当前时刻（QUOTA.md §6）。旧实现只在
      // reset_at=0 时刷起点，token 创建即定 reset_at=now，切 cycle 后起点仍是创建
      // 时刻 —— 周期窗口被错误拉长。同值 PATCH（daily→daily）不刷新（「值变化」才
      // 生效）；切回 none 不动 reset_at。实际 SET 在下方 fpRow 判 cycle 变化后补。
    }
    if (patch.expiresAt !== undefined) {
      sets.push('expires_at = ?');
      vals.push(patch.expiresAt);
    }
    if (patch.quotaTpm !== undefined) {
      sets.push('quota_tpm = ?');
      vals.push(Number(patch.quotaTpm) || 0);
    }
    if (patch.ipWhitelist !== undefined) {
      sets.push('ip_whitelist = ?');
      vals.push(patch.ipWhitelist.join(','));
    }
    if (sets.length === 0) return this.get(id) != null ? 'ok' : 'missing';
    try {
      // 先验存在性再 UPDATE：SQLite 的 changes 只统计值实际被改的行，
      // 对不存在的 id 更新 0 行会被误判为成功（与 updateAccount 同一思路）。
      // 顺手取指纹与当前 cycle：status/rpmLimit/quota 变化时失效 verify 缓存
      // （改 name/note/tokenPlain 不影响校验结果，不失效）；cycle 判变化用。
      const fpRow = this.raw.prepare('SELECT fingerprint, quota_cycle FROM tokens WHERE id = ?').get(id) as
        | { fingerprint?: string; quota_cycle?: unknown }
        | undefined;
      if (!fpRow) return 'missing';
      if (
        patch.cycle !== undefined &&
        patch.cycle !== 'none' &&
        normalizeQuotaCycle(fpRow.quota_cycle) !== normalizeQuotaCycle(patch.cycle)
      ) {
        sets.push('quota_reset_at = ?');
        vals.push(Date.now());
      }
      vals.push(id);
      this.raw.prepare(`UPDATE tokens SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      const touchesVerifyResult =
        patch.status !== undefined ||
        patch.rpmLimit !== undefined ||
        patch.quotaUsd !== undefined ||
        patch.quotaTokens !== undefined ||
        patch.quotaRequests !== undefined ||
        patch.cycle !== undefined ||
        patch.expiresAt !== undefined ||
        patch.quotaTpm !== undefined ||
        patch.ipWhitelist !== undefined;
      if (touchesVerifyResult) {
        this.invalidateVerifyCache(String(fpRow.fingerprint));
      }
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
      // 删除前取指纹：删掉后 verify 缓存里该 token 必须即时失效，否则
      // 10s 内缓存仍放行已删除 token（管理面删 key 应立即生效）。
      const fpRow = this.raw.prepare('SELECT fingerprint FROM tokens WHERE id = ?').get(id) as
        | { fingerprint?: string }
        | undefined;
      this.raw.prepare('DELETE FROM tokens WHERE id = ?').run(id);
      if (fpRow?.fingerprint) this.invalidateVerifyCache(String(fpRow.fingerprint));
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
   *
   * **生产数据面已不再调用**：`verify` 的 prepared 语句同一次点查就把
   * rpm_limit 一起取回（见 `verifyStmt`，少一次同步查询）。本方法保留
   * 给测试回归（断言热路径不再单独查）+ 库消费者按需读取，语义与 verify
   * 归一化完全一致（同一套 `normalizeRpmLimit`）。
   */
  getRpmLimit(fingerprint: string): number {
    if (!this.enabled) return 0;
    try {
      const row = this.raw
        .prepare('SELECT rpm_limit FROM tokens WHERE fingerprint = ?')
        .get(fingerprint) as { rpm_limit?: unknown } | undefined;
      return normalizeRpmLimit(row?.rpm_limit);
    } catch (err) {
      console.warn(`[tokens] rpm_limit 查询失败（按不限流处理）: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  /**
   * 校验客户端 token：算指纹 → 查表（存在且 active）→ 命中返回指纹 + rpmLimit。
   *
   * 热路径优化：verify 本来就要点查 tokens 这一行，rpm_limit 是同一行的列 ——
   * 一并取回，调用方（server 的 checkTokenRpmLimit）不用再为同一指纹做第二次
   * 同步点查。rpmLimit 归一化与 getRpmLimit 完全一致（非正整数归 0，
   * rpm_limit=0 语义不变 = 不限流）。
   * **全程无解密**；db 不可用恒返回失败（fail-closed）。
   * P2-4：10s TTL 内存缓存兜住高频重复校验（只缓存命中，见 verifyCache）。
   */
  verify(token: string): { ok: true; fingerprint: string; rpmLimit: number } | { ok: false } {
    if (!this.enabled || !this.verifyStmt) return { ok: false };
    const fingerprint = fingerprintOf(token);
    // 缓存命中：跳过查库。只缓存命中结果，miss 不缓存（见 verifyCache 注释）。
    try {
      const cached = this.verifyCache.get(fingerprint);
      if (cached) {
        if (cached.expiresAt > Date.now()) {
          return { ok: true, fingerprint, rpmLimit: cached.rpmLimit };
        }
        this.verifyCache.delete(fingerprint);
      }
    } catch {
      // 缓存异常回退直接查询（降级）。
    }
    try {
      const row = this.verifyStmt.get(fingerprint) as Record<string, unknown> | undefined;
      if (row) {
        const rpmLimit = normalizeRpmLimit(row.rpm_limit);
        const quota = quotaStateFromRow(row);
        try {
          this.verifyCache.set(fingerprint, { rpmLimit, quota, expiresAt: Date.now() + TokensStore.VERIFY_CACHE_TTL_MS });
        } catch {
          // 缓存写失败忽略，下次直接查库。
        }
        return { ok: true, fingerprint, rpmLimit };
      }
      return { ok: false };
    } catch (err) {
      console.warn(`[tokens] 校验查询失败: ${err instanceof Error ? err.message : err}`);
      return { ok: false };
    }
  }

  /**
   * 请求完成时同步结算配额（QUOTA.md §2，sub2api 式单条条件 UPDATE，不走 flush）。
   *
   * 三口径独立累加（$ / tokens / requests）；跨周期（quota_reset_at 过期）时
   * 同事务归零 used + 刷新起点（滚窗：新窗口从本次用量起算）。
   *
   * **M3 条件防超支（并发 N 倍超额修复）**：每口径独立判断 —— `limit=0`
   * 不限制；`quota_used_* < limit` 才累加；**已超限的该口径不再扣**（某口径
   * 超限只停该口径，其余口径照常扣）。verify 有 10s 缓存，N 并发可同时通过
   * 校验，但 settle 走同一条条件 UPDATE 串行化 —— 已受理请求只在额度内累加，
   * 超限后的请求不重复扣（单请求生命周期内的小额超额仍可接受，N 倍超额被
   * 封顶）。被跳过的口径记一条 warn（审计面：requests 表已落该请求）。
   *
   * M2：delta 带 `cacheReadTokens`（Anthropic 路径的 cache_read_input_tokens），
   * 计入 tokens 口径 —— 两条路径「总输入」一致（chat 的 input 含缓存、
   * cacheRead=0；messages 的 input 减缓存、cacheRead 补回）。$ 口径由 server
   * 侧按定价表（input/output/read）折算成 costMicroCents 传入。
   *
   * **失败静默**（QUOTA.md 关键不变量）：DB 写失败只记日志不抛 —— 结算是
   * 记账动作，绝不阻断请求链路（本次不扣，不重试）。
   *
   * 结算后失效该 key 的 verify 缓存：下一次请求的 verify/quotaCheck 读到
   * 扣减后的新值（缓存 TTL 只兜底窗口，结算即失效）。
   */
  settleQuota(
    fingerprint: string,
    delta: { costMicroCents: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number },
  ): void {
    if (!this.enabled) return;
    try {
      const row = this.raw
        .prepare(
          `SELECT quota_cycle, quota_reset_at,
                  quota_usd, quota_tokens, quota_requests,
                  quota_used_usd, quota_used_tokens, quota_used_requests
             FROM tokens WHERE fingerprint = ?`,
        )
        .get(fingerprint) as
        | {
            quota_cycle?: unknown;
            quota_reset_at?: unknown;
            quota_usd?: unknown;
            quota_tokens?: unknown;
            quota_requests?: unknown;
            quota_used_usd?: unknown;
            quota_used_tokens?: unknown;
            quota_used_requests?: unknown;
          }
        | undefined;
      if (!row) return;
      const now = Date.now();
      const crossed = quotaWindowExpired(Number(row.quota_reset_at ?? 0), normalizeQuotaCycle(row.quota_cycle), now) ? 1 : 0;
      const cost = Number(delta.costMicroCents) || 0;
      const cacheRead = Number(delta.cacheReadTokens) || 0;
      const tokensDelta = (Number(delta.inputTokens) || 0) + (Number(delta.outputTokens) || 0) + cacheRead;
      // M3 跳过判定（预读快照，仅供日志；真实扣减由下面 SQL 的原子条件兜底）。
      const over = {
        usd: Number(row.quota_usd ?? 0) > 0 && Number(row.quota_used_usd ?? 0) >= Number(row.quota_usd ?? 0),
        tokens: Number(row.quota_tokens ?? 0) > 0 && Number(row.quota_used_tokens ?? 0) >= Number(row.quota_tokens ?? 0),
        requests:
          Number(row.quota_requests ?? 0) > 0 && Number(row.quota_used_requests ?? 0) >= Number(row.quota_requests ?? 0),
      };
      if (!crossed && (over.usd || over.tokens || over.requests)) {
        const which = [over.usd ? '$' : '', over.tokens ? 'tokens' : '', over.requests ? 'requests' : '']
          .filter(Boolean)
          .join('/');
        console.warn(`[tokens] 配额已超限，本次结算跳过超限口径(${which})（已受理请求照实结算被 M3 封顶）`);
      }
      this.raw
        .prepare(
          `UPDATE tokens SET
             quota_reset_at    = CASE WHEN ? THEN ? ELSE quota_reset_at END,
             quota_used_usd    = CASE
               WHEN ? THEN ?
               WHEN quota_usd = 0 OR quota_used_usd < quota_usd THEN quota_used_usd + ?
               ELSE quota_used_usd
             END,
             quota_used_tokens = CASE
               WHEN ? THEN ?
               WHEN quota_tokens = 0 OR quota_used_tokens < quota_tokens THEN quota_used_tokens + ?
               ELSE quota_used_tokens
             END,
             quota_used_requests = CASE
               WHEN ? THEN ?
               WHEN quota_requests = 0 OR quota_used_requests < quota_requests THEN quota_used_requests + ?
               ELSE quota_used_requests
             END
           WHERE fingerprint = ?`,
        )
        .run(
          crossed, now,
          crossed, cost, cost,
          crossed, tokensDelta, tokensDelta,
          crossed, 1, 1,
          fingerprint,
        );
      this.invalidateVerifyCache(fingerprint);
    } catch (err) {
      console.warn(`[tokens] 配额结算失败（忽略，不阻断请求链路）: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * 配额校验（QUOTA.md §3，verify 路径的 403/429 判定）。server 在 verifyAuth
   * 之后、转发之前调用。
   *
   * 复用 verify 同一次点查填进 verifyCache 的配额快照（避免数据面每请求第二次
   * 同步点查）；缓存过期/未命中才单独查库。返回：
   * - `{expired: true}` → 过期（403 信号）：expires_at 非 0 且已到。
   * - `{exhausted: true}` → 任一口径 used ≥ 上限（429 信号，跨周期窗口按 used=0
   *   算 —— 滚窗语义：窗口起点已过，配额应已归零）。
   * - `resetAt` = 下一周期重置时刻（ms，0 = 无周期，M-3）。429 响应据此给
   *   retry-after（有周期 → 重置秒数；无周期 → 不带，配额不会自动重置）。
   * - `tpmLimit` = 每分钟 token 上限（0 = 无限）——server 的 TPM 检查（请求前
   *   已用 ≥ limit → 429）与 IP 白名单检查复用这次点查/缓存快照。
   * - `ipWhitelist` = IP/CIDR 白名单数组（空 = 不限）——server 的 IP 检查用。
   * - null = token 不存在或 db 不可用/查询失败 —— 调用方放行。全 0 配额
   *   （无任何限制）返回 `{expired:false, exhausted:false, resetAt:0}`。
   */
  quotaCheck(
    fingerprint: string,
  ): { expired: boolean; exhausted: boolean; resetAt: number; tpmLimit: number; ipWhitelist: string[] } | null {
    if (!this.enabled) return null;
    const now = Date.now();
    try {
      const cached = this.verifyCache.get(fingerprint);
      if (cached && cached.expiresAt > now) {
        const status = computeQuotaStatus(cached.quota, now);
        return {
          ...status,
          resetAt: quotaNextResetAt(cached.quota.resetAt, cached.quota.cycle),
          tpmLimit: cached.quota.quotaTpm,
          ipWhitelist: cached.quota.ipWhitelist,
        };
      }
    } catch {
      // 缓存异常回退直接查询（降级）。
    }
    try {
      const row = this.raw
        .prepare(
          `SELECT rpm_limit, quota_usd, quota_tokens, quota_requests,
                  quota_used_usd, quota_used_tokens, quota_used_requests,
                  quota_cycle, quota_reset_at, expires_at, quota_tpm, ip_whitelist
             FROM tokens WHERE fingerprint = ?`,
        )
        .get(fingerprint) as Record<string, unknown> | undefined;
      if (!row) return null;
      const state = quotaStateFromRow(row);
      const status = computeQuotaStatus(state, now);
      if (!status.exhausted && !status.expired) {
        // 结果缓存复用 verify 的槽位（结算/写操作失效后下一次 verify 会重填）。
        // 必须带上真实 rpm_limit：verify 会读这个缓存条目，若写 0 会把该 token
        // 的限流值冲成「不限流」（P2-4 热路径回归）。
        try {
          this.verifyCache.set(fingerprint, {
            rpmLimit: normalizeRpmLimit(row.rpm_limit),
            quota: state,
            expiresAt: now + TokensStore.VERIFY_CACHE_TTL_MS,
          });
        } catch {
          // 缓存写失败忽略。
        }
      }
      return {
        ...status,
        resetAt: quotaNextResetAt(state.resetAt, state.cycle),
        tpmLimit: state.quotaTpm,
        ipWhitelist: state.ipWhitelist,
      };
    } catch (err) {
      console.warn(`[tokens] 配额检查失败（按无配额放行）: ${err instanceof Error ? err.message : err}`);
      return null;
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
