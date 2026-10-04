'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client.js';
import { queryKeys } from '@/lib/queries';
import { PreviewPlayer } from './PreviewPlayer';

/**
 * 预览 + 编辑的最小组合（P05-04 验收夹具）：
 * 用真实页面同款的数据流（graph 查询 + 编辑协议提交 + 预览渲染），
 * 证明"编辑 → 刷新预览"路径**只**访问只读查询与编辑协议（不触发昂贵生成/计费调用）。
 */

export function StoryboardHarness({ client }: { client?: never }) {
  void client; // 由 Providers 注入
  const ancs = useAncsClient();
  const queryClient = useQueryClient();
  const workspaceId = 'ws_1';
  const projectId = 'prj_1';

  const graph = useQuery({ queryKey: queryKeys.graph(workspaceId, projectId), queryFn: () => ancs.projects.graph(projectId) });
  const assetUrls = useQuery({
    queryKey: [...queryKeys.assets(workspaceId, projectId), 'preview-urls'],
    enabled: graph.data !== undefined,
    queryFn: async () => {
      const ids = [...new Set((graph.data?.scenes ?? []).flatMap((scene) => scene.assetBindings.map((binding) => binding.assetId)))];
      const entries = await Promise.all(
        ids.map(async (assetId) => {
          try {
            return [assetId, (await ancs.assets.downloadUrl(workspaceId, assetId)).url] as const;
          } catch {
            return [assetId, null] as const;
          }
        }),
      );
      return new Map(entries);
    },
  });

  const edit = useMutation({
    mutationFn: async () => {
      const current = graph.data;
      if (current === undefined) throw new Error('图未加载');
      const first = current.scenes[0];
      if (first === undefined) throw new Error('无场景');
      return ancs.projects.edit(projectId, {
        baseProjectRevision: current.projectRevision,
        expectedSceneRevisions: { [first.id]: first.revision },
        operations: [{ op: 'update_scene', sceneId: first.id, changes: { durationMs: first.durationMs + 500 } }],
        idempotencyKey: `idem_preview_${String(Date.now())}`,
        intent: '预览夹具：时长微调',
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.graph(workspaceId, projectId) });
    },
  });

  if (graph.isPending) return <p>载入中…</p>;
  if (graph.isError) return <p>加载失败</p>;
  return (
    <div>
      <button type="button" onClick={() => edit.mutate()}>
        模拟编辑（时长微调）
      </button>
      <PreviewPlayer graph={graph.data} resolveAssetUrl={(assetId) => assetUrls.data?.get(assetId) ?? null} width={480} />
    </div>
  );
}
