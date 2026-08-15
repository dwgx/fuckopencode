/**
 * 货币单位换算（单一权威模块，QUOTA.md §1 / B1 修复）。
 *
 * 统一口径：**1e8 microCents = $1**（opencode 上游记账单位，与 cost_micro_cents、
 * billing 的 units、tokens 的 quota_usd 存储同源）。所有模块的 $ 换算只准引用
 * 本模块的常量与函数，禁止各自内联 1e8 —— 历史上 6+ 处独立实现（tokens.ts
 * MICROCENTS_PER_USD / billing.ts UNITS_PER_DOLLAR / console.ts / server.ts /
 * accounts.ts / legacy.ts / admin.ts）是 B1（quota 单位错配 1e8 倍）的根因。
 *
 * 注意：microCentsToUsd 不做取整（原样除法）。需要「两位小数展示」的调用方
 * （console.ts microCentsToDollars、accounts.ts 视图）自己 toFixed —— 保留各自
 * 的展示语义，只收敛换算系数。
 */

/** 1e8 microCents = $1（同 billing.ts 的 UNITS_PER_DOLLAR，数值等价）。 */
export const MICROCENTS_PER_DOLLAR = 1e8;

/** microCents（存储/上游记账）→ 美元（展示/API 输出）。 */
export const microCentsToUsd = (v: number): number => v / MICROCENTS_PER_DOLLAR;

/** 美元（API/UI 入参）→ microCents（存储/比较）。非法输入产出 NaN（调用方自担守卫）。 */
export const usdToMicroCents = (v: number): number => Math.round(v * MICROCENTS_PER_DOLLAR);
