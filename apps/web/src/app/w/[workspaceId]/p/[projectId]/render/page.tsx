'use client';

import { useParams } from 'next/navigation';
import { DeliveryRender } from '@/components/quiet-frame/delivery-render';

export default function RenderPage() {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  return <DeliveryRender workspaceId={workspaceId} projectId={projectId} />;
}
