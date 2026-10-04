'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AncsClient } from '@ancs/sdk';
import { AncsClientProvider } from '@/lib/client';

/** 应用装配：TanStack Query（服务端状态）+ SDK 客户端（可注入，测试用）。 */
export function Providers({ client, children }: { client?: AncsClient; children: ReactNode }) {
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
      <AncsClientProvider {...(client !== undefined ? { client } : {})}>{children}</AncsClientProvider>
    </QueryClientProvider>
  );
}
