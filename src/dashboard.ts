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
  .brand { color: var(--fg); font-weight: 500; }
  .brand span { color: var(--fg-weaker); font-weight: 400; }
  .spacer { flex: 1; }
  .stat-inline { color: var(--fg-weak); font-size: 12px; }
  .stat-inline b { color: var(--fg-base); font-weight: 400; }
  .stat-inline.ok b { color: var(--ok); }
  .stat-inline.bad b { color: var(--bad); }
  button {
    font: inherit; cursor: pointer; color: var(--fg-weak);
    background: transparent; border: 1px solid var(--line-weak);
    border-radius: var(--radius); padding: 3px 9px; font-size: 12px;
  }
  button:hover { color: var(--fg); border-color: var(--line-hover); }

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

  /* ── ascii banner ───────────────────────────────── */
  /* ASCII banner：41 字符宽，11px 等宽约 270px。max-width:100% + overflow
     保证窄屏也不会把文档撑出横向滚动条。 */
  .ascii {
    color: var(--fg-weaker); font-size: 11px; line-height: 1.05;
    white-space: pre; letter-spacing: 0;
    margin-bottom: 16px; max-width: 100%; overflow-x: auto;
  }
  .ascii b { color: var(--accent); font-weight: 400; }
  @media (max-width: 560px) { .ascii { font-size: 8px; } }

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
  <button id="btn">pause</button>
</header>

<main>
  <div class="ascii" aria-hidden="true"><b>█▀▀▀  █▀▀█  ▀█▀▀  █▀▀▀  █__█  █▀▀█  █__█</b>
<b>█_^█  █^^█  _█__  █^^^  █^^█  █^^█  ▀██▀</b>
<b>▀▀▀▀  ▀~~▀  _▀__  ▀▀▀▀  ▀▀▀▀  ▀~~▀  _▀▀_</b>
openai &lt;-&gt; anthropic protocol gateway · deepseek via opencode zen</div>

  <section>
    <div class="sec-hd">
      <h2>Overview</h2><span class="fig">Fig 1.</span>
      <span class="note" id="n-window">window 200</span>
    </div>
    <div class="grid cols-4">
      <div class="cell">
        <div class="k">requests</div>
        <div class="v" id="m-total">0</div>
        <div class="d"><b class="s-ok" id="m-ok">0</b> ok · <b class="s-bad" id="m-fail">0</b> fail · <b id="m-stream">0</b> stream</div>
        <svg class="spark" id="sp-req" preserveAspectRatio="none"></svg>
      </div>
      <div class="cell">
        <div class="k">latency</div>
        <div class="v" id="m-avg">0<i>ms</i></div>
        <div class="d">p95 <b id="m-p95">0</b>ms · last <b id="m-last">0</b>ms</div>
        <svg class="spark" id="sp-lat" preserveAspectRatio="none"></svg>
      </div>
      <div class="cell">
        <div class="k">tokens</div>
        <div class="v" id="m-tok">0</div>
        <div class="d">in <b id="m-in">0</b> · out <b id="m-out">0</b> · think <b id="m-think">0</b></div>
        <svg class="spark" id="sp-tok" preserveAspectRatio="none"></svg>
      </div>
      <div class="cell">
        <div class="k">devices</div>
        <div class="v" id="m-dev">0</div>
        <div class="d"><b id="m-clients">0</b> clients · <b id="m-models">0</b> models</div>
        <svg class="spark" id="sp-dev" preserveAspectRatio="none"></svg>
      </div>
    </div>
  </section>

  <section>
    <div class="sec-hd">
      <h2>Pipeline</h2><span class="fig">Fig 2.</span>
      <span class="note" id="n-pipe">idle</span>
    </div>
    <div class="pipe" id="pipe"></div>
  </section>

  <section class="grid cols-3" style="background:transparent;border:0;gap:28px">
    <div style="grid-column:span 1">
      <div class="sec-hd"><h2>Models</h2><span class="fig">Fig 3.</span></div>
      <div class="bars" id="b-model"></div>
    </div>
    <div style="grid-column:span 1">
      <div class="sec-hd"><h2>Clients</h2><span class="fig">Fig 4.</span></div>
      <div class="bars" id="b-client"></div>
    </div>
    <div style="grid-column:span 1">
      <div class="sec-hd"><h2>Devices</h2><span class="fig">Fig 5.</span></div>
      <div class="devs" id="devs"></div>
    </div>
  </section>

  <section>
    <div class="sec-hd">
      <h2>Requests</h2><span class="fig">Fig 6.</span>
      <span class="note">most recent first</span>
    </div>
    <div class="log">
      <div class="log-hd">
        <span>time</span><span>status</span><span>request</span>
        <span class="ta-r">ms</span><span class="ta-r">tokens</span><span>client</span>
      </div>
      <div id="rows"><div class="empty">no requests yet</div></div>
    </div>
  </section>

  <footer id="foot"><span>—</span></footer>
</main>

<script>
(function () {
  var paused = false, topId = 0;
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
      ['client', e ? e.device.client : '—'],
      ['ingress', e ? e.protocol : '—'],
      ['convert', e ? (e.protocol === 'anthropic' ? 'anthropic -> openai' : 'passthrough') : '—'],
      ['upstream', e ? (e.endpoint === 'payg' ? 'pay-as-you-go' : e.endpoint === 'subscription' ? 'subscription' : '—') : '—'],
      ['egress', e ? (e.stream ? 'sse stream' : 'single body') : '—']
    ];
    $('pipe').innerHTML = steps.map(function (s) {
      return '<div class="st' + (on ? ' on' : '') + '"><div class="n">' + s[0] + '</div><div class="b">' + esc(s[1]) + '</div></div>';
    }).join('');
    $('n-pipe').textContent = e
      ? (e.model || '-') + ' -> ' + (e.upstreamModel || '-') + ' · ' + e.durationMs + 'ms · ' +
        fmt(e.inputTokens) + '/' + fmt(e.outputTokens) + ' tok' + (on ? ' · active' : '')
      : 'idle';
  }

  function bars(el, items, name, count) {
    if (!items.length) { el.innerHTML = '<div class="w" style="padding:7px 0">no data</div>'; return; }
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
    if (!out.length) { $('devs').innerHTML = '<div class="w" style="padding:7px 0">no devices</div>'; return; }
    $('devs').innerHTML = out.map(function (e) {
      var d = e.device;
      return '<div class="dev"><div class="hd">' + esc(d.client) + ' <em>' + esc(d.os) + (d.mobile ? ' · mobile' : '') + '</em></div>' +
        '<dl><dt>ip</dt><dd>' + esc(d.ip || '-') + (d.viaProxy ? ' <span class="s-acc">[cdn]</span>' : '') + '</dd>' +
        (d.forwardedFor ? '<dt>xff</dt><dd>' + esc(d.forwardedFor) + '</dd>' : '') +
        (d.language ? '<dt>lang</dt><dd>' + esc(d.language) + '</dd>' : '') +
        '<dt>ua</dt><dd>' + esc(d.ua || '-') + '</dd></dl></div>';
    }).join('');
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
    $('m-total').textContent = fmt(m.totalRequests);
    $('m-ok').textContent = fmt(s.ok);
    $('m-fail').textContent = fmt(s.failed);
    $('m-stream').textContent = fmt(s.streaming);
    $('m-avg').innerHTML = fmt(s.avgDurationMs) + '<i>ms</i>';
    $('m-p95').textContent = fmt(s.p95DurationMs);
    $('m-last').textContent = ev.length ? ev[0].durationMs : 0;
    $('m-tok').textContent = fmt(s.inputTokens + s.outputTokens);
    $('m-in').textContent = fmt(s.inputTokens);
    $('m-out').textContent = fmt(s.outputTokens);
    $('m-think').textContent = fmt(s.thinkingTokens);

    var dv = {}; ev.forEach(function (e) { dv[e.device.ip + '|' + e.device.ua] = 1; });
    var nDev = Object.keys(dv).length;
    $('m-dev').textContent = fmt(nDev);
    $('m-clients').textContent = s.byClient.length;
    $('m-models').textContent = s.byModel.length;

    var p = $('h-pool');
    p.textContent = 'pool ' + m.pool.healthy + '/' + m.pool.size;
    p.className = 'stat-inline ' + (m.pool.size === 0 || m.pool.healthy === 0 ? 'bad' : m.pool.healthy < m.pool.size ? '' : 'ok');
    $('h-up').textContent = 'up ' + upt(m.uptimeMs);
    $('n-window').textContent = ev.length + ' / 200 in window';
    $('foot').innerHTML = [
      'subscription <em style="font-style:normal;color:var(--fg-weak)">' + esc(m.config.subscriptionBaseUrl) + '</em>',
      'pay-as-you-go <em style="font-style:normal;color:var(--fg-weak)">' + esc(m.config.paygBaseUrl) + '</em>',
      'fallback <em style="font-style:normal;color:var(--fg-weak)">' + esc(m.config.fallbackModel) + '</em>',
      m.config.upstreamModels.length + ' upstream models',
      'injection ' + esc(m.config.injectionMode),
      'poll 2s · in-memory'
    ].map(function (s) { return '<span>' + s + '</span>'; }).join('');

    push('req', m.totalRequests); push('lat', s.avgDurationMs);
    push('tok', s.inputTokens + s.outputTokens); push('dev', nDev);
    redraw();
    pipeline(ev[0]);
    bars($('b-model'), s.byModel, function (i) { return i.model; }, function (i) { return i.count; });
    bars($('b-client'), s.byClient, function (i) { return i.client; }, function (i) { return i.count; });
    devices(ev);
    rows(ev);
  }

  function tick() {
    if (paused) return;
    fetch('/__metrics', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))); })
      .then(function (m) { $('h-live').className = 'stat-inline ok'; $('h-live').textContent = '[*] live'; apply(m); })
      .catch(function (e) { $('h-live').className = 'stat-inline bad'; $('h-live').textContent = '[!] ' + e.message; });
  }

  $('btn').addEventListener('click', function () {
    paused = !paused;
    this.textContent = paused ? 'resume' : 'pause';
    if (!paused) tick();
  });
  tick(); setInterval(tick, 2000);
  window.addEventListener('resize', redraw);
})();
</script>
</body>
</html>`;
