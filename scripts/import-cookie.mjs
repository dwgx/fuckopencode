#!/usr/bin/env node
/**
 * 一键登录 opencode 并导入会话到网关面板（自动引导登录，能抓什么抓什么）。
 *
 * 解决什么：旧版控制台（opencode.ai）只认 Iron 会话 cookie（auth=...，实测
 * Bearer 302 拒绝），且该 cookie 会因用户登出/服务端作废而失效——**没有**
 * refresh 机制。本脚本把「登录 + 抓取 + 导入」合成一步：会话失效时自动打开
 * 旧版控制台登录页，你在浏览器里登录一次，脚本轮询抓到有效会话后自动写入
 * 面板（fail-closed：抓不到有效会话绝不覆盖现有配置）。
 *
 * 流程：
 *   1. CDP 连本机共享 Chrome（默认 9223）拿 opencode 域 cookies
 *      （auth 旧版会话 + __Host-console_session 新版会话）。
 *   2. 新版会话反查 org id / email，匹配面板账号（--account 可指定）。
 *   3. auth 有效性验证：请求该账号 legacy workspace 的 go 页——
 *      200 = 有效，直接导入；302/失效 = 自动打开旧版控制台登录页，
 *      轮询等待你登录（默认 5 分钟），拿到有效会话后继续。
 *   4. 写入面板：cookie（主槽，legacy 通道读它）+ legacyWorkspaceId +
 *      workspaceId。cookie 值只在进程内 + 面板 API 之间流转，绝不打印。
 *
 * 用法：
 *   node scripts/import-cookie.mjs --panel https://fuckopencode.dwgx.top \
 *       --user admin --pass 'xxx' [--account 6] [--workspace wrk_xxx] [--cdp 9223]
 *
 * 退出码：0 = 已导入；2 = 会话无法建立（用户未登录/超时，现有配置未动）；1 = 其他。
 */

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PANEL = (opt('--panel', process.env.FC_PANEL) || 'https://fuckopencode.dwgx.top').replace(/\/+$/, '');
const USER = opt('--user', process.env.FC_ADMIN_USER) || 'admin';
const PASS = opt('--pass', process.env.FC_ADMIN_PASS) || '';
const ACCOUNT = opt('--account', '');
const WORKSPACE = opt('--workspace', '');
const CDP_PORT = Number(opt('--cdp', '9223'));
const LOGIN_WAIT_MS = Number(opt('--wait', '300000'));
const TIMEOUT_MS = 10_000;

const log = (m) => console.log(`[import-cookie] ${m}`);
const fail = (m, code = 1) => { console.error(`[import-cookie] ${m}`); process.exit(code); };

/** CDP：Network.getAllCookies → opencode 域 cookie 列表。 */
async function cdpCookies() {
  const ws = await cdpConnect();
  if (!ws) return null;
  try {
    const msg = await cdpCall(ws, 'Network.getAllCookies', {});
    return (msg?.result?.cookies ?? []).filter((c) => /opencode\.ai$/.test(c.domain) || c.domain.endsWith('.opencode.ai'));
  } finally {
    ws.close();
  }
}

/** CDP：Target.createTarget 打开一个页面（登录引导）。 */
async function cdpOpenPage(url) {
  const ws = await cdpConnect();
  if (!ws) return false;
  try {
    await cdpCall(ws, 'Target.createTarget', { url });
    return true;
  } catch {
    return false;
  } finally {
    ws.close();
  }
}

let _wsUrl = null;
async function cdpConnect() {
  if (_wsUrl) return new WebSocket(_wsUrl);
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
    const targets = await r.json();
    if (!Array.isArray(targets) || targets.length === 0) return null;
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? targets.find((t) => t.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) return null;
    _wsUrl = page.webSocketDebuggerUrl;
    return new WebSocket(_wsUrl);
  } catch {
    return null;
  }
}

function cdpCall(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => { ws.close(); reject(new Error('cdp timeout')); }, 6000);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      clearTimeout(timer);
      resolve(m);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}

/** 面板 API（带登录会话）。 */
let SESSION = '';
async function panelApi(method, path, body) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (SESSION) headers.cookie = SESSION;
  const r = await fetch(`${PANEL}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}

async function panelLogin() {
  if (!PASS) fail('缺少面板密码：--pass 或 FC_ADMIN_PASS');
  const res = await fetch(`${PANEL}/__admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }), // server.ts:629-630
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 429) {
    const j = await res.json().catch(() => null);
    fail(`面板登录失败（${res.status}）${j?.error?.message ? '：' + j.error.message : '——检查 --user/--pass'}`, 1);
  }
  if (!res.ok) fail(`面板登录失败（HTTP ${res.status}）`, 1);
  const sc = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!sc) fail('面板登录成功但未拿到会话 cookie', 1);
  SESSION = sc;
}

/** 新版会话反查账号身份。 */
async function consoleIdentity(sessCookie) {
  const H = { cookie: sessCookie, accept: 'application/json' };
  const orgs = await (await fetch('https://console.opencode.ai/api/orgs', { headers: H, signal: AbortSignal.timeout(TIMEOUT_MS) })).json();
  const user = await (await fetch('https://console.opencode.ai/api/user', { headers: H, signal: AbortSignal.timeout(TIMEOUT_MS) })).json();
  const list = Array.isArray(orgs) ? orgs : Array.isArray(orgs?.orgs) ? orgs.orgs : [];
  return { orgIds: list.map((o) => (o && typeof o.id === 'string' ? o.id : '')).filter(Boolean), email: typeof user?.email === 'string' ? user.email : '' };
}

/** auth 有效性：请求旧版 go 页，200 = 有效会话。 */
async function authValid(authValue, workspaceId) {
  if (!workspaceId) return { valid: null, reason: 'no-workspace-to-probe' };
  try {
    const r = await fetch(`https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`, {
      headers: { cookie: `auth=${authValue}` }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status === 200) return { valid: true };
    return { valid: false, reason: `status ${r.status}${r.status >= 300 && r.status < 400 ? '（旧版会话未激活）' : ''}` };
  } catch (e) {
    return { valid: null, reason: `probe failed: ${e.message.slice(0, 80)}` };
  }
}

/** 等待 auth 会话有效：轮询 CDP 抓 cookie + 验证，直到超时。 */
async function waitForValidAuth(workspaceId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let printed = false;
  while (Date.now() < deadline) {
    const cookies = await cdpCookies();
    const auth = cookies?.find((c) => c.name === 'auth' && c.domain === 'opencode.ai');
    if (auth) {
      const v = await authValid(auth.value, workspaceId);
      if (v.valid === true) return auth.value;
      if (!printed) { log(`  等待旧版会话激活（当前 ${v.reason}）...`); printed = true; }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

async function main() {
  log(`面板 ${PANEL} · 登录引导等待 ${Math.round(LOGIN_WAIT_MS / 60000)} 分钟`);
  const cookies = await cdpCookies();
  if (!cookies) fail(`连不上本机 Chrome CDP :${CDP_PORT}（先 oc-chrome ensure 启动共享 Chrome）`);
  const sess = cookies.find((c) => c.name === '__Host-console_session');
  let auth = cookies.find((c) => c.name === 'auth' && c.domain === 'opencode.ai') ?? null;

  let ident = { orgIds: [], email: '' };
  if (sess) {
    try { ident = await consoleIdentity(`__Host-console_session=${sess.value}`); } catch { /* 会话可能已失效 */ }
  }
  log(`浏览器: email=${ident.email || '?'} orgs=[${ident.orgIds.join(', ') || '?'}] auth=${auth ? '有' : '无'}`);

  await panelLogin();
  const list = await panelApi('GET', '/__admin/api/accounts');
  const accounts = list.json?.list ?? [];
  if (!Array.isArray(accounts) || accounts.length === 0) fail('面板账号列表为空');

  // 匹配账号：--account > org id > email 模糊
  let target = null;
  if (ACCOUNT) target = accounts.find((a) => String(a.id) === String(ACCOUNT));
  if (!target && ident.orgIds.length) target = accounts.find((a) => ident.orgIds.includes(a.workspaceId || ''));
  if (!target && ident.email) {
    const short = ident.email.split('@')[0];
    target = accounts.find((a) => (a.name || '').toLowerCase().includes(short.toLowerCase()));
  }
  if (!target) {
    fail(`面板里找不到匹配账号（浏览器=${ident.email || ident.orgIds[0] || '?'}）。可 --account <id> 指定。账号列表：` +
      accounts.map((a) => `${a.id}:${a.name}`).join(' / '));
  }
  const workspaceId = WORKSPACE || target.legacyWorkspaceId || '';
  log(`目标账号 #${target.id} ${target.name}（legacyWs=${target.legacyWorkspaceId || '-'} 工作区=${workspaceId || '?'}）`);
  if (!workspaceId) {
    log('  ⚠ 账号无 legacy workspace（wrk_xxx）且未提供 --workspace——先在你的浏览器旧版控制台打开该 workspace，'
      + '把 URL 里的 wrk_xxx 用 --workspace 传进来，否则无法验证/绑定旧版通道');
  }

  // auth 有效性：有效直接导入；失效自动引导登录
  let authValue = auth?.value ?? null;
  if (workspaceId) {
    const verdict = authValue ? await authValid(authValue, workspaceId) : { valid: false, reason: '无 auth cookie' };
    if (verdict.valid === true) {
      log(`旧版会话有效（200）——直接导入`);
    } else {
      log(`旧版会话不可用（${verdict.reason}）——自动打开旧版控制台登录页`);
      const loginUrl = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
      if (await cdpOpenPage(loginUrl)) {
        log(`  已在浏览器打开 ${loginUrl}`);
        log('  请在打开的页面完成登录（会跳到 authorize 流程）。登录成功后脚本自动继续...');
      } else {
        log(`  无法自动打开页面——请手动在浏览器打开：${loginUrl}`);
      }
      authValue = await waitForValidAuth(workspaceId, LOGIN_WAIT_MS);
      if (!authValue) {
        fail(`等待登录超时（${Math.round(LOGIN_WAIT_MS / 60000)} 分钟）——未拿到有效旧版会话，现有配置未改动。重新运行本脚本再试。`, 2);
      }
      log(`已拿到有效旧版会话（登录成功）`);
    }
  } else {
    log('  无 workspace——跳过会话验证与导入（只做账号信息确认）');
    process.exit(0);
  }

  // 写入面板（槽位架构，2026-08-15 修正）：
  //   legacyCookie 槽 = 旧版 auth 会话（legacy 通道读它——旧版控制台只认 auth）；
  //   cookie 槽 = 新版 __Host-console_session（console 通道读它——新版 API 只认
  //   __Host-console_session，auth 对 console API 无效，实测 401）。
  //   两个 cookie 互相不通，必须分槽；老配置 auth 在 cookie 槽时 server 的
  //   legacy 端点用 legacyCookieOf ?? cookieOf 回退兼容。
  const patch = {};
  if (authValue && workspaceId) patch.legacyCookie = `auth=${authValue}`;
  // __Host-console_session 只在该会话与目标账号匹配时写入 cookie 槽（console 通道
  // 读它打新版 API）——否则会串数据（如 gmail 会话写进 outlook 账号 → 显示 gmail 余额）。
  // 不匹配时 cookie 槽留空，console 通道自动走 Bearer（oauthRefresh 兜底）。
  if (sess && ident.orgIds.includes(target.workspaceId || '')) {
    patch.cookie = `__Host-console_session=${sess.value}`;
  } else if (sess && !target.workspaceId) {
    patch.cookie = `__Host-console_session=${sess.value}`;
  } else if (sess) {
    log(`  跳过写 cookie 槽：浏览器会话属于 ${ident.orgIds.join(',') || '其他'}，与账号 #${target.id} 的 workspace ${target.workspaceId || '(空)'} 不匹配（console 通道走 Bearer 兜底）`);
  }
  if (workspaceId) patch.legacyWorkspaceId = workspaceId;
  if (workspaceId.startsWith('org_') && !target.workspaceId) patch.workspaceId = workspaceId;
  const r = await panelApi('PATCH', `/__admin/api/accounts/${target.id}`, patch);
  // PATCH /accounts/:id 成功返回 {account:{...}}（sendAccount），无 ok 字段。
  if (r.status === 200 && (r.json?.ok === true || r.json?.account)) {
    log(`完成：账号 #${target.id} ${target.name} 已绑定 legacy 通道（wrk=${workspaceId}）＋新版会话。面板应显示 Go 订阅/旧版 key/余额`);
    process.exit(0);
  }
  fail(`PATCH 失败（${r.status}）：${(r.json?.error?.message || r.text || '').slice(0, 160)}`);
}

main().catch((e) => fail(e.message));
