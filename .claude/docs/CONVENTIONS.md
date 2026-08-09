# 代码与提交风格

从现有代码里总结出来的，不是新规定。写新代码跟着这个走。

## 注释

中文注释，解释**为什么**而不是做什么。这个项目的注释密度偏高，
因为每处 workaround 都对应一个上游怪癖，不写清楚下个人会当成冗余代码删掉。

好的例子（[request.ts:84](../../src/request.ts)）：

```ts
// JSON mode 依赖强制 tool_choice；deepseek 在 thinking enabled 时拒绝
// tool_choice 指定工具（"Thinking mode does not support this tool_choice"），
// 所以 JSON mode 时强制 thinking disabled，保证强制工具可用。
```

带上上游的原始报错字符串，这样以后 grep 报错能找到对应代码。

模块顶部用块注释交代整个模块的职责和已知坑位，`deepseek.ts` 是范本。

## 类型

- strict 模式，零 `any`。不确定的外部输入用 `unknown` 再窄化。
- 处理上游/客户端的裸 JSON 时用 `Record<string, unknown>` + 逐字段判型，
  不要强转成接口就当真。
- ESM，import 路径**必须带 `.js` 后缀**（编译产物的路径）。

## 错误处理

- 面向客户端的错误不含内部细节。内部异常统一 `INTERNAL_SERVER_ERROR`，
  真实原因只进日志。
- 任何进日志或转发的外部字符串先过 `stripControl`，防日志伪造。
- 校验函数返回 `{ok: true} | {ok: false, error: string}`，不抛异常。

## 测试

- vitest，每个模块一个 `test/<module>.test.ts`。
- 断言具体行为，不要只断言「不抛异常」。
- 修 bug 时先写一个能复现的失败测试，再修。
- 改了转换行为，同步更新断言旧行为的测试 —— 并在测试名里写清新契约，
  别留一个名字说 A 实际断言 B 的用例。

## 提交

- 中文或英文，简洁说明性。`feat:` / `fix:` / `docs:` / `refactor:` 前缀。
- **绝不带 Claude / Anthropic 署名**（项目铁律，见 `/CLAUDE.md`）。
- 提交前 `git add <具体文件>`，不用 `git add .`。
- 提交前跑 `npm run typecheck && npm test`。

## 文档

- 所有 `.md` 禁用 emoji（项目铁律）。
- 论断带 `文件:行号`。
- 会过期的数字（测试数量之类）只在 README 写一次，别到处复制。
