export type InjectionMode = 'block' | 'log' | 'off';

export interface AppConfig {
  host: string;
  port: number;
  /** 允许的调用方 API keys（明文，逗号分隔） */
  apiKeys: string[];
  /** 上游 Anthropic API key */
  anthropicApiKey: string | null;
  /** 上游 Anthropic base URL，末尾不带斜杠 */
  anthropicBaseUrl: string;
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

  return {
    host,
    port: intFromEnv(env.PORT, 8787, 1),
    apiKeys,
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    anthropicBaseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
    modelMap: parseModelMap(env.MODEL_MAP),
    fallbackModel: env.DEFAULT_MODEL || 'deepseek-v4-flash',
    injectionMode,
    allowUnauthenticated: boolFromEnv(env.ALLOW_UNAUTHENTICATED, false) && hostnameIsSafe(host),
    maxBodyBytes: intFromEnv(env.MAX_BODY_BYTES, 10 * 1024 * 1024),
    maxMessageChars: intFromEnv(env.MAX_MESSAGE_CHARS, 200_000),
    stripControlChars: boolFromEnv(env.STRIP_CONTROL_CHARS, true),
    trustClaudeCodeHeaders: boolFromEnv(env.TRUST_CLAUDE_CODE_HEADERS, false),
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
