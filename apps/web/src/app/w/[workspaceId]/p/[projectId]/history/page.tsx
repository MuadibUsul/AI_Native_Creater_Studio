'use client';

import { useParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useWorkspaceEvents } from '@/lib/queries';
import { StateBlock } from '@/ui/StateBlock';

/**
 * History 页面（P05-03）：编辑事件时间线 + 撤销/重做（补偿事件；历史不改写、不回拨 revision）。
 * 状态矩阵：加载 / 失败 / 空 / 正常 / 无可撤销（409 前置条件）。
 */

export default function HistoryPage() {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const params = useParams<{ workspaceId: string; projectId: string }>();
  const workspaceId = params.workspaceId;
  const projectId = params.projectId;
  const events = useWorkspaceEvents(workspaceId);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.events(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.graph(workspaceId, projectId) });
  };
  const undo = useMutation({
    mutationFn: () => client.projects.undo(projectId, { idempotencyKey: `idem_web_undo_${String(Date.now())}` }),
    onSuccess: invalidate,
  });
  const redo = useMutation({
    mutationFn: () => client.projects.redo(projectId, { idempotencyKey: `idem_web_redo_${String(Date.now())}` }),
    onSuccess: invalidate,
  });

  if (events.isPending) return <StateBlock variant="loading" title="正在加载编辑历史…" />;
  if (events.isError) {
    const described = describeError(events.error);
    return (
      <StateBlock
        variant={described.kind === 'forbidden' ? 'forbidden' : 'error'}
        title="加载编辑历史失败"
        description={described.message}
        action={{ label: '重试', onClick: () => void events.refetch() }}
      />
    );
  }

  const list = events.data?.events ?? [];
  const actionError = undo.isError ? describeError(undo.error) : redo.isError ? describeError(redo.error) : null;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">History</h1>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={undo.isPending}
            onClick={() => undo.mutate()}
            className="rounded border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
          >
            撤销最近一次编辑
          </button>
          <button
            type="button"
            disabled={redo.isPending}
            onClick={() => redo.mutate()}
            className="rounded border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
          >
            重做
          </button>
        </div>
      </div>

      {actionError !== null ? (
        <StateBlock
          variant={actionError.kind === 'conflict' ? 'conflict' : 'error'}
          title={actionError.kind === 'conflict' ? '无法撤销/重做' : '操作失败'}
          description={actionError.message}
          diagnostics={actionError.code ?? undefined}
          action={{ label: '刷新历史', onClick: () => void events.refetch() }}
        />
      ) : null}

      {list.length === 0 ? (
        <StateBlock variant="empty" title="还没有编辑事件" description="应用 Director 计划或修改场景后，这里会出现可审计的事件流。" />
      ) : (
        <ol className="flex flex-col gap-2">
          {[...list].reverse().map((event) => {
            const operations = Array.isArray(event.payload['operations']) ? (event.payload['operations'] as string[]) : [];
            const actorType = typeof event.payload['actorType'] === 'string' ? event.payload['actorType'] : null;
            const compensation = typeof event.payload['compensation'] === 'string' ? event.payload['compensation'] : null;
            const revision = typeof event.payload['revision'] === 'number' ? event.payload['revision'] : null;
            return (
              <li key={`${event.seq}`} className="rounded border border-slate-800 bg-slate-900/60 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    #{event.seq} {event.eventType}
                    {compensation !== null ? <span className="ml-2 rounded bg-orange-900 px-1.5 py-0.5 text-xs text-orange-100">{compensation}</span> : null}
                  </span>
                  <span className="text-xs text-slate-500">
                    {actorType ?? '—'} · {new Date(event.occurredAt).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  {operations.length > 0 ? `操作：${operations.join(', ')}` : '无操作明细'}
                  {revision !== null ? ` · revision ${String(revision)}` : ''} · 资源 {event.resourceId.slice(0, 12)}…
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
