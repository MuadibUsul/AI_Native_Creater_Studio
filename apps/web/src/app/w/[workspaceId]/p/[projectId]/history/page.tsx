'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/I18nProvider';
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
  const { messages, locale } = useI18n();
  const t = messages.projectFlow.history;
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
  if (events.isPending) return <StateBlock variant="loading" title={t.loading} />;
  if (events.isError) {
    const error = describeError(events.error);
    return <StateBlock variant={error.kind === 'forbidden' ? 'forbidden' : 'error'} title={t.loadFailed} description={error.message} action={{ label: t.retry, onClick: () => void events.refetch() }} />;
  }
  const list = (events.data?.pages.flatMap((page) => page.events) ?? []).filter((event) => event.resourceId === projectId || event.payload['projectId'] === projectId);
  const actionError = undo.isError ? describeError(undo.error) : redo.isError ? describeError(redo.error) : null;
  return <section className="page" data-testid="project-history"><header className="sectionhead mobile-stack"><div><div className="eyebrow mb16">{t.eyebrow}</div><h1>{t.title}</h1><p>{t.intro}</p></div><div className="row" style={{ flexWrap: 'wrap' }}><button type="button" className="btn small" disabled={undo.isPending || redo.isPending} onClick={() => undo.mutate()}><QuietIcon name="undo" />{t.undo}</button><button type="button" className="btn small" disabled={undo.isPending || redo.isPending} onClick={() => redo.mutate()}>{t.redo}</button></div></header>
    {actionError && <div className="mb24"><StateBlock variant={actionError.kind === 'conflict' ? 'conflict' : 'error'} title={actionError.kind === 'conflict' ? t.undoRedoBlocked : t.actionFailed} description={actionError.message} diagnostics={actionError.code ?? undefined} action={{ label: t.refreshHistory, onClick: () => void events.refetch() }} /></div>}
    <div className="split wide mt32"><section className="panel pad" aria-label={t.eventsTitle}><div className="row between mb24"><h3>{t.eventsTitle}</h3><span className="badge">{t.loadedCount(list.length)}</span></div>{list.length === 0 && <StateBlock variant="empty" title={t.emptyTitle} description={events.hasNextPage ? t.emptyHasMore : t.emptyNoMore} />}
      <ol className={styles['timeline']}>{[...list].reverse().map((event) => {
        const operations = Array.isArray(event.payload['operations']) ? event.payload['operations'].map(String) : [];
        const actor = typeof event.payload['actorType'] === 'string' ? event.payload['actorType'] : t.systemActor;
        const compensation = typeof event.payload['compensation'] === 'string' ? event.payload['compensation'] : null;
        const revision = typeof event.payload['revision'] === 'number' ? event.payload['revision'] : event.resourceRevision;
        return <li key={event.seq} className={styles['eventRow']}><span className={styles['eventMarker']} aria-hidden="true" /><div className="grow"><div className="row between" style={{ flexWrap: 'wrap' }}><strong>#{event.seq} {event.eventType}</strong><time className="small muted" dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString(locale)}</time></div><p className="small muted mt8">{operations.length ? t.operations(operations.join(t.operationSeparator)) : t.noOperations}{revision !== null ? ` · revision ${revision}` : ''} · {actor}</p>{compensation && <span className="badge amber mt8">{compensation}</span>}</div></li>;
      })}</ol>
      {events.hasNextPage && <button type="button" className="btn full mt24" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>{events.isFetchingNextPage ? t.loadingMore : t.loadMore}</button>}
      <p className="small muted mt16">{t.pagingNote}</p>
    </section><aside className="col"><section className="panel pad"><div className="row between"><h3>{t.versionsTitle}</h3><QuietIcon name="layers" /></div><p className="small muted mt8">{t.versionsIntro}</p><button type="button" className="btn small mt24" onClick={() => setShowVersions((value) => !value)}>{showVersions ? t.hideVersions : t.showVersions}</button>{showVersions && <div className="mt16">{versions.isPending && <p className="small muted">{t.versionsLoading}</p>}{versions.isError && <p className="small muted">{t.versionsFailed(describeError(versions.error).message)}</p>}{versions.data?.length === 0 && <p className="small muted">{t.versionsEmpty}</p>}{versions.data?.map((version) => <div key={version.id} className={styles['versionRow']}><strong>{t.versionLabel(version.versionNumber)}</strong><span className="badge">{version.reason}</span><p className="small muted mt8">{t.versionMeta(version.sceneCount, new Date(version.createdAt).toLocaleString(locale))}</p>{version.note && <p className="small muted mt8">{version.note}</p>}</div>)}</div>}</section><div className="notice"><QuietIcon name="shield" /><span>{t.serverNote}</span></div></aside></div>
  </section>;
}
