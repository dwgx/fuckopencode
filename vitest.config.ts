import { defineConfig } from 'vitest/config';

/**
 * 只为一件事存在：把 `.claude/` 从测试发现范围里排掉。
 *
 * 为什么需要：`git worktree` 建在 `.claude/worktrees/<name>/` 下，是项目根目录的
 * 子目录，vitest 默认的 include（`**\/*.test.ts`）会把 worktree 里的**整套测试**
 * 也扫进来。实测开着一个 worktree 时 `npm test` 从 326 个用例变成 630 个，
 * 而且 worktree 里的失败会算到主仓库头上 —— 主仓库明明是干净的。
 *
 * 除此之外全用 vitest 默认值，不引入别的配置。
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
});
