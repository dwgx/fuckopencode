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

/**
 * thinking 开启时 max_tokens 的下限。deepseek 的 thinking 计入 max_tokens 预算，
 * 客户端小预算（如 200）会被 thinking 吃光导致正文空（实测 max_tokens=30 只有 thinking、
 * 无 text；4096 正常出正文）。上游接受大 max_tokens（实测 4096 OK）。
 */
export const DEEPSEEK_MIN_MAX_TOKENS = 4096;

/**
 * 模型名解析：命中 MODEL_MAP 用映射值，否则回落 fallback。
 *
 * 上游 `/zen/v1/models` 列了 61 个模型（claude 系、gpt 系、deepseek 系、glm 系等），
 * 客户端请求的模型名若本身就是上游支持的，直接透传，不该被回落吃掉。
 * `knownModels` 为空时退化成老行为（只看 MODEL_MAP）。
 */
export function resolveModelName(
  model: string,
  modelMap: Record<string, string>,
  fallbackModel: string,
  knownModels?: ReadonlySet<string>,
): string {
  const mapped = modelMap[model];
  if (mapped) return mapped;
  // 客户端请求的就是上游认识的模型名：直传（比如显式要 claude-opus-5 或 deepseek-v4-pro）。
  if (knownModels && knownModels.has(model)) return model;
  return fallbackModel;
}

/**
 * 选上游端点：`-free` 后缀的模型只在按量付费端点存在，订阅端点（/zen/go）
 * 会 401 `Model ... is not supported`；其余模型走订阅端点（cost=0，不烧额度）。
 *
 * 实测依据：`deepseek-v4-flash` 在 /zen/go 200，`deepseek-v4-flash-free` 在 /zen/go 401、
 * 在 /zen 200。所以两者都要能用，只是走不同 base URL。
 */
export function resolveUpstreamBaseUrl(
  model: string,
  subscriptionBaseUrl: string,
  payAsYouGoBaseUrl: string,
): string {
  return model.endsWith('-free') ? payAsYouGoBaseUrl : subscriptionBaseUrl;
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
    const retained: unknown[] = [];
    for (const t of body.tools) {
      if (t != null && typeof t === 'object' && !Array.isArray(t)) {
        const tool = t as Record<string, unknown>;
        delete tool.strict;
        delete tool.defer_loading;
        // 5.1 内置 web_search 工具（type 以 web_search 开头）deepseek 不认，剥掉；
        //     仅 type 前缀匹配，避免误剥名字碰巧含 web_search 的自定义工具。
        const toolType = typeof tool.type === 'string' ? tool.type : '';
        const toolName = typeof tool.name === 'string' ? tool.name : '';
        if (toolType.startsWith('web_search') || toolName === 'web_search') {
          continue;
        }
      }
      retained.push(t);
    }
    body.tools = retained;

    // 5.2 指向被剥 web_search 工具的 tool_choice 会悬空 400：两种形态都要剥
    //     （服务端工具 `{type:"web_search_*"}` 与显式 `{type:"tool",name:"web_search"}`）。
    const tc = body.tool_choice;
    if (tc != null && typeof tc === 'object' && !Array.isArray(tc)) {
      const tcObj = tc as Record<string, unknown>;
      const tcType = typeof tcObj.type === 'string' ? tcObj.type : '';
      const tcName = typeof tcObj.name === 'string' ? tcObj.name : '';
      if (tcType.startsWith('web_search') || tcName === 'web_search') {
        delete body.tool_choice;
      }
    }
  }

  // 6. content 字符串 → 内容块数组。opencode Zen 只认块数组形式，
  //    收到 `content:"hi"` 会报 "Empty input messages"（实测直连上游确认）。
  //    Anthropic 官方两种都支持，Claude Code 会发字符串形式，必须转换。
  normalizeMessageContent(body);

  // 7. thinking enabled + 带工具的多轮：assistant 历史缺 thinking 块则注入空块，
  //    否则 deepseek 次轮 400（reasoning_content 缺失）。
  injectMissingThinkingBlocks(body);

  // 8. max_tokens 下限保护：deepseek 的 thinking 计入 max_tokens 预算，客户端小预算
  //    （如 200）会被 thinking 吃光导致正文空。thinking 非 disabled 时把 < 下限的抬到
  //    下限、缺失补下限；≥ 下限保持；thinking disabled 不调（尊重客户端意图）。
  if (!thinkingDisabled) {
    const current = typeof body.max_tokens === 'number' ? body.max_tokens : undefined;
    if (current == null || current < DEEPSEEK_MIN_MAX_TOKENS) {
      body.max_tokens = DEEPSEEK_MIN_MAX_TOKENS;
    }
  }

  return body;
}

/**
 * 把 `content: "文本"` 规整成 `content: [{type:'text', text:'文本'}]`。
 *
 * opencode Zen 只接受内容块数组，收到字符串形式会报 "Empty input messages"
 * （实测：直连上游 `content:"hi"` 失败、`content:[{type:"text",text:"hi"}]` 成功）。
 * Anthropic 官方两种形式都支持，Claude Code 发的是字符串，所以必须在这里转。
 *
 * 空字符串转成空数组会再次触发 "Empty input messages"，因此空串直接跳过
 * （交给上游按原样判断，不制造更坏的形态）。
 */
function normalizeMessageContent(body: Record<string, unknown>): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    if (m == null || typeof m !== 'object' || Array.isArray(m)) continue;
    const msg = m as Record<string, unknown>;
    if (typeof msg.content === 'string' && msg.content !== '') {
      msg.content = [{ type: 'text', text: msg.content }];
    }
  }
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

/**
 * 补全上游缺失的 Anthropic 流式事件骨架。
 *
 * opencode Zen / deepseek 的流有时缺 `message_start`、`content_block_start`、
 * `content_block_stop`、`message_stop`，Claude Code 收到后无法初始化 message
 * 对象直接报错。这里按需补发，保证事件序列自洽：
 * - 任何事件出现前先补 `message_start`
 * - `content_block_delta` 前先补对应 index 的 `content_block_start`
 * - `message_delta` 前补齐所有未 stop 的块
 * - EOF 时补齐剩余块的 stop 与 `message_stop`
 *
 * 已由上游发出的事件不重复补（用 started/stopped 集合去重）。
 */
export async function* completeStreamEvents(
  events: AsyncIterable<AnthropicStreamEvent>,
): AsyncGenerator<AnthropicStreamEvent> {
  let sentMessageStart = false;
  let sentMessageStop = false;
  /** 已补发过 stop 的块 index */
  const stoppedBlocks = new Set<number>();
  /** 已补发过 start 的块 index */
  const startedBlocks = new Set<number>();

  const maybeMessageStart = function* (): Generator<AnthropicStreamEvent> {
    if (!sentMessageStart) {
      sentMessageStart = true;
      yield {
        type: 'message_start',
        message: {
          id: `msg_${Date.now().toString(36)}`,
          type: 'message',
          role: 'assistant',
          model: '',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
    }
  };

  const maybeBlockStart = function* (index: number): Generator<AnthropicStreamEvent> {
    if (!startedBlocks.has(index)) {
      startedBlocks.add(index);
      yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
    }
  };

  const maybeBlockStop = function* (index: number): Generator<AnthropicStreamEvent> {
    if (!stoppedBlocks.has(index) && startedBlocks.has(index)) {
      stoppedBlocks.add(index);
      yield { type: 'content_block_stop', index };
    }
  };

  const maybeMessageStop = function* (): Generator<AnthropicStreamEvent> {
    if (!sentMessageStop) {
      sentMessageStop = true;
      yield { type: 'message_stop' };
    }
  };

  /** 收尾：补所有未 stop 的块 + message_stop。 */
  const closeAll = function* (): Generator<AnthropicStreamEvent> {
    yield* maybeMessageStart();
    for (const idx of startedBlocks) {
      yield* maybeBlockStop(idx);
    }
    yield* maybeMessageStop();
  };

  for await (const ev of events) {
    switch (ev.type) {
      case 'message_start':
        sentMessageStart = true;
        yield ev;
        break;
      case 'content_block_start':
        yield* maybeMessageStart();
        startedBlocks.add(ev.index);
        yield ev;
        break;
      case 'content_block_delta':
        yield* maybeMessageStart();
        yield* maybeBlockStart(ev.index);
        yield ev;
        break;
      case 'content_block_stop':
        stoppedBlocks.add(ev.index);
        yield ev;
        break;
      case 'message_delta':
        // 先补块 stop（上游缺），再 yield message_delta。message_stop 由 EOF 统一补发，
        // 避免与上游自带的 message_stop 重复。
        yield* maybeMessageStart();
        for (const idx of startedBlocks) {
          yield* maybeBlockStop(idx);
        }
        yield ev;
        break;
      case 'message_stop':
        sentMessageStop = true;
        yield ev;
        break;
      default:
        yield* maybeMessageStart();
        yield ev;
    }
  }

  // EOF：收尾。
  yield* closeAll();
}
