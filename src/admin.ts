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
import type { AppConfig } from './config.js';
import { keyFingerprint } from './keypool.js';
import type { KeyPool } from './keypool.js';
import type { AccountKind, AccountPatch, AccountsStore } from './accounts.js';
import { buildAccountsSection } from './accounts.js';
import type { BillingAccounts } from './billing.js';
import { refreshBilling, type FetchLike } from './billing.js';
import type { UsageDb } from './usagedb.js';
import { deleteModelAlias, loadModelAliases, saveModelAlias } from './modelmap.js';
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

/** PATCH /__admin/api/accounts/:id 的字段校验（§6.3）。undefined 不更新。 */
export function validatePatchAccount(body: unknown): ValidateResult<AccountPatch> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  const patch: AccountPatch = {};

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
}

/**
 * Origin 校验（§6.1）：写操作若带非空 Origin 且不等于 `http://<host>:<port>`
 * （同源，回环场景浏览器自动带）→ 403。无 Origin 放行（curl 等非浏览器场景）。
 */
/** 管理面写操作的 Origin 校验：只认「origin 的 hostname+端口 == Host 头」。
 *  不比较 scheme —— HTTPS 反代（nginx/cloudflared TLS 终止）后面 Origin 是
 *  https:// 而 Host 头不变，写死 http 会让所有写操作 403。跨站攻击者的
 *  origin hostname 必然不同（同 hostname 不同端口也算跨站，端口也归一比较）。 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return true;
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
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.create', accountId: created.value.id, ok: true, note: null, ip: auditIp(req) });
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
  if (!deps.store!.update(id, v.value)) {
    deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.patch', accountId: id, ok: false, note: 'update failed', ip: auditIp(req) });
    sendJson(res, 500, { error: { message: 'failed to update account', type: 'server_error' } });
    return;
  }
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.patch', accountId: id, ok: true, note: null, ip: auditIp(req) });
  // 凭据更新（cookie/oauth）后重置 console 健康态——防旧 invalid 标记死锁（审查 H2）。
  if (v.value.cookie !== undefined || v.value.workspaceId !== undefined) {
    deps.consoleClient?.noteCredentialChanged?.(id);
  }
  // legacyCookie 走独立槽（加密存储）。
  if (v.value.legacyCookie !== undefined) {
    deps.store!.setLegacyCookie(id, v.value.legacyCookie);
  }
  sendAccount(res, 200, deps, id);
}

/** DELETE /__admin/api/accounts/:id：删账户 + 从 pool 移除其全部 key。 */
function handleDelete(req: IncomingMessage, res: ServerResponse, deps: AdminDeps, id: number): void {
  const store = deps.store!;
  if (store.get(id) == null) {
    sendNotFound(res, `account ${id} not found`);
    return;
  }
  const removed = store.remove(id);
  if (removed == null) {
    deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.delete', accountId: id, ok: false, note: 'remove failed', ip: auditIp(req) });
    sendJson(res, 500, { error: { message: 'failed to delete account', type: 'server_error' } });
    return;
  }
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.delete', accountId: id, ok: true, note: null, ip: auditIp(req) });
  for (const key of removed) deps.pool.removeKey(key);
  res.writeHead(204, { 'content-length': '0' });
  res.end();
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
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.add-key', accountId: id, ok: true, note: null, ip: auditIp(req) });
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
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.remove-key', accountId: id, ok: true, note: null, ip: auditIp(req) });
  deps.pool.removeKey(removed);
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
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'account.rename-key', accountId: id, ok: true, note: null, ip: auditIp(req) });
  sendAccount(res, 200, deps, id);
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
      // 无可用余额字段（缺字段 / null / 非数字）→ 该账号没有余额数据：
      // 余额置空（面板显示 —），刷新 lastBillingAt，不算失败。
      store.setBilling(id, { balanceUnits: units ?? null, at: Date.now() });
      sendAccount(res, 200, deps, id);
      return;
    }
    // 响应形状异常（非对象）→ 可读错误而非笼统 failed。
    sendJson(res, 502, { error: { message: 'billing refresh failed: unexpected console response shape', type: 'server_error' } });
    return;
  }
  const r = await refreshBilling(deps.cfg, toBillingAccounts(store), id, deps.log ?? console.log, deps.fetchImpl);
  if (!r.ok) {
    // §6.3：无 cookie → 400；其余抓取失败（网络/非 2xx/解析不出）→ 502。
    if (r.reason === 'no workspace/cookie') {
      sendJson(res, 400, { error: { message: 'account has no billing cookie', type: 'invalid_request_error' } });
      return;
    }
    sendJson(res, 502, { error: { message: `billing refresh failed: ${r.reason}`, type: 'server_error' } });
    return;
  }
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
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
    border: 0; border-bottom: 2px solid transparent; border-radius: 0;
    padding: 7px 12px 5px; font-size: 13px; font-weight: 500;
    color: var(--text-muted); background: transparent;
  }
  .tab:hover:not(.active) { color: var(--text); border-bottom-color: transparent; }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

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
  h1 { font-size: 24px; font-weight: 500; text-transform: uppercase; letter-spacing: -0.03125rem; color: var(--text); }
  .sub { color: var(--text-muted); font-size: 15px; margin-top: 3px; }
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

  /* ── account card ────────────────────────────────── */
  /* 账号卡：对齐 .panel 模板（同一套盒子），类名保留供 JS 选择器使用。 */
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px 20px; margin-bottom: 12px;
  }
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
  .oc-chip.st-region, .oc-chip.st-unknown, .badge.st-region, .badge.st-unknown { color: var(--text-muted); }
  .retry { color: var(--warn); font-size: 12px; white-space: nowrap; }
  /* 操作菜单平时隐身，卡片 hover 才现身（危险操作不给误触机会）。 */
  .ops { margin-left: auto; display: flex; align-items: center; position: relative; opacity: 0; transition: opacity .15s; }
  .card:hover .ops { opacity: 1; }
  .ops-btn { padding: 1px 8px; color: var(--text-muted); }

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

  /* ── 账号预览卡 v4：容器化数据区（余额/用量/Go 三格并列）── */
  .preview-cols {
    display: grid; grid-template-columns: minmax(150px, 1fr) 1.2fr 1.2fr;
    gap: 10px; margin-top: 12px; align-items: stretch;
  }
  .preview-box { min-width: 0; }
  .preview-box .p-title {
    font-size: 10px; color: var(--text-muted); text-transform: uppercase;
    letter-spacing: .03em; margin-bottom: 8px;
  }
  /* 容器 B：余额大数字（balance-card 解壳进 preview-box，防嵌套双框） */
  .preview-balance .balance-row { margin-top: 0; gap: 0; }
  .preview-balance .balance-card { padding: 0; min-width: 0; }
  .preview-balance .balance-card .v { font-size: 22px; }
  .preview-balance .meter { margin-top: 8px; max-width: none; }
  /* 容器 C：用量三小格（请求数/输出 tokens/成本） */
  .preview-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  .p-cell .p-k { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
  .p-cell .p-v { font-size: 15px; font-weight: 600; color: var(--text); line-height: 130%; margin-top: 3px; }
  /* 容器 D：Go 三窗口迷你进度条 */
  .p-go-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .p-go-row:last-child { margin-bottom: 0; }
  .p-go-l { font-size: 10px; color: var(--text-muted); width: 80px; flex: none; white-space: nowrap; }
  .p-go-bar { flex: 1; height: 5px; background: var(--surface); border: 1px solid var(--border-muted); border-radius: var(--radius); overflow: hidden; min-width: 0; }
  .p-go-fill { display: block; height: 100%; background: var(--accent); border-radius: var(--radius); }
  .p-go-pct { font-size: 11px; font-weight: 600; color: var(--text-2); width: 36px; text-align: right; flex: none; }
  /* 未连接/等待同步提示占满整行 */
  .preview-cols .p-note { grid-column: 1 / -1; margin-top: 0; }
  @media (max-width: 48rem) {
    .preview-cols { grid-template-columns: 1fr; }
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
  .key-add { display: flex; gap: 6px; margin-top: 8px; }

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

  /* ── v5：状态列表（网关/上游/账号/分发密钥/兼容修复）── */
  .st-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border-muted); font-size: 12px; }
  .st-row:last-child { border-bottom: 0; }
  .st-row .st-name { color: var(--text-2); min-width: 96px; flex: none; }
  .st-row .st-desc { color: var(--text-muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st-dot, .oc-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--text-disabled); }
  .oc-dot.ok, .st-dot.ok { background: var(--ok); }
  .oc-dot.warn, .st-dot.warn { background: var(--warn); }
  .oc-dot.bad, .st-dot.bad { background: var(--danger); }

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
  <button class="tab" data-tab="settings" data-i18n="tabSettings">Settings</button>
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
        <h1 data-i18n="accountsTitle">Accounts</h1>
        <div class="sub" data-i18n="accountsSub">per-account status, balance and keys</div>
        <div id="accounts"></div>
      </section>

      <section id="sec-create">
        <h1 data-i18n="createTitle">Create account</h1>
        <div class="sub" data-i18n="createSub">register an upstream account, keys are encrypted at rest</div>
        <div class="oc-form">
          <div class="oc-field">
            <label data-i18n="name">name</label>
            <input class="oc-input" id="c-name" autocomplete="off">
          </div>
          <div class="oc-field">
            <label data-i18n="kind">kind</label>
            <div class="dd">
              <button id="c-kind-toggle" class="oc-btn dd-toggle">subscription</button>
              <div class="dd-menu" id="c-kind-menu" hidden>
                <button class="oc-btn dd-item" data-kind="subscription">subscription</button>
                <button class="oc-btn dd-item" data-kind="payg">payg</button>
                <button class="oc-btn dd-item" data-kind="unknown">unknown</button>
              </div>
            </div>
          </div>
          <div class="oc-field oc-full">
            <label data-i18n="workspaceId">workspace id</label>
            <input class="oc-input" id="c-ws" autocomplete="off" placeholder="ws_...">
          </div>
          <div class="oc-field oc-full">
            <label data-i18n="keysLabel">keys (comma separated)</label>
            <input class="oc-input" id="c-keys" autocomplete="off" placeholder="sk-ant-xxx, sk-ant-yyyy">
          </div>
          <div class="oc-field oc-full">
            <label data-i18n="cookieLabel">cookie (optional)</label>
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
            <input class="oc-input oc-grow oc-min-200" id="detail-cookie-paste" placeholder="auth=..." autocomplete="off">
            <button class="oc-btn" id="detail-paste-save" data-i18n="importCookie">import</button>
          </div>
          <div class="cookie-import" id="detail-oauth-row">
            <button class="oc-btn" id="detail-oauth" data-i18n="oauthInstead">or sign in with OpenCode instead</button>
          </div>
        </div>
        <div id="detail-workspace"></div>
        <div id="detail-billing"></div>
        <div id="detail-usage"></div>
        <div id="detail-models-usage"></div>
        <div id="detail-users-usage"></div>
        <div id="detail-autorecharge"></div>
        <div id="detail-budgets"></div>
        <div id="detail-members"></div>
        <div id="detail-sa"></div>
        <div id="detail-providers"></div>
        <div id="detail-pricing"></div>
        <div id="detail-go"></div>
        <div id="detail-legacy"></div>
        <div id="detail-legacy-billing"></div>
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
          <input class="oc-input oc-grow" id="req-q" placeholder="search path/status/model/client/ua/error" autocomplete="off" spellcheck="false">
          <select class="oc-select oc-shrink" id="req-size" title="page size">
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
          <input class="oc-input oc-w64" id="req-page" type="number" min="1" step="1" autocomplete="off" title="jump to page">
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
          <th data-i18n="tokenUsage">usage</th><th class="t-hide" data-i18n="tokenCreatedAt">created</th>
          <th class="t-rpm-hd" data-i18n="tokenRpm">rpm</th><th></th>
            </tr></thead>
            <tbody id="tokens-rows"></tbody>
          </table>
          <div class="oc-hint" id="tokens-empty" data-i18n="tokensEmpty">no tokens yet</div>
        </div>
        <div class="oc-hint" data-i18n="tokensNote">token plaintext is shown only once at creation — the list only shows masks</div>
      </section>
    </div>

    <div id="view-settings" hidden>
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
            <label data-i18n="modelAlias">alias</label>
            <input class="oc-input" id="mm-alias" placeholder="claude-mythos-5" autocomplete="off" spellcheck="false">
          </div>
          <div class="oc-field">
            <label data-i18n="modelTarget">target</label>
            <input class="oc-input" id="mm-target" list="mm-targets" placeholder="deepseek-v4-flash-free" autocomplete="off" spellcheck="false">
            <datalist id="mm-targets">
              <option value="deepseek-v4-flash"></option>
              <option value="deepseek-v4-flash-free"></option>
            </datalist>
          </div>
          <div class="oc-field oc-full">
            <label data-i18n="modelNote">note</label>
            <input class="oc-input" id="mm-note" placeholder="optional" autocomplete="off">
          </div>
          <div class="oc-hint-err oc-full" id="mm-err"></div>
          <button class="oc-btn oc-btn-primary oc-full" id="mm-add" data-i18n="addMapping">add mapping</button>
        </div>
        <div class="oc-hint" data-i18n="modelMapNote">Claude Code sends claude-* model names; the gateway looks up this table first and maps to the target — takes effect immediately</div>
      </section>

      <section id="sec-admin-auth">
        <h1 data-i18n="adminAuthTitle">Admin account</h1>
        <div class="sub" data-i18n="adminAuthSub">login credentials for this panel</div>
        <div class="oc-form">
          <div class="oc-field">
            <label><span data-i18n="adminUserLabel">username</span> <span class="oc-chip-src" id="aa-user-src"></span></label>
            <input class="oc-input" id="aa-user" autocomplete="off">
          </div>
          <div class="oc-field">
            <label><span data-i18n="adminPassLabel">password</span> <span class="oc-chip-src" id="aa-pass-src"></span></label>
            <input class="oc-input" id="aa-pass" type="password" placeholder="..." autocomplete="new-password">
            <div class="oc-hint oc-hint-err" id="aa-pass-warn" hidden></div>
          </div>
          <div class="oc-hint-err oc-full" id="aa-err"></div>
          <button class="oc-btn oc-btn-primary oc-full" id="aa-save" data-i18n="save">save</button>
        </div>
        <div class="oc-hint" data-i18n="adminPassHint">old sessions stay valid for up to 24h after a password change</div>
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

      <section id="sec-experimental">
        <h1 data-i18n="expTitle">Experimental</h1>
        <div class="sub" data-i18n="expSub">opt-in features, off by default</div>
        <div class="panel" id="exp-panel">
          <div class="oc-hint" id="exp-loading">…</div>
        </div>
        <div class="oc-hint" data-i18n="expNote">settings come from environment variables and are read at startup — changing them requires a restart</div>
      </section>

      <section id="sec-about">
        <h1 data-i18n="about">About</h1>
        <div class="sub" data-i18n="aboutSub">fuckopencode admin panel</div>
        <div class="card">
          <div class="meta" data-i18n="aboutDesc">OpenAI <-> Anthropic protocol gateway for DeepSeek — manage upstream accounts and protocol conversion</div>
          <div class="meta"><a href="https://github.com/dwgx/fuckopencode" target="_blank" rel="noopener">github.com/dwgx/fuckopencode</a></div>
          <div class="meta">/__admin — <span data-i18n="aboutEndpointAdmin">management</span> · /__metrics — <span data-i18n="aboutEndpointMetrics">metrics</span> · /__dash — <span data-i18n="aboutEndpointDash">dashboard</span></div>
        </div>
      </section>
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
      noAccounts: 'No accounts yet', noAccountsSub: 'create one to start managing keys and balance',
      balance: 'balance', monthlyLimit: 'monthly limit', monthlyUsage: 'monthly usage',
      previewBalance: 'balance', previewUsage: '7d usage', previewGo: 'go limits',
      previewGwTitle: 'workspace usage (7d)',
      previewGwPoolTitle: 'gateway total (7d)',
      legacyCount: 'legacy keys:', legacyHint: 'view in account details',
      usedOf: 'of monthly limit',
      lastProbe: 'last probe', lastBilling: 'last billing', never: 'never',
      retryIn: 'retry in', nextProbe: 'next probe in', inFlight: 'in flight',
      keysTitle: 'keys', noKeys: 'no keys',
      edit: 'edit', save: 'save', cancel: 'cancel',
      refresh: 'refresh balance', addKey: 'add key', remove: 'remove',
      delete: 'delete', confirmDelete: 'Delete this account? Its keys will stop routing.',
      confirmDeleteKey: 'Remove this key from the account?',
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
      notConnected: 'not connected', waitingSync: 'connected — balance syncs on next probe', processing: 'processing…',
      logout: 'logout',
      kindUnknown: 'unset', kindSubscription: 'subscription', kindPayg: 'pay as you go',
      goSub: 'Go subscription', goSubHint: 'usage windows from OpenCode Go (opencode.ai)',
      goRolling: 'Rolling (5h)', goWeekly: 'Weekly', goMonthly: 'Monthly',
      goReset: 'resets in', goUseBalance: 'use balance after limit', goChinaModels: 'enable China-hosted models', goNotSubscribed: 'not subscribed',
      nameRequired: 'name is required', cookieClear: 'leave blank to clear',
      live: 'live',
      tabOverview: 'Overview', tabAccounts: 'Accounts', tabUsage: 'Usage', tabSettings: 'Settings',
      subOverview: 'Overview', subHealth: 'Health',
      subAccounts: 'Accounts', subCreate: 'Create account', subOauth: 'OpenCode sign-in',
      subRequests: 'Request stats', subKeys: 'Key pool',
      subLanguage: 'Language', subAbout: 'About',
      usageTitle: 'Request stats', usageSub: 'traffic summary from /__metrics',
      totalRequests: 'total requests', failed: 'failed', streaming: 'streaming',
      avgDuration: 'avg duration', tokens: 'tokens',
      keypoolTitle: 'Key pool', keypoolSub: 'per-key health and in-flight load',
      recentRequests: 'Recent requests', noRequests: 'no requests yet',
      langTitle: 'Language', langSub: 'interface language',
      langNote: 'language preference is stored in localStorage',
      langEn: 'EN', langZh: '中文',
      about: 'About', aboutSub: 'fuckopencode admin panel',
      aboutDesc: 'OpenAI <-> Anthropic protocol gateway for DeepSeek — manage upstream accounts and protocol conversion',
      aboutEndpointAdmin: 'management', aboutEndpointMetrics: 'metrics',
      oauthStart: 'Sign in with OpenCode', oauthTitle: 'OpenCode sign-in',
      oauthDesc: 'pair an opencode account via device code',
      oauthUrlLabel: 'verification url', oauthCodeLabel: 'device code',
      oauthHint: 'sign in in the opened page, then return here',
      oauthCopy: 'copy', oauthCopied: 'copied',
      oauthPolling: 'polling for approval', oauthStarting: 'starting',
      oauthExpiresIn: 'code expires in', oauthDone: 'account signed in',
      oauthExpired: 'device code expired, retry', oauthDenied: 'sign-in denied, retry',
      oauthNotFound: 'sign-in session not found, retry',
      oauthFail: 'sign-in failed', oauthNetFail: 'network error',
      oauthRetry: 'retry', oauthInvalid: 'OAuth credential invalid, sign in again',
      oauthInstead: 'or sign in with OpenCode instead',
      detail: 'details', back: 'back', subDetail: 'Account detail',
      // 工作区区块（显示当前 workspace + 切换）。
      workspaceTitle: 'Workspace', workspaceSub: 'current console workspace and switching',
      currentWorkspace: 'current workspace', wsLegacy: 'legacy workspace',
      noWorkspace: 'no workspace configured',
      wsManual: 'enter workspace id manually…', wsManualHint: 'switch uses the new console workspace (org_...) — console data reloads after switching',
      wsSwitch: 'switch', wsSwitchTitle: 'Switch workspace',
      wsSwitched: 'workspace switched', wsIdRequired: 'select or enter a workspace id',
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
      saTitle: 'Service accounts', saSub: 'API keys issued on the console',
      saName: 'name', created: 'created', noSa: 'no service accounts',
      createSa: 'create service account',
      // 旧版 workspace（opencode.ai 老控制台）的 key 管控。
      legacyKeys: 'Legacy API keys', legacySub: 'API keys issued on the legacy console (opencode.ai)',
      legacyCreateTitle: 'Create legacy key',
      createKey: 'create key', keyName: 'key name',
      masked: 'masked', creator: 'creator',
      keyCreated: 'key created', keyDeleted: 'key deleted',
      delLegacyKeyConfirm: 'Delete this legacy key? It will stop working immediately.',
      legacyCookieMissing: 'legacy console cookie not configured',
      refreshKeys: 'refresh', noLegacyKeys: 'no legacy keys',
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
      hClient: 'client', hFp: 'key', hUa: 'user agent',
      // 请求明细（分页 + 搜索 + 跳页 + 每页条数 + IP 统计）。
      detailRequests: 'Detailed requests', reqPrev: 'prev', reqNext: 'next', reqPage: 'page',
      reqGo: 'go',
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
      legacyReload: 'auto reload', paymentHistory: 'payment history', amount: 'amount', noPayments: 'no payments yet',
      legacyBillingUnavailable: 'legacy billing data unavailable',
      costTrend: 'daily cost (7d)', noTrend: 'no cost data in range',
      modelUsageTitle: 'Model usage', modelUsageSub: 'cost and tokens by model',
      userUsageTitle: 'Member usage', userUsageSub: 'requests and tokens by member',
      spent: 'spent', exceeded: 'exceeded', resetsAt: 'resets at', noMemberBudget: 'no member budget data',
      memberBudgetTitle: 'Member budgets', memberBudgetSub: 'per-member monthly spending status',
      pricingTitle: 'Model pricing', pricingSub: 'price per million tokens (v2/config)',
      inPerMtok: 'input', outPerMtok: 'output', noPricing: 'no pricing data',
      fixCountTitle: 'compat fixes', fixRewritten: 'rewritten', fixStripped: 'stripped', fixCompressed: 'compressed', fixNone: 'no compat fixes yet',
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
      tokenSaved: 'token updated', tokenDeleted: 'token deleted',
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
      adminPassHint: 'old sessions stay valid for up to 24h after a password change',
      adminPassEnvWarn: 'using the default password — change it',
      authSaved: 'admin credentials saved', aaNothing: 'nothing to save',
      sourceEnv: 'source: env', sourceDb: 'source: panel',
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
      legacyKeyNotFound: 'key not found in plain list',
      legacyKeyCopyTitle: 'copy plaintext to clipboard'
    },
    zh: {
      degradedTitle: '账号数据不可用',
      overview: '总览', overviewSub: '账户、余额与 key 健康度',
      accountsLabel: '个账号', healthy: '健康',
      totalBalance: '余额汇总', cooldown: '冷却中',
      healthTitle: '健康度', healthSub: '账户状态一览',
      createTitle: '创建账号', createSub: '注册一个上游账号，key 加密落盘',
      name: '名称', kind: '类型', workspaceId: '工作区 id',
      keysLabel: 'key（逗号分隔）', cookieLabel: 'cookie（可选）',
      create: '创建',
      accountsTitle: '账号', accountsSub: '账户状态、余额与 key',
      noAccounts: '暂无账号', noAccountsSub: '创建一个账号开始管理 key 与余额',
      balance: '余额', monthlyLimit: '月额度', monthlyUsage: '月用量',
      previewBalance: '余额', previewUsage: '7 天用量', previewGo: 'Go 额度',
      previewGwTitle: '7 天 workspace 用量',
      previewGwPoolTitle: '7 天网关总用量',
      legacyCount: '个 legacy key', legacyHint: '查看账号详情',
      usedOf: '月额度已用',
      lastProbe: '最近探针', lastBilling: '最近抓取', never: '从未',
      retryIn: '剩余冷却', nextProbe: '下次探测', inFlight: '在飞',
      keysTitle: 'key', noKeys: '暂无 key',
      edit: '编辑', save: '保存', cancel: '取消',
      refresh: '刷新余额', addKey: '添加 key', remove: '移除',
      delete: '删除', confirmDelete: '删除该账号？其 key 将停止路由。',
      confirmDeleteKey: '从该账号移除这个 key？',
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
      notConnected: '未接入', waitingSync: '已连接 · 余额随下次探测同步', processing: '处理中…',
      logout: '退出',
      kindUnknown: '未标注', kindSubscription: '订阅', kindPayg: '按量',
      goSub: 'Go 订阅', goSubHint: 'OpenCode Go 的用量窗口（opencode.ai）',
      goRolling: '滚动（5 小时）', goWeekly: '每周', goMonthly: '每月',
      goReset: '重置于', goUseBalance: '达限额后用余额', goChinaModels: '启用中国区模型', goNotSubscribed: '未订阅',
      nameRequired: '名称不能为空', cookieClear: '留空 = 清除',
      live: '实时',
      tabOverview: '总览', tabAccounts: '账号', tabUsage: '用量', tabSettings: '设置',
      subOverview: '概览', subHealth: '健康度',
      subAccounts: '账号列表', subCreate: '创建账号', subOauth: 'OpenCode 登录',
      subRequests: '请求统计', subKeys: 'Key 池',
      subLanguage: '语言', subAbout: '关于',
      usageTitle: '请求统计', usageSub: '来自 /__metrics 的流量汇总',
      totalRequests: '总请求', failed: '失败', streaming: '流式',
      avgDuration: '平均耗时', tokens: 'tokens',
      keypoolTitle: 'Key 池', keypoolSub: '逐 key 健康度与在飞负载',
      recentRequests: '最近请求', noRequests: '暂无请求',
      langTitle: '语言', langSub: '界面语言',
      langNote: '语言偏好保存在 localStorage',
      langEn: 'EN', langZh: '中文',
      about: '关于', aboutSub: 'fuckopencode 管理面板',
      aboutDesc: 'OpenAI 与 Anthropic 协议转换网关，面向 DeepSeek —— 用于管理上游账号与协议转换',
      aboutEndpointAdmin: '管理', aboutEndpointMetrics: '指标',
      oauthStart: '通过 OpenCode 登录', oauthTitle: 'OpenCode 登录',
      oauthDesc: '通过设备码绑定 opencode 账号',
      oauthUrlLabel: '验证链接', oauthCodeLabel: '设备码',
      oauthHint: '在打开的页面登录后回到这里',
      oauthCopy: '复制', oauthCopied: '已复制',
      oauthPolling: '等待授权中', oauthStarting: '启动中',
      oauthExpiresIn: '设备码过期倒计时', oauthDone: '账号登录成功',
      oauthExpired: '设备码已过期，可重试', oauthDenied: '登录被拒绝，可重试',
      oauthNotFound: '登录会话不存在，可重试',
      oauthFail: '登录失败', oauthNetFail: '网络错误',
      oauthRetry: '重试', oauthInvalid: 'OAuth 凭据失效，请重新授权',
      oauthInstead: '或用 OpenCode 登录',
      detail: '详情', back: '返回', subDetail: '账号详情',
      // 工作区区块（显示当前 workspace + 切换）。
      workspaceTitle: '工作区', workspaceSub: '当前控制台工作区与切换',
      currentWorkspace: '当前工作区', wsLegacy: '旧版工作区',
      noWorkspace: '未配置工作区',
      wsManual: '手动输入工作区 id…', wsManualHint: '切换走新版控制台 workspace（org_...），切换后控制台数据重新加载',
      wsSwitch: '切换', wsSwitchTitle: '切换工作区',
      wsSwitched: '工作区已切换', wsIdRequired: '请选择或输入工作区 id',
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
      saTitle: '服务账号', saSub: '控制台签发的 API key',
      saName: '名称', created: '创建时间', noSa: '暂无服务账号',
      createSa: '创建服务账号',
      // 旧版 workspace（opencode.ai 老控制台）的 key 管控。
      legacyKeys: '旧版 API key', legacySub: '旧版控制台（opencode.ai）签发的 API key',
      legacyCreateTitle: '创建旧版 key',
      createKey: '创建 key', keyName: 'key 名称',
      masked: '掩码', creator: '创建者',
      keyCreated: 'key 已创建', keyDeleted: 'key 已删除',
      delLegacyKeyConfirm: '删除该旧版 key？它将立即失效。',
      legacyCookieMissing: '未配置旧版控制台 cookie',
      refreshKeys: '刷新', noLegacyKeys: '暂无旧版 key',
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
      hTime: '时间', hStatus: '状态', hRequest: '请求', hMs: '耗时', hTokens: 'tokens',
      hClient: '客户端', hFp: 'key', hUa: 'UA',
      // 请求明细（分页 + 搜索 + 跳页 + 每页条数 + IP 统计）。
      detailRequests: '详细请求', reqPrev: '上一页', reqNext: '下一页', reqPage: '页',
      reqGo: '跳转',
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
      legacyReload: '自动充值', paymentHistory: '支付历史', amount: '金额', noPayments: '暂无支付记录',
      legacyBillingUnavailable: '旧版计费数据不可用',
      costTrend: '每日成本（7 天）', noTrend: '该范围内无成本数据',
      modelUsageTitle: '模型消费', modelUsageSub: '按模型的成本与 tokens',
      userUsageTitle: '成员消费', userUsageSub: '按成员的请求与 tokens',
      spent: '已用', exceeded: '超限', resetsAt: '重置于', noMemberBudget: '暂无成员预算数据',
      memberBudgetTitle: '成员预算', memberBudgetSub: '成员月度支出状态',
      pricingTitle: '模型定价', pricingSub: '每百万 token 价格（v2/config）',
      inPerMtok: '输入', outPerMtok: '输出', noPricing: '暂无定价数据',
      fixCountTitle: '兼容修复', fixRewritten: '改写', fixStripped: '剥除', fixCompressed: '压缩', fixNone: '暂无兼容修复',
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
      tokenSaved: '密钥已更新', tokenDeleted: '密钥已删除',
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
      adminPassHint: '改密码后旧会话 24h 内仍有效',
      adminPassEnvWarn: '正在使用默认密码，建议修改',
      authSaved: '登录凭据已保存', aaNothing: '没有需要保存的内容',
      sourceEnv: '来源: env', sourceDb: '来源: 面板',
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
      balanceOrg: '余额（org）',
      // 批次 2：RPM 限流配置 + legacy key 明文复制。
      tokenRpm: '请求频率', tokenRpmHint: '每分钟请求上限 — 0 = 不限',
      tokenRpmSaved: '请求频率已保存', tokenRpmInvalid: '请输入不小于 0 的整数',
      legacyKeyNotFound: '明文列表里找不到该 key',
      legacyKeyCopyTitle: '复制明文到剪贴板'
    }
  };
  var lang = (function () {
    try { var v = localStorage.getItem('fc-lang'); if (v === 'zh' || v === 'en') return v; } catch (e) {}
    return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  })();
  var T = function (k) { return (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k; };

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

  var langLabel = function () { return lang === 'zh' ? T('langZh') : T('langEn'); };

  function applyLang() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = T(nodes[i].getAttribute('data-i18n'));
    }
    $('btn-lang').textContent = langLabel();
    var b2 = $('btn-settings-lang');
    if (b2) b2.textContent = langLabel();
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
  function errMsg(r) {
    return (r.json && r.json.error && r.json.error.message) || (T('opFail') + ' (' + r.status + ')');
  }

  /** 单条 key 行。指纹来自服务端（末 4 位），原文永不出现在面板。
   *  有昵称：昵称优先 + 指纹小字；无昵称：只显示指纹。hover 出「改名」「移除」。 */
  function keyRow(k, accountId) {
    var meta = k.healthy
      ? (k.inFlight > 0 ? T('inFlight') + ' ' + k.inFlight : '')
      : esc(k.disabledReason || '') + (k.recoverInMs > 0 ? ' · ' + hms(k.recoverInMs) : '');
    var label = k.nickname
      ? '<span class="fp">' + esc(k.nickname) + '</span> <span class="w">' + esc(k.fingerprint) + '</span>'
      : '<span class="fp">' + esc(k.fingerprint) + '</span>';
    return '<div class="key-row">' +
      '<span class="oc-dot ' + (k.healthy ? 'ok' : 'bad') + '"></span>' +
      label +
      '<span class="k-meta">' + meta + '</span>' +
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
    var detail = a.statusDetail
      ? '<div class="detail" title="' + esc(a.statusDetail) + '">' + esc(a.statusDetail) + '</div>'
      : '';
    var balance = a.balance == null ? '—' : '$' + Number(a.balance).toFixed(2);
    var limit = a.monthlyLimit == null ? '—' : '$' + Number(a.monthlyLimit).toFixed(2);
    var usage = a.monthlyUsage == null ? '—' : '$' + Number(a.monthlyUsage).toFixed(2);
    var pct = a.monthlyPercent == null ? '' : Number(a.monthlyPercent).toFixed(1);
    var meter = pct === ''
      ? ''
      : '<div class="meter"><div class="meter-bg"><div class="meter-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="meter-l">' + pct + '% ' + T('usedOf') + '</div></div>';
    // 控制台数据获取不到（billing 从未成功 / cookie 失效）时：余额/月额度/月用量
    // 三个卡全是「—」，不渲染空容器，只给一行「未连接」提示（详情页有 cookie 导入）。
    var noConsole = a.balance == null && a.monthlyLimit == null && a.monthlyUsage == null;
    // 容器 B：余额 + 月额度条。无控制台数据时给单行提示（区分「有凭据但余额
    // 还没同步」vs「状态异常」）。env 代理账号（hasConsole=false）与控制台无关，
    // 不渲染任何提示——它只是 key 池，只显示名称/状态/key 信息。
    var consoleBlock = noConsole
      ? (a.hasConsole
        ? ((a.status === 'error' || a.status === 'invalid')
          ? '<div class="meta s-bad p-note">' + esc(a.statusDetail || T('stError')) + '</div>'
          : '<div class="meta p-note">' + T('waitingSync') + '</div>')
        : '')
      : '<div class="preview-box preview-balance">' +
          '<div class="p-title">' + T('balanceOrg') + '</div>' +
          '<div class="balance-row">' +
            '<div class="balance-card"><div class="v">' + balance + '</div></div>' +
          '</div>' +
          meter +
        '</div>';
    // 容器 C/D：用量摘要 + Go 三窗口（60s 缓存数据；无数据时整容器隐藏，失败不报错）。
    // 容器 C 走 previewUsageHtml：网关实际用量优先，org 用量回落（与数据到达时的回填同口径）。
    var pc = previewCache[a.id];
    var usageBox = pc ? previewUsageHtml(pc) : '';
    var goBox = pc && pc.go ? previewGoBox(pc.go) : '';
    var keys = a.keys && a.keys.length
      ? a.keys.map(function (k) { return keyRow(k, a.id); }).join('')
      : '<div class="key-row"><span class="w">' + T('noKeys') + '</span></div>';
    // legacy keys 摘要行（render 重建时从缓存读；数据后到时由 fillPreviewLegacy 补插）。
    var legacyRow = pc ? legacyPreviewRow(pc.legacy) : '';
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
    return '<div class="card" data-id="' + a.id + '">' +
      '<div class="card-hd">' +
        '<span class="name" title="' + esc(a.name) + '">' + esc(a.name) + '</span>' +
        '<span class="oc-chip">' + kindText(a.kind) + '</span>' +
        '<span class="oc-chip st-' + esc(a.status) + '">' + statusText(a.status) + '</span>' +
        retry +
        ops +
      '</div>' +
      // 数据区：容器 B（余额）+ 容器 C（用量摘要）+ 容器 D（Go 三窗口）并列。
      '<div class="preview-cols">' + consoleBlock + usageBox + goBox + '</div>' +
      '<div class="edit" id="edit-' + a.id + '" hidden>' +
        '<div class="oc-field"><label>' + T('name') + '</label><input class="oc-input" id="e-name-' + a.id + '" value="' + esc(a.name) + '" autocomplete="off"></div>' +
        '<div class="oc-field"><label>' + T('kind') + '</label><select class="oc-select" id="e-kind-' + a.id + '">' +
          '<option value="subscription">subscription</option>' +
          '<option value="payg">payg</option>' +
          '<option value="unknown">unknown</option>' +
        '</select></div>' +
        '<div class="oc-field oc-full"><label>' + T('cookieLabel') + '</label><input class="oc-input" id="e-cookie-' + a.id + '" type="password" placeholder="' + T('cookieClear') + '" autocomplete="off"></div>' +
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
        '<div class="keys-hd">' + T('keysTitle') + '</div>' +
        keys +
        legacyRow +
        '<div class="key-add">' +
          '<input class="oc-input oc-grow" id="keyin-' + a.id + '" placeholder="sk-..." autocomplete="off">' +
          '<button class="oc-btn" data-action="addkey" data-id="' + a.id + '">' + T('addKey') + '</button>' +
        '</div>' +
      '</div>' +
      '</div>';
  }

  // ── 预览数据（用量/Go/网关用量/legacy keys）：列表页每账号并行拉一次，60s 缓存 ──
  // 用量/Go 是 15 分钟级变化的数据，不值得跟 2s tick 每轮重拉：列表首次渲染
  // 拉一次，之后 60s 内复用缓存（render 指纹变化重建 DOM 也不重拉）。
  var PREVIEW_TTL = 60 * 1000;
  var previewCache = {};
  /** 预览容器 C（用量摘要）：请求数/输出 tokens/成本 三小格。无 summary 返回 ''（隐藏）。 */
  function previewUsageBox(u) {
    if (!u || !u.summary) return '';
    var s = u.summary;
    var req = s.totalRequests != null ? fmt(s.totalRequests) : '—';
    var out = s.totalOutputTokens != null ? fmt(s.totalOutputTokens) : '—';
    var cost = s.totalCostMicroCents != null ? money(s.totalCostMicroCents) : '—';
    return '<div class="preview-box preview-usage">' +
      '<div class="p-title">' + T('previewUsage') + '</div>' +
      '<div class="preview-grid">' +
        '<div class="p-cell"><div class="p-k">' + T('requests') + '</div><div class="p-v">' + req + '</div></div>' +
        '<div class="p-cell"><div class="p-k">' + T('outputTokens') + '</div><div class="p-v">' + out + '</div></div>' +
        '<div class="p-cell"><div class="p-k">' + T('cost') + '</div><div class="p-v">' + cost + '</div></div>' +
      '</div>' +
      '</div>';
  }
  /** 预览容器 C'（网关实际代理用量）：请求数/输入+输出 tokens/成本 三小格。
   *  数据来自 requests 表按账号 legacy keys 指纹归属的聚合（usage-gateway 端点），
   *  有值（含 0）时优先于 org 用量（usage summary）显示。 */
  function previewGwBox(g) {
    if (!g) return '';
    var req = g.requests != null ? fmt(g.requests) : '—';
    var tok = (g.inputTokens != null || g.outputTokens != null)
      ? fmt((Number(g.inputTokens) || 0) + (Number(g.outputTokens) || 0))
      : '—';
    var cost = g.costMicroCents != null ? money(g.costMicroCents) : '—';
    // scope 标注：pool = 网关总用量（env 池）；legacy = 该 workspace 的 key 用量
    // （outlook/gmail 共享同一旧版 workspace——用量是 workspace 级）。
    var title = g.scope === 'pool' ? T('previewGwPoolTitle') : T('previewGwTitle');
    return '<div class="preview-box preview-usage">' +
      '<div class="p-title">' + title + '</div>' +
      '<div class="preview-grid">' +
        '<div class="p-cell"><div class="p-k">' + T('requests') + '</div><div class="p-v">' + req + '</div></div>' +
        '<div class="p-cell"><div class="p-k">' + T('tokens') + '</div><div class="p-v">' + tok + '</div></div>' +
        '<div class="p-cell"><div class="p-k">' + T('cost') + '</div><div class="p-v">' + cost + '</div></div>' +
      '</div>' +
      '</div>';
  }
  /** 容器 C 的最终选择：网关实际用量优先，没有则回落 org 用量（现状）。
   *  两个数据源可能先后到达，都走这个出口才能保证回填结果一致。 */
  function previewUsageHtml(c) {
    return c.gw ? previewGwBox(c.gw) : previewUsageBox(c.usage);
  }
  /** 预览容器 D（Go 三窗口）：迷你进度条。未订阅（窗口全 null）返回 ''（隐藏）。 */
  function previewGoBox(g) {
    if (!g || !g.go) return '';
    var go = g.go;
    var row = function (label, w) {
      if (!w || typeof w.usagePercent !== 'number') return '';
      var pct = Math.max(0, Math.min(100, w.usagePercent));
      var pctTxt = pct.toFixed(0) + '%';
      return '<div class="p-go-row">' +
        '<span class="p-go-l">' + label + '</span>' +
        '<span class="p-go-bar"><span class="p-go-fill" style="width:' + pctTxt + '"></span></span>' +
        '<span class="p-go-pct">' + pctTxt + '</span>' +
        '</div>';
    };
    var rows = row(T('goRolling'), go.rolling) + row(T('goWeekly'), go.weekly) + row(T('goMonthly'), go.monthly);
    if (!rows) return '';
    return '<div class="preview-box preview-go">' +
      '<div class="p-title">' + T('previewGo') + '</div>' + rows +
      '</div>';
  }
  /** 拉取并回填单账号的用量摘要（容器 C）。失败/404 → 保持 null → 容器隐藏。 */
  function fetchPreviewUsage(id) {
    api('GET', '/__admin/api/console/account/' + id + '/usage?range=7d', null).then(function (r) {
      var c = previewCache[id];
      if (!c) return;
      if (r.ok && r.json && r.json.ok !== false && r.json.data && r.json.data.summary) c.usage = r.json.data;
      fillPreviewBox(id, 'usage', previewUsageHtml(c));
    }).catch(function () {});
  }
  /** 拉取并回填单账号的网关实际代理用量（容器 C'，优先级高于 org 用量）。失败 → 回落 org。 */
  function fetchPreviewGateway(id) {
    api('GET', '/__admin/api/accounts/' + id + '/usage-gateway?rangeDays=7', null).then(function (r) {
      var c = previewCache[id];
      if (!c) return;
      if (r.ok && r.json && r.json.ok !== false && r.json.data) c.gw = r.json.data;
      fillPreviewBox(id, 'usage', previewUsageHtml(c));
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
  /** legacy keys 摘要行的 HTML：N 个 legacy key + 首个名字（无 legacy 返回 ''）。
   *  accountCard（render 重建时读缓存）与 fillPreviewLegacy（数据后到时补插）共用。 */
  function legacyPreviewRow(keys) {
    if (!keys || !keys.length) return '';
    var names = [];
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] && keys[i].name) names.push(keys[i].name);
    }
    return '<div class="key-row legacy-row" title="' + T('legacyHint') + '">' +
      '<span class="w">' + T('legacyCount') + ' ' + keys.length + '</span>' +
      (names.length ? '<span class="fp cut">' + esc(names[0]) + '</span>' : '') +
      '</div>';
  }
  /** 数据后到时补插 legacy 摘要行（防重：已有 .legacy-row 就不再插）。 */
  function fillPreviewLegacy(id, keys) {
    var html = legacyPreviewRow(keys);
    if (!html) return;
    var card = document.querySelector('.card[data-id="' + id + '"]');
    if (!card) return;
    if (card.querySelector('.keys .legacy-row')) return;
    var add = card.querySelector('.keys .key-add');
    if (!add) return;
    add.insertAdjacentHTML('beforebegin', html);
  }
  /** 拉取并回填单账号的 Go 三窗口（容器 D）。失败 → 保持 null → 容器隐藏。 */
  function fetchPreviewGo(id) {
    api('GET', '/__admin/api/legacy/account/' + id + '/go', null).then(function (r) {
      var c = previewCache[id];
      if (!c) return;
      if (r.ok && r.json && r.json.ok !== false && r.json.data && r.json.data.go) c.go = r.json.data;
      fillPreviewBox(id, 'go', previewGoBox(c.go));
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
      fetchPreviewUsage(id);
      fetchPreviewGo(id);
      fetchPreviewGateway(id);
      fetchPreviewLegacy(id);
    }
  }
  /** 数据到达后回填卡片 DOM（无壳时插入容器；空 html = 失败 → 不动作）。 */
  function fillPreviewBox(id, cls, html) {
    if (!html) return;
    var card = document.querySelector('.card[data-id="' + id + '"]');
    if (!card) return;
    var box = card.querySelector('.preview-' + cls);
    if (box) { box.outerHTML = html; return; }
    var cols = card.querySelector('.preview-cols');
    if (!cols) return;
    cols.insertAdjacentHTML('beforeend', html);
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
  }

  function tick(manual) {
    fetch('/__admin/api/accounts', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))); })
      .then(function (d) {
        $('h-live').className = 'ok'; $('h-live-text').textContent = T('live');
        render(d);
        // 独立于 render：数据不变 render 跳过时，预览失败缓存（60s TTL）仍能
        // 在过期后重试——否则「首次加载失败 → 容器永远不出现」（审查）。
        loadPreviewData(d.list);
      })
      .catch(function (e) {
        $('h-live').className = 'bad'; $('h-live-text').textContent = e.message;
      });
    fetchUsage();
    fetchOverviewTrend();
    fetchRequests();
    fetchIpStats();
    fetchAudit();
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
      loadLegacyBilling(detailState.id);
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
    if (!name) { $('e-err-' + id).textContent = T('nameRequired'); return; }
    api('PATCH', '/__admin/api/accounts/' + id, { name: name, kind: kind, cookie: cookie })
      .then(function (r) {
        if (r.ok) { $('edit-' + id).hidden = true; $('e-err-' + id).textContent = ''; tick(true); }
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

  /** 改 key 昵称：confirm 弹层内联输入框（留空 = 清除），PATCH keys/:fp。 */
  function renameKey(id, fp) {
    var cur = '';
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
      body: '<div class="oc-form"><div class="oc-field oc-full"><label>' + T('nickname') + '</label>' +
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
    usage: 'view-usage', tokens: 'view-tokens', settings: 'view-settings',
    'account-detail': 'view-account-detail'
  };
  /** 每个 tab 的子导航：词条键 + 锚点 section id。 */
  var SUBS = {
    overview: [['subOverview', 'sec-overview'], ['subStatus', 'sec-status'], ['subHealth', 'sec-health']],
    accounts: [['subAccounts', 'sec-accounts'], ['subCreate', 'sec-create'], ['subOauth', 'sec-oauth']],
    usage: [['subRequests', 'sec-usage-summary'], ['subKeys', 'sec-usage-keys'], ['subIps', 'sec-usage-ips'], ['subAudit', 'sec-usage-audit']],
    tokens: [['subTokens', 'sec-tokens']],
    settings: [
      ['subLanguage', 'sec-settings-lang'], ['subModelMap', 'sec-modelmap'],
      ['subAdminAuth', 'sec-admin-auth'], ['subAdminKeys', 'sec-admin-keys'],
      ['subExperimental', 'sec-experimental'], ['subAbout', 'sec-about'],
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
    if (v === 'settings') { refreshModelMap(); loadSettings(false); }  // 进设置页时拉映射表 + 热改配置
    if (v === 'tokens') { loadTokens(false); }  // 进密钥页时拉列表（60s 缓存内不重拉）
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
            : esc(k.disabledReason || '') + (k.recoverInMs > 0 ? ' · ' + hms(k.recoverInMs) : '');
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
    return '<tr>' +
      '<td class="t-name">' + esc(t.name) + '</td>' +
      '<td>' + stBadge + '</td>' +
      '<td class="tok-mask">' + esc(t.mask) +
        ' <button class="oc-btn oc-btn-ghost oc-btn-sm" data-action="copy-token" data-id="' + t.id + '" title="' + T('tokenCopyTitle') + '">' + T('tokenCopy') + '</button>' +
      '</td>' +
      '<td>' + cost + ' · ' + req + ' · ' + tok + '</td>' +
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
        '<div class="oc-field oc-full"><label>' + T('tokenName') + '</label>' +
          '<input class="oc-input" id="tok-name" autocomplete="off"></div>' +
        '<div class="oc-field oc-full"><label>' + T('tokenCount') + '</label>' +
          '<input class="oc-input" id="tok-count" type="number" min="1" max="10" step="1" value="1" autocomplete="off"></div>' +
        '<div class="oc-field oc-full"><label>' + T('tokenCustomKey') + '</label>' +
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
    openConfirm({
      title: T('tokenEditTitle'),
      okText: T('save'),
      body: '<div class="oc-form">' +
        '<div class="oc-field oc-full"><label>' + T('tokenName') + '</label>' +
          '<input class="oc-input" id="tok-edit-name" value="' + esc(t.name) + '" autocomplete="off"></div>' +
        '<div class="oc-field oc-full"><label>' + T('tokenNote') + '</label>' +
          '<input class="oc-input" id="tok-edit-note" value="' + esc(t.note || '') + '" placeholder="' + T('tokenNotePlaceholder') + '" autocomplete="off"></div>' +
        '</div>',
      run: function () {
        var name = $('tok-edit-name').value.trim();
        var note = $('tok-edit-note').value.trim();
        if (!name) { $('confirm-err').textContent = T('tokenNameRequired'); unlockConfirm(); return; }
        api('PATCH', '/__admin/api/tokens/' + id, { name: name, note: note || null })
          .then(function (r) { tokDone(r, T('tokenSaved')); });
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

  // ── 请求明细（/__admin/api/requests，按 at 倒序）──
  // 字段契约：{at, status, path, durationMs, inputTokens, outputTokens, model,
  // fingerprint, ua, client, endpoint, error}；client/ua 由服务端解析。
  // 分页/搜索：pageSize 可切 20/50/100，q 过滤 path/status/model/client/ua（不区分大小写）。
  var REQ_PAGE_SIZE = 20;
  var reqPage = 1, reqTotal = 0, reqQuery = '';
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
        e.fingerprint ? '<span>key ' + esc(e.fingerprint) + '</span>' : '',
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
        '<div class="oc-field oc-full"><label>' + T('modelAlias') + '</label>' +
          '<input class="oc-input" id="mm-edit-alias" value="' + esc(alias) + '" disabled></div>' +
        '<div class="oc-field oc-full"><label>' + T('modelTarget') + '</label>' +
          '<input class="oc-input" id="mm-edit-target" list="mm-targets" value="' + esc(cur.target) + '" autocomplete="off" spellcheck="false"></div>' +
        '<div class="oc-field oc-full"><label>' + T('modelNote') + '</label>' +
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
  var settingsCache = null;  // {at, data}
  var SETTINGS_SRC = { env: 'sourceEnv', db: 'sourceDb' };
  function loadSettings(force) {
    if (!force && settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL) {
      renderSettings(settingsCache.data);
      return;
    }
    api('GET', '/__admin/api/settings', null).then(function (r) {
      if (r.ok && r.json && r.json.data && r.json.data.settings) {
        settingsCache = { at: Date.now(), data: r.json.data.settings };
        renderSettings(settingsCache.data);
      } else {
        var panel = $('exp-panel');
        if (panel) panel.innerHTML = '<div class="oc-hint oc-hint-err">' + esc(T('expUnavailable')) + '</div>';
      }
    });
  }
  function renderSettings(s) {
    var srcOf = function (k) { return T(SETTINGS_SRC[(s[k] && s[k].source === 'db') ? 'db' : 'env']); };
    // 账号密码：用户名回填；密码不回显（value 恒 ''），来源标记说明一切。
    var u = $('aa-user');
    if (u && s.adminUser) u.value = s.adminUser.value;
    var up = $('aa-pass');
    if (up) up.placeholder = T('adminPassPlaceholder');
    var us = $('aa-user-src');
    if (us) us.textContent = srcOf('adminUser');
    var ps = $('aa-pass-src');
    if (ps) ps.textContent = srcOf('adminPass');
    // env 来源 = 默认密码（settings 表没有 adminPass 键），提示修改。
    var pw = $('aa-pass-warn');
    if (pw) {
      pw.hidden = !(s.adminPass && s.adminPass.source === 'env');
      pw.textContent = T('adminPassEnvWarn');
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
      ? Number(s.compactMaxMessageChars.value) + ' chars'
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
  var detailState = { id: null, range: '7d', billing: null };
  /** microCents → $（1e8 = $1），两位小数。null/undefined/非法输入 → '—'（未知），
   *  不把「没拿到数据」伪装成「没钱」——0 是合法值，显示 $0.00。 */
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
    el.innerHTML = '<div class="oc-hint oc-hint-err">' + esc(msg) + '</div>';
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
    ['detail-workspace', 'workspaceTitle', 'workspaceSub'],
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
    ['detail-go', 'goSub', 'goSubHint'],
    ['detail-legacy', 'legacyKeys', 'legacySub'],
    ['detail-legacy-billing', 'legacyBilling', 'legacyBillingSub'],
  ];
  function loadAccountDetail() {
    var id = detailState.id;
    if (id == null) return;
    DETAIL_BLOCK_KEYS.forEach(function (b) {
      var el = $(b[0]);
      if (el && !el.innerHTML) el.innerHTML = dBlock(b[1], b[2], '<div class="oc-hint">' + T('loading') + '</div>');
    });
    loadBilling(id);
    loadUsage();
    loadModelsUsage(id);
    loadUsersUsage(id);
    loadMembers(id);
    loadSa(id);
    loadProviders(id);
    loadBudgets(id);
    loadMemberBudgets(id);
    loadPricing(id);
    loadLegacyKeys(id);
    loadLegacyBilling(id);
    loadGo(id);
    loadWorkspaces(id);
  }

  /** 工作区区块：显示当前 workspace（id + 名称）+ 切换入口。 */
  function loadWorkspaces(id) {
    api('GET', '/__admin/api/console/account/' + id + '/workspaces', null).then(function (r) {
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
        body: '<div class="oc-form"><div class="oc-field oc-full"><label>' + T('workspaceId') + '</label>' +
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

  function loadGo(id, fromTick) {
    api('GET', '/__admin/api/legacy/account/' + id + '/go', null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态：旧账号慢响应不渲染进新视图
      var el = $('detail-go');
      if (!r.ok || !r.json || r.json.ok === false || !r.json.data || !r.json.data.go) {
        if (r.status === 404) { el.innerHTML = ''; return; }  // 非 legacy workspace 静默隐藏
        if (r.status === 401 || r.status === 403) { detailErr('go', T('legacyCookieMissing')); return; }
        detailErr('go', errMsg(r));
        return;
      }
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

  function loadBilling(id, fromTick) {
    api('GET', '/__admin/api/console/account/' + id + '/billing', null).then(function (r) {
      if (detailState.id !== id) return;  // 详情切换竞态：旧账号慢响应不渲染进新视图
      if (!r.ok || !r.json || r.json.ok === false || !r.json.data) {
        detailErr('billing', errMsg(r));  // detailErr 统一处理 env 中性化/凭据类中性化
        $('detail-autorecharge').innerHTML = '';
        return;
      }
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
    api('GET', '/__admin/api/console/account/' + id + '/usage?range=' + detailState.range, null).then(function (r) {
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
    api('GET', '/__admin/api/console/account/' + id + '/usage/models?range=' + detailState.range, null).then(function (r) {
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
    api('GET', '/__admin/api/console/account/' + id + '/usage/users?range=' + detailState.range, null).then(function (r) {
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
    api('GET', '/__admin/api/console/account/' + id + '/budgets/users-status', null).then(function (r) {
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
    api('GET', '/__admin/api/console/account/' + id + '/models-pricing', null).then(function (r) {
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
    for (var pid in provs) {
      if (!Object.prototype.hasOwnProperty.call(provs, pid)) continue;
      var p = provs[pid] || {};
      var models = p.models || {};
      for (var mid in models) {
        if (!Object.prototype.hasOwnProperty.call(models, mid)) continue;
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
  /** 旧版计费：余额（美元）+ 自动充值 + 最近 5 笔支付。失败语义与 legacy keys 同款。 */
  function loadLegacyBilling(id) {
    api('GET', '/__admin/api/legacy/account/' + id + '/billing', null).then(function (r) {
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

  function loadMembers(id) {    api('GET', '/__admin/api/console/account/' + id + '/members', null).then(function (r) {
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
    api('GET', '/__admin/api/console/account/' + id + '/keys', null).then(function (r) {
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
    api('GET', '/__admin/api/legacy/account/' + id + '/keys', null).then(function (r) {
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
   *  按 id 匹配 → navigator.clipboard 写入 → flash 成功；失败显示 oc-hint-err。 */
  function copyLegacyKey(keyId) {
    var errEl = $('legacy-copy-err');
    if (errEl) errEl.textContent = '';
    api('GET', '/__admin/api/legacy/account/' + detailState.id + '/keys/plain', null).then(function (r) {
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
      body: '<div class="oc-form"><div class="oc-field oc-full"><label>' + T('keyName') + '</label>' +
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
    api('GET', '/__admin/api/console/account/' + id + '/providers', null).then(function (r) {
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
    api('GET', '/__admin/api/console/account/' + id + '/budgets', null).then(function (r) {
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
        '<div class="oc-field oc-full"><label>' + T('arEnabled') + '</label>' +
          '<select class="oc-select" id="ar-enabled">' +
            '<option value="1"' + (ar.enabled ? ' selected' : '') + '>' + T('enabled') + '</option>' +
            '<option value="0"' + (!ar.enabled ? ' selected' : '') + '>' + T('disabled') + '</option>' +
          '</select></div>' +
        '<div class="oc-field"><label>' + T('thresholdDollars') + '</label>' +
          '<input class="oc-input" id="ar-threshold" type="number" min="1" step="1" value="' + esc(ar.thresholdDollars == null ? '' : ar.thresholdDollars) + '"></div>' +
        '<div class="oc-field"><label>' + T('rechargeAmountDollars') + '</label>' +
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
      body: '<div class="oc-form"><div class="oc-field oc-full"><label>' + T(scope === 'org' ? 'orgBudget' : 'userBudget') + '</label>' +
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
      body: '<div class="oc-form"><div class="oc-field oc-full"><label>' + T('saModalName') + '</label>' +
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
    if (act === 'detail') { openAccountDetail(id); return; }
    if (act === 'edit') { toggleEdit(id); return; }
    if (act === 'cancel') { var ed = $('edit-' + id); if (ed) ed.hidden = true; return; }
    if (act === 'save') { saveEdit(id); return; }
    if (act === 'billing') { refreshBalance(id); return; }
    if (act === 'addkey') { addKey(id); return; }
    if (act === 'renamekey') { renameKey(id, btn.getAttribute('data-fp')); return; }
    if (act === 'delkey') { delKey(id, btn.getAttribute('data-fp')); return; }
    if (act === 'delete') { delAccount(id); return; }
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
  // m1（对抗审查）：关闭即清空明文（DOM + dataset）——「仅此一次」在页面生命周期内也成立。
  function clearPlain() {
    var el = $('plain-list');
    if (el) { el.innerHTML = ''; delete el.dataset.plain; }
    $('plain-overlay').hidden = true;
  }
  $('plain-close').addEventListener('click', clearPlain);
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

  // 语言菜单选择 + 点外部关闭 dropdown（dd-toggle 自身的开关在各自按钮上）。
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.matches && t.matches('[data-go-toggle]')) {
      var id = t.getAttribute('data-id');
      var toggle = t.getAttribute('data-go-toggle');
      var enabled = t.checked;
      api('POST', '/__admin/api/legacy/account/' + id + '/go/' + (toggle === 'useBalance' ? 'use-balance' : 'china-models'), { enabled: enabled }).then(function (r) {
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
    var item = e.target.closest('.dd-item[data-lang]');
    if (item) {
      var v = item.getAttribute('data-lang');
      if (v === 'zh' || v === 'en') {
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
      if (act === 'copy-legacy-key') { copyLegacyKey(btn.getAttribute('data-keyid')); return; }
      if (act === 'refresh-legacy-keys') { loadLegacyKeys(detailState.id); return; }
      if (act === 'ws-switch') { switchWorkspace(Number(btn.getAttribute('data-id'))); return; }
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
  // 恢复上次的 tab + sidebar 子项（非法/详情视图回退 overview，sub 由
  // renderSubnav 校验兜底）。tab 记忆 = 刷新/重进面板不回到初始 tab。
  try {
    var rv = localStorage.getItem('fc-admin-view');
    if (rv && VIEWS[rv] && rv !== 'account-detail') curView = rv;
    var rs = localStorage.getItem('fc-admin-sub');
    if (rs) curSub = rs;
  } catch (e) {}
  switchView(curView);
  tick(); setInterval(tick, 2000);
  setInterval(tickCountdown, 1000);
  // 首拉分发密钥（总览费用/密钥卡 + 密钥 tab 共用这份 60s 缓存）。
  loadTokens(false);
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
<title>fuckopencode — sign in</title>
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
        <label data-i18n="username">username</label>
        <input class="oc-input" id="lg-user" name="username" autocomplete="username" autofocus>
      </div>
      <div class="oc-field">
        <label data-i18n="password">password</label>
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
      authRequired: 'admin panel requires authentication',
      username: 'username', password: 'password',
      loginError: 'invalid username or password',
      locked: 'locked: retry in {n}s'
    },
    zh: {
      signIn: '登录', signInSub: '/ 登录',
      authRequired: '管理面板需要登录',
      username: '用户名', password: '密码',
      loginError: '用户名或密码错误',
      locked: '已锁定：{n} 秒后重试'
    }
  };
  var lang = (function () {
    try { var v = localStorage.getItem('fc-lang'); if (v === 'zh' || v === 'en') return v; } catch (e) {}
    return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  })();
  var T = function (k) { return (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k; };
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
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
