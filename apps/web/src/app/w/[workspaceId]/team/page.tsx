'use client';

import { useParams } from 'next/navigation';
import { TeamManagement } from '@/ui/TeamManagement';
import styles from '@/components/quiet-frame/legacy.module.css';

/**
 * 团队与隐私页面（P09-04 / §22、§20.4）：成员/邀请管理、席位与超额提示、隐私档位。
 */

export default function TeamPage() {
  const params = useParams<{ workspaceId: string }>();
  return <div className="page narrow"><header className="sectionhead"><div><div className="eyebrow mb16">WORKSPACE / PEOPLE</div><h1>团队与隐私</h1><p>管理成员、邀请、席位和工作区隐私。</p></div></header><div className={styles['surface']}><TeamManagement workspaceId={params.workspaceId} /></div></div>;
}
