'use client';

import { useParams } from 'next/navigation';
import { CreditsBilling } from '@/ui/CreditsBilling';

/**
 * Credits 与账单页面（P09-03 / §35、§73.3）：余额/预扣/可用 + 包目录购买 + 明细 + 对账。
 */

export default function BillingPage() {
  const params = useParams<{ workspaceId: string }>();
  return <CreditsBilling workspaceId={params.workspaceId} />;
}
