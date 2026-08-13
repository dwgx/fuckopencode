export type InjectionMode = 'block' | 'log' | 'off';

/**
 * 面板登录密码的默认值（ADMIN_PASS env 未设时生效）。
 *
 * 刻意**不是**强随机：线上部署通常 env 显式设置（历史默认 admin/thankyouopencode、
 * 现默认 13141516 都是用户在用），改默认值会破坏现有登录。安全兜底靠
 * 设置页的「默认密码」告警（settings GET 的 adminPassIsDefault）+ 登录时
 * 的 stderr 告警，而不是悄悄改默认值。新部署若不加 ADMIN_PASS，会看到
 * 告警并建议改密码。
 */
export const DEFAULT_ADMIN_PASS = '13141516';

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
  /**
   * 管理面密钥（GATEWAY_SECRET env）。非空时优先于 SECRET_FILE，
   * 用于加密账户 key 与 billing cookie（AES-256-GCM）。
   */
  gatewaySecret: string | null;
  /** secret 文件路径（SECRET_FILE env），默认 data/secret.key，不存在自动生成 0600。 */
  secretFilePath: string;
  /** billing 余额抓取周期（毫秒）。0 = 关闭（不启动 billing 循环）。 */
  billingIntervalMs: number;
  /** 单次 billing 抓取超时。 */
  billingTimeoutMs: number;
  /** 面板登录账号（ADMIN_USER，默认 admin）。 */
  adminUser: string;
  /** 面板登录密码（ADMIN_PASS，默认 DEFAULT_ADMIN_PASS——默认密码有告警）。 */
  adminPass: string;
  /** 面板会话 cookie 有效期（默认 24h）。 */
  adminSessionTtlMs: number;
  /** 面板登录失败限速：同 IP 失败 N 次后锁定。 */
  adminLoginFailLimit: number;
  /** 面板登录失败锁定时长。 */
  adminLoginLockMs: number;
  /** OAuth device flow 的 client_id（官方 CLI 同款，默认 opencode-cli）。 */
  oauthClientId: string;
  /** OAuth 控制台端点 base URL（测试注入假端点用）。 */
  oauthConsoleUrl: string;
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
  /**
   * 数据面代理路径并发在飞上限（/v1/chat/completions + /v1/messages）。
   * 审计 P1-D：全链路无上限 + undici 无 per-origin 连接上限 + 大 body 多份
   * 拷贝滞留整个流时长，是 2GB VPS 唯一的 OOM 向量。默认 400（本机压测基线
   * 200 并发 1435 RPS 远低于此）。0 = 不限。
   * 可选字段：config.ts 总是生成；server 侧兜底 `?? 400`，测试字面量可省略。
   */
  maxConcurrentRequests?: number;
  /** 单条消息文本字符上限 */
  maxMessageChars: number;
  /** messages 条数上限（防超长列表遍历 DoS；0 = 不限）。 */
  maxMessages: number;
  /** 输出日志控制符是否剥离 */
  stripControlChars: boolean;
  /** 是否透传客户端 x-claude-code-* 会话标记头（默认不透传，防共享部署冒充会话） */
  trustClaudeCodeHeaders: boolean;
  /**
   * 监控面板是否免鉴权。**默认关闭**（fail-closed）：配置翻转（如误删
   * ADMIN_PASS/env 错配）不会让管理面免凭据裸奔。仅在绑定回环地址且
   * DASHBOARD_OPEN=1 时为本机直连免 key —— 面板含调用方 IP/UA 等设备
   * 信息，绑非回环时即使开着也必须带 key 才能看。
   */
  dashboardOpen: boolean;
  /**
   * 面板是否完全公开（含公网）。默认关。
   *
   * 打开后任何人都能看到全部调用方的 IP、完整 UA、转发链 —— 这是刻意的取舍，
   * 用于「把面板当展示页」的场景。不需要展示时设 0，退回本机免 key 的行为。
   */
  dashboardPublic: boolean;
  /**
   * 实验性：返回给客户端的 usage 是否缩放（SCALE_CLIENT_TOKENS）。默认关。
   *
   * 把 usage 乘上 clientTokenScale 后返回，诱导 Claude Code 按「假用量」提前
   * 触发本地 compact（在 200K 窗口内主动压缩历史），从源头避免撞上游 400。
   * 代价：客户端看到的用量失真，真实用量以网关 MetricsCtx 为准。
   */
  scaleClientTokens: boolean;
  /** 实验性：usage 缩放系数（CLIENT_TOKEN_SCALE，默认 0.6657，范围 (0, 1]）。 */
  clientTokenScale: number;
  /**
   * 实验性：请求体被动压缩开关（COMPACT_ENABLED）。默认关。
   *
   * 请求体超 compactTriggerBytes 时，对消息文本做空白折叠 + 超长单条截断，
   * 减小发给上游的字节数。无损（不裁剪消息），有损历史裁剪二期再做。
   */
  compactEnabled: boolean;
  /** 实验性：被动压缩触发阈值（COMPACT_TRIGGER_BYTES，请求体字节数）。 */
  compactTriggerBytes: number;
  /** 实验性：被动压缩的单条消息字符上限（COMPACT_MAX_MESSAGE_CHARS，超长截断）。 */
  compactMaxMessageChars: number;
  /**
   * 上游模型目录（/zen/go 订阅模型清单）的刷新周期（毫秒）。0 = 关闭定时刷新。
   * 目录只用于「白名单模型不在订阅端点 → 拒绝」的目录门，且目录空（未加载）
   * 时该门 fail-open —— 拉取失败保留旧目录，不影响代理链路。
   */
  modelCatalogRefreshMs?: number;
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

/** 解析浮点环境变量，带 [min, max] 范围检查；非法/缺失回退默认值。 */
function floatFromEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value == null || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
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
    // 探针节奏：轮转 15min（失败重试粒度），空闲 60min（闲置才探）。
    // 两个值不一样是刻意的：真实流量经过的 key 不需要探，但失败后要在 15min
    // 内重试一次。多账号模式下账户调度由 keyprobe 的 retry_until 闸门驱动。
    keyProbeIntervalMs: intFromEnv(env.KEY_PROBE_INTERVAL_MS, 900_000, 0),
    keyProbeIdleMs: intFromEnv(env.KEY_PROBE_IDLE_MS, 3_600_000, 0),
    keyProbeTimeoutMs: intFromEnv(env.KEY_PROBE_TIMEOUT_MS, 30_000, 1_000),
    // 多账号管理面的密钥：优先 GATEWAY_SECRET（env），否则读 SECRET_FILE 默认
    // data/secret.key（不存在自动生成 0600）。用于加密账户 key 与 billing cookie。
    gatewaySecret: env.GATEWAY_SECRET ? String(env.GATEWAY_SECRET) : null,
    secretFilePath: env.SECRET_FILE || 'data/secret.key',
    // 面板登录凭证：账号密码（默认 admin/DEFAULT_ADMIN_PASS，默认密码有告警）。
    // 登录成功签发 HttpOnly 会话 cookie（24h），与 API key 并存。
    adminUser: env.ADMIN_USER || 'admin',
    adminPass: env.ADMIN_PASS || DEFAULT_ADMIN_PASS,
    adminSessionTtlMs: intFromEnv(env.ADMIN_SESSION_TTL_MS, 24 * 3600_000, 60_000),
    // 面板登录失败限速：同 IP 失败 N 次锁 M 毫秒。
    adminLoginFailLimit: intFromEnv(env.ADMIN_LOGIN_FAIL_LIMIT, 5, 1),
    adminLoginLockMs: intFromEnv(env.ADMIN_LOGIN_LOCK_MS, 5 * 60_000, 1_000),
    billingIntervalMs: intFromEnv(env.BILLING_INTERVAL_MS, 1_800_000, 0),
    billingTimeoutMs: intFromEnv(env.BILLING_TIMEOUT_MS, 20_000, 5_000),
    // OAuth device flow 登录（官方 CLI 同款协议）：client_id 默认 opencode-cli，
    // 可被 OAUTH_CLIENT_ID 覆盖；控制台端点默认 https://console.opencode.ai，
    // 可被 OAUTH_CONSOLE_URL 覆盖（测试注入假端点）。
    oauthClientId: env.OAUTH_CLIENT_ID || 'opencode-cli',
    oauthConsoleUrl: (env.OAUTH_CONSOLE_URL || 'https://console.opencode.ai').replace(/\/+$/, ''),
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
    maxConcurrentRequests: intFromEnv(env.MAX_CONCURRENT_REQUESTS, 400),
    maxMessageChars: intFromEnv(env.MAX_MESSAGE_CHARS, 8_000_000),
    // messages 条数上限：默认 4000 —— 2000 对 Claude Code 超长会话太紧
    // （实测线上真实请求超限被 400）。0 = 不限（不推荐）。
    maxMessages: intFromEnv(env.MAX_MESSAGES, 4_000, 0),
    stripControlChars: boolFromEnv(env.STRIP_CONTROL_CHARS, true),
    trustClaudeCodeHeaders: boolFromEnv(env.TRUST_CLAUDE_CODE_HEADERS, false),
    // 面板含设备信息，只在本机绑定时免鉴权。默认关闭（fail-closed）——
    // 「配置翻转即全裸」的地雷：曾经默认 true，忘记设 DASHBOARD_OPEN=0 时
    // 管理面就免凭据公开。线上靠 env 显式 DASHBOARD_OPEN=1 打开不受影响。
    dashboardOpen: boolFromEnv(env.DASHBOARD_OPEN, false) && hostnameIsSafe(host),
    // 完全公开需显式开启，避免「不知不觉把 IP 记录挂到公网」。
    dashboardPublic: boolFromEnv(env.DASHBOARD_PUBLIC, false),
    // 实验性功能，默认全关；开任何一项都意味着「接受失真/丢字」的取舍。
    scaleClientTokens: boolFromEnv(env.SCALE_CLIENT_TOKENS, false),
    clientTokenScale: floatFromEnv(env.CLIENT_TOKEN_SCALE, 0.6657, 0.001, 1),
    compactEnabled: boolFromEnv(env.COMPACT_ENABLED, false),
    compactTriggerBytes: intFromEnv(env.COMPACT_TRIGGER_BYTES, 4 * 1024 * 1024, 1),
    compactMaxMessageChars: intFromEnv(env.COMPACT_MAX_MESSAGE_CHARS, 8_000, 1),
    // 上游模型目录定时刷新：默认 6h，0 = 关闭（只做启动时一次拉取）。
    modelCatalogRefreshMs: intFromEnv(env.MODEL_CATALOG_REFRESH_MS, 6 * 3_600_000, 0),
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
