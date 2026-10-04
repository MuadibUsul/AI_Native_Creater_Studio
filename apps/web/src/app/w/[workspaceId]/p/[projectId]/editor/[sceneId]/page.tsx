'use client';

import { useParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError, isVersionConflict } from '@/lib/errors';
import { queryKeys, useSceneGraph } from '@/lib/queries';
import { PropForm } from '@/ui/PropForm';
import { ScenePreview } from '@/ui/ScenePreview';
import { StateBlock } from '@/ui/StateBlock';

/**
 * Scene Editor（P05-03）：props 表单由组件协议驱动（保存前用组件 schema 校验），
 * 通过编辑协议提交（base revision + expected scene revision）；409 → 冲突状态块，可刷新后重试。
 * 写入一律经 SDK（UI 不直连数据库；权威规则在域层）。
 */

export default function SceneEditorPage() {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const params = useParams<{ workspaceId: string; projectId: string; sceneId: string }>();
  const { workspaceId, projectId, sceneId } = params;

  const graph = useSceneGraph(workspaceId, projectId);
  const save = useMutation({
    mutationFn: async (props: Record<string, unknown>) => {
      const current = graph.data;
      if (current === undefined) throw new Error('场景图尚未加载');
      const scene = current.scenes.find((candidate) => candidate.id === sceneId);
      if (scene === undefined) throw new Error('场景不存在（可能是并发删除）');
      return client.projects.edit(projectId, {
        baseProjectRevision: current.projectRevision,
        expectedSceneRevisions: { [scene.id]: scene.revision },
        operations: [{ op: 'update_scene', sceneId: scene.id, changes: { props } }],
        idempotencyKey: `idem_web_scene_${scene.id}_r${String(scene.revision)}_${String(Date.now())}`,
        intent: '编辑器修改场景属性',
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.graph(workspaceId, projectId) });
    },
  });

  if (graph.isPending) return <StateBlock variant="loading" title="正在加载场景…" />;
  if (graph.isError) {
    const described = describeError(graph.error);
    return (
      <StateBlock
        variant={described.kind === 'forbidden' ? 'forbidden' : 'error'}
        title="加载场景失败"
        description={described.message}
        action={{ label: '重试', onClick: () => void graph.refetch() }}
      />
    );
  }

  const scene = graph.data?.scenes.find((candidate) => candidate.id === sceneId);
  if (scene === undefined) {
    return (
      <StateBlock
        variant="error"
        title="场景不存在"
        description="它可能已被删除（例如撤销了一次插入）。请回到 Storyboard 查看当前场景。"
        action={{ label: '刷新场景图', onClick: () => void graph.refetch() }}
      />
    );
  }

  const saveError = save.isError ? describeError(save.error) : null;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">
          {scene.sceneType}
          <span className="ml-2 text-xs text-slate-500">
            #{scene.position} · {scene.semanticType} · revision {scene.revision} {scene.locked ? '· 已锁定' : ''}
          </span>
        </h1>
        <span className="text-xs text-slate-500">project revision {graph.data?.projectRevision}</span>
      </div>

      <div className="flex gap-6">
        <ScenePreview
          sceneType={scene.sceneType}
          componentVersion={scene.componentVersion}
          props={scene.props}
          durationMs={scene.durationMs}
          width={480}
        />
        <div className="flex-1">
          <PropForm
            sceneType={scene.sceneType}
            componentVersion={scene.componentVersion}
            initialProps={scene.props as Record<string, unknown>}
            disabled={save.isPending}
            onSubmit={(props, validation) => {
              if (validation.ok) save.mutate(props);
            }}
          />
        </div>
      </div>

      {scene.locked ? (
        <StateBlock
          variant="info"
          title="该场景已锁定"
          description="AI 不得静默修改锁定场景（§4.7）；如需修改请先在编辑协议中显式解锁（set_scene_lock）。"
        />
      ) : null}

      {save.isSuccess ? <StateBlock variant="info" title="已保存" description={`场景 revision 已更新（项目 revision ${String(save.data.project.revision)}）。`} /> : null}
      {saveError !== null ? (
        <StateBlock
          variant={isVersionConflict(saveError) ? 'conflict' : saveError.kind === 'budget' ? 'error' : 'error'}
          title={isVersionConflict(saveError) ? '保存冲突：数据已被其他编辑更新' : '保存失败'}
          description={isVersionConflict(saveError) ? '请刷新场景图获取最新 revision，再重新提交你的修改。' : saveError.message}
          diagnostics={saveError.code ?? undefined}
          action={{ label: '刷新场景图', onClick: () => void graph.refetch() }}
        />
      ) : null}
    </section>
  );
}
