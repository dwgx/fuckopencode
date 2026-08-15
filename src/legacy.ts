/**
 * 旧版控制台（opencode.ai）workspace 的 API key 数据层。
 *
 * 与新版 console.opencode.ai（console.ts）不同，旧版控制台**没有 REST API**，
 * 只有两条实测通道（2026-08-11 浏览器抓包确认，见 .claude/state/CURRENT.md）：
 *
 * 1. 读：`GET /workspace/{id}/keys`（带 cookie）返回 HTML，key 列表在 **SSR 水合**
 *    里 —— SolidStart 的 `$R[n]={id:"key_...",name:"...",key:"sk-...",...}` 序列。
 *    实测对象字段：id / name / key（**完整明文**）/ timeUsed / userID / email /
 *    keyDisplay（掩码，实测形态 `sk-AOpQ...0osU`，末 4 位是真实指纹 ——
 *    网关用量端点靠它归属统计，见 server.ts 的 usage-gateway）。
 * 2. 写：`POST /_server`（SolidStart server function），`X-Server-Id` 头 + 
 *    `application/x-www-form-urlencoded` body。实测（真实提交，创建后已删除）：
 *    - 创建：X-Server-Id `44482507...`（= 页面弹窗表单 action 里的 id），
 *      body `name=<名称>&workspaceID=<wsId>`
 *    - 删除：X-Server-Id `48baebd3...`（= 每行删除表单 action 里的 id，
 *      可从 SSR HTML 解析，跨构建稳定），body `id=<keyId>&workspaceID=<wsId>`
 *
 * 隐私口径（与 console.ts 一致）：
 * - **key 明文绝不出模块** —— SSR 解析出的 `key` 字段只用于兜底掩码计算，
 *   返回对象只有 id/name/masked/creatorEmail；
 * - cookie 明文只在进程内流转，绝不进响应与日志；
 * - 失败只记日志返回细分原因，不抛错（观测设施哲学）。
 *
 * 注意：任务文档给的删除 hash（`c22cd964...`）是旧构建的，当前构建页面实测
 * 是 `48baebd3...` —— 所以删除优先用 SSR 里解析的 form action id，解析不到
 * 才兜底常量。创建 hash 无法从初始页面 HTML 解析（创建表单只在弹窗打开后
 * 渲染），只能硬编码（当前构建实测值，与任务抓包一致）。
 *
 * Go 订阅页（/workspace/{id}/go）2026-08-11 浏览器实测（CDP 9223 真实抓包 +
 * 开关真点两轮并恢复原状）：
 *
 * 1. 读：`GET /workspace/{id}/go`（带 cookie）→ HTML。数据在 SSR 水合：
 *    - `lite.subscription.get["wrk_..."]` → 已订阅时值对象
 *      `{mine:!0,useBalance:!1,region:["us","eu","sg","cn"],
 *      rollingUsage:{status:"ok",resetInSec:N,usagePercent:N},
 *      weeklyUsage:{...},monthlyUsage:{...}}`；**未订阅时值为裸 `null`**
 *      （对照 workspace 实测确认）；
 *    - `billing.get["wrk_..."]` → 含 `liteSubscriptionID:"sub_..."`（订阅 id）；
 *    - 「启用部署在中国的模型」开关状态不在水合里，直接读 SSR 渲染的
 *      `<input type="checkbox" checked>`（useChinaProviders 那个 form 里的）。
 * 2. 写（开关，都是 form 增强提交 → POST /_server + X-Server-Id + urlencoded）：
 *    - useBalance：X-Server-Id `0c8d84b0...`，body
 *      `workspaceID=<ws>&useBalance=true|false`
 *    - 中国模型：X-Server-Id `57e61af1...`，body
 *      `workspaceID=<ws>&useChinaProviders=true|false`
 *    实测提交值 = 点击后的开关目标值（true 开 / false 关），与 checkbox
 *    当前状态一致；请求无需 X-Server-Instance（实测浏览器会带，但非必需）。
 * 3. 「管理订阅」按钮 = 跳转 Stripe customer portal（billing.stripe.com），
 *    纯前端行为，后端不做。
 *
 * Billing 页（/workspace/{id}/billing）2026-08-12 浏览器实测（CDP 9223 真实抓包）：
 *
 * 1. `billing.get["wrk_..."]` 槽位 resolve 一个对象，实测字段：
 *    `customerID / paymentMethodID / paymentMethodType("alipay") /
 *    paymentMethodLast4(null) / balance:0 / reload:null / reloadAmount:20 /
 *    reloadAmountMin:10 / reloadTrigger:5 / reloadTriggerMin:5 /
 *    monthlyLimit:null / monthlyUsage:0 / timeMonthlyUsageUpdated:
 *    new Date(...) / reloadError / subscription / lite / liteSubscriptionID`。
 *    金额口径分两种：**balance / monthlyLimit / payment.amount 是整数 units**
 *    （1e8 = $1，与 billing.ts 的 UNITS_PER_DOLLAR 一致；实测余额 0、
 *    $5.00 支付 = 500000000）；**reloadAmount / reloadTrigger 是美元整数**
 *    （form 表单值，min 值 10/5 只能是美元不是 units）。
 * 2. `payment.list["wrk_..."]` 槽位 resolve 数组，元素实测字段：
 *    `id:"pay_..." / timeCreated:new Date("...") / amount:500000000 /
 *    enrichment:{type:"lite",couponID:"6iMezXFZ"}`。
 * 3. reload 未启用时是裸 `null`（顶层 reloadAmount/reloadTrigger 仍给出
 *    上次配置的数字）；启用后的形态没实测过（不想对真实账号做写操作），
 *    解析按对象 `{amount,trigger}` 防御式处理，兜底读顶层字段。
 */

import { UNITS_PER_DOLLAR, type FetchLike } from './billing.js';

/** 单次上游调用超时（与 console.ts 同款）。 */
export const LEGACY_TIMEOUT_MS = 15_000;

/**
 * zen usage JSON API 的超时（/zen/go/v1/usage 是轻量 JSON，比 HTML 页更快，
 * 不需要 HTML 抓取的 15s）。
 */
export const ZEN_TIMEOUT_MS = 10_000;

/** 创建 server function 的 X-Server-Id（实测：弹窗表单 action id，跨构建可能变化）。 */
export const LEGACY_CREATE_SERVER_ID =
  '444825072757feb3b2ec98a3260e2c32488cb05899076c0afb36b9eb5142bc62';

/**
 * 删除 server function 的 X-Server-Id 兜底（实测当前构建）。优先用 SSR 里
 * 解析的删除表单 action id（fetchLegacyKeys 顺手带出），解析不到才用它。
 */
export const LEGACY_DELETE_SERVER_ID_FALLBACK =
  '48baebd35f970b8dc3a658e6f9cc953efd731a7f8a6376012c9bc1802cec787d';

/** Go 页「使用余额」开关的 X-Server-Id（实测：form action 的 id，与表单提交一致）。 */
export const LEGACY_GO_USE_BALANCE_SERVER_ID =
  '0c8d84b0a700eb0de440ca4c9105b42d6c9ede971d6bf592fa4f91bbeaaa1e6b';

/** Go 页「启用部署在中国的模型」开关的 X-Server-Id（实测）。 */
export const LEGACY_GO_CHINA_SERVER_ID =
  '57e61af1bc9c8fa15e0c1a880a2a6754484afdd4a3bc4426b3fc02e3a7ff4d69';

/** Go 订阅的一个用量窗口（滚动/每周/每月同构）。 */
export interface GoUsageWindow {
  /** 上游返回的状态（实测 "ok"；错误时为 "limit_reached" 等）。 */
  status: string;
  /** 距重置的秒数（面板可本地倒计时）。 */
  resetInSec: number;
  /** 用量百分比（0-100，实测整数）。 */
  usagePercent: number;
}

/** Go 订阅状态（读的结果，字段名按实测水合/SSR）。 */
export interface LegacyGoStatus {
  /** 是否已订阅（lite.subscription.get 水合值非 null）。 */
  subscribed: boolean;
  /** 「达到使用限额后使用您的可用余额」开关（水合 useBalance 字段）。 */
  useBalance: boolean;
  /** 「启用部署在中国的模型」开关（SSR checkbox 的 checked 属性）。 */
  chinaModels: boolean;
  rolling: GoUsageWindow | null;
  weekly: GoUsageWindow | null;
  monthly: GoUsageWindow | null;
}

/** Go 状态读的结果。 */
export type LegacyGoReadResult =
  | { ok: true; status: LegacyGoStatus }
  | { ok: false; reason: 'no-cookie' | 'wrong-console' | 'auth' | 'upstream' | 'parse' };

/** parseLegacyGoHtml 的输出（null = 页面不是 go 页，无水合数据）。 */
export type LegacyGoParse = LegacyGoStatus | null;

/** 一条旧版 key 的对外视图（**绝不含 key 明文**）。 */
export interface LegacyKeyRow {
  /** key_ 开头的唯一 id（删除请求要用它，不是名称）。 */
  id: string;
  /** 用户填的 key 名称。 */
  name: string;
  /** 掩码（SSR 的 keyDisplay，如 `sk-AOpQ...0osU`；缺失时用 key 明文自算）。 */
  masked: string;
  /** 创建者邮箱（SSR 的 email 字段；缺失为 null）。 */
  creatorEmail: string | null;
}

/** 读的结果：成功带 key 列表 + 删除 server-id；失败带细分原因。 */
export type LegacyReadResult =
  | { ok: true; keys: LegacyKeyRow[]; deleteServerId: string | null }
  | { ok: false; reason: 'no-cookie' | 'wrong-console' | 'auth' | 'upstream' | 'parse' };

/** 写（创建/删除）的结果。 */
export type LegacyWriteResult =
  | { ok: true }
  | { ok: false; reason: 'no-cookie' | 'wrong-console' | 'auth' | 'upstream' };

/** parseLegacyKeysHtml 的输出。 */
export interface LegacyKeysParse {
  keys: LegacyKeyRow[];
  /** 从删除表单 action 里提取的 server-id（页面没有删除表单时为 null）。 */
  deleteServerId: string | null;
  /**
   * 页面确实是 keys 页的弱信号：SSR 水合含 `key.list["<ws>"]` 注册行
   * （实测 keys 页必有，空列表也有；登录页没有）。用于区分「空 key 列表」
   * 与「登录页」——空列表是正常状态，登录页是解析失败。
   */
  isKeysPage: boolean;
}

/**
 * cookie 是否可用于旧版通道。旧版只认 `auth=` cookie（opencode.ai 域）；
 * `__Host-` 前缀是新版 console（console.opencode.ai）的会话 cookie，混用必然 401。
 * 其余形态（如完整 `auth=xxx; other=yyy` 串）原样放行，尽力而为。
 */
export function legacyCookieStatus(
  cookie: string | null,
): 'ok' | 'missing' | 'wrong-console' {
  if (!cookie) return 'missing';
  if (cookie.startsWith('__Host-')) return 'wrong-console';
  return 'ok';
}

/** 掩码兜底：`sk-` + 前 4 + `...` + 后 4（与 SSR 的 keyDisplay 格式一致）。
 *  exported：accounts.ts 给旧版 Default API Key 算掩码视图用（同隐私口径）。 */
export function maskKey(key: string): string {
  // 异常短 key（≤11 位，够不出前 4 后 4）直接整段打码，绝不让明文进 masked 字段。
  if (key.length <= 11) return '***';
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

/**
 * 一条旧版 key 的明文（**只进内存缓存**，绝不落库/进日志/进掩码响应）。
 * 由 `GET /__admin/api/legacy/account/{id}/keys/plain`（管理鉴权）返回。
 */
export interface LegacyPlainKey {
  /** key_ 开头的唯一 id（与 LegacyKeyRow.id 对应）。 */
  id: string;
  /** 用户填的 key 名称。 */
  name: string;
  /** 完整明文（sk- + 64 位）。 */
  key: string;
}

/** 明文缓存条目的过期时间（惰性：get 命中已过期即作废并就地清除）。 */
export const LEGACY_PLAIN_CACHE_TTL_MS = 15 * 60 * 1000;

/** 明文缓存的上限账号数（超过逐出最旧 —— 防内存泄漏的安全网）。 */
export const LEGACY_PLAIN_CACHE_MAX_ACCOUNTS = 64;

/**
 * legacy keys 明文的进程内缓存（Map<accountId, {ws, Array<{id,name,key}>}>）。
 *
 * workspace 维度：条目在 set 时记下抓取所用的 ws，get 校验请求 ws —— 账号
 * 切换 legacyWorkspaceId 后 TTL 内绝不返回旧 workspace 的明文 key（凭证级串
 * 数据，跨 workspace 泄露不可接受）。任何一方未传 ws（旧调用方形态）时无法
 * 校验，按兼容放行。
 *
 * 生命周期设计（任务契约）：
 * - **只存内存**：进程重启即清空，绝不落库、绝不进日志、绝不进掩码端点；
 * - **抓取时填充**：fetchLegacyKeys 的 onPlain 回调在每次成功抓取后 set；
 * - **失败清理**：上层（main.ts 适配器 / server.ts 端点）在抓取失败、写操作
 *   后 clear —— 绝不返回抓不到的证据；
 * - **防内存泄漏**：TTL（15 分钟，get 惰性过期 + set 顺带清理）+ 账号上限
 *   （64，超出逐出最旧）双保险，兜住「账号删除后无人再访问」的残留条目。
 */
export class LegacyPlainCache {
  private entries = new Map<number, { ws: string | null; keys: LegacyPlainKey[]; fetchedAt: number }>();
  private ttlMs: number;
  private maxAccounts: number;

  constructor(opts: { ttlMs?: number; maxAccounts?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? LEGACY_PLAIN_CACHE_TTL_MS;
    this.maxAccounts = opts.maxAccounts ?? LEGACY_PLAIN_CACHE_MAX_ACCOUNTS;
  }

  /**
   * 命中且未过期 → 明文列表；未命中/已过期 → null（过期条目就地清除）。
   * ws 维度：条目按当时抓取的 workspace 填的，请求 ws 与条目不一致 → miss
   * （调用方用当前 ws 重抓并覆盖），绝不跨 workspace 返回明文 key。任何一方
   * 未传 ws（旧调用方形态）→ 无法校验，按兼容放行。
   */
  get(accountId: number, ws?: string): LegacyPlainKey[] | null {
    const e = this.entries.get(accountId);
    if (!e) return null;
    if (Date.now() - e.fetchedAt > this.ttlMs) {
      this.entries.delete(accountId);
      return null;
    }
    if (ws != null && e.ws != null && ws !== e.ws) return null;
    return e.keys;
  }

  /** 填充/刷新条目。超过账号上限时逐出最旧（Map 插入序第一个）。 */
  set(accountId: number, keys: LegacyPlainKey[], ws?: string): void {
    // 顺带清一遍过期条目：不访问的已删账号残留靠它收敛（上限仍是最后兜底）。
    if (this.entries.size >= this.maxAccounts) {
      const now = Date.now();
      for (const [id, e] of this.entries) {
        if (now - e.fetchedAt > this.ttlMs) this.entries.delete(id);
      }
    }
    this.entries.delete(accountId); // 重插到末尾：最旧优先逐出
    this.entries.set(accountId, { ws: ws ?? null, keys, fetchedAt: Date.now() });
    while (this.entries.size > this.maxAccounts) {
      const oldest = this.entries.keys().next().value;
      if (oldest == null) break;
      this.entries.delete(oldest);
    }
  }

  /** 清空某账号的明文（抓取失败 / 账号删除 / key 写操作后调用）。 */
  clear(accountId: number): void {
    this.entries.delete(accountId);
  }

  /** 当前缓存条目数（测试观察点）。 */
  size(): number {
    return this.entries.size;
  }
}

/**
 * 从 keys 页 HTML 里提取 key 列表 + 删除 server-id（SSR 水合解析）。
 *
 * 提取策略（鲁棒，不依赖完整 JSON 结构）：先按 `{id:"key_` 定位对象起点，
 * 再扫描到最近的一个 `}`（实测对象内全是双引号字符串/字面量，无嵌套对象），
 * 然后逐字段正则提取。字段缺失兜底，坏条目跳过。
 *
 * key 明文（SSR 的 `key` 字段）只在 keyDisplay 缺失时用于算掩码，绝不返回。
 * 调用方若想收集明文（喂内存缓存），传一个 `plainSink` 数组，明文会 push 进去
 * —— 返回对象本身仍不含明文（隐私口径不变）。
 */
export function parseLegacyKeysHtml(html: string, plainSink?: LegacyPlainKey[]): LegacyKeysParse {
  const keys: LegacyKeyRow[] = [];
  const re = /\{id:"key_[^"]*"/g;
  for (const m of html.matchAll(re)) {
    const start = m.index ?? 0;
    const end = html.indexOf('}', start);
    if (end < 0) break;
    const obj = html.slice(start, end + 1);
    const id = /id:"([^"]+)"/.exec(obj)?.[1];
    if (!id) continue;
    const name = /name:"((?:\\.|[^"])*)"/.exec(obj)?.[1] ?? '';
    const key = /key:"((?:\\.|[^"])*)"/.exec(obj)?.[1] ?? null;
    // SolidStart 序列化可能把 null 输出成带引号的 "null"（或裸 null 无引号），
    // 归一成真正的 null 再兜底。
    const keyDisplay = /keyDisplay:"((?:\\.|[^"])*)"/.exec(obj)?.[1] ?? null;
    const display = keyDisplay === 'null' ? null : keyDisplay;
    const email = /email:"((?:\\.|[^"])*)"/.exec(obj)?.[1] ?? null;
    const creatorEmail = email === 'null' ? null : email;
    // key 明文只用于掩码兜底，不进返回对象（隐私口径）。
    const masked = display && display.length > 0 ? display : key ? maskKey(key) : '';
    keys.push({ id, name, masked, creatorEmail });
    // 明文只在调用方显式提供的 sink 里收集（喂内存缓存），绝不进返回对象。
    if (plainSink && key) plainSink.push({ id, name, key });
  }
  // 删除 server-id：每行删除表单的 `action="/_server?id=<hash>"`。
  // 表单增强 fetch 把 action 里的 id 挪进 X-Server-Id 头，所以这里解析出的
  // 就是删除请求要带的 X-Server-Id（跨构建稳定，不依赖硬编码）。
  const formMatch = /action="[^"]*\/_server\?id=([0-9a-f]+)"/i.exec(html);
  // keys 页弱信号：水合注册行 `key.list["<ws>"]`（实测空列表页也在）。
  const isKeysPage = html.includes('key.list[');
  return { keys, deleteServerId: formMatch?.[1] ?? null, isKeysPage };
}

/** cookie 状态 → 失败 reason（legacyCookieStatus 的 'missing' 映射成 no-cookie）。 */
function cookieFailure(
  status: 'ok' | 'missing' | 'wrong-console',
): 'no-cookie' | 'wrong-console' | null {
  if (status === 'ok') return null;
  return status === 'missing' ? 'no-cookie' : 'wrong-console';
}

/**
 * 读旧版 workspace 的 key 列表：GET keys 页 → 解析 SSR 水合。
 * 401/403 → auth（cookie 失效）；网络/超时/5xx → upstream；解析不出任何
 * key、无删除表单且页面不像 keys 页（isKeysPage 弱信号）→ parse
 * （调用方按失败处理）。**空 key 列表是正常状态**：keys 页水合标记在、
 * 只是没 key 时返回 {ok:true, keys:[]}，让创建按钮可达。
 *
 * `onPlain`：成功（页面确实是 keys 页）时收到解析出的明文列表，供调用方喂
 * 内存缓存；失败路径不触发 —— 登录页等 parse 失败不会污染缓存。明文不进
 * 返回对象，隐私口径不变。
 */
export async function fetchLegacyKeys(
  baseUrl: string,
  cookie: string | null,
  workspaceId: string,
  fetchImpl: FetchLike = fetch,
  onPlain?: (keys: LegacyPlainKey[]) => void,
): Promise<LegacyReadResult> {
  const bad = cookieFailure(legacyCookieStatus(cookie));
  if (bad) return { ok: false, reason: bad };
  const url = `${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(workspaceId)}/keys`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { cookie: cookie!, accept: 'text/html' },
      signal: AbortSignal.timeout(LEGACY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
  if (!res.ok) return { ok: false, reason: 'upstream' };
  let html: string;
  try {
    html = await res.text();
  } catch {
    return { ok: false, reason: 'parse' };
  }
  const plainSink: LegacyPlainKey[] = [];
  const parsed = parseLegacyKeysHtml(html, plainSink);
  // 页面不是 keys 页（水合里一个 key 对象都没有、没有删除表单、也没有
  // key.list 水合标记）→ 解析失败，避免把「登录页 HTML」当「空 key 列表」。
  // 空列表（key.list 标记在）不算失败——创建按钮要靠它可达。
  if (parsed.keys.length === 0 && parsed.deleteServerId === null && !parsed.isKeysPage) {
    return { ok: false, reason: 'parse' };
  }
  // 页面确实是 keys 页才把明文喂给调用方（登录页等 parse 失败路径不触发）。
  onPlain?.(plainSink);
  return { ok: true, ...parsed };
}

/** POST /_server 的公共部分（urlencoded body + X-Server-Id + cookie）。 */
async function postServerFn(
  baseUrl: string,
  cookie: string | null,
  serverId: string,
  body: string,
  fetchImpl: FetchLike,
): Promise<LegacyWriteResult> {
  const bad = cookieFailure(legacyCookieStatus(cookie));
  if (bad) return { ok: false, reason: bad };
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/_server`, {
      method: 'POST',
      headers: {
        'x-server-id': serverId,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookie!,
      },
      body,
      signal: AbortSignal.timeout(LEGACY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
  if (!res.ok) return { ok: false, reason: 'upstream' };
  return { ok: true };
}

/**
 * 创建 key（实测协议：POST /_server + 创建函数 id + urlencoded
 * `name=<名称>&workspaceID=<ws>`）。
 */
export async function createLegacyKey(
  baseUrl: string,
  cookie: string | null,
  workspaceId: string,
  name: string,
  fetchImpl: FetchLike = fetch,
): Promise<LegacyWriteResult> {
  const body = `name=${encodeURIComponent(name)}&workspaceID=${encodeURIComponent(workspaceId)}`;
  return postServerFn(baseUrl, cookie, LEGACY_CREATE_SERVER_ID, body, fetchImpl);
}

/**
 * 删除 key（实测协议：POST /_server + body `id=<keyId>&workspaceID=<ws>`）。
 * serverId 优先用 SSR 解析的删除表单 id（跨构建稳定）；不传/传 null 时兜底
 * 硬编码常量（当前构建实测值）。
 */
export async function deleteLegacyKey(
  baseUrl: string,
  cookie: string | null,
  workspaceId: string,
  keyId: string,
  fetchImpl: FetchLike = fetch,
  serverId?: string | null,
): Promise<LegacyWriteResult> {
  const body = `id=${encodeURIComponent(keyId)}&workspaceID=${encodeURIComponent(workspaceId)}`;
  return postServerFn(baseUrl, cookie, serverId || LEGACY_DELETE_SERVER_ID_FALLBACK, body, fetchImpl);
}

// ---------------------------------------------------------------------------
// Go 订阅（/workspace/{id}/go）
// ---------------------------------------------------------------------------

/**
 * 从 go 页 HTML 提取订阅状态 + 三窗口用量 + 两个开关（SSR 水合解析）。
 *
 * 提取策略（与 parseLegacyKeysHtml 同款鲁棒正则，不依赖完整 JSON 结构）：
 * 1. `lite.subscription.get["<ws>"]` 键的槽位（$R[n]）从注册行提取；
 * 2. 找该槽位的 resolve 调用 `$R[k]($R[n],`，取到下一个 `);` 之间的值文本
 *    （实测值对象内无 `);`，嵌套引用 $R[m]={...} 与 new Date(...) 都不含）；
 *    值文本是裸 `null` = 未订阅；
 * 3. 字段逐个正则提取（SolidStart 序列化布尔是 `!0`/`!1`）；
 * 4. 中国模型开关不在水合里，读 SSR 渲染的 checkbox `checked` 属性。
 *
 * 页面里连 `lite.subscription.get[` 和 `billing.get[` 都没有 → 不是 go 页
 * （登录页等），返回 null，上层判 parse 失败。
 */
export function parseLegacyGoHtml(html: string, workspaceId: string): LegacyGoParse {
  const hasKey =
    html.includes('lite.subscription.get[') || html.includes('billing.get[');
  if (!hasKey) return null;

  const esc = workspaceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const slotRe = new RegExp(
    `lite\\.subscription\\.get\\[\\\\"${esc}\\\\"\\]\\"]=\\$R\\[\\d+\\]=\\$R\\[\\d+\\]\\(\\$R\\[(\\d+)\\]=\\{p:0,s:0,f:0\\}`,
  );
  const slot = slotRe.exec(html)?.[1];
  if (!slot) {
    // 键存在但形态对不上（旧构建序列化差异）：保守按未订阅处理，不误判页面。
    return {
      subscribed: false,
      useBalance: false,
      chinaModels: false,
      rolling: null,
      weekly: null,
      monthly: null,
    };
  }

  const resolveRe = new RegExp(`\\$R\\[\\d+\\]\\(\\$R\\[${slot}\\],`);
  const m = resolveRe.exec(html);
  const raw = m ? html.slice((m.index ?? 0) + m[0].length, html.indexOf(');', (m.index ?? 0) + m[0].length)) : 'null';
  const value = raw.trim();

  if (value === 'null') {
    return {
      subscribed: false,
      useBalance: false,
      chinaModels: false,
      rolling: null,
      weekly: null,
      monthly: null,
    };
  }

  const windowRe = (name: string): GoUsageWindow | null => {
    const w = new RegExp(`${name}:\\$R\\[\\d+\\]=\\{status:"(\\w+)",resetInSec:(\\d+),usagePercent:(\\d+)\\}`).exec(value);
    return w ? { status: w[1]!, resetInSec: Number(w[2]), usagePercent: Number(w[3]) } : null;
  };
  const boolOf = (field: string, dflt: boolean): boolean => {
    const b = new RegExp(`${field}:!(0|1)`).exec(value);
    // SolidStart 序列化：!0 = true，!1 = false（JS 对数字取反）。
    return b ? b[1] === '0' : dflt;
  };

  // 中国模型开关：SSR 渲染的 checkbox 带 checked = 开（未订阅页面无此 form，false）。
  const chinaForm = /name="useChinaProviders"[^>]*><label[^>]*><input type="checkbox"([^>]*)>/.exec(html);

  return {
    subscribed: true,
    useBalance: boolOf('useBalance', false),
    chinaModels: chinaForm ? /\bchecked\b/.test(chinaForm[1] ?? '') : false,
    rolling: windowRe('rollingUsage'),
    weekly: windowRe('weeklyUsage'),
    monthly: windowRe('monthlyUsage'),
  };
}

/**
 * 读 Go 订阅状态：GET go 页 → 解析 SSR 水合。
 * 失败分类与 fetchLegacyKeys 同款（401/403 → auth；网络/5xx → upstream；
 * 页面不像 go 页 → parse）。
 */
export async function fetchLegacyGoStatus(
  baseUrl: string,
  cookie: string | null,
  workspaceId: string,
  fetchImpl: FetchLike = fetch,
): Promise<LegacyGoReadResult> {
  const bad = cookieFailure(legacyCookieStatus(cookie));
  if (bad) return { ok: false, reason: bad };
  const url = `${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(workspaceId)}/go`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { cookie: cookie!, accept: 'text/html' },
      signal: AbortSignal.timeout(LEGACY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
  if (!res.ok) return { ok: false, reason: 'upstream' };
  let html: string;
  try {
    html = await res.text();
  } catch {
    return { ok: false, reason: 'parse' };
  }
  const parsed = parseLegacyGoHtml(html, workspaceId);
  if (parsed === null) return { ok: false, reason: 'parse' };
  return { ok: true, status: parsed };
}

// ---------------------------------------------------------------------------
// Zen usage（/zen/go/v1/usage，API key 通道，零 cookie）
// ---------------------------------------------------------------------------

/**
 * 用旧版 Default API Key 读 Go 订阅用量：GET {baseUrl}/zen/go/v1/usage。
 *
 * 2026-08-15 服务器实测：`Authorization: Bearer <旧版 Default API Key>` → 200
 * JSON `{"usage":{"rolling":{"status":"ok","percent":5,"resetsAt":"..."},...}}`；
 * 每个 key 返回该 key 所属 workspace 的订阅（与 HTML 抓取数据一致）。无效 key
 * → 401 `{"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}`。
 *
 * 映射到 LegacyGoStatus：percent → usagePercent；resetsAt → resetInSec（秒数，
 * 已过期钳到 0）；status 直接透传。zen 响应不含 useBalance/chinaModels/订阅标记
 * —— 200 即该 workspace 有 Go 订阅（subscribed=true），两个开关给 false
 * （写开关仍走 cookie 通道，见 setLegacyGoToggle）。
 *
 * 失败一律返回 null（不抛）：401/非 2xx/网络错/畸形 JSON 都由调用方 fallback
 * 到 cookie HTML 抓取。
 */
export async function fetchZenGoUsage(
  baseUrl: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<LegacyGoStatus | null> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/zen/go/v1/usage`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(ZEN_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return null;
  }
  const usage = (raw as { usage?: unknown } | null)?.usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const windowOf = (name: string): GoUsageWindow | null => {
    const w = u[name];
    if (typeof w !== 'object' || w === null) return null;
    const win = w as Record<string, unknown>;
    if (typeof win.status !== 'string') return null;
    const pct = Number(win.percent);
    if (!Number.isFinite(pct)) return null;
    const resetsAt = win.resetsAt;
    const resetInSec =
      typeof resetsAt === 'string' && Number.isFinite(Date.parse(resetsAt))
        ? Math.max(0, Math.floor((Date.parse(resetsAt) - Date.now()) / 1000))
        : 0;
    return { status: win.status, resetInSec, usagePercent: pct };
  };
  return {
    subscribed: true,
    useBalance: false,
    chinaModels: false,
    rolling: windowOf('rolling'),
    weekly: windowOf('weekly'),
    monthly: windowOf('monthly'),
  };
}

/**
 * 合并 zen 用量与 cookie HTML go 页的 Go 状态（go 端点 zen 优先路径用，见
 * server.ts handleLegacyGoStatus）：窗口与 subscribed 取 zen（零 cookie 通道，
 * 服务器实测数据一致）；开关（useBalance/chinaModels）取 cookie —— zen JSON
 * 无这两个字段恒 false。cookieStatus 为 null（cookie 缺失/失效/解析失败）时
 * 返回 zen 原样，开关保持 false —— 与 zen 单独使用时一致，不新增错误面；
 * cookie 失败不阻塞窗口数据返回。
 */
export function mergeLegacyGoStatus(
  zen: LegacyGoStatus,
  cookieStatus: LegacyGoStatus | null,
): LegacyGoStatus {
  if (!cookieStatus) return zen;
  return {
    ...zen,
    useBalance: cookieStatus.useBalance,
    chinaModels: cookieStatus.chinaModels,
  };
}

/**
 * 写 Go 开关（实测协议：POST /_server + X-Server-Id + urlencoded
 * `workspaceID=<ws>&<field>=true|false`）。toggle 决定走哪个 server 函数：
 * 'useBalance' → useBalance 字段 + LEGACY_GO_USE_BALANCE_SERVER_ID；
 * 'chinaModels' → useChinaProviders 字段 + LEGACY_GO_CHINA_SERVER_ID。
 */
export async function setLegacyGoToggle(
  baseUrl: string,
  cookie: string | null,
  workspaceId: string,
  toggle: 'useBalance' | 'chinaModels',
  value: boolean,
  fetchImpl: FetchLike = fetch,
): Promise<LegacyWriteResult> {
  const serverId =
    toggle === 'useBalance' ? LEGACY_GO_USE_BALANCE_SERVER_ID : LEGACY_GO_CHINA_SERVER_ID;
  const field = toggle === 'useBalance' ? 'useBalance' : 'useChinaProviders';
  const body = `workspaceID=${encodeURIComponent(workspaceId)}&${field}=${value ? 'true' : 'false'}`;
  return postServerFn(baseUrl, cookie, serverId, body, fetchImpl);
}

// ---------------------------------------------------------------------------
// 旧版 billing（/workspace/{id}/billing）
// ---------------------------------------------------------------------------

/** 自动充值配置（水合 reload 字段；金额是美元整数，不是 units）。 */
export interface LegacyBillingReload {
  enabled: boolean;
  /** 余额低于该美元数时触发自动充值（水合 reloadTrigger，美元）。 */
  thresholdDollars: number;
  /** 每次自动充值的美元数（水合 reloadAmount，美元）。 */
  amountDollars: number;
}

/** 一条支付记录（payment.list 水合元素）。 */
export interface LegacyBillingPayment {
  /** 金额（美元；水合 amount 是整数 units，UNITS_PER_DOLLAR = $1）。 */
  amount: number;
  /** 支付时间（timeCreated 的 Date 字符串，ISO；缺失为 null）。 */
  date: string | null;
  /** 描述（enrichment.type + couponID 拼的；缺失为 null）。 */
  description: string | null;
}

/** 旧版 billing 页的读取结果。 */
export interface LegacyBilling {
  /** 当前余额（美元；水合 balance 是整数 units）。 */
  balanceDollars: number;
  /** 自动充值配置（水合 reload 对象；null = 未启用）。 */
  reload: LegacyBillingReload | null;
  /** 支付历史（payment.list；无记录为空数组）。 */
  payments: LegacyBillingPayment[];
  /** 每月限额（美元；水合 monthlyLimit 是整数 units；null = 未设置）。 */
  monthlyLimitDollars: number | null;
}

/** parseLegacyBillingHtml 的输出（null = 页面不是 billing 页）。 */
export type LegacyBillingParse = LegacyBilling | null;

/** billing 读的结果。 */
export type LegacyBillingReadResult =
  | { ok: true; billing: LegacyBilling }
  | { ok: false; reason: 'no-cookie' | 'wrong-console' | 'auth' | 'upstream' | 'parse' };

/**
 * 从 billing 页 HTML 提取余额 + 自动充值 + 支付历史（SSR 水合解析）。
 *
 * 提取策略（与 parseLegacyGoHtml 同款槽位+resolve 模式，实测 2026-08-12）：
 * 1. `billing.get["<ws>"]` 与 `payment.list["<ws>"]` 的槽位（$R[n]）从
 *    注册行提取（`_$HY.r["key[..."]=$R[n]=$R[m]($R[k]={p:0,s:0,f:0})`）；
 * 2. 找该槽位的 resolve 调用 `$R[x]($R[n],`，取到下一个 `);` 之间的值文本
 *    （实测值对象内无 `);`，new Date(...) 与嵌套 $R 引用都不含）；
 * 3. 字段逐个正则提取（SolidStart 序列化布尔是 !0/!1，金额是裸整数）；
 * 4. payment.list 的 resolve 值是一整段数组文本，按 `{id:"pay_` 锚点分段，
 *    每段独立提取（对象内含 enrichment 嵌套对象，不能按第一个 `}` 截断）。
 *
 * 页面里连 `billing.get[` 和 `payment.list[` 都没有 → 不是 billing 页
 * （登录页等），返回 null，上层判 parse 失败。
 */
export function parseLegacyBillingHtml(html: string, workspaceId: string): LegacyBillingParse {
  const hasKey = html.includes('billing.get[') || html.includes('payment.list[');
  if (!hasKey) return null;

  const esc = workspaceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** 槽位注册行里取 $R 编号；形态对不上返回 null。 */
  const slotOf = (key: string): string | null => {
    const slotRe = new RegExp(
      `${key}\\[\\\\"${esc}\\\\"\\]\\"]=\\$R\\[\\d+\\]=\\$R\\[\\d+\\]\\(\\$R\\[(\\d+)\\]=\\{p:0,s:0,f:0\\}`,
    );
    return slotRe.exec(html)?.[1] ?? null;
  };
  /** 取槽位 resolve 调用的值文本；找不到按 null 处理（保守）。 */
  const resolveOf = (slot: string): string => {
    const m = new RegExp(`\\$R\\[\\d+\\]\\(\\$R\\[${slot}\\],`).exec(html);
    if (!m) return 'null';
    const start = (m.index ?? 0) + m[0].length;
    const end = html.indexOf(');', start);
    return end < 0 ? 'null' : html.slice(start, end);
  };
  /** 数字兜底：null/缺失/非法 → dflt。 */
  const num = (s: string | undefined, dflt: number): number => {
    if (s === undefined || s === 'null') return dflt;
    const n = Number(s);
    return Number.isFinite(n) ? n : dflt;
  };

  const billingSlot = slotOf('billing\\.get');
  const billingRaw = billingSlot ? resolveOf(billingSlot) : 'null';

  // reload：对象 = 已启用；amount/trigger 是美元整数（实测顶层 reloadAmount/
  // reloadTrigger 也是美元），对象内缺字段时兜底读顶层。
  const topAmount = /reloadAmount:(\d+)/.exec(billingRaw)?.[1];
  const topTrigger = /reloadTrigger:(\d+)/.exec(billingRaw)?.[1];
  let reload: LegacyBillingReload | null = null;
  const reloadObj = /reload:(?:\$R\[\d+\]=)?(\{[^}]*\}|null)/.exec(billingRaw)?.[1];
  if (reloadObj && reloadObj !== 'null') {
    reload = {
      enabled: true,
      thresholdDollars: num(/trigger:(\d+)/.exec(reloadObj)?.[1], num(topTrigger, 0)),
      amountDollars: num(/amount:(\d+)/.exec(reloadObj)?.[1], num(topAmount, 0)),
    };
  }

  // payments：resolve 值是一整段数组文本，按 `{id:"pay_` 锚点分段。
  const payments: LegacyBillingPayment[] = [];
  const paySlot = slotOf('payment\\.list');
  if (paySlot) {
    const payRaw = resolveOf(paySlot);
    const anchors = [...payRaw.matchAll(/\{id:"pay_[^"]*"/g)];
    for (let i = 0; i < anchors.length; i++) {
      const start = anchors[i]!.index ?? 0;
      const end = i + 1 < anchors.length ? (anchors[i + 1]!.index ?? payRaw.length) : payRaw.length;
      const seg = payRaw.slice(start, end);
      const enr = /enrichment:(?:\$R\[\d+\]=)?(\{[^}]*\}|null)/.exec(seg)?.[1] ?? null;
      const enrType = enr && enr !== 'null' ? /type:"([^"]+)"/.exec(enr)?.[1] ?? null : null;
      const coupon = enr && enr !== 'null' ? /couponID:"([^"]+)"/.exec(enr)?.[1] ?? null : null;
      const description = [enrType, coupon].filter((x): x is string => x !== null).join(' · ') || null;
      payments.push({
        amount: num(/amount:(\d+)/.exec(seg)?.[1], 0) / UNITS_PER_DOLLAR,
        date: /timeCreated:(?:\$R\[\d+\]=)?new Date\("([^"]+)"\)/.exec(seg)?.[1] ?? null,
        description,
      });
    }
  }

  const monthly = /monthlyLimit:(null|\d+)/.exec(billingRaw)?.[1];
  return {
    balanceDollars: num(/balance:(\d+)/.exec(billingRaw)?.[1], 0) / UNITS_PER_DOLLAR,
    reload,
    payments,
    monthlyLimitDollars: monthly === 'null' || monthly === undefined ? null : Number(monthly) / UNITS_PER_DOLLAR,
  };
}

/**
 * 读旧版 workspace 的 billing：GET billing 页 → 解析 SSR 水合。
 * 失败分类与 fetchLegacyKeys 同款（401/403 → auth；网络/5xx → upstream；
 * 页面不像 billing 页 → parse）。billing 是读操作，只返回聚合数据，
 * cookie 明文不进响应。
 */
export async function fetchLegacyBilling(
  baseUrl: string,
  cookie: string | null,
  workspaceId: string,
  fetchImpl: FetchLike = fetch,
): Promise<LegacyBillingReadResult> {
  const bad = cookieFailure(legacyCookieStatus(cookie));
  if (bad) return { ok: false, reason: bad };
  const url = `${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(workspaceId)}/billing`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { cookie: cookie!, accept: 'text/html' },
      signal: AbortSignal.timeout(LEGACY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
  if (!res.ok) return { ok: false, reason: 'upstream' };
  let html: string;
  try {
    html = await res.text();
  } catch {
    return { ok: false, reason: 'parse' };
  }
  const parsed = parseLegacyBillingHtml(html, workspaceId);
  if (parsed === null) return { ok: false, reason: 'parse' };
  return { ok: true, billing: parsed };
}
