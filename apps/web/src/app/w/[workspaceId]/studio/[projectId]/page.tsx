'use client';

import { useParams } from 'next/navigation';
import { StudioRoom } from '@/studio/StudioRoom';

/** V6-1c 共看片室（单屏工作台，不套用旧项目布局）。 */
export default function StudioPage() {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  return <StudioRoom workspaceId={workspaceId} projectId={projectId} />;
}
