import type { IncomingMessage } from 'node:http';

/**
 * 内存指标收集：环形缓冲存最近 N 条请求，供监控面板轮询。
 *
 * 刻意不落盘、不引依赖：这是个单机网关，指标只用于「看现在在发生什么」，
 * 重启清零是可接受的。上限固定，避免长跑内存无界增长。
 */
const MAX_EVENTS = 200;

export interface DeviceInfo {
  /** 原始 User-Agent */
  ua: string;
  /** 解析出的客户端名（Claude Code / curl / OpenAI SDK 等） */
  client: string;
  os: string;
  /** 是否判定为移动端 */
  mobile: boolean;
  /** 调用方 IP（考虑反代头） */
  ip: string;
  /** 反代链路（x-forwarded-for 全链） */
  forwardedFor: string;
  /** Accept-Language 首选语言 */
  language: string;
  /** 是否经 cloudflared/CDN（有 cf-* 头） */
  viaProxy: boolean;
}

export interface RequestEvent {
  id: number;
  /** Unix 毫秒 */
  at: number;
  method: string;
  path: string;
  /** 协议视角：客户端说的是哪种协议 */
  protocol: 'openai' | 'anthropic' | 'other';
  status: number;
  /** 端到端耗时（ms） */
  durationMs: number;
  /** 客户端请求的模型名 */
  model: string;
  /** 实际发给上游的模型名 */
  upstreamModel: string;
  /**
   * 命中订阅端点还是按量付费；`count_tokens` 是纯本地估算的记账请求
   * （reviewer m7：记账请求不进「请求数」统计，面板聚合与趋势都排除它）。
   */
  endpoint: 'subscription' | 'payg' | 'count_tokens' | '-';
  stream: boolean;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  /** 请求体字节数 */
  requestBytes: number;
  device: DeviceInfo;
  /** 上游 key 指纹（末 4 位），不含原文 */
  keyFingerprint: string;
  error: string | null;
  /** 本请求触发错误改写（上下文超限 400 改写）次数。观测：改写率 = 上游上下文撞限频率。 */
  rewritten: number;
  /** 本请求触发 context_management 剥除次数（DeepSeek 不认 compact 配对字段）。 */
  stripped: number;
  /** 本请求触发被动压缩次数（实验性 COMPACT_ENABLED 的触发即计，非实际压缩到的字节）。 */
  compressed: number;
}

let seq = 0;
const events: RequestEvent[] = [];
const startedAt = Date.now();

/**
 * 解析 UA 得到可读的客户端/系统名。刻意保持简单：只认实际会用到的几类。
 *
 * 客户端识别的优先级链参考 kirostudio 的 `classify_device`（src/usage/record.rs）：
 * **具体品牌必须先判**——Cursor/Windsurf/Cline 等 AI 客户端的 UA 里常同时带
 * `vscode`/`Chrome`/`Mozilla`，先判通用分支会让它们塌陷成浏览器或 VSCode，
 * 面板就看不出来真实客户端构成。`zed` 用词边界（`authorized`/`optimized`
 * 等常见子串），避免误伤。
 *
 * OS 判定**移动端优先**：iPad UA 自报 "like Mac OS X"、Android UA 自报 Linux，
 * 必须让 iOS/Android 分支在桌面 OS 之前短路（修复过：真实 iPhone UA 曾被
 * 判成 macOS）。`ios` 用词边界——`axios/1.6.0` 这类 Node 库 UA 含裸 `ios` 子串。
 */
export function parseUserAgent(ua: string): { client: string; os: string; mobile: boolean } {
  const s = ua || '';
  const lower = s.toLowerCase();
  let client = 'unknown';
  if (/claude-cli|claude-code/i.test(s)) client = 'Claude Code';
  else if (/cursor/i.test(s)) client = 'Cursor';
  else if (/windsurf|codeium/i.test(s)) client = 'Windsurf';
  // Codex 客户端家族（sub2api 取证的 UA 形态）：codex_cli_rs / codex-tui /
  // codex_vscode / codex_vscode_copilot / codex_app / Codex Desktop 等。
  else if (/codex/i.test(s)) client = 'Codex';
  // Cline / Roo-Cline（`roo-cline` 也含 `cline`，一并归类）。
  else if (/cline/i.test(s)) client = 'Cline';
  else if (/continue/i.test(s)) client = 'Continue';
  else if (/copilot/i.test(s)) client = 'Copilot';
  else if (/opencode/i.test(s)) client = 'OpenCode';
  else if (/aider/i.test(s)) client = 'Aider';
  else if (/\bzed\b/i.test(s)) client = 'Zed';
  // Kiro IDE（AWS 的 AI 编程工具，kiro2cc-proxy 取证）：UA 形如
  // `aws-sdk-js/1.0.27 KiroIDE-{version}-{machine_id}`（User-Agent 与
  // x-amz-user-agent 都带 KiroIDE 字样）。必须在 /kiro/ 通用分支之前：
  // KiroIDE 含 kiro 子串，先判能给出更精确的客户端名。
  else if (/KiroIDE/i.test(s)) client = 'Kiro IDE';
  else if (/kiro/i.test(s)) client = 'Kiro';
  else if (/jetbrains|intellij|pycharm|goland|webstorm/i.test(s)) client = 'JetBrains';
  // 通用 VSCode（未命中上述具体分支/插件时；Cursor/Cline 等必须先判）。
  else if (/vscode|visual studio code/i.test(s)) client = 'VSCode';
  else if (/anthropic-sdk|anthropic-ai/i.test(s)) client = 'Anthropic SDK';
  else if (/openai-python|openai-node|openai\//i.test(s)) client = 'OpenAI SDK';
  else if (/^curl/i.test(s)) client = 'curl';
  else if (/httpie/i.test(s)) client = 'HTTPie';
  else if (/python-requests|aiohttp|httpx/i.test(s)) client = 'Python HTTP';
  else if (/postman/i.test(s)) client = 'Postman';
  else if (/node-fetch|undici/i.test(s)) client = 'Node fetch';
  else if (/Edg\//.test(s)) client = 'Edge';
  else if (/Chrome\//.test(s)) client = 'Chrome';
  else if (/Safari\//.test(s) && !/Chrome/.test(s)) client = 'Safari';
  else if (/Firefox\//.test(s)) client = 'Firefox';
  else if (s) client = s.split('/')[0]!.slice(0, 24);

  let os = 'unknown';
  // 移动端优先：iOS/Android 的 UA 含桌面关键字（"like Mac OS X" / Linux），
  // 必须先短路，否则 iPhone 判成 macOS、Android 判成 Linux。
  if (/iphone|ipad|ipod/.test(lower) || /\bios\b/.test(lower)) os = 'iOS';
  else if (/android/.test(lower)) os = 'Android';
  else if (/mac os x|macintosh|darwin/.test(lower)) os = 'macOS';
  else if (/windows nt|win32/.test(lower)) os = 'Windows';
  else if (/linux|x11/.test(lower)) os = 'Linux';

  const mobile = /Mobile|Android|iPhone|iPad/i.test(s);
  return { client, os, mobile };
}

/** 从请求头提取设备信息。反代场景取 x-forwarded-for 首段作为真实 IP。 */
export function extractDevice(req: IncomingMessage): DeviceInfo {
  const h = req.headers;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const ua = str(h['user-agent']);
  const xff = str(h['x-forwarded-for']);
  const cfIp = str(h['cf-connecting-ip']);
  const realIp = str(h['x-real-ip']);
  const socketIp = req.socket.remoteAddress ?? '';
  // 优先级：CDN 头 → x-real-ip → xff 首段 → socket。
  const ip = cfIp || realIp || xff.split(',')[0]?.trim() || socketIp;
  const { client, os, mobile } = parseUserAgent(ua);
  return {
    ua,
    client,
    os,
    mobile,
    ip,
    forwardedFor: xff,
    language: str(h['accept-language']).split(',')[0] ?? '',
    viaProxy: Boolean(cfIp || str(h['cf-ray'])),
  };
}

/** 记录一条请求事件（超出上限时丢最旧的）。 */
export function recordEvent(ev: Omit<RequestEvent, 'id'>): void {
  events.push({ ...ev, id: ++seq });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export interface MetricsSnapshot {
  uptimeMs: number;
  totalRequests: number;
  events: RequestEvent[];
  summary: {
    ok: number;
    failed: number;
    streaming: number;
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    avgDurationMs: number;
    p95DurationMs: number;
    /** 窗口内错误改写次数（触发 Claude Code 自动恢复链的上下文超限 400）。 */
    rewritten: number;
    /** 窗口内 context_management 剥除次数。 */
    stripped: number;
    /** 窗口内被动压缩触发次数（实验性 COMPACT_ENABLED）。 */
    compressed: number;
    byModel: Array<{ model: string; count: number; tokens: number }>;
    byClient: Array<{ client: string; count: number }>;
    byEndpoint: Array<{ endpoint: string; count: number }>;
  };
}

/** 面板用快照：最近事件 + 聚合。计算很轻（上限 200 条），每次请求现算即可。 */
export function snapshot(): MetricsSnapshot {
  const list = [...events].reverse(); // 最新在前
  const durations = events.map((e) => e.durationMs).sort((a, b) => a - b);
  const sum = (f: (e: RequestEvent) => number): number => events.reduce((n, e) => n + f(e), 0);

  const group = <K extends string>(key: (e: RequestEvent) => K): Map<K, RequestEvent[]> => {
    const m = new Map<K, RequestEvent[]>();
    for (const e of events) {
      const k = key(e);
      const arr = m.get(k);
      if (arr) arr.push(e);
      else m.set(k, [e]);
    }
    return m;
  };

  const byModel = [...group((e) => e.model || '-')]
    .map(([model, list_]) => ({
      model,
      count: list_.length,
      tokens: list_.reduce((n, e) => n + e.inputTokens + e.outputTokens, 0),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const byClient = [...group((e) => e.device.client)]
    .map(([client, list_]) => ({ client, count: list_.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const byEndpoint = [...group((e) => e.endpoint)]
    .map(([endpoint, list_]) => ({ endpoint, count: list_.length }))
    .sort((a, b) => b.count - a.count);

  return {
    uptimeMs: Date.now() - startedAt,
    totalRequests: seq,
    events: list,
    summary: {
      ok: events.filter((e) => e.status >= 200 && e.status < 400).length,
      failed: events.filter((e) => e.status >= 400).length,
      streaming: events.filter((e) => e.stream).length,
      inputTokens: sum((e) => e.inputTokens),
      outputTokens: sum((e) => e.outputTokens),
      thinkingTokens: sum((e) => e.thinkingTokens),
      avgDurationMs: durations.length ? Math.round(sum((e) => e.durationMs) / durations.length) : 0,
      p95DurationMs: durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]! : 0,
      rewritten: sum((e) => e.rewritten),
      stripped: sum((e) => e.stripped),
      compressed: sum((e) => e.compressed),
      byModel,
      byClient,
      byEndpoint,
    },
  };
}
