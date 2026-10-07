'use client';

import { useParams } from 'next/navigation';
import { DeliveryAnalytics } from '@/components/quiet-frame/delivery-analytics';

export default function AnalyticsPage() {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  return <DeliveryAnalytics workspaceId={workspaceId} projectId={projectId} />;
}
