'use client';

import { useParams } from 'next/navigation';
import { DeliveryAssets } from '@/components/quiet-frame/delivery-assets';

export default function AssetsPage() {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  return <DeliveryAssets workspaceId={workspaceId} projectId={projectId} />;
}
