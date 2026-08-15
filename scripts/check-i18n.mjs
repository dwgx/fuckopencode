#!/usr/bin/env node
/**
 * i18n 一致性核对脚本（零依赖：node:fs / node:vm / node:path / node:url）。
 *
 * 背景（绊脚石 4）：面板 i18n 的 `T(k)` 在缺词条时回落 `|| k` 直接显示 key 名，
 * `data-i18n="KEY"` 与字典错位是零报错静默失败——key 错位没有任何测试覆盖。
 * 本脚本把 admin.ts 里两块 HTML（ADMIN_HTML / LOGIN_HTML）的内联字典用 vm
 * 真执行提取出来，再做核对：
 *
 *   a. 所有 data-i18n="KEY"（HTML 静态 key）⊆ en 字典
 *   b. 所有 T('KEY') / T("KEY") ⊆ en 字典
 *   c. en 键集合 == 每个其他语言键集合。语言集合 = Object.keys(I18N) 除 en 外，
 *      按字典里实际出现的语言逐一与 en 比对（现在 en/zh 对称；ja 加入后自动纳入，
 *      没加入就不核对）
 *   d. LOGIN_HTML 独立字典，同样做 a/b/c（它不加载面板字典，词条独立）
 *
 * 死词条（字典有但生产代码未引用）只打 warning，不阻塞退出码。
 *
 * 退出码：a/b/c/d 任一失败 → exit 1（CI 阻断）；只有死词条 → exit 0。
 *
 * 核心函数（checkSets / parseI18n 等）导出供测试复用；直接运行走 CLI 主流程，
 * 被 import 时不执行主流程。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_TS = path.join(root, 'src', 'admin.ts');

/**
 * en 有、其他语言无 的白名单。当前为空——en/zh 已经对称。
 * （早期启发式提取曾误报 keys/configured，真执行后确认不是字典键。）
 */
const EN_ONLY_ALLOW = new Set();

/** 解析失败抛错；CLI 主流程 catch 后打错误信息并 exit 1。 */
function die(msg) {
  throw new Error(msg);
}

/** 从 `export const NAME = String.raw\`...\`` 里抠出模板内容。 */
export function extractHtml(src, name) {
  const marker = `export const ${name} = String.raw\``;
  const start = src.indexOf(marker);
  if (start < 0) die(`找不到 ${name} 的 String.raw 模板`);
  const bodyStart = start + marker.length;
  const end = src.indexOf('`', bodyStart);
  if (end < 0) die(`${name} 模板没有闭合反引号`);
  return src.slice(bodyStart, end);
}

/** 找与 openIdx 处 `{` 配对的 `}`（跳过字符串/注释/正则内的花括号）。 */
export function findClosingBrace(str, openIdx) {
  let depth = 0;
  let i = openIdx;
  const n = str.length;
  while (i < n) {
    const ch = str[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      i++;
      while (i < n) {
        if (str[i] === '\\') { i += 2; continue; }
        if (str[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && str[i + 1] === '/') {
      while (i < n && str[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && str[i + 1] === '*') {
      i += 2;
      while (i < n && !(str[i] === '*' && str[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  die(`花括号未配对：offset ${openIdx}`);
}

/** 从内联 `<script>` 提取 `var I18N = {...};` 块，用 vm 真执行拿到对象。 */
export function extractI18N(html) {
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
  if (!scriptMatch) die('HTML 里找不到内联 <script>');
  const script = scriptMatch[1];
  const openIdx = script.indexOf('var I18N = {');
  if (openIdx < 0) die('内联脚本里找不到 var I18N');
  const braceIdx = script.indexOf('{', openIdx);
  const closeIdx = findClosingBrace(script, braceIdx);
  const block = script.slice(openIdx, closeIdx + 1) + ';';
  const context = vm.createContext(Object.create(null));
  try {
    vm.runInContext(block, context, { filename: 'admin.ts inline I18N' });
  } catch (err) {
    die(`vm 执行 I18N 块失败：${err.message}`);
  }
  return { dict: context.I18N, script, dictStart: openIdx, dictEnd: closeIdx };
}

/** 收集 `data-i18n="KEY"` 的静态 key（去重、保序）。 */
export function collectDataI18n(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

/** 收集字面量 T('KEY') / T("KEY") 调用（去重、保序）。 */
export function collectTCalls(script) {
  const out = [];
  const seen = new Set();
  for (const m of script.matchAll(/\bT\((['"])([A-Za-z][A-Za-z0-9_]*)\1\)/g)) {
    if (!seen.has(m[2])) { seen.add(m[2]); out.push(m[2]); }
  }
  return out;
}

/** 收集脚本里除字典块外出现的所有引号字符串（近似「间接引用」：map/helper/ternary 的 key）。 */
export function collectIndirectKeys(script, dictStart, dictEnd) {
  const outside = script.slice(0, dictStart) + '\n' + script.slice(dictEnd + 1);
  const out = new Set();
  for (const m of outside.matchAll(/['"]([A-Za-z][A-Za-z0-9_]*)['"]/g)) out.add(m[1]);
  return out;
}

/**
 * 核对一组来源（data-i18n / T()）对单个字典的集合关系，纯函数无副作用。
 * 语言集合 = Object.keys(dict) 除 en 外，逐一与 en 比对键集合对称；没有的语言不核对。
 *
 * 返回：
 *   enKeys     en 键集合
 *   langKeys   [{ lang, keys }] 其他语言键集合（按字典声明顺序）
 *   dataMissing  data-i18n 里有、en 没有
 *   tMissing     T() 里有、en 没有
 *   asym         [{ lang, enOnly, langOnly }]：en 有该语言没有 / 该语言有 en 没有
 */
export function checkSets({ dict, dataKeys, tKeys, enOnlyAllow = EN_ONLY_ALLOW }) {
  const en = dict.en || {};
  const enKeys = Object.keys(en);
  const langKeys = Object.keys(dict)
    .filter((l) => l !== 'en')
    .map((lang) => ({ lang, keys: Object.keys(dict[lang] || {}) }));

  const dataMissing = dataKeys.filter((k) => !(k in en));
  const tMissing = tKeys.filter((k) => !(k in en));

  const asym = langKeys.map(({ lang, keys }) => ({
    lang,
    enOnly: enKeys.filter((k) => !(k in dict[lang]) && !enOnlyAllow.has(k)),
    langOnly: keys.filter((k) => !(k in en)),
  }));

  return { enKeys, langKeys, dataMissing, tMissing, asym };
}

/**
 * 解析 admin.ts 全部 HTML 块的内联字典 + key 引用来源。
 * 返回 [{ name, dict, script, dictStart, dictEnd, dataKeys, tKeys }]。
 */
export function parseI18n(src) {
  return ['ADMIN_HTML', 'LOGIN_HTML'].map((name) => {
    const html = extractHtml(src, name);
    const { dict, script, dictStart, dictEnd } = extractI18N(html);
    const dataKeys = collectDataI18n(html);
    const tKeys = collectTCalls(script);
    return { name, dict, script, dictStart, dictEnd, dataKeys, tKeys };
  });
}

// ---- 主流程（仅直接运行脚本时执行） ----
// realpath 归一化两侧：argv[1] 可能带着用户输入的字面路径（macOS /var → /private/var 等
// 符号链接），import.meta.url 是真实路径，直接比会误判「不是主入口」。
const IS_MAIN =
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (IS_MAIN) {
  try {
    const src = fs.readFileSync(ADMIN_TS, 'utf8');
    console.log(`核对 i18n（${ADMIN_TS}）`);

    let failures = 0;
    const warnings = [];

    for (const { name, dict, script, dictStart, dictEnd, dataKeys, tKeys } of parseI18n(src)) {
      const res = checkSets({ dict, dataKeys, tKeys });
      const keySummary = [
        ['en', res.enKeys.length],
        ...res.langKeys.map(({ lang, keys }) => [lang, keys.length]),
      ]
        .map(([lang, n]) => `${lang} ${n} 个`)
        .join(' == ');

      for (const k of res.dataMissing) {
        failures++;
        console.error(`  [${name}] 缺 en 词条（来源 data-i18n）：${k}`);
      }
      for (const k of res.tMissing) {
        failures++;
        console.error(`  [${name}] 缺 en 词条（来源 T()）：${k}`);
      }
      for (const { lang, enOnly, langOnly } of res.asym) {
        for (const k of enOnly) {
          failures++;
          console.error(`  [${name}] 缺 ${lang} 词条（来源 en 字典）：${k}`);
        }
        for (const k of langOnly) {
          failures++;
          console.error(`  [${name}] 缺 en 词条（来源 ${lang} 字典）：${k}`);
        }
      }

      const ok =
        !res.dataMissing.length &&
        !res.tMissing.length &&
        res.asym.every((x) => !x.enOnly.length && !x.langOnly.length);
      if (ok) {
        console.log(`  [${name}] ok：data-i18n ${dataKeys.length} 个 / T() ${tKeys.length} 个 / ${keySummary}`);
      }

      // 死词条：字典有、生产代码（data-i18n / T() / 间接引用）都没用到 → warning。
      const used = new Set([...dataKeys, ...tKeys, ...collectIndirectKeys(script, dictStart, dictEnd)]);
      const dead = res.enKeys.filter((k) => !used.has(k));
      if (dead.length) {
        warnings.push(`[${name}] 死词条 ${dead.length} 个（字典有但未引用）：${dead.join(', ')}`);
      }
    }

    if (failures > 0) {
      console.error(`\n${failures} 处缺失/不对称，exit 1`);
      process.exit(1);
    }

    for (const w of warnings) console.warn(`\nwarning: ${w}`);
    console.log(warnings.length ? `\n通过（${warnings.length} 条死词条 warning，不阻塞）` : '\n通过');
  } catch (err) {
    console.error(`check-i18n 失败：${err.message}`);
    process.exit(1);
  }
}
