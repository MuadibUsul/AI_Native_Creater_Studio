/**
 * 界面语言（V6：新界面一律中英双语）。
 *
 * - 选择优先级：本设备明确选择（Cookie）→ 浏览器 Accept-Language → 中文；
 * - 服务端首屏按 Cookie 渲染同一语言，避免 hydration 时先中后英的闪烁；
 * - 只决定界面文案；作品内容（字幕、讲述）的语言由作品自身决定。
 */

export const LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'zh-CN';
export const LOCALE_COOKIE = 'ancs-locale';

export function parseLocale(value: string | null | undefined): Locale | null {
  return value === 'zh-CN' || value === 'en' ? value : null;
}

/** 按 Accept-Language 的先后顺序取第一个能支持的语言（只区分中文/英文）。 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  for (const part of acceptLanguage.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase() ?? '';
    if (tag.startsWith('zh')) return 'zh-CN';
    if (tag.startsWith('en')) return 'en';
  }
  return DEFAULT_LOCALE;
}

export function saveLocaleCookie(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
