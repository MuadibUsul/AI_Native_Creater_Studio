'use client';

import { useParams } from 'next/navigation';
import { WorkflowDirector } from '@/components/quiet-frame/workflow-director';

/** Deep links restore the selected scene without changing the editing protocol. */
export default function SceneEditorPage() {
  const { sceneId } = useParams<{ sceneId: string }>();
  return <WorkflowDirector initialSceneId={sceneId} />;
}
