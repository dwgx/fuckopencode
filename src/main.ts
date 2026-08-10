#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createApp, keyStateHandler } from './server.js';
import { KeyPool } from './keypool.js';
import { PROBE_MODEL, startKeyProbe } from './keyprobe.js';
import { UsageDb } from './usagedb.js';

const cfg = loadConfig();

if (cfg.upstreamKeys.length === 0) {
  console.warn('[proxy] no upstream keys configured — set ANTHROPIC_API_KEY or OPENSEA_KEYS');
}
if (cfg.apiKeys.length === 0 && !cfg.allowUnauthenticated) {
  console.warn('[proxy] API_KEYS not set and ALLOW_UNAUTHENTICATED off — all requests will be rejected (fail-closed)');
}

const usageDb = new UsageDb(cfg.usageDbPath, cfg.usageDbRetentionDays);

const pool = new KeyPool(cfg.upstreamKeys, {
  cooldownMs: cfg.keyCooldownMs,
  failThreshold: cfg.keyFailThreshold,
  onStateChange: keyStateHandler(usageDb),
});

const server = createApp(cfg, pool, usageDb);

// 主动探活：面板的「可用」只代表不在冷却期，探活用最小 token 的真实请求
// 证明它还活着。只探健康且长时间空闲的 key，不浪费额度。
const stopKeyProbe = startKeyProbe(cfg, pool, usageDb);

server.listen(cfg.port, cfg.host, () => {
  console.log(`[proxy] listening on http://${cfg.host}:${cfg.port}`);
  console.log(`[proxy] injection mode: ${cfg.injectionMode}`);
  console.log(`[proxy] upstream key pool: ${pool.size} keys (${pool.healthyCount} healthy)`);
  console.log(
    usageDb.enabled
      ? `[proxy] usage db: ${cfg.usageDbPath} (retention ${cfg.usageDbRetentionDays}d)`
      : `[proxy] usage db: off (${usageDb.disabledReason})`,
  );
  console.log(
    cfg.keyProbeIntervalMs > 0
      ? `[proxy] key probe: every ${Math.round(cfg.keyProbeIntervalMs / 60000)}m for keys idle > ${Math.round(cfg.keyProbeIdleMs / 60000)}m (model ${PROBE_MODEL})`
      : '[proxy] key probe: off',
  );
});

function shutdown(signal: string): void {
  console.log(`[proxy] ${signal} — shutting down`);
  stopKeyProbe();
  server.close(() => {
    usageDb.close();  // WAL 收尾；不关也不会丢已提交数据，但干净退出更好。
    process.exit(0);
  });
  // 兜底：5s 内未关完强制退出。
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
