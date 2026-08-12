/**
 * 实验性：请求体被动压缩（COMPACT_ENABLED）。
 *
 * 只做无损层，且只在**解析后的消息 content** 上做 —— 不碰 JSON 结构本身
 * （块类型、字段名、非文本块不动）：
 * - 空白折叠：content 文本里连续空白序列 → 单个空格。
 * - 超长单条消息截断：超过 maxMessageChars 的文本保留前段 + 省略标记。
 *
 * 有损历史裁剪（tool 配对风险）二期再做。压缩计数由 MetricsCtx 观测（波 2）。
 */

/** 截断省略标记。 */
export const TRUNCATE_MARK = '…[truncated]';

/** 被动压缩的配置与阈值（调用方负责判断 bodyBytes，见 normalizeAnthropicRequest）。 */
export interface CompactOptions {
  /** 原始请求体字节数（UTF-8，调用方用 estimateBytes 估算）。 */
  bodyBytes: number;
  /** 超过该字节数才触发压缩（仅开关开启时提供；只传 bodyBytes 时跳过压缩——
   *  OOM 克隆跳过用）。 */
  triggerBytes?: number;
  /** 单条消息字符上限，超长截断（同上，开关开启时提供）。 */
  maxMessageChars?: number;
}

/** 估算请求体字节数（UTF-8，与上游计数口径一致）。 */
export function estimateBytes(json: string): number {
  return Buffer.byteLength(json, 'utf8');
}

/**
 * 折叠单段文本：连续空白 → 单空格；超长截断（保留省略标记）。
 * 未改动（折叠/截断后与原串相同）返回 null，供调用方判断是否发生压缩。
 */
function collapseText(text: string, maxMessageChars: number): string | null {
  if (text.length === 0) return null;
  let out = text.replace(/\s+/g, ' ');
  if (out.length > maxMessageChars) {
    out = out.slice(0, maxMessageChars) + TRUNCATE_MARK;
  }
  return out === text ? null : out;
}

/**
 * 处理单个 content 块：只碰 text 与 tool_result 的文本，其余块（image/thinking/
 * tool_use 等）原样保留。返回是否发生改动。
 */
function compactBlock(block: unknown, maxMessageChars: number): boolean {
  if (block == null || typeof block !== 'object' || Array.isArray(block)) return false;
  const b = block as Record<string, unknown>;
  if (b.type === 'text' && typeof b.text === 'string') {
    const out = collapseText(b.text, maxMessageChars);
    if (out !== null) {
      b.text = out;
      return true;
    }
    return false;
  }
  if (b.type === 'tool_result') {
    // tool_result.content 可能是字符串，也可能是块数组（text/image 混排）。
    if (typeof b.content === 'string') {
      const out = collapseText(b.content, maxMessageChars);
      if (out !== null) {
        b.content = out;
        return true;
      }
      return false;
    }
    let changed = false;
    if (Array.isArray(b.content)) {
      for (const sub of b.content) {
        if (sub == null || typeof sub !== 'object' || Array.isArray(sub)) continue;
        const s = sub as Record<string, unknown>;
        if (s.type === 'text' && typeof s.text === 'string') {
          const out = collapseText(s.text, maxMessageChars);
          if (out !== null) {
            s.text = out;
            changed = true;
          }
        }
      }
    }
    return changed;
  }
  return false;
}

/**
 * 对 messages 数组做被动压缩，**原地修改** content 块（调用方需保证可变，
 * normalizeAnthropicRequest 已 structuredClone，直接改安全）。
 *
 * content 为字符串的消息直接处理；块数组只处理 text / tool_result 的文本。
 * 返回是否发生了任何压缩（供观测；具体次数/字节统计由 MetricsCtx 负责）。
 */
export function compactMessages(
  messages: unknown[],
  maxMessageChars: number,
): { messages: unknown[]; compressed: boolean } {
  let compressed = false;
  for (const m of messages) {
    if (m == null || typeof m !== 'object' || Array.isArray(m)) continue;
    const msg = m as Record<string, unknown>;
    if (typeof msg.content === 'string') {
      const out = collapseText(msg.content, maxMessageChars);
      if (out !== null) {
        msg.content = out;
        compressed = true;
      }
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (compactBlock(block, maxMessageChars)) compressed = true;
      }
    }
  }
  return { messages, compressed };
}
