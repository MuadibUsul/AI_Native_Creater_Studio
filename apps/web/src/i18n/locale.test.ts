import { describe, expect, it } from 'vitest';
import { FALLBACK_LOCALE, negotiateLocale, parseLocale } from './locale';

describe('界面语言协商（面向全球市场）', () => {
  it('按 Accept-Language 先后取第一个支持的语言', () => {
    expect(negotiateLocale('zh-TW,zh;q=0.9,en;q=0.8')).toBe('zh-CN');
    expect(negotiateLocale('en-GB,en;q=0.9')).toBe('en');
    expect(negotiateLocale('de-DE,de;q=0.9,en;q=0.5,zh;q=0.3')).toBe('en');
    expect(negotiateLocale('fr-FR,zh-CN;q=0.5')).toBe('zh-CN');
  });

  it('浏览器语言都不支持或没带时用英文', () => {
    expect(FALLBACK_LOCALE).toBe('en');
    expect(negotiateLocale('de-DE,fr;q=0.8')).toBe('en');
    expect(negotiateLocale('')).toBe('en');
    expect(negotiateLocale(null)).toBe('en');
    expect(negotiateLocale(undefined)).toBe('en');
  });

  it('Cookie 只接受支持的语言', () => {
    expect(parseLocale('en')).toBe('en');
    expect(parseLocale('zh-CN')).toBe('zh-CN');
    expect(parseLocale('de')).toBeNull();
  });
});
