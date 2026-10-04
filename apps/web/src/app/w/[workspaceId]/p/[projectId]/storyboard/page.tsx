'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useNarrative, useSceneGraph } from '@/lib/queries';
import type { EditPlan } from '@ancs/contracts';
import { AiEditPanel } from '@/ui/AiEditPanel';
import { LiteTimeline, type TimelineEditRequest } from '@/ui/LiteTimeline';
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
  const [editPlan, setEditPlan] = useState<EditPlan | null>(null);

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

  /** Lite Timeline 的编辑提交（P05-05）：统一走编辑协议；成功后失效 graph 查询（刷新后以服务端为准）。 */
  const timelineEdit = useMutation({
    mutationFn: async (request: TimelineEditRequest) => {
      const current = graph.data;
      if (current === undefined) throw new Error('场景图尚未加载');
      return client.projects.edit(projectId, {
        baseProjectRevision: current.projectRevision,
        expectedSceneRevisions: request.expectedSceneRevisions,
        operations: request.operations,
        idempotencyKey: `idem_web_timeline_${String(current.projectRevision)}_${String(Date.now())}`,
        intent: `Lite Timeline：${request.operations.map((operation) => operation.op).join(', ')}`,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.graph(workspaceId, projectId) });
    },
  });

  /** AI Edit（P05-06）：生成计划（不落库）→ 用户确认后经编辑协议 Apply。 */
  const planEdit = useMutation({
    mutationFn: (prompt: string) => client.narrative.aiEditPlan(workspaceId, projectId, { prompt }),
    onSuccess: (plan) => setEditPlan(plan),
  });
  const applyEditPlan = useMutation({
    mutationFn: async (plan: EditPlan) => {
      const current = graph.data;
      if (current === undefined) throw new Error('场景图尚未加载');
      const expectedSceneRevisions: Record<string, number> = {};
      for (const entry of plan.operations) {
        if (entry.sceneId !== null) {
          const scene = current.scenes.find((candidate) => candidate.id === entry.sceneId);
          if (scene !== undefined) expectedSceneRevisions[scene.id] = scene.revision;
        }
      }
      return client.projects.edit(projectId, {
        baseProjectRevision: plan.baseProjectRevision,
        expectedSceneRevisions,
        operations: plan.operations.map((entry) => entry.operation),
        idempotencyKey: `idem_web_aiedit_${plan.planId}`,
        intent: `AI Edit：${plan.prompt.slice(0, 80)}`,
      });
    },
    onSuccess: () => {
      setEditPlan(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.graph(workspaceId, projectId) });
    },
  });

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

      {/* AI Edit（P05-06）：生成计划不落库；Apply 才走编辑协议（整批同一事务） */}
      <AiEditPanel
        plan={editPlan}
        planPending={planEdit.isPending}
        planError={planEdit.isError ? (() => { const d = describeError(planEdit.error); return { kind: d.kind, message: d.message, code: d.code }; })() : null}
        onPlan={(prompt) => planEdit.mutate(prompt)}
        onApply={(plan) => applyEditPlan.mutate(plan)}
        onReject={() => setEditPlan(null)}
        applyPending={applyEditPlan.isPending}
        applyError={applyEditPlan.isError ? (() => { const d = describeError(applyEditPlan.error); return { kind: d.kind, message: d.message, code: d.code }; })() : null}
      />

      {/* Lite Timeline（P05-05）：默认折叠（REQ-5-03 不默认展示复杂时间线） */}
      <details data-testid="timeline-panel" className="rounded border border-slate-800 bg-slate-900/40">
        <summary className="cursor-pointer px-4 py-2 text-sm font-semibold text-slate-300">Lite Timeline（排序/时长/拆分/复制/删除/替换素材/转场/缩放/音量/字幕）</summary>
        <div className="p-3 pt-0">
          <LiteTimeline
            graph={graph.data}
            assets={(assetUrls.data === undefined ? [] : [...assetUrls.data.entries()]).map(([id]) => ({ id, assetType: 'ASSET' }))}
            pending={timelineEdit.isPending}
            onEdit={(request) => timelineEdit.mutate(request)}
            error={timelineEdit.isError ? (() => { const d = describeError(timelineEdit.error); return { kind: d.kind, message: d.message, code: d.code }; })() : null}
          />
        </div>
      </details>

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
