import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { DEFAULT_ADMIN_PASS, type AppConfig } from './config.js';
import { fetchUpstreamModels, postUpstreamChat, type UpstreamCall } from './upstream.js';
import { KeyPool, PoolEmptyError, keyFingerprint, type KeyStateEvent } from './keypool.js';
import {
  anthropicErrorToOpenAI,
  classifyUpstreamFailure,
  resetDelayMsFromError,
  INTERNAL_SERVER_ERROR,
  rejectionError,
  stripControl,
  stripSecrets,
  UPSTREAM_TIMEOUT_ERROR,
} from './errors.js';
import { verifyAuth } from './security/auth.js';
import { buildSystemGuard, detectInjection, extractAllText, scanMessagesForInjection } from './security/injection.js';
import { isJsonContentType, validateAnthropicRequest, validateChatRequest } from './security/validate.js';
import { extractDevice, recordEvent, snapshot, type RequestEvent } from './metrics.js';
import { UsageDb } from './usagedb.js';
import { applySettingsToConfig, SETTINGS_META, SettingsStore, validateSetting } from './settings.js';
import { TokensStore, fingerprintOf } from './tokens.js';
import { RpmLimiter } from './ratelimit.js';
import { buildAccountsSection, type AccountsStore } from './accounts.js';
import { handleAdminRoutes, LOGIN_HTML, parseAccountId } from './admin.js';
import { loadModelAliases, updateModelAlias } from './modelmap.js';
import { OauthManager, type OauthIdentity } from './oauth.js';
import type { FetchLike } from './billing.js';
import { DASHBOARD_HTML } from './dashboard.js';
import { anthropicToOpenAIRequest } from './toOpenAI.js';
import { anthropicEventToSSE, openAIStreamToAnthropic, openAIToAnthropicResponse } from './toAnthropic.js';
import { sseStringify } from './stream.js';
import { parseOpenAISSE } from './sse.js';
import {
  ALLOWED_MODELS,
  filterThinkingFromStream,
  normalizeAnthropicRequest,
  resolveModelName,
} from './deepseek.js';
import type { OpenAIChatRequest, OpenAIChatResponse } from './types.js';

/** 直通模式总是转发的头（Claude Code 依赖的 beta 标记）。 */
const FORWARD_HEADERS = ['anthropic-beta'];
/** 会话标记头：默认不透传（共享部署可被客户端冒充会话），TRUST_CLAUDE_CODE_HEADERS=1 才转发。 */
const CLAUDE_CODE_HEADERS = ['x-claude-code-session-id', 'x-claude-code-agent-id', 'x-claude-code-parent-agent-id'];

/** 转发 header 值上限：防恶意客户端塞超大 header 借上游。 */
const MAX_FORWARD_HEADER_CHARS = 500;

/**
 * anthropic-beta 里需要剥掉的 compact 相关值（与 body 的 context_management
 * 成对剥除——官方网关协议：body 字段与 beta header 必须成对，否则上游可能
 * 只剥一半出 400，opencode Zen 踩过的坑 issue #34694）。DeepSeek 不支持
 * compaction，剥掉后 Claude Code 安静走本地 compact 路径。
 */
const STRIP_BETA_VALUES = ['compact-2026-01-12', 'compact-2025-06-27', 'context-management-2025-06-27'];

function collectForwardHeaders(
  headers: IncomingMessage['headers'],
  cfg: AppConfig,
): Record<string, string> {
  const out: Record<string, string> = {};
  const names = cfg.trustClaudeCodeHeaders
    ? [...FORWARD_HEADERS, ...CLAUDE_CODE_HEADERS]
    : FORWARD_HEADERS;
  for (const name of names) {
    const value = headers[name];
    if (typeof value === 'string' && value) {
      let cleaned = stripControl(value).slice(0, MAX_FORWARD_HEADER_CHARS);
      if (name === 'anthropic-beta') {
        // 成对剥除 compact/context-management 值（与 body 的 context_management 对齐）。
        const parts = cleaned.split(',').map((p) => p.trim()).filter((p) => !STRIP_BETA_VALUES.includes(p));
        cleaned = parts.join(', ');
      }
      if (cleaned) out[name] = cleaned;
    }
  }
  return out;
}

/**
 * 带背压的响应写入：`res.write()` 返回 false 表示内核缓冲已满，
 * 等待 'drain' 再继续，避免慢客户端把内存推到无界。
 * 客户端断开（'close'/'error'）时也解除等待，让调用循环检查 res.destroyed 退出。
 */
function writeChunk(res: ServerResponse, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (res.write(data)) {
      resolve();
      return;
    }
    res.once('drain', resolve);
    res.once('close', resolve);
    res.once('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 上游记账 cost（microCents，实测字符串如 "0"）→ 数字。非法/负数输入按 0 ——
 * 观测数据，坏值不落库、不抛错。
 */
function parseCostMicroCents(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/**
 * 包一层生成器：透传每个 chunk，同时把记账 chunk 的 cost 回调出来。
 * 用途：流式转换链（openAIStreamToAnthropic）会吞掉无 choices/usage 的记账
 * chunk，这里在转换前窥视 cost 供落库，转换链路本身不受影响。
 */
async function* tapStreamCost<T extends { cost?: string }>(
  chunks: AsyncIterable<T>,
  onCost: (costMicroCents: number) => void,
): AsyncGenerator<T> {
  for await (const chunk of chunks) {
    if (chunk.cost != null) onCost(parseCostMicroCents(chunk.cost));
    yield chunk;
  }
}

// 日志/转发清洗复用 errors.ts 的 stripControl（剥控制符防日志伪造）。

const BODY_READ_TIMEOUT_MS = 30_000;

function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: { ok: true; text: string } | { ok: false; status: number }): void => {
      if (done) return;
      done = true;
      resolve(result);
    };
    // 慢客户端/半开连接：30s 读不完直接 408 断连。
    req.setTimeout(BODY_READ_TIMEOUT_MS, () => {
      finish({ ok: false, status: 408 });
      req.destroy();
    });
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // maxBytes=0 表示不限制（对齐 kirostudio：大请求体常见，限制反而误伤）。
      if (maxBytes > 0 && size > maxBytes) {
        finish({ ok: false, status: 413 });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      req.setTimeout(0); // 读完就撤掉闲置超时，别误杀 keep-alive 连接。
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', (err) => {
      req.setTimeout(0);
      // 观测：请求体读取中途的连接错误（ECONNRESET/aborted 等）此前只落一个
      // 400 状态码 + requestBytes=0，用户问「为什么 400」时无据可查。这里把
      // 错误类别打进日志（落库走 ctx.error，调用方在 body 读失败分支补记）。
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
      console.log(`[proxy] body read error: ${code} (${(err.message ?? '').slice(0, 120)})`);
      finish({ ok: false, status: 400 });
    });
  });
}

const BODY_READ_STATUS_MESSAGE: Record<number, string> = {
  408: 'request body read timed out',
  413: 'request body too large',
};

function parseJson(text: string): { ok: true; body: unknown } | { ok: false; empty: boolean } {
  // 区分「请求体为空」与「JSON 写错」：空 body 通常意味着上游代理/透传层把
  // 请求体丢了（实测 kirostudio 透传曾发出 0 字节 body），而不是客户端写错 JSON。
  // 报错文案不同才能一眼定位是哪一层的问题。
  if (text.length === 0) return { ok: false, empty: true };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, empty: false };
  }
}

/** 空 body / 畸形 JSON 的统一错误响应。 */
function badBodyError(empty: boolean): { error: { message: string; type: string } } {
  return {
    error: {
      message: empty
        ? 'request body is empty — a proxy or relay in front of this gateway likely dropped it'
        : 'invalid JSON body',
      type: 'invalid_request_error',
    },
  };
}

/**
 * 上游已知模型清单。启动时异步拉一次，用于判断客户端请求的模型名能否直传
 * （上游支持 61 个模型，不该被 fallback 一律吃掉）。拉取失败保持为空集，
 * 此时退化成老行为：只认 MODEL_MAP，其余回落 fallback。
 */
let upstreamModels: ReadonlySet<string> = new Set();

/**
 * 从 Host 头解析 hostname（忽略端口）。解析失败返回 null（fail-closed）。
 *
 * 覆盖形态：
 * - `127.0.0.1:8799` / `localhost:8799` → 冒号后是纯数字端口，切掉。
 * - `[::1]:8799` → 方括号内的 IPv6。
 * - 裸 IPv6 `::1`（无方括号）无法区分地址与端口，整体当 hostname。
 *   像 `::1:8799` 这种歧义形态不会被切，自然也过不了下面的白名单 —— 落回鉴权。
 */
function hostnameFromHostHeader(host: string): string | null {
  let h = host.trim().toLowerCase();
  if (h.length === 0 || h.length > 255) return null;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end < 0) return null;
    return h.slice(1, end) || null;
  }
  if ((h.match(/:/g) ?? []).length <= 1) {
    const colon = h.indexOf(':');
    if (colon >= 0) return h.slice(0, colon) || null;
  }
  return h;
}

/** 免 key 本机放行允许的 Host hostname（DNS rebinding 白名单，忽略端口）。 */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * 是否为「直连本机」的请求：socket 源地址是回环、Host 指向本机，且没有任何
 * 反代/CDN 转发头。
 *
 * 三条防线各挡一类绕过：
 * - cloudflared 反代进来的请求 socket 也是 127.0.0.1，光看源地址会误判成本机，
 *   从而把含 IP/UA 的面板暴露到公网。所以额外要求不带 cf-* / x-forwarded-*
 *   这类头 —— 走 SSH 隧道时不会有这些头，走隧道/CDN 时一定有。
 * - DNS rebinding：恶意网页把域名 rebind 到 127.0.0.1 后 socket 也是回环、
 *   转发头也是空的，但 Host 头是攻击者自己的域名（`evil.com:port`）。
 *   Host hostname 必须在 {127.0.0.1, localhost, ::1} 白名单内才给免 key 放行，
 *   否则落回 verifyAuth —— 攻击者拿不到 key 就是 401。
 */
function isDirectLocalRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!loopback) return false;
  const host = req.headers.host;
  const hostname = typeof host === 'string' ? hostnameFromHostHeader(host) : null;
  if (hostname == null || !LOCAL_HOSTNAMES.has(hostname)) return false;
  const h = req.headers;
  return (
    h['cf-connecting-ip'] == null &&
    h['cf-ray'] == null &&
    h['x-forwarded-for'] == null &&
    h['x-real-ip'] == null
  );
}

/**
 * 管理面鉴权（MULTI-ACCOUNT.md §6.1）：本机直连免 key，或带 API key，
 * 或面板登录会话 cookie 有效。DASHBOARD_PUBLIC 公网模式**永不豁免** ——
 * 账户管理含增删凭据，公开等于裸奔。
 */
function isAdminRequest(req: IncomingMessage, cfg: AppConfig): boolean {
  if (cfg.dashboardOpen && isDirectLocalRequest(req)) return true;
  if (adminSessionValid(req, cfg)) return true;
  return verifyAuth(cfg, req.headers as Record<string, string | undefined>).ok;
}

// ---------------------------------------------------------------------------
// 面板账号密码登录（默认 admin / DEFAULT_ADMIN_PASS，env 可覆盖）。
// 会话 = 签名 cookie（HMAC，密码版本进签名）；HttpOnly + SameSite=Lax + Secure。
// 登录失败限速防爆破；跨站 Origin 校验防跨站表单锁定 DoS。
// ---------------------------------------------------------------------------

// 浏览器自动请求的静态资源（favicon/图标等）：无鉴权直接 404，不进 metrics。
const STATIC_ASSET_PATHS = new Set([
  '/favicon.ico',
  '/robots.txt',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/apple-touch-icon-120x120.png',
  '/apple-touch-icon-152x152.png',
  '/site.webmanifest',
  '/browserconfig.xml',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
]);

const ADMIN_SESSION_COOKIE = 'fc_admin_session';
// 无状态签名会话：HMAC-SHA256(secret, expiry + 密码版本)。**不存内存** ——
// 服务重启会话不失效（用户不用每次部署后重新输入密码）。
// 登出用内存黑名单（签名 → 过期时刻）。密码版本进 HMAC ⇒ 改密码后旧签名
// 立即失效（见 passwordVersion）；黑名单按 expiry 过期清理 + 上限钳制，
// 不会无界增长（见 MAX_REVOKED_SESSIONS）。
const revokedSessions = new Map<string, number>(); // 签名 → 过期时刻
const loginFails = new Map<string, { fails: number; lockedUntil: number }>(); // ip → 状态

/** 兜底会话密钥：进程启动随机（randomBytes 32，模块级存一份，重启失效）。
 *  与旧的内存 token 会话同一生命周期语义 —— 签名密钥不可用时宁可重启失效，
 *  也绝不能用 `fc-session-<port>` 这种可预测材料（端口公开可探测 → 会话伪造）。 */
let fallbackSessionKey: Buffer | null = null;
let fallbackSessionKeyLogged = false;

/** 会话签名密钥：与账户加密同源（GATEWAY_SECRET 或 data/secret.key 派生）。
 *  两者都不可用（理论上不会）回落进程随机 —— 重启失效，但至少不裸奔。 */
function sessionKey(cfg: AppConfig): Buffer {
  if (cfg.gatewaySecret) return crypto.createHash('sha256').update(cfg.gatewaySecret).digest();
  try {
    const material = fs.readFileSync(cfg.secretFilePath, 'utf8').trim();
    return crypto.createHash('sha256').update(material).digest();
  } catch {
    if (fallbackSessionKey == null) fallbackSessionKey = crypto.randomBytes(32);
    if (!fallbackSessionKeyLogged) {
      fallbackSessionKeyLogged = true;
      console.warn('[admin] 会话密钥降级为进程随机（重启失效，所有已签发会话作废）');
    }
    return fallbackSessionKey;
  }
}

/** 密码版本：sha256(adminPass)。编进签名 ⇒ 改密码（settings 热改 / env 重启）
 *  后旧签名会话全部失效 —— 攻击者拿到旧会话 cookie 也不能在密码更换后复用。 */
function passwordVersion(cfg: AppConfig): string {
  return crypto.createHash('sha256').update(cfg.adminPass).digest('hex');
}

/** 签发无状态会话 token：`<签名>.<过期时刻>`。 */
function createAdminSession(cfg: AppConfig, now: number): string {
  const expiry = now + cfg.adminSessionTtlMs;
  const sig = crypto
    .createHmac('sha256', sessionKey(cfg))
    .update(`${expiry}.${passwordVersion(cfg)}`)
    .digest('hex');
  return `${sig}.${expiry}`;
}

/** cookie 里的签名会话是否有效（签名 + 过期 + 未登出）；有效返回 true。 */
function adminSessionValid(req: IncomingMessage, cfg: AppConfig): boolean {
  pruneRevokedSessions(Date.now());
  const cookie = req.headers.cookie;
  if (typeof cookie !== 'string') return false;
  const m = /(?:^|;\s*)fc_admin_session=([0-9a-f]{64})\.(\d+)(?:;|$)/.exec(cookie);
  if (m == null) return false;
  const sig = m[1]!;
  const expiry = Number(m[2]);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;
  if (revokedSessions.has(sig)) return false;
  const expect = crypto
    .createHmac('sha256', sessionKey(cfg))
    .update(`${expiry}.${passwordVersion(cfg)}`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
}

/** 销毁会话（登出）：签名进黑名单（带过期时刻）+ 浏览器 cookie 清掉。 */
function destroyAdminSession(req: IncomingMessage): void {
  const cookie = req.headers.cookie;
  if (typeof cookie === 'string') {
    const m = /(?:^|;\s*)fc_admin_session=([0-9a-f]{64})\.(\d+)(?:;|$)/.exec(cookie);
    if (m) addRevokedSession(m[1]!, Number(m[2]));
  }
  pruneRevokedSessions(Date.now());
}

/** 登出黑名单上限：无上限时每个登录会话都能往黑名单塞一条，长期运行会
 *  无限吃内存（内存 DoS 面）。Map 满时淘汰最旧条目（插入序 = 最早签发 =
 *  最早过期）——黑名单继续工作，只是最早的一批被换出。 */
export const MAX_REVOKED_SESSIONS = 10_000;

/** 登出黑名单当前条数（测试断言「清理/上限生效」用）。 */
export function revokedSessionCount(): number {
  return revokedSessions.size;
}

/** 按过期时刻清理黑名单：过期条目（expiry <= now）删掉。登出只会发生在
 *  会话有效期内，所以清理后黑名单尺寸恒 ≤ 一个 TTL 窗口内的登出数。 */
export function pruneRevokedSessions(now: number): void {
  for (const [sig, expiry] of revokedSessions) {
    if (expiry <= now) revokedSessions.delete(sig);
  }
}

/** 测试专用：直接向黑名单注入一条（防 24h TTL 让过期清理/上限不可测）。
 *  与登出路径共用 addRevokedSession（上限淘汰逻辑同款）。 */
export function revokeSessionForTest(sig: string, expiry: number): void {
  addRevokedSession(sig, expiry);
}

function addRevokedSession(sig: string, expiry: number): void {
  if (revokedSessions.size >= MAX_REVOKED_SESSIONS) {
    const oldest = revokedSessions.keys().next().value;
    if (oldest != null) revokedSessions.delete(oldest);
  }
  revokedSessions.set(sig, expiry);
}

/** 登录失败限速：返回剩余锁定时长（ms，0 = 未锁定）。
 *  注意：未锁定的记录（lockedUntil=0，只有失败计数）**不能删**——否则每次
 *  请求开头的这次检查会把上次的失败计数清掉，限速永远不触发。 */
function loginLockRemaining(ip: string, now: number): number {
  const st = loginFails.get(ip);
  if (!st) return 0;
  if (st.lockedUntil > now) return st.lockedUntil - now;
  if (st.lockedUntil > 0) loginFails.delete(ip); // 已过期的锁定记录清理
  return 0;
}

/** 登录失败限速键的上限：伪造转发头直连本机时每个假 IP 是一个键，无上限
 *  会被撑爆内存（内存 DoS）。Map 满时淘汰最旧条目 —— 限速继续工作（新 IP
 *  照常计数），只是最早的一批记录被换出。 */
export const MAX_LOGIN_FAIL_KEYS = 1_000;

/** 只读观察点（测试断言「伪造大量 XFF 不会让键无限增长」用）。 */
export function loginFailKeyCount(): number {
  return loginFails.size;
}

/** 登录失败计数（超过阈值即锁定）。 */
function recordLoginFail(ip: string, cfg: AppConfig, now: number): void {
  if (!loginFails.has(ip) && loginFails.size >= MAX_LOGIN_FAIL_KEYS) {
    // 淘汰最旧（Map 插入序的第一个），给新 IP 让位 —— 键数恒 ≤ 上限。
    const oldest = loginFails.keys().next().value;
    if (oldest != null) loginFails.delete(oldest);
  }
  const st = loginFails.get(ip) ?? { fails: 0, lockedUntil: 0 };
  st.fails += 1;
  if (st.fails >= cfg.adminLoginFailLimit) {
    st.lockedUntil = now + cfg.adminLoginLockMs;
    st.fails = 0;
  }
  loginFails.set(ip, st);
}

function clearLoginFails(ip: string): void {
  loginFails.delete(ip);
}

/** 登录限速键 = 真实客户端 IP。经盾/cloudflared 的流量 remoteAddress 全是
 *  127.0.0.1（盾原样转发），不能拿它当键——否则全局一把锁，一个人输错
 *  所有人 429。优先转发头（cloudflared 注入 cf-connecting-ip，盾透传），
 *  本机直连回落 remoteAddress。
 *
 *  信任转发头的前提：网关只监听回环地址（config 默认 127.0.0.1，8788 线上
 *  形态）——公网不可直达，转发头只能由本地进程（盾）或本机用户注入。
 *  若将来把网关绑到非回环地址，这里必须改为「只在可信代理层覆写转发头后
 *  才信任」，否则伪造 XFF 可绕过限速。 */
/**
 * 提取调用方 IP（requests 落库用，纯展示/统计）。转发头只在网关绑回环的
 * 前提下可信（见 loginRateKey 的说明）；登录限速是安全控制，走 fail-closed
 * 的 clientIpForRateLimit，这里不重复做信任决策。
 *
 * 优先级：cf-connecting-ip（cloudflared/CDN 注入）→ x-real-ip → x-forwarded-for
 * 首段 → socket 地址，与 metrics.extractDevice 的口径一致（同一请求两个出口
 * 的 IP 对得上）。
 */
function clientIpOf(req: IncomingMessage): string {
  return ipFromHeaders(req.headers) ?? (req.socket.remoteAddress ?? 'unknown').slice(0, 64);
}

/** 从转发头取 IP（cf-connecting-ip → x-real-ip → x-forwarded-for 首段）；
 *  都没有返回 null（调用方回落 socket 地址）。 */
function ipFromHeaders(h: IncomingHttpHeaders): string | null {
  const cf = h['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0) return cf.slice(0, 64);
  const realIp = h['x-real-ip'];
  if (typeof realIp === 'string' && realIp.length > 0) return realIp.slice(0, 64);
  const xff = h['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]!.trim();
    if (first) return first.slice(0, 64);
  }
  return null;
}

/** socket 对端是否为回环地址（`::ffff:` 前缀的 IPv4 映射也算）。 */
function isLoopbackPeer(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * 登录限速键 IP 的信任决策（导出供测试）。转发头（cf-connecting-ip / x-real-ip /
 * x-forwarded-for）只在**回环对端**可信：盾 / cloudflared 是本机代理进程，把真实
 * 客户端 IP 覆写进 cf-connecting-ip（盾还会剥离伪造转发头）。非回环对端 =
 * 网关直连无盾（HOST 绑定到公网/局域网）—— 转发头可被任意伪造，轮换 XFF
 * 就能给每个请求换新键绕过限速，此时一律回落 socket 地址（TCP 层无法伪造）。
 *
 * 与 clientIpOf 的差别只在「是否信任转发头」：requests 落库的 IP 沿用 clientIpOf
 * （纯展示/统计），登录限速是安全控制，必须 fail-closed 用本函数。
 */
export function clientIpForRateLimit(
  remoteAddress: string | undefined,
  headers: IncomingHttpHeaders,
): string {
  if (!isLoopbackPeer(remoteAddress)) return (remoteAddress ?? 'unknown').slice(0, 64);
  return ipFromHeaders(headers) ?? (remoteAddress ?? 'unknown').slice(0, 64);
}

/** 登录限速按 IP 记键：与请求落库的 IP 同一来源（clientIpOf），但转发头信任
 *  走 fail-closed 的 clientIpForRateLimit（非回环直连伪造转发头不能绕过）。 */
function loginRateKey(req: IncomingMessage): string {
  return clientIpForRateLimit(req.socket.remoteAddress, req.headers);
}

/** 面板登录端点：POST /__admin/api/login。
 *
 * 双模式（按 accept 头分流）：
 * - accept 为 application/json（curl/脚本，e2e 既有断言）→ 200/401/429 JSON 原样保留。
 * - 其余（浏览器表单默认的 accept 头）→ 302 跳转：成功 → /__admin（Set-Cookie），
 *   凭证错 → /__admin?login_error=1，限速 → /__admin?login_locked=<剩余秒数>。
 *   原生表单 POST + 302 是浏览器密码管理器保存密码的前提，前端不再 fetch。
 * 请求体兼容两种格式：表单 urlencoded（浏览器）与 JSON（脚本）。
 */
async function handleAdminLogin(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AppConfig,
  db: UsageDb | null,
): Promise<void> {
  // 跨站表单锁定 DoS（reviewer m4）：攻击者页面 `<form action=网关/__admin/api/login>`
  // 提交错凭证，浏览器必带攻击者的 Origin —— 与 Host 不匹配 → 403，既不会累计
  // 受害者的失败计数，也不会触发锁定。无 Origin（curl/脚本/同源表单部分场景）
  // 放行 —— 同源请求本来就有 Origin 且匹配 Host。校验必须在限速检查**之前**，
  // 否则跨站表单仍能靠反复命中限速检查把受害者锁住。
  if (!adminOriginAllowed(req)) {
    sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
    return;
  }
  const ip = loginRateKey(req);
  const now = Date.now();
  const wantsJson = /application\/json/i.test(req.headers.accept ?? '');
  const locked = loginLockRemaining(ip, now);
  if (locked > 0) {
    if (wantsJson) {
      sendJson(res, 429, {
        error: { message: `too many login attempts, retry in ${Math.ceil(locked / 1000)}s`, type: 'rate_limited' },
      });
      return;
    }
    res.writeHead(302, { location: `/__admin?login_locked=${Math.ceil(locked / 1000)}` });
    res.end();
    return;
  }
  // 登录是预鉴权、公网可达的唯一 POST 面：固定 64KB 上限（全面审查 M5——
  // 生产 MAX_BODY_BYTES=0 时大 body 整读进堆，配合 OOM 史是内存 DoS 面）。
  const body = await readBody(req, LOGIN_BODY_MAX_BYTES);
  let user = '';
  let pass = '';
  if (body.ok) {
    const ct = (req.headers['content-type'] ?? '').toLowerCase();
    if (ct.includes('application/x-www-form-urlencoded')) {
      const sp = new URLSearchParams(body.text);
      user = sp.get('username') ?? '';
      pass = sp.get('password') ?? '';
    } else {
      try {
        const parsed = JSON.parse(body.text) as Record<string, unknown>;
        user = typeof parsed.username === 'string' ? parsed.username : '';
        pass = typeof parsed.password === 'string' ? parsed.password : '';
      } catch {
        // 非 JSON 体：按空凭证处理，走 401/302 路径。
      }
    }
  }
  const userOk = safeEqual(user, cfg.adminUser);
  const passOk = safeEqual(pass, cfg.adminPass);
  if (!userOk || !passOk) {
    recordLoginFail(ip, cfg, now);
    // 登录审计：凭证失败留痕。限速拦截（上方 locked 分支）刻意不记——
    // 伪造 IP 刷限速会同步刷爆审计表，且拦截本身不是凭证尝试。
    db?.insertAdminAudit({ at: now, op: 'login', accountId: null, ok: false, note: 'invalid credentials', ip });
    if (wantsJson) {
      sendJson(res, 401, { error: { message: 'invalid credentials', type: 'authentication_error' } });
      return;
    }
    res.writeHead(302, { location: '/__admin?login_error=1' });
    res.end();
    return;
  }
  clearLoginFails(ip);
  db?.insertAdminAudit({ at: now, op: 'login', accountId: null, ok: true, note: null, ip });
  // 默认密码告警：登录成功但用的还是 DEFAULT_ADMIN_PASS —— 新部署忘配
  // ADMIN_PASS 的强信号。面板设置页另有 adminPassIsDefault 精确提示，这里
  // 是日志侧兜底（journalctl 一眼能看到）。
  if (cfg.adminPass === DEFAULT_ADMIN_PASS) {
    console.warn(`[admin] 警告：面板登录成功但正在使用默认密码 "${DEFAULT_ADMIN_PASS}"，生产环境请用 env ADMIN_PASS 或设置页改密码`);
  }
  const token = createAdminSession(cfg, now);
  // Secure：会话 cookie 只在 HTTPS/回环传输（Chrome 对 http://localhost 接受
  // Secure cookie，本机 ssh 隧道场景不受影响）——防经公网 http 明文携带会话。
  const setCookie =
    `${ADMIN_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=${Math.floor(cfg.adminSessionTtlMs / 1000)}`;
  if (wantsJson) {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': setCookie });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(302, { location: '/__admin', 'set-cookie': setCookie });
  res.end();
}

/** 面板登出端点：POST /__admin/api/logout。 */
function handleAdminLogout(req: IncomingMessage, res: ServerResponse, db: UsageDb | null): void {
  destroyAdminSession(req);
  db?.insertAdminAudit({ at: Date.now(), op: 'logout', accountId: null, ok: true, note: null, ip: clientIpOf(req) });
  res.writeHead(200, {
    'content-type': 'application/json',
    'set-cookie': `${ADMIN_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0`,
  });
  res.end(JSON.stringify({ ok: true }));
}

/** 常量时间字符串比较（登录凭证用，防时序侧信道）。 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * 面板类页面的 401 提示。浏览器地址栏没法带 header，所以给一句能照做的
 * ssh 隧道指引，而不是干巴巴的 unauthorized。/__dash 与 /__admin 共用。
 */
function sendPanelAuthRequired(res: ServerResponse, cfg: AppConfig, path: string): void {
  sendJson(res, 401, {
    error: {
      message:
        'dashboard requires an API key. open it over an ssh tunnel for key-free local access: ' +
        'ssh -N -L 8899:127.0.0.1:' + cfg.port + ' <host>  then visit http://127.0.0.1:8899' + path,
      type: 'authentication_error',
    },
  });
}

/** 面板登录页（账号密码，LOGIN_HTML 在 admin.ts）。无会话时页面请求返回它。 */
function sendLoginPage(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(LOGIN_HTML);
}

/**
 * GET /__admin/api/requests：详细请求分页。
 *
 * 契约：`?page=1&pageSize=20&q=<关键词>` → `{ok:true, data:{items, total, page, pageSize}}`。
 * pageSize 上限 100（超限 clamp）；page 下限 1。items 按 at 倒序，排除探活。
 * q 为可选：对 path/status/model/client/ua/ip/error 做不区分大小写的包含过滤
 * （LIKE 参数化，通配符已转义）。空串等价于不过滤。
 * 错误响应沿用现有形状（{error:{message,type}}）：db 不可用/查询失败 → 503。
 * 鉴权：路由处先过 isAdminRequest，再过 adminOriginAllowed（读也防跨站）。
 */
/**
 * GET /__admin/api/audit：管理面操作审计（谁 · 何时 · 做了什么）。
 *
 * 契约：`?limit=N`（默认 50，上限 200）→ `{ok:true, data:{items:[{at, op,
 * accountId, accountName, ok, note, ip}]}}`。items 按 at 倒序。
 * 数据源是 admin_audit 表（insertAdminAudit 的脱敏摘要：只存 op/accountId/
 * ok/note/ip，金额与 cookie 从不落库）。db 不可用/查询失败 → 503。
 * 鉴权：路由处先过 isAdminRequest，再过 adminOriginAllowed（管理面信息，读也防跨站）。
 */
async function handleAuditRoute(req: IncomingMessage, res: ServerResponse, db: UsageDb): Promise<void> {
  let limit = 50;
  const qs = (req.url ?? '').split('?')[1];
  if (qs) {
    try {
      const params = new URLSearchParams(qs);
      const rawLimit = Number.parseInt(params.get('limit') ?? '', 10);
      if (Number.isFinite(rawLimit) && rawLimit >= 1) limit = Math.min(200, Math.floor(rawLimit));
    } catch {
      // 畸形 query 不解析，走默认。
    }
  }
  const items = db.listAdminAudit(limit);
  if (items == null) {
    sendJson(res, 503, {
      error: { message: db.enabled ? 'usage db query failed' : `usage db unavailable: ${db.disabledReason ?? 'unknown'}`, type: 'server_error' },
    });
    return;
  }
  sendJson(res, 200, { ok: true, data: { items, limit } });
}

async function handleRequestsRoute(req: IncomingMessage, res: ServerResponse, db: UsageDb): Promise<void> {
  let page = 1;
  let pageSize = 20;
  let q: string | undefined;
  let filter: 'important' | 'all' = 'important';
  const qs = (req.url ?? '').split('?')[1];
  if (qs) {
    try {
      const params = new URLSearchParams(qs);
      const rawPage = Number.parseInt(params.get('page') ?? '', 10);
      const rawSize = Number.parseInt(params.get('pageSize') ?? '', 10);
      if (Number.isFinite(rawPage) && rawPage >= 1) page = Math.floor(rawPage);
      if (Number.isFinite(rawSize) && rawSize >= 1) pageSize = Math.min(100, Math.floor(rawSize));
      const rawQ = params.get('q');
      if (rawQ != null && rawQ.trim() !== '') q = rawQ.slice(0, 200);
      const rawFilter = params.get('filter');
      if (rawFilter === 'all') filter = 'all';
    } catch {
      // 畸形 query 不解析，走默认分页。
    }
  }
  const result = db.listRequests(page, pageSize, q, filter);
  if (result == null) {
    sendJson(res, 503, {
      error: { message: db.enabled ? 'usage db query failed' : `usage db unavailable: ${db.disabledReason ?? 'unknown'}`, type: 'server_error' },
    });
    return;
  }
  sendJson(res, 200, { ok: true, data: { items: result.items, total: result.total, page, pageSize, q: q ?? null, filter } });
}

/**
 * GET /__admin/api/requests/stats-by-ip：按调用方 IP 聚合的用量统计。
 *
 * 契约：`?page=1&pageSize=20` → `{ok:true, data:{items:[{ip, requests, inputTokens,
 * outputTokens, clients[], lastAt}], total, page, pageSize}}`。按 requests 倒序；
 * total 是不同 IP 的数量（排除探活、排除未落 ip 的旧数据）。pageSize 上限 100。
 */
async function handleStatsByIpRoute(req: IncomingMessage, res: ServerResponse, db: UsageDb): Promise<void> {
  let page = 1;
  let pageSize = 20;
  const qs = (req.url ?? '').split('?')[1];
  if (qs) {
    try {
      const params = new URLSearchParams(qs);
      const rawPage = Number.parseInt(params.get('page') ?? '', 10);
      const rawSize = Number.parseInt(params.get('pageSize') ?? '', 10);
      if (Number.isFinite(rawPage) && rawPage >= 1) page = Math.floor(rawPage);
      if (Number.isFinite(rawSize) && rawSize >= 1) pageSize = Math.min(100, Math.floor(rawSize));
    } catch {
      // 畸形 query 不解析，走默认分页。
    }
  }
  const result = db.statsByIp(page, pageSize);
  if (result == null) {
    sendJson(res, 503, {
      error: { message: db.enabled ? 'usage db query failed' : `usage db unavailable: ${db.disabledReason ?? 'unknown'}`, type: 'server_error' },
    });
    return;
  }
  sendJson(res, 200, { ok: true, data: { items: result.items, total: result.total, page, pageSize } });
}

/**
 * GET /__admin/api/overview/trend：总览卡组的**真实历史趋势**。
 *
 * 契约：`?range=24h|Nd`（缺省 7，1-90）→ `{ok:true, data:{rangeDays, bucket,
 * since, until, requests, ok, failed, inputTokens, outputTokens, costMicroCents,
 * items:[{at, requests, ok, failed, inputTokens, outputTokens, costMicroCents}]}}`。
 * items 是连续序列（无请求的桶补 0）；顶层 totals 与 items 求和一致（面板统计卡
 * 直接读）。与 history() 同口径：排除探活（probe 是维护动作，不是用户请求）。
 * range 非法 → 400；db 不可用/查询失败 → 503。
 * 鉴权：路由处先过 isAdminRequest，再过 adminOriginAllowed（用量是财务级信息，读也防跨站）。
 */
async function handleOverviewTrend(req: IncomingMessage, res: ServerResponse, db: UsageDb): Promise<void> {
  const qs = (req.url ?? '').split('?')[1] ?? '';
  const rangeDays = parseRangeDays(qs);
  if (rangeDays == null) {
    sendJson(res, 400, {
      error: { message: 'range must look like 24h or 7d (1-90 days)', type: 'invalid_request_error' },
    });
    return;
  }
  const data = db.usageTrend(rangeDays);
  if (data == null) {
    sendJson(res, 503, {
      error: { message: db.enabled ? 'usage db query failed' : `usage db unavailable: ${db.disabledReason ?? 'unknown'}`, type: 'server_error' },
    });
    return;
  }
  sendJson(res, 200, { ok: true, data });
}

// ---------------------------------------------------------------------------
// 设置页热配置端点（GET/PATCH /__admin/api/settings）
// ---------------------------------------------------------------------------
//
// 契约（与批次 2 面板约定）：
// - 都已过 isAdminRequest；**GET/PATCH 都过 adminOriginAllowed**（读也防跨站，
//   与 tokens 读端点同口径 —— 账号状态/密钥掩码是管理面信息）。
// - GET：`{ok:true, data:{settings: {<key>: {value, default, source}}}}`。
//   value = 当前生效值（cfg，PATCH/启动应用后即真值）；default = env 默认
//   （SETTINGS_META，与 config.ts 对齐）；source = 'env' | 'db'（settings 表
//   里有该键即 'db'）。
//   **隐私口径**：adminPass 的 value/default 恒为 ''（活密码与默认密码都不
//   回显）；顶层 `adminPassIsDefault` 精确给出「当前生效密码是否等于默认值」
//   （面板据此显示「建议修改默认密码」的强提示，比按 source 推断准确 ——
//   source='env' 也可能是 env 显式设了强密码）。apiKeys 的 value 是掩码数组
//   （`****XXXX` 末 4 位，keyFingerprint 同款），明文只在 PATCH 请求体由管理端
//   自己提供。
// - PATCH：body 是部分更新对象 `{<key>: value, ...}`（一次可改多键）。
//   未知键/类型错/值越界 → 400 {error:{message,type}}；db 不可用或写入失败
//   → 503。多键写入走**单事务**（全成或全败，绝不部分落库），成功后再
//   applySettingsToConfig 原地改 cfg（apiKeys 是数组引用替换，verifyAuth
//   下次读取即生效）→ 审计 op=settings.update → 200 全量 settings。
// - 已知取舍：
//   1. 改 adminPass 会让**已签发会话立即失效**（签名编入密码版本
//      sha256(adminPass)，applySettingsToConfig 改 cfg.adminPass 后旧签名
//      对不上）——无需黑名单枚举。
//   2. PATCH apiKeys 是**替换**语义：管理端若把自己当前用的 key 从列表移除，
//      API key 鉴权会立即失效（fallback 是会话 cookie / 本机直连）。

/** settings 写操作请求体上限（值都很小，宽松防滥用）。 */
const LOGIN_BODY_MAX_BYTES = 64 * 1024;
const SETTINGS_BODY_MAX_BYTES = 64 * 1024;

/** 从 cfg 取某个可热改字段的当前值（SETTINGS_META 的键 → AppConfig 字段）。 */
function currentSettingValue(cfg: AppConfig, key: string): unknown {
  switch (key) {
    case 'adminUser':
      return cfg.adminUser;
    case 'adminPass':
      return cfg.adminPass;
    case 'apiKeys':
      return cfg.apiKeys;
    case 'scaleClientTokens':
      return cfg.scaleClientTokens;
    case 'clientTokenScale':
      return cfg.clientTokenScale;
    case 'compactEnabled':
      return cfg.compactEnabled;
    case 'compactTriggerBytes':
      return cfg.compactTriggerBytes;
    case 'compactMaxMessageChars':
      return cfg.compactMaxMessageChars;
    default:
      return undefined;
  }
}

/**
 * 组装 settings 全量视图（GET/PATCH 响应共用；stored 决定 source 标记）。
 *
 * **隐私口径（与「key 星号挡住」同级别）**：
 * - adminPass 的 value 与 default 都恒为 '' —— 活密码与默认密码都不回显，
 *   source 才有意义（'env' = 用默认密码，面板提示「建议修改」；'db' = 已热改）。
 * - apiKeys 的 value 是掩码数组（`****XXXX` 末 4 位，keyFingerprint 同款）——
 *   面板能看出「生效了几个、长什么样」，但拿不到明文。明文只在 PATCH 请求体
 *   里由管理端自己提供。
 */
function settingsView(
  cfg: AppConfig,
  stored: Record<string, string>,
): Record<string, { value: unknown; default: unknown; source: 'env' | 'db' }> {
  const out: Record<string, { value: unknown; default: unknown; source: 'env' | 'db' }> = {};
  for (const key of Object.keys(SETTINGS_META)) {
    const meta = SETTINGS_META[key]!;
    if (key === 'adminPass') {
      out[key] = { value: '', default: '', source: stored[key] != null ? 'db' : 'env' };
      continue;
    }
    const current = currentSettingValue(cfg, key);
    out[key] = {
      value: key === 'apiKeys' ? (current as string[]).map((k) => keyFingerprint(k)) : current,
      default: meta.default,
      source: stored[key] != null ? 'db' : 'env',
    };
  }
  return out;
}

/** GET /__admin/api/settings/keys/:index/plain：返回单个 API key 明文（管理鉴权 +
 *  Origin）——设置页「复制明文」用。index 是当前 apiKeys 数组下标；越界 404。
 *  明文只出现在这个响应（管理员显式请求），不进列表/审计。 */
async function handleRevealApiKey(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { cfg: AppConfig },
): Promise<void> {
  if (!adminOriginAllowed(req)) {
    sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
    return;
  }
  const rest = (req.url ?? '').split('?')[0] ?? '';
  const m = /^\/__admin\/api\/settings\/keys\/(\d+)\/plain$/.exec(rest);
  if (!m) {
    sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
    return;
  }
  const idx = Number(m[1]);
  const keys = deps.cfg.apiKeys ?? [];
  if (!(idx >= 0 && idx < keys.length)) {
    sendJson(res, 404, { error: { message: 'key index out of range', type: 'invalid_request_error' } });
    return;
  }
  sendJson(res, 200, { ok: true, data: { key: keys[idx] } });
}

/** GET /__admin/api/settings：只读视图。db 不可用也 200（全部 source=env）。
 *  读端点也过 Origin 校验（读也防跨站 —— 这里含账号状态/密钥掩码，
 *  与 tokens 读端点同口径）。 */
async function handleGetSettings(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { cfg: AppConfig; db: UsageDb | null },
): Promise<void> {
  if (!adminOriginAllowed(req)) {
    sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
    return;
  }
  const stored = new SettingsStore(deps.db).all();
  sendJson(res, 200, {
    ok: true,
    data: {
      settings: settingsView(deps.cfg, stored),
      adminPassIsDefault: deps.cfg.adminPass === DEFAULT_ADMIN_PASS,
    },
  });
}

/**
 * PATCH /__admin/api/settings：热改配置。
 * 失败语义：未知键/类型错/值越界 400；db 不可用 503（写操作要真相，
 * 落不了库就不改内存 —— 否则重启后配置回滚，面板与运行态不一致）。
 */
async function handlePatchSettings(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { cfg: AppConfig; db: UsageDb | null },
): Promise<void> {
  if (!adminOriginAllowed(req)) {
    sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
    return;
  }
  const db = deps.db;
  if (db == null || !db.enabled) {
    const reason = db == null ? 'usage db not wired' : `usage db unavailable: ${db.disabledReason ?? 'unknown'}`;
    sendJson(res, 503, { error: { message: reason, type: 'server_error' } });
    return;
  }
  const read = await readBody(req, SETTINGS_BODY_MAX_BYTES);
  if (!read.ok) {
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    sendJson(res, 400, badBodyError(parsed.empty));
    return;
  }
  const body = parsed.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: { message: 'request body must be a JSON object', type: 'invalid_request_error' } });
    return;
  }
  // 全部键先校验（一次性失败，不半途落库），再事务写入（setMany 全成或全败）——
  // 部分写失败会让 db 与内存分叉：一次「失败」的 PATCH 静默改变重启后的配置。
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const v = validateSetting(key, value);
    if (!v.ok) {
      sendJson(res, 400, { error: { message: v.error, type: 'invalid_request_error' } });
      return;
    }
    values[key] = v.value;
  }
  const store = new SettingsStore(db);
  const serialized: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    serialized[key] = JSON.stringify(value);
  }
  if (!store.setMany(serialized)) {
    sendJson(res, 503, { error: { message: 'failed to persist setting', type: 'server_error' } });
    return;
  }
  // 落库成功再改内存：apiKeys 引用替换，verifyAuth 下次读取即生效（无需重启）。
  applySettingsToConfig(deps.cfg, values);
  db.insertAdminAudit({
    at: Date.now(),
    op: 'settings.update',
    accountId: null,
    ok: true,
    note: Object.keys(values).join(','),
    ip: clientIpOf(req),
  });
  sendJson(res, 200, {
    ok: true,
    data: {
      settings: settingsView(deps.cfg, store.all()),
      adminPassIsDefault: deps.cfg.adminPass === DEFAULT_ADMIN_PASS,
    },
  });
}

// ---------------------------------------------------------------------------
// 分发密钥端点（GET/POST /__admin/api/tokens、PATCH/DELETE /__admin/api/tokens/:id、
// GET /__admin/api/tokens/stats）
// ---------------------------------------------------------------------------
//
// 契约（与批次 2 面板约定）：
// - 都已过 isAdminRequest；**读端点也过 Origin 校验**（读也防跨站，与
//   requests/stats-by-ip 同口径 —— 用量是财务/设备级信息）。
// - GET /tokens：`{ok:true, data:{items:[{id, name, fingerprint, mask, status,
//   note, rpmLimit, createdAt, usage:{requests, inputTokens, outputTokens, costMicroCents}}]}}`。
//   usage 按 token_fp 聚合（含已删除 token 的历史不归任何现有 token）。
// - POST /tokens：body `{name, note?}` → 200 `{ok:true, data:{id, name, token,
//   fingerprint}}`。**token 明文只在这个响应出现一次**，此后任何接口都拿不回。
// - PATCH /tokens/:id：body `{name?/status?/note?/rpmLimit?}`（至少一个字段）→ 200 该行；
//   id 不存在 404。status 只认 active/disabled；rpmLimit 非负整数（0 = 不限流）。
// - DELETE /tokens/:id：幂等 200（删除不存在的行也成功，与 deleteAccount 同口径）。
// - GET /tokens/stats：`{ok:true, data:{items:[{fingerprint, requests,
//   inputTokens, outputTokens, costMicroCents}]}}`（纯聚合，含已删除 token 历史）。
// - 费用口径：requests.cost_micro_cents（上游 opencode 记账，1e8 microCents = $1），
//   **不自己定价**。
// - 审计：token.create / token.update / token.delete 落 admin_audit。

/** token 字段校验上限（name ≤100、note ≤200，与 model-alias 对齐）。 */
const TOKEN_NAME_MAX = 100;
const TOKEN_NOTE_MAX = 200;
/** rpmLimit 上限：1,000,000/min 是现实流量到不了的量级，纯防御。 */
const TOKEN_RPM_MAX = 1_000_000;

/** tokens 写操作请求体上限。 */
const TOKENS_BODY_MAX_BYTES = 64 * 1024;

/** PATCH body 里出现过的字段名（审计 note 用）。 */
type TokenPatchInput = {
  name?: string;
  status?: 'active' | 'disabled';
  note?: string | null;
  rpmLimit?: number;
  tokenPlain?: string | null;
};

/** tokens 数据面不可用（未接线 / db 挂）的统一 503。 */
function tokensUnavailable(deps: { db: UsageDb | null; tokens: TokensStore | null }): string {
  if (deps.tokens == null) return 'tokens module not wired';
  if (deps.db == null || !deps.db.enabled) return `usage db unavailable: ${deps.db?.disabledReason ?? 'unknown'}`;
  return 'tokens unavailable';
}

/** 校验 token 的 name/status/note 字段（PATCH 用，undefined = 不动）。 */
function validateTokenPatch(body: Record<string, unknown>): { ok: true; patch: TokenPatchInput } | { ok: false; error: string } {
  const patch: TokenPatchInput = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return { ok: false, error: 'name must be a string' };
    const name = body.name.trim();
    if (name.length === 0 || name.length > TOKEN_NAME_MAX) {
      return { ok: false, error: `name must be 1-${TOKEN_NAME_MAX} characters` };
    }
    patch.name = name;
  }
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'disabled') {
      return { ok: false, error: 'status must be active or disabled' };
    }
    patch.status = body.status;
  }
  if (body.note !== undefined) {
    // null = 清除备注；字符串 trim 后 ≤200 字符，空串归一 null。
    if (body.note !== null && typeof body.note !== 'string') {
      return { ok: false, error: 'note must be a string or null' };
    }
    if (typeof body.note === 'string') {
      const t = body.note.trim();
      if (t.length > TOKEN_NOTE_MAX) return { ok: false, error: `note must be at most ${TOKEN_NOTE_MAX} characters` };
      patch.note = t === '' ? null : t;
    } else {
      patch.note = null;
    }
  }
  if (body.rpmLimit !== undefined) {
    if (typeof body.rpmLimit !== 'number' || !Number.isInteger(body.rpmLimit) || body.rpmLimit < 0 || body.rpmLimit > TOKEN_RPM_MAX) {
      return { ok: false, error: `rpmLimit must be an integer 0-${TOKEN_RPM_MAX}` };
    }
    patch.rpmLimit = body.rpmLimit;
  }
  if (body.tokenPlain !== undefined) {
    // 补录明文（老 token 创建时未存）。指纹匹配校验在 handler（需要现有 fingerprint）。
    if (body.tokenPlain !== null && typeof body.tokenPlain !== 'string') {
      return { ok: false, error: 'tokenPlain must be a string or null' };
    }
    if (typeof body.tokenPlain === 'string') {
      const t = body.tokenPlain.trim();
      if (t.length === 0 || t.length > 256) return { ok: false, error: 'tokenPlain must be 1-256 characters' };
      patch.tokenPlain = t;
    } else {
      patch.tokenPlain = null;
    }
  }
  return { ok: true, patch };
}

/**
 * 分发 token 的 per-key RPM 限流检查（鉴权后、转发前）。
 *
 * 只对**分发 token** 鉴权（tokenFp 非空）生效 —— API key 是管理面/网关级
 * 凭据，没有 per-key 配置；rpm_limit<=0 = 不限流。限流是网关侧策略，**不触发
 * keypool 冷却**（429 来自上游账号才是上游故障，这里是本地配置）。
 *
 * 热路径优化：rpmLimit 是 verifyAuth 里 tokens.verify 同一次点查带回来的
 * （tokens 行同一列），这里直接用，不再为同一指纹做第二次同步点查。
 *
 * 拒绝时写 429：Anthropic messages 回 `{type:'error',error:{type:'rate_limit_error'}}`
 * （Claude Code 期望的原生错误格式），OpenAI chat 回 `{error:{type:'rate_limit_error'}}`
 * （与 errors.ts anthropicErrorToOpenAI 的出口同形）。两个都带 retry-after 头。
 * 被拒的请求不计入实际转发（不消耗上游额度）。
 *
 * 调用方在检查失败时直接 return（响应已写完）。
 */
function checkTokenRpmLimit(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  tokenFp: string | null,
  rpmLimit: number,
  limiter: RpmLimiter,
  ctx: MetricsCtx,
): boolean {
  if (tokenFp == null || rpmLimit <= 0) return true;
  const verdict = limiter.check(tokenFp, rpmLimit);
  if (verdict.allowed) return true;
  const retryAfterSec = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
  // 观测：写进 ctx.error，这条 429 会在 finally 落库（requests.error 列），
  // 面板能看出这个 token 在撞限流。不进 console（客户端死循环重试会刷屏）。
  ctx.error = `rate-limited:${path} rpm=${rpmLimit}`;
  const message = `rate limit exceeded (${rpmLimit}/min), retry in ${retryAfterSec}s`;
  const body =
    path === '/v1/messages'
      ? { type: 'error', error: { type: 'rate_limit_error', message } }
      : { error: { message, type: 'rate_limit_error' } };
  // sendJson 的 writeHead 会与已 setHeader 的头合并，先设 retry-after 再写。
  res.setHeader('retry-after', String(retryAfterSec));
  res.setHeader('connection', 'close');
  // 429 在 readBody 之前触发，请求体可能还在路上：resume 把残余 body 排空，
  // 否则未消费的 body 残留在 socket 上，被当成下一个请求解析（keep-alive 假 400）。
  // connection: close 双保险——限流响应不值得保连接。
  req.resume();
  sendJson(res, 429, body);
  return false;
}

/** GET /__admin/api/tokens：列表（每个 token 附用量统计）。 */
async function handleListTokens(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { db: UsageDb | null; tokens: TokensStore | null },
): Promise<void> {
  if (deps.tokens == null || deps.db == null || !deps.db.enabled) {
    sendJson(res, 503, { error: { message: tokensUnavailable(deps), type: 'server_error' } });
    return;
  }
  const usage = new Map(deps.tokens.usage().map((r) => [r.fingerprint, r.usage]));
  const zero = { requests: 0, inputTokens: 0, outputTokens: 0, costMicroCents: 0 };
  const items = deps.tokens.list().map((t) => ({ ...t, usage: usage.get(t.fingerprint) ?? zero }));
  sendJson(res, 200, { ok: true, data: { items } });
}

/** GET /__admin/api/tokens/stats：纯聚合（含已删除 token 的历史记录）。 */
async function handleTokenStats(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { db: UsageDb | null; tokens: TokensStore | null },
): Promise<void> {
  if (deps.tokens == null || deps.db == null || !deps.db.enabled) {
    sendJson(res, 503, { error: { message: tokensUnavailable(deps), type: 'server_error' } });
    return;
  }
  // 契约：平铺字段（fingerprint + requests/inputTokens/outputTokens/costMicroCents）。
  const items = deps.tokens.usage().map((r) => ({ fingerprint: r.fingerprint, ...r.usage }));
  sendJson(res, 200, { ok: true, data: { items } });
}

/** POST /__admin/api/tokens：创建（token 明文仅此一次）。 */
async function handleCreateToken(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { db: UsageDb | null; tokens: TokensStore | null },
): Promise<void> {
  if (deps.tokens == null || deps.db == null || !deps.db.enabled) {
    sendJson(res, 503, { error: { message: tokensUnavailable(deps), type: 'server_error' } });
    return;
  }
  const read = await readBody(req, TOKENS_BODY_MAX_BYTES);
  if (!read.ok) {
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    sendJson(res, 400, badBodyError(parsed.empty));
    return;
  }
  const body = parsed.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: { message: 'request body must be a JSON object', type: 'invalid_request_error' } });
    return;
  }
  const b = body as Record<string, unknown>;
  if (typeof b.name !== 'string') {
    sendJson(res, 400, { error: { message: 'name must be a string', type: 'invalid_request_error' } });
    return;
  }
  const name = b.name.trim();
  if (name.length === 0 || name.length > TOKEN_NAME_MAX) {
    sendJson(res, 400, { error: { message: `name must be 1-${TOKEN_NAME_MAX} characters`, type: 'invalid_request_error' } });
    return;
  }
  // 自定义 key 值（可选）：用户提供（如 sk-dwgxnbnb）——空/缺省 = 随机生成。
  let customKey: string | null = null;
  if (b.customKey != null) {
    if (typeof b.customKey !== 'string') {
      sendJson(res, 400, { error: { message: 'customKey must be a string or null', type: 'invalid_request_error' } });
      return;
    }
    const ck = b.customKey.trim();
    if (ck.length < 8 || ck.length > 256) {
      sendJson(res, 400, { error: { message: 'customKey must be 8-256 characters', type: 'invalid_request_error' } });
      return;
    }
    if (ck.includes(',')) {
      sendJson(res, 400, { error: { message: 'customKey must not contain commas', type: 'invalid_request_error' } });
      return;
    }
    customKey = ck;
  }
  let note: string | null = null;
  if (b.note != null) {
    if (typeof b.note !== 'string') {
      sendJson(res, 400, { error: { message: 'note must be a string or null', type: 'invalid_request_error' } });
      return;
    }
    const t = b.note.trim();
    if (t.length > TOKEN_NOTE_MAX) {
      sendJson(res, 400, { error: { message: `note must be at most ${TOKEN_NOTE_MAX} characters`, type: 'invalid_request_error' } });
      return;
    }
    note = t === '' ? null : t;
  }
  const r = deps.tokens.create(name, note, customKey);
  if (!r.ok) {
    deps.db.insertAdminAudit({ at: Date.now(), op: 'token.create', accountId: null, ok: false, note: name, ip: clientIpOf(req) });
    sendJson(res, 500, { error: { message: 'failed to create token', type: 'server_error' } });
    return;
  }
  deps.db.insertAdminAudit({ at: Date.now(), op: 'token.create', accountId: null, ok: true, note: name, ip: clientIpOf(req) });
  sendJson(res, 200, { ok: true, data: r.value });
}

/** PATCH /__admin/api/tokens/:id：改名 / 改状态 / 改备注。 */
async function handlePatchToken(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { db: UsageDb | null; tokens: TokensStore | null },
  id: number,
): Promise<void> {
  if (deps.tokens == null || deps.db == null || !deps.db.enabled) {
    sendJson(res, 503, { error: { message: tokensUnavailable(deps), type: 'server_error' } });
    return;
  }
  const read = await readBody(req, TOKENS_BODY_MAX_BYTES);
  if (!read.ok) {
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    sendJson(res, 400, badBodyError(parsed.empty));
    return;
  }
  const body = parsed.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: { message: 'request body must be a JSON object', type: 'invalid_request_error' } });
    return;
  }
  const checked = validateTokenPatch(body as Record<string, unknown>);
  if (!checked.ok) {
    sendJson(res, 400, { error: { message: checked.error, type: 'invalid_request_error' } });
    return;
  }
  const patch = checked.patch;
  const fields = Object.keys(patch);
  if (fields.length === 0) {
    sendJson(res, 400, { error: { message: 'no fields to update', type: 'invalid_request_error' } });
    return;
  }
  if (patch.tokenPlain != null) {
    // 补录明文必须与该 token 的指纹匹配（防把别的 key 填进这个条目）。
    const row = deps.tokens.get(id);
    if (row == null) {
      sendJson(res, 404, { error: { message: 'token not found', type: 'not_found_error' } });
      return;
    }
    if (fingerprintOf(patch.tokenPlain) !== row.fingerprint) {
      sendJson(res, 400, { error: { message: 'tokenPlain fingerprint does not match this token', type: 'invalid_request_error' } });
      return;
    }
  }
  const r = deps.tokens.update(id, patch);
  if (r === false) {
    deps.db.insertAdminAudit({ at: Date.now(), op: 'token.update', accountId: null, ok: false, note: `id=${id}`, ip: clientIpOf(req) });
    sendJson(res, 500, { error: { message: 'failed to update token', type: 'server_error' } });
    return;
  }
  if (r === 'missing') {
    deps.db.insertAdminAudit({ at: Date.now(), op: 'token.update', accountId: null, ok: false, note: `id=${id} missing`, ip: clientIpOf(req) });
    sendJson(res, 404, { error: { message: 'token not found', type: 'not_found_error' } });
    return;
  }
  deps.db.insertAdminAudit({
    at: Date.now(),
    op: 'token.update',
    accountId: null,
    ok: true,
    note: `id=${id} ${fields.join(',')}`,
    ip: clientIpOf(req),
  });
  sendJson(res, 200, { ok: true, data: deps.tokens.get(id) });
}

/** DELETE /__admin/api/tokens/:id：删除（幂等）。 */
async function handleDeleteToken(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { db: UsageDb | null; tokens: TokensStore | null },
  id: number,
): Promise<void> {
  if (deps.tokens == null || deps.db == null || !deps.db.enabled) {
    sendJson(res, 503, { error: { message: tokensUnavailable(deps), type: 'server_error' } });
    return;
  }
  // 删除前先拿名字（审计留痕）；拿不到不阻塞删除。
  const before = deps.tokens.get(id);
  if (!deps.tokens.delete(id)) {
    deps.db.insertAdminAudit({ at: Date.now(), op: 'token.delete', accountId: null, ok: false, note: `id=${id}`, ip: clientIpOf(req) });
    sendJson(res, 500, { error: { message: 'failed to delete token', type: 'server_error' } });
    return;
  }
  deps.db.insertAdminAudit({
    at: Date.now(),
    op: 'token.delete',
    accountId: null,
    ok: true,
    note: `id=${id}${before ? ` name=${before.name}` : ''}`,
    ip: clientIpOf(req),
  });
  sendJson(res, 200, { ok: true });
}

/**
 * GET /__admin/api/accounts/:id/usage-gateway：网关实际用量。
 *
 * 契约：`?rangeDays=7` → `{ok:true, data:{requests, inputTokens, outputTokens, costMicroCents}}`。
 * 归属口径：requests 表 key_fp 是脱敏指纹（`****XXXX`），legacy keys 列表的
 * masked（`sk-AOpQ...0osU`）取末 4 位，按 `key_fp LIKE '%0osU'` 匹配统计
 * （rangeDays 过滤、排除探活）。costMicroCents 来自上游记账（订阅端点恒 0）。
 *
 * **失败一律返回空数据（全零）而不是错误**：legacy 通道不可用（没接 cookie /
 * 账户失效 / 上游挂了）时，「网关实际用量」不知道归谁 —— 空数据比报错更能
 * 避免面板把「通道故障」误读成「账户有问题」。rangeDays 非法时回落默认 7 天
 * （1-90 clamp）。
 */
async function handleGatewayUsageRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LegacyDeps,
  accountId: number,
): Promise<void> {
  const empty = { requests: 0, inputTokens: 0, outputTokens: 0, costMicroCents: 0 };
  // 通道没接线 / 账户数据面不可用 / 账户不存在：没有可归属的指纹，空数据。
  if (deps.client == null || deps.store == null || !deps.store.enabled || !deps.store.get(accountId)) {
    sendJson(res, 200, { ok: true, data: { ...empty, scope: 'unavailable' } });
    return;
  }
  const ws = deps.store.legacyWorkspaceIdOf(accountId);
  if (!ws) {
    // env 等无 legacy workspace 的账号：显示「网关总用量」（池里所有 key 的请求）。
    const total = await gatewayPoolUsage(deps.db, 7);
    sendJson(res, 200, { ok: true, data: { ...total, scope: 'pool' } });
    return;
  }
  let rangeDays = 7;
  const qs = (req.url ?? '').split('?')[1];
  if (qs) {
    try {
      const params = new URLSearchParams(qs);
      const raw = Number.parseInt(params.get('rangeDays') ?? '', 10);
      if (Number.isFinite(raw) && raw >= 1) rangeDays = Math.min(90, Math.floor(raw));
    } catch {
      // 畸形 query 用默认 7 天。
    }
  }
  // legacy keys 拿 masked（`sk-AOpQ...0osU`）→ 末 4 位。失败（auth/upstream/
  // 无 cookie）也走空数据 —— 网关用量不知道归谁，但绝不是通道错误要报。
  const r = await deps.client.listKeys(accountId, deps.store.cookieOf(accountId), ws);
  if (!r.ok) {
    sendJson(res, 200, { ok: true, data: { ...empty, scope: 'legacy' } });
    return;
  }
  const tails = r.keys
    .map((k) => k.masked.slice(-4))
    .filter((t) => t.length === 4);
  // 畸形防护：masked 若变成全占位（如 `sk-XXXX...XXXX`，末 4 也是占位符），
  // LIKE 匹配不到任何真实指纹 → 静默全零。这种形态不是正常数据，记一行日志
  // 便于线上核对 keyDisplay 的真实格式（上线前 test:live 真打一次确认）。
  if (tails.length > 0 && tails.every((t) => !/[0-9a-z]/i.test(t))) {
    console.warn(`[usage-gateway] account=${accountId} legacy masked 末 4 位全是占位符，可能匹配不到任何请求记录`);
  }
  const usage = dbAvailable(deps.db) ? deps.db.usageByKeyFingerprints(tails, Date.now() - rangeDays * 86_400_000) : empty;
  sendJson(res, 200, { ok: true, data: { ...usage, scope: 'legacy' } });
}

/** 池总用量：requests 表所有真实 key_fp（非 '-' 未归属）的请求统计。 */
async function gatewayPoolUsage(db: UsageDb | null, rangeDays: number): Promise<{ requests: number; inputTokens: number; outputTokens: number; costMicroCents: number }> {
  const zero = { requests: 0, inputTokens: 0, outputTokens: 0, costMicroCents: 0 };
  if (db == null || !db.enabled) return zero;
  try {
    const since = Date.now() - rangeDays * 86_400_000;
    const rows = db
      .sqlite()
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS it, COALESCE(SUM(output_tokens),0) AS ot, COALESCE(SUM(cost_micro_cents),0) AS cm
         FROM requests WHERE at >= ? AND endpoint != 'probe' AND key_fp != '-' AND key_fp != ''`,
      )
      .get(since) as { n: number; it: number; ot: number; cm: number };
    return { requests: Number(rows.n), inputTokens: Number(rows.it), outputTokens: Number(rows.ot), costMicroCents: Number(rows.cm) };
  } catch {
    return zero;
  }
}

/** db 可用的简写（UsageDb 构造永不抛，enabled 才是真相）。 */
function dbAvailable(db: UsageDb | null): db is UsageDb {
  return db != null && db.enabled;
}

/**
 * PUT /__admin/api/model-aliases/:alias：更新一条映射（不存在的 alias 404）。
 *
 * 契约：body `{target, note?}` → 200 `{aliases:[...]}`（全量列表，与 POST/DELETE
 * 同形状）。与 POST 的区别：只更新已存在的映射，不隐式创建。落库成功后再原地改
 * cfg.modelMap —— resolveModelName 每次读的是同一个对象引用，立即生效。
 * 校验规则与 admin.ts 的 validateModelAlias 对齐（target ≤100、note ≤200 空串归一
 * null、alias 走路径 1-100 字母数字 ._-）。写操作先过 adminOriginAllowed。
 */
async function handlePutModelAlias(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { cfg: AppConfig; db: UsageDb | null },
  raw: string,
): Promise<void> {
  if (!adminOriginAllowed(req)) {
    sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
    return;
  }
  const db = deps.db;
  if (db == null || !db.enabled) {
    const reason = db == null ? 'usage db not wired' : `usage db unavailable: ${db.disabledReason ?? 'unknown'}`;
    sendJson(res, 503, { error: { message: reason, type: 'server_error' } });
    return;
  }
  let alias: string;
  try {
    alias = decodeURIComponent(raw);
  } catch {
    sendJson(res, 400, { error: { message: 'invalid alias encoding', type: 'invalid_request_error' } });
    return;
  }
  if (alias.length === 0 || alias.length > 100 || !/^[A-Za-z0-9._-]+$/.test(alias)) {
    sendJson(res, 400, { error: { message: 'alias must be 1-100 characters of letters, digits, dot, dash or underscore', type: 'invalid_request_error' } });
    return;
  }
  const read = await readBody(req, CONSOLE_BODY_MAX_BYTES);
  if (!read.ok) {
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    sendJson(res, 400, badBodyError(parsed.empty));
    return;
  }
  const body = parsed.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: { message: 'request body must be a JSON object', type: 'invalid_request_error' } });
    return;
  }
  const b = body as Record<string, unknown>;
  if (typeof b.target !== 'string') {
    sendJson(res, 400, { error: { message: 'target must be a string', type: 'invalid_request_error' } });
    return;
  }
  const target = b.target.trim();
  if (target.length === 0 || target.length > 100) {
    sendJson(res, 400, { error: { message: 'target must be a non-empty string of at most 100 characters', type: 'invalid_request_error' } });
    return;
  }
  let note: string | null = null;
  if (b.note != null) {
    if (typeof b.note !== 'string') {
      sendJson(res, 400, { error: { message: 'note must be a string or null', type: 'invalid_request_error' } });
      return;
    }
    const t = b.note.trim();
    if (t.length > 200) {
      sendJson(res, 400, { error: { message: 'note must be at most 200 characters', type: 'invalid_request_error' } });
      return;
    }
    note = t === '' ? null : t;
  }
  const r = updateModelAlias(db, alias, target, note);
  if (r === false) {
    db.insertAdminAudit({ at: Date.now(), op: 'model-alias.update', accountId: null, ok: false, note: 'update failed', ip: clientIpOf(req) });
    sendJson(res, 500, { error: { message: 'failed to update model alias', type: 'server_error' } });
    return;
  }
  if (r === 'missing') {
    db.insertAdminAudit({ at: Date.now(), op: 'model-alias.update', accountId: null, ok: false, note: 'missing', ip: clientIpOf(req) });
    sendJson(res, 404, { error: { message: 'model alias not found', type: 'not_found_error' } });
    return;
  }
  db.insertAdminAudit({ at: Date.now(), op: 'model-alias.update', accountId: null, ok: true, note: null, ip: clientIpOf(req) });
  deps.cfg.modelMap[alias] = target;
  sendJson(res, 200, { aliases: loadModelAliases(db) });
}

/** 单次请求的指标上下文，由各 handler 逐步填充。 */
type MetricsCtx = Pick<
  RequestEvent,
  | 'protocol' | 'model' | 'upstreamModel' | 'endpoint' | 'stream'
  | 'inputTokens' | 'outputTokens' | 'thinkingTokens' | 'requestBytes'
  | 'keyFingerprint' | 'error'
  | 'rewritten' | 'stripped' | 'compressed'
> & {
  /** 上游记账的 cost（microCents；订阅端点恒 0，按量端点真实）。仅落库用。 */
  costMicroCents: number;
  /**
   * 鉴权用的分发 token 指纹（完整 sha256 前 24 hex，tokens.ts 口径）。
   * API key / 免鉴权请求为 null —— 只落库（requests.token_fp）供按 token
   * 聚合用量，不进内存指标（与 keyFingerprint 同级别，面板另有展示）。
   */
  tokenFp: string | null;
};

/**
 * 把上游错误体里的原始文案记进 ctx，供内存指标与 usagedb 落库。
 *
 * 为什么值得单独做：`ctx.error` 此前从初始化的 null 之后**从未被赋值**，
 * 于是 `requests.error` 列恒为 NULL —— 失败请求在库里只剩一个状态码。
 * 而上游那句原文（例如 `Weekly usage limit reached. Resets in 19hr 22min.`）
 * 是判断「这个 key 到底怎么了」最直接的证据，此前它既不落库、也没有任何
 * 一处 console 打它，只能靠 `key_events.cooldown_ms` 反推。
 *
 * 截断到 300 字符：上游偶尔会回很长的 HTML 错误页，没必要整页进库。
 * 只给运维看，不回给客户端（客户端拿的仍是规范化后的错误体）。
 */
function noteUpstreamError(ctx: MetricsCtx, status: number, errBody: unknown): void {
  let detail = '';
  const e = errBody as { error?: { message?: unknown; type?: unknown } } | null;
  const raw = e && e.error && typeof e.error.message === 'string' ? e.error.message : '';
  const kind = e && e.error && typeof e.error.type === 'string' ? e.error.type : '';
  if (raw) detail = kind ? `${kind}: ${raw}` : raw;
  // stripSecrets 同 keyprobe：上游 message 可能回显 Bearer sk-xxx，会进
  // requests.error 列与内存指标。
  ctx.error = stripSecrets(stripControl(`upstream ${status}${detail ? ` ${detail}` : ''}`)).slice(0, 300);
}

/**
 * key 池状态变更日志。禁用/恢复都记一行，带指纹、原因、冷却时长与池健康度。
 *
 * 为什么必须有：2026-08-09 线上出过 295 个 503（`/v1/messages` 整池被禁约 3 分钟），
 * 但当时日志里只有 access 行，禁用原因完全没有记录 —— 事后无法区分是 transient
 * 累积、auth 还是额度耗尽。池健康度打在同一行，能直接看出何时跌到 0。
 */
export function logKeyStateChange(ev: KeyStateEvent): void {
  const health = `pool=${ev.healthyCount}/${ev.poolSize}`;
  if (ev.type === 'recovered') {
    console.warn(`[keypool] recovered key=${ev.fingerprint} ${health}`);
    return;
  }
  const cooldown = ev.cooldownMs != null ? `${Math.round(ev.cooldownMs / 1000)}s` : '?';
  console.warn(`[keypool] disabled key=${ev.fingerprint} reason=${ev.kind ?? '?'} cooldown=${cooldown} ${health}`);
}

/**
 * 把状态变更同时写进日志和用量库。
 *
 * 为什么要包一层：日志只在 `journalctl` 里，重启后面板拿不到任何历史 ——
 * 「这个 key 昨天被禁过几次」这类问题此前只能翻日志。落库之后面板能直接列
 * 最近的禁用/恢复。db 不可用时 `recordKeyEvent` 是空操作，日志照旧。
 */
export function keyStateHandler(db: UsageDb): (ev: KeyStateEvent) => void {
  return (ev) => {
    logKeyStateChange(ev);
    db.recordKeyEvent({
      at: Date.now(),
      keyFingerprint: ev.fingerprint,
      type: ev.type,
      kind: ev.kind,
      cooldownMs: ev.cooldownMs,
      healthyCount: ev.healthyCount,
      poolSize: ev.poolSize,
    });
  };
}

/** 池空日志的节流窗口：整池被禁时请求会连续撞上来，不必每条都记。 */
const POOL_EMPTY_LOG_INTERVAL_MS = 10_000;
let lastPoolEmptyLogAt = 0;
let suppressedPoolEmptyCount = 0;

/**
 * 记录一次「整池被禁」。这是此前唯一完全静默的 503 路径 —— 2026-08-09 那 295 个
 * 503 就是从这里出去的，日志里却只有 access 行。
 *
 * 节流到 10s 一行，被压掉的次数累加在下一行里，避免刷屏又不丢量级信息。
 */
function logPoolEmpty(pool: KeyPool): void {
  suppressedPoolEmptyCount += 1;
  const now = Date.now();
  if (now - lastPoolEmptyLogAt < POOL_EMPTY_LOG_INTERVAL_MS) return;
  lastPoolEmptyLogAt = now;
  const disabled = pool.disabledFingerprints().join(',') || 'none';
  console.error(
    `[keypool] pool empty — all ${pool.size} keys disabled (requests rejected: ${suppressedPoolEmptyCount}, disabled: ${disabled})`,
  );
  suppressedPoolEmptyCount = 0;
}

/**
 * 池空时的统一出口。整池都是额度耗尽 → 把上游的 GoUsageLimitError 原样透传
 * （保留 type + "Resets in ..."，让 kirostudio 这类下游知道是额度问题、何时
 * 恢复）；否则回通用 503（auth/transient 禁用、或从未记录过额度错误）。
 */
function sendPoolEmpty(res: ServerResponse, pool: KeyPool): void {
  const quota = pool.quotaEmptyError;
  if (quota) {
    const err = anthropicErrorToOpenAI(quota.status, quota.body);
    sendJson(res, err.status, err.body);
    return;
  }
  sendJson(res, 503, { error: { message: 'all upstream keys are disabled', type: 'server_error' } });
}

/**
 * console 数据层（src/console.ts 的 ConsoleClient）的最小接口假设。
 * 与 admin.ts 的 BillingAccounts 同一套路：duck typing，不 import console.ts，
 * 避免两个模块互相依赖。签名对齐 src/console.ts 实际导出（读方法失败返回
 * null 而不是带 reason 的错误对象；健康态是 cookieStatus；fixture 证实余额
 * 是 microCents 字符串，见下方 microCentsToDollars）。
 */
export interface ConsoleClientLike {
  billingStatus(accountId: number): Promise<unknown | null>;
  billingAccount(id: number): Promise<unknown | null>;
  billingLedger(id: number): Promise<unknown | null>;
  autoRecharge(id: number): Promise<unknown | null>;
  paymentMethods(id: number): Promise<unknown | null>;
  usageSummary(id: number, rangeDays: number): Promise<unknown | null>;
  /** P0 数据端点（真实控制台实测，响应形状见 console.ts 各方法注释）。 */
  usageCostByDay(id: number, rangeDays: number, bucket: 'day' | 'hour'): Promise<unknown | null>;
  usageModels(id: number, rangeDays: number): Promise<unknown | null>;
  usageUsers(id: number, rangeDays: number): Promise<unknown | null>;
  budgetsUsersStatus(id: number): Promise<unknown | null>;
  modelPricing(id: number): Promise<unknown | null>;
  members(id: number, pageSize: number): Promise<unknown | null>;
  serviceAccounts(id: number, pageSize: number): Promise<unknown | null>;
  providers(id: number): Promise<unknown | null>;
  budgetsOrg(id: number): Promise<unknown | null>;
  setAutoRecharge(
    id: number,
    opts: { enabled: boolean; thresholdDollars: number; rechargeAmountDollars: number },
  ): Promise<ConsoleWriteResult>;
  setMonthlyLimit(id: number, limitDollars: number): Promise<ConsoleWriteResult>;
  createServiceAccount(id: number, name: string): Promise<ConsoleWriteResult>;
  removeServiceAccount(id: number, saId: string): Promise<ConsoleWriteResult>;
  /** 通道健康态：该账户 cookie 是否已被判定失效（内存态，与本次调用无关）。 */
  cookieStatus(id: number): 'ok' | 'invalid';
  /** 失效凭据所在通道（'cookie' | 'oauth'）——面板区分恢复指引（更新 cookie
   *  还是重新 OAuth 授权）；未失效 → null。 */
  authChannel(id: number): 'cookie' | 'oauth' | null;
  /** 最近一次调用失败原因（区分「合法 null 响应」与「真实失败」，budgets 用）。 */
  lastError(id: number): 'auth' | 'upstream' | 'no-cred' | null;
  /** 凭据更新后重置健康态（新 cookie/重新登录——防旧 invalid 标记死锁）。 */
  noteCredentialChanged(id: number): void;
}

/** ConsoleClient 写方法的统一返回（形状对齐 src/console.ts 的 ConsoleWriteResult）。 */
export type ConsoleWriteResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: 'auth' | 'no-cookie' | 'no-workspace' | 'upstream' | 'parse' };

export function createApp(
  cfg: AppConfig,
  pool?: KeyPool,
  usageDb?: UsageDb,
  accounts?: AccountsStore | null,
  adminFetch?: FetchLike,
  consoleClient?: ConsoleClientLike,
  importCookie?: CookieImportLike,
  legacyClient?: LegacyClientLike,
  tokensStore?: TokensStore | null,
  legacyPlainCache?: LegacyPlainCacheLike,
) {
  // 用量库：未显式传时按配置建。构造永不抛，不可用就退化成 no-op（面板无累计列）。
  const db = usageDb ?? new UsageDb(cfg.usageDbPath, cfg.usageDbRetentionDays);
  // 设置页热配置层：未接线（null）时 settings 端点 503、PATCH 不生效。
  // 启动合并（settings 覆盖 env 默认）由调用方（main.ts）在 createApp 之前做；
  // 这里只持有 store 供 GET/PATCH 端点读 db（source 判定 + 写入）。
  const settingsStore = new SettingsStore(db);
  // 分发 token 校验器：未接线（null）时 verifyAuth 跳过分发 token（fail-closed）。
  // 管理面鉴权（isAdminRequest）刻意不传它 —— 分发 token 只用于客户端数据面。
  const tokens = tokensStore ?? null;
  // per-key RPM 限流器（内存滑动窗口）。每 app 一个实例：测试用例独立 app
  // 即独立窗口，不跨用例串计数。数据面入口 check，见 checkTokenRpmLimit。
  const rpmLimiter = new RpmLimiter();
  // 后台设置页维护的模型映射（存 usage db）：启动时合并进 cfg.modelMap。
  // resolveModelName 每次读的都是这个 cfg.modelMap 对象引用，运行时新增/删除
  // 映射时 API 侧原地改它即全局生效，无需重启。db 不可用时返回空，不动 cfg。
  for (const m of loadModelAliases(db)) {
    cfg.modelMap[m.alias] = m.target;
  }
  // 管理面数据层：未接线（main.ts 下一轮接）时 /__metrics 不含 accounts 段，
  // /__admin 页面照常渲染但显示 degraded。管理面是观测设施，绝不阻塞代理链路。
  const store = accounts ?? null;
  // billing 抓取的 fetch 注入点（测试用 fake；生产走默认全局 fetch）。
  // OAuth device flow 复用同一个注入点（任务契约：沿用 adminFetch 参数）。
  const adminFetchImpl = adminFetch;
  // console 数据层注入点（ConsoleClientLike，src/console.ts 的 ConsoleClient）。
  // 未传时 console 端点返回 502 channel_error —— 观测设施，不阻塞代理链路。
  const consoleClientImpl = consoleClient;
  // cookie 导入注入点（cookie.ts 的 importCookieFromChrome）。未传时
  // import-cookie 端点 502。cookie 值只在进程内流转，绝不进响应与日志。
  const importCookieImpl = importCookie;
  // 旧版控制台（opencode.ai）key 通道注入点（LegacyClientLike，src/legacy.ts
  // 的纯函数适配）。未传时 legacy 端点返回 502 channel_error —— 观测设施，
  // 不阻塞代理链路。
  const legacyClientImpl = legacyClient;
  // keys 明文的内存缓存（/keys/plain 端点专用）。main.ts 的 legacyClient 适配器
  // 在每次成功抓取后填充；未接线（undefined）时 /keys/plain fail-closed 502。
  const legacyPlainCacheImpl = legacyPlainCache;
  // OAuth device flow 会话（内存 Map，每 app 一个；start 存、poll 取、过期清理）。
  const oauthManager = new OauthManager();
  // 未显式传 pool 时，用 cfg.upstreamKeys 建默认池（兼容测试直连场景）。
  const keyPool =
    pool ??
    new KeyPool(cfg.upstreamKeys, {
      cooldownMs: cfg.keyCooldownMs,
      failThreshold: cfg.keyFailThreshold,
      onStateChange: keyStateHandler(db),
    });

  // 后台拉一次上游模型清单，失败不影响服务启动。
  void fetchUpstreamModels(cfg, keyPool).then((models) => {
    if (models?.length) {
      upstreamModels = new Set(models);
      console.log(`[proxy] upstream models: ${models.length}`);
    }
  });

  return createServer(async (req, res) => {
    const startTime = Date.now();
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';
    // 浏览器自动请求的静态资源：直接 404，不鉴权不记录 —— 否则 favicon 等
    // 401 把面板的「最近请求」刷屏（实测 /__metrics events 被 favicon 占满）。
    if (STATIC_ASSET_PATHS.has(path)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    // handler 边跑边往这里填，finally 统一记一条指标事件。
    const ctx: MetricsCtx = {
      protocol: path === '/v1/messages' || path.startsWith('/v1/messages/') ? 'anthropic'
        : path === '/v1/chat/completions' ? 'openai' : 'other',
      model: '',
      upstreamModel: '',
      endpoint: '-',
      stream: false,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      requestBytes: 0,
      keyFingerprint: '',
      error: null,
      costMicroCents: 0,
      tokenFp: null,
      rewritten: 0,
      stripped: 0,
      compressed: 0,
    };

    try {
      // 健康检查不需要鉴权。
      if (req.method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // 监控面板：公开访问，无需鉴权（用户明确要求 HTML 公开）。
      //
      // 注意这意味着**任何人都能看到全部调用方的 IP、完整 UA、转发链**。
      // 这是刻意的选择，不是漏配。想收回去就把 DASHBOARD_PUBLIC 设成 0，
      // 那时会退回「本机直连免 key、其余要 key」的行为。
      if (req.method === 'GET' && (path === '/__dash' || path === '/__metrics')) {
        if (!cfg.dashboardPublic && !(cfg.dashboardOpen && isDirectLocalRequest(req))) {
          // 面板登录会话 cookie 也放行（浏览器登录后可免 API key 访问监控面板）。
          if (!adminSessionValid(req, cfg)) {
            const auth = verifyAuth(cfg, req.headers as Record<string, string | undefined>);
            if (!auth.ok) {
              // 页面请求 → 登录页；API 请求 → 401 JSON。
              if (path === '/__dash') {
                sendLoginPage(res);
                return;
              }
              sendPanelAuthRequired(res, cfg, path);
              return;
            }
          }
        }
        if (path === '/__metrics') {
          const snap = snapshot();
          // 管理鉴权（本机免 key 或带 key）通过才给管理面专属字段，同一判定用
          // 一次、两处保持一致：accounts 段 + pool.keys 的 accountId（账户归属
          // 是管理面内部信息）。公网匿名模式两者都不给 —— 公网响应不含任何
          // 管理面字段（MULTI-ACCOUNT.md §6.1）。
          const adminOk = isAdminRequest(req, cfg);
          // 隐私（m12）：公网匿名响应剥掉 device.ip（调用方 IP 不该公网可见）。
          // events 元素是环形缓冲的共享引用，剥字段必须复制对象，不能原地改。
          // 管理鉴权请求保留完整 device（管理面板按 IP 统计要它）。
          const events = adminOk
            ? snap.events
            : snap.events.map((e) => {
                const { ip: _ip, ...device } = e.device;
                return { ...e, device };
              });
          // 改写/剥除计数是管理面观测字段，与 accounts 段同门槛：公网匿名
          // 响应不给。用 rest 丢弃键而非置 undefined，响应里键完全缺席。
          let summary = snap.summary;
          if (!adminOk) {
            const { rewritten: _rewritten, stripped: _stripped, compressed: _compressed, ...rest } = snap.summary;
            // rest 缺三个计数键（公网匿名不给），类型上补回结构即可。
            summary = rest as typeof snap.summary;
          }
          const adminAccounts =
            store != null && adminOk
              ? buildAccountsSection(store, keyPool, Date.now())
              : null;
          const rawKeys = keyPool.snapshot();
          // 后台 key 备注（昵称）：前台 Key 池显示昵称代替裸指纹。昵称来自
          // fingerprint → nickname 映射，不含明文 key；公网匿名也发 —— 备注
          // 是用户自选对外展示的信息，与 accountId（账户归属）不同级别。
          // 未接线管理面（store 为 null）时统一补 null，面板直接读字段即可。
          const nicknames = new Map<string, string | null>();
          if (store != null && store.enabled) {
            for (const acc of store.list()) {
              for (const [fp, nick] of store.keyNicknameMap(acc.id)) {
                nicknames.set(fp, nick);
              }
            }
          }
          const poolKeys = (adminOk ? rawKeys : rawKeys.map(({ accountId: _accountId, ...rest }) => rest))
            .map((k) => ({ ...k, nickname: nicknames.get(k.fingerprint) ?? null }));
          sendJson(res, 200, {
            ...snap,
            events,
            summary,
            ...(adminAccounts != null ? { accounts: adminAccounts } : {}),
            pool: {
              size: keyPool.size,
              healthy: keyPool.healthyCount,
              disabled: keyPool.disabledFingerprints(),
              // 逐 key 明细：在飞请求数（= 几个号在扛并发）、禁用原因、剩余冷却。
              keys: poolKeys,
              // 冷却策略本身：让面板能解释「为什么是这个恢复时刻」，
              // 而不是只给一个数字让人回去读源码。
              policy: keyPool.policy(),
              // 跨重启累计。db 不可用时为 null，面板据此隐藏累计列。
              history: db.history(),
              historyDisabledReason: db.enabled ? null : db.disabledReason,
            },
            config: {
              subscriptionBaseUrl: cfg.anthropicBaseUrl,
              paygBaseUrl: cfg.payAsYouGoBaseUrl,
              fallbackModel: cfg.fallbackModel,
              injectionMode: cfg.injectionMode,
              // 别名清单已配置化（env MODEL_MAP + db model_aliases 合并后的
              // cfg.modelMap）：展示当前生效的映射，白名单模型跟在后面。
              upstreamModels: [...Object.keys(cfg.modelMap), ...ALLOWED_MODELS],
              aliases: { ...cfg.modelMap },
            },
          });
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(DASHBOARD_HTML);
        return;
      }

      // 管理面板：页面前置、先鉴权再分派（MULTI-ACCOUNT.md §6.1/§6.3）。
      // 必须过 isAdminRequest —— DASHBOARD_PUBLIC 公网模式也不豁免（面板管理
      // 账户凭据）。业务分派（页面/查询/写操作 + Origin 校验）全在 admin.ts。
      if (path === '/__admin' || path.startsWith('/__admin/')) {
        // 登录/登出端点：无需会话（登录本身就是拿会话），但仍过限速。
        if (path === '/__admin/api/login') {
          if (req.method !== 'POST') {
            sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
            return;
          }
          await handleAdminLogin(req, res, cfg, db);
          return;
        }
        if (path === '/__admin/api/logout') {
          if (req.method !== 'POST') {
            sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
            return;
          }
          handleAdminLogout(req, res, db);
          return;
        }
        // 页面请求（非 /api/*）：无鉴权 → 返回登录页（浏览器无 cookie 时）。
        // 数据端点保持 401 JSON —— 前端带会话 cookie 后自动通过。
        // /__admin 与 /__admin/ 等价：带斜杠的直达也回登录页，而不是 401 JSON
        // （浏览器地址栏手敲斜杠、表单 action 误带尾斜杠都会命中后者）。
        if ((path === '/__admin' || path === '/__admin/') && !adminSessionValid(req, cfg) && !isAdminRequest(req, cfg)) {
          sendLoginPage(res);
          return;
        }
        if (!isAdminRequest(req, cfg)) {
          sendPanelAuthRequired(res, cfg, path);
          return;
        }
        // OAuth device flow 端点（任务契约：放 /__admin 路由块内，独立于
        // admin.ts 的账户 CRUD 分派）。写操作：Origin 校验与 admin.ts 同款。
        if (path === '/__admin/api/oauth/start' || path === '/__admin/api/oauth/poll') {
          if (req.method !== 'POST') {
            sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
            return;
          }
          if (path === '/__admin/api/oauth/start') {
            await handleOauthStart(req, res, cfg, oauthManager, adminFetchImpl);
          } else {
            await handleOauthPoll(req, res, cfg, oauthManager, store, adminFetchImpl);
          }
          return;
        }
        // 实验功能开关的只读端点（设置页展示用）：env 配置运行时不可改，
        // 前端只读状态 + 提示重启。GET 读端点不设 Origin 校验（与 console
        // 读端点同口径 —— 开关状态非财务/设备信息）。
        if (path === '/__admin/api/config' && req.method === 'GET') {
          sendJson(res, 200, {
            ok: true,
            data: {
              experimental: {
                scaleClientTokens: cfg.scaleClientTokens,
                clientTokenScale: cfg.clientTokenScale,
                compactEnabled: cfg.compactEnabled,
                compactTriggerBytes: cfg.compactTriggerBytes,
                compactMaxMessageChars: cfg.compactMaxMessageChars,
              },
            },
          });
          return;
        }
        // 设置页热配置（本任务）：GET 只读（默认值+当前值+来源标记），PATCH 热改
        // （管理鉴权 + Origin 校验，校验/落库/apply/审计全在 handler）。写操作
        // 需 db（settings 表在 usage db 里），db 不可用 → PATCH 503、GET 降级 200。
        if (path.startsWith('/__admin/api/settings/keys/') && path.endsWith('/plain') && req.method === 'GET') {
          await handleRevealApiKey(req, res, { cfg });
          return;
        }
        if (path === '/__admin/api/settings') {
          if (req.method === 'GET') {
            await handleGetSettings(req, res, { cfg, db });
            return;
          }
          if (req.method === 'PATCH') {
            await handlePatchSettings(req, res, { cfg, db });
            return;
          }
          sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
          return;
        }
        // 分发密钥（本任务）：stats 必须在 /tokens 之前判断（子路径前缀共享）。
        // 读端点也过 Origin 校验（读也防跨站，用量是财务级信息）。
        if (path === '/__admin/api/tokens/stats') {
          if (req.method !== 'GET') {
            sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
            return;
          }
          if (!adminOriginAllowed(req)) {
            sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
            return;
          }
          await handleTokenStats(req, res, { db, tokens });
          return;
        }
        if (path === '/__admin/api/tokens') {
          if (req.method === 'GET' || req.method === 'POST') {
            if (!adminOriginAllowed(req)) {
              sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
              return;
            }
            if (req.method === 'GET') {
              await handleListTokens(req, res, { db, tokens });
            } else {
              await handleCreateToken(req, res, { db, tokens });
            }
            return;
          }
          sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
          return;
        }
        {
          const tRest = path.startsWith('/__admin/api/tokens/')
            ? path.slice('/__admin/api/tokens/'.length)
            : null;
          if (tRest != null) {
            // /plain 子路径提前处理（否则 '5/plain' 会被 parseAccountId 拒成 400）。
            if (tRest.endsWith('/plain')) {
              const pid = parseAccountId(tRest.slice(0, -'/plain'.length));
              if (pid == null) { sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } }); return; }
              if (req.method !== 'GET' || !adminOriginAllowed(req)) {
                sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
                return;
              }
              if (tokens == null || db == null || !db.enabled) {
                sendJson(res, 503, { error: { message: tokensUnavailable({ db, tokens }), type: 'server_error' } });
                return;
              }
              const plain = tokens.plainOf(pid);
              if (plain == null) {
                sendJson(res, 404, { error: { message: 'token plaintext not stored (created before plaintext storage)', type: 'not_found_error' } });
                return;
              }
              sendJson(res, 200, { ok: true, data: { id: pid, token: plain } });
              return;
            }
            const tokenId = parseAccountId(tRest);
            if (tokenId == null) {
              sendJson(res, 400, { error: { message: 'token id must be a positive integer', type: 'invalid_request_error' } });
              return;
            }
            if (req.method === 'PATCH' || req.method === 'DELETE') {
              if (!adminOriginAllowed(req)) {
                sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
                return;
              }
              if (req.method === 'PATCH') {
                await handlePatchToken(req, res, { db, tokens }, tokenId);
              } else {
                await handleDeleteToken(req, res, { db, tokens }, tokenId);
              }
              return;
            }
            sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
            return;
          }
        }
        // console 数据端点（本任务）：读端点只过 isAdminRequest；写端点在
        // handler 内做 Origin 校验（与 oauth 端点同款）。全部独立于 admin.ts
        // 的账户 CRUD 分派，prefix 不重叠。
        if (path.startsWith('/__admin/api/console/')) {
          await handleConsoleRoutes(req, res, { cfg, store, client: consoleClientImpl, importCookie: importCookieImpl, db });
          return;
        }
        // 旧版控制台（opencode.ai，wrk_ 前缀 workspace）的 key 端点。
        if (path.startsWith('/__admin/api/legacy/')) {
          await handleLegacyRoutes(req, res, { store, client: legacyClientImpl, db, plainCache: legacyPlainCacheImpl });
          return;
        }
        // 按 IP 聚合的用量统计：管理鉴权之上再加 Origin 校验（读也防跨站）。
        // 必须在 /__admin/api/requests 之前判断（子路径，前缀共享）。
        if (path === '/__admin/api/requests/stats-by-ip') {
          if (req.method !== 'GET') {
            sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
            return;
          }
          if (!adminOriginAllowed(req)) {
            sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
            return;
          }
          await handleStatsByIpRoute(req, res, db);
          return;
        }
        // 总览真实趋势（usage db 聚合，24h 按小时 / 7d 按天）：读端点，
        // 同样过 Origin 校验（用量是财务级信息，读也防跨站）。
        if (path === '/__admin/api/overview/trend') {
          if (req.method !== 'GET') {
            sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
            return;
          }
          if (!adminOriginAllowed(req)) {
            sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
            return;
          }
          await handleOverviewTrend(req, res, db);
          return;
        }
        // 网关实际用量（按该账户 legacy keys 的指纹末 4 位归属）：读端点，
        // 同样过 Origin 校验。失败（legacy 不可用等）返回空数据，不报错。
        if (path.startsWith('/__admin/api/accounts/')) {
          const accountRest = path.slice('/__admin/api/accounts/'.length);
          if (accountRest.endsWith('/usage-gateway')) {
            if (req.method !== 'GET') {
              sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
              return;
            }
            if (!adminOriginAllowed(req)) {
              sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
              return;
            }
            const idRaw = accountRest.slice(0, accountRest.length - '/usage-gateway'.length);
            const accountId = parseAccountId(idRaw);
            if (accountId == null) {
              sendJson(res, 400, { error: { message: 'account id must be a positive integer', type: 'invalid_request_error' } });
              return;
            }
            await handleGatewayUsageRoute(req, res, { store, client: legacyClientImpl, db, plainCache: legacyPlainCacheImpl }, accountId);
            return;
          }
        }
        // 模型映射 PUT（更新已存在映射）：与 POST/DELETE 同款 Origin 校验，
        // 独立于 admin.ts 分派（admin.ts 只认 POST/DELETE）。
        {
          const maPut = path.startsWith('/__admin/api/model-aliases/')
            ? path.slice('/__admin/api/model-aliases/'.length)
            : null;
          if (maPut != null && req.method === 'PUT') {
            await handlePutModelAlias(req, res, { cfg, db }, maPut);
            return;
          }
        }
        // 详细请求分页：管理鉴权之上再加 Origin 校验（读也防跨站）。
        if (path === '/__admin/api/requests') {
          if (req.method !== 'GET') {
            sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
            return;
          }
          if (!adminOriginAllowed(req)) {
            sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
            return;
          }
          await handleRequestsRoute(req, res, db);
          return;
        }
        // 操作审计（管理面写操作的脱敏留痕）：只读，同 requests 端点的门槛。
        if (path === '/__admin/api/audit') {
          if (req.method !== 'GET') {
            sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
            return;
          }
          if (!adminOriginAllowed(req)) {
            sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
            return;
          }
          await handleAuditRoute(req, res, db);
          return;
        }
        await handleAdminRoutes(req, res, { cfg, store, pool: keyPool, fetchImpl: adminFetchImpl, db, consoleClient: consoleClientImpl });
        return;
      }

      // CORS preflight：不授信任何跨域来源（不设 access-control-allow-origin），
      // 浏览器里非简单请求会因缺 ACAO 被拒；配合下方 Origin 校验兜住简单请求。
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization, x-api-key, anthropic-version',
        });
        res.end();
        return;
      }

      // CSRF：未鉴权放行模式下，浏览器跨站请求必带非空 Origin，直接拒绝。
      // 带 API key 时攻击者页面拿不到 key，天然免疫。
      if (cfg.allowUnauthenticated) {
        const origin = req.headers.origin;
        if (typeof origin === 'string' && origin.length > 0) {
          sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
          return;
        }
      }

      // 鉴权（fail-closed）。tokensStore 传入后：API_KEYS 未命中时兜底查
      // 分发 token（管理面 isAdminRequest 的 verifyAuth 调用点不传，刻意收紧）。
      const auth = verifyAuth(cfg, req.headers as Record<string, string | undefined>, tokens);
      if (!auth.ok) {
        sendJson(res, 401, { error: { message: 'unauthorized', type: 'authentication_error' } });
        return;
      }
      ctx.tokenFp = auth.tokenFp;

      if (req.method === 'POST' && path === '/v1/chat/completions') {
        if (!isJsonContentType(req.headers['content-type'])) {
          sendJson(res, 415, { error: { message: 'content-type must be application/json', type: 'invalid_request_error' } });
          return;
        }
        // 鉴权后、转发前：per-key RPM 限流（只对分发 token 生效）。
        if (!checkTokenRpmLimit(req, res, path, auth.tokenFp, auth.rpmLimit, rpmLimiter, ctx)) return;
        await handleChatCompletion(req, res, cfg, keyPool, auth.keyId, ctx);
        return;
      }

      if (req.method === 'POST' && path === '/v1/messages') {
        if (!isJsonContentType(req.headers['content-type'])) {
          sendJson(res, 415, { error: { message: 'content-type must be application/json', type: 'invalid_request_error' } });
          return;
        }
        // 鉴权后、转发前：per-key RPM 限流（只对分发 token 生效）。
        if (!checkTokenRpmLimit(req, res, path, auth.tokenFp, auth.rpmLimit, rpmLimiter, ctx)) return;
        await handleMessagesPassThrough(req, res, cfg, keyPool, auth.keyId, ctx);
        return;
      }

      // Claude Code 记账端点：本地估算（上游无此端点）。
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        if (!isJsonContentType(req.headers['content-type'])) {
          sendJson(res, 415, { error: { message: 'content-type must be application/json', type: 'invalid_request_error' } });
          return;
        }
        await handleCountTokens(req, res, cfg, ctx);
        return;
      }

      // 模型发现（OpenAI 兼容）：别名（env/db 配置的映射 key）排前面，白名单
      // 真名跟后，两种都可用 —— 与 resolveModelName 的解析面一致。
      if (req.method === 'GET' && path === '/v1/models') {
        const ids = new Set([...Object.keys(cfg.modelMap), ...ALLOWED_MODELS]);
        sendJson(res, 200, {
          object: 'list',
          data: [...ids].map((id) => ({ id, object: 'model', owned_by: 'proxy' })),
        });
        return;
      }

      sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
    } catch (err) {
      // 内部异常只进日志，回给调用方的统一固定文案（防配置/堆栈细节泄露）。
      const message = err instanceof Error ? err.message : 'internal error';
      // 记进 ctx 让它落库/进内存指标。回给客户端的仍是固定文案，
      // 这里只影响运维自己能看到的记账 —— 否则失败请求在库里只剩一个状态码，
      // 「为什么失败」得回去翻 journalctl，而那恰是这个库要消灭的动作。
      ctx.error = stripControl(message).slice(0, 300);
      console.error(`[proxy] ${stripControl(message)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: INTERNAL_SERVER_ERROR });
      } else {
        res.end();
      }
    } finally {
      const elapsed = Date.now() - startTime;
      console.log(`[proxy] ${req.method ?? '?'} ${path} ${res.statusCode} ${elapsed}ms`);
      // /healthz 与面板自身的轮询不记账，否则面板会把自己刷满。
      if (path !== '/healthz' && !path.startsWith('/__')) {
        const device = extractDevice(req);
        // 记账请求（count_tokens）只落库、不进内存指标（reviewer m7：不混进
        // 「请求数」统计 —— Claude Code 每条消息前都调一次 count_tokens，进
        // events 会把面板「最近请求」与 summary.ok 刷满）。落库的详细请求页
        // 仍可见（endpoint='count_tokens' 标记，input_tokens 是真实值）。
        if (ctx.endpoint !== 'count_tokens') {
          recordEvent({
            at: startTime,
            method: req.method ?? '?',
            path,
            protocol: ctx.protocol,
            status: res.statusCode,
            durationMs: elapsed,
            model: ctx.model,
            upstreamModel: ctx.upstreamModel,
            endpoint: ctx.endpoint,
            stream: ctx.stream,
            inputTokens: ctx.inputTokens,
            outputTokens: ctx.outputTokens,
            thinkingTokens: ctx.thinkingTokens,
            requestBytes: ctx.requestBytes,
            device,
            keyFingerprint: ctx.keyFingerprint,
            error: ctx.error,
            rewritten: ctx.rewritten,
            stripped: ctx.stripped,
            compressed: ctx.compressed,
          });
        }
        // 同一份数据落库。内存指标环形缓冲重启即清零，落库的才能回答
        // 「这个 key 这个月一共扛了多少」。IP 与上游 cost（microCents）也落库：
        // 管理鉴权后的 IP 统计与「网关实际用量」端点要用；path/ua/client 进
        // 详细请求页（管理鉴权后才可见）。
        db.recordRequest({
          at: startTime,
          keyFingerprint: ctx.keyFingerprint,
          model: ctx.model,
          upstreamModel: ctx.upstreamModel,
          endpoint: ctx.endpoint,
          status: res.statusCode,
          durationMs: elapsed,
          stream: ctx.stream,
          inputTokens: ctx.inputTokens,
          outputTokens: ctx.outputTokens,
          thinkingTokens: ctx.thinkingTokens,
          error: ctx.error,
          path,
          // UA 是客户端可控的任意串，落库前剥控制符（与 error 列同口径）——
          // 否则 ANSI 注入能进详细请求页 JSON，终端型消费者可被利用。
          ua: stripControl(device.ua),
          // 热路径优化：client 在 extractDevice 里已经解析过了，直接复用，
          // recordRequest 不再为同一 UA 二次 parseUserAgent。
          client: device.client,
          ip: clientIpOf(req),
          costMicroCents: ctx.costMicroCents,
          tokenFp: ctx.tokenFp,
        });
      }
    }
  });
}

/**
 * 判定流/body 消费失败是否源于**客户端主动断开**（而非上游问题）。
 *
 * 客户端断开 → res 触发 close → 两处挂载的 `res.on('close', () => controller.abort())`
 * 把网关侧 controller abort 掉 → 上游 fetch 的 body 读随之中止。此时
 * `controller.signal.aborted === true` 且 `res.destroyed === true`。
 *
 * 这类失败**不能上报 keypool**：Claude Code 停生成是常态，客户端取消 5 次就把
 * 健康 key 禁 5 分钟。只有 idle watchdog 掐断（上游挂死）或上游网络错误
 * （controller 未 abort）才记 transient。
 */
function isClientAbort(controller: AbortController, res: ServerResponse): boolean {
  return controller.signal.aborted && res.destroyed;
}

/**
 * 判定流/body 消费失败是否源于**网关注侧的超时**（idle watchdog / 非流式总超时）。
 *
 * `controller.signal.aborted` 有两个来源：客户端断开（res close → abort）与
 * 我们自己的定时器（idle/total/header）。客户端断开时 res 已被 destroy，所以
 * `aborted && !destroyed` 精确区分出「网关主动掐断」—— 这是「上游响应超时」，
 * 回给客户端的文案应明确说明，而不是泛化的 internal error（第十九轮口径）。
 */
function isUpstreamWatchdog(controller: AbortController, res: ServerResponse): boolean {
  return controller.signal.aborted && !res.destroyed;
}

async function handleChatCompletion(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AppConfig,
  pool: KeyPool,
  keyId: string,
  ctx: MetricsCtx,
): Promise<void> {
  const read = await readBody(req, cfg.maxBodyBytes);
  if (!read.ok) {
    // 观测：body 读取失败的原因写进 ctx.error（落库/面板可见）。
    ctx.error = `body-read-fail:${read.status}`;
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    sendJson(res, 400, badBodyError(parsed.empty));
    return;
  }

  const body = parsed.body as Record<string, unknown>;

  // L2：schema 校验。
  const v = validateChatRequest(body, cfg);
  if (!v.ok) {
    sendJson(res, 400, rejectionError(v.error).body);
    return;
  }

  const messages = body.messages as Array<{ role: string; content: unknown }>;

  // L3：注入检测（user/tool 顶层文本）。
  const hits = scanMessagesForInjection(messages);
  if (hits.length > 0) {
    for (const h of hits) {
      console.warn(`[inject] key=${keyId} msg#${h.index} level=${h.level} signals=${h.signals.join(',')}`);
    }
    if (cfg.injectionMode === 'block') {
      const high = hits.some((h) => h.level === 'high');
      if (high) {
        sendJson(res, 400, rejectionError('message content violates content policy').body);
        return;
      }
    }
  }

  // 上游本身就是 OpenAI 协议，这条路径不再绕 Anthropic：只做模型名解析、
  // 剥不支持的字段、加 system 护栏，然后原样转发。
  const upstreamReq = prepareOpenAIUpstreamRequest(body as unknown as OpenAIChatRequest, cfg);
  ctx.requestBytes = Buffer.byteLength(read.text);
  ctx.model = typeof body.model === 'string' ? body.model : '';
  ctx.upstreamModel = typeof upstreamReq.model === 'string' ? upstreamReq.model : '';
  ctx.endpoint = ctx.upstreamModel.endsWith('-free') ? 'payg' : 'subscription';
  ctx.stream = upstreamReq.stream === true;

  const controller = new AbortController();
  // 客户端断开要中止上游请求。不能挂 req.on('close')：IncomingMessage 的 close
  // 在**请求体读完**时就触发（远早于客户端断开），监听器等于白挂；要挂响应的
  // close —— 连接被客户端掐断时 res 立即 close，正常结束时触发无害
  // （此时上游 body 已消费完或不再需要，abort 不造成副作用）。
  res.on('close', () => controller.abort());

  // 用 key 池转发。非流式在「未写出任何响应字节」时可换 key 重试一次。
  let upstream: UpstreamCall;
  try {
    upstream = await postUpstreamChat(cfg, pool, upstreamReq, controller.signal);
    ctx.keyFingerprint = keyFingerprint(upstream.key);
  } catch (err) {
    if (err instanceof PoolEmptyError) {
      logPoolEmpty(pool);
      sendPoolEmpty(res, pool);
      return;
    }
    // 池内所有 key 瞬时失败（fetch 网络错误），postAnthropic 已自动 release + 上报。
    sendJson(res, 502, { error: { message: 'upstream unavailable', type: 'server_error' } });
    return;
  }

  // 第一次读到的上游错误体。响应 body 只能读一次，所以读完要留着 ——
  // 下面那个统一错误出口原本会再 `.json()` 一次，在「没换 key」的路径上
  // 必然拿到空，于是连回给客户端的错误文案都退化成按状态码生成的通用句子。
  let firstErrBody: unknown = null;
  // 当前 `upstream` 的失败是否已上报 keypool。首个 key 的 markFailure 在换 key
  // 判断块里做；换出的第二个 key 失败时统一错误出口必须补报 —— 否则第二个 key
  // 持续失败时每个请求都白撞它一次再 503，它还永远 healthy（坏 key 永不降权）。
  let failureReported = false;

  // 非流式：上游返回错误状态时，若尚未写响应字节，可换 key 重试一次。
  if (!upstream.response.ok && !res.headersSent) {
    // 读取错误体用于分级（余额不足 → rate-limit，而非 auth 长期禁用）。
    let errBody: unknown = null;
    try {
      errBody = await upstream.response.json();
    } catch {
      // body 不是 JSON（如空/HTML）：忽略，按状态码分级。
    }
    firstErrBody = errBody;
    const kind = classifyUpstreamFailure(upstream.response.status, errBody);
    upstream.markFailure(kind, resetDelayMsFromError(errBody) ?? undefined);
    // 额度耗尽记下上游原文（type + Resets in ...）：整池同时耗尽时 pool empty
    // 没有响应可读，靠它把 GoUsageLimitError 原样透传给下游。
    if (kind === 'quota-exhausted') pool.noteQuotaError(upstream.response.status, errBody);
    failureReported = true;
    // 在这里记：body 只能读一次，下面那个统一错误出口再 .json() 会拿到空。
    // 记下的是「第一个 key 上到底出了什么」—— 恰是换 key 重试会掩盖掉的证据。
    noteUpstreamError(ctx, upstream.response.status, errBody);
    if (pool.healthyCount > 0 && !res.headersSent) {
      upstream.release();
      // 换 key 重试（最多一次）。排除刚失败的 key：它刚 release、inFlight=0，
      // 并发场景下 least-loaded 会把「最闲」的它再选回来，白撞一次错误。
      try {
        upstream = await postUpstreamChat(cfg, pool, upstreamReq, controller.signal, {}, undefined, {
          excludeKey: upstream.key,
        });
        ctx.keyFingerprint = keyFingerprint(upstream.key);
        // 换了 key 就是一个全新的响应：上一个 key 的错误体不能再用来描述它。
        firstErrBody = null;
        // 新 key 的失败还没上报过，统一错误出口要补（见 failureReported 注释）。
        failureReported = false;
        // 重试成功就不该在这条 200 记录上留着上一个 key 的错误文案。
        if (upstream.response.ok) ctx.error = null;
      } catch (err) {
        if (err instanceof PoolEmptyError) {
          logPoolEmpty(pool);
          sendPoolEmpty(res, pool);
          return;
        }
        sendJson(res, 502, { error: { message: 'upstream unavailable', type: 'server_error' } });
        return;
      }
    } else {
      upstream.release();
    }
  }

  if (!upstream.response.ok) {
    // 没换 key 时 body 已在上面读过（只能读一次），复用那份；换过 key 的话
    // 这是新响应，firstErrBody 属于上一个 key，得重新读。
    let errBody: unknown = firstErrBody;
    if (errBody == null) {
      try {
        errBody = await upstream.response.json();
      } catch {
        // ignore
      }
    }
    noteUpstreamError(ctx, upstream.response.status, errBody);
    // 统一错误出口：首 key 的失败已在换 key 判断块上报过（failureReported=true），
    // 只有换出来的第二个 key 失败（或重试前上游就 !ok 的路径）需要在这里补报。
    if (!failureReported) {
      const kind = classifyUpstreamFailure(upstream.response.status, errBody);
      upstream.markFailure(kind, resetDelayMsFromError(errBody) ?? undefined);
      if (kind === 'quota-exhausted') pool.noteQuotaError(upstream.response.status, errBody);
    }
    const err = anthropicErrorToOpenAI(upstream.response.status, errBody);
    const retryAfter = upstream.response.headers.get('retry-after');
    if (retryAfter) res.setHeader('retry-after', retryAfter);
    upstream.release();
    sendJson(res, err.status, err.body);
    return;
  }

  const requestedModel = typeof body.model === 'string' ? body.model : undefined;
  const isStream = upstreamReq.stream === true;

  if (isStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    try {
      // 上游已是 OpenAI 流，逐 chunk 回显（只改写 model 名回显客户端请求的名字），
      // 收尾补 [DONE]。上游的 `{"choices":[],"cost":...}` 记账 chunk 不转发给客户端。
      // 脏数据（非 SSE 行）由 parseOpenAISSE 丢弃并回调：收到即中止流并发错误事件，
      // 避免客户端看到断流后报通用 Failed to parse JSON。
      let dirtySample: string | null = null;
      for await (const chunk of parseOpenAISSE(upstream.response.body, (d) => {
        if (dirtySample === null) dirtySample = d.sample;
      })) {
        if (res.writableEnded || res.destroyed) break;
        // 重置上游 body 空闲 watchdog：每收到一个 chunk 视为上游还活着。
        upstream.touch();
        if (requestedModel) chunk.model = requestedModel;
        if (chunk.usage) {
          ctx.inputTokens = chunk.usage.prompt_tokens ?? ctx.inputTokens;
          ctx.outputTokens = chunk.usage.completion_tokens ?? ctx.outputTokens;
          ctx.thinkingTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? ctx.thinkingTokens;
        }
        // 记账 chunk（`{"choices":[],"cost":"..."}`）只用于落库，不转发。
        // 实测订阅端点 cost 恒 "0"，按量端点（-free）才是真实成本。
        if (chunk.cost != null) ctx.costMicroCents = parseCostMicroCents(chunk.cost);
        // 脏行检测放在写出**之前**：onDirty 在 parseOpenAISSE 产出下一个 chunk 的
        // 途中触发，此时该 chunk 已越过脏数据边界，不能再写给客户端。
        if (dirtySample !== null) {
          // 脏样本可能回显上游 Authorization 头，落日志前先脱敏。
          console.error(`[proxy] chat stream aborted on dirty line: ${stripSecrets(stripControl(dirtySample))}`);
          // 镜像直通路径：脏行不再静默断流 —— 补一个错误 chunk + 上报 keypool +
          // 记 ctx.error。否则客户端看到「无 [DONE] 无错误」的响应（挂起/通用
          // Failed to parse JSON），面板也没有任何失败痕迹。
          upstream.markFailure('transient');
          ctx.error = 'upstream dirty stream';
          if (!res.writableEnded && !res.destroyed) {
            await writeChunk(res, `data: ${JSON.stringify({ error: INTERNAL_SERVER_ERROR })}\n\n`);
          }
          break;
        }
        if (!chunk.choices?.length && !chunk.usage) continue;
        await writeChunk(res, sseStringify(chunk));
      }
      if (dirtySample === null && !res.writableEnded && !res.destroyed) {
        await writeChunk(res, 'data: [DONE]\n\n');
      }
      if (dirtySample === null) upstream.markSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'stream error';
      console.error(`[proxy] stream error: ${stripControl(message)}`);
      // 客户端中途断开（res close → controller.abort）不是上游故障：取消流不能
      // 上报 keypool，否则 Claude Code 停生成 5 次就把健康 key 禁 5 分钟。
      if (!isClientAbort(controller, res)) {
        upstream.markFailure('transient');
      }
      if (!res.writableEnded && !res.destroyed) {
        // 网关主动掐断（idle watchdog 超时）时给客户端明确「上游响应超时」；
        // 其余流错误保持泛化 internal error。
        const timedOut = isUpstreamWatchdog(controller, res);
        res.write(`data: ${JSON.stringify({ error: timedOut ? UPSTREAM_TIMEOUT_ERROR : INTERNAL_SERVER_ERROR })}\n\n`);
      }
    } finally {
      upstream.release();
      res.end();
    }
    return;
  }

  const data = (await upstream.response.json().catch(() => null)) as OpenAIChatResponse | null;
  upstream.release();
  if (data === null) {
    // 上游 200 但 body 非法（或 body 阶段被 idle/total watchdog 掐断）：记失败不记成功，
    // 否则坏 key 永不降权、requests.error 恒空。客户端主动断开触发的 abort 除外。
    // watchdog 掐断（网关主动断开）要明确「上游响应超时」，不能泛化成 malformed body
    // —— 客户端（Claude Code/curl）面对 502 需要能区分是上游挂了还是响应坏了。
    const timedOut = isUpstreamWatchdog(controller, res);
    if (!isClientAbort(controller, res)) {
      upstream.markFailure('transient');
      // 观测：超时记成可读原因（面板/db 里能直接看到「上游响应超时」而非「upstream 200」）。
      if (timedOut) ctx.error = 'upstream response timed out';
      else noteUpstreamError(ctx, 200, null);
    }
    sendJson(res, 502, {
      error: { message: timedOut ? UPSTREAM_TIMEOUT_ERROR.message : 'upstream returned malformed body', type: 'server_error' },
    });
    return;
  }
  upstream.markSuccess();
  // 回显客户端请求的模型名，而非上游实际模型名。
  if (requestedModel) data.model = requestedModel;
  ctx.inputTokens = data.usage?.prompt_tokens ?? 0;
  ctx.outputTokens = data.usage?.completion_tokens ?? 0;
  ctx.thinkingTokens = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  if (data.cost != null) ctx.costMicroCents = parseCostMicroCents(data.cost);
  sendJson(res, 200, data);
}

/**
 * OpenAI 请求 → 发给上游的 OpenAI 请求。
 *
 * 上游同为 OpenAI 协议，所以不做协议转换，只做三件事：
 * 1. 模型名解析（MODEL_MAP → 上游已知模型直传 → 回落 fallback）。
 * 2. 加 system 指令隔离护栏（把历史/工具结果声明为不可信数据）。
 * 3. 剥掉上游不认的字段，避免 400。
 */
function prepareOpenAIUpstreamRequest(
  req: OpenAIChatRequest,
  cfg: AppConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(req as unknown as Record<string, unknown>) };
  out.model = resolveModelName(req.model, cfg.modelMap, cfg.fallbackModel, upstreamModels);

  // system 护栏：已有 system 消息就追加，没有就插一条到最前面。
  const messages = Array.isArray(req.messages) ? [...req.messages] : [];
  const firstSystem = messages.findIndex((m) => m?.role === 'system');
  if (firstSystem >= 0) {
    const m = messages[firstSystem]!;
    const text = typeof m.content === 'string' ? m.content : '';
    messages[firstSystem] = { ...m, content: buildSystemGuard(text) };
  } else {
    messages.unshift({ role: 'system', content: buildSystemGuard('') });
  }
  out.messages = messages;

  // 上游不认的 OpenAI 扩展字段：剥掉防 400。
  for (const k of ['logit_bias', 'logprobs', 'top_logprobs', 'n', 'seed', 'user', 'store', 'metadata']) {
    delete out[k];
  }
  return out;
}

async function handleMessagesPassThrough(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AppConfig,
  pool: KeyPool,
  keyId: string,
  ctx: MetricsCtx,
): Promise<void> {
  const read = await readBody(req, cfg.maxBodyBytes);
  if (!read.ok) {
    // 观测：body 读取失败的原因写进 ctx.error（落库/面板可见）。
    ctx.error = `body-read-fail:${read.status}`;
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    sendJson(res, 400, badBodyError(parsed.empty));
    return;
  }
  const body = parsed.body as Record<string, unknown>;

  // 客户端请求的模型名快照，必须在 normalize 之前取：大 body（>512KB）时
  // normalizeAnthropicRequest 跳过 structuredClone、原地改写入参（body.model 被
  // 映射成 deepseek 名，见 OOM 修复注释），这里再读 body.model 会拿到改后值 ——
  // 大请求与小请求的响应 model 回显会分叉。快照对 <512KB 也一致（原样回显客户端模型名）。
  const requestedModel = typeof body.model === 'string' ? body.model : undefined;

  const v = validateAnthropicRequest(body, cfg);
  if (!v.ok) {
    // 观测：校验拒绝的原因写进 ctx.error 落库/面板（此前校验 400 的 error 恒空，
    // 用户问「为什么 400」时无据可查）。原因不是敏感数据（不回显请求体）。
    ctx.error = `reject: ${v.error}`;
    console.log(`[proxy] validate reject ${req.url ?? ''}: ${v.error}`);
    sendJson(res, 400, { error: { message: v.error, type: 'invalid_request_error' } });
    return;
  }

  // deepseek 归一化：模型名映射 + thinking 归一化（adaptive→enabled 等）。
  // 实验性被动压缩（COMPACT_ENABLED）：请求体超阈值时在此顺带压缩（见 compact.ts）。
  // 观测：context_management 剥除计数 —— 删除动作在 deepseek.ts 的
  // normalizeAnthropicRequest 里（无 ctx 可写），这里按请求体是否带该字段判定
  // （delete 无条件，带即删，两者一一对应）。只数 body 字段，anthropic-beta 头
  // 的成对剥除（collectForwardHeaders）不单独计。
  if (body.context_management != null) ctx.stripped += 1;
  let normalized: Record<string, unknown>;
  try {
    // 观测：被动压缩触发计数 —— 触发条件与 deepseek.ts 的 compactMessages
    // 调用点（compact != null && bodyBytes > triggerBytes && messages 是数组）
    // 一一对应，这里镜像同一条件（deepseek.ts 无 ctx 可写）。按「触发」计数
    // 而非「实际压缩到的字节」：全部空白折叠命中与否不影响次数口径。
    if (cfg.compactEnabled && Buffer.byteLength(read.text) > cfg.compactTriggerBytes && Array.isArray(body.messages)) {
      ctx.compressed += 1;
    }
    normalized = normalizeAnthropicRequest(
      body,
      cfg.modelMap,
      cfg.fallbackModel,
      // bodyBytes 始终传（OOM 修复：大 body 跳过 structuredClone——不依赖
      // 实验开关）；压缩参数只在开关开启时给。
      {
        bodyBytes: Buffer.byteLength(read.text),
        ...(cfg.compactEnabled
          ? {
              triggerBytes: cfg.compactTriggerBytes,
              maxMessageChars: cfg.compactMaxMessageChars,
            }
          : {}),
      },
    );
  } catch {
    sendJson(res, 400, { error: { message: 'invalid request body', type: 'invalid_request_error' } });
    return;
  }

  // 注入检测：对 user 消息递归提取文本做启发式扫描（含 tool_result 内嵌 content）。
  const anthroMessages = normalized.messages as Array<{ role: string; content: unknown }>;
  for (let i = 0; i < anthroMessages.length; i++) {
    const m = anthroMessages[i]!;
    if (m.role !== 'user') continue;
    const verdict = detectInjection(extractAllText(m.content));
    if (verdict.level !== 'none') {
      console.warn(`[inject] key=${keyId} msg#${i} level=${verdict.level} signals=${verdict.signals.join(',')}`);
      if (cfg.injectionMode === 'block' && verdict.level === 'high') {
        sendJson(res, 400, { error: { message: 'message content violates content policy', type: 'invalid_request_error' } });
        return;
      }
    }
  }

  const controller = new AbortController();
  // 同 chat 路径：挂响应 close 才能捕捉客户端断开（req close 在 body 读完即触发）。
  res.on('close', () => controller.abort());

  // 转成 OpenAI 请求再发上游。上游的 Anthropic 兼容层工具调用是坏的
  // （返回空 content + stop_reason:null），OpenAI 端点才可用，见 DEEPSEEK-QUIRKS.md。
  const openAIReq = anthropicToOpenAIRequest(normalized as unknown as Parameters<typeof anthropicToOpenAIRequest>[0]);
  ctx.requestBytes = Buffer.byteLength(read.text);
  ctx.model = requestedModel ?? '';
  ctx.upstreamModel = openAIReq.model;
  ctx.endpoint = openAIReq.model.endsWith('-free') ? 'payg' : 'subscription';
  ctx.stream = normalized.stream === true;

  // 转发额外 headers（anthropic-beta、x-claude-code-*），并保留上游 request-id。
  const extraHeaders = collectForwardHeaders(req.headers, cfg);
  let upstream: UpstreamCall;
  try {
    upstream = await postUpstreamChat(
      cfg,
      pool,
      openAIReq as unknown as Record<string, unknown>,
      controller.signal,
      extraHeaders,
    );
    ctx.keyFingerprint = keyFingerprint(upstream.key);
  } catch (err) {
    if (err instanceof PoolEmptyError) {
      logPoolEmpty(pool);
      sendPoolEmpty(res, pool);
      return;
    }
    sendJson(res, 502, { error: { message: 'upstream unavailable', type: 'server_error' } });
    return;
  }

  if (!upstream.response.ok) {
    // Claude Code 期望 Anthropic 原生错误格式，直通透传（限长 + 剥控制符防泄漏/日志注入），
    // 保留 request-id 与 retry-after。
    const raw = (await upstream.response.text().catch(() => '')).slice(0, 64 * 1024);
    let errBody: unknown = null;
    try {
      errBody = JSON.parse(raw);
    } catch {
      /* 非 JSON，按状态码分级 */
    }
    const kind = classifyUpstreamFailure(upstream.response.status, errBody);
    upstream.markFailure(kind, resetDelayMsFromError(errBody) ?? undefined);
    if (kind === 'quota-exhausted') pool.noteQuotaError(upstream.response.status, errBody);
    noteUpstreamError(ctx, upstream.response.status, errBody);
    const requestId = upstream.response.headers.get('request-id');
    const retryAfter = upstream.response.headers.get('retry-after');
    res.writeHead(upstream.response.status, {
      'content-type': 'application/json; charset=utf-8',
      ...(requestId ? { 'request-id': requestId } : {}),
      ...(retryAfter ? { 'retry-after': retryAfter } : {}),
    });
    upstream.release();
    // 上游错误体可能回显 Authorization 头（Bearer sk-xxx），透传前脱敏，
    // 否则 key 明文直接进客户端（stripControl 只剥控制符，剥不掉 key）。
    // 上下文超限改写：DeepSeek 的 "maximum context length" 措辞 Claude Code
    // 认不出（官方文档：CC 只对 prompt is too long / Input is too long 类措辞
    // 触发自动恢复链：缩 max_tokens → 本地 compact）。不改写 = CC 直接报错
    // 中断，用户反复重试全部 400（实测 04:25-04:30 连续 15+ 次）。
    // 观测：计数真正发生的改写（命中上下文超限措辞且被改写），供 /__metrics
    // summary.rewritten —— 改写率 = 上游上下文撞限的暴露面。
    const rewrittenBody = rewriteContextOverflowImpl(raw);
    if (rewrittenBody.rewrote) ctx.rewritten += 1;
    res.end(stripSecrets(stripControl(rewrittenBody.text)));
    return;
  }
  const requestId = upstream.response.headers.get('request-id');
  if (requestId) res.setHeader('request-id', requestId);

  const isStream = normalized.stream === true;
  if (isStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // 上游是 OpenAI 流：解析 chunk → 转成 Anthropic 事件序列（自带完整骨架）。
    // thinking 显式 disabled 时剥掉 thinking 块事件（Claude Code 会因多余 thinking 报错）。
    const keepThinking = (normalized.thinking as { type?: string } | undefined)?.type !== 'disabled';
    // 上游在流中途插入脏数据（非 SSE 行/坏 JSON）时：中止流并发明确 error 事件，
    // 否则客户端只会看到一个「断流」的响应，报出通用的 Failed to parse JSON。
    // 行本身仍被 parseOpenAISSE 丢弃（不透传），这里只是让「断流」可解释。
    let dirtySample: string | null = null;
    // 记账 chunk（`{"choices":[],"cost":"..."}`）在转换时被丢弃，先窥视 cost
    // 供落库（网关实际用量）：订阅端点恒 "0"，按量端点（-free）才是真实成本。
    const rawChunks = tapStreamCost(
      parseOpenAISSE(upstream.response.body, (d) => {
        if (dirtySample === null) dirtySample = d.sample;
      }),
      (cost) => {
        ctx.costMicroCents = cost;
      },
    );
    const events = filterThinkingFromStream(
      // 实验性 usage 缩放（SCALE_CLIENT_TOKENS）：返回给客户端的用量失真，观测走 MetricsCtx。
      openAIStreamToAnthropic(rawChunks, {
        model: requestedModel,
        scale: cfg.scaleClientTokens ? cfg.clientTokenScale : undefined,
      }),
      keepThinking,
    );
    /** 发一个 Anthropic error 事件，告知客户端流被上游打断。 */
    const emitStreamError = (sample: string): void => {
      // 脏样本可能回显上游 Authorization 头，落日志前先脱敏。
      console.error(`[proxy] passthrough stream aborted on dirty line: ${stripSecrets(stripControl(sample))}`);
      if (!res.writableEnded && !res.destroyed) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'upstream interrupted the stream' } })}\n\n`,
        );
      }
    };
    try {
      for await (const ev of events) {
        if (res.writableEnded || res.destroyed) break;
        // 重置上游 body 空闲 watchdog：每收到一个事件视为上游还活着。
        upstream.touch();
        // 脏行检测放在写出**之前**：收到脏行时不再写给客户端后续事件。
        if (dirtySample !== null) break;
        if (ev.type === 'message_delta' && ev.usage) {
          ctx.outputTokens = ev.usage.output_tokens;
          // 流式 input_tokens 恒 0 的修复：真实 prompt_tokens 由 toAnthropic 经
          // message_delta.usage.input_tokens 传出（Anthropic 允许该字段），
          // server 侧取用记账 —— 否则主流量（messages + stream）的 input 侧
          // 用量账本失真，SCALE_CLIENT_TOKENS 缩放也永远作用不到 input 侧。
          if (ev.usage.input_tokens != null) ctx.inputTokens = ev.usage.input_tokens;
        }
        await writeChunk(res, anthropicEventToSSE(ev));
      }
      // 循环结束后再查一次：openAIStreamToAnthropic 会缓冲整个 text 块到流末尾
      // 收尾统一产出，脏行可能在最后一次迭代之后才被上报。
      if (dirtySample !== null) {
        emitStreamError(dirtySample);
        upstream.markFailure('transient');
      } else {
        upstream.markSuccess();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'passthrough stream error';
      console.error(`[proxy] passthrough stream error: ${stripControl(message)}`);
      // 客户端中途断开（res close → controller.abort）不是上游故障：取消流不能
      // 上报 keypool，否则 Claude Code 停生成 5 次就把健康 key 禁 5 分钟。
      if (!isClientAbort(controller, res)) {
        upstream.markFailure('transient');
        // 网关主动掐断（idle watchdog 超时）：给客户端明确「上游响应超时」，
        // 别让流无声断掉（Claude Code 拿到 event: error 才能报出可读错误）。
        if (isUpstreamWatchdog(controller, res) && !res.writableEnded) {
          res.write(
            `event: error\ndata: ${JSON.stringify({
              type: 'error',
              error: { type: 'overloaded_error', message: UPSTREAM_TIMEOUT_ERROR.message },
            })}\n\n`,
          );
        }
      }
    } finally {
      upstream.release();
      res.end();
    }
    return;
  }

  // 非流式：上游 OpenAI 响应 → Anthropic 响应。
  const data = (await upstream.response.json().catch(() => null)) as OpenAIChatResponse | null;
  upstream.release();
  if (data === null) {
    // 上游 200 但 body 非法（或 body 阶段被 idle/total watchdog 掐断）：记失败不记成功，
    // 否则坏 key 永不降权、requests.error 恒空。客户端主动断开触发的 abort 除外。
    // watchdog 掐断（网关主动断开）要明确「上游响应超时」，不能泛化成 malformed body。
    const timedOut = isUpstreamWatchdog(controller, res);
    if (!isClientAbort(controller, res)) {
      upstream.markFailure('transient');
      if (timedOut) ctx.error = 'upstream response timed out';
      else noteUpstreamError(ctx, 200, null);
    }
    sendJson(res, 502, {
      error: { message: timedOut ? UPSTREAM_TIMEOUT_ERROR.message : 'upstream returned malformed body', type: 'server_error' },
    });
    return;
  }
  upstream.markSuccess();
  // 回显客户端请求的模型名（映射前的名字），而非上游实际模型。
  // 实验性 usage 缩放（SCALE_CLIENT_TOKENS）：返回给客户端的用量失真。
  // 注意：下方 ctx 计数取的是缩放后值，真实用量由波 2 的 MetricsCtx 观测接管。
  const anthropicRes = openAIToAnthropicResponse(data, {
    model: requestedModel,
    scale: cfg.scaleClientTokens ? cfg.clientTokenScale : undefined,
  });
  ctx.inputTokens = anthropicRes.usage.input_tokens;
  ctx.outputTokens = anthropicRes.usage.output_tokens;
  ctx.thinkingTokens = anthropicRes.usage.output_tokens_details?.thinking_tokens ?? 0;
  if (data.cost != null) ctx.costMicroCents = parseCostMicroCents(data.cost);

  // thinking 显式 disabled 时剥掉 thinking 块（Claude Code 会因多余 thinking 报错）。
  if ((normalized.thinking as { type?: string } | undefined)?.type === 'disabled') {
    anthropicRes.content = anthropicRes.content.filter((b) => b.type !== 'thinking');
    if (anthropicRes.content.length === 0) {
      anthropicRes.content.push({ type: 'text', text: '' });
    }
  }

  sendJson(res, 200, anthropicRes);
}

/**
 * Claude Code 记账端点。
 *
 * 上游走的是 OpenAI 协议，没有 count_tokens（Anthropic 端点也只返回 404 HTML），
 * 所以这里纯本地估算，不打上游 —— 既省一次往返，也避免烧订阅额度。
 * 估算口径：messages/system 的文本字符数 / 4。
 *
 * 观测注意（2026-08-13 修复）：此前是 `void readBody(...).then(...)` 没被 await
 * —— finally 记账先于 .then() 回调执行，ctx.inputTokens 还没赋值就落库，requests
 * 行 input_tokens 恒 0；body 读失败也不写 ctx.error。现在改成 async + await，
 * 读失败记 ctx.error。endpoint 标记成 'count_tokens'：记账请求不进「请求数」
 * 统计（metrics 事件直接跳过、db 聚合查询排除），面板详细请求里仍可见（带
 * 真实 input_tokens），靠 endpoint 区分。
 */
async function handleCountTokens(req: IncomingMessage, res: ServerResponse, cfg: AppConfig, ctx: MetricsCtx): Promise<void> {
  ctx.endpoint = 'count_tokens';
  const read = await readBody(req, cfg.maxBodyBytes);
  if (!read.ok) {
    ctx.error = `request body read failed (${read.status})`;
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    ctx.error = parsed.empty ? 'request body is empty' : 'invalid JSON body';
    sendJson(res, 400, badBodyError(parsed.empty));
    return;
  }
  const bodyObj = parsed.body as Record<string, unknown> | null;
  if (bodyObj != null && typeof bodyObj.model === 'string') ctx.model = bodyObj.model;
  const inputTokens = estimateInputTokens(parsed.body);
  ctx.inputTokens = inputTokens;
  sendJson(res, 200, { input_tokens: inputTokens });
}

/** 本地估算 input_tokens：messages/system 文本字符数 / 4（约 4 字符/token）。 */
function estimateInputTokens(body: unknown): number {
  let chars = 0;
  const countText = (value: unknown): void => {
    if (typeof value === 'string') {
      chars += value.length;
    } else if (Array.isArray(value)) {
      for (const item of value) countText(item);
    } else if (value != null && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        countText((value as Record<string, unknown>)[key]);
      }
    }
  };

  const bodyObj = body as Record<string, unknown> | null;
  if (bodyObj != null && typeof bodyObj === 'object') {
    if (typeof bodyObj.system === 'string') chars += bodyObj.system.length;
    countText(bodyObj.messages);
  }
  return Math.max(1, Math.ceil(chars / 4));
}

// ---------------------------------------------------------------------------
// OAuth device flow 管理端点（POST /__admin/api/oauth/start | poll）
// ---------------------------------------------------------------------------
//
// 契约（与前端约定）：
// - 两个端点都已过 isAdminRequest，这里只做写操作专属的 Origin 校验
//   （与 admin.ts 同款：非空 Origin 必须等于 http://<host>:<port>）。
// - start：200 {ok:true, deviceCode, userCode, verificationUriComplete,
//   expiresIn, interval}；上游失败 500 {ok:false, reason:"error"}，detail 只进日志。
// - poll：body {deviceCode}；200 {ok:true,status:"pending"|"done"}（done =
//   服务端已自动创建/更新账号）或 200 {ok:false, reason:"expired"|"denied"|
//   "not_found"|"error"}。鉴权/格式错误沿用 {error:{message,type}} 形状。

/** OAuth 端点请求体上限（deviceCode 很小，宽松上限防滥用）。 */
const OAUTH_BODY_MAX_BYTES = 64 * 1024;

/** 管理面写操作的 Origin 校验（与 admin.ts 的 originAllowed 同语义：
 *  hostname+端口归一比较，不比较 scheme，兼容 HTTPS 反代 TLS 终止）。 */
function adminOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return true;
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0) return false;
  try {
    const o = new URL(origin);
    const h = new URL(`http://${host}`);
    if (o.hostname !== h.hostname) return false;
    // 端口规则与 admin.ts 的 originAllowed 一致：Host 显式端口严格比；
    // Host 无端口（HTTPS 反代）时 Origin 端口须为标准端口 80/443。
    const originPort = o.port || (o.protocol === 'https:' ? '443' : '80');
    if (h.port !== '') return h.port === originPort;
    return originPort === '80' || originPort === '443';
  } catch {
    return false;
  }
}

/** POST /__admin/api/oauth/start：发起一个 device flow 会话。 */
async function handleOauthStart(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AppConfig,
  oauth: OauthManager,
  fetchImpl: FetchLike | undefined,
): Promise<void> {
  if (!adminOriginAllowed(req)) {
    sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
    return;
  }
  // 消费请求体（前端传 {}；不读会破坏 keep-alive）。体内容不参与业务。
  const read = await readBody(req, OAUTH_BODY_MAX_BYTES);
  if (!read.ok) {
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const r = await oauth.start(cfg.oauthConsoleUrl, cfg.oauthClientId, fetchImpl ?? fetch);
  if (!r.ok) {
    // 上游失败的 detail 已在 oauth.start 内部记日志，对外固定原因。
    sendJson(res, 500, { ok: false, reason: 'error' });
    return;
  }
  sendJson(res, 200, { ok: true, ...r.session });
}

/** POST /__admin/api/oauth/poll：轮询 device flow 状态；done 时自动创建账号。 */
async function handleOauthPoll(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AppConfig,
  oauth: OauthManager,
  store: AccountsStore | null,
  fetchImpl: FetchLike | undefined,
): Promise<void> {
  if (!adminOriginAllowed(req)) {
    sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
    return;
  }
  const read = await readBody(req, OAUTH_BODY_MAX_BYTES);
  if (!read.ok) {
    // 观测：body 读取失败只打日志（OAuth 端点无 MetricsCtx）。
    console.log(`[proxy] body read fail (oauth): ${read.status}`);
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    sendJson(res, 400, badBodyError(parsed.empty));
    return;
  }
  const body = parsed.body as Record<string, unknown> | null;
  const deviceCode = body != null && typeof body.deviceCode === 'string' ? body.deviceCode : '';
  if (!deviceCode || deviceCode.length > 4096) {
    sendJson(res, 400, { error: { message: 'deviceCode must be a non-empty string', type: 'invalid_request_error' } });
    return;
  }
  const r = await oauth.poll(deviceCode, cfg.oauthConsoleUrl, cfg.oauthClientId, fetchImpl ?? fetch);
  if (!r.ok) {
    sendJson(res, 200, { ok: false, reason: r.reason });
    return;
  }
  if (r.status === 'pending') {
    sendJson(res, 200, { ok: true, status: 'pending' });
    return;
  }
  // done：服务端自动创建账号（幂等）。失败时设备码已消费，前端重新走 start。
  if (!persistOauthAccount(store, r.identity)) {
    sendJson(res, 200, { ok: false, reason: 'error' });
    return;
  }
  sendJson(res, 200, { ok: true, status: 'done' });
}

/**
 * 把登录身份落成账号（幂等）：同 workspaceId 已有账号 → 只更新 oauth 字段
 * （不覆盖用户自定义的名字）；否则 create 一个 `{kind:'unknown', keys:[], cookie:null}`
 * 的新账号。refresh_token 在这里加密落库；access_token 不在本函数出现。
 *
 * **补绑语义（确认）**：OAuth 登录天然按 workspaceId 归并 —— 现有 cookie 账号
 * 只要用同一个 workspace（同一 OAuth 账号登录的 org 与 cookie 账号相同），
 * 第二次走 Sign in with OpenCode 就是「补绑」：cookie 与 refresh_token 并存，
 * console 通道 cookie 优先、失效自动回退 Bearer（见 ConsoleClient.getCredentials）。
 * 不同 workspace 才新建账号。所以「现有 cookie 账号能否补绑 OAuth」= 能，
 * 前提是同一个 workspace；面板无需单独入口，复用弹层再授权一次即可。
 */
function persistOauthAccount(store: AccountsStore | null, identity: OauthIdentity): boolean {
  if (store == null || !store.enabled) {
    console.error(`[oauth] 数据面不可用，登录成功但账号未落库: ws=${identity.workspaceId}`);
    return false;
  }
  const existing = store.list().find((a) => a.workspaceId === identity.workspaceId);
  if (existing) {
    if (!store.setOauthRefresh(existing.id, identity.refreshToken)) {
      console.error(`[oauth] 账号 ${existing.id} refresh_token 落库失败`);
      return false;
    }
    console.log(`[oauth] account=${identity.name} ws=${identity.workspaceId} refresh updated`);
    return true;
  }
  const created = store.create({
    name: identity.name,
    kind: 'unknown',
    workspaceId: identity.workspaceId,
    keys: [],
    cookie: null,
  });
  if (!created.ok) {
    console.error(`[oauth] 账号创建失败: ${created.reason}`);
    return false;
  }
  if (!store.setOauthRefresh(created.value.id, identity.refreshToken)) {
    console.error(`[oauth] 账号 ${created.value.id} refresh_token 落库失败`);
    return false;
  }
  console.log(`[oauth] account=${identity.name} ws=${identity.workspaceId} created (id=${created.value.id})`);
  return true;
}

// ---------------------------------------------------------------------------
// console 数据端点（GET/POST/DELETE /__admin/api/console/...）
// ---------------------------------------------------------------------------
//
// 契约（任务说明 + CONSOLE-PORT.md §4）：
// - 全部已过 isAdminRequest；写操作（含 import-cookie）在分派前统一先过
//   adminOriginAllowed（与 oauth 端点同款）。
// - 读端点成功统一 {ok:true, ...}（billing 带 cookieState）；失败：
//   参数校验 400 / 账户 404 / 通道未接线或无 cookie 或 auth 失效 502
//   channel_error / 上游失败 502 upstream_error —— 形状 {error:{message,type}}。
// - 写端点成功 {ok:true}；校验 400 / 上游 502；成功/失败都落 admin_audit
//   审计表（op/accountId/ok/note 摘要，**绝不记金额/cookie**），保留 console.log。
// - import-cookie：成功 {ok:true, imported:true}。**cookie 值绝不进响应与日志**，
//   服务端直接写进 store（accounts 的 cookie 存储语义 = 完整 name=value 原样）。
// - cookie/余额值不进任何日志。

/** console 写操作请求体上限（都很小，宽松防滥用）。 */
const CONSOLE_BODY_MAX_BYTES = 64 * 1024;
/** 共享 Chrome 的 CDP 调试端口（全局铁律：常驻浏览器连 127.0.0.1:9223）。 */
const CONSOLE_CHROME_CDP_PORT = 9223;
/** members/keys 分页大小（契约默认值）。 */
const CONSOLE_PAGE_SIZE = 50;
/** usage 默认统计窗口（天）。 */
const CONSOLE_USAGE_RANGE_DAYS = 7;

/** importCookieFromChrome（cookie.ts）的最小接口假设：成功带 auth cookie 值。 */
export type CookieImportLike = (
  port: number,
) => Promise<{ auth: string } | { ok: false; reason: string }>;

/** console 路由的依赖集合（createApp 注入点透传）。 */
interface ConsoleDeps {
  cfg: AppConfig;
  store: AccountsStore | null;
  client: ConsoleClientLike | undefined;
  importCookie?: CookieImportLike;
  /** 用量库（管理审计落表；未接线/null = 审计只走 console.log，不阻断操作）。 */
  db: UsageDb | null;
}

/**
 * /__admin/api/console 全部分派。路径形状：
 *   account/:id/{billing,members,keys,providers,budgets,models-pricing}（读）
 *   account/:id/usage[/{cost-by-day,models,users}]                      （读）
 *   account/:id/budgets/users-status                                    （读）
 *   account/:id/{auto-recharge,monthly-limit} | account/:id/keys     （写）
 *   account/:id/keys/:saId                                           （删）
 *   import-cookie                                                    （写）
 */
async function handleConsoleRoutes(req: IncomingMessage, res: ServerResponse, deps: ConsoleDeps): Promise<void> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const query = (req.url ?? '').split('?')[1] ?? '';
  const rest = path.slice('/__admin/api/console/'.length);

  // 写操作统一先过 Origin 校验（读端点 GET 无需 —— 与 admin.ts 的 GET 不设防
  // 一致）。提前到分派前：import-cookie 也是写操作，不能绕过校验（CSRF，M1）。
  if (req.method !== 'GET' && !adminOriginAllowed(req)) {
    sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
    return;
  }

  if (rest === 'import-cookie') {
    if (req.method !== 'POST') {
      sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
      return;
    }
    await handleConsoleImportCookie(req, res, deps);
    return;
  }

  if (!rest.startsWith('account/')) {
    sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
    return;
  }
  const segs = rest.slice('account/'.length).split('/');
  const accountId = parseAccountId(segs[0] ?? '');
  if (accountId == null) {
    sendJson(res, 400, { error: { message: 'account id must be a positive integer', type: 'invalid_request_error' } });
    return;
  }
  const sub = segs[1];

  if (req.method === 'GET') {
    if (sub === 'billing') {
      await handleConsoleBilling(res, deps, accountId);
      return;
    }
    if (sub === 'workspaces') {
      await handleConsoleWorkspaces(res, deps, accountId);
      return;
    }
    if (sub === 'usage') {
      // usage 有子路径：/usage 汇总（含 byDay）/usage/cost-by-day（时间序列）
      // /usage/models /usage/users（拆分表）。未知子路径 404。
      const usageSub = segs[2];
      if (usageSub === undefined) {
        await handleConsoleUsage(res, deps, accountId, query);
        return;
      }
      if (usageSub === 'cost-by-day') {
        await handleConsoleUsageCostByDay(res, deps, accountId, query);
        return;
      }
      if (usageSub === 'models') {
        await handleConsoleUsageModels(res, deps, accountId, query);
        return;
      }
      if (usageSub === 'users') {
        await handleConsoleUsageUsers(res, deps, accountId, query);
        return;
      }
    }
    if (sub === 'members') {
      await handleConsoleMembers(res, deps, accountId);
      return;
    }
    if (sub === 'keys') {
      await handleConsoleKeysList(res, deps, accountId);
      return;
    }
    if (sub === 'providers') {
      await handleConsoleProviders(res, deps, accountId);
      return;
    }
    if (sub === 'budgets') {
      // /budgets 汇总 + /budgets/users-status（用户预算状态）。
      if (segs[2] === 'users-status') {
        await handleConsoleBudgetsUsersStatus(res, deps, accountId);
        return;
      }
      await handleConsoleBudgets(res, deps, accountId);
      return;
    }
    if (sub === 'models-pricing') {
      await handleConsoleModelsPricing(res, deps, accountId);
      return;
    }
  }

  // 写操作：Origin 校验已在分派前统一完成（含 import-cookie）。

  if (sub === 'keys' && req.method === 'POST') {
    await runConsoleWrite(req, res, deps, accountId, 'key.create', validateConsoleCreateKey, (id, body) => {
      const b = body as { name: string };
      return deps.client!.createServiceAccount(id, b.name);
    });
    return;
  }
  if (sub === 'keys' && req.method === 'DELETE') {
    // 与 admin.ts 的 keys DELETE 同款（m4）：畸形 % 编码（如 %zz）会让
    // decodeURIComponent 抛 URIError 穿透到 server 兜底 catch → 500。
    // 这里是路径参数格式错误，该是 400。
    let saId: string;
    try {
      saId = decodeURIComponent(segs[2] ?? '');
    } catch {
      sendJson(res, 400, { error: { message: 'invalid service account id encoding', type: 'invalid_request_error' } });
      return;
    }
    if (!saId || saId.length > 200) {
      sendJson(res, 400, { error: { message: 'service account id must be a non-empty string', type: 'invalid_request_error' } });
      return;
    }
    await runConsoleWriteNoBody(req, res, deps, accountId, 'key.remove', (id) => deps.client!.removeServiceAccount(id, saId));
    return;
  }
  if (sub === 'auto-recharge' && req.method === 'POST') {
    await runConsoleWrite(req, res, deps, accountId, 'auto-recharge', validateConsoleAutoRecharge, (id, body) => {
      // validate 已保证 enabled 是 boolean、金额（若传）是数字 ≥ 0；缺失按 0 填充
      // （ConsoleClient 签名金额必填，enabled=false 时金额被上游忽略）。
      const b = body as Record<string, unknown>;
      const enabled = b.enabled as boolean;
      const thresholdDollars = typeof b.thresholdDollars === 'number' ? b.thresholdDollars : 0;
      const rechargeAmountDollars = typeof b.rechargeAmountDollars === 'number' ? b.rechargeAmountDollars : 0;
      return deps.client!.setAutoRecharge(id, { enabled, thresholdDollars, rechargeAmountDollars });
    });
    return;
  }
  if (sub === 'monthly-limit' && req.method === 'POST') {
    await runConsoleWrite(req, res, deps, accountId, 'monthly-limit', validateConsoleMonthlyLimit, (id, body) =>
      deps.client!.setMonthlyLimit(id, (body as { limitDollars: number }).limitDollars),
    );
    return;
  }

  sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
}

// ---------------------------------------------------------------------------
// console 读端点的前置检查 + 统一失败出口
// ---------------------------------------------------------------------------

/** 数据面/通道不可用时的统一错误响应。 */
function sendConsoleChannelError(res: ServerResponse, message: string): void {
  sendJson(res, 502, { error: { message, type: 'channel_error' } });
}

/** 上游失败（非 auth）统一 502。 */
function sendConsoleUpstreamError(res: ServerResponse): void {
  sendJson(res, 502, { error: { message: 'console channel error', type: 'upstream_error' } });
}

/**
 * 读端点前置检查：通道接线 → 数据面 → 账户存在。返回 null = 检查通过。
 */
function consoleReadGuard(res: ServerResponse, deps: ConsoleDeps, accountId: number): boolean {
  if (!deps.client) {
    sendConsoleChannelError(res, 'console channel not wired');
    return false;
  }
  if (deps.store == null || !deps.store.enabled) {
    sendJson(res, 503, {
      error: {
        message: deps.store == null ? 'accounts module not wired' : `accounts unavailable: ${deps.store.disabledReason ?? 'unknown'}`,
        type: 'server_error',
      },
    });
    return false;
  }
  if (!deps.store.get(accountId)) {
    sendJson(res, 404, { error: { message: 'account not found', type: 'not_found_error' } });
    return false;
  }
  return true;
}

/**
 * 无 cookie / 通道失效的判定（读端点前置，billing 端点除外 —— 它有自己的
 * cookieState 处理）：通道有了但账户没配 cookie，或健康态已判定 cookie 失效
 * （invalid 态下不打上游 —— 与 billing 端点同语义，M-4：面板 2s 轮询不能
 * 每轮都拿失效的 cookie 打上游）。
 */
function consoleNoCookie(res: ServerResponse, deps: ConsoleDeps, accountId: number): boolean {
  // 凭据缺失（无 cookie 且无 OAuth refresh）→ 真没得请求，阻断。
  if (deps.store!.cookieOf(accountId) == null && deps.store!.getOauthRefresh?.(accountId) == null) {
    sendConsoleChannelError(res, 'console channel not available: no credential');
    return true;
  }
  // invalid 是内存健康态（上次请求失败标记）——**不阻断**：token 可能已轮换
  // （重新 OAuth 登录/竞态重试），放请求过去让它自愈（成功 → recordOk 清标记）；
  // 真的失效 → 请求再失败 → 再标记。阻断会造成「新 token 永远被旧标记短路」的死锁。
  return false;
}

/**
 * cookieState 推断：store 的 cookie/OAuth 存在性（missing）+ ConsoleClient 健康态
 * （cookieStatus + authChannel，失败后内存标记）+ 其余 ok。
 * oauth-invalid 单独一个值：OAuth 账号 refresh_token 失效时，面板应提示
 * 「重新授权」而不是「更新 cookie」——两条通道的恢复路径完全不同。
 */
function consoleCookieState(
  store: AccountsStore,
  accountId: number,
  client: ConsoleClientLike,
): 'ok' | 'invalid' | 'oauth-invalid' | 'missing' {
  // cookie 或 OAuth refresh_token 任一存在即可用（Bearer fallback 通道）。
  if (!store.enabled || (store.cookieOf(accountId) == null && store.getOauthRefresh?.(accountId) == null)) {
    return 'missing';
  }
  if (client.cookieStatus(accountId) !== 'invalid') return 'ok';
  return client.authChannel(accountId) === 'oauth' ? 'oauth-invalid' : 'invalid';
}

/**
 * microCents → 美元（1e8 = $1，与 billing.ts 的 UNITS_PER_DOLLAR 同口径）。
 * fixture 证实上游金额字段是字符串（如 "0"）。非法输入返回 null。
 */
function microCentsToDollars(v: unknown): number | null {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number((n / 1e8).toFixed(2));
}

/** unknown 值 → Record（读端点的 data 都是 JSON 对象或 null）。 */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 从 data 里提取「列表」：data 本身是数组，或 {items:[...]}，缺省空数组。 */
function extractList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const items = asRecord(data)?.items;
  return Array.isArray(items) ? items : [];
}

/** 从 data 里提取字段（对象或数组都可），缺省 null。 */
function fieldOf(data: unknown, key: string): unknown {
  const r = asRecord(data);
  return r ? (r[key] ?? null) : null;
}

/**
 * GET /__admin/api/console/account/:id/billing
 * 五个子调用的服务端合并（fixture 对齐：billingStatus 带 balanceMicroCents /
 * promotional 系字段，billingAccount 带 creditLimitMicroCents，ledger /
 * paymentMethods 是数组，autoRecharge 是美元对象）。billingStatus 是主余额源；
 * 其余子调用失败只让对应字段为 null（观测设施哲学：一个子接口坏不拖垮汇总）。
 * cookieState 与通道健康绑定：missing/invalid 时不打上游，直接给空数据 + 状态。
 */
async function handleConsoleBilling(res: ServerResponse, deps: ConsoleDeps, accountId: number): Promise<void> {
  if (!consoleReadGuard(res, deps, accountId)) return;
  const client = deps.client!;
  const store = deps.store!;

  const state = consoleCookieState(store, accountId, client);
  if (state === 'missing') {
    sendJson(res, 200, {
      ok: true,
      data: {
        balance: null,
        promotional: null,
        autoRecharge: null,
        ledger: null,
        paymentMethods: null,
        cookieState: state,
      },
    });
    return;
  }
  // invalid（内存健康态标记）不短路：token 可能已轮换（重新 OAuth 登录），
  // 放请求过去自愈（成功 → recordOk 清标记）；真失效 → 再失败再标记。

  const [status, _account, recharge, ledger, payments] = await Promise.all([
    client.billingStatus(accountId),
    client.billingAccount(accountId),
    client.autoRecharge(accountId),
    client.billingLedger(accountId),
    client.paymentMethods(accountId),
  ]);

  if (status == null) {
    // 主余额源失败：cookieStatus 已同步更新 —— invalid 说明凭据失效（健康态
    // 通常已提前拦截，这里兜住竞态）；否则是真实上游故障。
    if (client.cookieStatus(accountId) === 'invalid') {
      // 区分失效通道：OAuth Bearer 失效 → oauth-invalid（面板提示重新授权）；
      // cookie 失效 → invalid（面板提示更新 cookie）。
      const invalidState = client.authChannel(accountId) === 'oauth' ? 'oauth-invalid' : 'invalid';
      sendJson(res, 200, {
        ok: true,
        data: {
          balance: null,
          promotional: null,
          autoRecharge: null,
          ledger: null,
          paymentMethods: null,
          cookieState: invalidState,
        },
      });
      return;
    }
    sendConsoleUpstreamError(res);
    return;
  }

  const statusRec = asRecord(status);
  const ledgerItems = extractList(ledger).slice(0, 20);
  sendJson(res, 200, {
    ok: true,
    data: {
      balance: microCentsToDollars(statusRec?.balanceMicroCents) ?? null,
      promotional: microCentsToDollars(statusRec?.promotionalAvailableMicroCents) ?? null,
      autoRecharge: recharge,
      ledger: ledgerItems.length > 0 ? ledgerItems : null,
      paymentMethods: payments,
      cookieState: 'ok',
    },
  });
}

/**
 * 解析 range 查询参数（usage 系列端点共用）：
 *   range=24h → 1 天（面板按钮档位，console 实测支持）
 *   range=Nd（1-90）→ N 天（与既有 usage 端点契约一致）
 * 缺省 7 天；非法 → null（调用方回 400）。
 * console 上游只认 24h/7d/30d，超出档位由 ConsoleClient 就近取档（usageRangeAndSince）。
 */
function parseRangeDays(query: string): number | null {
  const v = queryParam(query, 'range');
  if (v == null || v === '') return CONSOLE_USAGE_RANGE_DAYS;
  if (v === '24h') return 1;
  const m = /^(\d{1,3})d$/.exec(v);
  if (!m) return null;
  const days = Number(m[1]);
  return Number.isSafeInteger(days) && days >= 1 && days <= 90 ? days : null;
}

/** 解析 bucket 查询参数（cost-by-day 用）：day|hour，缺省 day；非法 → null。 */
function parseUsageBucket(query: string): 'day' | 'hour' | null {
  const v = queryParam(query, 'bucket');
  if (v == null || v === '') return 'day';
  return v === 'day' || v === 'hour' ? v : null;
}

/** 从 query 串里取参数值（按 & 拆，取 name=value 的 value；无该参数 → null）。 */
function queryParam(query: string, name: string): string | null {
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

/**
 * GET /__admin/api/console/account/:id/workspaces
 * 该账号可切换的 workspace 列表。新版 console REST API 是 x-org-id 定向的
 * （每个请求只针对一个 workspace），**没有「该账号的全部 workspace」列表端点**
 * （Bearer /api/orgs 只对 OAuth 账号可用且走另一套凭据体系）。最小可行实现：
 * 从账号库现有数据推断 —— 汇总所有已配置 workspaceId 的账号（{id, name}，
 * 按 workspaceId 去重），当前账号的 workspace 标注在 current；legacy 返回
 * 旧版控制台 workspace id（只读展示，不走切换）。面板据此渲染下拉列表，
 * 未覆盖到的 workspace 用「手动输入」兜底。
 */
async function handleConsoleWorkspaces(res: ServerResponse, deps: ConsoleDeps, accountId: number): Promise<void> {
  if (!consoleReadGuard(res, deps, accountId)) return;
  const store = deps.store!;
  const acc = store.get(accountId)!;
  const seen = new Set<string>();
  const items: Array<{ id: string; name: string }> = [];
  for (const a of store.list()) {
    if (!a.workspaceId || seen.has(a.workspaceId)) continue;
    seen.add(a.workspaceId);
    items.push({ id: a.workspaceId, name: a.name });
  }
  sendJson(res, 200, {
    ok: true,
    data: {
      items,
      current: acc.workspaceId,
      legacy: acc.legacyWorkspaceId,
    },
  });
}

/**
 * GET /__admin/api/console/account/:id/usage?range=7d
 * range 支持 `24h` 与 `Nd`（1-90），缺省 7。summary 透传 usageSummary 的 data；
 * byDay 由 cost-by-day 通道并行补齐（P0：原来恒 null 的缺口）——子通道失败只让
 * byDay 为 null，不拖垮 summary（观测设施哲学：一个子接口坏不拖汇总）。
 */
async function handleConsoleUsage(
  res: ServerResponse,
  deps: ConsoleDeps,
  accountId: number,
  query: string,
): Promise<void> {
  if (!consoleReadGuard(res, deps, accountId)) return;
  const rangeDays = parseRangeDays(query);
  if (rangeDays == null) {
    sendJson(res, 400, { error: { message: 'range must look like 24h or 7d (1-90 days)', type: 'invalid_request_error' } });
    return;
  }
  const bucket = parseUsageBucket(query);
  if (bucket == null) {
    sendJson(res, 400, { error: { message: 'bucket must be day or hour', type: 'invalid_request_error' } });
    return;
  }
  if (consoleNoCookie(res, deps, accountId)) return;

  const [summary, byDay] = await Promise.all([
    deps.client!.usageSummary(accountId, rangeDays),
    deps.client!.usageCostByDay(accountId, rangeDays, bucket),
  ]);
  if (summary == null) {
    sendConsoleReadFailure(res, deps.client!, accountId);
    return;
  }
  sendJson(res, 200, { ok: true, data: { summary, byDay: Array.isArray(byDay) ? byDay : null } });
}

/**
 * GET /__admin/api/console/account/:id/usage/cost-by-day?range=7d&bucket=day
 * 按日/小时成本时间序列（趋势图数据）。上游返回 DailyCost 数组
 * （{date, totalCostMicroCents, totalTokens, totalRequests}，金额 microCents
 * 字符串）→ 包成 {items}。
 */
async function handleConsoleUsageCostByDay(
  res: ServerResponse,
  deps: ConsoleDeps,
  accountId: number,
  query: string,
): Promise<void> {
  if (!consoleReadGuard(res, deps, accountId)) return;
  const rangeDays = parseRangeDays(query);
  if (rangeDays == null) {
    sendJson(res, 400, { error: { message: 'range must look like 24h or 7d (1-90 days)', type: 'invalid_request_error' } });
    return;
  }
  const bucket = parseUsageBucket(query);
  if (bucket == null) {
    sendJson(res, 400, { error: { message: 'bucket must be day or hour', type: 'invalid_request_error' } });
    return;
  }
  if (consoleNoCookie(res, deps, accountId)) return;
  const data = await deps.client!.usageCostByDay(accountId, rangeDays, bucket);
  if (data == null) {
    sendConsoleReadFailure(res, deps.client!, accountId);
    return;
  }
  sendJson(res, 200, { ok: true, data: { items: extractList(data) } });
}

/** GET .../usage/models?range=7d —— 按模型拆分 {items, pageInfo}。 */
async function handleConsoleUsageModels(
  res: ServerResponse,
  deps: ConsoleDeps,
  accountId: number,
  query: string,
): Promise<void> {
  const rangeDays = parseRangeDays(query);
  if (rangeDays == null) {
    sendJson(res, 400, { error: { message: 'range must look like 24h or 7d (1-90 days)', type: 'invalid_request_error' } });
    return;
  }
  await sendConsoleList(res, deps, accountId, (client) => client.usageModels(accountId, rangeDays));
}

/** GET .../usage/users?range=7d —— 按用户拆分 {items, pageInfo}。 */
async function handleConsoleUsageUsers(
  res: ServerResponse,
  deps: ConsoleDeps,
  accountId: number,
  query: string,
): Promise<void> {
  const rangeDays = parseRangeDays(query);
  if (rangeDays == null) {
    sendJson(res, 400, { error: { message: 'range must look like 24h or 7d (1-90 days)', type: 'invalid_request_error' } });
    return;
  }
  await sendConsoleList(res, deps, accountId, (client) => client.usageUsers(accountId, rangeDays));
}

/**
 * GET .../budgets/users-status —— 用户预算状态列表 {items}。
 * 上游返回 UserBudgetStatusWithUser 数组（实测：{scope, userId, email,
 * limitMicroCents, spentMicroCents, exceeded, resetsAt, source, updatedAt}，
 * 金额是 microCents 字符串，面板用 money() 换算 —— 与 summary/byDay 同口径）。
 */
async function handleConsoleBudgetsUsersStatus(res: ServerResponse, deps: ConsoleDeps, accountId: number): Promise<void> {
  if (!consoleReadGuard(res, deps, accountId)) return;
  if (consoleNoCookie(res, deps, accountId)) return;
  const data = await deps.client!.budgetsUsersStatus(accountId);
  if (data == null) {
    sendConsoleReadFailure(res, deps.client!, accountId);
    return;
  }
  sendJson(res, 200, { ok: true, data: { items: extractList(data) } });
}

/**
 * GET .../models-pricing —— AI SDK 格式模型定价表 {providers: {...}}。
 * 61 模型 cost/limit/capabilities（实测约 20KB），ConsoleClient 侧 10 分钟长缓存。
 */
async function handleConsoleModelsPricing(res: ServerResponse, deps: ConsoleDeps, accountId: number): Promise<void> {
  if (!consoleReadGuard(res, deps, accountId)) return;
  if (consoleNoCookie(res, deps, accountId)) return;
  const data = await deps.client!.modelPricing(accountId);
  if (data == null) {
    sendConsoleReadFailure(res, deps.client!, accountId);
    return;
  }
  sendJson(res, 200, { ok: true, data });
}

/** GET /__admin/api/console/account/:id/members —— {items, pageInfo}。 */
async function handleConsoleMembers(res: ServerResponse, deps: ConsoleDeps, accountId: number): Promise<void> {
  await sendConsoleList(res, deps, accountId, (client) => client.members(accountId, CONSOLE_PAGE_SIZE));
}

/** GET /__admin/api/console/account/:id/keys —— 服务账号列表 {items, pageInfo}。 */
async function handleConsoleKeysList(res: ServerResponse, deps: ConsoleDeps, accountId: number): Promise<void> {
  await sendConsoleList(res, deps, accountId, (client) => client.serviceAccounts(accountId, CONSOLE_PAGE_SIZE));
}

/** 读列表类端点的统一流程：guard → cookie → 调用 → {ok:true, items, pageInfo}。 */
async function sendConsoleList(
  res: ServerResponse,
  deps: ConsoleDeps,
  accountId: number,
  call: (client: ConsoleClientLike) => Promise<unknown | null>,
): Promise<void> {
  if (!consoleReadGuard(res, deps, accountId)) return;
  if (consoleNoCookie(res, deps, accountId)) return;
  const data = await call(deps.client!);
  if (data == null) {
    sendConsoleReadFailure(res, deps.client!, accountId);
    return;
  }
  sendJson(res, 200, {
    ok: true,
    data: {
      items: extractList(data),
      pageInfo: fieldOf(data, 'pageInfo') ?? null,
    },
  });
}

/** 读失败统一出口：cookieStatus invalid → channel_error（按失效通道给不同指引）；
 * 否则 upstream_error。 */
function sendConsoleReadFailure(res: ServerResponse, client: ConsoleClientLike, accountId: number): void {
  if (client.cookieStatus(accountId) === 'invalid') {
    if (client.authChannel(accountId) === 'oauth') {
      sendConsoleChannelError(
        res,
        'console channel auth failed: OAuth credential expired or revoked — sign in with OpenCode to re-authorize this account',
      );
      return;
    }
    sendConsoleChannelError(
      res,
      'console channel auth failed: console login expired or invalid — update this account\'s cookie or re-import from browser',
    );
    return;
  }
  sendConsoleUpstreamError(res);
}

/** GET /__admin/api/console/account/:id/providers —— 模型/供应商列表。 */
async function handleConsoleProviders(res: ServerResponse, deps: ConsoleDeps, accountId: number): Promise<void> {
  await sendConsoleList(res, deps, accountId, (client) => client.providers(accountId));
}

/** GET /__admin/api/console/account/:id/budgets —— {org, user}。 */
async function handleConsoleBudgets(res: ServerResponse, deps: ConsoleDeps, accountId: number): Promise<void> {
  if (!consoleReadGuard(res, deps, accountId)) return;
  if (consoleNoCookie(res, deps, accountId)) return;
  const data = await deps.client!.budgetsOrg(accountId);
  // /api/budgets/org 对未设置预算的 org 合法返回 null（fixture 实测）——
  // null 是「未设置」不是错误。区分「合法 null」与「调用失败」：查 lastError。
  if (data == null && deps.client!.lastError(accountId) != null) {
    sendConsoleReadFailure(res, deps.client!, accountId);
    return;
  }
  const org = data == null ? null : ((asRecord(data)?.org as unknown) ?? data);
  // ConsoleClient 无 budgetsUser 通道（fixture 有 budgets_user 响应但本轮未实现），
  // user 恒 null，面板按「未接入」展示。
  const user = data != null && typeof data === 'object' ? (fieldOf(data, 'user') ?? null) : null;
  sendJson(res, 200, { ok: true, data: { org, user } });
}

// ---------------------------------------------------------------------------
// console 写端点（统一流程 + 字段校验 + 审计）
// ---------------------------------------------------------------------------

/**
 * 金额字段校验（数字、有限、0 ≤ v ≤ 100 万）。null = 非法。
 * 上限 1,000,000 美元：防止手滑多打几个 0 / 恶意大额请求直达上游
 * （自动充值 = 真实扣款，月限额/充值额超上限没有业务意义）。
 */
function parseDollars(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1_000_000) return null;
  return v;
}

/** POST keys：{name} 非空字符串 ≤ 100。 */
function validateConsoleCreateKey(body: Record<string, unknown>): string | null {
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return 'name is required and must be a non-empty string';
  }
  if (body.name.trim().length > 100) return 'name must be at most 100 characters';
  return null;
}

/**
 * POST auto-recharge：{confirm:true, enabled:boolean, thresholdDollars?,
 * rechargeAmountDollars?}。confirm 语义（CONSOLE-PORT §6.4 auto-reload 档）：
 * 自动充值 = 自动扣款，服务端强制 confirm===true，缺失 400。enabled=true 时
 * 两个金额必填（自动充值没有金额没有意义）；enabled=false 时金额字段忽略
 * （传了仍校验格式）。
 */
function validateConsoleAutoRecharge(body: Record<string, unknown>): string | null {
  if (body.confirm !== true) return 'confirm must be true';
  if (typeof body.enabled !== 'boolean') return 'enabled must be a boolean';
  const threshold = body.thresholdDollars === undefined ? null : parseDollars(body.thresholdDollars);
  const amount = body.rechargeAmountDollars === undefined ? null : parseDollars(body.rechargeAmountDollars);
  if (threshold === null && body.thresholdDollars !== undefined) return 'thresholdDollars must be a number between 0 and 1000000';
  if (amount === null && body.rechargeAmountDollars !== undefined) return 'rechargeAmountDollars must be a number between 0 and 1000000';
  if (body.enabled && (threshold === null || amount === null)) {
    return 'thresholdDollars and rechargeAmountDollars are required when enabled';
  }
  return null;
}

/** POST monthly-limit：{limitDollars} 数字 0-100 万（0 = 取消限额）。 */
function validateConsoleMonthlyLimit(body: Record<string, unknown>): string | null {
  if (body.limitDollars === undefined || parseDollars(body.limitDollars) === null) {
    return 'limitDollars must be a number between 0 and 1000000';
  }
  return null;
}

/**
 * 带 body 的写操作统一流程：Origin → body → 校验 → 账户存在 → 调用 → 审计。
 * 审计在 executeConsoleWrite 里调用后落表（op/accountId/ok/note，值不进库）。
 */
async function runConsoleWrite(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleDeps,
  accountId: number,
  op: string,
  validate: (body: Record<string, unknown>) => string | null,
  call: (id: number, body: Record<string, unknown>) => Promise<ConsoleWriteResult>,
): Promise<void> {
  const read = await readBody(req, CONSOLE_BODY_MAX_BYTES);
  if (!read.ok) {
    // 观测：body 读取失败只打日志（console 写端点无 MetricsCtx）。
    console.log(`[proxy] body read fail (console write): ${read.status}`);
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    sendJson(res, 400, badBodyError(parsed.empty));
    return;
  }
  if (typeof parsed.body !== 'object' || parsed.body === null || Array.isArray(parsed.body)) {
    sendJson(res, 400, { error: { message: 'request body must be a JSON object', type: 'invalid_request_error' } });
    return;
  }
  const body = parsed.body as Record<string, unknown>;
  const bad = validate(body);
  if (bad != null) {
    sendJson(res, 400, { error: { message: bad, type: 'invalid_request_error' } });
    return;
  }
  if (!consoleWriteGuard(res, deps, accountId)) return;
  await executeConsoleWrite(res, deps, accountId, op, call, body);
}

/** 无 body 的写操作（DELETE keys/:saId）。 */
async function runConsoleWriteNoBody(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleDeps,
  accountId: number,
  op: string,
  call: (id: number) => Promise<ConsoleWriteResult>,
): Promise<void> {
  // 消费请求体（不读会破坏 keep-alive）。
  const read = await readBody(req, CONSOLE_BODY_MAX_BYTES);
  if (!read.ok) {
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  if (!consoleWriteGuard(res, deps, accountId)) return;
  await executeConsoleWrite(res, deps, accountId, op, call, {});
}

/** 写操作前置：通道接线 + 数据面 + 账户存在。 */
function consoleWriteGuard(res: ServerResponse, deps: ConsoleDeps, accountId: number): boolean {
  if (!deps.client) {
    sendConsoleChannelError(res, 'console channel not wired');
    return false;
  }
  if (deps.store == null || !deps.store.enabled) {
    sendJson(res, 503, {
      error: {
        message: deps.store == null ? 'accounts module not wired' : `accounts unavailable: ${deps.store.disabledReason ?? 'unknown'}`,
        type: 'server_error',
      },
    });
    return false;
  }
  if (!deps.store.get(accountId)) {
    sendJson(res, 404, { error: { message: 'account not found', type: 'not_found_error' } });
    return false;
  }
  return true;
}

/**
 * 调用 + 统一响应。审计在**调用后**记录（M4：写操作结果必须落库才能回答
 * 「这个操作到底成没成」）：console.log 保留旧格式（时间点移到调用后），
 * admin_audit 表记 op/accountId/ok/note 摘要 —— 绝不记金额/cookie。
 * 审计失败不阻断操作（观测设施哲学）。
 */
async function executeConsoleWrite(
  res: ServerResponse,
  deps: ConsoleDeps,
  accountId: number,
  op: string,
  call: (id: number, body: Record<string, unknown>) => Promise<ConsoleWriteResult>,
  body: Record<string, unknown>,
): Promise<void> {
  const r = await call(accountId, body);
  const ok = r.ok;
  const note = ok ? null : r.reason;
  console.log(`[admin] op=${op} account=${accountId} by=local`);
  deps.db?.insertAdminAudit({ at: Date.now(), op, accountId, ok, note });
  if (!r.ok) {
    // auth / no-cookie / no-workspace = 通道不可用；upstream / parse = 上游故障。
    if (r.reason === 'auth' || r.reason === 'no-cookie' || r.reason === 'no-workspace') {
      sendConsoleChannelError(res, `console channel unavailable: ${r.reason}`);
    } else {
      sendConsoleUpstreamError(res);
    }
    return;
  }
  sendJson(res, 200, { ok: true });
}

/**
 * POST /__admin/api/console/import-cookie
 * body {accountId}。调 importCookieFromChrome(9223) 从共享 Chrome 抓 auth
 * cookie，服务端直接写进 store —— **cookie 值绝不进响应与日志**。
 */
async function handleConsoleImportCookie(req: IncomingMessage, res: ServerResponse, deps: ConsoleDeps): Promise<void> {
  const read = await readBody(req, CONSOLE_BODY_MAX_BYTES);
  if (!read.ok) {
    // 观测：body 读取失败只打日志（console 端点无 MetricsCtx）。
    console.log(`[proxy] body read fail (console import-cookie): ${read.status}`);
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    sendJson(res, 400, badBodyError(parsed.empty));
    return;
  }
  if (typeof parsed.body !== 'object' || parsed.body === null || Array.isArray(parsed.body)) {
    sendJson(res, 400, { error: { message: 'request body must be a JSON object', type: 'invalid_request_error' } });
    return;
  }
  const accountId = parseAccountId(String((parsed.body as Record<string, unknown>).accountId ?? ''));
  if (accountId == null) {
    sendJson(res, 400, { error: { message: 'accountId must be a positive integer', type: 'invalid_request_error' } });
    return;
  }
  if (deps.importCookie == null) {
    sendConsoleChannelError(res, 'cookie import not wired');
    return;
  }
  if (!consoleWriteGuard(res, deps, accountId)) return;

  console.log(`[admin] op=import-cookie account=${accountId} by=local`);
  const r = await deps.importCookie(CONSOLE_CHROME_CDP_PORT);
  if ('auth' in r) {
    // B1：store 的 cookie 语义 = 完整 name=value 原样落库（CDP 拿到的是
    // `__Host-console_session=x` 或 `auth=x`，不再剥前缀）。billing 通道发送时
    // 原样带出，console 通道同样原样 —— 一个值两通道都能用。
    const saved = deps.store!.update(accountId, { cookie: r.auth });
    // 审计在调用后记录（note 只放细分类别，绝不落 cookie 值）。
    deps.db?.insertAdminAudit({
      at: Date.now(),
      op: 'import-cookie',
      accountId,
      ok: saved,
      note: saved ? null : 'save failed',
    });
    if (!saved) {
      sendJson(res, 200, { ok: false, reason: 'save failed' });
      return;
    }
    // 新 cookie 已落库 → 重置 console 健康态（清 invalid 标记 + 读缓存）。
    // 否则旧 invalid 标记会让 getCredentials 跳过新 cookie、通道继续锁死在
    // auth 失败（与 PATCH 换 cookie 的 H2 修复同一条路）。
    deps.client?.noteCredentialChanged?.(accountId);
    sendJson(res, 200, { ok: true, imported: true });
    return;
  }
  // 抓取失败：reason 是分类标签（'port'|'no-target'|'no-cookie'|'ws'），不是值。
  deps.db?.insertAdminAudit({ at: Date.now(), op: 'import-cookie', accountId, ok: false, note: r.reason });
  sendJson(res, 200, { ok: false, reason: r.reason });
}

// ---------------------------------------------------------------------------
// 旧版控制台（opencode.ai，wrk_ 前缀 workspace）key + Go + billing 端点
// ---------------------------------------------------------------------------
//
// 协议事实（2026-08-11/12 浏览器实测，见 src/legacy.ts 文件头）：
// - 读：GET /workspace/{id}/keys（带 cookie）→ HTML，key 列表在 SSR 水合里；
// - 写：POST /_server + X-Server-Id 头 + urlencoded body（创建/删除各一个函数）；
// - Go 页（/workspace/{id}/go）：订阅状态 + 三窗口用量在 SSR 水合
//   （lite.subscription.get），中国模型开关状态在 checkbox 的 checked 属性，
//   两个开关（useBalance / useChinaProviders）各是一个 /_server 函数；
// - billing 页（/workspace/{id}/billing）：余额 + 自动充值 + 支付历史在
//   SSR 水合（billing.get / payment.list），只读。
// 端点层只做凭据组装（cookie / legacy workspace id 从 store 解密，进程内），
// 具体请求交给注入的 LegacyClientLike（src/legacy.ts 纯函数适配）。cookie
// 值绝不出现在响应与日志。

/** legacy 通道的失败分类（形状对齐 src/legacy.ts 的 LegacyWriteResult）。 */
export type LegacyWriteResult =
  | { ok: true }
  | { ok: false; reason: 'no-cookie' | 'wrong-console' | 'auth' | 'upstream' };

/** legacy 读的结果（形状对齐 src/legacy.ts 的 LegacyReadResult）。 */
export type LegacyReadResult =
  | { ok: true; keys: LegacyKeyRow[]; deleteServerId: string | null }
  | { ok: false; reason: 'no-cookie' | 'wrong-console' | 'auth' | 'upstream' | 'parse' };

/** 一条旧版 key 的展示视图（绝不含 key 明文）。 */
export interface LegacyKeyRow {
  id: string;
  name: string;
  masked: string;
  creatorEmail: string | null;
}

/** 一条旧版 key 的明文（只经 /keys/plain 端点返回，绝不落库/进日志）。 */
export interface LegacyPlainKey {
  id: string;
  name: string;
  key: string;
}

/**
 * legacy keys 明文缓存的最小接口假设（duck typing：main.ts 注入
 * LegacyPlainCache，端点只依赖 get/clear；填充由 client 适配器完成）。
 */
export interface LegacyPlainCacheLike {
  get(accountId: number): LegacyPlainKey[] | null;
  clear(accountId: number): void;
}

/** Go 订阅的一个用量窗口（形状对齐 src/legacy.ts 的 GoUsageWindow）。 */
export interface GoUsageWindow {
  status: string;
  resetInSec: number;
  usagePercent: number;
}

/** Go 订阅状态（形状对齐 src/legacy.ts 的 LegacyGoStatus）。 */
export interface LegacyGoStatus {
  subscribed: boolean;
  useBalance: boolean;
  chinaModels: boolean;
  rolling: GoUsageWindow | null;
  weekly: GoUsageWindow | null;
  monthly: GoUsageWindow | null;
}

/** Go 状态读的结果（形状对齐 src/legacy.ts 的 LegacyGoReadResult）。 */
export type LegacyGoReadResult =
  | { ok: true; status: LegacyGoStatus }
  | { ok: false; reason: 'no-cookie' | 'wrong-console' | 'auth' | 'upstream' | 'parse' };

/** 自动充值配置（形状对齐 src/legacy.ts 的 LegacyBillingReload）。 */
export interface LegacyBillingReload {
  enabled: boolean;
  thresholdDollars: number;
  amountDollars: number;
}

/** 一条支付记录（形状对齐 src/legacy.ts 的 LegacyBillingPayment）。 */
export interface LegacyBillingPayment {
  amount: number;
  date: string | null;
  description: string | null;
}

/** 旧版 billing 读的结果（形状对齐 src/legacy.ts 的 LegacyBilling）。 */
export interface LegacyBilling {
  balanceDollars: number;
  reload: LegacyBillingReload | null;
  payments: LegacyBillingPayment[];
  monthlyLimitDollars: number | null;
}

/** billing 读的结果（形状对齐 src/legacy.ts 的 LegacyBillingReadResult）。 */
export type LegacyBillingReadResult =
  | { ok: true; billing: LegacyBilling }
  | { ok: false; reason: 'no-cookie' | 'wrong-console' | 'auth' | 'upstream' | 'parse' };

/**
 * 旧版控制台数据层的最小接口假设（duck typing，不 import legacy.ts，
 * 避免两个模块互相依赖；与 ConsoleClientLike 同一套路）。cookie 与
 * workspaceId 由端点层从 store 解密后传入 —— 明文只在进程内流转。
 */
export interface LegacyClientLike {
  listKeys(accountId: number, cookie: string | null, workspaceId: string): Promise<LegacyReadResult>;
  createKey(accountId: number, cookie: string | null, workspaceId: string, name: string): Promise<LegacyWriteResult>;
  deleteKey(accountId: number, cookie: string | null, workspaceId: string, keyId: string): Promise<LegacyWriteResult>;
  getGoStatus(accountId: number, cookie: string | null, workspaceId: string): Promise<LegacyGoReadResult>;
  setGoToggle(accountId: number, cookie: string | null, workspaceId: string, toggle: 'useBalance' | 'chinaModels', value: boolean): Promise<LegacyWriteResult>;
  getBilling(accountId: number, cookie: string | null, workspaceId: string): Promise<LegacyBillingReadResult>;
}

/** legacy 路由的依赖集合（createApp 注入点透传）。 */
interface LegacyDeps {
  store: AccountsStore | null;
  client: LegacyClientLike | undefined;
  /** 用量库（管理审计落表；未接线/null = 审计只走 console.log，不阻断操作）。 */
  db: UsageDb | null;
  /** keys 明文的内存缓存（/keys/plain 端点专用；未接线 → fail-closed 502）。 */
  plainCache: LegacyPlainCacheLike | undefined;
}

/**
 * /__admin/api/legacy 全部分派。路径形状：
 *   account/:id/keys            （GET 读 / POST 创建）
 *   account/:id/keys/:keyId     （DELETE 删除）
 * 写操作统一先过 adminOriginAllowed（与 console 端点同款）。
 */
async function handleLegacyRoutes(req: IncomingMessage, res: ServerResponse, deps: LegacyDeps): Promise<void> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const rest = path.slice('/__admin/api/legacy/'.length);

  if (req.method !== 'GET' && !adminOriginAllowed(req)) {
    sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
    return;
  }

  if (!rest.startsWith('account/')) {
    sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
    return;
  }
  const segs = rest.slice('account/'.length).split('/');
  const accountId = parseAccountId(segs[0] ?? '');
  if (accountId == null) {
    sendJson(res, 400, { error: { message: 'account id must be a positive integer', type: 'invalid_request_error' } });
    return;
  }
  const sub = segs[1];

  // keys/plain 是「完整 key 明文」端点（复制用），比 keys/go 读敏感得多
  // （凭证级），读也强制 Origin 校验（与 billing 同款）。必须在子路径为
  // `keys` 的 GET 分支之前判断，否则会被 keys 列表 handler 吃掉。
  if (sub === 'keys' && segs[2] === 'plain' && req.method === 'GET') {
    if (!adminOriginAllowed(req)) {
      sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
      return;
    }
    await handleLegacyPlainKeys(res, deps, accountId);
    return;
  }

  if (sub === 'keys' && req.method === 'GET') {
    await handleLegacyKeysList(res, deps, accountId);
    return;
  }
  if (sub === 'go' && segs.length === 2 && req.method === 'GET') {
    await handleLegacyGoStatus(res, deps, accountId);
    return;
  }
  // billing 是财务读端点：与 keys/go 不同，读也强制 Origin 校验（防跨站
  // 读取余额/支付历史等敏感数据；keys/go 的读取量级和敏感度较低不设）。
  if (sub === 'billing' && segs.length === 2 && req.method === 'GET') {
    if (!adminOriginAllowed(req)) {
      sendJson(res, 403, { error: { message: 'cross-origin requests are not allowed', type: 'authentication_error' } });
      return;
    }
    await handleLegacyBilling(res, deps, accountId);
    return;
  }
  if (sub === 'go' && segs[2] === 'use-balance' && req.method === 'POST') {
    await runLegacyGoToggle(req, res, deps, accountId, 'legacy.go.use-balance', 'useBalance');
    return;
  }
  if (sub === 'go' && segs[2] === 'china-models' && req.method === 'POST') {
    await runLegacyGoToggle(req, res, deps, accountId, 'legacy.go.china-models', 'chinaModels');
    return;
  }
  if (sub === 'keys' && req.method === 'POST') {
    await runLegacyWrite(req, res, deps, accountId, 'legacy.key.create', async (cookie, ws, body) => {
      const name = (body as { name: unknown }).name;
      if (typeof name !== 'string' || name.trim() === '') {
        sendJson(res, 400, { error: { message: 'name is required and must be a non-empty string', type: 'invalid_request_error' } });
        return null;
      }
      if (name.trim().length > 100) {
        sendJson(res, 400, { error: { message: 'name must be at most 100 characters', type: 'invalid_request_error' } });
        return null;
      }
      return deps.client!.createKey(accountId, cookie, ws, name.trim());
    });
    return;
  }
  if (sub === 'keys' && req.method === 'DELETE') {
    // m4 同款防护：畸形 % 编码（如 %zz）会让 decodeURIComponent 抛 URIError。
    let keyId: string;
    try {
      keyId = decodeURIComponent(segs[2] ?? '');
    } catch {
      sendJson(res, 400, { error: { message: 'invalid key id encoding', type: 'invalid_request_error' } });
      return;
    }
    // keyId 必须是页面返回的 key_ 形式（删除协议按 id 精确删除，不是名称）。
    if (!/^key_[A-Za-z0-9]{10,100}$/.test(keyId)) {
      sendJson(res, 400, { error: { message: 'key id must be a key_ prefixed id from the keys list', type: 'invalid_request_error' } });
      return;
    }
    await runLegacyWriteNoBody(req, res, deps, accountId, 'legacy.key.remove', async (cookie, ws) =>
      deps.client!.deleteKey(accountId, cookie, ws, keyId),
    );
    return;
  }

  sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
}

/** legacy 端点前置检查：通道接线 → 数据面 → 账户存在。返回 null = 通过。 */
function legacyGuard(res: ServerResponse, deps: LegacyDeps, accountId: number): boolean {
  if (!deps.client) {
    sendConsoleChannelError(res, 'legacy channel not wired');
    return false;
  }
  if (deps.store == null || !deps.store.enabled) {
    sendJson(res, 503, {
      error: {
        message: deps.store == null ? 'accounts module not wired' : `accounts unavailable: ${deps.store.disabledReason ?? 'unknown'}`,
        type: 'server_error',
      },
    });
    return false;
  }
  if (!deps.store.get(accountId)) {
    // 账号已被删除（admin.ts 删除路径不经过这里）：清掉明文缓存残留，
    // 防止已删账号的明文继续留在内存里直到 TTL。TTL + 上限仍是兜底。
    deps.plainCache?.clear(accountId);
    sendJson(res, 404, { error: { message: 'account not found', type: 'not_found_error' } });
    return false;
  }
  return true;
}

/**
 * legacy 写操作统一流程：Origin（已前置）→ body → 校验 → 前置检查 →
 * 凭据组装 → 调用 → 审计。call 返回 null 表示已在内部回错（校验失败）。
 */
async function runLegacyWrite(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LegacyDeps,
  accountId: number,
  op: string,
  call: (cookie: string | null, workspaceId: string, body: Record<string, unknown>) => Promise<LegacyWriteResult | null>,
): Promise<void> {
  const read = await readBody(req, CONSOLE_BODY_MAX_BYTES);
  if (!read.ok) {
    console.log(`[proxy] body read fail (legacy write): ${read.status}`);
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    sendJson(res, 400, badBodyError(parsed.empty));
    return;
  }
  if (typeof parsed.body !== 'object' || parsed.body === null || Array.isArray(parsed.body)) {
    sendJson(res, 400, { error: { message: 'request body must be a JSON object', type: 'invalid_request_error' } });
    return;
  }
  const body = parsed.body as Record<string, unknown>;
  if (!legacyGuard(res, deps, accountId)) return;
  const ws = deps.store!.legacyWorkspaceIdOf(accountId);
  if (!ws) {
    // 404 = 该账号没有旧版工作区（env 代理等），前端静默隐藏区块——不是错误。
    sendJson(res, 404, { error: { message: 'legacy workspace not configured for this account', type: 'not_found_error' } });
    return;
  }
  const cookie = deps.store!.cookieOf(accountId);
  const r = await call(cookie, ws, body);
  if (r === null) return;
  const ok = r.ok;
  console.log(`[admin] op=${op} account=${accountId} by=local`);
  deps.db?.insertAdminAudit({ at: Date.now(), op, accountId, ok, note: ok ? null : r.reason });
  if (!r.ok) {
    sendLegacyChannelError(res, r.reason);
    return;
  }
  sendJson(res, 200, { ok: true });
}

/** 无 body 的写操作（DELETE keys/:keyId）——消费 body 但不解析（DELETE 无 body）。 */
async function runLegacyWriteNoBody(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LegacyDeps,
  accountId: number,
  op: string,
  call: (cookie: string | null, workspaceId: string) => Promise<LegacyWriteResult>,
): Promise<void> {
  const read = await readBody(req, CONSOLE_BODY_MAX_BYTES);
  if (!read.ok) {
    console.log(`[proxy] body read fail (legacy write): ${read.status}`);
    sendJson(res, read.status, {
      error: { message: BODY_READ_STATUS_MESSAGE[read.status] ?? 'request body read failed', type: 'invalid_request_error' },
    });
    return;
  }
  if (!legacyGuard(res, deps, accountId)) return;
  const ws = deps.store!.legacyWorkspaceIdOf(accountId);
  if (!ws) {
    // 404 = 该账号没有旧版工作区（env 代理等），前端静默隐藏区块——不是错误。
    sendJson(res, 404, { error: { message: 'legacy workspace not configured for this account', type: 'not_found_error' } });
    return;
  }
  const cookie = deps.store!.cookieOf(accountId);
  const r = await call(cookie, ws);
  const ok = r.ok;
  console.log(`[admin] op=${op} account=${accountId} by=local`);
  deps.db?.insertAdminAudit({ at: Date.now(), op, accountId, ok, note: ok ? null : r.reason });
  if (!r.ok) {
    sendLegacyChannelError(res, r.reason);
    return;
  }
  sendJson(res, 200, { ok: true });
}

/** 读端点：GET /__admin/api/legacy/account/:id/keys。 */
async function handleLegacyKeysList(res: ServerResponse, deps: LegacyDeps, accountId: number): Promise<void> {
  if (!legacyGuard(res, deps, accountId)) return;
  const ws = deps.store!.legacyWorkspaceIdOf(accountId);
  if (!ws) {
    // 404 = 该账号没有旧版工作区（env 代理等），前端静默隐藏区块——不是错误。
    sendJson(res, 404, { error: { message: 'legacy workspace not configured for this account', type: 'not_found_error' } });
    return;
  }
  const cookie = deps.store!.cookieOf(accountId);
  const r = await deps.client!.listKeys(accountId, cookie, ws);
  if (!r.ok) {
    sendLegacyChannelError(res, r.reason);
    return;
  }
  // key 列表本身不含明文（legacy.ts 解析时已剥掉 key 字段），可放心透传。
  sendJson(res, 200, { ok: true, data: { keys: r.keys } });
}

/**
 * 读端点：GET /__admin/api/legacy/account/:id/keys/plain —— 旧版 key 明文复制。
 *
 * 设计（任务契约）：明文**只存内存缓存**（LegacyPlainCache，main.ts 适配器在
 * 每次成功抓取后经 onPlain 填充）。优先返回缓存；缓存缺失时实时抓一次（复用
 * client.listKeys —— 其抓取会顺带刷新缓存），再取缓存返回。抓取失败/无 cookie
 * 走统一 legacy 错误；缓存未接线时 fail-closed（明文只能经内存缓存出，绝不
 * 落库/进日志/进掩码端点）。响应是裸 JSON 数组 [{id,name,key}]（复制用契约）。
 */
async function handleLegacyPlainKeys(res: ServerResponse, deps: LegacyDeps, accountId: number): Promise<void> {
  if (!legacyGuard(res, deps, accountId)) return;
  if (!deps.plainCache) {
    sendConsoleChannelError(res, 'legacy plain-key cache not wired');
    return;
  }
  const ws = deps.store!.legacyWorkspaceIdOf(accountId);
  if (!ws) {
    // 404 = 该账号没有旧版工作区（env 代理等），前端静默隐藏区块——不是错误。
    sendJson(res, 404, { error: { message: 'legacy workspace not configured for this account', type: 'not_found_error' } });
    return;
  }
  const cookie = deps.store!.cookieOf(accountId);
  const cached = deps.plainCache.get(accountId);
  if (cached) {
    sendJson(res, 200, cached);
    return;
  }
  const r = await deps.client!.listKeys(accountId, cookie, ws);
  if (!r.ok) {
    // 实时抓取失败：清掉可能残留的过期/半截条目，绝不返回抓不到的证据。
    deps.plainCache.clear(accountId);
    sendLegacyChannelError(res, r.reason);
    return;
  }
  // listKeys 的抓取已刷新缓存；解析到明文就返回，空列表/无明文返回 []。
  sendJson(res, 200, deps.plainCache.get(accountId) ?? []);
}

/** 读端点：GET /__admin/api/legacy/account/:id/go（订阅状态 + 三窗口用量 + 开关）。 */
async function handleLegacyGoStatus(res: ServerResponse, deps: LegacyDeps, accountId: number): Promise<void> {
  if (!legacyGuard(res, deps, accountId)) return;
  const ws = deps.store!.legacyWorkspaceIdOf(accountId);
  if (!ws) {
    // 404 = 该账号没有旧版工作区（env 代理等），前端静默隐藏区块——不是错误。
    sendJson(res, 404, { error: { message: 'legacy workspace not configured for this account', type: 'not_found_error' } });
    return;
  }
  const cookie = deps.store!.cookieOf(accountId);
  const r = await deps.client!.getGoStatus(accountId, cookie, ws);
  if (!r.ok) {
    sendLegacyChannelError(res, r.reason);
    return;
  }
  sendJson(res, 200, { ok: true, data: { go: r.status } });
}

/** 读端点：GET /__admin/api/legacy/account/:id/billing（余额 + 自动充值 + 支付历史）。 */
async function handleLegacyBilling(res: ServerResponse, deps: LegacyDeps, accountId: number): Promise<void> {
  if (!legacyGuard(res, deps, accountId)) return;
  const ws = deps.store!.legacyWorkspaceIdOf(accountId);
  if (!ws) {
    // 404 = 该账号没有旧版工作区（env 代理等），前端静默隐藏区块——不是错误。
    sendJson(res, 404, { error: { message: 'legacy workspace not configured for this account', type: 'not_found_error' } });
    return;
  }
  const cookie = deps.store!.cookieOf(accountId);
  const r = await deps.client!.getBilling(accountId, cookie, ws);
  if (!r.ok) {
    sendLegacyChannelError(res, r.reason);
    return;
  }
  sendJson(res, 200, { ok: true, data: { billing: r.billing } });
}

/**
 * Go 开关写端点（POST .../go/use-balance 与 .../go/china-models 共用）：
 * 复用 runLegacyWrite 的统一流程（Origin → body → 校验 → 凭据 → 审计），
 * 只多一步 enabled 布尔校验。
 */
async function runLegacyGoToggle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LegacyDeps,
  accountId: number,
  op: string,
  toggle: 'useBalance' | 'chinaModels',
): Promise<void> {
  await runLegacyWrite(req, res, deps, accountId, op, async (cookie, ws, body) => {
    if (typeof body.enabled !== 'boolean') {
      sendJson(res, 400, { error: { message: 'enabled must be a boolean', type: 'invalid_request_error' } });
      return null;
    }
    return deps.client!.setGoToggle(accountId, cookie, ws, toggle, body.enabled);
  });
}

/** legacy 失败分类 → 统一错误响应。 */
function sendLegacyChannelError(res: ServerResponse, reason: 'no-cookie' | 'wrong-console' | 'auth' | 'upstream' | 'parse'): void {
  switch (reason) {
    case 'no-cookie':
      sendConsoleChannelError(res, 'legacy channel not available: no cookie');
      break;
    case 'wrong-console':
      sendConsoleChannelError(res, 'legacy console cookie not configured (need the auth= cookie from opencode.ai, not __Host-console_session)');
      break;
    case 'auth':
      sendConsoleChannelError(res, 'legacy channel auth failed: opencode.ai login expired or invalid — update the account cookie (auth= cookie from opencode.ai, not __Host-console_session)');
      break;
    case 'upstream':
    case 'parse':
      sendConsoleUpstreamError(res);
      break;
  }
}

/**
 * 上下文超限 400 的错误改写（对 Claude Code 的兼容修复，P0）：
 * 匹配上游的 "maximum context length" / "context_length_exceeded" 类错误，
 * 把 message 改写成 Claude Code 认识的 Anthropic 措辞（"prompt is too long"），
 * 触发 CC 的自动恢复链（缩 max_tokens → 本地 compact）。保留状态码、错误
 * 类型与原始错误文本（附在后面，不丢信息）。
 *
 * 参考（研究结论）：
 * - code.claude.com/docs/en/errors：CC 的 retry logic 匹配上游错误措辞，
 *   "prompt is too long" / "Input is too long" 触发恢复链
 * - kiro2cc-proxy（生产）同样做错误改写（handlers.rs），诱导客户端 compact
 */
export function rewriteContextOverflow(raw: string): string {
  return rewriteContextOverflowImpl(raw).text;
}

/**
 * 带改写标志的内部实现：对外契约保持 `rewriteContextOverflow(raw) -> string`，
 * 调用方（直通错误出口）需要知道「这次是否真的改写了」来喂观测计数
 * （/__metrics summary.rewritten）。改写 = 错误文本命中上下文超限措辞且被
 * 改成 "prompt is too long"；已是该措辞（幂等返回）不算改写。
 */
function rewriteContextOverflowImpl(raw: string): { text: string; rewrote: boolean } {
  if (!raw) return { text: raw, rewrote: false };
  const lower = raw.toLowerCase();
  if (
    !lower.includes('maximum context length') &&
    !lower.includes('context_length_exceeded') &&
    !lower.includes('context length is') &&
    !lower.includes('prompt is too long')
  ) {
    return { text: raw, rewrote: false };
  }
  // 已经是 CC 认识的措辞（或已改写过）——原样返回。
  if (lower.includes('prompt is too long')) return { text: raw, rewrote: false };
  // 保留原始错误文本（已附在改写后 message 里），同时尝试替换 JSON 里的 message 字段。
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown; type?: unknown } };
    if (parsed.error && typeof parsed.error.message === 'string') {
      parsed.error.message = `prompt is too long: ${parsed.error.message}`;
      parsed.error.type = parsed.error.type ?? 'invalid_request_error';
      return { text: JSON.stringify(parsed), rewrote: true };
    }
  } catch {
    /* 非 JSON（SSR 错误页等）——按文本替换兜底 */
  }
  return {
    text: raw.replace(
      /(This model's maximum context length is \d+ tokens\. However, you requested \d+ tokens)/i,
      'prompt is too long: $1',
    ),
    rewrote: true,
  };
}
