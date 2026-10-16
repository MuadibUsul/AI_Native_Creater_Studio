'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatorLearningAction, VideoPerformanceRecord } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import type { Locale } from '@/i18n/locale';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { AnalyticsWorkspace } from '@/ui/AnalyticsWorkspace';
import { MonochromeSeriesChart } from '@/ui/MonochromeSeriesChart';
import { QuietIcon } from '@/ui/QuietIcon';
import styles from './delivery.module.css';
import legacy from './legacy.module.css';

export function formatMetric(value: number | null | undefined, suffix = '', locale: Locale = 'zh-CN'): string {
  return value == null ? '—' : `${value.toLocaleString(locale)}${suffix}`;
}
export function retentionSegments(points: VideoPerformanceRecord['metrics']['retention']): string[] {
  const ordered = [...points].sort((a, b) => a.positionMs - b.positionMs);
  const end = Math.max(ordered.at(-1)?.positionMs ?? 0, 1);
  const x = (time: number) => (time / end) * 680;
  const commands: string[] = [];
  let started = false;
  let hasLine = false;
  for (const point of ordered) {
    if (point.rate === null) { started = false; continue; }
    commands.push(`${started ? 'L' : 'M'}${x(point.positionMs).toFixed(1)} ${(170 - point.rate * 145).toFixed(1)}`);
    if (started) hasLine = true;
    started = true;
  }
  return hasLine ? commands : [];
}
function duration(ms: number | null): string {
  if (ms === null) return '—';
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function MetricCard({ title, value, note }: { title: string; value: string; note: string }) {
  return <div className="metriccard"><h4>{title}</h4><div className="value">{value}</div><small>{note}</small></div>;
}

export function DeliveryAnalytics({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const { messages, locale } = useI18n();
  const t = messages.delivery.analytics;
  const client = useAncsClient();
  const cache = useQueryClient();
  const [publicationId, setPublicationId] = useState('');
  const [performanceId, setPerformanceId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const publications = useQuery({ queryKey: ['analytics', workspaceId, projectId, 'publications'], queryFn: () => client.publications.list(workspaceId, projectId) });
  const activePublication = publicationId || publications.data?.items[0]?.id || '';
  const performances = useQuery({ queryKey: ['analytics', workspaceId, projectId, activePublication, 'performance'], queryFn: () => client.publications.listAnalytics(workspaceId, projectId, activePublication), enabled: !!activePublication });
  const activePerformance = performanceId || performances.data?.items[0]?.id || '';
  const scenes = useQuery({ queryKey: ['analytics', workspaceId, projectId, activePerformance, 'scenes'], queryFn: () => client.analytics.listScenes(workspaceId, projectId, activePerformance), enabled: !!activePerformance });
  const learnings = useQuery({ queryKey: ['analytics', workspaceId, projectId, 'learnings'], queryFn: () => client.analytics.listLearnings(workspaceId, projectId) });
  const performance = performances.data?.items.find((item) => item.id === activePerformance) ?? performances.data?.items[0];
  const retentionPath = retentionSegments(performance?.metrics.retention ?? []).join(' ');
  const retentionPoints = performance?.metrics.retention ?? [];
  const hasRetentionSample = retentionPoints.some((point) => point.rate !== null);
  const collect = useMutation({ mutationFn: () => client.publications.collectAnalytics(workspaceId, projectId, activePublication, { granularity: 'LIFETIME', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }), onSuccess: async (record) => { setPerformanceId(record.id); setNotice(t.notices.saved); await cache.invalidateQueries({ queryKey: ['analytics', workspaceId, projectId, activePublication, 'performance'] }); }, onError: (error) => setNotice(t.notices.collectFailed(describeError(error).message)) });
  const attribute = useMutation({ mutationFn: () => client.analytics.attributeScenes(workspaceId, projectId, activePerformance), onSuccess: async () => { setNotice(t.notices.attributed); await cache.invalidateQueries({ queryKey: ['analytics', workspaceId, projectId, activePerformance, 'scenes'] }); }, onError: (error) => setNotice(t.notices.attributeFailed(describeError(error).message)) });
  const generate = useMutation({ mutationFn: () => client.analytics.generateLearnings(workspaceId, projectId), onSuccess: async () => { setNotice(t.notices.generated); await cache.invalidateQueries({ queryKey: ['analytics', workspaceId, projectId, 'learnings'] }); }, onError: (error) => setNotice(t.notices.generateFailed(describeError(error).message)) });
  const act = useMutation({ mutationFn: ({ id, action }: { id: string; action: CreatorLearningAction['action'] }) => client.analytics.actOnLearning(workspaceId, projectId, id, { action }), onSuccess: async () => { setNotice(t.notices.updated); await cache.invalidateQueries({ queryKey: ['analytics', workspaceId, projectId, 'learnings'] }); }, onError: (error) => setNotice(t.notices.actFailed(describeError(error).message)) });
  return <div className="page" data-testid="quiet-analytics"><header className="sectionhead mobile-stack"><div><div className="eyebrow mb16">LEARN FROM EVERY STORY</div><h1>{t.title}</h1><p>{t.subtitle}</p></div><div className="row"><span className="badge">{performance ? t.realSnapshot(performance.platformId) : t.noPlatformData}</span><select className="field select" aria-label={t.selectPublication} value={activePublication} onChange={(event) => { setPublicationId(event.target.value); setPerformanceId(''); }}><option value="">{t.selectPublicationOption}</option>{publications.data?.items.map((record) => <option key={record.id} value={record.id}>{record.title} · {record.platformId}</option>)}</select></div></header>
    {notice && <p role="status" className="notice amber mb24">{notice}</p>}
    {publications.isPending && <p role="status" className="small muted mb24">{t.loadingPublications}</p>}
    {publications.isError && <p role="alert" className="notice amber mb24">{t.publicationsFailed(describeError(publications.error).message)} <button type="button" className="textbtn small" onClick={() => void publications.refetch()}>{t.retry}</button></p>}
    {performances.isPending && activePublication && <p role="status" className="small muted mb24">{t.loadingPerformance}</p>}
    {performances.isError && <p role="alert" className="notice amber mb24">{t.performanceFailed(describeError(performances.error).message)} <button type="button" className="textbtn small" onClick={() => void performances.refetch()}>{t.retry}</button></p>}
    <div className="metricgrid mt32"><MetricCard title={t.metrics.views} value={formatMetric(performance?.metrics.views, '', locale)} note={performance ? `${performance.sampling.source} · ${new Date(performance.sampling.fetchedAt).toLocaleString(locale)}` : t.metrics.viewsMissing} /><MetricCard title={t.metrics.averageWatch} value={duration(performance?.metrics.averageWatchTimeMs ?? null)} note={performance ? t.metrics.fromSnapshot : t.metrics.notReturned} /><MetricCard title={t.metrics.completion} value="—" note={t.metrics.completionMissing} /><MetricCard title={t.metrics.saves} value="—" note={t.metrics.savesMissing} /></div>
    <div className="split wide mt24"><section className="panel pad grow"><div className="row between"><div><h3>{t.retention.title}</h3><p className="small muted mt8">{t.retention.axes}</p></div><span className={`badge ${retentionPath ? 'green' : ''}`}>{retentionPath ? t.retention.sampled : hasRetentionSample ? t.retention.tooFew : t.retention.none}</span></div><div className="mt16"><MonochromeSeriesChart
      title={t.retention.chartTitle}
      series={retentionPoints.length ? [{ id: 'retention', label: t.retention.seriesLabel, points: retentionPoints.map((point) => ({ x: point.positionMs, y: point.rate })) }] : []}
      xLabel={t.retention.xLabel}
      yLabel={t.retention.yLabel}
      windowLabel={performance ? t.retention.window(performance.sampling.granularity, performance.sampling.timezone, new Date(performance.sampling.fetchedAt).toLocaleString(locale)) : t.retention.noData}
      formatX={(value) => duration(value)}
      formatY={(value) => `${(value * 100).toFixed(1)}%`}
      yDomain={[0, 1]}
    /></div><p className="small muted mt16">{t.retention.causality}{performance ? t.retention.sampling(performance.sampling.granularity, performance.sampling.timezone) : ''}</p><div className="row mt16" style={{ flexWrap: 'wrap' }}><button type="button" className="btn small" disabled={!activePublication || collect.isPending} onClick={() => collect.mutate()}>{collect.isPending ? t.retention.collecting : t.retention.collect}</button><button type="button" className="btn small" disabled={!activePerformance || attribute.isPending} onClick={() => attribute.mutate()}>{attribute.isPending ? t.retention.computing : t.retention.attribute}</button></div></section><aside className="panel pad"><div className="row between"><h3>{t.review.title}</h3><QuietIcon name="spark" /></div>{learnings.isPending && <p className="small muted mt16">{t.review.loading}</p>}{learnings.isError && <p role="alert" className="small muted mt16">{t.review.failed(describeError(learnings.error).message)} <button type="button" className="textbtn small" onClick={() => void learnings.refetch()}>{t.retry}</button></p>}{!learnings.isPending && !learnings.isError && learnings.data?.items.length === 0 && <div className="analysis-insight mt16"><h4>{t.review.emptyTitle}</h4><p>{t.review.emptyBody}</p></div>}{learnings.data?.items.slice(0, 3).map((learning) => <div className="analysis-insight mt16" key={learning.id}><h4>{learning.title}</h4><p>{learning.explanation}</p><div className="row between mt16"><span className="badge">{t.review.correlation(learning.evidence.sampleCount)}</span>{learning.status === 'ACTIVE' ? <button type="button" className="btn small" disabled={act.isPending} onClick={() => act.mutate({ id: learning.id, action: 'ACCEPT' })}>{t.review.addToPlan}</button> : <span className="badge">{learning.status}</span>}</div></div>)}<p className="small muted mt24">{t.review.note}</p><button type="button" className="textbtn small mt16" disabled={generate.isPending} onClick={() => generate.mutate()}>{generate.isPending ? t.review.generating : t.review.generate} <QuietIcon name="arrow" /></button></aside></div>
    <section className="panel pad mt24"><div className="row between mb16"><h3>{t.scenes.title}</h3><span className="sample-note">{t.scenes.frozen}</span></div>{scenes.isPending && activePerformance && <p className="small muted">{t.scenes.loading}</p>}{scenes.isError && <p role="alert" className="small muted">{t.scenes.failed(describeError(scenes.error).message)} <button type="button" className="textbtn small" onClick={() => void scenes.refetch()}>{t.retry}</button></p>}{!scenes.isPending && !scenes.isError && !scenes.data?.items.length && <p className="small muted">{t.scenes.empty}</p>}{!!scenes.data?.items.length && <div className={styles['tableScroller']}><table className="data-table"><thead><tr><th>{t.scenes.shot}</th><th>{t.scenes.time}</th><th>{t.scenes.type}</th><th>{t.scenes.retention}</th><th></th></tr></thead><tbody>{scenes.data.items.map((scene) => <tr key={scene.id}><td>#{scene.position + 1} · {scene.sceneId.slice(0, 8)}</td><td>{duration(scene.startMs)} – {duration(scene.startMs + scene.durationMs)}</td><td>{scene.sceneType}</td><td>{scene.retentionRate === null ? t.scenes.unknown : formatMetric(scene.retentionRate * 100, '%', locale)}</td><td><Link className="textbtn small" href={`/w/${workspaceId}/p/${projectId}/editor/${scene.sceneId}`}>{t.scenes.review} <QuietIcon name="arrow" /></Link></td></tr>)}</tbody></table></div>}</section>
    <details className="panel pad mt24" onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}><summary className={styles['summary']}>{t.advanced.title}</summary><p className="small muted mt8">{t.advanced.body}</p>{advancedOpen && <div className={`${styles['advanced']} ${legacy['surface']}`}><AnalyticsWorkspace workspaceId={workspaceId} projectId={projectId} /></div>}</details>
  </div>;
}
