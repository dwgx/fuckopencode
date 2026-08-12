#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createApp, keyStateHandler } from './server.js';
import { KeyPool } from './keypool.js';
import { PROBE_MODEL, startKeyProbe } from './keyprobe.js';
import { UsageDb } from './usagedb.js';
import { loadSecret } from './secrets.js';
import { AccountsStore } from './accounts.js';
import { applySettingsToConfig, parseSettingValue, SettingsStore } from './settings.js';
import { TokensStore } from './tokens.js';

const cfg = loadConfig();

if (cfg.upstreamKeys.length === 0) {
  console.warn('[proxy] no upstream keys configured — set ANTHROPIC_API_KEY or OPENSEA_KEYS');
}
// API_KEYS 可能来自 settings 表而不是 env —— 完整的 fail-closed 判断在 settings
// 应用之后（见下方 usageDb 之后的同名检查），这里保留原始 env 视角的提示。
if (cfg.apiKeys.length === 0 && !cfg.allowUnauthenticated) {
  console.warn('[proxy] API_KEYS not set and ALLOW_UNAUTHENTICATED off — all requests will be rejected (fail-closed)');
}

// 多账号管理面（MULTI-ACCOUNT.md §2.3）：secret 任何失败 → AccountsStore 整体禁用、
// 账户 key 不进池，代理链路退回「env keys 现状」，只多一条日志。
// 现有文件 vs 本次自动生成：loadSecret 内部不暴露来源，用调用前的存在性推断。
const secretFileExisted = fs.existsSync(path.resolve(cfg.secretFilePath));
const secret = loadSecret(cfg);

const secretStatus = secret == null
  ? '[proxy] secret: unavailable'
  : cfg.gatewaySecret
    ? '[proxy] secret: env (from env)'
    : `[proxy] secret: ${cfg.secretFilePath} (${secretFileExisted ? 'from file' : 'auto-generated'})`;

const usageDb = new UsageDb(cfg.usageDbPath, cfg.usageDbRetentionDays);

// 设置页热配置：settings 表是配置真源（env 为默认，settings 覆盖，运行时不重启）。
// 启动时把已存的值解析后 apply 进 cfg —— 与运行时 PATCH 走同一条 apply 函数，
// 保证「重启后配置仍在」且两种入口行为一致。坏数据（手工改库）记 warn 跳过。
const settingsStore = new SettingsStore(usageDb);
const appliedSettings: Record<string, unknown> = {};
for (const [key, raw] of Object.entries(settingsStore.all())) {
  const parsed = parseSettingValue(key, raw);
  if (parsed.ok) {
    appliedSettings[key] = parsed.value;
  } else {
    console.warn(`[proxy] settings: 跳过无效配置 ${key} (${parsed.error})`);
  }
}
if (Object.keys(appliedSettings).length > 0) {
  applySettingsToConfig(cfg, appliedSettings);
  console.log(`[proxy] settings: applied ${Object.keys(appliedSettings).join(', ')} from db`);
}

// settings 应用后再做 fail-closed 检查：API_KEYS 可能来自 settings 表而不是 env。
if (cfg.apiKeys.length === 0 && !cfg.allowUnauthenticated) {
  console.warn('[proxy] API_KEYS not set and ALLOW_UNAUTHENTICATED off — all requests will be rejected (fail-closed)');
}

// 模型映射配置化（内置别名已从代码移除）：首次启动（表空）把默认别名
// （claude-mythos-5 / claude-fable-5 → deepseek-v4-flash）种进 db，保持与
// 旧版一致的默认行为；之后完全由后台设置页管理。createApp 启动时会把
// model_aliases 合并进 cfg.modelMap，seed 在这里先行即可在第一次请求前生效。
import { loadModelAliases, seedDefaultModelAliases } from './modelmap.js';
const seededDefaults = seedDefaultModelAliases(usageDb);
console.log(
  seededDefaults
    ? `[proxy] model aliases: seeded ${loadModelAliases(usageDb).length} defaults`
    : `[proxy] model aliases: ${loadModelAliases(usageDb).length} from db`,
);

// 构造器内已按 §3.3 做 env 种子（db 可用 && 表空 && env keys 非空），这里只算日志。
const accounts = new AccountsStore(usageDb, secret, cfg);

const accList = accounts.list();
const accountsStatus = !accounts.enabled
  ? `[proxy] accounts: off (${accounts.disabledReason})`
  // env-seeded 判定：存在名为 env 的账户即认为 env 种子在生效（种子账户常驻 id 1）。
  : `[proxy] accounts: ${accList.length} (${accList.some((a) => a.name === 'env') ? 'env-seeded' : 'from db'})`;

// 池 = env keys + 账户明文 keys。keypool 构造自带 trim/去重（重复 key 取第一个，
// accountId 由 map 解析）；降级时 map 为空 → 只走 env keys，行为与现状一致。
const accountIds = accounts.keysForPool();
const pool = new KeyPool(
  [...cfg.upstreamKeys, ...accountIds.keys()],
  {
    cooldownMs: cfg.keyCooldownMs,
    failThreshold: cfg.keyFailThreshold,
    onStateChange: keyStateHandler(usageDb),
  },
  accountIds,
);

// 控制台数据通道（新版 REST API）：cookie 会话 + x-org-id。ConsoleClient 只在
// 有账户 cookie 时才有意义；cookie 导入（importCookieFromChrome）仅本机开发
// 场景可用（线上 VPS 没有用户浏览器，走手动粘贴）。都失败时 console 端点 502。
import { ConsoleClient } from './console.js';
import { importCookieFromChrome } from './cookie.js';
const consoleClient = accounts.enabled ? new ConsoleClient(cfg, accounts) : undefined;
// 旧版控制台（opencode.ai）key 通道：legacy.ts 的纯函数直接当 client 用
// （端点层只做凭据组装；fetch 走全局）。
import { fetchLegacyKeys, createLegacyKey, deleteLegacyKey, fetchLegacyGoStatus, setLegacyGoToggle, fetchLegacyBilling, legacyCookieStatus, LegacyPlainCache } from './legacy.js';
// 旧版控制台域（不是 oauthConsoleUrl=console.opencode.ai）——旧版 workspace 页面只在 opencode.ai。
const LEGACY_BASE_URL = 'https://opencode.ai';
// legacy keys 明文的内存缓存：listKeys 每次成功抓取后填充；cookie 失效/写操作
// 后清空。只存内存（重启即清），绝不落库/进日志/进掩码端点。
const legacyPlainCache = new LegacyPlainCache();
const legacyClient = {
  listKeys: (accountId: number, cookie: string | null, workspaceId: string) => {
    const st = legacyCookieStatus(cookie);
    if (st !== 'ok') {
      legacyPlainCache.clear(accountId);
      return Promise.resolve({ ok: false as const, reason: (st === 'missing' ? 'no-cookie' : st) as 'wrong-console' });
    }
    return fetchLegacyKeys(LEGACY_BASE_URL, cookie!, workspaceId, undefined, (keys) =>
      legacyPlainCache.set(accountId, keys),
    );
  },
  createKey: (accountId: number, cookie: string | null, workspaceId: string, name: string) => {
    const st = legacyCookieStatus(cookie);
    if (st !== 'ok') {
      legacyPlainCache.clear(accountId);
      return Promise.resolve({ ok: false as const, reason: (st === 'missing' ? 'no-cookie' : st) as 'wrong-console' });
    }
    return createLegacyKey(LEGACY_BASE_URL, cookie!, workspaceId, name).then((r) => {
      // 创建后列表变了：缓存作废，下次 /keys/plain 实时抓取。
      if (r.ok) legacyPlainCache.clear(accountId);
      return r;
    });
  },
  deleteKey: (accountId: number, cookie: string | null, workspaceId: string, keyId: string) => {
    const st = legacyCookieStatus(cookie);
    if (st !== 'ok') {
      legacyPlainCache.clear(accountId);
      return Promise.resolve({ ok: false as const, reason: (st === 'missing' ? 'no-cookie' : st) as 'wrong-console' });
    }
    return deleteLegacyKey(LEGACY_BASE_URL, cookie!, workspaceId, keyId).then((r) => {
      // 删除后列表变了：缓存作废（否则明文端点会给出已删 key）。
      if (r.ok) legacyPlainCache.clear(accountId);
      return r;
    });
  },
  getGoStatus: (accountId: number, cookie: string | null, workspaceId: string) => {
    const st = legacyCookieStatus(cookie);
    return st === 'ok'
      ? fetchLegacyGoStatus(LEGACY_BASE_URL, cookie!, workspaceId)
      : Promise.resolve({ ok: false as const, reason: (st === 'missing' ? 'no-cookie' : st) as 'wrong-console' });
  },
  setGoToggle: (accountId: number, cookie: string | null, workspaceId: string, toggle: 'useBalance' | 'chinaModels', value: boolean) => {
    const st = legacyCookieStatus(cookie);
    return st === 'ok'
      ? setLegacyGoToggle(LEGACY_BASE_URL, cookie!, workspaceId, toggle, value)
      : Promise.resolve({ ok: false as const, reason: (st === 'missing' ? 'no-cookie' : st) as 'wrong-console' });
  },
  getBilling: (accountId: number, cookie: string | null, workspaceId: string) => {
    const st = legacyCookieStatus(cookie);
    return st === 'ok'
      ? fetchLegacyBilling(LEGACY_BASE_URL, cookie!, workspaceId)
      : Promise.resolve({ ok: false as const, reason: (st === 'missing' ? 'no-cookie' : st) as 'wrong-console' });
  },
};
// 分发密钥系统（客户端 key，走共享池）：db 不可用内部降级（enabled=false，
// verify 恒失败 —— fail-closed），构造不抛，不阻塞代理链路。
const tokensStore = new TokensStore(usageDb);
const server = createApp(cfg, pool, usageDb, accounts, undefined, consoleClient, importCookieFromChrome, legacyClient, tokensStore, legacyPlainCache);

// 主动探活：面板的「可用」只代表不在冷却期，探活用最小 token 的真实请求
// 证明它还活着。只探健康且长时间空闲的 key，不浪费额度。
const stopKeyProbe = startKeyProbe(cfg, pool, usageDb, accounts);

// billing SSR 旧通道（billing.ts 的 startBillingLoop）刻意停用：
// 新版控制台是 SPA，SSR 页面解析永远 parse failed —— 每 15min 打一次上游
// 只产出噪音日志，还可能把「console 通道刚写的正确余额」覆写成半截解析
// 结果。余额同步已由两条新通道接管：探针顺带抓（OAuth 账号）+ 手动刷新
// 端点（console 通道优先）。billing.ts 保留 —— handleRefreshBilling 的
// SSR 兜底路径仍用它。

server.listen(cfg.port, cfg.host, () => {
  console.log(`[proxy] listening on http://${cfg.host}:${cfg.port}`);
  console.log(`[proxy] injection mode: ${cfg.injectionMode}`);
  console.log(`[proxy] upstream key pool: ${pool.size} keys (${pool.healthyCount} healthy)`);
  console.log(
    usageDb.enabled
      ? `[proxy] usage db: ${cfg.usageDbPath} (retention ${cfg.usageDbRetentionDays}d)`
      : `[proxy] usage db: off (${usageDb.disabledReason})`,
  );
  console.log(secretStatus);
  console.log(accountsStatus);
  // 分发密钥状态：db 挂时 verify 恒失败（fail-closed），启动日志是唯一可见信号。
  console.log(
    tokensStore.enabled
      ? `[proxy] tokens: ${tokensStore.list().length} keys`
      : '[proxy] tokens: off (usage db unavailable)',
  );
  console.log(
    cfg.keyProbeIntervalMs > 0
      ? `[proxy] key probe: every ${Math.round(cfg.keyProbeIntervalMs / 60000)}m for keys idle > ${Math.round(cfg.keyProbeIdleMs / 60000)}m (model ${PROBE_MODEL})`
      : '[proxy] key probe: off',
  );
  // 实验性功能默认关；开了就要清楚失真/丢字是刻意取舍。
  console.log(
    cfg.scaleClientTokens || cfg.compactEnabled
      ? `[proxy] experimental: scale_client_tokens=${cfg.scaleClientTokens}${cfg.scaleClientTokens ? ` (x${cfg.clientTokenScale})` : ''} compact=${cfg.compactEnabled}${cfg.compactEnabled ? ` (trigger ${cfg.compactTriggerBytes}B, max ${cfg.compactMaxMessageChars} chars)` : ''}`
      : '[proxy] experimental: off (SCALE_CLIENT_TOKENS / COMPACT_ENABLED)',
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
