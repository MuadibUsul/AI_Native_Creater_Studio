'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import type { CreatorLearningAction } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { StateBlock } from './StateBlock';
import ui from './Monochrome.module.css';

const panel = `${ui['panel']} p-4`;
const input = ui['field'];
const button = ui['button'];

const errorText = (error: unknown): string => describeError(error).message;

export function AnalyticsWorkspace({ workspaceId, projectId }: { workspaceId: string; projectId: string }): ReactElement {
  const { messages, locale } = useI18n();
  const t = messages.delivery.workspace;
  const metric = (value: number | null, suffix = ''): string => value === null ? t.unknownMetric : `${value.toLocaleString(locale)}${suffix}`;
  const client = useAncsClient();
  const cache = useQueryClient();
  const [selectedPublicationId, setSelectedPublicationId] = useState('');
  const [selectedPerformanceId, setSelectedPerformanceId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const publications = useQuery({ queryKey: ['analytics', workspaceId, projectId, 'publications'], queryFn: () => client.publications.list(workspaceId, projectId) });
  const activePublicationId = selectedPublicationId || publications.data?.items[0]?.id || '';
  const performances = useQuery({
    queryKey: ['analytics', workspaceId, projectId, activePublicationId, 'performance'],
    queryFn: () => client.publications.listAnalytics(workspaceId, projectId, activePublicationId),
    enabled: activePublicationId.length > 0,
  });
  const activePerformanceId = selectedPerformanceId || performances.data?.items[0]?.id || '';
  const scenes = useQuery({
    queryKey: ['analytics', workspaceId, projectId, activePerformanceId, 'scenes'],
    queryFn: () => client.analytics.listScenes(workspaceId, projectId, activePerformanceId),
    enabled: activePerformanceId.length > 0,
  });
  const learnings = useQuery({ queryKey: ['analytics', workspaceId, projectId, 'learnings'], queryFn: () => client.analytics.listLearnings(workspaceId, projectId) });

  const refresh = async (key: readonly unknown[]): Promise<void> => { await cache.invalidateQueries({ queryKey: key }); };
  const collect = useMutation({
    mutationFn: () => client.publications.collectAnalytics(workspaceId, projectId, activePublicationId, { granularity: 'LIFETIME', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }),
    onSuccess: async (record) => { setSelectedPerformanceId(record.id); setNotice(t.notices.saved); await refresh(['analytics', workspaceId, projectId, activePublicationId, 'performance']); },
    onError: (error) => setNotice(t.notices.collectFailed(errorText(error))),
  });
  const attribute = useMutation({
    mutationFn: () => client.analytics.attributeScenes(workspaceId, projectId, activePerformanceId),
    onSuccess: async () => { setNotice(t.notices.attributed); await refresh(['analytics', workspaceId, projectId, activePerformanceId, 'scenes']); },
    onError: (error) => setNotice(t.notices.attributeFailed(errorText(error))),
  });
  const generate = useMutation({
    mutationFn: () => client.analytics.generateLearnings(workspaceId, projectId),
    onSuccess: async () => { setNotice(t.notices.generated); await refresh(['analytics', workspaceId, projectId, 'learnings']); },
    onError: (error) => setNotice(t.notices.generateFailed(errorText(error))),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: CreatorLearningAction['action'] }) => client.analytics.actOnLearning(workspaceId, projectId, id, { action }),
    onSuccess: async () => { setNotice(t.notices.updated); await refresh(['analytics', workspaceId, projectId, 'learnings']); },
    onError: (error) => setNotice(t.notices.actFailed(errorText(error))),
  });

  const fatal = publications.error ?? learnings.error;
  if (publications.isPending || learnings.isPending) return <StateBlock variant="loading" title={t.loading} />;
  if (fatal !== null) return <StateBlock variant="error" title={t.loadFailed} description={errorText(fatal)} action={{ label: t.retry, onClick: () => { void publications.refetch(); void learnings.refetch(); } }} />;

  const performance = performances.data?.items.find((item) => item.id === activePerformanceId) ?? performances.data?.items[0];
  return (
    <section className="flex flex-col gap-5" data-testid="analytics-workspace">
      <div><h1 className="text-xl font-semibold">{t.title}</h1><p className={`mt-1 text-sm ${ui['secondaryText']}`}>{t.subtitle}</p></div>
      {notice !== null ? <p role="status" className={`text-sm ${ui['notice']}`}>{notice}</p> : null}

      <div className={panel}>
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-semibold">{t.performance.title}</h2><p className={`text-xs ${ui['secondaryText']}`}>{t.performance.body}</p></div>
          <div className="flex gap-2"><select aria-label={t.performance.select} value={activePublicationId} onChange={(event) => { setSelectedPublicationId(event.target.value); setSelectedPerformanceId(''); }} className={input}><option value="">{t.performance.select}</option>{publications.data?.items.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.platformId}</option>)}</select><button className={button} disabled={!activePublicationId || collect.isPending} onClick={() => collect.mutate()}>{t.performance.collect}</button></div>
        </div>
        {activePublicationId && performances.isPending ? <p className={`mt-3 text-sm ${ui['secondaryText']}`}>{t.performance.loading}</p> : performance === undefined ? <p className={`mt-3 text-sm ${ui['secondaryText']}`}>{t.performance.empty}</p> : <div className="mt-4 grid gap-3 md:grid-cols-4"><Metric label={t.performance.views} value={metric(performance.metrics.views)} /><Metric label={t.performance.impressions} value={metric(performance.metrics.impressions)} /><Metric label={t.performance.ctr} value={metric(performance.metrics.clickThroughRate === null ? null : performance.metrics.clickThroughRate * 100, '%')} /><Metric label={t.performance.watchTime} value={metric(performance.metrics.watchTimeMs, ' ms')} /><p className={`md:col-span-4 text-xs ${ui['mutedText']}`}>{t.performance.fetched(performance.platformId, performance.sampling.granularity, performance.sampling.timezone, new Date(performance.sampling.fetchedAt).toLocaleString(locale))}</p></div>}
      </div>

      <div className={panel}>
        <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{t.scenes.title}</h2><p className={`text-xs ${ui['secondaryText']}`}>{t.scenes.body}</p></div><button className={button} disabled={!activePerformanceId || attribute.isPending} onClick={() => attribute.mutate()}>{t.scenes.attribute}</button></div>
        <ul className="mt-3 grid gap-2 md:grid-cols-2">{scenes.data?.items.map((scene) => <li key={scene.id} className={`${ui['inset']} p-3 text-sm`}><span className="font-medium">#{scene.position + 1} {scene.sceneType}</span><p className={`mt-1 ${ui['secondaryText']}`}>{t.scenes.retention(metric(scene.retentionRate === null ? null : scene.retentionRate * 100, '%'), scene.derivation.sampleCount)}</p></li>)}</ul>
      </div>

      <div className={panel}>
        <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{t.learnings.title}</h2><p className={`text-xs ${ui['secondaryText']}`}>{t.learnings.body}</p></div><button className={button} disabled={generate.isPending} onClick={() => generate.mutate()}>{t.learnings.generate}</button></div>
        <ul className="mt-3 flex flex-col gap-2">{learnings.data?.items.map((learning) => <li key={learning.id} className={`${ui['inset']} p-3 text-sm`}><div className="flex flex-wrap justify-between gap-3"><div><p className="font-medium">{learning.title} <span className={`text-xs ${ui['secondaryText']}`}>{learning.status}</span></p><p className={`mt-1 ${ui['secondaryText']}`}>{learning.explanation}</p><p className={`mt-1 text-xs ${ui['secondaryText']}`}>{t.learnings.evidence(learning.evidence.sampleCount)}</p></div><div className="flex gap-2">{learning.status === 'ACTIVE' ? <><button className={button} onClick={() => act.mutate({ id: learning.id, action: 'ACCEPT' })}>{t.learnings.accept}</button><button className={button} onClick={() => act.mutate({ id: learning.id, action: 'DISABLE' })}>{t.learnings.disable}</button></> : <button className={button} onClick={() => act.mutate({ id: learning.id, action: 'RESTORE' })}>{t.learnings.restore}</button>}</div></div></li>)}</ul>
      </div>

    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return <div className={`${ui['inset']} p-3`}><p className={`text-xs ${ui['mutedText']}`}>{label}</p><p className="mt-1 text-sm font-medium">{value}</p></div>;
}
