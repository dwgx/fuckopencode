#!/usr/bin/env node
/**
 * scripts/smoke-test.mjs —— 网关网页/链路 smoke test（部署后 / 例行巡检用）。
 *
 * 区别于 scripts/live-probe.mjs（数据面深度 probe）：这是快速链路检查，
 * 覆盖「部署对不对」：公网全链路（FurCDN → 网关）、网关、面板、数据面。
 *
 * 用法：
 *   node scripts/smoke-test.mjs                 全链路（公网 + ssh 本机检查）
 *   node scripts/smoke-test.mjs --only-public   只测公网（跳过 ssh 部分）
 *   node scripts/smoke-test.mjs --only-local    只测 ssh（直连 8787，跳过公网）
 *
 * 参数：
 *   --key <k> / SMOKE_API_KEY       数据面 API key（公网模式用）
 *   --user <u> / SMOKE_ADMIN_USER   面板用户名（默认 admin）
 *   --pass <p> / SMOKE_ADMIN_PASS   面板密码（公网模式用；不传且 ssh 可达时从服务器取）
 *   --ssh <target>                  ssh 目标，默认 nbus
 *   --timeout <s>                   单请求超时（默认 15s；数据面请求用 30s）
 *   --help
 *
 * 凭据（铁律）：本脚本不硬编码、不打印任何 key/密码。
 *   - ssh 本机检查：凭据在服务器端 env/db 内展开，key/密码不出服务器。
 *   - 公网检查：优先 --key/--pass/SMOKE_*；未给且 ssh 可达时从服务器
 *     env/db 取到本进程内存（base64 传输，不落日志、不打印）。
 *   - 面板账号密码生效值 = DB settings 覆盖 env（与网关自身解析一致）。
 *     注意：env 里的 ADMIN_PASS 可能是旧值（设置页改过密码后 DB 才是生效值）。
 *
 * 数据面请求（消耗真实额度）：每次运行只发 1 次（公网模式走公网，local 模式走 ssh）。
 * 退出码：0 = 全部通过；1 = 有失败或跳过。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const PUBLIC_BASE = 'https://fuckopencode.dwgx.top';
const ENV_FILE = '/root/fuckopencode/fuckopencode.env';
const DB_FILE = '/root/fuckopencode/data/usage.db';
const BUDGET_MS = 55_000;

function usage() {
  console.log(`用法：
  node scripts/smoke-test.mjs [--only-public|--only-local] [--key K] [--user U] [--pass P] [--ssh T] [--timeout S]
模式：默认全链路；--only-public 只测公网；--only-local 只测 ssh。
凭据：--key/--user/--pass 或 SMOKE_API_KEY/SMOKE_ADMIN_USER/SMOKE_ADMIN_PASS；缺省时经 ssh 从服务器 env/db 取（不打印）。`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opt = { mode: 'both', timeout: 15, sshTarget: 'nbus' };
  let key = '';
  let user = '';
  let pass = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--only-public') opt.mode = 'public';
    else if (a === '--only-local') opt.mode = 'local';
    else if (a === '--key') key = args[++i] ?? '';
    else if (a === '--user') user = args[++i] ?? '';
    else if (a === '--pass') pass = args[++i] ?? '';
    else if (a === '--ssh') opt.sshTarget = args[++i] ?? 'nbus';
    else if (a === '--timeout') opt.timeout = Number(args[++i]) || 15;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error(`未知参数: ${a}`); usage(); process.exit(2); }
  }
  opt.key = key || process.env.SMOKE_API_KEY || '';
  opt.user = user || process.env.SMOKE_ADMIN_USER || 'admin';
  opt.userSet = user !== '' || process.env.SMOKE_ADMIN_USER != null;
  opt.pass = pass || process.env.SMOKE_ADMIN_PASS || '';
  opt.chatTimeout = Math.max(opt.timeout, 30);
  return opt;
}

const opt = parseArgs();
const t0 = Date.now();

const results = [];
function report(name, ok, detail = '') {
  results.push({ name, ok, skip: false, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}]  ${name}${detail ? '  ' + detail : ''}`);
}
function reportSkip(name, reason) {
  results.push({ name, ok: false, skip: true, detail: reason });
  console.log(`[SKIP]  ${name}  ${reason}`);
}
function overBudget() {
  return Date.now() - t0 > BUDGET_MS;
}

/** 经 ssh 在服务器上执行一段 bash 脚本（base64 传输，规避引号地狱）。 */
async function sshScript(script, timeoutMs) {
  const b64 = Buffer.from(script).toString('base64');
  const remote = `echo ${b64} | base64 -d | bash`;
  const { stdout, stderr } = await execFileP('ssh', [opt.sshTarget, remote], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/** 服务器侧凭据解析脚本：DB settings 覆盖 env；key 取 API_KEYS 首个。 */
const CRED_SCRIPT = `
set -a
. ${ENV_FILE}
set +a
cd /root/fuckopencode
CREDS=$(node - <<'JS'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('${DB_FILE}');
let u = '', p = '';
for (const k of ['adminUser', 'adminPass']) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  if (r) { try { const v = JSON.parse(r.value); if (k === 'adminUser') u = v; else p = v; } catch {} }
}
process.stdout.write(u + '\\n' + p);
JS
)
U=$(printf '%s' "$CREDS" | sed -n '1p')
P=$(printf '%s' "$CREDS" | sed -n '2p')
[ -z "$U" ] && U=\${ADMIN_USER:-admin}
[ -z "$P" ] && P=\${ADMIN_PASS:-13141516}
printf 'SMOKE_CRED key=%s\\n' "$(printf '%s' "\${API_KEYS%%,*}" | base64 | tr -d '\\n')"
printf 'SMOKE_CRED user=%s\\n' "$(printf '%s' "$U" | base64 | tr -d '\\n')"
printf 'SMOKE_CRED pass=%s\\n' "$(printf '%s' "$P" | base64 | tr -d '\\n')"
`;

/** 从服务器取凭据到内存（base64 解码，绝不打印）。返回 {key,user,pass} 或 null。 */
async function fetchServerCreds() {
  try {
    const { stdout } = await sshScript(CRED_SCRIPT, 20_000);
    const creds = { key: '', user: '', pass: '' };
    for (const line of stdout.split('\n')) {
      const m = line.match(/^SMOKE_CRED (\w+)=(\S+)$/);
      if (!m) continue;
      const decoded = Buffer.from(m[2], 'base64').toString('utf8');
      if (m[1] === 'key') creds.key = decoded;
      else if (m[1] === 'user') creds.user = decoded;
      else if (m[1] === 'pass') creds.pass = decoded;
    }
    return creds;
  } catch {
    return null;
  }
}

/** 本机 → 公网全链路的 HTTP 请求。 */
async function http(url, { method = 'GET', headers = {}, body, timeoutMs = opt.timeout * 1000 } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, text, setCookie: res.headers.get('set-cookie') };
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ---------------------------------------------------------------------------
// 公网部分
// ---------------------------------------------------------------------------
async function runPublic(creds) {
  const key = opt.key || (creds && creds.key) || '';
  const user = opt.userSet ? opt.user : (creds && creds.user) || opt.user;
  const pass = opt.pass || (creds && creds.pass) || '';
  const hasAdmin = opt.pass !== '' || (creds && creds.user && creds.pass);

  if (overBudget()) return reportSkip('公网 剩余检查', '总时长预算超限');
  try {
    const r = await http(`${PUBLIC_BASE}/healthz`);
    const j = tryJson(r.text);
    // 实测：FurCDN 边缘会直接拦截 /healthz 回「ok」纯文本（不落到网关）；
    // 网关自身回 {"ok":true}。两者都是「公网边缘健康」的正向信号，都算过，
    // 在 detail 里标明是哪一种。
    const bodyOk = j?.ok === true || r.text.trim() === 'ok';
    const shape = j?.ok === true ? '{ok:true}(网关)' : r.text.trim() === 'ok' ? 'ok(FurCDN边缘拦截)' : r.text.trim().slice(0, 40);
    report('公网 healthz（FurCDN→网关）', r.status === 200 && bodyOk, `status=${r.status} body=${shape}`);
  } catch (e) {
    report('公网 healthz（FurCDN→网关）', false, `请求失败: ${e.message}`);
  }

  if (overBudget()) return reportSkip('公网 剩余检查', '总时长预算超限');
  try {
    const r = await http(`${PUBLIC_BASE}/__admin`);
    report('公网 面板页 /__admin', r.status === 200, `status=${r.status}`);
  } catch (e) {
    report('公网 面板页 /__admin', false, `请求失败: ${e.message}`);
  }

  if (!hasAdmin) {
    reportSkip('公网 面板登录', '无凭据（用 --pass/SMOKE_ADMIN_PASS，或保证 ssh 可达以从服务器取）');
    reportSkip('公网 面板会话（/__admin/api/accounts）', '上一步登录被跳过');
  } else if (overBudget()) {
    reportSkip('公网 面板登录', '总时长预算超限');
  } else {
    try {
      const loginBody = JSON.stringify({ username: user, password: pass });
      const r = await http(`${PUBLIC_BASE}/__admin/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: loginBody,
      });
      const ok = r.status === 200 && r.setCookie != null;
      report('公网 面板登录', ok, `status=${r.status}${r.setCookie ? ' 有会话cookie' : ''}`);
      if (ok) {
        const cookie = r.setCookie.split(';')[0].trim();
        if (overBudget()) {
          reportSkip('公网 面板会话（/__admin/api/accounts）', '总时长预算超限');
        } else {
          try {
            const a = await http(`${PUBLIC_BASE}/__admin/api/accounts`, { headers: { cookie } });
            const aj = tryJson(a.text);
            const listLen = Array.isArray(aj?.list) ? aj.list.length : -1;
            report('公网 面板会话（/__admin/api/accounts）', a.status === 200 && listLen >= 0, `status=${a.status} 账户数=${listLen}`);
            // legacy 404 噪音回归（2026-08-15）：前端 tick 用 legacyWorkspaceId
            // 决定是否请求 legacy 端点（无 legacy 的 OAuth/env 账号不再每 2s
            // 打 404）。列表接口必须带该字段，否则守卫退化成「全部请求 404」。
            if (a.status === 200 && listLen > 0) {
              const hasLegacyField = aj.list.some((x) => Object.prototype.hasOwnProperty.call(x, 'legacyWorkspaceId'));
              report('面板账号列表含 legacyWorkspaceId（前端守卫依据）', hasLegacyField, `字段=${hasLegacyField ? '有' : '缺失'}`);
            }
          } catch (e) {
            report('公网 面板会话（/__admin/api/accounts）', false, `请求失败: ${e.message}`);
          }
        }
      } else {
        report('公网 面板会话（/__admin/api/accounts）', false, '登录未成功，跳过');
      }
    } catch (e) {
      report('公网 面板登录', false, `请求失败: ${e.message}`);
    }
  }

  if (!key) {
    reportSkip('公网 模型目录 /v1/models', '无 key（用 --key/SMOKE_API_KEY，或保证 ssh 可达）');
    reportSkip('公网 数据面最小请求 /v1/chat/completions', '无 key');
  } else if (overBudget()) {
    reportSkip('公网 模型目录 /v1/models', '总时长预算超限');
  } else {
    try {
      const r = await http(`${PUBLIC_BASE}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
      const j = tryJson(r.text);
      const models = Array.isArray(j?.data) ? j.data.map((m) => m.id) : [];
      report('公网 模型目录 /v1/models', r.status === 200 && models.includes('deepseek-v4-flash'), `status=${r.status} 模型数=${models.length} [${models.join(', ')}]`);
    } catch (e) {
      report('公网 模型目录 /v1/models', false, `请求失败: ${e.message}`);
    }

    if (overBudget()) {
      reportSkip('公网 数据面最小请求 /v1/chat/completions', '总时长预算超限');
    } else {
      try {
        const r = await http(`${PUBLIC_BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: 'deepseek-v4-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
          timeoutMs: opt.chatTimeout * 1000,
        });
        const j = tryJson(r.text);
        const c = j?.choices?.[0]?.message?.content;
        const contentOk = typeof c === 'string' && c.length > 0;
        report('公网 数据面最小请求 /v1/chat/completions', r.status === 200 && contentOk, `status=${r.status} content=${contentOk ? c.length + '字符' : '空/缺失'} finish=${j?.choices?.[0]?.finish_reason}`);
      } catch (e) {
        report('公网 数据面最小请求 /v1/chat/completions', false, `请求失败: ${e.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ssh 本机部分（网关在 127.0.0.1:8787 上，凭据不出服务器）
// ---------------------------------------------------------------------------
function localScript(includeChat) {
  return `
set -a
. ${ENV_FILE}
set +a
cd /root/fuckopencode
KEY=\${API_KEYS%%,*}

gwc=$(curl -s -m 10 -o /tmp/fc_gw.bin -w '%{http_code}' http://127.0.0.1:8787/healthz)
printf 'SMOKE gwhealthz %s %s\\n' "$gwc" "$(cat /tmp/fc_gw.bin)"
ap=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H 'Host: fuckopencode.dwgx.top' http://127.0.0.1:8787/__admin)
printf 'SMOKE adminpage %s\\n' "$ap"

CREDS=$(node - <<'JS'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('${DB_FILE}');
let u = '', p = '';
for (const k of ['adminUser', 'adminPass']) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  if (r) { try { const v = JSON.parse(r.value); if (k === 'adminUser') u = v; else p = v; } catch {} }
}
process.stdout.write(u + '\\n' + p);
JS
)
U=$(printf '%s' "$CREDS" | sed -n '1p')
P=$(printf '%s' "$CREDS" | sed -n '2p')
[ -z "$U" ] && U=\${ADMIN_USER:-admin}
[ -z "$P" ] && P=\${ADMIN_PASS:-13141516}
BODY=$(node -e "process.stdout.write(JSON.stringify({username:process.argv[1],password:process.argv[2]}))" "$U" "$P")

login=$(curl -s -m 10 -D /tmp/fc_hdr.txt -o /dev/null -w '%{http_code}' -c /tmp/fc_smoke.jar -X POST 'http://127.0.0.1:8787/__admin/api/login' -H 'Host: fuckopencode.dwgx.top' -H 'content-type: application/json' -H 'accept: application/json' -d "$BODY")
printf 'SMOKE login %s\\n' "$login"
if [ "$login" = "200" ]; then
  COOKIE=$(sed -n 's/^[Ss]et-[Cc]ookie: \\([^;]*\\);.*/\\1/p' /tmp/fc_hdr.txt | head -1)
  acc=$(curl -s -m 10 -H 'Host: fuckopencode.dwgx.top' -H "Cookie: $COOKIE" 'http://127.0.0.1:8787/__admin/api/accounts')
  printf 'SMOKE accounts 200 %s\n' "$acc"
  # Go 一致性对照：面板 legacy go 端点 vs 官网 zen usage 直调 + 旧版控制台 cookie 页开关。
  # key/cookie 全部在服务器内解密使用，明文不出服务器；输出仅含用量百分比与开关布尔。
  SMOKE_COOKIE="$COOKIE" node - <<'JS'
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const material = fs.readFileSync('data/secret.key', 'utf8').trim();
const key = crypto.createHash('sha256').update(material, 'utf8').digest();
function decrypt(payload) {
  if (!payload || payload.slice(0, 2) !== '1:') return null;
  const raw = Buffer.from(payload.slice(2), 'base64');
  if (raw.length < 28) return null;
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) { return null; }
}
const db = new DatabaseSync('${DB_FILE}');
const rows = db.prepare('SELECT id, name, legacy_key_enc, legacy_cookie_enc, legacy_workspace_id FROM accounts ORDER BY id').all();
const targets = [];
for (const r of rows) {
  if (/outlook\\.com/i.test(r.name) || /gmail\\.com/i.test(r.name)) targets.push(r);
}
const cookie = process.env.SMOKE_COOKIE || '';
async function getJson(url, headers, ms) {
  try {
    const res = await fetch(url, { headers: headers, signal: AbortSignal.timeout(ms) });
    const text = await res.text();
    return { status: res.status, body: text };
  } catch (e) { return { status: 0, body: 'fetch-error: ' + e.message }; }
}
async function cookieSwitchesOf(ws, ck) {
  const url = 'https://opencode.ai/workspace/' + encodeURIComponent(ws) + '/go';
  const r = await getJson(url, { cookie: ck, accept: 'text/html' }, 20000);
  if (r.status !== 200) return { ok: false, reason: 'cookie 页 status=' + r.status };
  const html = r.body;
  if (!html.includes('lite.subscription.get[') && !html.includes('billing.get[')) return { ok: false, reason: 'cookie 页非 go 页' };
  const ub = /useBalance:!([01])/.exec(html);
  const cf = /name="useChinaProviders"[^>]*><label[^>]*><input type="checkbox"([^>]*)>/.exec(html);
  return { ok: true, useBalance: ub ? ub[1] === '0' : false, chinaModels: cf ? /\\bchecked\\b/.test(cf[1] || '') : false };
}
(async function () {
  const accs = [];
  for (const r of targets) {
    const lk = decrypt(r.legacy_key_enc);
    const ck = decrypt(r.legacy_cookie_enc);
    const zen = lk ? await getJson('https://opencode.ai/zen/go/v1/usage', { authorization: 'Bearer ' + lk, accept: 'application/json' }, 20000) : null;
    const panel = await getJson('http://127.0.0.1:8787/__admin/api/legacy/account/' + r.id + '/go', { cookie: cookie, accept: 'application/json' }, 15000);
    const csw = ck && r.legacy_workspace_id ? await cookieSwitchesOf(r.legacy_workspace_id, ck) : { ok: false, reason: '无 legacy cookie' };
    accs.push({ id: r.id, name: r.name, hasKey: Boolean(lk), panel: panel, zen: zen, cookieSwitches: csw });
  }
  const out = JSON.stringify({ accs: accs });
  process.stdout.write('SMOKE goconsist ok ' + Buffer.from(out).toString('base64') + '\\n');
})();
JS
fi
rm -f /tmp/fc_smoke.jar /tmp/fc_hdr.txt

if [ -n "$KEY" ]; then
  mc=$(curl -s -m 10 -o /tmp/fc_models.bin -w '%{http_code}' -H 'Host: fuckopencode.dwgx.top' -H "Authorization: Bearer $KEY" 'http://127.0.0.1:8787/v1/models')
  printf 'SMOKE models %s %s\\n' "$mc" "$(cat /tmp/fc_models.bin)"
${includeChat ? `
  cc=$(curl -s -m 25 -o /tmp/fc_chat.bin -w '%{http_code}' -H 'Host: fuckopencode.dwgx.top' -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"deepseek-v4-flash","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}' 'http://127.0.0.1:8787/v1/chat/completions')
  printf 'SMOKE chat %s %s\n' "$cc" "$(cat /tmp/fc_chat.bin)"
  rm -f /tmp/fc_chat.bin
` : ''}
  # 错误如实传递：不存在的模型被模型门拒绝（400，不耗额度）。断言错误体带原始文案。
  eb=$(curl -s -m 15 -o /tmp/fc_err.bin -w '%{http_code}' -H 'Host: fuckopencode.dwgx.top' -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"deepseek-v4-flash-nonexistent","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}' 'http://127.0.0.1:8787/v1/chat/completions')
  printf 'SMOKE errprobe %s %s\n' "$eb" "$(base64 < /tmp/fc_err.bin | tr -d '\n')"
  rm -f /tmp/fc_err.bin
  rm -f /tmp/fc_models.bin /tmp/fc_gw.bin
fi
`;
}

async function runLocal(includeChat) {
  let out;
  try {
    out = await sshScript(localScript(includeChat), 90_000);
  } catch (e) {
    const why = `ssh 失败: ${String(e.stderr || e.message).split('\n')[0].slice(0, 200)}`;
    for (const name of ['网关本机 healthz 8787', '本机 面板页 /__admin', '本机 面板登录', '本机 面板会话', '本机 模型目录', '本机 数据面请求']) {
      report(name, false, why);
    }
    return;
  }
  const map = {};
  for (const line of out.stdout.split('\n')) {
    if (!line.startsWith('SMOKE ')) continue;
    const [tag, name, ...rest] = line.split(' ');
    map[name] = { code: rest[0] ?? '', body: rest.slice(1).join(' ') };
  }

  const gw = map.gwhealthz;
  if (gw) {
    const j = tryJson(gw.body);
    report('网关本机 healthz 8787', gw.code === '200' && j?.ok === true, `status=${gw.code} ok=${j?.ok}`);
  } else report('网关本机 healthz 8787', false, '无输出');

  const ap = map.adminpage;
  if (ap) report('本机 面板页 /__admin', ap.code === '200', `status=${ap.code}`);
  else report('本机 面板页 /__admin', false, '无输出');

  const login = map.login;
  if (!login) {
    report('本机 面板登录', false, '无输出');
  } else if (login.code === '200') {
    report('本机 面板登录', true, 'status=200');
    const acc = map.accounts;
    if (acc) {
      const j = tryJson(acc.body);
      const listLen = Array.isArray(j?.list) ? j.list.length : -1;
      report('本机 面板会话（/__admin/api/accounts）', acc.code === '200' && listLen >= 0, `status=${acc.code} 账户数=${listLen}`);
    } else report('本机 面板会话（/__admin/api/accounts）', false, '无输出');
  } else if (login.code === '401') {
    report('本机 面板登录', false, 'status=401 凭据不被接受（DB/env 解析的用户名/密码不正确）');
    report('本机 面板会话（/__admin/api/accounts）', false, '登录未成功，跳过');
  } else if (login.code === '429') {
    report('本机 面板登录', false, 'status=429 该来源 IP 被登录限速锁定（5 次失败锁 5 分钟）');
    report('本机 面板会话（/__admin/api/accounts）', false, '登录未成功，跳过');
  } else {
    report('本机 面板登录', false, `status=${login.code}`);
    report('本机 面板会话（/__admin/api/accounts）', false, '登录未成功，跳过');
  }

  // NEW: Go 数据一致性对照官网（面板 legacy go vs 官网 zen 直调 + cookie 页开关）
  const gc = map.goconsist;
  if (gc) {
    let data = null;
    try {
      data = JSON.parse(Buffer.from(gc.body, 'base64').toString('utf8'));
    } catch {}
    if (!data || !Array.isArray(data.accs) || data.accs.length === 0) {
      report('面板 vs 官网 Go 数据一致性', false, '未找到 outlook/gmail 账号（或 goconsist 输出不可解析）');
    } else {
      for (const a of data.accs) {
        const label = `账号${a.id}(${a.name})`;
        const pj = tryJson(a.panel && a.panel.body);
        const go = pj && pj.ok === true && pj.data ? pj.data.go : null;
        const zj = tryJson(a.zen && a.zen.body);
        const zu = zj && zj.usage && typeof zj.usage === 'object' ? zj.usage : null;

        const goShapeOk =
          go != null &&
          typeof go.subscribed === 'boolean' &&
          typeof go.useBalance === 'boolean' &&
          typeof go.chinaModels === 'boolean' &&
          ['rolling', 'weekly', 'monthly'].every((n) => go[n] && typeof go[n].usagePercent === 'number');
        const shapeDetail = go
          ? `useBalance=${typeof go.useBalance} chinaModels=${typeof go.chinaModels} 窗口=${['rolling', 'weekly', 'monthly'].map((n) => (go[n] && typeof go[n].usagePercent === 'number' ? go[n].usagePercent + '%' : 'null')).join('/')}`
          : `面板 status=${a.panel && a.panel.status}`;
        report(`面板 Go 响应结构与开关字段  ${label}`, goShapeOk, shapeDetail);

        if (!go) {
          report(`面板 vs 官网 Go 用量(±5%)  ${label}`, false, '面板 go 数据缺失');
        } else if (!a.hasKey || !zu || (a.zen && a.zen.status !== 200)) {
          report(`面板 vs 官网 Go 用量(±5%)  ${label}`, false, `官网 zen 不可用（hasKey=${a.hasKey} zen_status=${a.zen ? a.zen.status : 'n/a'}）`);
        } else {
          const names = ['rolling', 'weekly', 'monthly'];
          const parts = [];
          let ok = true;
          for (const n of names) {
            const g = go[n];
            const z = zu[n];
            if (!g || typeof g.usagePercent !== 'number' || !z || typeof z.percent !== 'number') {
              parts.push(`${n}=缺失`);
              ok = false;
              continue;
            }
            const d = Math.abs(g.usagePercent - z.percent);
            parts.push(`${n}:面板${g.usagePercent}%官网${z.percent}%(Δ${d})`);
            if (d > 5) ok = false;
          }
          report(`面板 vs 官网 Go 用量(±5%)  ${label}`, ok, parts.join(' '));
        }

        const csw = a.cookieSwitches;
        if (csw && csw.ok === true && go) {
          const ubOk = go.useBalance === csw.useBalance;
          const cmOk = go.chinaModels === csw.chinaModels;
          report(`面板 vs cookie 页开关一致  ${label}`, ubOk && cmOk, `useBalance 面板=${go.useBalance}/cookie=${csw.useBalance}${ubOk ? '' : '(不符)'} chinaModels 面板=${go.chinaModels}/cookie=${csw.chinaModels}${cmOk ? '' : '(不符)'}`);
        } else if (go) {
          report(`面板 vs cookie 页开关一致  ${label}`, true, `cookie 页不可用（${csw && csw.reason ? csw.reason : '无 cookie'}），仅验证开关为 boolean`);
        }
      }
    }
  } else if (login && login.code === '200') {
    reportSkip('面板 vs 官网 Go 数据一致性', '服务器未产出 goconsist 数据');
  }

  const models = map.models;
  if (models) {
    const j = tryJson(models.body);
    const arr = Array.isArray(j?.data) ? j.data.map((m) => m.id) : [];
    report('本机 模型目录 /v1/models', models.code === '200' && arr.includes('deepseek-v4-flash'), `status=${models.code} 模型数=${arr.length} [${arr.join(', ')}]`);
  } else report('本机 模型目录 /v1/models', false, '无输出');

  if (includeChat) {
    const chat = map.chat;
    if (chat) {
      const j = tryJson(chat.body);
      const c = j?.choices?.[0]?.message?.content;
      const contentOk = typeof c === 'string' && c.length > 0;
      report('本机 数据面最小请求 /v1/chat/completions', chat.code === '200' && contentOk, `status=${chat.code} content=${contentOk ? c.length + '字符' : '空/缺失'} finish=${j?.choices?.[0]?.finish_reason}`);
    } else report('本机 数据面最小请求 /v1/chat/completions', false, '无输出');
  }

  // NEW: 错误如实传递 —— 不存在的模型被数据面拒绝，错误体带原始文案
  const err = map.errprobe;
  if (err) {
    let bodyText = '';
    try {
      bodyText = Buffer.from(err.body, 'base64').toString('utf8');
    } catch {}
    const j = tryJson(bodyText);
    const msg = j && j.error ? String(j.error.message || '') : bodyText;
    const ok =
      err.code === '400' &&
      j != null &&
      j.error != null &&
      j.error.type === 'invalid_request_error' &&
      typeof j.error.message === 'string' &&
      j.error.message.includes('deepseek-v4-flash-nonexistent') &&
      j.error.message.includes('not allowed');
    report('错误如实传递（不存在的模型被数据面拒绝）', ok, `status=${err.code} type=${j && j.error ? j.error.type : '?'} msg="${msg.slice(0, 100)}"`);
  } else if (login && login.code === '200') {
    reportSkip('错误如实传递（不存在的模型被数据面拒绝）', '服务器未产出 errprobe 数据');
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const modeLabel = opt.mode === 'public' ? '公网（--only-public）' : opt.mode === 'local' ? 'ssh 本机（--only-local）' : '全链路（公网 + ssh）';
  console.log(`== 网关 smoke test  ${modeLabel} ==\n`);

  let creds = null;
  if (opt.mode !== 'local' && (opt.key === '' || opt.pass === '')) {
    creds = await fetchServerCreds();
    if (creds) {
      const gotKey = Boolean(opt.key || creds.key);
      const gotAdmin = Boolean(opt.pass || (creds.user && creds.pass));
      console.log(`（服务器凭据就绪：key=${gotKey ? '有' : '无'} admin=${gotAdmin ? '有' : '无'}——仅存内存，不打印）\n`);
    }
  }

  if (opt.mode !== 'local') await runPublic(creds);
  if (opt.mode !== 'public') await runLocal(opt.mode === 'local');

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skip);
  console.log(`\n${results.length - failed.length}/${results.length} 通过` + (skipped.length ? `，${skipped.length} 跳过` : ''));
  if (failed.length) console.log(`（${failed.length} 项未通过，详见上方 FAIL/SKIP）`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('SMOKE ERROR', e); process.exit(1); });
