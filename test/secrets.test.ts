import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSecret } from '../src/secrets.js';
import type { AppConfig } from '../src/config.js';

let tmpDir: string;
/** 静音日志，只在断言告警时才看。 */
const logs: string[] = [];
const log = (m: string): void => void logs.push(m);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-secrets-'));
  logs.length = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 最小 AppConfig：只带 secrets 相关字段，其余字段本模块用不到。 */
function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    gatewaySecret: null,
    secretFilePath: path.join(tmpDir, 'secret.key'),
    ...over,
  } as unknown as AppConfig;
}

describe('loadSecret / SecretKey 加解密', () => {
  it('roundtrip：encrypt 后 decrypt 还原原文', () => {
    const sk = loadSecret(cfg({ gatewaySecret: 'test-secret' }), log)!;
    expect(sk).not.toBeNull();
    const ct = sk.encrypt('sk-ant-xxxx');
    expect(ct.startsWith('1:')).toBe(true);
    expect(sk.decrypt(ct)).toBe('sk-ant-xxxx');
    expect(logs).toHaveLength(0);
  });

  it('输出格式 `1:<base64(iv‖tag‖ct)>`：IV 12 字节、tag 16 字节', () => {
    const sk = loadSecret(cfg({ gatewaySecret: 'test-secret' }), log)!;
    const raw = Buffer.from(sk.encrypt('hi').slice(2), 'base64');
    expect(raw.length).toBe(12 + 16 + 2); // iv + tag + 密文「hi」
  });

  it('错 key 解密返回 null（不抛）', () => {
    const a = loadSecret(cfg({ gatewaySecret: 'secret-a' }), log)!;
    const b = loadSecret(cfg({ gatewaySecret: 'secret-b' }), log)!;
    expect(b.decrypt(a.encrypt('sk-1'))).toBeNull();
  });

  it('坏格式一律 null：无前缀/错前缀/截断/非法 base64/垃圾输入', () => {
    const sk = loadSecret(cfg({ gatewaySecret: 'test-secret' }), log)!;
    expect(sk.decrypt('')).toBeNull();
    expect(sk.decrypt('2:' + Buffer.alloc(30).toString('base64'))).toBeNull();
    expect(sk.decrypt('1:')).toBeNull();
    expect(sk.decrypt('1:!!!not-base64!!!')).toBeNull();
    expect(sk.decrypt('1:' + Buffer.alloc(10).toString('base64'))).toBeNull(); // 不足 iv+tag
    expect(sk.decrypt('plain text')).toBeNull();
  });

  it('篡改密文（翻转 payload 一个字节）→ GCM 认证失败返回 null', () => {
    const sk = loadSecret(cfg({ gatewaySecret: 'test-secret' }), log)!;
    const ct = sk.encrypt('sk-ant-secret');
    const raw = Buffer.from(ct.slice(2), 'base64');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0x01;
    expect(sk.decrypt('1:' + raw.toString('base64'))).toBeNull();
  });

  it('加密永不抛：大输入也返回字符串', () => {
    const sk = loadSecret(cfg({ gatewaySecret: 'test-secret' }), log)!;
    expect(typeof sk.encrypt('x'.repeat(10_000))).toBe('string');
  });
});

describe('secret 文件自动生成与读取', () => {
  it('文件不存在 → 自动生成：0600、32 字节 base64，重复加载幂等', () => {
    const p = path.join(tmpDir, 'secret.key');
    const sk1 = loadSecret(cfg({ secretFilePath: p }), log)!;
    expect(sk1).not.toBeNull();
    expect(fs.existsSync(p)).toBe(true);
    // 创建时显式 chmod 兜 umask：权限必须恰好 0600
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    const content = fs.readFileSync(p, 'utf8');
    expect(Buffer.from(content, 'base64').length).toBe(32);

    // 二次加载读到的是同一把 key：A 加密的密文 B 能解
    const sk2 = loadSecret(cfg({ secretFilePath: p }), log)!;
    expect(sk2.decrypt(sk1.encrypt('sk-1'))).toBe('sk-1');
    // 成功路径不该刷告警
    expect(logs).toHaveLength(0);
  });

  it('父目录不存在也能建（data/ 首启场景）', () => {
    const p = path.join(tmpDir, 'nested', 'deep', 'secret.key');
    const sk = loadSecret(cfg({ secretFilePath: p }), log)!;
    expect(sk).not.toBeNull();
    expect(fs.existsSync(p)).toBe(true);
  });

  it('已存在但权限比 0600 宽松 → 打 warn，不静默改权限', () => {
    const p = path.join(tmpDir, 'secret.key');
    fs.writeFileSync(p, 'loose-perms-secret', { mode: 0o644 });
    const sk = loadSecret(cfg({ secretFilePath: p }), log)!;
    expect(sk).not.toBeNull();
    expect(logs.some((l) => l.includes('0600'))).toBe(true);
    // 权限保持原样（留给运维决定，不静默 chmod）
    expect(fs.statSync(p).mode & 0o777).toBe(0o644);
  });

  it('读不了（chmod 000）→ 返回 null，不生成新文件覆盖', () => {
    const p = path.join(tmpDir, 'secret.key');
    fs.writeFileSync(p, 'unreadable', { mode: 0o600 });
    fs.chmodSync(p, 0o000);
    const sk = loadSecret(cfg({ secretFilePath: p }), log)!;
    expect(sk).toBeNull();
    expect(logs.some((l) => l.includes('失败'))).toBe(true);
    fs.chmodSync(p, 0o600); // 清理，否则 afterEach 删不掉
  });

  it('文件内容为空 → 返回 null', () => {
    const p = path.join(tmpDir, 'secret.key');
    fs.writeFileSync(p, '   \n ');
    expect(loadSecret(cfg({ secretFilePath: p }), log)).toBeNull();
    expect(logs.some((l) => l.includes('为空'))).toBe(true);
  });

  it('GATEWAY_SECRET env 优先：有 env 就不碰 secret 文件', () => {
    const p = path.join(tmpDir, 'secret.key');
    const sk = loadSecret(cfg({ gatewaySecret: 'from-env', secretFilePath: p }), log)!;
    expect(sk).not.toBeNull();
    expect(fs.existsSync(p)).toBe(false);
  });
});
