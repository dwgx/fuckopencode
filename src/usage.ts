import type { AnthropicUsage, OpenAIUsage } from './types.js';

/**
 * Anthropic usage → OpenAI usage。
 * - cache_read + cache_creation 并入 prompt_tokens，并暴露到
 *   prompt_tokens_details.cached_tokens（缓存命中时 token 计数不再低估）。
 * - input_tokens → prompt_tokens 的「新鲜」部分，output_tokens → completion_tokens。
 * - output_tokens_details.thinking_tokens → completion_tokens_details.reasoning_tokens
 *   （thinking 已计入 output_tokens，直接透传不加）。
 */
export function anthropicUsageToOpenAI(usage: AnthropicUsage): OpenAIUsage {
  const cachedTokens = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const freshPrompt = usage.input_tokens ?? 0;
  const promptTokens = freshPrompt + cachedTokens;
  const completionTokens = usage.output_tokens ?? 0;

  const out: OpenAIUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
  if (cachedTokens > 0) {
    out.prompt_tokens_details = { cached_tokens: cachedTokens };
  }
  // thinking_tokens → reasoning_tokens。thinking 已计入 output_tokens，直接透传不加。
  if (usage.output_tokens_details?.thinking_tokens != null) {
    out.completion_tokens_details = { reasoning_tokens: usage.output_tokens_details.thinking_tokens };
  }
  return out;
}
