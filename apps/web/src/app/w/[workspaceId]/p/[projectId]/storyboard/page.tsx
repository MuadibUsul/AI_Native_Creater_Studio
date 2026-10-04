'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useNarrative, useSceneGraph } from '@/lib/queries';
import { PreviewPlayer } from '@/ui/PreviewPlayer';
import { ScenePreview } from '@/ui/ScenePreview';
import { StateBlock } from '@/ui/StateBlock';

/**
 * Storyboard 页面（P05-03）：场景序列 + 组件缩略预览（与成片同源的组件注册表）。
 * 空项目提供「应用 Director 计划」：确定性规划（视觉语法 → 场景/资产/任务/成本/告警）经编辑协议原子应用。
 * 状态矩阵：加载 / 失败 / 空（无叙事或无场景）/ 正常 / 冲突（已有场景 409）。
 */

export default function StoryboardPage() {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const params = useParams<{ workspaceId: string; projectId: string }>();
  const workspaceId = params.workspaceId;
  const projectId = params.projectId;

  const graph = useSceneGraph(workspaceId, projectId);
  const narrative = useNarrative(workspaceId, projectId);

  /**
   * 素材解析（预览用）：assetId → 预览 URL（Signed URL）。
   * 未解析（未绑定/解析失败）→ 组件自身的明确占位；**解析不触发任何生成调用**。
   */
  const assetUrls = useQuery({
    queryKey: [...queryKeys.assets(workspaceId, projectId), 'preview-urls'],
    enabled: graph.data !== undefined,
    queryFn: async () => {
      const ids = [...new Set((graph.data?.scenes ?? []).flatMap((scene) => scene.assetBindings.map((binding) => binding.assetId)))];
      const entries = await Promise.all(
        ids.map(async (assetId) => {
          try {
            const response = await client.assets.downloadUrl(workspaceId, assetId);
            return [assetId, response.url] as const;
          } catch {
            return [assetId, null] as const;
          }
        }),
      );
      return new Map(entries);
    },
  });
  const resolveAssetUrl = (assetId: string): string | null => assetUrls.data?.get(assetId) ?? null;

  const applyDirector = useMutation({
    mutationFn: async () => {
      const plan = narrative.data;
      if (plan === null || plan === undefined) throw new Error('缺少叙事计划：先在 Script 页生成叙事');
      return client.narrative.applyDirectorPlan(workspaceId, projectId, plan.id, {
        idempotencyKey: `idem_web_director_${plan.id}_${String(plan.revision)}`,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.graph(workspaceId, projectId) });
    },
  });

  if (graph.isPending) return <StateBlock variant="loading" title="正在加载分镜…" />;
  if (graph.isError) {
    const described = describeError(graph.error);
    return (
      <StateBlock
        variant={described.kind === 'forbidden' ? 'forbidden' : 'error'}
        title="加载分镜失败"
        description={described.message}
        diagnostics={described.code ?? undefined}
        action={{ label: '重试', onClick: () => void graph.refetch() }}
      />
    );
  }

  const scenes = graph.data?.scenes ?? [];
  if (scenes.length === 0) {
    const described = applyDirector.isError ? describeError(applyDirector.error) : null;
    return (
      <StateBlock
        variant={described?.kind === 'conflict' ? 'conflict' : 'empty'}
        title="分镜还是空的"
        description="用 Director 把叙事计划转成场景序列：语义识别 → 场景类型 → 数据/来源门控（§10.3）→ 资产与任务计划。应用前会通过 Schema/来源/Lock/预算四类验证。"
        diagnostics={described?.code ?? undefined}
        action={{
          label: applyDirector.isPending ? '规划和应用中…' : '应用 Director 计划',
          onClick: () => applyDirector.mutate(),
          disabled: applyDirector.isPending || narrative.data === null,
        }}
      >
        {described !== null ? <p className="text-xs text-rose-300">{described.message}</p> : null}
        {narrative.data === null ? <p className="text-xs text-amber-300">先在 Script 页生成叙事计划。</p> : null}
      </StateBlock>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Storyboard</h1>
        <span className="text-xs text-slate-400">
          project revision {graph.data?.projectRevision} · {scenes.length} 个场景
        </span>
      </div>
      {/* Preview（P05-04）：Remotion Player 消费 Graph；与成片共用时序映射 */}
      <section data-testid="preview-panel" className="rounded border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-300">Preview</h2>
        <PreviewPlayer graph={graph.data} resolveAssetUrl={resolveAssetUrl} width={720} />
      </section>

      <ol className="flex flex-col gap-3">
        {scenes.map((scene) => (
          <li key={scene.id} className="flex gap-4 rounded border border-slate-800 bg-slate-900/60 p-3">
            <ScenePreview
              sceneType={scene.sceneType}
              componentVersion={scene.componentVersion}
              props={scene.props}
              durationMs={scene.durationMs}
              width={320}
            />
            <div className="flex flex-1 flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  #{scene.position} {scene.sceneType}
                  <span className="ml-2 text-xs text-slate-500">{scene.semanticType}</span>
                </span>
                <span className="text-xs text-slate-500">
                  {scene.durationMs} ms {scene.locked ? '· 已锁定' : ''}
                </span>
              </div>
              <p className="text-sm text-slate-300">{scene.narration === '' ? '（无旁白，结构场景）' : scene.narration}</p>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span>
                  数据绑定 {scene.dataBindings.length} · 来源绑定 {scene.sourceBindings.length} · 资产 {scene.assetBindings.length}
                </span>
                <Link className="text-sky-300 hover:underline" href={`/w/${workspaceId}/p/${projectId}/editor/${scene.id}`}>
                  编辑场景
                </Link>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
