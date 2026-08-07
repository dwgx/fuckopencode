import type { AnthropicStreamEvent } from './types.js';

/**
 * DeepSeek / opencodezen 上游的 Anthropic 协议归一化。
 *
 * 目标：让标准 Anthropic 客户端（Claude Code）的请求经过本层后，
 * 能被 deepseek-v4 系列 / opencodezen 网关正确接受。已知坑：
 * - 只认 `deepseek-v4-flash` 这类精确模型名，claude-* 会被上游 401。
 * - `thinking:{type:'adaptive'}` + `budget_tokens` 直接 400，必须归一化
 *   成 `{type:'enabled'|'disabled'}` 并去掉 budget_tokens。
 * - `thinking:{type:'disabled'}` 时若仍带 reasoning_effort → 400
 *   （deepseek 报 "cannot be disabled when reasoning_effort is set"）。
 * - `reasoning_effort` 需转成 `output_config.effort`。
 * - Claude Code 会带 `context_management`、`output_config.format/task_budget`、
 *   工具上的 `strict/defer_loading` 等「beta 配对字段」，deepseek 直接 400
 *   （Extra inputs are not permitted），需剥离。
 */

export const DEFAULT_FALLBACK_MODEL = 'deepseek-v4-flash';

/** 模型名解析：命中 MODEL_MAP 用映射值，否则回落 fallback（opencodezen 只认 flash）。 */
export function resolveModelName(
  model: string,
  modelMap: Record<string, string>,
  fallbackModel: string,
): string {
  return modelMap[model] ?? fallbackModel;
}

/**
 * 对 Anthropic 请求做深拷贝 + 归一化，返回新的对象（不污染入参）。
 * 只做协议字段调整，不动 messages 语义。
 */
export function normalizeAnthropicRequest(
  raw: unknown,
  modelMap: Record<string, string>,
  fallbackModel: string,
): Record<string, unknown> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid anthropic request body');
  }
  const body = structuredClone(raw) as Record<string, unknown>;

  // 1. 模型名映射。
  if (typeof body.model === 'string') {
    body.model = resolveModelName(body.model, modelMap, fallbackModel);
  }

  // 2. thinking 归一化：adaptive→enabled，删 budget_tokens，未知类型删除。
  let thinkingDisabled = false;
  const thinking = body.thinking;
  if (thinking != null && typeof thinking === 'object' && !Array.isArray(thinking)) {
    const type = (thinking as Record<string, unknown>).type;
    if (type === 'adaptive' || type === 'enabled') {
      body.thinking = { type: 'enabled' };
    } else if (type === 'disabled') {
      body.thinking = { type: 'disabled' };
      thinkingDisabled = true;
    } else {
      delete body.thinking;
    }
  } else if (typeof thinking === 'string') {
    delete body.thinking;
  }

  // 3. reasoning_effort：disabled 时连 effort 一起删；否则映射到 output_config.effort。
  if (thinkingDisabled) {
    delete body.reasoning_effort;
    delete body.output_config;
  } else if (typeof body.reasoning_effort === 'string') {
    body.output_config = { effort: body.reasoning_effort };
    delete body.reasoning_effort;
  }

  // 4. 剥离 deepseek 不认的 beta 配对字段。
  delete body.context_management;
  if (body.output_config != null && typeof body.output_config === 'object') {
    const oc = body.output_config as Record<string, unknown>;
    const effort = oc.effort;
    body.output_config = typeof effort === 'string' ? { effort } : {};
    if (Object.keys(body.output_config as object).length === 0) {
      delete body.output_config;
    }
  }

  // 5. 工具上的 strict/defer_loading 也会 400，剥离。
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map((t) => {
      if (t != null && typeof t === 'object' && !Array.isArray(t)) {
        const tool = t as Record<string, unknown>;
        delete tool.strict;
        delete tool.defer_loading;
      }
      return t;
    });
  }

  // 6. thinking enabled + 带工具的多轮：assistant 历史缺 thinking 块则注入空块，
  //    否则 deepseek 次轮 400（reasoning_content 缺失）。
  injectMissingThinkingBlocks(body);

  return body;
}

/**
 * 请求侧：thinking 非 disabled 时，若 assistant 历史消息带 tool_use 但缺 thinking 块，
 * 注入空 thinking 块。deepseek 在「带工具+thinking」的多轮里要求 assistant 回传
 * reasoning 内容，缺失会 400（间歇性，取决于上游启发式检查）；Claude Code 这类
 * 客户端不回传，社区代理都注入空块。
 */
export function injectMissingThinkingBlocks(body: Record<string, unknown>): void {
  const thinking = body.thinking;
  if (thinking != null && typeof thinking === 'object' && (thinking as { type?: unknown }).type === 'disabled') return;
  const messages = body.messages;
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    if (m == null || typeof m !== 'object' || Array.isArray(m)) continue;
    const msg = m as Record<string, unknown>;
    if (msg.role !== 'assistant') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const hasToolUse = content.some(
      (b) => b != null && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_use',
    );
    const hasThinking = content.some(
      (b) => b != null && typeof b === 'object' && (b as { type?: unknown }).type === 'thinking',
    );
    if (hasToolUse && !hasThinking) {
      content.unshift({ type: 'thinking', thinking: '', signature: '' });
    }
  }
}

/**
 * 响应侧：过滤 Anthropic 流式事件里的 thinking 内容块。
 * deepseek 即使请求 thinking disabled 也会吐 thinking/signature_delta，
 * Claude Code 在 thinking 关闭时会因此报「Tool result missing」等错误。
 * keepThinking=true 时原样透传；false 时剥掉 thinking 块相关事件。
 */
export async function* filterThinkingFromStream(
  events: AsyncIterable<AnthropicStreamEvent>,
  keepThinking: boolean,
): AsyncGenerator<AnthropicStreamEvent> {
  if (keepThinking) {
    for await (const ev of events) yield ev;
    return;
  }
  const thinkingBlocks = new Set<number>();
  for await (const ev of events) {
    switch (ev.type) {
      case 'content_block_start':
        if (ev.content_block.type === 'thinking') {
          thinkingBlocks.add(ev.index);
          continue;
        }
        yield ev;
        break;
      case 'content_block_delta':
        if (thinkingBlocks.has(ev.index)) continue;
        yield ev;
        break;
      case 'content_block_stop':
        if (thinkingBlocks.has(ev.index)) {
          thinkingBlocks.delete(ev.index);
          continue;
        }
        yield ev;
        break;
      default:
        yield ev;
    }
  }
}
