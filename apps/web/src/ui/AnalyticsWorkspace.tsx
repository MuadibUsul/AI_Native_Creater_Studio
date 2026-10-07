'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';
import { FINANCE_VISUALIZATION_TYPES, type CreatorLearningAction, type FinanceVisualizationType } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { StateBlock } from './StateBlock';

const panel = 'rounded border border-slate-800 bg-slate-900/60 p-4';
const input = 'rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm';
const button = 'rounded border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50';
const VISUAL_LABELS: Record<FinanceVisualizationType, string> = {
  CANDLE: 'K 线', YIELD_CURVE: '收益率曲线', POLICY_PATH: '政策路径', SUPPLY_CHAIN: '供应链', TRADE_ROUTE: '贸易路线', SCENARIO_TREE: '情景树',
};

const metric = (value: number | null, suffix = ''): string => value === null ? '未知（平台未返回）' : `${value.toLocaleString()}${suffix}`;
const errorText = (error: unknown): string => describeError(error).message;

export function AnalyticsWorkspace({ workspaceId, projectId }: { workspaceId: string; projectId: string }): ReactElement {
  const client = useAncsClient();
  const cache = useQueryClient();
  const [selectedPublicationId, setSelectedPublicationId] = useState('');
  const [selectedPerformanceId, setSelectedPerformanceId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [financeType, setFinanceType] = useState<FinanceVisualizationType>('CANDLE');
  const [sourceName, setSourceName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [licenseId, setLicenseId] = useState('');
  const [licenseName, setLicenseName] = useState('');
  const [licenseUrl, setLicenseUrl] = useState('');
  const [allowedUse, setAllowedUse] = useState('内部视频制作');
  const [templateKey, setTemplateKey] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [artifactTitle, setArtifactTitle] = useState('');
  const [datumLabel, setDatumLabel] = useState('');
  const [datumValue, setDatumValue] = useState('');
  const [datumUnit, setDatumUnit] = useState('%');
  const [datumCurrency, setDatumCurrency] = useState('');
  const [datumTimezone, setDatumTimezone] = useState('UTC');
  const [datumAdjustment, setDatumAdjustment] = useState('UNADJUSTED');
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [relationFrom, setRelationFrom] = useState('');
  const [relationTo, setRelationTo] = useState('');
  const [relationLabel, setRelationLabel] = useState('');

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
  const sources = useQuery({ queryKey: ['finance', workspaceId, 'sources'], queryFn: () => client.finance.listDataSources(workspaceId) });
  const templates = useQuery({ queryKey: ['finance', workspaceId, 'templates'], queryFn: () => client.finance.listTemplates(workspaceId) });
  const artifacts = useQuery({ queryKey: ['finance', workspaceId, 'artifacts'], queryFn: () => client.finance.listArtifacts(workspaceId) });

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
  const createSource = useMutation({
    mutationFn: () => client.finance.createDataSource(workspaceId, { name: sourceName, sourceUrl: sourceUrl.trim() || null, license: { licenseId, name: licenseName, url: licenseUrl.trim() || null, allowedUse, effectiveAt: new Date().toISOString() } }),
    onSuccess: async (created) => { setSourceName(''); setSelectedSourceId(created.id); setNotice('数据来源及许可证快照已保存。'); await refresh(['finance', workspaceId, 'sources']); },
    onError: (error) => setNotice(`保存来源失败：${errorText(error)}`),
  });
  const createTemplate = useMutation({
    mutationFn: () => client.finance.createTemplate(workspaceId, { key: templateKey, name: templateName, visualizationType: financeType, config: {} }),
    onSuccess: async (created) => { setSelectedTemplateId(created.id); setNotice(`模板 ${created.key} v${String(created.version)} 已保存。`); await refresh(['finance', workspaceId, 'templates']); },
    onError: (error) => setNotice(`保存模板失败：${errorText(error)}`),
  });
  const compatibleTemplates = useMemo(() => templates.data?.items.filter((item) => item.visualizationType === financeType) ?? [], [templates.data, financeType]);
  const activeSourceId = selectedSourceId || sources.data?.items[0]?.id || '';
  const activeTemplateId = selectedTemplateId && compatibleTemplates.some((item) => item.id === selectedTemplateId) ? selectedTemplateId : compatibleTemplates[0]?.id || '';
  const relationRequired = financeType === 'SUPPLY_CHAIN' || financeType === 'TRADE_ROUTE' || financeType === 'SCENARIO_TREE';
  const generateArtifact = useMutation({
    mutationFn: async () => {
      if (datumValue.trim() === '') throw new Error('缺失数据不可生成图表；请补齐数值或保留为空而不生成');
      const source = sources.data?.items.find((item) => item.id === activeSourceId);
      const selectedTemplate = compatibleTemplates.find((item) => item.id === activeTemplateId);
      if (source === undefined || selectedTemplate === undefined) throw new Error('请先创建数据来源及同类型模板');
      if (relationRequired && (!relationFrom.trim() || !relationTo.trim() || !relationLabel.trim())) throw new Error('该图表类型需要填写一条可追溯关系');
      return client.finance.generateArtifact(workspaceId, {
        visualizationType: financeType, title: artifactTitle, dataSourceId: source.id, templateId: selectedTemplate.id,
        data: [{ label: datumLabel, value: Number(datumValue), unit: datumUnit, currency: datumCurrency.trim() || null, timezone: datumTimezone, adjustment: datumAdjustment, sourceId: source.id, observedAt: new Date().toISOString(), dimensions: {} }],
        relations: relationRequired ? [{ from: relationFrom, to: relationTo, label: relationLabel, sourceId: source.id }] : [],
      });
    },
    onSuccess: async () => { setNotice('Finance 产物已冻结来源许可证与模板版本。'); await refresh(['finance', workspaceId, 'artifacts']); },
    onError: (error) => setNotice(`生成失败：${errorText(error)}`),
  });

  const fatal = publications.error ?? learnings.error ?? sources.error ?? templates.error ?? artifacts.error;
  if (publications.isPending || learnings.isPending || sources.isPending || templates.isPending || artifacts.isPending) return <StateBlock variant="loading" title="正在加载 Analytics 与 Finance 工作台…" />;
  if (fatal !== null) return <StateBlock variant="error" title="工作台加载失败" description={errorText(fatal)} />;

  const performance = performances.data?.items.find((item) => item.id === activePerformanceId) ?? performances.data?.items[0];
  return (
    <section className="flex flex-col gap-5" data-testid="analytics-workspace">
      <div><h1 className="text-xl font-semibold">Analytics & Learning</h1><p className="mt-1 text-sm text-slate-400">发布后表现、场景相关性与可控学习建议。未知指标始终显示为未知，不按 0 处理。</p></div>
      {notice !== null ? <p role="status" className="rounded border border-sky-900 bg-sky-950/40 p-3 text-sm text-sky-200">{notice}</p> : null}

      <div className={panel}>
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-semibold">发布表现</h2><p className="text-xs text-slate-400">授权撤销后服务端停止采集；每份记录保留平台、区间、粒度、时区和抓取时间。</p></div>
          <div className="flex gap-2"><select aria-label="选择发布" value={activePublicationId} onChange={(event) => { setSelectedPublicationId(event.target.value); setSelectedPerformanceId(''); }} className={input}><option value="">选择发布</option>{publications.data?.items.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.platformId}</option>)}</select><button className={button} disabled={!activePublicationId || collect.isPending} onClick={() => collect.mutate()}>采集最新表现</button></div>
        </div>
        {activePublicationId && performances.isPending ? <p className="mt-3 text-sm text-slate-400">正在加载表现…</p> : performance === undefined ? <p className="mt-3 text-sm text-slate-400">尚无表现快照。</p> : <div className="mt-4 grid gap-3 md:grid-cols-4"><Metric label="播放" value={metric(performance.metrics.views)} /><Metric label="曝光" value={metric(performance.metrics.impressions)} /><Metric label="点击率" value={metric(performance.metrics.clickThroughRate === null ? null : performance.metrics.clickThroughRate * 100, '%')} /><Metric label="观看时长" value={metric(performance.metrics.watchTimeMs, ' ms')} /><p className="md:col-span-4 text-xs text-slate-500">{performance.platformId} · {performance.sampling.granularity} · {performance.sampling.timezone} · 抓取于 {new Date(performance.sampling.fetchedAt).toLocaleString()}</p></div>}
      </div>

      <div className={panel}>
        <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">场景归因</h2><p className="text-xs text-amber-300">仅表示相关性，不代表因果。归因基于发布时冻结的 Scene Graph 和留存采样。</p></div><button className={button} disabled={!activePerformanceId || attribute.isPending} onClick={() => attribute.mutate()}>计算场景归因</button></div>
        <ul className="mt-3 grid gap-2 md:grid-cols-2">{scenes.data?.items.map((scene) => <li key={scene.id} className="rounded border border-slate-800 p-3 text-sm"><span className="font-medium">#{scene.position + 1} {scene.sceneType}</span><p className="mt-1 text-slate-400">留存：{metric(scene.retentionRate === null ? null : scene.retentionRate * 100, '%')} · 样本点 {scene.derivation.sampleCount}</p></li>)}</ul>
      </div>

      <div className={panel}>
        <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">学习建议</h2><p className="text-xs text-slate-400">建议可接受、禁用与恢复；任何操作都不会静默修改 Channel。</p></div><button className={button} disabled={generate.isPending} onClick={() => generate.mutate()}>生成建议</button></div>
        <ul className="mt-3 flex flex-col gap-2">{learnings.data?.items.map((learning) => <li key={learning.id} className="rounded border border-slate-800 p-3 text-sm"><div className="flex flex-wrap justify-between gap-3"><div><p className="font-medium">{learning.title} <span className="text-xs text-sky-300">{learning.status}</span></p><p className="mt-1 text-slate-400">{learning.explanation}</p><p className="mt-1 text-xs text-amber-300">相关性证据 · {learning.evidence.sampleCount} 个样本 · 未修改 Channel</p></div><div className="flex gap-2">{learning.status === 'ACTIVE' ? <><button className={button} onClick={() => act.mutate({ id: learning.id, action: 'ACCEPT' })}>接受</button><button className={button} onClick={() => act.mutate({ id: learning.id, action: 'DISABLE' })}>禁用</button></> : <button className={button} onClick={() => act.mutate({ id: learning.id, action: 'RESTORE' })}>恢复</button>}</div></div></li>)}</ul>
      </div>

      <div className={panel} data-testid="finance-pack">
        <div><h2 className="font-semibold">Finance Pack</h2><p className="text-xs text-slate-400">六类专业图表均要求单位、时区、调整口径、观测时间和有许可证的数据来源；模板按版本冻结。</p></div>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); createSource.mutate(); }}><h3 className="text-sm font-medium">1. 数据来源与许可证</h3><input aria-label="来源名称" className={input} value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder="来源名称" required /><input aria-label="来源 URL" className={input} value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="来源 URL（可选）" type="url" /><input aria-label="许可证 ID" className={input} value={licenseId} onChange={(e) => setLicenseId(e.target.value)} placeholder="许可证 ID" required /><input aria-label="许可证名称" className={input} value={licenseName} onChange={(e) => setLicenseName(e.target.value)} placeholder="许可证名称" required /><input aria-label="许可证 URL" className={input} value={licenseUrl} onChange={(e) => setLicenseUrl(e.target.value)} placeholder="许可证 URL（可选）" type="url" /><input aria-label="允许用途" className={input} value={allowedUse} onChange={(e) => setAllowedUse(e.target.value)} required /><button className={button} disabled={createSource.isPending}>保存来源</button></form>
          <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); createTemplate.mutate(); }}><h3 className="text-sm font-medium">2. 版本化模板</h3><select aria-label="可视化类型" className={input} value={financeType} onChange={(e) => { setFinanceType(e.target.value as FinanceVisualizationType); setSelectedTemplateId(''); }}>{FINANCE_VISUALIZATION_TYPES.map((type) => <option key={type} value={type}>{VISUAL_LABELS[type]}</option>)}</select><input aria-label="模板 Key" className={input} value={templateKey} onChange={(e) => setTemplateKey(e.target.value)} placeholder="模板 Key" required /><input aria-label="模板名称" className={input} value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="模板名称" required /><button className={button} disabled={createTemplate.isPending}>保存新版本</button></form>
          <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); generateArtifact.mutate(); }}><h3 className="text-sm font-medium">3. 生成产物</h3><select aria-label="产物数据来源" className={input} value={activeSourceId} onChange={(e) => setSelectedSourceId(e.target.value)}><option value="">选择数据来源</option>{sources.data?.items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.license.name}</option>)}</select><select aria-label="产物模板" className={input} value={activeTemplateId} onChange={(e) => setSelectedTemplateId(e.target.value)}><option value="">选择同类型模板</option>{compatibleTemplates.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}</select><input aria-label="产物标题" className={input} value={artifactTitle} onChange={(e) => setArtifactTitle(e.target.value)} placeholder="产物标题" required /><input aria-label="数据标签" className={input} value={datumLabel} onChange={(e) => setDatumLabel(e.target.value)} placeholder="数据标签" required /><div className="flex gap-2"><input aria-label="数据值" className={`${input} min-w-0 flex-1`} value={datumValue} onChange={(e) => setDatumValue(e.target.value)} inputMode="decimal" placeholder="数值（必填）" /><input aria-label="单位" className={`${input} w-20`} value={datumUnit} onChange={(e) => setDatumUnit(e.target.value)} required /></div><div className="flex gap-2"><input aria-label="币种" className={`${input} min-w-0 flex-1`} value={datumCurrency} onChange={(e) => setDatumCurrency(e.target.value)} placeholder="币种（可选，如 USD）" /><input aria-label="时区" className={`${input} min-w-0 flex-1`} value={datumTimezone} onChange={(e) => setDatumTimezone(e.target.value)} required /></div><input aria-label="调整口径" className={input} value={datumAdjustment} onChange={(e) => setDatumAdjustment(e.target.value)} required />{relationRequired ? <div className="grid grid-cols-3 gap-2"><input aria-label="关系起点" className={input} value={relationFrom} onChange={(e) => setRelationFrom(e.target.value)} placeholder="起点" /><input aria-label="关系终点" className={input} value={relationTo} onChange={(e) => setRelationTo(e.target.value)} placeholder="终点" /><input aria-label="关系标签" className={input} value={relationLabel} onChange={(e) => setRelationLabel(e.target.value)} placeholder="关系" /></div> : null}<button className={button} disabled={generateArtifact.isPending}>生成并冻结快照</button></form>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-2">{artifacts.data?.items.map((artifact) => <article key={artifact.id} className="rounded border border-slate-800 p-3 text-sm"><p className="font-medium">{VISUAL_LABELS[artifact.visualizationType]} · {artifact.title}</p><p className="mt-1 text-xs text-slate-400">来源：{artifact.dataSourceSnapshot.name}（{artifact.dataSourceSnapshot.license.name}） · 模板：{artifact.templateSnapshot.key} v{artifact.templateSnapshot.version}</p></article>)}</div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return <div className="rounded border border-slate-800 p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-sm font-medium">{value}</p></div>;
}
