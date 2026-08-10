/**
 * 监控面板（单文件内联 HTML，零外部依赖）。
 *
 * 为什么内联成字符串：网关是零运行时依赖的单进程服务，不想引入静态文件服务、
 * 也不想让面板依赖 CDN（国内网络 + 离线可用）。图标全部内联 SVG。
 *
 * 设计对齐 opencode 的 token 体系（取自 packages/ui/src/styles/theme.css）：
 * - 全站等宽字体（他们把 --font-sans 直接指向 --font-mono），终端优先的身份
 * - 零渐变、零发光；圆角 4px；边框用半透明白叠加而非实色
 * - 文字色用 rgba 透明度分级（0.618 / 0.38 / 0.24），不用实色灰阶
 * - 强调色单一（#9dbefe 蓝），状态色只出现在状态位，不做装饰
 * - 标题不做 text-transform / letter-spacing，靠字重与颜色分层
 * - 括号记号 [*] 与 "Fig n." 标注沿用他们站点的 CLI 风格
 *
 * 数据来源：轮询 /__metrics（同源）。秒级刷新够用，免掉 WebSocket 的连接管理。
 */
export const DASHBOARD_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>fuckopencode — gateway</title>
<style>
  :root {
    --bg: #101010;
    --bg-strong: #121212;
    --bg-stronger: #151515;
    --bg-weak: #1e1e1e;
    --line: rgba(255,255,255,.195);
    --line-weak: rgba(255,255,255,.09);
    --line-hover: rgba(255,255,255,.284);
    --fg: #fcfcfc;
    --fg-base: rgba(255,255,255,.618);
    --fg-weak: rgba(255,255,255,.38);
    --fg-weaker: rgba(255,255,255,.24);
    --accent: #9dbefe;
    --ok: #9bcd97;
    --bad: #fc533a;
    --warn: #f4bdf8;
    --radius: 4px;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--fg-base);
    font-family: var(--mono);
    font-size: 13px; line-height: 150%;
    -webkit-font-smoothing: antialiased;
    font-variant-numeric: tabular-nums;
  }
  a { color: var(--accent); text-decoration: none; }

  /* ── topbar ─────────────────────────────────────── */
  header {
    position: sticky; top: 0; z-index: 30;
    display: flex; align-items: center; gap: 20px;
    padding: 0 20px; height: 46px;
    background: var(--bg); border-bottom: 1px solid var(--line-weak);
  }
  /* brand 可截断（min-width:0 才能让 flex item 缩到内容宽度以下），
     状态位与按钮不换行 —— 46px 单行 topbar 里换行会把字顶出边框。 */
  .brand {
    color: var(--fg); font-weight: 500;
    min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  }
  .brand span { color: var(--fg-weaker); font-weight: 400; }
  .spacer { flex: 1; }
  .stat-inline { color: var(--fg-weak); font-size: 12px; white-space: nowrap; }
  /* live 位在断流时会填入上游错误原文（[!] Failed to fetch 这类），长度不可控。
     给它 min-width:0 + 省略号，让它替按钮吸收溢出，而不是把按钮顶出可视区。 */
  #h-live { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .stat-inline b { color: var(--fg-base); font-weight: 400; }
  .stat-inline.ok b { color: var(--ok); }
  .stat-inline.bad b { color: var(--bad); }
  button {
    font: inherit; cursor: pointer; color: var(--fg-weak);
    background: transparent; border: 1px solid var(--line-weak);
    border-radius: var(--radius); padding: 3px 9px; font-size: 12px;
    white-space: nowrap; flex: none;
  }
  button:hover { color: var(--fg); border-color: var(--line-hover); }
  /* 窄屏降级：375px 下六个元素要 401px，会给整个文档拖出横向滚动条。
     按信息价值从低到高丢弃：收紧间距与内边距、摘掉 brand 的 / gateway 后缀和
     up 运行时长（时长不是判断故障的关键位）、状态位降到 11px；
     保住 pool / live 两个状态位和两个按钮。brand 兜底截断，池子位变长时
     溢出压在它身上，而不是把按钮顶出可视区。 */
  @media (max-width: 560px) {
    header { gap: 8px; padding: 0 12px; }
    .brand span, #h-up { display: none; }
    .stat-inline { font-size: 11px; }
  }

  main { padding: 20px; max-width: 1600px; margin: 0 auto; }

  /* ── section ────────────────────────────────────── */
  section { margin-bottom: 28px; }
  .sec-hd {
    display: flex; align-items: baseline; gap: 10px;
    padding-bottom: 8px; margin-bottom: 14px;
    border-bottom: 1px solid var(--line-weak);
  }
  .sec-hd h2 { font-size: 13px; font-weight: 500; color: var(--fg); }
  .sec-hd .fig { color: var(--fg-weaker); font-size: 12px; }
  .sec-hd .note { color: var(--fg-weaker); font-size: 12px; margin-left: auto; }

  .grid { display: grid; gap: 1px; background: var(--line-weak); border: 1px solid var(--line-weak); }
  .cols-4 { grid-template-columns: repeat(4, 1fr); }
  .cols-3 { grid-template-columns: repeat(3, 1fr); }
  @media (max-width: 1000px) { .cols-4 { grid-template-columns: repeat(2, 1fr); } .cols-3 { grid-template-columns: 1fr; } }
  @media (max-width: 560px) { .cols-4 { grid-template-columns: 1fr; } }

  /* ── metric cell ────────────────────────────────── */
  .cell { background: var(--bg); padding: 14px 16px; min-width: 0; }
  .cell .k { color: var(--fg-weaker); font-size: 12px; }
  .cell .v { color: var(--fg); font-size: 26px; font-weight: 400; line-height: 130%; margin-top: 3px; letter-spacing: -.32px; }
  .cell .v i { font-style: normal; font-size: 13px; color: var(--fg-weak); }
  .cell .d { color: var(--fg-weak); font-size: 12px; margin-top: 4px; }
  .cell .d b { font-weight: 400; color: var(--fg-base); }
  .spark { width: 100%; height: 26px; display: block; margin-top: 9px; }

  /* ── pipeline ───────────────────────────────────── */
  .pipe { display: flex; align-items: stretch; border: 1px solid var(--line-weak); }
  .pipe .st {
    flex: 1; padding: 12px 14px; min-width: 0;
    border-right: 1px solid var(--line-weak); position: relative;
  }
  .pipe .st:last-child { border-right: 0; }
  .pipe .st .n { color: var(--fg-weaker); font-size: 12px; }
  .pipe .st .b { color: var(--fg); font-size: 13px; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pipe .st.on { background: var(--bg-strong); }
  .pipe .st.on .b { color: var(--accent); }
  .pipe .st.on::before {
    content: ''; position: absolute; left: 0; right: 0; top: 0; height: 1px;
    background: var(--accent); opacity: .55;
  }
  @media (max-width: 860px) {
    .pipe { flex-direction: column; }
    .pipe .st { border-right: 0; border-bottom: 1px solid var(--line-weak); }
    .pipe .st:last-child { border-bottom: 0; }
  }

  /* ── bars ───────────────────────────────────────── */
  .bars { display: flex; flex-direction: column; }
  .bar {
    display: grid; grid-template-columns: minmax(0,1fr) auto;
    gap: 3px 12px; padding: 7px 0; border-bottom: 1px solid var(--line-weak);
  }
  .bar:last-child { border-bottom: 0; }
  .bar .n { color: var(--fg-base); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar .c { color: var(--fg-weak); font-size: 12px; }
  .bar .t { grid-column: 1 / -1; height: 2px; background: var(--bg-weak); }
  .bar .f { height: 100%; background: var(--accent); opacity: .8; transition: width .4s ease; }

  /* ── device ─────────────────────────────────────── */
  .devs { display: flex; flex-direction: column; }
  .dev { padding: 10px 0; border-bottom: 1px solid var(--line-weak); }
  .dev:last-child { border-bottom: 0; }
  .dev .hd { color: var(--fg); font-size: 12.5px; }
  .dev .hd em { font-style: normal; color: var(--fg-weaker); }
  .dev dl { display: grid; grid-template-columns: 68px 1fr; gap: 2px 10px; margin-top: 5px; font-size: 12px; }
  .dev dt { color: var(--fg-weaker); }
  .dev dd { color: var(--fg-weak); word-break: break-all; }

  /* ── key pool ───────────────────────────────────── */
  /* 不写死列数：key 数量由配置决定（线上 2 个，本地 3 个，以后可能 5 个），
     任何固定值在别的数量下都会难看。
     用 auto-fit 而非 auto-fill —— auto-fill 会留下空轨道，容器那层
     半透明底色就会露出一整块空白（3 个卡片 4 列时实测如此）。 */
  .keys {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(288px, 1fr));
    gap: 1px; background: var(--line-weak); border: 1px solid var(--line-weak);
  }
  .kc { background: var(--bg); padding: 12px 14px; min-width: 0; }
  .kc.off { background: var(--bg-strong); }
  .kc .hd { display: flex; align-items: baseline; gap: 8px; }
  .kc .fp { color: var(--fg); font-size: 13px; }
  .kc .badge { margin-left: auto; font-size: 12px; white-space: nowrap; }
  .kc dl { display: grid; grid-template-columns: 64px 1fr; gap: 3px 10px; margin-top: 8px; font-size: 12px; }
  .kc dt { color: var(--fg-weaker); }
  .kc dd { color: var(--fg-weak); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .kc dd b { font-weight: 400; color: var(--fg-base); }
  .kc .glyph { color: var(--accent); letter-spacing: 1px; }
  .kc .glyph em { font-style: normal; color: var(--fg-weaker); }
  .kc .t { height: 2px; background: var(--bg-weak); margin-top: 9px; }
  .kc .t .f { display: block; height: 100%; background: var(--accent); opacity: .8; transition: width .4s ease; }
  .kc.off .t .f { background: var(--bad); }

  .kevs { display: flex; flex-direction: column; margin-top: 12px; }
  .kev {
    display: grid; grid-template-columns: 62px 84px 1fr auto;
    gap: 10px; padding: 5px 0; font-size: 12px;
    border-bottom: 1px solid var(--line-weak); color: var(--fg-weak);
  }
  .kev:last-child { border-bottom: 0; }
  .kev .w { color: var(--fg-weaker); }
  @media (max-width: 620px) { .kev { grid-template-columns: 62px 84px 1fr; } .kev .kv-h { display: none; } }

  /* 冷却策略：回答「为什么恢复时刻是这个数」。规则从真实配置算出，不是写死文案。 */
  .kpol { margin-top: 12px; border-top: 1px solid var(--line-weak); padding-top: 8px; font-size: 12px; }
  .kpol .hd { color: var(--fg-weaker); margin-bottom: 6px; }
  .kpol .r { display: grid; grid-template-columns: 128px 92px 1fr; gap: 4px 10px; padding: 2px 0; }
  .kpol .r .k { color: var(--fg-weak); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .kpol .r .v { color: var(--fg-base); white-space: nowrap; }
  .kpol .r .d { color: var(--fg-weaker); min-width: 0; }
  .kpol .cfg { color: var(--fg-weaker); margin-top: 6px; }
  @media (max-width: 620px) {
    .kpol .r { grid-template-columns: 112px 1fr; }
    .kpol .r .d { grid-column: 1/-1; }
  }

  /* ── ascii banner ───────────────────────────────── */
  /* ASCII banner：41 字符宽，11px 等宽约 270px。max-width:100% + overflow
     保证窄屏也不会把文档撑出横向滚动条。 */
  .ascii {
    color: var(--fg-weaker); font-size: 11px; line-height: 1.05;
    white-space: pre; letter-spacing: 0;
    margin-bottom: 16px; max-width: 100%; overflow-x: auto;
  }
  .ascii b { color: var(--accent); font-weight: 400; }
  @media (max-width: 700px) { .ascii { font-size: 7px; } }
  @media (max-width: 460px) { .ascii { display: none; } }
  .tagline { color: var(--fg-weaker); font-size: 12px; margin: -6px 0 18px; }

  /* ── request log（放弃 15 列宽表，改成两行式条目：不挤不叠）──── */
  .log { border: 1px solid var(--line-weak); }
  .log-hd {
    display: grid; grid-template-columns: 62px 76px 1fr 54px 62px 96px;
    gap: 12px; padding: 7px 12px; background: var(--bg-strong);
    border-bottom: 1px solid var(--line-weak);
    color: var(--fg-weaker); font-size: 12px;
    position: sticky; top: 46px; z-index: 5;
  }
  .ent { border-bottom: 1px solid var(--line-weak); }
  .ent:last-child { border-bottom: 0; }
  .ent:hover { background: var(--bg-strong); }
  .ent.new { background: var(--bg-stronger); }
  .ent .r1 {
    display: grid; grid-template-columns: 62px 76px 1fr 54px 62px 96px;
    gap: 12px; padding: 7px 12px; align-items: baseline;
  }
  .ent .r2 {
    padding: 0 12px 8px 86px; color: var(--fg-weaker); font-size: 12px;
    display: flex; flex-wrap: wrap; gap: 4px 14px;
  }
  .ent .r2 span { white-space: nowrap; }
  /* 上游错误原文是唯一长度不可控的一项（上游文案 + 状态码，可能上百字符）。
     其余各项都是短标签所以统一 nowrap，这项必须能折行，否则窄屏横向溢出 ——
     实测 375px 下一条 429 文案把 scrollWidth 顶到 604px。 */
  .ent .r2 span.s-bad { white-space: normal; overflow-wrap: anywhere; }
  .ent .r2 em { font-style: normal; color: var(--fg-weak); }
  .cut { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .ta-r { text-align: right; }
  @media (max-width: 780px) {
    .log-hd { display: none; }
    .ent .r1 { grid-template-columns: 62px 1fr auto; }
    .ent .r1 .h-model, .ent .r1 .h-ms { display: none; }
    .ent .r2 { padding-left: 12px; }
  }

  .w { color: var(--fg-weaker); }
  .s-ok { color: var(--ok); }
  .s-bad { color: var(--bad); }
  .s-acc { color: var(--accent); }
  .s-warn { color: var(--warn); }
  .empty { padding: 32px; text-align: center; color: var(--fg-weaker); }
  /* 与上一段留出呼吸，之前只有 4px 导致文字贴在表格上 */
  footer {
    color: var(--fg-weaker); font-size: 12px;
    margin-top: 24px; padding-top: 12px;
    border-top: 1px solid var(--line-weak);
    display: flex; flex-wrap: wrap; gap: 4px 16px;
  }
</style>
</head>
<body>
<header>
  <div class="brand">fuckopencode <span>/ gateway</span></div>
  <div class="spacer"></div>
  <div class="stat-inline" id="h-pool">pool —</div>
  <div class="stat-inline" id="h-up">up —</div>
  <div class="stat-inline ok" id="h-live">[*] live</div>
  <button id="btn-lang">中文</button>
  <button id="btn">pause</button>
</header>

<main>
  <div class="ascii" aria-hidden="true"><b>████ █  █  ███ █  █ ████ ████ ████ █  █  ███ ████ ███  ████
█    █  █ █    █ █  █  █ █  █ █    ██ █ █    █  █ █  █ █
███  █  █ █    ██   █  █ ████ ███  █ ██ █    █  █ █  █ ███
█    █  █ █    █ █  █  █ █    █    █  █ █    █  █ █  █ █
█    ████  ███ █  █ ████ █    ████ █  █  ███ ████ ███  ████</b></div>
  <div class="tagline" id="t-tagline"></div>

  <section>
    <div class="sec-hd">
      <h2 data-i18n="overview">Overview</h2><span class="fig">Fig 1.</span>
      <span class="note" id="n-window">window 200</span>
    </div>
    <div class="grid cols-4">
      <div class="cell">
        <div class="k" data-i18n="kRequests">requests</div>
        <div class="v" id="m-total">0</div>
        <div class="d" id="d-req"></div>
        <svg class="spark" id="sp-req" preserveAspectRatio="none"></svg>
      </div>
      <div class="cell">
        <div class="k" data-i18n="kLatency">latency</div>
        <div class="v" id="m-avg">0<i>ms</i></div>
        <div class="d" id="d-lat"></div>
        <svg class="spark" id="sp-lat" preserveAspectRatio="none"></svg>
      </div>
      <div class="cell">
        <div class="k" data-i18n="kTokens">tokens</div>
        <div class="v" id="m-tok">0</div>
        <div class="d" id="d-tok"></div>
        <svg class="spark" id="sp-tok" preserveAspectRatio="none"></svg>
      </div>
      <div class="cell">
        <div class="k" data-i18n="kDevices">devices</div>
        <div class="v" id="m-dev">0</div>
        <div class="d" id="d-dev"></div>
        <svg class="spark" id="sp-dev" preserveAspectRatio="none"></svg>
      </div>
    </div>
  </section>

  <section>
    <div class="sec-hd">
      <h2 data-i18n="pipeline">Pipeline</h2><span class="fig">Fig 2.</span>
      <span class="note" id="n-pipe">idle</span>
    </div>
    <div class="pipe" id="pipe"></div>
  </section>

  <section>
    <div class="sec-hd">
      <h2 data-i18n="keypool">Key pool</h2><span class="fig">Fig 3.</span>
      <span class="note" id="n-pool">—</span>
    </div>
    <div class="keys" id="keys"></div>
    <div class="kevs" id="kevs"></div>
    <div class="kpol" id="kpol"></div>
  </section>

  <section class="grid cols-3" style="background:transparent;border:0;gap:28px">
    <div style="grid-column:span 1">
      <div class="sec-hd"><h2 data-i18n="models">Models</h2><span class="fig">Fig 4.</span></div>
      <div class="bars" id="b-model"></div>
    </div>
    <div style="grid-column:span 1">
      <div class="sec-hd"><h2 data-i18n="clients">Clients</h2><span class="fig">Fig 5.</span></div>
      <div class="bars" id="b-client"></div>
    </div>
    <div style="grid-column:span 1">
      <div class="sec-hd"><h2 data-i18n="devices">Devices</h2><span class="fig">Fig 6.</span></div>
      <div class="devs" id="devs"></div>
    </div>
  </section>

  <section>
    <div class="sec-hd">
      <h2 data-i18n="requests">Requests</h2><span class="fig">Fig 7.</span>
      <span class="note" data-i18n="recentFirst">most recent first</span>
    </div>
    <div class="log">
      <div class="log-hd">
        <span data-i18n="hTime">time</span><span data-i18n="hStatus">status</span><span data-i18n="hRequest">request</span>
        <span class="ta-r" data-i18n="hMs">ms</span><span class="ta-r" data-i18n="hTokens">tokens</span><span data-i18n="hClient">client</span>
      </div>
      <div id="rows"><div class="empty" data-i18n="noReq">no requests yet</div></div>
    </div>
  </section>

  <footer id="foot"><span>—</span></footer>
</main>

<script>
(function () {
  var paused = false, topId = 0;

  /**
   * 中英文词条。默认跟随浏览器语言（zh 开头用中文），可手动切换并存 localStorage。
   * 只译界面文案；模型名、路径、协议名这类标识符不译。
   */
  var I18N = {
    en: {
      tagline: 'openai <-> anthropic protocol gateway · deepseek via opencode zen',
      overview: 'Overview', pipeline: 'Pipeline', models: 'Models',
      clients: 'Clients', devices: 'Devices', requests: 'Requests',
      keypool: 'Key pool', recentFirst: 'most recent first',
      kInflight: 'in flight', kState: 'state', kPicked: 'picked', kLastUse: 'last use',
      kFails: 'fails', kRecover: 'recovers in', kTotal: 'lifetime', kReason: 'reason',
      kHealthy: 'healthy', kDisabled: 'disabled', kNever: 'never',
      carrying: 'carrying load', ofKeys: 'of', poolIdle: 'no in-flight requests',
      histSince: 'lifetime since', noHist: 'no persisted history',
      unattributed: 'rejected before reaching a key',
      recentEvents: 'recent key events', noKeyEvents: 'no key state changes recorded',
      evDisabled: 'disabled', evRecovered: 'recovered', reqShort: 'req',
      authErr: 'invalid credential', rateErr: 'rate limited',
      quotaErr: 'quota exhausted', transientErr: 'repeated transient errors',
      polHd: 'cooldown policy · why a key recovers when it does',
      polUpstream: 'from upstream',
      polFallback: 'fallback when unparsable',
      polFirstHit: 'disabled on first occurrence',
      polAfterN: 'disabled after {n} in a row',
      polBackoff: 'then doubles each time, up to 16x, +/-20% jitter',
      polQuotaNote: 'upstream reset time + 60s margin',
      polAuthNote: '12x base cooldown',
      polRateNote: 'kept short on purpose: 429 is account-level, so cycling keys does not help',
      polCfg: 'base cooldown {base} · fail threshold {n} · routing: least in-flight first',
      kRequests: 'requests', kLatency: 'latency', kTokens: 'tokens', kDevices: 'devices',
      hTime: 'time', hStatus: 'status', hRequest: 'request', hMs: 'ms', hTokens: 'tokens', hClient: 'client',
      noReq: 'no requests yet', noData: 'no data', noDev: 'no devices',
      ok: 'ok', fail: 'fail', stream: 'stream', last: 'last',
      inTok: 'in', outTok: 'out', thinkTok: 'think',
      nClients: 'clients', nModels: 'models',
      pause: 'pause', resume: 'resume', live: 'live',
      pool: 'pool', up: 'up', inWindow: 'in window',
      idle: 'idle', active: 'active',
      pClient: 'client', pIngress: 'ingress', pConvert: 'convert', pUpstream: 'upstream', pEgress: 'egress',
      passthrough: 'passthrough', sub: 'subscription', payg: 'pay-as-you-go',
      sse: 'sse stream', single: 'single body',
      fallback: 'fallback', upModels: 'upstream models', injection: 'injection',
      poll: 'poll 2s · in-memory', pollSql: 'poll 2s · window in-memory, totals in sqlite',
      mobile: 'mobile', langBtn: '中文'
    },
    zh: {
      tagline: 'OpenAI 与 Anthropic 协议转换网关 · 经 opencode zen 使用 DeepSeek',
      overview: '总览', pipeline: '数据流动', models: '模型分布',
      clients: '客户端', devices: '设备', requests: '请求明细',
      keypool: 'Key 池', recentFirst: '最新在前',
      kInflight: '在飞请求', kState: '状态', kPicked: '本次启动', kLastUse: '最近使用',
      kFails: '连续失败', kRecover: '剩余冷却', kTotal: '累计', kReason: '原因',
      kHealthy: '可用', kDisabled: '已禁用', kNever: '未用过',
      carrying: '个号在扛并发', ofKeys: '/', poolIdle: '当前无在飞请求',
      histSince: '累计自', noHist: '未启用历史持久化',
      unattributed: '条未到达上游（格式/鉴权错误）',
      recentEvents: '最近状态变更', noKeyEvents: '暂无状态变更记录',
      evDisabled: '禁用', evRecovered: '恢复', reqShort: '请求',
      authErr: '凭据无效', rateErr: '限流',
      quotaErr: '额度耗尽', transientErr: '连续瞬时错误',
      polHd: '冷却策略 · 恢复时刻是怎么算出来的',
      polUpstream: '按上游给的时间',
      polFallback: '解析不出时兜底',
      polFirstHit: '首次出现即禁用',
      polAfterN: '连续 {n} 次后禁用',
      polBackoff: '之后每次翻倍，最多 16 倍，带 ±20% 抖动',
      polQuotaNote: '上游重置时间 + 60 秒余量',
      polAuthNote: '基础冷却的 12 倍',
      polRateNote: '刻意很短：429 是账号级状态，换 key 也解决不了',
      polCfg: '基础冷却 {base} · 失败阈值 {n} · 选路：优先挑在飞最少的 key',
      kRequests: '请求总数', kLatency: '响应耗时', kTokens: 'Token 用量', kDevices: '活跃设备',
      hTime: '时间', hStatus: '状态', hRequest: '请求', hMs: '毫秒', hTokens: 'Token', hClient: '客户端',
      noReq: '暂无请求', noData: '暂无数据', noDev: '暂无设备',
      ok: '成功', fail: '失败', stream: '流式', last: '最近',
      inTok: '入', outTok: '出', thinkTok: '思考',
      nClients: '种客户端', nModels: '个模型',
      pause: '暂停', resume: '继续', live: '实时',
      pool: 'Key 池', up: '运行', inWindow: '在窗口内',
      idle: '空闲', active: '进行中',
      pClient: '客户端', pIngress: '入口协议', pConvert: '协议转换', pUpstream: '上游', pEgress: '回传',
      passthrough: '直通', sub: '订阅端点', payg: '按量付费',
      sse: 'SSE 流式', single: '整包返回',
      fallback: '兜底模型', upModels: '个可用模型', injection: '注入检测',
      poll: '每 2 秒轮询 · 内存存储', pollSql: '每 2 秒轮询 · 窗口在内存，累计在 SQLite',
      mobile: '移动端',
      langBtn: 'EN'
    }
  };
  var lang = (function () {
    try { var v = localStorage.getItem('fc-lang'); if (v === 'zh' || v === 'en') return v; } catch (e) {}
    return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  })();
  var T = function (k) { return (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k; };

  /** 把所有 data-i18n 节点刷成当前语言。 */
  function applyLang() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = T(nodes[i].getAttribute('data-i18n'));
    }
    document.getElementById('t-tagline').textContent = T('tagline');
    document.getElementById('btn-lang').textContent = T('langBtn');
    document.getElementById('btn').textContent = paused ? T('resume') : T('pause');
  }
  var hist = { req: [], lat: [], tok: [], dev: [] };
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var fmt = function (n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  };
  /* 耗时专用。fmt() 是计数用的（k/M/B），拿它格式化毫秒会输出
     「2.1kms」这种没人看得懂的东西 —— 秒该用秒表示。 */
  var ms = function (n) {
    n = Number(n) || 0;
    if (n < 1000) return Math.round(n) + 'ms';
    // 先算总秒数再分流，避免 59999 四舍五入成 "60.0s" 这种该进位没进位的写法。
    var total = Math.round(n / 1000);
    if (total < 60) return (n / 1000).toFixed(n < 10000 ? 2 : 1) + 's';
    var m = Math.floor(total / 60);
    var s = total - m * 60;
    return m + 'm' + (s ? ' ' + s + 's' : '');
  };
  var size = function (n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + 'M';
    if (n >= 1024) return (n / 1024).toFixed(1) + 'K';
    return n + 'B';
  };
  var upt = function (ms) {
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d) return d + 'd' + (h % 24) + 'h';
    if (h) return h + 'h' + (m % 60) + 'm';
    if (m) return m + 'm' + (s % 60) + 's';
    return s + 's';
  };
  var hhmmss = function (ts) {
    var d = new Date(ts), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };

  /** 阶梯折线 sparkline：无渐变无填充，只有 1px 线，贴合终端审美。 */
  function spark(el, data) {
    var w = el.clientWidth || 200, h = 26;
    el.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    if (data.length < 2) { el.innerHTML = ''; return; }
    var max = Math.max.apply(null, data), min = Math.min.apply(null, data);
    var span = (max - min) || 1, step = w / (data.length - 1);
    var d = data.map(function (v, i) {
      return (i ? 'L' : 'M') + (i * step).toFixed(1) + ',' + (h - 2 - ((v - min) / span) * (h - 5)).toFixed(1);
    }).join('');
    el.innerHTML = '<path d="' + d + '" fill="none" stroke="' + '#9dbefe' + '" stroke-width="1" opacity=".7"/>';
  }
  function push(k, v) { var a = hist[k]; a.push(v); if (a.length > 48) a.shift(); }
  function redraw() {
    spark($('sp-req'), hist.req); spark($('sp-lat'), hist.lat);
    spark($('sp-tok'), hist.tok); spark($('sp-dev'), hist.dev);
  }

  function pipeline(e) {
    var on = e && (Date.now() - e.at) < 4000;
    var steps = [
      [T('pClient'), e ? e.device.client : '—'],
      [T('pIngress'), e ? e.protocol : '—'],
      [T('pConvert'), e ? (e.protocol === 'anthropic' ? 'anthropic -> openai' : T('passthrough')) : '—'],
      [T('pUpstream'), e ? (e.endpoint === 'payg' ? T('payg') : e.endpoint === 'subscription' ? T('sub') : '—') : '—'],
      [T('pEgress'), e ? (e.stream ? T('sse') : T('single')) : '—']
    ];
    $('pipe').innerHTML = steps.map(function (s) {
      return '<div class="st' + (on ? ' on' : '') + '"><div class="n">' + s[0] + '</div><div class="b">' + esc(s[1]) + '</div></div>';
    }).join('');
    $('n-pipe').textContent = e
      ? (e.model || '-') + ' -> ' + (e.upstreamModel || '-') + ' · ' + e.durationMs + 'ms · ' +
        fmt(e.inputTokens) + '/' + fmt(e.outputTokens) + ' tok' + (on ? ' · ' + T('active') : '')
      : T('idle');
  }

  function bars(el, items, name, count) {
    if (!items.length) { el.innerHTML = '<div class="w" style="padding:7px 0">' + T('noData') + '</div>'; return; }
    var max = Math.max.apply(null, items.map(count));
    el.innerHTML = items.map(function (it) {
      return '<div class="bar"><span class="n">' + esc(name(it)) + '</span><span class="c">' + fmt(count(it)) + '</span>' +
        '<span class="t"><span class="f" style="width:' + (max ? count(it) / max * 100 : 0).toFixed(1) + '%"></span></span></div>';
    }).join('');
  }

  function devices(ev) {
    var seen = {}, out = [];
    for (var i = 0; i < ev.length && out.length < 4; i++) {
      var k = ev[i].device.ip + '|' + ev[i].device.ua;
      if (seen[k]) continue; seen[k] = 1; out.push(ev[i]);
    }
    if (!out.length) { $('devs').innerHTML = '<div class="w" style="padding:7px 0">' + T('noDev') + '</div>'; return; }
    $('devs').innerHTML = out.map(function (e) {
      var d = e.device;
      return '<div class="dev"><div class="hd">' + esc(d.client) + ' <em>' + esc(d.os) + (d.mobile ? ' · ' + T('mobile') : '') + '</em></div>' +
        '<dl><dt>ip</dt><dd>' + esc(d.ip || '-') + (d.viaProxy ? ' <span class="s-acc">[cdn]</span>' : '') + '</dd>' +
        (d.forwardedFor ? '<dt>xff</dt><dd>' + esc(d.forwardedFor) + '</dd>' : '') +
        (d.language ? '<dt>lang</dt><dd>' + esc(d.language) + '</dd>' : '') +
        '<dt>ua</dt><dd>' + esc(d.ua || '-') + '</dd></dl></div>';
    }).join('');
  }

  /** 失败类型 -> 词条。原始值是 keypool 的 UpstreamFailureKind。 */
  var KIND_KEY = {
    'auth': 'authErr', 'rate-limit': 'rateErr',
    'quota-exhausted': 'quotaErr', 'transient': 'transientErr'
  };
  var kindText = function (k) { return k ? T(KIND_KEY[k] || k) + ' (' + k + ')' : '—'; };

  /** 冷却倒计时用的 h/m/s。upt() 是给运行时长的（会省掉秒），倒计时要看到秒。 */
  var hms = function (ms) {
    var s = Math.floor(Math.max(0, ms) / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    if (h) return h + 'h' + p(m) + 'm' + p(s % 60) + 's';
    if (m) return m + 'm' + p(s % 60) + 's';
    return (s % 60) + 's';
  };

  /**
   * Key 池明细。回答的是「当前几个号在扛并发分流、每个号什么状态」——
   * 这些数据本来就在 KeyPool 的内存里，此前只是没暴露出来，
   * 想知道得去 journalctl 翻日志再照着源码算冷却时间。
   *
   * key 一律只显示指纹（****XXXX，末 4 位），原文不出现在任何响应里。
   * 注意：这段注释在 String.raw 模板里，不能出现反引号 —— 会提前闭合模板。
   */
  function keypool(pool) {
    var keys = (pool && pool.keys) || [];
    // 别叫 hist —— 外层 hist 是 sparkline 的历史缓冲。
    // 逐字段兜底而不是只判 lifetime 真假：这个函数在 apply() 里跑，apply() 在
    // tick() 的 .then() 里，抛异常会被 .catch() 接走 —— 后果是整个 apply()
    // 半途中止、面板所有小节永久停在上一轮的值，而且错误文案落在 #h-live
    // （和真实上游故障同一个位置），会把渲染 bug 读成上游挂了。
    // 服务端正常不会给出半截结构，但滚动部署/回滚期间新旧不匹配就会。
    var lifetime = (pool && pool.history) || null;
    var byKey = (lifetime && lifetime.byKey) || [];
    var byFp = {};
    byKey.forEach(function (r) { byFp[r.fingerprint] = r; });

    var busy = 0, inflight = 0, maxIn = 0;
    keys.forEach(function (k) {
      if (k.inFlight > 0) busy++;
      inflight += k.inFlight;
      if (k.inFlight > maxIn) maxIn = k.inFlight;
    });
    // 进度条的刻度。原来是 max(1, 当前最大并发) —— 纯相对刻度，于是「最忙的
    // key」永远是满格：单个 key 上只有 1 条在飞也画成 100%，看着像打满了。
    // 低并发是这个池子的常态（线上 2-3 个 key），误导正好落在最常见的情形上。
    // 改成至少 4 格的固定底：1 条在飞画 25%，要真的压到 4 条以上才接近满格，
    // 超过 4 条时刻度跟着涨，仍能看出相对负载。
    var barScale = Math.max(4, maxIn);
    // 「几个号在扛并发分流」—— 用户明确要的那个数，直接摆在小节标题右边。
    // en: "2 carrying load of 3 · 7 req" / zh: "2 个号在扛并发 / 3 · 7 请求"
    $('n-pool').textContent = inflight
      ? busy + ' ' + T('carrying') + ' ' + T('ofKeys') + ' ' + keys.length + ' · ' + inflight + ' ' + T('reqShort')
      : T('poolIdle');

    if (!keys.length) {
      $('keys').innerHTML = '<div class="kc"><div class="w">' + T('noData') + '</div></div>';
      $('kevs').innerHTML = '';
      return;
    }

    var now = Date.now();
    $('keys').innerHTML = keys.map(function (k) {
      var lt = byFp[k.fingerprint];
      // 倒计时基于**客户端**时刻推进：recoverInMs 是服务端给的相对量，
      // 用它加本地 now 避免两端时钟不一致造成的负数/跳变。
      var rows = [
        ['kInflight', '<b>' + k.inFlight + '</b>'],
        ['kState', k.healthy
          ? '<span class="s-ok">' + T('kHealthy') + '</span>'
          : '<span class="s-bad">' + T('kDisabled') + '</span>']
      ];
      if (!k.healthy) {
        rows.push(['kReason', '<span class="s-warn">' + esc(kindText(k.disabledReason)) + '</span>']);
        rows.push(['kRecover', '<b data-rc="' + (now + k.recoverInMs) + '">' + hms(k.recoverInMs) + '</b>']);
      }
      rows.push(['kFails', String(k.failCount)]);
      rows.push(['kPicked', '<b>' + fmt(k.totalAcquired) + '</b>']);
      rows.push(['kLastUse', k.lastUsedAt ? hhmmss(k.lastUsedAt) : '<span class="w">' + T('kNever') + '</span>']);
      if (lt) {  // 跨重启累计（来自 sqlite）；db 关掉时这行不出现
        rows.push(['kTotal', '<b>' + fmt(lt.requests) + '</b> ' + T('reqShort') + ' · <b>' + fmt(lt.tokens) + '</b> tok' +
          (lt.failed ? ' · <span class="s-bad">' + fmt(lt.failed) + ' ' + T('fail') + '</span>' : '')]);
      }
      // 在飞请求的字形化显示：一个方块一条请求，扫一眼就知道谁在扛。
      var glyph = k.inFlight > 0
        ? new Array(Math.min(k.inFlight, 24) + 1).join('#') + (k.inFlight > 24 ? '+' : '')
        : '<em>idle</em>';
      return '<div class="kc' + (k.healthy ? '' : ' off') + '">' +
        '<div class="hd"><span class="fp">' + esc(k.fingerprint) + '</span>' +
        '<span class="badge ' + (k.healthy ? 's-ok' : 's-bad') + '">' +
        (k.healthy ? '[ok]' : '[!]') + '</span></div>' +
        '<div class="glyph">' + glyph + '</div>' +
        '<dl>' + rows.map(function (r) {
          return '<dt>' + T(r[0]) + '</dt><dd>' + r[1] + '</dd>';
        }).join('') + '</dl>' +
        '<span class="t"><span class="f" style="width:' + (k.inFlight / barScale * 100).toFixed(1) + '%"></span></span>' +
        '</div>';
    }).join('');

    // 放在 kevs 的早退分支之前 —— 策略与有没有历史数据无关，任何情况下都该显示。
    policy(pool.policy);

    if (!lifetime) {
      $('kevs').innerHTML = '<div class="kev"><span class="w" style="grid-column:1/-1">' + T('noHist') +
        (pool.historyDisabledReason ? ' · ' + esc(pool.historyDisabledReason) : '') + '</span></div>';
      return;
    }
    var evs = lifetime.recentKeyEvents || [];
    if (!evs.length) {
      $('kevs').innerHTML = '<div class="kev"><span class="w" style="grid-column:1/-1">' + T('noKeyEvents') + '</span></div>';
      return;
    }
    /* 未归属请求（还没选到 key 就被拒的 400/401/池空 503）单独说一句。
       它们不在逐 key 卡片里，不说明的话 byKey 求和会对不上总数。 */
    var unattr = Number(lifetime.unattributedRequests) || 0;
    var head = '<div class="kev"><span class="w" style="grid-column:1/-1">' +
      T('recentEvents') + ' · ' + T('histSince') + ' ' +
      (lifetime.since ? esc(new Date(lifetime.since).toLocaleString()) : '—') +
      ' · ' + fmt(lifetime.totalRequests) + ' ' + T('reqShort') +
      (unattr ? ' · ' + fmt(unattr) + ' ' + T('unattributed') : '') +
      '</span></div>';
    $('kevs').innerHTML = head + evs.map(function (e) {
      var dis = e.type === 'disabled';
      return '<div class="kev">' +
        '<span class="w">' + hhmmss(e.at) + '</span>' +
        '<span class="' + (dis ? 's-bad' : 's-ok') + '">' + T(dis ? 'evDisabled' : 'evRecovered') + '</span>' +
        '<span class="cut">' + esc(e.fingerprint) + (e.kind ? ' · ' + esc(kindText(e.kind)) : '') + '</span>' +
        '<span class="w kv-h">' + (e.cooldownMs ? hms(e.cooldownMs) : '—') + '</span>' +
        '</div>';
    }).join('');
  }

  /**
   * 冷却策略。回答的是「为什么这个 key 的恢复时刻是这个数」——
   * 面板此前只给结果（剩余 3h16m），规则得回去读源码。
   *
   * 每条都来自服务端按真实配置算出的 policy 对象，不在前端写死时长，
   * 所以改了 COOLDOWN_MS 这里会跟着变，不会说谎。
   */
  function policy(p) {
    if (!p || !p.rules) { $('kpol').innerHTML = ''; return; }
    // 每种失败类型的补充说明（为什么是这个时长）。
    var NOTE = {
      'quota-exhausted': 'polQuotaNote', 'auth': 'polAuthNote', 'rate-limit': 'polRateNote'
    };
    var rows = p.rules.map(function (r) {
      var dur;
      if (r.ms == null) {
        dur = T('polUpstream');
      } else {
        dur = hms(r.ms);
      }
      var when = r.countsToThreshold
        ? T('polAfterN').replace('{n}', String(p.failThreshold))
        : T('polFirstHit');
      var note = r.kind === 'transient'
        ? T('polBackoff')
        : (NOTE[r.kind] ? T(NOTE[r.kind]) : '');
      if (r.ms == null && r.fallbackMs != null) {
        note = note + ' · ' + T('polFallback') + ' ' + hms(r.fallbackMs);
      }
      return '<div class="r">' +
        '<span class="k">' + esc(kindText(r.kind)) + '</span>' +
        '<span class="v">' + esc(dur) + '</span>' +
        '<span class="d">' + esc(when) + (note ? ' · ' + esc(note) : '') + '</span>' +
        '</div>';
    }).join('');
    $('kpol').innerHTML =
      '<div class="hd">' + T('polHd') + '</div>' + rows +
      '<div class="cfg">' +
        esc(T('polCfg').replace('{base}', hms(p.cooldownMs)).replace('{n}', String(p.failThreshold))) +
      '</div>';
  }

  /**
   * 每秒推进冷却倒计时，不必等下一次 2s 轮询（读秒卡住会显得像挂了）。
   *
   * data-rc 是渲染时算好的**客户端**恢复时刻（now + 服务端给的 recoverInMs），
   * 所以这里只做减法，不受两端时钟差影响。
   *
   * 归零后钳到 0 并摘掉 data-rc：不再每秒重算一个越来越负的值，
   * 也让「已到期但服务端还没 reap」这一小段显示成 0s 而不是负数。
   * 真正的状态翻转由下一次轮询带来。
   */
  function tickCountdown() {
    var now = Date.now();
    var nodes = document.querySelectorAll('[data-rc]');
    for (var i = 0; i < nodes.length; i++) {
      var left = Number(nodes[i].getAttribute('data-rc')) - now;
      if (left <= 0) {
        nodes[i].textContent = hms(0);
        nodes[i].removeAttribute('data-rc');
      } else {
        nodes[i].textContent = hms(left);
      }
    }
  }

  /**
   * 请求日志：每条两行。
   * 第一行是扫读用的固定列（时间/状态/请求/耗时/token/客户端），
   * 第二行是细节（上游模型、端点、思考 token、体积、系统、IP、key），
   * 用 flex-wrap 自动换行 —— 不会像 15 列宽表那样把字挤在一起。
   */
  function rows(ev) {
    if (!ev.length) return;
    $('rows').innerHTML = ev.map(function (e) {
      var d = e.device, good = e.status >= 200 && e.status < 400;
      var protoCls = e.protocol === 'anthropic' ? 's-acc' : e.protocol === 'openai' ? 's-warn' : 'w';
      var detail = [
        e.upstreamModel && e.upstreamModel !== e.model ? '<span>upstream <em>' + esc(e.upstreamModel) + '</em></span>' : '',
        e.endpoint !== '-' ? '<span>' + (e.endpoint === 'payg' ? 'pay-as-you-go' : 'subscription') + '</span>' : '',
        e.thinkingTokens ? '<span>think <em>' + fmt(e.thinkingTokens) + '</em></span>' : '',
        '<span>' + size(e.requestBytes) + '</span>',
        d.os && d.os !== 'unknown' ? '<span>' + esc(d.os) + (d.mobile ? ' mobile' : '') + '</span>' : '',
        d.ip ? '<span>' + esc(d.ip) + (d.viaProxy ? ' [cdn]' : '') + '</span>' : '',
        e.keyFingerprint ? '<span>key <em>' + esc(e.keyFingerprint) + '</em></span>' : '',
        e.error ? '<span class="s-bad">' + esc(e.error) + '</span>' : ''
      ].filter(Boolean).join('');

      return '<div class="ent' + (e.id > topId ? ' new' : '') + '">' +
        '<div class="r1">' +
          '<span class="w">' + hhmmss(e.at) + '</span>' +
          '<span class="' + (good ? 's-ok' : 's-bad') + '">' + e.status + ' <span class="' + protoCls + '">' + esc(e.protocol.slice(0, 4)) + '</span></span>' +
          '<span class="cut">' + esc(e.path) + (e.stream ? ' <span class="w">[sse]</span>' : '') +
            '<span class="w h-model"> · ' + esc(e.model || '-') + '</span></span>' +
          '<span class="ta-r h-ms">' + e.durationMs + '</span>' +
          '<span class="ta-r">' + fmt(e.inputTokens) + '/' + fmt(e.outputTokens) + '</span>' +
          '<span class="cut w">' + esc(d.client) + '</span>' +
        '</div>' +
        (detail ? '<div class="r2">' + detail + '</div>' : '') +
      '</div>';
    }).join('');
    topId = ev[0].id;
  }

  function apply(m) {
    var s = m.summary, ev = m.events;
    var b = function (v, cls) { return '<b' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</b>'; };

    $('m-total').textContent = fmt(m.totalRequests);
    $('d-req').innerHTML =
      b(fmt(s.ok), 's-ok') + ' ' + T('ok') + ' · ' +
      b(fmt(s.failed), 's-bad') + ' ' + T('fail') + ' · ' +
      b(fmt(s.streaming)) + ' ' + T('stream');

    $('m-avg').innerHTML = ms(s.avgDurationMs);
    $('d-lat').innerHTML =
      'p95 ' + b(ms(s.p95DurationMs)) + ' · ' +
      T('last') + ' ' + b(ms(ev.length ? ev[0].durationMs : 0));

    $('m-tok').textContent = fmt(s.inputTokens + s.outputTokens);
    $('d-tok').innerHTML =
      T('inTok') + ' ' + b(fmt(s.inputTokens)) + ' · ' +
      T('outTok') + ' ' + b(fmt(s.outputTokens)) + ' · ' +
      T('thinkTok') + ' ' + b(fmt(s.thinkingTokens));

    var dv = {}; ev.forEach(function (e) { dv[e.device.ip + '|' + e.device.ua] = 1; });
    var nDev = Object.keys(dv).length;
    $('m-dev').textContent = fmt(nDev);
    $('d-dev').innerHTML =
      b(s.byClient.length) + ' ' + T('nClients') + ' · ' + b(s.byModel.length) + ' ' + T('nModels');

    var p = $('h-pool');
    var busyNow = (m.pool.keys || []).filter(function (k) { return k.inFlight > 0; }).length;
    p.textContent = T('pool') + ' ' + m.pool.healthy + '/' + m.pool.size + (busyNow ? ' [' + busyNow + ']' : '');
    p.className = 'stat-inline ' + (m.pool.size === 0 || m.pool.healthy === 0 ? 'bad' : m.pool.healthy < m.pool.size ? '' : 'ok');
    $('h-up').textContent = T('up') + ' ' + upt(m.uptimeMs);
    $('n-window').textContent = ev.length + ' / 200 ' + T('inWindow');
    $('foot').innerHTML = [
      'subscription <em style="font-style:normal;color:var(--fg-weak)">' + esc(m.config.subscriptionBaseUrl) + '</em>',
      'pay-as-you-go <em style="font-style:normal;color:var(--fg-weak)">' + esc(m.config.paygBaseUrl) + '</em>',
      T('fallback') + ' <em style="font-style:normal;color:var(--fg-weak)">' + esc(m.config.fallbackModel) + '</em>',
      m.config.upstreamModels.length + ' ' + T('upModels'),
      T('injection') + ' ' + esc(m.config.injectionMode),
      T(m.pool.history ? 'pollSql' : 'poll')
    ].map(function (s) { return '<span>' + s + '</span>'; }).join('');

    push('req', m.totalRequests); push('lat', s.avgDurationMs);
    push('tok', s.inputTokens + s.outputTokens); push('dev', nDev);
    redraw();
    pipeline(ev[0]);
    keypool(m.pool);
    bars($('b-model'), s.byModel, function (i) { return i.model; }, function (i) { return i.count; });
    bars($('b-client'), s.byClient, function (i) { return i.client; }, function (i) { return i.count; });
    devices(ev);
    rows(ev);
  }

  function tick() {
    if (paused) return;
    fetch('/__metrics', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))); })
      .then(function (m) { $('h-live').className = 'stat-inline ok'; $('h-live').textContent = '[*] ' + T('live'); apply(m); })
      .catch(function (e) { $('h-live').className = 'stat-inline bad'; $('h-live').textContent = '[!] ' + e.message; });
  }

  $('btn').addEventListener('click', function () {
    paused = !paused;
    this.textContent = paused ? T('resume') : T('pause');
    if (!paused) tick();
  });

  $('btn-lang').addEventListener('click', function () {
    lang = lang === 'zh' ? 'en' : 'zh';
    try { localStorage.setItem('fc-lang', lang); } catch (e) {}
    applyLang();
    // 立刻拉一次，让动态区（流水线/空态/明细）也跟着换语言。
    if (!paused) tick();
  });

  applyLang();
  tick(); setInterval(tick, 2000);
  setInterval(tickCountdown, 1000);  // 冷却读秒；与轮询解耦，暂停时也照走
  // 标签页切回前台时立刻补一次：后台标签页里定时器会被浏览器节流甚至完全停摆，
  // 回来时读秒文字可能已经陈旧（对着一个早已过期的 data-rc 显示几秒前的值）。
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    tickCountdown();
    if (!paused) tick();
  });
  window.addEventListener('resize', redraw);
})();
</script>
</body>
</html>`;
