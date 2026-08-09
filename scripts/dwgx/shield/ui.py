#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Embedded page assets moved verbatim from kiro_shield.py."""

UI_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>护盾异常观测</title>
<style>
:root{
  --bg:#0b0d10; --panel:#14181d; --panel2:#1a1f26; --line:#252c35;
  --fg:#e6edf3; --dim:#8b98a5; --dim2:#5c6773;
  --retry:#58a6ff; --cool:#3fb950; --swap:#d29922; --auth:#a371f7;
  --pass:#f85149; --network:#ff7b72;
}
*{box-sizing:border-box}
body{
  margin:0; background:var(--bg); color:var(--fg);
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
}
header{
  position:sticky; top:0; z-index:10; background:rgba(11,13,16,.92);
  backdrop-filter:blur(8px); border-bottom:1px solid var(--line);
  padding:14px 20px; display:flex; align-items:center; gap:16px; flex-wrap:wrap;
}
h1{margin:0; font-size:16px; font-weight:600; letter-spacing:.3px}
.sub{color:var(--dim); font-size:12px}
.spacer{flex:1}
.live{display:flex; align-items:center; gap:6px; font-size:12px; color:var(--dim)}
.dot{width:7px; height:7px; border-radius:50%; background:var(--cool);
     animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
main{padding:20px; max-width:1400px; margin:0 auto}

.cards{display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr));
       gap:12px; margin-bottom:22px}
.card{background:var(--panel); border:1px solid var(--line); border-radius:10px;
      padding:14px 16px; position:relative; overflow:hidden}
.card::before{content:""; position:absolute; left:0; top:0; bottom:0; width:3px;
              background:var(--bar,var(--dim2))}
.card h3{margin:0 0 2px; font-size:13px; font-weight:600; display:flex;
         align-items:center; gap:8px}
.card .n{font-size:26px; font-weight:600; letter-spacing:-.5px; margin:6px 0 2px}
.card .why{color:var(--dim); font-size:11.5px; line-height:1.5}
.card .how{color:var(--dim2); font-size:11px; margin-top:8px;
           padding-top:8px; border-top:1px dashed var(--line); line-height:1.5}
.chips{display:flex; gap:5px; flex-wrap:wrap; margin-top:8px}
.chip{font-size:10.5px; padding:2px 7px; border-radius:20px;
      background:var(--panel2); border:1px solid var(--line); color:var(--dim)}
.chip.bad{color:var(--pass); border-color:#40232a}
.chip.ok{color:var(--cool); border-color:#1e3a26}

.bar{display:flex; height:6px; border-radius:4px; overflow:hidden;
     background:var(--panel2); margin:14px 0 20px}
.bar i{display:block}

.toolbar{display:flex; gap:8px; align-items:center; margin-bottom:12px;
         flex-wrap:wrap}
select,button,input{
  background:var(--panel); color:var(--fg); border:1px solid var(--line);
  border-radius:7px; padding:6px 10px; font-size:12.5px; font-family:inherit;
}
button{cursor:pointer}
button:hover{background:var(--panel2)}
button.on{border-color:var(--retry); color:var(--retry)}
.count{color:var(--dim); font-size:12px; margin-left:auto}

table{width:100%; border-collapse:collapse; font-size:12.5px}
th{text-align:left; color:var(--dim); font-weight:500; font-size:11.5px;
   padding:8px 10px; border-bottom:1px solid var(--line); white-space:nowrap;
   text-transform:uppercase; letter-spacing:.4px}
td{padding:9px 10px; border-bottom:1px solid #1b2027; vertical-align:top}
tr.row:hover{background:var(--panel)}
tr.row{cursor:pointer}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
      font-size:11.5px}
.tag{display:inline-block; padding:2px 8px; border-radius:5px; font-size:11px;
     font-weight:600; white-space:nowrap}
.st{font-family:ui-monospace,monospace; font-weight:600}
.st4{color:var(--swap)} .st5{color:var(--network)} .st2{color:var(--cool)}
.out{font-size:11px; padding:2px 8px; border-radius:5px; white-space:nowrap}
.out-absorbed{background:#12261a; color:var(--cool)}
.out-passed{background:#2d1618; color:var(--pass)}
.out-gave_up{background:#2b2410; color:var(--swap)}
.out-client_gone{background:#1e1f26; color:var(--dim)}
.body{color:var(--dim); max-width:520px; overflow:hidden;
      text-overflow:ellipsis; white-space:nowrap}
tr.detail td{background:#0f1216; color:var(--dim); padding:0}
tr.detail pre{margin:0; padding:14px 18px; white-space:pre-wrap;
              word-break:break-all; font-size:11.5px; line-height:1.6;
              max-height:340px; overflow:auto; font-family:ui-monospace,monospace}
.kv{display:grid; grid-template-columns:96px 1fr; gap:4px 14px;
    padding:12px 18px 0; font-size:12px}
.kv b{color:var(--dim2); font-weight:500}
.empty{text-align:center; padding:60px 20px; color:var(--dim2)}
.foot{margin-top:24px; padding-top:16px; border-top:1px solid var(--line);
      color:var(--dim2); font-size:11.5px; line-height:1.7}
.foot code{background:var(--panel); padding:1px 5px; border-radius:4px;
           font-size:11px}
.cfgbox{border:1px solid #2a3344;border-radius:8px;margin:14px 0;background:#141a24}
.cfgbox summary{cursor:pointer;padding:10px 14px;font-size:13px;color:#9fb0c8;user-select:none}
.cfgbox summary:hover{color:#dce6f2}
.cfghint{padding:0 14px 10px;font-size:12px;color:#7c8ba1;line-height:1.7}
.cfghint b{color:#a8bad0}
.kinds{padding:0 14px 4px}
.kind{border:1px solid #232c3b;border-radius:6px;margin-bottom:8px;background:#0f141c}
.kind.off{opacity:.55}
.khead{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid #1c2431}
.kname{font-size:13px;color:#dce6f2;font-weight:600}
.kcnt{font-size:11px;color:#7c8ba1;background:#1a2130;padding:1px 7px;border-radius:9px}
.kbody{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0}
.kcell{padding:9px 12px;font-size:12px;line-height:1.65;border-right:1px solid #1c2431}
.kcell:last-child{border-right:none}
.kcell .t{font-size:11px;color:#5c6a80;margin-bottom:3px}
.kcell .v{color:#a8bad0;word-break:break-all}
.kcell code{background:#0a0e14;padding:1px 4px;border-radius:3px;color:#c4a86a;font-size:11px}
.kok{color:#6fbf73}
.kbad{color:#d97b7b}
.sw{position:relative;width:38px;height:20px;flex-shrink:0}
.sw input{opacity:0;width:0;height:0;position:absolute}
.sw i{position:absolute;inset:0;background:#2a3344;border-radius:20px;cursor:pointer;transition:.2s}
.sw i:before{content:"";position:absolute;width:14px;height:14px;left:3px;top:3px;
  background:#8b9bb4;border-radius:50%;transition:.2s}
.sw input:checked + i{background:#2d5a3d}
.sw input:checked + i:before{transform:translateX(18px);background:#6fbf73}
.ksec{display:flex;align-items:center;gap:6px;font-size:12px;color:#7c8ba1}
.ksec input{width:66px;padding:3px 6px;background:#0a0e14;border:1px solid #2a3344;
  border-radius:4px;color:#dce6f2;font-size:12px;font-family:inherit}
.ksec.dim{color:#4d5566;font-size:11px}
.swph{width:38px;height:20px;flex-shrink:0;position:relative}
.swph:before{content:"";position:absolute;left:16px;top:9px;width:6px;height:2px;
  background:#2a3344;border-radius:1px}
.ktag{font-size:10px;color:#7a6a3f;background:#1e1a10;border:1px solid #332c18;
  padding:1px 6px;border-radius:3px;font-family:ui-monospace,monospace}
/* HTTP 状态码：放在名称前面并用醒目色，因为看日志时第一眼找的就是它 */
.kcode{font-size:11px;font-weight:700;color:#e8a44c;background:#2a1f10;
  border:1px solid #4a3418;padding:2px 7px;border-radius:3px;
  font-family:ui-monospace,monospace;flex-shrink:0}
/* 事件表里的上游 reason 码 */
.rtag{display:inline-block;margin-left:6px;font-size:10px;color:#8a7a4f;
  background:#1a160e;border:1px solid #2e2716;padding:0 5px;border-radius:3px;
  font-family:ui-monospace,monospace;vertical-align:middle}
.cfggrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px;padding:0 14px 12px}
.cfgitem{display:flex;align-items:center;gap:8px;font-size:12px;color:#8b9bb4}
.cfgitem label{flex:1;min-width:0}
.cfgitem input{width:78px;padding:4px 6px;background:#0e131b;border:1px solid #2a3344;
  border-radius:4px;color:#dce6f2;font-size:12px;font-family:inherit}
.cfgitem input:focus{outline:none;border-color:#4a6fa5}
.cfgitem .rng{color:#5c6a80;font-size:11px;white-space:nowrap}
.cfgact{padding:0 14px 14px;display:flex;align-items:center;gap:8px}
</style>
</head>
<body>
<header>
  <h1>护盾异常观测</h1>
  <span class="sub" id="upstream"></span>
  <span class="spacer"></span>
  <span class="live"><span class="dot"></span><span id="tick">连接中</span></span>
</header>

<main>
  <div class="bar" id="bar"></div>
  <div class="cards" id="cards"></div>

  <details id="cfgbox" class="cfgbox" open>
    <summary>每类错误：原始报错 → 护盾怎么处理 → 客户端看到什么（可单独开关）</summary>
    <div class="cfghint">
      每一行是一类错误。<b>开关关掉</b>=不再拦这一类，原样返回给客户端；
      <b>等待秒数</b>=最多帮它扛多久。改完点「应用」立刻生效，不重启、不打断进行中的对话。
    </div>
    <div class="kinds" id="kinds"></div>
    <div class="cfgact">
      <button id="cfgsave">应用</button>
      <button id="cfgreload">读取当前值</button>
      <span class="count" id="cfgmsg"></span>
    </div>
  </details>

  <div class="toolbar">
    <select id="fv"><option value="">全部类型</option></select>
    <select id="fo"><option value="">全部处置</option></select>
    <button id="auto" class="on">自动刷新</button>
    <button id="now">立即刷新</button>
    <span class="count" id="cnt"></span>
  </div>

  <table>
    <thead><tr>
      <th style="width:78px">时间</th>
      <th style="width:52px">状态</th>
      <th style="width:132px">类型</th>
      <th style="width:96px">处置</th>
      <th style="width:52px">尝试</th>
      <th style="width:64px">耗时</th>
      <th>响应原文</th>
    </tr></thead>
    <tbody id="tb"></tbody>
  </table>
  <div class="empty" id="empty" style="display:none">
    暂无异常事件。护盾启动后遇到的每一个非 2xx 响应都会记录在这里。
  </div>

  <div class="foot" id="foot"></div>
</main>

<script>
var COLORS = {retry:"--retry", cool:"--cool", swap:"--swap",
              auth:"--auth", pass:"--pass", network:"--network"};
var OUT_CN = {absorbed:"已吸收", passed:"已透传", gave_up:"已放弃",
              client_gone:"客户端断开", retrying:"重试中"};
var state = {data:null, auto:true, open:{}};

function color(v){
  var name = COLORS[v] || "--dim2";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"]/g, function(ch){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch];
  });
}
function hhmmss(ts){
  var d = new Date(ts * 1000);
  function p(n){ return (n < 10 ? "0" : "") + n; }
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function ago(ts, now){
  var s = Math.max(0, Math.round(now - ts));
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.round(s / 60) + " 分钟前";
  return Math.round(s / 3600) + " 小时前";
}

function render(){
  var d = state.data;
  if (!d) return;

  document.getElementById("upstream").textContent =
    d.config.upstream + "　预算 " + d.config.max_budget + "s / "
    + d.config.max_attempts + " 次　换号窗 " + d.config.swap_budget + "s";

  // 顶部占比条
  var bar = document.getElementById("bar");
  var total = d.groups.reduce(function(a, g){ return a + g.count; }, 0);
  if (total > 0) {
    bar.innerHTML = d.groups.map(function(g){
      return '<i style="width:' + (g.count / total * 100) + '%;background:'
             + color(g.verdict) + '" title="' + esc(g.verdict) + " "
             + g.count + '"></i>';
    }).join("");
  } else {
    bar.innerHTML = '<i style="width:100%;background:var(--panel2)"></i>';
  }

  // 分类卡片
  var cards = d.groups.map(function(g){
    var m = d.meta[g.verdict] || {name:g.verdict, how:"", why:""};
    var outs = Object.keys(g.outcomes).map(function(k){
      var cls = (k === "passed" || k === "gave_up") ? "chip bad"
              : (k === "absorbed" ? "chip ok" : "chip");
      return '<span class="' + cls + '">' + (OUT_CN[k] || k)
             + " " + g.outcomes[k] + "</span>";
    }).join("");
    var sts = Object.keys(g.statuses).sort().map(function(k){
      return '<span class="chip">' + k + " × " + g.statuses[k] + "</span>";
    }).join("");
    return '<div class="card" style="--bar:' + color(g.verdict) + '">'
      + "<h3>" + esc(m.name)
      + '<span class="mono" style="color:var(--dim2);font-weight:400">'
      + esc(g.verdict) + "</span></h3>"
      + '<div class="n" style="color:' + color(g.verdict) + '">' + g.count + "</div>"
      + '<div class="why">' + esc(m.why) + "</div>"
      + '<div class="chips">' + sts + outs + "</div>"
      + '<div class="how"><b style="color:var(--dim)">处理方式</b><br>'
      + esc(m.how) + "</div>"
      + "</div>";
  }).join("");
  document.getElementById("cards").innerHTML = cards
    || '<div class="card"><h3>暂无异常</h3><div class="why">'
       + "护盾运行正常，还没有遇到非 2xx 响应。</div></div>";

  // 下拉选项（保留当前选择）
  var fv = document.getElementById("fv"), fo = document.getElementById("fo");
  var keepV = fv.value, keepO = fo.value;
  fv.innerHTML = '<option value="">全部类型</option>'
    + Object.keys(d.meta).map(function(k){
        var g = d.groups.filter(function(x){ return x.verdict === k; })[0];
        return '<option value="' + k + '">' + esc(d.meta[k].name)
               + (g ? " (" + g.count + ")" : "") + "</option>";
      }).join("");
  fv.value = keepV;
  var allOut = {};
  d.groups.forEach(function(g){
    Object.keys(g.outcomes).forEach(function(k){
      allOut[k] = (allOut[k] || 0) + g.outcomes[k];
    });
  });
  fo.innerHTML = '<option value="">全部处置</option>'
    + Object.keys(allOut).map(function(k){
        return '<option value="' + k + '">' + (OUT_CN[k] || k)
               + " (" + allOut[k] + ")</option>";
      }).join("");
  fo.value = keepO;

  // 事件表
  var rows = d.events.map(function(e){
    var m = d.meta[e.verdict] || {name:e.verdict};
    var stCls = "st st" + String(e.status).charAt(0);
    // 从响应体里抽出上游的 reason 码（如 CONTENT_LENGTH_EXCEEDS_THRESHOLD）。
    // 只有分类名（"确定性错误"）看不出到底是哪个错，排查时第一眼要找的是这个码。
    var det = state.open[e.seq]
      ? '<tr class="detail"><td colspan="7">'
        + '<div class="kv"><b>路径</b><span class="mono">' + esc(e.path)
        + "</span><b>发生时间</b><span>" + hhmmss(e.ts) + "　"
        + ago(e.ts, d.now) + "</span>"
        + "<b>处理方式</b><span>" + esc(m.how || "") + "</span>"
        + "<b>判定依据</b><span>" + esc(m.why || "") + "</span>"
        + (e.retry_after ? "<b>Retry-After</b><span>" + esc(e.retry_after)
           + " 秒</span>" : "")
        + (e.note ? "<b>说明</b><span>" + esc(e.note) + "</span>" : "")
        + "</div><pre>" + esc(e.body || "(空响应体)") + "</pre></td></tr>"
      : "";
    return '<tr class="row" data-seq="' + e.seq + '">'
      + "<td>" + hhmmss(e.ts) + "</td>"
      + '<td class="' + stCls + '">' + e.status + "</td>"
      + '<td><span class="tag" style="color:' + color(e.verdict)
      + '">' + esc(m.name) + "</span>"
      + (reasonOf(e.body) ? '<span class="rtag">' + esc(reasonOf(e.body))
         + "</span>" : "") + "</td>"
      + '<td><span class="out out-' + e.outcome + '">'
      + (OUT_CN[e.outcome] || e.outcome) + "</span></td>"
      + "<td>" + e.attempts + "</td>"
      + "<td>" + e.waited + "s</td>"
      + '<td class="body mono">' + esc((e.body || "").slice(0, 200)) + "</td>"
      + "</tr>" + det;
  }).join("");
  document.getElementById("tb").innerHTML = rows;
  document.getElementById("empty").style.display = d.events.length ? "none" : "";
  document.getElementById("cnt").textContent =
    "显示 " + d.events.length + " / 缓冲 " + d.total_buffered
    + " 条（上限 " + d.buffer_max + "）";

  var s = d.stats;
  document.getElementById("foot").innerHTML =
    "<b>累计</b>　请求 " + s.requests + "　重试 " + s.retries
    + "　已吸收 " + s.absorbed + "　放弃 " + s.gave_up
    + "　冷却等待 " + (s.cool_waits || 0)
    + "　换号等待 " + (s.swap_waits || 0)
    + "　4xx 兜底等待 " + (s.auth_waits || 0) + "<br>"
    + "<b>唯一会透传给客户端的情况</b>：响应体命中 <code>"
    + d.config.permanent_markers.join("</code> <code>") + "</code>"
    + "，或状态码属于 <code>"
    + d.config.client_fault_statuses.join(" ") + "</code>"
    + "（客户端自己的错，必须立刻报，不能拖）。其余一切非 2xx 都会被拦下重试。";

  document.getElementById("tick").textContent = "更新于 " + hhmmss(d.now);
}

function load(){
  var qs = [];
  var v = document.getElementById("fv").value;
  var o = document.getElementById("fo").value;
  if (v) qs.push("verdict=" + encodeURIComponent(v));
  if (o) qs.push("outcome=" + encodeURIComponent(o));
  qs.push("limit=300");
  fetch("events?" + qs.join("&"), {cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(j){ state.data = j; render(); })
    .catch(function(err){
      document.getElementById("tick").textContent = "连接失败";
    });
}

document.getElementById("tb").addEventListener("click", function(ev){
  var tr = ev.target.closest("tr.row");
  if (!tr) return;
  var seq = tr.getAttribute("data-seq");
  state.open[seq] = !state.open[seq];
  render();
});
document.getElementById("fv").addEventListener("change", load);
document.getElementById("fo").addEventListener("change", load);
document.getElementById("now").addEventListener("click", load);
document.getElementById("auto").addEventListener("click", function(){
  state.auto = !state.auto;
  this.classList.toggle("on", state.auto);
  this.textContent = state.auto ? "自动刷新" : "已暂停";
});
/* ---------------- 预算调节 ---------------- */
/* 中文标签 + 该项的实际含义。用词直说「客户端会挂多久」，
   因为这才是调它的真实后果，写成「预算」太抽象。 */
var CFG_LABEL = {
  max_budget:         ["总预算(秒)", "所有重试合计最长等待"],
  max_attempts:       ["总次数", "最多重试几次"],
  swap_budget:        ["换号窗(秒)", "全池 429/封号 → 等号池恢复，调大=更强 0 透传"],
  swap_max_attempts:  ["换号次数", ""],
  auth_budget:        ["未知4xx(秒)", "确定性 400 多落这里，等待救不回来，建议短"],
  auth_max_attempts:  ["未知4xx次数", ""],
  perm_budget:        ["确定性错误(秒)", "请求非法/模型错，重试必失败，建议短"],
  perm_max_attempts:  ["确定性次数", ""],
  client_budget:      ["客户端错误(秒)", "key 填错这类，最短即可"],
  client_max_attempts:["客户端次数", ""]
};

/* 每类错误一行卡片：真实报错样例 → 护盾做什么 → 客户端看到什么。
   verdict 是内部分类名，这里全部翻成人话，并绑定「开关 + 等待秒数」。
   budget_key 指向该类实际用的预算参数；null 表示这类不吃预算（直接透传）。 */
/* perm 这一类实际包含 4 种成因完全不同的错误（数据来自 k2cc failure_log
   全量统计），处置手段也不同，所以在界面上拆开显示。它们共用 perm 的
   预算与开关（后端是同一个 verdict），但各自标注了真正的解法，
   避免「一行卡片说不清三件事」。 */
var KINDS = [
  { verdict:"perm", code:"400", name:"上下文太长", tag:"CONTENT_LENGTH_EXCEEDS_THRESHOLD",
    sample:"Input is too long.",
    reason:"对话历史累积超过模型上限（实测 647 次，占 400 的最大头）",
    fix:"重试救不回来。真正的解法是服务端自动截断最老的历史（k2cc 已有该开关，默认关）",
    client:"连接开着，最长 45 秒后收到 503",
    budget_key:"perm_budget", attempts_key:"perm_max_attempts" },
  { verdict:"perm", code:"400", name:"模型名不对", tag:"INVALID_MODEL_ID",
    sample:"Invalid model. Please select a different model to continue.",
    reason:"该号的订阅档位不支持这个模型（196 次）。同一模型换个号可能就行",
    fix:"重试同号无用，换号才有机会 —— 目前按短窗收敛",
    client:"连接开着，最长 45 秒后收到 503",
    budget_key:"perm_budget", attempts_key:"perm_max_attempts" },
  { verdict:"perm", code:"400", name:"工具调用配对错", tag:"TOOL_USE_RESULT_MISMATCH",
    sample:"`tool_use` ids were found without `tool_result` blocks immediately after",
    reason:"上游要求工具结果必须紧跟在下一条消息（累计 500+ 次，是 k2cc 拼请求的缺陷）",
    fix:"需要在 k2cc 侧修请求结构；护盾这边只能短窗重试",
    client:"连接开着，最长 45 秒后收到 503",
    budget_key:"perm_budget", attempts_key:"perm_max_attempts" },
  { verdict:"perm", code:"400", name:"请求格式非法", tag:"REQUEST_BODY_INVALID",
    sample:"Improperly formed request.",
    reason:"请求体不符合上游 schema（114 次）",
    fix:"重试不改变结果，短窗收敛",
    client:"连接开着，最长 45 秒后收到 503",
    budget_key:"perm_budget", attempts_key:"perm_max_attempts" },
  { verdict:"auth", code:"400/403", name:"认不出的 4xx",
    sample:"上游返回 400/403 但措辞不在已知清单里",
    reason:"k2cc 把上游原文包装成「Upstream API call failed」，护盾看不到具体原因",
    fix:"当账号问题等一小会儿（原先等 1 小时纯空转，已改成 90 秒）",
    client:"连接开着；超时后 503",
    budget_key:"auth_budget", attempts_key:"auth_max_attempts" },
  { verdict:"swap", code:"403", name:"账号被封 / 需要换号",
    sample:"TEMPORARILY_SUSPENDED / AccessDeniedException / no available credential",
    reason:"号被上游风控，或全池没有可用号",
    fix:"长时间等号池恢复 —— 这条是「0 透传」的主力",
    client:"连接一直开着（每几秒发心跳），恢复后正常出结果",
    budget_key:"swap_budget", attempts_key:"swap_max_attempts" },
  { verdict:"retry", code:"429/502/503", name:"限速 / 上游抖动",
    sample:"429 Too Many Requests / 502 / 503 / INSUFFICIENT_MODEL_CAPACITY",
    reason:"打太快或上游临时不可用，等一下就好",
    fix:"指数退避重试（1 秒起，最多 12 秒一次）",
    client:"连接开着，通常几秒内自动成功",
    budget_key:"max_budget", attempts_key:"max_attempts" },
  { verdict:"client", code:"401/404", name:"你自己的 key/路径写错",
    sample:"Invalid API key / Missing API key / not_found_error",
    reason:"请求还没碰到号池就被鉴权门拒了，换号一百次也没用",
    fix:"只等 2 次，快速收敛",
    client:"很快收到 503（不再干等）",
    budget_key:"client_budget", attempts_key:"client_max_attempts" }
];

function cfgRender(cfg, tunable){
  var groups = {};
  if (state.data && state.data.groups) {
    state.data.groups.forEach(function(g){ groups[g.verdict] = g.count; });
  }
  // 同一 verdict 可能对应多张卡片（perm 拆成 4 种）。开关与秒数是按 verdict
  // 生效的，所以只在该 verdict 的**第一张**卡片上渲染控件，其余标注「同上」，
  // 否则同一个 id 会重复、且让人误以为能单独关掉其中一种。
  var seen = {};
  document.getElementById("kinds").innerHTML = KINDS.map(function(k){
    var on = !(state.off && state.off[k.verdict]);
    var cnt = groups[k.verdict] || 0;
    var sec = k.budget_key ? cfg[k.budget_key] : "";
    var first = !seen[k.verdict];
    seen[k.verdict] = true;
    return '<div class="kind' + (on ? '' : ' off') + '">'
      + '<div class="khead">'
      +   (first
          ? '<label class="sw"><input type="checkbox" data-v="' + k.verdict + '"'
            + (on ? ' checked' : '') + '><i></i></label>'
          : '<span class="swph" title="与上一条同属一类，开关共用"></span>')
      +   (k.code ? '<span class="kcode">' + esc(k.code) + '</span>' : '')
      +   '<span class="kname">' + esc(k.name) + '</span>'
      +   (k.tag ? '<span class="ktag">' + esc(k.tag) + '</span>' : '')
      +   (first ? '<span class="kcnt">该类共 ' + cnt + ' 次</span>' : '')
      +   '<span class="spacer"></span>'
      +   (first && k.budget_key
          ? '<span class="ksec">最多帮扛 <input type="number" id="kb_'
            + k.verdict + '" value="' + sec + '"> 秒</span>'
          : '<span class="ksec dim">开关/秒数同上</span>')
      + '</div>'
      + '<div class="kbody">'
      +   '<div class="kcell"><div class="t">原始报错长这样</div>'
      +     '<div class="v"><code>' + esc(k.sample) + '</code><br>'
      +     '<span style="color:#6b7891">' + esc(k.reason) + '</span></div></div>'
      +   '<div class="kcell"><div class="t">护盾怎么处理</div>'
      +     '<div class="v">' + esc(k.fix) + '</div></div>'
      +   '<div class="kcell"><div class="t">客户端（Cursor / Claude Code）看到</div>'
      +     '<div class="v ' + (on ? 'kok' : 'kbad') + '">'
      +     (on ? esc(k.client) : '原样收到上面那个错误（开关已关）') + '</div></div>'
      + '</div></div>';
  }).join("");

  // 高级区仍保留原始数字，方便需要时精调
  var box = document.getElementById("cfggrid");
  box.innerHTML = Object.keys(CFG_LABEL).filter(function(k){
    return tunable && tunable[k];
  }).map(function(k){
    var meta = CFG_LABEL[k], rng = tunable[k];
    return '<div class="cfgitem" title="' + esc(meta[1]) + '">'
      + '<label>' + esc(meta[0]) + '</label>'
      + '<input id="cf_' + k + '" type="number" value="' + cfg[k] + '">'
      + '<span class="rng">' + rng[0] + '~' + rng[1] + '</span>'
      + '</div>';
  }).join("");
}

/* 从上游响应体里提取 reason 码。取不到时退回 message 的前几个词，
   总比只显示一个笼统的分类名有用。 */
function reasonOf(body){
  if (!body) return "";
  var m = /"reason"\s*:\s*"([A-Z_]{3,})"/.exec(body);
  if (m) return m[1];
  m = /"type"\s*:\s*"([a-z_]{3,})"/.exec(body);
  if (m) return m[1];
  return "";
}

function cfgLoad(){
  fetch("config", {cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(j){ state.cfg = j.config; state.tunable = j.tunable;
                       syncOff(j.config); cfgRender(j.config, j.tunable);
                       document.getElementById("cfgmsg").textContent = "已读取当前值"; })
    .catch(function(){ document.getElementById("cfgmsg").textContent = "读取失败"; });
}

/* 开关：勾掉某一类 = 那一类不再拦，原样透传给客户端 */
document.getElementById("kinds").addEventListener("change", function(ev){
  var cb = ev.target;
  if (!cb || cb.type !== "checkbox") return;
  state.off = state.off || {};
  state.off[cb.getAttribute("data-v")] = !cb.checked;
  cfgRender(state.cfg || {}, state.tunable);
  document.getElementById("cfgmsg").textContent = "已修改，点「应用」生效";
});

document.getElementById("cfgsave").addEventListener("click", function(){
  var patch = {};
  // 1) 每类的「最多帮扛多少秒」
  KINDS.forEach(function(k){
    if (!k.budget_key) return;
    var el = document.getElementById("kb_" + k.verdict);
    if (!el) return;
    var v = el.value.trim();
    if (v !== "" && Number(v) > 0) patch[k.budget_key] = Number(v);
  });
  // 2) 被关掉的类别（后端据此改为直接透传）
  var off = Object.keys(state.off || {}).filter(function(v){ return state.off[v]; });
  patch.passthrough = off;
  // 3) 高级区的原始数字（若填了则覆盖）
  Object.keys(CFG_LABEL).forEach(function(k){
    var el = document.getElementById("cf_" + k);
    if (!el) return;
    var v = el.value.trim();
    if (v !== "" && Number(v) > 0) patch[k] = Number(v);
  });
  document.getElementById("cfgmsg").textContent = "提交中…";
  fetch("config", {method:"POST", headers:{"Content-Type":"application/json"},
                   body: JSON.stringify(patch)})
    .then(function(r){ return r.json(); })
    .then(function(j){
      var msg = j.ok ? "✓ 已生效" : "部分失败：" + j.errors.join("；");
      if (j.config && j.config.passthrough && j.config.passthrough.length) {
        msg += "　已放行：" + j.config.passthrough.join(", ");
      }
      document.getElementById("cfgmsg").textContent = msg;
      if (j.config) { state.cfg = j.config; state.tunable = j.tunable || state.tunable;
                      syncOff(j.config); cfgRender(j.config, state.tunable); }
      load();
    })
    .catch(function(){ document.getElementById("cfgmsg").textContent = "提交失败"; });
});
document.getElementById("cfgreload").addEventListener("click", cfgLoad);

/* 后端是权威：用返回的 passthrough 列表校正本地开关状态，
   避免页面显示「已关」而服务端其实还在拦 */
function syncOff(cfg){
  state.off = {};
  (cfg.passthrough || []).forEach(function(v){ state.off[v] = true; });
}
document.getElementById("cfgbox").addEventListener("toggle", function(){
  if (this.open) cfgLoad();
});

setInterval(function(){ if (state.auto) load(); }, 3000);
load();
</script>
</body>
</html>
"""
