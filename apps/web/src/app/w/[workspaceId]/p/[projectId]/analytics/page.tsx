'use client';

import { useParams } from 'next/navigation';
import { AnalyticsWorkspace } from '@/ui/AnalyticsWorkspace';

export default function AnalyticsPage() {
  const params = useParams<{ workspaceId: string; projectId: string }>();
  return <AnalyticsWorkspace workspaceId={params.workspaceId} projectId={params.projectId} />;
}
