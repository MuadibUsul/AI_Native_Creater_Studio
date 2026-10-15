'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PrivacyTier, ProviderConnection, WorkspaceFeature } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { StateBlock } from '@/ui/StateBlock';
import { useWorkspaceSelection } from '@/ui/StudioShell';
import './workspace.css';

// 设置分类（标签文案见 messages.workspaceAdmin.settings.tabs）
const tabs = ['providers', 'budget', 'features', 'workspace', 'privacy', 'appearance'] as const;
type SettingsTab = (typeof tabs)[number];
// Provider 类别与图标缩写（标题与说明见 messages.workspaceAdmin.settings.providers.kinds）
const providerKinds = [
  ['LLM', 'AI'],
  ['TTS', 'VO'],
  ['AVATAR', 'AV'],
  ['AI_VIDEO', 'MV'],
  ['MUSIC', 'MU'],
  ['RENDER', 'RE'],
  ['STORAGE', 'ST'],
  ['DISTRIBUTION', 'DI'],
] as const;

function ProviderSettings({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const { messages } = useI18n();
  const t = messages.workspaceAdmin.settings.providers;
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<(typeof providerKinds)[number][0]>('LLM');
  const [mode, setMode] = useState<'AUTOMATIC' | 'PLATFORM_MANAGED' | 'BYOK'>('AUTOMATIC');
  const [connectionId, setConnectionId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const connections = useQuery({ queryKey: ['workspaces', workspaceId, 'provider-connections'], queryFn: () => client.providerConnections.list(workspaceId) });
  const settings = useQuery({ queryKey: ['workspaces', workspaceId, 'provider-settings'], queryFn: () => client.providerSettings.list(workspaceId) });
  const selected = settings.data?.find((entry) => entry.kind === kind);
  const matching = connections.data?.filter((entry) => entry.kind === kind) ?? [];
  useEffect(() => { setMode(selected?.selectionMode ?? 'AUTOMATIC'); setConnectionId(selected?.connectionId ?? ''); }, [kind, selected?.selectionMode, selected?.connectionId]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'provider-connections'] });
    void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'provider-settings'] });
  };
  const save = useMutation({
    mutationFn: () => client.providerSettings.set(workspaceId, kind, { selectionMode: mode, connectionId: mode === 'BYOK' ? connectionId : null }),
    onSuccess: () => { setMessage(t.routingSaved); refresh(); },
  });
  const create = useMutation({
    mutationFn: () => client.providerConnections.create(workspaceId, { providerId: providerId.trim(), kind, label: label.trim(), secret }),
    onSuccess: (created) => { setSecret(''); setProviderId(''); setLabel(''); setConnectionId(created.id); setMode('BYOK'); setMessage(t.connectionSaved); refresh(); },
  });
  const test = useMutation({
    mutationFn: (id: string) => client.providerConnections.test(workspaceId, id),
    onSuccess: (result) => { setMessage(t.testResult(result.test.message, result.test.mode === 'LIVE' ? t.testLive : t.testOffline)); refresh(); },
  });
  const error = save.error ?? create.error ?? test.error;

  return <div className="qf-settings-content"><section className="panel pad"><div className="row between"><div><h3>{t.title}</h3><p className="small muted mt8">{t.lead}</p></div><span className="badge">{t.secureBadge}</span></div>
    {connections.isError || settings.isError ? <StateBlock variant="error" title={t.loadFailed} description={describeError(connections.error ?? settings.error).message} action={{ label: messages.common.retry, onClick: () => { void connections.refetch(); void settings.refetch(); } }} /> : connections.isPending || settings.isPending ? <StateBlock variant="loading" title={t.loading} /> : <>
      <div className="qf-provider-list mt24">{providerKinds.map(([itemKind, glyph]) => {
        const { title, description } = t.kinds[itemKind];
        const linked = connections.data?.filter((entry) => entry.kind === itemKind && entry.status === 'ACTIVE') ?? [];
        const configured = settings.data?.find((entry) => entry.kind === itemKind);
        return <button type="button" key={itemKind} className={'provider-row qf-provider-row qf-provider-button' + (kind === itemKind ? ' active' : '')} onClick={() => { setKind(itemKind); setMessage(null); }} aria-pressed={kind === itemKind}><span className="provider-icon">{glyph}</span><span className="grow"><strong>{title}</strong><small>{description}</small></span><span className={'badge' + (linked.length ? ' green' : '')}>{linked.length ? t.connectionCount(linked.length) : t.notConnected}</span><span className="small muted">{configured?.selectionMode === 'BYOK' ? t.modeByok : configured?.selectionMode === 'PLATFORM_MANAGED' ? t.modePlatformPreference : t.modeAutomatic}</span></button>;
      })}</div>
      <div className="qf-provider-detail mt24"><h3>{t.detailTitle(t.kinds[kind].title)}</h3><p className="small muted mt8">{t.detailNote}</p>
        <form className="qf-provider-form mt24" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}><label className="label">{t.selectionMode}<select className="field select" value={mode} disabled={!canManage} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="AUTOMATIC">{t.optionAutomatic}</option><option value="PLATFORM_MANAGED">{t.optionPlatform}</option><option value="BYOK">{t.optionByok}</option></select></label><label className="label">{t.currentConnection}<select className="field select" value={connectionId} disabled={!canManage || mode !== 'BYOK'} onChange={(event) => setConnectionId(event.target.value)}><option value="">{t.chooseConnection}</option>{matching.filter((entry) => entry.status === 'ACTIVE').map((entry) => <option value={entry.id} key={entry.id}>{entry.label} · {entry.maskedToken}</option>)}</select></label><div className="qf-span-2 qf-settings-actions"><button type="submit" className="btn primary small" disabled={!canManage || save.isPending || (mode === 'BYOK' && !connectionId)}>{t.saveRouting}</button></div></form>
        {matching.length ? <div className="mt24"><h4>{t.registered}</h4>{matching.map((entry: ProviderConnection) => <div className="settings-row" key={entry.id}><div><strong>{entry.label}</strong><p>{entry.providerId} · {entry.maskedToken} · {entry.status}</p></div><button type="button" className="btn small" disabled={!canManage || test.isPending || entry.status !== 'ACTIVE'} onClick={() => test.mutate(entry.id)}>{t.testConnection}</button></div>)}</div> : <p className="small muted mt24">{t.noByok}</p>}
        <hr className="divider" /><h4>{t.addTitle}</h4><p className="small muted mt8">{t.addNote}</p><form className="qf-provider-form mt16" autoComplete="off" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><label className="label">{t.providerIdLabel}<input className="field" value={providerId} disabled={!canManage} onChange={(event) => setProviderId(event.target.value)} required maxLength={100} placeholder={t.providerIdPlaceholder} /></label><label className="label">{t.connectionName}<input className="field" value={label} disabled={!canManage} onChange={(event) => setLabel(event.target.value)} required maxLength={200} placeholder={t.connectionNamePlaceholder} /></label><label className="label qf-span-2">{t.secretLabel}<input className="field qf-secret" type="password" value={secret} disabled={!canManage} onChange={(event) => setSecret(event.target.value)} required minLength={8} maxLength={4096} autoComplete="new-password" /></label><div className="qf-span-2"><button type="submit" className="btn small" disabled={!canManage || create.isPending}>{t.saveConnection}</button></div></form>
      </div>
    </>}
    {message ? <p role="status" className="notice green mt16">{message}</p> : null}{error ? <p role="alert" className="notice amber mt16">{describeError(error).message}</p> : null}
  </section><section className="panel pad mt24"><h3>{t.costTitle}</h3><p className="small muted mt8">{t.costLead}</p><div className="notice mt16">{t.costNotice}</div></section></div>;
}

function BudgetSettings({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const { messages, locale } = useI18n();
  const t = messages.workspaceAdmin.settings.budget;
  const formatNumber = (value: number) => new Intl.NumberFormat(locale).format(value);
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const billing = useQuery({ queryKey: ['workspaces', workspaceId, 'billing-status'], queryFn: () => client.billing.status(workspaceId) });
  const [period, setPeriod] = useState<'DAILY' | 'MONTHLY'>('MONTHLY');
  const [limitCredits, setLimitCredits] = useState('0');
  const [perJobMaxCredits, setPerJobMaxCredits] = useState('0');
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { if (billing.data?.budget) { setPeriod(billing.data.budget.period); setLimitCredits(String(billing.data.budget.limitCredits)); setPerJobMaxCredits(String(billing.data.budget.perJobMaxCredits)); } }, [billing.data?.budget]);
  const save = useMutation({
    mutationFn: () => {
      const limit = Number(limitCredits), perJob = Number(perJobMaxCredits);
      if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(perJob) || perJob < 0) throw new Error(t.invalid);
      return client.billing.setBudget(workspaceId, { period, limitCredits: limit, perJobMaxCredits: perJob });
    },
    onSuccess: () => { setMessage(t.saved); void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'billing-status'] }); },
  });
  return <div className="qf-settings-content"><section className="panel pad"><h3>{t.title}</h3><p className="small muted mt8">{t.lead}</p>{billing.isPending ? <StateBlock variant="loading" title={t.loading} /> : billing.isError ? <StateBlock variant="error" title={t.loadFailed} description={describeError(billing.error).message} action={{ label: messages.common.retry, onClick: () => void billing.refetch() }} /> : <><div className="qf-metric-row mt24"><div><span className="small muted">{t.balance}</span><h2>{t.credits(formatNumber(billing.data?.balanceCredits ?? 0))}</h2></div><div><span className="small muted">{t.spent}</span><h2>{formatNumber(billing.data?.usage.spentCredits ?? 0)}</h2></div><div><span className="small muted">{t.reserved}</span><h2>{formatNumber(billing.data?.usage.reservedCredits ?? 0)}</h2></div></div><form className="mt32" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}><div className="qf-budget-fields"><label className="label">{t.period}<select className="field select" value={period} disabled={!canManage} onChange={(event) => setPeriod(event.target.value as typeof period)}><option value="MONTHLY">{t.monthly}</option><option value="DAILY">{t.daily}</option></select></label><label className="label">{t.limit}<input className="field" type="number" min="0" step="1" value={limitCredits} disabled={!canManage} onChange={(event) => setLimitCredits(event.target.value)} /></label><label className="label">{t.perJob}<input className="field" type="number" min="0" step="1" value={perJobMaxCredits} disabled={!canManage} onChange={(event) => setPerJobMaxCredits(event.target.value)} /></label></div><button type="submit" className="btn primary small mt24" disabled={!canManage || save.isPending}>{t.save}</button></form><Link className="textbtn mt24" href={'/w/' + workspaceId + '/billing'}>{t.viewBilling}</Link></>}{message ? <p role="status" className="notice green mt16">{message}</p> : null}{save.isError ? <p role="alert" className="notice amber mt16">{describeError(save.error).message}</p> : null}</section></div>;
}

function WorkspaceDetails({ workspaceId, privacyOnly }: { workspaceId: string; privacyOnly: boolean }) {
  const { messages } = useI18n();
  const t = messages.workspaceAdmin.settings.workspace;
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ['workspaces', workspaceId, 'details'], queryFn: () => client.workspaces.get(workspaceId) });
  const [name, setName] = useState('');
  const [privacyTier, setPrivacyTier] = useState<PrivacyTier>('STANDARD');
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { setName(workspace.data?.name ?? ''); setPrivacyTier(workspace.data?.privacyTier ?? 'STANDARD'); }, [workspace.data?.name, workspace.data?.privacyTier]);
  const canManage = workspace.data?.role === 'OWNER' || workspace.data?.role === 'ADMIN';
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'details'] });
  const saveName = useMutation({ mutationFn: () => client.workspaces.update(workspaceId, { name: name.trim() }), onSuccess: () => { setMessage(t.nameSaved); refresh(); } });
  const savePrivacy = useMutation({ mutationFn: () => client.workspaces.setPrivacyTier(workspaceId, { privacyTier }), onSuccess: () => { setMessage(t.privacySaved); refresh(); } });
  return <div className="qf-settings-content"><section className="panel pad"><h3>{privacyOnly ? t.privacyTitle : t.workspaceTitle}</h3>{workspace.isPending ? <StateBlock variant="loading" title={t.loading} /> : workspace.isError ? <StateBlock variant="error" title={t.loadFailed} description={describeError(workspace.error).message} action={{ label: messages.common.retry, onClick: () => void workspace.refetch() }} /> : privacyOnly ? <><p className="small muted mt8">{t.privacyLead}</p><form className="mt24" onSubmit={(event) => { event.preventDefault(); savePrivacy.mutate(); }}><label className="label">{t.currentTier}<select className="field select" value={privacyTier} disabled={!canManage} onChange={(event) => setPrivacyTier(event.target.value as PrivacyTier)}><option value="STANDARD">{t.tiers.STANDARD}</option><option value="PRIVATE">{t.tiers.PRIVATE}</option><option value="ENTERPRISE">{t.tiers.ENTERPRISE}</option></select></label><button type="submit" className="btn primary small mt16" disabled={!canManage || savePrivacy.isPending}>{t.savePrivacy}</button></form><div className="notice mt24">{t.privacyNotice}</div><Link className="textbtn mt24" href={'/w/' + workspaceId + '/team'}>{t.viewTeamPrivacy}</Link></> : <><p className="small muted mt8">{t.roleLead(workspace.data?.role ?? '')}</p><form className="mt24" onSubmit={(event) => { event.preventDefault(); saveName.mutate(); }}><label className="label">{t.workspaceName}<input className="field" value={name} maxLength={80} disabled={!canManage} onChange={(event) => setName(event.target.value)} /></label><button type="submit" className="btn primary small mt16" disabled={!canManage || saveName.isPending || !name.trim()}>{t.saveName}</button></form><div className="settings-row mt24"><div><h4>{t.membersTitle}</h4><p>{t.membersNote}</p></div><Link className="btn small" href={'/w/' + workspaceId + '/team'}>{t.manageTeam}</Link></div></>}{message ? <p role="status" className="notice green mt16">{message}</p> : null}{saveName.isError || savePrivacy.isError ? <p role="alert" className="notice amber mt16">{describeError(saveName.error ?? savePrivacy.error).message}</p> : null}</section></div>;
}

function FeatureSettings({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const { messages } = useI18n();
  const t = messages.workspaceAdmin.settings.features;
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const features = useQuery({ queryKey: ['workspaces', workspaceId, 'features'], queryFn: () => client.workspaces.features(workspaceId) });
  const update = useMutation({
    mutationFn: (input: { feature: WorkspaceFeature; enabled: boolean }) => client.workspaces.setFeature(workspaceId, input.feature.key, input.enabled),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'features'] }),
  });
  return <div className="qf-settings-content"><section className="panel pad"><h3>{t.title}</h3><p className="small muted mt8">{t.lead}</p>
    {features.isPending ? <StateBlock variant="loading" title={t.loading} /> : features.isError ? <StateBlock variant="error" title={t.loadFailed} description={describeError(features.error).message} action={{ label: messages.common.retry, onClick: () => void features.refetch() }} /> : <div className="mt24">{features.data?.map((feature) => <div className="settings-row" key={feature.key}><div><div className="row"><h4>{feature.label}</h4><span className={'badge' + (feature.effectiveState === 'ENABLED' ? ' green' : '')}>{feature.effectiveState === 'ENABLED' ? t.enabled : feature.effectiveState === 'READ_ONLY' ? t.waitingGate : t.notSelected}</span></div><p>{feature.description}</p><p className="small muted">{t.meta(feature.releaseGate, feature.platforms.join(' / '), t.levels[feature.minimumCapabilityLevel])}</p></div><button type="button" className="btn small qf-feature-action" disabled={!canManage || update.isPending} aria-pressed={feature.requestedEnabled} onClick={() => update.mutate({ feature, enabled: !feature.requestedEnabled })}>{feature.requestedEnabled ? t.deselect : t.select}</button></div>)}</div>}
    {update.isError ? <p role="alert" className="notice amber mt16">{describeError(update.error).message}</p> : null}
    <div className="notice mt24">{t.notice}</div>
  </section></div>;
}

function AppearanceSettings() {
  const { messages } = useI18n();
  const t = messages.workspaceAdmin.settings.appearance;
  const { accountAppearanceMode, deviceOverride, appearancePending, appearanceError, refetchAppearance, setAccountAppearance, setDeviceOverride } = useWorkspaceSelection();
  const save = useMutation({ mutationFn: setAccountAppearance });
  return <section className="panel pad qf-settings-content">
    <h3>{t.title}</h3><p className="small muted mt8">{t.lead}</p>
    {appearanceError ? <StateBlock variant="error" title={t.loadFailed} description={t.loadFailedHint} action={{ label: messages.common.retry, onClick: refetchAppearance }} /> : null}
    <div className="settings-row mt24"><div><h4>{t.accountTitle}</h4><p>{t.accountNote}</p></div><label className="label">{t.accountLabel}<select className="field select" value={accountAppearanceMode} disabled={appearancePending || appearanceError || save.isPending} onChange={(event) => save.mutate(event.target.value as typeof accountAppearanceMode)}><option value="system">{t.system}</option><option value="light">{t.light}</option><option value="dark">{t.dark}</option></select></label></div>
    <div className="settings-row"><div><h4>{t.deviceTitle}</h4><p>{t.deviceNote}</p></div><label className="label">{t.deviceLabel}<select className="field select" value={deviceOverride ?? 'inherit'} onChange={(event) => setDeviceOverride(event.target.value === 'inherit' ? null : event.target.value as typeof accountAppearanceMode)}><option value="inherit">{t.inherit}</option><option value="system">{t.deviceSystem}</option><option value="light">{t.light}</option><option value="dark">{t.dark}</option></select></label></div>
    {save.isError ? <p role="alert" className="notice amber mt16">{describeError(save.error).message}</p> : null}
    <div className="settings-row"><div><h4>{t.designTitle}</h4><p>{t.designNote}</p></div><Link className="btn small" href="/design-system">{t.designLink}</Link></div>
  </section>;
}

export function WorkspaceSettings({ workspaceId }: { workspaceId: string }) {
  const { messages } = useI18n();
  const t = messages.workspaceAdmin.settings;
  const [tab, setTab] = useState<SettingsTab>('providers');
  const client = useAncsClient();
  const workspace = useQuery({ queryKey: ['workspaces', workspaceId, 'details'], queryFn: () => client.workspaces.get(workspaceId) });
  const canManage = workspace.data?.role === 'OWNER' || workspace.data?.role === 'ADMIN';
  return <main className="page narrow qf-workspace-page"><div className="page-head"><h1>{t.title}</h1><p>{t.lead}</p></div><div className="settings-layout mt32"><aside className="setting-nav qf-setting-nav" aria-label={t.navAria}>{tabs.map((item) => <button key={item} type="button" className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{t.tabs[item]}</button>)}</aside>
    {tab === 'providers' ? <ProviderSettings workspaceId={workspaceId} canManage={canManage} /> : tab === 'budget' ? <BudgetSettings workspaceId={workspaceId} canManage={canManage} /> : tab === 'features' ? <FeatureSettings workspaceId={workspaceId} canManage={canManage} /> : tab === 'workspace' ? <WorkspaceDetails workspaceId={workspaceId} privacyOnly={false} /> : tab === 'privacy' ? <WorkspaceDetails workspaceId={workspaceId} privacyOnly /> : <AppearanceSettings />}
  </div></main>;
}
