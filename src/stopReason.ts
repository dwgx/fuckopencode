import type { AnthropicStopReason, OpenAIFinishReason } from './types.js';

/**
 * Anthropic stop_reason → OpenAI finish_reason。
 *
 * 映射：
 * - end_turn       → stop
 * - max_tokens     → length
 * - stop_sequence  → stop（OpenAI 无法区分「自然结束」与「命中 stop 序列」，统一 stop）
 * - tool_use       → tool_calls
 * - refusal        → content_filter
 * - pause_turn     → stop（新版 Anthropic 长回合续跑停因；OpenAI 无对应语义，
 *   stop 最接近，且不会报错）
 */
export function anthropicStopReasonToOpenAI(
  reason: AnthropicStopReason | 'pause_turn' | null,
): OpenAIFinishReason {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    case 'pause_turn':
      return 'stop';
    default:
      return 'stop';
  }
}
