'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatorLearningAction, VideoPerformanceRecord } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { AnalyticsWorkspace } from '@/ui/AnalyticsWorkspace';
import { MonochromeSeriesChart } from '@/ui/MonochromeSeriesChart';
import { QuietIcon } from '@/ui/QuietIcon';
import styles from './delivery.module.css';
import legacy from './legacy.module.css';

export function formatMetric(value: number | null | undefined, suffix = ''): string {
  return value == null ? '—' : `${value.toLocaleString('zh-CN')}${suffix}`;
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
  const collect = useMutation({ mutationFn: () => client.publications.collectAnalytics(workspaceId, projectId, activePublication, { granularity: 'LIFETIME', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }), onSuccess: async (record) => { setPerformanceId(record.id); setNotice('平台数据快照已保存，含采样口径与抓取时间。'); await cache.invalidateQueries({ queryKey: ['analytics', workspaceId, projectId, activePublication, 'performance'] }); }, onError: (error) => setNotice(`采集失败：${describeError(error).message}`) });
  const attribute = useMutation({ mutationFn: () => client.analytics.attributeScenes(workspaceId, projectId, activePerformance), onSuccess: async () => { setNotice('已按冻结版本计算场景相关性。'); await cache.invalidateQueries({ queryKey: ['analytics', workspaceId, projectId, activePerformance, 'scenes'] }); }, onError: (error) => setNotice(`归因失败：${describeError(error).message}`) });
  const generate = useMutation({ mutationFn: () => client.analytics.generateLearnings(workspaceId, projectId), onSuccess: async () => { setNotice('已生成可解释建议；不会自动修改栏目设置。'); await cache.invalidateQueries({ queryKey: ['analytics', workspaceId, projectId, 'learnings'] }); }, onError: (error) => setNotice(`生成建议失败：${describeError(error).message}`) });
  const act = useMutation({ mutationFn: ({ id, action }: { id: string; action: CreatorLearningAction['action'] }) => client.analytics.actOnLearning(workspaceId, projectId, id, { action }), onSuccess: async () => { setNotice('建议状态已更新；作品与栏目设置未被改动。'); await cache.invalidateQueries({ queryKey: ['analytics', workspaceId, projectId, 'learnings'] }); }, onError: (error) => setNotice(`操作失败：${describeError(error).message}`) });
  return <div className="page" data-testid="quiet-analytics"><header className="sectionhead mobile-stack"><div><div className="eyebrow mb16">LEARN FROM EVERY STORY</div><h1>看见作品，如何被理解。</h1><p>把观看表现放回具体分镜，不让指标替你做创作决定。</p></div><div className="row"><span className="badge">{performance ? `${performance.platformId} · 真实快照` : '暂无平台数据'}</span><select className="field select" aria-label="选择发布" value={activePublication} onChange={(event) => { setPublicationId(event.target.value); setPerformanceId(''); }}><option value="">选择作品发布</option>{publications.data?.items.map((record) => <option key={record.id} value={record.id}>{record.title} · {record.platformId}</option>)}</select></div></header>
    {notice && <p role="status" className="notice amber mb24">{notice}</p>}
    {publications.isPending && <p role="status" className="small muted mb24">正在读取发布记录…</p>}
    {publications.isError && <p role="alert" className="notice amber mb24">发布记录加载失败：{describeError(publications.error).message} <button type="button" className="textbtn small" onClick={() => void publications.refetch()}>重试</button></p>}
    {performances.isPending && activePublication && <p role="status" className="small muted mb24">正在读取平台表现…</p>}
    {performances.isError && <p role="alert" className="notice amber mb24">平台表现加载失败：{describeError(performances.error).message} <button type="button" className="textbtn small" onClick={() => void performances.refetch()}>重试</button></p>}
    <div className="metricgrid mt32"><MetricCard title="观看次数" value={formatMetric(performance?.metrics.views)} note={performance ? `${performance.sampling.source} · ${new Date(performance.sampling.fetchedAt).toLocaleString()}` : '平台尚未返回，不按 0 处理'} /><MetricCard title="平均观看时长" value={duration(performance?.metrics.averageWatchTimeMs ?? null)} note={performance ? '来自平台采样快照' : '平台尚未返回'} /><MetricCard title="完播率" value="—" note="当前接口未返回此指标" /><MetricCard title="收藏次数" value="—" note="当前接口未返回，不按 0 处理" /></div>
    <div className="split wide mt24"><section className="panel pad grow"><div className="row between"><div><h3>观看留存，回到每个场景</h3><p className="small muted mt8">横轴为作品时间 · 纵轴为相对观看留存</p></div><span className={`badge ${retentionPath ? 'green' : ''}`}>{retentionPath ? '平台采样' : hasRetentionSample ? '采样点不足' : '暂无留存采样'}</span></div><div className="mt16"><MonochromeSeriesChart
      title="真实平台留存曲线"
      series={retentionPoints.length ? [{ id: 'retention', label: '观看留存', points: retentionPoints.map((point) => ({ x: point.positionMs, y: point.rate })) }] : []}
      xLabel="作品时间"
      yLabel="相对观看留存"
      windowLabel={performance ? `${performance.sampling.granularity} · ${performance.sampling.timezone} · 抓取于 ${new Date(performance.sampling.fetchedAt).toLocaleString('zh-CN')}` : '尚无平台数据'}
      formatX={(value) => duration(value)}
      formatY={(value) => `${(value * 100).toFixed(1)}%`}
      yDomain={[0, 1]}
    /></div><p className="small muted mt16">相关变化不等于因果；低样本时不产生确定性结论。{performance ? `采样：${performance.sampling.granularity} · ${performance.sampling.timezone}` : ''}</p><div className="row mt16" style={{ flexWrap: 'wrap' }}><button type="button" className="btn small" disabled={!activePublication || collect.isPending} onClick={() => collect.mutate()}>{collect.isPending ? '采集中…' : '采集最新表现'}</button><button type="button" className="btn small" disabled={!activePerformance || attribute.isPending} onClick={() => attribute.mutate()}>{attribute.isPending ? '计算中…' : '计算场景归因'}</button></div></section><aside className="panel pad"><div className="row between"><h3>创作复盘</h3><QuietIcon name="spark" /></div>{learnings.isPending && <p className="small muted mt16">正在读取复盘建议…</p>}{learnings.isError && <p role="alert" className="small muted mt16">建议加载失败：{describeError(learnings.error).message} <button type="button" className="textbtn small" onClick={() => void learnings.refetch()}>重试</button></p>}{!learnings.isPending && !learnings.isError && learnings.data?.items.length === 0 && <div className="analysis-insight mt16"><h4>还没有复盘建议</h4><p>有真实发布表现后，可基于场景相关性生成待验证的建议。</p></div>}{learnings.data?.items.slice(0, 3).map((learning) => <div className="analysis-insight mt16" key={learning.id}><h4>{learning.title}</h4><p>{learning.explanation}</p><div className="row between mt16"><span className="badge">相关性 · {learning.evidence.sampleCount} 个样本</span>{learning.status === 'ACTIVE' ? <button type="button" className="btn small" disabled={act.isPending} onClick={() => act.mutate({ id: learning.id, action: 'ACCEPT' })}>加入下次计划</button> : <span className="badge">{learning.status}</span>}</div></div>)}<p className="small muted mt24">接受建议只记录你的选择，不会静默修改栏目设置，也不会改动已发布作品。</p><button type="button" className="textbtn small mt16" disabled={generate.isPending} onClick={() => generate.mutate()}>{generate.isPending ? '生成中…' : '生成可解释建议'} <QuietIcon name="arrow" /></button></aside></div>
    <section className="panel pad mt24"><div className="row between mb16"><h3>分镜表现</h3><span className="sample-note">对应冻结版本，不随草稿变化</span></div>{scenes.isPending && activePerformance && <p className="small muted">正在读取场景归因…</p>}{scenes.isError && <p role="alert" className="small muted">场景归因加载失败：{describeError(scenes.error).message} <button type="button" className="textbtn small" onClick={() => void scenes.refetch()}>重试</button></p>}{!scenes.isPending && !scenes.isError && !scenes.data?.items.length && <p className="small muted">暂无场景归因记录。需要平台留存采样和冻结版本。</p>}{!!scenes.data?.items.length && <div className={styles['tableScroller']}><table className="data-table"><thead><tr><th>分镜</th><th>时间位置</th><th>类型</th><th>相关留存</th><th></th></tr></thead><tbody>{scenes.data.items.map((scene) => <tr key={scene.id}><td>#{scene.position + 1} · {scene.sceneId.slice(0, 8)}</td><td>{duration(scene.startMs)} – {duration(scene.startMs + scene.durationMs)}</td><td>{scene.sceneType}</td><td>{scene.retentionRate === null ? '未知' : formatMetric(scene.retentionRate * 100, '%')}</td><td><Link className="textbtn small" href={`/w/${workspaceId}/p/${projectId}/editor/${scene.sceneId}`}>回看 <QuietIcon name="arrow" /></Link></td></tr>)}</tbody></table></div>}</section>
    <details className="panel pad mt24" onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}><summary className={styles['summary']}>高级表现与建议管理</summary><p className="small muted mt8">查看完整采样记录，并接受、禁用或恢复学习建议。</p>{advancedOpen && <div className={`${styles['advanced']} ${legacy['surface']}`}><AnalyticsWorkspace workspaceId={workspaceId} projectId={projectId} /></div>}</details>
  </div>;
}
