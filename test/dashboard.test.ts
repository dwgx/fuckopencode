import { describe, expect, it } from 'vitest';
import { DASHBOARD_HTML } from '../src/dashboard.js';

/**
 * 面板是单文件内联 HTML：整个页面是一个 `String.raw` 模板字符串，
 * 里面塞着 CSS + HTML + 原生 JS。**这些内容对 TypeScript 而言只是字符串**，
 * 所以那 700 多行前端代码不受任何静态检查保护。
 *
 * 这不是假设，是实测过的：往模板里的 JS 塞一个明显的语法错误
 * （`keypool(m.pool;` 外加一行 `function {{ BROKEN`），
 * `npm run typecheck`、`npm run build`、`npm test` 326 个用例**全部通过**。
 * 这和本项目踩过的裸 `require` 事故是同一类漏洞：检查看不见的地方就是盲区。
 *
 * 这个文件就是那道兜底。
 */

/** 抠出内联 `<script>` 的内容。 */
function inlineScript(): string {
  const m = DASHBOARD_HTML.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('面板 HTML 里找不到内联 <script>');
  return m[1]!;
}

describe('面板内联 JS 的语法完整性', () => {
  it('内联 script 能被 JS 引擎解析（唯一能抓住模板里语法错误的检查）', () => {
    const code = inlineScript();
    expect(code.length).toBeGreaterThan(1000);
    // new Function 只解析不执行：语法错误立刻抛 SyntaxError，
    // 而里面的 DOM 调用不会真的跑起来。
    expect(() => new Function(code)).not.toThrow();
  });

  it('模板里没有漏进反引号（会提前闭合 String.raw 模板）', () => {
    // 源码层面检查：模板内出现反引号会把模板截断，
    // 后果是一大段页面变成 TS 代码、报一堆莫名的类型错。
    // 这里检查产物 —— 产物里不该有反引号（面板 JS 全用字符串拼接）。
    expect(DASHBOARD_HTML).not.toContain('`');
  });

  it('没有未被 String.raw 处理的 ${} 插值残留', () => {
    // String.raw 不阻止 ${} 插值。模板里如果不小心写了 ${x}，
    // 会在构建期求值而不是留给浏览器 —— 但真写错了通常是编译错误。
    // 这里断言产物里没有残留的字面 ${，避免有人误以为它会被前端解释。
    expect(DASHBOARD_HTML).not.toContain('${');
  });
});

describe('面板关键渲染入口没有被误删', () => {
  /**
   * 变异测试暴露的另一类盲区：把 `keypool(m.pool)` 这行调用删掉，
   * 面板不再渲染整个 key 池小节，而所有测试照样全绿。
   * 这几条断言把「本轮加的东西真的被接上了」钉住。
   */
  it('key 池小节的渲染函数被真正调用', () => {
    const code = inlineScript();
    expect(code).toContain('function keypool(');
    expect(code).toMatch(/keypool\(\s*m\.pool\s*\)/);
  });

  it('冷却倒计时定时器被装上', () => {
    const code = inlineScript();
    expect(code).toContain('function tickCountdown(');
    expect(code).toMatch(/setInterval\(\s*tickCountdown/);
  });

  it('面板骨架里有 key 池要用的挂载点', () => {
    for (const id of ['keys', 'kevs', 'n-pool']) {
      expect(DASHBOARD_HTML).toContain(`id="${id}"`);
    }
  });
});

describe('i18n 词条 en/zh 对齐', () => {
  /**
   * 缺词条不会报错，只会在界面上显示成 key 名（`T()` 回退到原字符串），
   * 静态检查同样看不见。这里把两份字典的键集合比出来。
   */
  function dictKeys(lang: 'en' | 'zh'): string[] {
    const code = inlineScript();
    // 定位 I18N.<lang> = { ... } 那段，取到下一个 };
    const start = code.indexOf(`${lang}:`);
    expect(start).toBeGreaterThan(-1);
    const slice = code.slice(start);
    const end = slice.indexOf('\n    }');
    const body = slice.slice(0, end > 0 ? end : 4000);
    // 只认「行首或紧跟逗号」的标识符，否则会把词条**内容**里的英文单词
    // 误当成键（实测 `kept short on purpose: 429 ...` 里的 purpose、
    // `routing: least in-flight first` 里的 routing 都会被误抓）。
    return [...body.matchAll(/(?:^\s+|,\s*)([A-Za-z][\w]*)\s*:/gm)]
      .map((m) => m[1]!)
      // 字典自身的标签 `en:` / `zh:` 不是词条。
      .filter((k) => k !== lang);
  }

  it('两种语言的词条键集合一致', () => {
    const en = new Set(dictKeys('en'));
    const zh = new Set(dictKeys('zh'));
    expect(en.size).toBeGreaterThan(30);
    const onlyEn = [...en].filter((k) => !zh.has(k));
    const onlyZh = [...zh].filter((k) => !en.has(k));
    expect({ onlyEn, onlyZh }).toEqual({ onlyEn: [], onlyZh: [] });
  });

  it('本轮新增的 key 池词条都在', () => {
    const en = new Set(dictKeys('en'));
    for (const k of ['keypool', 'kInflight', 'kState', 'kReason', 'kRecover', 'carrying', 'poolIdle']) {
      expect(en.has(k)).toBe(true);
    }
  });

  it('冷却策略小节的词条都在（en/zh 都有）', () => {
    const en = new Set(dictKeys('en'));
    const zh = new Set(dictKeys('zh'));
    for (const k of ['polHd', 'polUpstream', 'polFallback', 'polFirstHit', 'polAfterN',
                     'polBackoff', 'polQuotaNote', 'polAuthNote', 'polRateNote', 'polCfg']) {
      expect(en.has(k), `en 缺 ${k}`).toBe(true);
      expect(zh.has(k), `zh 缺 ${k}`).toBe(true);
    }
  });
});

describe('冷却策略小节接线完整', () => {
  it('policy 渲染函数存在且被调用', () => {
    const code = inlineScript();
    expect(code).toContain('function policy(');
    expect(code).toMatch(/policy\(\s*pool\.policy\s*\)/);
  });

  it('骨架里有 kpol 挂载点', () => {
    expect(DASHBOARD_HTML).toContain('id="kpol"');
  });

  it('带占位符的词条真的做了替换（不能把 {n}/{base} 直接显示给用户）', () => {
    const code = inlineScript();
    expect(code).toContain(".replace('{n}'");
    expect(code).toContain(".replace('{base}'");
  });
});
