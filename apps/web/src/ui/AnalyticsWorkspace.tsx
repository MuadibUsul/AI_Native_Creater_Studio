'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import type { CreatorLearningAction } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { StateBlock } from './StateBlock';
import ui from './Monochrome.module.css';

const panel = `${ui['panel']} p-4`;
const input = ui['field'];
const button = ui['button'];

const metric = (value: number | null, suffix = ''): string => value === null ? '未知（平台未返回）' : `${value.toLocaleString()}${suffix}`;
const errorText = (error: unknown): string => describeError(error).message;

export function AnalyticsWorkspace({ workspaceId, projectId }: { workspaceId: string; projectId: string }): ReactElement {
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
    onSuccess: async (record) => { setSelectedPerformanceId(record.id); setNotice('已保存平台表现与采样口径。'); await refresh(['analytics', workspaceId, projectId, activePublicationId, 'performance']); },
    onError: (error) => setNotice(`采集失败：${errorText(error)}`),
  });
  const attribute = useMutation({
    mutationFn: () => client.analytics.attributeScenes(workspaceId, projectId, activePerformanceId),
    onSuccess: async () => { setNotice('已按冻结版本时间轴完成场景归因。'); await refresh(['analytics', workspaceId, projectId, activePerformanceId, 'scenes']); },
    onError: (error) => setNotice(`归因失败：${errorText(error)}`),
  });
  const generate = useMutation({
    mutationFn: () => client.analytics.generateLearnings(workspaceId, projectId),
    onSuccess: async () => { setNotice('已生成可解释建议；栏目设置未被修改。'); await refresh(['analytics', workspaceId, projectId, 'learnings']); },
    onError: (error) => setNotice(`生成建议失败：${errorText(error)}`),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: CreatorLearningAction['action'] }) => client.analytics.actOnLearning(workspaceId, projectId, id, { action }),
    onSuccess: async () => { setNotice('建议状态已更新；栏目设置仍保持不变。'); await refresh(['analytics', workspaceId, projectId, 'learnings']); },
    onError: (error) => setNotice(`操作失败：${errorText(error)}`),
  });

  const fatal = publications.error ?? learnings.error;
  if (publications.isPending || learnings.isPending) return <StateBlock variant="loading" title="正在加载表现与建议…" />;
  if (fatal !== null) return <StateBlock variant="error" title="表现或建议加载失败" description={errorText(fatal)} action={{ label: '重试', onClick: () => { void publications.refetch(); void learnings.refetch(); } }} />;

  const performance = performances.data?.items.find((item) => item.id === activePerformanceId) ?? performances.data?.items[0];
  return (
    <section className="flex flex-col gap-5" data-testid="analytics-workspace">
      <div><h1 className="text-xl font-semibold">Analytics & Learning</h1><p className={`mt-1 text-sm ${ui['secondaryText']}`}>发布后表现、场景相关性与可控学习建议。未知指标始终显示为未知，不按 0 处理。</p></div>
      {notice !== null ? <p role="status" className={`text-sm ${ui['notice']}`}>{notice}</p> : null}

      <div className={panel}>
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-semibold">发布表现</h2><p className={`text-xs ${ui['secondaryText']}`}>授权撤销后服务端停止采集；每份记录保留平台、区间、粒度、时区和抓取时间。</p></div>
          <div className="flex gap-2"><select aria-label="选择发布" value={activePublicationId} onChange={(event) => { setSelectedPublicationId(event.target.value); setSelectedPerformanceId(''); }} className={input}><option value="">选择发布</option>{publications.data?.items.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.platformId}</option>)}</select><button className={button} disabled={!activePublicationId || collect.isPending} onClick={() => collect.mutate()}>采集最新表现</button></div>
        </div>
        {activePublicationId && performances.isPending ? <p className={`mt-3 text-sm ${ui['secondaryText']}`}>正在加载表现…</p> : performance === undefined ? <p className={`mt-3 text-sm ${ui['secondaryText']}`}>尚无表现快照。</p> : <div className="mt-4 grid gap-3 md:grid-cols-4"><Metric label="播放" value={metric(performance.metrics.views)} /><Metric label="曝光" value={metric(performance.metrics.impressions)} /><Metric label="点击率" value={metric(performance.metrics.clickThroughRate === null ? null : performance.metrics.clickThroughRate * 100, '%')} /><Metric label="观看时长" value={metric(performance.metrics.watchTimeMs, ' ms')} /><p className={`md:col-span-4 text-xs ${ui['mutedText']}`}>{performance.platformId} · {performance.sampling.granularity} · {performance.sampling.timezone} · 抓取于 {new Date(performance.sampling.fetchedAt).toLocaleString()}</p></div>}
      </div>

      <div className={panel}>
        <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">场景归因</h2><p className={`text-xs ${ui['secondaryText']}`}>仅表示相关性，不代表因果。归因基于发布时冻结的 Scene Graph 和留存采样。</p></div><button className={button} disabled={!activePerformanceId || attribute.isPending} onClick={() => attribute.mutate()}>计算场景归因</button></div>
        <ul className="mt-3 grid gap-2 md:grid-cols-2">{scenes.data?.items.map((scene) => <li key={scene.id} className={`${ui['inset']} p-3 text-sm`}><span className="font-medium">#{scene.position + 1} {scene.sceneType}</span><p className={`mt-1 ${ui['secondaryText']}`}>留存：{metric(scene.retentionRate === null ? null : scene.retentionRate * 100, '%')} · 样本点 {scene.derivation.sampleCount}</p></li>)}</ul>
      </div>

      <div className={panel}>
        <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">学习建议</h2><p className={`text-xs ${ui['secondaryText']}`}>建议可接受、禁用与恢复；任何操作都不会静默修改 Channel。</p></div><button className={button} disabled={generate.isPending} onClick={() => generate.mutate()}>生成建议</button></div>
        <ul className="mt-3 flex flex-col gap-2">{learnings.data?.items.map((learning) => <li key={learning.id} className={`${ui['inset']} p-3 text-sm`}><div className="flex flex-wrap justify-between gap-3"><div><p className="font-medium">{learning.title} <span className={`text-xs ${ui['secondaryText']}`}>{learning.status}</span></p><p className={`mt-1 ${ui['secondaryText']}`}>{learning.explanation}</p><p className={`mt-1 text-xs ${ui['secondaryText']}`}>相关性证据 · {learning.evidence.sampleCount} 个样本 · 未修改 Channel</p></div><div className="flex gap-2">{learning.status === 'ACTIVE' ? <><button className={button} onClick={() => act.mutate({ id: learning.id, action: 'ACCEPT' })}>接受</button><button className={button} onClick={() => act.mutate({ id: learning.id, action: 'DISABLE' })}>禁用</button></> : <button className={button} onClick={() => act.mutate({ id: learning.id, action: 'RESTORE' })}>恢复</button>}</div></div></li>)}</ul>
      </div>

    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return <div className={`${ui['inset']} p-3`}><p className={`text-xs ${ui['mutedText']}`}>{label}</p><p className="mt-1 text-sm font-medium">{value}</p></div>;
}
