import type { AppConfig } from '../config.js';

export type ValidationResult = { ok: true } | { ok: false; error: string };

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const PART_TYPES = new Set(['text', 'image_url']);

/** chat 直通端点与 anthropic 直通端点共享的消息条数上限。 */
const MAX_MESSAGES = 2000;
/** OpenAI chat max_tokens 上限（Anthropic 侧同样封顶，防 DoS）。 */
const MAX_CHAT_MAX_TOKENS = 200_000;

/** Content-Type 是否为 application/json（忽略 charset 等参数；多值头视为非 JSON）。 */
export function isJsonContentType(value: string | string[] | undefined): boolean {
  if (typeof value !== 'string') return false;
  return value.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/**
 * 请求 schema 校验（L2）。纯结构校验 + 基本长度控制，不做语义判断。
 * 防御目标：畸形 JSON、role 越权、超长内容 DoS、工具结构损坏。
 */
export function validateChatRequest(body: unknown, cfg: AppConfig): ValidationResult {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'request body must be a JSON object' };
  }
  const req = body as Record<string, unknown>;

  if (typeof req.model !== 'string' || req.model.length === 0) {
    return { ok: false, error: 'model must be a non-empty string' };
  }
  if (typeof req.stream !== 'undefined' && typeof req.stream !== 'boolean') {
    return { ok: false, error: 'stream must be a boolean' };
  }
  if (req.max_tokens != null && (typeof req.max_tokens !== 'number' || !Number.isFinite(req.max_tokens))) {
    return { ok: false, error: 'max_tokens must be a finite number' };
  }
  if (typeof req.max_tokens === 'number' && req.max_tokens > MAX_CHAT_MAX_TOKENS) {
    return { ok: false, error: `max_tokens must not exceed ${MAX_CHAT_MAX_TOKENS}` };
  }
  if (req.system != null) {
    if (typeof req.system !== 'string') {
      return { ok: false, error: 'system must be a string' };
    }
    if (req.system.length > cfg.maxMessageChars) {
      return { ok: false, error: `system exceeds ${cfg.maxMessageChars} chars` };
    }
  }
  if (req.tools != null && !Array.isArray(req.tools)) {
    return { ok: false, error: 'tools must be an array' };
  }

  const messages = req.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: 'messages must be a non-empty array' };
  }
  if (messages.length > MAX_MESSAGES) {
    return { ok: false, error: `messages must not exceed ${MAX_MESSAGES} entries` };
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg == null || typeof msg !== 'object' || Array.isArray(msg)) {
      return { ok: false, error: `messages[${i}] must be an object` };
    }
    const m = msg as Record<string, unknown>;
    if (typeof m.role !== 'string' || !ROLES.has(m.role)) {
      return { ok: false, error: `messages[${i}].role must be one of system/user/assistant/tool` };
    }

    // role 提权防护：内容块里不得出现冒充 role 的字段。
    if (m.role !== 'system' && typeof m.content === 'object' && m.content !== null && !Array.isArray(m.content)) {
      return { ok: false, error: `messages[${i}].content must be string, array, or null` };
    }

    if (typeof m.content === 'string') {
      if (m.content.length > cfg.maxMessageChars) {
        return { ok: false, error: `messages[${i}].content exceeds ${cfg.maxMessageChars} chars` };
      }
    } else if (Array.isArray(m.content)) {
      for (let j = 0; j < m.content.length; j++) {
        const part = m.content[j];
        if (part == null || typeof part !== 'object' || Array.isArray(part)) {
          return { ok: false, error: `messages[${i}].content[${j}] must be an object` };
        }
        const p = part as Record<string, unknown>;
        if (typeof p.type !== 'string' || !PART_TYPES.has(p.type)) {
          return { ok: false, error: `messages[${i}].content[${j}].type must be text or image_url` };
        }
        // 内容块结构冒充 role/system 字段：视为提权尝试。
        if (p.type === 'text') {
          if (typeof p.text !== 'string') {
            return { ok: false, error: `messages[${i}].content[${j}].text must be a string` };
          }
          if (p.text.length > cfg.maxMessageChars) {
            return { ok: false, error: `messages[${i}].content[${j}] exceeds ${cfg.maxMessageChars} chars` };
          }
        }
      }
    }
    // content === null 仅 assistant 允许（配合 tool_calls）。
    if (m.content == null && m.role !== 'assistant') {
      return { ok: false, error: `messages[${i}] only assistant messages may have null content` };
    }
  }

  if (req.tools != null) {
    const tools = req.tools as unknown[];
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i];
      if (t == null || typeof t !== 'object' || Array.isArray(t)) {
        return { ok: false, error: `tools[${i}] must be an object` };
      }
      const tool = t as Record<string, unknown>;
      if (tool.type !== 'function') {
        return { ok: false, error: `tools[${i}].type must be 'function'` };
      }
      const fn = tool.function;
      if (fn == null || typeof fn !== 'object' || typeof (fn as Record<string, unknown>).name !== 'string') {
        return { ok: false, error: `tools[${i}].function.name must be a string` };
      }
    }
  }

  // tool_choice 结构校验：字符串只收 auto/none/required；对象必须 type==='function'
  // 且 function.name 是字符串，否则下游 openAIToolChoiceToAnthropic 会 .replace 崩溃。
  if (req.tool_choice != null) {
    const tc = req.tool_choice;
    if (typeof tc === 'string') {
      if (tc !== 'auto' && tc !== 'none' && tc !== 'required') {
        return { ok: false, error: "tool_choice string must be one of auto/none/required" };
      }
    } else if (typeof tc === 'object' && !Array.isArray(tc)) {
      const tcObj = tc as Record<string, unknown>;
      const fn = tcObj.function;
      if (
        tcObj.type !== 'function' ||
        fn == null ||
        typeof fn !== 'object' ||
        Array.isArray(fn) ||
        typeof (fn as Record<string, unknown>).name !== 'string'
      ) {
        return { ok: false, error: "tool_choice.function.name must be a string" };
      }
    } else {
      return { ok: false, error: 'tool_choice must be a string or object' };
    }
  }

  return { ok: true };
}

const MAX_ANTHROPIC_MESSAGES = MAX_MESSAGES;
const MAX_ANTHROPIC_TOOLS = 128;

/** 递归累加 content 里所有字符串的长度（覆盖 tool_result 内嵌 content 数组）。 */
function contentCharCount(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) {
    let n = 0;
    for (const item of value) n += contentCharCount(item);
    return n;
  }
  if (value != null && typeof value === 'object') {
    let n = 0;
    for (const key of Object.keys(value)) {
      n += contentCharCount((value as Record<string, unknown>)[key]);
    }
    return n;
  }
  return 0;
}

/**
 * Anthropic 直通端点（/v1/messages）的结构校验 + 长度上限。
 * 防 DoS：消息条数、单条 content 字符数、tools 数量全部封顶；stream 必须布尔。
 */
export function validateAnthropicRequest(body: unknown, cfg: AppConfig): ValidationResult {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'request body must be a JSON object' };
  }
  const req = body as Record<string, unknown>;
  if (typeof req.model !== 'string' || !req.model) return { ok: false, error: 'model is required' };
  if (typeof req.max_tokens !== 'number') return { ok: false, error: 'max_tokens is required' };
  if (typeof req.stream !== 'undefined' && typeof req.stream !== 'boolean') {
    return { ok: false, error: 'stream must be a boolean' };
  }
  if (!Array.isArray(req.messages)) return { ok: false, error: 'messages must be an array' };
  if (req.messages.length > MAX_ANTHROPIC_MESSAGES) {
    return { ok: false, error: `messages must not exceed ${MAX_ANTHROPIC_MESSAGES} entries` };
  }
  for (let i = 0; i < req.messages.length; i++) {
    const m = req.messages[i];
    if (m == null || typeof m !== 'object' || Array.isArray(m)) {
      return { ok: false, error: `messages[${i}] must be an object` };
    }
    const mm = m as Record<string, unknown>;
    if (mm.role !== 'user' && mm.role !== 'assistant') {
      return { ok: false, error: `messages[${i}].role must be user or assistant` };
    }
    const content = mm.content;
    if (typeof content !== 'string' && !Array.isArray(content)) {
      return { ok: false, error: `messages[${i}].content must be a string or array` };
    }
    if (contentCharCount(content) > cfg.maxMessageChars) {
      return { ok: false, error: `messages[${i}].content exceeds ${cfg.maxMessageChars} chars` };
    }
    if (Array.isArray(content)) {
      for (let j = 0; j < content.length; j++) {
        const part = content[j];
        if (part == null || typeof part !== 'object' || Array.isArray(part)) {
          return { ok: false, error: `messages[${i}].content[${j}] must be an object` };
        }
      }
    }
  }
  if (req.tools != null) {
    if (!Array.isArray(req.tools)) return { ok: false, error: 'tools must be an array' };
    if (req.tools.length > MAX_ANTHROPIC_TOOLS) {
      return { ok: false, error: `tools must not exceed ${MAX_ANTHROPIC_TOOLS} entries` };
    }
  }
  return { ok: true };
}
