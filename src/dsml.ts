/**
 * DSML 工具调用兜底解析。
 *
 * DeepSeek 偶发不吐结构化 `tool_calls`，而是把工具调用当普通文本吐出来，
 * 形如（`⟨` 代表实际的分隔字符，上游用的是 antml/DSML 风格标记）：
 *
 *   ⟨|DSML|function_calls⟩
 *   <invoke name="Bash">
 *   <parameter name="command">ls -la</parameter>
 *   </invoke>
 *   ⟨/DSML|function_calls⟩
 *
 * 客户端（Claude Code）看到的就是一堆裸文本，工具不会被执行。这里把这类文本
 * 还原成真正的 `tool_use` 块。
 *
 * 保守原则：只在文本里同时出现 `function_calls` 包裹标记和 `<invoke name=...>`
 * 时才介入；解析不出任何 invoke 就原样返回，绝不吞掉正常文本。
 */

export interface DsmlToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface DsmlExtraction {
  /** 剥掉 DSML 块之后剩下的文本（已 trim，可能为空）。 */
  text: string;
  /** 解析出的工具调用，按出现顺序。 */
  toolCalls: DsmlToolCall[];
}

/** 匹配整个 function_calls 包裹块。分隔符宽松：允许 antml/DSML 等前缀变体。 */
const FUNCTION_CALLS_BLOCK =
  /[<⟨]\s*\|?\s*[A-Za-z]*\s*\|?\s*function_calls\s*\|?\s*[>⟩]?([\s\S]*?)(?:[<⟨]\s*\/\s*\|?\s*[A-Za-z]*\s*\|?\s*function_calls\s*\|?\s*[>⟩]?|$)/gi;

/** 单个 invoke 及其参数。 */
const INVOKE = /<invoke\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)(?:<\/invoke\s*>|$)/gi;

/** 单个 parameter。属性顺序不固定，额外属性（如 string="true"）忽略。 */
const PARAMETER = /<parameter\s+([^>]*?)>([\s\S]*?)(?:<\/parameter\s*>|$)/gi;

function attrValue(attrs: string, key: string): string | null {
  const m = new RegExp(`${key}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs);
  return m ? (m[1] ?? null) : null;
}

/** 参数值按 JSON 试解析（数字/布尔/对象），失败则保留原字符串。 */
function coerce(raw: string): unknown {
  const s = raw.trim();
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

function parseInvokes(inner: string): DsmlToolCall[] {
  const calls: DsmlToolCall[] = [];
  INVOKE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INVOKE.exec(inner)) != null) {
    const name = (m[1] ?? '').trim();
    if (!name) continue;
    const input: Record<string, unknown> = {};
    const body = m[2] ?? '';
    PARAMETER.lastIndex = 0;
    let p: RegExpExecArray | null;
    while ((p = PARAMETER.exec(body)) != null) {
      const key = attrValue(p[1] ?? '', 'name');
      if (key) input[key] = coerce(p[2] ?? '');
    }
    calls.push({ name, input });
  }
  return calls;
}

/**
 * 从文本里抽出 DSML 工具调用。没有可解析的调用时返回 null（调用方保持原样，
 * 避免对正常文本做任何改写）。
 */
export function extractDsmlToolCalls(text: string): DsmlExtraction | null {
  if (!text || !/function_calls/i.test(text) || !/<invoke\s/i.test(text)) return null;

  const toolCalls: DsmlToolCall[] = [];
  let rest = '';
  let lastEnd = 0;
  FUNCTION_CALLS_BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FUNCTION_CALLS_BLOCK.exec(text)) != null) {
    const calls = parseInvokes(m[1] ?? '');
    if (calls.length === 0) continue;
    toolCalls.push(...calls);
    rest += text.slice(lastEnd, m.index);
    lastEnd = m.index + m[0].length;
  }
  if (toolCalls.length === 0) return null;
  rest += text.slice(lastEnd);
  return { text: rest.trim(), toolCalls };
}
