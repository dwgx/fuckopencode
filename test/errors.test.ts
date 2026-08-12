import { describe, expect, it } from 'vitest';
import { rewriteContextOverflow } from '../src/server.js';
import {
  anthropicErrorToOpenAI,
  classifyAccountError,
  classifyUpstreamFailure,
  parseResetDelayMs,
  resetDelayMsFromError,
  stripSecrets,
  RESET_CLAMP_MS,
  type AccountStatus,
} from '../src/errors.js';
import type { UpstreamFailureKind } from '../src/keypool.js';

const COOLDOWN = 60_000;
const FIFTEEN_MIN = 15 * 60_000;
const ONE_HOUR = 3_600_000;
const TWENTY_FOUR_H = 24 * 3_600_000;
const RESET_MSG = 'Weekly usage limit reached. Resets in 19hr 22min.';

describe('classifyAccountError（MULTI-ACCOUNT.md §4.2 全表）', () => {
  it('AuthError / authentication_error（401/403）→ invalid，12 × cooldown', () => {
    for (const status of [401, 403]) {
      for (const type of ['AuthError', 'authentication_error']) {
        const r = classifyAccountError(status, { error: { type } }, COOLDOWN);
        expect(r.status).toBe('invalid');
        expect(r.retryMs).toBe(COOLDOWN * 12);
      }
    }
  });

  it('401 但非认证错误 → error（其他兜底，不是 invalid）', () => {
    const r = classifyAccountError(401, { error: { type: 'ModelError' } }, COOLDOWN);
    expect(r).toEqual({ status: 'error', retryMs: FIFTEEN_MIN });
  });

  it('CreditsError / billing_error / insufficient_balance → insufficient，15min', () => {
    for (const type of ['CreditsError', 'billing_error', 'insufficient_balance']) {
      const r = classifyAccountError(400, { error: { type } }, COOLDOWN);
      expect(r).toEqual({ status: 'insufficient', retryMs: FIFTEEN_MIN });
    }
  });

  it('MonthlyLimitError / UserLimitError → limit，按上游重置时间', () => {
    for (const type of ['MonthlyLimitError', 'UserLimitError']) {
      const r = classifyAccountError(429, { error: { type, message: RESET_MSG } }, COOLDOWN);
      expect(r.status).toBe('limit');
      expect(r.retryMs).toBe(19 * ONE_HOUR + 22 * 60_000);
    }
  });

  it('MonthlyLimitError / UserLimitError 解析不出重置时间 → 24h 兜底', () => {
    for (const type of ['MonthlyLimitError', 'UserLimitError']) {
      const r = classifyAccountError(429, { error: { type, message: 'monthly limit' } }, COOLDOWN);
      expect(r).toEqual({ status: 'limit', retryMs: TWENTY_FOUR_H });
    }
  });

  it('GoUsageLimitError → cooldown，重置 + 60s；解析不出 1h 兜底', () => {
    const withReset = classifyAccountError(429, { error: { type: 'GoUsageLimitError', message: RESET_MSG } }, COOLDOWN);
    expect(withReset.status).toBe('cooldown');
    expect(withReset.retryMs).toBe(19 * ONE_HOUR + 22 * 60_000 + 60_000);
    // 解析不出（无 "Resets in"）→ 1h + 60s。
    const noReset = classifyAccountError(429, { error: { type: 'GoUsageLimitError', message: 'limit reached' } }, COOLDOWN);
    expect(noReset.retryMs).toBe(ONE_HOUR + 60_000);
  });

  it('BlackUsageLimitError → cooldown，重置 + 60s；解析不出 24h 兜底', () => {
    const withReset = classifyAccountError(429, { error: { type: 'BlackUsageLimitError', message: RESET_MSG } }, COOLDOWN);
    expect(withReset.status).toBe('cooldown');
    expect(withReset.retryMs).toBe(19 * ONE_HOUR + 22 * 60_000 + 60_000);
    const noReset = classifyAccountError(429, { error: { type: 'BlackUsageLimitError' } }, COOLDOWN);
    expect(noReset.retryMs).toBe(TWENTY_FOUR_H + 60_000);
  });

  it('RateLimitError / 裸 429 → cooldown，15min（探针节流下限）', () => {
    expect(classifyAccountError(429, { error: { type: 'RateLimitError' } }, COOLDOWN)).toEqual({
      status: 'cooldown',
      retryMs: FIFTEEN_MIN,
    });
    expect(classifyAccountError(429, null, COOLDOWN)).toEqual({
      status: 'cooldown',
      retryMs: FIFTEEN_MIN,
    });
  });

  it('RegionError → region，24h', () => {
    expect(classifyAccountError(429, { error: { type: 'RegionError' } }, COOLDOWN)).toEqual({
      status: 'region',
      retryMs: TWENTY_FOUR_H,
    });
  });

  it('其他 / 网络层失败 → error，15min', () => {
    expect(classifyAccountError(500, null, COOLDOWN)).toEqual({ status: 'error', retryMs: FIFTEEN_MIN });
    expect(classifyAccountError(502, 'html', COOLDOWN)).toEqual({ status: 'error', retryMs: FIFTEEN_MIN });
    expect(classifyAccountError(400, { error: { type: 'unknown_type' } }, COOLDOWN)).toEqual({
      status: 'error',
      retryMs: FIFTEEN_MIN,
    });
  });
});

describe('两张分类表一致性（§4.2：同 error.type 不能结论相反）', () => {
  const cases: Array<{
    name: string;
    status: number;
    body: unknown;
    pool: UpstreamFailureKind;
    account: AccountStatus;
  }> = [
    { name: 'authentication_error 401', status: 401, body: { error: { type: 'authentication_error' } }, pool: 'auth', account: 'invalid' },
    { name: 'authentication_error 403', status: 403, body: { error: { type: 'authentication_error' } }, pool: 'auth', account: 'invalid' },
    { name: 'AuthError 401（订阅端点实测形态）', status: 401, body: { error: { type: 'AuthError' } }, pool: 'auth', account: 'invalid' },
    { name: 'AuthError 403', status: 403, body: { error: { type: 'AuthError' } }, pool: 'auth', account: 'invalid' },
    { name: 'CreditsError', status: 400, body: { error: { type: 'CreditsError' } }, pool: 'rate-limit', account: 'insufficient' },
    { name: 'billing_error', status: 400, body: { error: { type: 'billing_error' } }, pool: 'rate-limit', account: 'insufficient' },
    { name: 'insufficient_balance', status: 400, body: { error: { type: 'insufficient_balance' } }, pool: 'rate-limit', account: 'insufficient' },
    { name: 'MonthlyLimitError', status: 429, body: { error: { type: 'MonthlyLimitError', message: RESET_MSG } }, pool: 'quota-exhausted', account: 'limit' },
    { name: 'UserLimitError', status: 429, body: { error: { type: 'UserLimitError', message: RESET_MSG } }, pool: 'quota-exhausted', account: 'limit' },
    { name: 'GoUsageLimitError', status: 429, body: { error: { type: 'GoUsageLimitError', message: RESET_MSG } }, pool: 'quota-exhausted', account: 'cooldown' },
    { name: 'BlackUsageLimitError', status: 429, body: { error: { type: 'BlackUsageLimitError', message: RESET_MSG } }, pool: 'quota-exhausted', account: 'cooldown' },
    { name: 'RateLimitError 429', status: 429, body: { error: { type: 'RateLimitError' } }, pool: 'rate-limit', account: 'cooldown' },
    { name: '裸 429', status: 429, body: null, pool: 'rate-limit', account: 'cooldown' },
    { name: '5xx', status: 500, body: null, pool: 'transient', account: 'error' },
    { name: '未知 type', status: 400, body: { error: { type: 'unknown_type' } }, pool: 'transient', account: 'error' },
  ];

  for (const c of cases) {
    it(`${c.name}：pool=${c.pool}，account=${c.account}`, () => {
      expect(classifyUpstreamFailure(c.status, c.body)).toBe(c.pool);
      expect(classifyAccountError(c.status, c.body, COOLDOWN).status).toBe(c.account);
    });
  }

  it('回归：quota 类错误不再被归成 rate-limit 短冷却（§4.2 小改）', () => {
    // 这是本次改造的核心动因：MonthlyLimitError 等真实流量错误此前落
    // classifyUpstreamFailure 的 429 → rate-limit（3s），限流期内每请求都撞一次
    // 已耗尽的 key。现在必须与账户表一致走 quota-exhausted 长冷却。
    for (const type of ['MonthlyLimitError', 'UserLimitError', 'BlackUsageLimitError']) {
      const pool = classifyUpstreamFailure(429, { error: { type, message: RESET_MSG } });
      expect(pool).toBe('quota-exhausted');
      expect(classifyAccountError(429, { error: { type, message: RESET_MSG } }, COOLDOWN).status).toBe(
        type === 'MonthlyLimitError' || type === 'UserLimitError' ? 'limit' : 'cooldown',
      );
    }
  });

  it('刻意的偏差：RegionError 不进 pool 分类（§8 取舍，账户徽标承担展示）', () => {
    // pool 只有 4 种 kind，区域错误由账户徽标 region 展示；pool 侧短冷却让请求换号重试。
    expect(classifyUpstreamFailure(429, { error: { type: 'RegionError' } })).toBe('rate-limit');
    expect(classifyAccountError(429, { error: { type: 'RegionError' } }, COOLDOWN).status).toBe('region');
  });
});

describe('parseResetDelayMs 上限（m5：恶意/异常上游消息不能永久禁用 key）', () => {
  it('正常值不受影响（19h22min 照常解析）', () => {
    expect(parseResetDelayMs('Weekly usage limit reached. Resets in 19hr 22min.')).toBe(19 * ONE_HOUR + 22 * 60_000);
    expect(parseResetDelayMs('Resets in 2 days')).toBe(2 * 86_400_000);
  });

  it('超大数字被 clamp 到 30 天', () => {
    expect(parseResetDelayMs('Resets in 999999999999 hours')).toBe(RESET_CLAMP_MS);
    expect(parseResetDelayMs('Resets in 999999999999 days')).toBe(RESET_CLAMP_MS);
  });

  it('resetDelayMsFromError 同口径 clamp（keypool.disabledUntil 的入参）', () => {
    expect(resetDelayMsFromError({ error: { type: 'GoUsageLimitError', message: 'Resets in 999999999999 hours' } })).toBe(RESET_CLAMP_MS);
    expect(resetDelayMsFromError({ error: { type: 'GoUsageLimitError', message: RESET_MSG } })).toBe(19 * ONE_HOUR + 22 * 60_000);
  });
});

describe('stripSecrets（m12：上游错误原文脱敏）', () => {
  it('sk- 前缀 key 被替换', () => {
    expect(stripSecrets('invalid key sk-AbC123_xyz-999 provided')).toBe('invalid key sk-*** provided');
    expect(stripSecrets('sk-abcdef')).toBe('sk-***');
  });

  it('Bearer 头被替换', () => {
    expect(stripSecrets('Authorization: Bearer sk-live-abc123.def')).toBe('Authorization: Bearer ***');
  });

  it('auth=Fe26. 签名 token 被替换', () => {
    expect(stripSecrets('auth=Fe26.2**abc.def.ghi=xyz== invalid')).toBe('auth=*** invalid');
  });

  it('混合形态一次替换完', () => {
    expect(stripSecrets('key=sk-aaa, Bearer sk-bbb, auth=Fe26.1**cc')).toBe('key=sk-***, Bearer ***, auth=***');
  });

  it('无凭证的普通文案原样保留', () => {
    expect(stripSecrets('Weekly usage limit reached. Resets in 19hr 22min.')).toBe(
      'Weekly usage limit reached. Resets in 19hr 22min.',
    );
  });
});

describe('anthropicErrorToOpenAI 脱敏（m1：上游 key 明文不回显客户端）', () => {
  it('错误消息回显 Authorization 头时 key 被替换', () => {
    const err = anthropicErrorToOpenAI(401, {
      error: { type: 'authentication_error', message: 'invalid key: Authorization: Bearer sk-live-abc123.def' },
    });
    expect(err.body.error.message).not.toContain('sk-live-abc123.def');
    // Bearer 正则先命中整段 token，sk- 前缀随之一起被打码。
    expect(err.body.error.message).toBe('invalid key: Authorization: Bearer ***');
  });

  it('sk- 前缀 key 回显时被替换', () => {
    const err = anthropicErrorToOpenAI(400, {
      error: { type: 'billing_error', message: 'usage rejected for key sk-AbC123_xyz-999' },
    });
    expect(err.body.error.message).not.toContain('sk-AbC123_xyz-999');
    expect(err.body.error.message).toContain('sk-***');
  });

  it('无凭证的普通错误文案原样透传（脱敏不误伤）', () => {
    const err = anthropicErrorToOpenAI(429, {
      error: { type: 'rate_limit_error', message: 'Weekly usage limit reached. Resets in 19hr 22min.' },
    });
    expect(err.body.error.message).toBe('Weekly usage limit reached. Resets in 19hr 22min.');
  });
});

describe('rewriteContextOverflow（上下文超限错误改写，Claude Code 兼容）', () => {
  it('DeepSeek 措辞 → 加 "prompt is too long" 前缀（CC 自动恢复链）', () => {
    const raw = JSON.stringify({
      error: { type: 'invalid_request_error', message: "This model's maximum context length is 1048576 tokens. However, you requested 1048812 tokens." },
    });
    const out = JSON.parse(rewriteContextOverflow(raw));
    expect(out.error.message).toContain('prompt is too long');
    expect(out.error.message).toContain('maximum context length'); // 原文保留
  });

  it('已是 CC 措辞 → 原样返回（不重复改写）', () => {
    const raw = JSON.stringify({ error: { message: 'prompt is too long: reduce length' } });
    expect(rewriteContextOverflow(raw)).toBe(raw);
  });

  it('非超限错误 → 原样返回', () => {
    const raw = JSON.stringify({ error: { message: 'invalid api key' } });
    expect(rewriteContextOverflow(raw)).toBe(raw);
  });

  it('非 JSON 文本 → 正则兜底改写', () => {
    const raw = "This model's maximum context length is 1048576 tokens. However, you requested 1048812 tokens. Please reduce.";
    expect(rewriteContextOverflow(raw)).toContain('prompt is too long');
  });
});
