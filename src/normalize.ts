import { randomUUID } from 'node:crypto';
import type { AnthropicContentBlock, AnthropicMessage, OpenAIMessage } from './types.js';
import { openAIImageToAnthropic } from './image.js';

/**
 * 提取所有 system 消息，拼接为 Anthropic 顶层 system 字符串。
 * system 消息**不**进 messages 数组（Anthropic 的 system 是独立顶层字段）。
 */
export function extractSystem(messages: OpenAIMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'system') continue;
    if (typeof msg.content === 'string') {
      if (msg.content) parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) parts.push(part.text);
      }
    }
  }
  return parts.join('\n');
}

interface PendingMessage {
  role: 'user' | 'assistant';
  blocks: AnthropicContentBlock[];
  /** 是否包含 tool_result 块（决定能否与相邻 user 消息合并） */
  hasToolResult: boolean;
}

interface NormalizeState {
  /** 缺 id 的 assistant tool_use 生成的 id 队列；tool 消息缺 tool_call_id 时按 FIFO 取用。 */
  toolUseIdQueue: string[];
}

function genToolId(): string {
  return `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function serializeToolResultContent(content: OpenAIMessage['content']): string | AnthropicContentBlock[] {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      // tool_result 里的图片块：转 Anthropic image block；私网/无法识别的丢弃。
      const img = openAIImageToAnthropic(part.image_url);
      if (img) blocks.push(img);
    }
  }
  if (blocks.length === 0) return '';
  return blocks;
}

/** 把一条 OpenAI 消息转成 Anthropic 形式的中间表示（不含 system）。 */
function toPending(msg: OpenAIMessage, state: NormalizeState): PendingMessage {
  if (msg.role === 'assistant') {
    const blocks: AnthropicContentBlock[] = [];
    // OpenAI/DeepSeek 的推理内容 → Anthropic thinking 块，保证多轮工具时
    // deepseek 能拿到 reasoning 回传（缺失会 400）。
    if (msg.reasoning_content) blocks.push({ type: 'thinking', thinking: msg.reasoning_content });
    if (typeof msg.content === 'string') {
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
      }
    }
    for (const tc of msg.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        // 畸形 arguments 不丢弃工具调用：保持空 input，让下游可诊断。
        input = {};
      }
      let id = tc.id;
      if (!id) {
        // 缺 id：生成并入队，保证多条 tool_use 各有唯一 id，后续 tool 结果按 FIFO 对应。
        id = genToolId();
        state.toolUseIdQueue.push(id);
      }
      blocks.push({ type: 'tool_use', id, name: tc.function.name, input });
    }
    return { role: 'assistant', blocks, hasToolResult: false };
  }

  if (msg.role === 'tool') {
    // 缺 tool_call_id 时按 FIFO 从队列取对应的 tool_use id（队列空才新生成），
    // 确保 tool_result.tool_use_id 与 assistant 的 tool_use.id 一一对应。
    let toolUseId = msg.tool_call_id;
    if (!toolUseId) {
      toolUseId = state.toolUseIdQueue.shift() ?? genToolId();
    }
    return {
      role: 'user',
      blocks: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: serializeToolResultContent(msg.content),
        },
      ],
      hasToolResult: true,
    };
  }

  // user
  const blocks: AnthropicContentBlock[] = [];
  if (typeof msg.content === 'string') {
    if (msg.content) blocks.push({ type: 'text', text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text') {
        if (part.text) blocks.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        const img = openAIImageToAnthropic(part.image_url);
        if (img) blocks.push(img);
      }
    }
  }
  return { role: 'user', blocks, hasToolResult: false };
}

/**
 * 把 OpenAI 消息序列规整为 Anthropic 兼容序列。处理协议硬性约束：
 *
 * 1. system 消息被抽出（由调用方 extractSystem 处理），此处跳过。
 * 2. 严格 user/assistant 交替：相邻同角色合并；但含 tool_result 的 user
 *    消息与普通 user 消息**不**合并，因为 tool_result 必须紧跟产生它的
 *    assistant 消息（Anthropic 硬性要求）。
 * 3. 首条必须是 user：以 assistant 开头时丢弃该条；其后的孤立 tool_result
 *    user 消息失去对应 tool_use，一并丢弃。
 * 4. 末条不能是 assistant：以 assistant 结尾时追加空 user 占位。
 * 5. 多条 tool 结果合并进同一条 user 消息。
 * 6. 空 assistant（无 text/tool_use/thinking）跳过，避免产出空 content。
 * 7. 缺 id 的 tool_use 生成 id 入 FIFO 队列；tool 消息缺 tool_call_id 时按序取用。
 */
export function normalizeMessages(messages: OpenAIMessage[]): AnthropicMessage[] {
  const out: PendingMessage[] = [];
  const state: NormalizeState = { toolUseIdQueue: [] };

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    // 孤立/乱序 tool_result：前面既不是含 tool_use 的 assistant 消息，也不在
    // 连续 tool_result 链中，则没有可对应的 tool_use → drop（Anthropic 会 400）。
    if (msg.role === 'tool') {
      const prev = out[out.length - 1];
      const prevHasToolUse = prev?.role === 'assistant' && prev.blocks.some((b) => b.type === 'tool_use');
      const inToolResultChain = prev?.role === 'user' && prev.hasToolResult;
      if (!prevHasToolUse && !inToolResultChain) {
        // warn：孤立/乱序的 tool 消息被丢弃，无对应 tool_use 时无法下发。
        continue;
      }
    }

    const pending = toPending(msg, state);

    // 空 user 消息（无文本无图）：Anthropic 不接受空 content，跳过。
    if (pending.role === 'user' && !pending.hasToolResult && pending.blocks.length === 0) {
      continue;
    }
    // 空 assistant 消息（无 text/tool_use/thinking）：产出 {content:[]} 上游会 400，跳过。
    if (pending.role === 'assistant' && pending.blocks.length === 0) {
      continue;
    }

    const last = out[out.length - 1];
    if (last && last.role === pending.role) {
      const canMerge =
        pending.role === 'assistant' || last.hasToolResult === pending.hasToolResult;
      if (canMerge) {
        last.blocks.push(...pending.blocks);
        last.hasToolResult = last.hasToolResult || pending.hasToolResult;
        continue;
      }
    }
    out.push(pending);
  }

  // 首条必须以 user 开头：丢弃开头的 assistant。若随丢弃的 assistant 之后首条是
  // 含 tool_result 的 user，其 tool_use 已被丢、无从对应 → 同样丢弃，直到首条为普通消息。
  while (
    out.length > 0 &&
    (out[0]!.role === 'assistant' || (out[0]!.role === 'user' && out[0]!.hasToolResult))
  ) {
    out.shift();
  }

  // 至少保留一条消息（Anthropic 要求非空 messages）。
  if (out.length === 0) {
    out.push({ role: 'user', blocks: [{ type: 'text', text: '' }], hasToolResult: false });
  }

  // 末条不能是 assistant：追加空 user 占位。
  const lastMsg = out[out.length - 1]!;
  if (lastMsg.role === 'assistant') {
    out.push({ role: 'user', blocks: [{ type: 'text', text: '' }], hasToolResult: false });
  }

  return out.map((m) => ({ role: m.role, content: m.blocks }));
}
