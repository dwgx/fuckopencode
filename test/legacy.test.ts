import { describe, expect, it, vi } from 'vitest';
import {
  LEGACY_CREATE_SERVER_ID,
  LEGACY_DELETE_SERVER_ID_FALLBACK,
  LEGACY_GO_CHINA_SERVER_ID,
  LEGACY_GO_USE_BALANCE_SERVER_ID,
  LegacyPlainCache,
  createLegacyKey,
  deleteLegacyKey,
  fetchLegacyBilling,
  fetchLegacyGoStatus,
  fetchLegacyKeys,
  fetchZenGoUsage,
  legacyCookieStatus,
  mergeLegacyGoStatus,
  parseLegacyBillingHtml,
  parseLegacyGoHtml,
  parseLegacyKeysHtml,
  setLegacyGoToggle,
} from '../src/legacy.js';
import type { LegacyGoStatus, LegacyPlainKey } from '../src/legacy.js';
import type { FetchLike } from '../src/billing.js';

/**
 * 旧版控制台（opencode.ai）key 通道单测（fake fetch 注入，不打上游）。
 *
 * 协议事实来自 2026-08-11 浏览器实测（见 src/legacy.ts 文件头）：
 * - 读：GET /workspace/{id}/keys → HTML，key 列表在 SSR 水合
 *   `$R[n]={id:"key_...",name:"...",key:"<完整明文>",timeUsed:...,userID:"...",
 *   email:"...",keyDisplay:"sk-XXXX...XXXX"}`；
 * - 写：POST /_server + X-Server-Id 头 + urlencoded body（创建/删除各一函数）。
 * 下面的 fixture 按实测形状构造（key 明文用假的 sk- 串）。
 */

// ---------------------------------------------------------------------------
// SSR 水合解析
// ---------------------------------------------------------------------------

const KEY_OBJ_TPL =
  '$R[{i}]={{id:"{id}",name:"{name}",key:"{plain}",timeUsed:{timeUsed},userID:"usr_01KZEQCBJ5C1M5Q4SXGDKQB9ZQ",email:"{email}",keyDisplay:"{display}"}}';

function keyObj(i: number, over: Record<string, string>): string {
  const v: Record<string, string> = {
    id: `key_01KZEQCC3ASCSD6T0BSQBDKHK${i}`,
    name: 'Default API Key',
    plain: `sk-AOpQOUTje3uIJRVctKiLocPCaPPF1yWBQwOlwP7JfiOX47iCoL8BeTFTviyd0os${i}`,
    timeUsed: 'null',
    email: `user${i}@gmail.com`,
    display: `sk-AOpQ...0os${i}`,
    ...over,
  };
  let out = KEY_OBJ_TPL;
  for (const [key, value] of Object.entries(v)) {
    out = out.replaceAll(`{${key}}`, value);
  }
  return out;
}

/** 实测形状的 keys 页 HTML：4 个 key 对象 + 每行删除表单（action 带 server-id）。 */
function keysPageHtml(deleteServerId = '48baebd35f970b8dc3a658e6f9cc953efd731a7f8a6376012c9bc1802cec787d'): string {
  const rows = ['k1', 'k2', 'k3', 'k4'].map((k, i) => `
    <div data-key-row="${k}">
      <form method="post" action="/_server?id=${deleteServerId}">
        <input type="hidden" name="id" value="key_01KZEQCC3ASCSD6T0BSQBDKHK${i}">
        <input type="hidden" name="workspaceID" value="wrk_01KZEQCBJ59Y3T34CSJNRVQJV7">
        <button data-color="ghost">删除</button>
      </form>
    </div>`).join('');
  return `<html><body><h2>API 密钥</h2>
    <script>${keyObj(0, {})};${keyObj(1, { name: 'x' })};${keyObj(2, { email: 'null' })};${keyObj(3, {})}</script>
    ${rows}</body></html>`;
}

describe('parseLegacyKeysHtml', () => {
  it('实测形状：提取全部 key（id/name/掩码/创建者）+ 删除 server-id，绝不含 key 明文', () => {
    const parsed = parseLegacyKeysHtml(keysPageHtml());
    expect(parsed.keys).toHaveLength(4);
    expect(parsed.deleteServerId).toBe('48baebd35f970b8dc3a658e6f9cc953efd731a7f8a6376012c9bc1802cec787d');
    const first = parsed.keys[0]!;
    expect(first.id).toBe('key_01KZEQCC3ASCSD6T0BSQBDKHK0');
    expect(first.name).toBe('Default API Key');
    // 掩码来自 keyDisplay，不是 key 明文。
    expect(first.masked).toBe('sk-AOpQ...0os0');
    expect(first.creatorEmail).toBe('user0@gmail.com');
    // 隐私：任何返回值都不含完整 key（sk- + 64 位）。
    expect(JSON.stringify(parsed)).not.toContain('OUTje3uIJRVctKiLocPCaPPF1yWBQwOlwP7JfiOX47iCoL8BeTFTviyd0os');
  });

  it('keyDisplay 缺失时用 key 明文自算掩码（前 4 后 4），明文仍不外发', () => {
    const html = `<script>${keyObj(0, { display: 'null' })}</script>`;
    const parsed = parseLegacyKeysHtml(html);
    expect(parsed.keys[0]!.masked).toBe('sk-AOpQ...0os0');
    expect(JSON.stringify(parsed)).not.toContain('OUTje3uIJRVctKiLocPCaPPF1y');
  });

  it('C-I3：异常短 key（≤11 位）掩码整段打码为 ***，明文不进响应', () => {
    const html = `<script>${keyObj(0, { display: 'null', plain: 'sk-abc' })}</script>`;
    const parsed = parseLegacyKeysHtml(html);
    expect(parsed.keys[0]!.masked).toBe('***');
    expect(JSON.stringify(parsed)).not.toContain('sk-abc');
  });

  it('email 缺失 → creatorEmail 为 null', () => {
    const html = `<script>${keyObj(0, { email: 'null' })}</script>`;
    expect(parseLegacyKeysHtml(html).keys[0]!.creatorEmail).toBeNull();
  });

  it('没有 key 对象/删除表单 → 空结果 + isKeysPage=false（登录页等会被上层判 parse 失败）', () => {
    expect(parseLegacyKeysHtml('<html><title>登录</title></html>')).toEqual({
      keys: [],
      deleteServerId: null,
      isKeysPage: false,
    });
  });

  it('空 key 列表（水合有 key.list 标记、无对象无表单）→ isKeysPage=true（区分登录页的锚点）', () => {
    // 实测形状：keys 页的 SSR 水合注册行 `key.list["<ws>"]`（空列表也在）。
    const html = `<script>_$HY.r["key.list[\\"wrk_01KZEQCBJ59Y3T34CSJNRVQJV7\\"]"]=$R[20]=$R[2]($R[21]={p:0,s:0,f:0});$R[22]($R[21],[]);</script>`;
    expect(parseLegacyKeysHtml(html)).toEqual({ keys: [], deleteServerId: null, isKeysPage: true });
  });

  it('删除表单 action 缺失 → deleteServerId null', () => {
    expect(parseLegacyKeysHtml(`<script>${keyObj(0, {})}</script>`).deleteServerId).toBeNull();
  });

  it('plainSink：明文 push 进调用方数组（喂内存缓存），返回对象仍无明文', () => {
    const sink: LegacyPlainKey[] = [];
    const parsed = parseLegacyKeysHtml(keysPageHtml(), sink);
    expect(parsed.keys).toHaveLength(4);
    expect(sink).toHaveLength(4);
    expect(sink[0]).toEqual({
      id: 'key_01KZEQCC3ASCSD6T0BSQBDKHK0',
      name: 'Default API Key',
      key: 'sk-AOpQOUTje3uIJRVctKiLocPCaPPF1yWBQwOlwP7JfiOX47iCoL8BeTFTviyd0os0',
    });
    // 隐私不变量不变：返回对象不含明文，明文只经 sink 出去。
    expect(JSON.stringify(parsed)).not.toContain('OUTje3uIJRVctKiLocPCaPPF1y');
  });

  it('plainSink 缺省 → 明文不收集（旧调用方式行为不变）', () => {
    const parsed = parseLegacyKeysHtml(keysPageHtml());
    expect(JSON.stringify(parsed)).not.toContain('OUTje3uIJRVctKiLocPCaPPF1y');
  });
});

// ---------------------------------------------------------------------------
// 明文内存缓存（LegacyPlainCache）
// ---------------------------------------------------------------------------

describe('LegacyPlainCache', () => {
  it('set/get/clear：set 后 get 命中，clear 后 miss', () => {
    const c = new LegacyPlainCache();
    expect(c.get(1)).toBeNull();
    c.set(1, [{ id: 'key_1', name: 'n', key: 'sk-abc' }]);
    expect(c.get(1)).toEqual([{ id: 'key_1', name: 'n', key: 'sk-abc' }]);
    c.clear(1);
    expect(c.get(1)).toBeNull();
  });

  it('set 刷新同账号条目（覆盖旧明文）', () => {
    const c = new LegacyPlainCache();
    c.set(1, [{ id: 'key_1', name: 'old', key: 'sk-old' }]);
    c.set(1, [{ id: 'key_2', name: 'new', key: 'sk-new' }]);
    expect(c.size()).toBe(1);
    expect(c.get(1)).toEqual([{ id: 'key_2', name: 'new', key: 'sk-new' }]);
  });

  it('TTL：过期条目 get 返回 null 并就地清除', () => {
    vi.useFakeTimers();
    try {
      const c = new LegacyPlainCache({ ttlMs: 1000 });
      c.set(1, [{ id: 'key_1', name: 'n', key: 'sk-1' }]);
      expect(c.get(1)).not.toBeNull();
      vi.setSystemTime(Date.now() + 1001);
      expect(c.get(1)).toBeNull();
      expect(c.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超出账号上限 → 逐出最旧（Map 插入序第一个）', () => {
    const c = new LegacyPlainCache({ maxAccounts: 2 });
    c.set(1, [{ id: 'key_1', name: 'n', key: 'sk-1' }]);
    c.set(2, [{ id: 'key_2', name: 'n', key: 'sk-2' }]);
    expect(c.size()).toBe(2);
    c.set(3, [{ id: 'key_3', name: 'n', key: 'sk-3' }]);
    expect(c.size()).toBe(2);
    expect(c.get(1)).toBeNull(); // 最旧被逐出
    expect(c.get(2)).not.toBeNull();
    expect(c.get(3)).not.toBeNull();
  });

  it('C-P2-2：同一账号不同 workspace 互不命中（TTL 内绝不跨 workspace 泄露明文）', () => {
    const c = new LegacyPlainCache();
    c.set(1, [{ id: 'key_1', name: 'n', key: 'sk-ws-a' }], 'ws-a');
    expect(c.get(1, 'ws-a')).toEqual([{ id: 'key_1', name: 'n', key: 'sk-ws-a' }]);
    // workspace 不匹配 → miss（调用方用当前 ws 重抓并覆盖旧条目）
    expect(c.get(1, 'ws-b')).toBeNull();
    // 重抓后以新 ws 填充，旧 ws 反过来 miss
    c.set(1, [{ id: 'key_2', name: 'n', key: 'sk-ws-b' }], 'ws-b');
    expect(c.get(1, 'ws-b')).toEqual([{ id: 'key_2', name: 'n', key: 'sk-ws-b' }]);
    expect(c.get(1, 'ws-a')).toBeNull();
    expect(c.size()).toBe(1);
  });

  it('C-P2-2：ws 未传（旧调用方形态）→ 兼容放行，TTL 行为不变', () => {
    const c = new LegacyPlainCache();
    c.set(1, [{ id: 'key_1', name: 'n', key: 'sk-x' }]);
    expect(c.get(1)).toEqual([{ id: 'key_1', name: 'n', key: 'sk-x' }]);
    // 条目无 ws，请求带 ws 也无法校验 → 放行（升级过渡期语义）
    expect(c.get(1, 'ws-y')).toEqual([{ id: 'key_1', name: 'n', key: 'sk-x' }]);
  });
});

// ---------------------------------------------------------------------------
// cookie 判定
// ---------------------------------------------------------------------------

describe('legacyCookieStatus', () => {
  it('null/空串 → missing', () => {
    expect(legacyCookieStatus(null)).toBe('missing');
    expect(legacyCookieStatus('')).toBe('missing');
  });
  it('auth= 开头（opencode.ai 旧版 cookie）→ ok', () => {
    expect(legacyCookieStatus('auth=abc123')).toBe('ok');
  });
  it('__Host- 开头（新版 console 会话 cookie）→ wrong-console', () => {
    expect(legacyCookieStatus('__Host-console_session=xyz')).toBe('wrong-console');
  });
  it('多 cookie 串（auth= 在其中）→ ok，原样透传', () => {
    expect(legacyCookieStatus('auth=abc; other=def')).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 读：fetchLegacyKeys
// ---------------------------------------------------------------------------

function fakeFetch(
  handler: (init: { method: string; url: string; headers: Headers; body: string | null }) => Response,
): { f: FetchLike; reqs: Array<{ method: string; url: string; headers: Headers; body: string | null }> } {
  const reqs: Array<{ method: string; url: string; headers: Headers; body: string | null }> = [];
  const f: FetchLike = async (input, init) => {
    const headers = new Headers(init.headers);
    const req = {
      method: init.method ?? 'GET',
      url: input,
      headers,
      body: typeof init.body === 'string' ? init.body : null,
    };
    reqs.push(req);
    return handler(req);
  };
  return { f, reqs };
}

const BASE = 'https://opencode.ai';

describe('fetchLegacyKeys', () => {
  it('成功：GET keys 页（带 cookie + accept html）→ 解析出 key 列表', async () => {
    const { f, reqs } = fakeFetch(() => new Response(keysPageHtml(), { status: 200 }));
    const r = await fetchLegacyKeys(BASE, 'auth=cookie-1', 'wrk_01KZEQCBJ59Y3T34CSJNRVQJV7', f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.keys).toHaveLength(4);
    expect(r.deleteServerId).toBeTruthy();
    const req = reqs[0]!;
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://opencode.ai/workspace/wrk_01KZEQCBJ59Y3T34CSJNRVQJV7/keys');
    expect(req.headers.get('cookie')).toBe('auth=cookie-1');
    expect(req.headers.get('accept')).toBe('text/html');
  });

  it('workspaceId 会 URL 编码（防路径注入）', async () => {
    const { f, reqs } = fakeFetch(() => new Response(keysPageHtml(), { status: 200 }));
    await fetchLegacyKeys(BASE, 'auth=c', 'wrk a/b?x', f);
    expect(reqs[0]!.url).toBe('https://opencode.ai/workspace/wrk%20a%2Fb%3Fx/keys');
  });

  it('401/403 → auth', async () => {
    for (const status of [401, 403]) {
      const { f } = fakeFetch(() => new Response('', { status }));
      expect(await fetchLegacyKeys(BASE, 'auth=c', 'wrk_x', f)).toEqual({ ok: false, reason: 'auth' });
    }
  });

  it('5xx → upstream', async () => {
    const { f } = fakeFetch(() => new Response('', { status: 500 }));
    expect(await fetchLegacyKeys(BASE, 'auth=c', 'wrk_x', f)).toEqual({ ok: false, reason: 'upstream' });
  });

  it('网络错误/超时 → upstream', async () => {
    const { f } = fakeFetch(() => {
      throw new Error('boom');
    });
    expect(await fetchLegacyKeys(BASE, 'auth=c', 'wrk_x', f)).toEqual({ ok: false, reason: 'upstream' });
  });

  it('响应不是 keys 页（无 key 对象无删除表单）→ parse', async () => {
    const { f } = fakeFetch(() => new Response('<html>登录</html>', { status: 200 }));
    expect(await fetchLegacyKeys(BASE, 'auth=c', 'wrk_x', f)).toEqual({ ok: false, reason: 'parse' });
  });

  it('H3：空 key 列表（key.list 水合标记在、无对象无删除表单）→ ok + 空列表，不是 parse 失败', async () => {
    const html = `<script>_$HY.r["key.list[\\"wrk_01KZEQCBJ59Y3T34CSJNRVQJV7\\"]"]=$R[20]=$R[2]($R[21]={p:0,s:0,f:0});$R[22]($R[21],[]);</script>`;
    const { f } = fakeFetch(() => new Response(html, { status: 200 }));
    const r = await fetchLegacyKeys(BASE, 'auth=c', 'wrk_01KZEQCBJ59Y3T34CSJNRVQJV7', f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.keys).toEqual([]);
    expect(r.deleteServerId).toBeNull();
  });

  it('无 cookie → no-cookie，不发请求', async () => {
    const { f, reqs } = fakeFetch(() => new Response(keysPageHtml(), { status: 200 }));
    expect(await fetchLegacyKeys(BASE, null, 'wrk_x', f)).toEqual({ ok: false, reason: 'no-cookie' });
    expect(reqs).toHaveLength(0);
  });

  it('cookie 是 __Host-（新版 console 会话）→ wrong-console，不发请求', async () => {
    const { f, reqs } = fakeFetch(() => new Response(keysPageHtml(), { status: 200 }));
    expect(await fetchLegacyKeys(BASE, '__Host-console_session=x', 'wrk_x', f)).toEqual({
      ok: false,
      reason: 'wrong-console',
    });
    expect(reqs).toHaveLength(0);
  });

  it('onPlain：成功抓取时收到明文列表（喂内存缓存），返回对象仍无明文', async () => {
    const { f } = fakeFetch(() => new Response(keysPageHtml(), { status: 200 }));
    const sink: LegacyPlainKey[] = [];
    const r = await fetchLegacyKeys(BASE, 'auth=c', 'wrk_01KZEQCBJ59Y3T34CSJNRVQJV7', f, (keys) => sink.push(...keys));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sink).toHaveLength(4);
    expect(sink[0]).toEqual({
      id: 'key_01KZEQCC3ASCSD6T0BSQBDKHK0',
      name: 'Default API Key',
      key: 'sk-AOpQOUTje3uIJRVctKiLocPCaPPF1yWBQwOlwP7JfiOX47iCoL8BeTFTviyd0os0',
    });
    // LegacyReadResult 返回对象绝不含明文 —— 明文只走 onPlain。
    expect(JSON.stringify(r)).not.toContain('OUTje3uIJRVctKiLocPCaPPF1y');
  });

  it('onPlain：登录页（parse 失败）不触发，不污染缓存', async () => {
    const { f } = fakeFetch(() => new Response('<html>登录</html>', { status: 200 }));
    let fired = false;
    const r = await fetchLegacyKeys(BASE, 'auth=c', 'wrk_x', f, () => {
      fired = true;
    });
    expect(r).toEqual({ ok: false, reason: 'parse' });
    expect(fired).toBe(false);
  });

  it('onPlain：空 key 列表（ok:true）→ 触发且收到空数组', async () => {
    const html = `<script>_$HY.r["key.list[\\"wrk_01KZEQCBJ59Y3T34CSJNRVQJV7\\"]"]=$R[20]=$R[2]($R[21]={p:0,s:0,f:0});$R[22]($R[21],[]);</script>`;
    const { f } = fakeFetch(() => new Response(html, { status: 200 }));
    let fired = false;
    const r = await fetchLegacyKeys(BASE, 'auth=c', 'wrk_01KZEQCBJ59Y3T34CSJNRVQJV7', f, (keys) => {
      fired = true;
      expect(keys).toEqual([]);
    });
    expect(r.ok).toBe(true);
    expect(fired).toBe(true);
  });

  it('onPlain：无 cookie / __Host- cookie → 不触发，也不发请求', async () => {
    const { f, reqs } = fakeFetch(() => new Response(keysPageHtml(), { status: 200 }));
    let fired = false;
    await fetchLegacyKeys(BASE, null, 'wrk_x', f, () => {
      fired = true;
    });
    await fetchLegacyKeys(BASE, '__Host-console_session=x', 'wrk_x', f, () => {
      fired = true;
    });
    expect(reqs).toHaveLength(0);
    expect(fired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 写：createLegacyKey / deleteLegacyKey
// ---------------------------------------------------------------------------

describe('createLegacyKey', () => {
  it('实测协议：POST /_server + 创建 X-Server-Id + urlencoded body name/workspaceID', async () => {
    const { f, reqs } = fakeFetch(() => new Response('ok', { status: 200 }));
    const r = await createLegacyKey(BASE, 'auth=c', 'wrk_01KZEQCBJ59Y3T34CSJNRVQJV7', '我的 key', f);
    expect(r).toEqual({ ok: true });
    const req = reqs[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://opencode.ai/_server');
    expect(req.headers.get('x-server-id')).toBe(LEGACY_CREATE_SERVER_ID);
    expect(req.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(req.headers.get('cookie')).toBe('auth=c');
    expect(req.body).toBe('name=%E6%88%91%E7%9A%84%20key&workspaceID=wrk_01KZEQCBJ59Y3T34CSJNRVQJV7');
  });

  it('401/403 → auth；5xx/网络错 → upstream', async () => {
    for (const status of [401, 403]) {
      const { f } = fakeFetch(() => new Response('', { status }));
      expect(await createLegacyKey(BASE, 'auth=c', 'wrk_x', 'n', f)).toEqual({ ok: false, reason: 'auth' });
    }
    const { f } = fakeFetch(() => new Response('', { status: 500 }));
    expect(await createLegacyKey(BASE, 'auth=c', 'wrk_x', 'n', f)).toEqual({ ok: false, reason: 'upstream' });
    const { f: f2 } = fakeFetch(() => {
      throw new Error('net');
    });
    expect(await createLegacyKey(BASE, 'auth=c', 'wrk_x', 'n', f2)).toEqual({ ok: false, reason: 'upstream' });
  });

  it('无 cookie / __Host- cookie → 不发请求直接失败', async () => {
    const { f, reqs } = fakeFetch(() => new Response('ok', { status: 200 }));
    expect(await createLegacyKey(BASE, null, 'wrk_x', 'n', f)).toEqual({ ok: false, reason: 'no-cookie' });
    expect(await createLegacyKey(BASE, '__Host-console_session=x', 'wrk_x', 'n', f)).toEqual({
      ok: false,
      reason: 'wrong-console',
    });
    expect(reqs).toHaveLength(0);
  });
});

describe('deleteLegacyKey', () => {
  it('实测协议：POST /_server + body id/workspaceID；显式 serverId 优先', async () => {
    const { f, reqs } = fakeFetch(() => new Response('ok', { status: 200 }));
    const r = await deleteLegacyKey(
      BASE,
      'auth=c',
      'wrk_01KZEQCBJ59Y3T34CSJNRVQJV7',
      'key_01KZEQCC3ASCSD6T0BSQBDKHK1',
      f,
      '48baebd35f970b8dc3a658e6f9cc953efd731a7f8a6376012c9bc1802cec787d',
    );
    expect(r).toEqual({ ok: true });
    const req = reqs[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://opencode.ai/_server');
    expect(req.headers.get('x-server-id')).toBe('48baebd35f970b8dc3a658e6f9cc953efd731a7f8a6376012c9bc1802cec787d');
    expect(req.body).toBe('id=key_01KZEQCC3ASCSD6T0BSQBDKHK1&workspaceID=wrk_01KZEQCBJ59Y3T34CSJNRVQJV7');
  });

  it('serverId 不传 → 兜底常量（当前构建实测值）', async () => {
    const { f, reqs } = fakeFetch(() => new Response('ok', { status: 200 }));
    await deleteLegacyKey(BASE, 'auth=c', 'wrk_x', 'key_1', f);
    expect(reqs[0]!.headers.get('x-server-id')).toBe(LEGACY_DELETE_SERVER_ID_FALLBACK);
  });

  it('失败分类与创建一致', async () => {
    const { f } = fakeFetch(() => new Response('', { status: 401 }));
    expect(await deleteLegacyKey(BASE, 'auth=c', 'wrk_x', 'key_1', f)).toEqual({ ok: false, reason: 'auth' });
    const { f: f2 } = fakeFetch(() => new Response('', { status: 500 }));
    expect(await deleteLegacyKey(BASE, 'auth=c', 'wrk_x', 'key_1', f2)).toEqual({ ok: false, reason: 'upstream' });
    const { f: f3, reqs: reqs3 } = fakeFetch(() => new Response('ok', { status: 200 }));
    expect(await deleteLegacyKey(BASE, null, 'wrk_x', 'key_1', f3)).toEqual({ ok: false, reason: 'no-cookie' });
    expect(reqs3).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Go 订阅：SSR 水合解析（parseLegacyGoHtml）
// ---------------------------------------------------------------------------
//
// fixture 按 2026-08-11 浏览器实测形状构造（见 src/legacy.ts 文件头）：
// - 已订阅：lite.subscription.get 槽位 resolve 一个对象字面量
//   {mine:!0,useBalance:!1,region:["us","eu","sg","cn"],
//   rollingUsage:$R[34]={status:"ok",resetInSec:N,usagePercent:N},...}；
// - 未订阅：resolve 值是裸 null；
// - 中国模型开关状态在 SSR checkbox 的 checked 属性（不在水合里）。

const GO_WS = 'wrk_01KZEQCBJ59Y3T34CSJNRVQJV7';

/** 已订阅的 go 页水合片段（可覆盖 useBalance / 用量字段，模拟开/关与缺失）。 */
function goSubscribedHydration(over: Record<string, string> = {}): string {
  const v: Record<string, string> = {
    useBalance: '!1',
    rolling: 'rollingUsage:$R[34]={status:"ok",resetInSec:15184,usagePercent:5}',
    weekly: 'weeklyUsage:$R[35]={status:"ok",resetInSec:461761,usagePercent:46}',
    monthly: 'monthlyUsage:$R[36]={status:"ok",resetInSec:2413712,usagePercent:60}',
    ...over,
  };
  return (
    `_$HY.r["lite.subscription.get[\\"${GO_WS}\\"]"]=$R[17]=$R[2]($R[18]={p:0,s:0,f:0});` +
    `$R[28]($R[18],$R[32]={mine:!0,useBalance:${v.useBalance},region:$R[33]=["us","eu","sg","cn"],` +
    `${v.rolling},${v.weekly},${v.monthly}});` +
    `$R[28]($R[20],$R[37]={customerID:"cus_x",liteSubscriptionID:"sub_1U2Az62StuRr0lbXsJm24bHj"});`
  );
}

/** 开关区的 SSR HTML（chinaChecked 控制 checkbox 的 checked 属性）。 */
function goSwitchForms(chinaChecked: boolean): string {
  return (
    `<form method="post" data-slot="setting-row" action="/_server?id=${LEGACY_GO_USE_BALANCE_SERVER_ID}">` +
    `<p>达到使用限额后使用您的可用余额</p>` +
    `<input type="hidden" name="workspaceID" value="${GO_WS}">` +
    `<input type="hidden" name="useBalance" value="true">` +
    `<label data-slot="toggle-label"><input type="checkbox"><span></span></label></form>` +
    `<form method="post" data-slot="setting-row" action="/_server?id=${LEGACY_GO_CHINA_SERVER_ID}">` +
    `<p>启用部署在中国的模型</p>` +
    `<input type="hidden" name="workspaceID" value="${GO_WS}">` +
    `<input type="hidden" name="useChinaProviders" value="true">` +
    `<label data-slot="toggle-label"><input type="checkbox"${chinaChecked ? ' checked' : ''}><span></span></label></form>`
  );
}

function goPageHtml(script: string, chinaChecked: boolean): string {
  return `<html><body><h2>Go</h2><script>${script}</script>${goSwitchForms(chinaChecked)}</body></html>`;
}

describe('parseLegacyGoHtml', () => {
  it('已订阅页（实测形状）：订阅状态 + 三窗口用量 + 两个开关全解析', () => {
    const parsed = parseLegacyGoHtml(goPageHtml(goSubscribedHydration(), true), GO_WS);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.subscribed).toBe(true);
    expect(parsed.useBalance).toBe(false);
    expect(parsed.chinaModels).toBe(true);
    expect(parsed.rolling).toEqual({ status: 'ok', resetInSec: 15184, usagePercent: 5 });
    expect(parsed.weekly).toEqual({ status: 'ok', resetInSec: 461761, usagePercent: 46 });
    expect(parsed.monthly).toEqual({ status: 'ok', resetInSec: 2413712, usagePercent: 60 });
  });

  it('useBalance:!0（开）与 checkbox 无 checked（中国模型关）都能正确读出', () => {
    const parsed = parseLegacyGoHtml(goPageHtml(goSubscribedHydration({ useBalance: '!0' }), false), GO_WS);
    expect(parsed?.useBalance).toBe(true);
    expect(parsed?.chinaModels).toBe(false);
  });

  it('用量窗口字段缺失 → 对应窗口为 null（兜底不炸）', () => {
    const parsed = parseLegacyGoHtml(goPageHtml(goSubscribedHydration({ weekly: '' }), true), GO_WS);
    expect(parsed?.weekly).toBeNull();
    expect(parsed?.rolling).not.toBeNull();
  });

  it('未订阅（resolve 值是裸 null）→ subscribed=false，开关/用量全空', () => {
    const html = `<script>_$HY.r["lite.subscription.get[\\"${GO_WS}\\"]"]=$R[17]=$R[2]($R[18]={p:0,s:0,f:0});$R[28]($R[18],null);$R[28]($R[20],null);</script>`;
    const parsed = parseLegacyGoHtml(html, GO_WS);
    expect(parsed).toEqual({
      subscribed: false,
      useBalance: false,
      chinaModels: false,
      rolling: null,
      weekly: null,
      monthly: null,
    });
  });

  it('非 go 页（水合里既无 lite.subscription.get 也无 billing.get）→ null（上层判 parse）', () => {
    expect(parseLegacyGoHtml('<html><title>登录</title></html>', GO_WS)).toBeNull();
  });

  it('键存在但槽位形态对不上（旧构建序列化差异）→ 保守按未订阅，不误判页面', () => {
    const html = `<script>_$HY.r["lite.subscription.get[\\"${GO_WS}\\"]"]=$R[17]=$R[2]($R[18]={x:1});</script>`;
    const parsed = parseLegacyGoHtml(html, GO_WS);
    expect(parsed?.subscribed).toBe(false);
    expect(parsed?.useBalance).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Go 订阅：读（fetchLegacyGoStatus）
// ---------------------------------------------------------------------------

describe('fetchLegacyGoStatus', () => {
  it('成功：GET go 页（带 cookie + accept html）→ 解析出订阅状态', async () => {
    const { f, reqs } = fakeFetch(() =>
      new Response(goPageHtml(goSubscribedHydration(), true), { status: 200 }),
    );
    const r = await fetchLegacyGoStatus(BASE, 'auth=cookie-1', GO_WS, f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status.subscribed).toBe(true);
    expect(r.status.useBalance).toBe(false);
    expect(r.status.chinaModels).toBe(true);
    expect(r.status.monthly?.usagePercent).toBe(60);
    const req = reqs[0]!;
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`https://opencode.ai/workspace/${GO_WS}/go`);
    expect(req.headers.get('cookie')).toBe('auth=cookie-1');
    expect(req.headers.get('accept')).toBe('text/html');
  });

  it('workspaceId 会 URL 编码（防路径注入）', async () => {
    const { f, reqs } = fakeFetch(() => new Response(goPageHtml(goSubscribedHydration(), true), { status: 200 }));
    await fetchLegacyGoStatus(BASE, 'auth=c', 'wrk a/b?x', f);
    expect(reqs[0]!.url).toBe('https://opencode.ai/workspace/wrk%20a%2Fb%3Fx/go');
  });

  it('401/403 → auth；5xx/网络错 → upstream', async () => {
    for (const status of [401, 403]) {
      const { f } = fakeFetch(() => new Response('', { status }));
      expect(await fetchLegacyGoStatus(BASE, 'auth=c', GO_WS, f)).toEqual({ ok: false, reason: 'auth' });
    }
    const { f: f2 } = fakeFetch(() => new Response('', { status: 500 }));
    expect(await fetchLegacyGoStatus(BASE, 'auth=c', GO_WS, f2)).toEqual({ ok: false, reason: 'upstream' });
    const { f: f3 } = fakeFetch(() => {
      throw new Error('net');
    });
    expect(await fetchLegacyGoStatus(BASE, 'auth=c', GO_WS, f3)).toEqual({ ok: false, reason: 'upstream' });
  });

  it('响应不是 go 页（无水合键）→ parse', async () => {
    const { f } = fakeFetch(() => new Response('<html>登录</html>', { status: 200 }));
    expect(await fetchLegacyGoStatus(BASE, 'auth=c', GO_WS, f)).toEqual({ ok: false, reason: 'parse' });
  });

  it('未订阅页也能读（subscribed=false 不是 parse 失败）', async () => {
    const html = `<script>_$HY.r["lite.subscription.get[\\"${GO_WS}\\"]"]=$R[17]=$R[2]($R[18]={p:0,s:0,f:0});$R[28]($R[18],null);</script>`;
    const { f } = fakeFetch(() => new Response(html, { status: 200 }));
    const r = await fetchLegacyGoStatus(BASE, 'auth=c', GO_WS, f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status.subscribed).toBe(false);
  });

  it('无 cookie → no-cookie，不发请求', async () => {
    const { f, reqs } = fakeFetch(() => new Response('ok', { status: 200 }));
    expect(await fetchLegacyGoStatus(BASE, null, GO_WS, f)).toEqual({ ok: false, reason: 'no-cookie' });
    expect(reqs).toHaveLength(0);
  });

  it('cookie 是 __Host-（新版 console 会话）→ wrong-console，不发请求', async () => {
    const { f, reqs } = fakeFetch(() => new Response('ok', { status: 200 }));
    expect(await fetchLegacyGoStatus(BASE, '__Host-console_session=x', GO_WS, f)).toEqual({
      ok: false,
      reason: 'wrong-console',
    });
    expect(reqs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Go 订阅：写（setLegacyGoToggle）
// ---------------------------------------------------------------------------

describe('setLegacyGoToggle', () => {
  it('useBalance=true：POST /_server + 实测 X-Server-Id + body workspaceID/useBalance', async () => {
    const { f, reqs } = fakeFetch(() => new Response('ok', { status: 200 }));
    const r = await setLegacyGoToggle(BASE, 'auth=c', GO_WS, 'useBalance', true, f);
    expect(r).toEqual({ ok: true });
    const req = reqs[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://opencode.ai/_server');
    expect(req.headers.get('x-server-id')).toBe(LEGACY_GO_USE_BALANCE_SERVER_ID);
    expect(req.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(req.headers.get('cookie')).toBe('auth=c');
    expect(req.body).toBe(`workspaceID=${GO_WS}&useBalance=true`);
  });

  it('useBalance=false：body 带 false（实测点回提交值）', async () => {
    const { f, reqs } = fakeFetch(() => new Response('ok', { status: 200 }));
    await setLegacyGoToggle(BASE, 'auth=c', GO_WS, 'useBalance', false, f);
    expect(reqs[0]!.body).toBe(`workspaceID=${GO_WS}&useBalance=false`);
  });

  it('chinaModels：用中国模型函数 id + useChinaProviders 字段', async () => {
    const { f, reqs } = fakeFetch(() => new Response('ok', { status: 200 }));
    const r = await setLegacyGoToggle(BASE, 'auth=c', GO_WS, 'chinaModels', true, f);
    expect(r).toEqual({ ok: true });
    const req = reqs[0]!;
    expect(req.headers.get('x-server-id')).toBe(LEGACY_GO_CHINA_SERVER_ID);
    expect(req.body).toBe(`workspaceID=${GO_WS}&useChinaProviders=true`);
  });

  it('失败分类与 key 写一致（401 → auth；5xx → upstream；无 cookie 不发请求）', async () => {
    const { f } = fakeFetch(() => new Response('', { status: 401 }));
    expect(await setLegacyGoToggle(BASE, 'auth=c', GO_WS, 'useBalance', true, f)).toEqual({
      ok: false,
      reason: 'auth',
    });
    const { f: f2 } = fakeFetch(() => new Response('', { status: 500 }));
    expect(await setLegacyGoToggle(BASE, 'auth=c', GO_WS, 'useBalance', true, f2)).toEqual({
      ok: false,
      reason: 'upstream',
    });
    const { f: f3, reqs: reqs3 } = fakeFetch(() => new Response('ok', { status: 200 }));
    expect(await setLegacyGoToggle(BASE, null, GO_WS, 'useBalance', true, f3)).toEqual({
      ok: false,
      reason: 'no-cookie',
    });
    expect(reqs3).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 旧版 billing：SSR 水合解析（parseLegacyBillingHtml）
// ---------------------------------------------------------------------------
//
// fixture 按 2026-08-12 浏览器实测形状构造（见 src/legacy.ts 文件头）：
// - billing.get 槽位 resolve 一个对象：balance 是整数 units（1e8=$1）、
//   reload 是裸 null（未启用）、reloadAmount/reloadTrigger 是美元整数、
//   monthlyLimit 是 units 或 null；
// - payment.list 槽位 resolve 一个数组，元素带 timeCreated:new Date(...) 与
//   enrichment 嵌套对象（`{id:"pay_` 锚点分段必须能跨过嵌套 `}`）。

/** 实测形状的 billing 页水合（可覆盖 balance/reload/monthlyLimit/payments）。 */
function billingHydration(over: Record<string, string> = {}): string {
  const v: Record<string, string> = {
    balance: 'balance:0',
    reload: 'reload:null,reloadAmount:20,reloadAmountMin:10,reloadTrigger:5,reloadTriggerMin:5',
    monthlyLimit: 'monthlyLimit:null',
    payments:
      `$R[22]($R[36],$R[39]=[$R[40]={id:"pay_01KZGYZ3DMBP8R0H8BZ81PRGE1",workspaceID:"${GO_WS}",` +
      `timeCreated:$R[41]=new Date("2026-08-08T15:13:20.000Z"),timeUpdated:$R[42]=new Date("2026-08-08T15:13:20.840Z"),` +
      `timeDeleted:null,customerID:"cus_V2FTXixFWWhxX2",invoiceID:"in_1U2Aye2StuRr0lbXkJXO1M37",` +
      `paymentID:"pi_3U2Aye2StuRr0lbX0htWmTIJ",amount:500000000,timeRefunded:null,` +
      `enrichment:$R[43]={type:"lite",couponID:"6iMezXFZ"}}]);`,
    ...over,
  };
  return (
    `_$HY.r["billing.get[\\"${GO_WS}\\"]"]=$R[15]=$R[2]($R[16]={p:0,s:0,f:0});` +
    `_$HY.r["payment.list[\\"${GO_WS}\\"]"]=$R[35]=$R[2]($R[36]={p:0,s:0,f:0});` +
    `$R[22]($R[16],$R[23]={customerID:"cus_V2FTXixFWWhxX2",paymentMethodID:"pm_1U2Ayd2StuRr0lbXuGhVuSLt",` +
    `paymentMethodType:"alipay",paymentMethodLast4:null,${v.balance},${v.reload},${v.monthlyLimit},` +
    `monthlyUsage:0,timeMonthlyUsageUpdated:$R[24]=new Date("2026-08-11T16:33:01.000Z"),` +
    `reloadError:null,timeReloadError:null,subscription:null,subscriptionID:null,subscriptionPlan:null,` +
    `timeSubscriptionBooked:null,timeSubscriptionSelected:null,lite:$R[25]={},liteSubscriptionID:"sub_1U2Az62StuRr0lbXsJm24bHj"});` +
    v.payments
  );
}

describe('parseLegacyBillingHtml', () => {
  it('实测形状：余额/自动充值（禁用）/支付历史/月限额全解析，单位换算正确', () => {
    const parsed = parseLegacyBillingHtml(billingHydration(), GO_WS);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.balanceDollars).toBe(0);
    expect(parsed.reload).toBeNull(); // reload:null = 未启用，不因顶层 reloadAmount 误报
    expect(parsed.payments).toEqual([
      {
        amount: 5, // 500000000 units / 1e8 = $5.00
        date: '2026-08-08T15:13:20.000Z',
        description: 'lite · 6iMezXFZ',
      },
    ]);
    expect(parsed.monthlyLimitDollars).toBeNull();
  });

  it('余额/月限额是 units：balance:500000000 → $5，monthlyLimit:250000000 → $2.5', () => {
    const parsed = parseLegacyBillingHtml(
      billingHydration({ balance: 'balance:500000000', monthlyLimit: 'monthlyLimit:250000000' }),
      GO_WS,
    );
    expect(parsed?.balanceDollars).toBe(5);
    expect(parsed?.monthlyLimitDollars).toBe(2.5);
  });

  it('自动充值启用（reload 对象）：amount/trigger 是美元整数，不经 units 换算', () => {
    const parsed = parseLegacyBillingHtml(
      billingHydration({ reload: 'reload:$R[50]={amount:20,trigger:5},reloadAmount:20,reloadTrigger:5' }),
      GO_WS,
    );
    expect(parsed?.reload).toEqual({ enabled: true, thresholdDollars: 5, amountDollars: 20 });
  });

  it('reload 对象缺字段 → 兜底读顶层 reloadAmount/reloadTrigger', () => {
    const parsed = parseLegacyBillingHtml(
      billingHydration({ reload: 'reload:$R[50]={},reloadAmount:15,reloadTrigger:3' }),
      GO_WS,
    );
    expect(parsed?.reload).toEqual({ enabled: true, thresholdDollars: 3, amountDollars: 15 });
  });

  it('无支付记录（payment.list resolve 空数组）→ payments 空数组', () => {
    const parsed = parseLegacyBillingHtml(billingHydration({ payments: `$R[22]($R[36],$R[39]=[]);` }), GO_WS);
    expect(parsed?.payments).toEqual([]);
  });

  it('多笔支付、字段缺失兜底：amount 缺失 → 0，无 enrichment → description null', () => {
    const html =
      billingHydration({
        payments:
          `$R[22]($R[36],$R[39]=[$R[40]={id:"pay_a",amount:100000000},` +
          `$R[41]={id:"pay_b",timeCreated:$R[42]=new Date("2026-08-01T00:00:00.000Z"),amount:200000000}]);`,
      });
    const parsed = parseLegacyBillingHtml(html, GO_WS);
    expect(parsed?.payments).toEqual([
      { amount: 1, date: null, description: null },
      { amount: 2, date: '2026-08-01T00:00:00.000Z', description: null },
    ]);
  });

  it('非 billing 页（无水合键）→ null（上层判 parse）', () => {
    expect(parseLegacyBillingHtml('<html><title>登录</title></html>', GO_WS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 旧版 billing：读（fetchLegacyBilling）
// ---------------------------------------------------------------------------

describe('fetchLegacyBilling', () => {
  it('成功：GET billing 页（带 cookie + accept html）→ 解析出余额/充值/支付历史', async () => {
    const { f, reqs } = fakeFetch(() => new Response(billingHydration(), { status: 200 }));
    const r = await fetchLegacyBilling(BASE, 'auth=cookie-1', GO_WS, f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.billing.balanceDollars).toBe(0);
    expect(r.billing.payments[0]?.amount).toBe(5);
    const req = reqs[0]!;
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`https://opencode.ai/workspace/${GO_WS}/billing`);
    expect(req.headers.get('cookie')).toBe('auth=cookie-1');
    expect(req.headers.get('accept')).toBe('text/html');
  });

  it('workspaceId 会 URL 编码（防路径注入）', async () => {
    const { f, reqs } = fakeFetch(() => new Response(billingHydration(), { status: 200 }));
    await fetchLegacyBilling(BASE, 'auth=c', 'wrk a/b?x', f);
    expect(reqs[0]!.url).toBe('https://opencode.ai/workspace/wrk%20a%2Fb%3Fx/billing');
  });

  it('401/403 → auth；5xx/网络错 → upstream', async () => {
    for (const status of [401, 403]) {
      const { f } = fakeFetch(() => new Response('', { status }));
      expect(await fetchLegacyBilling(BASE, 'auth=c', GO_WS, f)).toEqual({ ok: false, reason: 'auth' });
    }
    const { f: f2 } = fakeFetch(() => new Response('', { status: 500 }));
    expect(await fetchLegacyBilling(BASE, 'auth=c', GO_WS, f2)).toEqual({ ok: false, reason: 'upstream' });
    const { f: f3 } = fakeFetch(() => {
      throw new Error('net');
    });
    expect(await fetchLegacyBilling(BASE, 'auth=c', GO_WS, f3)).toEqual({ ok: false, reason: 'upstream' });
  });

  it('响应不是 billing 页（无水合键）→ parse', async () => {
    const { f } = fakeFetch(() => new Response('<html>登录</html>', { status: 200 }));
    expect(await fetchLegacyBilling(BASE, 'auth=c', GO_WS, f)).toEqual({ ok: false, reason: 'parse' });
  });

  it('无 cookie → no-cookie，不发请求', async () => {
    const { f, reqs } = fakeFetch(() => new Response(billingHydration(), { status: 200 }));
    expect(await fetchLegacyBilling(BASE, null, GO_WS, f)).toEqual({ ok: false, reason: 'no-cookie' });
    expect(reqs).toHaveLength(0);
  });

  it('cookie 是 __Host-（新版 console 会话）→ wrong-console，不发请求', async () => {
    const { f, reqs } = fakeFetch(() => new Response(billingHydration(), { status: 200 }));
    expect(await fetchLegacyBilling(BASE, '__Host-console_session=x', GO_WS, f)).toEqual({
      ok: false,
      reason: 'wrong-console',
    });
    expect(reqs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Zen usage（/zen/go/v1/usage，API key 通道，零 cookie）
// ---------------------------------------------------------------------------
//
// fixture 按 2026-08-15 服务器实测形状构造（见 src/legacy.ts fetchZenGoUsage 注释）：
// GET /zen/go/v1/usage + Bearer 旧版 Default API Key → 200
// `{"usage":{"rolling":{"status":"ok","percent":5,"resetsAt":"..."},...}}`；
// 无效 key → 401 AuthError。

describe('fetchZenGoUsage', () => {
  const ZEN_OK = {
    usage: {
      rolling: { status: 'ok', percent: 5, resetsAt: '2026-08-15T05:09:37.327Z' },
      weekly: { status: 'ok', percent: 41, resetsAt: '2026-08-17T00:00:00.327Z' },
      monthly: { status: 'ok', percent: 20, resetsAt: '2026-09-11T15:25:51.327Z' },
    },
  };

  it('实测形状 200 → LegacyGoStatus（percent→usagePercent、resetsAt→resetInSec、status 透传）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'));
    try {
      const { f, reqs } = fakeFetch(() =>
        new Response(JSON.stringify(ZEN_OK), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      const r = await fetchZenGoUsage(BASE, 'sk-AOpQOUTje3uIJRVctKiLocPCaPPF1yWBQwOlwP7JfiOX47iCoL8BeTFTviyd0osU', f);
      expect(r).not.toBeNull();
      if (!r) return;
      expect(r.subscribed).toBe(true);
      expect(r.useBalance).toBe(false);
      expect(r.chinaModels).toBe(false);
      const reset = (iso: string): number =>
        Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000));
      expect(r.rolling).toEqual({ status: 'ok', resetInSec: reset('2026-08-15T05:09:37.327Z'), usagePercent: 5 });
      expect(r.weekly).toEqual({ status: 'ok', resetInSec: reset('2026-08-17T00:00:00.327Z'), usagePercent: 41 });
      expect(r.monthly).toEqual({ status: 'ok', resetInSec: reset('2026-09-11T15:25:51.327Z'), usagePercent: 20 });
      const req = reqs[0]!;
      expect(req.method).toBe('GET');
      expect(req.url).toBe('https://opencode.ai/zen/go/v1/usage');
      expect(req.headers.get('authorization')).toBe('Bearer sk-AOpQOUTje3uIJRVctKiLocPCaPPF1yWBQwOlwP7JfiOX47iCoL8BeTFTviyd0osU');
      expect(req.headers.get('accept')).toBe('application/json');
    } finally {
      vi.useRealTimers();
    }
  });

  it('401（无效 key，实测 AuthError 形状）→ null，不抛', async () => {
    const { f } = fakeFetch(() =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'AuthError', message: 'Unauthorized' } }), { status: 401 }),
    );
    expect(await fetchZenGoUsage(BASE, 'sk-bad', f)).toBeNull();
  });

  it('非 2xx（5xx）→ null', async () => {
    const { f } = fakeFetch(() => new Response('', { status: 500 }));
    expect(await fetchZenGoUsage(BASE, 'sk-x', f)).toBeNull();
  });

  it('网络错误/超时 → null', async () => {
    const { f } = fakeFetch(() => {
      throw new Error('net');
    });
    expect(await fetchZenGoUsage(BASE, 'sk-x', f)).toBeNull();
  });

  it('响应不是合法 JSON → null', async () => {
    const { f } = fakeFetch(() => new Response('<html>oops</html>', { status: 200 }));
    expect(await fetchZenGoUsage(BASE, 'sk-x', f)).toBeNull();
  });

  it('JSON 缺顶层 usage → null', async () => {
    const { f } = fakeFetch(() => new Response(JSON.stringify({ foo: 1 }), { status: 200 }));
    expect(await fetchZenGoUsage(BASE, 'sk-x', f)).toBeNull();
  });

  it('窗口缺字段/畸形 → 该窗口 null（其余照常）；resetsAt 解析失败 → resetInSec 0 而非 NaN', async () => {
    const bad = {
      usage: {
        rolling: { status: 'ok', percent: 5, resetsAt: 'not-a-date' },
        weekly: { status: 'ok', percent: 'x' },
        monthly: { status: 'ok' },
      },
    };
    const { f } = fakeFetch(() => new Response(JSON.stringify(bad), { status: 200 }));
    const r = await fetchZenGoUsage(BASE, 'sk-x', f);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.rolling).toEqual({ status: 'ok', resetInSec: 0, usagePercent: 5 });
    expect(r.weekly).toBeNull();
    expect(r.monthly).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Go 状态合并（zen 窗口 + cookie HTML 开关，go 端点 zen 优先路径用）
// ---------------------------------------------------------------------------

describe('mergeLegacyGoStatus', () => {
  it('mock fetch：zen 窗口 + cookie go 页开关 → 合并结果窗口来自 zen、开关来自 cookie', async () => {
    const { f, reqs } = fakeFetch((req) =>
      req.url.includes('/zen/go/v1/usage')
        ? new Response(
            JSON.stringify({
              usage: {
                rolling: { status: 'ok', percent: 5, resetsAt: '2026-08-15T05:09:37.327Z' },
                weekly: { status: 'ok', percent: 41, resetsAt: '2026-08-17T00:00:00.327Z' },
                monthly: { status: 'ok', percent: 20, resetsAt: '2026-09-11T15:25:51.327Z' },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        : new Response(goPageHtml(goSubscribedHydration({ useBalance: '!0' }), true), { status: 200 }),
    );
    const zen = await fetchZenGoUsage(BASE, 'sk-x', f);
    const cookieR = await fetchLegacyGoStatus(BASE, 'auth=c', GO_WS, f);
    expect(zen).not.toBeNull();
    expect(cookieR.ok).toBe(true);
    if (!zen || !cookieR.ok) return;
    const merged = mergeLegacyGoStatus(zen, cookieR.status);
    expect(merged.useBalance).toBe(true); // 来自 cookie go 页
    expect(merged.chinaModels).toBe(true); // 来自 cookie go 页
    expect(merged.monthly?.usagePercent).toBe(20); // 窗口来自 zen
    expect(merged.rolling).toEqual(zen.rolling);
    expect(reqs).toHaveLength(2);
  });

  it('cookie 状态为 null（cookie 缺失/失效/解析失败）→ 返回 zen 原样，开关保持 false', () => {
    const zen: LegacyGoStatus = {
      subscribed: true,
      useBalance: false,
      chinaModels: false,
      rolling: { status: 'ok', resetInSec: 3600, usagePercent: 5 },
      weekly: null,
      monthly: null,
    };
    const merged = mergeLegacyGoStatus(zen, null);
    expect(merged).toBe(zen);
    expect(merged.useBalance).toBe(false);
    expect(merged.chinaModels).toBe(false);
    expect(merged.rolling).toEqual(zen.rolling);
  });

  it('zen 窗口为 null 时合并仍保留 null（不因 cookie 引入窗口数据）', () => {
    const zen: LegacyGoStatus = {
      subscribed: true,
      useBalance: false,
      chinaModels: false,
      rolling: null,
      weekly: null,
      monthly: null,
    };
    const cookieStatus: LegacyGoStatus = {
      subscribed: true,
      useBalance: true,
      chinaModels: true,
      rolling: { status: 'ok', resetInSec: 1, usagePercent: 99 },
      weekly: null,
      monthly: null,
    };
    const merged = mergeLegacyGoStatus(zen, cookieStatus);
    expect(merged.useBalance).toBe(true);
    expect(merged.chinaModels).toBe(true);
    expect(merged.rolling).toBeNull(); // 窗口仍取 zen
  });
});
