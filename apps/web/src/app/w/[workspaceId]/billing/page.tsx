'use client';

import { useParams } from 'next/navigation';
import { useI18n } from '@/i18n/I18nProvider';
import { CreditsBilling } from '@/ui/CreditsBilling';
import styles from '@/components/quiet-frame/legacy.module.css';

/**
 * Credits 与账单页面（P09-03 / §35、§73.3）：余额/预扣/可用 + 包目录购买 + 明细 + 对账。
 */

export default function BillingPage() {
  const params = useParams<{ workspaceId: string }>();
  const t = useI18n().messages.workspaceAdmin.billingPage;
  return <div className="page narrow"><header className="sectionhead"><div><div className="eyebrow mb16">{t.eyebrow}</div><h1>{t.title}</h1><p>{t.lead}</p></div></header><div className={styles['surface']}><CreditsBilling workspaceId={params.workspaceId} /></div></div>;
}
