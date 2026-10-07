'use client';

import { useParams } from 'next/navigation';
import { DeliveryAssets } from '@/components/quiet-frame/delivery-assets';

export default function WorkspaceAssetsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return <DeliveryAssets workspaceId={workspaceId} />;
}
