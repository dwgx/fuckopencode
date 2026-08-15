/**
 * GitHub OTA 自更新核心（OTA.md §1-§4）。
 *
 * 分层：纯函数（isValidVersionTag / compareVersions / fetchTags / 校验 / 解包）
 * 全部可注入 fetchImpl 与目录，方便单测；performUpdate 把 下载 → 校验 →
 * 原子替换 → 自重启 串成一条，错误统一挂 httpStatus 字段（400/403/409/422/
 * 502/500，见 OTA.md §7）。
 *
 * 关键安全口径：
 * - 下载走镜像链（gh-proxy）→ 直连兜底，但 **sha256 文件只从 github.com 直连取**，
 *   绝不过镜像 —— 防镜像同时给后门包 + 匹配哈希。直连失败宁可中止。
 * - URL 由「白名单 repo（OTA_REPO，owner/repo 无 . 段）+ 合法 tag + 固定资产名」
 *   拼装，无用户可控 URL。
 * - OTA_TOKEN 存在时只走直连（token 绝不过镜像中间人），永不进日志/响应。
 * - 解包前 tar 双重预读：-tzf 拒 ../ 与绝对路径、条目数上限；-tvzf 拒
 *   symlink/hardlink/特殊条目 + 解包总量预算（超限解包前拒）。解包后 lstat
 *   全树兜底，version.txt 必须 == 请求的 tag（反投毒）。
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from './billing.js';
import { BOOT_COUNTER } from './ota-guard.js';

const execFileP = promisify(execFile);

export const OTA_DEFAULTS = {
  /** 下载累计上限（真实产物 ~2MB）。 */
  downloadCapBytes: 64 * 1024 * 1024,
  /** tar 条目数上限（zip-bomb DoS 防线）。 */
  tarEntryCap: 5000,
  /** 解包总量上限（高压缩比炸弹填盘防线）。 */
  tarExtractCap: 512 * 1024 * 1024,
  /** 单次 fetch 超时。 */
  fetchTimeoutMs: 15_000,
  /** 下载/解包超时（镜像慢）。 */
  longTimeoutMs: 60_000,
  /** 版本列表缓存 TTL：只缓存成功结果。 */
  tagCacheTtlMs: 60_000,
} as const;

/** gh-proxy 镜像链（顺序即优先级），最后直连 api.github.com。 */
export const MIRROR_HOSTS = ['gh-proxy.org', 'hk.gh-proxy.org', 'cdn.gh-proxy.org', 'edgeone.gh-proxy.org'];

export const DEFAULT_OTA_REPO = 'dwgx/fuckopencode';

/** 编译后 ota.js 在 <root>/dist/，上一级即项目根（线上 = /root/fuckopencode）。 */
export function otaProjectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** owner/repo 白名单：值会拼进 URL，非法形状（含 . 段/多余段）回落默认。 */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DOT_SEGMENT_RE = /(^|\/)\.{1,2}($|\/)/;

export function sanitizeRepo(raw: string | undefined, fallback = DEFAULT_OTA_REPO): string {
  const v = (raw ?? '').trim();
  return v && REPO_RE.test(v) && !DOT_SEGMENT_RE.test(v) ? v : fallback;
}

/** tag 白名单：`v?X.Y.Z`，1-4 段纯数字。`../evil`、`v1.2.3.4.5` 一律拒。 */
const VERSION_TAG_RE = /^v?\d+(\.\d+){0,3}$/;

export function isValidVersionTag(tag: unknown): tag is string {
  return typeof tag === 'string' && VERSION_TAG_RE.test(tag);
}

/** a > b -> 1，< -> -1，== -> 0；v 前缀忽略，缺段补 0。 */
export function compareVersions(a: string, b: string): number {
  const clean = (v: string): number[] =>
    String(v ?? '')
      .replace(/^v/, '')
      .split('.')
      .map((p) => parseInt(p, 10) || 0);
  const [x, y] = [clean(a), clean(b)];
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ── 远程访问：镜像链 ──────────────────────────────────────────

export function apiCandidates(apiPath: string, token: string): Array<{ name: string; url: string }> {
  const direct = { name: 'github-direct', url: `https://api.github.com/${apiPath}` };
  if (token) return [direct];
  return [
    ...MIRROR_HOSTS.map((host) => ({ name: host, url: `https://${host}/https://api.github.com/${apiPath}` })),
    direct,
  ];
}

async function withTimeout(f: FetchLike, url: string, init: RequestInit = {}, ms: number = OTA_DEFAULTS.fetchTimeoutMs): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await f(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface TagCacheEntry {
  tags: string[];
  at: number;
}

const tagCache = new Map<string, TagCacheEntry>();

export function resetTagCache(): void {
  tagCache.clear();
}

/** 单测用：清缓存 + 重置进程内 in-flight 标志（测试崩在中途不串到下一个用例）。 */
export function resetOtaState(): void {
  tagCache.clear();
  inFlight = false;
}

export interface FetchTagsOpts {
  fetchImpl?: FetchLike;
  repo?: string;
  token?: string;
  /** 时钟注入（缓存 TTL 测试）。 */
  now?: () => number;
  /** 缓存容器；null = 强制绕过缓存。默认模块级缓存（只缓存成功）。 */
  cache?: Map<string, TagCacheEntry> | null;
}

/** 拉版本列表，semver 降序，逐镜像 fallback；全失败返回 []。 */
export async function fetchTags(opts: FetchTagsOpts = {}): Promise<string[]> {
  const f = opts.fetchImpl ?? fetch;
  const repo = sanitizeRepo(opts.repo);
  const token = (opts.token ?? '').trim();
  const now = opts.now ?? Date.now;
  const cache = opts.cache === undefined ? tagCache : opts.cache;
  const key = `${repo}|${token ? 't' : ''}`;
  if (cache) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < OTA_DEFAULTS.tagCacheTtlMs) return hit.tags;
  }
  let lastErr = '';
  for (const c of apiCandidates(`repos/${repo}/tags`, token)) {
    try {
      const resp = await withTimeout(f, c.url, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!resp.ok) {
        lastErr = `${c.name} returned ${resp.status}`;
        continue;
      }
      const list = (await resp.json()) as Array<{ name?: unknown }> | null;
      const tags = Array.isArray(list)
        ? list.map((t) => t?.name).filter((n): n is string => isValidVersionTag(n))
        : [];
      if (tags.length === 0) {
        lastErr = `${c.name} has no valid version tags`;
        continue;
      }
      tags.sort((a, b) => compareVersions(b, a));
      if (cache) cache.set(key, { tags, at: now() });
      return tags;
    } catch (err) {
      lastErr = `${c.name} request failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return [];
}

// ── 当前版本 / 检查 ──────────────────────────────────────────

export function currentVersion(root = otaProjectRoot()): string {
  try {
    const v = fs.readFileSync(path.join(root, 'dist', 'version.txt'), 'utf8').trim();
    if (v) return v;
  } catch {
    // 回落到 package.json
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    // 都读不到 → 0.0.0
  }
  return '0.0.0';
}

export interface CheckStatus {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  enabled: boolean;
  error: string | null;
  checkedAt: number;
}

export interface CheckUpdateOpts extends FetchTagsOpts {
  root?: string;
  enabled?: boolean;
  /** 强制绕过缓存（面板「检查更新」按钮）。 */
  force?: boolean;
}

export async function checkUpdate(opts: CheckUpdateOpts = {}): Promise<CheckStatus> {
  const current = currentVersion(opts.root);
  const tags = await fetchTags({ ...opts, cache: opts.force ? null : opts.cache });
  const latest = tags[0] ?? null;
  return {
    current,
    latest,
    hasUpdate: latest != null && compareVersions(latest, current) > 0,
    enabled: opts.enabled !== false,
    error: tags.length === 0 ? 'failed to fetch remote version tags' : null,
    checkedAt: (opts.now ?? Date.now)(),
  };
}

export interface ChangelogCommit {
  sha: string;
  message: string;
  date: string | null;
}

/** compare 端点取 ≤30 commit（短 sha + 标题首行 + 日期）；全失败返回 []。 */
export async function fetchCompareCommits(opts: FetchTagsOpts & { from: string; to: string }): Promise<ChangelogCommit[]> {
  const f = opts.fetchImpl ?? fetch;
  const repo = sanitizeRepo(opts.repo);
  const token = (opts.token ?? '').trim();
  // from 来自 dist/version.txt（外部可写），过白名单校验，非法回落 '0.0.0'，
  // 防畸形版本串拼进 compare URL 造成路径注入。
  const from = isValidVersionTag(opts.from) ? opts.from : '0.0.0';
  const to = isValidVersionTag(opts.to) ? opts.to : '0.0.0';
  const apiPath = `repos/${repo}/compare/${from}...${to}`;
  let lastErr = '';
  for (const c of apiCandidates(apiPath, token)) {
    try {
      const resp = await withTimeout(f, c.url, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!resp.ok) {
        lastErr = `${c.name} returned ${resp.status}`;
        continue;
      }
      const body = (await resp.json()) as {
        commits?: Array<{ sha?: unknown; commit?: { message?: unknown; author?: { date?: unknown } } }>;
      } | null;
      const commits = Array.isArray(body?.commits)
        ? body.commits
            .slice(0, 30)
            .map((c2) => ({
              sha: typeof c2.sha === 'string' ? c2.sha.slice(0, 7) : '',
              message: typeof c2.commit?.message === 'string' ? c2.commit.message.split('\n')[0] ?? '' : '',
              date: typeof c2.commit?.author?.date === 'string' ? c2.commit.author.date : null,
            }))
            .filter((x) => x.sha !== '')
        : [];
      return commits;
    } catch (err) {
      lastErr = `${c.name} request failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return [];
}

// ── 下载 + 校验（S3） ─────────────────────────────────────────

export function assetCandidates(tag: string, repo: string, token: string): Array<{ name: string; url: string }> {
  const asset = `fuckopencode-${tag}-dist.tar.gz`;
  const gh = `github.com/${repo}/releases/download/${tag}/${asset}`;
  const direct = { name: 'github-direct', url: `https://${gh}` };
  if (token) return [direct];
  return [
    ...MIRROR_HOSTS.map((host) => ({ name: host, url: `https://${host}/https://${gh}` })),
    direct,
  ];
}

export interface DownloadOpts {
  fetchImpl?: FetchLike;
  repo?: string;
  token?: string;
  tag: string;
  destPath: string;
  capBytes?: number;
}

/** 流式写盘 + 增量 sha256，累计上限截断（超限是硬失败，不再试下一镜像）。 */
export async function downloadAsset(opts: DownloadOpts): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const repo = sanitizeRepo(opts.repo);
  const token = (opts.token ?? '').trim();
  const cap = opts.capBytes ?? OTA_DEFAULTS.downloadCapBytes;
  let lastErr = '';
  for (const c of assetCandidates(opts.tag, repo, token)) {
    try {
      const resp = await withTimeout(
        f,
        c.url,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        OTA_DEFAULTS.longTimeoutMs,
      );
      if (!resp.ok) {
        lastErr = `${c.name} returned ${resp.status}`;
        continue;
      }
      const len = Number(resp.headers.get('content-length') ?? 0);
      if (len > cap) throw httpError(422, `${c.name} response over the limit (${len} bytes)`);
      return await streamToFile(resp, opts.destPath, cap);
    } catch (err) {
      if ((err as { httpStatus?: number })?.httpStatus != null) throw err;
      lastErr = `${c.name} download failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  throw httpError(502, `all mirrors failed to download the release package: ${lastErr}`);
}

async function streamToFile(resp: Response, destPath: string, capBytes: number): Promise<string> {
  const hash = createHash('sha256');
  const fd = fs.openSync(destPath, 'w');
  try {
    if (!resp.body || typeof (resp.body as { getReader?: unknown }).getReader !== 'function') {
      // 无流 body（测试 stub）→ arrayBuffer + 后置检查。
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > capBytes) throw httpError(422, 'download response over the limit');
      hash.update(buf);
      fs.writeSync(fd, buf);
      return hash.digest('hex');
    }
    const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.length ?? 0;
      if (total > capBytes) {
        await reader.cancel().catch(() => {});
        throw httpError(422, 'download exceeded the size cap');
      }
      hash.update(value);
      fs.writeSync(fd, value);
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

/** sha256 文件**只从 github.com 直连取**（绝不过镜像），直连失败中止更新。 */
export async function fetchReleaseChecksum(opts: DownloadOpts): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const repo = sanitizeRepo(opts.repo);
  const token = (opts.token ?? '').trim();
  const asset = `fuckopencode-${opts.tag}-dist.tar.gz.sha256`;
  const url = `https://github.com/${repo}/releases/download/${opts.tag}/${asset}`;
  try {
    const resp = await withTimeout(
      f,
      url,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      OTA_DEFAULTS.longTimeoutMs,
    );
    if (!resp.ok) throw new Error(`github.com returned ${resp.status}`);
    return await readChecksumText(resp);
  } catch (err) {
    throw httpError(
      502,
      `direct github.com fetch of the checksum failed: ${err instanceof Error ? err.message : String(err)}; ` +
        'aborting the update — the checksum never falls back to a mirror',
    );
  }
}

/** 校验文件流式读 + 边读边限长 4096（仿 streamToFile，不 arrayBuffer 全量载入）。 */
async function readChecksumText(resp: Response, cap = 4096): Promise<string> {
  if (!resp.body || typeof (resp.body as { getReader?: unknown }).getReader !== 'function') {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > cap) throw new Error(`checksum file too large (${buf.length} bytes)`);
    return buf.toString('utf8');
  }
  const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.length ?? 0;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new Error('checksum file too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/** 从校验文件文本取 expected（单行 64hex + 可选文件名）。格式非法返回 null。 */
export function parseChecksum(text: string): string | null {
  const expected = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return /^[0-9a-f]{64}$/.test(expected) ? expected : null;
}

export function verifyChecksum(expectedHex: string, actualHex: string): void {
  if (expectedHex !== actualHex) {
    throw httpError(
      422,
      `sha256 mismatch: package=${actualHex.slice(0, 12)}... vs checksum=${expectedHex.slice(0, 12)}...`,
    );
  }
}

// ── tar 三重校验 + 解包（S3） ─────────────────────────────────

export interface VerifyTarOpts {
  tarPath: string;
  /** 解包目标（应为空目录）；条目按 strip-components=1 展开。 */
  outDir: string;
  expectedTag: string;
  entryCap?: number;
  extractCap?: number;
}

export async function verifyAndExtractTar(opts: VerifyTarOpts): Promise<void> {
  const entryCap = opts.entryCap ?? OTA_DEFAULTS.tarEntryCap;
  const extractCap = opts.extractCap ?? OTA_DEFAULTS.tarExtractCap;
  try {
    try {
      await execFileP('tar', ['--version'], { timeout: 5000 });
    } catch {
      throw httpError(500, 'OTA requires the system `tar` binary, which is missing on this host');
    }
    // 1. 预读（解包前）：路径安全 + 条目数上限。用 -tzf（纯文件名，最稳）。
    // maxBuffer 2MB（审查 m-4）：5000 条 × 255B ≈ 1.27MB，execFile 默认 1MB
    // 上限会先抛 maxBuffer 错误（误报为「预读失败」而非「超条目」）。
    const { stdout: nameOut } = await execFileP('tar', ['-tzf', opts.tarPath], {
      timeout: OTA_DEFAULTS.longTimeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    const entries = nameOut.split('\n').filter(Boolean);
    if (entries.length > entryCap) throw httpError(422, `archive has ${entries.length} entries; over the limit`);
    for (const e of entries) {
      if (!isSafeTarEntry(e)) throw httpError(422, `archive contains a suspicious path entry: ${e}`);
    }
    // 2. 预读（解包前）：条目类型 + 解包总量预算。-tvzf 的 verbose 列表每行
    //    首字符是条目类型（GNU tar / bsdtar 一致），尺寸用「日期前的数字」定位
    //    （两种实现的字段排布不同，见 parseTarVerboseSize）。symlink/hardlink/
    //    特殊文件与超预算归档都在落盘前被拒。
    const { stdout: verboseOut } = await execFileP('tar', ['-tvzf', opts.tarPath], {
      timeout: OTA_DEFAULTS.longTimeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    const lines = verboseOut.split('\n').filter(Boolean);
    if (lines.length > entryCap) throw httpError(422, `archive has ${lines.length} entries; over the limit`);
    let budget = 0;
    for (const line of lines) {
      const typeChar = line.trim()[0] ?? '';
      if (typeChar !== '-' && typeChar !== 'd') {
        throw httpError(422, `archive contains a ${tarTypeName(typeChar)} entry; rejected before extraction`);
      }
      if (typeChar === '-') {
        budget += parseTarVerboseSize(line);
        if (budget > extractCap) throw httpError(422, `archive expands to over ${extractCap} bytes; rejected before extraction`);
      }
    }
    // 3. 解包。
    fs.mkdirSync(opts.outDir, { recursive: true });
    await execFileP('tar', ['-xzf', opts.tarPath, '-C', opts.outDir, '--strip-components=1'], {
      timeout: OTA_DEFAULTS.longTimeoutMs,
    });
    // 4. 全树 lstat 兜底：拒 symlink / 特殊文件（预读是主防线，这里是纵深）。
    rejectSymlinks(opts.outDir);
    // 5. dist/version.txt 必须 == 请求的 tag（反投毒）。
    let version = '';
    try {
      version = fs.readFileSync(path.join(opts.outDir, 'version.txt'), 'utf8').trim();
    } catch {
      version = '';
    }
    if (stripV(version) !== stripV(opts.expectedTag)) {
      throw httpError(
        422,
        `archive version.txt=${version || '(missing)'} does not match requested tag=${opts.expectedTag}`,
      );
    }
    // 6. 必需文件。
    for (const f of ['main.js', 'keypool.js', 'dsml.js']) {
      if (!fs.existsSync(path.join(opts.outDir, f))) throw httpError(422, `archive is missing required file ${f}`);
    }
    // 7. 解包总量兜底（预读预算已挡大头，这里抓稀疏/元数据等漏网）。
    const size = dirSize(opts.outDir);
    if (size > extractCap) throw httpError(422, `extracted content is ${size} bytes; over the limit`);
  } catch (err) {
    if ((err as { httpStatus?: number })?.httpStatus == null) Object.assign(err as Error, { httpStatus: 422 });
    throw err;
  }
}

function isSafeTarEntry(raw: string): boolean {
  const e = raw.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!e) return false;
  if (e.startsWith('/')) return false;
  return !e.split('/').some((s) => s === '..' || s === '.');
}

/** -tvzf 每行首字符即条目类型：- 常规、d 目录、l 符号链接、h 硬链接… */
function tarTypeName(c: string): string {
  if (c === 'l') return 'symlink';
  if (c === 'h') return 'hardlink';
  if (c === 'b' || c === 'c') return 'device file';
  if (c === 'p') return 'fifo';
  return `special entry (type '${c}')`;
}

/**
 * 从 -tvzf 行取条目大小。GNU tar 的字段排布是 owner/size/date，bsdtar 是
 * uid/user/group/size/date，固定下标不可移植；统一取「日期 token 前那个数字」。
 * 日期 token 兼容 GNU（YYYY-MM-DD）与 bsdtar（Aug 15）；名字在日期之后，
 * 不会抢先匹配。
 */
function parseTarVerboseSize(line: string): number {
  const m = line.match(/(\d+)\s+(?:\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2}\s+\d{1,2})/);
  return m ? parseInt(m[1]!, 10) || 0 : 0;
}

function rejectSymlinks(root: string): void {
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw httpError(422, `archive contains a symlink entry: ${name}`);
      if (st.isDirectory()) walk(p);
      else if (!st.isFile()) throw httpError(422, `archive contains a special file entry: ${name}`);
    }
  };
  walk(root);
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) total += dirSize(p);
      else if (st.isFile()) total += st.size;
    }
  } catch {
    // 读不了的目录按 0 计；存在性检查是兜底。
  }
  return total;
}

function stripV(v: string): string {
  return String(v ?? '').replace(/^v/, '');
}

// ── 原子替换 + 自重启（S4） ─────────────────────────────────

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY']);

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // 睡眠被中断不致命，直接重试
  }
}

/** rename(2) 遇 EPERM/EBUSY（Windows/AV 扫描）短退避重试。 */
export function renameSyncWithRetry(sourcePath: string, targetPath: string, attempts = 6, baseDelayMs = 10): void {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.renameSync(sourcePath, targetPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!RETRYABLE_RENAME_CODES.has(code ?? '') || attempt === attempts) throw err;
      sleepSync(baseDelayMs * attempt);
    }
  }
}

/** 轮转替换：rm dist.prev → dist→dist.prev → .ota-tmp/out→dist。替换后立即校验。
 *  导出供单测直接驱动 swap（含反向回滚注入）。 */
export function replaceDist(root: string, out: string): void {
  const dist = path.join(root, 'dist');
  const prev = path.join(root, 'dist.prev');
  fs.rmSync(prev, { recursive: true, force: true });
  if (fs.existsSync(dist)) renameSyncWithRetry(dist, prev);
  try {
    renameSyncWithRetry(out, dist);
  } catch (err) {
    try {
      fs.rmSync(dist, { recursive: true, force: true });
    } catch {
      // 忽略
    }
    try {
      renameSyncWithRetry(prev, dist);
    } catch {
      // 反向回滚也失败：旧版仍在 dist.prev，启动守卫可兜底
    }
    throw httpError(500, `replacing dist/ failed: ${err instanceof Error ? err.message : String(err)}; the previous version was restored`);
  }
  // 替换后立即校验关键产物（少 keypool.js = 零上游 key 全 503）。
  if (!fs.existsSync(path.join(dist, 'keypool.js')) || !fs.existsSync(path.join(dist, 'main.js'))) {
    try {
      fs.rmSync(dist, { recursive: true, force: true });
    } catch {
      // 忽略
    }
    try {
      renameSyncWithRetry(prev, dist);
    } catch {
      // 忽略
    }
    throw httpError(500, 'replaced dist/ is missing required files (keypool.js/main.js); rolled back');
  }
}

/** supervisor 判定：systemd 会给进程注入 INVOCATION_ID。 */
export function hasSupervisor(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.INVOCATION_ID);
}

let inFlight = false;

/** 互斥锁：进程内标志 + 项目根 .ota-lock 独占创建，双保险。 */
function acquireLock(root: string): () => void {
  if (inFlight) throw httpError(409, 'an OTA update is already running');
  inFlight = true;
  try {
    const fd = fs.openSync(path.join(root, '.ota-lock'), 'wx');
    return () => {
      inFlight = false;
      try {
        fs.closeSync(fd);
      } catch {
        // 忽略
      }
      try {
        fs.rmSync(path.join(root, '.ota-lock'), { force: true });
      } catch {
        // 残留锁只阻塞下一次更新（清晰 409），不致命
      }
    };
  } catch (err) {
    inFlight = false;
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw httpError(409, 'another OTA update is in progress (a stale .ota-lock may need a manual remove)');
    }
    throw err;
  }
}

export interface PerformOpts {
  fetchImpl?: FetchLike;
  repo?: string;
  token?: string;
  /** OTA_ENABLED；false → 403。 */
  enabled: boolean;
  root?: string;
  now?: () => number;
  log?: (msg: string) => void;
  /** 替换成功后安排自重启（进程内延迟 shutdown，1s 让 HTTP 200 先 flush）。 */
  scheduleRestart?: () => void;
  /** supervisor 判定注入（测试）。 */
  hasSupervisor?: () => boolean;
  downloadCapBytes?: number;
  tarEntryCap?: number;
  tarExtractCap?: number;
}

export interface PerformResult {
  updated: boolean;
  before: string;
  after: string;
  restart: 'scheduled';
}

export async function performUpdate(opts: PerformOpts): Promise<PerformResult> {
  if (!opts.enabled) throw httpError(403, 'OTA updates are disabled (set OTA_ENABLED=1 to allow)');
  const root = opts.root ?? otaProjectRoot();
  const log = opts.log ?? (() => {});
  const release = acquireLock(root);
  const tmp = path.join(root, '.ota-tmp');
  try {
    const current = currentVersion(root);
    const tags = await fetchTags({ fetchImpl: opts.fetchImpl, repo: opts.repo, token: opts.token, now: opts.now });
    const latest = tags[0];
    if (!latest) throw httpError(502, 'cannot fetch a remote version (all mirrors failed)');
    if (compareVersions(latest, current) <= 0) {
      throw httpError(409, `current ${current} is up to date or newer (remote ${latest}); downgrade refused`);
    }
    // 换文件前检测 supervisor：裸跑（无 systemd）拒绝替换，否则换了没人拉起。
    if (!(opts.hasSupervisor ?? hasSupervisor)()) {
      throw httpError(409, 'no supervisor detected (INVOCATION_ID); refusing to replace the running tree — run the service under systemd to enable OTA restarts');
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const bundlePath = path.join(tmp, 'bundle.tar.gz');
    const actual = await downloadAsset({
      fetchImpl: opts.fetchImpl,
      repo: opts.repo,
      token: opts.token,
      tag: latest,
      destPath: bundlePath,
      capBytes: opts.downloadCapBytes,
    });
    // sha256 独立信道（github.com 直连）→ 先校验再解包。
    const shaTxt = await fetchReleaseChecksum({
      fetchImpl: opts.fetchImpl,
      repo: opts.repo,
      token: opts.token,
      tag: latest,
      destPath: bundlePath,
    });
    const expected = parseChecksum(shaTxt);
    if (!expected) throw httpError(422, 'checksum file has no valid 64-hex sha256; refusing to replace');
    verifyChecksum(expected, actual);
    await verifyAndExtractTar({
      tarPath: bundlePath,
      outDir: path.join(tmp, 'out'),
      expectedTag: latest,
      entryCap: opts.tarEntryCap,
      extractCap: opts.tarExtractCap,
    });
    replaceDist(root, path.join(tmp, 'out'));
    // M-2：OTA 替换后清 boot 计数（对齐 deploy.sh:73 手动部署的清计数）——否则
    // 陈旧计数残留会让新版本首次启动 bind 失败一次就触发守卫回滚（计数≥3 且
    // 新版本未健康确认 → dist != health → 误判坏版），撤销一次正常升级。
    try {
      fs.rmSync(path.join(root, BOOT_COUNTER), { force: true });
    } catch {
      // 清理失败不阻断替换
    }
    log(`[ota] replaced dist with ${latest} (was ${current}), scheduling restart`);
    // O-I6：延到下一个宏任务再触发 scheduleRestart——调用方（server.ts）在
    // performUpdate resolve 后的微任务里才 sendJson 200，推迟到宏任务保证
    // restart 的倒计时从响应发出后才开始（不留「200 还没 flush 就开始倒计时」的窗口）。
    setTimeout(() => {
      try {
        opts.scheduleRestart?.();
      } catch (err) {
        log(`[ota] scheduleRestart failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 0);
    return { updated: true, before: current, after: latest, restart: 'scheduled' };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    release();
  }
}

// ── 后台定时检查（S2）：只检查不自动应用 ─────────────────────

export function startOtaCheck(opts: CheckUpdateOpts & { intervalMs: number; onResult: (s: CheckStatus) => void }): () => void {
  if (opts.intervalMs <= 0) return () => {};
  let stopped = false;
  const run = async (): Promise<void> => {
    if (stopped) return;
    try {
      const s = await checkUpdate(opts);
      opts.onResult(s);
    } catch {
      // 后台检查失败静默，面板下次手动拉
    }
  };
  void run();
  const timer = setInterval(() => {
    void run();
  }, opts.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { httpStatus: status });
}
