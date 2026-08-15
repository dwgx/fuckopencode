import { describe, expect, it } from 'vitest';
import { compactMessages, estimateBytes, TRUNCATE_MARK } from '../src/compact.js';

describe('compactMessages 空白折叠（M-P2-3：只折空格类空白，保留换行）', () => {
  it('tool_result 代码段的换行不被拍平', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'def f():\n    return 1\n\n  x = 2' },
        ],
      },
    ] as unknown[];
    const r = compactMessages(messages, 8000);
    expect(r.compressed).toBe(true);
    const out = (messages[0] as { content: Array<{ content: string }> }).content[0]!.content;
    // 换行保留（含空行），行首缩进 4 空格→1 空格，连续空格折叠为单空格。
    expect(out).toBe('def f():\n return 1\n\n x = 2');
  });

  it('连续空格/制表符折叠为单空格', () => {
    const r = compactMessages([{ role: 'user', content: 'a    b\t\tc' }] as unknown[], 8000);
    expect(r.compressed).toBe(true);
    expect(r.messages[0]).toEqual({ role: 'user', content: 'a b c' });
  });

  it('短文本不折叠不截断（compressed=false）', () => {
    const messages = [{ role: 'user', content: 'hello world' }] as unknown[];
    const r = compactMessages(messages, 8000);
    expect(r.compressed).toBe(false);
    expect(r.messages[0]).toEqual({ role: 'user', content: 'hello world' });
  });
});

describe('compactMessages 码点截断（M-P2-3：UTF-16 slice 修复）', () => {
  it('4 字节字符截断不切出孤立 surrogate', () => {
    // 旧实现 `out.slice(0, max)` 按 UTF-16 code unit 切，max=3 会切出
    // 第 3 个 emoji 的高位 surrogate（孤立代理），客户端解不了码。
    const messages = [{ role: 'user', content: '😀😀😀😀😀' }] as unknown[];
    const r = compactMessages(messages, 3);
    expect(r.compressed).toBe(true);
    const out = (messages[0] as { content: string }).content;
    expect(out).toBe('😀😀😀' + TRUNCATE_MARK);
    // 不许残留孤立 surrogate（高位代理后必须跟低位代理）。
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('截断按码点数而非码元数', () => {
    const r = compactMessages([{ role: 'user', content: 'a😀b😀c' }] as unknown[], 4);
    const out = (r.messages[0] as { content: string }).content;
    // 前 4 个码点 = a 😀 b 😀，之后接省略标记。
    expect(out).toBe('a😀b😀' + TRUNCATE_MARK);
    expect([...out].length).toBe(4 + [...TRUNCATE_MARK].length);
  });
});

describe('estimateBytes', () => {
  it('按 UTF-8 字节估算（中文多字节）', () => {
    expect(estimateBytes('hi')).toBe(2);
    expect(estimateBytes('你好')).toBe(6);
  });
});
