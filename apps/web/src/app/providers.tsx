'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AncsClient } from '@ancs/sdk';
import { AncsClientProvider } from '@/lib/client';
import { I18nProvider } from '@/i18n/I18nProvider';
import type { Locale } from '@/i18n/locale';

/** 应用装配：TanStack Query（服务端状态）+ SDK 客户端（可注入，测试用）+ 界面语言。 */
export function Providers({ client, locale, children }: { client?: AncsClient; locale?: Locale; children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5_000 },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <AncsClientProvider {...(client !== undefined ? { client } : {})}>
        <I18nProvider {...(locale !== undefined ? { initialLocale: locale } : {})}>{children}</I18nProvider>
      </AncsClientProvider>
    </QueryClientProvider>
  );
}
