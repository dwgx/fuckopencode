import type {
  AnthropicContentBlock,
  AnthropicRequest,
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAITool,
  OpenAIToolCall,
  OpenAIToolChoice,
} from './types.js';

/**
 * Anthropic Messages 请求 → OpenAI Chat Completions 请求。
 *
 * 上游 opencode Zen 的 Anthropic 兼容层工具调用是坏的（返回空 content +
 * stop_reason:null），所以直通端点也要先转成 OpenAI 再发出去。
 *
 * 映射要点：
 * - 顶层 `system`（字符串或块数组）→ 首条 `role:'system'` 消息。
 * - `thinking` 块 → `reasoning_content`（OpenAI/DeepSeek 兼容字段）。
 * - `tool_use` → `tool_calls`（input 对象转 arguments JSON 字符串）。
 * - `tool_result` → 独立的 `role:'tool'` 消息（Anthropic 把它塞在 user 里）。
 * - `stop_sequences` → `stop`；`max_tokens` 必填 → 透传。
 * - Anthropic 特有的 `output_config` / `thinking` 开关不发给 OpenAI 端点
 *   （上游 OpenAI 端点不认，会被忽略或 400）。
 */
export function anthropicToOpenAIRequest(req: AnthropicRequest): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  // 顶层 system → 首条 system 消息。
  const systemText = extractSystemText(req.system);
  if (systemText) {
    messages.push({ role: 'system', content: systemText });
  }

  for (const msg of req.messages) {
    if (msg.role === 'assistant') {
      pushAssistant(messages, msg.content);
    } else {
      pushUser(messages, msg.content);
    }
  }

  const out: OpenAIChatRequest = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
  };

  if (req.stream != null) out.stream = req.stream;
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.tools?.length) out.tools = anthropicToolsToOpenAI(req.tools);

  const toolChoice = anthropicToolChoiceToOpenAI(req.tool_choice);
  if (toolChoice) out.tool_choice = toolChoice;

  // reasoning_effort：Anthropic 侧可能在顶层或 output_config.effort。
  const effort =
    typeof req.reasoning_effort === 'string'
      ? req.reasoning_effort
      : typeof req.output_config?.effort === 'string'
        ? req.output_config.effort
        : undefined;
  if (effort) out.reasoning_effort = effort;

  return out;
}

/** 顶层 system 可能是字符串，也可能是块数组（Claude Code 会发块数组）。 */
function extractSystemText(system: AnthropicRequest['system']): string {
  if (system == null) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const block of system as AnthropicContentBlock[]) {
      if (block != null && typeof block === 'object' && block.type === 'text' && block.text) {
        parts.push(block.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function pushAssistant(messages: OpenAIMessage[], content: AnthropicContentBlock[] | string): void {
  if (typeof content === 'string') {
    if (content) messages.push({ role: 'assistant', content });
    return;
  }

  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) textParts.push(block.text);
    } else if (block.type === 'thinking') {
      if (block.thinking) thinkingParts.push(block.thinking);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
    // redacted_thinking / image：assistant 侧 OpenAI 无对应结构，丢弃。
  }

  // 全空的 assistant 消息不发（OpenAI 也不接受空 content 且无 tool_calls）。
  if (textParts.length === 0 && toolCalls.length === 0 && thinkingParts.length === 0) return;

  const msg: OpenAIMessage = {
    role: 'assistant',
    content: textParts.length ? textParts.join('') : null,
  };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  if (thinkingParts.length) msg.reasoning_content = thinkingParts.join('');
  messages.push(msg);
}

/**
 * user 消息：Anthropic 把 tool_result 塞在 user 消息里，OpenAI 需要拆成独立的
 * `role:'tool'` 消息。所以一条 Anthropic user 可能产出多条 OpenAI 消息。
 */
function pushUser(messages: OpenAIMessage[], content: AnthropicContentBlock[] | string): void {
  if (typeof content === 'string') {
    if (content) messages.push({ role: 'user', content });
    return;
  }

  const parts: OpenAIContentPart[] = [];

  for (const block of content) {
    if (block.type === 'tool_result') {
      // tool_result 必须成为独立的 tool 消息，且要排在普通文本之前
      // （它对应上一条 assistant 的 tool_call）。
      messages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: toolResultText(block.content),
      });
    } else if (block.type === 'text') {
      if (block.text) parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const url = imageBlockToDataUrl(block.source);
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }

  if (parts.length === 0) return;
  // 纯文本时用字符串形式（更兼容），含图片时用块数组。
  const onlyText = parts.every((p) => p.type === 'text');
  if (onlyText) {
    messages.push({
      role: 'user',
      content: parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n'),
    });
  } else {
    messages.push({ role: 'user', content: parts });
  }
}

/** tool_result.content 可以是字符串或块数组，OpenAI 的 tool 消息只收字符串。 */
function toolResultText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block != null && typeof block === 'object' && block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/** Anthropic image block → OpenAI image_url（base64 转 data URI，url 直传）。 */
function imageBlockToDataUrl(source: Extract<AnthropicContentBlock, { type: 'image' }>['source']): string | null {
  if (source.type === 'url') return source.url;
  if (source.type === 'base64') return `data:${source.media_type};base64,${source.data}`;
  return null;
}

/** Anthropic tools（`{name, description, input_schema}`）→ OpenAI 嵌套 function 形式。 */
export function anthropicToolsToOpenAI(tools: NonNullable<AnthropicRequest['tools']>): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.input_schema ?? { type: 'object' },
    },
  }));
}

/** Anthropic tool_choice → OpenAI tool_choice。 */
export function anthropicToolChoiceToOpenAI(
  choice: AnthropicRequest['tool_choice'],
): OpenAIToolChoice | undefined {
  if (choice == null) return undefined;
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'none':
      return 'none';
    case 'any':
      return 'required';
    case 'tool':
      return { type: 'function', function: { name: choice.name } };
    default:
      return undefined;
  }
}
