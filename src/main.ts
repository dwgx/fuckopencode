#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createApp } from './server.js';

const cfg = loadConfig();

if (!cfg.anthropicApiKey) {
  console.warn('[proxy] ANTHROPIC_API_KEY not set — upstream /v1/messages calls will fail');
}
if (cfg.apiKeys.length === 0 && !cfg.allowUnauthenticated) {
  console.warn('[proxy] API_KEYS not set and ALLOW_UNAUTHENTICATED off — all requests will be rejected (fail-closed)');
}

const server = createApp(cfg);

server.listen(cfg.port, cfg.host, () => {
  console.log(`[proxy] listening on http://${cfg.host}:${cfg.port}`);
  console.log(`[proxy] injection mode: ${cfg.injectionMode}`);
});

function shutdown(signal: string): void {
  console.log(`[proxy] ${signal} — shutting down`);
  server.close(() => process.exit(0));
  // 兜底：5s 内未关完强制退出。
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
