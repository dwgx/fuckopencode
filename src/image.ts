import type { AnthropicContentBlock } from './types.js';

/** 解析 IPv4 点分字符串为 32 位整数；非 4 段或非法段返回 null。 */
function parseIpv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

/** 32 位 IPv4 是否为私网/保留/环回地址（127/8、10/8、172.16/12、192.168/16、169.254/16、0.0.0.0）。 */
function isPrivateIpv4(v4: number): boolean {
  if (v4 === 0) return true; // 0.0.0.0/8
  if (v4 >>> 24 === 127) return true; // 127.0.0.0/8
  if (v4 >>> 24 === 10) return true; // 10.0.0.0/8
  if (v4 >>> 20 === 0xac1) return true; // 172.16.0.0/12
  if (v4 >>> 16 === 0xc0a8) return true; // 192.168.0.0/16
  if (v4 >>> 16 === 0xa9fe) return true; // 169.254.0.0/16（含 metadata）
  return false;
}

/** 从 IPv4-mapped（::ffff:x.x.x.x 或 ::ffff:xxxx:xxxx）尾部解析内嵌 IPv4；非 mapped 形态返回 null。 */
function parseMappedIpv4(addr: string): number | null {
  const mapped = /^::ffff:(.+)$/i.exec(addr);
  if (!mapped) return null;
  const tail = mapped[1]!;
  // 尾部的点分形式（如 ::ffff:127.0.0.1）。
  const dotted = parseIpv4(tail);
  if (dotted != null) return dotted;
  // Node 会把 ::ffff:127.0.0.1 规范化为 ::ffff:7f00:1 —— 末 32 位是十六进制 IPv4。
  const lastHextets = tail.split(':').slice(-2);
  const hex = lastHextets.map((h) => h.padStart(4, '0')).join('');
  if (!/^[0-9a-f]{8}$/i.test(hex)) return null;
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n >>> 0 : null;
}

/**
 * IPv6 字面量是否指向私网/保留地址：
 * - ::1（环回）
 * - ::ffff:x.x.x.x（IPv4-mapped，按内嵌 IPv4 判断）
 * - fc00::/7（ULA）
 * - fe80::/10（link-local）
 */
function isPrivateIpv6(host: string): boolean {
  let addr = host;
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  addr = addr.split('%')[0]!.toLowerCase(); // 去掉 zone id（如 fe80::1%eth0）
  if (!addr.includes(':')) return false;
  if (addr === '::1') return true;

  const mappedV4 = parseMappedIpv4(addr);
  if (mappedV4 != null) return isPrivateIpv4(mappedV4);

  // ULA fc00::/7 与 link-local fe80::/10：看首 hextet 的位模式。
  const firstHex = /^[0-9a-f]{1,4}/.exec(addr);
  if (firstHex) {
    const first = Number.parseInt(firstHex[0]!, 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  }
  return false;
}

/**
 * 判断 URL 是否指向私网/保留/环回地址（上游代为抓取会构成 SSRF 放大器）。
 * 命中 IPv4 私网段、IPv6 的 ::1 / IPv4-mapped / ULA / link-local、
 * localhost、0.0.0.0 时返回 true；无法解析的 URL 一律视为不安全返回 true。
 * 非 IP 字面量的域名字符串按公网放行（简单判断）。
 */
export function isPrivateUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // 无法解析的 URL 视为不安全，不交给上游。
    return true;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost') return true;
  if (host.includes(':')) return isPrivateIpv6(host);
  const v4 = parseIpv4(host);
  if (v4 == null) return false; // 域名（非 IP 字面量）：放行
  return isPrivateIpv4(v4);
}

/**
 * OpenAI image_url（data URI 或 http(s) URL）→ Anthropic image block。
 *
 * - `data:image/png;base64,...` → base64 source（解析 media_type，去 base64 标记）。
 * - `data:image/svg+xml,...`（未 base64，urlencoded）→ 按 UTF-8 转 base64 后走 base64 source。
 * - `https://...` → url source；但私网/保留/环回地址直接返回 null（SSRF 防护）。
 * - 无法识别的 URL 返回 null（调用方应丢弃）。
 */
export function openAIImageToAnthropic(imageUrl: { url: string; detail?: string }): AnthropicContentBlock | null {
  const url = imageUrl.url;
  if (url.startsWith('data:')) {
    const match = /^data:([^,]*),(.*)$/s.exec(url);
    if (!match) return null;
    const header = match[1] ?? '';
    const data = match[2] ?? '';
    const parts = header.split(';');
    const isBase64 = parts.includes('base64');
    const mediaType = parts.find((p) => p.includes('/')) ?? 'image/png';
    if (isBase64) {
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    }
    // 非 base64 data URI（如 URL-encoded 文本/SVG）：Anthropic 只收 base64。
    let decoded: string;
    try {
      decoded = decodeURIComponent(data);
    } catch {
      // 非法 % 转义（如 %zz）会抛 URI malformed；视为不可用返回 null。
      return null;
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: Buffer.from(decoded, 'utf8').toString('base64') },
    };
  }
  if (/^https?:\/\//.test(url)) {
    if (isPrivateUrl(url)) return null; // 私网/保留段：不转 url source
    return { type: 'image', source: { type: 'url', url } };
  }
  return null;
}
