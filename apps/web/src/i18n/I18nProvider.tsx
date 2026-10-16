'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_LOCALE, saveLocaleCookie, type Locale } from './locale';
import { MESSAGES, type Messages } from './messages';

interface I18nValue {
  locale: Locale;
  messages: Messages;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nValue>({ locale: DEFAULT_LOCALE, messages: MESSAGES[DEFAULT_LOCALE], setLocale: () => undefined });

/** 界面语言：首屏由服务端按 Cookie/Accept-Language 决定；切换只改本设备（Cookie），不重建页面状态。 */
export function I18nProvider({ initialLocale = DEFAULT_LOCALE, children }: { initialLocale?: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    saveLocaleCookie(next);
    document.documentElement.lang = next;
  }, []);
  const value = useMemo(() => ({ locale, messages: MESSAGES[locale], setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
