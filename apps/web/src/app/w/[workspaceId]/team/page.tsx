'use client';

import { useParams } from 'next/navigation';
import { useI18n } from '@/i18n/I18nProvider';
import { TeamManagement } from '@/ui/TeamManagement';
import styles from '@/components/quiet-frame/legacy.module.css';

/**
 * 团队与隐私页面（P09-04 / §22、§20.4）：成员/邀请管理、席位与超额提示、隐私档位。
 */

export default function TeamPage() {
  const params = useParams<{ workspaceId: string }>();
  const t = useI18n().messages.workspaceAdmin.teamPage;
  return <div className="page narrow"><header className="sectionhead"><div><div className="eyebrow mb16">{t.eyebrow}</div><h1>{t.title}</h1><p>{t.lead}</p></div></header><div className={styles['surface']}><TeamManagement workspaceId={params.workspaceId} /></div></div>;
}
