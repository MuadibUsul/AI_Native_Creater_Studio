import { describe, expect, it } from 'vitest';
import { EFFECT_TEMPLATES, findEffectTemplate, resolveEffectParams } from './effect-templates.js';
import { narrationLanguage, splitNarrationSentences } from './agent-narration.js';
import { ARTICLE_CONTEXT_CHARS, articleContextView, articleParagraphs } from './agent-article.js';
import { numbersIn, numbersMissingFromSource } from './source-numbers.js';

/**
 * V6-5 讲述与图解的纯函数：句子切分（字幕按句出现、逐句合成）、语言判断（声音能不能说）、
 * 数据图解的数字来源校验（不得虚构数值）、文章分段进入上下文、图解模板的文字参数。
 */

describe('V6-5 讲述稿切句与语言', () => {
  it('中英文句末标点切句；小数与缩写里的点不切；右引号并入本句；只有标点的碎片并到前一句', () => {
    expect(splitNarrationSentences('Water covers 71 percent of Earth. Only 2.5 percent is fresh water! Why does it matter?'))
      .toEqual(['Water covers 71 percent of Earth.', 'Only 2.5 percent is fresh water!', 'Why does it matter?']);
    expect(splitNarrationSentences('地球表面约 71% 是水。淡水只占 2.5%！为什么？'))
      .toEqual(['地球表面约 71% 是水。', '淡水只占 2.5%！', '为什么？']);
    expect(splitNarrationSentences('He said "stop." Then he left'))
      .toEqual(['He said "stop."', 'Then he left']);
    expect(splitNarrationSentences('  ')).toEqual([]);
    expect(splitNarrationSentences('Wait... what?!')).toEqual(['Wait...', 'what?!']);
  });

  it('过长的句子按逗号再切，每句不超过 200 字', () => {
    const long = `${'a'.repeat(150)}, ${'b'.repeat(150)}, ${'c'.repeat(150)}.`;
    const sentences = splitNarrationSentences(long);
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    expect(sentences.every((sentence) => sentence.length <= 200)).toBe(true);
    expect(sentences.join('').replace(/[ ,.]/g, '')).toBe(`${'a'.repeat(150)}${'b'.repeat(150)}${'c'.repeat(150)}`);
  });

  it('语言：含汉字 → zh，否则 en', () => {
    expect(narrationLanguage('Hello world')).toBe('en');
    expect(narrationLanguage('Hello 世界')).toBe('zh');
  });
});

describe('V6-5 数据图解的数字必须出自来源', () => {
  it('数值规范化：千分位、尾零、全角数字视为同一个数；年份和小数都是数', () => {
    expect(numbersIn('1,200 people in 2019 spent 3.50 dollars, ５０ more')).toEqual(['1200', '2019', '3.5', '50']);
    expect(numbersIn('ratio 3,5')).toEqual(['3', '5']);
    expect(numbersIn('no numbers')).toEqual([]);
  });

  it('找出来源里没有的数（推算、四舍五入出来的新数字不认）', () => {
    const source = 'In 2023 the city planted 1,200 trees, up from 800 in 2022. Survival was 92.5 percent.';
    expect(numbersMissingFromSource(['Trees planted', '2022: 800|2023: 1200', 'trees'], source)).toEqual([]);
    expect(numbersMissingFromSource(['Growth', 'Increase: 400'], source)).toEqual(['400']);
    expect(numbersMissingFromSource(['92.5%', '93%'], source)).toEqual(['93']);
  });
});

describe('V6-5 文章进入上下文', () => {
  it('按换行分段、去空段；上下文按字数截断并给出续读位置', () => {
    expect(articleParagraphs('First paragraph.\n\n\nSecond  paragraph.\r\nThird.')).toEqual(['First paragraph.', 'Second paragraph.', 'Third.']);
    const paragraph = 'x'.repeat(1_000);
    const view = articleContextView({ title: 'Long', text: Array.from({ length: 20 }, () => paragraph).join('\n') });
    expect(view.totalParagraphs).toBe(20);
    expect(view.paragraphs.length).toBe(ARTICLE_CONTEXT_CHARS / 1_000);
    expect(view.continuesFrom).toBe(view.paragraphs.length + 1);
    expect(view.contentTreatment).toBe('REFERENCE_DATA_ONLY');
    expect(articleContextView({ title: 'Short', text: 'One.\nTwo.' })).toMatchObject({ totalParagraphs: 2, continuesFrom: null, paragraphs: [{ n: 1, text: 'One.' }, { n: 2, text: 'Two.' }] });
  });
});

describe('V6-5 图解模板', () => {
  it('六个图解模板：整画面、文字参数带长度上限；数据类模板要求数字出自来源', () => {
    const ids = ['title-card', 'key-points', 'bar-chart', 'big-number', 'steps', 'quote'];
    for (const id of ids) {
      const template = findEffectTemplate(id);
      expect(template, id).toBeDefined();
      expect(template!.coverage).toBe('FULL_FRAME');
      expect(template!.params.some((param) => param.kind === 'text' && param.maxLength !== undefined)).toBe(true);
      expect(template!.params.find((param) => param.key === 'backdrop')?.options).toEqual(['solid', 'none']);
    }
    expect(EFFECT_TEMPLATES.filter((template) => template.numbersFromSource).map((template) => template.id).sort()).toEqual(['bar-chart', 'big-number']);
    // V6-3 的特效模板不受影响
    expect(findEffectTemplate('burst')!.numbersFromSource).toBe(false);
  });

  it('文字参数：去首尾空白、超长截断并报告；缺省用默认值', () => {
    const template = findEffectTemplate('title-card')!;
    const { params, issues } = resolveEffectParams(template, { title: `  ${'T'.repeat(100)}  `, accent: '#ff0000' });
    expect(params['title']).toBe('T'.repeat(80));
    expect(issues).toEqual(['title: longer than 80 characters, cut']);
    expect(params['subtitle']).toBe('');
    expect(params['backdrop']).toBe('solid');
  });
});
