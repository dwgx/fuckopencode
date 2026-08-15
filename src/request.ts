import type {
  AnthropicRequest,
  AnthropicTool,
  AnthropicToolChoice,
  OpenAIChatRequest,
  RequestConvertOptions,
} from './types.js';
import { extractSystem, normalizeMessages } from './normalize.js';
import { DEEPSEEK_MIN_MAX_TOKENS, injectMissingThinkingBlocks } from './deepseek.js';
import {
  openAIToolChoiceToAnthropic,
  openAIToolsToAnthropic,
  parallelToolCallsToAnthropic,
  sanitizeInputSchema,
} from './tool.js';

const DEFAULT_MAX_TOKENS = 8192;

/**
 * OpenAI `response_format`（JSON mode）→ Anthropic 强制单工具：
 * 注入 `json_mode` 工具并让 tool_choice 锁定它，schema 经 sanitizeInputSchema 清洗。
 * 无 response_format 或无法解析 schema 时返回 null。
 */
function jsonModeTool(responseFormat: OpenAIChatRequest['response_format']): AnthropicTool | null {
  if (responseFormat?.type === 'json_object') {
    return {
      name: 'json_mode',
      description: 'Respond with JSON matching the given schema',
      input_schema: sanitizeInputSchema({ type: 'object' }),
    };
  }
  if (responseFormat?.type === 'json_schema') {
    const js = responseFormat.json_schema;
    if (!js) return null;
    const schema =
      js.schema && typeof js.schema === 'object' && !Array.isArray(js.schema)
        ? (js.schema as Record<string, unknown>)
        : js;
    return {
      name: 'json_mode',
      description: 'Respond with JSON matching the given schema',
      input_schema: sanitizeInputSchema(schema),
    };
  }
  return null;
}

/**
 * OpenAI Chat Completions 请求 → Anthropic Messages 请求。
 *
 * 协议差异处理：
 * - system 消息 → 顶层 `system` 字段。
 * - messages 规整（交替/首尾/合并/tool_result 紧跟）见 normalizeMessages。
 * - `tools` 扁平化；`tool_choice` 映射。
 * - `max_tokens` 必填：取 max_tokens ?? max_completion_tokens，缺省用 maxTokens。
 * - `response_format` → 注入 json_mode 工具并强制 tool_choice。
 * - `parallel_tool_calls:false` → 仅 tool_choice 为 auto 时合并
 *   disable_parallel_tool_use（tool/any/none 时该字段无效，忽略）。
 * - `reasoning_effort` → `output_config.effort`（deepseek 形态；response_format 时跳过）。
 * - `stop` → `stop_sequences`（剔纯空白项）。
 * - Anthropic 不支持的字段（frequency_penalty / presence_penalty / n /
 *   logit_bias / seed / user / logprobs）静默丢弃。
 */
/**
 * OpenAI → Anthropic 请求转换（库消费者/历史参考）。
 *
 * **网关内未接线**：数据面 chat 路径（/v1/chat/completions）直发 OpenAI 协议，
 * 不走本模块；唯一引用是 index.ts 对外导出，供外部库消费者按需调用。
 * 修改本文件不影响网关行为，但改动前仍要与 deepseek 适配（见 DEEPSEEK-QUIRKS.md）
 * 保持语义一致，避免「库路径 vs 网关路径」双口径漂移。
 */
export function openAIToAnthropicRequest(
  req: OpenAIChatRequest,
  options: RequestConvertOptions = {},
): AnthropicRequest {
  const { mapModel, maxTokens = DEFAULT_MAX_TOKENS } = options;

  const system = extractSystem(req.messages);
  const messages = normalizeMessages(req.messages);

  let tools = req.tools?.length ? openAIToolsToAnthropic(req.tools) : undefined;
  const jsonMode = jsonModeTool(req.response_format);
  if (jsonMode) tools = [...(tools ?? []), jsonMode];

  const out: AnthropicRequest = {
    model: mapModel ? mapModel(req.model) : req.model,
    messages,
    max_tokens: req.max_tokens ?? req.max_completion_tokens ?? maxTokens,
  };

  if (system) out.system = system;
  // JSON mode 依赖强制 tool_choice；deepseek 在 thinking enabled 时拒绝
  // tool_choice 指定工具（"Thinking mode does not support this tool_choice"），
  // 所以 JSON mode 时强制 thinking disabled，保证强制工具可用。
  if (req.response_format != null) {
    out.thinking = { type: 'disabled' };
  }
  if (req.stream != null) out.stream = req.stream;
  if (req.temperature != null) {
    // Anthropic 多数模型 temperature 限 [0,1]，OpenAI 允许到 2：越界即钳制不拒绝。
    out.temperature = Math.min(1, Math.max(0, req.temperature));
  }
  if (req.top_p != null) out.top_p = req.top_p;
  // reasoning_effort → output_config.effort。deepseek 不认顶层 reasoning_effort
  // （见 deepseek.ts 的坑位清单），必须转成 output_config.effort 才不会 400。
  // response_format 已强制 thinking disabled，与 effort 冲突则不映射。
  if (req.response_format == null && typeof req.reasoning_effort === 'string') {
    out.output_config = { effort: req.reasoning_effort };
  }
  if (req.stop != null) {
    const stops = (typeof req.stop === 'string' ? [req.stop] : req.stop).filter((s) => s.trim() !== '');
    if (stops.length) out.stop_sequences = stops;
  }
  if (tools?.length) out.tools = tools;

  // tool_choice：JSON mode 强制单工具，否则沿用 OpenAI tool_choice。
  let toolChoice: AnthropicToolChoice | undefined;
  if (req.response_format != null) {
    toolChoice = { type: 'tool', name: 'json_mode' };
  } else if (req.tool_choice != null) {
    toolChoice = openAIToolChoiceToAnthropic(req.tool_choice);
  }

  // parallel_tool_calls:false → 合并 disable_parallel_tool_use。该字段仅对
  // {type:'auto'} 生效；tool/any/none 或 JSON mode 强制工具时合并会 400，忽略。
  const disableParallel = parallelToolCallsToAnthropic(req.parallel_tool_calls);
  if (disableParallel) {
    if (toolChoice?.type === 'auto') {
      toolChoice = { type: 'auto', ...disableParallel };
    } else if (!toolChoice && tools?.length) {
      toolChoice = { type: 'auto', ...disableParallel };
    }
  }

  // tool_choice 'none' 但无 tools：Anthropic 可能 400，不下发。
  if (toolChoice && toolChoice.type === 'none' && !tools?.length) {
    toolChoice = undefined;
  }

  if (toolChoice) out.tool_choice = toolChoice;

  // 多轮工具稳定：deepseek 要求带 tool_use 的 assistant 历史必须回传 reasoning。
  // 客户端若没带 reasoning_content，注入空 thinking 块并启用 thinking，否则间歇 400。
  const hasToolUseHistory = out.messages.some(
    (m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'),
  );
  const thinkingDisabled =
    out.thinking != null && typeof out.thinking === 'object' && out.thinking.type === 'disabled';
  if (hasToolUseHistory && !thinkingDisabled) {
    // 标准 Anthropic 要求 thinking enabled 必须带 budget_tokens（≥1024）；
    // deepseek 会忽略 budget_tokens，带上不冲突。
    if (out.thinking == null) {
      out.thinking = { type: 'enabled', budget_tokens: 1024 };
    } else if (typeof out.thinking === 'object' && out.thinking.type === 'enabled') {
      out.thinking = { type: 'enabled', budget_tokens: 1024 };
    }
    injectMissingThinkingBlocks(out as unknown as Record<string, unknown>);
    // 与 /v1/messages 端点对齐：thinking 计入 deepseek 的 max_tokens 预算，
    // 客户端小预算会被 thinking 吃光导致正文为空。这里刚开启 thinking，
    // 必须同样抬到下限，否则多轮工具的第二轮只出 thinking 不出 text。
    if (out.max_tokens < DEEPSEEK_MIN_MAX_TOKENS) {
      out.max_tokens = DEEPSEEK_MIN_MAX_TOKENS;
    }
  }

  return out;
}
