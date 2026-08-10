export type InjectionMode = 'block' | 'log' | 'off';

export interface AppConfig {
  host: string;
  port: number;
  /** 允许的调用方 API keys（明文，逗号分隔） */
  apiKeys: string[];
  /** 上游 Anthropic API key（单 key 兼容；多 key 用 upstreamKeys） */
  anthropicApiKey: string | null;
  /** 上游 key 池：OPENSEA_KEYS 逗号分隔，兼容 ANTHROPIC_API_KEY 单 key 合并 */
  upstreamKeys: string[];
  /** key 池：连续失败多少次禁用 */
  keyFailThreshold: number;
  /** key 池：冷却期（ms） */
  keyCooldownMs: number;
  /**
   * 用量持久化 db 路径（SQLite）。空串 = 关闭持久化，面板只剩内存窗口。
   *
   * 默认在**代码目录旁的 `data/`**，刻意不在 `dist/` 里 —— `scripts/deploy.sh`
   * 每次部署都 `mv dist dist.prev; mv dist.new dist`，放 dist 内会随部署丢。
   */
  usageDbPath: string;
  /** 用量记录保留天数，0 = 不清理。 */
  usageDbRetentionDays: number;
  /**
   * key 主动探活的周期（毫秒）。0 = 关闭。
   *
   * 面板的「可用」只代表不在冷却期，不代表验证过能用 —— 探活用最小 token
   * 的真实请求去证明它还活着。详见 keyprobe.ts。
   */
  keyProbeIntervalMs: number;
  /** 一个 key 空闲多久才值得探（有真实流量经过就不用额外探）。 */
  keyProbeIdleMs: number;
  /** 单次探活请求的超时。探活是后台动作，不该无限等。 */
  keyProbeTimeoutMs: number;
  /** 上游 base URL，末尾不带斜杠。订阅端点（opencode Zen 的 /zen/go）。 */
  anthropicBaseUrl: string;
  /**
   * 按量付费端点 base URL，末尾不带斜杠。
   * `-free` 模型只存在于这里，订阅端点不认（401 ModelError）。
   */
  payAsYouGoBaseUrl: string;
  /** 模型名映射表（OpenAI 名 → 上游 Anthropic 名） */
  modelMap: Record<string, string>;
  /** 未命中映射时的兜底模型名（opencodezen 只认 deepseek-v4-flash） */
  fallbackModel: string;
  /** 注入检测模式：block=高置信拒绝 / log=只记录 / off=关闭 */
  injectionMode: InjectionMode;
  /** 未鉴权放行开关（fail-closed；仅当绑定非公网地址时有效） */
  allowUnauthenticated: boolean;
  /** 请求体字节上限 */
  maxBodyBytes: number;
  /** 单条消息文本字符上限 */
  maxMessageChars: number;
  /** 输出日志控制符是否剥离 */
  stripControlChars: boolean;
  /** 是否透传客户端 x-claude-code-* 会话标记头（默认不透传，防共享部署冒充会话） */
  trustClaudeCodeHeaders: boolean;
  /**
   * 监控面板是否免鉴权。仅在绑定回环地址时为 true —— 面板会展示调用方 IP/UA
   * 等设备信息，绑非回环时必须带 key 才能看。
   */
  dashboardOpen: boolean;
  /**
   * 面板是否完全公开（含公网）。默认关。
   *
   * 打开后任何人都能看到全部调用方的 IP、完整 UA、转发链 —— 这是刻意的取舍，
   * 用于「把面板当展示页」的场景。不需要展示时设 0，退回本机免 key 的行为。
   */
  dashboardPublic: boolean;
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

function intFromEnv(value: string | undefined, fallback: number, min = 0): number {
  if (value == null || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/** 解析 `MODEL_MAP="gpt-4o:claude-sonnet-4-6,gpt-4o-mini:claude-haiku-4-5"`。 */
function parseModelMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const [from, to] = pair.split(':');
    if (from && to) map[from.trim()] = to.trim();
  }
  return map;
}

/** 解析 `OPENSEA_KEYS="k1,k2,k3"`（逗号分隔，去空，去重）。单 key 优先排在最前。 */
function parseUpstreamKeys(raw: string | undefined, singleKey: string | null): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  if (singleKey) {
    seen.add(singleKey);
    keys.push(singleKey);
  }
  for (const rawKey of (raw ?? '').split(',')) {
    const key = rawKey.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
}

/**
 * 从环境变量读取配置。键全部白名单化，避免不可控输入进入服务边界。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const injectionRaw = env.INJECTION_MODE?.toLowerCase();
  const injectionMode: InjectionMode =
    injectionRaw === 'block' || injectionRaw === 'log' || injectionRaw === 'off'
      ? injectionRaw
      : 'block';

  const host = env.HOST || '127.0.0.1';
  const apiKeys = (env.API_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  const anthropicApiKey = env.ANTHROPIC_API_KEY || null;
  const upstreamKeys = parseUpstreamKeys(env.OPENSEA_KEYS, anthropicApiKey);

  return {
    host,
    port: intFromEnv(env.PORT, 8787, 1),
    apiKeys,
    anthropicApiKey,
    upstreamKeys,
    keyFailThreshold: intFromEnv(env.KEY_FAIL_THRESHOLD, 5, 1),
    keyCooldownMs: intFromEnv(env.KEY_COOLDOWN_MS, 300_000, 1_000),
    // `USAGE_DB_PATH` 未设 → 默认 `<cwd>/data/usage.db`。cwd 在 systemd unit 里是
    // `WorkingDirectory=/root/fuckopencode`（已核实），即与 dist/ 同级的 data/。
    // 显式设为空串 = 关闭持久化（此时面板只有内存窗口，代理行为完全不变）。
    usageDbPath: env.USAGE_DB_PATH === '' ? '' : (env.USAGE_DB_PATH || 'data/usage.db'),
    usageDbRetentionDays: intFromEnv(env.USAGE_DB_RETENTION_DAYS, 30, 0),
    // 30 分钟一轮，探「空闲超过 30 分钟」的 key。两个值一致是刻意的：
    // 一个 key 只要连续 30 分钟没接到真实流量，下一轮就会被探到。
    keyProbeIntervalMs: intFromEnv(env.KEY_PROBE_INTERVAL_MS, 1_800_000, 0),
    keyProbeIdleMs: intFromEnv(env.KEY_PROBE_IDLE_MS, 1_800_000, 0),
    keyProbeTimeoutMs: intFromEnv(env.KEY_PROBE_TIMEOUT_MS, 30_000, 1_000),
    anthropicBaseUrl: (env.ANTHROPIC_BASE_URL || 'https://opencode.ai/zen/go').replace(/\/+$/, ''),
    payAsYouGoBaseUrl: (env.PAYG_BASE_URL || 'https://opencode.ai/zen').replace(/\/+$/, ''),
    modelMap: parseModelMap(env.MODEL_MAP),
    fallbackModel: env.DEFAULT_MODEL || 'deepseek-v4-flash',
    injectionMode,
    allowUnauthenticated: boolFromEnv(env.ALLOW_UNAUTHENTICATED, false) && hostnameIsSafe(host),
    // DeepSeek V4 是 1M token 上下文（约 400 万字符）。默认值必须留足余量，
    // 否则 Claude Code 读个大文件就被网关自己拒掉（曾因 200_000 导致线上 400）。
    // 两者都支持 0 = 不限制。
    maxBodyBytes: intFromEnv(env.MAX_BODY_BYTES, 64 * 1024 * 1024),
    maxMessageChars: intFromEnv(env.MAX_MESSAGE_CHARS, 8_000_000),
    stripControlChars: boolFromEnv(env.STRIP_CONTROL_CHARS, true),
    trustClaudeCodeHeaders: boolFromEnv(env.TRUST_CLAUDE_CODE_HEADERS, false),
    // 面板含设备信息，只在本机绑定时免鉴权。
    dashboardOpen: boolFromEnv(env.DASHBOARD_OPEN, true) && hostnameIsSafe(host),
    // 完全公开需显式开启，避免「不知不觉把 IP 记录挂到公网」。
    dashboardPublic: boolFromEnv(env.DASHBOARD_PUBLIC, false),
  };
}

/**
 * fail-closed 的一部分：即使 ALLOW_UNAUTHENTICATED=1，也只在本机绑定场景放行，
 * 防止裸奔到局域网/公网。绑定非回环地址时强制要求鉴权。
 */
function hostnameIsSafe(host: string): boolean {
  if (host === '0.0.0.0') return false; // 绑定所有网卡，不安全
  // 只认回环地址。绑定 OS 主机名可能解析到局域网 IP，会裸奔，一律不放行。
  return isLoopbackHost(host);
}
