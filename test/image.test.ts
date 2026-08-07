import { describe, expect, it } from 'vitest';
import { isPrivateUrl, openAIImageToAnthropic } from '../src/image.js';

describe('isPrivateUrl IPv6', () => {
  it('IPv4-mapped（::ffff:127.0.0.1 / ::ffff:10.0.0.1）判私网', () => {
    expect(isPrivateUrl('http://[::ffff:127.0.0.1]/x.png')).toBe(true);
    expect(isPrivateUrl('http://[::ffff:10.0.0.1]/x.png')).toBe(true);
  });

  it('ULA（fc00::/7）判私网', () => {
    expect(isPrivateUrl('http://[fc00::1]/x.png')).toBe(true);
    expect(isPrivateUrl('http://[fd00::1]/x.png')).toBe(true);
  });

  it('link-local（fe80::/10）判私网', () => {
    expect(isPrivateUrl('http://[fe80::1]/x.png')).toBe(true);
  });

  it('::1 判私网', () => {
    expect(isPrivateUrl('http://[::1]/x.png')).toBe(true);
  });

  it('公网 IPv6 放行', () => {
    expect(isPrivateUrl('http://[2606:4700:4700::1111]/x.png')).toBe(false);
  });
});

describe('openAIImageToAnthropic', () => {
  it('非 base64 data URI 含非法 % 转义（%zz）不崩溃，返回 null', () => {
    expect(openAIImageToAnthropic({ url: 'data:image/svg+xml,<svg>%zz</svg>' })).toBeNull();
  });

  it('IPv6 私网 URL 不转 url source（SSRF 防护）', () => {
    expect(openAIImageToAnthropic({ url: 'http://[::ffff:127.0.0.1]/x.png' })).toBeNull();
    expect(openAIImageToAnthropic({ url: 'http://[fd00::1]/x.png' })).toBeNull();
  });

  it('合法 base64 data URI 转 base64 source', () => {
    const img = openAIImageToAnthropic({ url: 'data:image/png;base64,iVBORw0KGgo=' });
    expect(img).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    });
  });

  it('公网 http(s) URL 转 url source', () => {
    expect(openAIImageToAnthropic({ url: 'https://example.com/a.png' })).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/a.png' },
    });
  });
});
