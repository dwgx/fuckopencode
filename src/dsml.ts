/**
 * DSML 工具调用兜底解析。
 *
 * DeepSeek 偶发不吐结构化 `tool_calls`，而是把工具调用当普通文本吐出来。
 * 实测形态（2026-08-09 线上截图，claude-mythos-5）：**每个标签自己带命名空间
 * 前缀**，不是外层包一层：
 *
 *   <|DSML|function_calls>
 *   <|DSML|invoke name="Bash">
 *   <|DSML|parameter name="command" string="true">ls -la</|DSML|parameter>
 *   </|DSML|invoke>
 *   </|DSML|function_calls>
 *
 * 前缀形态不稳定（`|DSML|`、`antml:`、全角 `｜`、或干脆没有），所以标签匹配
 * 统一走 `NS` 这个宽松前缀模式，不硬编码某一种。
 *
 * 客户端（Claude Code / opencode）看到的就是一堆裸文本，工具不会被执行。
 * 这里把这类文本还原成真正的 `tool_use` 块。
 *
 * 保守原则：只在文本里**同时**出现 function_calls 标记和 invoke 标签时才介入；
 * 解析不出任何 invoke 就原样返回，绝不吞掉正常文本。
 */

export interface DsmlToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface DsmlExtraction {
  /** 剥掉 DSML 标记之后剩下的文本（已 trim，可能为空）。 */
  text: string;
  /** 解析出的工具调用，按出现顺序。 */
  toolCalls: DsmlToolCall[];
}

/**
 * 标签名前的命名空间噪声。三种形态：
 * - `|DSML|` / ` | DSML | ` / 全角 `｜DSML｜`（实测形态）
 * - `antml:` / `foo:`（XML 命名空间风格）
 * - 空（标准 `<invoke>`）
 */
const NS = String.raw`(?:[\s|｜]*[A-Za-z][\w-]*[\s|｜]*|[\s|｜]*[A-Za-z][\w-]*\s*:\s*|[\s|｜]*)`;

/** 开/闭标签。闭合标签允许缺失（上游被 max_tokens 截断时）。 */
const openTag = (name: string) => String.raw`[<⟨]${NS}${name}`;
const closeTag = (name: string) => String.raw`[<⟨]\s*/${NS}${name}[^>⟩]*[>⟩]?`;

const HAS_FUNCTION_CALLS = /function_calls/i;
const HAS_INVOKE = new RegExp(`${openTag('invoke')}\\b`, 'i');

/** function_calls 的开闭标记（用于从残余文本里剥掉）。 */
const FUNCTION_CALLS_MARKER = new RegExp(
  `${openTag('function_calls')}[^>]*>?|${closeTag('function_calls')}`,
  'gi',
);

/** 单个 invoke 及其内容。属性段单独捕获，name 从属性里取。 */
const INVOKE = new RegExp(
  `${openTag('invoke')}\\s+([^>]*?)>([\\s\\S]*?)(?:${closeTag('invoke')}|$)`,
  'gi',
);

/** 单个 parameter。属性顺序不固定，额外属性（如 string="true"）单独判读。 */
const PARAMETER = new RegExp(
  `${openTag('parameter')}\\s+([^>]*?)>([\\s\\S]*?)(?:${closeTag('parameter')}|$)`,
  'gi',
);

function attrValue(attrs: string, key: string): string | null {
  const m = new RegExp(`\\b${key}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs);
  return m ? (m[1] ?? null) : null;
}

/**
 * 参数值类型还原。上游带 `string="true"` 时明确是字符串，直接原样返回 ——
 * 否则像 `command="123"` 这种会被误转成数字。
 */
function coerce(raw: string, attrs: string): unknown {
  if (attrValue(attrs, 'string') === 'true') return raw;
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

/**
 * 残缺 DSML 标记。上游被 max_tokens 截断、或只吐了半截标签时，
 * `extractDsmlToolCalls` 抽不出任何 invoke，此前那些标记就原样泄漏给客户端了
 * （实测：客户端看到裸的 `<｜DSML｜function_calls`）。
 *
 * 这里单独兜一层：只剥标记本身，**保留周围的正常文本**。
 * 覆盖开/闭标签，以及被截断成「没有 `>`」的半截标签。
 */
const DSML_RESIDUE = new RegExp(
  [
    // 完整或半截的开标签：<|DSML|function_calls> / <｜DSML｜invoke ...> / <|DSML|parameter ...>
    `[<⟨]${NS}(?:function_calls|invoke|parameter)\\b[^>⟩]*[>⟩]?`,
    // 闭标签
    `[<⟨]\\s*/${NS}(?:function_calls|invoke|parameter)[^>⟩]*[>⟩]?`,
  ].join('|'),
  'gi',
);

/** 文本里是否残留 DSML 标记（用于判断要不要走剥离兜底）。 */
export function hasDsmlResidue(text: string): boolean {
  if (!text) return false;
  DSML_RESIDUE.lastIndex = 0;
  return DSML_RESIDUE.test(text);
}

/**
 * 剥掉残留的 DSML 标记，保留正常文本。
 *
 * 与 `extractDsmlToolCalls` 的分工：那个负责「能还原成 tool_use 的」，
 * 这个负责「还原不了、但不能让客户端看到标记的」。
 */
export function stripDsmlResidue(text: string): string {
  return text.replace(DSML_RESIDUE, '').trim();
}

/**
 * 从文本里抽出 DSML 工具调用。没有可解析的调用时返回 null
 * （调用方保持原样，避免对正常文本做任何改写）。
 */
export function extractDsmlToolCalls(text: string): DsmlExtraction | null {
  if (!text || !HAS_FUNCTION_CALLS.test(text) || !HAS_INVOKE.test(text)) return null;

  const toolCalls: DsmlToolCall[] = [];
  let rest = '';
  let lastEnd = 0;

  INVOKE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INVOKE.exec(text)) != null) {
    const name = (attrValue(m[1] ?? '', 'name') ?? '').trim();
    if (!name) continue;

    const input: Record<string, unknown> = {};
    const body = m[2] ?? '';
    PARAMETER.lastIndex = 0;
    let p: RegExpExecArray | null;
    while ((p = PARAMETER.exec(body)) != null) {
      const attrs = p[1] ?? '';
      const key = attrValue(attrs, 'name');
      if (key) input[key] = coerce(p[2] ?? '', attrs);
    }

    toolCalls.push({ name, input });
    rest += text.slice(lastEnd, m.index);
    lastEnd = m.index + m[0].length;
  }

  if (toolCalls.length === 0) return null;
  rest += text.slice(lastEnd);
  // 残余里还会留着 function_calls 的开闭标记，一并剥掉。
  return { text: rest.replace(FUNCTION_CALLS_MARKER, '').trim(), toolCalls };
}


