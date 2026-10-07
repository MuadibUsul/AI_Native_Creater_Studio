'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';
import { FINANCE_VISUALIZATION_TYPES, type FinanceVisualizationType } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import styles from './finance-workspace.module.css';

const VISUAL_LABELS: Record<FinanceVisualizationType, string> = {
  CANDLE: 'K 线', YIELD_CURVE: '收益率曲线', POLICY_PATH: '政策路径', SUPPLY_CHAIN: '供应链', TRADE_ROUTE: '贸易路线', SCENARIO_TREE: '情景树',
};

const errorText = (error: unknown): string => describeError(error).message;

export function FinanceWorkspace({ workspaceId }: { workspaceId: string }): ReactElement {
  const client = useAncsClient();
  const cache = useQueryClient();
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

  const sources = useQuery({ queryKey: ['finance', workspaceId, 'sources'], queryFn: () => client.finance.listDataSources(workspaceId) });
  const templates = useQuery({ queryKey: ['finance', workspaceId, 'templates'], queryFn: () => client.finance.listTemplates(workspaceId) });
  const artifacts = useQuery({ queryKey: ['finance', workspaceId, 'artifacts'], queryFn: () => client.finance.listArtifacts(workspaceId) });

  const refresh = async (key: readonly unknown[]): Promise<void> => { await cache.invalidateQueries({ queryKey: key }); };
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
      if (!Number.isFinite(Number(datumValue))) throw new Error('请输入有效数值');
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

  const fatal = sources.error ?? templates.error ?? artifacts.error;
  if (sources.isPending || templates.isPending || artifacts.isPending) return <div className="panel pad" role="status">正在加载 Finance 图表素材…</div>;
  if (fatal !== null) return <div className="panel pad" role="alert"><h3>Finance 图表素材加载失败</h3><p className="small muted mt8">{errorText(fatal)}</p><button type="button" className="btn small mt16" onClick={() => { void sources.refetch(); void templates.refetch(); void artifacts.refetch(); }}>重试</button></div>;

  return (
    <section className={styles['root']} data-testid="finance-workspace">
      {notice !== null && <p role="status" className="notice amber mb24">{notice}</p>}
      <div className="panel pad" data-testid="finance-pack">
        <div className="sectionhead mobile-stack"><div><h2>Finance Pack</h2><p className="small muted mt8">六类专业图表均要求单位、时区、调整口径、观测时间和有许可证的数据来源；模板按版本冻结。</p></div><span className="badge blue">工作区素材</span></div>
        <div className={styles['forms']}>
          <form className={`panel pad ${styles['form']}`} onSubmit={(event) => { event.preventDefault(); createSource.mutate(); }}>
            <h3>1. 数据来源与许可证</h3>
            <label className="label">来源名称<input aria-label="来源名称" className="field mt8" value={sourceName} onChange={(event) => setSourceName(event.target.value)} required /></label>
            <label className="label">来源 URL（可选）<input aria-label="来源 URL" className="field mt8" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} type="url" /></label>
            <label className="label">许可证 ID<input aria-label="许可证 ID" className="field mt8" value={licenseId} onChange={(event) => setLicenseId(event.target.value)} required /></label>
            <label className="label">许可证名称<input aria-label="许可证名称" className="field mt8" value={licenseName} onChange={(event) => setLicenseName(event.target.value)} required /></label>
            <label className="label">许可证 URL（可选）<input aria-label="许可证 URL" className="field mt8" value={licenseUrl} onChange={(event) => setLicenseUrl(event.target.value)} type="url" /></label>
            <label className="label">允许用途<input aria-label="允许用途" className="field mt8" value={allowedUse} onChange={(event) => setAllowedUse(event.target.value)} required /></label>
            <button type="submit" className="btn primary full" disabled={createSource.isPending}>{createSource.isPending ? '保存中…' : '保存来源'}</button>
          </form>
          <form className={`panel pad ${styles['form']}`} onSubmit={(event) => { event.preventDefault(); createTemplate.mutate(); }}>
            <h3>2. 版本化模板</h3>
            <label className="label">可视化类型<select aria-label="可视化类型" className="field select mt8" value={financeType} onChange={(event) => { setFinanceType(event.target.value as FinanceVisualizationType); setSelectedTemplateId(''); }}>{FINANCE_VISUALIZATION_TYPES.map((type) => <option key={type} value={type}>{VISUAL_LABELS[type]}</option>)}</select></label>
            <label className="label">模板 Key<input aria-label="模板 Key" className="field mt8" value={templateKey} onChange={(event) => setTemplateKey(event.target.value)} required /></label>
            <label className="label">模板名称<input aria-label="模板名称" className="field mt8" value={templateName} onChange={(event) => setTemplateName(event.target.value)} required /></label>
            <p className="small muted">同一 Key 的新模板会形成新版本；已有产物继续引用冻结版本。</p>
            <button type="submit" className="btn primary full" disabled={createTemplate.isPending}>{createTemplate.isPending ? '保存中…' : '保存新版本'}</button>
          </form>
          <form className={`panel pad ${styles['form']}`} onSubmit={(event) => { event.preventDefault(); generateArtifact.mutate(); }}>
            <h3>3. 生成产物</h3>
            <label className="label">产物数据来源<select aria-label="产物数据来源" className="field select mt8" value={activeSourceId} onChange={(event) => setSelectedSourceId(event.target.value)}><option value="">选择数据来源</option>{sources.data?.items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.license.name}</option>)}</select></label>
            <label className="label">产物模板<select aria-label="产物模板" className="field select mt8" value={activeTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}><option value="">选择同类型模板</option>{compatibleTemplates.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}</select></label>
            <label className="label">产物标题<input aria-label="产物标题" className="field mt8" value={artifactTitle} onChange={(event) => setArtifactTitle(event.target.value)} required /></label>
            <label className="label">数据标签<input aria-label="数据标签" className="field mt8" value={datumLabel} onChange={(event) => setDatumLabel(event.target.value)} required /></label>
            <div className={styles['pair']}><label className="label">数据值<input aria-label="数据值" className="field mt8" value={datumValue} onChange={(event) => setDatumValue(event.target.value)} inputMode="decimal" placeholder="必填数值" /></label><label className="label">单位<input aria-label="单位" className="field mt8" value={datumUnit} onChange={(event) => setDatumUnit(event.target.value)} required /></label></div>
            <div className={styles['pair']}><label className="label">币种（可选）<input aria-label="币种" className="field mt8" value={datumCurrency} onChange={(event) => setDatumCurrency(event.target.value)} placeholder="如 USD" /></label><label className="label">时区<input aria-label="时区" className="field mt8" value={datumTimezone} onChange={(event) => setDatumTimezone(event.target.value)} required /></label></div>
            <label className="label">调整口径<input aria-label="调整口径" className="field mt8" value={datumAdjustment} onChange={(event) => setDatumAdjustment(event.target.value)} required /></label>
            {relationRequired && <div className={styles['relations']}><label className="label">关系起点<input aria-label="关系起点" className="field mt8" value={relationFrom} onChange={(event) => setRelationFrom(event.target.value)} /></label><label className="label">关系终点<input aria-label="关系终点" className="field mt8" value={relationTo} onChange={(event) => setRelationTo(event.target.value)} /></label><label className="label">关系标签<input aria-label="关系标签" className="field mt8" value={relationLabel} onChange={(event) => setRelationLabel(event.target.value)} /></label></div>}
            <button type="submit" className="btn primary full" disabled={generateArtifact.isPending}>{generateArtifact.isPending ? '生成中…' : '生成并冻结快照'}</button>
          </form>
        </div>
        <section className="mt24"><h3>已生成图表</h3>{artifacts.data?.items.length ? <div className={styles['artifacts']}>{artifacts.data.items.map((artifact) => <article key={artifact.id} className={styles['artifact']}><strong>{VISUAL_LABELS[artifact.visualizationType]} · {artifact.title}</strong><p className="small muted mt8">来源：{artifact.dataSourceSnapshot.name}（{artifact.dataSourceSnapshot.license.name}） · 模板：{artifact.templateSnapshot.key} v{artifact.templateSnapshot.version}</p></article>)}</div> : <p className="small muted mt16">尚无 Finance 图表产物；不会生成示例数值。</p>}</section>
      </div>
    </section>
  );
}
