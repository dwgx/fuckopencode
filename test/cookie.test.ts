import { describe, expect, it, vi } from 'vitest';
import { getChromeTargets, parseCookiesFromCdpResponse } from '../src/cookie.js';
import type { FetchLike } from '../src/billing.js';

/**
 * cookie 导入模块单测。
 *
 * importCookieFromChrome 本体依赖真实 CDP WebSocket，mock 一个假 CDP 服务太
 * 复杂 —— 按拆分约定只测纯函数部分：parseCookiesFromCdpResponse（解析逻辑）
 * 与 getChromeTargets（HTTP 取 target，注入 fetchImpl）。
 */

// ---------------------------------------------------------------------------
// parseCookiesFromCdpResponse（Network.getAllCookies 响应解析）
// ---------------------------------------------------------------------------

/** 构造一条 CDP cookie。 */
function cdpCookie(name: string, value: string, domain: string): unknown {
  return { name, value, domain, path: '/', secure: true, httpOnly: true };
}

/** 构造 Network.getAllCookies 的完整响应。 */
function getAllCookiesResponse(cookies: unknown[]): unknown {
  return { result: { cookies } };
}

describe('parseCookiesFromCdpResponse', () => {
  it('命中 console.opencode.ai 的 auth cookie', () => {
    const data = getAllCookiesResponse([
      cdpCookie('sk_session', 'abc', 'console.opencode.ai'),
      cdpCookie('auth', 'Fe26.2*abc', 'console.opencode.ai'),
    ]);
    expect(parseCookiesFromCdpResponse(data)).toBe('auth=Fe26.2*abc');
  });

  it('通配 domain（.opencode.ai）同样命中', () => {
    const data = getAllCookiesResponse([cdpCookie('auth', 'Fe26.1*x', '.opencode.ai')]);
    expect(parseCookiesFromCdpResponse(data)).toBe('auth=Fe26.1*x');
  });

  it('没有 auth cookie 返回 null', () => {
    const data = getAllCookiesResponse([cdpCookie('sk_session', 'abc', 'console.opencode.ai')]);
    expect(parseCookiesFromCdpResponse(data)).toBeNull();
  });

  it('auth cookie 不在 console 域返回 null', () => {
    const data = getAllCookiesResponse([cdpCookie('auth', 'Fe26.x', 'example.com')]);
    expect(parseCookiesFromCdpResponse(data)).toBeNull();
  });

  it('auth 值为空串返回 null', () => {
    const data = getAllCookiesResponse([cdpCookie('auth', '', 'console.opencode.ai')]);
    expect(parseCookiesFromCdpResponse(data)).toBeNull();
  });

  it('垃圾输入全部返回 null', () => {
    expect(parseCookiesFromCdpResponse(null)).toBeNull();
    expect(parseCookiesFromCdpResponse('nope')).toBeNull();
    expect(parseCookiesFromCdpResponse([])).toBeNull();
    expect(parseCookiesFromCdpResponse({})).toBeNull();
    expect(parseCookiesFromCdpResponse({ result: null })).toBeNull();
    expect(parseCookiesFromCdpResponse({ result: { cookies: 'nope' } })).toBeNull();
    expect(parseCookiesFromCdpResponse({ result: { cookies: [null, 42] } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getChromeTargets（CDP /json/list）
// ---------------------------------------------------------------------------

describe('getChromeTargets', () => {
  it('解析 /json/list 的 page target 列表', async () => {
    const f = vi.fn<FetchLike>().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            type: 'page',
            url: 'https://console.opencode.ai/',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/1',
          },
          {
            type: 'page',
            url: 'https://example.com/',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/2',
          },
          { type: 'service_worker', url: 'x', webSocketDebuggerUrl: null },
        ]),
        { status: 200 },
      ),
    );

    const targets = await getChromeTargets(9223, f);

    expect(targets).toEqual([
      { type: 'page', url: 'https://console.opencode.ai/', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/1' },
      { type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/2' },
      { type: 'service_worker', url: 'x', webSocketDebuggerUrl: null },
    ]);
    expect(f).toHaveBeenCalledWith(
      'http://127.0.0.1:9223/json/list',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('字段缺失的 target 行宽容解析', async () => {
    const f = vi.fn<FetchLike>().mockResolvedValue(
      new Response(JSON.stringify([{ type: 'page' }, null, 'junk']), { status: 200 }),
    );

    const targets = await getChromeTargets(9223, f);

    expect(targets).toEqual([
      { type: 'page', url: '', webSocketDebuggerUrl: null },
    ]);
  });

  it('端口不通（fetch 抛错）返回 null', async () => {
    const f = vi.fn<FetchLike>().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await getChromeTargets(9223, f)).toBeNull();
  });

  it('非 2xx 返回 null', async () => {
    const f = vi.fn<FetchLike>().mockResolvedValue(new Response('nope', { status: 404 }));
    expect(await getChromeTargets(9223, f)).toBeNull();
  });

  it('响应不是数组返回 null', async () => {
    const f = vi.fn<FetchLike>().mockResolvedValue(
      new Response(JSON.stringify({ list: [] }), { status: 200 }),
    );
    expect(await getChromeTargets(9223, f)).toBeNull();
  });
});
