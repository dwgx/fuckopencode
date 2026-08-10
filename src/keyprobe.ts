/**
 * key 主动探活。
 *
 * 为什么需要：面板上的「可用」只代表**不在冷却期**，不代表验证过能用。
 * 实测遇到过两个 key 都显示可用、但 40 分钟里谁都没接过真实请求 ——
 * 那时面板是绿的，可它们到底还能不能用没人知道，只有等真实流量撞上去
 * 才会发现（而那一撞就是用户的请求失败）。
 *
 * 做法：定期挑出「健康但长时间空闲」的 key，各发一个**最小开销**的真实
 * 请求。成功就刷新 lastUsedAt（面板的「最近使用」变新，说明刚验证过），
 * 失败就走和真实流量完全相同的 markFailure 路径 —— 该禁用的照样禁用，
 * 让面板提前知道，而不是等用户的请求去踩。
 *
 * 两条克制原则（额度很珍贵）：
 * - 只探健康的 key。禁用中的有明确冷却到期时间，让它自然恢复；拿真请求去
 *   撞一个已知额度耗尽的 key 纯属浪费。
 * - 只探空闲的。有真实流量经过就说明它活着，不需要额外证明。
 */

import type { AppConfig } from './config.js';
import { classifyUpstreamFailure, resetDelayMsFromError } from './errors.js';
import type { KeyPool } from './keypool.js';
import type { UsageDb } from './usagedb.js';

/** 探活请求的模型。上游只承载 DeepSeek，固定用这个。 */
export const PROBE_MODEL = 'deepseek-v4-flash';

/** 探活请求体：最小 token 开销。 */
function probeBody(): Record<string, unknown> {
  return {
    model: PROBE_MODEL,
    // 1 个 token 就够判断链路是否通 —— 我们只关心状态码，不关心回什么。
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  };
}

export interface ProbeResult {
  fingerprint: string;
  ok: boolean;
  status: number;
  durationMs: number;
  /** 失败时的分类，与真实流量用同一套 classifyUpstreamFailure。 */
  kind?: 'auth' | 'rate-limit' | 'quota-exhausted' | 'transient';
  error?: string;
}

/**
 * 探一个指定的 key。
 *
 * 刻意**不走** `postUpstreamChat` —— 那个函数内部用 `pool.acquire()` 按
 * least-loaded 自己挑 key，而探活必须打到指定的那一个。所以这里直接发请求，
 * 但成功/失败的处理复用 pool 的 markSuccess/markFailure，保证探活得出的
 * 结论和真实流量完全一致（同样的分类、同样的冷却、同样的面板呈现）。
 */
export async function probeKey(
  cfg: AppConfig,
  pool: KeyPool,
  key: string,
  fingerprint: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.anthropicBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(probeBody()),
      signal: ac.signal,
    });

    const durationMs = Date.now() - started;
    if (res.ok) {
      // 把 body 读干净再丢，避免连接悬着。
      await res.text().catch(() => '');
      pool.markSuccess(key);
      return { fingerprint, ok: true, status: res.status, durationMs };
    }

    let body: unknown = null;
    const raw = await res.text().catch(() => '');
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const kind = classifyUpstreamFailure(res.status, body);
    const resetMs = resetDelayMsFromError(body);
    pool.markFailure(key, kind, resetMs ?? undefined);
    return {
      fingerprint,
      ok: false,
      status: res.status,
      durationMs,
      kind,
      error: `probe ${res.status}: ${raw.slice(0, 200)}`,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    // 网络层失败（超时、连不上）算 transient：可能是本机网络抖动而非 key 的问题，
    // 让它累计到阈值再禁用，不要因为一次探活失败就误杀一个好 key。
    pool.markFailure(key, 'transient');
    const msg = err instanceof Error ? err.message : String(err);
    return {
      fingerprint,
      ok: false,
      status: 0,
      durationMs,
      kind: 'transient',
      error: `probe failed: ${msg.slice(0, 200)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跑一轮探活：把所有「健康且空闲超过 idleMs」的 key 各探一次。
 *
 * 串行探而非并发：探活是后台维护动作，没必要为了快去抢占上游并发额度，
 * 也避免同时打多个请求触发上游的速率限制。
 */
export async function runProbeRound(
  cfg: AppConfig,
  pool: KeyPool,
  db: UsageDb | null,
  log: (msg: string) => void = console.log,
): Promise<ProbeResult[]> {
  const stale = pool.staleKeys(cfg.keyProbeIdleMs);
  if (stale.length === 0) return [];

  const results: ProbeResult[] = [];
  for (const { key, fingerprint, idleForMs } of stale) {
    const r = await probeKey(cfg, pool, key, fingerprint, cfg.keyProbeTimeoutMs);
    results.push(r);

    const idle = Number.isFinite(idleForMs)
      ? `空闲 ${Math.round(idleForMs / 60000)}m`
      : '本进程内从未使用';
    if (r.ok) {
      log(`[keyprobe] ${fingerprint} 活（${idle}，${r.durationMs}ms）`);
    } else {
      log(`[keyprobe] ${fingerprint} 探活失败 ${r.status} ${r.kind}（${idle}）：${r.error ?? ''}`);
    }

    // 探活结果也落库，这样面板的「累计」和历史里能看出哪些请求是探活产生的
    // （endpoint = 'probe'），不会和真实流量混淆。
    db?.recordRequest({
      at: Date.now(),
      keyFingerprint: fingerprint,
      model: PROBE_MODEL,
      upstreamModel: PROBE_MODEL,
      endpoint: 'probe',
      status: r.status,
      durationMs: r.durationMs,
      stream: false,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      error: r.error ?? null,
    });
  }
  return results;
}

/**
 * 启动周期探活。返回停止函数。
 *
 * `unref()` 掉定时器：探活是后台维护，不该拖住进程退出。
 */
export function startKeyProbe(
  cfg: AppConfig,
  pool: KeyPool,
  db: UsageDb | null,
  log: (msg: string) => void = console.log,
): () => void {
  if (cfg.keyProbeIntervalMs <= 0) return () => {};

  let running = false;
  const tick = async () => {
    if (running) return; // 上一轮还没跑完（上游很慢），跳过这一轮
    running = true;
    try {
      await runProbeRound(cfg, pool, db, log);
    } catch (err) {
      // 探活绝不能拖垮进程 —— 它是观测设施。
      log(`[keyprobe] 本轮异常（已忽略）: ${err instanceof Error ? err.message : err}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, cfg.keyProbeIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
