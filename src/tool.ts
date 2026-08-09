import type {
  AnthropicTool,
  AnthropicToolChoice,
  OpenAITool,
  OpenAIToolChoice,
} from './types.js';

/**
 * 递归清洗 JSON Schema，去掉 Anthropic/deepseek 不认或会 400 的关键字，
 * 避免结构化输出时上游拒绝。
 *
 * 白名单外关键字（anyOf/oneOf/allOf/$ref/$schema/format 等）一律剥离。
 * $ref 在单 schema 上下文无法解析 → 降级为宽松 `{type:'object'}`，防透传被拒。
 */
export function sanitizeInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  // $ref 无法在单 schema 上下文解析 → 降级宽松 object，避免把引用原样透传给上游被拒。
  if ('$ref' in schema) {
    return { type: 'object' };
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    // 白名单剥离：只保留 type/properties/required/items/additionalProperties/description/enum，
    // 其余（anyOf/oneOf/allOf/$ref/$schema/format/pattern 等）全部丢弃。
    if (!SCHEMA_KEEP_KEYS.has(key)) continue;

    if (key === 'properties') {
      // properties 的值是「属性名 → 子 schema」映射：键（属性名）必须保留，
      // 只递归清洗每个子 schema，不能把整个 properties 当 schema 剥键。
      if (value != null && typeof value === 'object' && !Array.isArray(value)) {
        const props: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
          if (propSchema != null && typeof propSchema === 'object' && !Array.isArray(propSchema)) {
            props[propName] = sanitizeInputSchema(propSchema as Record<string, unknown>);
          } else {
            props[propName] = propSchema;
          }
        }
        out[key] = props;
      } else {
        out[key] = value;
      }
    } else if (value != null && typeof value === 'object' && !Array.isArray(value)) {
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

/** sanitizeInputSchema 白名单键（对齐 KiroStudio converter 的七键白名单）。 */
const SCHEMA_KEEP_KEYS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'additionalProperties',
  'description',
  'enum',
]);

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
