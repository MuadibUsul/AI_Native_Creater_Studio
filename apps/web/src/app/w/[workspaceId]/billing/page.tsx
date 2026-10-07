'use client';

import { useParams } from 'next/navigation';
import { CreditsBilling } from '@/ui/CreditsBilling';
import styles from '@/components/quiet-frame/legacy.module.css';

/**
 * Credits 与账单页面（P09-03 / §35、§73.3）：余额/预扣/可用 + 包目录购买 + 明细 + 对账。
 */

export default function BillingPage() {
  const params = useParams<{ workspaceId: string }>();
  return <div className="page narrow"><header className="sectionhead"><div><div className="eyebrow mb16">WORKSPACE / BILLING</div><h1>额度与账单</h1><p>余额、用量、套餐和账本记录以服务端状态为准。</p></div></header><div className={styles['surface']}><CreditsBilling workspaceId={params.workspaceId} /></div></div>;
}
