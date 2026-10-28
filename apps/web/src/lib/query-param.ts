'use client';

import { useSearchParams } from 'next/navigation';

/** 读一个查询参数（如邮件链接里的 token、预填的 email）；不在 App Router 上下文里（组件测试）时为 null。 */
export function useQueryParam(name: string): string | null {
  const params = useSearchParams() as ReturnType<typeof useSearchParams> | null;
  return params?.get(name) ?? null;
}
