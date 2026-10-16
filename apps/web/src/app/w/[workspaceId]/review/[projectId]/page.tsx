'use client';

import { useParams } from 'next/navigation';
import { ReviewRoom } from '@/review/ReviewRoom';

/** V6-4 批注式审片（手机网页优先；桌面同样可用）。 */
export default function ReviewPage() {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  return <ReviewRoom workspaceId={workspaceId} projectId={projectId} />;
}
