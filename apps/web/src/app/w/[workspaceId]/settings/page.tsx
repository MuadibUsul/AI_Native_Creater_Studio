'use client';

import { useParams } from 'next/navigation';
import { WorkspaceSettings } from '@/components/quiet-frame/workspace-settings';

export default function SettingsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return <WorkspaceSettings workspaceId={workspaceId} />;
}
