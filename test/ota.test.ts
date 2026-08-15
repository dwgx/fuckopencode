import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  checkUpdate,
  compareVersions,
  downloadAsset,
  fetchReleaseChecksum,
  fetchTags,
  isValidVersionTag,
  parseChecksum,
  performUpdate,
  replaceDist,
  renameSyncWithRetry,
  resetOtaState,
  startOtaCheck,
  verifyAndExtractTar,
  verifyChecksum,
} from '../src/ota.js';
import { readBootAttempts, writeBootAttempts, clearBootAttempts, confirmHealth, readStatus, clearStaleLock } from '../src/ota-guard.js';

const execFileP = promisify(execFile);

/** 等一个宏任务：performUpdate 的 scheduleRestart 现在是延后触发的（O-I6）。 */
function flushMacrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 用真实 tar 在临时目录构建 fixture。 */

async function runTar(args: string[], cwd: string): Promise<void> {
  await execFileP('tar', args, { cwd });
}

async function isBsdtar(): Promise<boolean> {
  const { stdout } = await execFileP('tar', ['--version']);
  return stdout.includes('bsdtar');
}

/** 标准发布包：顶层 dist/ 含 main.js/keypool.js/dsml.js/version.txt。 */
async function buildValidTar(base: string, outTar: string, version = '1.2.3'): Promise<void> {
  fs.mkdirSync(path.join(base, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(base, 'dist', 'main.js'), '// main\n');
  fs.writeFileSync(path.join(base, 'dist', 'keypool.js'), '// keypool\n');
  fs.writeFileSync(path.join(base, 'dist', 'dsml.js'), '// dsml\n');
  fs.writeFileSync(path.join(base, 'dist', 'version.txt'), `${version}\n`);
  await runTar(['-czf', outTar, '-C', base, 'dist'], base);
}

async function makeDistTar(): Promise<{ tarBytes: Buffer; sha256: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-dist-'));
  const tar = path.join(dir, 'pkg.tar.gz');
  await buildValidTar(dir, tar);
  const bytes = fs.readFileSync(tar);
  fs.rmSync(dir, { recursive: true, force: true });
  return { tarBytes: bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function makeEvilTar(kind: 'dotdot' | 'abs' | 'symlink'): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-evil-'));
  try {
    if (kind === 'dotdot') {
      fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'dist', 'evil.txt'), 'evil\n');
      const args = (await isBsdtar())
        ? ['-czf', 'evil.tgz', '-s', '|dist/evil.txt|../evil.txt|', 'dist/evil.txt']
        : ['-czf', 'evil.tgz', '--transform', 's|dist/evil.txt|../evil.txt|', 'dist/evil.txt'];
      await runTar(args, dir);
    } else if (kind === 'abs') {
      const absFile = path.join(dir, 'absfile.txt');
      fs.writeFileSync(absFile, 'abs\n');
      // 从 / 打包保留绝对路径条目（两个 tar 都支持 -P）。
      await runTar(['-czf', path.join(dir, 'evil.tgz'), '-P', absFile], '/');
    } else {
      fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
      fs.symlinkSync('/etc/hosts', path.join(dir, 'dist', 'link'));
      fs.writeFileSync(path.join(dir, 'dist', 'main.js'), '// main\n');
      await runTar(['-czf', 'evil.tgz', '-C', dir, 'dist'], dir);
    }
    return fs.readFileSync(path.join(dir, 'evil.tgz'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ota-root-'));
}

/** 造一个带旧版本的临时项目根（dist/version.txt + 关键文件）。 */
function seedOldDist(root: string, version = '1.0.0'): void {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'version.txt'), `${version}\n`);
  fs.writeFileSync(path.join(root, 'dist', 'main.js'), '// old main\n');
  fs.writeFileSync(path.join(root, 'dist', 'keypool.js'), '// old keypool\n');
  fs.writeFileSync(path.join(root, 'dist', 'dsml.js'), '// old dsml\n');
}

function tagsResponse(tags: string[]): Response {
  return new Response(JSON.stringify(tags.map((name) => ({ name }))), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let roots: string[] = [];
let timers: Array<ReturnType<typeof setTimeout>> = [];

beforeEach(() => {
  resetOtaState();
});

afterEach(() => {
  resetOtaState();
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  }
  roots = [];
  for (const t of timers) clearTimeout(t);
  timers = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('isValidVersionTag 白名单', () => {
  it('接受 v?X.Y.Z 1-4 段纯数字', () => {
    for (const ok of ['v1.2.3', '1.2.3', 'v1', '1', 'v0.0.0', 'v1.2.3.4', 'v10.20.30']) {
      expect(isValidVersionTag(ok), ok).toBe(true);
    }
  });

  it('拒绝路径注入 / 超段 / 非纯数字', () => {
    for (const bad of ['../evil', 'v1.2.3.4.5', '1.2.3.4.5', 'abc', 'v1.2.x', '1..2', 'v1.2.3/', 'v1.2.3/../../x', 'V1.2.3', '']) {
      expect(isValidVersionTag(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isValidVersionTag(null)).toBe(false);
    expect(isValidVersionTag(undefined)).toBe(false);
  });
});

describe('compareVersions', () => {
  it('基本比较', () => {
    expect(compareVersions('v1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('1.2.3', 'v1.2.3')).toBe(0);
    expect(compareVersions('v2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('v0.9', 'v0.10')).toBe(-1);
    expect(compareVersions('v1.2.3.4', 'v1.2.3.5')).toBe(-1);
    expect(compareVersions('v1.2.3.5', 'v1.2.3.4')).toBe(1);
  });

  it('降序排序用', () => {
    const tags = ['v1.0.0', 'v1.2.3', 'v0.9.0'].sort((a, b) => compareVersions(b, a));
    expect(tags).toEqual(['v1.2.3', 'v1.0.0', 'v0.9.0']);
  });
});

describe('fetchTags 镜像链 / token / 缓存', () => {
  it('镜像全挂 → 直连兜底，结果 semver 降序', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('gh-proxy')) return new Response('nope', { status: 502 });
      return tagsResponse(['v1.0.0', 'v1.2.3', 'not-a-tag', 'v1.0']);
    });
    const tags = await fetchTags({ fetchImpl });
    expect(tags).toEqual(['v1.2.3', 'v1.0.0', 'v1.0']);
    // 顺序：4 个 gh-proxy 镜像在前，直连 api.github.com 兜底在后。
    expect(calls[0]).toBe('https://gh-proxy.org/https://api.github.com/repos/dwgx/fuckopencode/tags');
    expect(calls.at(-1)).toBe('https://api.github.com/repos/dwgx/fuckopencode/tags');
    // 非法 tag（not-a-tag）被白名单过滤。
    expect(tags).not.toContain('not-a-tag');
  });

  it('全镜像 + 直连都失败 → []', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const tags = await fetchTags({ fetchImpl });
    expect(tags).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(5); // 4 镜像 + 直连
  });

  it('有 token 时只走直连（绝不过镜像）', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return tagsResponse(['v1.2.3']);
    });
    await fetchTags({ fetchImpl, token: 'sekrit' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('https://api.github.com/repos/dwgx/fuckopencode/tags');
    expect(calls[0]).not.toMatch(/gh-proxy/);
  });

  it('60s 缓存只缓存成功，TTL 由注入时钟控制', async () => {
    let nowMs = 1000;
    const now = () => nowMs;
    const fetchImpl = vi.fn(async () => tagsResponse(['v1.2.3']));
    const t1 = await fetchTags({ fetchImpl, now });
    expect(t1).toEqual(['v1.2.3']);
    const afterFirst = fetchImpl.mock.calls.length;
    // TTL 内：命中缓存，不再请求。
    const t2 = await fetchTags({ fetchImpl, now });
    expect(t2).toEqual(['v1.2.3']);
    expect(fetchImpl.mock.calls.length).toBe(afterFirst);
    // 过 TTL：重新请求。
    nowMs += 61_000;
    await fetchTags({ fetchImpl, now });
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('失败不缓存：全挂后再次调用仍重试', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    await fetchTags({ fetchImpl });
    const afterFirst = fetchImpl.mock.calls.length;
    await fetchTags({ fetchImpl });
    expect(fetchImpl.mock.calls.length).toBe(afterFirst * 2);
  });

  it('force（cache: null）绕过缓存', async () => {
    let nowMs = 1000;
    const now = () => nowMs;
    const fetchImpl = vi.fn(async () => tagsResponse(['v1.2.3']));
    await fetchTags({ fetchImpl, now });
    const afterFirst = fetchImpl.mock.calls.length;
    await fetchTags({ fetchImpl, now, cache: null });
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('OTA_REPO 白名单：非法值回落默认', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return tagsResponse(['v1.2.3']);
    });
    await fetchTags({ fetchImpl, repo: '../evil/../x', cache: null });
    expect(calls[0]).toBe('https://gh-proxy.org/https://api.github.com/repos/dwgx/fuckopencode/tags');
  });
});

describe('checkUpdate', () => {
  it('远端更新时 hasUpdate=true', async () => {
    const root = tempRoot();
    roots.push(root);
    seedOldDist(root, '1.0.0');
    const s = await checkUpdate({ root, fetchImpl: vi.fn(async () => tagsResponse(['v1.2.3', 'v1.0.0'])), cache: null });
    expect(s.current).toBe('1.0.0');
    expect(s.latest).toBe('v1.2.3');
    expect(s.hasUpdate).toBe(true);
    expect(s.enabled).toBe(true);
  });

  it('无更新/降级时 hasUpdate=false（只升不降）', async () => {
    const root = tempRoot();
    roots.push(root);
    seedOldDist(root, '2.0.0');
    const s = await checkUpdate({ root, fetchImpl: vi.fn(async () => tagsResponse(['v1.2.3'])), cache: null });
    expect(s.hasUpdate).toBe(false);
  });

  it('全失败 → error 非空，hasUpdate=false（不阻塞面板）', async () => {
    const root = tempRoot();
    roots.push(root);
    seedOldDist(root, '1.0.0');
    const s = await checkUpdate({ root, fetchImpl: vi.fn(async () => new Response('x', { status: 500 })), cache: null });
    expect(s.error).toBeTruthy();
    expect(s.hasUpdate).toBe(false);
  });

  it('enabled 透传（OTA_ENABLED=0 时面板只读状态照常）', async () => {
    const root = tempRoot();
    roots.push(root);
    seedOldDist(root, '1.0.0');
    const s = await checkUpdate({ root, enabled: false, fetchImpl: vi.fn(async () => tagsResponse(['v1.2.3'])), cache: null });
    expect(s.enabled).toBe(false);
    expect(s.latest).toBe('v1.2.3');
  });
});

describe('downloadAsset 流式 + 上限', () => {
  it('成功：写盘 + 返回增量 sha256', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-dl-'));
    roots.push(dir);
    const payload = Buffer.from('hello ota payload');
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(payload), { status: 200 }));
    const sha = await downloadAsset({ fetchImpl, tag: 'v1.2.3', destPath: path.join(dir, 'bundle.tar.gz') });
    expect(sha).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(fs.readFileSync(path.join(dir, 'bundle.tar.gz'))).toEqual(payload);
  });

  it('content-length 超限 → 422（不试下一镜像）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-dl-'));
    roots.push(dir);
    const fetchImpl = vi.fn(async () => new Response('x', { status: 200, headers: { 'content-length': '99999999' } }));
    await expect(downloadAsset({ fetchImpl, tag: 'v1.2.3', destPath: path.join(dir, 'b.tar.gz'), capBytes: 10 })).rejects.toMatchObject({ httpStatus: 422 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('流式累计超限 → 422 截断（不清空已写文件已无关，重点是拒绝）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-dl-'));
    roots.push(dir);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(1000, 0x61));
        controller.enqueue(Buffer.alloc(1000, 0x62));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
    await expect(downloadAsset({ fetchImpl, tag: 'v1.2.3', destPath: path.join(dir, 'b.tar.gz'), capBytes: 1500 })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('镜像失败 → 下一镜像兜底成功', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-dl-'));
    roots.push(dir);
    const calls: string[] = [];
    const payload = Buffer.from('ok');
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (calls.length === 1) return new Response('nope', { status: 404 });
      return new Response(new Uint8Array(payload), { status: 200 });
    });
    const sha = await downloadAsset({ fetchImpl, tag: 'v1.2.3', destPath: path.join(dir, 'b.tar.gz') });
    expect(sha).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toContain('gh-proxy.org');
  });
});

describe('checksum 独立信道 + 校验', () => {
  it('sha256 只从 github.com 直连取', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return new Response('a'.repeat(64) + '  x\n', { status: 200 });
    });
    const txt = await fetchReleaseChecksum({ fetchImpl, tag: 'v1.2.3', destPath: 'unused' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('https://github.com/dwgx/fuckopencode/releases/download/v1.2.3/fuckopencode-v1.2.3-dist.tar.gz.sha256');
    expect(txt).toContain('a'.repeat(64));
  });

  it('直连失败 → 502 中止（绝不过镜像）', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(fetchReleaseChecksum({ fetchImpl, tag: 'v1.2.3', destPath: 'unused' })).rejects.toMatchObject({ httpStatus: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('O-I3：校验文件超 4096 字节 → 502（流式读限长，不 arrayBuffer 全量载入）', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(5000), { status: 200 }));
    await expect(fetchReleaseChecksum({ fetchImpl, tag: 'v1.2.3', destPath: 'unused' })).rejects.toMatchObject({ httpStatus: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('parseChecksum：合法 64hex 通过，非法为 null', () => {
    expect(parseChecksum('ab'.repeat(32) + '  pkg.tar.gz\n')).toBe('ab'.repeat(32));
    expect(parseChecksum('abc')).toBeNull();
    expect(parseChecksum('')).toBeNull();
    expect(parseChecksum('g'.repeat(64))).toBeNull();
  });

  it('比对不等 → 422', () => {
    expect(() => verifyChecksum('a'.repeat(64), 'a'.repeat(64))).not.toThrow();
    expect(() => verifyChecksum('a'.repeat(64), 'b'.repeat(64))).toThrowError(/sha256 mismatch/);
    try {
      verifyChecksum('a'.repeat(64), 'b'.repeat(64));
    } catch (err) {
      expect((err as { httpStatus: number }).httpStatus).toBe(422);
    }
  });
});

describe('verifyAndExtractTar（真实 tar）', () => {
  async function extractInTemp(tarBytes: Buffer, expectedTag: string, extra?: Partial<Parameters<typeof verifyAndExtractTar>[0]>): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-vx-'));
    roots.push(dir);
    const tarPath = path.join(dir, 'bundle.tar.gz');
    fs.writeFileSync(tarPath, tarBytes);
    const outDir = path.join(dir, 'out');
    await verifyAndExtractTar({ tarPath, outDir, expectedTag, ...extra });
    return outDir;
  }

  it('合法包解包成功：必需文件齐全 + version.txt==tag', async () => {
    const { tarBytes } = await makeDistTar();
    const outDir = await extractInTemp(tarBytes, 'v1.2.3');
    for (const f of ['main.js', 'keypool.js', 'dsml.js', 'version.txt']) {
      expect(fs.existsSync(path.join(outDir, f)), f).toBe(true);
    }
    expect(fs.readFileSync(path.join(outDir, 'version.txt'), 'utf8').trim()).toBe('1.2.3');
  });

  it('../ 条目 → 422', async () => {
    const tarBytes = await makeEvilTar('dotdot');
    await expect(extractInTemp(tarBytes, 'v1.2.3')).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('绝对路径条目 → 422', async () => {
    const tarBytes = await makeEvilTar('abs');
    await expect(extractInTemp(tarBytes, 'v1.2.3')).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('symlink 条目 → 422', async () => {
    const tarBytes = await makeEvilTar('symlink');
    await expect(extractInTemp(tarBytes, 'v1.2.3')).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('O-P2-1：symlink 条目在解包前被拒（outDir 从未创建）', async () => {
    const tarBytes = await makeEvilTar('symlink');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-vx-'));
    roots.push(dir);
    const tarPath = path.join(dir, 'bundle.tar.gz');
    fs.writeFileSync(tarPath, tarBytes);
    const outDir = path.join(dir, 'out');
    await expect(verifyAndExtractTar({ tarPath, outDir, expectedTag: 'v1.2.3' })).rejects.toMatchObject({ httpStatus: 422 });
    // 预读阶段（-tvzf）就拒绝：任何东西都没落盘。
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it('version.txt != tag（反投毒）→ 422', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-vx-'));
    roots.push(dir);
    const tar = path.join(dir, 'x.tar.gz');
    await buildValidTar(dir, tar, '9.9.9');
    const outDir = path.join(dir, 'out');
    await expect(verifyAndExtractTar({ tarPath: tar, outDir, expectedTag: 'v1.2.3' })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('缺必需文件 → 422', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-vx-'));
    roots.push(dir);
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'main.js'), '// main\n');
    fs.writeFileSync(path.join(dir, 'dist', 'version.txt'), '1.2.3\n');
    await runTar(['-czf', 'x.tar.gz', '-C', dir, 'dist'], dir);
    const outDir = path.join(dir, 'out');
    await expect(verifyAndExtractTar({ tarPath: path.join(dir, 'x.tar.gz'), outDir, expectedTag: 'v1.2.3' })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('超条目数（zip-bomb 防线）→ 422', async () => {
    const { tarBytes } = await makeDistTar();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-vx-'));
    roots.push(dir);
    const tarPath = path.join(dir, 'bundle.tar.gz');
    fs.writeFileSync(tarPath, tarBytes);
    const outDir = path.join(dir, 'out');
    await expect(verifyAndExtractTar({ tarPath, outDir, expectedTag: 'v1.2.3', entryCap: 2 })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('解包总量超限 → 422', async () => {
    const { tarBytes } = await makeDistTar();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-vx-'));
    roots.push(dir);
    const tarPath = path.join(dir, 'bundle.tar.gz');
    fs.writeFileSync(tarPath, tarBytes);
    const outDir = path.join(dir, 'out');
    await expect(verifyAndExtractTar({ tarPath, outDir, expectedTag: 'v1.2.3', extractCap: 10 })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('O-P2-2：超预算在解包前被拒（outDir 从未创建）', async () => {
    const { tarBytes } = await makeDistTar();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-vx-'));
    roots.push(dir);
    const tarPath = path.join(dir, 'bundle.tar.gz');
    fs.writeFileSync(tarPath, tarBytes);
    const outDir = path.join(dir, 'out');
    await expect(verifyAndExtractTar({ tarPath, outDir, expectedTag: 'v1.2.3', extractCap: 10 })).rejects.toMatchObject({ httpStatus: 422 });
    // 预读阶段（-tvzf 累计条目大小）就拒绝：高压缩比归档不会先填盘再被拒。
    expect(fs.existsSync(outDir)).toBe(false);
  });
});

describe('replaceDist 原子替换 + 反向回滚', () => {
  it('正常轮转：新 dist 就位，旧版进 dist.prev', () => {
    const root = tempRoot();
    roots.push(root);
    seedOldDist(root, '1.0.0');
    const out = path.join(root, '.ota-tmp', 'out');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'version.txt'), '1.2.3\n');
    fs.writeFileSync(path.join(out, 'main.js'), '// new main\n');
    fs.writeFileSync(path.join(out, 'keypool.js'), '// new keypool\n');
    replaceDist(root, out);
    expect(fs.readFileSync(path.join(root, 'dist', 'version.txt'), 'utf8').trim()).toBe('1.2.3');
    expect(fs.readFileSync(path.join(root, 'dist.prev', 'version.txt'), 'utf8').trim()).toBe('1.0.0');
  });

  it('替换后关键产物缺失 → 反向回滚 + 500', () => {
    const root = tempRoot();
    roots.push(root);
    seedOldDist(root, '1.0.0');
    const out = path.join(root, '.ota-tmp', 'out');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'version.txt'), '1.2.3\n');
    fs.writeFileSync(path.join(out, 'main.js'), '// new main\n');
    // 缺 keypool.js → 替换后校验失败。
    try {
      replaceDist(root, out);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { httpStatus: number }).httpStatus).toBe(500);
    }
    // 反向回滚：旧 dist 恢复，dist.prev 已消费。
    expect(fs.readFileSync(path.join(root, 'dist', 'version.txt'), 'utf8').trim()).toBe('1.0.0');
    expect(fs.existsSync(path.join(root, 'dist.prev'))).toBe(false);
  });

  it('rename 目标失败 → 反向恢复旧 dist', () => {
    const root = tempRoot();
    roots.push(root);
    seedOldDist(root, '1.0.0');
    // out 不存在 → renameSyncWithRetry(out, dist) 抛 ENOENT → 反向恢复。
    try {
      replaceDist(root, path.join(root, '.ota-tmp', 'missing-out'));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { httpStatus: number }).httpStatus).toBe(500);
    }
    expect(fs.readFileSync(path.join(root, 'dist', 'version.txt'), 'utf8').trim()).toBe('1.0.0');
  });
});

describe('performUpdate 全链路（S3+S4）', () => {
  async function happyFetch(tarBytes: Buffer, sha256: string): Promise<{ fetchImpl: (url: string, init?: RequestInit) => Promise<Response>; calls: string[] }> {
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url.includes('/tags')) return tagsResponse(['v1.2.3', 'v1.0.0']);
      if (url.endsWith('.tar.gz.sha256')) return new Response(`${sha256}  fuckopencode-v1.2.3-dist.tar.gz\n`, { status: 200 });
      if (url.endsWith('.tar.gz')) return new Response(new Uint8Array(tarBytes), { status: 200 });
      return new Response('{}', { status: 200 });
    };
    return { fetchImpl, calls };
  }

  it('成功：下载→校验→解包→替换→安排重启', async () => {
    const { tarBytes, sha256 } = await makeDistTar();
    const { fetchImpl, calls } = await happyFetch(tarBytes, sha256);
    const root = tempRoot();
    roots.push(root);
    seedOldDist(root, '1.0.0');
    const restarted = vi.fn();
    const result = await performUpdate({
      enabled: true,
      root,
      fetchImpl,
      hasSupervisor: () => true,
      scheduleRestart: restarted,
    });
    expect(result).toEqual({ updated: true, before: '1.0.0', after: 'v1.2.3', restart: 'scheduled' });
    // scheduleRestart 延后到宏任务（O-I6：响应 200 发出后才触发）。
    await flushMacrotasks();
    expect(restarted).toHaveBeenCalledTimes(1);
    // dist 已替换为新版本，旧版在 dist.prev。
    expect(fs.readFileSync(path.join(root, 'dist', 'version.txt'), 'utf8').trim()).toBe('1.2.3');
    expect(fs.readFileSync(path.join(root, 'dist', 'main.js'), 'utf8')).toBe('// main\n');
    expect(fs.readFileSync(path.join(root, 'dist.prev', 'version.txt'), 'utf8').trim()).toBe('1.0.0');
    // 阶段目录与锁已清理。
    expect(fs.existsSync(path.join(root, '.ota-tmp'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.ota-lock'))).toBe(false);
    // 下载确实走了镜像链 + 直连兜底。
    expect(calls.some((u) => u.includes('gh-proxy.org'))).toBe(true);
  });

  it('OTA_ENABLED=0 → 403', async () => {
    await expect(performUpdate({ enabled: false, root: tempRoot() })).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('无更新/降级 → 409', async () => {
    const root = tempRoot();
    roots.push(root);
    seedOldDist(root, '9.9.9');
    await expect(performUpdate({ enabled: true, root, fetchImpl: vi.fn(async () => tagsResponse(['v1.2.3'])) })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('无 supervisor（裸跑）→ 409，文件未动', async () => {
    const root = tempRoot();
    roots.push(root);
    seedOldDist(root, '1.0.0');
    await expect(performUpdate({
      enabled: true,
      root,
      fetchImpl: vi.fn(async () => tagsResponse(['v1.2.3'])),
      hasSupervisor: () => false,
    })).rejects.toMatchObject({ httpStatus: 409 });
    expect(fs.existsSync(path.join(root, 'dist.prev'))).toBe(false);
  });

  it('.ota-lock 已存在 → 409', async () => {
    const root = tempRoot();
    roots.push(root);
    seedOldDist(root, '1.0.0');
    fs.writeFileSync(path.join(root, '.ota-lock'), '');
    await expect(performUpdate({ enabled: true, root, fetchImpl: vi.fn(async () => tagsResponse(['v1.2.3'])) })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('sha256 不匹配 → 422，dist 未动', async () => {
    const { tarBytes } = await makeDistTar();
    const { fetchImpl } = await happyFetch(tarBytes, 'f'.repeat(64)); // 假哈希
    const root = tempRoot();
    roots.push(root);
    seedOldDist(root, '1.0.0');
    await expect(performUpdate({ enabled: true, root, fetchImpl, hasSupervisor: () => true })).rejects.toMatchObject({ httpStatus: 422 });
    expect(fs.readFileSync(path.join(root, 'dist', 'version.txt'), 'utf8').trim()).toBe('1.0.0');
  });

  it('校验文件格式非法 → 422', async () => {
    const { tarBytes } = await makeDistTar();
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url.includes('/tags')) return tagsResponse(['v1.2.3', 'v1.0.0']);
      if (url.endsWith('.tar.gz.sha256')) return new Response('not-a-hash\n', { status: 200 });
      if (url.endsWith('.tar.gz')) return new Response(new Uint8Array(tarBytes), { status: 200 });
      return new Response('{}', { status: 200 });
    };
    const root = tempRoot();
    roots.push(root);
    seedOldDist(root, '1.0.0');
    await expect(performUpdate({ enabled: true, root, fetchImpl, hasSupervisor: () => true })).rejects.toMatchObject({ httpStatus: 422 });
  });
});

describe('renameSyncWithRetry', () => {
  it('EPERM/EBUSY 重试后成功', () => {
    const root = tempRoot();
    roots.push(root);
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    fs.writeFileSync(a, 'x');
    let failCount = 1;
    const origRename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
      if (failCount > 0) {
        failCount--;
        const err = new Error('busy') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      origRename(src, dst);
    });
    try {
      expect(() => renameSyncWithRetry(a, b, 3, 1)).not.toThrow();
      expect(fs.existsSync(b)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('持续 EPERM → 最终抛错', () => {
    const root = tempRoot();
    roots.push(root);
    const a = path.join(root, 'a2');
    const b = path.join(root, 'b2');
    fs.writeFileSync(a, 'x');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      const err = new Error('perm') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    try {
      expect(() => renameSyncWithRetry(a, b, 2, 1)).toThrow(/perm/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('startOtaCheck 定时器', () => {
  it('intervalMs=0 → 无操作', () => {
    const onResult = vi.fn();
    const stop = startOtaCheck({ intervalMs: 0, onResult, fetchImpl: vi.fn(async () => tagsResponse(['v1.2.3'])), cache: null });
    stop();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('interval > 0 → 立即检查一次，结果回调', async () => {
    vi.useFakeTimers();
    const onResult = vi.fn();
    const root = tempRoot();
    roots.push(root);
    seedOldDist(root, '1.0.0');
    const stop = startOtaCheck({
      intervalMs: 60_000,
      onResult,
      root,
      fetchImpl: vi.fn(async () => tagsResponse(['v1.2.3'])),
      cache: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]![0]).toMatchObject({ latest: 'v1.2.3', hasUpdate: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onResult).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('ota-guard 标记读写', () => {
  it('boot_attempts 计数读写 + 清零', () => {
    const root = tempRoot();
    roots.push(root);
    writeBootAttempts(root, 3);
    expect(readBootAttempts(root)).toBe(3);
    clearBootAttempts(root);
    expect(readBootAttempts(root)).toBe(0);
    // 缺失读 = 0（不抛）。
    const empty = tempRoot();
    roots.push(empty);
    expect(readBootAttempts(empty)).toBe(0);
  });

  it('confirmHealth 写健康标记 + readStatus 快照', () => {
    const root = tempRoot();
    roots.push(root);
    // dist.prev 存在 → rollbackPointPresent。
    fs.mkdirSync(path.join(root, 'dist.prev'), { recursive: true });
    confirmHealth(root, 'v1.2.3');
    const s = readStatus(root);
    expect(s.healthConfirmed).toBe(true);
    expect(s.healthDetail).toContain('version=v1.2.3');
    expect(s.rollbackPointPresent).toBe(true);
    expect(s.rolledBackBinaryPresent).toBe(false);
  });

  it('dist.failed.* 残留 → rolledBackBinaryPresent', () => {
    const root = tempRoot();
    roots.push(root);
    fs.mkdirSync(path.join(root, 'dist.failed.20260814-120000'), { recursive: true });
    const s = readStatus(root);
    expect(s.rolledBackBinaryPresent).toBe(true);
    expect(s.healthConfirmed).toBe(false);
  });

  it('clearStaleLock 清残留 .ota-lock', () => {
    const root = tempRoot();
    roots.push(root);
    fs.writeFileSync(path.join(root, '.ota-lock'), '');
    clearStaleLock(root);
    expect(fs.existsSync(path.join(root, '.ota-lock'))).toBe(false);
  });

  it('O-P1-1/M-1/M-2 回归：进程健康确认不清计数（计数跨崩溃累积，守卫裁决后重置）', () => {
    const root = tempRoot();
    roots.push(root);
    // 坏版「能 bind 但运行期崩」：计数由守卫（rollback-guard.sh ExecStartPre）每次
    // 启动 +1，**进程侧健康确认点只写 health、不再清计数**（M-1 起 main.ts 移除
    // clearBootAttempts）——否则坏版每轮跑过 30s 健康确认就把计数清零，永远攒不
    // 到阈值，守卫无法回滚。
    writeBootAttempts(root, 1);
    writeBootAttempts(root, 2);
    writeBootAttempts(root, 3);
    expect(readBootAttempts(root)).toBe(3);
    // 健康确认点：confirmHealth 写 version + confirmed_at；计数保留供守卫裁决。
    confirmHealth(root, '1.2.3');
    expect(readBootAttempts(root)).toBe(3);
    const health = fs.readFileSync(path.join(root, 'fuckopencode.health'), 'utf8');
    expect(health).toContain('version=1.2.3');
    expect(health).toMatch(/^confirmed_at=\d+$/m);
  });
});
