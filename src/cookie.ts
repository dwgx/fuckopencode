/**
 * 从本机 Chrome 导入 console.opencode.ai 的 auth cookie（**仅本机开发场景**）。
 *
 * 线上 VPS 没有用户浏览器，这个模块只在本机跑网关 + 面板时有用：
 * 一键把浏览器里已登录控制台的 cookie 灌进账户，省去手工复制粘贴。
 *
 * 通道：CDP（Chrome DevTools Protocol）—— Chrome 需以
 * `--remote-debugging-port=<port>` 启动（共享 Chrome 惯例连 9223）；先 GET
 * http://127.0.0.1:{port}/json/list 拿 page target 的 webSocketDebuggerUrl，
 * 再 WebSocket 调 Network.getAllCookies，取 console.opencode.ai 域下 name=auth
 * 的 cookie 值。Node 22 有全局 WebSocket 和 fetch，零依赖。
 *
 * 失败原因明确：端口不通 / 无 page target / 无 console 域 cookie / WS 出错。
 * cookie 值只作为返回值传递，绝不进日志、绝不出现在任何异常消息里。
 */

import type { FetchLike } from './billing.js';

/** CDP /json/list 返回的 target 行（只取我们用得到的字段）。 */
export interface CdpPageTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string | null;
}

/** importCookieFromChrome 的结果：成功带 auth cookie 值；失败带细分原因。 */
export type CookieImportResult =
  | { auth: string }
  | { ok: false; reason: 'port' | 'no-target' | 'no-cookie' | 'ws' };

/** /json/list 的请求超时（端口不通时快速失败）。 */
const TARGETS_TIMEOUT_MS = 5_000;

/** CDP Network.getAllCookies 的响应等待超时。 */
const WS_TIMEOUT_MS = 5_000;

/**
 * 从 Network.getAllCookies 响应里挑 console 会话 cookie，返回完整 `name=value` 串。
 * 纯函数（单测直接喂假数据）：
 * - 新版控制台（2026-08 线上）会话 cookie 是 `__Host-console_session`
 *   （host-only + secure），旧版是 `auth`（opencode.ai 域 Iron 会话）——两个都认；
 * - domain 接受 host-only `console.opencode.ai` 与通配 `.opencode.ai`；
 * - 返回完整 `name=value`（__Host- 前缀 cookie 必须带名前缀才能生效）；
 * - 无命中 / 结构不符 → null。
 */
export function parseCookiesFromCdpResponse(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const result = (data as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null) return null;
  const cookies = (result as { cookies?: unknown }).cookies;
  if (!Array.isArray(cookies)) return null;
  // 两遍扫描：先找新版会话 cookie（__Host-console_session，host-only+secure，
  // 新版控制台 API 的鉴权凭据），找不到再退回旧版 auth（opencode.ai Iron 会话）。
  // Chrome 的 cookies 数组顺序不定，不能依赖第一命中。
  for (const want of ['__Host-console_session', 'auth'] as const) {
    for (const item of cookies) {
      if (typeof item !== 'object' || item === null) continue;
      const c = item as { name?: unknown; value?: unknown; domain?: unknown };
      if (c.name !== want || typeof c.value !== 'string' || c.value === '') continue;
      if (typeof c.domain !== 'string') continue;
      if (isConsoleDomain(c.domain)) return `${c.name}=${c.value}`;
    }
  }
  return null;
}

/**
 * GET http://127.0.0.1:{port}/json/list 拿全部 page target。
 * 端口不通 / 非 2xx / 响应不是数组 → null（调用方报 reason 'port'）。
 */
export async function getChromeTargets(
  port: number,
  fetchImpl: FetchLike = fetch,
): Promise<CdpPageTarget[] | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(TARGETS_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return null;
    const out: CdpPageTarget[] = [];
    for (const t of data) {
      if (typeof t !== 'object' || t === null) continue;
      const src = t as { type?: unknown; url?: unknown; webSocketDebuggerUrl?: unknown };
      out.push({
        type: typeof src.type === 'string' ? src.type : '',
        url: typeof src.url === 'string' ? src.url : '',
        webSocketDebuggerUrl:
          typeof src.webSocketDebuggerUrl === 'string' ? src.webSocketDebuggerUrl : null,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 一键导入：连 CDP 拿 page target → Network.getAllCookies → 解析 auth cookie。
 *
 * 只做一页的取数（会话 cookie 在任一 page target 的 Network domain 里都有），
 * 优先 type=page 的 target。WS 层失败统一报 'ws'（细节不进返回，无敏感内容）。
 */
export async function importCookieFromChrome(
  port: number,
  opts: { fetchImpl?: FetchLike; wsTimeoutMs?: number } = {},
): Promise<CookieImportResult> {
  const targets = await getChromeTargets(port, opts.fetchImpl);
  if (!targets) return { ok: false, reason: 'port' };
  const page =
    targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ??
    targets.find((t) => t.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) return { ok: false, reason: 'no-target' };
  try {
    const msg = await cdpGetAllCookies(page.webSocketDebuggerUrl, opts.wsTimeoutMs ?? WS_TIMEOUT_MS);
    const auth = parseCookiesFromCdpResponse(msg);
    return auth ? { auth } : { ok: false, reason: 'no-cookie' };
  } catch {
    return { ok: false, reason: 'ws' };
  }
}

/**
 * WebSocket 调 CDP Network.getAllCookies，等 id=1 的响应后返回整条消息。
 * 超时 / 连接失败 → reject（调用方归为 'ws'）。
 */
function cdpGetAllCookies(wsUrl: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('cdp timeout'));
    }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg: unknown = JSON.parse(String(ev.data));
        if (typeof msg === 'object' && msg !== null && (msg as { id?: unknown }).id === 1) {
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        }
      } catch {
        // 非 JSON 的推送消息（事件等）忽略，继续等 id=1 的响应。
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('cdp ws error'));
    };
  });
}

/** domain 是否属于 console.opencode.ai（host-only 或 .opencode.ai 通配，含根域）。 */
function isConsoleDomain(domain: string): boolean {
  const d = domain.startsWith('.') ? domain.slice(1) : domain;
  return d === 'opencode.ai' || d.endsWith('.opencode.ai');
}
