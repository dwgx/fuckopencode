// ─── OpenAI Chat Completions 类型 ───────────────────────────────

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | OpenAIContentPart[];
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  /** 推理内容（DeepSeek/OpenAI reasoning 模型），转 Anthropic 时映射为 thinking 块。 */
  reasoning_content?: string;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type OpenAIToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  stop?: string | string[];
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
  frequency_penalty?: number;
  presence_penalty?: number;
  n?: number;
  logit_bias?: Record<string, number>;
  seed?: number;
  user?: string;
  logprobs?: boolean;
  response_format?: { type: 'json_object' | 'json_schema'; json_schema?: Record<string, unknown> };
}

// ─── Anthropic Messages 类型 ─────────────────────────────────────

export type AnthropicImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: AnthropicImageSource }
  | { type: 'redacted_thinking'; data: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | AnthropicContentBlock[];
      is_error?: boolean;
    }
  | { type: 'thinking'; thinking: string; signature?: string };

export interface AnthropicMessage {
  /** Anthropic 官方接受 messages 里出现 system（Claude Code 多轮会插入）。 */
  role: 'user' | 'assistant' | 'system';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?:
    | { type: 'adaptive' | 'enabled' | 'disabled'; budget_tokens?: number }
    | string;
  output_config?: { effort?: string; format?: unknown };
  reasoning_effort?: string;
}

// ─── 响应类型 ────────────────────────────────────────────────────

export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'refusal';

export type AnthropicResponseContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'server_tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'web_search_tool_result';
      tool_use_id: string;
      content: string | AnthropicContentBlock[];
    }
  | { type: 'mid_conv_system'; text: string };

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicResponseContentBlock[];
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export type OpenAIFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'function_call';

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface OpenAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
      reasoning_content?: string;
    };
    finish_reason: OpenAIFinishReason;
  }>;
  usage: OpenAIUsage;
  /**
   * 上游记账的 cost（opencode Zen 响应带，microCents，实测字符串如 "0"；
   * 订阅端点恒 0，按量端点真实）。可选 —— 普通兼容端不返回它。
   */
  cost?: string;
}

// ─── 流式类型 ────────────────────────────────────────────────────

export type AnthropicStreamEvent =
  | { type: 'message_start'; message: AnthropicResponse }
  | {
      type: 'content_block_start';
      index: number;
      content_block: AnthropicContentBlock;
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'signature_delta'; signature: string };
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason: AnthropicStopReason | null; stop_sequence: string | null };
      // input_tokens 由网关补传真实 prompt_tokens（Anthropic 允许 message_delta
      // 带 input_tokens）：流式下 message_start 里恒 0，不放这里 server 侧
      // 拿不到 input 用量（见 toAnthropic.openAIStreamToAnthropic 收尾段）。
      usage?: { output_tokens: number; input_tokens?: number };
    }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } };

export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  /**
   * 上游错误体混进流时的错误载荷（OpenAI `{error:{...}}` 形态）。
   * 正常 chunk 没有该字段；转换器遇它必须中止流（见 toAnthropic.openAIStreamToAnthropic）。
   */
  error?: { message?: string; type?: string };
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: OpenAIFinishReason | null;
  }>;
  usage?: OpenAIUsage;
  /**
   * 上游记账 chunk 的 cost（`{"choices":[],"cost":"0"}` 形态，microCents 字符串）。
   * server 层抓它落库（网关实际用量），不转发给客户端。
   */
  cost?: string;
}

// ─── 转换选项 ────────────────────────────────────────────────────

export interface RequestConvertOptions {
  /** 模型名映射钩子，默认原样透传 */
  mapModel?: (model: string) => string;
  /** Anthropic max_tokens 缺省时的默认值（Anthropic 必填），默认 8192 */
  maxTokens?: number;
}

export interface ResponseConvertOptions {
  /** 覆盖响应 id（默认沿用 Anthropic id） */
  id?: string;
  /** 覆盖时间戳（秒） */
  created?: number;
}

export interface StreamConvertOptions {
  /** 覆盖 chunk id（默认由 message_start 派生） */
  id?: string;
  /** 覆盖模型名 */
  model?: string;
  /** 覆盖时间戳（秒） */
  created?: number;
}
