import type {
  AnthropicResponse,
  OpenAIChatResponse,
  OpenAIToolCall,
  ResponseConvertOptions,
} from './types.js';
import { anthropicStopReasonToOpenAI } from './stopReason.js';
import { anthropicUsageToOpenAI } from './usage.js';

/** anthropicToOpenAIResponse 的选项：在原基础上支持回显客户端请求的模型名。 */
export type AnthropicToOpenAIResponseOptions = ResponseConvertOptions & { model?: string };

/**
 * Anthropic Messages 响应（非流式）→ OpenAI Chat Completions 响应。
 *
 * - text blocks 拼接为 content 字符串；thinking blocks 拼接为
 *   message.reasoning_content；tool_use → tool_calls。
 * - `input`（对象）→ `arguments`（JSON 字符串）。
 * - stop_reason → finish_reason；usage 换算。
 * - model 回显客户端请求的模型名（options.model），缺省用上游 Anthropic 名。
 */
export function anthropicToOpenAIResponse(
  res: AnthropicResponse,
  options: AnthropicToOpenAIResponseOptions = {},
): OpenAIChatResponse {
  const contentParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of res.content) {
    if (block.type === 'text') {
      contentParts.push(block.text);
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      // server_tool_use 结构与 tool_use 相同（id/name/input），统一映射为 OpenAI tool_calls。
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    } else if (block.type === 'thinking') {
      thinkingParts.push(block.thinking);
    }
    // redacted_thinking / web_search_tool_result / mid_conv_system：
    // OpenAI 无对应结构，显式丢弃（不崩溃、不混入 content）。
  }

  const message: OpenAIChatResponse['choices'][number]['message'] = {
    role: 'assistant',
    content: contentParts.length ? contentParts.join('') : null,
  };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (thinkingParts.length) message.reasoning_content = thinkingParts.join('');

  let finishReason = anthropicStopReasonToOpenAI(res.stop_reason);
  // JSON mode（json_mode 工具强制）：把工具调用转成 OpenAI json_object 语义——
  // content=JSON 字符串、finish_reason=stop，而不是向客户端暴露一个工具调用。
  if (toolCalls.length === 1 && toolCalls[0]!.function.name === 'json_mode') {
    message.content = toolCalls[0]!.function.arguments;
    delete message.tool_calls;
    finishReason = 'stop';
  }

  return {
    id: options.id ?? res.id,
    object: 'chat.completion',
    created: options.created ?? Math.floor(Date.now() / 1000),
    model: options.model ?? res.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: anthropicUsageToOpenAI(res.usage),
  };
}
