'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createClient, type AncsClient } from '@ancs/sdk';

/**
 * 客户端 SDK 装配（裁决 0005 / 计划 §3.4）：
 * 业务读写一律经 @ancs/sdk（浏览器下由 credentials:'include' 承载会话 Cookie）；
 * 测试通过 AncsClientProvider 注入脚本化客户端，页面组件不直接构造 SDK。
 */

export const DEFAULT_API_BASE_URL = 'http://localhost:3001';

export function createWebClient(baseUrl?: string): AncsClient {
  const resolved = baseUrl ?? process.env['NEXT_PUBLIC_ANCS_API_URL'] ?? DEFAULT_API_BASE_URL;
  return createClient({ baseUrl: resolved, clientType: 'web', clientVersion: '0.1.0' });
}

const AncsClientContext = createContext<AncsClient | null>(null);

export function AncsClientProvider({ client, children }: { client?: AncsClient; children: ReactNode }) {
  const value = useMemo(() => client ?? createWebClient(), [client]);
  return <AncsClientContext.Provider value={value}>{children}</AncsClientContext.Provider>;
}

export function useAncsClient(): AncsClient {
  const client = useContext(AncsClientContext);
  if (client === null) {
    throw new Error('缺少 AncsClientProvider：页面必须经 SDK（@ancs/sdk）访问业务 API');
  }
  return client;
}
