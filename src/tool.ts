import type {
  AnthropicTool,
  AnthropicToolChoice,
  OpenAITool,
  OpenAIToolChoice,
} from './types.js';

/**
 * 递归清洗 JSON Schema，去掉 Anthropic 不认/会 400 的关键字
 * （$ref、$schema、format），避免结构化输出时上游拒绝。
 */
export function sanitizeInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' || key === '$schema' || key === 'format') continue;
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = sanitizeInputSchema(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item != null && typeof item === 'object' && !Array.isArray(item)
          ? sanitizeInputSchema(item as Record<string, unknown>)
          : item,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 工具名消毒：只留 [a-zA-Z0-9_-]，超长截断，防注入/非法名。 */
export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'tool';
}

/**
 * OpenAI tools（`{type:'function', function:{name,description,parameters}}`）
 * → Anthropic tools（扁平 `{name, description, input_schema}`）。
 * 应用 schema 清洗与工具名消毒。
 */
export function openAIToolsToAnthropic(tools: OpenAITool[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: sanitizeToolName(t.function.name),
    description: t.function.description,
    input_schema: sanitizeInputSchema(t.function.parameters ?? {}),
  }));
}

/**
 * OpenAI tool_choice → Anthropic tool_choice。
 *
 * - 'auto'     → {type:'auto'}
 * - 'none'     → {type:'none'}
 * - 'required' → {type:'any'}
 * - {type:'function', function:{name}} → {type:'tool', name}
 */
export function openAIToolChoiceToAnthropic(choice: OpenAIToolChoice): AnthropicToolChoice {
  if (typeof choice === 'string') {
    switch (choice) {
      case 'none':
        return { type: 'none' };
      case 'required':
        return { type: 'any' };
      case 'auto':
      default:
        return { type: 'auto' };
    }
  }
  if (choice?.type === 'function') {
    return { type: 'tool', name: sanitizeToolName(choice.function.name) };
  }
  return { type: 'auto' };
}

/**
 * OpenAI `parallel_tool_calls:false` → Anthropic
 * `tool_choice.disable_parallel_tool_use:true`。未禁并行或未指定时返回 undefined。
 */
export function parallelToolCallsToAnthropic(
  parallel: boolean | undefined,
): { disable_parallel_tool_use: true } | undefined {
  return parallel === false ? { disable_parallel_tool_use: true } : undefined;
}
