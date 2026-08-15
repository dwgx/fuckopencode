import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_HTML, LOGIN_HTML, originAllowed, parseAccountId, validateCreateAccount, validatePatchAccount, validateModelAlias } from '../src/admin.js';
import { UsageDb } from '../src/usagedb.js';
import { deleteModelAlias, loadModelAliases, saveModelAlias, seedDefaultModelAliases, DEFAULT_MODEL_ALIASES } from '../src/modelmap.js';
import { resolveModelName } from '../src/deepseek.js';
import { createApp, LEGACY_TTL_MS, LegacyTtlCache } from '../src/server.js';
import type { LegacyBillingReadResult, LegacyClientLike, LegacyGoReadResult, LegacyGoStatus, LegacyReadResult, LegacyWriteResult } from '../src/server.js';
import { AccountsStore } from '../src/accounts.js';
import { KeyPool, keyFingerprint } from '../src/keypool.js';
import { loadSecret } from '../src/secrets.js';
import { ModelAccessStore } from '../src/modelaccess.js';
import type { AppConfig } from '../src/config.js';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 管理面板的盲区兜底测试（照抄 test/dashboard.test.ts 的模式）。
 *
 * ADMIN_HTML 是 String.raw 模板：CSS + HTML + 原生 JS 对 TypeScript 而言只是
 * 字符串，不受任何静态检查保护。内联 `<script>` 过 `new Function()` 解析是
 * 唯一能抓住模板里语法错误的检查。校验函数（validate*）是 TS 层代码，
 * 可以正常单测 —— 契约 §6.3 的字段校验规则钉在这里。
 */

/** 抠出内联 `<script>` 的内容。 */
function inlineScript(): string {
  const m = ADMIN_HTML.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('面板 HTML 里找不到内联 <script>');
  return m[1]!;
}

describe('管理面板内联 JS 的语法完整性', () => {
  it('内联 script 能被 JS 引擎解析（唯一能抓住模板里语法错误的检查）', () => {
    const code = inlineScript();
    expect(code.length).toBeGreaterThan(1000);
    expect(() => new Function(code)).not.toThrow();
  });

  it('模板里没有漏进反引号（会提前闭合 String.raw 模板）', () => {
    expect(ADMIN_HTML).not.toContain('`');
  });

  it('没有未被 String.raw 处理的 ${} 插值残留', () => {
    expect(ADMIN_HTML).not.toContain('${');
  });
});

describe('管理面板关键渲染入口没有被误删', () => {
  it('账号卡渲染函数存在且被 render 真正调用', () => {
    const code = inlineScript();
    expect(code).toContain('function accountCard(');
    expect(code).toContain('function render(');
    expect(code).toMatch(/el\.innerHTML\s*=\s*list\.map\(accountCard\)/);
  });

  it('冷却倒计时定时器被装上（data-rc 模式）', () => {
    const code = inlineScript();
    expect(code).toContain('function tickCountdown(');
    expect(code).toContain('data-rc="\' + (now + a.retryInMs)');
    expect(code).toMatch(/setInterval\(\s*tickCountdown/);
  });

  it('2 秒轮询 /__admin/api/accounts', () => {
    const code = inlineScript();
    expect(code).toContain("fetch('/__admin/api/accounts'");
    expect(code).toMatch(/setInterval\(\s*tick\s*,\s*2000\s*\)/);
  });

  it('写操作全部走同源 fetch，且 POST/PATCH/DELETE 都有调用点', () => {
    const code = inlineScript();
    for (const m of ["api('POST'", "api('PATCH'", "api('DELETE'"]) {
      expect(code).toContain(m);
    }
    expect(code).toContain("headers: { 'content-type': 'application/json' }");
  });

  it('事件委托接管所有卡片按钮（动态 innerHTML 无法绑监听器）', () => {
    const code = inlineScript();
    expect(code).toMatch(/\$\(['"]accounts['"]\)\.addEventListener\(['"]click['"]/);
    expect(code).toContain("btn.getAttribute('data-action')");
    for (const act of ['edit', 'save', 'billing', 'addkey', 'renamekey', 'delkey', 'delete']) {
      expect(code).toContain(`'${act}'`);
    }
  });

  it('骨架里有面板需要的挂载点', () => {
    for (const id of ['accounts', 'stat-accounts', 'stat-healthy', 'degraded', 'c-name', 'c-kind-toggle', 'c-keys', 'btn-create']) {
      expect(ADMIN_HTML).toContain(`id="${id}"`);
    }
  });
});

describe('重构后的 UI 骨架（tabs / sidebar / dropdown / OAuth 弹层）', () => {
  it('tab 栏与切换逻辑存在（四个视图 + switchView）', () => {
    const code = inlineScript();
    expect(ADMIN_HTML).toContain('id="tabs"');
    expect(ADMIN_HTML).toMatch(/data-tab="overview"[\s\S]*data-tab="accounts"[\s\S]*data-tab="usage"[\s\S]*data-tab="settings"/);
    expect(code).toContain('function switchView(');
    for (const v of ['overview', 'accounts', 'usage', 'settings']) {
      expect(code).toContain(`${v}: 'view-${v}'`);
    }
    expect(code).toContain('view-' + "'" + ' + name');
  });

  it('sidebar 存在且按当前 tab 渲染子导航（renderSubnav + 锚点）', () => {
    const code = inlineScript();
    expect(ADMIN_HTML).toContain('id="sidebar"');
    expect(ADMIN_HTML).toContain('class="sidebar"');
    expect(code).toContain('function renderSubnav(');
    expect(code).toContain("$('sidebar').addEventListener('click'");
    expect(code).toContain('scrollIntoView');
    for (const sec of ['sec-overview', 'sec-accounts', 'sec-usage-summary', 'sec-settings-lang']) {
      expect(ADMIN_HTML).toContain(`id="${sec}"`);
    }
  });

  it('dropdown 渲染/开关/外部与 Escape 关闭逻辑存在', () => {
    const code = inlineScript();
    expect(ADMIN_HTML).toContain('id="lang-menu"');
    expect(ADMIN_HTML).toContain('dd-menu');
    expect(code).toContain('function toggleMenu(');
    expect(code).toContain('function closeMenus(');
    expect(code).toContain("document.addEventListener('click'");
    expect(code).toContain('closest(\'.dd-toggle\')');
    expect(code).toMatch(/addEventListener\(['"]keydown['"]/);
    expect(code).toContain("e.key !== 'Escape'");
  });

  it('OAuth 弹层骨架与前端流程函数存在（start/poll/done/error/close/copy）', () => {
    const code = inlineScript();
    expect(ADMIN_HTML).toContain('id="oauth-overlay"');
    expect(ADMIN_HTML).toContain('id="oauth-url"');
    expect(ADMIN_HTML).toContain('id="oauth-code"');
    expect(ADMIN_HTML).toContain('id="oauth-retry"');
    expect(code).toContain("'/__admin/api/oauth/start'");
    expect(code).toContain("'/__admin/api/oauth/poll'");
    for (const fn of ['startOAuth', 'openOAuth', 'oauthPoll', 'oauthDone', 'oauthError', 'closeOAuth', 'copyOAuthUrl']) {
      expect(code).toContain(`function ${fn}(`);
    }
    expect(code).toContain('expiresIn');
    expect(code).toContain('verificationUriComplete');
    // oauthError 覆盖后端全部失败原因：expired/denied/not_found/net + 兜底 fail。
    expect(code).toContain("reason === 'expired'");
    expect(code).toContain("reason === 'denied'");
    expect(code).toContain("reason === 'not_found'");
    expect(code).toContain("reason === 'net'");
  });

  it('用量视图渲染 /__metrics（renderUsage + fetchUsage + key 池 + 事件列表）', () => {
    const code = inlineScript();
    expect(ADMIN_HTML).toContain('id="u-total"');
    expect(ADMIN_HTML).toContain('id="u-keys"');
    expect(ADMIN_HTML).toContain('id="u-events"');
    expect(code).toContain('function renderUsage(');
    expect(code).toContain('function fetchUsage(');
    expect(code).toContain("fetch('/__metrics'");
  });

  it('操作审计视图：挂载点 + fetch/render + 接入 tick + i18n', () => {
    const code = inlineScript();
    // 挂载点：用量 tab 的审计 section。
    for (const id of ['sec-usage-audit', 'audit-events']) {
      expect(ADMIN_HTML).toContain(`id="${id}"`);
    }
    // 前端函数与数据源端点。
    expect(code).toContain('function renderAudit(');
    expect(code).toContain('function fetchAudit(');
    expect(code).toContain("'/__admin/api/audit?limit=50'");
    expect(code).toContain('fetchAudit();');  // tick 里每 2s 轮询
    // subnav 入口。
    expect(code).toContain("['subAudit', 'sec-usage-audit']");
  });
});

describe('UI v3：账户详情视图（console 数据展示）', () => {
  it('详情视图挂载点与视图注册存在', () => {
    for (const id of ['view-account-detail', 'sec-account-detail', 'detail-billing', 'detail-usage',
                      'detail-autorecharge', 'detail-budgets', 'detail-members', 'detail-sa',
                      'detail-providers', 'detail-cookie', 'detail-cookie-paste', 'detail-name',
                      'detail-back', 'detail-import', 'detail-paste-save', 'detail-cookie-import',
                      'detail-oauth', 'detail-oauth-row']) {
      expect(ADMIN_HTML).toContain(`id="${id}"`);
    }
    const code = inlineScript();
    expect(code).toContain("'account-detail': 'view-account-detail'");
    expect(code).toContain("'account-detail': [['subDetail', 'sec-account-detail']]");
    // cookie 失效横幅里的 OAuth 替代路径已接上 startOAuth（OAuth 弹层）。
    expect(code).toContain("$('detail-oauth').addEventListener('click', startOAuth)");
    // oauth-invalid 状态有专属文案与「隐藏 cookie 导入行」分支。
    expect(code).toContain("T('oauthInvalid')");
    expect(code).toContain("$('detail-cookie-import').hidden = oauthOnly");
  });

  it('详情渲染/加载函数存在（open/close/load + 各数据块）', () => {
    const code = inlineScript();
    for (const fn of ['openAccountDetail', 'closeAccountDetail', 'loadAccountDetail',
                      'renderBilling', 'renderUsageDetail', 'renderMembers',
                      'renderSa', 'renderProviders', 'renderBudgets', 'budgetRow', 'dBlock']) {
      expect(code, `缺 ${fn}`).toContain(`function ${fn}(`);
    }
    expect(code).toContain("'/__admin/api/console/account/' + id + '/billing'");
    expect(code).toContain("'/__admin/api/console/account/' + id + '/usage?range='");
    expect(code).toContain("'/__admin/api/console/account/' + id + '/members'");
    expect(code).toContain("'/__admin/api/console/account/' + id + '/keys'");
    expect(code).toContain("'/__admin/api/console/account/' + id + '/providers'");
    expect(code).toContain("'/__admin/api/console/account/' + id + '/budgets'");
    expect(code).toContain('/ 1e8');
    expect(code).toContain("money(s.totalCostMicroCents)");
  });

  it('卡片点击与菜单项都能进入详情（委托在 #accounts 上）', () => {
    const code = inlineScript();
    expect(code).toContain("if (act === 'detail') { openAccountDetail(id); return; }");
    expect(code).toContain("if (card) openAccountDetail(Number(card.getAttribute('data-id')));");
    expect(code).toContain("closest('button, input, select, .edit, .dd-menu, .key-add')");
    expect(code).toContain('class="card" data-id="\' + a.id + \'"');
    expect(code).toContain('data-action="detail"');
  });

  it('用量范围 24h 默认 + 7d 切换，tick 打开详情时联动刷新', () => {
    const code = inlineScript();
    expect(code).toContain("var detailState = { id: null, range: '7d'");
    expect(code).toContain('detailState.range = r;\n        loadUsage();');
    expect(code).toContain("loadBilling(detailState.id, !manual);");
    expect(code).toContain("loadGo(detailState.id, !manual);");
    expect(code).toContain("loadLegacyKeys(detailState.id, !manual);");
  });

  it('cookie 警示条按 cookieState 显示（invalid/missing/oauth-invalid）', () => {
    const code = inlineScript();
    expect(code).toContain("var cs = data.cookieState || 'ok';");
    expect(code).toContain("T('cookieInvalid')");
    expect(code).toContain("T('cookieMissing')");
    expect(code).toContain("T('oauthInvalid')");
    expect(code).toContain("'detail-cookie-t'");
    // oauth-invalid 是独立分支（不是 cookie 文案）：只有 oauth-invalid 才提示重新授权。
    expect(code).toContain('var oauthOnly = cs === \'oauth-invalid\';');
  });
});

describe('可用模型区块（detail-models：账号 allowedModels + 全局默认 + 目录状态）', () => {
  it('详情页挂载点 + DETAIL_BLOCK_KEYS 注册（骨架标题/副标题键与渲染一致）', () => {
    expect(ADMIN_HTML).toContain('id="detail-models"');
    const code = inlineScript();
    expect(code).toContain("['detail-models', 'allowedModelsTitle', 'allowedModelsSub']");
    expect(code).toContain('loadModels(id);');  // loadAccountDetail 里接线
  });

  it('渲染/加载/保存/清除函数都在，保存走 PATCH allowedModels（null/空 = 清除回全局）', () => {
    const code = inlineScript();
    for (const fn of ['renderModels', 'loadModels', 'saveModels', 'clearModels']) {
      expect(code, `缺 ${fn}`).toContain(`function ${fn}(`);
    }
    expect(code).toContain("api('PATCH', '/__admin/api/accounts/' + id, { allowedModels: parts.length ? parts : null })");
    expect(code).toContain("api('PATCH', '/__admin/api/accounts/' + id, { allowedModels: null })");
    expect(code).toContain('data-action="save-models"');
    expect(code).toContain('data-action="clear-models"');
    expect(code).toContain("if (act === 'save-models') { saveModels(Number(btn.getAttribute('data-id'))); return; }");
    expect(code).toContain("if (act === 'clear-models') { clearModels(Number(btn.getAttribute('data-id'))); return; }");
  });

  it('区块数据源：账号 allowedModels/blockedModels + /__metrics catalog（缺字段显示 —）', () => {
    const code = inlineScript();
    expect(code).toContain('Array.isArray(a.allowedModels)');
    expect(code).toContain('lastMetrics && lastMetrics.catalog');
    expect(code).toContain('Array.isArray(a.blockedModels)');
    // 全局默认只读列表 + 覆盖输入 + 清除提示。
    expect(code).toContain("var gm = ['deepseek-v4-flash', 'deepseek-v4-flash-free'];");
    expect(code).toContain("T('globalDefault')");
    expect(code).toContain("T('clearToGlobalHint')");
  });

  it('allowedModels/blockedModels 变化会触发面板重建（renderFingerprint 元组含两者）', () => {
    const code = inlineScript();
    expect(code).toContain('JSON.stringify(a.allowedModels || null)');
    expect(code).toContain('JSON.stringify(a.blockedModels || null)');
  });

  it('可用模型词条 en/zh 都有', () => {
    const en = new Set(codeOfDict('en'));
    const zh = new Set(codeOfDict('zh'));
    for (const k of ['allowedModelsTitle', 'allowedModelsSub', 'globalDefault', 'accountOverride',
                     'clearToGlobal', 'clearToGlobalHint', 'modelCatalog', 'catalogModels',
                     'catalogRefreshed', 'modelsBlocked', 'modelsSaved', 'modelsPlaceholder']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });
});

describe('UI v3：写操作 confirm 流程（自动充值/月限额/建删 key/导入 cookie）', () => {
  it('confirm 弹层骨架与流程函数存在', () => {
    expect(ADMIN_HTML).toContain('id="confirm-overlay"');
    expect(ADMIN_HTML).toContain('id="confirm-title"');
    expect(ADMIN_HTML).toContain('id="confirm-body"');
    expect(ADMIN_HTML).toContain('id="confirm-ok"');
    expect(ADMIN_HTML).toContain('id="confirm-cancel"');
    const code = inlineScript();
    for (const fn of ['openConfirm', 'closeConfirm', 'opDone',
                      'configureAutoRecharge', 'setMonthlyBudget', 'createSa', 'delSa', 'importCookie', 'pasteCookie']) {
      expect(code, `缺 ${fn}`).toContain(`function ${fn}(`);
    }
  });

  it('五个写操作都命中 console 契约端点', () => {
    const code = inlineScript();
    expect(code).toContain("'/__admin/api/console/account/' + id + '/auto-recharge'");
    expect(code).toContain("'/__admin/api/console/account/' + id + '/monthly-limit'");
    expect(code).toContain("'/__admin/api/console/account/' + id + '/keys'");
    expect(code).toContain("'/__admin/api/console/account/' + id + '/keys/' + encodeURIComponent(saId)");
    expect(code).toContain("'/__admin/api/console/import-cookie'");
    expect(code).toContain("api('PATCH', '/__admin/api/accounts/' + id, { cookie: val })");
  });

  it('写操作成功 flash + tick 刷新，失败留在弹层内报错', () => {
    const code = inlineScript();
    expect(code).toContain('flash(okMsg);');
    expect(code).toContain('tick();');
    expect(code).toContain("$('confirm-err').textContent = errMsg(r);");
    expect(code).toContain("ok.dataset.variant = opts.danger ? 'danger' : 'primary';");
    expect(code).toContain("if (!confirmState || $('confirm-ok').dataset.busy === '1') return;");
    expect(code).toContain('closeConfirm();');
  });

  it('弹层表单有字段校验（自动充值必填、月限额/名称非空）', () => {
    const code = inlineScript();
    expect(code).toContain("T('arRequiresAmount')");
    expect(code).toContain("T('invalidNumber')");
    expect(code).toContain("T('nameRequired')");
    expect(code).toContain("T('delSaConfirm')");
  });
});

describe('UI v3：设计规范差距修复', () => {
  it('a. input/select focus 光圈：accent 边框 + 3px accent-alpha 光圈', () => {
    expect(ADMIN_HTML).toContain('--accent-alpha: rgba(0,122,255,.15)');
    expect(ADMIN_HTML).toContain('box-shadow: 0 0 0 3px var(--accent-alpha);');
  });

  it('b. 侧栏 active：白字 700 + 白竖条', () => {
    expect(ADMIN_HTML).toContain('.snav.active { color: var(--text); font-weight: 700; }');
    expect(ADMIN_HTML).toContain('.snav.active::before { opacity: 1; background: var(--text); }');
  });

  it('c. 页面标题 h1 24px/500/uppercase + -0.03125rem 字距，描述 15px', () => {
    expect(ADMIN_HTML).toContain('letter-spacing: -0.03125rem');
    expect(ADMIN_HTML).toContain('h1 { font-size: 24px; font-weight: 500;');
    expect(ADMIN_HTML).toContain('.sub { color: var(--text-muted); font-size: 15px;');
    expect(ADMIN_HTML).not.toContain('letter-spacing: .05em');
  });

  it('d. modal：5px radius + fadeIn/slideUp + 居中 18px/600 标题 + dark overlay .7', () => {
    expect(ADMIN_HTML).toContain('border-radius: 5px;');
    expect(ADMIN_HTML).toContain('@keyframes modalIn');
    expect(ADMIN_HTML).toContain('transform: translateY(8px)');
    expect(ADMIN_HTML).toMatch(/\.oc-modal-hd \{[\s\S]*text-align: center;[\s\S]*font-weight: 600; font-size: 18px;/);
    expect(ADMIN_HTML).toContain('background: rgba(0,0,0,.7);');
  });

  it('e. 按钮：danger 令牌化 + disabled .5 + focus 2px 光圈（oc-btn 体系 + 旧类名别名）', () => {
    expect(ADMIN_HTML).toContain('--danger-hover: #d70015');
    expect(ADMIN_HTML).toContain('--danger-active: #a50011');
    expect(ADMIN_HTML).toContain('button.danger:hover, .oc-btn-danger:hover { background: var(--danger-hover);');
    expect(ADMIN_HTML).toContain('button.danger:active, .oc-btn-danger:active { background: var(--danger-active);');
    expect(ADMIN_HTML).toMatch(/button\[disabled\], \.oc-btn\[disabled\] \{[\s\S]*opacity: \.5;/);
    expect(ADMIN_HTML).toContain('box-shadow: 0 0 0 2px var(--accent-alpha);');
  });

  it('f. 表格 ≤40rem 缩水（8px 12px + 12px 字号 + 隐藏一列 t-hide）', () => {
    expect(ADMIN_HTML).toContain('.tbl { width: 100%;');
    expect(ADMIN_HTML).toMatch(/@media \(max-width: 40rem\)/);
    expect(ADMIN_HTML).toContain('.tbl th, .tbl td { padding: 8px 12px; font-size: 12px; }');
    expect(ADMIN_HTML).toContain('.tbl .t-hide { display: none; }');
    expect(ADMIN_HTML).toContain('class="t-hide"');
  });

  it('g. 设备码 24px 呼吸 + 状态三态（pending/成功绿/失败红）', () => {
    expect(ADMIN_HTML).toContain('padding: 24px 16px;');
    expect(ADMIN_HTML).toContain('.oauth-status { font-size: 12px; color: var(--text-muted);');
    expect(ADMIN_HTML).toContain('.oauth-status.ok { color: var(--ok); }');
    expect(ADMIN_HTML).toContain('.oauth-status.bad { color: var(--danger); }');
    expect(ADMIN_HTML).toContain("'oauth-status ok'");
    expect(ADMIN_HTML).toContain("T('oauthLoggedIn')");
  });

  it('h. 响应式：≤40rem 表单单列 + ≤30rem 区块/弹层收紧', () => {
    expect(ADMIN_HTML).toContain('.form, .edit { grid-template-columns: 1fr; }');
    expect(ADMIN_HTML).toMatch(/@media \(max-width: 30rem\)/);
    expect(ADMIN_HTML).toContain('section { margin-bottom: 24px; }');
    expect(ADMIN_HTML).toContain('.oc-modal { width: 300px; }');
  });

  it('详情区动态插值全部过 esc()（members/sa/providers/ledger 的远端值）', () => {
    const code = inlineScript();
    for (const s of ['esc(m.email || m.userId || \'—\')', 'esc(k.name || k.displayName', 'esc(p.name || p.configKey', 'esc(l.description || l.kind', 'esc(d.date || d.day'] ) {
      expect(code, `缺插值防护: ${s}`).toContain(s);
    }
  });
});

describe('面板可读性：状态友好文案 + 健康度口径', () => {
  it('状态枚举全部有友好文案映射（STATUS_KEYS，8 个状态全覆盖）', () => {
    const code = inlineScript();
    expect(code).toContain('var STATUS_KEYS = {');
    for (const st of ['unknown', 'ok', 'invalid', 'insufficient', 'limit', 'cooldown', 'region', 'error']) {
      expect(code, `缺 ${st} 的映射`).toContain(`${st}: 'st${st[0]!.toUpperCase()}${st.slice(1)}'`);
    }
    // 徽标不再直接输出英文枚举，统一过 statusText()。
    expect(code).not.toContain("'badge st-' + esc(a.status) + '\">' + esc(a.status)");
  });

  it('未探测有副标题解释（stUnknownHint，账号卡与健康度列表都有）', () => {
    const code = inlineScript();
    expect(code).toContain("T('stUnknownHint')");
    expect(code).toContain("a.status === 'unknown'");
  });

  it('健康度 X/Y（Y=有 key 的账号数）+ 等待探测说明（health-note）', () => {
    const code = inlineScript();
    expect(ADMIN_HTML).toContain('id="health-note"');
    expect(code).toContain("$('stat-healthy').textContent = okN + '/' + withKeys;");
    expect(code).toContain("if (hasK) withKeys++;");
    expect(code).toContain("T('healthNote')");
  });

  it('「最近探针 从未」→「等待首次探测」（probeFmt），余额「—」不变', () => {
    const code = inlineScript();
    expect(code).toContain("probeFmt(a.lastProbeAt)");
    expect(code).toContain("T('waitingProbe')");
  });

  it('长账号名截断 + title 悬浮全文（卡片与详情面包屑）', () => {
    expect(ADMIN_HTML).toContain('max-width: min(100%, 340px);');
    expect(ADMIN_HTML).toContain('class="name" title="');
    const code = inlineScript();
    expect(code).toContain("$('detail-name').title = a.name;");
  });
});

describe('key 昵称：面板显示 + 改名弹层', () => {
  it('key 行：有昵称昵称优先 + 指纹小字，hover 出「改名」', () => {
    const code = inlineScript();
    expect(code).toContain('k.nickname');
    expect(code).toContain('data-action="renamekey"');
    expect(code).toContain("T('rename')");
  });

  it('改名走 confirm 弹层（内联输入框 ≤30）+ PATCH keys/:fp，成功 flash 刷新', () => {
    const code = inlineScript();
    expect(code).toContain('function renameKey(');
    expect(code).toContain("'/__admin/api/accounts/' + id + '/keys/' + encodeURIComponent(fp)");
    expect(code).toContain('{ nickname: nick || null }');
    expect(code).toContain('maxlength="30"');
    expect(code).toContain("T('renameHint')");
    expect(code).toContain("T('renamed')");
    expect(code).toContain("opDone(r, T('renamed'))");
  });

  it('昵称变化会触发面板重建（renderFingerprint 的 key 元组含 nickname）', () => {
    const code = inlineScript();
    expect(code).toContain('k.disabledReason, k.nickname');
  });
});

describe('登录页 LOGIN_HTML：标准表单提交（浏览器保存密码）', () => {
  /** 抠出登录页内联 <script>。 */
  function loginScript(): string {
    const m = LOGIN_HTML.match(/<script>([\s\S]*)<\/script>/);
    if (!m) throw new Error('登录页 HTML 里找不到内联 <script>');
    return m[1]!;
  }

  it('form 带 action/method，输入框带 name 与 autocomplete（密码管理器的前提）', () => {
    expect(LOGIN_HTML).toContain('action="/__admin/api/login"');
    expect(LOGIN_HTML).toContain('method="post"');
    expect(LOGIN_HTML).toContain('name="username"');
    expect(LOGIN_HTML).toContain('name="password"');
    expect(LOGIN_HTML).toContain('autocomplete="username"');
    expect(LOGIN_HTML).toContain('autocomplete="current-password"');
  });

  it('不再有 fetch/preventDefault —— 提交交给浏览器原生表单 POST', () => {
    expect(LOGIN_HTML).not.toContain('preventDefault');
    expect(LOGIN_HTML).not.toContain("fetch('/__admin/api/login'");
  });

  it('错误/锁定提示由页面加载时读 query（login_error / login_locked）', () => {
    const code = loginScript();
    expect(code).toContain("q.get('login_error')");
    expect(code).toContain("q.get('login_locked')");
  });

  it('登录页内联 script 能被 JS 引擎解析', () => {
    expect(() => new Function(loginScript())).not.toThrow();
  });
});

describe('管理面板 i18n 词条 en/zh 对齐', () => {
  function dictKeys(lang: 'en' | 'zh'): string[] {
    const code = inlineScript();
    const start = code.indexOf(`${lang}:`);
    expect(start).toBeGreaterThan(-1);
    const slice = code.slice(start);
    const end = slice.indexOf('\n    }');
    const body = slice.slice(0, end > 0 ? end : 4000);
    return [...body.matchAll(/(?:^\s+|,\s*)([A-Za-z][\w]*)\s*:/gm)]
      .map((m) => m[1]!)
      .filter((k) => k !== lang);
  }

  it('两种语言的词条键集合一致', () => {
    const en = new Set(dictKeys('en'));
    const zh = new Set(dictKeys('zh'));
    expect(en.size).toBeGreaterThan(25);
    const onlyEn = [...en].filter((k) => !zh.has(k));
    const onlyZh = [...zh].filter((k) => !en.has(k));
    expect({ onlyEn, onlyZh }).toEqual({ onlyEn: [], onlyZh: [] });
  });

  it('本轮关键词条都在（en/zh 都有）', () => {
    const en = new Set(dictKeys('en'));
    const zh = new Set(dictKeys('zh'));
    for (const k of ['createTitle', 'accountsTitle', 'noAccounts', 'balance', 'retryIn',
                     'confirmDelete', 'refreshed', 'nameRequired', 'cookieClear', 'usedOf']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });

  it('可读性/昵称词条 en/zh 都有（状态文案 8 个 + 健康度 + key 昵称）', () => {
    const en = new Set(dictKeys('en'));
    const zh = new Set(dictKeys('zh'));
    for (const k of ['stUnknown', 'stOk', 'stInvalid', 'stInsufficient', 'stLimit', 'stCooldown',
                     'stRegion', 'stError', 'stUnknownHint', 'healthNote', 'waitingProbe',
                     'rename', 'nickname', 'renameHint', 'renamed']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });

  it('UI v3 词条 en/zh 都有（详情视图 + 写操作 + 设计修复）', () => {
    const en = new Set(dictKeys('en'));
    const zh = new Set(dictKeys('zh'));
    for (const k of ['detail', 'back', 'subDetail', 'currentBalance', 'promotional', 'ledger',
                     'paymentMethods', 'detailUsageTitle', 'requests', 'inputTokens', 'outputTokens',
                     'cost', 'autoRechargeTitle', 'enabled', 'disabled', 'threshold', 'rechargeAmount',
                     'configure', 'budgetsTitle', 'orgBudget', 'userBudget', 'notSet', 'set',
                     'membersTitle', 'memberEmail', 'role', 'joined', 'saTitle', 'saName', 'created',
                     'createSa', 'noSa', 'providersTitle', 'provider', 'modelCount', 'status',
                     'cookieInvalid', 'cookieMissing', 'importFromBrowser', 'importCookie',
                     'confirm', 'arModalTitle', 'arRequiresAmount', 'mlModalTitle', 'invalidNumber',
                     'saModalTitle', 'cookieModalBody', 'arSaved', 'mlSaved', 'saCreated',
                     'saDeleted', 'cookieImported', 'cookiePasted', 'consoleUnavailable',
                     'usageUnavailable', 'delSaConfirm', 'oauthLoggedIn', 'none', 'date',
                     'oauthInvalid', 'oauthInstead', 'oauthNotFound']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });

  it('词条内容里不含未替换的占位符残留', () => {
    const code = inlineScript();
    // 词条字典内部不应出现 {x} 占位符（本项目 i18n 不用占位符）。
    const dict = code.slice(code.indexOf('I18N'), code.indexOf('var lang'));
    expect(dict).not.toMatch(/\{[a-z]+\}/i);
  });

  it('所有 T() 引用的键都在字典里（缺词条会直接显示 key 名，静态检查看不见）', () => {
    const code = inlineScript();
    const en = new Set(dictKeys('en'));
    const used = [...code.matchAll(/T\(['"]([A-Za-z]\w*)['"]\)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(15);
    const missing = [...new Set(used)].filter((k) => !en.has(k));
    expect({ missing }).toEqual({ missing: [] });
  });

  it('本轮新词条（模型映射 + 用量表头）en/zh 都有', () => {
    const en = new Set(dictKeys('en'));
    const zh = new Set(dictKeys('zh'));
    for (const k of ['modelMapTitle', 'modelMapSub', 'modelAlias', 'modelTarget', 'modelNote',
                     'addMapping', 'modelMapNote', 'mmEmpty', 'mmRequired', 'mmSaved',
                     'mmDeleted', 'mmConfirmDel', 'subModelMap', 'hTime', 'hStatus',
                     'hRequest', 'hMs', 'hTokens']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });
});

describe('POST 创建账户的字段校验（§6.3）', () => {
  it('合法请求通过并做 trim 归一', () => {
    const v = validateCreateAccount({
      name: '  订阅主力号  ',
      kind: 'subscription',
      workspaceId: '  ws_abc  ',
      keys: ['  sk-a  ', 'sk-b', 'sk-a'],
      cookie: 'tok123',
    });
    expect(v).toEqual({
      ok: true,
      value: { name: '订阅主力号', kind: 'subscription', workspaceId: 'ws_abc', keys: ['sk-a', 'sk-b'], cookie: 'auth=tok123' },
    });
  });

  it('cookie 裸值自动补 auth= 前缀；完整 name=value 原样保留（B1）', () => {
    expect(validateCreateAccount({ name: 'a', kind: 'unknown', keys: [], cookie: 'Fe26.2*abc' })).toEqual({
      ok: true,
      value: { name: 'a', kind: 'unknown', workspaceId: null, keys: [], cookie: 'auth=Fe26.2*abc' },
    });
    expect(validateCreateAccount({ name: 'a', kind: 'unknown', keys: [], cookie: '__Host-console_session=x' })).toEqual({
      ok: true,
      value: { name: 'a', kind: 'unknown', workspaceId: null, keys: [], cookie: '__Host-console_session=x' },
    });
  });

  it('workspaceId/cookie 缺省或空串归一为 null', () => {
    expect(validateCreateAccount({ name: 'a', kind: 'unknown', keys: [] })).toEqual({
      ok: true,
      value: { name: 'a', kind: 'unknown', workspaceId: null, keys: [], cookie: null },
    });
    expect(validateCreateAccount({ name: 'a', kind: 'unknown', keys: [], workspaceId: '  ', cookie: '' })).toEqual({
      ok: true,
      value: { name: 'a', kind: 'unknown', workspaceId: null, keys: [], cookie: null },
    });
  });

  it('name 缺失/空白/超长 → 400', () => {
    expect(validateCreateAccount({ kind: 'payg', keys: [] }).ok).toBe(false);
    expect(validateCreateAccount({ name: '  ', kind: 'payg', keys: [] }).ok).toBe(false);
    expect(validateCreateAccount({ name: 'x'.repeat(101), kind: 'payg', keys: [] }).ok).toBe(false);
    expect(validateCreateAccount({ name: 'x'.repeat(100), kind: 'payg', keys: [] }).ok).toBe(true);
  });

  it('kind 只能是三选一', () => {
    expect(validateCreateAccount({ name: 'a', kind: 'prepaid', keys: [] }).ok).toBe(false);
    expect(validateCreateAccount({ name: 'a', kind: 42, keys: [] }).ok).toBe(false);
  });

  it('keys 必须是非空字符串数组，≤20 项，去重', () => {
    expect(validateCreateAccount({ name: 'a', kind: 'unknown', keys: 'sk-a' }).ok).toBe(false);
    expect(validateCreateAccount({ name: 'a', kind: 'unknown', keys: [''] }).ok).toBe(false);
    expect(validateCreateAccount({ name: 'a', kind: 'unknown', keys: [42] }).ok).toBe(false);
    expect(validateCreateAccount({ name: 'a', kind: 'unknown', keys: ['x'.repeat(201)] }).ok).toBe(false);
    expect(validateCreateAccount({ name: 'a', kind: 'unknown', keys: Array.from({ length: 21 }, (_, i) => `k${i}`) }).ok).toBe(false);
    expect(validateCreateAccount({ name: 'a', kind: 'unknown', keys: Array.from({ length: 20 }, (_, i) => `k${i}`) }).ok).toBe(true);
  });

  it('cookie/workspaceId 超长 → 400', () => {
    expect(validateCreateAccount({ name: 'a', kind: 'unknown', keys: [], cookie: 'x'.repeat(4097) }).ok).toBe(false);
    expect(validateCreateAccount({ name: 'a', kind: 'unknown', keys: [], cookie: 'x'.repeat(4096) }).ok).toBe(true);
    expect(validateCreateAccount({ name: 'a', kind: 'unknown', keys: [], workspaceId: 'x'.repeat(201) }).ok).toBe(false);
  });

  it('非对象请求体 → 400', () => {
    expect(validateCreateAccount(null).ok).toBe(false);
    expect(validateCreateAccount('str').ok).toBe(false);
    expect(validateCreateAccount([1, 2]).ok).toBe(false);
  });
});

describe('PATCH 部分更新校验（§6.3）', () => {
  it('只更新给了的字段；undefined 不更新', () => {
    const v = validatePatchAccount({ name: '  改名  ' });
    expect(v).toEqual({ ok: true, value: { name: '改名' } });
    expect(validatePatchAccount({ kind: 'payg' })).toEqual({ ok: true, value: { kind: 'payg' } });
  });

  it('cookie 空串 = 清除（传 null）；裸值补 auth= 前缀，完整串保留', () => {
    expect(validatePatchAccount({ cookie: '' })).toEqual({ ok: true, value: { cookie: null } });
    expect(validatePatchAccount({ cookie: null })).toEqual({ ok: true, value: { cookie: null } });
    expect(validatePatchAccount({ cookie: 'tok' })).toEqual({ ok: true, value: { cookie: 'auth=tok' } });
    expect(validatePatchAccount({ cookie: 'auth=tok' })).toEqual({ ok: true, value: { cookie: 'auth=tok' } });
  });

  it('空 patch / 坏 kind / 空白 name → 400', () => {
    expect(validatePatchAccount({}).ok).toBe(false);
    expect(validatePatchAccount({ kind: 'prepaid' }).ok).toBe(false);
    expect(validatePatchAccount({ name: '  ' }).ok).toBe(false);
    expect(validatePatchAccount(null).ok).toBe(false);
  });

  it('workspaceId 空串归一为 null（宽松清除），超长 → 400', () => {
    expect(validatePatchAccount({ workspaceId: '  ' })).toEqual({ ok: true, value: { workspaceId: null } });
    expect(validatePatchAccount({ workspaceId: 'x'.repeat(201) }).ok).toBe(false);
  });

  it('allowedModels：数组 trim/去重，null/空数组/全空串 = 清除回全局', () => {
    expect(validatePatchAccount({
      allowedModels: [' deepseek-v4-flash ', 'deepseek-v4-flash-free', 'deepseek-v4-flash'],
    })).toEqual({
      ok: true,
      value: { allowedModels: ['deepseek-v4-flash', 'deepseek-v4-flash-free'] },
    });
    expect(validatePatchAccount({ allowedModels: null })).toEqual({ ok: true, value: { allowedModels: null } });
    expect(validatePatchAccount({ allowedModels: [] })).toEqual({ ok: true, value: { allowedModels: null } });
    // 非数组 / 含非字符串 / 空串项（含纯空白）/ 超长 → 400（与 parseKeys 同口径）。
    expect(validatePatchAccount({ allowedModels: 'deepseek-v4-flash' }).ok).toBe(false);
    expect(validatePatchAccount({ allowedModels: [42] }).ok).toBe(false);
    expect(validatePatchAccount({ allowedModels: [''] }).ok).toBe(false);
    expect(validatePatchAccount({ allowedModels: ['  '] }).ok).toBe(false);
    expect(validatePatchAccount({ allowedModels: ['x'.repeat(101)] }).ok).toBe(false);
    expect(validatePatchAccount({ allowedModels: Array.from({ length: 51 }, (_, i) => `m${i}`) }).ok).toBe(false);
    expect(validatePatchAccount({ allowedModels: Array.from({ length: 50 }, (_, i) => `m${i}`) }).ok).toBe(true);
  });

  it('legacyKey：字符串保存（stripControl + 截断 2048），null/空串清除，超长/坏类型 400', () => {
    const key = 'sk-AOpQOUTje3uIJRVctKiLocPCaPPF1yWBQwOlwP7JfiOX47iCoL8BeTFTviyd0osU';
    expect(validatePatchAccount({ legacyKey: key })).toEqual({ ok: true, value: { legacyKey: key } });
    expect(validatePatchAccount({ legacyKey: null })).toEqual({ ok: true, value: { legacyKey: null } });
    expect(validatePatchAccount({ legacyKey: '' })).toEqual({ ok: true, value: { legacyKey: null } });
    // 控制符剥离（与 legacyCookie 同口径）。
    expect(validatePatchAccount({ legacyKey: 'sk-\x1babc' })).toEqual({ ok: true, value: { legacyKey: 'sk-abc' } });
    expect(validatePatchAccount({ legacyKey: 'x'.repeat(2048) }).ok).toBe(true);
    expect(validatePatchAccount({ legacyKey: 'x'.repeat(2049) }).ok).toBe(false);
    expect(validatePatchAccount({ legacyKey: 42 }).ok).toBe(false);
    expect(validatePatchAccount({ legacyKey: ['sk-x'] }).ok).toBe(false);
  });
});

describe(':id 路径参数校验（§6.3 必须 /^\d+$/）', () => {
  it('纯数字通过；其余 400', () => {
    expect(parseAccountId('1')).toBe(1);
    expect(parseAccountId('42')).toBe(42);
    expect(parseAccountId('0')).toBeNull();
    expect(parseAccountId('-1')).toBeNull();
    expect(parseAccountId('1.5')).toBeNull();
    expect(parseAccountId('abc')).toBeNull();
    expect(parseAccountId('1abc')).toBeNull();
    expect(parseAccountId('')).toBeNull();
  });
});

describe('语言下拉修复（设置页菜单贴到 section 右缘的回归）', () => {
  it('.dd 收缩宽度（inline-block）——块级全宽是菜单 right:0 贴右缘的根因', () => {
    expect(ADMIN_HTML).toContain('.dd { position: relative; display: inline-block; }');
  });

  it('.dd-menu 左对齐（left: 0）+ 菜单项字距/行高（参照 opencode）', () => {
    expect(ADMIN_HTML).toMatch(/\.dd-menu \{[\s\S]*left: 0;[\s\S]*min-width: 160px;/);
    expect(ADMIN_HTML).toMatch(/\.dd-item \{[\s\S]*padding: 6px 10px;[\s\S]*letter-spacing: \.02em;/);
    expect(ADMIN_HTML).toContain('.dd-item[data-selected="true"]');
  });
});

describe('用量 tab 容器化（统计卡/key 池/请求明细进卡片容器）', () => {
  it('统计卡用网格内嵌卡片（dashboard .grid/.cell 同款：gap 1px + surface 底）', () => {
    expect(ADMIN_HTML).toContain('.u-grid {');
    expect(ADMIN_HTML).toMatch(/\.u-grid \{[\s\S]*gap: 1px;[\s\S]*background: var\(--border\);/);
    expect(ADMIN_HTML).toContain('.u-cell { background: var(--surface);');
    expect(ADMIN_HTML).toContain('class="u-cell"');
    expect(ADMIN_HTML).toContain('id="u-total"');
    expect(ADMIN_HTML).toContain('id="u-avg"');
  });

  it('key 池（含「在飞」）包进 .panel 卡片容器', () => {
    expect(ADMIN_HTML).toContain('.panel {');
    expect(ADMIN_HTML).toContain('<div class="panel" id="u-keys"></div>');
    expect(ADMIN_HTML).toMatch(/T\('inFlight'\) \+ ' ' \+ k\.inFlight/);
  });

  it('请求明细用两行式条目（第一行固定列 + 第二行细节 r2）', () => {
    expect(ADMIN_HTML).toContain('.log-hd {');
    expect(ADMIN_HTML).toContain('.lent {');
    expect(ADMIN_HTML).toContain('class="log-hd"');
    expect(ADMIN_HTML).toContain('id="u-events"');
    const code = inlineScript();
    expect(code).toContain("'<div class=\"lent\">'");
    expect(code).toContain("'<span class=\"h-ms\">' + (e.durationMs != null ? msFmt(e.durationMs)");
    expect(code).toContain("'<span class=\"h-client cut\">' + esc(e.client");
    expect(code).toContain("'<span class=\"r2\">' + detail");
  });
});

describe('统一容器模板 .panel（opencode 风格：所有区块容器同一套盒子）', () => {
  it('.panel 模板：surface 底 + 1px border + 3px 圆角 + 16/20 内边距', () => {
    expect(ADMIN_HTML).toMatch(/\.panel \{[\s\S]*background: var\(--surface\);[\s\S]*border: 1px solid var\(--border\);[\s\S]*border-radius: var\(--radius\);[\s\S]*padding: 16px 20px;/);
  });

  it('.panel-hd（标题行）+ .panel-bd（内容区）模板存在：标题 14px/500/uppercase + muted 12px 副行', () => {
    expect(ADMIN_HTML).toContain('.panel-hd {');
    expect(ADMIN_HTML).toMatch(/\.panel-hd \{[\s\S]*border-bottom: 1px solid var\(--border-muted\);/);
    expect(ADMIN_HTML).toMatch(/\.panel-hd h1 \{[\s\S]*font-size: 14px;[\s\S]*font-weight: 500;[\s\S]*text-transform: uppercase;/);
    expect(ADMIN_HTML).toMatch(/\.panel-hd \.sub \{[\s\S]*font-size: 12px;[\s\S]*color: var\(--text-muted\);/);
    expect(ADMIN_HTML).toContain('.panel-bd { min-width: 0; }');
  });

  it('详情页区块堆叠间距：.panel.detail-panel 40px 间距（对齐 section 节距）', () => {
    expect(ADMIN_HTML).toContain('.panel.detail-panel { margin-top: 0; margin-bottom: 40px; }');
  });

  it('dBlock 输出 .panel 结构（详情页所有区块统一走模板）', () => {
    const code = inlineScript();
    expect(code).toContain("'<div class=\"panel detail-panel\"><div class=\"panel-hd\"><h1>'");
    expect(code).toContain("'<div class=\"panel-bd\">' + inner + '</div></div>'");
    expect(code).not.toContain('class="d-block"');
  });

  it('GO 订阅区块走 dBlock（标题 goSub + 三窗口进度条在 panel-bd 内）', () => {
    const code = inlineScript();
    expect(code).toContain("dBlock('goSub', 'goSubHint'");
    expect(code).toContain("'<div class=\"meter\"><div class=\"meter-bg\"><div class=\"meter-fill\"");
    expect(code).toContain('data-go-toggle="useBalance"');
  });

  it('renderGo 三窗口含每周行，百分比与重置时间同行（「每周 77% · 重置于 X」口径）', () => {
    const code = inlineScript();
    // 三窗口渲染序列必须包含每周行（用户要的 weekusage）。
    expect(code).toContain("row(T('goWeekly'), go.weekly)");
    // 重置时间拼进 go-pct 行内（· 分隔），不再单独占一行。
    expect(code).toContain("' · ' + T('goReset')");
    expect(code).toContain("pctTxt + '<span class=\"go-reset\">' + resetTxt");
    // 超额百分比钳到 100 画条（与 previewGoBox 同口径；renderGo 内而非 previewGoBox 内）。
    expect(code).toMatch(/function renderGo[\s\S]{0,1200}Math\.max\(0,\s*Math\.min\(100,\s*w\.usagePercent\)\)/);
  });

  it('容器内小卡去边框（防嵌套双框：preview-box / balance-card / balance-hero 无边框透明）', () => {
    expect(ADMIN_HTML).toContain('.preview-box { min-width: 0; }');
    expect(ADMIN_HTML).toContain('.balance-card { padding: 10px 14px; min-width: 148px; }');
    expect(ADMIN_HTML).toContain('.balance-hero { padding: 4px 0 12px; }');
    expect(ADMIN_HTML).not.toContain('.preview-box {\n    border: 1px solid var(--border-muted)');
    expect(ADMIN_HTML).not.toContain('.balance-hero {\n    border: 1px solid var(--border)');
    expect(ADMIN_HTML).not.toContain('.balance-card {\n    border: 1px solid var(--border-muted)');
  });

  it('.card 账号卡与 .stat2 统计卡对齐模板（border + 3px 圆角 + 16/20 内边距）', () => {
    expect(ADMIN_HTML).toMatch(/\.card \{[\s\S]*border: 1px solid var\(--border\);[\s\S]*border-radius: var\(--radius\);[\s\S]*padding: 16px 20px;/);
    expect(ADMIN_HTML).toMatch(/\.stat2 \{[\s\S]*border: 1px solid var\(--border\);[\s\S]*border-radius: var\(--radius\);/);
    expect(ADMIN_HTML).not.toContain('.d-block {');
  });
});

describe('账号不可用时隐藏空容器 + env 卡简化', () => {
  it('三个控制台字段全 null 时渲染单行提示而非三张「—」卡', () => {
    const code = inlineScript();
    expect(code).toContain('var noConsole = a.balance == null && a.monthlyLimit == null && a.monthlyUsage == null;');
    expect(code).toContain('var consoleBlock = noConsole');
    // 有数据时仍渲染三卡 + 用量条（不破坏正常路径）。
    expect(code).toContain("'<div class=\"balance-row\">'");
    expect(code).toContain('<div class="meter"><div class="meter-bg">');
  });

  it('env 账号（hasConsole=false）不渲染「未接入 · 缺少控制台登录态」提示', () => {
    const code = inlineScript();
    // 无控制台凭据的账号：consoleBlock 直接为空串（env 只是 key 池，与控制台无关）。
    expect(code).toMatch(/a\.hasConsole\s*[\s\S]*?waitingSync[\s\S]*?: ''\)/);
    expect(code).not.toContain("' · ' + T('cookieMissing')");
    // 有凭据的账号仍保留「已连接 · 余额随下次探测同步」。
    expect(code).toContain("T('waitingSync')");
  });
});

describe('模型映射 UI 与校验（设置页 sec-modelmap）', () => {
  it('设置页有映射表格 + 添加表单 + 描述（new-api 式简单表格）', () => {
    expect(ADMIN_HTML).toContain('id="sec-modelmap"');
    expect(ADMIN_HTML).toContain('id="mm-rows"');
    expect(ADMIN_HTML).toContain('id="mm-alias"');
    expect(ADMIN_HTML).toContain('id="mm-target"');
    expect(ADMIN_HTML).toContain('id="mm-note"');
    expect(ADMIN_HTML).toContain('id="mm-add"');
    expect(ADMIN_HTML).toContain('datalist');
  });

  it('前端三个端点调用都在（GET 列表 / POST 添加 / DELETE 删除）', () => {
    const code = inlineScript();
    expect(code).toContain("'/__admin/api/model-aliases'");
    expect(code).toContain("api('DELETE', '/__admin/api/model-aliases/' + encodeURIComponent(alias)");
    expect(code).toContain('function addModelAlias(');
    expect(code).toContain('function delModelAlias(');
    expect(code).toContain('function renderModelMap(');
    expect(code).toContain("if (v === 'settings') { refreshModelMap(); loadSettings(false); loadOtaStatus(false); }");
    expect(code).toContain('closest(\'button[data-action="del-alias"]\')');
  });

  it('POST 校验：alias 字符集/长度，target 非空，note 可选归一 null', () => {
    expect(validateModelAlias({ alias: '  claude-mythos-5  ', target: ' deepseek-v4-flash-free ', note: ' 备注 ' })).toEqual({
      ok: true,
      value: { alias: 'claude-mythos-5', target: 'deepseek-v4-flash-free', note: '备注' },
    });
    expect(validateModelAlias({ alias: 'gpt-4o', target: 'deepseek-v4-flash' })).toEqual({
      ok: true,
      value: { alias: 'gpt-4o', target: 'deepseek-v4-flash', note: null },
    });
    expect(validateModelAlias({ alias: 'x', target: 'y', note: '' }).ok).toBe(true);
    expect(validateModelAlias({ alias: 'x', target: 'y', note: '  ' }).ok).toBe(true);
    expect(validateModelAlias({ alias: '', target: 'y' }).ok).toBe(false);
    expect(validateModelAlias({ alias: 'claude mythos', target: 'y' }).ok).toBe(false);
    expect(validateModelAlias({ alias: 'claude/mythos', target: 'y' }).ok).toBe(false);
    expect(validateModelAlias({ alias: 'a'.repeat(101), target: 'y' }).ok).toBe(false);
    expect(validateModelAlias({ alias: 'a'.repeat(100), target: 'y' }).ok).toBe(true);
    expect(validateModelAlias({ alias: 'x', target: ' ' }).ok).toBe(false);
    expect(validateModelAlias({ alias: 'x', target: 'y'.repeat(101) }).ok).toBe(false);
    expect(validateModelAlias({ alias: 'x', target: 'y', note: 'z'.repeat(201) }).ok).toBe(false);
    expect(validateModelAlias({ alias: 'x', target: 'y', note: 42 }).ok).toBe(false);
    expect(validateModelAlias(null).ok).toBe(false);
    expect(validateModelAlias('str').ok).toBe(false);
  });
});

describe('模型映射存储层（modelmap.ts + usage db）', () => {
  let tmpDir: string;
  const log = (): void => {};

  it('增查改删 + upsert 覆盖 + 降级哲学', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-modelmap-'));
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    expect(db.enabled).toBe(true);

    expect(loadModelAliases(db)).toEqual([]);

    expect(saveModelAlias(db, 'claude-mythos-5', 'deepseek-v4-flash', '主力')).toBe(true);
    expect(saveModelAlias(db, 'claude-fable-5', 'deepseek-v4-flash-free')).toBe(true);
    let list = loadModelAliases(db);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ alias: 'claude-fable-5', target: 'deepseek-v4-flash-free', note: null });
    expect(list[1]).toEqual({ alias: 'claude-mythos-5', target: 'deepseek-v4-flash', note: '主力' });

    // 同 alias 再存 = 更新（UNIQUE + ON CONFLICT），行数不变。
    expect(saveModelAlias(db, 'claude-mythos-5', 'deepseek-v4-flash-free', null)).toBe(true);
    list = loadModelAliases(db);
    expect(list).toHaveLength(2);
    expect(list.find((m) => m.alias === 'claude-mythos-5')).toEqual({
      alias: 'claude-mythos-5', target: 'deepseek-v4-flash-free', note: null,
    });

    // 重启等价：新实例读同一文件，映射还在（启动合并的数据源）。
    db.close();
    const db2 = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    expect(loadModelAliases(db2)).toHaveLength(2);

    expect(deleteModelAlias(db2, 'claude-mythos-5')).toBe(true);
    expect(deleteModelAlias(db2, 'claude-mythos-5')).toBe(true); // 幂等
    expect(loadModelAliases(db2)).toHaveLength(1);

    db2.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('db 不可用（null）时全部降级：空列表 / false，不抛', () => {
    expect(loadModelAliases(null)).toEqual([]);
    expect(saveModelAlias(null, 'a', 'b')).toBe(false);
    expect(deleteModelAlias(null, 'a')).toBe(false);
    expect(seedDefaultModelAliases(null)).toBe(false);
  });

  it('seed：默认别名表为空（初始配置干净，无 fable/mythos 内部映射），表空时 no-op', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-seed-'));
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    expect(db.enabled).toBe(true);

    // 2026-08-14：默认别名清空 —— 初始配置不预设任何映射（fable/mythos 是内部
    // 测试别名，对部署者是「离谱映射」）。seed 空列表 = 每次启动 no-op。
    expect(DEFAULT_MODEL_ALIASES).toEqual([]);
    expect(seedDefaultModelAliases(db)).toBe(true);
    expect(loadModelAliases(db)).toEqual([]);

    // 用户手动加一条后，后续启动不再 seed（配置归属用户）。
    expect(saveModelAlias(db, 'claude-sonnet-4-6', 'deepseek-v4-flash')).toBe(true);
    db.close();
    const db2 = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    expect(seedDefaultModelAliases(db2)).toBe(false);
    expect(loadModelAliases(db2)).toHaveLength(1);

    // 用户删掉后依然不 seed（防「用户刻意删除」被还原）——默认别名表为空的
    // 时代价天然为零（无可还原内容），seed 空列表是 no-op。
    expect(deleteModelAlias(db2, 'claude-sonnet-4-6')).toBe(true);
    expect(seedDefaultModelAliases(db2)).toBe(true); // no-op（写入 0 条）
    expect(loadModelAliases(db2)).toHaveLength(0);

    db2.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('seed 产物能被 resolveModelName 命中（启动合并后即默认行为）', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-seed2-'));
    const db = new UsageDb(path.join(tmpDir, 'usage.db'), 30, log);
    seedDefaultModelAliases(db);
    const map: Record<string, string> = {};
    for (const m of loadModelAliases(db)) map[m.alias] = m.target;
    expect(resolveModelName('claude-mythos-5', map, 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(resolveModelName('claude-fable-5', map, 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('旧版 workspace 的 key 管控（legacy console 区块）', () => {
  function dictKeys(lang: 'en' | 'zh'): string[] {
    const code = inlineScript();
    const start = code.indexOf(`${lang}:`);
    expect(start).toBeGreaterThan(-1);
    const slice = code.slice(start);
    const end = slice.indexOf('\n    }');
    const body = slice.slice(0, end > 0 ? end : 4000);
    return [...body.matchAll(/(?:^\s+|,\s*)([A-Za-z][\w]*)\s*:/gm)]
      .map((m) => m[1]!)
      .filter((k) => k !== lang);
  }

  it('详情视图挂载点 + 加载/渲染/创建/删除函数与端点都在', () => {
    expect(ADMIN_HTML).toContain('id="detail-legacy"');
    const code = inlineScript();
    for (const fn of ['loadLegacyKeys', 'renderLegacyKeys', 'createLegacyKey', 'delLegacyKey', 'legacyOpDone']) {
      expect(code, `缺 ${fn}`).toContain(`function ${fn}(`);
    }
    expect(code).toContain("'/__admin/api/legacy/account/' + id + '/keys'");
    expect(code).toContain("'/__admin/api/legacy/account/' + id + '/keys/' + encodeURIComponent(keyId)");
    expect(code).toContain('loadLegacyKeys(id);');
    expect(code).toContain('loadLegacyKeys(detailState.id)');
  });

  it('失败语义：404 静默隐藏，cookie 错误明确提示，其余隐藏', () => {
    const code = inlineScript();
    expect(code).toContain("if (!r.ok && r.status === 404) { el.innerHTML = ''; return; }");
    expect(code).toContain("T('legacyCookieMissing')");
    expect(code).toContain('function isLegacyCookieError(');
    expect(code).toContain("indexOf('cookie') >= 0");
  });

  it('MINOR：go 的确定性配置错误（401/403）打点 TTL 门——2s tick 不再反复打无效 legacy key 的 zen', () => {
    const src = fnSource('loadGo');
    // 401/403 分支在 detailErr 前先 legacyDetailMark：无效 key / 无 cookie 是确定性
    // 失败，30s 内不重试；网络/上游失败（.catch）不打点，保留 2s 重试自愈。
    expect(src).toMatch(/r\.status === 401 \|\| r\.status === 403/);
    expect(src).toMatch(/legacyDetailMark\(id, 'go'\)/);
    const markIdx = src.indexOf('legacyDetailMark(id, \'go\')');
    const errIdx = src.indexOf("detailErr('go', T('legacyCookieMissing'))");
    expect(markIdx).toBeGreaterThan(-1);
    expect(errIdx).toBeGreaterThan(markIdx);
    expect(src).toMatch(/\.catch\(function \(\) \{ if \(detailState\.id !== id\) return; detailErr\('go', T\('consoleUnavailable'\)\);/);
    expect(src).not.toContain("legacyDetailMark(id, 'go')" + ";\n" + "        detailErr('go', T('consoleUnavailable')");
  });

  it('创建/删除走 confirm 弹层（danger 删除 + 名称非空校验 + 成功重拉列表）', () => {
    const code = inlineScript();
    expect(code).toContain("if (act === 'create-legacy-key') { createLegacyKey(); return; }");
    expect(code).toContain("if (act === 'del-legacy-key') { delLegacyKey(btn.getAttribute('data-keyid')); return; }");
    expect(code).toContain("if (act === 'refresh-legacy-keys') { loadLegacyKeys(detailState.id); return; }");
    expect(code).toContain('data-action="del-legacy-key" data-keyid="\' + esc(keyId)');
    expect(code).toContain("T('nameRequired')");
    expect(code).toContain("legacyOpDone(r, T('keyCreated'))");
    expect(code).toContain("legacyOpDone(r, T('keyDeleted'))");
    expect(code).toContain('danger: true');
  });

  it('legacy 词条 en/zh 都有', () => {
    const en = new Set(dictKeys('en'));
    const zh = new Set(dictKeys('zh'));
    for (const k of ['legacyKeys', 'legacySub', 'legacyCreateTitle', 'createKey', 'keyName',
                     'masked', 'creator', 'keyCreated', 'keyDeleted', 'delLegacyKeyConfirm',
                     'legacyCookieMissing', 'refreshKeys', 'noLegacyKeys']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });
});

describe('账号预览卡容器化（余额/用量/Go 数据区）', () => {
  function dictKeys(lang: 'en' | 'zh'): string[] {
    const code = inlineScript();
    const start = code.indexOf(`${lang}:`);
    expect(start).toBeGreaterThan(-1);
    const slice = code.slice(start);
    const end = slice.indexOf('\n    }');
    const body = slice.slice(0, end > 0 ? end : 4000);
    return [...body.matchAll(/(?:^\s+|,\s*)([A-Za-z][\w]*)\s*:/gm)]
      .map((m) => m[1]!)
      .filter((k) => k !== lang);
  }

  it('数据区容器：preview-cols 三列 + 余额/用量/Go 三个子容器 CSS 都在', () => {
    expect(ADMIN_HTML).toContain('.preview-cols {');
    expect(ADMIN_HTML).toContain('.preview-box {');
    expect(ADMIN_HTML).toContain('.preview-balance .balance-card {');
    expect(ADMIN_HTML).toContain('.preview-grid {');
    expect(ADMIN_HTML).toContain('.p-go-row {');
    expect(ADMIN_HTML).toContain('.preview-cols .p-note { grid-column: 1 / -1;');
    expect(ADMIN_HTML).toMatch(/@media \(max-width: 48rem\)/);
  });

  it('预览渲染/加载函数存在（渲染函数 + 加载函数 + 回填函数）', () => {
    const code = inlineScript();
    for (const fn of ['previewUsageBox', 'previewGoBox', 'fetchPreviewUsage', 'fetchPreviewGo', 'loadPreviewData', 'fillPreviewBox']) {
      expect(code, `缺 ${fn}`).toContain(`function ${fn}(`);
    }
    expect(code).toContain("var previewCache = {};");
    expect(code).toContain("var PREVIEW_TTL = 60 * 1000;");
  });

  it('预览数据独立于 2s tick：TTL 缓存 + 列表渲染后拉一次', () => {
    const code = inlineScript();
    expect(code).toContain('if (c && now - c.at < PREVIEW_TTL) continue;');
    expect(code).toContain("previewCache[id] = { at: now, usage: null, go: null, gw: null, legacy: null };");
    expect(code).toContain('loadPreviewData(list);');
    expect(code).toContain('loadPreviewData(state.list);');
    expect(code).toContain("'/__admin/api/console/account/' + id + '/usage?range=7d'");
    expect(code).toContain("'/__admin/api/legacy/account/' + id + '/go'");
  });

  it('用量三小格（请求/输出 tokens/成本）与 Go 三窗口（滚动/每周/每月）字段齐全', () => {
    const code = inlineScript();
    expect(code).toContain("T('requests')");
    expect(code).toContain("T('outputTokens')");
    expect(code).toContain("T('cost')");
    expect(code).toContain("T('goRolling')");
    expect(code).toContain("T('goWeekly')");
    expect(code).toContain("T('goMonthly')");
    expect(code).toContain('s.totalRequests != null ? fmt(s.totalRequests)');
    expect(code).toContain('s.totalCostMicroCents != null ? money(s.totalCostMicroCents)');
    expect(code).toContain('typeof w.usagePercent !== \'number\'');
  });

  it('无数据/失败时容器隐藏（返回空串，fill 不动作），有数据时 render 用缓存回填', () => {
    const code = inlineScript();
    expect(code).toContain('var usageBox = pc ? previewUsageHtml(pc) : \'\';');
    expect(code).toContain("var goBox = pc && pc.go ? previewGoBox(pc.go) : '';");
    expect(code).toContain('if (!rows) return \'\';');
    expect(code).toContain('if (!html) return;');
    expect(code).toContain('cols.insertAdjacentHTML(\'beforeend\', html);');
  });

  it('preview 词条 en/zh 都有', () => {
    const en = new Set(dictKeys('en'));
    const zh = new Set(dictKeys('zh'));
    for (const k of ['previewBalance', 'previewUsage', 'previewGo']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });

  it('refreshBalance 成功后清预览缓存并立即重拉（用量/Go 同源刷新）', () => {
    const code = inlineScript();
    expect(code).toContain('delete previewCache[id];');
    expect(code).toContain('loadPreviewData(state.list);');
  });
});

describe('前端全量改造：删除确认原生化 + 类型下拉 + 请求明细 + sidebar + tab 记忆 + 关于页', () => {
  it('删除/危险操作不再用浏览器原生 confirm()（全部走 openConfirm）', () => {
    const code = inlineScript();
    expect(code).not.toContain('window.confirm');
    expect(code).not.toContain('confirm(');
    // 三处危险操作都改成了 openConfirm + danger 确认弹层。
    expect(code).toContain('function delKey(');
    expect(code).toContain('function delAccount(');
    expect(code).toContain('function delModelAlias(');
    expect(code).toContain("body: '<div class=\"oc-hint\">' + T('confirmDeleteKey')");
    expect(code).toContain("body: '<div class=\"oc-hint\">' + T('confirmDelete')");
    expect(code).toContain("body: '<div class=\"oc-hint\">' + T('mmConfirmDel')");
    expect(code).toContain('danger: true');
  });

  it('创建表单类型下拉：原生 select 换成 dd-toggle + dd-menu（data-kind）', () => {
    expect(ADMIN_HTML).toContain('id="c-kind-toggle"');
    expect(ADMIN_HTML).toContain('id="c-kind-menu"');
    expect(ADMIN_HTML).not.toContain('<select id="c-kind"');
    expect(ADMIN_HTML).toMatch(/data-kind="subscription"[\s\S]*data-kind="payg"[\s\S]*data-kind="unknown"/);
    const code = inlineScript();
    expect(code).toContain("var cKind = 'subscription';");
    expect(code).toContain("$('c-kind-toggle').addEventListener('click'");
    expect(code).toContain("closest('.dd-item[data-kind]')");
    expect(code).toContain('cKind = kv;');
    expect(code).toContain('var kind = cKind;');
  });

  it('请求明细接 /__admin/api/requests 分页契约（20 条/页 + prev/next + 页码信息）', () => {
    const code = inlineScript();
    expect(code).toContain("'/__admin/api/requests?page=' + reqPage + '&pageSize=' + REQ_PAGE_SIZE");
    expect(code).toContain('var REQ_PAGE_SIZE = 20;');
    expect(code).toContain('var reqPage = 1, reqTotal = 0, reqQuery = \'\', reqShowAll = false;');
    expect(ADMIN_HTML).toContain('id="req-prev"');
    expect(ADMIN_HTML).toContain('id="req-next"');
    expect(ADMIN_HTML).toContain('id="req-info"');
    expect(code).toContain("$('req-prev').addEventListener('click'");
    expect(code).toContain("$('req-next').addEventListener('click'");
    expect(code).toContain("reqTotal = Number(d.total) || 0;");
    expect(code).toContain('function fetchRequests(');
    expect(code).toContain('function renderRequests(');
    expect(code).toContain('function renderReqNav(');
    expect(code).toContain("fetchRequests();");
  });

  it('请求明细字段全：时间/状态/路径/耗时/tokens/客户端/模型/key/端点/UA/错误', () => {
    const code = inlineScript();
    for (const f of ['e.at', 'e.status', 'e.path', 'e.durationMs', 'e.inputTokens', 'e.outputTokens',
                     'e.client', 'e.model', 'e.fingerprint', 'e.endpoint', 'e.ua', 'e.error']) {
      expect(code, `缺字段 ${f}`).toContain(f);
    }
    expect(ADMIN_HTML).toContain('data-i18n="hClient"');
  });

  it('sidebar 激活项自动滚动居中（focusSidebar + 容器可滚动）', () => {
    const code = inlineScript();
    expect(code).toContain('function focusSidebar(');
    expect(code).toContain('sb.scrollHeight - sb.clientHeight');
    expect(code).toContain('(sb.clientHeight - active.offsetHeight) / 2');
    expect(ADMIN_HTML).toContain('overflow-y: auto;');
    expect(code).toContain('focusSidebar();');
  });

  it('tab 与 sidebar 子项存 localStorage，初始化恢复（fc-admin-view / fc-admin-sub）', () => {
    const code = inlineScript();
    expect(code).toContain("localStorage.setItem('fc-admin-view', curView)");
    expect(code).toContain("localStorage.setItem('fc-admin-sub', curSub)");
    expect(code).toContain("localStorage.getItem('fc-admin-view')");
    expect(code).toContain("localStorage.getItem('fc-admin-sub')");
    expect(code).toContain('switchView(curView);');
    expect(code).toContain('function saveViewState(');
  });

  it('关于页列出 /__dash 端点', () => {
    expect(ADMIN_HTML).toContain('/__dash');
    expect(ADMIN_HTML).toContain('data-i18n="aboutEndpointDash"');
    const code = inlineScript();
    expect(code).toContain("aboutEndpointDash: 'dashboard'");
    expect(code).toContain("aboutEndpointDash: '仪表盘'");
  });

  it('新增词条 en/zh 都有（hClient/hFp/hUa/reqPrev/reqNext/reqPage/detailRequests）', () => {
    const code = inlineScript();
    const en = new Set([...code.slice(code.indexOf('en: {'), code.indexOf('zh: {')).matchAll(/(?:^\s+|,\s*)([A-Za-z][\w]*)\s*:/gm)].map((m) => m[1]!));
    const zh = new Set([...code.slice(code.indexOf('zh: {'), code.indexOf('var lang')).matchAll(/(?:^\s+|,\s*)([A-Za-z][\w]*)\s*:/gm)].map((m) => m[1]!));
    for (const k of ['hClient', 'hFp', 'hUa', 'reqPrev', 'reqNext', 'reqPage', 'detailRequests', 'aboutEndpointDash']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });
});

describe('卡片用量实际化：网关代理用量优先，org 用量回落', () => {
  it('usage-gateway 端点被拉取并缓存进 previewCache（gw 字段）', () => {
    const code = inlineScript();
    expect(code).toContain("function fetchPreviewGateway(");
    expect(code).toContain("'/__admin/api/accounts/' + id + '/usage-gateway?rangeDays=7'");
    expect(code).toContain('if (r.ok && r.json && r.json.ok !== false && r.json.data) c.gw = r.json.data;');
    expect(code).toContain('fetchPreviewGateway(id);');
    expect(code).toContain('gw: null, legacy: null');
  });

  it('previewGwBox 渲染请求/输入+输出 tokens/成本三小格，标题用 previewGwTitle', () => {
    const code = inlineScript();
    expect(code).toContain('function previewGwBox(');
    expect(code).toContain("T('previewGwTitle')");
    expect(code).toContain("fmt((Number(g.inputTokens) || 0) + (Number(g.outputTokens) || 0))");
    expect(code).toContain("T('tokens')");
    expect(code).toContain('g.costMicroCents != null ? money(g.costMicroCents)');
  });

  it('最终选择走 previewUsageHtml：gw 有数据优先，否则回落 org usage', () => {
    const code = inlineScript();
    expect(code).toContain('function previewUsageHtml(c)');
    expect(code).toContain('return c.gw ? previewGwBox(c.gw) : previewUsageBox(c.usage);');
    // 两个数据源到达都走同一出口，防止先后到达互相覆盖；
    // accountCard（render 重建）同样走 previewUsageHtml，与回填口径一致。
    expect(code).toContain("fillPreviewBox(id, 'usage', previewUsageHtml(c));");
    expect(code).toContain('var usageBox = pc ? previewUsageHtml(pc) : \'\';');
  });

  it('网关用量词条 en/zh 都有（previewGwTitle）', () => {
    const en = new Set([...codeOfDict('en')]);
    const zh = new Set([...codeOfDict('zh')]);
    for (const k of ['previewGwTitle']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });
});

describe('卡片 legacy keys 摘要（数量 + 首个名字）', () => {
  it('legacy keys 端点被拉取并回填（fetchPreviewLegacy + fillPreviewLegacy）', () => {
    const code = inlineScript();
    expect(code).toContain('function fetchPreviewLegacy(');
    expect(code).toContain("'/__admin/api/legacy/account/' + id + '/keys'");
    expect(code).toContain('function fillPreviewLegacy(');
    expect(code).toContain("c.legacy = r.json.data.keys;");
    expect(code).toContain("add.insertAdjacentHTML('beforebegin', html);");
    expect(code).toContain('Array.isArray(r.json.data.keys)');
  });

  it('legacy 摘要行由 legacyPreviewRow 生成：数量 + 首个名字，无 legacy 返回空串', () => {
    const code = inlineScript();
    expect(code).toContain('function legacyPreviewRow(');
    expect(code).toContain("if (!keys || !keys.length) return '';");
    expect(code).toContain("if (keys[i] && keys[i].name) names.push(keys[i].name);");
    expect(code).toContain("T('legacyCount') + ' ' + keys.length");
    expect(code).toContain('esc(names[0])');
    // render 重建时 accountCard 也从缓存读 legacy 行（防丢），fill 防重插。
    expect(code).toContain('var legacyRow = pc ? legacyPreviewRow(pc.legacy) : \'\';');
    expect(code).toContain("if (card.querySelector('.keys .legacy-row')) return;");
    expect(code).toContain('legacyPreviewRow(keys)');
  });

  it('无 legacy keys / 404 时静默（不插行）', () => {
    const code = inlineScript();
    expect(code).toContain('if (!html) return;');
  });

  it('legacy 摘要词条 en/zh 都有（legacyCount/legacyHint）', () => {
    const en = new Set([...codeOfDict('en')]);
    const zh = new Set([...codeOfDict('zh')]);
    for (const k of ['legacyCount', 'legacyHint']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });
});

describe('详细请求增强：搜索 + 跳页 + 每页条数', () => {
  it('搜索框 req-q 存在，q 参数拼进请求 URL（encodeURIComponent）', () => {
    expect(ADMIN_HTML).toContain('id="req-q"');
    const code = inlineScript();
    expect(code).toContain("var url = '/__admin/api/requests?page=' + reqPage + '&pageSize=' + REQ_PAGE_SIZE +");
    expect(code).toContain("(reqQuery ? '&q=' + encodeURIComponent(reqQuery) : '')");
    expect(code).toContain("$('req-q').addEventListener('input'");
    expect(code).toContain('reqSearchTimer = setTimeout(function () { reqQuery = q; reqPage = 1; fetchRequests(); }, 400);');
  });

  it('跳页：req-page 输入框 + req-go 按钮 + Enter，钳到总页数内（goReqPage）', () => {
    expect(ADMIN_HTML).toContain('id="req-page"');
    expect(ADMIN_HTML).toContain('id="req-go"');
    const code = inlineScript();
    expect(code).toContain('function goReqPage(');
    expect(code).toContain("$('req-go').addEventListener('click', goReqPage);");
    expect(code).toContain("if (e.key === 'Enter') goReqPage();");
    expect(code).toContain('reqPage = Math.min(v, pages);');
    expect(code).toContain('if (pp) { pp.value = reqPage; pp.max = pages; }');
  });

  it('每页条数：req-size 下拉（20/50/100）切换后重置回第一页', () => {
    expect(ADMIN_HTML).toContain('id="req-size"');
    expect(ADMIN_HTML).toMatch(/<option value="20" selected>20<\/option>[\s\S]*<option value="50">50<\/option>[\s\S]*<option value="100">100<\/option>/);
    const code = inlineScript();
    expect(code).toContain("$('req-size').addEventListener('change'");
    expect(code).toContain('if (v === 20 || v === 50 || v === 100)');
    expect(code).toContain('REQ_PAGE_SIZE = v;');
  });

  it('req 词条 en/zh 都有（reqGo）', () => {
    const en = new Set([...codeOfDict('en')]);
    const zh = new Set([...codeOfDict('zh')]);
    for (const k of ['reqGo']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });
});

describe('IP 统计面板（stats-by-ip）', () => {
  it('usage tab 有 IP 统计 section 与挂载点（sec-usage-ips/ip-rows/ip-empty/ip-nav）', () => {
    expect(ADMIN_HTML).toContain('id="sec-usage-ips"');
    expect(ADMIN_HTML).toContain('id="ip-rows"');
    expect(ADMIN_HTML).toContain('id="ip-empty"');
    expect(ADMIN_HTML).toContain('id="ip-info"');
    expect(ADMIN_HTML).toContain('id="ip-prev"');
    expect(ADMIN_HTML).toContain('id="ip-next"');
    const code = inlineScript();
    expect(code).toContain("['subIps', 'sec-usage-ips']");
    expect(code).toContain("fetchIpStats();");
    expect(code).toContain("'/__admin/api/requests/stats-by-ip?page=' + ipPage + '&pageSize=' + IP_PAGE_SIZE");
  });

  it('渲染字段全：IP/请求数/输入+输出 tokens/客户端列表/最近时间', () => {
    const code = inlineScript();
    expect(code).toContain('function renderIpStats(');
    expect(code).toContain("'<td><span class=\"ip-link\" data-ip=\"' + esc(r.ip)");
    expect(code).toContain("(Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0)");
    expect(code).toContain('(r.clients || []).filter(Boolean).slice(0, 3).join(\' · \')');
    expect(code).toContain('hhmmss(r.lastAt)');
    expect(code).toContain('empty.hidden = items.length > 0;');
  });

  it('点 IP → 请求明细按该 IP 搜索（q=<ip>）并滚到明细区（filterByIp）', () => {
    const code = inlineScript();
    expect(code).toContain('function filterByIp(');
    expect(code).toContain('reqQuery = ip;');
    expect(code).toContain("$('req-q')");
    expect(code).toContain("$('view-usage').addEventListener('click'");
    expect(code).toContain("closest('[data-ip]')");
    expect(code).toContain('clearTimeout(reqSearchTimer);');
  });

  it('IP 词条 en/zh 都有（ipStatsTitle/ipStatsSub/ipClients/ipLast/ipEmpty/ipFilterHint/subIps）', () => {
    const en = new Set([...codeOfDict('en')]);
    const zh = new Set([...codeOfDict('zh')]);
    for (const k of ['ipStatsTitle', 'ipStatsSub', 'ipClients', 'ipLast', 'ipEmpty', 'ipFilterHint', 'subIps']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });
});

describe('侧栏导航点击居中：纵向 + 横向双方向', () => {
  it('focusSidebar 纵向（max-height 容器）与横向（窄屏横滚）都居中', () => {
    const code = inlineScript();
    expect(code).toContain('sb.scrollHeight - sb.clientHeight');
    expect(code).toContain('(sb.clientHeight - active.offsetHeight) / 2');
    expect(code).toContain('sb.scrollTop = Math.max(0, Math.min(target, maxY));');
    expect(code).toContain('sb.scrollWidth - sb.clientWidth');
    expect(code).toContain('sb.scrollLeft = Math.max(0, Math.min(tx, maxX));');
    // sidebar 滚动容器必须存在（max-height + overflow-y: auto）。
    expect(ADMIN_HTML).toContain('max-height: calc(100vh - 150px); overflow-y: auto;');
    expect(ADMIN_HTML).toContain('overflow-x: auto; gap: 2px;');
  });
});

describe('设置-关于页：介绍 + GitHub 仓库', () => {
  it('描述更新为「管理上游账号与协议转换」+ GitHub 链接', () => {
    expect(ADMIN_HTML).toContain('href="https://github.com/dwgx/fuckopencode"');
    expect(ADMIN_HTML).toContain('github.com/dwgx/fuckopencode');
    expect(ADMIN_HTML).toContain('target="_blank" rel="noopener"');
    const code = inlineScript();
    expect(code).toContain("aboutDesc: 'OpenAI <-> Anthropic protocol gateway for DeepSeek — manage upstream accounts and protocol conversion'");
    expect(code).toContain("aboutDesc: 'OpenAI 与 Anthropic 协议转换网关，面向 DeepSeek —— 用于管理上游账号与协议转换'");
  });
});

describe('模型映射可修改（PUT /model-aliases/:alias）', () => {
  it('映射行有编辑按钮（edit-alias），委托在 view-settings', () => {
    const code = inlineScript();
    expect(code).toContain('data-action="edit-alias"');
    expect(code).toContain("closest('button[data-action=\"edit-alias\"]')");
    expect(code).toContain('function editModelAlias(');
  });

  it('编辑弹层：alias 只读 + target/note 可改，PUT 提交，成功重拉列表 + flash', () => {
    const code = inlineScript();
    expect(code).toContain("api('PUT', '/__admin/api/model-aliases/' + encodeURIComponent(alias)");
    expect(code).toContain('{ target: target, note: note || null }');
    expect(code).toContain("id=\"mm-edit-target\"");
    expect(code).toContain("id=\"mm-edit-note\"");
    expect(code).toContain("T('mmTargetRequired')");
    expect(code).toContain('mmList');
    expect(code).toContain("flash(T('mmEdited'))");
  });

  it('编辑词条 en/zh 都有（mmEditTitle/mmEdited/mmTargetRequired）', () => {
    const en = new Set([...codeOfDict('en')]);
    const zh = new Set([...codeOfDict('zh')]);
    for (const k of ['mmEditTitle', 'mmEdited', 'mmTargetRequired']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });
});

/** 提取 i18n 字典（en/zh）的键集合。 */
function codeOfDict(lang: 'en' | 'zh'): string[] {
  const code = inlineScript();
  const start = code.indexOf(`${lang}:`);
  if (start < 0) throw new Error(`字典缺 ${lang}`);
  const slice = code.slice(start);
  const end = slice.indexOf('\n    }');
  const body = slice.slice(0, end > 0 ? end : 4000);
  return [...body.matchAll(/(?:^\s+|,\s*)([A-Za-z][\w]*)\s*:/gm)]
    .map((m) => m[1]!)
    .filter((k) => k !== lang);
}

describe('波 2：P0 面板 + 旧版计费 + 观测计数 + 实验功能', () => {
  it('详情页新区块挂载点存在（legacy billing / 模型消费 / 成员消费 / 定价）', () => {
    for (const id of ['detail-legacy-billing', 'detail-models-usage', 'detail-users-usage', 'detail-pricing']) {
      expect(ADMIN_HTML).toContain(`id="${id}"`);
    }
  });

  it('用量 tab 有兼容修复卡（u-fixes），设置页有实验功能区（sec-experimental）', () => {
    expect(ADMIN_HTML).toContain('id="u-fixes"');
    expect(ADMIN_HTML).toContain('id="sec-experimental"');
    expect(ADMIN_HTML).toContain('id="exp-panel"');
  });

  it('波 2 渲染/加载函数都在', () => {
    const code = inlineScript();
    for (const fn of ['loadLegacyBilling', 'renderLegacyBilling', 'trendHtml',
                      'loadModelsUsage', 'renderModelsUsage', 'loadUsersUsage', 'renderUsersUsage',
                      'loadMemberBudgets', 'renderMemberBudgets', 'loadPricing', 'renderPricing',
                      'loadSettings', 'renderSettings', 'renderApiKeys']) {
      expect(code, `缺 ${fn}`).toContain(`function ${fn}(`);
    }
  });

  it('波 2 端点调用都接线（legacy billing + P0 四个 + settings 热改）', () => {
    const code = inlineScript();
    expect(code).toContain("'/__admin/api/legacy/account/' + id + '/billing'");
    expect(code).toContain("'/__admin/api/console/account/' + id + '/usage/models?range='");
    expect(code).toContain("'/__admin/api/console/account/' + id + '/usage/users?range='");
    expect(code).toContain("'/__admin/api/console/account/' + id + '/budgets/users-status'");
    expect(code).toContain("'/__admin/api/console/account/' + id + '/models-pricing'");
    // 设置页热改：实验开关 / 账号密码 / API 密钥都走 settings 端点（GET 全量 + PATCH 部分更新）。
    expect(code).toContain("api('GET', '/__admin/api/settings', null)");
    expect(code).toContain("api('PATCH', '/__admin/api/settings', body)");
    expect(code).toContain("api('PATCH', '/__admin/api/settings', { apiKeys: merged })");
    expect(code).toContain("api('PATCH', '/__admin/api/settings', { apiKeys: rest })");
    // 兼容修复计数从 /__metrics 的 summary 三键读（rewritten/stripped/compressed）。
    expect(code).toContain('s.rewritten == null');
    expect(code).toContain('s.stripped == null');
    expect(code).toContain('s.compressed == null');
  });

  it('波 2 词条 en/zh 都有', () => {
    const en = new Set(codeOfDict('en'));
    const zh = new Set(codeOfDict('zh'));
    for (const k of ['legacyBilling', 'legacyBillingSub', 'legacyReload', 'paymentHistory', 'amount',
                     'noPayments', 'costTrend', 'noTrend', 'modelUsageTitle', 'modelUsageSub',
                     'userUsageTitle', 'userUsageSub', 'spent', 'exceeded', 'resetsAt',
                     'memberBudgetTitle', 'pricingTitle', 'pricingSub', 'inPerMtok', 'outPerMtok',
                     'fixCountTitle', 'fixRewritten', 'fixStripped', 'fixCompressed',
                     'expTitle', 'expSub', 'expNote', 'expUnavailable', 'expScaleUsage',
                     'expScaleDesc', 'expCompact', 'expCompactDesc', 'expOn', 'expOff']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });

  it('旧版计费区块失败语义与 legacy keys 同款（404 静默 / cookie 缺失明确提示）', () => {
    const code = inlineScript();
    expect(code).toContain('if (!r.ok && r.status === 404) { el.innerHTML = \'\'; return; }');
    expect(code).toContain("isLegacyCookieError(r)");
    expect(code).toContain("T('legacyCookieMissing')");
  });

  it('定价表格限高滚动（61 模型不撑爆详情页）', () => {
    expect(ADMIN_HTML).toContain('class="tbl-scroll"');
    const code = inlineScript();
    expect(code).toContain(`'<div class="tbl-scroll"><table class="tbl"><thead><tr><th>'`);
  });

  it('趋势柱只取最近 7 天，最高柱 accent（byDay 数据不足不崩）', () => {
    const code = inlineScript();
    expect(code).toContain('byDay.slice(-7)');
    expect(code).toContain("T('noTrend')");
  });
});

describe('批次 2：分发密钥 tab（tokens）', () => {
  it('tab 按钮 + 视图挂载点 + SUBS 注册都在', () => {
    expect(ADMIN_HTML).toContain('data-tab="tokens"');
    expect(ADMIN_HTML).toContain('id="view-tokens"');
    expect(ADMIN_HTML).toContain('id="sec-tokens"');
    expect(ADMIN_HTML).toContain('id="tokens-rows"');
    expect(ADMIN_HTML).toContain('id="tokens-empty"');
    expect(ADMIN_HTML).toContain('id="btn-token-create"');
    expect(ADMIN_HTML).toContain('id="btn-token-refresh"');
    const code = inlineScript();
    expect(code).toContain("tokens: 'view-tokens'");
    expect(code).toContain("tokens: [['subTokens', 'sec-tokens']]");
    expect(code).toContain("if (v === 'tokens') { loadTokens(false); }");
    expect(code).toContain("$('btn-token-create').addEventListener('click', createTokens);");
  });

  it('渲染/加载/操作函数都在，CRUD 端点齐（GET/POST/PATCH/DELETE）', () => {
    const code = inlineScript();
    for (const fn of ['loadTokens', 'renderTokens', 'tokenRow', 'findToken',
                      'createTokens', 'showTokenPlain', 'copyPlain',
                      'editToken', 'toggleToken', 'delToken', 'tokDone']) {
      expect(code, `缺 ${fn}`).toContain(`function ${fn}(`);
    }
    expect(code).toContain("api('GET', '/__admin/api/tokens', null)");
    expect(code).toContain("api('POST', '/__admin/api/tokens', body)");
    expect(code).toContain("api('PATCH', '/__admin/api/tokens/' + id, { name: name, note: note || null })");
    expect(code).toContain("api('PATCH', '/__admin/api/tokens/' + id, { status: to })");
    expect(code).toContain("api('DELETE', '/__admin/api/tokens/' + id, null)");
    expect(code).toContain('data-action="toggle-token"');
    expect(code).toContain('data-action="edit-token"');
    expect(code).toContain('data-action="del-token"');
  });

  it('60s 缓存（previewCache 模式）：TTL 内缓存复用，force 强制重拉', () => {
    const code = inlineScript();
    expect(code).toContain('var TOKENS_TTL = 60 * 1000;');
    expect(code).toContain('var tokensCache = null;');
    expect(code).toContain("if (!force && tokensCache && Date.now() - tokensCache.at < TOKENS_TTL) {");
    expect(code).toContain('tokensCache = { at: Date.now(), items: r.json.data.items };');
    expect(code).toContain("if (r.status === 503)");
    expect(code).toContain('renderTokens(tokensCache.items);');
  });

  it('列表行只渲染掩码（t.mask），永不引用明文；明文只在创建响应出现', () => {
    const code = inlineScript();
    // tokenRow 内只拼 t.mask / t.usage / t.name / t.createdAt，没有 token 明文字段。
    const tr = code.slice(code.indexOf('function tokenRow('), code.indexOf('function renderTokens('));
    expect(tr).toContain('t.mask');
    expect(tr).not.toContain('t.token');
    expect(tr).not.toContain('data.token');
    // 明文收集只发生在创建流程：POST 响应里的 r.json.data.token 进 plain 数组。
    expect(code).toContain('r.json.data.token');
    expect(code).toContain('plain.push({ name: r.json.data.name || nm, token: r.json.data.token });');
    expect(code).toContain('T(\'tokenPlainOnlyOnce\')');
    // 明文展示容器独立于列表（plain-overlay），关闭即无法再取回。
    expect(ADMIN_HTML).toContain('id="plain-overlay"');
    expect(ADMIN_HTML).toContain('id="plain-list"');
    expect(code).toContain("$('plain-overlay').hidden = false;");
    expect(code).toContain("$('plain-close').addEventListener('click'");
  });

  it('创建：名称必填 + 批量数量 1-10 校验，循环逐个 POST（多份时 name-N 后缀）', () => {
    const code = inlineScript();
    expect(code).toContain("T('tokenNameRequired')");
    expect(code).toContain("!(count >= 1 && count <= 10)");
    expect(code).toContain("T('tokenCountInvalid')");
    expect(code).toContain('var nm = count > 1 ? name + \'-\' + (i + 1) : name;');
    expect(code).toContain("var count = Math.floor(Number($('tok-count').value));");
  });

  it('状态徽章：active 绿（tok-active）/ disabled 灰（tok-disabled），禁用-启用互切', () => {
    expect(ADMIN_HTML).toContain('.badge.tok-active { color: var(--ok);');
    expect(ADMIN_HTML).toContain('.badge.tok-disabled');
    const code = inlineScript();
    expect(code).toContain("'<span class=\"oc-chip tok-active\">' + T('tokenActive')");
    expect(code).toContain("'<span class=\"oc-chip tok-disabled\">' + T('tokenDisabled')");
    expect(code).toContain("var to = t.status === 'active' ? 'disabled' : 'active';");
  });

  it('用量列：费用 $（money 换算）+ 请求数 + tokens；删除走 danger confirm', () => {
    const code = inlineScript();
    expect(code).toContain('u.costMicroCents != null ? money(u.costMicroCents)');
    expect(code).toContain('fmt((Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0))');
    expect(code).toContain("T('tokenDeleteConfirm')");
    expect(code).toContain('okText: T(\'delete\')');
    expect(code).toContain('danger: true');
  });

  it('写操作收尾 tokDone：成功 flash + 强制重拉列表（总览同步），失败留在弹层', () => {
    const code = inlineScript();
    expect(code).toContain('flash(okMsg);');
    expect(code).toContain('loadTokens(true);');
    expect(code).toContain("$('confirm-err').textContent = errMsg(r);");
  });
});

describe('批次 2：总览健康度（统计卡组 + 状态列表）', () => {
  it('网关统计卡组挂载点 + sec-status 状态列表都在', () => {
    for (const id of ['stats2', 'ov-total', 'ov-rate', 'ov-cost', 'ov-keys',
                      'spark-total', 'spark-rate', 'spark-cost', 'spark-keys',
                      'sec-status', 'status-list']) {
      expect(ADMIN_HTML).toContain(`id="${id}"`);
    }
    const code = inlineScript();
    expect(code).toContain("['subStatus', 'sec-status']");
  });

  it('sparkline 零依赖自绘：12 桶聚合（bucketize）+ SVG polyline', () => {
    const code = inlineScript();
    expect(code).toContain('function bucketize(');
    expect(code).toContain('function sparkline(');
    expect(code).toContain('function stRow(');
    expect(code).toContain('function renderOverviewMetrics(');
    expect(code).toContain('bucketize(evs, 12, function () { return 1; })');
    expect(code).toContain('<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none"');
    expect(code).toContain("'<polyline points=\"' + pts.join(' ')");
    expect(code).toContain('Math.min(n - 1, Math.floor((Number(events[k].at) - min) / (max - min) * n))');
  });

  it('成功率与 summary 同口径 ok/(ok+failed)，无样本显示 —；事件成功桶 200-399', () => {
    const code = inlineScript();
    expect(code).toContain("$('ov-rate').textContent = done > 0 ? Math.round(okN / done * 100) + '%' : '—';");
    expect(code).toContain('var okN = Number(s.ok) || 0;');
    expect(code).toContain('var failN = Number(s.failed) || 0;');
    expect(code).toContain('e.status >= 200 && e.status < 400 ? 1 : 0');
  });

  it('费用/密钥卡读 tokensCache（60s 共享缓存），未拉到显示 —', () => {
    const code = inlineScript();
    expect(code).toContain("$('ov-cost').textContent = tokensCache ? money(cost) : '—';");
    expect(code).toContain("$('ov-keys').textContent = tokensCache ? active + '/' + tokensCache.items.length : '—';");
    expect(code).toContain('cost += Number((tokensCache.items[i].usage || {}).costMicroCents) || 0;');
  });

  it('状态列表五行：网关/上游池/账号/分发密钥/兼容修复，绿黄红三态', () => {
    const code = inlineScript();
    for (const k of ["stRow('stGateway'", "stRow('stUpstream'", "stRow('stAccounts'", "stRow('stDistKeys'", "stRow('stFixes'"]) {
      expect(code).toContain(k);
    }
    expect(code).toContain("'<div class=\"st-row\"><span class=\"oc-dot ' + cls + '\"></span>'");
    expect(ADMIN_HTML).toContain('.st-dot.ok { background: var(--ok); }');
    expect(ADMIN_HTML).toContain('.st-dot.warn');
    expect(ADMIN_HTML).toContain('.st-dot.bad');
    expect(code).toContain("T('stRunning') + ' ' + hms(up)");
    expect(code).toContain('ph + \'/\' + ps + \' \' + T(\'healthy\')');
    expect(code).toContain("s.rewritten == null && s.stripped == null && s.compressed == null");
  });

  it('接线：fetchUsage 同时驱动用量视图与总览（lastMetrics + refreshOverviewTokens）', () => {
    const code = inlineScript();
    expect(code).toContain('var lastMetrics = null;');
    expect(code).toContain('renderUsage(m);');
    expect(code).toContain('renderOverviewMetrics(m, lastTrend);');
    expect(code).toContain('function refreshOverviewTokens(');
    expect(code).toContain('if (lastMetrics) renderOverviewMetrics(lastMetrics, lastTrend);');
    expect(code).toContain('loadTokens(false);');
  });

  it('总览真实趋势：/__admin/api/overview/trend 拉取 + trendSeries + 快照回落分支', () => {
    const code = inlineScript();
    expect(code).toContain("fetch('/__admin/api/overview/trend?range=7d'");
    expect(code).toContain('function fetchOverviewTrend(');
    expect(code).toContain('var TREND_TTL = 10 * 1000;');
    expect(code).toContain('function trendSeries(items, field)');
    expect(code).toContain('renderOverviewMetrics(lastMetrics, lastTrend);');
    // 真实聚合分支：卡片与 sparkline 都读 trend.items。
    expect(code).toContain("$('ov-total').textContent = fmt(trend.requests);");
    expect(code).toContain("sparkline(trendSeries(trend.items, 'requests'))");
    expect(code).toContain("$('ov-cost').textContent = money(trend.costMicroCents);");
    // 回落分支保留原快照逻辑（db 不可用时面板不假装有历史）。
    expect(code).toContain('bucketize(evs, 12, function () { return 1; })');
    expect(code).toContain("$('ov-cost').textContent = tokensCache ? money(cost) : '—';");
    // 口径标注元素 + 词条。
    expect(ADMIN_HTML).toContain('id="ov-note"');
    expect(code).toContain("note.textContent = trend ? T('ovTrendNote') : T('ovTrendFallback');");
  });
});

describe('批次 2：设置页热改（settings 端点）', () => {
  it('账号密码表单挂载点 + 实验功能区 + API 密钥管理区', () => {
    for (const id of ['sec-admin-auth', 'aa-user', 'aa-pass', 'aa-save', 'aa-user-src', 'aa-pass-src', 'aa-pass-warn',
                      'sec-admin-keys', 'akey-rows', 'akey-empty', 'btn-akey-add']) {
      expect(ADMIN_HTML).toContain(`id="${id}"`);
    }
    const code = inlineScript();
    expect(code).toContain("['subAdminAuth', 'sec-admin-auth']");
    expect(code).toContain("['subAdminKeys', 'sec-admin-keys']");
    expect(code).toContain("['subExperimental', 'sec-experimental']");
  });

  it('loadSettings 60s TTL + GET 全量视图；renderSettings 渲染三块', () => {
    const code = inlineScript();
    expect(code).toContain('var SETTINGS_TTL = 60 * 1000;');
    expect(code).toContain("api('GET', '/__admin/api/settings', null)");
    expect(code).toContain('function loadSettings(');
    expect(code).toContain('function renderSettings(');
    expect(code).toContain('function renderApiKeys(');
    expect(code).toContain("var srcOf = function (k) { return T(SETTINGS_SRC[(s[k] && s[k].source === 'db') ? 'db' : 'env']); };");
  });

  it('保存账号密码：密码留空不提交 adminPass（防覆盖成空）；成功 flash 会话失效提示', () => {
    const code = inlineScript();
    expect(code).toContain('function saveAdminAuth(');
    expect(code).toContain('if (pass) body.adminPass = pass;');
    expect(code).toContain('if (user) body.adminUser = user;');
    expect(code).toContain("T('aaNothing')");
    expect(code).toContain("flash(T('authSaved') + (pass ? ' — ' + T('adminPassHint') : ''));");
    expect(code).toContain("$('aa-pass').value = '';");
    // P2-1：改密码后旧会话立即失效（密码版本 sha256 编进 HMAC，24h 文案是误导）。
    // en/zh/HTML 三处同步。
    expect(code).toContain("adminPassHint: 'all logged-in sessions are invalidated immediately after a password change; re-login required'");
    expect(code).toContain("adminPassHint: '改密码后所有已登录会话立即失效，需重新登录'");
    expect(ADMIN_HTML).toContain('data-i18n="adminPassHint">all logged-in sessions are invalidated immediately after a password change; re-login required</div>');
  });

  it('来源标记：env/db 小字；默认密码强提示读服务端 adminPassIsDefault（非 source 近似）', () => {
    const code = inlineScript();
    expect(code).toContain("var SETTINGS_SRC = { env: 'sourceEnv', db: 'sourceDb' };");
    // 回归：修复前用 source==='env' 近似判断（env 显式强密码会误报）；修复后
    // 读服务端顶层 adminPassIsDefault 精确字段驱动徽章 + 行内提示。
    expect(code).toContain('r.json.data.adminPassIsDefault === true');
    expect(code).toContain('var isDefault = !!(settingsCache && settingsCache.def);');
    expect(code).toContain("pw.hidden = !isDefault;");
    expect(code).not.toContain("s.adminPass && s.adminPass.source === 'env'");
    expect(code).toContain("pw.textContent = T('adminPassEnvWarn');");
    expect(code).toContain("badge.textContent = T('adminPassDefaultBadge');");
  });

  it('默认密码徽章挂点：设置页 Admin account 区块密码 label 旁（HTML + CSS）', () => {
    expect(ADMIN_HTML).toContain('id="aa-pass-badge"');
    expect(ADMIN_HTML).toContain('oc-chip oc-chip-danger" id="aa-pass-badge" hidden');
    expect(ADMIN_HTML).toContain('.oc-chip.oc-chip-danger');
  });

  it('实验开关 toggle：反值 PATCH（scaleClientTokens / compactEnabled），只读值做后缀', () => {
    const code = inlineScript();
    expect(code).toContain("patchSetting('scaleClientTokens', tg.getAttribute('data-on') !== '1')");
    expect(code).toContain("patchSetting('compactEnabled', tc.getAttribute('data-on') !== '1')");
    expect(code).toContain("api('PATCH', '/__admin/api/settings', body).then");
    expect(code).toContain('scaleOn && s.clientTokenScale ? \'x\' + s.clientTokenScale.value');
    expect(code).toContain("Math.round(Number(s.compactTriggerBytes.value) / 1024) + 'KB'");
    expect(code).toContain("Number(s.compactMaxMessageChars.value) + ' chars'");
  });

  it('API 密钥管理：掩码列表 + 明文缓存（localStorage，mask=末 4 位），无明文删除禁用', () => {
    const code = inlineScript();
    expect(code).toContain("var APIKEY_CACHE_KEY = 'fc-akeys-plain';");
    expect(code).toContain('function loadApiKeyCache(');
    expect(code).toContain('function saveApiKeyCache(');
    expect(code).toContain("return plain.length <= 4 ? '****' : '****' + plain.slice(-4);");
    expect(code).toContain('var hasPlain = Boolean(cache[k]);');
    expect(code).toContain("'<button class=\"oc-btn oc-btn-ghost oc-btn-sm t-del\" disabled title=\"' + T('apiKeysNoPlain')");
  });

  it('添加/删除走 PATCH 全量数组（替换语义）：缓存明文合并 / 剩余明文提交', () => {
    const code = inlineScript();
    expect(code).toContain('var merged = known.concat(lines);');
    expect(code).toContain("api('PATCH', '/__admin/api/settings', { apiKeys: merged })");
    expect(code).toContain("api('PATCH', '/__admin/api/settings', { apiKeys: rest })");
    expect(code).toContain('if (m !== mask) rest.push(mm[m]);');
    expect(code).toContain("T('apiKeysEnvWarn')");
    expect(code).toContain("T('apiKeysDeleteConfirm')");
    expect(code).toContain('nm[apiKeyMask(merged[i])] = merged[i]');
  });

  it('分发密钥词条 + 设置热改词条 + 总览词条 en/zh 都有', () => {
    const en = new Set(codeOfDict('en'));
    const zh = new Set(codeOfDict('zh'));
    const keys = ['tabTokens', 'tokensTitle', 'tokensSub', 'tokensNote', 'tokensEmpty', 'tokensUnavailable',
                  'tokenCreate', 'tokenCount', 'tokenPlainOnlyOnce', 'tokenCopy', 'tokenCopied', 'tokenClose',
                  'tokenActive', 'tokenDisabled', 'tokenUsage', 'tokenCreatedAt', 'tokenEditTitle',
                  'tokenSaved', 'tokenDeleted', 'tokenEnabled', 'tokenDisabledMsg', 'tokenDisable',
                  'tokenEnable', 'tokenDeleteConfirm',
                  'ovTotalRequests', 'ovSuccessRate', 'ovCostLabel', 'ovKeys', 'statusTitle', 'statusSub',
                  'subStatus', 'stGateway', 'stUpstream', 'stAccounts', 'stDistKeys', 'stFixes', 'stRunning',
                  'ovTrendNote', 'ovTrendFallback',
                  'adminAuthTitle', 'adminAuthSub', 'adminUserLabel', 'adminPassLabel', 'adminPassPlaceholder',
                  'adminPassHint', 'adminPassEnvWarn', 'adminPassDefaultBadge', 'authSaved', 'aaNothing', 'sourceEnv', 'sourceDb',
                  'apiKeysTitle', 'apiKeysSub', 'apiKeysEmpty', 'apiKeysAdd', 'apiKeysAddTitle',
                  'apiKeysPasteHint', 'apiKeysNoPlain', 'apiKeysEnvWarn', 'apiKeysDeleteConfirm',
                  'apiKeysSaved', 'settingsSaved', 'subAdminAuth', 'subAdminKeys', 'subExperimental',
                  'balanceOrg'] as const;
    for (const k of keys) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });

  it('余额来源标注：账号卡余额卡用「余额（org）」词条', () => {
    const code = inlineScript();
    expect(code).toContain("T('balanceOrg') + '</div>'");
  });

  it('实验功能说明改为热改语义（立即生效并持久保存）', () => {
    const code = inlineScript();
    expect(code).toContain("expNote: 'changes apply immediately and persist across restarts'");
    expect(code).toContain("expNote: '修改立即生效并持久保存'");
  });
});

describe('第一批：控件模板化（oc-btn / oc-input / oc-hint）', () => {
  it('oc-btn 基类与修饰符都在 CSS 里，且旧类名保留为兼容别名', () => {
    expect(ADMIN_HTML).toMatch(/button, \.oc-btn \{/);
    expect(ADMIN_HTML).toContain('button.primary, .oc-btn-primary');
    expect(ADMIN_HTML).toContain('button.ghost, .oc-btn-ghost');
    expect(ADMIN_HTML).toContain('button.danger, .oc-btn-danger');
    expect(ADMIN_HTML).toContain('.oc-btn-sm { padding: 1px 8px; }');
  });

  it('oc-input/oc-select/oc-textarea/oc-field/oc-form 基类都在', () => {
    expect(ADMIN_HTML).toMatch(/input, select, textarea, \.oc-input, \.oc-select, \.oc-textarea \{/);
    expect(ADMIN_HTML).toContain('.form, .oc-form');
    expect(ADMIN_HTML).toContain('.field, .oc-field');
    expect(ADMIN_HTML).toContain('.oc-field.oc-full, .oc-form .oc-full');
    // 尺寸进控件自身：父容器定制选择器已删。
    expect(ADMIN_HTML).not.toContain('.req-tools input {');
    expect(ADMIN_HTML).not.toContain('.key-add input {');
    expect(ADMIN_HTML).not.toContain('.cookie-import input {');
    expect(ADMIN_HTML).not.toContain('.ws-switch select {');
    expect(ADMIN_HTML).not.toContain('.req-nav input { width: 64px;');
  });

  it('oc-hint / oc-hint-err 统一错误渲染，旧类名兼容', () => {
    expect(ADMIN_HTML).toContain('.hint, .oc-hint');
    expect(ADMIN_HTML).toContain('.form-error, .go-err, .oc-hint-err');
  });

  it('元素 class 属性里不再有裸旧类名（全部走 oc-* 体系）', () => {
    const css = ADMIN_HTML.slice(0, ADMIN_HTML.indexOf('</style>'));
    // CSS 选择器里保留别名是允许的，但 HTML/JS 的 class="..." 属性必须换新。
    const html = ADMIN_HTML.slice(ADMIN_HTML.indexOf('</style>'));
    for (const bare of ['class="primary"', 'class="ghost"', 'class="danger"', 'class="hint"',
                         'class="form-error', 'class="field"', 'class="field full"', 'class="form"',
                         'class="dd-item"', 'class="dd-toggle"', 'class="x"', 'class="go-err"']) {
      expect(html, `HTML 里残留裸类: ${bare}`).not.toContain(bare);
    }
    expect(css).toContain('button.primary');  // 别名在 CSS 里，确认没被误删
  });

  it('tab/snav 保持原样（导航控件不加 oc-btn，防基类覆盖下划线样式）', () => {
    expect(ADMIN_HTML).toContain('class="tab active"');
    expect(ADMIN_HTML).toContain('class="tab"');
    expect(inlineScript()).toContain("'<button class=\"snav'");
  });

  it('detailErr 写入的 sticky 错误不被自动轮询的成功覆盖（错误闪烁修复）', () => {
    const code = inlineScript();
    expect(code).toContain('var stickyErr = {};');
    expect(code).toContain('stickyErr[name] = true;');
    expect(code).toMatch(/function clearSticky\(name, fromTick\) \{/);
    expect(code).toMatch(/if \(stickyErr\[name\] && fromTick\) return false;/);
    // tick 的 billing 刷新标记为自动轮询（manual 空），renderBilling 在 sticky 时拒绝渲染。
    expect(code).toContain('loadBilling(detailState.id, !manual);');
    expect(code).toMatch(/function tick\(manual\) \{/);
    expect(code).toMatch(/function renderBilling\(data, fromTick\) \{[\s\S]*if \(!clearSticky\('billing', fromTick\)\) return;/);
    // 其余 detailErr 区块（用户动作触发）也走 clearSticky。
    for (const b of ['workspace', 'usage', 'members', 'sa', 'providers', 'budgets']) {
      expect(code, `缺 ${b} 的 clearSticky`).toContain(`clearSticky('${b}')`);
    }
  });
});

describe('登录页 LOGIN_HTML i18n', () => {
  function loginScript(): string {
    const m = LOGIN_HTML.match(/<script>([\s\S]*)<\/script>/);
    if (!m) throw new Error('登录页 HTML 里找不到内联 <script>');
    return m[1]!;
  }

  it('静态文本保持英文默认（e2e 断言 raw HTML 含 sign in），data-i18n 挂点存在', () => {
    expect(LOGIN_HTML).toContain('>sign in<');
    expect(LOGIN_HTML).toContain('data-i18n="username"');
    expect(LOGIN_HTML).toContain('data-i18n="password"');
    expect(LOGIN_HTML).toContain('data-i18n="authRequired"');
  });

  it('内联 en/zh 词条键集合一致', () => {
    const code = loginScript();
    const keys = (lang: 'en' | 'zh') => {
      const start = code.indexOf(`${lang}: {`);
      const slice = code.slice(start, code.indexOf('\n    }', start));
      return [...slice.matchAll(/(?:^\s+|,\s*)([A-Za-z][\w]*)\s*:/gm)].map((m) => m[1]!).filter((k) => k !== lang);
    };
    const en = new Set(keys('en'));
    const zh = new Set(keys('zh'));
    expect(en.size).toBeGreaterThan(4);
    expect([...en].filter((k) => !zh.has(k))).toEqual([]);
    expect([...zh].filter((k) => !en.has(k))).toEqual([]);
  });

  it('语言跟随面板偏好（同一 localStorage fc-lang），脚本运行时设置 html lang', () => {
    const code = loginScript();
    expect(code).toContain("localStorage.getItem('fc-lang')");
    expect(code).toContain("document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';");
  });

  it('登录页 CSS 走 oc-* 模板类', () => {
    expect(LOGIN_HTML).toContain('.oc-btn {');
    expect(LOGIN_HTML).toContain('.oc-input {');
    expect(LOGIN_HTML).toContain('.oc-field {');
    expect(LOGIN_HTML).toContain('.oc-hint-err {');
    // 不再有裸元素选择器按钮/输入样式。
    expect(LOGIN_HTML).not.toContain('button {\n');
    expect(LOGIN_HTML).not.toContain('  input {\n');
  });
});

describe('第二批：弹层模板化（oc-modal 系列 + data-variant）', () => {
  it('三个静态弹层的骨架用 oc-modal 系列类（hd/bd/actions/x），JS 按 id 操作不受影响', () => {
    expect(ADMIN_HTML).toContain('id="oauth-overlay"');
    expect(ADMIN_HTML).toContain('id="confirm-overlay"');
    expect(ADMIN_HTML).toContain('id="plain-overlay"');
    expect(ADMIN_HTML).toContain('class="oc-modal" role="dialog"');
    expect(ADMIN_HTML).toContain('class="oc-modal-hd"');
    expect(ADMIN_HTML).toContain('class="oc-modal-bd"');
    expect(ADMIN_HTML).toContain('class="oc-modal-actions"');
    expect(ADMIN_HTML).toContain('class="oc-btn oc-modal-x"');
    // 旧类名保留为 CSS 兼容别名（.modal/.modal-hd/.modal-bd/.modal-actions）。
    expect(ADMIN_HTML).toContain('.modal, .oc-modal {');
    expect(ADMIN_HTML).toContain('.modal-hd, .oc-modal-hd {');
    expect(ADMIN_HTML).toContain('.modal-bd, .oc-modal-bd {');
    expect(ADMIN_HTML).toContain('.modal-actions, .oc-modal-actions {');
    expect(ADMIN_HTML).toContain('.modal-hd .x, .oc-modal-hd .oc-modal-x');
  });

  it('confirm-ok 的「类名即状态」改为 data-variant 属性（CSS [data-variant] 选择器）', () => {
    expect(ADMIN_HTML).toContain('id="confirm-ok" data-variant="primary"');
    expect(ADMIN_HTML).toContain('button[data-variant="primary"], .oc-btn[data-variant="primary"]');
    expect(ADMIN_HTML).toContain('button[data-variant="danger"], .oc-btn[data-variant="danger"]');
    const code = inlineScript();
    expect(code).toContain("ok.dataset.variant = opts.danger ? 'danger' : 'primary';");
    // 不再动态换类名。
    expect(code).not.toContain("ok.className = opts.danger");
  });

  it('18 个 confirm body 表单统一 oc-form/oc-field 结构（不再有裸 form/field 类）', () => {
    const code = inlineScript();
    expect(code).toContain("body: '<div class=\"oc-form\">'");
    expect(code).not.toContain("body: '<div class=\"form\">'");
    // 弹层内表单不叠加额外上边距（modal-bd 的 14px gap 管间距）。
    expect(ADMIN_HTML).toContain('.oc-modal-bd .oc-form { margin-top: 0; }');
  });
});

describe('第二批：checkbox/switch 模板化（oc-check / oc-switch）', () => {
  it('oc-check：label + 视觉隐藏原生 input + 伪元素勾选框（:checked/:focus-visible 原生伪类）', () => {
    expect(ADMIN_HTML).toContain('.oc-check {');
    expect(ADMIN_HTML).toContain('.oc-check input { position: absolute; opacity: 0;');
    expect(ADMIN_HTML).toContain('.oc-check-box');
    expect(ADMIN_HTML).toContain('.oc-check input:checked + .oc-check-box');
    expect(ADMIN_HTML).toContain('.oc-check input:focus-visible + .oc-check-box');
  });

  it('GO 两个开关换 oc-check 外观，但原生 checkbox + data-go-toggle 保留（监听逻辑没动）', () => {
    const code = inlineScript();
    expect(code).toContain('<label class="go-toggle oc-check">');
    expect(code).toContain('data-go-toggle="useBalance"');
    expect(code).toContain('data-go-toggle="chinaModels"');
    expect(code).toContain('<span class="oc-check-box"></span>');
    // change 委托仍按 data-go-toggle 匹配原生 input，失败回滚 checked。
    expect(code).toContain("t.matches('[data-go-toggle]')");
    expect(code).toContain('var enabled = t.checked;');
    expect(code).toContain('t.checked = !enabled;');
  });

  it('实验开关 exp-toggle 换 oc-switch 外观（data-on 驱动轨道/旋钮，逻辑不动）', () => {
    expect(ADMIN_HTML).toContain('.oc-switch {');
    expect(ADMIN_HTML).toContain('.oc-switch[data-on="1"] {');
    expect(ADMIN_HTML).toContain('.oc-switch[data-on="1"] .oc-switch-knob');
    const code = inlineScript();
    expect(code).toContain("'<button class=\"oc-switch exp-toggle\" data-action=\"' + act + '\" data-on=\"'");
    expect(code).toContain("patchSetting('scaleClientTokens', tg.getAttribute('data-on') !== '1')");
    expect(code).toContain("patchSetting('compactEnabled', tc.getAttribute('data-on') !== '1')");
  });
});

describe('第二批：徽章/状态点模板化（oc-chip / oc-dot）', () => {
  it('徽章统一 oc-chip（kind/status/tok/dist/member budget），旧 .badge 保留 CSS 别名', () => {
    const code = inlineScript();
    expect(code).toContain("'<span class=\"oc-chip\">' + kindText(a.kind)");
    expect(code).toContain("'<span class=\"oc-chip st-' + esc(a.status)");
    expect(code).toContain("'<span class=\"oc-chip tok-active\">'");
    expect(code).toContain("'<span class=\"oc-chip st-' + esc(st) + '\">' + statusText(st) + ' · '");
    expect(code).toContain("'<span class=\"oc-chip st-error\">'");
    // 状态色修饰符仍是 st-*（语义色不变）。
    expect(ADMIN_HTML).toContain('.oc-chip.st-ok, .badge.st-ok');
    expect(ADMIN_HTML).toContain('.oc-chip.st-invalid, .oc-chip.st-error, .badge.st-invalid, .badge.st-error');
  });

  it('src-tag 换 oc-chip-src、workspace 芯片换 oc-chip（oc-chip-ws 限宽）', () => {
    expect(ADMIN_HTML).toContain('class="oc-chip-src"');
    expect(ADMIN_HTML).toContain('.src-tag, .oc-chip-src');
    expect(ADMIN_HTML).toContain('.ws-chip, .oc-chip-ws { max-width: 220px; }');
    const code = inlineScript();
    expect(code).toContain("'<span class=\"oc-chip oc-chip-ws cut w\" title=\"'");
  });

  it('状态点统一 oc-dot（key 行/健康度/状态列表），旧 .dot/.st-dot 保留 CSS 别名', () => {
    const code = inlineScript();
    expect(code).toContain("'<span class=\"oc-dot ' + (k.healthy ? 'ok' : 'bad')");
    expect(code).toContain("'<span class=\"oc-dot ' + (a.status === 'ok' ? 'ok' : 'bad')");
    expect(code).toContain('<span class="oc-dot \' + cls + \'"></span>\'');
    expect(ADMIN_HTML).toContain('.key-row .dot, .key-row .oc-dot');
    expect(ADMIN_HTML).toContain('.st-dot, .oc-dot');
    expect(ADMIN_HTML).toContain('.oc-dot.ok, .st-dot.ok');
  });
});

describe('第二批：RPM 限流配置 UI（分发密钥每行）', () => {
  it('密钥 tab 表头有 RPM 列（t-rpm-hd + 词条），行内数字输入 + 保存按钮', () => {
    expect(ADMIN_HTML).toContain('class="t-rpm-hd"');
    expect(ADMIN_HTML).toContain('data-i18n="tokenRpm"');
    const code = inlineScript();
    expect(code).toContain("'<input class=\"oc-input\" type=\"number\" min=\"0\" step=\"1\" value=\"' + (Number(t.rpmLimit) || 0)");
    expect(code).toContain('data-rpm-id="\' + t.id + \'"');
    expect(code).toContain('data-action="set-rpm"');
    expect(code).toContain("th.title = T('tokenRpmHint');");
  });

  it('保存走现有 token PATCH rpmLimit（0 = 不限），非法值 flash 报错', () => {
    const code = inlineScript();
    expect(code).toContain("api('PATCH', '/__admin/api/tokens/' + id, { rpmLimit: isFinite(rn) && rn > 0 ? rn : 0 })");
    expect(code).toContain("T('tokenRpmInvalid')");
    expect(code).toContain("flash(T('tokenRpmSaved'))");
  });

  it('RPM 词条 en/zh 都有', () => {
    const en = new Set(codeOfDict('en'));
    const zh = new Set(codeOfDict('zh'));
    for (const k of ['tokenRpm', 'tokenRpmHint', 'tokenRpmSaved', 'tokenRpmInvalid']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });
});

describe('第二批：legacy key 明文复制按钮', () => {
  it('legacy key 行有复制按钮（copy-legacy-key），点击走 /keys/plain 取明文', () => {
    const code = inlineScript();
    expect(code).toContain('data-action="copy-legacy-key"');
    expect(code).toContain("'/__admin/api/legacy/account/' + detailState.id + '/keys/plain'");
    expect(code).toContain('if (act === \'copy-legacy-key\') { copyLegacyKey(btn.getAttribute(\'data-keyid\')); return; }');
    expect(code).toContain('function copyLegacyKey(');
  });

  it('按 id 匹配明文 → clipboard 写入 → flash 成功；失败写 oc-hint-err', () => {
    const code = inlineScript();
    expect(code).toContain("String(r.json[i].id) === String(keyId)");
    expect(code).toContain('navigator.clipboard.writeText(found)');
    expect(code).toContain("flash(T('tokenCopied'))");
    expect(code).toContain("fail(T('opFail'))");
    expect(code).toContain("$('legacy-copy-err')");
    expect(code).toContain("T('legacyKeyNotFound')");
    // 明文复制错误容器是 oc-hint-err（任务要求：失败显示错误）。
    expect(code).toContain('id="legacy-copy-err"');
  });

  it('legacy 复制词条 en/zh 都有', () => {
    const en = new Set(codeOfDict('en'));
    const zh = new Set(codeOfDict('zh'));
    for (const k of ['legacyKeyNotFound', 'legacyKeyCopyTitle']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });
});

/** 花括号配对提取内联 JS 里指定函数的源码（支持 `function name(...)` 与
 *  `var name = function (...)` 两种形式）。配对扫描对字符串里的花括号免疫——
 *  renderFingerprint/opDone/money 这些目标函数体内没有带花括号的字符串。 */
function fnSource(name: string): string {
  const code = inlineScript();
  const pat = new RegExp(`(?:function ${name}\\s*\\([^)]*\\)|var ${name}\\s*=\\s*function\\s*\\([^)]*\\))\\s*\\{`);
  const start = code.search(pat);
  if (start < 0) throw new Error(`内联 JS 找不到函数 ${name}`);
  const bodyStart = code.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 的花括号未闭合`);
}

/** 在沙箱里求值一个纯函数（外部依赖用 stubs 提供），返回可调用函数。 */
function evalFn<T extends (...args: any[]) => any>(name: string, stubs: Record<string, unknown> = {}): T {
  const src = fnSource(name);
  const params = Object.keys(stubs);
  const body = src.startsWith('var ')
    ? `${src}\nreturn ${name};`
    : `return ${src};`;
  return new Function(...params, body)(...Object.values(stubs)) as T;
}

describe('M3：renderLegacyKey 跨账号残留输入清理', () => {
  /** 造 renderLegacyKey 的沙箱依赖：fake DOM（el + 共享 input）+ 假账号。 */
  function makeEnv(acct: { hasLegacyKey: boolean; legacyKeyMasked: string | null }) {
    const input = { value: '' };
    const renderLegacyKey = evalFn('renderLegacyKey', {
      detailState: { id: 0, range: '7d', billing: null, legacyKeyInputFor: null },
      $: (sel: string) =>
        sel === 'detail-legacy-key' ? { innerHTML: '' } : sel === 'detail-legacy-key-paste' ? input : null,
      findAccount: () => acct,
      T: (k: string) => k,
      esc: (s: string) => String(s),
      dBlock: () => '',
    });
    return { input, renderLegacyKey };
  }

  it('账号 A 输入未保存 → 切到账号 B：残留输入被清空（不把 A 的输入带进 B）', () => {
    // 先渲染账号 A 并输入未保存值（同账号重渲染不清 → 输入保留）。
    const a = makeEnv({ hasLegacyKey: false, legacyKeyMasked: null });
    a.renderLegacyKey();
    a.input.value = 'sk-typed-in-A';
    a.renderLegacyKey();
    expect(a.input.value).toBe('sk-typed-in-A'); // 同账号正在输入不被 tick 清掉

    // 切到账号 B：上次渲染账号（A）≠ 当前 id → 强制清空再走渲染。
    const detailState = { id: 7, range: '7d', billing: null, legacyKeyInputFor: 6 };
    const input = { value: 'sk-typed-in-A' };
    const render = evalFn('renderLegacyKey', {
      detailState,
      $: (sel: string) =>
        sel === 'detail-legacy-key' ? { innerHTML: '' } : sel === 'detail-legacy-key-paste' ? input : null,
      findAccount: () => ({ hasLegacyKey: false, legacyKeyMasked: null }),
      T: (k: string) => k,
      esc: (s: string) => String(s),
      dBlock: () => '',
    });
    render();
    // 残留输入被清空 + 归属账号更新为 B：后续 saveLegacyKey 不会把 A 的值写进 B。
    expect(input.value).toBe('');
    expect(detailState.legacyKeyInputFor).toBe(7);
  });

  it('renderLegacyKey 源码保留 M3 守卫（切账号清空输入框的判定）', () => {
    expect(fnSource('renderLegacyKey')).toContain('detailState.legacyKeyInputFor !== id');
    expect(fnSource('renderLegacyKey')).toContain("input.value = ''");
  });
});

describe('对抗审查 6 项修复的回归测试', () => {
  it('1a. money() 仍是 microCents→美元（把美元值再过 money 会压成 $0.00）', () => {
    const money = evalFn<(mc: unknown) => string>('money');
    expect(money(4218000000)).toBe('$42.18');  // 1e8 microCents = $1
    expect(money(42.18)).toBe('$0.00');        // 若把「已是美元」的值再过 money，就丢精度——正是被修的 bug
    expect(money(null)).toBe('—');
    expect(money(0)).toBe('$0.00');
  });

  it('1b. renderBilling 的 balance/promotional 不再过 money()（后端已是美元）', () => {
    const src = fnSource('renderBilling');
    expect(src).toContain('Number(data.balance).toFixed(2)');
    expect(src).toContain('Number(data.promotional).toFixed(2)');
    expect(src).not.toContain('money(data.balance)');
    expect(src).not.toContain('money(data.promotional)');
    // 账户列表页 accountCard 的显示口径没被误改。
    expect(fnSource('accountCard')).toContain("'$' + Number(a.balance).toFixed(2)");
  });

  it('2. renderFingerprint 排除 inFlight/lastUsedAt，保留状态字段', () => {
    const fp = evalFn<(d: unknown) => string>('renderFingerprint');
    const base: any = {
      degraded: false,
      list: [{
        id: 1, name: 'a', kind: 'subscription', status: 'ok', statusDetail: null,
        retryUntil: 0, balance: 10, monthlyLimit: 100, monthlyUsage: 5,
        lastProbeAt: 123, lastBillingAt: 456,
        keys: [{ fingerprint: 'abc', healthy: true, inFlight: 0, disabledReason: null, lastUsedAt: 111, nickname: 'k1' }],
      }],
    };
    const clone = (x: any): any => JSON.parse(JSON.stringify(x));
    // 只有 inFlight/lastUsedAt 变（任何请求都会变）→ 指纹不变，2s 轮询不重建列表。
    const busy = clone(base);
    busy.list[0].keys[0].inFlight = 2;
    busy.list[0].keys[0].lastUsedAt = 999;
    expect(fp(base)).toBe(fp(busy));
    // disabledReason 变（禁用/恢复）→ 指纹变，触发重建。
    const disabled = clone(base);
    disabled.list[0].keys[0].disabledReason = 'quota-exhausted';
    expect(fp(base)).not.toBe(fp(disabled));
    // nickname 变 → 指纹变，改名仍能刷新。
    const renamed = clone(base);
    renamed.list[0].keys[0].nickname = 'k2';
    expect(fp(base)).not.toBe(fp(renamed));
  });

  it('3. GO toggle 成功路径清 stickyErr[go] + 清空 go-err（失败才保留）', () => {
    const code = inlineScript();
    // 成功分支存在：delete stickyErr['go']（单引号 go 只在 toggle 成功分支出现）+
    // go-err 文本被清空。
    expect(code).toContain("delete stickyErr['go'];");
    expect(code).toContain("ge.textContent = '';");
    // 失败分支保留 sticky 标记，结构仍在。
    expect(code).toContain("stickyErr['go'] = true;");
    expect(code).toContain("ge.textContent = errMsg(r);");
    // 成功分支的 delete 必须位于 else 里（跟着 toggle 的 POST 响应），而不是
    // clearSticky 内部的 delete stickyErr[name]。
    const pos = code.indexOf("stickyErr['go'] = true;");
    const seg = code.slice(pos - 200, pos + 400);
    expect(seg).toMatch(/if \(!r\.ok\) \{[\s\S]*?\} else \{[\s\S]*?delete stickyErr\['go'\];/);
  });

  it('4a. opDone 成功后调用第三个参数 reload，失败不调用', () => {
    const calls: string[] = [];
    const opDone = evalFn<(r: { ok: boolean }, msg: string, reload?: () => void) => void>('opDone', {
      closeConfirm: () => calls.push('close'),
      flash: () => calls.push('flash'),
      tick: () => calls.push('tick'),
      unlockConfirm: () => calls.push('unlock'),
      errMsg: () => 'err',
      $: () => ({}),
    });
    let reloaded = 0;
    opDone({ ok: true }, 'ok', () => reloaded++);
    expect(reloaded).toBe(1);
    expect(calls).toContain('tick');
    opDone({ ok: false }, 'bad', () => reloaded++);
    expect(reloaded).toBe(1);  // 失败路径不 reload
    expect(calls).toContain('unlock');
  });

  it('4b. 每个写操作按类型重载对应区块（tick 不刷 sa/budgets/members/providers）', () => {
    const code = inlineScript();
    expect(code).toContain("opDone(r, T('arSaved'), function () { loadBilling(id, false); })");
    expect(code).toContain("opDone(r, T('mlSaved'), function () { loadBudgets(id); })");
    expect(code).toContain("opDone(r, T('saCreated'), function () { loadSa(id); })");
    expect(code).toContain("opDone(r, T('saDeleted'), function () { loadSa(id); })");
    expect(code).toContain("opDone(r, T('cookieImported'), function () { loadAccountDetail(); })");
  });

  it('5. DETAIL_BLOCK_KEYS 引用的全部 i18n 键都在字典（变量传键的 T(b[1]) 场景）', () => {
    const code = inlineScript();
    const start = code.indexOf('var DETAIL_BLOCK_KEYS = [');
    const end = code.indexOf('];', start);
    const arrSrc = code.slice(start, end);
    const refs = [...arrSrc.matchAll(/\[['"]([\w-]+)['"], ['"](\w+)['"], ['"](\w+)['"]\]/g)]
      .map((m) => [m[1]!, m[2]!, m[3]!] as [string, string, string]);
    expect(refs.length).toBeGreaterThan(10);
    const en = new Set(codeOfDict('en'));
    const zh = new Set(codeOfDict('zh'));
    for (const [, title, sub] of refs) {
      expect(en.has(title), `en 缺 ${title}`).toBe(true);
      expect(en.has(sub), `en 缺 ${sub}`).toBe(true);
      expect(zh.has(title), `zh 缺 ${title}`).toBe(true);
      expect(zh.has(sub), `zh 缺 ${sub}`).toBe(true);
    }
    // 坏键（不在字典的 8 个）不能再出现在数组里。
    for (const bad of ['modelsUsageTitle', 'modelsUsageSub', 'usersUsageTitle', 'usersUsageSub',
                       'goTitle', 'legacyKeysTitle', 'legacyKeysSub', 'legacyBillingTitle']) {
      expect(arrSrc, `DETAIL_BLOCK_KEYS 里残留坏键 ${bad}`).not.toContain(bad);
    }
    // 骨架键与对应 render 函数 dBlock() 实际用的键一致（loading 标题 = 渲染后标题）。
    expect(code).toContain("['detail-models-usage', 'modelUsageTitle', 'modelUsageSub']");
    expect(code).toContain("['detail-users-usage', 'userUsageTitle', 'userUsageSub']");
    expect(code).toContain("['detail-go', 'goSub', 'goSubHint']");
    expect(code).toContain("['detail-legacy', 'legacyKeys', 'legacySub']");
    expect(code).toContain("['detail-legacy-billing', 'legacyBilling', 'legacyBillingSub']");
  });

  it('6. 每个详情 load* 回调首行有 detailState.id 切换守卫（旧账号慢响应不渲染进新视图）', () => {
    const detailLoaders = ['loadWorkspaces', 'loadUsage', 'loadModelsUsage', 'loadUsersUsage',
      'loadMemberBudgets', 'loadPricing', 'loadLegacyBilling', 'loadMembers', 'loadSa',
      'loadLegacyKeys', 'loadProviders', 'loadBudgets', 'loadBilling', 'loadGo'];
    for (const fn of detailLoaders) {
      const src = fnSource(fn);
      expect(src, `${fn} 缺详情切换守卫`).toContain('if (detailState.id !== id) return;');
      // 守卫必须是 `.then(function (r) {` 之后的头一行：成功路径拦截旧账号响应。
      const thenI = src.indexOf('.then');
      expect(thenI, `${fn} 找不到 .then`).toBeGreaterThan(-1);
      expect(src.slice(thenI, thenI + 160), `${fn} 的 then 回调首行必须是守卫`).toContain('if (detailState.id !== id) return;');
    }
  });
});

describe('Model Access 面板（MODEL-ACCESS §6）', () => {
  it('tab 按钮 + 四段挂载点存在（view-access + 全局/搜索/上游/分发/API key）', () => {
    expect(ADMIN_HTML).toContain('data-tab="access"');
    for (const id of ['view-access', 'sec-access-global', 'sec-access-upstream',
                      'sec-access-token', 'sec-access-apikey', 'ma-global-chips',
                      'ma-global-save', 'ma-global-reset', 'ma-search', 'ma-filter',
                      'ma-upstream', 'ma-token', 'ma-apikey', 'ma-refresh']) {
      expect(ADMIN_HTML, `缺挂载点 #${id}`).toContain(`id="${id}"`);
    }
  });

  it('内联 JS 有 model-access 渲染/编辑逻辑（loadModelAccess + 编辑委托 + 端点路径）', () => {
    const code = inlineScript();
    expect(code).toContain('function loadModelAccess(');
    expect(code).toContain('function editModelAccess(');
    expect(code).toContain('function renderMaGlobal(');
    expect(code).toContain('data-action="ma-edit"');
    expect(code).toContain("data-subject=\"' + esc(k.subject || k.fingerprint || '')");
    expect(code).toContain("' + type + '/' + encodeURIComponent(subject)");
    expect(code).toContain('/__admin/api/model-access/global');
    expect(code).toContain("access: 'view-access'");
    expect(code).toContain("if (v === 'access') { loadModelAccess(); }");
  });

  it('切到 access tab 才拉配置（switchView 分支），2s tick 里不轮询（数据静态）', () => {
    const code = inlineScript();
    const tickSrc = code.slice(code.indexOf('function tick('), code.indexOf('function tick(') + 2000);
    expect(tickSrc.length).toBeGreaterThan(100);
    expect(tickSrc).not.toContain('loadModelAccess');
  });

  it('Model Access 词条 en/zh 都有（tab + 四段 + 编辑交互 + 搜索筛选）', () => {
    const keys = (lang: 'en' | 'zh'): Set<string> => {
      const code = inlineScript();
      const start = code.indexOf(`${lang}:`);
      expect(start).toBeGreaterThan(-1);
      const slice = code.slice(start);
      const end = slice.indexOf('\n    }');
      const body = slice.slice(0, end > 0 ? end : 4000);
      return new Set([...body.matchAll(/(?:^\s+|,\s*)([A-Za-z][\w]*)\s*:/gm)].map((m) => m[1]!).filter((k) => k !== lang));
    };
    const en = keys('en');
    const zh = keys('zh');
    for (const k of ['tabModelAccess', 'subModelAccess', 'maGlobalTitle', 'maGlobalSub',
                     'maGlobalModels', 'maGlobalFloor', 'maResetGlobal', 'maGlobalSaved',
                     'maSearchPh', 'maFilterAll', 'maFilterUpstream', 'maFilterToken', 'maFilterApiKey',
                     'maRefresh', 'maUpstreamTitle', 'maUpstreamSub', 'maTokenTitle', 'maTokenSub',
                     'maApiKeyTitle', 'maApiKeySub', 'maEmpty', 'maNoMatch', 'maCustomBadge',
                     'maFollowsGlobal', 'maEditTitle', 'maSaved', 'maFollowGlobal', 'maNotGrantable']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });

  it('OTA sec-update 挂载点 + 交互锚点齐全', () => {
    expect(ADMIN_HTML).toContain('id="sec-update"');
    expect(ADMIN_HTML).toContain('id="btn-ota-check"');
    expect(ADMIN_HTML).toContain('id="btn-ota-update"');
    expect(ADMIN_HTML).toContain('id="update-overlay"');
    expect(ADMIN_HTML).toContain('id="tab-dot-update"');
    // 设置 tab 子导航含 sec-update（在 sec-about 之前）。
    expect(inlineScript()).toContain("['subUpdate', 'sec-update'], ['subAbout', 'sec-about']");
    // 交互入口：检查 / 更新按钮 + 进度阶段文案轮换 + 60s 红点轮询。
    const code = inlineScript();
    expect(code).toContain("api('POST', '/__admin/api/update/check'");
    expect(code).toContain("api('POST', '/__admin/api/update/perform'");
    expect(code).toContain("api('GET', '/__admin/api/update/status', null)");
    expect(code).toContain("['otaStageCheck', 'otaStageDownload', 'otaStageVerify', 'otaStageSwap', 'otaStageRestart']");
    expect(code).toContain("loadOtaStatus(false)");
  });

  it('OTA 词条 en/zh 都有（设置 tab + 状态 + 阶段 + 确认弹层）', () => {
    const keys = (lang: 'en' | 'zh'): Set<string> => {
      const code = inlineScript();
      const start = code.indexOf(`${lang}:`);
      expect(start).toBeGreaterThan(-1);
      const slice = code.slice(start);
      const end = slice.indexOf('\n    }');
      const body = slice.slice(0, end > 0 ? end : 4000);
      return new Set([...body.matchAll(/(?:^\s+|,\s*)([A-Za-z][\w]*)\s*:/gm)].map((m) => m[1]!).filter((k) => k !== lang));
    };
    const en = keys('en');
    const zh = keys('zh');
    for (const k of ['subUpdate', 'otaTitle', 'otaSub', 'otaCurrent', 'otaLatest', 'otaDisabled',
                     'otaCheck', 'otaChecking', 'otaUpdate', 'otaCheckedAt', 'otaCheckFailed',
                     'otaPrevPresent', 'otaRolledBack', 'otaRollbackState', 'otaHint',
                     'otaConfirmTitle', 'otaConfirmBody',
                     'otaStageCheck', 'otaStageDownload', 'otaStageVerify', 'otaStageSwap', 'otaStageRestart',
                     'otaRestarting', 'otaChangelog', 'otaNoChangelog', 'otaClose']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 审计轮 P2 修复回归（2026-08-15）
// ---------------------------------------------------------------------------

/** originAllowed 只读 req.headers，fake req 用最小形状 + as never 断言。 */
function fakeReq(headers: Record<string, unknown>): never {
  return { headers } as never;
}

describe('A-P2-1：多值 Origin 数组头 fail-closed', () => {
  it('数组头（多 Origin）按拒绝处理', () => {
    expect(originAllowed(fakeReq({ origin: ['https://good.example', 'https://evil.example'], host: 'good.example' }))).toBe(false);
    expect(originAllowed(fakeReq({ origin: ['https://good.example'], host: 'good.example' }))).toBe(false);
  });

  it('单值同源放行；跨站/跨端口拒绝', () => {
    expect(originAllowed(fakeReq({ origin: 'https://good.example', host: 'good.example' }))).toBe(true);
    expect(originAllowed(fakeReq({ origin: 'https://good.example:443', host: 'good.example' }))).toBe(true);
    expect(originAllowed(fakeReq({ origin: 'https://evil.example', host: 'good.example' }))).toBe(false);
    expect(originAllowed(fakeReq({ origin: 'https://good.example:8443', host: 'good.example' }))).toBe(false);
  });

  it('无 Origin / 空 Origin 放行（curl 等非浏览器场景）', () => {
    expect(originAllowed(fakeReq({}))).toBe(true);
    expect(originAllowed(fakeReq({ origin: '', host: 'good.example' }))).toBe(true);
  });
});

describe('A-P2-4 / A-P2-7：面板前端改动（cookie 留空不更新 + tick 后台门控）', () => {
  it('saveEdit：cookie 输入框为空不发送该键，显式勾选清除才发 cookie:""', () => {
    const code = inlineScript();
    expect(code).toContain('if (cookie) body.cookie = cookie;');
    expect(code).toContain("else if (clearCookie) body.cookie = '';");
    expect(code).toContain("var clearCookie = $('e-clearcookie-' + id) && $('e-clearcookie-' + id).checked;");
    expect(code).toContain("T('cookieKeep')");
    expect(code).toContain("T('cookieClearCheckbox')");
    // 显式清除 checkbox 出现在编辑表单里。
    expect(ADMIN_HTML).toContain('id="e-clearcookie-\' + a.id + \'"');
  });

  it('A-P2-4 词条 cookieKeep / cookieClearCheckbox en/zh 都有', () => {
    for (const lang of ['en', 'zh']) {
      const code = inlineScript();
      const start = code.indexOf(`${lang}:`);
      expect(start).toBeGreaterThan(-1);
      const slice = code.slice(start);
      const end = slice.indexOf('\n    }');
      const body = slice.slice(0, end > 0 ? end : 4000);
      for (const k of ['cookieKeep', 'cookieClearCheckbox']) {
        expect(body, `${lang} 缺 ${k}`).toMatch(new RegExp(`\\b${k}\\s*:`));
      }
    }
  });

  it('tick 开头有 document.hidden 门控（后台 tab 不空转，与 OTA 轮询同款）', () => {
    const code = inlineScript();
    expect(code).toMatch(/function tick\(manual\)\s*\{\s*if \(document\.hidden\) return;/);
  });
});

describe('P2-2 / INFO-1 / INFO-2 修复回归（面板前端改动）', () => {
  it('P2-2：.ops 操作菜单触屏/键盘可达（focus-within + hover:none），桌面 hover 保留', () => {
    expect(ADMIN_HTML).toContain('.card:hover .ops { opacity: 1; }');
    expect(ADMIN_HTML).toContain('.ops:focus-within { opacity: 1; }');
    expect(ADMIN_HTML).toContain('@media (hover: none) { .ops { opacity: 1; } }');
  });

  it('INFO-1：requests/ipstats/audit 三请求只在 usage 视图拉取（其余视图 2s tick 不白打）', () => {
    const code = inlineScript();
    const tickSrc = code.slice(code.indexOf('function tick('), code.indexOf('function tick(') + 2500);
    expect(tickSrc).toMatch(/if \(curView === 'usage'\) \{\s*fetchRequests\(\);\s*fetchIpStats\(\);\s*fetchAudit\(\);/);
    // 总览卡组（fetchUsage/fetchOverviewTrend）不包在门里，任何视图都要拉。
    const gated = tickSrc.slice(tickSrc.indexOf("if (curView === 'usage')"));
    expect(gated).not.toContain('fetchUsage');
    expect(gated).not.toContain('fetchOverviewTrend');
  });

  it('INFO-2：401 时一并清掉 OTA 60s 轮询定时器（赋值给 otaTimer，可被 clearInterval）', () => {
    const code = inlineScript();
    expect(code).toContain('var otaTimer = 0;');
    expect(code).toMatch(/otaTimer = setInterval\(function \(\) \{/);
    expect(code).toMatch(/clearInterval\(fcTickTimer\);[\s\S]*?if \(otaTimer\) clearInterval\(otaTimer\);/);
  });
});

describe('审计轮 P2 修复回归（admin 端点 e2e）', () => {
  let tmpDir: string;
  let db: UsageDb;
  let cfg: AppConfig;
  let store: AccountsStore;
  let pool: KeyPool;
  let server: Server;
  let baseUrl: string;
  let billingFail = false;
  // P2-3：console 返回形状可控（缺余额字段 / 显式 null / 正常值）。
  let billingShape: unknown = { balanceMicroCents: '12345678' };

  function makeCfg(): AppConfig {
    return {
      host: '127.0.0.1', port: 0,
      apiKeys: ['admin-key'],
      anthropicApiKey: 'sk-ant-fake',
      upstreamKeys: [],
      keyFailThreshold: 5, keyCooldownMs: 300_000,
      anthropicBaseUrl: 'http://placeholder',
      payAsYouGoBaseUrl: 'http://placeholder-payg',
      modelMap: {}, fallbackModel: 'deepseek-v4-flash',
      injectionMode: 'block', allowUnauthenticated: false,
      maxBodyBytes: 10 * 1024 * 1024,
      maxMessageChars: 200_000, maxMessages: 4_000,
      stripControlChars: true, trustClaudeCodeHeaders: false,
      dashboardOpen: true, dashboardPublic: false,
      usageDbPath: '', usageDbRetentionDays: 30,
      keyProbeIntervalMs: 0, keyProbeIdleMs: 1_800_000, keyProbeTimeoutMs: 5_000,
      gatewaySecret: 'p2-admin-secret', secretFilePath: '/dev/null',
      billingIntervalMs: 1_800_000, billingTimeoutMs: 20_000,
      oauthClientId: 'opencode-cli', oauthConsoleUrl: 'https://console.opencode.ai',
      scaleClientTokens: false, clientTokenScale: 0.6657,
      compactEnabled: false, compactTriggerBytes: 4 * 1024 * 1024, compactMaxMessageChars: 8000,
      adminUser: 'admin', adminPass: 'thankyouopencode',
      adminSessionTtlMs: 86_400_000, adminLoginFailLimit: 5, adminLoginLockMs: 300_000,
    };
  }

  /** 面板只用 billingStatus/cookieStatus/lastError 三个方法，其余打不住。 */
  const consoleClient = {
    billingStatus: async (): Promise<unknown | null> =>
      billingFail ? null : billingShape,
    cookieStatus: (): 'ok' | 'invalid' => (billingFail ? 'invalid' : 'ok'),
    lastError: (): 'auth' | null => (billingFail ? 'auth' : null),
  } as unknown as Parameters<typeof createApp>[5];

  async function createAccount(name: string, keys: string[], cookie?: string): Promise<number> {
    const res = await fetch(`${baseUrl}/__admin/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, kind: 'unknown', keys, cookie }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { account: { id: number } }).account.id;
  }

  function lastAudit(op: string): { ok: number; note: string | null } {
    const row = db
      .sqlite()!
      .prepare('SELECT ok, note FROM admin_audit WHERE op = ? ORDER BY id DESC LIMIT 1')
      .get(op) as { ok: number; note: string | null } | undefined;
    return row ?? { ok: -1, note: null };
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-admin-p2-'));
    cfg = makeCfg();
    db = new UsageDb(path.join(tmpDir, 'p2.db'), 30, () => {});
    const secret = loadSecret({ gatewaySecret: 'p2-admin-secret', secretFilePath: '/dev/null' } as unknown as AppConfig)!;
    store = new AccountsStore(db, secret, cfg, () => {});
    pool = new KeyPool([], { cooldownMs: cfg.keyCooldownMs, failThreshold: cfg.keyFailThreshold });
    server = createApp(cfg, pool, db, store, undefined, consoleClient);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('A-P2-4：PATCH 不带 cookie 键不覆盖已存 cookie；显式 cookie:"" 才清除', async () => {
    const id = await createAccount('cookie-keep', [], 'auth=keepme');
    expect(store.cookieOf(id)).toBe('auth=keepme');
    const patch = await fetch(`${baseUrl}/__admin/api/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(patch.status).toBe(200);
    expect(store.cookieOf(id)).toBe('auth=keepme');
    // 显式清除路径仍可用（前端勾选「清除已存 cookie」→ 发 cookie:''）。
    const clear = await fetch(`${baseUrl}/__admin/api/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookie: '' }),
    });
    expect(clear.status).toBe(200);
    expect(store.cookieOf(id)).toBe(null);
    await fetch(`${baseUrl}/__admin/api/accounts/${id}`, { method: 'DELETE' });
  });

  it('A-P2-3：手动刷新余额有审计（成功 ok=1 / 失败 ok=0 带原因）', async () => {
    const id = await createAccount('billing-audit', ['sk-billing-1']);
    const ok = await fetch(`${baseUrl}/__admin/api/accounts/${id}/billing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(ok.status).toBe(200);
    expect(lastAudit('account.billing-refresh')).toEqual({ ok: 1, note: 'ok' });
    billingFail = true;
    try {
      const fail = await fetch(`${baseUrl}/__admin/api/accounts/${id}/billing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(fail.status).toBe(502);
      expect(lastAudit('account.billing-refresh')).toEqual({ ok: 0, note: 'console auth invalid' });
    } finally {
      billingFail = false;
    }
    await fetch(`${baseUrl}/__admin/api/accounts/${id}`, { method: 'DELETE' });
  });

  it('P2-3：console 缺余额字段不覆盖历史余额（部分更新），显式 null 才清空', async () => {
    const id = await createAccount('billing-partial', ['sk-billing-partial']);
    const refresh = () =>
      fetch(`${baseUrl}/__admin/api/accounts/${id}/billing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    try {
      // 先刷出历史余额。
      billingShape = { balanceMicroCents: '5000000' };
      expect((await refresh()).status).toBe(200);
      expect(store.get(id)!.balanceUnits).toBe(5000000);
      // 字段缺失（只带月额度，无 combinedAvailable/balanceMicroCents）→ 保留历史余额。
      billingShape = { monthlyLimitMicroCents: '1000000000' };
      expect((await refresh()).status).toBe(200);
      expect(store.get(id)!.balanceUnits).toBe(5000000);
      // 显式 null（上游明确无余额）→ 清空。
      billingShape = { balanceMicroCents: null };
      expect((await refresh()).status).toBe(200);
      expect(store.get(id)!.balanceUnits).toBe(null);
    } finally {
      billingShape = { balanceMicroCents: '12345678' };
      await fetch(`${baseUrl}/__admin/api/accounts/${id}`, { method: 'DELETE' });
    }
  });

  it('A-P2-5：账号写操作审计 note 不再恒 null（create/patch/add-key/remove-key/delete）', async () => {
    const id = await createAccount('note-test', ['sk-note-1']);
    expect(lastAudit('account.create')).toEqual({ ok: 1, note: 'note-test' });

    await fetch(`${baseUrl}/__admin/api/accounts/${id}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sk-note-2' }),
    });
    expect(lastAudit('account.add-key')).toEqual({ ok: 1, note: keyFingerprint('sk-note-2') });

    await fetch(`${baseUrl}/__admin/api/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'note-renamed' }),
    });
    expect(lastAudit('account.patch')).toEqual({ ok: 1, note: 'name' });

    await fetch(`${baseUrl}/__admin/api/accounts/${id}/keys/${encodeURIComponent(keyFingerprint('sk-note-1'))}`, {
      method: 'DELETE',
    });
    expect(lastAudit('account.remove-key')).toEqual({ ok: 1, note: keyFingerprint('sk-note-1') });

    await fetch(`${baseUrl}/__admin/api/accounts/${id}`, { method: 'DELETE' });
    expect(lastAudit('account.delete')).toEqual({ ok: 1, note: 'note-renamed' });
  });

  it('A-P2-6：setLegacyCookie 落库失败 → 500 + 审计 note', async () => {
    class FailLegacyStore extends AccountsStore {
      override setLegacyCookie(_id: number, _cookie: string | null): boolean {
        return false;
      }
    }
    const secret = loadSecret({ gatewaySecret: 'p2-admin-secret', secretFilePath: '/dev/null' } as unknown as AppConfig)!;
    const store2 = new FailLegacyStore(db, secret, cfg, () => {});
    const pool2 = new KeyPool([], { cooldownMs: cfg.keyCooldownMs, failThreshold: cfg.keyFailThreshold });
    const server2 = createApp(cfg, pool2, db, store2);
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
    const a2 = server2.address();
    const url = `http://127.0.0.1:${typeof a2 === 'object' && a2 ? a2.port : 0}`;
    try {
      const create = await fetch(`${url}/__admin/api/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'legacy-cookie-fail', kind: 'unknown', keys: [] }),
      });
      expect(create.status).toBe(201);
      const id = ((await create.json()) as { account: { id: number } }).account.id;
      const patch = await fetch(`${url}/__admin/api/accounts/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ legacyCookie: 'auth=legacy' }),
      });
      expect(patch.status).toBe(500);
      expect(lastAudit('account.patch')).toEqual({ ok: 0, note: 'legacy cookie save failed' });
    } finally {
      await new Promise<void>((r) => server2.close(() => r()));
    }
  });

  it('PATCH legacyKey：保存（加密落库、响应只给掩码）+ null 清除 + 明文绝不外泄', async () => {
    const id = await createAccount('legacy-key-patch', []);
    const plain = 'sk-AOpQOUTje3uIJRVctKiLocPCaPPF1yWBQwOlwP7JfiOX47iCoL8BeTFTviyd0osU';
    const patch = await fetch(`${baseUrl}/__admin/api/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ legacyKey: plain }),
    });
    expect(patch.status).toBe(200);
    // 进程内明文可解（zen usage 端点要发 Bearer）。
    expect(store.legacyKeyOf(id)).toBe(plain);
    const body = (await patch.json()) as { account: { hasLegacyKey: boolean; legacyKeyMasked: string | null } };
    expect(body.account.hasLegacyKey).toBe(true);
    expect(body.account.legacyKeyMasked).toBe('sk-AOpQ...0osU');
    // 隐私：响应绝不含明文。
    expect(JSON.stringify(body)).not.toContain('OUTje3uIJRVctKiLocPCaPPF1y');
    expect(body.account).not.toHaveProperty('legacyKey');
    // null = 清除。
    const clear = await fetch(`${baseUrl}/__admin/api/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ legacyKey: null }),
    });
    expect(clear.status).toBe(200);
    expect(store.legacyKeyOf(id)).toBeNull();
    const clearBody = (await clear.json()) as { account: { hasLegacyKey: boolean } };
    expect(clearBody.account.hasLegacyKey).toBe(false);
    await fetch(`${baseUrl}/__admin/api/accounts/${id}`, { method: 'DELETE' });
  });

  it('D-P2-3：删账户/删 key 清理 model_access 的 upstream-key 行（sha256 subject）', async () => {
    const ma = new ModelAccessStore(db);
    const sha = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');
    // 删账户：整批 key 的授权行一起清。
    const id1 = await createAccount('ma-delete', ['sk-ma-1', 'sk-ma-2']);
    ma.setCustom('upstream-key', sha('sk-ma-1'), ['deepseek-v4-flash']);
    ma.setCustom('upstream-key', sha('sk-ma-2'), ['deepseek-v4-flash']);
    expect(ma.listByType('upstream-key')).toHaveLength(2);
    const del = await fetch(`${baseUrl}/__admin/api/accounts/${id1}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(ma.listByType('upstream-key')).toHaveLength(0);

    // 删单 key：只清那一把，其余保留。
    const id2 = await createAccount('ma-remkey', ['sk-ma-3', 'sk-ma-4']);
    ma.setCustom('upstream-key', sha('sk-ma-3'), ['deepseek-v4-flash']);
    ma.setCustom('upstream-key', sha('sk-ma-4'), ['deepseek-v4-flash']);
    expect(ma.listByType('upstream-key')).toHaveLength(2);
    const delKey = await fetch(
      `${baseUrl}/__admin/api/accounts/${id2}/keys/${encodeURIComponent(keyFingerprint('sk-ma-3'))}`,
      { method: 'DELETE' },
    );
    expect(delKey.status).toBe(204);
    const rows = ma.listByType('upstream-key');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectId).toBe(sha('sk-ma-4'));
    await fetch(`${baseUrl}/__admin/api/accounts/${id2}`, { method: 'DELETE' });
  });

  it('D-P2-3b：管理面删 key 后数据面共享实例缓存失效（getCustom 回退 null，防旧授权复活）', async () => {
    // M1（对抗审查实证复现）：admin.ts 若自建 ModelAccessStore 删行，server 数据面
    // 共享实例的 getCustom 缓存不失效 → 同值 key 换账号重加后仍按旧授权限制。
    // 这里把同一个 ma 实例注入 createApp（server.ts:2975 handleAdminRoutes 收到共享实例），
    // 删 key 后同一实例缓存必须已清。
    const ma = new ModelAccessStore(db);
    const pool3 = new KeyPool([], { cooldownMs: cfg.keyCooldownMs, failThreshold: cfg.keyFailThreshold });
    const server3 = createApp(cfg, pool3, db, store, undefined, consoleClient, undefined, undefined, undefined, undefined, undefined, ma);
    await new Promise<void>((r) => server3.listen(0, '127.0.0.1', r));
    const a3 = server3.address();
    const url = `http://127.0.0.1:${typeof a3 === 'object' && a3 ? a3.port : 0}`;
    try {
      const sha = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');
      // 数据面（同一 ma）先缓存一条 upstream-key 授权。
      ma.setCustom('upstream-key', sha('sk-ma-cache'), ['deepseek-v4-flash']);
      expect(ma.getCustom('upstream-key', sha('sk-ma-cache'))).toEqual(['deepseek-v4-flash']);
      // 建账号（含该 key），走管理面删 key 端点。
      const create = await fetch(`${url}/__admin/api/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ma-cache', kind: 'unknown', keys: ['sk-ma-cache'] }),
      });
      expect(create.status).toBe(201);
      const id = ((await create.json()) as { account: { id: number } }).account.id;
      const delKey = await fetch(
        `${url}/__admin/api/accounts/${id}/keys/${encodeURIComponent(keyFingerprint('sk-ma-cache'))}`,
        { method: 'DELETE' },
      );
      expect(delKey.status).toBe(204);
      // 同一实例缓存必须已失效，否则数据面仍按旧授权限制该 key。
      expect(ma.getCustom('upstream-key', sha('sk-ma-cache'))).toBeNull();
      await fetch(`${url}/__admin/api/accounts/${id}`, { method: 'DELETE' });
    } finally {
      await new Promise<void>((r) => server3.close(() => r()));
    }
  });
});

describe('go 端点 legacyKey 优先：zen usage 成功走 zen、失败回落 cookie HTML', () => {
  let tmpDir: string;
  let db: UsageDb;
  let cfg: AppConfig;
  let store: AccountsStore;
  let client: FakeLegacyZenClient;
  let server: Server;
  let baseUrl: string;
  let ttl: LegacyTtlCache;

  const WS = 'wrk_01KZEQCBJ59Y3T34CSJNRVQJV7';
  const ZEN_STATUS: LegacyGoStatus = {
    subscribed: true, useBalance: false, chinaModels: false,
    rolling: { status: 'ok', resetInSec: 3600, usagePercent: 5 },
    weekly: { status: 'ok', resetInSec: 86400, usagePercent: 41 },
    monthly: { status: 'ok', resetInSec: 2592000, usagePercent: 20 },
  };

  /** fake LegacyClientLike：记录 zen / cookie HTML 两条路径的调用，zen 可切换。 */
  class FakeLegacyZenClient implements LegacyClientLike {
    zen: LegacyGoStatus | null = null;
    /** cookie HTML 通道模拟失败（401 等），用于验证 cookie 失败时开关保持 false。 */
    cookieFail = false;
    calls: Array<{ method: string; cookie?: string | null; ws?: string; apiKey?: string }> = [];
    async listKeys(): Promise<LegacyReadResult> {
      this.calls.push({ method: 'listKeys' });
      return { ok: false, reason: 'upstream' };
    }
    async createKey(): Promise<LegacyWriteResult> {
      this.calls.push({ method: 'createKey' });
      return { ok: true };
    }
    async deleteKey(): Promise<LegacyWriteResult> {
      this.calls.push({ method: 'deleteKey' });
      return { ok: true };
    }
    async getGoStatus(_id: number, cookie: string | null, ws: string): Promise<LegacyGoReadResult> {
      this.calls.push({ method: 'getGoStatus', cookie, ws });
      if (this.cookieFail) return { ok: false, reason: 'auth' };
      return {
        ok: true,
        status: {
          subscribed: true, useBalance: false, chinaModels: true,
          rolling: { status: 'ok', resetInSec: 15184, usagePercent: 5 },
          weekly: { status: 'ok', resetInSec: 461761, usagePercent: 46 },
          monthly: { status: 'ok', resetInSec: 2413712, usagePercent: 60 },
        },
      };
    }
    async getZenGoUsage(_id: number, apiKey: string): Promise<LegacyGoStatus | null> {
      this.calls.push({ method: 'getZenGoUsage', apiKey });
      return this.zen;
    }
    async setGoToggle(): Promise<LegacyWriteResult> {
      this.calls.push({ method: 'setGoToggle' });
      return { ok: true };
    }
    async getBilling(): Promise<LegacyBillingReadResult> {
      this.calls.push({ method: 'getBilling' });
      return { ok: true, billing: { balanceDollars: 0, reload: null, payments: [], monthlyLimitDollars: null } };
    }
  }

  function makeCfg(): AppConfig {
    return {
      host: '127.0.0.1', port: 0,
      apiKeys: ['admin-key'],
      anthropicApiKey: 'sk-ant-fake',
      upstreamKeys: [],
      keyFailThreshold: 5, keyCooldownMs: 300_000,
      anthropicBaseUrl: 'http://placeholder',
      payAsYouGoBaseUrl: 'http://placeholder-payg',
      modelMap: {}, fallbackModel: 'deepseek-v4-flash',
      injectionMode: 'block', allowUnauthenticated: false,
      maxBodyBytes: 10 * 1024 * 1024,
      maxMessageChars: 200_000, maxMessages: 4_000,
      stripControlChars: true, trustClaudeCodeHeaders: false,
      dashboardOpen: true, dashboardPublic: false,
      usageDbPath: '', usageDbRetentionDays: 30,
      keyProbeIntervalMs: 0, keyProbeIdleMs: 1_800_000, keyProbeTimeoutMs: 5_000,
      gatewaySecret: 'p2-admin-secret', secretFilePath: '/dev/null',
      billingIntervalMs: 1_800_000, billingTimeoutMs: 20_000,
      oauthClientId: 'opencode-cli', oauthConsoleUrl: 'https://console.opencode.ai',
      scaleClientTokens: false, clientTokenScale: 0.6657,
      compactEnabled: false, compactTriggerBytes: 4 * 1024 * 1024, compactMaxMessageChars: 8000,
      adminUser: 'admin', adminPass: 'thankyouopencode',
      adminSessionTtlMs: 86_400_000, adminLoginFailLimit: 5, adminLoginLockMs: 300_000,
    };
  }

  async function mkAccount(legacyKey: string | null, cookie: string | null): Promise<number> {
    const created = store.create({ name: 'zen-a', kind: 'unknown', workspaceId: null, keys: [], cookie });
    if (!created.ok) throw new Error('account create failed');
    store.setLegacyWorkspaceId(created.value.id, WS);
    if (legacyKey) store.setLegacyKey(created.value.id, legacyKey);
    return created.value.id;
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-legacykey-zen-'));
    cfg = makeCfg();
    db = new UsageDb(path.join(tmpDir, 'zen.db'), 30, () => {});
    const secret = loadSecret({ gatewaySecret: 'p2-admin-secret', secretFilePath: '/dev/null' } as unknown as AppConfig)!;
    store = new AccountsStore(db, secret, cfg, () => {});
    client = new FakeLegacyZenClient();
    ttl = new LegacyTtlCache(LEGACY_TTL_MS);
    server = createApp(cfg, undefined, db, store, undefined, undefined, undefined, client, undefined, undefined, ttl);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });

  beforeEach(() => {
    client.zen = null;
    client.cookieFail = false;
    client.calls = [];
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('有 legacyKey + zen 成功 → 并行取 cookie 开关，合并：窗口来自 zen、开关来自 cookie HTML', async () => {
    const id = await mkAccount('sk-zen-legacy-key', 'auth=legacy-secret');
    ttl.clear(id);
    client.zen = ZEN_STATUS;
    const res = await fetch(`${baseUrl}/__admin/api/legacy/account/${id}/go`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { go: LegacyGoStatus } };
    expect(body.data.go.monthly!.usagePercent).toBe(20); // 窗口来自 zen 形状
    expect(body.data.go.chinaModels).toBe(true); // 开关来自 cookie HTML（fake getGoStatus）
    expect(body.data.go.useBalance).toBe(false);
    expect(client.calls.filter((c) => c.method === 'getZenGoUsage')).toHaveLength(1);
    expect(client.calls.find((c) => c.method === 'getZenGoUsage')!.apiKey).toBe('sk-zen-legacy-key');
    expect(client.calls.filter((c) => c.method === 'getGoStatus')).toHaveLength(1); // 并行取开关
    await fetch(`${baseUrl}/__admin/api/accounts/${id}`, { method: 'DELETE' });
  });

  it('有 legacyKey + zen 成功 + cookie 失效 → 开关保持 false，窗口仍来自 zen', async () => {
    const id = await mkAccount('sk-zen-legacy-key', 'auth=expired');
    ttl.clear(id);
    client.zen = ZEN_STATUS;
    client.cookieFail = true; // cookie HTML 通道 401
    const res = await fetch(`${baseUrl}/__admin/api/legacy/account/${id}/go`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { go: LegacyGoStatus } };
    expect(body.data.go.monthly!.usagePercent).toBe(20); // 窗口仍来自 zen
    expect(body.data.go.chinaModels).toBe(false); // cookie 失效 → 开关 false
    expect(body.data.go.useBalance).toBe(false);
    expect(client.calls.filter((c) => c.method === 'getGoStatus')).toHaveLength(1);
    await fetch(`${baseUrl}/__admin/api/accounts/${id}`, { method: 'DELETE' });
  });

  it('有 legacyKey + zen 失败（null）→ 回落 cookie HTML（getGoStatus 被调，带 store 解密 cookie）', async () => {
    const id = await mkAccount('sk-zen-legacy-key', 'auth=legacy-secret');
    ttl.clear(id);
    client.zen = null; // zen 失败
    const res = await fetch(`${baseUrl}/__admin/api/legacy/account/${id}/go`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { go: LegacyGoStatus } };
    expect(body.data.go.monthly!.usagePercent).toBe(60); // HTML 抓取形状（fake getGoStatus）
    expect(client.calls.filter((c) => c.method === 'getZenGoUsage')).toHaveLength(1);
    expect(client.calls.filter((c) => c.method === 'getGoStatus')).toHaveLength(1); // fallback
    expect(client.calls.find((c) => c.method === 'getGoStatus')!.cookie).toBe('auth=legacy-secret');
    await fetch(`${baseUrl}/__admin/api/accounts/${id}`, { method: 'DELETE' });
  });

  it('无 legacyKey → 完全走 cookie HTML（getZenGoUsage 零调用，既有行为不变）', async () => {
    const id = await mkAccount(null, 'auth=legacy-secret');
    ttl.clear(id);
    const res = await fetch(`${baseUrl}/__admin/api/legacy/account/${id}/go`);
    expect(res.status).toBe(200);
    expect(client.calls.filter((c) => c.method === 'getZenGoUsage')).toHaveLength(0);
    expect(client.calls.filter((c) => c.method === 'getGoStatus')).toHaveLength(1);
    await fetch(`${baseUrl}/__admin/api/accounts/${id}`, { method: 'DELETE' });
  });
});

