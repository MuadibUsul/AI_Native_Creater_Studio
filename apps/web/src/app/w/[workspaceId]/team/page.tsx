'use client';

import { useParams } from 'next/navigation';
import { TeamManagement } from '@/ui/TeamManagement';

/**
 * 团队与隐私页面（P09-04 / §22、§20.4）：成员/邀请管理、席位与超额提示、隐私档位。
 */

export default function TeamPage() {
  const params = useParams<{ workspaceId: string }>();
  return <TeamManagement workspaceId={params.workspaceId} />;
}
