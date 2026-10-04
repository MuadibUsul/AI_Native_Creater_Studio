'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useSceneGraph } from '@/lib/queries';
import { StateBlock } from '@/ui/StateBlock';

/** Scene Editor 入口（P05-03）：列出场景并进入具体场景编辑。 */
export default function EditorIndexPage() {
  const params = useParams<{ workspaceId: string; projectId: string }>();
  const graph = useSceneGraph(params.workspaceId, params.projectId);

  if (graph.isPending) return <StateBlock variant="loading" title="正在加载场景…" />;
  if (graph.isError) {
    return <StateBlock variant="error" title="加载场景失败" action={{ label: '重试', onClick: () => void graph.refetch() }} />;
  }
  const scenes = graph.data?.scenes ?? [];
  if (scenes.length === 0) {
    return (
      <StateBlock
        variant="empty"
        title="没有可编辑的场景"
        description="先在 Storyboard 页应用 Director 计划生成场景序列。"
        action={{ label: '去 Storyboard', onClick: () => { window.location.href = `/w/${params.workspaceId}/p/${params.projectId}/storyboard`; } }}
      />
    );
  }
  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-xl font-semibold">Scene Editor</h1>
      <ul className="flex flex-col gap-2">
        {scenes.map((scene) => (
          <li key={scene.id} className="rounded border border-slate-800 bg-slate-900/60 p-3 text-sm">
            <Link className="text-sky-300 hover:underline" href={`/w/${params.workspaceId}/p/${params.projectId}/editor/${scene.id}`}>
              #{scene.position} {scene.sceneType}（revision {scene.revision}）
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
