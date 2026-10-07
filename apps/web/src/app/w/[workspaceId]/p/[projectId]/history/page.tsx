'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys } from '@/lib/queries';
import { QuietIcon } from '@/ui/QuietIcon';
import { StateBlock } from '@/ui/StateBlock';
import styles from '@/components/quiet-frame/legacy.module.css';

/** Project-scoped view over the authoritative workspace event stream. Undo/redo remain server commands. */
export default function HistoryPage() {
  const client = useAncsClient();
  const cache = useQueryClient();
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  const [showVersions, setShowVersions] = useState(false);
  const events = useInfiniteQuery({
    queryKey: [...queryKeys.events(workspaceId), 'project-history', projectId],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => client.events.list(workspaceId, { cursor: pageParam, limit: 100 }),
    getNextPageParam: (lastPage) => {
      const lastSeq = lastPage.events.at(-1)?.seq;
      return lastSeq !== undefined && lastSeq < lastPage.headSeq ? lastSeq : undefined;
    },
  });
  const versions = useQuery({ queryKey: queryKeys.versions(projectId), enabled: showVersions, queryFn: () => client.projects.versions.list(projectId) });
  const invalidate = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: queryKeys.events(workspaceId) }),
      cache.invalidateQueries({ queryKey: queryKeys.graph(workspaceId, projectId) }),
      cache.invalidateQueries({ queryKey: queryKeys.versions(projectId) }),
    ]);
  };
  const undo = useMutation({ mutationFn: () => client.projects.undo(projectId, { idempotencyKey: `idem_web_undo_${String(Date.now())}` }), onSuccess: invalidate });
  const redo = useMutation({ mutationFn: () => client.projects.redo(projectId, { idempotencyKey: `idem_web_redo_${String(Date.now())}` }), onSuccess: invalidate });
  if (events.isPending) return <StateBlock variant="loading" title="正在加载编辑历史…" />;
  if (events.isError) {
    const error = describeError(events.error);
    return <StateBlock variant={error.kind === 'forbidden' ? 'forbidden' : 'error'} title="加载编辑历史失败" description={error.message} action={{ label: '重试', onClick: () => void events.refetch() }} />;
  }
  const list = (events.data?.pages.flatMap((page) => page.events) ?? []).filter((event) => event.resourceId === projectId || event.payload['projectId'] === projectId);
  const actionError = undo.isError ? describeError(undo.error) : redo.isError ? describeError(redo.error) : null;
  return <section className="page" data-testid="project-history"><header className="sectionhead mobile-stack"><div><div className="eyebrow mb16">A RECORD YOU CAN TRUST</div><h1>History</h1><p>查看当前作品的编辑事件与版本快照。撤销和重做会追加补偿记录，不改写历史。</p></div><div className="row" style={{ flexWrap: 'wrap' }}><button type="button" className="btn small" disabled={undo.isPending || redo.isPending} onClick={() => undo.mutate()}><QuietIcon name="undo" />撤销最近一次编辑</button><button type="button" className="btn small" disabled={undo.isPending || redo.isPending} onClick={() => redo.mutate()}>重做</button></div></header>
    {actionError && <div className="mb24"><StateBlock variant={actionError.kind === 'conflict' ? 'conflict' : 'error'} title={actionError.kind === 'conflict' ? '无法撤销/重做' : '操作失败'} description={actionError.message} diagnostics={actionError.code ?? undefined} action={{ label: '刷新历史', onClick: () => void events.refetch() }} /></div>}
    <div className="split wide mt32"><section className="panel pad" aria-label="编辑事件"><div className="row between mb24"><h3>编辑事件</h3><span className="badge">已加载 {list.length} 条本项目记录</span></div>{list.length === 0 && <StateBlock variant="empty" title="还没有编辑事件" description={events.hasNextPage ? '当前页没有本项目事件，可继续加载较新的记录。' : '应用 Director 计划或修改场景后，这里会出现可审计的事件流。'} />}
      <ol className={styles['timeline']}>{[...list].reverse().map((event) => {
        const operations = Array.isArray(event.payload['operations']) ? event.payload['operations'].map(String) : [];
        const actor = typeof event.payload['actorType'] === 'string' ? event.payload['actorType'] : '系统';
        const compensation = typeof event.payload['compensation'] === 'string' ? event.payload['compensation'] : null;
        const revision = typeof event.payload['revision'] === 'number' ? event.payload['revision'] : event.resourceRevision;
        return <li key={event.seq} className={styles['eventRow']}><span className={styles['eventMarker']} aria-hidden="true" /><div className="grow"><div className="row between" style={{ flexWrap: 'wrap' }}><strong>#{event.seq} {event.eventType}</strong><time className="small muted" dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time></div><p className="small muted mt8">{operations.length ? `操作：${operations.join('、')}` : '无操作明细'}{revision !== null ? ` · revision ${revision}` : ''} · {actor}</p>{compensation && <span className="badge amber mt8">{compensation}</span>}</div></li>;
      })}</ol>
      {events.hasNextPage && <button type="button" className="btn full mt24" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>{events.isFetchingNextPage ? '正在加载…' : '加载更多事件'}</button>}
      <p className="small muted mt16">事件以工作区游标顺序分页；这里只显示可归属本项目的记录。</p>
    </section><aside className="col"><section className="panel pad"><div className="row between"><h3>版本快照</h3><QuietIcon name="layers" /></div><p className="small muted mt8">快照是不可变版本，可用于核对渲染与批准时的内容。</p><button type="button" className="btn small mt24" onClick={() => setShowVersions((value) => !value)}>{showVersions ? '收起版本' : '查看版本'}</button>{showVersions && <div className="mt16">{versions.isPending && <p className="small muted">正在加载版本…</p>}{versions.isError && <p className="small muted">版本加载失败：{describeError(versions.error).message}</p>}{versions.data?.length === 0 && <p className="small muted">尚无版本快照。</p>}{versions.data?.map((version) => <div key={version.id} className={styles['versionRow']}><strong>版本 {version.versionNumber}</strong><span className="badge">{version.reason}</span><p className="small muted mt8">{version.sceneCount} 个场景 · {new Date(version.createdAt).toLocaleString()}</p>{version.note && <p className="small muted mt8">{version.note}</p>}</div>)}</div>}</section><div className="notice"><QuietIcon name="shield" /><span>撤销和重做仍由服务端编辑协议校验当前 revision、锁定状态与幂等键。</span></div></aside></div>
  </section>;
}
