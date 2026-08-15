/**
 * 管理面板（/__admin）：单文件内联 HTML + 路由处理函数（MULTI-ACCOUNT.md §6/§7）。
 *
 * 与 dashboard.ts 同风格：ADMIN_HTML 是 `String.raw` 模板，CSS + HTML + 原生 JS
 * 全部内联，零外部依赖。纯函数式 handler，不持任何状态 —— 所有数据都从
 * deps（cfg/store/pool）现取，方便测试注入（fake fetch / fake 时间源）。
 *
 * 隐私口径：任何响应（HTML / JSON）绝不含 key / cookie 明文。key 只以指纹
 * （末 4 位）出现；billing cookie 只在进程内解密、只发给 opencode.ai 抓取页。
 *
 * Origin 校验（CSRF）放在这里而不是 server.ts：它是「管理面写操作」专属的
 * 防护（GET 只读不设防），与端点清单绑在一起自包含，server.ts 主路由只管
 * 鉴权分派，不让 990 行的路由再膨胀。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AppConfig } from './config.js';
import { keyFingerprint } from './keypool.js';
import type { KeyPool } from './keypool.js';
import type { AccountKind, AccountPatch, AccountsStore } from './accounts.js';
import { buildAccountsSection } from './accounts.js';
import type { BillingAccounts } from './billing.js';
import { refreshBilling, type FetchLike } from './billing.js';
import type { UsageDb } from './usagedb.js';
import { deleteModelAlias, loadModelAliases, saveModelAlias } from './modelmap.js';
import { ModelAccessStore } from './modelaccess.js';
import { stripControl } from './errors.js';
import { extractDevice } from './metrics.js';

// ---------------------------------------------------------------------------
// 请求体读取（与 server.ts 的 readBody/parseJson 保持同语义：408/413/空体区分）
// ---------------------------------------------------------------------------

const BODY_READ_TIMEOUT_MS = 30_000;

function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: { ok: true; text: string } | { ok: false; status: number }): void => {
      if (done) return;
      done = true;
      resolve(result);
    };
    req.setTimeout(BODY_READ_TIMEOUT_MS, () => {
      finish({ ok: false, status: 408 });
      req.destroy();
    });
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (maxBytes > 0 && size > maxBytes) {
        finish({ ok: false, status: 413 });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      req.setTimeout(0);
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => {
      req.setTimeout(0);
      finish({ ok: false, status: 400 });
    });
  });
}

function parseJson(text: string): { ok: true; body: unknown } | { ok: false; empty: boolean } {
  if (text.length === 0) return { ok: false, empty: true };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, empty: false };
  }
}

const BODY_READ_STATUS_MESSAGE: Record<number, string> = {
  408: 'request body read timed out',
  413: 'request body too large',
};

/** 审计打点的调用方 IP（与 requests 落库同一来源 metrics.extractDevice）。 */
function auditIp(req: IncomingMessage): string | null {
  return extractDevice(req).ip || null;
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// 字段校验（MULTI-ACCOUNT.md §6.3：任一失败 400 + 现有错误形状）
// ---------------------------------------------------------------------------

type ValidateResult<T> = { ok: true; value: T } | { ok: false; message: string };

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

function isKind(v: unknown): v is AccountKind {
  return v === 'subscription' || v === 'payg' || v === 'unknown';
}

/** POST 创建账户的校验产物（明文 keys 只在这里短暂存在，随即加密落盘）。 */
export interface CreateAccountInput {
  name: string;
  kind: AccountKind;
  workspaceId: string | null;
  keys: string[];
  cookie: string | null;
}

/** POST /__admin/api/accounts 的字段校验（§6.3）。 */
export function validateCreateAccount(body: unknown): ValidateResult<CreateAccountInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;

  if (typeof b.name !== 'string') {
    return fail('name is required and must be a non-empty string');
  }
  // 控制符剥离（m2）：账号名会落库并渲染到面板/日志，控制符能伪造终端
  // 输出；剥离后做非空与长度校验（剥离后只会更短）。
  const name = stripControl(b.name.trim());
  if (name === '') return fail('name is required and must be a non-empty string');
  if (name.length > 100) return fail('name must be at most 100 characters');

  if (!isKind(b.kind)) return fail('kind must be one of: subscription, payg, unknown');

  const keys = parseKeys(b.keys);
  if (!keys.ok) return keys;

  const workspaceId = parseWorkspaceId(b.workspaceId);
  if (!workspaceId.ok) return workspaceId;

  const cookie = parseCookie(b.cookie);
  if (!cookie.ok) return cookie;

  return {
    ok: true,
    value: { name, kind: b.kind, workspaceId: workspaceId.value, keys: keys.value, cookie: cookie.value },
  };
}

/**
 * PATCH 契约（服务端 accounts.ts 会给 AccountPatch 加 `allowedModels?: string[] | null`）。
 * 本文件先走 `AccountPatch & {...}` 交并类型：契约落地前后都能编译，落地后多余字段
 * 与基类字段合并，无任何副作用。
 */
export type PatchWithAllowedModels = AccountPatch & { allowedModels?: string[] | null };

/** PATCH /__admin/api/accounts/:id 的字段校验（§6.3）。undefined 不更新。 */
export function validatePatchAccount(body: unknown): ValidateResult<PatchWithAllowedModels> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  const patch: PatchWithAllowedModels = {};

  if (b.name !== undefined) {
    if (typeof b.name !== 'string') {
      return fail('name must be a non-empty string');
    }
    const name = stripControl(b.name.trim());
    if (name === '') return fail('name must be a non-empty string');
    if (name.length > 100) return fail('name must be at most 100 characters');
    patch.name = name;
  }

  if (b.kind !== undefined) {
    if (!isKind(b.kind)) return fail('kind must be one of: subscription, payg, unknown');
    patch.kind = b.kind;
  }

  if (b.workspaceId !== undefined) {
    const workspaceId = parseWorkspaceId(b.workspaceId);
    if (!workspaceId.ok) return workspaceId;
    patch.workspaceId = workspaceId.value;
  }

  if (b.legacyWorkspaceId !== undefined) {
    // 旧版控制台（opencode.ai）的 workspace id（wrk_ 前缀）；null 清除。
    if (b.legacyWorkspaceId === null) {
      patch.legacyWorkspaceId = null;
    } else if (typeof b.legacyWorkspaceId !== 'string' || b.legacyWorkspaceId.trim() === '') {
      return fail('legacyWorkspaceId must be a non-empty string or null');
    } else if (b.legacyWorkspaceId.length > 200) {
      return fail('legacyWorkspaceId must be at most 200 characters');
    } else {
      patch.legacyWorkspaceId = b.legacyWorkspaceId.trim();
    }
  }

  if (b.cookie !== undefined) {
    const cookie = parseCookie(b.cookie);
    if (!cookie.ok) return cookie;
    patch.cookie = cookie.value;
  }

  if (b.legacyCookie !== undefined) {
    // 旧版控制台独立会话 cookie（与主 cookie 槽互斥）；null/空串清除。
    if (b.legacyCookie === null || b.legacyCookie === '') {
      patch.legacyCookie = null;
    } else if (typeof b.legacyCookie !== 'string') {
      return fail('legacyCookie must be a string or null');
    } else if (b.legacyCookie.length > 2048) {
      return fail('legacyCookie must be at most 2048 characters');
    } else {
      const cleaned = stripControl(b.legacyCookie).slice(0, 2048);
      patch.legacyCookie = cleaned;
    }
  }

  if (b.legacyKey !== undefined) {
    // 旧版 Default API Key（zen usage JSON API 用，免 cookie）；null/空串清除。
    if (b.legacyKey === null || b.legacyKey === '') {
      patch.legacyKey = null;
    } else if (typeof b.legacyKey !== 'string') {
      return fail('legacyKey must be a string or null');
    } else if (b.legacyKey.length > 2048) {
      return fail('legacyKey must be at most 2048 characters');
    } else {
      const cleaned = stripControl(b.legacyKey).slice(0, 2048);
      patch.legacyKey = cleaned;
    }
  }

  // 可用模型覆盖：null / 空数组 / 全空串 = 清除（回全局默认），非空数组原样。
  if (b.allowedModels !== undefined) {
    const allowedModels = parseAllowedModels(b.allowedModels);
    if (!allowedModels.ok) return allowedModels;
    patch.allowedModels = allowedModels.value;
  }

  if (Object.keys(patch).length === 0) return fail('nothing to update');
  return { ok: true, value: patch };
}

/** keys：数组、每项非空 trim 后 ≤ 200 字符、去重、≤ 20 项。 */
function parseKeys(raw: unknown): ValidateResult<string[]> {
  if (!Array.isArray(raw)) return fail('keys must be an array of strings');
  if (raw.length > 20) return fail('keys must have at most 20 entries');
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return fail('each key must be a string');
    const k = item.trim();
    if (!k) return fail('keys must not contain empty entries');
    if (k.length > 200) return fail('each key must be at most 200 characters');
    if (!out.includes(k)) out.push(k);
  }
  return { ok: true, value: out };
}

/**
 * allowedModels：可选。null / 空数组 / 全空串项 → null（清除，回全局默认）。
 * 数组项 trim、≤ 100 字符、去重、≤ 50 项（与 keys 的校验口径一致）。
 * 不做白名单校验——别名模型（model_aliases 表）同样是合法输入，交给服务端处理。
 */
function parseAllowedModels(raw: unknown): ValidateResult<string[] | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (!Array.isArray(raw)) return fail('allowedModels must be an array of strings');
  if (raw.length > 50) return fail('allowedModels must have at most 50 entries');
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return fail('each allowed model must be a string');
    const t = item.trim();
    if (!t) return fail('allowedModels must not contain empty entries');
    if (t.length > 100) return fail('each allowed model must be at most 100 characters');
    if (!out.includes(t)) out.push(t);
  }
  return { ok: true, value: out.length ? out : null };
}

/**
 * workspaceId：可选。null / 空串 / 纯空白都归一为 null（宽松处理：
 * 表单空着提交 = 没填，不必为「空串还是 null」报 400）。
 */
function parseWorkspaceId(raw: unknown): ValidateResult<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return fail('workspaceId must be a string');
  const t = raw.trim();
  if (t === '') return { ok: true, value: null };
  if (t.length > 200) return fail('workspaceId must be at most 200 characters');
  return { ok: true, value: t };
}

/**
 * cookie：可选，≤ 4096 字符。空串 = 清除（与 PATCH 语义一致）。
 *
 * 规范化（B1，与 import-cookie 同语义）：落库值统一为**完整 name=value**。
 * 手动粘贴的裸值（`Fe26.2*...`）自动补 `auth=` 前缀 —— billing 通道发送时
 * 原样带出（旧版本曾假设裸值，这里把历史输入也收敛到新格式）。
 * 已带 `=` 的完整串（`__Host-console_session=x` / `auth=x`）原样保留。
 */
function parseCookie(raw: unknown): ValidateResult<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return fail('cookie must be a string');
  if (raw === '') return { ok: true, value: null };
  if (raw.length > 4096) return fail('cookie must be at most 4096 characters');
  const normalized = raw.includes('=') ? raw : `auth=${raw}`;
  // 控制符剥离（m2）：cookie 值会作为请求头发送给上游并落库，控制符能
  // 伪造日志/终端注入。剥离只删字符不可能变长，长度校验维持原输入口径。
  return { ok: true, value: stripControl(normalized) };
}

/** :id 必须是纯数字（§6.3），否则 400。 */
export function parseAccountId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** POST /__admin/api/model-aliases 的校验产物。 */
export interface ModelAliasInput {
  alias: string;
  target: string;
  note: string | null;
}

/**
 * 模型映射的字段校验。alias：1-100 字符、限字母数字 `._-`（模型名常见字符集，
 * 宽松但排除空白/控制符）；target：非空 ≤100；note：可选 ≤200，空串归一 null。
 */
export function validateModelAlias(body: unknown): ValidateResult<ModelAliasInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.alias !== 'string') return fail('alias must be a string');
  const alias = b.alias.trim();
  if (alias.length === 0 || alias.length > 100 || !/^[A-Za-z0-9._-]+$/.test(alias)) {
    return fail('alias must be 1-100 characters of letters, digits, dot, dash or underscore');
  }
  if (typeof b.target !== 'string') return fail('target must be a string');
  const target = b.target.trim();
  if (target.length === 0 || target.length > 100) {
    return fail('target must be a non-empty string of at most 100 characters');
  }
  let note: string | null = null;
  if (b.note != null) {
    if (typeof b.note !== 'string') return fail('note must be a string or null');
    const t = b.note.trim();
    if (t.length > 200) return fail('note must be at most 200 characters');
    note = t === '' ? null : t;
  }
  return { ok: true, value: { alias, target, note } };
}

// ---------------------------------------------------------------------------
// 依赖注入 + 路由
// ---------------------------------------------------------------------------

export interface AdminDeps {
  cfg: AppConfig;
  /** 账户数据面。null = 未接线（本轮 main.ts 尚未接线 / 测试未传）。 */
  store: AccountsStore | null;
  pool: KeyPool;
  log?: (msg: string) => void;
  /** billing 抓取的 fetch 注入点（测试用 fake；生产用全局 fetch）。 */
  fetchImpl?: FetchLike;
  /** 时间源注入（测试固定 now）。 */
  now?: () => number;
  /** 用量库（模型映射的存储层；null = 未接线，映射功能降级为空/503）。 */
  db?: UsageDb | null;
  /** console 数据通道（Bearer/cookie 读 /api/billing/status）。null = 未接线。 */
  consoleClient?: {
    billingStatus(id: number): Promise<unknown | null>;
    noteCredentialChanged?(id: number): void;
    /** 通道健康态（区分「cookie 失效」与「上游故障」用，见 handleRefreshBilling）。 */
    cookieStatus?(id: number): 'ok' | 'invalid';
    lastError?(id: number): 'auth' | 'upstream' | 'no-cred' | null;
  } | null;
  /** 密钥-模型授权层（MODEL-ACCESS）：删账户/删 key 时清理 upstream-key 授权行。
   *  未注入时按 deps.db 自建（无 db 则跳过清理——降级路径，清理是卫生操作非安全边界）。 */
  modelAccess?: ModelAccessStore | null;
}

/**
 * Origin 校验（§6.1）：写操作若带非空 Origin 且不等于 `http://<host>:<port>`
 * （同源，回环场景浏览器自动带）→ 403。无 Origin 放行（curl 等非浏览器场景）。
 */
/** 管理面写操作的 Origin 校验：只认「origin 的 hostname+端口 == Host 头」。
 *  fail-closed：多值 Origin 头（Node 在部分版本/代理后解析成数组）按拒绝处理——
 *  语义「多 Origin 任一匹配即放行」不可信，浏览器发不出多值 Origin（fetch 只
 *  允许单值），出现数组头只可能是代理/恶意客户端。空/缺失 Origin 放行（curl
 *  等非浏览器场景）。
 *  不比较 scheme —— HTTPS 反代（nginx/cloudflared TLS 终止）后面 Origin 是
 *  https:// 而 Host 头不变，写死 http 会让所有写操作 403。跨站攻击者的
 *  origin hostname 必然不同（同 hostname 不同端口也算跨站，端口也归一比较）。 */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin == null || origin === '') return true;
  if (typeof origin !== 'string') return false;
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0) return false;
  try {
    const o = new URL(origin);
    const h = new URL(`http://${host}`);
    if (o.hostname !== h.hostname) return false;
    // 端口规则：Host 带显式端口 → 严格比较；Host 无端口（cloudflared/nginx
    // 反代 TLS 终止后的常态）→ Origin 端口必须是标准端口（80/443）。
    // 反例（曾 403）：Origin https://x（443）vs Host x（解析成 http 默认 80）
    // —— 生产 HTTPS 场景 Host 不带端口，不能按 http:80 推断。
    const originPort = o.port || (o.protocol === 'https:' ? '443' : '80');
    if (h.port !== '') return h.port === originPort;
    return originPort === '80' || originPort === '443';
  } catch {
    return false;
  }
}

/** AccountsStore → billing 模块的最小接口适配（billing 用 duck typing，避免循环 import）。 */
function toBillingAccounts(store: AccountsStore): BillingAccounts {
  return {
    list: () =>
      store.list().map((a) => ({
        id: a.id,
        name: a.name,
        workspaceId: a.workspaceId,
        // hasCookie 是「有没有可用的 billing cookie」的布尔事实；cookieOf 进程内解密，
        // 解密失败（损坏）按没有处理。账户只有个位数，逐行解密代价可忽略。
        hasCookie: a.workspaceId != null && store.cookieOf(a.id) != null,
      })),
    billingCredential: (id) => store.cookieOf(id),
    // billing 用 lastBillingAt 字段名，AccountsStore 用 at —— 适配层转换。
    setBilling: (id, patch) => void store.setBilling(id, { ...patch, at: patch.lastBillingAt }),
  };
}

/** 管理面写操作的统一 503（数据面不可用）。 */
function sendUnavailable(res: ServerResponse, store: AccountsStore | null): void {
  const reason = store == null ? 'accounts module not wired' : `accounts unavailable: ${store.disabledReason ?? 'unknown'}`;
  sendJson(res, 503, { error: { message: reason, type: 'server_error' } });
}

/** 404（账户或 key 不存在）。 */
function sendNotFound(res: ServerResponse, message: string): void {
  sendJson(res, 404, { error: { message, type: 'not_found_error' } });
}

/**
 * /__admin 全部路径的请求分派。调用方（server.ts）已先过 isAdminRequest 鉴权，
 * 这里只处理业务：页面、查询、写操作（含 Origin 校验与字段校验）。
 */
export async function handleAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const { cfg, store, pool } = deps;
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string): void => console.warn(m));

  // 页面：恒 200（degraded 态由页面顶部提示条展示）。
  if (req.method === 'GET' && path === '/__admin') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(ADMIN_HTML);
    return;
  }

  if (path === '/__admin/api/accounts' && req.method === 'GET') {
    // 未接线时给一个可解释的 degraded（页面顶部提示条的数据源）。
    const section = store == null ? { degraded: 'accounts module not wired', list: [] } : buildAccountsSection(store, pool, now());
    sendJson(res, 200, section);
    return;
  }

  // 模型映射（设置页）：只依赖用量库，不依赖 accounts 数据面。GET 只读不设防。
  if (path === '/__admin/api/model-aliases' && req.method === 'GET') {
    sendJson(res, 200, { aliases: loadModelAliases(deps.db ?? null) });
    return;
  }

  // 其余全部是写操作：先过 Origin 校验，再检查数据面可用性。
  if (!originAllowed(req)) {
    sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
    return;
  }

  // 模型映射写操作（POST/DELETE）：只依赖 db —— accounts 数据面不可用
  // （如 secret 缺失）时映射仍应可用，所以放在 store 可用性检查之前。
  if (path === '/__admin/api/model-aliases' && req.method === 'POST') {
    await handleSaveModelAlias(req, res, deps);
    return;
  }
  const maRest = path.startsWith('/__admin/api/model-aliases/') ? path.slice('/__admin/api/model-aliases/'.length) : null;
  if (maRest != null && req.method === 'DELETE') {
    await handleDeleteModelAlias(req, res, deps, maRest);
    return;
  }

  if (store == null || !store.enabled) {
    sendUnavailable(res, store);
    return;
  }

  if (path === '/__admin/api/accounts' && req.method === 'POST') {
    await handleCreate(req, res, deps);
    return;
  }

  const rest = path.startsWith('/__admin/api/accounts/') ? path.slice('/__admin/api/accounts/'.length) : null;
  if (rest == null) {
    sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
    return;
  }
  const segs = rest.split('/');

  if (segs.length === 1) {
    const id = parseAccountId(segs[0]!);
    if (id == null) return void sendBadId(res);
    if (req.method === 'PATCH') {
      await handlePatch(req, res, deps, id);
      return;
    }
    if (req.method === 'DELETE') {
      handleDelete(req, res, deps, id);
      return;
    }
  } else if (segs.length === 2) {
    const id = parseAccountId(segs[0]!);
    if (id == null) return void sendBadId(res);
    if (segs[1] === 'keys' && req.method === 'POST') {
      await handleAddKey(req, res, deps, id);
      return;
    }
    if (segs[1] === 'billing' && req.method === 'POST') {
      await handleRefreshBilling(req, res, deps, id);
      return;
    }
  } else if (segs.length === 3 && segs[1] === 'keys') {
    const id = parseAccountId(segs[0]!);
    if (id == null) return void sendBadId(res);
    // m4：畸形 % 编码（如 %zz）会让 decodeURIComponent 抛 URIError 穿透到
    // server 兜底 catch → 500。这里是「指纹格式错误」，该是 400。
    let fingerprint: string;
    try {
      fingerprint = decodeURIComponent(segs[2] ?? '');
    } catch {
      sendJson(res, 400, { error: { message: 'invalid key fingerprint encoding', type: 'invalid_request_error' } });
      return;
    }
    if (!fingerprint || fingerprint.length > 64) {
      sendJson(res, 400, { error: { message: 'invalid key fingerprint', type: 'invalid_request_error' } });
      return;
    }
    if (req.method === 'GET' && fingerprint === 'plain') {
      // /accounts/:id/keys/plain：列出完整 key 明文（面板复制用）。凭证级
      // 读端点，读也强制 Origin 校验（与 billing / legacy keys-plain 同口径）。
      if (!originAllowed(req)) {
        sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
        return;
      }
      await handleAccountKeysPlain(req, res, deps, id);
      return;
    }
    if (req.method === 'DELETE') {
      handleRemoveKey(req, res, deps, id, fingerprint);
      return;
    }
    if (req.method === 'PATCH') {
      await handleRenameKey(req, res, deps, id, fingerprint);
      return;
    }
  }

  sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
}

function sendBadId(res: ServerResponse): void {
  sendJson(res, 400, { error: { message: 'account id must be a positive integer', type: 'invalid_request_error' } });
}

/** 读 JSON 请求体（readBody → parseJson → 统一 400/408/413 错误形状）。 */
async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AppConfig,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const read = await readBody(req, cfg.maxBodyBytes);
  if (!read.ok) {
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return { ok: false };
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    const message = parsed.empty
      ? 'request body is empty — a proxy or relay in front of this gateway likely dropped it'
      : 'invalid JSON body';
    sendJson(res, 400, { error: { message, type: 'invalid_request_error' } });
    return { ok: false };
  }
  return { ok: true, body: parsed.body };
}

/** POST /__admin/api/accounts：创建（落盘 → pool 热加载 → 201 返回账户）。 */
async function handleCreate(req: IncomingMessage, res: ServerResponse, deps: AdminDeps): Promise<void> {
  const read = await readJsonBody(req, res, deps.cfg);
  if (!read.ok) return;
  const v = validateCreateAccount(read.body);
  if (!v.ok) {
    sendJson(res, 400, { error: { message: v.message, type: 'invalid_request_error' } });
    return;
  }
  const store = deps.store!;
  const created = store.create(v.value);
  if (!created.ok) {
    // m6：key 已属于其他账户 → 400（数据层的跨账户知识转成业务错误）。
    // 审计在调用后记录：失败的创建也要留痕（op/ok/note，绝不记 key 明文）。
    deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.create', accountId: null, ok: false, note: created.reason, ip: auditIp(req) });
    if (created.reason === 'conflict') {
      sendJson(res, 400, {
        error: { message: `key already belongs to account "${created.ownerName}"`, type: 'invalid_request_error' },
      });
      return;
    }
    sendJson(res, 500, { error: { message: 'failed to create account', type: 'server_error' } });
    return;
  }
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.create', accountId: created.value.id, ok: true, note: created.value.name, ip: auditIp(req) });
  // §3.4 热加载：落盘 → 进内存。新 key 的 lastUsedAt=0 → 下一轮探针自动探它。
  for (const key of v.value.keys) deps.pool.addKey(key, created.value.id);
  sendAccount(res, 201, deps, created.value.id);
}

/** PATCH /__admin/api/accounts/:id：改名/改 kind/改 workspaceId/换 cookie。 */
async function handlePatch(req: IncomingMessage, res: ServerResponse, deps: AdminDeps, id: number): Promise<void> {
  if (deps.store!.get(id) == null) {
    sendNotFound(res, `account ${id} not found`);
    return;
  }
  const read = await readJsonBody(req, res, deps.cfg);
  if (!read.ok) return;
  const v = validatePatchAccount(read.body);
  if (!v.ok) {
    sendJson(res, 400, { error: { message: v.message, type: 'invalid_request_error' } });
    return;
  }
  const fields = Object.keys(v.value);
  if (!deps.store!.update(id, v.value)) {
    deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.patch', accountId: id, ok: false, note: 'update failed', ip: auditIp(req) });
    sendJson(res, 500, { error: { message: 'failed to update account', type: 'server_error' } });
    return;
  }
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.patch', accountId: id, ok: true, note: fields.join(','), ip: auditIp(req) });
  // 凭据更新（cookie/oauth）后重置 console 健康态——防旧 invalid 标记死锁（审查 H2）。
  if (v.value.cookie !== undefined || v.value.workspaceId !== undefined) {
    deps.consoleClient?.noteCredentialChanged?.(id);
  }
  // legacyCookie 走独立槽（加密存储）。落库失败不能静默吞：面板会显示已更新，
  // 实际没落库，下次重启/换会话就丢。此时主 PATCH 已应用（部分成功），
  // 明确 500 + 审计 note 说明是哪一步失败。
  if (v.value.legacyCookie !== undefined && !deps.store!.setLegacyCookie(id, v.value.legacyCookie)) {
    deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.patch', accountId: id, ok: false, note: 'legacy cookie save failed', ip: auditIp(req) });
    sendJson(res, 500, { error: { message: 'failed to update account', type: 'server_error' } });
    return;
  }
  // legacyKey 同样走独立加密槽（zen usage 用）。落库失败显式 500 + 审计 note。
  if (v.value.legacyKey !== undefined && !deps.store!.setLegacyKey(id, v.value.legacyKey)) {
    deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.patch', accountId: id, ok: false, note: 'legacy key save failed', ip: auditIp(req) });
    sendJson(res, 500, { error: { message: 'failed to update account', type: 'server_error' } });
    return;
  }
  sendAccount(res, 200, deps, id);
}

/** DELETE /__admin/api/accounts/:id：删账户 + 从 pool 移除其全部 key。 */
function handleDelete(req: IncomingMessage, res: ServerResponse, deps: AdminDeps, id: number): void {
  const store = deps.store!;
  const before = store.get(id);
  if (before == null) {
    sendNotFound(res, `account ${id} not found`);
    return;
  }
  const removed = store.remove(id);
  if (removed == null) {
    deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.delete', accountId: id, ok: false, note: 'remove failed', ip: auditIp(req) });
    sendJson(res, 500, { error: { message: 'failed to delete account', type: 'server_error' } });
    return;
  }
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.delete', accountId: id, ok: true, note: before.name, ip: auditIp(req) });
  for (const key of removed) deps.pool.removeKey(key);
  removeUpstreamKeyModelAccess(deps, removed);
  res.writeHead(204, { 'content-length': '0' });
  res.end();
}

/**
 * 清理一批明文 upstream key 的 model_access 授权行（D-P2-3）。key 被删后遗留的
 * upstream-key 行会继续约束 sha256(key) 对应的 key：同一个 key 值以后换账号重新
 * 添加时，仍被旧自定义模型限制（面板看不出来为什么受限）。删行 = 清除自定义
 * 回退全局默认。subject_id 与数据面口径一致：sha256(key) 全 hex（MODEL-ACCESS §2.2）。
 * 明文只在进程内流转（进 sha256 即丢），绝不进日志/响应。
 */
function removeUpstreamKeyModelAccess(deps: AdminDeps, keys: string[]): void {
  const ma = deps.modelAccess ?? (deps.db != null ? new ModelAccessStore(deps.db) : null);
  if (ma == null) return;
  for (const key of keys) {
    ma.setCustom('upstream-key', createHash('sha256').update(key, 'utf8').digest('hex'), null);
  }
}

/** POST /__admin/api/accounts/:id/keys：加一个 key（落盘 + pool 热加载）。 */
async function handleAddKey(req: IncomingMessage, res: ServerResponse, deps: AdminDeps, id: number): Promise<void> {
  if (deps.store!.get(id) == null) {
    sendNotFound(res, `account ${id} not found`);
    return;
  }
  const read = await readJsonBody(req, res, deps.cfg);
  if (!read.ok) return;
  const body = read.body as Record<string, unknown> | null;
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  if (!key || key.length > 200) {
    sendJson(res, 400, { error: { message: 'key must be a non-empty string of at most 200 characters', type: 'invalid_request_error' } });
    return;
  }
  const added = deps.store!.addKey(id, key);
  if (!added.ok) {
    // m6：跨账户冲突单独给话术；其余（重复/落库失败）沿用现有 400。
    const message =
      added.reason === 'conflict'
        ? `key already belongs to account "${added.ownerName}"`
        : 'key already exists';
    deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.add-key', accountId: id, ok: false, note: added.reason, ip: auditIp(req) });
    sendJson(res, 400, { error: { message, type: 'invalid_request_error' } });
    return;
  }
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.add-key', accountId: id, ok: true, note: keyFingerprint(key), ip: auditIp(req) });
  deps.pool.addKey(key, id);
  sendAccount(res, 200, deps, id);
}

/** DELETE /__admin/api/accounts/:id/keys/:fingerprint：按指纹删 key（匹配第一个）。 */
function handleRemoveKey(req: IncomingMessage, res: ServerResponse, deps: AdminDeps, id: number, fingerprint: string): void {
  const store = deps.store!;
  if (store.get(id) == null) {
    sendNotFound(res, `account ${id} not found`);
    return;
  }
  const removed = store.removeKey(id, fingerprint);
  if (removed == null) {
    deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.remove-key', accountId: id, ok: false, note: 'not found', ip: auditIp(req) });
    sendNotFound(res, `no key with fingerprint ${fingerprint} in account ${id}`);
    return;
  }
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.remove-key', accountId: id, ok: true, note: keyFingerprint(removed), ip: auditIp(req) });
  deps.pool.removeKey(removed);
  removeUpstreamKeyModelAccess(deps, [removed]);
  res.writeHead(204, { 'content-length': '0' });
  res.end();
}

/**
 * PATCH /__admin/api/accounts/:id/keys/:fingerprint：改 key 昵称。
 * body `{nickname: string|null}`：null / 空串 = 清除；字符串 trim 后 ≤ 30 字符。
 * 指纹 → 明文 key 的匹配走 store 的进程内能力（keysOf，明文只在进程内流转、
 * 绝不进响应/日志），与 handleRemoveKey 的 removeKey 同款口径。
 */
async function handleRenameKey(req: IncomingMessage, res: ServerResponse, deps: AdminDeps, id: number, fingerprint: string): Promise<void> {
  const store = deps.store!;
  if (store.get(id) == null) {
    sendNotFound(res, `account ${id} not found`);
    return;
  }
  const read = await readJsonBody(req, res, deps.cfg);
  if (!read.ok) return;
  const body = read.body as Record<string, unknown> | null;
  const raw = body?.nickname;
  let nickname: string | null;
  if (raw == null) {
    nickname = null;
  } else if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.length > 30) {
      sendJson(res, 400, { error: { message: 'nickname must be at most 30 characters', type: 'invalid_request_error' } });
      return;
    }
    nickname = t === '' ? null : t;
  } else {
    sendJson(res, 400, { error: { message: 'nickname must be a string or null', type: 'invalid_request_error' } });
    return;
  }
  const plain = (store.keysOf(id) ?? []).find((k) => keyFingerprint(k) === fingerprint) ?? null;
  if (plain == null) {
    sendNotFound(res, `no key with fingerprint ${fingerprint} in account ${id}`);
    return;
  }
  if (!store.setKeyNickname(id, plain, nickname)) {
    deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.rename-key', accountId: id, ok: false, note: 'update failed', ip: auditIp(req) });
    sendJson(res, 500, { error: { message: 'failed to update key nickname', type: 'server_error' } });
    return;
  }
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.rename-key', accountId: id, ok: true, note: keyFingerprint(plain), ip: auditIp(req) });
  sendAccount(res, 200, deps, id);
}

/**
 * GET /__admin/api/accounts/:id/keys/plain：该账号全部 key 明文（面板复制用）。
 * 凭证级读端点：路由处已过 isAdminRequest + adminOriginAllowed（读也防跨站）。
 * 明文来自 store.keysOf 的进程内解密，只出现在响应体，不进日志/审计。
 * 响应形状对齐 legacy 的 keys/plain（`{keys: [{plain, ...}]}`）——前端复制按钮
 * 一次拿全量，行级复制由前端按指纹挑。
 */
async function handleAccountKeysPlain(req: IncomingMessage, res: ServerResponse, deps: AdminDeps, id: number): Promise<void> {
  const store = deps.store!;
  if (store.get(id) == null) {
    sendNotFound(res, `account ${id} not found`);
    return;
  }
  const plainKeys = store.keysOf(id) ?? [];
  // 带掩码与明文一起给：前端行级复制按 fingerprint 匹配（列表里同 fp 的 key）。
  const keys = plainKeys.map((plain) => ({ plain, fingerprint: keyFingerprint(plain) }));
  sendJson(res, 200, { ok: true, data: { keys } });
}

/** POST /__admin/api/accounts/:id/billing：手动刷新余额（绕过调度器立即抓一次）。 */
async function handleRefreshBilling(req: IncomingMessage, res: ServerResponse, deps: AdminDeps, id: number): Promise<void> {
  if (deps.store!.get(id) == null) {
    sendNotFound(res, `account ${id} not found`);
    return;
  }
  // 先消费请求体（面板提交 `{}`）：不读的话请求字节留在 socket 上，Node 会
  // 在响应后关闭 keep-alive 连接 —— 面板每次刷新余额都白付一次 TCP 建连。
  // 与其余写操作同模式（readJsonBody 统一 400/408/413 错误形状）。
  const read = await readJsonBody(req, res, deps.cfg);
  if (!read.ok) return;
  // 优先 console 通道（新版 REST /api/billing/status，Bearer/cookie 皆可）；
  // 旧 SSR 页面解析（billing.ts）对新版控制台（SPA）永远 parse failed，降级兜底。
  const store = deps.store!;
  const cc = deps.consoleClient;
  if (cc) {
    const data = await cc.billingStatus(id);
    if (data == null) {
      // console 通道调用失败（null = 调用失败，不是合法空值）——区分 auth 与
      // 上游故障，报出真实原因，而不是误导性的「no balance in console response」。
      const auth = cc.cookieStatus?.(id) === 'invalid' || cc.lastError?.(id) === 'auth';
      deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.billing-refresh', accountId: id, ok: false, note: auth ? 'console auth invalid' : 'console channel error', ip: auditIp(req) });
      sendJson(res, 502, {
        error: {
          message: auth
            ? 'billing refresh failed: console login expired or invalid — update the account cookie or re-import from browser'
            : 'billing refresh failed: console channel error',
          type: auth ? 'channel_error' : 'upstream_error',
        },
      });
      return;
    }
    if (typeof data === 'object') {
      const rec = data as { balanceMicroCents?: unknown; combinedAvailableMicroCents?: unknown };
      const pick = (v: unknown): number | undefined => {
        if (v == null || v === '') return undefined;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
      };
      const units = pick(rec.combinedAvailableMicroCents) ?? pick(rec.balanceMicroCents);
      // 部分更新语义（setBilling §5.4）：余额字段缺失/非法（undefined）时保留历史
      // 余额，只在字段显式为 null（上游明确无余额）时清空 —— 否则一次缺字段的
      // 刷新会把历史余额抹成 null（面板显示 —），刷新 lastBillingAt，不算失败。
      const patch: { balanceUnits?: number | null; at: number } = { at: Date.now() };
      if (units !== undefined) patch.balanceUnits = units;
      else if (rec.combinedAvailableMicroCents === null || rec.balanceMicroCents === null) patch.balanceUnits = null;
      store.setBilling(id, patch);
      deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.billing-refresh', accountId: id, ok: true, note: 'ok', ip: auditIp(req) });
      sendAccount(res, 200, deps, id);
      return;
    }
    // 响应形状异常（非对象）→ 可读错误而非笼统 failed。
    deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.billing-refresh', accountId: id, ok: false, note: 'unexpected console shape', ip: auditIp(req) });
    sendJson(res, 502, { error: { message: 'billing refresh failed: unexpected console response shape', type: 'server_error' } });
    return;
  }
  const r = await refreshBilling(deps.cfg, toBillingAccounts(store), id, deps.log ?? console.log, deps.fetchImpl);
  if (!r.ok) {
    // §6.3：无 cookie → 400；其余抓取失败（网络/非 2xx/解析不出）→ 502。
    deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.billing-refresh', accountId: id, ok: false, note: r.reason, ip: auditIp(req) });
    if (r.reason === 'no workspace/cookie') {
      sendJson(res, 400, { error: { message: 'account has no billing cookie', type: 'invalid_request_error' } });
      return;
    }
    sendJson(res, 502, { error: { message: `billing refresh failed: ${r.reason}`, type: 'server_error' } });
    return;
  }
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.billing-refresh', accountId: id, ok: true, note: 'ok', ip: auditIp(req) });
  sendAccount(res, 200, deps, id);
}

/** 统一输出单个账户（buildAccountsSection 同构，防结构漂移）。 */
function sendAccount(res: ServerResponse, status: number, deps: AdminDeps, id: number): void {
  const section = buildAccountsSection(deps.store!, deps.pool, deps.now?.() ?? Date.now());
  const item = section.list.find((a) => a.id === id);
  if (item == null) {
    sendJson(res, 500, { error: { message: 'account vanished after mutation', type: 'server_error' } });
    return;
  }
  // §6.2 响应形状：单个账户对象不含 workspaceId 等内部字段（列表视图展示
  // workspace 走独立通道：/__admin/api/accounts 的 section + workspaces 端点）。
  const { workspaceId: _ws, legacyWorkspaceId: _lws, ...account } = item;
  sendJson(res, status, { account });
}

/** 模型映射的 db 可用性检查（共用 503 话术）。 */
function sendModelMapUnavailable(res: ServerResponse, db: UsageDb | null): void {
  const reason = db == null ? 'usage db not wired' : `usage db unavailable: ${db.disabledReason ?? 'unknown'}`;
  sendJson(res, 503, { error: { message: reason, type: 'server_error' } });
}

/**
 * POST /__admin/api/model-aliases：新增或更新一条映射。
 * 落库成功后再原地改 cfg.modelMap —— resolveModelName 每次读的是同一个对象
 * 引用，改完立即在代理链路生效（无需重启）。
 */
async function handleSaveModelAlias(req: IncomingMessage, res: ServerResponse, deps: AdminDeps): Promise<void> {
  const db = deps.db ?? null;
  if (db == null || !db.enabled) {
    sendModelMapUnavailable(res, db);
    return;
  }
  const read = await readJsonBody(req, res, deps.cfg);
  if (!read.ok) return;
  const v = validateModelAlias(read.body);
  if (!v.ok) {
    sendJson(res, 400, { error: { message: v.message, type: 'invalid_request_error' } });
    return;
  }
  if (!saveModelAlias(db, v.value.alias, v.value.target, v.value.note)) {
    deps.db?.insertAdminAudit({ at: Date.now(), op: 'model-alias.save', accountId: null, ok: false, note: 'save failed', ip: auditIp(req) });
    sendJson(res, 500, { error: { message: 'failed to save model alias', type: 'server_error' } });
    return;
  }
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'model-alias.save', accountId: null, ok: true, note: null, ip: auditIp(req) });
  deps.cfg.modelMap[v.value.alias] = v.value.target;
  sendJson(res, 200, { aliases: loadModelAliases(db) });
}

/**
 * DELETE /__admin/api/model-aliases/:alias：删除映射。
 * decodeURIComponent 的 URIError 按 400 处理（m4 同款：畸形 % 编码穿透会变 500）。
 */
async function handleDeleteModelAlias(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
  raw: string,
): Promise<void> {
  const db = deps.db ?? null;
  if (db == null || !db.enabled) {
    sendModelMapUnavailable(res, db);
    return;
  }
  let alias: string;
  try {
    alias = decodeURIComponent(raw);
  } catch {
    sendJson(res, 400, { error: { message: 'invalid alias encoding', type: 'invalid_request_error' } });
    return;
  }
  if (!alias || alias.length > 100) {
    sendJson(res, 400, { error: { message: 'invalid alias', type: 'invalid_request_error' } });
    return;
  }
  if (!deleteModelAlias(db, alias)) {
    deps.db?.insertAdminAudit({ at: Date.now(), op: 'model-alias.delete', accountId: null, ok: false, note: 'delete failed', ip: auditIp(req) });
    sendJson(res, 500, { error: { message: 'failed to delete model alias', type: 'server_error' } });
    return;
  }
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'model-alias.delete', accountId: null, ok: true, note: null, ip: auditIp(req) });
  delete deps.cfg.modelMap[alias];
  sendJson(res, 200, { aliases: loadModelAliases(db) });
}

// ---------------------------------------------------------------------------
// 管理面板 HTML（与 dashboard.ts 同风格：String.raw + 内联 JS，零构建工具）
// ---------------------------------------------------------------------------
//
// 设计令牌对齐 opencode 官网（任务摘取）：深色 #0c0c0e 底、等宽字体优先、
// 直角 3px、1px 边框、h1 uppercase 区块标题、64px 区块间距、表格无竖线无斑马纹、
// 危险操作行 hover 才现身、空状态 dashed + 80px 上下 padding。无 emoji、无阴影。
//
// v3（UI 重构）：账户详情视图（console 数据：billing/usage/members/sa/providers/
// budgets/cookieState）+ confirm 弹层统一写操作；设计规范修复 —— input focus 光圈、
// 侧栏 active 白字 700 + 白竖条、h1 24px/-0.03125rem 字距、modal 5px radius +
// fadeIn/slideUp + 居中 18px/600 标题、danger 令牌化、表格 ≤40rem 缩水、
// 设备码 24px 呼吸 + 状态三态、≤30rem 收紧。
//
// 注意：String.raw 模板里不能出现反引号与 ${（会提前闭合/触发插值），
// 前端代码一律字符串拼接，所有动态值过 esc() 防 XSS。

export const ADMIN_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>fuckopencode — admin</title>
<style>
  :root {
    --bg: #0c0c0e;
    --surface: #161618;
    --elevated: #1c1c1f;
    --border: #38383a;
    --border-muted: #2c2c2e;
    --text: #ffffff;
    --text-2: #c7c7cc;
    --text-muted: #a1a1a6;
    --text-disabled: #68686f;
    --accent: #007aff;
    --accent-hover: #0056b3;
    --accent-active: #004085;
    --ok: #30d158;
    --warn: #ff9f0a;
    --danger: #ff453a;
    --danger-hover: #d70015;
    --danger-active: #a50011;
    --accent-alpha: rgba(0,122,255,.15);
    --radius: 3px;
    --mono: "Berkeley Mono", "IBM Plex Mono", ui-monospace, Menlo, monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  [hidden] { display: none !important; }
  body {
    background: var(--bg); color: var(--text-2);
    font-family: var(--mono); font-size: 13px; line-height: 150%;
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: none; }

  /* ── topbar ─────────────────────────────────────── */
  header {
    position: sticky; top: 0; z-index: 30;
    display: flex; align-items: center; gap: 16px;
    padding: 0 20px; height: 46px;
    background: var(--bg); border-bottom: 1px solid var(--border-muted);
  }
  .brand { color: var(--text); font-weight: 500; white-space: nowrap; }
  .brand span { color: var(--text-disabled); font-weight: 400; }
  .spacer { flex: 1; }
  #h-live { font-size: 12px; color: var(--text-muted); white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  #h-live.ok { color: var(--ok); }
  #h-live.bad { color: var(--danger); }

  /* ── tabs：主视图切换，active = accent 字色 + 底部 2px 横条 ── */
  #tabs {
    position: sticky; top: 46px; z-index: 25;
    display: flex; gap: 2px; padding: 0 20px;
    background: var(--bg); border-bottom: 1px solid var(--border-muted);
  }
  .tab {
    position: relative;
    border: 0; border-bottom: 2px solid transparent; border-radius: 0;
    padding: 7px 12px 5px; font-size: 13px; font-weight: 500;
    color: var(--text-muted); background: transparent;
  }
  .tab:hover:not(.active) { color: var(--text); border-bottom-color: transparent; }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  /* 新版本红点（OTA）：设置 tab 右上角小圆点，有可用更新时亮起。 */
  .tab-dot {
    position: absolute; top: 5px; right: 3px;
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--danger);
  }

  /* ── buttons：oc-btn 模板控件体系 ─────────────────────
     基类 + 修饰符（primary/ghost/danger/sm）。旧类名（.primary/.ghost/.danger/
     .del/.t-del/.ops-btn）保留为兼容别名：动态 innerHTML 与历史 JS 直接写这些
     类名，改选择器会静默丢样式。注意 CSS 顺序——.tab/.snav 定义在按钮基类
     之前且不加 oc-btn，否则基类会盖掉它们的下划线样式。 */
  button, .oc-btn {
    font: inherit; font-size: 12px; font-weight: 500;
    color: var(--text-2); background: transparent;
    border: 1px solid var(--border); border-radius: var(--radius);
    padding: 3px 10px; cursor: pointer; white-space: nowrap;
  }
  button:hover, .oc-btn:hover { color: var(--text); border-color: var(--text-2); }
  button:active, .oc-btn:active { transform: translateY(1px); }
  button.primary, .oc-btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover, .oc-btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  button.primary:active, .oc-btn-primary:active { background: var(--accent-active); border-color: var(--accent-active); }
  button.danger, .oc-btn-danger { background: var(--danger); border-color: var(--danger); color: #fff; }
  button.danger:hover, .oc-btn-danger:hover { background: var(--danger-hover); border-color: var(--danger-hover); }
  button.danger:active, .oc-btn-danger:active { background: var(--danger-active); border-color: var(--danger-active); }
  button.ghost, .oc-btn-ghost { color: var(--text-muted); }
  button.ghost:hover, .oc-btn-ghost:hover { color: var(--text-2); border-color: var(--border); }
  /* 小按钮：行内操作（改名/删除/⋮ 菜单）用 1px 8px 紧凑内边距。 */
  .oc-btn-sm { padding: 1px 8px; }
  /* 弹层确认按钮的「类名即状态」反模式 → data-variant 属性（CSS 用
     [data-variant] 选择器，JS 只切属性；oc-btn-primary/oc-btn-danger 保留
     为类别名供 dropdown 等静态标记使用）。 */
  button[data-variant="primary"], .oc-btn[data-variant="primary"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  button[data-variant="primary"]:hover, .oc-btn[data-variant="primary"]:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  button[data-variant="primary"]:active, .oc-btn[data-variant="primary"]:active { background: var(--accent-active); border-color: var(--accent-active); }
  button[data-variant="danger"], .oc-btn[data-variant="danger"] { background: var(--danger); border-color: var(--danger); color: #fff; }
  button[data-variant="danger"]:hover, .oc-btn[data-variant="danger"]:hover { background: var(--danger-hover); border-color: var(--danger-hover); }
  button[data-variant="danger"]:active, .oc-btn[data-variant="danger"]:active { background: var(--danger-active); border-color: var(--danger-active); }
  button[disabled], .oc-btn[disabled] { color: var(--text-disabled); cursor: default; opacity: .5; }
  button[disabled]:hover, .oc-btn[disabled]:hover { color: var(--text-disabled); border-color: var(--border); }
  button:focus-visible, .oc-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent-alpha); }

  /* ── layout：sidebar + main ──────────────────────── */
  .layout {
    display: flex; gap: 28px; align-items: flex-start;
    max-width: 64rem; margin: 0 auto; padding: 0 20px;
  }
  main { flex: 1; min-width: 0; padding: 0 0 96px; }
  .sidebar {
    width: 240px; flex: none;
    position: sticky; top: 88px;
    display: flex; flex-direction: column; gap: 2px;
    padding: 40px 8px 0 0;
    /* 子项多/窗口矮时内部滚动，激活项由 JS 滚到可视区中间。 */
    max-height: calc(100vh - 150px); overflow-y: auto;
  }
  /* 子导航：opencode 侧栏风格 —— 左侧 2px active 竖条，active 加粗变 accent，
     hover 只变字色（muted → text）。 */
  .snav {
    position: relative; border: 0; border-radius: var(--radius);
    text-align: left; padding: 6px 10px; font-size: 13px; font-weight: 400;
    color: var(--text-muted); background: transparent; white-space: nowrap;
  }
  .snav::before {
    content: ''; position: absolute; left: 0; top: 2px; bottom: 2px;
    width: 2px; background: var(--accent); opacity: 0;
  }
  .snav:hover { color: var(--text); }
  .snav.active { color: var(--text); font-weight: 700; }
  .snav.active::before { opacity: 1; background: var(--text); }

  /* ── sections（opencode 骨架：h1 uppercase + muted 副行）── */
  section { padding: 40px 0 24px; border-bottom: 1px solid var(--border-muted); margin-bottom: 64px; }
  section:last-child { border-bottom: 0; }
  /* 设置页分组卡片（服务/安全/运行/关于）：一组相关 section 收进一张卡，
     section 之间用弱分隔线而不是 64px 大间距——dashboard 分组语义。 */
  .settings-group {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 0 20px 8px; margin-bottom: 28px;
  }
  .settings-group > section {
    border-bottom: 0; padding: 24px 0 20px; margin-bottom: 0;
  }
  .settings-group > section + section { border-top: 1px solid var(--border-muted); }
  .settings-group-hd {
    font-size: 11px; color: var(--text-muted); text-transform: uppercase;
    letter-spacing: .03em; padding: 16px 0 0;
  }
  h1 { font-size: 24px; font-weight: 500; text-transform: uppercase; letter-spacing: -0.03125rem; color: var(--text); }
  .sub { color: var(--text-muted); font-size: 15px; margin-top: 3px; }
  /* 区块头带操作按钮（全部收起/展开等）：标题 + 副行在左，工具按钮在右。 */
  .sec-hd { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .sec-hd .sub { margin-bottom: 0; }
  .sec-tools { display: flex; gap: 6px; }
  .w { color: var(--text-disabled); }
  /* 提示体系：oc-hint（普通说明）+ oc-hint-err（错误）。块级错误用
     oc-hint oc-hint-err（padding 来自 oc-hint）；表单/弹层内错误只挂
     oc-hint-err（min-height 占位，空内容隐藏）。.hint/.form-error/.s-bad
     保留为兼容别名；.s-bad 同时是状态 span 的颜色工具（非错误块）。 */
  .hint, .oc-hint { padding: 12px 0; color: var(--text-muted); font-size: 12px; }
  .s-ok { color: var(--ok); }
  .s-bad { color: var(--danger); }
  .form-error, .go-err, .oc-hint-err { color: var(--danger); font-size: 12px; min-height: 16px; }
  .form-error:empty, .go-err:empty, .oc-hint-err:empty { display: none; }
  .grow { flex: 1; min-width: 0; }
  .cut { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  /* 纯 CSS 悬浮提示（opencode 风格：dark elevated 气泡 + 细边框 + 阴影）：
     挂 data-tip 属性即生效，无需 JS；用于按钮/图标的补充说明。 */
  .oc-tooltip { position: relative; z-index: 2; cursor: help; }
  .oc-tooltip::after {
    content: attr(data-tip);
    position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 60;
    max-width: 260px; width: max-content; padding: 6px 10px;
    background: var(--elevated); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: 0 4px 12px rgba(0,0,0,.3);
    color: var(--text-2); font-size: 12px; line-height: 150%; white-space: normal;
    text-transform: none; letter-spacing: normal;
    opacity: 0; pointer-events: none; transition: opacity .15s;
  }
  .oc-tooltip:hover::after { opacity: 1; }

  /* ── degraded 提示条（数据面不可用时顶部亮红）────── */
  #degraded {
    display: flex; align-items: baseline; gap: 8px;
    background: rgba(255,69,58,.08); border: 1px solid rgba(255,69,58,.35);
    border-radius: var(--radius); padding: 8px 12px; margin-top: 16px;
    color: var(--danger); font-size: 12px;
  }
  #degraded .dg-t { font-weight: 500; }
  #degraded #degraded-reason { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ── flash 提示（操作结果的临时反馈） ────────────── */
  #flash {
    color: var(--text-muted); font-size: 12px; margin-top: 12px;
  }
  #flash.bad { color: var(--danger); }

  /* ── overview ────────────────────────────────────── */
  .stats { display: flex; gap: 40px; margin-top: 14px; flex-wrap: wrap; }
  .stat .v { font-size: 24px; font-weight: 600; color: var(--text); line-height: 120%; }
  .stat .l { font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-top: 2px; }
  /* KPI 一排卡片（总览 stats + 详情 d-stats 统计数字）。 */
  .stats .stat, .d-stats .stat {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 12px 16px; min-width: 120px;
  }
  .d-stats .stat { min-width: 132px; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }

  /* ── forms：oc-form / oc-field 模板控件体系 ────────────
     .form/.field/.full 保留为兼容别名。oc-full 控制 grid 跨列，
     尺寸/布局工具（oc-grow/oc-w64/oc-shrink/oc-min-200）直接挂在控件
     上，取代原来的父容器定制（.req-tools input 等）。 */
  .form, .oc-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; margin-top: 14px; }
  .field, .oc-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .field label, .oc-field label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; }
  .field .full, .form .full, .oc-field.oc-full, .oc-form .oc-full { grid-column: 1 / -1; }
  input, select, textarea, .oc-input, .oc-select, .oc-textarea {
    font: inherit; font-size: 12px; color: var(--text);
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 4px 8px; min-width: 0;
  }
  input::placeholder, .oc-input::placeholder { color: var(--text-disabled); }
  input:focus, select:focus, textarea:focus,
  .oc-input:focus, .oc-select:focus, .oc-textarea:focus {
    outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-alpha);
  }
  select option, .oc-select option { background: var(--elevated); }
  /* 输入控件布局工具（尺寸进 oc-input 自身，不再由父容器定制）：
     oc-grow = 在 flex 行里填满剩余宽度；oc-w64 = 固定窄输入（跳页）；
     oc-shrink = 不参与拉伸（下拉的每页条数）；oc-min-200 = 保底宽度。 */
  .oc-grow { flex: 1; min-width: 0; }
  .oc-w64 { width: 64px; flex: none; }
  .oc-shrink { width: auto; flex: none; }
  .oc-min-200 { min-width: 200px; }
  /* ── 数字输入自绘 spinner（kirostudio 风格）────────────
     隐藏浏览器原生步进（各浏览器外观不一致、主题不搭），右侧由 JS 挂两个
     小箭头（▲▼），点击走 document 委托 stepUp/stepDown。原生伪元素画在
     input 内部不可交互，故 JS 包一层 .num-wrap + .num-stepper。 */
  input[type="number"]::-webkit-outer-spin-button,
  input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  input[type="number"] { -moz-appearance: textfield; appearance: textfield; }
  .num-wrap { position: relative; display: inline-flex; vertical-align: middle; max-width: 100%; }
  .num-wrap > input[type="number"] { padding-right: 22px; }
  .num-stepper {
    position: absolute; top: 0; right: 0; bottom: 0; width: 16px;
    display: flex; flex-direction: column; align-items: stretch;
    border-left: 1px solid var(--border-muted);
  }
  .num-spin {
    flex: 1; border: 0; border-radius: 0; padding: 0; min-width: 0;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-muted); background: transparent; cursor: pointer;
  }
  .num-spin:hover { color: var(--text); background: var(--accent-alpha); }
  .num-spin:active { color: var(--accent); }
  .num-spin-div { height: 1px; background: var(--border-muted); flex: none; }
  .num-spin-up::before, .num-spin-down::before {
    content: ''; display: block; width: 0; height: 0;
    border-left: 4px solid transparent; border-right: 4px solid transparent;
  }
  .num-spin-up::before { border-bottom: 5px solid currentColor; }
  .num-spin-down::before { border-top: 5px solid currentColor; }
  /* 弹层表单字段（oc-field 是 stretch 列）：wrapper 接力撑满格子，输入填满。 */
  .oc-field .num-wrap { display: flex; }
  .oc-field .num-wrap > input[type="number"] { flex: 1; min-width: 0; }

  /* ── account card ────────────────────────────────── */
  /* 账号卡：对齐 .panel 模板（同一套盒子），类名保留供 JS 选择器使用。 */
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px 20px; margin-bottom: 12px;
  }
  /* 设置页「关于」区 secret.key 备份高亮警告卡：红色边框 + 标题红字。 */
  .backup-warn { border-color: rgba(255, 69, 58, .45); }
  .backup-warn .bw-title { color: var(--danger); font-weight: 600; }
  /* 账号列表：卡片式网格（一排 2-3 张紧凑卡，不再竖排堆叠）。 */
  #accounts {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 400px), 1fr));
    gap: 12px; align-items: start;
  }
  #accounts .card { margin-bottom: 0; }
  /* 空态（无账号）横跨整排，不挤进单个网格列。 */
  #accounts .empty { grid-column: 1 / -1; }
  .card-hd { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .card-hd .name { color: var(--text); font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: min(100%, 340px); }
  .badge, .oc-chip {
    font-size: 11px; padding: 1px 7px; border-radius: var(--radius);
    border: 1px solid var(--border-muted); color: var(--text-muted);
    text-transform: uppercase; letter-spacing: .03em; white-space: nowrap;
  }
  .oc-chip.st-ok, .badge.st-ok { color: var(--ok); border-color: rgba(48,209,88,.4); }
  .oc-chip.st-cooldown, .oc-chip.st-limit, .oc-chip.st-insufficient,
  .badge.st-cooldown, .badge.st-limit, .badge.st-insufficient { color: var(--warn); border-color: rgba(255,159,10,.4); }
  .oc-chip.st-invalid, .oc-chip.st-error, .badge.st-invalid, .badge.st-error { color: var(--danger); border-color: rgba(255,69,58,.4); }
  /* 强提示徽章（默认密码等安全告警）：实心红底白字，比 st-error 边框更醒目。 */
  .oc-chip.oc-chip-danger { background: var(--danger); color: #fff; border-color: transparent; }
  .oc-chip.st-region, .oc-chip.st-unknown, .badge.st-region, .badge.st-unknown { color: var(--text-muted); }
  .retry { color: var(--warn); font-size: 12px; white-space: nowrap; }
  /* 操作菜单平时隐身，卡片 hover 才现身（危险操作不给误触机会）。触屏（hover
     不存在）与键盘（Tab 聚焦进菜单）必须可达：focus-within + hover:none 兜底。 */
  .ops { margin-left: auto; display: flex; align-items: center; position: relative; opacity: 0; transition: opacity .15s; }
  .card:hover .ops { opacity: 1; }
  .ops:focus-within { opacity: 1; }
  @media (hover: none) { .ops { opacity: 1; } }
  /* 触屏没有 hover：key 行的行内操作（改名/移除/禁用）直接常显，不然点不到。 */
  @media (hover: none) { .key-row .del { opacity: 1; } }
  .ops-btn { padding: 1px 8px; color: var(--text-muted); }
  /* 账号卡收起/展开：头部（名称/状态/摘要/操作）保留，次要信息整块隐藏。
     data-collapsed 由 JS 翻转，chevron 用 CSS 边框三角（无 emoji）。 */
  .card-bd { min-width: 0; }
  .card[data-collapsed="1"] .card-bd { display: none; }
  .card-toggle {
    flex: none; width: 26px; padding: 2px 0;
    display: inline-flex; align-items: center; justify-content: center;
    color: var(--text-muted);
  }
  .card-toggle::before {
    content: ''; display: block; width: 0; height: 0;
    border-left: 5px solid transparent; border-right: 5px solid transparent;
    border-top: 6px solid currentColor;
    transition: transform .15s;
  }
  .card[data-collapsed="1"] .card-toggle::before { transform: rotate(180deg); }
  /* 卡片头「在飞」徽章：key 正在被请求时显示红点 + 数量（收起状态也能看到
     请求负载——card-bd 隐藏但头部保留）。无在飞时隐藏。 */
  .card-inflight {
    display: inline-flex; align-items: center; gap: 4px;
    color: var(--danger); font-size: 12px; white-space: nowrap;
  }
  .card-inflight::before {
    content: ''; width: 6px; height: 6px; border-radius: 50%;
    background: var(--danger); animation: inflightPulse 1.2s ease-in-out infinite;
  }
  @keyframes inflightPulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  .card-inflight[hidden] { display: none; }

  /* ── dropdown（opencode 风格：surface 底、边框、阴影、hover 高亮）── */
  /* .dd 必须 inline-block：默认块级 div 会撑满 section 全宽，菜单 right:0 就
     会贴到 section 右缘（「选项跑到很右边」的根因），改成收缩宽度 + left 对齐。 */
  .dd { position: relative; display: inline-block; }
  .dd-toggle { position: relative; }
  .dd-menu {
    position: absolute; top: calc(100% + 4px); left: 0; z-index: 50;
    min-width: 160px; padding: 4px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: 0 4px 12px rgba(0,0,0,.3);
    display: flex; flex-direction: column;
  }
  .dd-item {
    border: 0; border-radius: var(--radius);
    text-align: left; padding: 6px 10px; font-size: 13px; line-height: 150%;
    letter-spacing: .02em;
    color: var(--text-2); background: transparent; white-space: nowrap;
  }
  .dd-item:hover { background: rgba(255,255,255,.06); color: var(--text); }
  .dd-item[data-selected="true"] { background: rgba(0,122,255,.15); color: var(--text); }
  /* 危险项默认不显红（与普通项一致，避免整片红刺眼），hover 才显红。 */
  .dd-item.danger { color: var(--text-2); }
  .dd-item.danger:hover { background: rgba(255,69,58,.12); color: var(--danger); }

  /* ── inline edit ─────────────────────────────────── */
  .edit {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px;
    margin-top: 12px; padding: 12px; border: 1px solid var(--border-muted);
    border-radius: var(--radius); background: var(--elevated);
  }

  /* ── balance ─────────────────────────────────────── */
  .balance-row { display: flex; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
  /* 面板内小卡：无边框透明（防嵌套双框），只留大数字 + label。 */
  .balance-card { padding: 10px 14px; min-width: 148px; }
  .balance-card .v { font-size: 24px; font-weight: 600; color: var(--text); line-height: 120%; }
  .balance-card .l { font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-top: 2px; }

  /* ── Go 订阅 ────────────────────────────────────── */
  .go-row { margin-bottom: 10px; }
  .go-l { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
  .go-pct { color: var(--accent); font-weight: 600; }
  .go-reset { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
  .go-toggles { display: flex; gap: 18px; margin-top: 12px; font-size: 12px; }
  .go-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  /* ── oc-check / oc-switch：opencode 风格开关控件家族 ──
     oc-check：label + 视觉隐藏的原生 checkbox + 伪元素勾选框。原生 input
     保留（可聚焦、:checked/:focus-visible 原生伪类），data-go-toggle 的
     change 监听逻辑不受影响。oc-switch：button 模拟的开关（data-on 决定
     轨道/旋钮），视觉对齐 oc-check 家族。 */
  .oc-check { position: relative; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .oc-check input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
  .oc-check-box {
    flex: none; width: 14px; height: 14px; position: relative;
    border: 1px solid var(--border); border-radius: 3px; background: var(--surface);
    transition: background .15s, border-color .15s;
  }
  .oc-check input:checked + .oc-check-box { background: var(--accent); border-color: var(--accent); }
  .oc-check input:checked + .oc-check-box::after {
    content: ''; position: absolute; left: 4px; top: 1px;
    width: 4px; height: 8px; border: solid #fff; border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }
  .oc-check input:focus-visible + .oc-check-box { box-shadow: 0 0 0 2px var(--accent-alpha); }
  .oc-check-label { font-size: 12px; color: var(--text-2); }
  .oc-switch {
    position: relative; flex: none; width: 30px; height: 16px; padding: 0;
    border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
    cursor: pointer; transition: background .15s, border-color .15s;
  }
  .oc-switch:active { transform: none; }
  .oc-switch:hover { border-color: var(--text-2); }
  .oc-switch-track { position: absolute; inset: 0; }
  .oc-switch-knob {
    position: absolute; left: 2px; top: 2px; width: 10px; height: 10px;
    border-radius: 50%; background: var(--text-muted);
    transition: transform .15s, background .15s;
  }
  .oc-switch[data-on="1"] { background: var(--accent); border-color: var(--accent); }
  .oc-switch[data-on="1"] .oc-switch-knob { background: #fff; transform: translateX(14px); }
  .oc-switch-sr {
    position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  /* ── meter（8px 高进度条）────────────────────────── */
  .meter { margin-top: 10px; max-width: 480px; }
  .meter-bg { height: 8px; background: var(--surface); border-radius: var(--radius); overflow: hidden; }
  .meter-fill { height: 100%; background: var(--accent); border-radius: var(--radius); transition: width .3s; }
  .meter-l { font-size: 11px; color: var(--text-muted); margin-top: 3px; }

  /* ── 账号卡展开 v5：两栏——左侧主要信息（编辑/状态/keys），右侧压缩 3 行额度
     （余额 / 用量 / Go）。右侧每行 = 紧凑小字 label + 值，替代旧的三大盒竖排。 */
  .card-bd { display: grid; grid-template-columns: minmax(0, 1fr) minmax(200px, 280px); gap: 16px; }
  .card-main { min-width: 0; }
  .card-stats { min-width: 0; align-self: start; }
  .card-stats .st-row {
    display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
    font-size: 12px; padding: 4px 0; border-bottom: 1px solid var(--border-muted);
  }
  .card-stats .st-row:last-child { border-bottom: 0; }
  .card-stats .st-k { color: var(--text-muted); white-space: nowrap; }
  .card-stats .st-v { color: var(--text); text-align: right; white-space: nowrap; }
  @media (max-width: 48rem) {
    .card-bd { grid-template-columns: 1fr; }
    .card-stats { border-top: 1px solid var(--border-muted); padding-top: 8px; }
  }

  .detail {
    margin-top: 10px; font-size: 12px; color: var(--warn);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .meta { margin-top: 6px; font-size: 12px; color: var(--text-muted); }

  /* ── usage 容器（参照 dashboard：border + surface 底 + 网格内嵌卡片）── */
  .u-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 1px; background: var(--border); border: 1px solid var(--border);
    border-radius: var(--radius); margin-top: 14px; overflow: hidden;
  }
  .u-cell { background: var(--surface); padding: 14px 16px; min-width: 0; }
  .u-cell .k { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
  .u-cell .v { font-size: 22px; font-weight: 600; color: var(--text); line-height: 130%; margin-top: 3px; }

  /* ── 统一容器模板 .panel（opencode 控制台风格）────────────
     所有区块/详情/表格容器都收敛到这一套盒子：surface 底 + 1px border +
     3px 圆角 + 16/20 内边距。容器内的小卡（balance-card 等）一律去边框
     透明（防嵌套双框——opencode 的做法：容器内元素不重复画框）。
     .panel-hd = 自带标题的区块（详情页各块）；无标题的容器（表格等）
     直接 .panel + .panel-bd 或裸 .panel 即可。 */
  .panel {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px 20px; margin-top: 14px;
  }
  .panel-hd {
    display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
    padding-bottom: 12px; margin-bottom: 16px;
    border-bottom: 1px solid var(--border-muted);
  }
  .panel-hd h1 {
    font-size: 14px; font-weight: 500; text-transform: uppercase;
    letter-spacing: .02em; color: var(--text);
  }
  .panel-hd .sub { font-size: 12px; color: var(--text-muted); margin-top: 0; }
  .panel-bd { min-width: 0; }
  /* 详情页区块堆叠：面板之间 40px 间距（对齐 section 节距）。 */
  .panel.detail-panel { margin-top: 0; margin-bottom: 40px; }
  .panel .hint, .panel .oc-hint { padding: 10px 0; }
  /* 工作区区块：当前 workspace 行 + 旧版只读行 + 切换行（下拉 + 按钮）。 */
  .ws-cur { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .ws-k { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
  .ws-id { font-size: 12px; color: var(--text); overflow-wrap: anywhere; }
  .ws-name { font-size: 12px; color: var(--text-muted); }
  .ws-legacy { display: flex; align-items: baseline; gap: 8px; margin-top: 6px; }
  .ws-switch { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  .ws-chip, .oc-chip-ws { max-width: 220px; }
  /* 详情页分组 tab 条：复用 .tab 样式（下划线 active），次级尺寸。 */
  .sub-tabs { display: flex; flex-wrap: wrap; gap: 2px; margin: 2px 0 16px; border-bottom: 1px solid var(--border-muted); }
  .sub-tabs .tab { font-size: 12px; }
  /* 密钥页配额列：已用/上限 + 状态徽章两行。 */
  .t-quota { font-size: 12px; }
  .t-quota-badge { margin-top: 4px; }
  /* 编辑密钥弹层：配额分区标题（小号大写 + 弱分隔线，靠 margin 撑开不用
     padding——modal-bd 会把 oc-hint 的 padding 清零）。 */
  .t-quota-sect {
    border-top: 1px solid var(--border-muted);
    font-size: 11px; text-transform: uppercase; letter-spacing: .03em;
    color: var(--text-muted);
  }
  /* 请求明细：dashboard 的 .log 两行式（表头行 + 条目行） */
  .log {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); margin-top: 14px; overflow: hidden;
  }
  .log-hd {
    display: grid; grid-template-columns: 62px 58px 1fr 64px 84px 96px;
    gap: 12px; padding: 7px 12px; background: var(--elevated);
    border-bottom: 1px solid var(--border);
    color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .03em;
  }
  .lent {
    display: grid; grid-template-columns: 62px 58px 1fr 64px 84px 96px;
    gap: 12px; padding: 7px 12px; align-items: baseline;
    border-bottom: 1px solid var(--border-muted); font-size: 12px;
  }
  .lent:last-child { border-bottom: 0; }
  .lent:hover { background: var(--elevated); }
  /* 第二行细节（模型/key/端点/UA/错误），参照 dashboard .ent .r2。 */
  .lent .r2 {
    grid-column: 1 / -1; padding: 0 0 6px 74px;
    display: flex; flex-wrap: wrap; gap: 4px 16px;
    color: var(--text-muted); font-size: 11px;
  }
  .lent .r2 span { white-space: nowrap; }
  /* 错误原文长度不可控，允许折行防窄屏横向溢出（dashboard 同款处理）。 */
  .lent .r2 span.s-bad { white-space: normal; overflow-wrap: anywhere; }
  @media (max-width: 40rem) {
    .log-hd { display: none; }
    .lent { grid-template-columns: 62px 1fr auto; }
    .lent .h-ms, .lent .h-tok, .lent .h-client { display: none; }
    .lent .r2 { padding-left: 12px; }
  }
  /* 请求明细工具行：搜索框 + 每页条数下拉（分页导航下面一行）。
     输入尺寸由控件自身的 oc-grow/oc-shrink 类控制，不再依赖父容器。 */
  .req-tools { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  /* 请求明细分页：页码 + 总数左侧，跳页输入框 + 上一页/下一页右侧。 */
  .req-nav {
    display: flex; align-items: center; gap: 10px; margin-top: 10px;
    font-size: 12px;
  }
  .req-nav .req-info { margin-right: auto; color: var(--text-muted); }
  /* IP 统计表的 IP 单元格：可点击筛选（accent 色 + 手型）。 */
  .ip-link { color: var(--accent); cursor: pointer; }
  .ip-link:hover { text-decoration: underline; }

  /* ── keys（无竖线无斑马纹的行列表，行间 1px 弱线）── */
  .keys { margin-top: 14px; border-top: 1px solid var(--border-muted); padding-top: 10px; }
  .keys-hd { font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px; }
  .key-row {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 0; font-size: 12px;
    border-bottom: 1px solid var(--border-muted);
  }
  .key-row:last-child { border-bottom: 0; }
  .key-row .dot, .key-row .oc-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--text-disabled); }
  .key-row .dot.ok, .key-row .oc-dot.ok { background: var(--ok); }
  .key-row .dot.bad, .key-row .oc-dot.bad { background: var(--danger); }
  .key-row .fp { color: var(--text-2); }
  .key-row .k-meta { margin-left: auto; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .key-row .del { opacity: 0; padding: 1px 8px; }
  .key-row:hover .del { opacity: 1; }
  .key-row .del:hover { color: var(--danger); border-color: var(--danger); }
  /* 账号卡内 key 行按钮多（用量/复制/禁用/改名/移除）：窄卡允许换行，不横向溢出。 */
  .card .keys .key-row { flex-wrap: wrap; }
  .key-add { display: flex; gap: 6px; margin-top: 8px; }

  /* ── model access（chip 选择器：全局白名单 + 密钥级授权）── */
  .ma-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .ma-avail-hd { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
  .ma-avail-grid { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; max-height: 180px; overflow-y: auto; }
  .ma-chip {
    font-size: 12px; padding: 3px 10px; border-radius: var(--radius);
    border: 1px solid var(--border-muted); background: var(--surface);
    color: var(--text-2); cursor: pointer; font-family: inherit; line-height: 150%;
  }
  .ma-chip:hover { border-color: var(--accent); }
  .ma-chip.on { background: rgba(0,122,255,.18); border-color: var(--accent); color: var(--text); }
  .ma-chip.off { opacity: .55; }
  .ma-chip .ma-x { margin-left: 5px; font-weight: 700; }
  .ma-chip.dis { opacity: .4; cursor: not-allowed; }
  .ma-opt-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  #ma-search { max-width: 240px; }
  .ma-add-row { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
  .ma-add-row input { flex: 1; min-width: 0; }

  /* ── empty state（dashed + 80px 上下 padding）────── */
  .empty {
    border: 1px dashed var(--border); border-radius: var(--radius);
    padding: 80px 20px; text-align: center; color: var(--text-muted);
    margin-top: 14px;
  }
  .empty .e-t { color: var(--text-2); font-size: 13px; }
  .empty .e-s { font-size: 12px; margin-top: 4px; }

  /* ── oauth modal（opencode modal 风格：oc-modal 模板系列 + 旧类名别名）──
     .overlay 是固定定位的遮罩壳（结构容器，同 .layout/.panel）；可见弹层
     是 oc-modal（内部 oc-modal-hd / oc-modal-bd / oc-modal-actions /
     oc-modal-x）。旧类名（.modal/.modal-hd/.modal-bd/.modal-actions/.x）
     保留为兼容别名：JS 只按 id 操作弹层，改类名不破坏任何监听。 */
  .overlay {
    position: fixed; inset: 0; z-index: 100;
    background: rgba(0,0,0,.7);
    display: flex; align-items: center; justify-content: center;
    padding: 16px;
  }
  .modal, .oc-modal {
    width: min(420px, 100%);
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 5px; box-shadow: 0 8px 32px rgba(0,0,0,.5);
    padding: 24px;
    animation: modalIn .2s ease;
  }
  @keyframes modalIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }
  .modal-hd, .oc-modal-hd {
    position: relative; text-align: center;
    padding: 0 24px 16px;
    color: var(--text); font-weight: 600; font-size: 18px;
  }
  .modal-hd .x, .oc-modal-hd .oc-modal-x { position: absolute; right: 0; top: -6px; border: 0; color: var(--text-muted); font-size: 15px; padding: 0 6px; }
  .modal-bd, .oc-modal-bd { display: flex; flex-direction: column; gap: 14px; }
  /* 弹层内表单不加额外上边距（modal-bd 的 14px gap 已管间距，防止双倍）。 */
  .modal-bd .form, .modal-bd .oc-form, .oc-modal-bd .form, .oc-modal-bd .oc-form { margin-top: 0; }
  .modal-bd .hint, .modal-bd .oc-hint, .oc-modal-bd .hint, .oc-modal-bd .oc-hint { padding: 0; }
  .modal-actions, .oc-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .oauth-field label { display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px; }
  .oauth-url-row { display: flex; gap: 6px; align-items: center; }
  .oauth-url-row a { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .oauth-code {
    font-size: 26px; font-weight: 600; letter-spacing: 3px; text-align: center;
    color: var(--text); padding: 24px 16px; margin: 4px 0;
    background: var(--elevated); border: 1px solid var(--border-muted);
    border-radius: 5px;
  }
  .oauth-hint { font-size: 12px; color: var(--text-muted); }
  .oauth-status { font-size: 12px; color: var(--text-muted); min-height: 16px; }
  .oauth-status.ok { color: var(--ok); }
  .oauth-status.bad { color: var(--danger); }
  .oauth-expires { font-size: 12px; color: var(--text-muted); }
  .oauth-actions { display: flex; justify-content: flex-end; }
  .oauth-start-row { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
  .oauth-start-row .hint, .oauth-start-row .oc-hint { padding: 0; }

  /* ── v3：详情视图（账户卡片 → 控制台数据展示）────── */
  .crumb { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .crumb-name { color: var(--text); font-weight: 500; }
  .range { display: flex; gap: 2px; margin-top: 8px; }
  .range-btn { padding: 2px 10px; font-size: 12px; }
  .range-btn.active { color: var(--text); border-color: var(--text-2); }
  /* 面板内大数字：无边框透明（防嵌套双框），直接浮在 panel 底上。 */
  .balance-hero { padding: 4px 0 12px; }
  .balance-hero .bh-v { font-size: 34px; font-weight: 600; color: var(--text); line-height: 120%; }
  .balance-hero .bh-l { font-size: 12px; color: var(--text-muted); text-transform: uppercase; margin-top: 4px; }
  .d-stats { display: flex; gap: 40px; margin-top: 14px; flex-wrap: wrap; }
  .d-stats .stat .v { font-size: 20px; }
  .cookie-warn {
    margin-top: 16px; padding: 12px;
    border: 1px solid rgba(255,159,10,.4); background: rgba(255,159,10,.08);
    border-radius: 5px; display: flex; flex-direction: column; gap: 10px;
  }
  .cookie-warn .cookie-warn-t { color: var(--warn); font-size: 12px; }
  .cookie-import { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .tbl { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
  .tbl th, .tbl td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border-muted); vertical-align: top; }
  .tbl th { font-size: 11px; font-weight: 500; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
  .tbl tr:last-child td { border-bottom: 0; }
  .tbl .t-del { opacity: 0; padding: 1px 8px; }
  .tbl tr:hover .t-del { opacity: 1; }
  .d-ops { display: flex; justify-content: flex-end; margin-top: 10px; }

  /* ── v4：每日成本趋势柱（byDay → 简单柱状，最高柱 accent）── */
  .trend { display: flex; align-items: flex-end; gap: 6px; margin-top: 14px; min-height: 84px; }
  .trend-bar { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .trend-col { width: 100%; max-width: 34px; border-radius: 3px 3px 0 0; background: var(--accent); opacity: .85; }
  .trend-col.peak { opacity: 1; }
  .trend-l { font-size: 10px; color: var(--text-muted); white-space: nowrap; transform: rotate(-45deg); transform-origin: top left; margin-top: 4px; }
  .trend-v { font-size: 10px; color: var(--text-2); }

  /* ── v4：大表格滚动（models-pricing 61 模型，外层限高滚动）── */
  .tbl-scroll { max-height: 320px; overflow-y: auto; }

  /* ── v4：兼容修复三计数（u-cell 内小字，压缩成一行）── */
  .fix-cnt { font-size: 13px !important; line-height: 1.7 !important; }

  /* ── v4：设置页实验功能行 ── */
  .exp-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border-muted); font-size: 12px; }
  .exp-row:last-child { border-bottom: 0; }
  .exp-row .exp-name { color: var(--text-2); min-width: 120px; }
  .exp-row .exp-desc { color: var(--text-muted); flex: 1; min-width: 0; }
  .exp-on { color: var(--ok); font-weight: 600; }
  .exp-off { color: var(--text-muted); }

  /* ── v5：总览网关统计卡组（stats2）+ 迷你走势线（零依赖 SVG）── */
  .stats2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 14px; }
  /* 统计小卡：对齐 .panel 模板的盒子（border + 3px 圆角）。 */
  .stat2 { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; min-width: 0; }
  .stat2 .v { font-size: 20px; font-weight: 600; color: var(--text); line-height: 120%; }
  .stat2 .l { font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-top: 2px; letter-spacing: .03em; }
  .spark { display: block; width: 100%; height: 26px; margin-top: 6px; }
  .spark polyline { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }

  /* ── v6：总览性能仪表盘（sec-perf）── 与 stats2 同盒子，另加 meter 条 */
  .perf-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 14px; }
  .perf-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; min-width: 0; }
  .perf-card .pc-l { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
  .perf-card .pc-v { font-size: 20px; font-weight: 600; color: var(--text); line-height: 120%; }
  .perf-card .pc-v small { font-size: 12px; color: var(--text-muted); font-weight: 400; }
  .perf-meter { margin-top: 8px; }
  .perf-meter-bg { height: 6px; background: var(--border-muted); border-radius: var(--radius); overflow: hidden; }
  .perf-meter-fill { height: 100%; background: var(--accent); border-radius: var(--radius); transition: width .3s; }
  .perf-meter-fill.warn { background: #e6b450; }
  .perf-meter-fill.danger { background: var(--danger); }
  .perf-cols { display: flex; gap: 12px; margin-top: 8px; }
  .perf-col { min-width: 0; }
  .perf-col .n { font-size: 16px; font-weight: 600; color: var(--text); line-height: 120%; }
  .perf-col .l { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
  .perf-dots { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .perf-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--border-muted); }
  .perf-dot.ok { background: var(--ok); }
  .perf-dot.bad { background: var(--danger); }

  /* ── v5：状态列表（网关/上游/账号/分发密钥/兼容修复）── */
  .st-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border-muted); font-size: 12px; }
  .st-row:last-child { border-bottom: 0; }
  .st-row .st-name { color: var(--text-2); min-width: 96px; flex: none; }
  .st-row .st-desc { color: var(--text-muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st-dot, .oc-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--text-disabled); }
  .oc-dot.ok, .st-dot.ok { background: var(--ok); }
  .oc-dot.warn, .st-dot.warn { background: var(--warn); }
  .oc-dot.bad, .st-dot.bad { background: var(--danger); }
  /* OTA 更新进度/日志（sec-update + update-overlay）。 */
  .ota-progress { text-align: center; font-size: 13px; color: var(--text); padding: 20px 0; }
  .ota-commits { max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  .ota-commit { font-size: 12px; color: var(--text-2); }

  /* ── v5：分发密钥 tab（状态徽章 + 明文展示弹层）── */
  .oc-chip.tok-active, .badge.tok-active { color: var(--ok); border-color: rgba(48,209,88,.4); }
  .oc-chip.tok-disabled, .badge.tok-disabled { color: var(--text-muted); border-color: rgba(255,69,58,.4); }
  .tbl .tok-mask { color: var(--text-2); }
  .tok-ops { display: flex; gap: 8px; margin-bottom: 10px; }
  /* RPM 列：每行限流输入（0 = 不限）+ 行内保存按钮（行 hover 才现身）。 */
  .t-rpm { min-width: 100px; }
  .t-rpm .oc-input { width: 52px; padding: 2px 6px; }
  .t-rpm-save { opacity: 0; padding: 1px 8px; }
  .tbl tr:hover .t-rpm-save, .t-rpm-save:focus-visible { opacity: 1; }
  .plain-list { display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto; }
  .plain-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .plain-row .w { color: var(--text-2); flex: none; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .plain-key { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--bg); border: 1px solid var(--border-muted); border-radius: 3px; padding: 4px 8px; color: var(--text); font-family: inherit; }

  /* ── v5：设置页 API 密钥管理 ── */
  .akey-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border-muted); font-size: 12px; }
  .akey-row:last-child { border-bottom: 0; }
  .akey-row .src { color: var(--text-muted); font-size: 11px; }
  .akey-row .t-del { opacity: 0; padding: 1px 8px; }
  .akey-row:hover .t-del { opacity: 1; }
  .src-tag, .oc-chip-src { font-size: 11px; color: var(--text-muted); font-weight: 400; margin-left: 8px; }
  .exp-toggle { flex: none; }

  /* ── 窄屏：sidebar 收成顶部横滚 tab（active 底部 2px 横条）── */
  @media (max-width: 48rem) {
    #tabs { position: static; padding: 0 12px; }
    .layout { flex-direction: column; gap: 0; padding: 0 12px; }
    .sidebar {
      position: sticky; top: 46px; z-index: 20;
      width: auto; flex-direction: row; overflow-x: auto; gap: 2px;
      padding: 6px 12px 0; margin: 0 -12px;
      background: var(--bg); border-bottom: 1px solid var(--border-muted);
    }
    .sidebar .snav { white-space: nowrap; }
    .sidebar .snav::before {
      top: auto; left: 0; right: 0; bottom: 0;
      width: auto; height: 2px;
    }
    main { padding-bottom: 64px; }
  }

  /* ≤40rem：表格/表单多列变单列，表格缩水（8px 12px 单元格 + 12px 字号 + 隐藏一列） */
  @media (max-width: 40rem) {
    .form, .edit { grid-template-columns: 1fr; }
    /* 账号卡片网格降级为单列（紧凑卡 → 纵向流）。 */
    #accounts { grid-template-columns: 1fr; }
    .tbl th, .tbl td { padding: 8px 12px; font-size: 12px; }
    .tbl .t-hide { display: none; }
    .d-stats { gap: 24px; }
    .cookie-import { flex-direction: column; }
    .oc-min-200 { min-width: 0; width: 100%; }
  }

  /* ≤30rem：区块间距收紧（64→24）、modal 收窄到 300px */
  @media (max-width: 30rem) {
    section { margin-bottom: 24px; }
    .modal, .oc-modal { width: 300px; }
  }
</style>
</head>
<body>
<header>
  <div class="brand">fuckopencode <span>/ admin</span></div>
  <div class="spacer"></div>
  <div class="stat-inline" id="h-live">[*] <span id="h-live-text"></span></div>
  <div class="dd">
    <button id="btn-lang" class="oc-btn dd-toggle">中文</button>
    <div class="dd-menu" id="lang-menu" hidden>
      <button class="oc-btn dd-item" data-lang="en">EN</button>
      <button class="oc-btn dd-item" data-lang="zh">中文</button>
    </div>
  </div>
  <button id="btn-logout" class="oc-btn oc-btn-ghost" data-i18n="logout">退出</button>
</header>

<nav id="tabs">
  <button class="tab active" data-tab="overview" data-i18n="tabOverview">Overview</button>
  <button class="tab" data-tab="accounts" data-i18n="tabAccounts">Accounts</button>
  <button class="tab" data-tab="usage" data-i18n="tabUsage">Usage</button>
  <button class="tab" data-tab="tokens" data-i18n="tabTokens">Keys</button>
  <button class="tab" data-tab="access" data-i18n="tabModelAccess">Model Access</button>
  <button class="tab" data-tab="settings" data-i18n="tabSettings">Settings<span class="tab-dot" id="tab-dot-update" hidden></span></button>
</nav>

<div class="layout">
  <aside class="sidebar" id="sidebar"></aside>
  <main>
    <div id="degraded"><span class="dg-t">[!]</span> <span data-i18n="degradedTitle">accounts unavailable</span> <span id="degraded-reason"></span></div>
    <div id="flash" hidden></div>

    <div id="view-overview">
      <section id="sec-overview">
        <h1 data-i18n="overview">Overview</h1>
        <div class="sub" data-i18n="overviewSub">accounts, balance and key health</div>
        <div class="stats">
          <div class="stat"><div class="v" id="stat-accounts">0</div><div class="l" data-i18n="accountsLabel">accounts</div></div>
          <div class="stat"><div class="v" id="stat-healthy">0</div><div class="l" data-i18n="healthy">healthy</div></div>
          <div class="stat"><div class="v" id="stat-balance">—</div><div class="l" data-i18n="totalBalance">total balance</div></div>
          <div class="stat"><div class="v" id="stat-cooldown">0</div><div class="l" data-i18n="cooldown">cooldown</div></div>
        </div>
        <!-- 网关统计卡组：/__metrics summary + 最近 events（12 桶 sparkline）+ tokens 聚合 -->
        <div class="stats2" id="stats2">
          <div class="stat2"><div class="v" id="ov-total">—</div><div class="l" data-i18n="ovTotalRequests">requests</div><span class="spark" id="spark-total"></span></div>
          <div class="stat2"><div class="v" id="ov-rate">—</div><div class="l" data-i18n="ovSuccessRate">success rate</div><span class="spark" id="spark-rate"></span></div>
          <div class="stat2"><div class="v" id="ov-cost">—</div><div class="l" data-i18n="ovCostLabel">key cost</div><span class="spark" id="spark-cost"></span></div>
          <div class="stat2"><div class="v" id="ov-keys">—</div><div class="l" data-i18n="ovKeys">dist. keys</div><span class="spark" id="spark-keys"></span></div>
        </div>
        <!-- 数据口径标注：真实趋势（usage db）还是快照回落。 -->
        <div class="oc-hint" id="ov-note"></div>
        <div class="badges" id="stat-dist"></div>
        <div class="oc-hint" id="health-note"></div>
      </section>

      <!-- 性能仪表盘（设置页开关控制显示；关 = 隐藏整个区块，tick 也不拉数据） -->
      <section id="sec-perf">
        <h1 data-i18n="perfTitle">Performance</h1>
        <div class="sub" data-i18n="perfSub">process, system and gateway health at a glance</div>
        <div class="perf-grid" id="perf"><div class="oc-hint">…</div></div>
        <div class="oc-hint" id="perf-status"></div>
      </section>

      <section id="sec-status">
        <h1 data-i18n="statusTitle">Status</h1>
        <div class="sub" data-i18n="statusSub">gateway, upstream pool, accounts and distribution keys at a glance</div>
        <div class="panel" id="status-list"><div class="oc-hint">…</div></div>
      </section>

      <section id="sec-health">
        <h1 data-i18n="healthTitle">Health</h1>
        <div class="sub" data-i18n="healthSub">per-account status at a glance</div>
        <div id="health-list"></div>
      </section>
    </div>

    <div id="view-accounts" hidden>
      <section id="sec-accounts">
        <div class="sec-hd">
          <div>
            <h1 data-i18n="accountsTitle">Accounts</h1>
            <div class="sub" data-i18n="accountsSub">per-account status, balance and keys</div>
          </div>
          <div class="sec-tools">
            <button class="oc-btn oc-btn-ghost oc-btn-sm" id="btn-collapse-all" data-i18n="collapseAll">collapse all</button>
            <button class="oc-btn oc-btn-ghost oc-btn-sm" id="btn-expand-all" data-i18n="expandAll">expand all</button>
          </div>
        </div>
        <div id="accounts"></div>
      </section>

      <section id="sec-create">
        <h1 data-i18n="createTitle">Create account</h1>
        <div class="sub" data-i18n="createSub">register an upstream account, keys are encrypted at rest</div>
        <div class="oc-form">
          <div class="oc-field">
            <label for="c-name" data-i18n="name">name</label>
            <input class="oc-input" id="c-name" autocomplete="off">
          </div>
          <div class="oc-field">
            <label data-i18n="kind">kind</label>
            <div class="dd">
              <button id="c-kind-toggle" class="oc-btn dd-toggle">subscription</button>
              <div class="dd-menu" id="c-kind-menu" hidden>
                <button class="oc-btn dd-item" data-kind="subscription" data-i18n="kindSubscription">subscription</button>
                <button class="oc-btn dd-item" data-kind="payg" data-i18n="kindPayg">payg</button>
                <button class="oc-btn dd-item" data-kind="unknown" data-i18n="kindUnknown">unknown</button>
              </div>
            </div>
          </div>
          <div class="oc-field oc-full">
            <label for="c-ws" data-i18n="workspaceId">workspace id</label>
            <input class="oc-input" id="c-ws" autocomplete="off" placeholder="ws_...">
          </div>
          <div class="oc-field oc-full">
            <label for="c-keys" data-i18n="keysLabel">keys (comma separated)</label>
            <input class="oc-input" id="c-keys" autocomplete="off" placeholder="sk-ant-xxx, sk-ant-yyyy">
          </div>
          <div class="oc-field oc-full">
            <label for="c-cookie" data-i18n="cookieLabel">cookie (optional)</label>
            <input class="oc-input" id="c-cookie" type="password" autocomplete="off">
          </div>
          <div class="oc-hint-err oc-full" id="c-err"></div>
          <button class="oc-btn oc-btn-primary oc-full" id="btn-create" data-i18n="create">create</button>
        </div>
      </section>

      <section id="sec-oauth">
        <h1 data-i18n="oauthTitle">OpenCode sign-in</h1>
        <div class="sub" data-i18n="oauthDesc">pair an opencode account via device code</div>
        <div class="oauth-start-row">
          <button class="oc-btn oc-btn-primary" id="oauth-start" data-i18n="oauthStart">Sign in with OpenCode</button>
          <span class="oc-hint" id="oauth-start-status"></span>
        </div>
      </section>
    </div>

    <div id="view-account-detail" hidden>
      <section id="sec-account-detail">
        <div class="crumb">
          <button class="oc-btn oc-btn-ghost" id="detail-back" data-i18n="back">back</button>
          <span class="crumb-name cut" id="detail-name"></span>
        </div>
        <div id="detail-cookie" class="cookie-warn" hidden>
          <div class="cookie-warn-t" id="detail-cookie-t"></div>
          <div class="cookie-import" id="detail-cookie-import">
            <button class="oc-btn oc-btn-primary" id="detail-import" data-i18n="importFromBrowser">import from browser</button>
            <input class="oc-input oc-grow oc-min-200" id="detail-cookie-paste" aria-label="cookie" placeholder="auth=..." autocomplete="off">
            <button class="oc-btn" id="detail-paste-save" data-i18n="importCookie">import</button>
          </div>
          <div class="cookie-import" id="detail-oauth-row">
            <button class="oc-btn" id="detail-oauth" data-i18n="oauthInstead">or sign in with OpenCode instead</button>
          </div>
        </div>
        <!-- 订阅置顶（用户要求：Go 订阅及旧版 key 相关放最上面）：go（Go 订阅）→
             legacy-key（旧版 API key 配置，可复制）→ legacy（旧版 key 列表）→
             legacy-billing（旧版计费）。16 个区块按 5 组 tab 分组（.detail-group）：
             订阅 & Keys / 工作区 & 模型 / 财务 / 组织 / 定价；tab 只显隐不懒加载，
             load* 调用保持不变。 -->
        <div id="detail-nav"></div>
        <div class="detail-group" data-group="sub">
          <div id="detail-go"></div>
          <div id="detail-legacy-key"></div>
          <div id="detail-legacy"></div>
          <div id="detail-legacy-billing"></div>
        </div>
        <div class="detail-group" data-group="ws">
          <div id="detail-workspace"></div>
          <div id="detail-models"></div>
        </div>
        <div class="detail-group" data-group="finance">
          <div id="detail-billing"></div>
          <div id="detail-usage"></div>
          <div id="detail-models-usage"></div>
          <div id="detail-users-usage"></div>
          <div id="detail-autorecharge"></div>
          <div id="detail-budgets"></div>
        </div>
        <div class="detail-group" data-group="org">
          <div id="detail-members"></div>
          <div id="detail-sa"></div>
          <div id="detail-providers"></div>
        </div>
        <div class="detail-group" data-group="pricing">
          <div id="detail-pricing"></div>
        </div>
      </section>
    </div>

    <div id="view-usage" hidden>
      <section id="sec-usage-summary">
        <h1 data-i18n="usageTitle">Request stats</h1>
        <div class="sub" data-i18n="usageSub">traffic summary from /__metrics</div>
        <div class="u-grid">
          <div class="u-cell"><div class="k" data-i18n="totalRequests">total requests</div><div class="v" id="u-total">0</div></div>
          <div class="u-cell"><div class="k" data-i18n="failed">failed</div><div class="v" id="u-failed">0</div></div>
          <div class="u-cell"><div class="k" data-i18n="streaming">streaming</div><div class="v" id="u-stream">0</div></div>
          <div class="u-cell"><div class="k" data-i18n="avgDuration">avg duration</div><div class="v" id="u-avg">—</div></div>
          <div class="u-cell"><div class="k" data-i18n="tokens">tokens</div><div class="v" id="u-tokens">0</div></div>
          <div class="u-cell"><div class="k" data-i18n="fixCountTitle">compat fixes</div><div class="v fix-cnt" id="u-fixes">—</div></div>
        </div>
      </section>

      <section id="sec-usage-keys">
        <h1 data-i18n="keypoolTitle">Key pool</h1>
        <div class="sub" data-i18n="keypoolSub">per-key health and in-flight load</div>
        <div class="panel" id="u-keys"></div>
      </section>

      <section id="sec-usage-recent">
        <h1 data-i18n="detailRequests">Detailed requests</h1>
        <div class="req-tools">
          <input class="oc-input oc-grow" id="req-q" placeholder="search path/status/model/client/ua/error" autocomplete="off" spellcheck="false" aria-label="search requests">
          <label class="oc-check req-all" title="包含健康检查/记账等噪音请求">
            <input type="checkbox" id="req-all">
            <span data-i18n="reqShowAll">show all requests</span>
          </label>
          <select class="oc-select oc-shrink" id="req-size" title="page size" aria-label="page size">
            <option value="20" selected>20</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </div>
        <div class="log">
          <div class="log-hd">
            <span data-i18n="hTime">time</span><span data-i18n="hStatus">status</span><span data-i18n="hRequest">request</span>
            <span data-i18n="hMs">ms</span><span data-i18n="hTokens">tokens</span><span data-i18n="hClient">client</span>
          </div>
          <div id="u-events"><div class="oc-hint" data-i18n="noRequests">no requests yet</div></div>
        </div>
        <div class="req-nav">
          <span class="req-info" id="req-info"></span>
          <input class="oc-input oc-w64" id="req-page" type="number" min="1" step="1" autocomplete="off" title="jump to page" aria-label="jump to page">
          <button class="oc-btn" id="req-go" data-i18n="reqGo">go</button>
          <button class="oc-btn" id="req-prev" data-i18n="reqPrev">prev</button>
          <button class="oc-btn" id="req-next" data-i18n="reqNext">next</button>
        </div>
      </section>

      <section id="sec-usage-ips">
        <h1 data-i18n="ipStatsTitle">Top IPs</h1>
        <div class="sub" data-i18n="ipStatsSub">traffic aggregated by client IP</div>
        <div class="panel">
          <table class="tbl">
            <thead><tr><th>IP</th><th data-i18n="requests">requests</th><th data-i18n="tokens">tokens</th><th data-i18n="ipClients">clients</th><th data-i18n="ipLast">last seen</th></tr></thead>
            <tbody id="ip-rows"></tbody>
          </table>
          <div class="oc-hint" id="ip-empty" data-i18n="ipEmpty">no traffic yet</div>
        </div>
        <div class="req-nav">
          <span class="req-info" id="ip-info"></span>
          <button class="oc-btn" id="ip-prev" data-i18n="reqPrev">prev</button>
          <button class="oc-btn" id="ip-next" data-i18n="reqNext">next</button>
        </div>
      </section>

      <section id="sec-usage-audit">
        <h1 data-i18n="auditTitle">Admin audit</h1>
        <div class="sub" data-i18n="auditSub">who · when · what on the management panel</div>
        <div class="log">
          <div class="log-hd">
            <span data-i18n="hTime">time</span><span data-i18n="auditOp">op</span><span data-i18n="auditResult">result</span>
            <span data-i18n="auditAccount">account</span><span data-i18n="auditIp">ip</span>
          </div>
          <div id="audit-events"><div class="oc-hint" data-i18n="auditEmpty">no admin operations yet</div></div>
        </div>
      </section>
    </div>

    <div id="view-tokens" hidden>
      <section id="sec-tokens">
        <h1 data-i18n="tokensTitle">Distribution keys</h1>
        <div class="sub" data-i18n="tokensSub">client tokens routing through the shared upstream pool</div>
        <div class="tok-ops">
          <button class="oc-btn oc-btn-primary" id="btn-token-create" data-i18n="tokenCreate">create token</button>
          <button class="oc-btn oc-btn-ghost" id="btn-token-refresh" data-i18n="tokenRefresh">refresh</button>
        </div>
        <div class="panel">
          <table class="tbl">
            <thead><tr>
          <th data-i18n="name">name</th><th data-i18n="status">status</th><th data-i18n="masked">mask</th>
          <th data-i18n="tokenUsage">usage</th><th data-i18n="quota">quota</th><th class="t-hide" data-i18n="tokenCreatedAt">created</th>
          <th class="t-rpm-hd" data-i18n="tokenRpm">rpm</th><th></th>
            </tr></thead>
            <tbody id="tokens-rows"></tbody>
          </table>
          <div class="oc-hint" id="tokens-empty" data-i18n="tokensEmpty">no tokens yet</div>
        </div>
        <div class="oc-hint" data-i18n="tokensNote">token plaintext is shown only once at creation — the list only shows masks</div>
      </section>
    </div>

    <div id="view-access" hidden>
      <section id="sec-access-global">
        <h1 data-i18n="maGlobalTitle">Global allowlist</h1>
        <div class="sub" data-i18n="maGlobalSub">default models for keys without a custom override</div>
        <div class="panel">
          <div class="oc-form">
            <div class="oc-field oc-full">
              <label data-i18n="maGlobalModels">allowed models</label>
              <div class="ma-chips" id="ma-global-chips"></div>
              <div class="oc-hint" id="ma-global-hint"></div>
            </div>
            <div class="oc-field oc-full">
              <div class="ma-add-row">
                <input class="oc-input" id="ma-global-add" list="ma-global-options" placeholder="..." autocomplete="off" spellcheck="false" aria-label="add model">
                <datalist id="ma-global-options"></datalist>
                <button class="oc-btn oc-btn-ghost" id="ma-global-add-btn" data-i18n="maGlobalAdd">add</button>
              </div>
              <div class="oc-hint" data-i18n="maGlobalAddHint">add upstream model names — unsupported ones are passed through and the upstream error is returned as-is</div>
            </div>
            <div class="oc-field oc-full">
              <div class="ma-avail-hd">
                <span class="oc-hint" data-i18n="maAvailTitle">available models (all upstream)</span>
                <input class="oc-input oc-grow oc-min-160" id="ma-avail-search" placeholder="search…" autocomplete="off" aria-label="search available models">
              </div>
              <div class="ma-avail-grid" id="ma-avail-grid"></div>
            </div>
            <div class="ma-opt-row">
              <button class="oc-btn oc-btn-primary" id="ma-global-save" data-i18n="save">save</button>
              <button class="oc-btn oc-btn-ghost" id="ma-global-reset" data-i18n="maResetGlobal">reset to code default</button>
            </div>
          </div>
        </div>
      </section>

      <section id="sec-access-search">
        <div class="oc-form ma-opt-row">
          <input class="oc-input" id="ma-search" placeholder="..." autocomplete="off" aria-label="search model access">
          <select class="oc-select" id="ma-filter" aria-label="filter by type">
            <option value="" data-i18n="maFilterAll">all types</option>
            <option value="upstream-key" data-i18n="maFilterUpstream">upstream</option>
            <option value="token" data-i18n="maFilterToken">token</option>
            <option value="api-key" data-i18n="maFilterApiKey">api key</option>
          </select>
          <button class="oc-btn oc-btn-ghost" id="ma-refresh" data-i18n="maRefresh">refresh</button>
        </div>
      </section>

      <section id="sec-access-upstream">
        <h1 data-i18n="maUpstreamTitle">Upstream keys</h1>
        <div class="sub" data-i18n="maUpstreamSub">per-upstream-key model overrides</div>
        <div class="panel"><div id="ma-upstream"></div></div>
      </section>

      <section id="sec-access-token">
        <h1 data-i18n="maTokenTitle">Distribution tokens</h1>
        <div class="sub" data-i18n="maTokenSub">per-token model overrides</div>
        <div class="panel"><div id="ma-token"></div></div>
      </section>

      <section id="sec-access-apikey">
        <h1 data-i18n="maApiKeyTitle">API keys</h1>
        <div class="sub" data-i18n="maApiKeySub">per-API-key model overrides</div>
        <div class="panel"><div id="ma-apikey"></div></div>
      </section>
    </div>

    <div id="view-settings" hidden>
      <div class="settings-group">
        <div class="settings-group-hd" data-i18n="settingsGroupService">service</div>
      <section id="sec-settings-lang">
        <h1 data-i18n="langTitle">Language</h1>
        <div class="sub" data-i18n="langSub">interface language</div>
        <div class="dd">
          <button id="btn-settings-lang" class="oc-btn dd-toggle">中文</button>
          <div class="dd-menu" id="lang-menu-settings" hidden>
            <button class="oc-btn dd-item" data-lang="en">EN</button>
            <button class="oc-btn dd-item" data-lang="zh">中文</button>
          </div>
        </div>
        <div class="oc-hint" data-i18n="langNote">language preference is stored in localStorage</div>
      </section>

      <section id="sec-perf-toggle">
        <h1 data-i18n="perfPanel">Performance panel</h1>
        <div class="sub" data-i18n="perfPanelSub">show the performance dashboard on the overview page</div>
        <div class="exp-row">
          <span class="exp-name" data-i18n="perfPanel">Performance panel</span>
          <span class="exp-desc oc-hint" id="perf-state-hint"></span>
          <button class="oc-switch exp-toggle" id="perf-toggle" data-on="1" role="switch" aria-checked="true">
            <span class="oc-switch-track"><span class="oc-switch-knob"></span></span>
            <span class="oc-switch-sr">on</span>
          </button>
        </div>
        <div class="oc-hint" data-i18n="perfPanelNote">stored in localStorage, default on</div>
      </section>

      <section id="sec-modelmap">
        <h1 data-i18n="modelMapTitle">Model mapping</h1>
        <div class="sub" data-i18n="modelMapSub">map claude-* model names to deepseek models</div>
        <div class="panel">
          <table class="tbl">
            <thead><tr><th data-i18n="modelAlias">alias</th><th data-i18n="modelTarget">target</th><th data-i18n="modelNote">note</th><th></th></tr></thead>
            <tbody id="mm-rows"></tbody>
          </table>
          <div class="oc-hint" id="mm-empty" data-i18n="mmEmpty">no mappings yet</div>
        </div>
        <div class="oc-form">
          <div class="oc-field">
            <label for="mm-alias" data-i18n="modelAlias">alias</label>
            <input class="oc-input" id="mm-alias" placeholder="claude-mythos-5" autocomplete="off" spellcheck="false">
          </div>
          <div class="oc-field">
            <label for="mm-target" data-i18n="modelTarget">target</label>
            <input class="oc-input" id="mm-target" list="mm-targets" placeholder="deepseek-v4-flash-free" autocomplete="off" spellcheck="false">
            <datalist id="mm-targets">
              <option value="deepseek-v4-flash"></option>
              <option value="deepseek-v4-flash-free"></option>
            </datalist>
          </div>
          <div class="oc-field oc-full">
            <label for="mm-note" data-i18n="modelNote">note</label>
            <input class="oc-input" id="mm-note" placeholder="optional" autocomplete="off">
          </div>
          <div class="oc-hint-err oc-full" id="mm-err"></div>
          <button class="oc-btn oc-btn-primary oc-full" id="mm-add" data-i18n="addMapping">add mapping</button>
        </div>
        <div class="oc-hint" data-i18n="modelMapNote">Claude Code sends claude-* model names; the gateway looks up this table first and maps to the target — takes effect immediately</div>
      </section>

      </div>
      <div class="settings-group">
        <div class="settings-group-hd" data-i18n="settingsGroupSecurity">security</div>
      <section id="sec-admin-auth">
        <h1 data-i18n="adminAuthTitle">Admin account</h1>
        <div class="sub" data-i18n="adminAuthSub">login credentials for this panel</div>
        <div class="oc-form">
          <div class="oc-field">
            <label for="aa-user"><span data-i18n="adminUserLabel">username</span> <span class="oc-chip-src" id="aa-user-src"></span></label>
            <input class="oc-input" id="aa-user" autocomplete="off">
          </div>
          <div class="oc-field">
            <label for="aa-pass"><span data-i18n="adminPassLabel">password</span> <span class="oc-chip-src" id="aa-pass-src"></span>
              <span class="oc-chip oc-chip-danger" id="aa-pass-badge" hidden></span></label>
            <input class="oc-input" id="aa-pass" type="password" placeholder="..." autocomplete="new-password">
            <div class="oc-hint oc-hint-err" id="aa-pass-warn" hidden></div>
          </div>
          <div class="oc-hint-err oc-full" id="aa-err"></div>
          <button class="oc-btn oc-btn-primary oc-full" id="aa-save" data-i18n="save">save</button>
        </div>
        <div class="oc-hint" data-i18n="adminPassHint">all logged-in sessions are invalidated immediately after a password change; re-login required</div>
      </section>

      <section id="sec-admin-keys">
        <h1 data-i18n="apiKeysTitle">API keys</h1>
        <div class="sub" data-i18n="apiKeysSub">keys accepted for management access</div>
        <div class="panel">
          <div id="akey-rows"></div>
          <div class="oc-hint" id="akey-empty" data-i18n="apiKeysEmpty">no api keys</div>
        </div>
        <div class="oc-form">
          <div class="oc-field oc-full">
            <button class="oc-btn oc-btn-ghost" id="btn-akey-add" data-i18n="apiKeysAdd">add</button>
          </div>
        </div>
      </section>

      </div>
      <div class="settings-group">
        <div class="settings-group-hd" data-i18n="settingsGroupRuntime">runtime</div>
      <section id="sec-experimental">
        <h1 data-i18n="expTitle">Experimental</h1>
        <div class="sub" data-i18n="expSub">opt-in features, off by default</div>
        <div class="panel" id="exp-panel">
          <div class="oc-hint" id="exp-loading">…</div>
        </div>
        <div class="oc-hint" data-i18n="expNote">settings come from environment variables and are read at startup — changing them requires a restart</div>
      </section>

      <section id="sec-update">
        <h1 data-i18n="otaTitle">Update</h1>
        <div class="sub" data-i18n="otaSub">GitHub OTA self-update</div>
        <div class="card">
          <div class="meta">
            <span data-i18n="otaCurrent">current version</span>
            <strong id="ota-current">—</strong>
            <span class="oc-chip oc-chip-danger" id="ota-disabled-badge" hidden data-i18n="otaDisabled">disabled</span>
          </div>
          <div class="meta">
            <span data-i18n="otaLatest">latest version</span>
            <strong id="ota-latest">—</strong>
            <span class="w" id="ota-last-checked"></span>
          </div>
          <div class="oc-hint oc-hint-err" id="ota-error" hidden></div>
          <div class="oc-form">
            <div class="oc-field oc-full">
              <button class="oc-btn oc-btn-ghost" id="btn-ota-check" data-i18n="otaCheck">check for updates</button>
              <button class="oc-btn oc-btn-primary" id="btn-ota-update" hidden data-i18n="otaUpdate">update</button>
            </div>
          </div>
          <div class="meta" id="ota-rollback"></div>
          <div class="oc-hint" data-i18n="otaHint">updates run only when OTA_ENABLED=1; the service restarts itself</div>
        </div>
      </section>

      </div>
      <div class="settings-group">
        <div class="settings-group-hd" data-i18n="settingsGroupAbout">about</div>
      <section id="sec-about">
        <h1 data-i18n="about">About</h1>
        <div class="sub" data-i18n="aboutSub">fuckopencode admin panel</div>
        <div class="card">
          <div class="meta" data-i18n="aboutDesc">OpenAI <-> Anthropic protocol gateway for DeepSeek — manage upstream accounts and protocol conversion</div>
          <div class="meta"><a href="https://github.com/dwgx/fuckopencode" target="_blank" rel="noopener">github.com/dwgx/fuckopencode</a></div>
          <div class="meta">/__admin — <span data-i18n="aboutEndpointAdmin">management</span> · /__metrics — <span data-i18n="aboutEndpointMetrics">metrics</span> · /__dash — <span data-i18n="aboutEndpointDash">dashboard</span></div>
        </div>
        <div class="card backup-warn">
          <div class="meta bw-title" data-i18n="secretBackupTitle">back up secret.key</div>
          <div class="meta" data-i18n="secretBackupBody">data/secret.key encrypts every stored secret (account keys, cookies, OAuth tokens, distribution tokens). Losing or replacing it makes all of them permanently undecryptable. Copy it to a safe place and back it up with your data.</div>
        </div>
      </section>
      </div>
    </div>
  </main>
</div>

<div class="overlay" id="oauth-overlay" hidden>
  <div class="oc-modal" role="dialog" aria-modal="true">
    <div class="oc-modal-hd">
      <span data-i18n="oauthTitle">OpenCode sign-in</span>
      <button class="oc-btn oc-modal-x" id="oauth-close">×</button>
    </div>
    <div class="oc-modal-bd">
      <div class="oauth-field">
        <label data-i18n="oauthUrlLabel">verification url</label>
        <div class="oauth-url-row">
          <a id="oauth-url" target="_blank" rel="noopener"></a>
          <button class="oc-btn" id="oauth-copy" data-i18n="oauthCopy">copy</button>
        </div>
      </div>
      <div class="oauth-field">
        <label data-i18n="oauthCodeLabel">device code</label>
        <div class="oauth-code" id="oauth-code"></div>
      </div>
      <div class="oauth-hint" data-i18n="oauthHint">sign in in the opened page, then return here</div>
      <div class="oauth-status" id="oauth-status"></div>
      <div class="oauth-expires" id="oauth-expires"></div>
      <div class="oauth-actions">
        <button class="oc-btn" id="oauth-retry" hidden data-i18n="oauthRetry">retry</button>
      </div>
    </div>
  </div>
</div>

<div class="overlay" id="confirm-overlay" hidden>
  <div class="oc-modal" role="dialog" aria-modal="true">
    <div class="oc-modal-hd" id="confirm-title"></div>
    <div class="oc-modal-bd">
      <div id="confirm-body"></div>
      <div class="oc-hint-err" id="confirm-err"></div>
      <div class="oc-modal-actions">
        <button class="oc-btn oc-btn-ghost" id="confirm-cancel" data-i18n="cancel">cancel</button>
        <button class="oc-btn" id="confirm-ok" data-variant="primary"></button>
      </div>
    </div>
  </div>
</div>

<!-- 分发密钥明文展示（仅创建后这一次；关闭即不可再取回） -->
<div class="overlay" id="plain-overlay" hidden>
  <div class="oc-modal" role="dialog" aria-modal="true">
    <div class="oc-modal-hd" id="plain-title" data-i18n="tokensTitle">Distribution keys</div>
    <div class="oc-modal-bd">
      <div class="oc-hint oc-hint-err" id="plain-hint"></div>
      <div class="plain-list" id="plain-list"></div>
      <div class="oc-modal-actions">
        <button class="oc-btn oc-btn-primary" id="plain-close" data-i18n="tokenClose">close</button>
      </div>
    </div>
  </div>
</div>

<!-- OTA 更新进度弹层（确认用 confirm-overlay；这里只展示阶段进度与结果） -->
<div class="overlay" id="update-overlay" hidden>
  <div class="oc-modal" role="dialog" aria-modal="true">
    <div class="oc-modal-hd" id="update-title"></div>
    <div class="oc-modal-bd">
      <div id="update-body"></div>
      <div class="oc-hint oc-hint-err" id="update-err"></div>
      <div class="oc-modal-actions">
        <button class="oc-btn oc-btn-ghost" id="update-close" data-i18n="otaClose">close</button>
      </div>
    </div>
  </div>
</div>

<script>
(function () {
  var I18N = {
    en: {
      degradedTitle: 'accounts unavailable',
      overview: 'Overview', overviewSub: 'accounts, balance and key health',
      accountsLabel: 'accounts', healthy: 'healthy',
      totalBalance: 'total balance', cooldown: 'cooldown',
      healthTitle: 'Health', healthSub: 'per-account status at a glance',
      createTitle: 'Create account', createSub: 'register an upstream account, keys are encrypted at rest',
      name: 'name', kind: 'kind', workspaceId: 'workspace id',
      keysLabel: 'keys (comma separated)', cookieLabel: 'cookie (optional)',
      create: 'create',
      accountsTitle: 'Accounts', accountsSub: 'per-account status, balance and keys',
      collapse: 'collapse', expand: 'expand',
      collapseAll: 'collapse all', expandAll: 'expand all',
      noAccounts: 'No accounts yet', noAccountsSub: 'create one to start managing keys and balance',
      balance: 'balance', monthlyLimit: 'monthly limit',
      previewUsage: '7d usage', previewGo: 'go limits',
      legacyHint: 'view in account details',
      dupKeyBadge: 'shared key', dupKeyHint: 'this legacy key is also used by another account or the key pool',
      lastProbe: 'last probe', lastBilling: 'last billing', never: 'never',
      retryIn: 'retry in', nextProbe: 'next probe in', inFlight: 'in flight',
      inflightTitle: 'keys currently being requested',
      keysTitle: 'keys', noKeys: 'no keys',
      edit: 'edit', save: 'save', cancel: 'cancel',
      refresh: 'refresh balance', addKey: 'add key', remove: 'remove',
      delete: 'delete', confirmDelete: 'Delete this account? Its keys will stop routing.',
      confirmDeleteKey: 'Remove this key from the account?',
      keyNotFound: 'key not found in account',
      // 状态友好文案（徽标字 + 解释）。
      stUnknown: 'not probed', stOk: 'healthy', stInvalid: 'invalid key',
      stInsufficient: 'insufficient balance', stLimit: 'limit reached',
      stCooldown: 'cooling down', stRegion: 'region blocked', stError: 'error',
      stUnknownHint: 'not probed yet — waiting for the first probe',
      // 健康度说明（总览）。
      healthNote: 'healthy = recent probe passed',
      healthNoteWait: ' account(s) waiting for first probe',
      waitingProbe: 'waiting for first probe',
      // key 昵称。
      rename: 'rename', nickname: 'nickname',
      renameHint: 'leave blank to clear the nickname', renamed: 'nickname saved',
      refreshed: 'balance refreshed', opFail: 'request failed',
      networkFlaky: 'network hiccup, retrying automatically…',
      notConnected: 'not connected', waitingSync: 'connected — balance syncs on next probe', processing: 'processing…',
      logout: 'logout',
      kindUnknown: 'unset', kindSubscription: 'subscription', kindPayg: 'pay as you go',
      goSub: 'Go subscription', goSubHint: 'usage windows from OpenCode Go (opencode.ai)',
      goRolling: 'Rolling (5h)', goWeekly: 'Weekly', goMonthly: 'Monthly',
      goReset: 'resets in', goUseBalance: 'use balance after limit', goChinaModels: 'enable China-hosted models', goNotSubscribed: 'not subscribed',
      nameRequired: 'name is required', cookieKeep: 'leave blank to keep', cookieClearCheckbox: 'clear saved cookie',
      live: 'live',
      tabOverview: 'Overview', tabAccounts: 'Accounts', tabUsage: 'Usage', tabSettings: 'Settings',
      subOverview: 'Overview', subHealth: 'Health',
      subAccounts: 'Accounts', subCreate: 'Create account', subOauth: 'OpenCode sign-in',
      subRequests: 'Request stats', subKeys: 'Key pool',
      subLanguage: 'Language', subUpdate: 'Update', subAbout: 'About',
      usageTitle: 'Request stats', usageSub: 'traffic summary from /__metrics',
      totalRequests: 'total requests', failed: 'failed', streaming: 'streaming',
      avgDuration: 'avg duration', tokens: 'tokens',
      keypoolTitle: 'Key pool', keypoolSub: 'per-key health and in-flight load',
      noRequests: 'no requests yet',
      langTitle: 'Language', langSub: 'interface language',
      langNote: 'language preference is stored in localStorage',
      langEn: 'EN', langZh: '中文', langJa: '日本語',
      about: 'About', aboutSub: 'fuckopencode admin panel',
      aboutDesc: 'OpenAI <-> Anthropic protocol gateway for DeepSeek — manage upstream accounts and protocol conversion',
      aboutEndpointAdmin: 'management', aboutEndpointMetrics: 'metrics',
      secretBackupTitle: 'back up secret.key',
      secretBackupBody: 'data/secret.key encrypts every stored secret (account keys, cookies, OAuth tokens, distribution tokens). Losing or replacing it makes all of them permanently undecryptable. Copy it to a safe place and back it up with your data.',
      otaTitle: 'Update', otaSub: 'GitHub OTA self-update',
      otaCurrent: 'current version', otaLatest: 'latest version',
      otaDisabled: 'disabled', otaCheck: 'check for updates', otaChecking: 'checking…',
      otaUpdate: 'update', otaCheckedAt: 'checked', otaCheckFailed: 'cannot reach the update source',
      otaPrevPresent: 'previous version kept', otaRolledBack: 'a failed update was rolled back',
      otaRollbackState: 'rollback',
      otaHint: 'updates run only when OTA_ENABLED=1; the service restarts itself',
      otaConfirmTitle: 'Confirm update',

      otaStageCheck: 'checking…', otaStageDownload: 'downloading…', otaStageVerify: 'verifying…',
      otaStageSwap: 'replacing…', otaStageRestart: 'restarting…',
      otaRestarting: 'restarting — refresh the page in a moment to see the new version',
      otaChangelog: 'changelog', otaNoChangelog: 'no changelog available',
      otaClose: 'close',
      oauthStart: 'Sign in with OpenCode', oauthTitle: 'OpenCode sign-in',
      oauthDesc: 'pair an opencode account via device code',
      oauthUrlLabel: 'verification url', oauthCodeLabel: 'device code',
      oauthHint: 'sign in in the opened page, then return here',
      oauthCopy: 'copy', oauthCopied: 'copied',
      copied: 'copied',
      oauthPolling: 'polling for approval', oauthStarting: 'starting',
      oauthExpiresIn: 'code expires in', oauthDone: 'account signed in',
      oauthExpired: 'device code expired, retry', oauthDenied: 'sign-in denied, retry',
      oauthNotFound: 'sign-in session not found, retry',
      oauthFail: 'sign-in failed', oauthNetFail: 'network error',
      oauthRetry: 'retry', oauthInvalid: 'OAuth credential invalid, sign in again',
      oauthInstead: 'or sign in with OpenCode instead',
      detail: 'details', back: 'back', subDetail: 'Account detail',
      // 详情页分组 tab（5 组：订阅 & Keys / 工作区 & 模型 / 财务 / 组织 / 定价）。
      detailTabSub: 'Subscription & Keys', detailTabWs: 'Workspace & Models',
      detailTabFinance: 'Finance', detailTabOrg: 'Organization', detailTabPricing: 'Pricing',
      // 工作区区块（显示当前 workspace + 切换）。
      workspaceTitle: 'Workspace', workspaceSub: 'current console workspace and switching',
      currentWorkspace: 'current workspace', wsLegacy: 'legacy workspace',
      noWorkspace: 'no workspace configured',
      wsManual: 'enter workspace id manually…', wsManualHint: 'switch uses the new console workspace (org_...) — console data reloads after switching',
      wsSwitch: 'switch', wsSwitchTitle: 'Switch workspace',
      wsSwitched: 'workspace switched', wsIdRequired: 'select or enter a workspace id',
      // 可用模型区块（账号配置的模型列表 + 全局默认 + 目录状态）。
      allowedModelsTitle: 'Allowed models', allowedModelsSub: 'models this account may request',
      globalDefault: 'global default', accountOverride: 'account override',
      clearToGlobal: 'clear to global', clearToGlobalHint: 'leave empty to use the global default',
      modelCatalog: 'model catalog', catalogModels: 'models loaded', catalogRefreshed: 'last refresh',
      modelsBlocked: 'blocked by passive learning', modelsSaved: 'allowed models saved',
      modelsPlaceholder: 'comma separated model names',
      balanceTitle: 'Balance', balanceSub: 'console balance, ledger and payment methods',
      currentBalance: 'Current balance', promotional: 'promotional',
      ledger: 'ledger', paymentMethods: 'payment methods', none: 'none',
      detailUsageTitle: 'Usage', detailUsageSub: 'requests and cost on the console account',
      requests: 'requests', inputTokens: 'input tokens', outputTokens: 'output tokens',
      cost: 'cost', date: 'date',
      autoRechargeTitle: 'Auto recharge', autoRechargeSub: 'reload when balance drops below the threshold',
      enabled: 'enabled', disabled: 'disabled',
      threshold: 'threshold', rechargeAmount: 'recharge amount',
      configure: 'configure',
      budgetsTitle: 'Monthly budgets', budgetsSub: 'per-org and per-user monthly spending caps',
      orgBudget: 'org budget', userBudget: 'user budget',
      notSet: 'not set', set: 'set',
      membersTitle: 'Members', membersSub: 'people with access to this workspace',
      memberEmail: 'email', role: 'role', joined: 'joined', noMembers: 'no members',
      saTitle: 'Service accounts', saSub: 'API keys issued on the console — metered, billed against your zen balance (same channel as legacy API keys; Go subscription is the weekly/monthly window below)',
      saName: 'name', created: 'created', noSa: 'no service accounts',
      createSa: 'create service account',
      // 旧版 workspace（opencode.ai 老控制台）的 key 管控。
      legacyKeys: 'Legacy API keys', legacySub: 'API keys issued on the legacy console (opencode.ai) — metered, billed against your zen balance (Go subscription is the weekly/monthly window below)',
      legacyCreateTitle: 'Create legacy key',
      createKey: 'create key', keyName: 'key name',
      masked: 'masked', creator: 'creator',
      keyCreated: 'key created', keyDeleted: 'key deleted',
      delLegacyKeyConfirm: 'Delete this legacy key? It will stop working immediately.',
      legacyCookieMissing: 'legacy console cookie not configured',
      refreshKeys: 'refresh', noLegacyKeys: 'no legacy keys',
      legacyKeyTitle: 'Legacy API key', legacyKeySub: 'optional: paste the Default API Key from the legacy console — Go usage then reads from the zen JSON API with no cookie',
      legacyKeyPlaceholder: 'sk-...',
      legacyKeySave: 'save', legacyKeyClear: 'clear',
      legacyKeyConfigured: 'configured:', legacyKeyNotConfigured: 'not configured — cookie-free Go usage available',
      legacyKeySaved: 'legacy API key saved', legacyKeyCleared: 'legacy API key cleared',
      legacyKeyEmpty: 'paste a legacy API key first',
      providersTitle: 'Providers', providersSub: 'providers available on this account',
      provider: 'provider', modelCount: 'models', status: 'status', noProviders: 'no providers',
      consoleNotConfigured: 'console not configured for this account (env proxy uses local keys only)',
      cookieInvalid: 'console session invalid, update the cookie below',
      cookieMissing: 'no console session, import a cookie to read console data',
      importFromBrowser: 'import from browser',
      importCookie: 'import',
      cookiePasteEmpty: 'paste a cookie first',
      confirm: 'confirm',
      arModalTitle: 'Configure auto recharge',
      arEnabled: 'enable auto recharge',
      thresholdDollars: 'threshold ($)', rechargeAmountDollars: 'recharge amount ($)',
      arRequiresAmount: 'threshold and amount are required when enabled',
      mlModalTitle: 'Set monthly budget',
      invalidNumber: 'enter a valid number',
      saModalTitle: 'Create service account',
      saModalName: 'name',
      cookieModalTitle: 'Import cookie',
      cookieModalBody: 'Import the console session cookie from the shared browser?',
      arSaved: 'auto recharge saved',
      mlSaved: 'budget saved',
      saCreated: 'service account created',
      saDeleted: 'service account deleted',
      cookieImported: 'cookie imported',
      cookiePasted: 'cookie saved',
      consoleUnavailable: 'console data unavailable',
      usageUnavailable: 'usage data unavailable',
      delSaConfirm: 'Delete this service account? Its API key will stop working.',
      oauthLoggedIn: 'Logged in as',
      // 用量明细表头（dashboard 同款列 + 请求详情列）。
      hTime: 'time', hStatus: 'status', hRequest: 'request', hMs: 'ms', hTokens: 'tokens',
      hClient: 'client',
      // 请求明细（分页 + 搜索 + 跳页 + 每页条数 + IP 统计）。
      detailRequests: 'Detailed requests', reqPrev: 'prev', reqNext: 'next', reqPage: 'page',
      reqGo: 'go',
      reqShowAll: 'show all requests',
      ipStatsTitle: 'Top IPs', ipStatsSub: 'traffic aggregated by client IP',
      ipClients: 'clients', ipLast: 'last seen', ipEmpty: 'no traffic yet',
      ipFilterHint: 'filter detailed requests by this IP',
      // 操作审计（管理面写操作的脱敏留痕）。
      auditTitle: 'Admin audit', auditSub: 'who · when · what on the management panel',
      auditOp: 'op', auditResult: 'result', auditAccount: 'account', auditIp: 'ip',
      auditOk: 'ok', auditFail: 'fail', auditEmpty: 'no admin operations yet',
      subIps: 'Top IPs',
      subAudit: 'Admin audit',
      aboutEndpointDash: 'dashboard',
      // 模型映射（设置页）。
      subModelMap: 'Model mapping',
      modelMapTitle: 'Model mapping', modelMapSub: 'map claude-* model names to deepseek models',
      modelAlias: 'alias', modelTarget: 'target', modelNote: 'note',
      addMapping: 'add mapping',
      modelMapNote: 'Claude Code sends claude-* model names; the gateway looks up this table first and maps to the target — takes effect immediately',
      mmEmpty: 'no mappings yet', mmRequired: 'alias and target are required',
      mmSaved: 'mapping saved', mmDeleted: 'mapping deleted',
      mmEditTitle: 'Edit mapping', mmEdited: 'mapping updated',
      mmTargetRequired: 'target is required',
      mmConfirmDel: 'Delete this mapping? Requests using this alias will fall back to the default model.',
      // 波 2：旧版计费 + P0 面板 + 观测计数 + 实验功能。
      legacyBilling: 'Legacy billing', legacyBillingSub: 'balance, auto reload and payment history on the legacy console (opencode.ai)',
      legacyReload: 'auto reload', paymentHistory: 'payment history', noPayments: 'no payments yet',
      costTrend: 'daily cost (7d)', noTrend: 'no cost data in range',
      modelUsageTitle: 'Model usage', modelUsageSub: 'cost and tokens by model',
      userUsageTitle: 'Member usage', userUsageSub: 'requests and tokens by member',
      spent: 'spent', exceeded: 'exceeded', resetsAt: 'resets at',
      memberBudgetTitle: 'Member budgets',
      pricingTitle: 'Model pricing', pricingSub: 'price per million tokens (v2/config)',
      inPerMtok: 'input', outPerMtok: 'output',
      fixCountTitle: 'compat fixes', fixRewritten: 'rewritten', fixStripped: 'stripped', fixCompressed: 'compressed',
      expTitle: 'Experimental', expSub: 'opt-in features, off by default',
      expNote: 'changes apply immediately and persist across restarts',
      expUnavailable: 'experimental settings unavailable',
      expScaleUsage: 'usage scaling', expScaleDesc: 'multiply client-visible usage to trigger earlier local compaction',
      expCompact: 'passive compaction', expCompactDesc: 'compact request bodies above the threshold before sending upstream',
      expOn: 'on', expOff: 'off',
      // 批次 2：分发密钥 tab。
      tabTokens: 'Keys', subTokens: 'Keys',
      tokensTitle: 'Distribution keys', tokensSub: 'client tokens routing through the shared upstream pool',
      tokensNote: 'token plaintext is shown only once at creation — the list only shows masks',
      tokensEmpty: 'no tokens yet', tokensUnavailable: 'token data unavailable',
      tokenRefresh: 'refresh', tokenCreate: 'create token',
      tokenName: 'name', tokenCount: 'count (1-10)', tokenNameRequired: 'name is required',
      tokenCustomKey: 'custom key (optional)', tokenCustomKeyPlaceholder: 'leave blank = auto-generate',
      tokenCountInvalid: 'count must be 1-10', tokenCreated: 'tokens created',
      tokenPlainOnlyOnce: 'shown only once — copy each key now; it cannot be recovered later',
      tokenCopy: 'copy', tokenCopied: 'copied', tokenClose: 'close',
      tokenCopyTitle: 'copy full token',
      tokenPlainMissing: 'plaintext not stored (created before plaintext storage) — re-create the token to keep it viewable',
      tokenActive: 'active', tokenDisabled: 'disabled',
      tokenUsage: 'usage', tokenCreatedAt: 'created',
      tokenEditTitle: 'Edit token', tokenNote: 'note', tokenNotePlaceholder: 'optional',
      tokenDeleted: 'token deleted',
      tokenEnabled: 'token enabled', tokenDisabledMsg: 'token disabled',
      tokenDisable: 'disable', tokenEnable: 'enable',
      tokenDeleteConfirm: 'Delete this token? Clients using it will stop working immediately.',
      // 批次 2：总览健康度（统计卡组 + 状态列表）。
      ovTotalRequests: 'requests', ovSuccessRate: 'success rate',
      ovCostLabel: 'key cost', ovKeys: 'dist. keys',
      ovTrendNote: '7d aggregates from gateway usage history', ovTrendFallback: 'snapshot (usage db unavailable)',
      statusTitle: 'Status', statusSub: 'gateway, upstream pool, accounts and distribution keys at a glance',
      subStatus: 'Status',
      stGateway: 'gateway', stUpstream: 'upstream pool', stAccounts: 'accounts',
      stDistKeys: 'dist. keys', stFixes: 'compat fixes',
      stRunning: 'running', stLoading: 'loading…', loading: 'loading…',
      // 批次 2：设置页热改。
      adminAuthTitle: 'Admin account', adminAuthSub: 'login credentials for this panel',
      adminUserLabel: 'username', adminPassLabel: 'password',
      adminPassPlaceholder: 'leave blank to keep current',
      adminPassHint: 'all logged-in sessions are invalidated immediately after a password change; re-login required',
      adminPassEnvWarn: 'using the default password — change it',
      adminPassDefaultBadge: 'default password — change it',
      authSaved: 'admin credentials saved', aaNothing: 'nothing to save',
      sourceEnv: 'source: env', sourceDb: 'source: panel', codeDefault: 'code default',
      apiKeysTitle: 'API keys', apiKeysSub: 'keys accepted for management access',
      apiKeysEmpty: 'no api keys', apiKeysAdd: 'add', apiKeysAddTitle: 'Add API key',
      apiKeysCopy: 'copy plaintext',
      apiKeysLabel: 'api keys', apiKeysPasteHint: 'one key per line (panel-managed keys are kept)',
      apiKeysNoPlain: 'plaintext not available — manage in server config',
      apiKeysEnvWarn: 'env-sourced keys without recoverable plaintext will be dropped on save',
      apiKeysDeleteConfirm: 'Remove this API key? Clients using it will stop working.',
      apiKeysSaved: 'API keys saved', settingsSaved: 'settings saved',
      subAdminAuth: 'Admin account', subAdminKeys: 'API keys', subExperimental: 'Experimental',
      // 批次 2：账号卡余额来源标注。
      balanceOrg: 'balance (org)',
      // 批次 2：RPM 限流配置 + legacy key 明文复制。
      tokenRpm: 'rpm limit', tokenRpmHint: 'requests per minute — 0 = unlimited',
      tokenRpmSaved: 'rpm limit saved', tokenRpmInvalid: 'enter a number ≥ 0',
      // 配额（QUOTA.md §7）：每密钥 $ / tokens / 请求上限 + 周期 + 过期 + 状态。
      quota: 'quota',
      quotaUsd: '$ quota', quotaTokens: 'token quota', quotaRequests: 'request quota',
      quotaCycle: 'reset cycle', quotaCycleNone: 'none', quotaCycleDaily: 'daily', quotaCycleMonthly: 'monthly',
      quotaExpires: 'expires at', quotaExpiresHint: 'blank = never expires (0)',
      quotaHint: '0 = unlimited', quotaNone: 'no quota',
      quotaTpm: 'TPM (tokens per minute)', ipWhitelist: 'IP whitelist',
      ipWhitelistHint: 'comma-separated IPs or CIDR, blank = allow all',
      quotaBadgeOk: 'ok', quotaBadgeExhausted: 'exhausted', quotaBadgeExpired: 'expired',
      quotaInvalid: 'enter a valid quota (numbers ≥ 0)', quotaSaved: 'quota saved',
      legacyKeyNotFound: 'key not found in plain list',
      legacyKeyCopyTitle: 'copy plaintext to clipboard',
      // Model access tab（MODEL-ACCESS §6）。
      tabModelAccess: 'Model Access', subModelAccess: 'Model Access',
      maGlobalTitle: 'Global allowlist',       maGlobalSub: 'default models for keys without a custom override',
      maAvailTitle: 'available models (all upstream)',
      maGlobalModels: 'allowed models',
      maGlobalFloor: 'code default (reset base): ',
      maGlobalAdd: 'add', maGlobalAddHint: 'add upstream model names — unsupported ones are passed through and the upstream error is returned as-is',
      maGlobalEmpty: 'no models selected',
      maAddInvalid: 'invalid model name: ',
      maResetGlobal: 'reset to code default', maGlobalSaved: 'global allowlist saved',
      maSearchPh: 'search name / mask',
      maFilter: 'filter by type',
      maFilterAll: 'all types', maFilterUpstream: 'upstream', maFilterToken: 'token', maFilterApiKey: 'api key',
      maRefresh: 'refresh',
      maUpstreamTitle: 'Upstream keys', maUpstreamSub: 'per-upstream-key model overrides',
      maTokenTitle: 'Distribution tokens', maTokenSub: 'per-token model overrides',
      maApiKeyTitle: 'API keys', maApiKeySub: 'per-API-key model overrides',
      maEmpty: 'no keys configured', maNoMatch: 'no keys match the filter',
      maCustomBadge: 'custom', maFollowsGlobal: 'follows global',
      maEditTitle: 'Edit model access', maSaved: 'model access saved',
      maFollowGlobal: 'follow global (clear)',
      maNotGrantable: 'only models in the global allowlist can be granted',
      // 额度耗尽类错误友好文案（friendlyQuota）：识别 GoUsageLimitError /
      // FreeUsageLimitError / 月额度 / 余额不足 → 短文案 + 重置时间；原文在 title 可展开。
      quotaGo: 'Go usage limit reached', quotaFree: 'rate limited',
      quotaGeneric: 'usage limit reached', quotaBalance: 'insufficient balance',
      quotaResetsPre: 'resets in ', quotaResetsPost: '',
      // 账号 key 行增强：用量弹层 + 手动启停 + 引导创建分发密钥。
      keyUsage: 'usage', keyUsageHint: 'requests, tokens and cost for this upstream key',
      keyUsageTitle: 'Key usage', keyUsageNoData: 'no usage data yet',
      keyDisable: 'disable', keyDisableHint: 'stop routing this key (manual)',
      keyReset: 'reset', keyResetHint: 're-enable this key',
      manualPermanent: 'disabled permanently',
      keyDisabledMsg: 'key disabled', keyEnabledMsg: 'key re-enabled',
      gotoKeys: 'keys', keyQuotaGuide: 'create a quota distribution token in the Keys tab so clients can use this pool',
      // 设置页分组卡片（服务/安全/运行/关于）。
      settingsGroupService: 'service', settingsGroupSecurity: 'security',
      settingsGroupRuntime: 'runtime', settingsGroupAbout: 'about',
      // 总览性能仪表盘。
      subPerf: 'Performance',
      perfTitle: 'Performance', perfSub: 'process, system and gateway health at a glance',
      perfRss: 'memory (rss)', perfCpu: 'cpu', perfLoad: 'load',
      perfConcurrent: 'concurrency', perfLatency: 'latency', perfPool: 'key pool',
      perfUptime: 'up', perfHide: 'hidden', perfShow: 'shown',
      perfPanel: 'Performance panel', perfPanelSub: 'show the performance dashboard on the overview page',
      perfPanelNote: 'stored in localStorage, default on',
      // i18n 修复轮：静态 placeholder/title + 请求行 key 前缀 + 配额 tooltip + 实验描述单位。
      reqSearchPh: 'search path/status/model/client/ua/error',
      reqPageSize: 'page size', reqJumpTo: 'jump to page',
      searchPh: 'search…', optionalPh: 'optional',
      reqKey: 'key', quotaRemaining: 'remaining $', chars: 'chars',
      // 上游 key 禁用原因（disabledReason 枚举 → 友好文案，与 dashboard kindText 同款）。
      drQuota: 'quota exhausted', drAuth: 'invalid credential',
      drRate: 'rate limited', drTransient: 'repeated transient errors', drManual: 'disabled manually',
      // 服务端表单校验高频消息（其余 fail() 消息待后续轮次处理）。
      serverErrNameTooLong: 'name must be at most 100 characters',
      serverErrKind: 'invalid kind (subscription / payg / unknown)',
      serverErrKeysBad: 'invalid keys format',
      serverErrKeyTooLong: 'each key must be at most 200 characters',
      serverErrKeysTooMany: 'at most 20 keys',
      serverErrBody: 'request body must be a JSON object',
      serverErrWsType: 'workspace id must be a string',
      serverErrCookieType: 'cookie must be a string',
      serverErrWsTooLong: 'workspace id must be at most 200 characters',
      serverErrCookieTooLong: 'cookie must be at most 4096 characters',
      serverErrLegacyWsRequired: 'legacy workspace id must be a non-empty string or null',
      serverErrLegacyWsTooLong: 'legacy workspace id must be at most 200 characters',
      serverErrLegacyCookieType: 'legacy cookie must be a string or null',
      serverErrLegacyCookieTooLong: 'legacy cookie must be at most 2048 characters',
      serverErrLegacyKeyType: 'legacy key must be a string or null',
      serverErrLegacyKeyTooLong: 'legacy key must be at most 2048 characters',
      serverErrAllowedModelsType: 'allowed models must be an array of strings',
      serverErrAllowedModelsTooMany: 'allowed models must have at most 50 entries',
      serverErrAllowedModelsEmpty: 'allowed models must not contain empty entries',
      serverErrAllowedModelType: 'each allowed model must be a string',
      serverErrAllowedModelTooLong: 'each allowed model must be at most 100 characters',
      serverErrAliasType: 'alias must be a string',
      serverErrAliasFormat: 'alias must be 1-100 characters of letters, digits, dot, dash or underscore',
      serverErrTargetType: 'target must be a string',
      serverErrTargetRequired: 'target must be a non-empty string of at most 100 characters',
      serverErrNoteType: 'note must be a string or null',
      serverErrNoteTooLong: 'note must be at most 200 characters',
      serverErrNameType: 'name must be a string',
      serverErrNameRange: 'name must be 1-100 characters',
      serverErrStatus: 'status must be active or disabled',
      serverErrQuotaUsd: 'quota usd must be a non-negative number',
      serverErrQuotaTokens: 'quota tokens must be a non-negative integer',
      serverErrQuotaRequests: 'quota requests must be a non-negative integer',
      serverErrQuotaTpm: 'quota tpm must be a non-negative integer',
      serverErrExpires: 'expires must be a non-negative integer (epoch ms, 0 = never)',
      serverErrRpm: 'rpm limit must be an integer 0-1000000',
      serverErrTokenPlainType: 'token plaintext must be a string or null',
      serverErrTokenPlainLen: 'token plaintext must be 1-256 characters',
      serverErrModelsRequired: 'models is required',
      serverErrSubjectRequired: 'subject is required',
      serverErrNicknameType: 'nickname must be a string or null',
      serverErrNicknameTooLong: 'nickname must be at most 30 characters',
      serverErrNicknameFailed: 'failed to update key nickname'
    },
    zh: {
      degradedTitle: '账号数据不可用',
      overview: '总览', overviewSub: '账户、余额与 key 健康度',
      accountsLabel: '个账号', healthy: '健康',
      totalBalance: '余额汇总', cooldown: '冷却中',
      healthTitle: '健康度', healthSub: '账户状态一览',
      createTitle: '创建账号', createSub: '注册一个上游账号，key 加密落盘',
      name: '名称', kind: '类型', workspaceId: '工作区 id',
      keysLabel: '密钥（逗号分隔）', cookieLabel: 'Cookie（可选）',
      create: '创建',
      accountsTitle: '账号', accountsSub: '账户状态、余额与 key',
      collapse: '收起', expand: '展开',
      collapseAll: '全部收起', expandAll: '全部展开',
      noAccounts: '暂无账号', noAccountsSub: '创建一个账号开始管理 key 与余额',
      balance: '余额', monthlyLimit: '月额度',
      previewUsage: '7 天用量', previewGo: 'Go 额度',
      legacyHint: '查看账号详情',
      dupKeyBadge: '共用密钥', dupKeyHint: '该 legacy key 与其他账号或 key 池共用',
      lastProbe: '最近探针', lastBilling: '最近抓取', never: '从未',
      retryIn: '剩余冷却', nextProbe: '下次探测', inFlight: '在飞',
      inflightTitle: '当前正在被请求的 key 数',
      keysTitle: '密钥', noKeys: '暂无 key',
      edit: '编辑', save: '保存', cancel: '取消',
      refresh: '刷新余额', addKey: '添加 key', remove: '移除',
      delete: '删除', confirmDelete: '删除该账号？其 key 将停止路由。',
      confirmDeleteKey: '从该账号移除这个 key？',
      keyNotFound: '账号中未找到该 key',
      // 状态友好文案（徽标字 + 解释）。
      stUnknown: '未探测', stOk: '正常', stInvalid: 'key 失效',
      stInsufficient: '余额不足', stLimit: '达到限额',
      stCooldown: '冷却中', stRegion: '区域受限', stError: '异常',
      stUnknownHint: '还没探过活，等待首次探测',
      // 健康度说明（总览）。
      healthNote: '健康 = 最近探针正常',
      healthNoteWait: ' 个账号等待首次探测',
      waitingProbe: '等待首次探测',
      // key 昵称。
      rename: '改名', nickname: '昵称',
      renameHint: '留空 = 清除昵称', renamed: '昵称已保存',
      refreshed: '余额已刷新', opFail: '请求失败',
      networkFlaky: '网络波动，自动重试中…',
      notConnected: '未接入', waitingSync: '已连接 · 余额随下次探测同步', processing: '处理中…',
      logout: '退出',
      kindUnknown: '未标注', kindSubscription: '订阅', kindPayg: '按量',
      goSub: 'Go 订阅', goSubHint: 'OpenCode Go 的用量窗口（opencode.ai）——订阅靠周/月窗口额度，重置后自动恢复；窗口用尽时可「达限额后用余额」转按量',
      goRolling: '滚动（5 小时）', goWeekly: '每周', goMonthly: '每月',
      goReset: '重置于', goUseBalance: '达限额后用余额', goChinaModels: '启用中国区模型', goNotSubscribed: '未订阅',
      nameRequired: '名称不能为空', cookieKeep: '留空 = 不修改', cookieClearCheckbox: '清除已存 cookie',
      live: '实时',
      tabOverview: '总览', tabAccounts: '账号', tabUsage: '用量', tabSettings: '设置',
      subOverview: '概览', subHealth: '健康度',
      subAccounts: '账号列表', subCreate: '创建账号', subOauth: 'OpenCode 登录',
      subRequests: '请求统计', subKeys: 'Key 池',
      subLanguage: '语言', subUpdate: '更新', subAbout: '关于',
      usageTitle: '请求统计', usageSub: '来自 /__metrics 的流量汇总',
      totalRequests: '总请求', failed: '失败', streaming: '流式',
      avgDuration: '平均耗时', tokens: '令牌',
      keypoolTitle: 'Key 池', keypoolSub: '逐 key 健康度与在飞负载',
      noRequests: '暂无请求',
      langTitle: '语言', langSub: '界面语言',
      langNote: '语言偏好保存在 localStorage',
      langEn: 'EN', langZh: '中文', langJa: '日本語',
      about: '关于', aboutSub: 'fuckopencode 管理面板',
      aboutDesc: 'OpenAI 与 Anthropic 协议转换网关，面向 DeepSeek —— 用于管理上游账号与协议转换',
      aboutEndpointAdmin: '管理', aboutEndpointMetrics: '指标',
      secretBackupTitle: '请备份 secret.key',
      secretBackupBody: 'data/secret.key 加密了所有落库密钥（账户 key / cookie / OAuth / 分发 token）。一旦丢失或更换，这些数据将永久无法解密。请把 secret.key 复制到安全位置（如密码管理器），并连同 data 目录一起备份。',
      otaTitle: '更新', otaSub: 'GitHub OTA 自更新',
      otaCurrent: '当前版本', otaLatest: '远端最新',
      otaDisabled: '已停用', otaCheck: '检查更新', otaChecking: '检查中…',
      otaUpdate: '更新', otaCheckedAt: '检查于', otaCheckFailed: '无法连接更新源',
      otaPrevPresent: '保留旧版本', otaRolledBack: '曾有失败更新被回滚',
      otaRollbackState: '回滚',
      otaHint: '仅当 OTA_ENABLED=1 时才能更新；更新后服务自动重启',
      otaConfirmTitle: '确认更新',
      otaStageCheck: '检查中…', otaStageDownload: '下载中…', otaStageVerify: '校验中…',
      otaStageSwap: '替换中…', otaStageRestart: '即将重启…',
      otaRestarting: '正在重启 —— 稍后刷新页面即可看到新版本',
      otaChangelog: '更新日志', otaNoChangelog: '暂无更新日志',
      otaClose: '关闭',
      oauthStart: '通过 OpenCode 登录', oauthTitle: 'OpenCode 登录',
      oauthDesc: '通过设备码绑定 opencode 账号',
      oauthUrlLabel: '验证链接', oauthCodeLabel: '设备码',
      oauthHint: '在打开的页面登录后回到这里',
      oauthCopy: '复制', oauthCopied: '已复制',
      copied: '已复制',
      oauthPolling: '等待授权中', oauthStarting: '启动中',
      oauthExpiresIn: '设备码过期倒计时', oauthDone: '账号登录成功',
      oauthExpired: '设备码已过期，可重试', oauthDenied: '登录被拒绝，可重试',
      oauthNotFound: '登录会话不存在，可重试',
      oauthFail: '登录失败', oauthNetFail: '网络错误',
      oauthRetry: '重试', oauthInvalid: 'OAuth 凭据失效，请重新授权',
      oauthInstead: '或用 OpenCode 登录',
      detail: '详情', back: '返回', subDetail: '账号详情',
      // 详情页分组 tab（5 组：订阅 & Keys / 工作区 & 模型 / 财务 / 组织 / 定价）。
      detailTabSub: '订阅 & Keys', detailTabWs: '工作区 & 模型',
      detailTabFinance: '财务', detailTabOrg: '组织', detailTabPricing: '定价',
      // 工作区区块（显示当前 workspace + 切换）。
      workspaceTitle: '工作区', workspaceSub: '当前控制台工作区与切换',
      currentWorkspace: '当前工作区', wsLegacy: '旧版工作区',
      noWorkspace: '未配置工作区',
      wsManual: '手动输入工作区 id…', wsManualHint: '切换走新版控制台 workspace（org_...），切换后控制台数据重新加载',
      wsSwitch: '切换', wsSwitchTitle: '切换工作区',
      wsSwitched: '工作区已切换', wsIdRequired: '请选择或输入工作区 id',
      // 可用模型区块（账号配置的模型列表 + 全局默认 + 目录状态）。
      allowedModelsTitle: '可用模型', allowedModelsSub: '该账号可请求的模型',
      globalDefault: '全局默认', accountOverride: '账号覆盖',
      clearToGlobal: '清除回全局', clearToGlobalHint: '留空 = 使用全局默认',
      modelCatalog: '模型目录', catalogModels: '个模型已加载', catalogRefreshed: '上次刷新',
      modelsBlocked: '被动学习 blocked', modelsSaved: '可用模型已保存',
      modelsPlaceholder: '逗号分隔的模型名',
      balanceTitle: '余额', balanceSub: '控制台余额、账单与支付方式',
      currentBalance: '当前余额', promotional: '促销余额',
      ledger: '账单明细', paymentMethods: '支付方式', none: '无',
      detailUsageTitle: '用量', detailUsageSub: '控制台账号的请求与成本',
      requests: '请求数', inputTokens: '输入 tokens', outputTokens: '输出 tokens',
      cost: '成本', date: '日期',
      autoRechargeTitle: '自动充值', autoRechargeSub: '余额低于阈值时自动充值',
      enabled: '已启用', disabled: '未启用',
      threshold: '触发阈值', rechargeAmount: '充值金额',
      configure: '配置',
      budgetsTitle: '月度预算', budgetsSub: '组织与用户级月度支出上限',
      orgBudget: '组织预算', userBudget: '用户预算',
      notSet: '未设置', set: '设置',
      membersTitle: '成员', membersSub: '有权访问该工作区的人员',
      memberEmail: '邮箱', role: '角色', joined: '加入时间', noMembers: '暂无成员',
      saTitle: '服务账号', saSub: '控制台签发的 API key——按量计费，扣 zen 充值余额（与旧版 API key 同属 zen 通道，go 订阅见下方区块）',
      saName: '名称', created: '创建时间', noSa: '暂无服务账号',
      createSa: '创建服务账号',
      // 旧版 workspace（opencode.ai 老控制台）的 key 管控。
      legacyKeys: '旧版 API 密钥', legacySub: '旧版控制台（opencode.ai）签发的 API key——按量计费，扣 zen 充值余额（go 订阅是另一套周/月窗口额度，见下方 Go 订阅）',
      legacyCreateTitle: '创建旧版 key',
      createKey: '创建 key', keyName: 'key 名称',
      masked: '掩码', creator: '创建者',
      keyCreated: 'key 已创建', keyDeleted: 'key 已删除',
      delLegacyKeyConfirm: '删除该旧版 key？它将立即失效。',
      legacyCookieMissing: '未配置旧版控制台 cookie',
      refreshKeys: '刷新', noLegacyKeys: '暂无旧版 key',
      legacyKeyTitle: '旧版 API 密钥', legacyKeySub: '可选：粘贴旧版控制台的 Default API Key——Go 用量改走 zen JSON API，无需 cookie',
      legacyKeyPlaceholder: 'sk-...',
      legacyKeySave: '保存', legacyKeyClear: '清除',
      legacyKeyConfigured: '已配置：', legacyKeyNotConfigured: '未配置——可启用免 cookie 的 Go 用量',
      legacyKeySaved: '旧版 API key 已保存', legacyKeyCleared: '旧版 API key 已清除',
      legacyKeyEmpty: '请先粘贴旧版 API key',
      providersTitle: '模型提供方', providersSub: '该账号可用的提供方',
      provider: '提供方', modelCount: '模型数', status: '状态', noProviders: '暂无提供方',
      consoleNotConfigured: '该账号未配置控制台凭据（env 代理仅使用本地 key）',
      cookieInvalid: '控制台登录态失效，请更新下方 cookie',
      cookieMissing: '缺少控制台登录态，导入 cookie 后可读取控制台数据',
      importFromBrowser: '从浏览器导入',
      importCookie: '导入',
      cookiePasteEmpty: '请先粘贴 cookie',
      confirm: '确认',
      arModalTitle: '配置自动充值',
      arEnabled: '启用自动充值',
      thresholdDollars: '触发阈值（$）', rechargeAmountDollars: '充值金额（$）',
      arRequiresAmount: '启用时需填写阈值与金额',
      mlModalTitle: '设置月度预算',
      invalidNumber: '请输入有效数字',
      saModalTitle: '创建服务账号',
      saModalName: '名称',
      cookieModalTitle: '导入 cookie',
      cookieModalBody: '从共享浏览器导入控制台会话 cookie？',
      arSaved: '自动充值已保存',
      mlSaved: '预算已保存',
      saCreated: '服务账号已创建',
      saDeleted: '服务账号已删除',
      cookieImported: 'cookie 已导入',
      cookiePasted: 'cookie 已保存',
      consoleUnavailable: '控制台数据不可用',
      usageUnavailable: '用量数据不可用',
      delSaConfirm: '删除该服务账号？其 API key 将失效。',
      oauthLoggedIn: '已登录为',
      // 用量明细表头（dashboard 同款列 + 请求详情列）。
      hTime: '时间', hStatus: '状态', hRequest: '请求', hMs: '耗时', hTokens: '令牌',
      hClient: '客户端',
      // 请求明细（分页 + 搜索 + 跳页 + 每页条数 + IP 统计）。
      detailRequests: '详细请求', reqPrev: '上一页', reqNext: '下一页', reqPage: '页',
      reqGo: '跳转',
      reqShowAll: '显示全部请求',
      ipStatsTitle: 'IP 统计', ipStatsSub: '按客户端 IP 聚合的流量',
      ipClients: '客户端', ipLast: '最近', ipEmpty: '暂无流量',
      ipFilterHint: '按该 IP 筛选详细请求',
      // 操作审计（管理面写操作的脱敏留痕）。
      auditTitle: '操作审计', auditSub: '管理面板的谁 · 何时 · 做了什么',
      auditOp: '操作', auditResult: '结果', auditAccount: '账号', auditIp: 'IP',
      auditOk: '成功', auditFail: '失败', auditEmpty: '暂无操作记录',
      subIps: 'IP 统计',
      subAudit: '操作审计',
      aboutEndpointDash: '仪表盘',
      // 模型映射（设置页）。
      subModelMap: '模型映射',
      modelMapTitle: '模型映射', modelMapSub: '把 claude-* 模型名映射到 deepseek 模型',
      modelAlias: '别名', modelTarget: '目标模型', modelNote: '备注',
      addMapping: '添加映射',
      modelMapNote: 'Claude Code 发送 claude-* 模型名时，网关先查这里的映射，命中即映射到目标模型；保存后立即生效',
      mmEmpty: '暂无映射', mmRequired: '别名与目标模型不能为空',
      mmSaved: '映射已保存', mmDeleted: '映射已删除',
      mmEditTitle: '编辑映射', mmEdited: '映射已更新',
      mmTargetRequired: '目标模型不能为空',
      mmConfirmDel: '删除该映射？使用此别名的请求将回落到默认模型。',
      // 波 2：旧版计费 + P0 面板 + 观测计数 + 实验功能。
      legacyBilling: '旧版计费', legacyBillingSub: '旧版控制台（opencode.ai）的余额、自动充值与支付历史',
      legacyReload: '自动充值', paymentHistory: '支付历史', noPayments: '暂无支付记录',
      costTrend: '每日成本（7 天）', noTrend: '该范围内无成本数据',
      modelUsageTitle: '模型消费', modelUsageSub: '按模型的成本与 tokens',
      userUsageTitle: '成员消费', userUsageSub: '按成员的请求与 tokens',
      spent: '已用', exceeded: '超限', resetsAt: '重置于',
      memberBudgetTitle: '成员预算',
      pricingTitle: '模型定价', pricingSub: '每百万 token 价格（v2/config）',
      inPerMtok: '输入', outPerMtok: '输出',
      fixCountTitle: '兼容修复', fixRewritten: '改写', fixStripped: '剥除', fixCompressed: '压缩',
      expTitle: '实验功能', expSub: '默认关闭的可选功能',
      expNote: '修改立即生效并持久保存',
      expUnavailable: '实验功能设置不可用',
      expScaleUsage: '用量缩放', expScaleDesc: '缩放客户端可见用量，诱导其提前本地压缩',
      expCompact: '被动压缩', expCompactDesc: '请求体超过阈值时压缩后再发往上游',
      expOn: '开启', expOff: '关闭',
      // 批次 2：分发密钥 tab。
      tabTokens: '密钥', subTokens: '密钥',
      tokensTitle: '分发密钥', tokensSub: '走共享上游池的客户端令牌',
      tokensNote: '密钥明文仅在创建时显示一次，列表只展示掩码',
      tokensEmpty: '暂无分发密钥', tokensUnavailable: '分发密钥数据不可用',
      tokenRefresh: '刷新', tokenCreate: '创建密钥',
      tokenName: '名称', tokenCount: '数量（1-10）', tokenNameRequired: '名称不能为空',
      tokenCustomKey: '自定义密钥（可选）', tokenCustomKeyPlaceholder: '留空 = 自动生成',
      tokenCountInvalid: '数量需在 1-10 之间', tokenCreated: '密钥已创建',
      tokenPlainOnlyOnce: '仅显示这一次 —— 请立即复制，关闭后无法找回',
      tokenCopy: '复制', tokenCopied: '已复制', tokenClose: '关闭',
      tokenCopyTitle: '复制完整密钥',
      tokenPlainMissing: '该密钥未存明文（旧版本创建）——重新创建后即可随时查看',
      tokenActive: '启用', tokenDisabled: '已禁用',
      tokenUsage: '用量', tokenCreatedAt: '创建时间',
      tokenEditTitle: '编辑密钥', tokenNote: '备注', tokenNotePlaceholder: '可选',
      tokenDeleted: '密钥已删除',
      tokenEnabled: '密钥已启用', tokenDisabledMsg: '密钥已禁用',
      tokenDisable: '禁用', tokenEnable: '启用',
      tokenDeleteConfirm: '删除该密钥？使用它的客户端将立即失效。',
      // 批次 2：总览健康度（统计卡组 + 状态列表）。
      ovTotalRequests: '总请求', ovSuccessRate: '成功率',
      ovCostLabel: '密钥费用', ovKeys: '分发密钥',
      ovTrendNote: '近 7 天网关真实聚合', ovTrendFallback: '近期快照（用量库不可用）',
      statusTitle: '状态', statusSub: '网关、上游池、账号与分发密钥一览',
      subStatus: '状态',
      stGateway: '网关', stUpstream: '上游池', stAccounts: '账号',
      stDistKeys: '分发密钥', stFixes: '兼容修复',
      stRunning: '运行中', stLoading: '加载中…', loading: '加载中…',
      // 批次 2：设置页热改。
      adminAuthTitle: '管理员账号', adminAuthSub: '本面板的登录凭据',
      adminUserLabel: '用户名', adminPassLabel: '密码',
      adminPassPlaceholder: '留空 = 保持当前密码',
      adminPassHint: '改密码后所有已登录会话立即失效，需重新登录',
      adminPassEnvWarn: '正在使用默认密码，建议修改',
      adminPassDefaultBadge: '默认密码，建议修改',
      authSaved: '登录凭据已保存', aaNothing: '没有需要保存的内容',
      sourceEnv: '来源: env', sourceDb: '来源: 面板', codeDefault: '代码默认',
      apiKeysTitle: 'API 密钥', apiKeysSub: '管理面接受的密钥',
      apiKeysEmpty: '暂无 API 密钥', apiKeysAdd: '添加', apiKeysAddTitle: '添加 API 密钥',
      apiKeysCopy: '复制明文',
      apiKeysLabel: 'API 密钥', apiKeysPasteHint: '每行一个（面板管理的密钥会保留）',
      apiKeysNoPlain: '无明文，请在服务端配置中管理',
      apiKeysEnvWarn: '无明文（env 来源）的密钥在保存后将被移除',
      apiKeysDeleteConfirm: '移除该 API 密钥？使用它的客户端将立即失效。',
      apiKeysSaved: 'API 密钥已保存', settingsSaved: '设置已保存',
      subAdminAuth: '管理员账号', subAdminKeys: 'API 密钥', subExperimental: '实验功能',
      // 批次 2：账号卡余额来源标注。
      balanceOrg: '余额（组织）',
      // 批次 2：RPM 限流配置 + legacy key 明文复制。
      tokenRpm: '请求频率', tokenRpmHint: '每分钟请求上限 — 0 = 不限',
      tokenRpmSaved: '请求频率已保存', tokenRpmInvalid: '请输入不小于 0 的整数',
      // 配额（QUOTA.md §7）：每密钥 $ / tokens / 请求上限 + 周期 + 过期 + 状态。
      quota: '配额',
      quotaUsd: '美元配额', quotaTokens: 'token 配额', quotaRequests: '请求数配额',
      quotaCycle: '重置周期', quotaCycleNone: '无', quotaCycleDaily: '每日', quotaCycleMonthly: '每月',
      quotaExpires: '过期时间', quotaExpiresHint: '留空 = 永久有效（0）',
      quotaHint: '0 = 不限', quotaNone: '未设配额',
      quotaTpm: 'TPM（每分钟 token 上限）', ipWhitelist: 'IP 白名单',
      ipWhitelistHint: '逗号分隔的 IP 或 CIDR，留空 = 不限制',
      quotaBadgeOk: '正常', quotaBadgeExhausted: '已耗尽', quotaBadgeExpired: '已过期',
      quotaInvalid: '请输入合法配额（不小于 0 的数字）', quotaSaved: '配额已保存',
      legacyKeyNotFound: '明文列表里找不到该 key',
      legacyKeyCopyTitle: '复制明文到剪贴板',
      // Model access tab（MODEL-ACCESS §6）。
      tabModelAccess: '模型授权', subModelAccess: '模型授权',
      maGlobalTitle: '全局白名单',       maGlobalSub: '未配置自定义授权的密钥默认可用模型',
      maAvailTitle: '可选模型（上游全部）',
      maGlobalModels: '允许的模型',
      maGlobalFloor: '代码默认值（重置基准）：',
      maGlobalAdd: '添加', maGlobalAddHint: '添加上游模型名 — 上游不支持的模型会透传，上游错误原样返回',
      maGlobalEmpty: '未选择任何模型',
      maAddInvalid: '非法模型名：',
      maResetGlobal: '重置为代码默认', maGlobalSaved: '全局白名单已保存',
      maSearchPh: '搜索名称 / 掩码',
      maFilter: '按类型筛选',
      maFilterAll: '全部类型', maFilterUpstream: '上游', maFilterToken: '分发令牌', maFilterApiKey: 'API 密钥',
      maRefresh: '刷新',
      maUpstreamTitle: '上游密钥', maUpstreamSub: '上游密钥级模型覆盖',
      maTokenTitle: '分发令牌', maTokenSub: 'token 级模型覆盖',
      maApiKeyTitle: 'API 密钥', maApiKeySub: '管理面 API key 的模型覆盖',
      maEmpty: '暂无密钥', maNoMatch: '没有匹配的密钥',
      maCustomBadge: '自定义', maFollowsGlobal: '跟随全局',
      maEditTitle: '编辑模型授权', maSaved: '模型授权已保存',
      maFollowGlobal: '跟随全局（清除）',
      maNotGrantable: '仅全局白名单内模型可授',
      // 额度耗尽类错误友好文案（friendlyQuota）。quotaResetsPre/Post 配合
      // 语言词序（en: resets in X；zh: X 后重置）。
      quotaGo: 'Go 订阅额度已用尽', quotaFree: '限流中',
      quotaGeneric: '额度已用尽', quotaBalance: '余额不足',
      quotaResetsPre: '', quotaResetsPost: ' 后重置',
      // 账号 key 行增强：用量弹层 + 手动启停 + 引导创建分发密钥。
      keyUsage: '用量', keyUsageHint: '该上游 key 的请求、tokens 与成本',
      keyUsageTitle: 'key 用量', keyUsageNoData: '暂无用量数据',
      keyDisable: '禁用', keyDisableHint: '停止路由该 key（手动禁用）',
      keyReset: '恢复', keyResetHint: '重新启用该 key',
      manualPermanent: '永久停用',
      keyDisabledMsg: 'key 已禁用', keyEnabledMsg: 'key 已恢复',
      gotoKeys: '密钥', keyQuotaGuide: '在密钥页创建带配额的分发密钥，客户端即可使用该 key 池',
      // 设置页分组卡片（服务/安全/运行/关于）。
      settingsGroupService: '服务', settingsGroupSecurity: '安全',
      settingsGroupRuntime: '运行', settingsGroupAbout: '关于',
      // 总览性能仪表盘。
      subPerf: '性能',
      perfTitle: '性能', perfSub: '进程、系统与网关健康度一览',
      perfRss: '内存 RSS', perfCpu: 'CPU', perfLoad: '负载',
      perfConcurrent: '并发', perfLatency: '延迟', perfPool: 'Key 池',
      perfUptime: '已运行', perfHide: '已隐藏', perfShow: '显示中',
      perfPanel: '性能面板', perfPanelSub: '在总览页显示性能仪表盘',
      perfPanelNote: '保存在 localStorage，默认开启',
      // i18n 修复轮：静态 placeholder/title + 请求行 key 前缀 + 配额 tooltip + 实验描述单位。
      reqSearchPh: '搜索 路径/状态/模型/客户端/UA/错误',
      reqPageSize: '每页条数', reqJumpTo: '跳到第几页',
      searchPh: '搜索…', optionalPh: '可选',
      reqKey: '密钥', quotaRemaining: '剩余 $', chars: '字符',
      // 上游 key 禁用原因（disabledReason 枚举 → 友好文案，与 dashboard kindText 同款）。
      drQuota: '额度耗尽', drAuth: '凭据无效',
      drRate: '限流', drTransient: '连续瞬时错误', drManual: '手动停用',
      // 服务端表单校验高频消息（其余 fail() 消息待后续轮次处理）。
      serverErrNameTooLong: '名称最多 100 个字符',
      serverErrKind: '类型不合法（subscription / payg / unknown）',
      serverErrKeysBad: 'key 格式不正确',
      serverErrKeyTooLong: '单个 key 最多 200 字符',
      serverErrKeysTooMany: '最多 20 个 key',
      serverErrBody: '请求体必须是 JSON 对象',
      serverErrWsType: '工作区 id 必须是字符串',
      serverErrCookieType: 'cookie 必须是字符串',
      serverErrWsTooLong: '工作区 id 最多 200 个字符',
      serverErrCookieTooLong: 'cookie 最多 4096 个字符',
      serverErrLegacyWsRequired: '旧版工作区 id 必须是非空字符串或 null',
      serverErrLegacyWsTooLong: '旧版工作区 id 最多 200 个字符',
      serverErrLegacyCookieType: '旧版 cookie 必须是字符串或 null',
      serverErrLegacyCookieTooLong: '旧版 cookie 最多 2048 个字符',
      serverErrLegacyKeyType: '旧版 API key 必须是字符串或 null',
      serverErrLegacyKeyTooLong: '旧版 API key 最多 2048 个字符',
      serverErrAllowedModelsType: '可用模型必须是字符串数组',
      serverErrAllowedModelsTooMany: '可用模型最多 50 个',
      serverErrAllowedModelsEmpty: '可用模型不能包含空项',
      serverErrAllowedModelType: '每个可用模型必须是字符串',
      serverErrAllowedModelTooLong: '每个可用模型最多 100 个字符',
      serverErrAliasType: '别名必须是字符串',
      serverErrAliasFormat: '别名需 1-100 个字符，限字母数字与 ._-',
      serverErrTargetType: '目标必须是字符串',
      serverErrTargetRequired: '目标必须是非空字符串且最多 100 个字符',
      serverErrNoteType: '备注必须是字符串或 null',
      serverErrNoteTooLong: '备注最多 200 个字符',
      serverErrNameType: '名称必须是字符串',
      serverErrNameRange: '名称需 1-100 个字符',
      serverErrStatus: '状态必须是 active 或 disabled',
      serverErrQuotaUsd: '美元配额必须是非负数',
      serverErrQuotaTokens: 'token 配额必须是非负整数',
      serverErrQuotaRequests: '请求数配额必须是非负整数',
      serverErrQuotaTpm: 'TPM 必须是非负整数',
      serverErrExpires: '过期时间必须是非负整数（毫秒时间戳，0 = 永久）',
      serverErrRpm: 'RPM 必须是 0-1000000 的整数',
      serverErrTokenPlainType: '密钥明文必须是字符串或 null',
      serverErrTokenPlainLen: '密钥明文需 1-256 个字符',
      serverErrModelsRequired: 'models 字段必填',
      serverErrSubjectRequired: 'subject 字段必填',
      serverErrNicknameType: '昵称必须是字符串或 null',
      serverErrNicknameTooLong: '昵称最多 30 个字符',
      serverErrNicknameFailed: '更新 key 昵称失败'
    },
    ja: {
      degradedTitle: 'アカウントデータを利用できません',
      overview: '概要', overviewSub: 'アカウント・残高・キー健全性',
      accountsLabel: 'アカウント', healthy: '正常',
      totalBalance: '残高合計', cooldown: 'クールダウン中',
      healthTitle: '健全性', healthSub: 'アカウント状態の一覧',
      createTitle: 'アカウント作成', createSub: 'アップストリームアカウントを登録、キーは暗号化して保存',
      name: '名前', kind: '種別', workspaceId: 'ワークスペース ID',
      keysLabel: 'キー（カンマ区切り）', cookieLabel: 'Cookie（任意）',
      create: '作成',
      accountsTitle: 'アカウント', accountsSub: 'アカウント状態・残高・キー',
      collapse: '折りたたむ', expand: '展開',
      collapseAll: 'すべて折りたたむ', expandAll: 'すべて展開',
      noAccounts: 'アカウントがまだありません', noAccountsSub: 'アカウントを作成してキーと残高を管理',
      balance: '残高', monthlyLimit: '月額上限',
      previewUsage: '7 日間の利用量', previewGo: 'Go 上限',
      legacyHint: 'アカウント詳細を表示',
      dupKeyBadge: '共有キー', dupKeyHint: 'この legacy キーは他のアカウントまたはキープールと共有されています',
      lastProbe: '最終プローブ', lastBilling: '最終取得', never: 'なし',
      retryIn: '再試行まで', nextProbe: '次回プローブまで', inFlight: '処理中',
      inflightTitle: '現在リクエスト中のキー数',
      keysTitle: 'キー', noKeys: 'キーがありません',
      edit: '編集', save: '保存', cancel: 'キャンセル',
      refresh: '残高を更新', addKey: 'キーを追加', remove: '削除',
      delete: '削除', confirmDelete: 'このアカウントを削除しますか？キーはルーティングを停止します。',
      confirmDeleteKey: 'このキーをアカウントから削除しますか？',
      keyNotFound: 'アカウント内にこのキーが見つかりません',
      // 状態の表示用テキスト（バッジ文字 + 説明）。
      stUnknown: '未プローブ', stOk: '正常', stInvalid: 'キー無効',
      stInsufficient: '残高不足', stLimit: '上限到達',
      stCooldown: 'クールダウン中', stRegion: 'リージョン制限', stError: 'エラー',
      stUnknownHint: 'まだプローブされていません — 初回プローブを待っています',
      // 健全性の説明（概要）。
      healthNote: '正常 = 直近のプローブ成功',
      healthNoteWait: ' 個のアカウントが初回プローブ待ち',
      waitingProbe: '初回プローブ待ち',
      // キーのニックネーム。
      rename: 'リネーム', nickname: 'ニックネーム',
      renameHint: '空欄 = ニックネームをクリア', renamed: 'ニックネームを保存しました',
      refreshed: '残高を更新しました', opFail: 'リクエストに失敗しました',
      networkFlaky: 'ネットワーク不安定、自動再試行中…',
      notConnected: '未接続', waitingSync: '接続済み · 残高は次回プローブ時に同期', processing: '処理中…',
      logout: 'ログアウト',
      kindUnknown: '未設定', kindSubscription: 'サブスクリプション', kindPayg: '都度課金',
      goSub: 'Go サブスクリプション', goSubHint: 'OpenCode Go の利用枠（opencode.ai）——サブスクリプションは週/月の利用枠、リセット後に自動回復。利用枠を使い切った場合は「上限到達後は残高を使用」で都度課金へ切替',
      goRolling: 'ローリング（5 時間）', goWeekly: '毎週', goMonthly: '毎月',
      goReset: 'リセット:', goUseBalance: '上限到達後は残高を使用', goChinaModels: '中国モデルを有効化', goNotSubscribed: '未サブスクリプション',
      nameRequired: '名前は必須です', cookieKeep: '空欄 = 変更しない', cookieClearCheckbox: '保存済み Cookie をクリア',
      live: 'リアルタイム',
      tabOverview: '概要', tabAccounts: 'アカウント', tabUsage: '利用量', tabSettings: '設定',
      subOverview: '概要', subHealth: '健全性',
      subAccounts: 'アカウント一覧', subCreate: 'アカウント作成', subOauth: 'OpenCode サインイン',
      subRequests: 'リクエスト統計', subKeys: 'キープール',
      subLanguage: '言語', subUpdate: '更新', subAbout: '情報',
      usageTitle: 'リクエスト統計', usageSub: '/__metrics からのトラフィック集計',
      totalRequests: '総リクエスト', failed: '失敗', streaming: 'ストリーミング',
      avgDuration: '平均時間', tokens: 'トークン',
      keypoolTitle: 'キープール', keypoolSub: 'キーごとの健全性と処理中負荷',
      noRequests: 'リクエストはまだありません',
      langTitle: '言語', langSub: 'インターフェース言語',
      langNote: '言語設定は localStorage に保存されます',
      langEn: 'EN', langZh: '中文', langJa: '日本語',
      about: '情報', aboutSub: 'fuckopencode 管理パネル',
      aboutDesc: 'OpenAI と Anthropic のプロトコル変換ゲートウェイ（DeepSeek 向け）——アップストリームアカウントとプロトコル変換を管理',
      aboutEndpointAdmin: '管理', aboutEndpointMetrics: 'メトリクス',
      secretBackupTitle: 'secret.key をバックアップしてください',
      secretBackupBody: 'data/secret.key は保存済みのすべてのシークレット（アカウントキー / Cookie / OAuth / 配布トークン）を暗号化します。紛失・交換すると、これらはすべて恒久的に復号できなくなります。secret.key を安全な場所（パスワードマネージャー等）にコピーし、data ディレクトリごとバックアップしてください。',
      otaTitle: '更新', otaSub: 'GitHub OTA 自動更新',
      otaCurrent: '現在のバージョン', otaLatest: '最新バージョン',
      otaDisabled: '無効', otaCheck: '更新を確認', otaChecking: '確認中…',
      otaUpdate: '更新', otaCheckedAt: '確認日時', otaCheckFailed: '更新元に接続できません',
      otaPrevPresent: '旧バージョンを保持', otaRolledBack: '失敗した更新はロールバックされました',
      otaRollbackState: 'ロールバック',
      otaHint: 'OTA_ENABLED=1 のときのみ更新できます。更新後はサービスが自動再起動します',
      otaConfirmTitle: '更新の確認',

      otaStageCheck: '確認中…', otaStageDownload: 'ダウンロード中…', otaStageVerify: '検証中…',
      otaStageSwap: '置換中…', otaStageRestart: '再起動中…',
      otaRestarting: '再起動中 — 少し待ってページを更新すると新しいバージョンが表示されます',
      otaChangelog: '変更ログ', otaNoChangelog: '変更ログはありません',
      otaClose: '閉じる',
      oauthStart: 'OpenCode でサインイン', oauthTitle: 'OpenCode サインイン',
      oauthDesc: 'デバイスコードで opencode アカウントを連携',
      oauthUrlLabel: '認証 URL', oauthCodeLabel: 'デバイスコード',
      oauthHint: '開いたページでサインインしてからここに戻ってください',
      oauthCopy: 'コピー', oauthCopied: 'コピーしました',
      copied: 'コピーしました',
      oauthPolling: '承認を待っています', oauthStarting: '起動中',
      oauthExpiresIn: 'コードの有効期限', oauthDone: 'アカウントにサインインしました',
      oauthExpired: 'デバイスコードの期限が切れました、再試行してください', oauthDenied: 'サインインが拒否されました、再試行してください',
      oauthNotFound: 'サインインセッションが見つかりません、再試行してください',
      oauthFail: 'サインインに失敗しました', oauthNetFail: 'ネットワークエラー',
      oauthRetry: '再試行', oauthInvalid: 'OAuth 認証情報が無効です、再度サインインしてください',
      oauthInstead: 'または OpenCode でサインイン',
      detail: '詳細', back: '戻る', subDetail: 'アカウント詳細',
      // 詳細ページのグループタブ（5 グループ：サブスクリプション & キー / ワークスペース & モデル / 財務 / 組織 / 料金）。
      detailTabSub: 'サブスクリプション & キー', detailTabWs: 'ワークスペース & モデル',
      detailTabFinance: '財務', detailTabOrg: '組織', detailTabPricing: '料金',
      // ワークスペースセクション（現在のワークスペース + 切替）。
      workspaceTitle: 'ワークスペース', workspaceSub: '現在のコンソールワークスペースと切替',
      currentWorkspace: '現在のワークスペース', wsLegacy: 'レガシーワークスペース',
      noWorkspace: 'ワークスペースが設定されていません',
      wsManual: 'ワークスペース ID を手動入力…', wsManualHint: '切替は新しいコンソールのワークスペース（org_...）を使用 — 切替後、コンソールデータが再読み込みされます',
      wsSwitch: '切替', wsSwitchTitle: 'ワークスペースを切替',
      wsSwitched: 'ワークスペースを切り替えました', wsIdRequired: 'ワークスペース ID を選択または入力してください',
      // 利用可能モデルセクション（アカウント設定のモデル一覧 + グローバルデフォルト + カタログ状態）。
      allowedModelsTitle: '利用可能モデル', allowedModelsSub: 'このアカウントがリクエストできるモデル',
      globalDefault: 'グローバルデフォルト', accountOverride: 'アカウント個別設定',
      clearToGlobal: 'グローバルに戻す', clearToGlobalHint: '空欄 = グローバルデフォルトを使用',
      modelCatalog: 'モデルカタログ', catalogModels: ' モデルを読み込み', catalogRefreshed: '最終更新',
      modelsBlocked: 'パッシブラーニングでブロック', modelsSaved: '利用可能モデルを保存しました',
      modelsPlaceholder: 'カンマ区切りのモデル名',
      balanceTitle: '残高', balanceSub: 'コンソールの残高・台帳・支払い方法',
      currentBalance: '現在の残高', promotional: 'プロモーション残高',
      ledger: '台帳', paymentMethods: '支払い方法', none: 'なし',
      detailUsageTitle: '利用量', detailUsageSub: 'コンソールアカウントのリクエストとコスト',
      requests: 'リクエスト', inputTokens: '入力トークン', outputTokens: '出力トークン',
      cost: 'コスト', date: '日付',
      autoRechargeTitle: '自動チャージ', autoRechargeSub: '残高がしきい値を下回ったら自動でチャージ',
      enabled: '有効', disabled: '無効',
      threshold: 'しきい値', rechargeAmount: 'チャージ金額',
      configure: '設定',
      budgetsTitle: '月次予算', budgetsSub: '組織・ユーザーごとの月次支出上限',
      orgBudget: '組織予算', userBudget: 'ユーザー予算',
      notSet: '未設定', set: '設定',
      membersTitle: 'メンバー', membersSub: 'このワークスペースにアクセスできるユーザー',
      memberEmail: 'メール', role: 'ロール', joined: '参加日', noMembers: 'メンバーがいません',
      saTitle: 'サービスアカウント', saSub: 'コンソールで発行された API キー — 従量課金で、zen のチャージ残高から請求されます（レガシー API キーと同じ zen チャネル。Go サブスクリプションは下のブロック）',
      saName: '名前', created: '作成日時', noSa: 'サービスアカウントがありません',
      createSa: 'サービスアカウントを作成',
      // 旧ワークスペース（opencode.ai 旧コンソール）のキー管理。
      legacyKeys: 'レガシー API キー', legacySub: '旧コンソール（opencode.ai）で発行された API キー — 従量課金で、zen のチャージ残高から請求されます（Go サブスクリプションは別の週/月の利用枠。下の Go サブスクリプション参照）',
      legacyCreateTitle: 'レガシーキーを作成',
      createKey: 'キーを作成', keyName: 'キー名',
      masked: 'マスク', creator: '作成者',
      keyCreated: 'キーを作成しました', keyDeleted: 'キーを削除しました',
      delLegacyKeyConfirm: 'このレガシーキーを削除しますか？すぐに使えなくなります。',
      legacyCookieMissing: '旧コンソールの Cookie が設定されていません',
      refreshKeys: '更新', noLegacyKeys: 'レガシーキーがありません',
      legacyKeyTitle: 'レガシー API キー', legacyKeySub: '任意：旧コンソールの Default API Key を貼り付け — Go の利用量は Cookie なしで zen JSON API から取得',
      legacyKeyPlaceholder: 'sk-...',
      legacyKeySave: '保存', legacyKeyClear: 'クリア',
      legacyKeyConfigured: '設定済み：', legacyKeyNotConfigured: '未設定 — Cookie なしの Go 利用量が利用可能',
      legacyKeySaved: 'レガシー API キーを保存しました', legacyKeyCleared: 'レガシー API キーをクリアしました',
      legacyKeyEmpty: 'レガシー API キーを貼り付けてください',
      providersTitle: 'プロバイダー', providersSub: 'このアカウントで利用可能なプロバイダー',
      provider: 'プロバイダー', modelCount: 'モデル数', status: '状態', noProviders: 'プロバイダーがいません',
      consoleNotConfigured: 'このアカウントにコンソール認証情報が設定されていません（env プロキシはローカルキーのみ使用）',
      cookieInvalid: 'コンソールセッションが無効です、下の Cookie を更新してください',
      cookieMissing: 'コンソールセッションがありません、Cookie をインポートするとコンソールデータを読めます',
      importFromBrowser: 'ブラウザからインポート',
      importCookie: 'インポート',
      cookiePasteEmpty: 'まず Cookie を貼り付けてください',
      confirm: '確認',
      arModalTitle: '自動チャージを設定',
      arEnabled: '自動チャージを有効化',
      thresholdDollars: 'しきい値（$）', rechargeAmountDollars: 'チャージ金額（$）',
      arRequiresAmount: '有効にするときはしきい値と金額が必要です',
      mlModalTitle: '月次予算を設定',
      invalidNumber: '有効な数値を入力してください',
      saModalTitle: 'サービスアカウントを作成',
      saModalName: '名前',
      cookieModalTitle: 'Cookie をインポート',
      cookieModalBody: '共有ブラウザからコンソールセッションの Cookie をインポートしますか？',
      arSaved: '自動チャージを保存しました',
      mlSaved: '予算を保存しました',
      saCreated: 'サービスアカウントを作成しました',
      saDeleted: 'サービスアカウントを削除しました',
      cookieImported: 'Cookie をインポートしました',
      cookiePasted: 'Cookie を保存しました',
      consoleUnavailable: 'コンソールデータを利用できません',
      usageUnavailable: '利用量データを利用できません',
      delSaConfirm: 'このサービスアカウントを削除しますか？API キーが使えなくなります。',
      oauthLoggedIn: 'ログイン中：',
      // 利用量詳細のヘッダー（dashboard と同じ列 + リクエスト詳細列）。
      hTime: '時間', hStatus: '状態', hRequest: 'リクエスト', hMs: 'ms', hTokens: 'トークン',
      hClient: 'クライアント',
      // リクエスト詳細（ページング + 検索 + ジャンプ + ページサイズ + IP 統計）。
      detailRequests: 'リクエスト詳細', reqPrev: '前へ', reqNext: '次へ', reqPage: 'ページ',
      reqGo: '移動',
      reqShowAll: 'すべてのリクエストを表示',
      ipStatsTitle: 'トップ IP', ipStatsSub: 'クライアント IP で集計したトラフィック',
      ipClients: 'クライアント', ipLast: '最終アクセス', ipEmpty: 'まだトラフィックがありません',
      ipFilterHint: 'この IP でリクエスト詳細を絞り込み',
      // 操作監査（管理面の書き込み操作のマスク済み記録）。
      auditTitle: '管理監査', auditSub: '管理パネルでの誰が · いつ · 何を',
      auditOp: '操作', auditResult: '結果', auditAccount: 'アカウント', auditIp: 'IP',
      auditOk: '成功', auditFail: '失敗', auditEmpty: 'まだ管理操作がありません',
      subIps: 'トップ IP',
      subAudit: '管理監査',
      aboutEndpointDash: 'ダッシュボード',
      // モデルマッピング（設定ページ）。
      subModelMap: 'モデルマッピング',
      modelMapTitle: 'モデルマッピング', modelMapSub: 'claude-* モデル名を deepseek モデルにマップ',
      modelAlias: 'エイリアス', modelTarget: 'ターゲット', modelNote: 'メモ',
      addMapping: 'マッピングを追加',
      modelMapNote: 'Claude Code は claude-* モデル名を送信します。ゲートウェイはまずこのテーブルを参照してターゲットにマップ — 即時反映',
      mmEmpty: 'まだマッピングがありません', mmRequired: 'エイリアスとターゲットは必須です',
      mmSaved: 'マッピングを保存しました', mmDeleted: 'マッピングを削除しました',
      mmEditTitle: 'マッピングを編集', mmEdited: 'マッピングを更新しました',
      mmTargetRequired: 'ターゲットは必須です',
      mmConfirmDel: 'このマッピングを削除しますか？このエイリアスを使うリクエストはデフォルトモデルにフォールバックします。',
      // 波 2：レガシー請求 + P0 パネル + 観測カウント + 実験機能。
      legacyBilling: 'レガシー請求', legacyBillingSub: '旧コンソール（opencode.ai）の残高・自動チャージ・支払い履歴',
      legacyReload: '自動チャージ', paymentHistory: '支払い履歴', noPayments: 'まだ支払い履歴がありません',
      costTrend: '日次コスト（7 日間）', noTrend: 'この範囲にコストデータがありません',
      modelUsageTitle: 'モデル利用', modelUsageSub: 'モデルごとのコストとトークン',
      userUsageTitle: 'メンバー利用', userUsageSub: 'メンバーごとのリクエストとトークン',
      spent: '使用済み', exceeded: '超過', resetsAt: 'リセット:',
      memberBudgetTitle: 'メンバー予算',
      pricingTitle: 'モデル料金', pricingSub: '100万トークンあたりの価格（v2/config）',
      inPerMtok: '入力', outPerMtok: '出力',
      fixCountTitle: '互換性修正', fixRewritten: '書き換え', fixStripped: '削除', fixCompressed: '圧縮',
      expTitle: '実験的機能', expSub: 'オプトイン機能、デフォルトではオフ',
      expNote: '変更は即時反映され、再起動後も保持されます',
      expUnavailable: '実験的機能の設定を利用できません',
      expScaleUsage: '利用量スケーリング', expScaleDesc: 'クライアントに見える利用量をスケーリングして早期のローカル圧縮を促す',
      expCompact: 'パッシブ圧縮', expCompactDesc: 'しきい値を超えたリクエストボディを送信前に圧縮',
      expOn: 'オン', expOff: 'オフ',
      // バッチ 2：配布キータブ。
      tabTokens: 'キー', subTokens: 'キー',
      tokensTitle: '配布キー', tokensSub: '共有アップストリームプールを経由するクライアントトークン',
      tokensNote: 'キー平文は作成時に一度だけ表示、一覧はマスクのみ',
      tokensEmpty: 'まだトークンがありません', tokensUnavailable: 'トークンデータを利用できません',
      tokenRefresh: '更新', tokenCreate: 'トークンを作成',
      tokenName: '名前', tokenCount: '数量（1-10）', tokenNameRequired: '名前は必須です',
      tokenCustomKey: 'カスタムキー（任意）', tokenCustomKeyPlaceholder: '空欄 = 自動生成',
      tokenCountInvalid: '数量は 1〜10 にしてください', tokenCreated: 'トークンを作成しました',
      tokenPlainOnlyOnce: '一度だけ表示 — 今すぐコピーしてください。後から復元できません',
      tokenCopy: 'コピー', tokenCopied: 'コピーしました', tokenClose: '閉じる',
      tokenCopyTitle: '完全なトークンをコピー',
      tokenPlainMissing: '平文は保存されていません（平文保存前の作成）— 再作成すると表示できるようになります',
      tokenActive: '有効', tokenDisabled: '無効',
      tokenUsage: '利用量', tokenCreatedAt: '作成日時',
      tokenEditTitle: 'トークンを編集', tokenNote: 'メモ', tokenNotePlaceholder: '任意',
      tokenDeleted: 'トークンを削除しました',
      tokenEnabled: 'トークンを有効化しました', tokenDisabledMsg: 'トークンを無効化しました',
      tokenDisable: '無効化', tokenEnable: '有効化',
      tokenDeleteConfirm: 'このトークンを削除しますか？使用中のクライアントはすぐに使えなくなります。',
      // バッチ 2：概要の健全性（統計カード + 状態リスト）。
      ovTotalRequests: 'リクエスト', ovSuccessRate: '成功率',
      ovCostLabel: 'キーコスト', ovKeys: '配布キー',
      ovTrendNote: 'ゲートウェイ利用履歴の 7 日間集計', ovTrendFallback: 'スナップショット（利用量 DB が利用不可）',
      statusTitle: '状態', statusSub: 'ゲートウェイ・アップストリームプール・アカウント・配布キーの概要',
      subStatus: '状態',
      stGateway: 'ゲートウェイ', stUpstream: 'アップストリームプール', stAccounts: 'アカウント',
      stDistKeys: '配布キー', stFixes: '互換性修正',
      stRunning: '実行中', stLoading: '読み込み中…', loading: '読み込み中…',
      // バッチ 2：設定ページのホットリロード。
      adminAuthTitle: '管理者アカウント', adminAuthSub: 'このパネルのログイン認証情報',
      adminUserLabel: 'ユーザー名', adminPassLabel: 'パスワード',
      adminPassPlaceholder: '空欄 = 現在のパスワードを保持',
      adminPassHint: 'パスワード変更後、ログイン済みのセッションはすべて即時無効になり、再ログインが必要です',
      adminPassEnvWarn: 'デフォルトパスワードを使用中です — 変更してください',
      adminPassDefaultBadge: 'デフォルトパスワード — 変更してください',
      authSaved: '管理者認証情報を保存しました', aaNothing: '保存するものはありません',
      sourceEnv: 'ソース: env', sourceDb: 'ソース: パネル', codeDefault: 'コードデフォルト',
      apiKeysTitle: 'API キー', apiKeysSub: '管理アクセスに受け付けるキー',
      apiKeysEmpty: 'API キーがありません', apiKeysAdd: '追加', apiKeysAddTitle: 'API キーを追加',
      apiKeysCopy: '平文をコピー',
      apiKeysLabel: 'API キー', apiKeysPasteHint: '1 行に 1 つ（パネル管理のキーは保持されます）',
      apiKeysNoPlain: '平文を取得できません — サーバー設定で管理してください',
      apiKeysEnvWarn: '平文を復元できない env 由来のキーは保存時に削除されます',
      apiKeysDeleteConfirm: 'この API キーを削除しますか？使用中のクライアントはすぐに使えなくなります。',
      apiKeysSaved: 'API キーを保存しました', settingsSaved: '設定を保存しました',
      subAdminAuth: '管理者アカウント', subAdminKeys: 'API キー', subExperimental: '実験的機能',
      // バッチ 2：アカウントカードの残高ソース表示。
      balanceOrg: '残高（組織）',
      // バッチ 2：RPM レート制限設定 + レガシーキー平文コピー。
      tokenRpm: 'RPM 制限', tokenRpmHint: '1 分あたりのリクエスト数 — 0 = 無制限',
      tokenRpmSaved: 'RPM 制限を保存しました', tokenRpmInvalid: '0 以上の数値を入力してください',
      // クォータ（QUOTA.md §7）：キーごとの $ / トークン / リクエスト上限 + 周期 + 期限 + 状態。
      quota: 'クォータ',
      quotaUsd: '$ クォータ', quotaTokens: 'トークンクォータ', quotaRequests: 'リクエストクォータ',
      quotaCycle: 'リセット周期', quotaCycleNone: 'なし', quotaCycleDaily: '毎日', quotaCycleMonthly: '毎月',
      quotaExpires: '有効期限', quotaExpiresHint: '空欄 = 期限なし（0）',
      quotaHint: '0 = 無制限', quotaNone: 'クォータなし',
      quotaTpm: 'TPM（毎分トークン上限）', ipWhitelist: 'IP ホワイトリスト',
      ipWhitelistHint: 'カンマ区切りの IP または CIDR、空欄 = 制限なし',
      quotaBadgeOk: '正常', quotaBadgeExhausted: '枯渇', quotaBadgeExpired: '期限切れ',
      quotaInvalid: '有効なクォータを入力してください（0 以上）', quotaSaved: 'クォータを保存しました',
      legacyKeyNotFound: '平文リストにキーが見つかりません',
      legacyKeyCopyTitle: '平文をクリップボードにコピー',
      // Model access タブ（MODEL-ACCESS §6）。
      tabModelAccess: 'モデルアクセス', subModelAccess: 'モデルアクセス',
      maGlobalTitle: 'グローバル許可リスト',       maGlobalSub: 'カスタム設定のないキーのデフォルトモデル',
      maAvailTitle: '利用可能モデル（全アップストリーム）',
      maGlobalModels: '許可モデル',
      maGlobalFloor: 'コードデフォルト（リセット基準）：',
      maGlobalAdd: '追加', maGlobalAddHint: 'アップストリームのモデル名を追加 — 非対応モデルはそのまま透過され、アップストリームのエラーがそのまま返されます',
      maGlobalEmpty: 'モデルが選択されていません',
      maAddInvalid: '無効なモデル名: ',
      maResetGlobal: 'コードデフォルトにリセット', maGlobalSaved: 'グローバル許可リストを保存しました',
      maSearchPh: '名前 / マスクで検索',
      maFilter: 'タイプで絞り込み',
      maFilterAll: 'すべてのタイプ', maFilterUpstream: 'アップストリーム', maFilterToken: 'トークン', maFilterApiKey: 'API キー',
      maRefresh: '更新',
      maUpstreamTitle: 'アップストリームキー', maUpstreamSub: 'アップストリームキーごとのモデル上書き',
      maTokenTitle: '配布トークン', maTokenSub: 'トークンごとのモデル上書き',
      maApiKeyTitle: 'API キー', maApiKeySub: 'API キーごとのモデル上書き',
      maEmpty: 'キーが設定されていません', maNoMatch: 'フィルタに一致するキーがありません',
      maCustomBadge: 'カスタム', maFollowsGlobal: 'グローバルに追従',
      maEditTitle: 'モデルアクセスを編集', maSaved: 'モデルアクセスを保存しました',
      maFollowGlobal: 'グローバルに追従（クリア）',
      maNotGrantable: 'グローバル許可リスト内のモデルのみ許可できます',
      // 利用枠枯渇エラーの表示用テキスト（friendlyQuota）：GoUsageLimitError /
      // FreeUsageLimitError / 月額 / 残高不足を識別 → 短いテキスト + リセット時間。
      quotaGo: 'Go サブスクリプションの上限に到達', quotaFree: 'レート制限中',
      quotaGeneric: '利用上限に到達', quotaBalance: '残高不足',
      quotaResetsPre: '', quotaResetsPost: ' 後にリセット',
      // アカウントキー行の強化：利用量ポップアップ + 手動有効/無効 + 配布キー作成ガイド。
      keyUsage: '利用量', keyUsageHint: 'このアップストリームキーのリクエスト・トークン・コスト',
      keyUsageTitle: 'キー利用量', keyUsageNoData: 'まだ利用量データがありません',
      keyDisable: '無効化', keyDisableHint: 'このキーのルーティングを停止（手動）',
      keyReset: '復元', keyResetHint: 'このキーを再度有効化',
      manualPermanent: '恒久的に無効化',
      keyDisabledMsg: 'キーを無効化しました', keyEnabledMsg: 'キーを復元しました',
      gotoKeys: 'キー', keyQuotaGuide: 'キータブでクォータ付きの配布トークンを作成すると、クライアントがこのプールを使えるようになります',
      // 設定ページのグループカード（サービス / セキュリティ / ランタイム / 情報）。
      settingsGroupService: 'サービス', settingsGroupSecurity: 'セキュリティ',
      settingsGroupRuntime: 'ランタイム', settingsGroupAbout: '情報',
      // 概要のパフォーマンスダッシュボード。
      subPerf: 'パフォーマンス',
      perfTitle: 'パフォーマンス', perfSub: 'プロセス・システム・ゲートウェイの健全性',
      perfRss: 'メモリ（RSS）', perfCpu: 'CPU', perfLoad: 'ロード',
      perfConcurrent: '同時実行', perfLatency: 'レイテンシ', perfPool: 'キープール',
      perfUptime: '稼働', perfHide: '非表示', perfShow: '表示',
      perfPanel: 'パフォーマンスパネル', perfPanelSub: '概要ページにパフォーマンスダッシュボードを表示',
      perfPanelNote: 'localStorage に保存、デフォルトでオン',
      // i18n 修正ラウンド：静的 placeholder/title + リクエスト行のキー接頭辞 + クォータ tooltip + 実験説明の単位。
      reqSearchPh: 'パス/状態/モデル/クライアント/UA/エラーで検索',
      reqPageSize: 'ページサイズ', reqJumpTo: 'ページへ移動',
      searchPh: '検索…', optionalPh: '任意',
      reqKey: 'キー', quotaRemaining: '残り $', chars: '文字',
      // アップストリームキーの無効化理由（disabledReason 列挙 → 表示テキスト）。
      drQuota: 'クォータ枯渇', drAuth: '認証情報が無効',
      drRate: 'レート制限', drTransient: '一時エラーの連続', drManual: '手動で無効化',
      // サーバー側フォーム検証の頻出メッセージ（その他の fail() メッセージは今後のラウンドで対応）。
      serverErrNameTooLong: '名前は 100 文字以内にしてください',
      serverErrKind: '種別が無効です（subscription / payg / unknown）',
      serverErrKeysBad: 'キーの形式が無効です',
      serverErrKeyTooLong: '各キーは 200 文字以内にしてください',
      serverErrKeysTooMany: 'キーは最大 20 個です',
      serverErrBody: 'リクエストボディは JSON オブジェクトである必要があります',
      serverErrWsType: 'ワークスペース ID は文字列である必要があります',
      serverErrCookieType: 'Cookie は文字列である必要があります',
      serverErrWsTooLong: 'ワークスペース ID は 200 文字以内にしてください',
      serverErrCookieTooLong: 'Cookie は 4096 文字以内にしてください',
      serverErrLegacyWsRequired: 'レガシーワークスペース ID は空でない文字列または null である必要があります',
      serverErrLegacyWsTooLong: 'レガシーワークスペース ID は 200 文字以内にしてください',
      serverErrLegacyCookieType: 'レガシー Cookie は文字列または null である必要があります',
      serverErrLegacyCookieTooLong: 'レガシー Cookie は 2048 文字以内にしてください',
      serverErrLegacyKeyType: 'レガシー API キーは文字列または null である必要があります',
      serverErrLegacyKeyTooLong: 'レガシー API キーは 2048 文字以内にしてください',
      serverErrAllowedModelsType: '許可モデルは文字列の配列である必要があります',
      serverErrAllowedModelsTooMany: '許可モデルは最大 50 個です',
      serverErrAllowedModelsEmpty: '許可モデルに空の項目を含めることはできません',
      serverErrAllowedModelType: '各許可モデルは文字列である必要があります',
      serverErrAllowedModelTooLong: '各許可モデルは 100 文字以内にしてください',
      serverErrAliasType: 'エイリアスは文字列である必要があります',
      serverErrAliasFormat: 'エイリアスは 1〜100 文字で、英数字と ._- のみ使用できます',
      serverErrTargetType: 'ターゲットは文字列である必要があります',
      serverErrTargetRequired: 'ターゲットは空でない文字列で 100 文字以内にしてください',
      serverErrNoteType: 'メモは文字列または null である必要があります',
      serverErrNoteTooLong: 'メモは 200 文字以内にしてください',
      serverErrNameType: '名前は文字列である必要があります',
      serverErrNameRange: '名前は 1〜100 文字にしてください',
      serverErrStatus: '状態は active または disabled である必要があります',
      serverErrQuotaUsd: '$ クォータは非負の数である必要があります',
      serverErrQuotaTokens: 'トークンクォータは非負の整数である必要があります',
      serverErrQuotaRequests: 'リクエストクォータは非負の整数である必要があります',
      serverErrQuotaTpm: 'TPM は非負の整数である必要があります',
      serverErrExpires: '有効期限は非負の整数（エポックミリ秒、0 = 期限なし）である必要があります',
      serverErrRpm: 'RPM は 0〜1000000 の整数である必要があります',
      serverErrTokenPlainType: 'トークン平文は文字列または null である必要があります',
      serverErrTokenPlainLen: 'トークン平文は 1〜256 文字にしてください',
      serverErrModelsRequired: 'models フィールドは必須です',
      serverErrSubjectRequired: 'subject フィールドは必須です',
      serverErrNicknameType: 'ニックネームは文字列または null である必要があります',
      serverErrNicknameTooLong: 'ニックネームは 30 文字以内にしてください',
      serverErrNicknameFailed: 'キーのニックネームを更新できませんでした'
    }
  };
  var lang = (function () {
    try { var v = localStorage.getItem('fc-lang'); if (v === 'zh' || v === 'en' || v === 'ja') return v; } catch (e) {}
    var nl = navigator.language || ''; if (/^zh/i.test(nl)) return 'zh'; if (/^ja/i.test(nl)) return 'ja'; return 'en';
  })();
  var T = function (k) { return (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k; };

  /** 总览性能区块开关（localStorage fc-perf，默认开；设置页可关）。 */
  var perfOn = (function () {
    try { var v = localStorage.getItem('fc-perf'); if (v === '0' || v === '1') return v === '1'; } catch (e) {}
    return true;
  })();

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /** 冷却倒计时用的 h/m/s。 */
  var hms = function (ms) {
    /* Number() 兜底：字段缺失或后端给了非数字时 Math.max(0, undefined) 是 NaN，
       会一路渲染成「NaNs」。宁可显示 0s 也不要把 NaN 摆到面板上。 */
    var n = Number(ms);
    var s = Math.floor(Math.max(0, isFinite(n) ? n : 0) / 1000);
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    var p = function (v) { return (v < 10 ? '0' : '') + v; };
    /* 超过一天用「天」表示：额度耗尽的冷却能到几十小时，
       显示成 720h00m00s 没人能一眼读出那是 30 天。 */
    if (d) return d + 'd' + p(h) + 'h' + p(m) + 'm';
    if (h) return h + 'h' + p(m) + 'm' + p(s % 60) + 's';
    if (m) return m + 'm' + p(s % 60) + 's';
    return (s % 60) + 's';
  };
  var hhmmss = function (ts) {
    if (!ts) return '—';
    var d = new Date(ts), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };
  var nowFmt = function (ts) { return ts ? hhmmss(ts) : '<span class="w">' + T('never') + '</span>'; };
  /** 最近探针：从未探过显示「等待首次探测」而不是生硬的「从未」。 */
  var probeFmt = function (ts) { return ts ? hhmmss(ts) : '<span class="w">' + T('waitingProbe') + '</span>'; };
  /** 状态枚举 → 友好文案（徽标颜色仍走 st-<status> 语义色，字换成 i18n）。 */
  var STATUS_KEYS = {
    unknown: 'stUnknown', ok: 'stOk', invalid: 'stInvalid', insufficient: 'stInsufficient',
    limit: 'stLimit', cooldown: 'stCooldown', region: 'stRegion', error: 'stError'
  };
  /** 账号类型友好文案（unknown → 未标注；subscription/payg 用中文）。 */
  var KIND_KEYS = { unknown: 'kindUnknown', subscription: 'kindSubscription', payg: 'kindPayg' };
  var statusText = function (st) { return T(STATUS_KEYS[st] || 'stUnknown'); };
  /** 账号类型友好文案（unknown → 未标注；subscription/payg 已有中文）。 */
  var kindText = function (k) { return T(KIND_KEYS[k] || 'kindUnknown'); };
  /** 上游 key 禁用原因（keypool UpstreamFailureKind）→ 词条（与 dashboard kindText 同款）。 */
  var DISABLED_KEYS = {
    'quota-exhausted': 'drQuota', auth: 'drAuth', 'rate-limit': 'drRate',
    transient: 'drTransient', manual: 'drManual'
  };
  var disabledText = function (r) { return r ? T(DISABLED_KEYS[r] || r) : ''; };
  /** 计数格式化（k/M/B）。 */
  var fmt = function (n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  };
  /** 耗时格式化（毫秒 → ms/s/m）。 */
  var msFmt = function (n) {
    n = Number(n) || 0;
    if (n < 1000) return Math.round(n) + 'ms';
    var total = Math.round(n / 1000);
    if (total < 60) return (n / 1000).toFixed(n < 10000 ? 2 : 1) + 's';
    var m = Math.floor(total / 60);
    return m + 'm' + (total - m * 60) + 's';
  };

  /** 数字输入自绘 spinner（kirostudio 风格）：隐藏原生步进，右侧挂上下两个
   *  小箭头。原生伪元素画不出可点击按钮（input 内伪元素不可交互），所以 JS
   *  包一层 .num-wrap + .num-stepper，点击走 document 委托 stepUp/stepDown。
   *  幂等：data-num-mounted 标记 + 渲染入口末尾重调（renderTokens/openConfirm/
   *  render/初始化），tick 重建 DOM 后的新 input 会重新包裹，已包裹的不重复处理。 */
  function mountNumSpinners(container) {
    var root = container || document;
    var inputs = root.querySelectorAll('input[type="number"]');
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      if (inp.dataset.numMounted === '1') continue;
      inp.dataset.numMounted = '1';
      var wrap = document.createElement('span');
      wrap.className = 'num-wrap';
      inp.parentNode.insertBefore(wrap, inp);
      wrap.appendChild(inp);
      var st = document.createElement('span');
      st.className = 'num-stepper';
      st.setAttribute('aria-hidden', 'true');
      st.innerHTML = '<button type="button" class="num-spin num-spin-up" tabindex="-1"></button>' +
        '<span class="num-spin-div"></span>' +
        '<button type="button" class="num-spin num-spin-down" tabindex="-1"></button>';
      wrap.appendChild(st);
    }
  }

  // ── 账号卡片收起/展开：localStorage fc-collapsed（{accountId: bool}）记忆 ──
  var COLLAPSE_KEY = 'fc-collapsed';
  var collapseCache = null;
  function loadCollapsed() {
    if (collapseCache !== null) return collapseCache;
    var map = {};
    try {
      var v = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
      if (v && typeof v === 'object') map = v;
    } catch (e) {}
    collapseCache = map;
    return map;
  }
  function persistCollapse(map) {
    collapseCache = map;
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map)); } catch (e) {}
  }
  /** 单卡翻转：更新 DOM 属性 + localStorage（渲染重建时 accountCard 从缓存读取）。 */
  function toggleCard(id, cardEl) {
    var map = loadCollapsed();
    var next = !(map[id] === true);
    map[id] = next;
    persistCollapse(map);
    if (cardEl) {
      cardEl.setAttribute('data-collapsed', next ? '1' : '0');
      var tb = cardEl.querySelector('.card-toggle');
      if (tb) tb.title = next ? T('expand') : T('collapse');
    }
  }
  /** 全部收起/展开：同步设置所有卡片 + localStorage。 */
  function setAllCollapsed(collapsed) {
    var map = {};
    var cards = document.querySelectorAll('#accounts .card');
    for (var i = 0; i < cards.length; i++) {
      var cid = Number(cards[i].getAttribute('data-id'));
      if (!isFinite(cid)) continue;
      map[cid] = collapsed;
      cards[i].setAttribute('data-collapsed', collapsed ? '1' : '0');
    }
    persistCollapse(map);
  }

  var langLabel = function () { return lang === 'zh' ? T('langZh') : lang === 'ja' ? T('langJa') : T('langEn'); };

  function applyLang() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang === 'ja' ? 'ja' : 'en';
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = T(nodes[i].getAttribute('data-i18n'));
    }
    $('btn-lang').textContent = langLabel();
    var b2 = $('btn-settings-lang');
    if (b2) b2.textContent = langLabel();
    // 静态 placeholder / title（不在 textContent 上，语言切换同步更新）。
    var phMap = { 'req-q': 'reqSearchPh', 'ma-avail-search': 'searchPh', 'mm-note': 'optionalPh' };
    for (var phk in phMap) { var pEl = $(phk); if (pEl) pEl.placeholder = T(phMap[phk]); }
    var ttMap = { 'req-size': 'reqPageSize', 'req-page': 'reqJumpTo' };
    for (var ttk in ttMap) { var tEl = $(ttk); if (tEl) tEl.title = T(ttMap[ttk]); }
    // 静态输入框 aria-label（a11y：label 元素 for/id 配对优先，无可见 label 的
    // 用 aria-label 兜底；语言切换同步更新，避免屏幕阅读器读到英文）。
    var alMap = { 'req-q': 'reqSearchPh', 'req-size': 'reqPageSize', 'req-page': 'reqJumpTo',
      'ma-search': 'maSearchPh', 'ma-filter': 'maFilter', 'ma-global-add': 'maGlobalAdd',
      'ma-avail-search': 'maAvailTitle', 'detail-cookie-paste': 'cookieLabel' };
    for (var alk in alMap) { var aEl = $(alk); if (aEl) aEl.setAttribute('aria-label', T(alMap[alk])); }
    // 创建表单类型下拉 toggle：跟随当前选中值（选项文案已是词条，切换语言后重取）。
    var ctk = $('c-kind-toggle');
    if (ctk) ctk.textContent = T(KIND_KEYS[cKind] || 'kindUnknown');
    var items = document.querySelectorAll('.dd-item[data-lang]');
    for (var j = 0; j < items.length; j++) {
      if (items[j].getAttribute('data-lang') === lang) items[j].setAttribute('data-selected', 'true');
      else items[j].removeAttribute('data-selected');
    }
  }

  var flashTimer = 0;
  function flash(msg, bad) {
    var el = $('flash');
    el.textContent = msg;
    el.className = bad ? 'bad' : '';
    el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.hidden = true; }, 4000);
  }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        return { ok: r.ok, status: r.status, json: j };
      });
    }).catch(function () { return { ok: false, status: 0, json: null }; });
  }
  /** 服务端表单校验英文消息 → 词条（名称必填/长度/类型/key 格式/别名/白名单/legacy
   *  等）。未收录的原样透传。动态数字类（如 name must be 1-100 characters）走
   *  SERVER_MSG_RE 正则匹配，避免逐字硬编码上限值。 */
  var SERVER_MSG_KEYS = {
    'name is required and must be a non-empty string': 'nameRequired',
    'name must be a non-empty string': 'nameRequired',
    'name must be a string': 'serverErrNameType',
    'name must be at most 100 characters': 'serverErrNameTooLong',
    'kind must be one of: subscription, payg, unknown': 'serverErrKind',
    'keys must be an array of strings': 'serverErrKeysBad',
    'each key must be a string': 'serverErrKeysBad',
    'keys must not contain empty entries': 'serverErrKeysBad',
    'each key must be at most 200 characters': 'serverErrKeyTooLong',
    'keys must have at most 20 entries': 'serverErrKeysTooMany',
    'request body must be a JSON object': 'serverErrBody',
    'workspaceId must be a string': 'serverErrWsType',
    'workspaceId must be at most 200 characters': 'serverErrWsTooLong',
    'cookie must be a string': 'serverErrCookieType',
    'cookie must be at most 4096 characters': 'serverErrCookieTooLong',
    'legacyWorkspaceId must be a non-empty string or null': 'serverErrLegacyWsRequired',
    'legacyWorkspaceId must be at most 200 characters': 'serverErrLegacyWsTooLong',
    'legacyCookie must be a string or null': 'serverErrLegacyCookieType',
    'legacyCookie must be at most 2048 characters': 'serverErrLegacyCookieTooLong',
    'legacyKey must be a string or null': 'serverErrLegacyKeyType',
    'legacyKey must be at most 2048 characters': 'serverErrLegacyKeyTooLong',
    'allowedModels must be an array of strings': 'serverErrAllowedModelsType',
    'allowedModels must have at most 50 entries': 'serverErrAllowedModelsTooMany',
    'allowedModels must not contain empty entries': 'serverErrAllowedModelsEmpty',
    'each allowed model must be a string': 'serverErrAllowedModelType',
    'each allowed model must be at most 100 characters': 'serverErrAllowedModelTooLong',
    'alias must be a string': 'serverErrAliasType',
    'alias must be 1-100 characters of letters, digits, dot, dash or underscore': 'serverErrAliasFormat',
    'target must be a string': 'serverErrTargetType',
    'target must be a non-empty string of at most 100 characters': 'serverErrTargetRequired',
    'note must be a string or null': 'serverErrNoteType',
    'status must be active or disabled': 'serverErrStatus',
    'quotaUsd must be a non-negative number': 'serverErrQuotaUsd',
    'quotaTokens must be a non-negative integer': 'serverErrQuotaTokens',
    'quotaRequests must be a non-negative integer': 'serverErrQuotaRequests',
    'quotaTpm must be a non-negative integer': 'serverErrQuotaTpm',
    'expiresAt must be a non-negative integer (epoch ms, 0 = never)': 'serverErrExpires',
    'tokenPlain must be a string or null': 'serverErrTokenPlainType',
    'tokenPlain must be 1-256 characters': 'serverErrTokenPlainLen',
    'models is required': 'serverErrModelsRequired',
    'subject is required': 'serverErrSubjectRequired',
    'nickname must be a string or null': 'serverErrNicknameType',
    'nickname must be at most 30 characters': 'serverErrNicknameTooLong',
    'failed to update key nickname': 'serverErrNicknameFailed',
    'nothing to update': 'aaNothing'
  };
  /** 动态数字上限的服务端消息（精确字符串匹配不到）：正则 → 词条。 */
  var SERVER_MSG_RE = [
    [/^name must be 1-\d+ characters$/, 'serverErrNameRange'],
    [/^note must be at most \d+ characters$/, 'serverErrNoteTooLong'],
    [/^rpmLimit must be an integer 0-\d+$/, 'serverErrRpm']
  ];
  function translateServerMsg(m) {
    if (!m) return m;
    var s = String(m);
    var k = SERVER_MSG_KEYS[s];
    if (k) return T(k);
    for (var i = 0; i < SERVER_MSG_RE.length; i++) {
      if (SERVER_MSG_RE[i][0].test(s)) return T(SERVER_MSG_RE[i][1]);
    }
    return m;
  }
  function errMsg(r) {
    var raw = r.json && r.json.error && r.json.error.message;
    if (raw) return translateServerMsg(raw);
    return (r.status === 0 ? T('networkFlaky') : (T('opFail') + ' (' + r.status + ')'));
  }

  /** 额度耗尽类错误的友好文案（需求 1）：识别上游 quota 错误（GoUsageLimitError /
   *  FreeUsageLimitError / 月额度 / 余额不足）→ 返回友好短文案（含重置时间）；
   *  识别不出返回 null（调用方保留原文）。原始文案始终留在 title/tooltip
   *  可展开，不做销毁。上游形态见 errors.ts：形如 GoUsageLimitError: Weekly usage
   *  limit reached. Resets in 19hr 22min. 或 FreeUsageLimitError: Rate limit
   *  exceeded. Please try again later. */
  function friendlyQuota(msg) {
    if (!msg) return null;
    var m = String(msg);
    var go = /GoUsageLimitError/.test(m);
    var free = /FreeUsageLimitError|RateLimitError|Rate limit/i.test(m);
    var insuff = /CreditsError|billing_error|insufficient[_ ]?balance|余额不足/i.test(m);
    var generic = /MonthlyLimitError|UserLimitError|quota|usage limit|limit reached|额度|用尽/i.test(m);
    if (!go && !free && !insuff && !generic) return null;
    var reset = '';
    var rm = /[Rr]esets?\s+in\s+([^.]+)/.exec(m);
    if (rm) reset = String(rm[1]).trim();
    // zh 模式把上游英文时间单位中文化（3 days → 3 天；19hr 22min → 19 小时 22 分钟），
    // 避免「Go 订阅额度已用尽 · 3 days 后重置」混排；en 或识别不出保持原样。
    if (reset && lang === 'zh') {
      reset = reset.replace(/(\d+(?:\.\d+)?)\s*([A-Za-z]+)/g, function (all, n, u) {
        var units = {
          day: '天', days: '天', hr: '小时', hrs: '小时', h: '小时', hour: '小时', hours: '小时',
          min: '分钟', mins: '分钟', m: '分钟', minute: '分钟', minutes: '分钟',
          sec: '秒', secs: '秒', s: '秒', second: '秒', seconds: '秒',
          week: '周', weeks: '周', month: '个月', months: '个月', year: '年', years: '年'
        };
        return n + ' ' + (units[String(u).toLowerCase()] || u);
      });
    }
    var text = T(go ? 'quotaGo' : free ? 'quotaFree' : insuff ? 'quotaBalance' : 'quotaGeneric');
    if (reset) text += ' · ' + T('quotaResetsPre') + reset + T('quotaResetsPost');
    return text;
  }

  /** 单条 key 行。指纹来自服务端（末 4 位），原文永不出现在面板。
   *  有昵称：昵称优先 + 指纹小字；无昵称：只显示指纹。hover 出「用量」「改名」
   *  「禁用/恢复」「移除」。禁用/恢复（data-action=disable-key|reset-key）走
   *  POST /keys/:fp/disable|reset（并行服务端 agent 实现）；用量弹层读
   *  GET /keys/:fp/usage 聚合。 */
  function keyRow(k, accountId) {
    var meta = k.healthy
      ? (k.inFlight > 0 ? T('inFlight') + ' ' + k.inFlight : '')
      : esc(disabledText(k.disabledReason)) + (k.recoverInMs > 0 ? ' · ' + (k.disabledReason === 'manual' ? T('manualPermanent') : hms(k.recoverInMs)) : '');
    var label = k.nickname
      ? '<span class="fp">' + esc(k.nickname) + '</span> <span class="w">' + esc(k.fingerprint) + '</span>'
      : '<span class="fp">' + esc(k.fingerprint) + '</span>';
    // 手动启停：有 disabledReason（含手动禁用标记）→ 「恢复」；健康/无原因 → 「禁用」。
    var stateBtn = k.disabledReason
      ? '<button class="oc-btn oc-btn-ghost oc-btn-sm del" data-action="reset-key" data-id="' + accountId + '" data-fp="' + esc(k.fingerprint) + '" title="' + T('keyResetHint') + '">' + T('keyReset') + '</button>'
      : '<button class="oc-btn oc-btn-ghost oc-btn-sm del" data-action="disable-key" data-id="' + accountId + '" data-fp="' + esc(k.fingerprint) + '" title="' + T('keyDisableHint') + '">' + T('keyDisable') + '</button>';
    return '<div class="key-row">' +
      '<span class="oc-dot ' + (k.healthy ? 'ok' : 'bad') + '"></span>' +
      label +
      '<span class="k-meta">' + meta + '</span>' +
      '<button class="oc-btn oc-btn-ghost oc-btn-sm del" data-action="key-usage" data-id="' + accountId + '" data-fp="' + esc(k.fingerprint) + '" title="' + T('keyUsageHint') + '">' + T('keyUsage') + '</button>' +
      '<button class="oc-btn oc-btn-ghost oc-btn-sm" data-action="copykey" data-id="' + accountId + '" data-fp="' + esc(k.fingerprint) + '">' + T('tokenCopy') + '</button>' +
      stateBtn +
      '<button class="oc-btn oc-btn-ghost oc-btn-sm del" data-action="renamekey" data-id="' + accountId + '" data-fp="' + esc(k.fingerprint) + '">' + T('rename') + '</button>' +
      '<button class="oc-btn oc-btn-ghost oc-btn-sm del" data-action="delkey" data-id="' + accountId + '" data-fp="' + esc(k.fingerprint) + '">' + T('remove') + '</button>' +
      '</div>';
  }

  /** 每账号一张卡：状态徽标 + 余额卡 + 月用量条 + key 行 + ⋮ 操作菜单。 */
  function accountCard(a) {
    var now = Date.now();
    // workspace 芯片（卡片 meta 行首）：只给新版 console workspace id，title 悬浮全文。
    var wsChip = a.workspaceId
      ? '<span class="oc-chip oc-chip-ws cut w" title="' + esc(a.workspaceId) + '">' + esc(a.workspaceId) + '</span> · '
      : '';
    var retry = a.retryInMs > 0
      ? (a.status === 'ok'
        ? '<span class="retry">' + T('nextProbe') + ' ' + hms(a.retryInMs) + '</span>'
        : '<span class="retry" data-rc="' + (now + a.retryInMs) + '">' + T('retryIn') + ' ' + hms(a.retryInMs) + '</span>')
      : '';
    // 需求 1：上游原始错误（如 GoUsageLimitError: Weekly usage limit reached.
    // Resets in 3 days. ...）经 friendlyQuota 包装成友好短文案，原文留在
    // title 悬浮可展开。
    var detailRaw = a.statusDetail || '';
    var detailTxt = friendlyQuota(detailRaw) || detailRaw;
    var detail = detailRaw
      ? '<div class="detail" title="' + esc(detailRaw) + '">' + esc(detailTxt) + '</div>'
      : '';
    // 右侧压缩额度栏数据源：billing（a.balance）+ previewCache（用量/Go 60s 缓存）。
    var pc = previewCache[a.id];
    var keys = a.keys && a.keys.length
      ? a.keys.map(function (k) { return keyRow(k, a.id); }).join('')
      : '<div class="key-row"><span class="w">' + T('noKeys') + '</span></div>';
    // legacy keys 摘要行（render 重建时从缓存读；数据后到时由 fillPreviewLegacy 补插）。
    var legacyRow = pc ? legacyPreviewRow(pc.legacy, a.id) : '';
    var ops = '<span class="ops">' +
      '<button class="oc-btn oc-btn-sm ops-btn dd-toggle" data-action="menu" data-id="' + a.id + '">⋮</button>' +
      '<div class="dd-menu" id="ops-menu-' + a.id + '" hidden>' +
        '<button class="oc-btn dd-item" data-action="detail" data-id="' + a.id + '">' + T('detail') + '</button>' +
        '<button class="oc-btn dd-item" data-action="edit" data-id="' + a.id + '">' + T('edit') + '</button>' +
        '<button class="oc-btn dd-item" data-action="billing" data-id="' + a.id + '">' + T('refresh') + '</button>' +
        '<button class="oc-btn dd-item oc-btn-danger" data-action="delete" data-id="' + a.id + '">' + T('delete') + '</button>' +
      '</div>' +
    '</span>';
    // 未探测：徽标下方补一句解释，让「为什么是灰色」不用猜。
    var unprobed = a.status === 'unknown'
      ? '<div class="meta">' + T('stUnknownHint') + '</div>'
      : '';
    // 收起/展开（localStorage fc-collapsed 记忆，刷新后保持）：收起时隐藏
    // 余额/用量/Go/keys 等次要信息，只留名称/状态/操作一行。
    var collapsed = loadCollapsed()[a.id] === true;
    var toggleBtn = '<button class="oc-btn oc-btn-sm card-toggle" data-action="toggle-card" data-id="' + a.id +
      '" title="' + (collapsed ? T('expand') : T('collapse')) + '"></button>';
    // 卡片头「在飞」徽章（收起状态也能看到 key 是否在被请求）：池 key 的
    // inFlight 合计，无在飞隐藏。值由 tick 里的 updateInflightBadges 就地刷新
    // （renderFingerprint 排除 inFlight，活跃流量下重建列表会清掉编辑表单）。
    var inflightN = 0;
    if (a.keys) for (var ik = 0; ik < a.keys.length; ik++) inflightN += (Number(a.keys[ik].inFlight) || 0);
    var inflight = '<span class="card-inflight" title="' + esc(T('inflightTitle')) + '"' +
      (inflightN > 0 ? '' : ' hidden') + '>' + esc(T('inFlight')) + ' ' + inflightN + '</span>';
    return '<div class="card" data-id="' + a.id + '" data-collapsed="' + (collapsed ? '1' : '0') + '">' +
      '<div class="card-hd">' +
        '<span class="name" title="' + esc(a.name) + '">' + esc(a.name) + '</span>' +
        '<span class="oc-chip">' + kindText(a.kind) + '</span>' +
        '<span class="oc-chip st-' + esc(a.status) + '">' + statusText(a.status) + '</span>' +
        (a.duplicateKey
          ? '<span class="oc-chip oc-chip-danger" title="' + esc(T('dupKeyHint')) + '">' + T('dupKeyBadge') + (a.duplicateKeyWith ? ' · ' + esc(a.duplicateKeyWith) : '') + '</span>'
          : '') +
        retry +
        inflight +
        ops +
        toggleBtn +
      '</div>' +
      '<div class="card-bd">' +
      '<div class="card-main">' +
      // 编辑表单（inline edit）
      '<div class="edit" id="edit-' + a.id + '" hidden>' +
        '<div class="oc-field"><label for="e-name-' + a.id + '">' + T('name') + '</label><input class="oc-input" id="e-name-' + a.id + '" value="' + esc(a.name) + '" autocomplete="off"></div>' +
        '<div class="oc-field"><label for="e-kind-' + a.id + '">' + T('kind') + '</label><select class="oc-select" id="e-kind-' + a.id + '">' +
          '<option value="subscription">' + T('kindSubscription') + '</option>' +
          '<option value="payg">' + T('kindPayg') + '</option>' +
          '<option value="unknown">' + T('kindUnknown') + '</option>' +
        '</select></div>' +
        '<div class="oc-field oc-full"><label for="e-cookie-' + a.id + '">' + T('cookieLabel') + '</label><input class="oc-input" id="e-cookie-' + a.id + '" type="password" placeholder="' + T('cookieKeep') + '" autocomplete="off"></div>' +
        '<div class="oc-field oc-full"><label class="oc-check"><input type="checkbox" id="e-clearcookie-' + a.id + '"><span class="oc-check-box"></span><span class="oc-check-label">' + T('cookieClearCheckbox') + '</span></label></div>' +
        '<div class="oc-hint-err oc-full" id="e-err-' + a.id + '"></div>' +
        '<button class="oc-btn oc-btn-primary" data-action="save" data-id="' + a.id + '">' + T('save') + '</button>' +
        '<button class="oc-btn" data-action="cancel" data-id="' + a.id + '">' + T('cancel') + '</button>' +
      '</div>' +
      detail +
      '<div class="meta">' +
        wsChip +
        T('lastProbe') + ' ' + probeFmt(a.lastProbeAt) +
        ' · ' + T('lastBilling') + ' ' + nowFmt(a.lastBillingAt) +
      '</div>' +
      unprobed +
      '<div class="keys">' +
        '<div class="keys-hd">' + T('keysTitle') +
          ' <button class="oc-btn oc-btn-ghost oc-btn-sm oc-tooltip" data-action="goto-tokens" data-id="' + a.id + '" data-tip="' + esc(T('keyQuotaGuide')) + '">' + T('gotoKeys') + '</button>' +
        '</div>' +
        keys +
        legacyRow +
        '<div class="key-add">' +
          '<input class="oc-input oc-grow" id="keyin-' + a.id + '" placeholder="sk-..." autocomplete="off" aria-label="' + T('addKey') + '">' +
          '<button class="oc-btn" data-action="addkey" data-id="' + a.id + '">' + T('addKey') + '</button>' +
        '</div>' +
      '</div>' +
      '</div>' +
      cardStatsHtml(a, pc) +
      '</div>' +
      '</div>';
  }

  // ── 预览数据（用量/Go/网关用量/legacy keys）：列表页每账号并行拉一次，60s 缓存 ──
  // 用量/Go 是 15 分钟级变化的数据，不值得跟 2s tick 每轮重拉：列表首次渲染
  // 拉一次，之后 60s 内复用缓存（render 指纹变化重建 DOM 也不重拉）。
  var PREVIEW_TTL = 60 * 1000;
  var previewCache = {};
  /** 卡片右侧压缩额度栏：余额 / 用量 / Go 三行紧凑小字（替代旧的三大盒竖排）。
   *  数据源 = a.balance（billing）+ previewCache（用量/Go 60s 缓存）。
   *  - 余额：$ 值，取自 billing 同步。
   *  - 用量：网关实际用量优先（gw），回落 org 用量 summary 的输出 tokens。
   *  - Go：周/月两窗口百分比（滚动窗口与周窗口信息重叠，右侧压缩只留周/月）；
   *    窗口用尽（usagePercent>=100 或 status 命中限流）标红。
   *  无控制台数据时给「等待同步 / 状态异常」提示；env 代理账号（hasConsole=false）
   *  纯 key 池，不渲染提示。 */
  function cardStatsHtml(a, pc) {
    var rows = [];
    if (a.balance != null) {
      rows.push('<div class="st-row"><span class="st-k">' + T('balanceOrg') + '</span>' +
        '<span class="st-v">$' + Number(a.balance).toFixed(2) + '</span></div>');
    }
    var tok = null;
    if (pc && pc.gw && (pc.gw.inputTokens != null || pc.gw.outputTokens != null)) {
      tok = fmt((Number(pc.gw.inputTokens) || 0) + (Number(pc.gw.outputTokens) || 0));
    } else if (pc && pc.usage && pc.usage.summary && pc.usage.summary.totalOutputTokens != null) {
      tok = fmt(pc.usage.summary.totalOutputTokens);
    }
    if (tok != null) {
      rows.push('<div class="st-row"><span class="st-k">' + T('previewUsage') + '</span>' +
        '<span class="st-v">' + tok + ' tok</span></div>');
    }
    if (pc && pc.go && pc.go.go) {
      var g = pc.go.go;
      var goLine = [];
      var goPush = function (label, w) {
        if (!w || typeof w.usagePercent !== 'number') return;
        goLine.push('<span class="' + (isGoWindowExhausted(w) ? 's-bad' : '') + '">' +
          label + ' ' + Math.round(w.usagePercent) + '%</span>');
      };
      goPush(T('goWeekly'), g.weekly);
      goPush(T('goMonthly'), g.monthly);
      if (goLine.length) {
        rows.push('<div class="st-row"><span class="st-k">' + T('previewGo') + '</span>' +
          '<span class="st-v">' + goLine.join(' · ') + '</span></div>');
      }
    }
    // 无控制台数据：区分「有凭据等同步」vs「状态异常」；env 代理账号无提示。
    if (a.balance == null && a.monthlyLimit == null && a.monthlyUsage == null && a.hasConsole) {
      var noteTxt = (a.status === 'error' || a.status === 'invalid')
        ? esc(friendlyQuota(a.statusDetail) || a.statusDetail || T('stError'))
        : T('waitingSync');
      rows.push('<div class="st-row"><span class="st-v s-bad">' + noteTxt + '</span></div>');
    }
    if (!rows.length) return '';
    return '<div class="card-stats">' + rows.join('') + '</div>';
  }
  /** Go 窗口是否用量已用尽：usagePercent>=100，或 status 命中限流/耗尽标记。 */
  function isGoWindowExhausted(w) {
    if (!w || typeof w !== 'object') return false;
    if (typeof w.usagePercent === 'number' && w.usagePercent >= 100) return true;
    if (typeof w.status === 'string') {
      return /rate-?limit|limit_reached|exhausted/i.test(w.status);
    }
    return false;
  }
  /** 拉取并回填单账号的用量摘要（右侧压缩栏）。失败/404 → 保持 null → 行隐藏。 */
  function fetchPreviewUsage(id) {
    api('GET', '/__admin/api/console/account/' + id + '/usage?range=7d', null).then(function (r) {
      var c = previewCache[id];
      if (!c) return;
      if (r.ok && r.json && r.json.ok !== false && r.json.data && r.json.data.summary) c.usage = r.json.data;
      fillCardStats(id);
    }).catch(function () {});
  }
  /** 拉取并回填单账号的网关实际代理用量（优先级高于 org 用量）。失败 → 回落 org。 */
  function fetchPreviewGateway(id) {
    api('GET', '/__admin/api/accounts/' + id + '/usage-gateway?rangeDays=7', null).then(function (r) {
      var c = previewCache[id];
      if (!c) return;
      if (r.ok && r.json && r.json.ok !== false && r.json.data) c.gw = r.json.data;
      fillCardStats(id);
    }).catch(function () {});
  }
  /** 拉取并回填单账号的 legacy keys 摘要（卡片 key 区显示数量 + 首个名字）。404 = 非 legacy workspace，静默。 */
  function fetchPreviewLegacy(id) {
    api('GET', '/__admin/api/legacy/account/' + id + '/keys', null).then(function (r) {
      var c = previewCache[id];
      if (!c) return;
      if (r.ok && r.json && r.json.ok !== false && r.json.data && Array.isArray(r.json.data.keys)) {
        c.legacy = r.json.data.keys;
        fillPreviewLegacy(id, c.legacy);
      }
    }).catch(function () {});
  }
  /** legacy keys 摘要行的 HTML：逐 key 一行（名字 + 掩码 + 复制按钮），无 legacy 返回 ''。
   *  accountCard（render 重建时读缓存）与 fillPreviewLegacy（数据后到时补插）共用。
   *  accountId 用于复制按钮（列表页没有 detailState.id，必须带账户归属）。 */
  function legacyPreviewRow(keys, accountId) {
    if (!keys || !keys.length) return '';
    var rows = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!k || !k.id) continue;
      var name = k.name ? esc(k.name) : '—';
      var masked = k.masked ? '<span class="w">' + esc(k.masked) + '</span>' : '';
      rows.push('<div class="key-row legacy-row" title="' + T('legacyHint') + '">' +
        '<span class="fp cut">' + name + '</span>' + masked +
        '<button class="oc-btn oc-btn-ghost oc-btn-sm" data-action="copy-legacy-key" data-accountid="' + accountId + '" data-keyid="' + esc(k.id) + '" title="' + T('legacyKeyCopyTitle') + '">' + T('tokenCopy') + '</button>' +
        '</div>');
    }
    return rows.join('');
  }
  /** 数据后到时补插 legacy 摘要行（防重：已有 .legacy-row 就不再插）。 */
  function fillPreviewLegacy(id, keys) {
    var html = legacyPreviewRow(keys, id);
    if (!html) return;
    var card = document.querySelector('.card[data-id="' + id + '"]');
    if (!card) return;
    if (card.querySelector('.keys .legacy-row')) return;
    var add = card.querySelector('.keys .key-add');
    if (!add) return;
    add.insertAdjacentHTML('beforebegin', html);
  }
  /** 拉取并回填单账号的 Go 三窗口（右侧压缩栏）。失败 → 保持 null → 行隐藏。 */
  function fetchPreviewGo(id) {
    api('GET', '/__admin/api/legacy/account/' + id + '/go', null).then(function (r) {
      var c = previewCache[id];
      if (!c) return;
      if (r.ok && r.json && r.json.ok !== false && r.json.data && r.json.data.go) c.go = r.json.data;
      fillCardStats(id);
    }).catch(function () {});
  }
  /** 列表渲染后调用：只为缓存缺失/过期的账号发请求（TTL 防 tick 重复拉）。 */
  function loadPreviewData(list) {
    var now = Date.now();
    for (var i = 0; i < list.length; i++) {
      var id = list[i].id;
      var c = previewCache[id];
      if (c && now - c.at < PREVIEW_TTL) continue;
      previewCache[id] = { at: now, usage: null, go: null, gw: null, legacy: null };
      // 网关实际代理用量始终可拉（本机数据，任何账号都有）。
      fetchPreviewGateway(id);
      // console usage 预览：只有 hasConsole（配了 cookie/oauth 凭据）的账号才发——
      // env 等无凭据账号发 console usage 必得 502（实测 2026-08-15 reqid=11），纯噪音。
      if (list[i].hasConsole) fetchPreviewUsage(id);
      // legacy go/keys 预览：只有 legacyWorkspaceId 配置的账号才发——无 legacy 的
      // 账号发 legacy 请求网关 404 → 经盾转 503（实测 reqid=12/14），纯噪音。
      if (list[i].legacyWorkspaceId) {
        fetchPreviewGo(id);
        fetchPreviewLegacy(id);
      }
    }
  }
  /** 数据到达后回填卡片右侧压缩栏（重建 .card-stats；空 html = 失败 → 不动作）。 */
  function fillCardStats(id) {
    var card = document.querySelector('.card[data-id="' + id + '"]');
    if (!card) return;
    var a = findAccount(id);
    if (!a) return;
    var box = card.querySelector('.card-stats');
    if (!box) return;
    box.outerHTML = cardStatsHtml(a, previewCache[id]);
  }

  /** 健康度列表的单行（总览 tab）。 */
  function healthRow(a) {
    var now = Date.now();
    var retry = a.retryInMs > 0
      ? (a.status === 'ok'
        ? '<span class="retry">' + T('nextProbe') + ' ' + hms(a.retryInMs) + '</span>'
        : '<span class="retry" data-rc="' + (now + a.retryInMs) + '">' + T('retryIn') + ' ' + hms(a.retryInMs) + '</span>')
      : '';
    var unprobed = a.status === 'unknown'
      ? '<span class="w">' + T('stUnknownHint') + '</span>'
      : '';
    return '<div class="key-row">' +
      '<span class="oc-dot ' + (a.status === 'ok' ? 'ok' : 'bad') + '"></span>' +
      '<span class="fp">' + esc(a.name) + '</span>' +
      '<span class="oc-chip st-' + esc(a.status) + '">' + statusText(a.status) + '</span>' +
      unprobed +
      retry +
      '</div>';
  }

  /** 账号渲染指纹：排除每秒变的 retryInMs/recoverInMs（倒计时由 data-rc 自走），
   *  也排除 key 的 inFlight/lastUsedAt（keypool 实时值，任何请求都变——活跃流量下
   *  2s 轮询会因它们重建列表，正在输入的 key/编辑表单被清空）。保留 disabledReason/
   *  healthy/nickname 等状态字段，状态或昵称变化仍触发重建。 */
  function renderFingerprint(d) {
    return JSON.stringify(d.degraded) + '|' + (d.list || []).map(function (a) {
      return [a.id, a.name, a.kind, a.status, a.statusDetail, a.retryUntil, a.balance,
        a.monthlyLimit, a.monthlyUsage, a.lastProbeAt, a.lastBillingAt,
        JSON.stringify(a.allowedModels || null), JSON.stringify(a.blockedModels || null),
        a.duplicateKey ? (a.duplicateKeyWith || '') : '',
        JSON.stringify((a.keys || []).map(function (k) {
          return [k.fingerprint, k.healthy, k.disabledReason, k.nickname];
        }))].join(':');
    }).join(';');
  }
  var lastFp = null;

  function render(d) {
    var fp = renderFingerprint(d);
    if (fp === lastFp) return;  // 数据没变，保留现有 DOM（编辑表单/输入框不受干扰）
    lastFp = fp;
    if (d.degraded) {
      $('degraded').hidden = false;
      $('degraded-reason').textContent = d.degraded;
    } else {
      $('degraded').hidden = true;
    }
    var list = d.list || [];
    state.list = list;
    // OAuth 成功态：拿到新账号（id 单调递增）后把 email 补进状态行（对齐 CLI 文案）。
    if (!$('oauth-overlay').hidden) {
      var ost = $('oauth-status');
      if (ost.className === 'oauth-status ok' && ost.textContent === T('oauthLoggedIn')) {
        for (var i2 = 0; i2 < list.length; i2++) {
          if (list[i2].id > oauthMaxId) {
            ost.textContent = T('oauthLoggedIn') + ' ' + list[i2].name;
            break;
          }
        }
      }
    }
    // 健康度口径：X = 最近探针正常；Y = 有 key 的账号数（无 key 账号不算，
    // 没 key 永远不会被探，算进去只会让「Y」虚高）；未探测 = 等待首次探测。
    var okN = 0, coolN = 0, bal = 0, hasBal = false, dist = {}, withKeys = 0, waitN = 0;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.status === 'ok') okN++;
      if (a.status === 'cooldown' || a.status === 'limit' || a.status === 'insufficient') coolN++;
      if (a.balance != null) { bal += Number(a.balance); hasBal = true; }
      var hasK = a.keys && a.keys.length > 0;
      if (hasK) withKeys++;
      if (hasK && a.status === 'unknown') waitN++;
      var st = a.status || 'unknown';
      dist[st] = (dist[st] || 0) + 1;
    }
    $('stat-accounts').textContent = list.length;
    $('stat-healthy').textContent = okN + '/' + withKeys;
    $('stat-balance').textContent = hasBal ? '$' + bal.toFixed(2) : '—';
    $('stat-cooldown').textContent = coolN;
    $('stat-dist').innerHTML = Object.keys(dist).map(function (st) {
      return '<span class="oc-chip st-' + esc(st) + '">' + statusText(st) + ' · ' + dist[st] + '</span>';
    }).join('');
    $('health-note').textContent = T('healthNote') + (waitN > 0 ? ' · ' + waitN + T('healthNoteWait') : '');
    $('health-list').innerHTML = list.length
      ? list.map(healthRow).join('')
      : '<div class="oc-hint">' + T('noAccounts') + '</div>';

    var el = $('accounts');
    if (!list.length) {
      el.innerHTML = '<div class="empty"><div class="e-t">' + T('noAccounts') + '</div>' +
        '<div class="e-s">' + T('noAccountsSub') + '</div></div>';
      return;
    }
    el.innerHTML = list.map(accountCard).join('');
    // 列表渲染后拉一次预览数据（用量/Go）；TTL 内重复调用是 no-op。
    loadPreviewData(list);
    // 数字输入 spinner：渲染函数末尾重挂（tick 重建 DOM 后新 input 重新包裹）。
    mountNumSpinners(el);
  }

  function tick(manual) {
    if (document.hidden) return;
    fetch('/__admin/api/accounts', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))); })
      .then(function (d) {
        $('h-live').className = 'ok'; $('h-live-text').textContent = T('live');
        render(d);
        // 独立于 render：数据不变 render 跳过时，预览失败缓存（60s TTL）仍能
        // 在过期后重试——否则「首次加载失败 → 容器永远不出现」（审查）。
        loadPreviewData(d.list);
        // 在飞徽章走独立就地更新（renderFingerprint 排除 inFlight，不重建列表）。
        updateInflightBadges();
      })
      .catch(function (e) {
        // 未登录（401）：停止 2s 轮询 —— 否则一直开着的未登录面板页每 2s
        // 打一组请求全部 401（实测占网关日志量 ~80%，2026-08-15 日志深挖）。
        // 登录页本身不依赖这些数据；重新登录后页面会整页刷新重新初始化。
        if (String(e.message).indexOf('401') >= 0) {
          clearInterval(fcTickTimer);
          // 未登录时 OTA 状态轮询也停：60s 白打一组 401（与 fcTickTimer 同源噪音）。
          if (otaTimer) clearInterval(otaTimer);
          return;
        }
        $('h-live').className = 'bad'; $('h-live-text').textContent = e.message;
      });
    fetchUsage();
    fetchOverviewTrend();
    // 总览性能仪表盘（跟随同一 2s tick；区块隐藏时 fetchPerf 内部早退，不发请求）。
    fetchPerf();
    // 用量 tab 三张表（requests/ipstats/audit）渲染全是 usage 视图内容——非 usage
    // 视图每 2s 白打 3 个请求；切到 usage 后下个 tick 自然补拉（2s 延迟可接受）。
    if (curView === 'usage') {
      fetchRequests();
      fetchIpStats();
      fetchAudit();
    }
    // 分发密钥 60s 自动刷新兜底：TTL 过期后 tick 负责续命（总览费用/密钥卡）。
    loadTokens(false);
    // 预览数据（用量/Go）60s 自动刷新兜底：render 指纹不变时 tick 也负责续命。
    loadPreviewData(state.list);
    // tick 刷新 billing（最动态）+ go/legacy（详情打开时偶发瞬时失败——
    // 首次加载失败会残留空区块，2s 重试自愈）；members/sa/providers/budgets/
    // usage 只在进入详情和手动刷新时加载，避免 2s 轮询发太多请求。
    if (detailState.id != null) {
      // 2s 自动轮询（manual 空）→ fromTick=true：billing 的 sticky 错误不被
      // 成功覆盖（detailErr 的错误要持续显示到用户操作）；用户主动触发
      // （tick(true)：写操作/刷新余额/切语言等）→ 成功时清除并渲染新数据。
      loadBilling(detailState.id, !manual);
      loadGo(detailState.id, !manual);
      loadLegacyKeys(detailState.id, !manual);
      loadLegacyBilling(detailState.id, !manual);
      renderLegacyKey();
    }
  }

  /** 每秒推进冷却倒计时（data-rc 是渲染时算好的客户端时刻，与轮询解耦）。 */
  function tickCountdown() {
    var now = Date.now();
    var nodes = document.querySelectorAll('[data-rc]');
    for (var i = 0; i < nodes.length; i++) {
      var left = Number(nodes[i].getAttribute('data-rc')) - now;
      if (left <= 0) {
        nodes[i].textContent = hms(0);
        nodes[i].removeAttribute('data-rc');
      } else {
        nodes[i].textContent = T('retryIn') + ' ' + hms(left);
      }
    }
  }

  /** 就地刷新卡片头「在飞」徽章（不重建列表）。renderFingerprint 排除 inFlight，
   *  活跃流量下 2s 轮询不会因它重建 DOM，徽章必须走这条独立更新路径。 */
  function updateInflightBadges() {
    var list = state.list || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i], n = 0;
      if (a.keys) for (var ik = 0; ik < a.keys.length; ik++) n += (Number(a.keys[ik].inFlight) || 0);
      var badge = document.querySelector('.card[data-id="' + a.id + '"] .card-inflight');
      if (!badge) continue;
      badge.hidden = n <= 0;
      badge.textContent = T('inFlight') + ' ' + n;
      badge.setAttribute('data-inflight', String(n));
    }
  }

  /** 当前列表数据（render 时缓存，编辑表单/操作回读用）。 */
  var state = { list: [] };
  function findAccount(id) {
    for (var i = 0; i < state.list.length; i++) {
      if (state.list[i].id === id) return state.list[i];
    }
    return null;
  }

  /** 内联编辑表单展开/收起，select 同步当前 kind。 */
  function toggleEdit(id) {
    var ed = $('edit-' + id);
    if (!ed) return;
    ed.hidden = !ed.hidden;
    if (!ed.hidden) {
      var a = findAccount(id);
      $('e-kind-' + id).value = a ? a.kind : 'unknown';
    }
  }

  function saveEdit(id) {
    var name = $('e-name-' + id).value.trim();
    var kind = $('e-kind-' + id).value;
    var cookie = $('e-cookie-' + id).value;
    var clearCookie = $('e-clearcookie-' + id) && $('e-clearcookie-' + id).checked;
    if (!name) { $('e-err-' + id).textContent = T('nameRequired'); return; }
    var body = { name: name, kind: kind };
    // cookie 输入框打开时恒为空（不回填现值）：空输入 + 未勾选清除 = 不带 cookie
    // 键（服务端 undefined 不更新，避免把空串提交成 cookie:null 静默清空 billing
    // cookie）；显式勾选「清除已存 cookie」才发 cookie:''（服务端解析成 null=清除）。
    if (cookie) body.cookie = cookie;
    else if (clearCookie) body.cookie = '';
    api('PATCH', '/__admin/api/accounts/' + id, body)
      .then(function (r) {
        if (r.ok) {
          $('edit-' + id).hidden = true;
          $('e-err-' + id).textContent = '';
          var cc = $('e-clearcookie-' + id);
          if (cc) cc.checked = false;
          tick(true);
        }
        else { $('e-err-' + id).textContent = errMsg(r); }
      });
  }

  function addKey(id) {
    var input = $('keyin-' + id);
    var key = (input && input.value || '').trim();
    if (!key) return;
    api('POST', '/__admin/api/accounts/' + id + '/keys', { key: key })
      .then(function (r) {
        if (r.ok) { if (input) input.value = ''; tick(true); }
        else { flash(errMsg(r), true); }
      });
  }

  function delKey(id, fp) {
    openConfirm({
      title: T('keysTitle'),
      okText: T('remove'),
      danger: true,
      body: '<div class="oc-hint">' + T('confirmDeleteKey') + '</div>',
      run: function () {
        api('DELETE', '/__admin/api/accounts/' + id + '/keys/' + encodeURIComponent(fp), null)
          .then(function (r) {
            if (r.ok) { closeConfirm(); tick(true); }
            else { unlockConfirm(); $('confirm-err').textContent = errMsg(r); }
          });
      }
    });
  }

  /** 复制账户上游 key 明文（H2）：GET keys/plain 一次拿全量，按指纹挑出该行。
   *  明文只在响应体与剪贴板流转，不进日志。 */
  function copyKey(id, fp) {
    api('GET', '/__admin/api/accounts/' + id + '/keys/plain', null)
      .then(function (r) {
        if (!r.ok || !r.json || !r.json.data || !r.json.data.keys) { flash(errMsg(r), true); return; }
        var keys = r.json.data.keys || [];
        var hit = null;
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].fingerprint === fp) { hit = keys[i].plain; break; }
        }
        if (hit == null) { flash(T('keyNotFound'), true); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(hit).then(function () {
            flash(T('tokenCopied'));
          }, function () { flash(T('opFail'), true); });
        } else {
          flash(T('opFail'), true);
        }
      });
  }

  /** key 用量弹层：GET /__admin/api/keys/usage（服务端已实现的聚合端点，
   *  契约 {ok, data:{rangeDays, sinceMs, keys:[{fingerprint, accountId,
   *  accountName, nickname, healthy, requests, tokens, costMicroCents, lastAt}]}}）。
   *  按 accountId + fingerprint 双条件匹配（防末 4 位指纹跨账号误中）。cost 单位
   *  microCents 用 money() 换算美元。找不到 → 「暂无用量」占位而不是报错。
   *  弹层内附「创建配额分发密钥」引导（用户需求：key 详情丰富）。 */
  function keyUsage(id, fp) {
    api('GET', '/__admin/api/keys/usage?rangeDays=7', null).then(function (r) {
      var hit = null;
      if (r.ok && r.json && r.json.data && Array.isArray(r.json.data.keys)) {
        for (var i = 0; i < r.json.data.keys.length; i++) {
          var k = r.json.data.keys[i];
          if (k.fingerprint === fp && (k.accountId == null || k.accountId === id)) { hit = k; break; }
        }
      }
      var row = function (label, v) {
        return '<div class="key-row"><span class="fp">' + label + '</span><span class="k-meta">' + v + '</span></div>';
      };
      var rows = hit
        ? row(T('requests'), hit.requests != null ? fmt(hit.requests) : '—') +
          row(T('tokens'), hit.tokens != null ? fmt(hit.tokens) : '—') +
          row(T('cost'), hit.costMicroCents != null ? money(hit.costMicroCents) : '—') +
          (hit.lastAt ? row(T('ipLast'), hhmmss(hit.lastAt)) : '')
        : '<div class="oc-hint">' + T('keyUsageNoData') + '</div>';
      openConfirm({
        title: T('keyUsageTitle') + ' ' + esc(fp),
        okText: T('tokenClose'),
        body: '<div class="keys">' + rows + '</div>' +
          '<div class="oc-hint">' + T('keyQuotaGuide') + '</div>',
        run: function () { closeConfirm(); }
      });
    }).catch(function () {
      flash(T('opFail'), true);
    });
  }
  /** 手动启停上游 key（服务端已实现的端点）：POST /keys/:fp/disable（禁用）
   *  | /keys/:fp/reset（恢复）。指纹取掩码形态（****XXXX，服务端按此校验）。
   *  成功 flash + tick 刷新（列表/预览重建）；失败 flash 错误。 */
  function toggleKeyState(id, fp, disable) {
    api('POST', '/__admin/api/keys/' + encodeURIComponent(fp) + (disable ? '/disable' : '/reset'), {})
      .then(function (r) {
        if (r.ok) { flash(disable ? T('keyDisabledMsg') : T('keyEnabledMsg')); tick(true); }
        else flash(errMsg(r), true);
      });
  }

  /** 改 key 昵称：confirm 弹层内联输入框（留空 = 清除），PATCH keys/:fp。 */
  function renameKey(id, fp) {    var cur = '';
    var acc = findAccount(id);
    if (acc) {
      var ks = acc.keys || [];
      for (var i = 0; i < ks.length; i++) {
        if (ks[i].fingerprint === fp) { cur = ks[i].nickname || ''; break; }
      }
    }
    openConfirm({
      title: T('rename'),
      okText: T('save'),
      body: '<div class="oc-form"><div class="oc-field oc-full"><label for="rk-nickname">' + T('nickname') + '</label>' +
        '<input class="oc-input" id="rk-nickname" maxlength="30" value="' + esc(cur) + '" autocomplete="off"></div>' +
        '<div class="oc-hint">' + T('renameHint') + '</div></div>',
      run: function () {
        var nick = $('rk-nickname').value.trim();
        api('PATCH', '/__admin/api/accounts/' + id + '/keys/' + encodeURIComponent(fp), { nickname: nick || null })
          .then(function (r) { opDone(r, T('renamed')); });
      }
    });
    setTimeout(function () { var el = $('rk-nickname'); if (el) el.focus(); }, 0);
  }

  function delAccount(id) {
    openConfirm({
      title: T('delete'),
      okText: T('delete'),
      danger: true,
      body: '<div class="oc-hint">' + T('confirmDelete') + '</div>',
      run: function () {
        api('DELETE', '/__admin/api/accounts/' + id, null)
          .then(function (r) {
            if (r.ok) { closeConfirm(); tick(true); }
            else { unlockConfirm(); $('confirm-err').textContent = errMsg(r); }
          });
      }
    });
  }

  function refreshBalance(id) {
    api('POST', '/__admin/api/accounts/' + id + '/billing', {})
      .then(function (r) {
        if (r.ok) {
          // 余额变了，预览缓存作废：清掉立即重拉（用量/Go 同源刷新）。
          delete previewCache[id];
          loadPreviewData(state.list);
          flash(T('refreshed'));
          tick(true);
        }
        else { flash(errMsg(r), true); }
      });
  }

  /** 创建表单的类型下拉当前值（默认 subscription；切换走 .dd-item[data-kind] 委托）。 */
  var cKind = 'subscription';
  function createAccount() {
    var name = $('c-name').value.trim();
    var kind = cKind;
    var ws = $('c-ws').value.trim();
    var keys = $('c-keys').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var cookie = $('c-cookie').value;
    if (!name) { $('c-err').textContent = T('nameRequired'); return; }
    api('POST', '/__admin/api/accounts', {
      name: name, kind: kind, workspaceId: ws || null,
      keys: keys, cookie: cookie || null
    }).then(function (r) {
      if (r.ok) {
        $('c-err').textContent = '';
        $('c-name').value = ''; $('c-ws').value = ''; $('c-keys').value = ''; $('c-cookie').value = '';
        tick(true);
      } else {
        $('c-err').textContent = errMsg(r);
      }
    });
  }

  // ── tabs / sidebar ─────────────────────────────────
  var VIEWS = {
    overview: 'view-overview', accounts: 'view-accounts',
    usage: 'view-usage', tokens: 'view-tokens', access: 'view-access', settings: 'view-settings',
    'account-detail': 'view-account-detail'
  };
  /** 每个 tab 的子导航：词条键 + 锚点 section id。 */
  var SUBS = {
    overview: [['subOverview', 'sec-overview'], ['subPerf', 'sec-perf'], ['subStatus', 'sec-status'], ['subHealth', 'sec-health']],
    accounts: [['subAccounts', 'sec-accounts'], ['subCreate', 'sec-create'], ['subOauth', 'sec-oauth']],
    usage: [['subRequests', 'sec-usage-summary'], ['subKeys', 'sec-usage-keys'], ['subIps', 'sec-usage-ips'], ['subAudit', 'sec-usage-audit']],
    tokens: [['subTokens', 'sec-tokens']],
    access: [['subModelAccess', 'sec-access-global'], ['maUpstreamTitle', 'sec-access-upstream'],
      ['maTokenTitle', 'sec-access-token'], ['maApiKeyTitle', 'sec-access-apikey']],
    settings: [
      ['subLanguage', 'sec-settings-lang'], ['subModelMap', 'sec-modelmap'],
      ['subAdminAuth', 'sec-admin-auth'], ['subAdminKeys', 'sec-admin-keys'],
      ['subExperimental', 'sec-experimental'], ['subUpdate', 'sec-update'], ['subAbout', 'sec-about'],
    ],
    'account-detail': [['subDetail', 'sec-account-detail']]
  };

  /** 当前 tab 与 sidebar 子项（section id）：驱动高亮 + localStorage 记忆。 */
  var curView = 'overview';
  var curSub = null;

  function renderSubnav(v) {
    var items = SUBS[v] || [];
    // 记忆的 sub 不在当前 tab 子项里就回落到第一个（跨 tab 残留兜底）。
    var active = curSub && items.some(function (s) { return s[1] === curSub; }) ? curSub : (items[0] ? items[0][1] : null);
    $('sidebar').innerHTML = items.map(function (s) {
      return '<button class="snav' + (s[1] === active ? ' active' : '') + '" data-sub="' + s[1] + '">' + T(s[0]) + '</button>';
    }).join('');
  }

  /** 激活项滚到 sidebar 可视区中间（容器内部滚动，不扰动页面滚动）。
   *  纵向：桌面 sidebar 有 max-height + overflow-y: auto，子项溢出时生效；
   *  横向：≤48rem 时 sidebar 收成横滚子导航，激活项同样滚到可视区中间。 */
  function focusSidebar() {
    var sb = $('sidebar');
    var active = sb.querySelector('.snav.active');
    if (!active) return;
    var maxY = sb.scrollHeight - sb.clientHeight;
    if (maxY > 0) {
      var target = active.offsetTop - (sb.clientHeight - active.offsetHeight) / 2;
      sb.scrollTop = Math.max(0, Math.min(target, maxY));
    }
    var maxX = sb.scrollWidth - sb.clientWidth;
    if (maxX > 0) {
      var tx = active.offsetLeft - (sb.clientWidth - active.offsetWidth) / 2;
      sb.scrollLeft = Math.max(0, Math.min(tx, maxX));
    }
  }

  /** 当前 tab + sub 记忆进 localStorage（刷新/重进面板恢复；详情视图不记忆）。 */
  function saveViewState() {
    try {
      if (curView !== 'account-detail') localStorage.setItem('fc-admin-view', curView);
      if (curSub) localStorage.setItem('fc-admin-sub', curSub);
      else localStorage.removeItem('fc-admin-sub');
    } catch (e) {}
  }

  function switchView(v) {
    if (!VIEWS[v]) return;
    if (v !== 'account-detail') detailState.id = null;
    curView = v;
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tab') === (v === 'account-detail' ? 'accounts' : v);
      tabs[i].className = on ? 'tab active' : 'tab';
    }
    for (var name in VIEWS) {
      $('view-' + name).hidden = name !== v;
    }
    renderSubnav(v);
    closeMenus();
    saveViewState();
    focusSidebar();
    if (v === 'settings') { refreshModelMap(); loadSettings(false); loadOtaStatus(false); }  // 进设置页时拉映射表 + 热改配置 + OTA 状态
    if (v === 'tokens') { loadTokens(true); }  // 进密钥页强制拉列表（用量实时，60s 缓存仅限 tick 内）
    if (v === 'access') { loadModelAccess(); }  // 进 model access 页时拉配置（数据静态，无缓存）
    window.scrollTo(0, 0);
  }

  // ── dropdown（语言菜单 + 卡片操作菜单共用）──────────
  function closeMenus() {
    var menus = document.querySelectorAll('.dd-menu');
    for (var i = 0; i < menus.length; i++) menus[i].hidden = true;
  }
  function toggleMenu(menu) {
    if (!menu) return;
    var wasOpen = !menu.hidden;
    closeMenus();
    if (!wasOpen) menu.hidden = false;
  }

  // ── usage（/__metrics 简化版渲染）──────────────────
  function renderUsage(m) {
    var s = m.summary || {};
    $('u-total').textContent = fmt(m.totalRequests);
    $('u-failed').textContent = fmt(s.failed);
    $('u-stream').textContent = fmt(s.streaming);
    $('u-avg').textContent = msFmt(s.avgDurationMs);
    $('u-tokens').textContent = fmt((s.inputTokens || 0) + (s.outputTokens || 0));
    // 兼容修复三计数（管理鉴权下 /__metrics summary 才带；匿名请求字段缺席 → 显示 —）。
    var fixes = $('u-fixes');
    if (s.rewritten == null && s.stripped == null && s.compressed == null) {
      fixes.textContent = '—';
    } else {
      fixes.textContent = T('fixRewritten') + ' ' + fmt(s.rewritten || 0) + ' · ' +
        T('fixStripped') + ' ' + fmt(s.stripped || 0) + ' · ' +
        T('fixCompressed') + ' ' + fmt(s.compressed || 0);
    }
    var pool = m.pool || {};
    var keys = pool.keys || [];
    $('u-keys').innerHTML = keys.length
      ? keys.map(function (k) {
          var meta = k.healthy
            ? T('healthy')
            : esc(disabledText(k.disabledReason)) + (k.recoverInMs > 0 ? ' · ' + (k.disabledReason === 'manual' ? T('manualPermanent') : hms(k.recoverInMs)) : '');
          return '<div class="key-row">' +
            '<span class="oc-dot ' + (k.healthy ? 'ok' : 'bad') + '"></span>' +
            '<span class="fp">' + esc(k.fingerprint) + '</span>' +
            '<span class="k-meta">' + meta + '</span>' +
            '<span class="k-meta">' + T('inFlight') + ' ' + k.inFlight + '</span>' +
            '</div>';
        }).join('')
      : '<div class="oc-hint">' + T('noKeys') + '</div>';
  }
  /** 最近一次 /__metrics 快照（总览卡组 + 状态列表重渲染用；tokens 数据到达后
   *  也靠它刷总览——费用/密钥卡在 renderOverviewMetrics 里读 tokensCache）。 */
  var lastMetrics = null;
  function fetchUsage() {
    fetch('/__metrics', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))); })
      .then(function (m) {
        lastMetrics = m;
        renderUsage(m);
        renderOverviewMetrics(m, lastTrend);
      })
      .catch(function () {});
  }
  /** 总览真实趋势（/__admin/api/overview/trend，7d 聚合）。服务端已有 10s 聚合
   *  缓存，这里再加一层客户端 TTL，2 秒 tick 不用每轮都发这个请求。 */
  var lastTrend = null;
  var lastTrendAt = 0;
  var TREND_TTL = 10 * 1000;
  function fetchOverviewTrend() {
    var now = Date.now();
    if (now - lastTrendAt < TREND_TTL) return;
    lastTrendAt = now;
    fetch('/__admin/api/overview/trend?range=7d', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))); })
      .then(function (d) {
        lastTrend = d && d.data ? d.data : null;
        if (lastMetrics) renderOverviewMetrics(lastMetrics, lastTrend);
      })
      .catch(function () { lastTrend = null; });
  }

  // ── 总览：网关统计卡组 + 状态列表（/__metrics + /__admin/api/tokens）──
  /** 最近事件按时间均匀切 12 桶（桶数 = 点数；不足 12 条也能画，最多 n 个非零桶）。
   *  pick 决定每个事件对桶的贡献（请求数 1 / 成功 0-1 / tokens / 活跃 key）。 */
  function bucketize(events, n, pick) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(0);
    if (!events || !events.length) return out;
    var min = Infinity, max = -Infinity;
    for (var j = 0; j < events.length; j++) {
      var at = Number(events[j].at) || 0;
      if (at < min) min = at;
      if (at > max) max = at;
    }
    if (min === max) { out[n - 1] = events.length; return out; }  // 同一时刻全进最后一桶
    for (var k = 0; k < events.length; k++) {
      var idx = Math.min(n - 1, Math.floor((Number(events[k].at) - min) / (max - min) * n));
      out[idx] += pick(events[k]);
    }
    return out;
  }
  /** 零依赖 SVG 折线（viewBox 0 0 100 28，按最大值归一；全 0 画平线）。 */
  function sparkline(values) {
    var n = values.length || 1, max = 0;
    for (var i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
    var pts = [];
    for (var j = 0; j < n; j++) {
      var x = n > 1 ? (j / (n - 1)) * 100 : 50;
      var y = max > 0 ? 26 - (values[j] / max) * 24 : 14;
      pts.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    return '<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">' +
      '<polyline points="' + pts.join(' ') + '"/></svg>';
  }
  /** 趋势序列抽取：从 usageTrend.items 取一个数值字段（sparkline 数据源）。 */
  function trendSeries(items, field) {
    var out = [];
    for (var i = 0; i < items.length; i++) out.push(Number(items[i][field]) || 0);
    return out;
  }
  /** 状态列表一行：状态点（绿/黄/红）+ 名称 + 描述。 */
  function stRow(nameKey, cls, desc) {
    return '<div class="st-row"><span class="oc-dot ' + cls + '"></span>' +
      '<span class="st-name">' + T(nameKey) + '</span>' +
      '<span class="st-desc">' + desc + '</span></div>';
  }
  /** 渲染总览卡组 + 状态列表。事件数据来自 /__metrics；费用/密钥卡读 tokensCache
   *  （60s TTL，未拉到显示 —）。成功率与 summary 同口径：ok/(ok+failed)。
   *  trend（usage db 的真实 7 天聚合）可用时，请求数/成功率/费用卡与三根
   *  sparkline 都改用真实聚合；trend 为 null（db 未接线/不可用）时回落快照。 */
  function renderOverviewMetrics(m, trend) {
    var s = m.summary || {};
    var evs = m.events || [];
    var total = Number(m.totalRequests) || 0;
    var okN = Number(s.ok) || 0;
    var failN = Number(s.failed) || 0;
    var done = okN + failN;
    var cost = 0, active = 0;
    if (tokensCache && tokensCache.items) {
      for (var i = 0; i < tokensCache.items.length; i++) {
        cost += Number((tokensCache.items[i].usage || {}).costMicroCents) || 0;
        if (tokensCache.items[i].status === 'active') active++;
      }
    }
    if (trend) {
      $('ov-total').textContent = fmt(trend.requests);
      $('spark-total').innerHTML = sparkline(trendSeries(trend.items, 'requests'));
      var tDone = trend.ok + trend.failed;
      $('ov-rate').textContent = tDone > 0 ? Math.round(trend.ok / tDone * 100) + '%' : '—';
      // 成功率桶与 summary 同口径（ok 事件数），比例归一由 sparkline 自己做。
      $('spark-rate').innerHTML = sparkline(trendSeries(trend.items, 'ok'));
      $('ov-cost').textContent = money(trend.costMicroCents);
      $('spark-cost').innerHTML = sparkline(trendSeries(trend.items, 'costMicroCents'));
    } else {
      $('ov-total').textContent = fmt(total);
      $('spark-total').innerHTML = sparkline(bucketize(evs, 12, function () { return 1; }));
      $('ov-rate').textContent = done > 0 ? Math.round(okN / done * 100) + '%' : '—';
      // sparkline 的成功桶与 summary 同口径（200 <= status < 400 算 ok）。
      $('spark-rate').innerHTML = sparkline(bucketize(evs, 12, function (e) {
        return e.status >= 200 && e.status < 400 ? 1 : 0;
      }));
      $('ov-cost').textContent = tokensCache ? money(cost) : '—';
      // 费用没有事件级数据（上游记账），sparkline 用 token 量作为活动趋势。
      $('spark-cost').innerHTML = sparkline(bucketize(evs, 12, function (e) {
        return (Number(e.inputTokens) || 0) + (Number(e.outputTokens) || 0);
      }));
    }
    var note = $('ov-note');
    if (note) note.textContent = trend ? T('ovTrendNote') : T('ovTrendFallback');
    $('ov-keys').textContent = tokensCache ? active + '/' + tokensCache.items.length : '—';
    $('spark-keys').innerHTML = sparkline(bucketize(evs, 12, function (e) {
      return e.keyFingerprint ? 1 : 0;
    }));
    // 状态列表：网关 / 上游池 / 账号 / 分发密钥 / 兼容修复。
    var pool = m.pool || {};
    var alist = (m.accounts || {}).list || [];
    var up = Number(m.uptimeMs) || 0;
    var rows = stRow('stGateway', up > 0 ? 'ok' : 'bad',
      T('stRunning') + ' ' + hms(up) + ' · ' + fmt(total) + ' ' + T('totalRequests'));
    var ph = Number(pool.healthy) || 0, ps = Number(pool.size) || 0;
    rows += stRow('stUpstream', ps > 0 ? (ph > 0 ? 'ok' : 'bad') : 'warn',
      ph + '/' + ps + ' ' + T('healthy'));
    var aok = 0, abad = 0, withK = 0;
    for (var j = 0; j < alist.length; j++) {
      var a = alist[j];
      if (!(a.keys && a.keys.length > 0)) continue;
      withK++;
      if (a.status === 'ok') aok++;
      else if (a.status !== 'unknown') abad++;
    }
    rows += stRow('stAccounts', withK > 0 ? (abad > 0 ? 'bad' : 'ok') : 'warn',
      withK > 0
        ? aok + '/' + withK + ' ' + T('healthy') + (abad > 0 ? ' · ' + abad + ' ' + T('stError') : '')
        : T('noAccounts'));
    rows += stRow('stDistKeys', tokensCache ? (active > 0 ? 'ok' : 'bad') : 'warn',
      tokensCache ? active + '/' + tokensCache.items.length + ' ' + T('tokenActive') : T('stLoading'));
    var fxNone = s.rewritten == null && s.stripped == null && s.compressed == null;
    rows += stRow('stFixes', fxNone ? 'warn' : 'ok',
      fxNone
        ? '—'
        : T('fixRewritten') + ' ' + fmt(s.rewritten || 0) + ' · ' +
          T('fixStripped') + ' ' + fmt(s.stripped || 0) + ' · ' +
          T('fixCompressed') + ' ' + fmt(s.compressed || 0));
    var sl = $('status-list');
    if (sl) sl.innerHTML = rows;
  }
  /** tokens 数据到达后刷新总览（费用/密钥卡 + 分发密钥状态行）。 */
  function refreshOverviewTokens() {
    if (lastMetrics) renderOverviewMetrics(lastMetrics, lastTrend);
  }

  // ── 总览性能仪表盘（/__admin/api/performance）──────────────────
  // 跟随 2s tick 拉取；服务端 10s TTL 兜底。区块被设置页开关隐藏时 tick 不拉。
  /** 卡片内部一行：label 在上，value 在下（value 已格式化好）。 */
  function perfCol(label, value) {
    return '<div class="perf-col"><div class="n">' + value + '</div><div class="l">' + label + '</div></div>';
  }
  /** 主题化 meter 条（0-100，可带 warn/danger 语义色）。 */
  function perfBar(pct, cls) {
    return '<div class="perf-meter"><div class="perf-meter-bg"><div class="perf-meter-fill' +
      (cls ? ' ' + cls : '') + '" style="width:' + pct + '%"></div></div></div>';
  }
  function renderPerf(d) {
    var el = $('perf');
    if (!el) return;
    var proc = d.process || {}, osd = d.os || {}, gw = d.gateway || {};
    var lat = d.latency || {}, pool = gw.pool || {};
    // RSS 条：相对 256M 上限（与服务端 PERF_RSS_CAP_BYTES 同基准）。
    var rssMb = (Number(proc.rss) || 0) / 1048576;
    var rssCap = 256;
    var rssPct = Math.min(100, rssMb / rssCap * 100);
    var cpu = Number(proc.cpuPercent) || 0;
    var up = Number(proc.uptime) || 0;
    var inflight = Number(gw.concurrentInFlight) || 0;
    var maxc = Math.max(1, Number(gw.maxConcurrent) || 1);
    var concPct = Math.min(100, inflight / maxc * 100);
    var load = Array.isArray(osd.loadAvg) ? osd.loadAvg.map(Number) : [0, 0, 0];
    var okp = Number(pool.healthy) || 0, totp = Number(pool.total) || 0;
    var dots = [];
    for (var i = 0; i < totp; i++) {
      dots.push('<span class="perf-dot' + (i < okp ? ' ok' : ' bad') + '"></span>');
    }
    var st = $('perf-status');
    if (st) {
      st.textContent = lat.available
        ? T('perfLatency') + ' · 5m · ' + fmt(lat.count) + ' ' + T('requests')
        : '—';
    }
    el.innerHTML =
      '<div class="perf-card"><div class="pc-l">' + T('perfRss') + '</div>' +
        '<div class="pc-v">' + rssMb.toFixed(1) + '<small> MB / ' + rssCap + '</small></div>' +
        perfBar(rssPct, rssPct >= 85 ? 'danger' : (rssPct >= 60 ? 'warn' : '')) + '</div>' +
      '<div class="perf-card"><div class="pc-l">' + T('perfCpu') + '</div>' +
        '<div class="pc-v">' + cpu.toFixed(1) + '%<small> ' + T('perfUptime') + ' ' + hms(up * 1000) + '</small></div>' +
        perfBar(cpu, cpu >= 70 ? 'danger' : (cpu >= 40 ? 'warn' : '')) + '</div>' +
      '<div class="perf-card"><div class="pc-l">' + T('perfLoad') + '</div>' +
        '<div class="perf-cols">' + perfCol('1m', load[0].toFixed(2)) + perfCol('5m', load[1].toFixed(2)) + perfCol('15m', load[2].toFixed(2)) + '</div></div>' +
      '<div class="perf-card"><div class="pc-l">' + T('perfConcurrent') + '</div>' +
        '<div class="pc-v">' + inflight + '<small> / ' + maxc + '</small></div>' +
        perfBar(concPct, concPct >= 80 ? 'danger' : (concPct >= 50 ? 'warn' : '')) + '</div>' +
      '<div class="perf-card"><div class="pc-l">' + T('perfLatency') + '</div>' +
        '<div class="perf-cols">' + perfCol('p50', msFmt(lat.p50Ms)) + perfCol('p95', msFmt(lat.p95Ms)) + perfCol('p99', msFmt(lat.p99Ms)) + '</div>' +
        '<div class="perf-col"><div class="l" style="margin-top:4px">max ' + msFmt(lat.maxMs) + '</div></div></div>' +
      '<div class="perf-card"><div class="pc-l">' + T('perfPool') + '</div>' +
        '<div class="pc-v">' + okp + '<small> / ' + totp + ' ' + T('healthy') + '</small></div>' +
        '<div class="perf-dots">' + dots.join('') + '</div></div>';
  }
  function fetchPerf() {
    if (!perfOn || curView !== 'overview') return;
    fetch('/__admin/api/performance', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))); })
      .then(function (d) {
        if (d && d.data) renderPerf(d.data);
        else { var st = $('perf-status'); if (st) st.textContent = '—'; }
      })
      .catch(function () { var st2 = $('perf-status'); if (st2) st2.textContent = '—'; });
  }
  /** 性能区块显隐 + 设置页开关状态 + 状态提示同步。 */
  function applyPerfVisibility() {
    var sec = $('sec-perf');
    if (sec) sec.hidden = !perfOn;
    var tg = $('perf-toggle');
    if (tg) {
      tg.setAttribute('data-on', perfOn ? '1' : '0');
      tg.setAttribute('aria-checked', perfOn ? 'true' : 'false');
      var sr = tg.querySelector('.oc-switch-sr');
      if (sr) sr.textContent = T(perfOn ? 'expOn' : 'expOff');
    }
    var hint = $('perf-state-hint');
    if (hint) hint.textContent = T(perfOn ? 'perfShow' : 'perfHide');
  }

  // ── 分发密钥（/__admin/api/tokens）：列表 / 创建 / 编辑 / 禁用 / 删除 ──
  // 刷新节奏与 previewCache 同款：进入 tab 时拉一次，60s 内缓存复用（tokens
  // 列表是分钟级变化的数据，不值得跟 2s tick 每轮重拉）；手动「刷新」强制重拉。
  var TOKENS_TTL = 60 * 1000;
  var tokensCache = null;  // {at, items}
  function findToken(id) {
    if (!tokensCache) return null;
    for (var i = 0; i < tokensCache.items.length; i++) {
      if (tokensCache.items[i].id === id) return tokensCache.items[i];
    }
    return null;
  }
  /** 配额显示解析（字段口径见 tokens.ts TokenQuotaView / QUOTA.md §1）：limit 0 = 无限
   *  （∞）；有上限的维度显示「已用/上限」。usedUsd/quotaUsd 都是**美元**（B1 后视图
   *  统一单位），直接 '$'+toFixed(2)，不再过 money()——money 吃 microCents，会把
   *  已转好的美元压成 $0.00。exhausted/expired/remainingUsd 由服务端按校验口径算好
   *  下发（tokens.ts computeQuotaStatus，与 quotaCheck 同源），前端不再手写
   *  ×1e8 对齐或 used≥limit 推导（B1 复发面）。t.quota 由 list 端点附带（服务端
   *  未就绪时缺字段按未设配额处理）。 */
  function quotaParts(t) {
    var qo = t.quota || {};
    var qUsd = Number(qo.quotaUsd) || 0;
    var qTok = Number(qo.quotaTokens) || 0;
    var qReq = Number(qo.quotaRequests) || 0;
    var qTpm = Number(qo.quotaTpm) || 0;
    var uUsd = Number(qo.usedUsd) || 0;
    var uTok = Number(qo.usedTokens) || 0;
    var uReq = Number(qo.usedRequests) || 0;
    var uTpm = Number(qo.usedTpm) || 0;
    var inf = '<span class="w">∞</span>';
    return {
      parts: [
        qUsd > 0 ? '$' + uUsd.toFixed(2) + '/' + '$' + qUsd.toFixed(2) : inf,
        qTok > 0 ? fmt(uTok) + '/' + fmt(qTok) + ' tok' : inf,
        qReq > 0 ? fmt(uReq) + '/' + fmt(qReq) + ' req' : inf,
        qTpm > 0 ? fmt(uTpm) + '/' + fmt(qTpm) + ' tpm' : inf
      ],
      // 状态判定直接读服务端算好的 exhausted/expired（与 quotaCheck 校验口径一致，
      // 跨周期窗口按 used=0 算，前端推导会误报）；remainingUsd 供徽章 tooltip。
      exhausted: !!qo.exhausted,
      expired: !!qo.expired,
      remainingUsd: qo.remainingUsd == null ? null : Number(qo.remainingUsd),
      any: qUsd > 0 || qTok > 0 || qReq > 0 || qTpm > 0
    };
  }
  /** 配额状态徽章：正常（绿）/ 已耗尽（amber st-limit）/ 已过期（红 st-invalid）。
   *  过期优先于耗尽；状态直接读服务端算好的 t.quota.expired/exhausted（tokens.ts
   *  computeQuotaStatus，B1 复发面——不再前端从 expiresAt + used≥limit 推导）。
   *  未设配额不显示徽章。 */
  function quotaBadge(t, q) {
    if (q.expired) return '<span class="oc-chip st-invalid">' + T('quotaBadgeExpired') + '</span>';
    if (q.any && q.exhausted) {
      var rem = q.remainingUsd == null ? '' : ' · ' + T('quotaRemaining') + q.remainingUsd.toFixed(2);
      return '<span class="oc-chip st-limit" title="' + T('quotaBadgeExhausted') + rem + '">' + T('quotaBadgeExhausted') + '</span>';
    }
    // 正常（绿）：设了配额，或设了过期日但还没到（expired=false 已排除过期）。
    // 有过期日的 token 即使没配额也显示 ok（保持旧行为），否则过期前无任何徽章。
    if (q.any || (Number((t.quota || {}).expiresAt) || 0) > 0) return '<span class="oc-chip st-ok">' + T('quotaBadgeOk') + '</span>';
    return '';
  }
  function tokenRow(t) {
    var u = t.usage || {};
    var cost = u.costMicroCents != null ? money(u.costMicroCents) : '—';
    var req = u.requests != null ? fmt(u.requests) : '—';
    var tok = (u.inputTokens != null || u.outputTokens != null)
      ? fmt((Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0))
      : '—';
    var stBadge = t.status === 'active'
      ? '<span class="oc-chip tok-active">' + T('tokenActive') + '</span>'
      : '<span class="oc-chip tok-disabled">' + T('tokenDisabled') + '</span>';
    var toggle = t.status === 'active'
      ? '<button class="oc-btn oc-btn-ghost" data-action="toggle-token" data-id="' + t.id + '">' + T('tokenDisable') + '</button>'
      : '<button class="oc-btn oc-btn-ghost" data-action="toggle-token" data-id="' + t.id + '">' + T('tokenEnable') + '</button>';
    // RPM：每行一个限流输入（0 = 不限），保存走 PATCH rpmLimit。
    var rpm = '<td class="t-rpm">' +
      '<input class="oc-input" type="number" min="0" step="1" value="' + (Number(t.rpmLimit) || 0) + '"' +
        ' data-rpm-id="' + t.id + '" placeholder="0" title="' + T('tokenRpmHint') + '" autocomplete="off" aria-label="' + T('tokenRpm') + '">' +
      '<button class="oc-btn oc-btn-ghost oc-btn-sm t-rpm-save" data-action="set-rpm" data-id="' + t.id + '" title="' + T('tokenRpmHint') + '">' + T('save') + '</button>' +
      '</td>';
    // 配额列：已用/上限（∞ = 不限）+ 状态徽章；未设配额显示中性占位。
    var q = quotaParts(t);
    var qb = quotaBadge(t, q);
    var quota = '<td class="t-quota"><div>' +
      (q.any ? q.parts.join(' · ') : '<span class="w">' + T('quotaNone') + '</span>') +
      '</div>' + (qb ? '<div class="t-quota-badge">' + qb + '</div>' : '') + '</td>';
    return '<tr>' +
      '<td class="t-name">' + esc(t.name) + '</td>' +
      '<td>' + stBadge + '</td>' +
      '<td class="tok-mask">' + esc(t.mask) +
        ' <button class="oc-btn oc-btn-ghost oc-btn-sm" data-action="copy-token" data-id="' + t.id + '" title="' + T('tokenCopyTitle') + '">' + T('tokenCopy') + '</button>' +
      '</td>' +
      '<td>' + cost + ' · ' + req + ' · ' + tok + '</td>' +
      quota +
      '<td class="t-hide">' + dateFmt(t.createdAt) + '</td>' +
      rpm +
      '<td>' + toggle +
        ' <button class="oc-btn oc-btn-ghost" data-action="edit-token" data-id="' + t.id + '">' + T('edit') + '</button>' +
        ' <button class="oc-btn oc-btn-ghost oc-btn-sm t-del" data-action="del-token" data-id="' + t.id + '">' + T('delete') + '</button>' +
      '</td>' +
      '</tr>';
  }
  /** 分发 key 渲染指纹：任何字段变化都触发重建；数据没变保留 DOM——
   *  否则 2s 轮询会把用户正在输入的 RPM 值清回缓存值（对抗审查 B1）。 */
  function tokenFingerprint(items) {
    return (items || []).map(function (t) {
      return [t.id, t.name, t.status, t.mask, t.rpmLimit,
        JSON.stringify(t.quota || null),
        t.usage ? [t.usage.costMicroCents, t.usage.requests, t.usage.inputTokens, t.usage.outputTokens].join(':') : '',
        JSON.stringify((t.keys || []).map(function (k) {
          return [k.fingerprint, k.healthy, k.nickname].join(':');
        }))].join('|');
    }).join(';');
  }
  var lastTokenFp = null;
  function renderTokens(items) {
    var tb = $('tokens-rows');
    var empty = $('tokens-empty');
    if (!tb || !empty) return;
    var fp = tokenFingerprint(items);
    if (fp === lastTokenFp) return;
    lastTokenFp = fp;
    empty.hidden = items.length > 0;
    tb.innerHTML = items.map(tokenRow).join('');
    // RPM 输入的自绘 spinner：重建后重挂（幂等，指纹不变时跳过无副作用）。
    mountNumSpinners(tb);
    // RPM 列头 tooltip（静态 HTML 里拿不到 T()，渲染时补 title）。
    var th = document.querySelector('.t-rpm-hd');
    if (th) th.title = T('tokenRpmHint');
  }
  function loadTokens(force) {
    if (!force && tokensCache && Date.now() - tokensCache.at < TOKENS_TTL) {
      renderTokens(tokensCache.items);
      refreshOverviewTokens();
      return;
    }
    api('GET', '/__admin/api/tokens', null).then(function (r) {
      if (r.ok && r.json && r.json.data && Array.isArray(r.json.data.items)) {
        tokensCache = { at: Date.now(), items: r.json.data.items };
        renderTokens(tokensCache.items);
        refreshOverviewTokens();
      } else if (r.status === 503) {
        // 数据面未接线/不可用：列表给提示，总览卡保持 —。
        var empty = $('tokens-empty');
        if (empty) { empty.hidden = false; empty.textContent = T('tokensUnavailable'); }
      }
    });
  }
  /** 创建（批量 1-10）：逐个 POST；每个 token 明文只在它自己的创建响应出现，
   *  全部成功后统一展示一次（plain-overlay），关闭即无法再取回。 */
  function createTokens() {
    openConfirm({
      title: T('tokensTitle'),
      okText: T('tokenCreate'),
      body: '<div class="oc-form">' +
        '<div class="oc-field oc-full"><label for="tok-name">' + T('tokenName') + '</label>' +
          '<input class="oc-input" id="tok-name" autocomplete="off"></div>' +
        '<div class="oc-field oc-full"><label for="tok-count">' + T('tokenCount') + '</label>' +
          '<input class="oc-input" id="tok-count" type="number" min="1" max="10" step="1" value="1" autocomplete="off"></div>' +
        '<div class="oc-field oc-full"><label for="tok-custom">' + T('tokenCustomKey') + '</label>' +
          '<input class="oc-input" id="tok-custom" placeholder="' + T('tokenCustomKeyPlaceholder') + '" autocomplete="off"></div>' +
        '</div>',
      run: function () {
        var name = $('tok-name').value.trim();
        var count = Math.floor(Number($('tok-count').value));
        if (!name) { $('confirm-err').textContent = T('tokenNameRequired'); unlockConfirm(); return; }
        if (!(count >= 1 && count <= 10)) { $('confirm-err').textContent = T('tokenCountInvalid'); unlockConfirm(); return; }
        var plain = [];
        var step = function (i) {
          if (i >= count) { showTokenPlain(plain); return; }
          var nm = count > 1 ? name + '-' + (i + 1) : name;
          var ck = $('tok-custom') ? $('tok-custom').value.trim() : '';
          // 自定义 key 只在 count=1 时有意义（批量多个用同一值会撞指纹——后端拒绝）。
          var body = { name: nm };
          if (ck && count === 1) body.customKey = ck;
          api('POST', '/__admin/api/tokens', body).then(function (r) {
            if (r.ok && r.json && r.json.data && r.json.data.token) {
              plain.push({ name: r.json.data.name || nm, token: r.json.data.token });
              step(i + 1);
            } else if (plain.length > 0) {
              // 部分失败：已创建成功的明文必须先展示（否则这批明文永远拿不回）。
              showTokenPlain(plain);
              flash(errMsg(r), true);
            } else {
              unlockConfirm();
              $('confirm-err').textContent = errMsg(r);
            }
          });
        };
        step(0);
      }
    });
  }
  function showTokenPlain(plain) {
    closeConfirm();
    $('plain-hint').textContent = T('tokenPlainOnlyOnce');
    $('plain-list').innerHTML = plain.map(function (p, i) {
      return '<div class="plain-row"><span class="w">' + esc(p.name) + '</span>' +
        '<code class="plain-key">' + esc(p.token) + '</code>' +
        '<button class="oc-btn oc-btn-ghost" data-copy="' + i + '">' + T('tokenCopy') + '</button></div>';
    }).join('');
    // 明文只进 dataset（供复制按钮读），不留在 DOM 文本之外的地方。
    $('plain-list').dataset.plain = JSON.stringify(plain);
    $('plain-overlay').hidden = false;
    flash(T('tokenCreated'));
    // 新 key 已落库，强制刷新列表与总览（60s 缓存挡不住创建后的变化）。
    loadTokens(true);
  }
  function copyPlain(i, btn) {
    var plain = [];
    try { plain = JSON.parse($('plain-list').dataset.plain || '[]'); } catch (e) {}
    var row = plain[i];
    if (!row) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(row.token).then(function () {
        if (btn) btn.textContent = T('tokenCopied');
      }, function () { flash(T('opFail'), true); });
    } else {
      flash(T('opFail'), true);
    }
  }
  function editToken(id) {
    var t = findToken(id);
    if (!t) return;
    var qo = t.quota || {};
    var cyc = [['none', 'quotaCycleNone'], ['daily', 'quotaCycleDaily'], ['monthly', 'quotaCycleMonthly']];
    var cycOpts = cyc.map(function (c) {
      return '<option value="' + c[0] + '"' + ((qo.cycle || 'none') === c[0] ? ' selected' : '') + '>' +
        esc(T(c[1])) + '</option>';
    }).join('');
    var exp = Number(qo.expiresAt) || 0;
    var expVal = '';
    if (exp > 0) {
      var ed = new Date(exp), ep = function (n) { return (n < 10 ? '0' : '') + n; };
      expVal = ed.getFullYear() + '-' + ep(ed.getMonth() + 1) + '-' + ep(ed.getDate());
    }
    openConfirm({
      title: T('tokenEditTitle'),
      okText: T('save'),
      body: '<div class="oc-form">' +
        '<div class="oc-field oc-full"><label for="tok-edit-name">' + T('tokenName') + '</label>' +
          '<input class="oc-input" id="tok-edit-name" value="' + esc(t.name) + '" autocomplete="off"></div>' +
        '<div class="oc-field oc-full"><label for="tok-edit-note">' + T('tokenNote') + '</label>' +
          '<input class="oc-input" id="tok-edit-note" value="' + esc(t.note || '') + '" placeholder="' + T('tokenNotePlaceholder') + '" autocomplete="off"></div>' +
        '<div class="oc-hint oc-full t-quota-sect" style="margin-top:6px">' + T('quota') + '</div>' +
        '<div class="oc-field"><label for="tok-edit-qusd">' + T('quotaUsd') + '</label>' +
          '<input class="oc-input" id="tok-edit-qusd" type="number" min="0" step="0.01" value="' + (Number(qo.quotaUsd) || 0) + '" autocomplete="off"></div>' +
        '<div class="oc-field"><label for="tok-edit-qtok">' + T('quotaTokens') + '</label>' +
          '<input class="oc-input" id="tok-edit-qtok" type="number" min="0" step="1" value="' + (Number(qo.quotaTokens) || 0) + '" autocomplete="off"></div>' +
        '<div class="oc-field"><label for="tok-edit-qreq">' + T('quotaRequests') + '</label>' +
          '<input class="oc-input" id="tok-edit-qreq" type="number" min="0" step="1" value="' + (Number(qo.quotaRequests) || 0) + '" autocomplete="off"></div>' +
        '<div class="oc-field"><label for="tok-edit-cycle">' + T('quotaCycle') + '</label>' +
          '<select class="oc-select" id="tok-edit-cycle">' + cycOpts + '</select></div>' +
        '<div class="oc-field"><label for="tok-edit-expires">' + T('quotaExpires') + '</label>' +
          '<input class="oc-input" id="tok-edit-expires" type="date" value="' + expVal + '" autocomplete="off"></div>' +
        '<div class="oc-field"><label for="tok-edit-qpm">' + T('quotaTpm') + '</label>' +
          '<input class="oc-input" id="tok-edit-qpm" type="number" min="0" step="1" value="' + (Number(qo.quotaTpm) || 0) + '" autocomplete="off"></div>' +
        '<div class="oc-field"><label for="tok-edit-ip">' + T('ipWhitelist') + '</label>' +
          '<input class="oc-input" id="tok-edit-ip" value="' + esc((qo.ipWhitelist || []).join(', ')) + '" placeholder="' + esc(T('ipWhitelistHint')) + '" autocomplete="off"></div>' +
        '<div class="oc-field oc-full"><div class="oc-hint">' + T('quotaHint') + ' · ' + T('quotaExpiresHint') + ' · ' + T('ipWhitelistHint') + '</div></div>' +
        '</div>',
      run: function () {
        var name = $('tok-edit-name').value.trim();
        var note = $('tok-edit-note').value.trim();
        if (!name) { $('confirm-err').textContent = T('tokenNameRequired'); unlockConfirm(); return; }
        var qUsdRaw = $('tok-edit-qusd').value.trim();
        var qTokRaw = $('tok-edit-qtok').value.trim();
        var qReqRaw = $('tok-edit-qreq').value.trim();
        var qUsd = Number(qUsdRaw), qTok = Number(qTokRaw), qReq = Number(qReqRaw);
        // $ 配额允许小数，token/请求/TPM 配额必须是非负整数；空 = 0 = 不限。
        if (qUsdRaw !== '' && (!isFinite(qUsd) || qUsd < 0)) { $('confirm-err').textContent = T('quotaInvalid'); unlockConfirm(); return; }
        if (qTokRaw !== '' && (!isFinite(qTok) || qTok < 0 || Math.floor(qTok) !== qTok)) { $('confirm-err').textContent = T('quotaInvalid'); unlockConfirm(); return; }
        if (qReqRaw !== '' && (!isFinite(qReq) || qReq < 0 || Math.floor(qReq) !== qReq)) { $('confirm-err').textContent = T('quotaInvalid'); unlockConfirm(); return; }
        var qpmRaw = $('tok-edit-qpm').value.trim();
        var qpm = Number(qpmRaw);
        if (qpmRaw !== '' && (!isFinite(qpm) || qpm < 0 || Math.floor(qpm) !== qpm)) { $('confirm-err').textContent = T('quotaInvalid'); unlockConfirm(); return; }
        // IP 白名单：逗号分隔 → 去空白非空数组（空 = 不限）。
        var ipList = ($('tok-edit-ip').value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        // 过期日期：留空 = 0 = 永久；有值按本地零点转时间戳。
        var expRaw = $('tok-edit-expires').value;
        var expTs = expRaw ? new Date(expRaw + 'T00:00:00').getTime() : 0;
        api('PATCH', '/__admin/api/tokens/' + id, { name: name, note: note || null, quotaUsd: qUsdRaw === '' ? 0 : qUsd, quotaTokens: qTokRaw === '' ? 0 : qTok, quotaRequests: qReqRaw === '' ? 0 : qReq, quotaTpm: qpmRaw === '' ? 0 : qpm, ipWhitelist: ipList, cycle: $('tok-edit-cycle').value, expiresAt: expTs })
          .then(function (r) { tokDone(r, T('quotaSaved')); });
      }
    });
  }
  function toggleToken(id) {
    var t = findToken(id);
    if (!t) return;
    var to = t.status === 'active' ? 'disabled' : 'active';
    api('PATCH', '/__admin/api/tokens/' + id, { status: to }).then(function (r) {
      tokDone(r, to === 'disabled' ? T('tokenDisabledMsg') : T('tokenEnabled'));
    });
  }
  function delToken(id) {
    var t = findToken(id);
    if (!t) return;
    openConfirm({
      title: T('tokensTitle'),
      okText: T('delete'),
      danger: true,
      body: '<div class="oc-hint">' + T('tokenDeleteConfirm') + '</div>',
      run: function () {
        api('DELETE', '/__admin/api/tokens/' + id, null).then(function (r) { tokDone(r, T('tokenDeleted')); });
      }
    });
  }
  /** tokens 写操作统一收尾：成功 → 关弹层 + flash + 强制重拉列表（含总览）。 */
  function tokDone(r, okMsg) {
    if (r.ok) {
      closeConfirm();
      flash(okMsg);
      loadTokens(true);
    } else {
      unlockConfirm();
      $('confirm-err').textContent = errMsg(r);
    }
  }

  // ── model access（MODEL-ACCESS §6）────────────────────
  // 数据静态（配置），不做 2s tick 轮询；进 tab / 写操作后局部刷新。
  var maData = null;
  var maGlobalSel = null; // null = 未改动（从数据初始化）；数组 = 已 toggle
  var maSearch = '';
  var maFilter = '';
  var maEdit = null; // { type, subject, cur:[models] }（编辑 modal 内状态）
  // 上游定价模型名（console models-pricing 加载时收集）——「添加模型」输入框的
  // 自动补全候选。没加载过就只用手动输入（全局白名单已可扩展任意合法模型名）。
  var maPricingModels = [];
  function maHas(list, m) { return list.indexOf(m) >= 0; }
  function maToggleSel(m) {
    if (maGlobalSel == null) maGlobalSel = (maData.global.models || []).slice();
    var i = maGlobalSel.indexOf(m);
    if (i >= 0) maGlobalSel.splice(i, 1);
    else maGlobalSel.push(m);
    renderMaGlobal();
  }
  function loadModelAccess() {
    api('GET', '/__admin/api/model-access', null).then(function (r) {
      if (r.ok && r.json && r.json.data) {
        maData = r.json.data;
        maGlobalSel = null;
        renderModelAccess();
      } else {
        flash(errMsg(r), true);
      }
    });
  }
  function renderModelAccess() {
    if (!maData) return;
    var se = $('ma-search');
    if (se) se.placeholder = T('maSearchPh');
    renderMaGlobal();
    renderMaSection($('ma-upstream'), maData.keys.upstreamKeys, 'upstream-key', maUpstreamLabel);
    renderMaSection($('ma-token'), maData.keys.tokens, 'token', maTokenLabel);
    renderMaSection($('ma-apikey'), maData.keys.apiKeys, 'api-key', maApiKeyLabel);
  }
  function renderMaGlobal() {
    if (!maData) return;
    var g = maData.global;
    var core = g.core || [];
    var sel = maGlobalSel == null ? (g.models || []) : maGlobalSel;
    // 渲染当前选中集（含添加的非默认模型）：chip 带 × 可移除；空集显示提示。
    $('ma-global-chips').innerHTML = sel.length
      ? sel.map(function (m) {
          return '<button type="button" class="ma-chip on" data-model="' + esc(m) + '">' +
            esc(m) + '<span class="ma-x">&times;</span></button>';
        }).join('')
      : '<span class="oc-hint">' + T('maGlobalEmpty') + '</span>';
    $('ma-global-hint').textContent = T('maGlobalFloor') + core.join(', ');
    renderMaGlobalOptions();
    renderMaAvail();
  }
  /** 「可选模型」网格：上游全部模型（maData.pricing，62 个）——已选高亮，未选点击添加；
   *  支持搜索过滤。pricing 缺失（无账号/失败）时网格隐藏，回退 datalist 手动添加。 */
  var maAvailQuery = '';
  function renderMaAvail() {
    var grid = $('ma-avail-grid');
    if (!grid) return;
    var pricing = (maData && maData.pricing) || [];
    if (!pricing.length) { grid.innerHTML = ''; return; }
    var sel = maGlobalSel == null ? (maData.global.models || []) : maGlobalSel;
    var q = maAvailQuery.toLowerCase();
    var chips = pricing
      .filter(function (m) { return !q || m.toLowerCase().indexOf(q) >= 0; })
      .map(function (m) {
        var on = sel.indexOf(m) >= 0;
        return '<button type="button" class="ma-chip' + (on ? ' on' : '') + '" data-model="' + esc(m) + '">' +
          esc(m) + (on ? '<span class="ma-x">&times;</span>' : '') + '</button>';
      })
      .join('');
    grid.innerHTML = chips || '<span class="oc-hint">' + esc(T('maNoMatch')) + '</span>';
    var s = $('ma-avail-search');
    if (s && s.value !== maAvailQuery) s.value = maAvailQuery;
  }
  /** 「添加模型」输入框的自动补全候选：pricing 模型（若已加载）+ 服务端可选项 + 当前选中。 */
  function renderMaGlobalOptions() {
    var dl = $('ma-global-options');
    if (!dl) return;
    var seen = {};
    var out = [];
    function push(m) { if (m && !seen[m]) { seen[m] = 1; out.push(m); } }
    for (var i = 0; i < maPricingModels.length; i++) push(maPricingModels[i]);
    var base = maData.models || [];
    for (var j = 0; j < base.length; j++) push(base[j]);
    var sel = maGlobalSel == null ? (maData.global.models || []) : maGlobalSel;
    for (var k = 0; k < sel.length; k++) push(sel[k]);
    dl.innerHTML = out.sort().map(function (m) { return '<option value="' + esc(m) + '"></option>'; }).join('');
  }
  /** 添加模型：逗号分隔输入，逐个过与 settings 同款校验（/^[a-z0-9._-]+$/ ≤100），
   *  合法才进 maGlobalSel（保存时 PUT 全局白名单）。非法项 flash 提示。 */
  function addMaGlobalModels() {
    var input = $('ma-global-add');
    if (!input) return;
    var raw = (input.value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!raw.length) return;
    if (maGlobalSel == null) maGlobalSel = (maData.global.models || []).slice();
    var bad = [];
    for (var i = 0; i < raw.length; i++) {
      var m = raw[i];
      if (m.length > 100 || !/^[a-z0-9._-]+$/.test(m)) { bad.push(m); continue; }
      if (!maHas(maGlobalSel, m)) maGlobalSel.push(m);
    }
    input.value = '';
    renderMaGlobal();
    if (bad.length) flash(T('maAddInvalid') + bad.join(', '), true);
  }
  function maUpstreamLabel(k) {
    return esc(k.fingerprint) + (k.accountName ? ' <span class="w">· ' + esc(k.accountName) + '</span>' : '');
  }
  function maTokenLabel(k) {
    return esc(k.name || k.mask);
  }
  function maApiKeyLabel(k) {
    return esc(k.mask);
  }
  function maSectionVisible(type) {
    return maFilter === '' || maFilter === type;
  }
  function maKeyRow(k, type, label) {
    var badges = '';
    if (type === 'token') {
      badges = k.status === 'active'
        ? '<span class="oc-chip st-ok">' + T('tokenActive') + '</span>'
        : '<span class="oc-chip st-invalid">' + T('tokenDisabled') + '</span>';
    }
    badges += k.custom
      ? '<span class="oc-chip st-ok">' + T('maCustomBadge') + '</span>'
      : '<span class="oc-chip">' + T('maFollowsGlobal') + '</span>';
    return '<div class="key-row">' +
      '<span class="fp">' + label + '</span>' +
      badges +
      '<span class="k-meta">' + esc(k.mask || '') + '</span>' +
      '<button class="oc-btn oc-btn-ghost oc-btn-sm del" data-action="ma-edit" data-type="' + type + '"' +
        ' data-subject="' + esc(k.subject || k.fingerprint || '') + '" data-name="' + esc(k.name || '') + '"' +
        ' data-mask="' + esc(k.mask || '') + '">' + T('edit') + '</button>' +
      '</div>';
  }
  function maKeyMatches(k, q) {
    if (!q) return true;
    return (k.name || '').toLowerCase().indexOf(q) >= 0 ||
      (k.mask || '').toLowerCase().indexOf(q) >= 0 ||
      (k.accountName || '').toLowerCase().indexOf(q) >= 0;
  }
  function renderMaSection(el, rows, type, labelFn) {
    if (!el) return;
    if (!maSectionVisible(type)) { el.innerHTML = ''; return; }
    var q = maSearch.toLowerCase();
    var filtered = rows.filter(function (k) { return maKeyMatches(k, q); });
    el.innerHTML = filtered.length
      ? filtered.map(function (k) { return maKeyRow(k, type, labelFn(k)); }).join('')
      : (rows.length ? '<div class="oc-hint">' + T('maNoMatch') + '</div>' : '<div class="oc-hint">' + T('maEmpty') + '</div>');
  }
  function saveMaGlobal() {
    if (maGlobalSel == null) maGlobalSel = (maData.global.models || []).slice();
    api('PUT', '/__admin/api/model-access/global', { models: maGlobalSel.length ? maGlobalSel : null })
      .then(function (r) {
        if (r.ok) { flash(T('maGlobalSaved')); loadModelAccess(); }
        else flash(errMsg(r), true);
      });
  }
  function resetMaGlobal() {
    api('PUT', '/__admin/api/model-access/global', { models: null })
      .then(function (r) {
        if (r.ok) { flash(T('maGlobalSaved')); loadModelAccess(); }
        else flash(errMsg(r), true);
      });
  }
  function renderMaEditChips() {
    if (!maEdit) return;
    var all = maData.models || [];
    var glob = maData.global.models || [];
    $('ma-edit-chips').innerHTML = all.map(function (m) {
      var on = maHas(maEdit.cur, m);
      var grantable = maHas(glob, m);
      return '<button type="button" class="ma-chip' + (on ? ' on' : ' off') + (grantable ? '' : ' dis') + '"' +
        ' data-ma-opt="' + esc(m) + '"' + (grantable ? '' : ' disabled') + '>' +
        esc(m) + (on ? '<span class="ma-x">&times;</span>' : '') + '</button>';
    }).join('');
  }
  function editModelAccess(type, subject, name, mask) {
    var rows = maData.keys[type === 'token' ? 'tokens' : type === 'api-key' ? 'apiKeys' : 'upstreamKeys'];
    var cur = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if ((row.subject || row.fingerprint || '') === subject && row.custom) cur = row.custom.slice();
    }
    maEdit = { type: type, subject: subject, cur: cur };
    openConfirm({
      title: T('maEditTitle') + ' — ' + (name || mask || subject.slice(-8)),
      okText: T('save'),
      body: '<div class="ma-chips" id="ma-edit-chips"></div>' +
        '<div class="oc-hint">' + T('maNotGrantable') + '</div>' +
        '<button type="button" class="oc-btn oc-btn-ghost" data-ma-clear data-type="' + type + '" data-subject="' + esc(subject) + '">' + T('maFollowGlobal') + '</button>',
      run: function () {
        api('PUT', '/__admin/api/model-access/keys/' + type + '/' + encodeURIComponent(subject), { models: maEdit.cur.length ? maEdit.cur : null })
          .then(function (r) {
            if (r.ok) { closeConfirm(); flash(T('maSaved')); loadModelAccess(); }
            else { unlockConfirm(); $('confirm-err').textContent = errMsg(r); }
          });
      }
    });
    renderMaEditChips();
  }

  // ── 请求明细（/__admin/api/requests，按 at 倒序）──
  // 字段契约：{at, status, path, durationMs, inputTokens, outputTokens, model,
  // fingerprint, ua, client, endpoint, error}；client/ua 由服务端解析。
  // 分页/搜索：pageSize 可切 20/50/100，q 过滤 path/status/model/client/ua（不区分大小写）。
  var REQ_PAGE_SIZE = 20;
  var reqPage = 1, reqTotal = 0, reqQuery = '', reqShowAll = false;
  var reqSearchTimer = 0;
  function renderRequests(items) {
    var el = $('u-events');
    if (!el) return;
    if (!items.length) {
      el.innerHTML = '<div class="oc-hint">' + T('noRequests') + '</div>';
      return;
    }
    el.innerHTML = items.map(function (e) {
      var good = e.status >= 200 && e.status < 400;
      // 第二行细节：模型/key 指纹/端点/UA 原文/错误（flex-wrap，不挤不叠）。
      var detail = [
        e.client ? '<span>' + esc(e.client) + '</span>' : '',
        e.model ? '<span>' + esc(e.model) + '</span>' : '',
        e.endpoint && e.endpoint !== '-' ? '<span>' + esc(e.endpoint) + '</span>' : '',
        e.fingerprint ? '<span>' + T('reqKey') + ' ' + esc(e.fingerprint) + '</span>' : '',
        e.ua ? '<span class="cut">' + esc(e.ua) + '</span>' : '',
        e.error ? '<span class="s-bad">' + esc(e.error) + '</span>' : ''
      ].filter(Boolean).join('');
      return '<div class="lent">' +
        '<span class="w">' + hhmmss(e.at) + '</span>' +
        '<span class="' + (good ? 's-ok' : 's-bad') + '">' + e.status + '</span>' +
        '<span class="grow cut">' + esc(e.path) + '</span>' +
        '<span class="h-ms">' + (e.durationMs != null ? msFmt(e.durationMs) : '—') + '</span>' +
        '<span class="h-tok">' + fmt(e.inputTokens) + '/' + fmt(e.outputTokens) + '</span>' +
        '<span class="h-client cut">' + esc(e.client || '—') + '</span>' +
        (detail ? '<span class="r2">' + detail + '</span>' : '') +
        '</div>';
    }).join('');
  }
  /** 分页信息 + 跳页输入框 + 上一页/下一页按钮禁用态。 */
  function renderReqNav() {
    var pages = reqTotal ? Math.max(1, Math.ceil(reqTotal / REQ_PAGE_SIZE)) : 1;
    var info = $('req-info');
    if (info) info.textContent = T('reqPage') + ' ' + reqPage + ' / ' + pages + ' · ' + reqTotal + ' ' + T('requests');
    var pp = $('req-page');
    if (pp) { pp.value = reqPage; pp.max = pages; }
    var prev = $('req-prev'), next = $('req-next');
    if (prev) prev.disabled = reqPage <= 1;
    if (next) next.disabled = reqPage >= pages;
  }
  /** 跳页：输入框值钳到 [1, 总页数]，越界收敛。 */
  function goReqPage() {
    var pp = $('req-page');
    var v = Math.floor(Number(pp ? pp.value : NaN));
    var pages = reqTotal ? Math.max(1, Math.ceil(reqTotal / REQ_PAGE_SIZE)) : 1;
    if (!isFinite(v) || v < 1) return;
    reqPage = Math.min(v, pages);
    fetchRequests();
  }
  function fetchRequests() {
    var url = '/__admin/api/requests?page=' + reqPage + '&pageSize=' + REQ_PAGE_SIZE +
      '&filter=' + (reqShowAll ? 'all' : 'important') +
      (reqQuery ? '&q=' + encodeURIComponent(reqQuery) : '');
    api('GET', url, null).then(function (r) {
      if (r.ok && r.json && r.json.ok !== false && r.json.data) {
        var d = r.json.data;
        reqTotal = Number(d.total) || 0;
        // 数据增长后 total 变大，钳制超界页码（只收敛一次：钳后必在界内）。
        var pages = reqTotal ? Math.ceil(reqTotal / REQ_PAGE_SIZE) : 1;
        if (reqPage > pages) { reqPage = pages; fetchRequests(); return; }
        renderRequests(d.items || []);
        renderReqNav();
      } else {
        var el = $('u-events');
        if (el) el.innerHTML = '<div class="oc-hint oc-hint-err">' + esc(errMsg(r)) + '</div>';
      }
    }).catch(function () {});
  }

  // ── IP 统计（/__admin/api/requests/stats-by-ip，按 ip 聚合的流量）──
  // 契约：{ok, data:{items:[{ip, requests, inputTokens, outputTokens, clients, lastAt}],
  // total, page, pageSize}}。点 IP → 请求明细列表按该 IP 搜索（q=<ip>）。
  var IP_PAGE_SIZE = 20;
  var ipPage = 1, ipTotal = 0;
  function renderIpStats(items) {
    var rows = $('ip-rows'), empty = $('ip-empty');
    if (!rows || !empty) return;
    empty.hidden = items.length > 0;
    rows.innerHTML = items.map(function (r) {
      var tok = (Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0);
      var clients = (r.clients || []).filter(Boolean).slice(0, 3).join(' · ');
      return '<tr>' +
        '<td><span class="ip-link" data-ip="' + esc(r.ip) + '" title="' + T('ipFilterHint') + '">' + esc(r.ip) + '</span></td>' +
        '<td>' + fmt(r.requests) + '</td>' +
        '<td>' + fmt(tok) + '</td>' +
        '<td class="t-hide cut">' + esc(clients || '—') + '</td>' +
        '<td>' + hhmmss(r.lastAt) + '</td>' +
        '</tr>';
    }).join('');
  }
  function renderIpNav() {
    var pages = ipTotal ? Math.max(1, Math.ceil(ipTotal / IP_PAGE_SIZE)) : 1;
    var info = $('ip-info');
    if (info) info.textContent = T('reqPage') + ' ' + ipPage + ' / ' + pages + ' · ' + ipTotal + ' ' + T('requests');
    var prev = $('ip-prev'), next = $('ip-next');
    if (prev) prev.disabled = ipPage <= 1;
    if (next) next.disabled = ipPage >= pages;
  }
  function fetchIpStats() {
    api('GET', '/__admin/api/requests/stats-by-ip?page=' + ipPage + '&pageSize=' + IP_PAGE_SIZE, null).then(function (r) {
      if (r.ok && r.json && r.json.ok !== false && r.json.data) {
        var d = r.json.data;
        ipTotal = Number(d.total) || 0;
        var pages = ipTotal ? Math.ceil(ipTotal / IP_PAGE_SIZE) : 1;
        if (ipPage > pages) { ipPage = pages; fetchIpStats(); return; }
        renderIpStats(d.items || []);
        renderIpNav();
      }
    }).catch(function () {});
  }
  /** 点 IP → 请求明细按该 IP 搜索（q=<ip>）并滚到明细区。 */
  function filterByIp(ip) {
    // 清掉可能还挂着的搜索防抖 timer：否则 400ms 后它会把 reqQuery 覆盖回旧输入。
    clearTimeout(reqSearchTimer);
    reqQuery = ip;
    reqPage = 1;
    var q = $('req-q');
    if (q) q.value = ip;
    fetchRequests();
    var sec = $('sec-usage-recent');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── 操作审计（/__admin/api/audit，管理面写操作的脱敏留痕）──
  // 契约：{ok, data:{items:[{at, op, accountId, accountName, ok, note, ip}]}}。
  // 只显示最近操作（谁 · 什么时候 · 做了什么）；金额/cookie 等敏感值绝不进库，
  // op + note 都是脱敏摘要。写操作后 tick 每 2s 轮询刷新。
  function renderAudit(items) {
    var el = $('audit-events');
    if (!el) return;
    if (!items || !items.length) {
      el.innerHTML = '<div class="oc-hint">' + T('auditEmpty') + '</div>';
      return;
    }
    el.innerHTML = items.map(function (e) {
      var acc = e.accountName ? esc(e.accountName)
        : (e.accountId != null ? '#' + e.accountId : '—');
      var note = e.note ? '<span class="s-bad">' + esc(e.note) + '</span>' : '';
      var detail = [acc, e.ip ? esc(e.ip) : '', note].filter(Boolean).join(' · ');
      return '<div class="lent">' +
        '<span class="w">' + hhmmss(e.at) + '</span>' +
        '<span class="grow cut">' + esc(e.op) + '</span>' +
        '<span class="' + (e.ok ? 's-ok' : 's-bad') + '">' + (e.ok ? T('auditOk') : T('auditFail')) + '</span>' +
        '<span class="h-client cut">' + detail + '</span>' +
        '</div>';
    }).join('');
  }
  function fetchAudit() {
    fetch('/__admin/api/audit?limit=50', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.ok !== false && d.data) renderAudit(d.data.items);
      })
      .catch(function () {});
  }

  // ── 模型映射（设置页）：GET 列表 + POST 添加/更新 + PUT 修改 + DELETE 删除 ──
  function loadModelAliases() {
    return api('GET', '/__admin/api/model-aliases', null).then(function (r) {
      return r.ok && r.json && Array.isArray(r.json.aliases) ? r.json.aliases : [];
    });
  }
  /** 当前映射列表（编辑弹层取当前 target/note 用；renderModelMap 每次更新）。 */
  var mmList = [];
  function renderModelMap(list) {
    mmList = list;
    var tb = $('mm-rows');
    var empty = $('mm-empty');
    if (!tb || !empty) return;
    empty.hidden = list.length > 0;
    tb.innerHTML = list.map(function (m) {
      return '<tr>' +
        '<td>' + esc(m.alias) + '</td>' +
        '<td>' + esc(m.target) + '</td>' +
        '<td class="t-hide">' + esc(m.note || '') + '</td>' +
        '<td>' +
          '<button class="oc-btn oc-btn-ghost" data-action="edit-alias" data-alias="' + esc(m.alias) + '">' + T('edit') + '</button>' +
          ' <button class="oc-btn oc-btn-ghost oc-btn-sm t-del" data-action="del-alias" data-alias="' + esc(m.alias) + '">' + T('delete') + '</button>' +
        '</td>' +
        '</tr>';
    }).join('');
  }
  function refreshModelMap() {
    loadModelAliases().then(renderModelMap);
  }
  function addModelAlias() {
    var alias = $('mm-alias').value.trim();
    var target = $('mm-target').value.trim();
    var note = $('mm-note').value.trim();
    var err = $('mm-err');
    if (!alias || !target) { err.textContent = T('mmRequired'); return; }
    api('POST', '/__admin/api/model-aliases', { alias: alias, target: target, note: note || null })
      .then(function (r) {
        if (r.ok) {
          err.textContent = '';
          $('mm-alias').value = ''; $('mm-target').value = ''; $('mm-note').value = '';
          renderModelMap(r.json && r.json.aliases ? r.json.aliases : []);
          flash(T('mmSaved'));
        } else {
          err.textContent = errMsg(r);
        }
      });
  }
  /** 编辑映射：confirm 弹层内联改 target/note（alias 不可改），PUT 提交。 */
  function editModelAlias(alias) {
    var cur = null;
    for (var i = 0; i < mmList.length; i++) {
      if (mmList[i].alias === alias) { cur = mmList[i]; break; }
    }
    if (!cur) return;
    openConfirm({
      title: T('mmEditTitle'),
      okText: T('save'),
      body: '<div class="oc-form">' +
        '<div class="oc-field oc-full"><label for="mm-edit-alias">' + T('modelAlias') + '</label>' +
          '<input class="oc-input" id="mm-edit-alias" value="' + esc(alias) + '" disabled></div>' +
        '<div class="oc-field oc-full"><label for="mm-edit-target">' + T('modelTarget') + '</label>' +
          '<input class="oc-input" id="mm-edit-target" list="mm-targets" value="' + esc(cur.target) + '" autocomplete="off" spellcheck="false"></div>' +
        '<div class="oc-field oc-full"><label for="mm-edit-note">' + T('modelNote') + '</label>' +
          '<input class="oc-input" id="mm-edit-note" value="' + esc(cur.note || '') + '" autocomplete="off"></div>' +
        '</div>',
      run: function () {
        var target = $('mm-edit-target').value.trim();
        var note = $('mm-edit-note').value.trim();
        if (!target) { $('confirm-err').textContent = T('mmTargetRequired'); unlockConfirm(); return; }
        api('PUT', '/__admin/api/model-aliases/' + encodeURIComponent(alias), { target: target, note: note || null })
          .then(function (r) {
            if (r.ok) {
              closeConfirm();
              renderModelMap(r.json && r.json.aliases ? r.json.aliases : []);
              flash(T('mmEdited'));
            } else {
              unlockConfirm();
              $('confirm-err').textContent = errMsg(r);
            }
          });
      }
    });
    setTimeout(function () { var el = $('mm-edit-target'); if (el) el.focus(); }, 0);
  }
  function delModelAlias(alias) {
    openConfirm({
      title: T('modelMapTitle'),
      okText: T('delete'),
      danger: true,
      body: '<div class="oc-hint">' + T('mmConfirmDel') + '</div>',
      run: function () {
        api('DELETE', '/__admin/api/model-aliases/' + encodeURIComponent(alias), null)
          .then(function (r) {
            if (r.ok) {
              closeConfirm();
              renderModelMap(r.json && r.json.aliases ? r.json.aliases : []);
              flash(T('mmDeleted'));
            } else {
              unlockConfirm();
              $('confirm-err').textContent = errMsg(r);
            }
          });
      }
    });
  }

  // ── 设置页热改（/__admin/api/settings）：账号密码 / API 密钥 / 实验开关 ──
  // GET 给 value/default/source 三元组（adminPass 与 apiKeys 只回掩码/空串，
  // 明文只在 PATCH 请求体里由管理端提供）；PATCH 多键单事务，成功立即生效。
  // 刷新节奏与 previewCache 同款：60s TTL，进入设置页时拉一次，保存后强制重拉。
  var SETTINGS_TTL = 60 * 1000;
  var settingsCache = null;  // {at, data, def}
  // 来源三元组：db / env / code-default（服务端 SettingsSource，见 server.ts
  // settingsView）。code-default = 没配，用的代码里写死的默认值——不再吞进 env。
  var SETTINGS_SRC = { env: 'sourceEnv', db: 'sourceDb', 'code-default': 'codeDefault' };
  function loadSettings(force) {
    if (!force && settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL) {
      renderSettings(settingsCache.data);
      return;
    }
    api('GET', '/__admin/api/settings', null).then(function (r) {
      if (r.ok && r.json && r.json.data && r.json.data.settings) {
        // def = 顶层 adminPassIsDefault（服务端精确判定「生效密码 === 默认值」，
        // 比 settings.adminPass.source === 'env' 准 —— env 显式强密码不算默认）。
        settingsCache = { at: Date.now(), data: r.json.data.settings, def: r.json.data.adminPassIsDefault === true };
        renderSettings(settingsCache.data);
      } else {
        var panel = $('exp-panel');
        if (panel) panel.innerHTML = '<div class="oc-hint oc-hint-err">' + esc(T('expUnavailable')) + '</div>';
      }
    });
  }
  function renderSettings(s) {
    // srcOf 读服务端下发的 source 三元组（'db' | 'env' | 'code-default'）；未知/
    // 缺省回落 env（老响应兼容），不把 code-default 显示成 env。
    var srcOf = function (k) {
      var src = s[k] && s[k].source;
      return T(SETTINGS_SRC[src] || 'sourceEnv');
    };
    // 账号密码：用户名回填；密码不回显（value 恒 ''），来源标记说明一切。
    var u = $('aa-user');
    if (u && s.adminUser) u.value = s.adminUser.value;
    var up = $('aa-pass');
    if (up) up.placeholder = T('adminPassPlaceholder');
    var us = $('aa-user-src');
    if (us) us.textContent = srcOf('adminUser');
    var ps = $('aa-pass-src');
    if (ps) ps.textContent = srcOf('adminPass');
    // 默认密码强提示：读服务端顶层 adminPassIsDefault（精确判定），不是
    // source==='env' 近似（env 显式配了强密码时 source 也是 env，会误报）。
    // 徽章（密码 label 旁红底）+ 行内提示（输入框下）同源。
    var isDefault = !!(settingsCache && settingsCache.def);
    var pw = $('aa-pass-warn');
    if (pw) {
      pw.hidden = !isDefault;
      pw.textContent = T('adminPassEnvWarn');
    }
    var badge = $('aa-pass-badge');
    if (badge) {
      badge.hidden = !isDefault;
      badge.textContent = T('adminPassDefaultBadge');
    }
    // API 密钥列表（掩码数组 + 来源标记）。
    var keys = s.apiKeys && Array.isArray(s.apiKeys.value) ? s.apiKeys.value : [];
    renderApiKeys(keys, srcOf('apiKeys'));
    // 实验开关（toggle 即 PATCH，只读值做描述后缀）。
    var sc = s.scaleClientTokens || {};
    var cc = s.compactEnabled || {};
    var scaleOn = sc.value === true;
    var compactOn = cc.value === true;
    var kb = s.compactTriggerBytes && Number(s.compactTriggerBytes.value)
      ? Math.round(Number(s.compactTriggerBytes.value) / 1024) + 'KB'
      : '';
    var chars = s.compactMaxMessageChars && Number(s.compactMaxMessageChars.value)
      ? Number(s.compactMaxMessageChars.value) + ' ' + T('chars')
      : '';
    var panel = $('exp-panel');
    if (!panel) return;
    panel.innerHTML =
      expRow('expScaleUsage', 'expScaleDesc', scaleOn,
        scaleOn && s.clientTokenScale ? 'x' + s.clientTokenScale.value : '', 'toggle-scale') +
      expRow('expCompact', 'expCompactDesc', compactOn,
        compactOn && kb ? kb + ' / ' + chars : '', 'toggle-compact');
  }
  function expRow(nameKey, descKey, on, detail, act) {
    return '<div class="exp-row">' +
      '<span class="exp-name">' + T(nameKey) + '</span>' +
      '<span class="exp-desc">' + T(descKey) + (detail ? ' — ' + esc(detail) : '') + '</span>' +
      '<button class="oc-switch exp-toggle" data-action="' + act + '" data-on="' + (on ? '1' : '0') + '"' +
        ' role="switch" aria-checked="' + (on ? 'true' : 'false') + '" aria-label="' + T(nameKey) + '">' +
        '<span class="oc-switch-track"><span class="oc-switch-knob"></span></span>' +
        '<span class="oc-switch-sr">' + T(on ? 'expOn' : 'expOff') + '</span>' +
      '</button>' +
      '</div>';
  }
  function patchSetting(key, value) {
    var body = {};
    body[key] = value;
    api('PATCH', '/__admin/api/settings', body).then(function (r) {
      if (r.ok && r.json && r.json.data && r.json.data.settings) {
        settingsCache = { at: Date.now(), data: r.json.data.settings };
        renderSettings(settingsCache.data);
        flash(T('settingsSaved'));
      } else {
        flash(errMsg(r), true);
      }
    });
  }
  /** 保存账号密码表单。密码留空 = 不更新（后端不回显明文，空串提交会把
   *  真密码覆盖成空——刻意只在有输入时才带 adminPass）。 */
  function saveAdminAuth() {
    var user = $('aa-user').value.trim();
    var pass = $('aa-pass').value;
    var body = {};
    if (user) body.adminUser = user;
    if (pass) body.adminPass = pass;
    if (!user && !pass) { $('aa-err').textContent = T('aaNothing'); return; }
    api('PATCH', '/__admin/api/settings', body).then(function (r) {
      if (r.ok && r.json && r.json.data && r.json.data.settings) {
        settingsCache = { at: Date.now(), data: r.json.data.settings };
        $('aa-pass').value = '';
        $('aa-err').textContent = '';
        renderSettings(settingsCache.data);
        flash(T('authSaved') + (pass ? ' — ' + T('adminPassHint') : ''));
      } else {
        $('aa-err').textContent = errMsg(r);
      }
    });
  }
  // ── Update（OTA 自更新，sec-update）──────────────────────────
  var otaCache = null;
  function loadOtaStatus(force) {
    return api('GET', '/__admin/api/update/status', null).then(function (r) {
      if (r.ok && r.json && r.json.ok && r.json.data) {
        otaCache = r.json.data;
        renderOtaStatus(otaCache);
        return otaCache;
      }
      return null;
    });
  }
  function renderOtaStatus(s) {
    var cur = $('ota-current');
    if (cur) cur.textContent = s.current || '—';
    var dis = $('ota-disabled-badge');
    if (dis) dis.hidden = s.enabled !== false; // 停用徽章只在 OTA_ENABLED=0 时亮
    var lat = $('ota-latest');
    if (lat) lat.textContent = s.latest || '—';
    var lc = $('ota-last-checked');
    if (lc) lc.textContent = s.lastCheckedAt ? ' · ' + T('otaCheckedAt') + ' ' + hhmmss(s.lastCheckedAt) : '';
    var err = $('ota-error');
    if (err) {
      err.hidden = !s.error;
      err.textContent = s.error ? T('otaCheckFailed') : '';
    }
    var up = $('btn-ota-update');
    if (up) up.hidden = !s.hasUpdate;
    var rb = $('ota-rollback');
    if (rb) {
      var parts = [];
      if (s.rollback && s.rollback.rollbackPointPresent) parts.push(T('otaPrevPresent'));
      if (s.rollback && s.rollback.rolledBackBinaryPresent) parts.push(T('otaRolledBack'));
      rb.textContent = parts.length ? T('otaRollbackState') + ': ' + parts.join(' · ') : '';
    }
    // 设置 tab 红点：有新版本且不在设置页 → 亮；否则灭。
    var dot = $('tab-dot-update');
    if (dot) dot.hidden = !(s.hasUpdate && curView !== 'settings');
  }
  function doOtaCheck() {
    var btn = $('btn-ota-check');
    btn.disabled = true;
    btn.textContent = T('otaChecking');
    api('POST', '/__admin/api/update/check', {}).then(function (r) {
      btn.disabled = false;
      btn.textContent = T('otaCheck');
      if (r.ok && r.json && r.json.ok && r.json.data) {
        otaCache = r.json.data;
        renderOtaStatus(otaCache);
        if (otaCache.hasUpdate) showOtaChangelog(otaCache);
      } else {
        flash(errMsg(r), true);
      }
    });
  }
  function showOtaChangelog(s) {
    var body = '<div class="meta">' + esc(s.current) + ' → ' + esc(s.latest) + '</div>';
    var list = (s.commits && s.commits.length) ? s.commits : null;
    if (list) {
      body += '<div class="meta">' + T('otaChangelog') + '</div>' +
        '<div class="ota-commits">' + list.map(function (c) {
          return '<div class="ota-commit"><span class="w">' + esc(c.sha) + '</span> ' + esc(c.message) + '</div>';
        }).join('') + '</div>';
    } else {
      body += '<div class="meta">' + T('otaNoChangelog') + '</div>';
    }
    openConfirm({
      title: T('otaConfirmTitle') + ' v' + esc(String(s.latest).replace(/^v/, '')),
      body: body,
      okText: T('otaUpdate'),
      danger: true,
      run: doOtaPerform
    });
  }
  var OTA_STAGES = ['otaStageCheck', 'otaStageDownload', 'otaStageVerify', 'otaStageSwap', 'otaStageRestart'];
  var otaStageIdx = 0;
  var otaStageTimer = null;
  function runOtaStage() {
    var b = $('update-body');
    if (b) b.innerHTML = '<div class="ota-progress">' + T(OTA_STAGES[otaStageIdx % OTA_STAGES.length]) + '</div>';
    otaStageIdx++;
  }
  function doOtaPerform() {
    closeConfirm();
    $('update-title').textContent = T('otaTitle');
    $('update-err').textContent = '';
    $('update-close').disabled = true;
    $('update-overlay').hidden = false;
    otaStageIdx = 0;
    runOtaStage();
    otaStageTimer = setInterval(runOtaStage, 1500);
    api('POST', '/__admin/api/update/perform', {}).then(function (r) {
      clearInterval(otaStageTimer);
      if (r.ok && r.json && r.json.ok) {
        // 成功：服务已安排自重启，前端给出提示（1s 后连接会断）。
        var b = $('update-body');
        if (b) b.innerHTML = '<div class="ota-progress">' + T('otaRestarting') + '</div>';
      } else if (r.status === 0) {
        // 连接中断 = 服务正在重启（最常见于成功路径的 1s 窗口之后）。
        var b2 = $('update-body');
        if (b2) b2.innerHTML = '<div class="ota-progress">' + T('otaRestarting') + '</div>';
      } else {
        $('update-err').textContent = errMsg(r);
        $('update-close').disabled = false;
      }
      // 无论成败都刷新一次状态（重启后 status 会给新版本）。
      setTimeout(function () { loadOtaStatus(true); }, 3000);
    });
  }
  // ── API 密钥管理（PATCH apiKeys 是替换语义：删除/添加都要全量明文数组）。
  // 明文只存服务端指纹，面板这边把「本面板添加过的 key」明文缓存进
  // localStorage（mask → plain，mask = '****' + 末 4 位，与后端 keyFingerprint
  // 同款）。缓存里没有明文（env 来源等）的 key 无法安全删除/追加 —— 按钮
  // 禁用并提示去服务端配置文件操作，绝不把掩码当明文提交污染配置。
  var APIKEY_CACHE_KEY = 'fc-akeys-plain';
  function loadApiKeyCache() {
    try {
      var raw = JSON.parse(localStorage.getItem(APIKEY_CACHE_KEY) || '{}');
      return (raw && typeof raw === 'object') ? raw : {};
    } catch (e) { return {}; }
  }
  function saveApiKeyCache(map) {
    try { localStorage.setItem(APIKEY_CACHE_KEY, JSON.stringify(map)); } catch (e) {}
  }
  function apiKeyMask(plain) {
    return plain.length <= 4 ? '****' : '****' + plain.slice(-4);
  }
  function renderApiKeys(keys, source) {
    var el = $('akey-rows');
    var empty = $('akey-empty');
    if (!el || !empty) return;
    empty.hidden = keys.length > 0;
    var cache = loadApiKeyCache();
    el.innerHTML = keys.map(function (k) {
      var hasPlain = Boolean(cache[k]);
      var del = hasPlain
        ? '<button class="oc-btn oc-btn-ghost oc-btn-sm t-del" data-action="del-akey" data-mask="' + esc(k) + '">' + T('delete') + '</button>'
        : '<button class="oc-btn oc-btn-ghost oc-btn-sm t-del" disabled title="' + T('apiKeysNoPlain') + '">' + T('delete') + '</button>';
      return '<div class="akey-row">' +
        '<span class="tok-mask">' + esc(k) + '</span>' +
        '<span class="src">' + source + '</span>' +
        '<button class="oc-btn oc-btn-ghost" data-action="reveal-akey" data-index="' + keys.indexOf(k) + '">' + T('apiKeysCopy') + '</button>' +
        del +
        '</div>';
    }).join('');
  }
  function addApiKey() {
    openConfirm({
      title: T('apiKeysAddTitle'),
      okText: T('apiKeysAdd'),
      body: '<div class="oc-form">' +
        '<div class="oc-field oc-full"><label>' + T('apiKeysLabel') + '</label>' +
          '<textarea class="oc-textarea" id="akey-in" rows="3" placeholder="' + T('apiKeysPasteHint') + '" autocomplete="off" spellcheck="false"></textarea></div>' +
        '</div>' +
        '<div class="oc-hint" id="akey-warn"></div>',
      run: function () {
        var lines = ($('akey-in').value || '').split(/\n/)
          .map(function (s) { return s.trim(); })
          .filter(function (s) { return s; });
        if (!lines.length) { $('confirm-err').textContent = T('nameRequired'); unlockConfirm(); return; }
        // 现有明文（面板缓存）+ 新明文 → 全量替换。缓存缺明文的 key（env 来源）
        // 会随替换丢失——弹层已按缺明文的个数给出警告。
        var map = loadApiKeyCache();
        var known = [];
        for (var m in map) known.push(map[m]);
        var merged = known.concat(lines);
        api('PATCH', '/__admin/api/settings', { apiKeys: merged }).then(function (r) {
          if (r.ok) {
            var nm = {};
            for (var i = 0; i < merged.length; i++) nm[apiKeyMask(merged[i])] = merged[i];
            saveApiKeyCache(nm);
            settingsCache = null;
            loadSettings(true);
            closeConfirm();
            flash(T('apiKeysSaved'));
          } else {
            unlockConfirm();
            $('confirm-err').textContent = errMsg(r);
          }
        });
      }
    });
    // 弹层打开后立刻填 env 覆盖警告（缓存缺明文的 key 会在保存后被替换掉）。
    var warn = $('akey-warn');
    if (warn) {
      var n = countNoPlainKeys();
      warn.textContent = n > 0 ? T('apiKeysEnvWarn') + ' (' + n + ')' : '';
    }
  }
  function delApiKey(mask) {
    var map = loadApiKeyCache();
    if (!map[mask]) { flash(T('apiKeysNoPlain'), true); return; }
    openConfirm({
      title: T('apiKeysTitle'),
      okText: T('delete'),
      danger: true,
      body: '<div class="oc-hint">' + T('apiKeysDeleteConfirm') + '</div>' +
        '<div class="oc-hint">' + esc(mask) + '</div>',
      run: function () {
        var mm = loadApiKeyCache();
        var rest = [];
        for (var m in mm) {
          if (m !== mask) rest.push(mm[m]);
        }
        api('PATCH', '/__admin/api/settings', { apiKeys: rest }).then(function (r) {
          if (r.ok) {
            delete mm[mask];
            saveApiKeyCache(mm);
            settingsCache = null;
            loadSettings(true);
            closeConfirm();
            flash(T('apiKeysSaved'));
          } else {
            unlockConfirm();
            $('confirm-err').textContent = errMsg(r);
          }
        });
      }
    });
  }
  /** 添加弹层打开时计算「缓存缺明文」的数量（env 来源等），警告替换会丢它们。 */
  function countNoPlainKeys() {
    var cache = loadApiKeyCache();
    var n = 0;
    var keys = settingsCache && settingsCache.data && settingsCache.data.apiKeys &&
      Array.isArray(settingsCache.data.apiKeys.value) ? settingsCache.data.apiKeys.value : [];
    for (var i = 0; i < keys.length; i++) {
      if (!cache[keys[i]]) n++;
    }
    return n;
  }

  // ── OAuth 设备码登录（弹层 + 轮询，后端并行开发中）──
  var oauthTimer = 0, oauthPollTimer = 0, oauthMaxId = 0;
  /** 主 2s 轮询定时器（未登录 401 时清除，见 tick 的 catch）。 */
  var fcTickTimer = 0;

  function startOAuth() {
    var mx = 0;
    for (var i = 0; i < state.list.length; i++) {
      if (state.list[i].id > mx) mx = state.list[i].id;
    }
    oauthMaxId = mx;
    var st = $('oauth-start-status');
    st.textContent = T('oauthStarting');
    var btn = $('oauth-start');
    btn.disabled = true;
    api('POST', '/__admin/api/oauth/start', {})
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok) {
          st.textContent = errMsg(r);
          return;
        }
        var d = r.json || {};
        if (!d.deviceCode || !d.verificationUriComplete) {
          st.textContent = T('oauthFail');
          return;
        }
        st.textContent = '';
        openOAuth(d);
      })
      .catch(function (e) {
        btn.disabled = false;
        st.textContent = T('oauthNetFail') + (e && e.message ? ' (' + e.message + ')' : '');
      });
  }

  function openOAuth(d) {
    $('oauth-url').textContent = d.verificationUriComplete;
    $('oauth-url').href = d.verificationUriComplete;
    $('oauth-code').textContent = d.userCode || '—';
    var intervalMs = Math.max(1, Number(d.interval) || 2) * 1000;
    var deadline = Date.now() + Math.max(1, Number(d.expiresIn) || 60) * 1000;
    $('oauth-status').className = 'oauth-status';
    $('oauth-status').textContent = T('oauthPolling');
    $('oauth-expires').textContent = T('oauthExpiresIn') + ' ' + hms(deadline - Date.now());
    $('oauth-retry').hidden = true;
    $('oauth-overlay').hidden = false;
    clearInterval(oauthTimer);
    clearInterval(oauthPollTimer);
    oauthTimer = setInterval(function () {
      var left = deadline - Date.now();
      if (left <= 0) {
        $('oauth-expires').textContent = '';
        oauthError('expired');
      } else {
        $('oauth-expires').textContent = T('oauthExpiresIn') + ' ' + hms(left);
      }
    }, 1000);
    oauthPollTimer = setInterval(function () { oauthPoll(d); }, intervalMs);
    oauthPoll(d);
  }

  function oauthPoll(d) {
    api('POST', '/__admin/api/oauth/poll', { deviceCode: d.deviceCode })
      .then(function (r) {
        if ($('oauth-overlay').hidden) return;
        if (!r.ok || !r.json || r.json.ok === false) {
          oauthError((r.json && r.json.reason) || 'error');
          return;
        }
        var st = r.json.status;
        if (st === 'done') oauthDone();
        else if (st === 'pending') $('oauth-status').textContent = T('oauthPolling');
      })
      .catch(function () {
        oauthError('net');
      });
  }

  function oauthDone() {
    clearInterval(oauthTimer);
    clearInterval(oauthPollTimer);
    var st = $('oauth-status');
    st.className = 'oauth-status ok';
    st.textContent = T('oauthLoggedIn');
    setTimeout(function () {
      $('oauth-overlay').hidden = true;
      flash(T('oauthDone'));
    }, 1500);
    tick(true);
  }

  function oauthError(reason) {
    clearInterval(oauthTimer);
    clearInterval(oauthPollTimer);
    var msg = reason === 'expired' ? T('oauthExpired')
      : reason === 'denied' ? T('oauthDenied')
      : reason === 'not_found' ? T('oauthNotFound')
      : reason === 'net' ? T('oauthNetFail')
      : T('oauthFail');
    var st = $('oauth-status');
    st.className = 'oauth-status bad';
    st.textContent = msg;
    $('oauth-retry').hidden = false;
  }

  function closeOAuth() {
    clearInterval(oauthTimer);
    clearInterval(oauthPollTimer);
    $('oauth-overlay').hidden = true;
  }

  function copyOAuthUrl() {
    var url = $('oauth-url').textContent;
    var done = function () {
      var b = $('oauth-copy');
      b.textContent = T('oauthCopied');
      setTimeout(function () { b.textContent = T('oauthCopy'); }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { flash(T('opFail'), true); });
    } else {
      flash(T('opFail'), true);
    }
  }

  // ── UI v3：账户详情（console 数据展示）──────────────
  // legacyKeyInputFor：detail 视图跨账号复用同一 DOM，记录 legacy key 输入框当前
  // 归属的账号 id——切账号时必须清掉上一个账号的未保存输入（M3），否则「正在输入」
  // 守卫跳过渲染 + saveLegacyKey 按 detailState.id 会把 A 的值写进 B。
  var detailState = { id: null, range: '7d', billing: null, legacyKeyInputFor: null };
  /** microCents → $（1e8 = $1），两位小数。null/undefined/非法输入 → '—'（未知），
   *  不把「没拿到数据」伪装成「没钱」——0 是合法值，显示 $0.00。
   *  **与 src/money.ts 的 microCentsToUsd 同口径（1e8 microCents = $1），勿改系数。**
   *  内联 JS 是字符串模板（ADMIN_HTML 内 <script>），无法 import TS 模块，
   *  前端独立实现不可避免；系数收敛到 money.ts（单一权威模块，B1 根因）。 */
  var money = function (mc) {
    if (mc == null || isNaN(Number(mc))) return '—';
    return '$' + (Number(mc) / 1e8).toFixed(2);
  };
  var dateFmt = function (ts) {
    if (!ts) return '—';
    var d = new Date(ts), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };
  /** 详情页区块容器：统一 .panel 模板（panel-hd 标题行 + panel-bd 内容区）。 */
  function dBlock(titleKey, subKey, inner) {
    return '<div class="panel detail-panel"><div class="panel-hd"><h1>' + T(titleKey) + '</h1>' +
      (subKey ? '<div class="sub">' + T(subKey) + '</div>' : '') + '</div>' +
      '<div class="panel-bd">' + inner + '</div></div>';
  }
  /**
   * 详情块错误持久化：detailErr 写入的错误不被 2s 轮询的下一次成功覆盖——
   * 错误一旦出现就持续显示，直到用户主动操作（进入详情/手动刷新/切范围）后
   * 重新渲染才清除。stickyErr 记区块名；autoTick 标志区分「2s 轮询发起」与
   * 「用户发起」。tick 调用的 load* 传 fromTick=true，其余入口默认 false。
   */
  var stickyErr = {};
  function detailErr(name, msg) {
    stickyErr[name] = true;
    var el = $('detail-' + name);
    if (!el) return;
    var acct = detailState.id != null ? findAccount(detailState.id) : null;
    // env 代理账号（hasConsole=false）：console 区块无凭据是常态，显示中性说明而非红字。
    if (acct && !acct.hasConsole) {
      el.innerHTML = '<div class="oc-hint">' + esc(T('consoleNotConfigured')) + '</div>';
      return;
    }
    // 凭据类错误（cookie 失效/登录过期/无凭据）：顶部横幅已提示，区块给中性提示不重复红字。
    if (/cookie|credential|auth failed|expired|invalid|登录态|登录已失效/i.test(msg)) {
      el.innerHTML = '<div class="oc-hint">' + esc(msg) + '</div>';
      return;
    }
    // 需求 1：额度耗尽类错误包装为友好短文案，原文保留在 title 可展开。
    el.innerHTML = '<div class="oc-hint oc-hint-err" title="' + esc(msg) + '">' + esc(friendlyQuota(msg) || msg) + '</div>';
  }
  /** 渲染成功前的守卫：自动轮询且该块还挂着 sticky 错误 → 拒绝渲染（保留错误
   *  给用户看）；否则清除 sticky 标记并放行（用户操作触发的成功）。 */
  function clearSticky(name, fromTick) {
    if (stickyErr[name] && fromTick) return false;
    delete stickyErr[name];
    return true;
  }

  function openAccountDetail(id) {
    var a = findAccount(id);
    if (!a) return;
    detailState.id = id;
    $('detail-name').textContent = a.name;
    $('detail-name').title = a.name;
    switchView('account-detail');
    detailGroup = 'sub';  // 每次进详情默认「订阅 & Keys」组（tab 只显隐，load 全拉）
    loadAccountDetail();
  }
  function closeAccountDetail() {
    detailState.id = null;
    detailState.billing = null;
    switchView('accounts');
  }
  /** 详情区块 → 标题/副标题 i18n key。首次进入时显示 loading 骨架（已有内容不覆盖）。
   *  键必须与对应 render 函数 dBlock() 实际用的键一致且都在 I18N 字典里——
   *  否则 loading 骨架直接显示原始 key 名（DETAIL_BLOCK_KEYS 的 T() 是变量传键，
   *  静态检查看不见）。 */
  var DETAIL_BLOCK_KEYS = [
    ['detail-go', 'goSub', 'goSubHint'],
    ['detail-legacy-key', 'legacyKeyTitle', 'legacyKeySub'],
    ['detail-legacy', 'legacyKeys', 'legacySub'],
    ['detail-legacy-billing', 'legacyBilling', 'legacyBillingSub'],
    ['detail-workspace', 'workspaceTitle', 'workspaceSub'],
    ['detail-models', 'allowedModelsTitle', 'allowedModelsSub'],
    ['detail-billing', 'balanceTitle', 'balanceSub'],
    ['detail-usage', 'usageTitle', 'usageSub'],
    ['detail-models-usage', 'modelUsageTitle', 'modelUsageSub'],
    ['detail-users-usage', 'userUsageTitle', 'userUsageSub'],
    ['detail-autorecharge', 'autoRechargeTitle', 'autoRechargeSub'],
    ['detail-budgets', 'budgetsTitle', 'budgetsSub'],
    ['detail-members', 'membersTitle', 'membersSub'],
    ['detail-sa', 'saTitle', 'saSub'],
    ['detail-providers', 'providersTitle', 'providersSub'],
    ['detail-pricing', 'pricingTitle', 'pricingSub'],
  ];
  /** 详情页分组 tab（解决 16 个竖排区块一直下滑）：5 组，默认「订阅 & Keys」。
   *  tab 只显隐不懒加载——loadAccountDetail 仍全拉所有区块（首屏一次，切换零等待）。 */
  var detailGroup = 'sub';
  var DETAIL_GROUPS = [
    ['sub', 'detailTabSub', ['detail-go', 'detail-legacy-key', 'detail-legacy', 'detail-legacy-billing']],
    ['ws', 'detailTabWs', ['detail-workspace', 'detail-models']],
    ['finance', 'detailTabFinance', ['detail-billing', 'detail-usage', 'detail-models-usage',
      'detail-users-usage', 'detail-autorecharge', 'detail-budgets']],
    ['org', 'detailTabOrg', ['detail-members', 'detail-sa', 'detail-providers']],
    ['pricing', 'detailTabPricing', ['detail-pricing']]
  ];
  /** 渲染详情页分组 tab 条（detail-nav 容器内，复用 .tab 样式 + .sub-tabs 行）。 */
  function renderDetailTabs() {
    var el = $('detail-nav');
    if (!el) return;
    var html = '<div class="sub-tabs">' + DETAIL_GROUPS.map(function (g) {
      return '<button type="button" class="tab' + (g[0] === detailGroup ? ' active' : '') +
        '" data-detail-group="' + g[0] + '">' + esc(T(g[1])) + '</button>';
    }).join('') + '</div>';
    el.innerHTML = html;
    el.querySelectorAll('button[data-detail-group]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        showDetailGroup(btn.getAttribute('data-detail-group'));
      });
    });
  }
  /** 切换详情页分组：显示目标组容器（.detail-group[data-group]），隐藏其余。 */
  function showDetailGroup(g) {
    detailGroup = g;
    var groups = document.querySelectorAll('.detail-group');
    for (var i = 0; i < groups.length; i++) {
      groups[i].hidden = groups[i].getAttribute('data-group') !== g;
    }
    renderDetailTabs();
  }
  // 详情首拉并发闸门（需求 2）：loadAccountDetail 一次排 14 个区块请求，全部
  // 同时发会打上游洪峰（console/legacy 端点首拉全 miss 服务端缓存）。qDetail
  // 排队，最多 DETAIL_CONCURRENCY 个同时在飞，其余 FIFO 逐个发。队列按页面
  // 区块顺序排（头部区块先拉）；切账号时清掉未出发的旧任务。tick 的 2s 轮询
  // （loadBilling/loadGo/loadLegacyKeys/loadLegacyBilling）不走队列（自带 TTL 门）。
  var DETAIL_CONCURRENCY = 4;
  var detailQueue = [];
  var detailInFlight = 0;
  function pumpDetailQueue() {
    while (detailInFlight < DETAIL_CONCURRENCY && detailQueue.length) {
      var next = detailQueue.shift();
      if (!next) break;
      detailInFlight++;
      Promise.resolve().then(next).finally(function () {
        detailInFlight--;
        pumpDetailQueue();
      });
    }
  }
  function qDetail(fn) {
    detailQueue.push(fn);
    pumpDetailQueue();
  }
  function loadAccountDetail() {
    var id = detailState.id;
    if (id == null) return;
    DETAIL_BLOCK_KEYS.forEach(function (b) {
      var el = $(b[0]);
      if (el && !el.innerHTML) el.innerHTML = dBlock(b[1], b[2], '<div class="oc-hint">' + T('loading') + '</div>');
    });
    showDetailGroup(detailGroup);
    // 首拉排队（≤DETAIL_CONCURRENCY 并发，FIFO，按页面顺序 = 头部区块先拉）。
    // task 带 start 守卫：排队期间切账号的旧任务直接放弃。load* 内部仍保留
    // 响应时的 detailState.id 切换守卫（旧账号慢响应不渲染进新视图）。
    detailQueue.length = 0;
    var tasks = [
      function () { if (detailState.id !== id) return; return loadGo(id); },
      function () { if (detailState.id !== id) return; return loadLegacyKeys(id); },
      function () { if (detailState.id !== id) return; return loadLegacyBilling(id); },
      function () { if (detailState.id !== id) return; return loadWorkspaces(id); },
      function () { if (detailState.id !== id) return; return loadBilling(id); },
      function () { if (detailState.id !== id) return; return loadUsage(); },
      function () { if (detailState.id !== id) return; return loadModelsUsage(id); },
      function () { if (detailState.id !== id) return; return loadUsersUsage(id); },
      function () { if (detailState.id !== id) return; return loadBudgets(id); },
      function () { if (detailState.id !== id) return; return loadMemberBudgets(id); },
      function () { if (detailState.id !== id) return; return loadMembers(id); },
      function () { if (detailState.id !== id) return; return loadSa(id); },
      function () { if (detailState.id !== id) return; return loadProviders(id); },
      function () { if (detailState.id !== id) return; return loadPricing(id); }
    ];
    for (var i = 0; i < tasks.length; i++) qDetail(tasks[i]);
    // 同步渲染（不发起请求）：模型区块读账号列表/目录快照，legacy key 配置读列表。
    loadModels(id);
    renderLegacyKey();
  }

  /** 工作区区块：显示当前 workspace（id + 名称）+ 切换入口。 */
  function loadWorkspaces(id) {
    return api('GET', '/__admin/api/console/account/' + id + '/workspaces', null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态：旧账号慢响应不渲染进新视图
      if (!r.ok || !r.json || r.json.ok === false || !r.json.data) {
        detailErr('workspace', errMsg(r));
        return;
      }
      renderWorkspaces(r.json.data, id);
    }).catch(function () { if (detailState.id !== id) return; detailErr('workspace', T('opFail')); });
  }
  function renderWorkspaces(data, id) {
    if (!clearSticky('workspace')) return;
    var items = data.items || [];
    var current = data.current;
    var legacy = data.legacy;
    var curName = '';
    var found = false;
    var opts = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.id === current) { found = true; curName = it.name; }
      opts += '<option value="' + esc(it.id) + '"' + (it.id === current ? ' selected' : '') + '>' +
        esc(it.name) + ' · ' + esc(it.id) + '</option>';
    }
    // 当前 workspace 不在任何已知账号里（手动配置过）：单独补一个选中项，
    // 否则下拉默认落在「手动输入」上，看起来像当前没 workspace。
    if (!found && current) {
      opts = '<option value="' + esc(current) + '" selected>' + T('currentWorkspace') + ' · ' + esc(current) + '</option>' + opts;
    }
    // 当前没配置 workspace：占位项占住下拉，避免默认选中第一个 workspace 造成误导。
    if (!current) {
      opts = '<option value="" disabled selected>—</option>' + opts;
    }
    opts += '<option value="__manual__">' + T('wsManual') + '</option>';
    var curTxt = current
      ? '<span class="ws-id" title="' + esc(current) + '">' + esc(current) + '</span>' +
        (curName ? '<span class="ws-name cut" title="' + esc(curName) + '">' + esc(curName) + '</span>' : '')
      : '<span class="oc-hint">' + T('noWorkspace') + '</span>';
    var legacyHtml = legacy
      ? '<div class="ws-legacy"><span class="ws-k">' + T('wsLegacy') + '</span>' +
        '<span class="ws-id" title="' + esc(legacy) + '">' + esc(legacy) + '</span></div>'
      : '';
    var html =
      '<div class="ws-cur"><span class="ws-k">' + T('currentWorkspace') + '</span>' + curTxt + '</div>' +
      legacyHtml +
      '<div class="ws-switch">' +
        '<select class="oc-select oc-grow" id="ws-select-' + id + '">' + opts + '</select>' +
        '<button class="oc-btn oc-btn-primary" data-action="ws-switch" data-id="' + id + '">' + T('wsSwitch') + '</button>' +
      '</div>';
    $('detail-workspace').innerHTML = dBlock('workspaceTitle', 'workspaceSub', html);
  }
  /** 切换 workspace：下拉选中一个 → PATCH workspaceId → 重拉详情（新区块数据）。
   *  手动输入（__manual__）走 confirm 弹层的文本输入。 */
  function switchWorkspace(id) {
    var sel = $('ws-select-' + id);
    var v = sel ? sel.value : '';
    if (v === '__manual__') {
      openConfirm({
        title: T('wsSwitchTitle'),
        okText: T('wsSwitch'),
        body: '<div class="oc-form"><div class="oc-field oc-full"><label for="ws-manual">' + T('workspaceId') + '</label>' +
          '<input class="oc-input" id="ws-manual" autocomplete="off" placeholder="org_..."></div>' +
          '<div class="oc-hint">' + T('wsManualHint') + '</div></div>',
        run: function () {
          var ws = $('ws-manual').value.trim();
          if (!ws) { $('confirm-err').textContent = T('wsIdRequired'); unlockConfirm(); return; }
          applyWorkspace(id, ws, true);
        }
      });
      return;
    }
    if (!v) { flash(T('wsIdRequired'), true); return; }
    applyWorkspace(id, v, false);
  }
  /** PATCH workspaceId → 成功重拉详情（console 数据随新 workspace 走）；失败按入口报错。 */
  function applyWorkspace(id, ws, viaModal) {
    api('PATCH', '/__admin/api/accounts/' + id, { workspaceId: ws }).then(function (r) {
      if (r.ok) {
        if (viaModal) closeConfirm();
        flash(T('wsSwitched'));
        tick(true);
        loadAccountDetail();
      } else {
        if (viaModal) { unlockConfirm(); $('confirm-err').textContent = errMsg(r); }
        else flash(errMsg(r), true);
      }
    });
  }

  // ── 可用模型区块（detail-models）────────────────────
  // 数据源（不发起新请求，全读已拉取的数据）：
  // - 账号覆盖 / 被动学习 blocked：accounts 列表的 allowedModels / blockedModels
  //   （服务端契约会给 AccountSectionItem 加这两项；落地前缺字段显示 —）。
  // - 模型目录状态：/__metrics 的 catalog 段，服务端契约形状
  //   { count, lastRefreshAt, error }（字段名以实际实现为准，缺字段显示 —）。
  // - 全局默认：只读列表，镜像 src/deepseek.ts 的 ALLOWED_MODELS（面板是自包含
  //   模板，无法 import 服务端常量；两边需保持同步）。
  function renderModels(id) {
    var a = findAccount(id);
    if (!a) return;
    var ov = Array.isArray(a.allowedModels) ? a.allowedModels : null;
    var now = Date.now();
    var gm = ['deepseek-v4-flash', 'deepseek-v4-flash-free'];
    var globalHtml = '<div class="keys"><div class="keys-hd">' + T('globalDefault') + '</div>' +
      gm.map(function (m) { return '<div class="key-row"><span class="fp">' + esc(m) + '</span></div>'; }).join('') +
      '</div>';
    var overrideHtml = '<div class="oc-form">' +
      '<div class="oc-field oc-full"><label for="models-in-' + id + '">' + T('accountOverride') + '</label>' +
        '<input class="oc-input" id="models-in-' + id + '" value="' + esc((ov || []).join(', ')) + '"' +
          ' placeholder="' + esc(T('modelsPlaceholder')) + '" autocomplete="off" spellcheck="false">' +
        '<div class="oc-hint">' + T('clearToGlobalHint') + '</div>' +
      '</div>' +
      '<button class="oc-btn oc-btn-primary" data-action="save-models" data-id="' + id + '">' + T('save') + '</button>' +
      '<button class="oc-btn oc-btn-ghost" data-action="clear-models" data-id="' + id + '">' + T('clearToGlobal') + '</button>' +
    '</div>';
    var cat = lastMetrics && lastMetrics.catalog;
    var catCount = cat ? Number(cat.count) : NaN;
    var catHtml = '<div class="keys"><div class="keys-hd">' + T('modelCatalog') + '</div>' +
      '<div class="key-row"><span class="fp">' +
        (isFinite(catCount) && catCount > 0 ? fmt(catCount) + ' ' + T('catalogModels') : '—') +
        (cat && cat.lastRefreshAt
          ? ' <span class="w">· ' + T('catalogRefreshed') + ' ' + hhmmss(cat.lastRefreshAt) + '</span>'
          : '') +
      '</span>' +
      (cat && cat.error ? '<span class="k-meta s-bad">' + esc(cat.error) + '</span>' : '') +
      '</div></div>';
    var bm = Array.isArray(a.blockedModels) ? a.blockedModels : null;
    var blockedHtml = '<div class="keys"><div class="keys-hd">' + T('modelsBlocked') + '</div>' +
      '<div class="key-row"><span class="fp">' +
        (bm && bm.length
          ? bm.map(function (b) {
              if (typeof b === 'string') return esc(b);
              var name = b.model || b.name || '—';
              var until = Number(b.until || b.retryUntil || 0);
              return esc(name) + (until > now ? ' · ' + hms(until - now) : '');
            }).join(' · ')
          : '—') +
      '</span></div></div>';
    $('detail-models').innerHTML = dBlock('allowedModelsTitle', 'allowedModelsSub',
      globalHtml + overrideHtml + catHtml + blockedHtml);
  }
  function loadModels(id) {
    if (detailState.id !== id) return;  // 详情切换竞态：旧账号慢响应不渲染进新视图
    renderModels(id);
  }
  /** 保存账号可用模型覆盖：逗号分隔 → 数组；空 → null（清除回全局）。 */
  function saveModels(id) {
    var input = $('models-in-' + id);
    var parts = (input && input.value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    api('PATCH', '/__admin/api/accounts/' + id, { allowedModels: parts.length ? parts : null })
      .then(function (r) {
        if (r.ok) { flash(T('modelsSaved')); tick(true); loadModels(id); }
        else flash(errMsg(r), true);
      });
  }
  /** 一键清除回全局：清空输入 + PATCH null。 */
  function clearModels(id) {
    var input = $('models-in-' + id);
    if (input) input.value = '';
    api('PATCH', '/__admin/api/accounts/' + id, { allowedModels: null })
      .then(function (r) {
        if (r.ok) { flash(T('modelsSaved')); tick(true); loadModels(id); }
        else flash(errMsg(r), true);
      });
  }

  // legacy 详情块前端 TTL 门：详情 tick 每 2s 调 loadGo/loadLegacyKeys/
  // loadLegacyBilling，服务端已有 30s TTL 缓存兜住上游流量；前端再挡一层
  // 减少 2s 轮询的 HTTP 往返。规则：**成功渲染后** TTL 内且是自动轮询
  // （fromTick=true）直接跳过；用户发起（fromTick 空/false：进详情、手动
  // 刷新、写操作后）绕过 TTL 强制重拉。失败不打点 —— 2s tick 会继续重试
  // （保留「偶发失败自愈」，否则首次拉取失败会被门挡 30s 冻结错误）。
  // sticky 语义不受影响 —— TTL 门只挡「发起请求」，渲染路径根本没进，
  // 错误状态持续显示（见 clearSticky 注释）。
  var LEGACY_DETAIL_TTL = 30 * 1000;
  var legacyDetailAt = {};  // 'kind:id' -> 最近一次打点时间（成功渲染；确定性配置错误的失败也打点，见 loadGo）
  /** 账号是否配置了 legacy workspace（legacyWorkspaceId 非空）。无 legacy 凭据
   *  的账号（env/OAuth 账号）请求 legacy 三端点必然 404 —— tick 每 2s 打一次，
   *  经盾 client-fault 重试 3 次等 4 秒才给错误文案（2026-08-15 用户实测：网页
   *  操作看到「上游返回 404」），纯噪音。加载器统一在入口跳过。 */
  function legacyEligible(id) {
    for (var i = 0; i < state.list.length; i++) {
      if (state.list[i].id === id) return !!state.list[i].legacyWorkspaceId;
    }
    return false;
  }
  function legacyDetailFresh(id, kind, force) {
    var k = kind + ':' + id;
    var now = Date.now();
    return !force && !!legacyDetailAt[k] && now - legacyDetailAt[k] < LEGACY_DETAIL_TTL;
  }
  function legacyDetailMark(id, kind) {
    legacyDetailAt[kind + ':' + id] = Date.now();
  }

  // ── 旧版 Default API Key（zen usage，免 cookie）────────────
  // 数据源是账号列表的 hasLegacyKey/legacyKeyMasked（tick 每 2s 刷新）。输入框
  // 不回填明文，只显示掩码；正在输入时不重渲染（否则 2s tick 会清掉未保存的输入）。
  function renderLegacyKey() {
    var id = detailState.id;
    if (id == null) return;
    var el = $('detail-legacy-key');
    if (!el) return;
    var a = findAccount(id);
    if (!a) return;
    var input = $('detail-legacy-key-paste');
    // M3：detail 视图跨账号复用同一 DOM。上次渲染的账号（legacyKeyInputFor）与
    // 当前 id 不同 = 用户切了账号 → 清掉上一个账号的未保存输入，否则会被下面的
    // 「正在输入」守卫跳过渲染（B 显示 A 的输入），且 saveLegacyKey 用当前
    // detailState.id=B 会把 A 的值写进 B。同账号的 tick 重渲染不清，保住用户
    // 正在输入的内容。
    if (detailState.legacyKeyInputFor !== id) {
      if (input) input.value = '';
      detailState.legacyKeyInputFor = id;
    }
    if (input && input.value) return; // 用户正在输入，交给 2s tick 下次再同步
    var has = !!a.hasLegacyKey;
    var masked = a.legacyKeyMasked || '';
    // 同 key 共用提示：legacyKey 与池 key/其他账号重复（服务端检测，见 buildAccountsSection）。
    var dupWarn = a.duplicateKey
      ? '<div class="oc-hint-err">' + T('dupKeyBadge') + (a.duplicateKeyWith ? ' · ' + esc(a.duplicateKeyWith) : '') + ' — ' + T('dupKeyHint') + '</div>'
      : '';
    var configured = has
      ? '<div class="oc-hint">' + T('legacyKeyConfigured') + ' ' + esc(masked) +
        ' <button class="oc-btn oc-btn-ghost oc-btn-sm" data-action="copy-config-legacy-key" title="' + esc(T('legacyKeyCopyTitle')) + '">' + T('tokenCopy') + '</button></div>'
      : '<div class="oc-hint">' + T('legacyKeyNotConfigured') + '</div>';
    el.innerHTML = dBlock('legacyKeyTitle', 'legacyKeySub',
      '<div class="cookie-import">' +
        '<input class="oc-input oc-grow oc-min-200" id="detail-legacy-key-paste" type="password" placeholder="' + esc(T('legacyKeyPlaceholder')) + '" autocomplete="off" aria-label="' + esc(T('legacyKeyTitle')) + '">' +
        '<button class="oc-btn oc-btn-primary" data-action="save-legacy-key">' + T('legacyKeySave') + '</button>' +
        (has ? '<button class="oc-btn" data-action="clear-legacy-key">' + T('legacyKeyClear') + '</button>' : '') +
      '</div>' + configured + dupWarn);
  }
  function saveLegacyKey() {
    var id = detailState.id;
    var val = $('detail-legacy-key-paste').value.trim();
    if (!val) { flash(T('legacyKeyEmpty'), true); return; }
    api('PATCH', '/__admin/api/accounts/' + id, { legacyKey: val })
      .then(function (r) {
        if (r.ok) { $('detail-legacy-key-paste').value = ''; flash(T('legacyKeySaved')); tick(true); }
        else flash(errMsg(r), true);
      });
  }
  function clearLegacyKey() {
    var id = detailState.id;
    api('PATCH', '/__admin/api/accounts/' + id, { legacyKey: null })
      .then(function (r) {
        if (r.ok) { flash(T('legacyKeyCleared')); tick(true); }
        else flash(errMsg(r), true);
      });
  }
  /** 配置区「复制」：GET legacy-key plain → 剪贴板（明文只在进程内流转，不落 DOM）。 */
  function copyConfigLegacyKey() {
    var id = detailState.id;
    if (id == null) return;
    api('GET', '/__admin/api/legacy-key/' + id + '/plain', null).then(function (r) {
      if (r.ok && r.json && r.json.data && r.json.data.key) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(r.json.data.key).then(function () { flash(T('copied')); }, function () { flash(T('opFail'), true); });
        } else {
          flash(T('opFail'), true);
        }
      } else {
        flash(errMsg(r), true);
      }
    }).catch(function () { flash(T('opFail'), true); });
  }

  function loadGo(id, fromTick) {
    if (!legacyEligible(id)) return;
    if (legacyDetailFresh(id, 'go', !fromTick)) return;
    return api('GET', '/__admin/api/legacy/account/' + id + '/go', null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态：旧账号慢响应不渲染进新视图
      var el = $('detail-go');
      if (!r.ok || !r.json || r.json.ok === false || !r.json.data || !r.json.data.go) {
        if (r.status === 404) { el.innerHTML = ''; return; }  // 非 legacy workspace 静默隐藏
        if (r.status === 401 || r.status === 403) {
          // 确定性配置错误（无 cookie / legacy key 无效）：打点 TTL 门，2s tick
          // 不再反复打上游（zen 401 是确定性的，不会自愈）。用户修好后的手动
          // 刷新（save/import → tick(true)/loadAccountDetail）是 force，绕过 TTL。
          // 网络/上游瞬时失败（.catch / 其他状态码）不打点——保留 2s 重试自愈。
          legacyDetailMark(id, 'go');
          detailErr('go', T('legacyCookieMissing'));
          return;
        }
        detailErr('go', errMsg(r));
        return;
      }
      legacyDetailMark(id, 'go');
      renderGo(r.json.data.go, id, fromTick);
    }).catch(function () { if (detailState.id !== id) return; detailErr('go', T('consoleUnavailable')); });
  }

  /** Go 订阅区块：三窗口用量进度条 + 重置时间 + 开关。
   *  窗口数据只有百分比 + 重置秒数（legacy.ts GoUsageWindow 无已用/限额数值），
   *  按「每周 77% · 重置于 X」口径同行展示；超额（>100）钳到 100 画条。 */
  function renderGo(go, id, fromTick) {
    if (!clearSticky('go', fromTick)) return;
    // 窗口可能为 null（未订阅/解析失败）——渲染「—」，不崩（审查 H4）。
    var row = function (label, w) {
      if (!w || typeof w !== 'object') {
        return '<div class="go-row"><div class="go-l"><span class="go-label">' + label + '</span><span class="go-pct">—</span></div></div>';
      }
      var pct = typeof w.usagePercent === 'number' ? Math.max(0, Math.min(100, w.usagePercent)) : 0;
      var pctTxt = pct.toFixed(0) + '%';
      var resetTxt = w.resetInSec > 0 ? ' · ' + T('goReset') + ' ' + hms(w.resetInSec * 1000) : '';
      return '<div class="go-row">' +
        '<div class="go-l"><span class="go-label">' + label + '</span>' +
          '<span class="go-pct">' + pctTxt + '<span class="go-reset">' + resetTxt + '</span></span></div>' +
        '<div class="meter"><div class="meter-bg"><div class="meter-fill" style="width:' + pct + '%"></div></div></div>' +
        '</div>';
    };
    var toggles =
      '<div class="go-toggles">' +
        '<label class="go-toggle oc-check"><input type="checkbox" data-go-toggle="useBalance" data-id="' + id + '"' + (go.useBalance ? ' checked' : '') + '><span class="oc-check-box"></span><span class="oc-check-label">' + T('goUseBalance') + '</span></label>' +
        '<label class="go-toggle oc-check"><input type="checkbox" data-go-toggle="chinaModels" data-id="' + id + '"' + (go.chinaModels ? ' checked' : '') + '><span class="oc-check-box"></span><span class="oc-check-label">' + T('goChinaModels') + '</span></label>' +
      '</div>';
    $('detail-go').innerHTML = dBlock('goSub', 'goSubHint',
      (go.subscribed ? '' : '<div class="oc-hint">' + T('goNotSubscribed') + '</div>') +
      row(T('goRolling'), go.rolling) +
      row(T('goWeekly'), go.weekly) +
      row(T('goMonthly'), go.monthly) +
      toggles +
      '<div class="oc-hint-err" id="go-err"></div>');
  }

  // billing 详情块前端 TTL 门（需求 2）：console 服务端已有 30s 读缓存兜住上游，
  // 前端再挡一层 2s tick 的 HTTP 往返（balance/ledger/cookie 状态是分钟级变化）。
  // 与 legacy 详情 TTL 同语义：成功渲染后打点（按账号 id 记，切账号不误命中）；
  // 失败不打点（保留 2s 自愈）。用户操作（opDone/刷新余额 → loadBilling(id, false)）
  // 绕过 TTL。
  var billingDetailAt = {};  // id -> 最近成功渲染时刻
  function billingFresh(id, fromTick) {
    var at = billingDetailAt[id];
    return !!fromTick && !!at && (Date.now() - at) < LEGACY_DETAIL_TTL;
  }

  function loadBilling(id, fromTick) {
    if (billingFresh(id, fromTick)) return;
    return api('GET', '/__admin/api/console/account/' + id + '/billing', null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态：旧账号慢响应不渲染进新视图
      if (!r.ok || !r.json || r.json.ok === false || !r.json.data) {
        detailErr('billing', errMsg(r));  // detailErr 统一处理 env 中性化/凭据类中性化
        $('detail-autorecharge').innerHTML = '';
        return;
      }
      billingDetailAt[id] = Date.now();
      renderBilling(r.json.data, fromTick);
    }).catch(function () { if (detailState.id !== id) return; detailErr('billing', T('consoleUnavailable')); });
  }
  function renderBilling(data, fromTick) {
    // sticky 错误在自动轮询成功时不覆盖（detailErr 的错误要持续显示到用户操作）。
    if (!clearSticky('billing', fromTick)) return;
    detailState.billing = data;
    // balance/promotional 后端已是美元（microCentsToDollars 转换过，e2e 钉住
    // data.balance === 42.18）——直接 toFixed(2)，不再过 money()（money 是
    // microCents→美元，再除一次 1e8 会把非零余额压成 $0.00）。对齐账号列表 accountCard。
    var bal = data.balance == null ? '—' : '$' + Number(data.balance).toFixed(2);
    var promo = Number(data.promotional || 0) > 0
      ? '<div class="balance-card"><div class="v">$' + Number(data.promotional).toFixed(2) + '</div><div class="l">' + T('promotional') + '</div></div>'
      : '';
    var pm = data.paymentMethods || [];
    var pmTxt = pm.length ? pm.map(function (m) {
      return esc(m.brand || m.type || 'card') + (m.last4 ? ' •••• ' + esc(m.last4) : '');
    }).join(' · ') : T('none');
    var ledger = data.ledger || [];
    var ledgerHtml = ledger.length
      ? ledger.map(function (l) {
          var amt = l.amountMicroCents != null ? money(l.amountMicroCents)
            : (l.amount != null ? '$' + Number(l.amount).toFixed(2) : '');
          var at = l.timeCreated || l.createdAt;
          return '<div class="key-row"><span class="fp">' + esc(l.description || l.kind || l.type || '—') + '</span>' +
            (at ? '<span class="k-meta">' + dateFmt(at) + '</span>' : '') +
            '<span class="k-meta">' + amt + '</span></div>';
        }).join('')
      : '<div class="oc-hint">' + T('none') + '</div>';
    $('detail-billing').innerHTML = dBlock('balanceTitle', 'balanceSub',
      '<div class="balance-hero"><div class="bh-v">' + bal + '</div><div class="bh-l">' + T('currentBalance') + '</div></div>' +
      '<div class="balance-row">' + promo +
        '<div class="balance-card"><div class="v">' + pmTxt + '</div><div class="l">' + T('paymentMethods') + '</div></div>' +
      '</div>' +
      '<div class="keys"><div class="keys-hd">' + T('ledger') + '</div>' + ledgerHtml + '</div>');
    var ar = data.autoRecharge || {};
    var arVal = ar.thresholdDollars == null ? '—' : '$' + Number(ar.thresholdDollars).toFixed(2);
    var arAmt = ar.rechargeAmountDollars == null ? '—' : '$' + Number(ar.rechargeAmountDollars).toFixed(2);
    $('detail-autorecharge').innerHTML = dBlock('autoRechargeTitle', 'autoRechargeSub',
      '<div class="balance-row">' +
        '<div class="balance-card"><div class="v ' + (ar.enabled ? 's-ok' : 'w') + '">' + T(ar.enabled ? 'enabled' : 'disabled') + '</div><div class="l">' + T('autoRechargeTitle') + '</div></div>' +
        '<div class="balance-card"><div class="v">' + arVal + '</div><div class="l">' + T('threshold') + '</div></div>' +
        '<div class="balance-card"><div class="v">' + arAmt + '</div><div class="l">' + T('rechargeAmount') + '</div></div>' +
      '</div>' +
      '<div class="d-ops"><button class="oc-btn" data-action="configure-ar">' + T('configure') + '</button></div>');
    var cs = data.cookieState || 'ok';
    var cw = $('detail-cookie');
    var acct = detailState.id != null ? findAccount(detailState.id) : null;
    // env 代理账号（hasConsole=false）与控制台无关：不显示 cookie 导入提示。
    if (cs === 'ok' || (acct && !acct.hasConsole)) {
      cw.hidden = true;
    } else {
      cw.hidden = false;
      // oauth-invalid：OAuth Bearer 失效（refresh_token 过期/撤销）——恢复路径是
      // 重新授权，不是更新 cookie；oauth 账号本来就没有 cookie 可换。
      var oauthOnly = cs === 'oauth-invalid';
      $('detail-cookie-t').textContent = cs === 'invalid' ? T('cookieInvalid')
        : oauthOnly ? T('oauthInvalid')
        : T('cookieMissing');
      $('detail-cookie-import').hidden = oauthOnly;
      $('detail-oauth-row').hidden = false;
    }
  }

  function loadUsage() {
    var id = detailState.id;
    if (id == null) return;
    return api('GET', '/__admin/api/console/account/' + id + '/usage?range=' + detailState.range, null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态：旧账号慢响应不渲染进新视图
      if (!r.ok || !r.json || r.json.ok === false || !r.json.data) {
        detailErr('usage', errMsg(r));
        return;
      }
      renderUsageDetail(r.json.data);
    }).catch(function () { if (detailState.id !== id) return; detailErr('usage', T('usageUnavailable')); });
  }
  /** 每日成本趋势柱（最近 7 天，最高柱 accent 实色）。无成本数据返回提示。 */
  function trendHtml(byDay) {
    if (!byDay || !byDay.length) return '';
    var days = byDay.slice(-7).filter(function (d) {
      var c = Number(d.totalCostMicroCents);
      return isFinite(c) && c > 0;
    });
    if (!days.length) return '<div class="oc-hint">' + T('noTrend') + '</div>';
    var max = 0;
    for (var i = 0; i < days.length; i++) max = Math.max(max, Number(days[i].totalCostMicroCents));
    var bars = days.map(function (d) {
      var c = Number(d.totalCostMicroCents);
      var h = max > 0 ? Math.max(4, Math.round(c / max * 60)) : 4;
      return '<div class="trend-bar">' +
        '<span class="trend-v">' + money(c) + '</span>' +
        '<span class="trend-col' + (c === max ? ' peak' : '') + '" style="height:' + h + 'px"></span>' +
        '<span class="trend-l">' + esc(d.date || '—') + '</span>' +
        '</div>';
    }).join('');
    return '<div class="trend">' + bars + '</div>';
  }
  function renderUsageDetail(data) {
    if (!clearSticky('usage')) return;
    var s = data.summary || {};
    var rows = (data.byDay || []).map(function (d) {
      var amt = d.costMicroCents != null ? money(d.costMicroCents)
        : (d.totalCostMicroCents != null ? money(d.totalCostMicroCents)
        : (d.cost != null ? '$' + Number(d.cost).toFixed(2) : '—'));
      var req = d.requests != null ? d.requests : (d.totalRequests != null ? d.totalRequests : '—');
      return '<tr><td>' + esc(d.date || d.day || '—') + '</td><td>' + esc(req) + '</td><td>' + amt + '</td></tr>';
    }).join('');
    $('detail-usage').innerHTML = dBlock('detailUsageTitle', 'detailUsageSub',
      '<div class="range">' +
        '<button class="oc-btn oc-btn-sm range-btn' + (detailState.range === '24h' ? ' active' : '') + '" data-range="24h">24h</button>' +
        '<button class="oc-btn oc-btn-sm range-btn' + (detailState.range === '7d' ? ' active' : '') + '" data-range="7d">7d</button>' +
      '</div>' +
      '<div class="d-stats">' +
        '<div class="stat"><div class="v">' + fmt(s.totalRequests) + '</div><div class="l">' + T('requests') + '</div></div>' +
        '<div class="stat"><div class="v">' + fmt(s.totalInputTokens) + '</div><div class="l">' + T('inputTokens') + '</div></div>' +
        '<div class="stat"><div class="v">' + fmt(s.totalOutputTokens) + '</div><div class="l">' + T('outputTokens') + '</div></div>' +
        '<div class="stat"><div class="v">' + money(s.totalCostMicroCents) + '</div><div class="l">' + T('cost') + '</div></div>' +
      '</div>' +
      '<div class="sub" style="margin-top:14px">' + T('costTrend') + '</div>' +
      trendHtml(data.byDay) +
      '<table class="tbl"><thead><tr><th>' + T('date') + '</th><th>' + T('requests') + '</th><th>' + T('cost') + '</th></tr></thead><tbody>' +
      (rows || '<tr><td>' + T('none') + '</td></tr>') + '</tbody></table>');
  }

  // ── P0：模型消费 / 成员消费 / 成员预算状态 / 模型定价 ──
  function loadModelsUsage(id) {
    return api('GET', '/__admin/api/console/account/' + id + '/usage/models?range=' + detailState.range, null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态
      var el = $('detail-models-usage');
      if (!el) return;
      if (!r.ok || !r.json || r.json.ok === false || !r.json.data) { el.innerHTML = ''; return; }
      renderModelsUsage((r.json.data.items) || []);
    }).catch(function () { if (detailState.id !== id) return; var el = $('detail-models-usage'); if (el) el.innerHTML = ''; });
  }
  function renderModelsUsage(items) {
    if (!items.length) { $('detail-models-usage').innerHTML = ''; return; }
    var rows = items.map(function (m) {
      var tok = (Number(m.totalInputTokens) || 0) + (Number(m.totalOutputTokens) || 0);
      return '<tr><td>' + esc(m.model || '—') + '</td>' +
        '<td>' + fmt(m.totalRequests) + '</td>' +
        '<td>' + fmt(tok) + '</td>' +
        '<td>' + money(m.totalCostMicroCents) + '</td></tr>';
    }).join('');
    $('detail-models-usage').innerHTML = dBlock('modelUsageTitle', 'modelUsageSub',
      '<table class="tbl"><thead><tr><th>' + T('modelAlias') + '</th><th>' + T('requests') + '</th><th>' + T('tokens') + '</th><th>' + T('cost') + '</th></tr></thead><tbody>' +
      rows + '</tbody></table>');
  }
  function loadUsersUsage(id) {
    return api('GET', '/__admin/api/console/account/' + id + '/usage/users?range=' + detailState.range, null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态
      var el = $('detail-users-usage');
      if (!el) return;
      if (!r.ok || !r.json || r.json.ok === false || !r.json.data) { el.innerHTML = ''; return; }
      renderUsersUsage((r.json.data.items) || []);
    }).catch(function () { if (detailState.id !== id) return; var el = $('detail-users-usage'); if (el) el.innerHTML = ''; });
  }
  function renderUsersUsage(items) {
    if (!items.length) { $('detail-users-usage').innerHTML = ''; return; }
    var rows = items.map(function (u) {
      var name = u.email || u.name || u.userId || '—';
      var tok = (Number(u.totalInputTokens) || 0) + (Number(u.totalOutputTokens) || 0);
      return '<tr><td>' + esc(name) + '</td>' +
        '<td>' + fmt(u.totalRequests) + '</td>' +
        '<td>' + fmt(tok) + '</td>' +
        '<td>' + money(u.totalCostMicroCents) + '</td></tr>';
    }).join('');
    $('detail-users-usage').innerHTML = dBlock('userUsageTitle', 'userUsageSub',
      '<table class="tbl"><thead><tr><th>' + T('memberEmail') + '</th><th>' + T('requests') + '</th><th>' + T('tokens') + '</th><th>' + T('cost') + '</th></tr></thead><tbody>' +
      rows + '</tbody></table>');
  }
  /** 成员预算状态：限/已用/超限徽标/重置时刻。无数据静默（区块里只扩表格）。 */
  function loadMemberBudgets(id) {
    return api('GET', '/__admin/api/console/account/' + id + '/budgets/users-status', null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态
      if (!r.ok || !r.json || r.json.ok === false || !r.json.data) return;
      renderMemberBudgets((r.json.data.items) || []);
    }).catch(function () {});
  }
  function renderMemberBudgets(items) {
    if (!items.length) return;
    var rows = items.map(function (b) {
      var limit = b.limitMicroCents != null ? money(b.limitMicroCents) : T('notSet');
      var badge = b.exceeded ? '<span class="oc-chip st-error">' + T('exceeded') + '</span>' : '';
      return '<tr>' +
        '<td>' + esc(b.email || b.userId || '—') + '</td>' +
        '<td>' + limit + '</td>' +
        '<td>' + money(b.spentMicroCents) + '</td>' +
        '<td>' + badge + '</td>' +
        '<td class="t-hide">' + dateFmt(b.resetsAt) + '</td>' +
        '</tr>';
    }).join('');
    var box = $('detail-budgets');
    if (!box) return;
    // 成员预算表追加进 budgets 面板的内容区（面板未渲染时兜底到容器本身）。
    var bd = box.querySelector('.panel-bd') || box;
    bd.insertAdjacentHTML('beforeend',
      '<div class="sub" style="margin-top:14px">' + T('memberBudgetTitle') + '</div>' +
      '<table class="tbl"><thead><tr><th>' + T('memberEmail') + '</th><th>' + T('monthlyLimit') + '</th><th>' + T('spent') + '</th><th></th><th class="t-hide">' + T('resetsAt') + '</th></tr></thead><tbody>' +
      rows + '</tbody></table>');
  }
  /** 模型定价：简化展示（模型名 + 输入/输出每百万 token 美元），61 模型限高滚动。 */
  function loadPricing(id) {
    return api('GET', '/__admin/api/console/account/' + id + '/models-pricing', null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态
      var el = $('detail-pricing');
      if (!el) return;
      if (!r.ok || !r.json || r.json.ok === false || !r.json.data) { el.innerHTML = ''; return; }
      renderPricing(r.json.data);
    }).catch(function () { if (detailState.id !== id) return; var el = $('detail-pricing'); if (el) el.innerHTML = ''; });
  }
  function renderPricing(data) {
    var provs = (data && data.providers) || {};
    var rows = '';
    var count = 0;
    // 收集上游定价模型名（「添加模型」自动补全候选）。
    maPricingModels = [];
    for (var pid in provs) {
      if (!Object.prototype.hasOwnProperty.call(provs, pid)) continue;
      var p = provs[pid] || {};
      var models = p.models || {};
      for (var mid in models) {
        if (!Object.prototype.hasOwnProperty.call(models, mid)) continue;
        maPricingModels.push(mid);
        var m = models[mid] || {};
        var cost = (m.cost && m.cost[0]) || {};
        var inp = cost.input != null ? '$' + Number(cost.input).toFixed(4) + '/M' : '—';
        var out = cost.output != null ? '$' + Number(cost.output).toFixed(4) + '/M' : '—';
        rows += '<tr><td>' + esc(mid) + '</td>' +
          '<td class="t-hide">' + esc(m.name || '—') + '</td>' +
          '<td>' + inp + '</td>' +
          '<td>' + out + '</td></tr>';
        count++;
      }
    }
    if (!count) { $('detail-pricing').innerHTML = ''; return; }
    $('detail-pricing').innerHTML = dBlock('pricingTitle', 'pricingSub',
      '<div class="tbl-scroll"><table class="tbl"><thead><tr><th>' + T('modelAlias') + '</th><th class="t-hide">' + T('name') + '</th><th>' + T('inPerMtok') + '</th><th>' + T('outPerMtok') + '</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>');
  }
  /** 旧版计费：余额（美元）+ 自动充值 + 最近 5 笔支付。失败语义与 legacy keys 同款。
   *  fromTick：2s 轮询发起时 TTL 门生效（服务端 30s 缓存兜底）；用户操作绕过。 */
  function loadLegacyBilling(id, fromTick) {
    if (!legacyEligible(id)) return;
    if (legacyDetailFresh(id, 'billing', !fromTick)) return;
    return api('GET', '/__admin/api/legacy/account/' + id + '/billing', null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态
      var el = $('detail-legacy-billing');
      if (!el) return;
      if (!r.ok && r.status === 404) { el.innerHTML = ''; return; }
      if (!r.ok || !r.json || r.json.ok === false || !r.json.data || !r.json.data.billing) {
        el.innerHTML = isLegacyCookieError(r)
          ? '<div class="oc-hint oc-hint-err">' + esc(T('legacyCookieMissing')) + '</div>'
          : '';
        return;
      }
      legacyDetailMark(id, 'billing');
      renderLegacyBilling(r.json.data.billing);
    }).catch(function () {
      if (detailState.id !== id) return;  // 详情切换竞态
      var el = $('detail-legacy-billing');
      if (el) el.innerHTML = '';
    });
  }
  function renderLegacyBilling(b) {
    var bal = b.balanceDollars != null ? '$' + Number(b.balanceDollars).toFixed(2) : '—';
    var rl = b.reload;
    var moneyOf = function (n) { return n != null && isFinite(Number(n)) ? '$' + Number(n).toFixed(2) : '—'; };
    var reload = rl
      ? '<div class="balance-row">' +
          '<div class="balance-card"><div class="v ' + (rl.enabled ? 's-ok' : 'w') + '">' + T(rl.enabled ? 'enabled' : 'disabled') + '</div><div class="l">' + T('legacyReload') + '</div></div>' +
          '<div class="balance-card"><div class="v">' + moneyOf(rl.thresholdDollars) + '</div><div class="l">' + T('threshold') + '</div></div>' +
          '<div class="balance-card"><div class="v">' + moneyOf(rl.amountDollars) + '</div><div class="l">' + T('rechargeAmount') + '</div></div>' +
        '</div>'
      : '<div class="oc-hint">' + T('legacyReload') + ' ' + T('disabled') + '</div>';
    var pays = (b.payments || []).slice(0, 5);
    var payHtml = pays.length
      ? pays.map(function (p) {
          var amt = p.amount != null ? '$' + Number(p.amount).toFixed(2) : '—';
          return '<div class="key-row"><span class="fp cut">' + esc(p.description || '—') + '</span>' +
            (p.date ? '<span class="k-meta">' + dateFmt(p.date) + '</span>' : '') +
            '<span class="k-meta">' + amt + '</span></div>';
        }).join('')
      : '<div class="oc-hint">' + T('noPayments') + '</div>';
    $('detail-legacy-billing').innerHTML = dBlock('legacyBilling', 'legacyBillingSub',
      '<div class="balance-hero"><div class="bh-v">' + bal + '</div><div class="bh-l">' + T('balance') + '</div></div>' +
      reload +
      '<div class="keys"><div class="keys-hd">' + T('paymentHistory') + '</div>' + payHtml + '</div>');
  }

  function loadMembers(id) {    return api('GET', '/__admin/api/console/account/' + id + '/members', null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态
      if (!r.ok || !r.json) { detailErr('members', errMsg(r)); return; }
      renderMembers(r.json);
    }).catch(function () { if (detailState.id !== id) return; detailErr('members', T('consoleUnavailable')); });
  }
  function renderMembers(j) {
    if (!clearSticky('members')) return;
    var items = (j && j.data && j.data.items) || [];
    var rows = items.map(function (m) {
      return '<tr>' +
        '<td>' + esc(m.email || m.userId || '—') + '</td>' +
        '<td>' + esc(m.role || '—') + '</td>' +
        '<td class="t-hide">' + dateFmt(m.createdAt) + '</td>' +
        '</tr>';
    }).join('');
    $('detail-members').innerHTML = dBlock('membersTitle', 'membersSub',
      '<table class="tbl"><thead><tr><th>' + T('memberEmail') + '</th><th>' + T('role') + '</th><th class="t-hide">' + T('joined') + '</th></tr></thead><tbody>' +
      (rows || '<tr><td>' + T('noMembers') + '</td></tr>') + '</tbody></table>');
  }

  function loadSa(id) {
    return api('GET', '/__admin/api/console/account/' + id + '/keys', null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态
      if (!r.ok || !r.json) { detailErr('sa', errMsg(r)); return; }
      renderSa(r.json);
    }).catch(function () { if (detailState.id !== id) return; detailErr('sa', T('consoleUnavailable')); });
  }
  function renderSa(j) {
    if (!clearSticky('sa')) return;
    var items = (j && j.data && j.data.items) || [];
    var rows = items.map(function (k) {
      var saId = k.id != null ? k.id : (k.saId != null ? k.saId : '');
      return '<tr>' +
        '<td>' + esc(k.name || k.displayName || k.id || '—') + '</td>' +
        '<td class="t-hide">' + dateFmt(k.createdAt || k.timeCreated) + '</td>' +
        '<td><button class="oc-btn oc-btn-ghost oc-btn-sm t-del" data-action="del-sa" data-said="' + esc(saId) + '">' + T('delete') + '</button></td>' +
        '</tr>';
    }).join('');
    $('detail-sa').innerHTML = dBlock('saTitle', 'saSub',
      '<table class="tbl"><thead><tr><th>' + T('saName') + '</th><th class="t-hide">' + T('created') + '</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td>' + T('noSa') + '</td></tr>') + '</tbody></table>' +
      '<div class="d-ops"><button class="oc-btn" data-action="create-sa">' + T('createSa') + '</button></div>');
  }

  // ── 旧版 workspace（opencode.ai 老控制台）的 key 管控 ────────
  // 与 console 区块独立：不依赖 cookieState，单独调 legacy 端点。
  // 失败语义：404 = 该账号没有 legacy workspace → 静默隐藏区块；
  // cookie 缺失/格式错误 → 明确提示；其余网络错误 → 静默隐藏。
  function loadLegacyKeys(id, fromTick) {
    if (!legacyEligible(id)) return;
    if (legacyDetailFresh(id, 'keys', !fromTick)) return;
    return api('GET', '/__admin/api/legacy/account/' + id + '/keys', null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态
      var el = $('detail-legacy');
      if (!el) return;
      if (!r.ok && r.status === 404) { el.innerHTML = ''; return; }
      if (!r.ok || !r.json || r.json.ok === false) {
        // 错误走 sticky（对抗审查 M1：legacy 复制/加载失败不再被 2s 轮询刷掉）。
        if (r.status === 401 || r.status === 403) { detailErr('legacy', T('legacyCookieMissing')); return; }
        detailErr('legacy', errMsg(r));
        return;
      }
      legacyDetailMark(id, 'keys');
      renderLegacyKeys(r.json, fromTick);
    }).catch(function () { if (detailState.id !== id) return; detailErr('legacy', T('consoleUnavailable')); });
  }
  /** cookie 相关失败识别：401/403，或错误 type/message 里带 cookie 字样。 */
  function isLegacyCookieError(r) {
    if (r.status === 401 || r.status === 403) return true;
    var j = r.json;
    if (!j) return false;
    var err = j.error || j;
    var t = String(err.type || '') + ' ' + String(err.message || '');
    return t.toLowerCase().indexOf('cookie') >= 0;
  }
  function renderLegacyKeys(j, fromTick) {
    if (!clearSticky('legacy', fromTick)) return;
    // 后端契约：{ok, data:{keys:[{name, masked, creatorEmail, id}]}}（旧版 workspace 的 key）。
    var items = (j && j.data && j.data.keys) || [];
    var rows = items.map(function (k) {
      var name = k.name || '';
      var keyId = k.id || '';
      return '<tr>' +
        '<td>' + esc(name) + '</td>' +
        '<td><span class="w">' + esc(k.masked || '—') + '</span></td>' +
        '<td class="t-hide">' + esc(k.creatorEmail || '—') + '</td>' +
        '<td>' +
          '<button class="oc-btn oc-btn-ghost oc-btn-sm" data-action="copy-legacy-key" data-keyid="' + esc(keyId) + '" title="' + T('legacyKeyCopyTitle') + '">' + T('tokenCopy') + '</button>' +
          ' <button class="oc-btn oc-btn-ghost oc-btn-sm t-del" data-action="del-legacy-key" data-keyid="' + esc(keyId) + '">' + T('delete') + '</button>' +
        '</td>' +
        '</tr>';
    }).join('');
    $('detail-legacy').innerHTML = dBlock('legacyKeys', 'legacySub',
      '<table class="tbl"><thead><tr><th>' + T('keyName') + '</th><th>' + T('masked') + '</th><th class="t-hide">' + T('creator') + '</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td>' + T('noLegacyKeys') + '</td></tr>') + '</tbody></table>' +
      '<div class="oc-hint-err" id="legacy-copy-err"></div>' +
      '<div class="d-ops"><button class="oc-btn" data-action="create-legacy-key">' + T('createKey') + '</button>' +
      '<button class="oc-btn" data-action="refresh-legacy-keys">' + T('refreshKeys') + '</button></div>');
  }
  /** legacy key 明文复制：GET /keys/plain（裸 JSON 数组 [{id,name,key}]）→
   *  按 id 匹配 → navigator.clipboard 写入 → flash 成功；失败显示 oc-hint-err。
   *  accountId 可空（详情页省略）：为空回落 detailState.id；列表页卡片必须带上。 */
  function copyLegacyKey(keyId, accountId) {
    var aid = accountId != null && accountId !== '' ? accountId : detailState.id;
    var errEl = $('legacy-copy-err');
    if (errEl) errEl.textContent = '';
    api('GET', '/__admin/api/legacy/account/' + aid + '/keys/plain', null).then(function (r) {
      var fail = function (msg) {
        stickyErr['legacy'] = true; // 复制失败也 sticky：不被 2s 轮询的 loadLegacyKeys 刷掉（对抗审查 M1）
        if (errEl) { errEl.textContent = msg; return; }
        flash(msg, true);
      };
      if (!r.ok || !Array.isArray(r.json)) { fail(errMsg(r)); return; }
      var found = '';
      for (var i = 0; i < r.json.length; i++) {
        if (String(r.json[i].id) === String(keyId)) { found = r.json[i].key || ''; break; }
      }
      if (!found) { fail(T('legacyKeyNotFound')); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(found).then(function () { flash(T('tokenCopied')); }, function () { fail(T('opFail')); });
      } else {
        fail(T('opFail'));
      }
    }).catch(function () {
      var errEl2 = $('legacy-copy-err');
      if (errEl2) errEl2.textContent = T('opFail');
      else flash(T('opFail'), true);
    });
  }
  /** 创建/删除成功统一收尾：关弹层 + flash + 重拉列表（不依赖 tick 的 console 刷新）。 */
  function legacyOpDone(r, okMsg) {
    if (r.ok) {
      closeConfirm();
      flash(okMsg);
      loadLegacyKeys(detailState.id);
    } else {
      unlockConfirm();
      $('confirm-err').textContent = errMsg(r);
    }
  }
  function createLegacyKey() {
    var id = detailState.id;
    openConfirm({
      title: T('legacyCreateTitle'),
      okText: T('createKey'),
      body: '<div class="oc-form"><div class="oc-field oc-full"><label for="legacy-key-name">' + T('keyName') + '</label>' +
        '<input class="oc-input" id="legacy-key-name" autocomplete="off"></div></div>',
      run: function () {
        var name = $('legacy-key-name').value.trim();
        if (!name) { $('confirm-err').textContent = T('nameRequired'); unlockConfirm(); return; }
        api('POST', '/__admin/api/legacy/account/' + id + '/keys', { name: name })
          .then(function (r) { legacyOpDone(r, T('keyCreated')); });
      }
    });
  }
  function delLegacyKey(keyId) {
    var id = detailState.id;
    openConfirm({
      title: T('legacyKeys'),
      okText: T('delete'),
      danger: true,
      body: '<div class="oc-hint">' + T('delLegacyKeyConfirm') + '</div>',
      run: function () {
        // 后端按 keyId（key_ 前缀）删除——传名称永远 400（审查 H1）。
        api('DELETE', '/__admin/api/legacy/account/' + id + '/keys/' + encodeURIComponent(keyId), null)
          .then(function (r) { legacyOpDone(r, T('keyDeleted')); });
      }
    });
  }

  function loadProviders(id) {
    return api('GET', '/__admin/api/console/account/' + id + '/providers', null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态
      if (!r.ok || !r.json) { detailErr('providers', errMsg(r)); return; }
      renderProviders(r.json);
    }).catch(function () { if (detailState.id !== id) return; detailErr('providers', T('consoleUnavailable')); });
  }
  function renderProviders(arr) {
    if (!clearSticky('providers')) return;
    var items = Array.isArray(arr) ? arr : (arr && arr.data && arr.data.items ? arr.data.items : []);
    var rows = items.map(function (p) {
      var mc = p.models ? p.models.length : (p.modelCount != null ? p.modelCount : '—');
      return '<tr><td>' + esc(p.name || p.configKey || p.id || '—') + '</td>' +
        '<td class="t-hide">' + esc(mc) + '</td>' +
        '<td><span class="' + (p.enabled === false ? 'w' : 's-ok') + '">' + T(p.enabled === false ? 'disabled' : 'enabled') + '</span></td></tr>';
    }).join('');
    $('detail-providers').innerHTML = dBlock('providersTitle', 'providersSub',
      '<table class="tbl"><thead><tr><th>' + T('provider') + '</th><th class="t-hide">' + T('modelCount') + '</th><th>' + T('status') + '</th></tr></thead><tbody>' +
      (rows || '<tr><td>' + T('noProviders') + '</td></tr>') + '</tbody></table>');
  }

  function loadBudgets(id) {
    return api('GET', '/__admin/api/console/account/' + id + '/budgets', null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态
      if (!r.ok || !r.json) { detailErr('budgets', errMsg(r)); return; }
      renderBudgets(r.json);
    }).catch(function () { if (detailState.id !== id) return; detailErr('budgets', T('consoleUnavailable')); });
  }
  function budgetRow(scope, val) {
    var v;
    if (scope === 'user' && val == null) {
      // 用户级预算通道未接入（ConsoleClient 无 budgetsUser），不渲染假按钮。
      v = '<span class="w">' + T('notConnected') + '</span>';
    } else {
      v = val
        ? '$' + Number(val.limitDollars != null ? val.limitDollars : (val.limit != null ? val.limit : 0)).toFixed(2)
        : T('notSet') + ' <button class="oc-btn" data-action="set-budget" data-scope="' + scope + '">' + T('set') + '</button>';
    }
    return '<div class="key-row"><span class="fp">' + T(scope === 'org' ? 'orgBudget' : 'userBudget') + '</span><span class="k-meta">' + v + '</span></div>';
  }
  function renderBudgets(b) {
    if (!clearSticky('budgets')) return;
    var d = b && b.data ? b.data : (b || {});
    $('detail-budgets').innerHTML = dBlock('budgetsTitle', 'budgetsSub',
      '<div class="keys">' + budgetRow('org', d.org) + budgetRow('user', d.user) + '</div>');
  }

  // ── UI v3：confirm 弹层（写操作统一入口）─────────────
  var confirmState = null;
  function openConfirm(opts) {
    $('confirm-title').textContent = opts.title;
    $('confirm-body').innerHTML = opts.body || '';
    // 弹层里的数字输入（token 数量/配额/自动充值/月限额等）挂自绘 spinner。
    mountNumSpinners($('confirm-body'));
    $('confirm-err').textContent = '';
    var ok = $('confirm-ok');
    ok.textContent = opts.okText || T('confirm');
    // 危险/普通确认由 data-variant 属性驱动（CSS [data-variant] 选择器），
    // 不再在 JS 里动态换类名。
    ok.className = 'oc-btn';
    ok.dataset.variant = opts.danger ? 'danger' : 'primary';
    ok.disabled = false;
    ok.dataset.busy = '0';
    confirmState = opts;
    $('confirm-overlay').hidden = false;
  }
  function closeConfirm() {
    $('confirm-overlay').hidden = true;
    confirmState = null;
  }
  /** 确认按钮 in-flight 锁：防双击双发（create-sa 双发=两个同名账号）。
   *  run 期间禁用按钮；opDone 或失败路径恢复。 */
  function lockConfirm() {
    var ok = $('confirm-ok');
    ok.disabled = true;
    ok.dataset.busy = '1';
    ok.textContent = T('processing');
  }
  function unlockConfirm() {
    var ok = $('confirm-ok');
    ok.disabled = false;
    ok.dataset.busy = '0';
    if (confirmState) ok.textContent = confirmState.okText || T('confirm');
  }
  /** 写操作统一收尾：成功 → 关弹层 + flash + tick 刷新 + 按操作类型重载目标区块
   *  （tick 只重载 billing/go/legacyKeys/legacyBilling，sa/budgets/members/providers
   *  不刷新——写成功但表格不更新）；失败 → 弹层内报错。 */
  function opDone(r, okMsg, reload) {
    if (r.ok) {
      closeConfirm();
      flash(okMsg);
      tick(true);
      if (reload) reload();
    } else {
      unlockConfirm();
      $('confirm-err').textContent = errMsg(r);
    }
  }

  function configureAutoRecharge() {
    var id = detailState.id;
    var ar = (detailState.billing && detailState.billing.autoRecharge) || {};
    openConfirm({
      title: T('arModalTitle'),
      okText: T('save'),
      body: '<div class="oc-form">' +
        '<div class="oc-field oc-full"><label for="ar-enabled">' + T('arEnabled') + '</label>' +
          '<select class="oc-select" id="ar-enabled">' +
            '<option value="1"' + (ar.enabled ? ' selected' : '') + '>' + T('enabled') + '</option>' +
            '<option value="0"' + (!ar.enabled ? ' selected' : '') + '>' + T('disabled') + '</option>' +
          '</select></div>' +
        '<div class="oc-field"><label for="ar-threshold">' + T('thresholdDollars') + '</label>' +
          '<input class="oc-input" id="ar-threshold" type="number" min="1" step="1" value="' + esc(ar.thresholdDollars == null ? '' : ar.thresholdDollars) + '"></div>' +
        '<div class="oc-field"><label for="ar-amount">' + T('rechargeAmountDollars') + '</label>' +
          '<input class="oc-input" id="ar-amount" type="number" min="1" step="1" value="' + esc(ar.rechargeAmountDollars == null ? '' : ar.rechargeAmountDollars) + '"></div>' +
        '</div>',
      run: function () {
        var enabled = $('ar-enabled').value === '1';
        var thr = parseFloat($('ar-threshold').value);
        var amt = parseFloat($('ar-amount').value);
        if (enabled && (isNaN(thr) || isNaN(amt) || thr <= 0 || amt <= 0)) {
          $('confirm-err').textContent = T('arRequiresAmount');
          unlockConfirm();
          return;
        }
        api('POST', '/__admin/api/console/account/' + id + '/auto-recharge', {
          enabled: enabled,
          thresholdDollars: isNaN(thr) ? undefined : thr,
          rechargeAmountDollars: isNaN(amt) ? undefined : amt,
          confirm: true   // 弹层确认流程即服务端 confirm 信号（防误触扣款）
        }).then(function (r) { opDone(r, T('arSaved'), function () { loadBilling(id, false); }); });
      }
    });
  }

  function setMonthlyBudget(scope) {
    var id = detailState.id;
    openConfirm({
      title: T('mlModalTitle'),
      okText: T('save'),
      body: '<div class="oc-form"><div class="oc-field oc-full"><label for="ml-limit">' + T(scope === 'org' ? 'orgBudget' : 'userBudget') + '</label>' +
        '<input class="oc-input" id="ml-limit" type="number" min="0" step="1" autocomplete="off"></div></div>',
      run: function () {
        var v = parseFloat($('ml-limit').value);
        if (isNaN(v) || v < 0) { $('confirm-err').textContent = T('invalidNumber'); unlockConfirm(); return; }
        api('POST', '/__admin/api/console/account/' + id + '/monthly-limit', { limitDollars: v })
          .then(function (r) { opDone(r, T('mlSaved'), function () { loadBudgets(id); }); });
      }
    });
  }

  function createSa() {
    var id = detailState.id;
    openConfirm({
      title: T('saModalTitle'),
      okText: T('create'),
      body: '<div class="oc-form"><div class="oc-field oc-full"><label for="sa-name">' + T('saModalName') + '</label>' +
        '<input class="oc-input" id="sa-name" autocomplete="off"></div></div>',
      run: function () {
        var name = $('sa-name').value.trim();
        if (!name) { $('confirm-err').textContent = T('nameRequired'); unlockConfirm(); return; }
        api('POST', '/__admin/api/console/account/' + id + '/keys', { name: name })
          .then(function (r) { opDone(r, T('saCreated'), function () { loadSa(id); }); });
      }
    });
  }

  function delSa(saId) {
    var id = detailState.id;
    openConfirm({
      title: T('saTitle'),
      okText: T('delete'),
      danger: true,
      body: '<div class="oc-hint">' + T('delSaConfirm') + '</div>',
      run: function () {
        api('DELETE', '/__admin/api/console/account/' + id + '/keys/' + encodeURIComponent(saId), null)
          .then(function (r) { opDone(r, T('saDeleted'), function () { loadSa(id); }); });
      }
    });
  }

  function importCookie() {
    var id = detailState.id;
    openConfirm({
      title: T('cookieModalTitle'),
      okText: T('importCookie'),
      body: '<div class="oc-hint">' + T('cookieModalBody') + '</div>',
      run: function () {
        api('POST', '/__admin/api/console/import-cookie', { accountId: id })
          .then(function (r) { opDone(r, T('cookieImported'), function () { loadAccountDetail(); }); });
      }
    });
  }

  function pasteCookie() {
    var id = detailState.id;
    var val = $('detail-cookie-paste').value.trim();
    if (!val) { flash(T('cookiePasteEmpty'), true); return; }
    api('PATCH', '/__admin/api/accounts/' + id, { cookie: val })
      .then(function (r) {
        if (r.ok) { $('detail-cookie-paste').value = ''; flash(T('cookiePasted')); tick(true); }
        else flash(errMsg(r), true);
      });
  }

  // ── 事件绑定（动态 innerHTML 一律走委托）────────────
  $('accounts').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var id = Number(btn.getAttribute('data-id'));
    var act = btn.getAttribute('data-action');
    if (act === 'menu') { toggleMenu($('ops-menu-' + id)); return; }
    closeMenus();
    if (act === 'toggle-card') { toggleCard(id, btn.closest('.card')); return; }
    if (act === 'detail') { openAccountDetail(id); return; }
    if (act === 'edit') { toggleEdit(id); return; }
    if (act === 'cancel') { var ed = $('edit-' + id); if (ed) ed.hidden = true; return; }
    if (act === 'save') { saveEdit(id); return; }
    if (act === 'billing') { refreshBalance(id); return; }
    if (act === 'addkey') { addKey(id); return; }
    if (act === 'copykey') { copyKey(id, btn.getAttribute('data-fp')); return; }
    if (act === 'key-usage') { keyUsage(id, btn.getAttribute('data-fp')); return; }
    if (act === 'disable-key') { toggleKeyState(id, btn.getAttribute('data-fp'), true); return; }
    if (act === 'reset-key') { toggleKeyState(id, btn.getAttribute('data-fp'), false); return; }
    if (act === 'renamekey') { renameKey(id, btn.getAttribute('data-fp')); return; }
    if (act === 'delkey') { delKey(id, btn.getAttribute('data-fp')); return; }
    if (act === 'delete') { delAccount(id); return; }
    if (act === 'goto-tokens') { switchView('tokens'); return; }
    // 卡身空白处点击进入详情；编辑表单/菜单/输入框内不算。
    if (e.target.closest('button, input, select, .edit, .dd-menu, .key-add')) return;
    var card = e.target.closest('.card');
    if (card) openAccountDetail(Number(card.getAttribute('data-id')));
  });

  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('.tab');
    if (!b) return;
    switchView(b.getAttribute('data-tab'));
  });

  $('sidebar').addEventListener('click', function (e) {
    var b = e.target.closest('.snav');
    if (!b) return;
    var all = $('sidebar').querySelectorAll('.snav');
    for (var i = 0; i < all.length; i++) all[i].className = 'snav';
    b.className = 'snav active';
    curSub = b.getAttribute('data-sub');
    saveViewState();
    focusSidebar();
    var sec = $(curSub);
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('btn-create').addEventListener('click', createAccount);
  $('c-kind-toggle').addEventListener('click', function () { toggleMenu($('c-kind-menu')); });
  $('btn-lang').addEventListener('click', function () { toggleMenu($('lang-menu')); });
  // 账号卡片全部收起/展开（同步设置所有卡片 + localStorage fc-collapsed）。
  var btnCollapseAll = $('btn-collapse-all');
  if (btnCollapseAll) btnCollapseAll.addEventListener('click', function () { setAllCollapsed(true); });
  var btnExpandAll = $('btn-expand-all');
  if (btnExpandAll) btnExpandAll.addEventListener('click', function () { setAllCollapsed(false); });
  // 退出：清会话 cookie 回登录页（登录功能闭环）。
  $('btn-logout').addEventListener('click', function () {
    fetch('/__admin/api/logout', { method: 'POST' }).then(function () {
      window.location.href = '/__admin';
    }).catch(function () { window.location.href = '/__admin'; });
  });
  $('btn-settings-lang').addEventListener('click', function () { toggleMenu($('lang-menu-settings')); });
  $('mm-add').addEventListener('click', addModelAlias);
  $('btn-token-create').addEventListener('click', createTokens);
  $('btn-token-refresh').addEventListener('click', function () { loadTokens(true); });
  $('aa-save').addEventListener('click', saveAdminAuth);
  $('btn-akey-add').addEventListener('click', addApiKey);
  // 请求明细分页：跳页输入框/按钮 + 每页条数 + 搜索（防抖）+ prev/next
  // （越界由 fetchRequests 钳制 + 按钮禁用双兜底）。
  $('req-go').addEventListener('click', goReqPage);
  $('req-page').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') goReqPage();
  });
  var reqAllEl = $('req-all');
  if (reqAllEl) reqAllEl.addEventListener('change', function () {
    reqShowAll = reqAllEl.checked;
    reqPage = 1;
    fetchRequests();
  });
  $('req-size').addEventListener('change', function () {
    var v = Number(this.value);
    if (v === 20 || v === 50 || v === 100) {
      REQ_PAGE_SIZE = v;
      reqPage = 1;
      fetchRequests();
    }
  });
  $('req-q').addEventListener('input', function () {
    clearTimeout(reqSearchTimer);
    var q = this.value.trim();
    // 防抖 400ms：输入停顿后才发起搜索（2s tick 的 fetchRequests 不受影响，
    // 它用的仍是旧的 reqQuery，搜索条件变更只由这里驱动）。
    reqSearchTimer = setTimeout(function () { reqQuery = q; reqPage = 1; fetchRequests(); }, 400);
  });
  $('req-prev').addEventListener('click', function () {
    if (reqPage > 1) { reqPage--; fetchRequests(); }
  });
  $('req-next').addEventListener('click', function () {
    if (reqPage < Math.max(1, Math.ceil(reqTotal / REQ_PAGE_SIZE))) { reqPage++; fetchRequests(); }
  });
  // IP 统计分页 + 点 IP 筛选请求明细（动态行委托在 view-usage 上）。
  $('ip-prev').addEventListener('click', function () {
    if (ipPage > 1) { ipPage--; fetchIpStats(); }
  });
  $('ip-next').addEventListener('click', function () {
    if (ipPage < Math.max(1, Math.ceil(ipTotal / IP_PAGE_SIZE))) { ipPage++; fetchIpStats(); }
  });
  $('view-usage').addEventListener('click', function (e) {
    var ip = e.target.closest('[data-ip]');
    if (ip) filterByIp(ip.getAttribute('data-ip'));
  });
  // 分发密钥 tab：列表行是动态 innerHTML，操作走视图委托；明文弹层复制另绑。
  $('view-tokens').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var act = btn.getAttribute('data-action');
    var id = Number(btn.getAttribute('data-id')) || 0;
    if (act === 'toggle-token') { toggleToken(id); return; }
    if (act === 'edit-token') { editToken(id); return; }
    if (act === 'del-token') { delToken(id); return; }
    // RPM 保存：读同行输入框的值 → PATCH rpmLimit（0 = 不限流）。
    if (act === 'copy-token') {
      api('GET', '/__admin/api/tokens/' + id + '/plain', null).then(function (r) {
        if (!r.ok || !r.json || !r.json.data || typeof r.json.data.token !== 'string') {
          flash(r.status === 404 ? T('tokenPlainMissing') : errMsg(r), true);
          return;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(r.json.data.token).then(function () { flash(T('tokenCopied')); }, function () { flash(T('opFail'), true); });
        } else {
          flash(r.json.data.token, false);  // 无剪贴板权限时直接显示明文（管理面内）
        }
      });
      return;
    }
    if (act === 'set-rpm') {
      var rp = document.querySelector('[data-rpm-id="' + id + '"]');
      var rv = rp ? String(rp.value).trim() : '';
      var rn = Math.floor(Number(rv));
      if (rv !== '' && (!isFinite(rn) || rn < 0 || String(rn) !== rv)) {
        flash(T('tokenRpmInvalid'), true);
        return;
      }
      api('PATCH', '/__admin/api/tokens/' + id, { rpmLimit: isFinite(rn) && rn > 0 ? rn : 0 })
        .then(function (r) {
          // 失败走 flash（弹层错误对非弹层操作零反馈，对抗审查 M2）。
          if (!r.ok) { flash(errMsg(r), true); return; }
          flash(T('tokenRpmSaved'));
          loadTokens(true);
        });
      return;
    }
  });
  $('plain-list').addEventListener('click', function (e) {
    var c = e.target.closest('button[data-copy]');
    if (c) copyPlain(Number(c.getAttribute('data-copy')), c);
  });
  // model access tab：行/chip 是动态 innerHTML，走视图委托。
  var maAvailSearchEl = $('ma-avail-search');
  if (maAvailSearchEl) {
    maAvailSearchEl.addEventListener('input', function () {
      maAvailQuery = maAvailSearchEl.value.trim();
      renderMaAvail();
    });
  }
  $('view-access').addEventListener('click', function (e) {
    var gc = e.target.closest('[data-model]');
    if (gc) { maToggleSel(gc.getAttribute('data-model')); return; }
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var act = btn.getAttribute('data-action');
    if (act === 'ma-edit') {
      editModelAccess(btn.getAttribute('data-type'), btn.getAttribute('data-subject'),
        btn.getAttribute('data-name'), btn.getAttribute('data-mask'));
      return;
    }
  });
  var maSearchEl = $('ma-search');
  if (maSearchEl) maSearchEl.addEventListener('input', function () {
    maSearch = this.value.trim();
    renderModelAccess();
  });
  var maFilterEl = $('ma-filter');
  if (maFilterEl) maFilterEl.addEventListener('change', function () {
    maFilter = this.value;
    renderModelAccess();
  });
  $('ma-global-save').addEventListener('click', saveMaGlobal);
  $('ma-global-reset').addEventListener('click', resetMaGlobal);
  $('ma-global-add-btn').addEventListener('click', addMaGlobalModels);
  var maGlobalAddEl = $('ma-global-add');
  if (maGlobalAddEl) maGlobalAddEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addMaGlobalModels(); }
  });
  $('ma-refresh').addEventListener('click', function () { loadModelAccess(); });

  // m1（对抗审查）：关闭即清空明文（DOM + dataset）——「仅此一次」在页面生命周期内也成立。
  function clearPlain() {
    var el = $('plain-list');
    if (el) { el.innerHTML = ''; delete el.dataset.plain; }
    $('plain-overlay').hidden = true;
  }
  $('plain-close').addEventListener('click', clearPlain);
  // Update（OTA）：检查按钮 + 更新进度弹层关闭按钮。
  $('btn-ota-check').addEventListener('click', doOtaCheck);
  $('btn-ota-update').addEventListener('click', function () { if (otaCache && otaCache.hasUpdate) showOtaChangelog(otaCache); });
  $('update-close').addEventListener('click', function () { $('update-overlay').hidden = true; });
  $('update-overlay').addEventListener('click', function (e) {
    if (e.target === $('update-overlay')) $('update-overlay').hidden = true;
  });
  $('plain-overlay').addEventListener('click', function (e) {
    if (e.target === $('plain-overlay')) clearPlain();
  });
  // 映射表格行是动态 innerHTML，删除/编辑按钮走设置视图的事件委托。
  $('view-settings').addEventListener('click', function (e) {
    var del = e.target.closest('button[data-action="del-alias"]');
    if (del) { delModelAlias(del.getAttribute('data-alias')); return; }
    var ed = e.target.closest('button[data-action="edit-alias"]');
    if (ed) { editModelAlias(ed.getAttribute('data-alias')); return; }
    // 实验开关 toggle（PATCH 反值，立即生效并落库）。
    var tg = e.target.closest('button[data-action="toggle-scale"]');
    if (tg) { patchSetting('scaleClientTokens', tg.getAttribute('data-on') !== '1'); return; }
    var tc = e.target.closest('button[data-action="toggle-compact"]');
    if (tc) { patchSetting('compactEnabled', tc.getAttribute('data-on') !== '1'); return; }
    var rk = e.target.closest('button[data-action="reveal-akey"]');
    if (rk) {
      var idx = rk.getAttribute('data-index');
      api('GET', '/__admin/api/settings/keys/' + idx + '/plain', null).then(function (r) {
        if (r.ok && r.json && r.json.data && r.json.data.key) {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(r.json.data.key).then(function () { flash(T('tokenCopied')); },
              function () { flash(T('opFail'), true); });
          } else { flash(T('opFail'), true); }
        } else { flash(errMsg(r)); }
      });
      return;
    }
    var ak = e.target.closest('button[data-action="del-akey"]');
    if (ak) { delApiKey(ak.getAttribute('data-mask')); return; }
  });

  // 性能面板开关（设置页）：localStorage fc-perf 持久化，关了总览隐藏性能区块。
  var perfToggle = $('perf-toggle');
  if (perfToggle) {
    perfToggle.addEventListener('click', function () {
      perfOn = !perfOn;
      try { localStorage.setItem('fc-perf', perfOn ? '1' : '0'); } catch (e) {}
      applyPerfVisibility();
      if (perfOn) fetchPerf(); // 重新打开立刻拉一帧，不等 2s tick
    });
  }

  // 语言菜单选择 + 点外部关闭 dropdown（dd-toggle 自身的开关在各自按钮上）。
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.matches && t.matches('[data-go-toggle]')) {
      var id = t.getAttribute('data-id');
      var toggle = t.getAttribute('data-go-toggle');
      var enabled = t.checked;
      // 契约（并行服务端 agent）：PUT /legacy/account/:id/go-toggle，body 只带
      // 被切换的那个键（{useBalance?} 或 {chinaModels?}），其余省略 = 不修改。
      var body = toggle === 'useBalance' ? { useBalance: enabled } : { chinaModels: enabled };
      api('PUT', '/__admin/api/legacy/account/' + id + '/go-toggle', body).then(function (r) {
        if (!r.ok) {
          t.checked = !enabled; // 失败回滚
          stickyErr['go'] = true; // 标记 sticky：2s 轮询的 loadGo 成功也不重建，错误留着（对抗审查 M1）
          var ge = $('go-err');
          if (ge) ge.textContent = errMsg(r);
        } else {
          // 成功清掉 sticky：否则 loadGo 的 clearSticky('go', true) 永远拒绝渲染，
          // 错误残留且服务端状态渲染不出来（成功是用户主动操作，允许覆盖）。
          delete stickyErr['go'];
          var ge = $('go-err');
          if (ge) ge.textContent = '';
        }
      });
    }
  });
  // 右键账号卡片 → 直接进详情（输入框内右键放过，保留粘贴菜单）。
  document.addEventListener('contextmenu', function (e) {
    var t = e.target;
    if (!t || !t.closest || t.closest('input,textarea')) return;
    var card = t.closest('.card[data-id]');
    if (!card) return;
    e.preventDefault();
    openAccountDetail(Number(card.dataset.id));
  });
  document.addEventListener('click', function (e) {
    // 自绘 spinner：点击上下箭头 → 最近数字输入 stepUp/stepDown（document 级
    // 委托，动态 innerHTML 重建后无需重新绑）。
    var sb = e.target.closest('.num-spin-up, .num-spin-down');
    if (sb) {
      var wrap = sb.closest('.num-wrap');
      var inp = wrap ? wrap.querySelector('input[type="number"]') : null;
      if (inp && !inp.disabled) {
        try {
          if (sb.classList.contains('num-spin-up')) inp.stepUp();
          else inp.stepDown();
        } catch (err) {}
      }
      return;
    }
    var item = e.target.closest('.dd-item[data-lang]');
    if (item) {
      var v = item.getAttribute('data-lang');
      if (v === 'zh' || v === 'en' || v === 'ja') {
        if (v !== lang) {
          lang = v;
          try { localStorage.setItem('fc-lang', lang); } catch (e2) {}
          applyLang();
          tick(true);
        }
      }
      closeMenus();
      return;
    }
    // 创建表单的类型下拉：选中后同步 toggle 文案 + 记录值（沿用枚举原文）。
    var kitem = e.target.closest('.dd-item[data-kind]');
    if (kitem) {
      var kv = kitem.getAttribute('data-kind');
      if (kv === 'subscription' || kv === 'payg' || kv === 'unknown') {
        cKind = kv;
        $('c-kind-toggle').textContent = kitem.textContent;
      }
      closeMenus();
      return;
    }
    if (e.target.closest('.dd-toggle')) return;
    closeMenus();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    closeMenus();
    closeOAuth();
    closeConfirm();
    clearPlain();
  });

  // OAuth 弹层
  $('oauth-start').addEventListener('click', startOAuth);
  $('oauth-close').addEventListener('click', closeOAuth);
  $('oauth-overlay').addEventListener('click', function (e) {
    if (e.target === $('oauth-overlay')) closeOAuth();
  });
  $('oauth-copy').addEventListener('click', copyOAuthUrl);
  $('oauth-retry').addEventListener('click', function () {
    $('oauth-retry').hidden = true;
    startOAuth();
  });

  // UI v3：详情视图 + confirm 弹层
  $('detail-back').addEventListener('click', closeAccountDetail);
  $('detail-import').addEventListener('click', importCookie);
  $('detail-paste-save').addEventListener('click', pasteCookie);
  // cookie 失效横幅里的 OAuth 替代路径：直接复用 OAuth 弹层（startOAuth 会
  // 自动打开 overlay；done 后 tick 刷新账号列表——新账号或更新 refresh 都可见）。
  $('detail-oauth').addEventListener('click', startOAuth);
  $('confirm-ok').addEventListener('click', function () {
    if (!confirmState || $('confirm-ok').dataset.busy === '1') return; // in-flight 锁
    lockConfirm();
    confirmState.run();
  });
  $('confirm-cancel').addEventListener('click', closeConfirm);
  $('confirm-overlay').addEventListener('click', function (e) {
    if (e.target === $('confirm-overlay')) closeConfirm();
  });
  // model access 编辑 modal：chip toggle + 「跟随全局（清除）」按钮（confirm-body 动态 HTML）。
  $('confirm-overlay').addEventListener('click', function (e) {
    var opt = e.target.closest('.ma-chip[data-ma-opt]');
    if (opt) {
      var om = opt.getAttribute('data-ma-opt');
      if (maEdit) {
        var i = maEdit.cur.indexOf(om);
        if (i >= 0) maEdit.cur.splice(i, 1);
        else maEdit.cur.push(om);
        renderMaEditChips();
      }
      return;
    }
    var clr = e.target.closest('button[data-ma-clear]');
    if (clr) {
      var type = clr.getAttribute('data-type');
      var subject = clr.getAttribute('data-subject');
      api('PUT', '/__admin/api/model-access/keys/' + type + '/' + encodeURIComponent(subject), { models: null })
        .then(function (r) {
          if (r.ok) { closeConfirm(); flash(T('maSaved')); loadModelAccess(); }
          else { $('confirm-err').textContent = errMsg(r); }
        });
      return;
    }
  });
  $('view-account-detail').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (btn) {
      var act = btn.getAttribute('data-action');
      if (act === 'configure-ar') { configureAutoRecharge(); return; }
      if (act === 'set-budget') { setMonthlyBudget(btn.getAttribute('data-scope') || 'org'); return; }
      if (act === 'create-sa') { createSa(); return; }
      if (act === 'del-sa') { delSa(btn.getAttribute('data-said')); return; }
      if (act === 'create-legacy-key') { createLegacyKey(); return; }
      if (act === 'del-legacy-key') { delLegacyKey(btn.getAttribute('data-keyid')); return; }
      if (act === 'copy-legacy-key') { copyLegacyKey(btn.getAttribute('data-keyid'), btn.getAttribute('data-accountid')); return; }
      if (act === 'refresh-legacy-keys') { loadLegacyKeys(detailState.id); return; }
      if (act === 'ws-switch') { switchWorkspace(Number(btn.getAttribute('data-id'))); return; }
      if (act === 'save-legacy-key') { saveLegacyKey(); return; }
      if (act === 'clear-legacy-key') { clearLegacyKey(); return; }
      if (act === 'copy-config-legacy-key') { copyConfigLegacyKey(); return; }
      if (act === 'save-models') { saveModels(Number(btn.getAttribute('data-id'))); return; }
      if (act === 'clear-models') { clearModels(Number(btn.getAttribute('data-id'))); return; }
      return;
    }
    var rb = e.target.closest('.range-btn');
    if (rb) {
      var r = rb.getAttribute('data-range');
      if (r !== detailState.range) {
        detailState.range = r;
        loadUsage();
        loadModelsUsage(detailState.id);
        loadUsersUsage(detailState.id);
      }
    }
  });

  applyLang();
  // 性能区块显隐按 localStorage fc-perf 应用到 DOM（开关状态/提示一并同步）。
  applyPerfVisibility();
  // 恢复上次的 tab + sidebar 子项（非法/详情视图回退 overview，sub 由
  // renderSubnav 校验兜底）。tab 记忆 = 刷新/重进面板不回到初始 tab。
  try {
    var rv = localStorage.getItem('fc-admin-view');
    if (rv && VIEWS[rv] && rv !== 'account-detail') curView = rv;
    var rs = localStorage.getItem('fc-admin-sub');
    if (rs) curSub = rs;
  } catch (e) {}
  switchView(curView);
  tick(); fcTickTimer = setInterval(tick, 2000);
  setInterval(tickCountdown, 1000);
  // 静态数字输入（跳页 req-page）挂自绘 spinner；动态渲染的由各渲染函数重挂。
  mountNumSpinners();
  // 首拉分发密钥（总览费用/密钥卡 + 密钥 tab 共用这份 60s 缓存）。
  loadTokens(false);
  // OTA 红点：启动拉一次 + 60s 轮询（后台服务端每 6h 检查一次，这里只是
  // 把「有新版本」的红点刷到 tab 上；进设置页时 switchView 已拉一次）。
  var otaTimer = 0;
  loadOtaStatus(false);
  otaTimer = setInterval(function () {
    if (document.hidden) return;
    loadOtaStatus(false);
  }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    tickCountdown();
    tick();
  });
})();
</script>
</body>
</html>`;

/**
 * 面板登录页（账号密码）。用户要求：默认 admin / thankyouopencode（env 可覆盖）。
 * 深色居中卡片 + 等宽字体，与 ADMIN_HTML 同设计令牌。
 *
 * 标准表单提交（浏览器密码管理器要 name 属性 + 原生 POST + 302 才能保存密码）：
 * form action=/__admin/api/login method=post，服务端成功 Set-Cookie 后 302 → /__admin。
 * 失败提示由 URL query 携带（服务端 302 时拼进去）：
 * - `?login_error=1` → 用户名或密码错误
 * - `?login_locked=<秒数>` → 锁定倒计时（登录失败限速）
 */
export const LOGIN_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title data-i18n="titleSignIn">fuckopencode — sign in</title>
<style>
  /* 与 ADMIN_HTML 同设计令牌 + 同 oc-* 模板控件类（oc-btn/oc-input/oc-field/
     oc-hint/oc-hint-err）。静态文本默认英文（服务端 302 兜底 + 密码管理器
     需要 name 属性），语言由脚本按 localStorage fc-lang 切换。 */
  :root {
    --bg: #0c0c0e; --surface: #161618; --border: #38383a;
    --text: #ffffff; --text-muted: #a1a1a6; --accent: #007aff; --accent-hover: #0056b3;
    --danger: #ff453a;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text); font-family: "Berkeley Mono", "IBM Plex Mono", ui-monospace, Menlo, monospace;
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .card {
    width: 100%; max-width: 360px; border: 1px solid var(--border); border-radius: 5px;
    background: var(--surface); padding: 32px 28px;
  }
  .brand { font-size: 13px; color: var(--text); text-transform: uppercase; letter-spacing: -0.03125rem; }
  .brand span { color: var(--text-muted); }
  .sub { font-size: 13px; color: var(--text-muted); margin: 4px 0 24px; }
  .oc-field { margin-bottom: 14px; }
  .oc-field label { display: block; font-size: 13px; font-weight: 500; color: var(--text-muted); margin-bottom: 6px; }
  .oc-input {
    width: 100%; padding: 8px 12px; font-size: 13px; color: var(--text); background: var(--bg);
    border: 1px solid var(--border); border-radius: 3px; outline: none; font-family: inherit;
  }
  .oc-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.15); }
  .oc-select {
    width: 100%; padding: 8px 12px; font-size: 13px; color: var(--text);
    background: var(--bg); border: 1px solid var(--border); border-radius: 3px;
    outline: none; font-family: inherit; appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%2368686f'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 12px center;
  }
  .oc-select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.15); }
  .oc-hint-err { font-size: 12px; color: var(--danger); min-height: 16px; margin-bottom: 10px; }
  .oc-hint-err:empty { display: none; }
  .oc-btn {
    width: 100%; padding: 10px 16px; font-size: 13px; font-weight: 500; font-family: inherit;
    background: var(--accent); color: #fff; border: 0; border-radius: 3px; cursor: pointer;
  }
  .oc-btn:hover { background: var(--accent-hover); }
  .oc-btn:disabled { opacity: 0.5; cursor: default; }
  .oc-hint { font-size: 11px; color: var(--text-muted); margin-top: 16px; text-align: center; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">fuckopencode <span data-i18n="signInSub">/ sign in</span></div>
    <div class="sub" data-i18n="authRequired">admin panel requires authentication</div>
    <form id="login-form" action="/__admin/api/login" method="post">
      <div class="oc-field">
        <label for="lg-user" data-i18n="username">username</label>
        <input class="oc-input" id="lg-user" name="username" autocomplete="username" autofocus>
      </div>
      <div class="oc-field">
        <label for="lg-pass" data-i18n="password">password</label>
        <input class="oc-input" id="lg-pass" name="password" type="password" autocomplete="current-password">
      </div>
      <div class="oc-hint-err" id="lg-err"></div>
      <button class="oc-btn oc-btn-primary" type="submit" id="lg-btn" data-i18n="signIn">sign in</button>
    </form>
    <div class="oc-hint" id="lg-hint"></div>
  </div>
<script>
(function () {
  // 独立于 ADMIN_HTML 的登录页词条（它不加载面板字典）。语言跟随面板偏好：
  // 读同一个 localStorage fc-lang，与面板语言切换同键同源。
  var I18N = {
    en: {
      signIn: 'sign in', signInSub: '/ sign in',
      titleSignIn: 'fuckopencode — sign in',
      authRequired: 'admin panel requires authentication',
      username: 'username', password: 'password',
      loginError: 'invalid username or password',
      locked: 'locked: retry in {n}s'
    },
    zh: {
      signIn: '登录', signInSub: '/ 登录',
      titleSignIn: 'fuckopencode — 登录',
      authRequired: '管理面板需要登录',
      username: '用户名', password: '密码',
      loginError: '用户名或密码错误',
      locked: '已锁定：{n} 秒后重试'
    },
    ja: {
      signIn: 'サインイン', signInSub: '/ サインイン',
      titleSignIn: 'fuckopencode — サインイン',
      authRequired: '管理パネルには認証が必要です',
      username: 'ユーザー名', password: 'パスワード',
      loginError: 'ユーザー名またはパスワードが正しくありません',
      locked: 'ロック中：{n} 秒後に再試行'
    }
  };
  var lang = (function () {
    try { var v = localStorage.getItem('fc-lang'); if (v === 'zh' || v === 'en' || v === 'ja') return v; } catch (e) {}
    var nl = navigator.language || ''; if (/^zh/i.test(nl)) return 'zh'; if (/^ja/i.test(nl)) return 'ja'; return 'en';
  })();
  var T = function (k) { return (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k; };
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang === 'ja' ? 'ja' : 'en';
  var nodes = document.querySelectorAll('[data-i18n]');
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].textContent = T(nodes[i].getAttribute('data-i18n'));
  }
  // 服务端 302 回来时把失败原因带在 query 里（标准表单提交拿不到状态码）。
  var errEl = document.getElementById('lg-err');
  var hint = document.getElementById('lg-hint');
  var q = new URLSearchParams(window.location.search);
  if (q.get('login_error')) errEl.textContent = T('loginError');
  var locked = Math.floor(Number(q.get('login_locked')) || 0);
  if (locked > 0) {
    hint.textContent = T('locked').replace('{n}', locked);
    var left = locked;
    var timer = setInterval(function () {
      left -= 1;
      if (left <= 0) { clearInterval(timer); hint.textContent = ''; }
      else hint.textContent = T('locked').replace('{n}', left);
    }, 1000);
  }
})();
</script>
</body>
</html>`;
