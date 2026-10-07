'use client';

import { useParams } from 'next/navigation';
import { DeliveryPublish } from '@/components/quiet-frame/delivery-publish';

export default function PublishPage() {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  return <DeliveryPublish workspaceId={workspaceId} projectId={projectId} />;
}
