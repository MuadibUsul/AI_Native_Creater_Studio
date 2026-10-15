'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';
import { FINANCE_VISUALIZATION_TYPES, type FinanceVisualizationType } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useI18n } from '@/i18n/I18nProvider';
import styles from './finance-workspace.module.css';

const errorText = (error: unknown): string => describeError(error).message;

export function FinanceWorkspace({ workspaceId }: { workspaceId: string }): ReactElement {
  const client = useAncsClient();
  const cache = useQueryClient();
  const { messages } = useI18n();
  const t = messages.assetLibrary.finance;
  const [notice, setNotice] = useState<string | null>(null);
  const [financeType, setFinanceType] = useState<FinanceVisualizationType>('CANDLE');
  const [sourceName, setSourceName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [licenseId, setLicenseId] = useState('');
  const [licenseName, setLicenseName] = useState('');
  const [licenseUrl, setLicenseUrl] = useState('');
  const [allowedUse, setAllowedUse] = useState(t.defaultAllowedUse);
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
    onSuccess: async (created) => { setSourceName(''); setSelectedSourceId(created.id); setNotice(t.sourceSaved); await refresh(['finance', workspaceId, 'sources']); },
    onError: (error) => setNotice(t.sourceSaveFailed(errorText(error))),
  });
  const createTemplate = useMutation({
    mutationFn: () => client.finance.createTemplate(workspaceId, { key: templateKey, name: templateName, visualizationType: financeType, config: {} }),
    onSuccess: async (created) => { setSelectedTemplateId(created.id); setNotice(t.templateSaved(created.key, String(created.version))); await refresh(['finance', workspaceId, 'templates']); },
    onError: (error) => setNotice(t.templateSaveFailed(errorText(error))),
  });
  const compatibleTemplates = useMemo(() => templates.data?.items.filter((item) => item.visualizationType === financeType) ?? [], [templates.data, financeType]);
  const activeSourceId = selectedSourceId || sources.data?.items[0]?.id || '';
  const activeTemplateId = selectedTemplateId && compatibleTemplates.some((item) => item.id === selectedTemplateId) ? selectedTemplateId : compatibleTemplates[0]?.id || '';
  const relationRequired = financeType === 'SUPPLY_CHAIN' || financeType === 'TRADE_ROUTE' || financeType === 'SCENARIO_TREE';
  const generateArtifact = useMutation({
    mutationFn: async () => {
      if (datumValue.trim() === '') throw new Error(t.missingValue);
      if (!Number.isFinite(Number(datumValue))) throw new Error(t.invalidValue);
      const source = sources.data?.items.find((item) => item.id === activeSourceId);
      const selectedTemplate = compatibleTemplates.find((item) => item.id === activeTemplateId);
      if (source === undefined || selectedTemplate === undefined) throw new Error(t.missingSourceOrTemplate);
      if (relationRequired && (!relationFrom.trim() || !relationTo.trim() || !relationLabel.trim())) throw new Error(t.relationRequired);
      return client.finance.generateArtifact(workspaceId, {
        visualizationType: financeType, title: artifactTitle, dataSourceId: source.id, templateId: selectedTemplate.id,
        data: [{ label: datumLabel, value: Number(datumValue), unit: datumUnit, currency: datumCurrency.trim() || null, timezone: datumTimezone, adjustment: datumAdjustment, sourceId: source.id, observedAt: new Date().toISOString(), dimensions: {} }],
        relations: relationRequired ? [{ from: relationFrom, to: relationTo, label: relationLabel, sourceId: source.id }] : [],
      });
    },
    onSuccess: async () => { setNotice(t.artifactSaved); await refresh(['finance', workspaceId, 'artifacts']); },
    onError: (error) => setNotice(t.generateFailed(errorText(error))),
  });

  const fatal = sources.error ?? templates.error ?? artifacts.error;
  if (sources.isPending || templates.isPending || artifacts.isPending) return <div className="panel pad" role="status">{t.loading}</div>;
  if (fatal !== null) return <div className="panel pad" role="alert"><h3>{t.loadFailed}</h3><p className="small muted mt8">{errorText(fatal)}</p><button type="button" className="btn small mt16" onClick={() => { void sources.refetch(); void templates.refetch(); void artifacts.refetch(); }}>{messages.common.retry}</button></div>;

  return (
    <section className={styles['root']} data-testid="finance-workspace">
      {notice !== null && <p role="status" className="notice amber mb24">{notice}</p>}
      <div className="panel pad" data-testid="finance-pack">
        <div className="sectionhead mobile-stack"><div><h2>Finance Pack</h2><p className="small muted mt8">{t.intro}</p></div><span className="badge blue">{t.workspaceBadge}</span></div>
        <div className={styles['forms']}>
          <form className={`panel pad ${styles['form']}`} onSubmit={(event) => { event.preventDefault(); createSource.mutate(); }}>
            <h3>{t.sourceStep}</h3>
            <label className="label">{t.sourceName}<input aria-label={t.sourceName} className="field mt8" value={sourceName} onChange={(event) => setSourceName(event.target.value)} required /></label>
            <label className="label">{t.sourceUrlOptional}<input aria-label={t.sourceUrl} className="field mt8" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} type="url" /></label>
            <label className="label">{t.licenseId}<input aria-label={t.licenseId} className="field mt8" value={licenseId} onChange={(event) => setLicenseId(event.target.value)} required /></label>
            <label className="label">{t.licenseName}<input aria-label={t.licenseName} className="field mt8" value={licenseName} onChange={(event) => setLicenseName(event.target.value)} required /></label>
            <label className="label">{t.licenseUrlOptional}<input aria-label={t.licenseUrl} className="field mt8" value={licenseUrl} onChange={(event) => setLicenseUrl(event.target.value)} type="url" /></label>
            <label className="label">{t.allowedUse}<input aria-label={t.allowedUse} className="field mt8" value={allowedUse} onChange={(event) => setAllowedUse(event.target.value)} required /></label>
            <button type="submit" className="btn primary full" disabled={createSource.isPending}>{createSource.isPending ? t.saving : t.saveSource}</button>
          </form>
          <form className={`panel pad ${styles['form']}`} onSubmit={(event) => { event.preventDefault(); createTemplate.mutate(); }}>
            <h3>{t.templateStep}</h3>
            <label className="label">{t.visualType}<select aria-label={t.visualType} className="field select mt8" value={financeType} onChange={(event) => { setFinanceType(event.target.value as FinanceVisualizationType); setSelectedTemplateId(''); }}>{FINANCE_VISUALIZATION_TYPES.map((type) => <option key={type} value={type}>{t.visualTypes[type]}</option>)}</select></label>
            <label className="label">{t.templateKey}<input aria-label={t.templateKey} className="field mt8" value={templateKey} onChange={(event) => setTemplateKey(event.target.value)} required /></label>
            <label className="label">{t.templateName}<input aria-label={t.templateName} className="field mt8" value={templateName} onChange={(event) => setTemplateName(event.target.value)} required /></label>
            <p className="small muted">{t.templateVersionNote}</p>
            <button type="submit" className="btn primary full" disabled={createTemplate.isPending}>{createTemplate.isPending ? t.saving : t.saveTemplate}</button>
          </form>
          <form className={`panel pad ${styles['form']}`} onSubmit={(event) => { event.preventDefault(); generateArtifact.mutate(); }}>
            <h3>{t.artifactStep}</h3>
            <label className="label">{t.artifactSource}<select aria-label={t.artifactSource} className="field select mt8" value={activeSourceId} onChange={(event) => setSelectedSourceId(event.target.value)}><option value="">{t.chooseSource}</option>{sources.data?.items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.license.name}</option>)}</select></label>
            <label className="label">{t.artifactTemplate}<select aria-label={t.artifactTemplate} className="field select mt8" value={activeTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}><option value="">{t.chooseTemplate}</option>{compatibleTemplates.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}</select></label>
            <label className="label">{t.artifactTitle}<input aria-label={t.artifactTitle} className="field mt8" value={artifactTitle} onChange={(event) => setArtifactTitle(event.target.value)} required /></label>
            <label className="label">{t.datumLabel}<input aria-label={t.datumLabel} className="field mt8" value={datumLabel} onChange={(event) => setDatumLabel(event.target.value)} required /></label>
            <div className={styles['pair']}><label className="label">{t.datumValue}<input aria-label={t.datumValue} className="field mt8" value={datumValue} onChange={(event) => setDatumValue(event.target.value)} inputMode="decimal" placeholder={t.datumValuePlaceholder} /></label><label className="label">{t.unit}<input aria-label={t.unit} className="field mt8" value={datumUnit} onChange={(event) => setDatumUnit(event.target.value)} required /></label></div>
            <div className={styles['pair']}><label className="label">{t.currencyOptional}<input aria-label={t.currency} className="field mt8" value={datumCurrency} onChange={(event) => setDatumCurrency(event.target.value)} placeholder={t.currencyPlaceholder} /></label><label className="label">{t.timezone}<input aria-label={t.timezone} className="field mt8" value={datumTimezone} onChange={(event) => setDatumTimezone(event.target.value)} required /></label></div>
            <label className="label">{t.adjustment}<input aria-label={t.adjustment} className="field mt8" value={datumAdjustment} onChange={(event) => setDatumAdjustment(event.target.value)} required /></label>
            {relationRequired && <div className={styles['relations']}><label className="label">{t.relationFrom}<input aria-label={t.relationFrom} className="field mt8" value={relationFrom} onChange={(event) => setRelationFrom(event.target.value)} /></label><label className="label">{t.relationTo}<input aria-label={t.relationTo} className="field mt8" value={relationTo} onChange={(event) => setRelationTo(event.target.value)} /></label><label className="label">{t.relationLabel}<input aria-label={t.relationLabel} className="field mt8" value={relationLabel} onChange={(event) => setRelationLabel(event.target.value)} /></label></div>}
            <button type="submit" className="btn primary full" disabled={generateArtifact.isPending}>{generateArtifact.isPending ? t.generating : t.generate}</button>
          </form>
        </div>
        <section className="mt24"><h3>{t.artifactsTitle}</h3>{artifacts.data?.items.length ? <div className={styles['artifacts']}>{artifacts.data.items.map((artifact) => <article key={artifact.id} className={styles['artifact']}><strong>{t.visualTypes[artifact.visualizationType]} · {artifact.title}</strong><p className="small muted mt8">{t.artifactMeta(artifact.dataSourceSnapshot.name, artifact.dataSourceSnapshot.license.name, artifact.templateSnapshot.key, String(artifact.templateSnapshot.version))}</p></article>)}</div> : <p className="small muted mt16">{t.artifactsEmpty}</p>}</section>
      </div>
    </section>
  );
}
