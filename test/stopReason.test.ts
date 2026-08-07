import { describe, expect, it } from 'vitest';
import { anthropicStopReasonToOpenAI } from '../src/stopReason.js';

describe('anthropicStopReasonToOpenAI pause_turn', () => {
  it('pause_turn 映射为 stop（OpenAI 无对应语义，stop 最接近）', () => {
    expect(anthropicStopReasonToOpenAI('pause_turn')).toBe('stop');
  });

  it('refusal 仍映射 content_filter', () => {
    expect(anthropicStopReasonToOpenAI('refusal')).toBe('content_filter');
  });

  it('未知停因回落 stop 不报错', () => {
    expect(anthropicStopReasonToOpenAI(null)).toBe('stop');
  });
});
