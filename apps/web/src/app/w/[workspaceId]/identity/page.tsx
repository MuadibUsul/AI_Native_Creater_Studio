'use client';

import { useParams } from 'next/navigation';
import { WorkspaceIdentity } from '@/components/quiet-frame/workspace-identity';

export default function IdentityPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return <WorkspaceIdentity workspaceId={workspaceId} />;
}
