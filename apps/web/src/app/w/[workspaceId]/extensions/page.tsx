'use client';

import { useParams } from 'next/navigation';
import { WorkspaceExtensions } from '@/components/quiet-frame/workspace-extensions';

export default function ExtensionsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return <WorkspaceExtensions workspaceId={workspaceId} />;
}
