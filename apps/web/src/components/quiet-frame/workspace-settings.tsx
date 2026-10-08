'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PrivacyTier, ProviderConnection, WorkspaceFeature } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { StateBlock } from '@/ui/StateBlock';
import { useWorkspaceSelection } from '@/ui/StudioShell';
import './workspace.css';

const tabs = ['模型与连接', '用量与预算', '新能力', '工作区与成员', '安全与隐私', '外观与偏好'] as const;
type SettingsTab = (typeof tabs)[number];
const providerKinds = [
  ['LLM', 'AI', '脚本与导演', '语言理解、叙事与结构化修改'],
  ['TTS', 'VO', '旁白声音', '声音合成与授权克隆'],
  ['AVATAR', 'AV', '数字人', '按场景生成，保持身份一致'],
  ['AI_VIDEO', 'MV', '视频镜头', '只生成必要镜头，避免重复支出'],
  ['MUSIC', 'MU', '音乐与音效', '作品音频素材生成'],
  ['RENDER', 'RE', '成片渲染', '成片输出与校验'],
  ['STORAGE', 'ST', '资产存储', '保留受控的持久资产'],
  ['DISTRIBUTION', 'DI', '交付分发', '按渠道能力和授权交付'],
] as const;
const capabilityLevelLabel: Record<WorkspaceFeature['minimumCapabilityLevel'], string> = {
  PROTOTYPE: '原型验证',
  INTERNAL_VALIDATED: '内部验证',
  PRODUCTION_SUPPORTED: '生产支持',
};

function ProviderSettings({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
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
    onSuccess: () => { setMessage('路由偏好已保存'); refresh(); },
  });
  const create = useMutation({
    mutationFn: () => client.providerConnections.create(workspaceId, { providerId: providerId.trim(), kind, label: label.trim(), secret }),
    onSuccess: (created) => { setSecret(''); setProviderId(''); setLabel(''); setConnectionId(created.id); setMode('BYOK'); setMessage('连接已保存。服务端仅返回掩码；可继续设置为当前类别的 BYOK 连接。'); refresh(); },
  });
  const test = useMutation({
    mutationFn: (id: string) => client.providerConnections.test(workspaceId, id),
    onSuccess: (result) => { setMessage('检测：' + result.test.message + '（' + (result.test.mode === 'LIVE' ? '真实检测' : '离线校验') + '）'); refresh(); },
  });
  const error = save.error ?? create.error ?? test.error;

  return <div className="qf-settings-content"><section className="panel pad"><div className="row between"><div><h3>模型与生成服务</h3><p className="small muted mt8">按能力选择 Provider。当前状态由工作区连接和路由偏好决定。</p></div><span className="badge">安全连接</span></div>
    {connections.isError || settings.isError ? <StateBlock variant="error" title="连接读取失败" description={describeError(connections.error ?? settings.error).message} action={{ label: '重试', onClick: () => { void connections.refetch(); void settings.refetch(); } }} /> : connections.isPending || settings.isPending ? <StateBlock variant="loading" title="正在读取连接" /> : <>
      <div className="qf-provider-list mt24">{providerKinds.map(([itemKind, glyph, title, description]) => {
        const linked = connections.data?.filter((entry) => entry.kind === itemKind && entry.status === 'ACTIVE') ?? [];
        const configured = settings.data?.find((entry) => entry.kind === itemKind);
        return <button type="button" key={itemKind} className={'provider-row qf-provider-row qf-provider-button' + (kind === itemKind ? ' active' : '')} onClick={() => { setKind(itemKind); setMessage(null); }} aria-pressed={kind === itemKind}><span className="provider-icon">{glyph}</span><span className="grow"><strong>{title}</strong><small>{description}</small></span><span className={'badge' + (linked.length ? ' green' : '')}>{linked.length ? linked.length + ' 个连接' : '未连接'}</span><span className="small muted">{configured?.selectionMode === 'BYOK' ? '使用自己的 API' : configured?.selectionMode === 'PLATFORM_MANAGED' ? '平台托管偏好' : '自动选择'}</span></button>;
      })}</div>
      <div className="qf-provider-detail mt24"><h3>{providerKinds.find((item) => item[0] === kind)?.[2]} · 配置</h3><p className="small muted mt8">平台托管偏好不保证服务端已有可用 Provider；实际可用性以生成报价与路由结果为准。</p>
        <form className="qf-provider-form mt24" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}><label className="label">选择方式<select className="field select" value={mode} disabled={!canManage} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="AUTOMATIC">自动选择</option><option value="PLATFORM_MANAGED">平台托管</option><option value="BYOK">使用自己的 API</option></select></label><label className="label">当前连接<select className="field select" value={connectionId} disabled={!canManage || mode !== 'BYOK'} onChange={(event) => setConnectionId(event.target.value)}><option value="">选择有效连接</option>{matching.filter((entry) => entry.status === 'ACTIVE').map((entry) => <option value={entry.id} key={entry.id}>{entry.label} · {entry.maskedToken}</option>)}</select></label><div className="qf-span-2 qf-settings-actions"><button type="submit" className="btn primary small" disabled={!canManage || save.isPending || (mode === 'BYOK' && !connectionId)}>保存路由偏好</button></div></form>
        {matching.length ? <div className="mt24"><h4>已登记连接</h4>{matching.map((entry: ProviderConnection) => <div className="settings-row" key={entry.id}><div><strong>{entry.label}</strong><p>{entry.providerId} · {entry.maskedToken} · {entry.status}</p></div><button type="button" className="btn small" disabled={!canManage || test.isPending || entry.status !== 'ACTIVE'} onClick={() => test.mutate(entry.id)}>检测连接</button></div>)}</div> : <p className="small muted mt24">这个类别还没有 BYOK 连接。</p>}
        <hr className="divider" /><h4>添加自己的 API 连接</h4><p className="small muted mt8">密钥仅在提交时发送到后端加密保存，本页不回显。</p><form className="qf-provider-form mt16" autoComplete="off" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><label className="label">Provider ID<input className="field" value={providerId} disabled={!canManage} onChange={(event) => setProviderId(event.target.value)} required maxLength={100} placeholder="与 Provider Catalog 一致" /></label><label className="label">连接名称<input className="field" value={label} disabled={!canManage} onChange={(event) => setLabel(event.target.value)} required maxLength={200} placeholder="供工作区识别" /></label><label className="label qf-span-2">API Key / Token<input className="field qf-secret" type="password" value={secret} disabled={!canManage} onChange={(event) => setSecret(event.target.value)} required minLength={8} maxLength={4096} autoComplete="new-password" /></label><div className="qf-span-2"><button type="submit" className="btn small" disabled={!canManage || create.isPending}>安全保存连接</button></div></form>
      </div>
    </>}
    {message ? <p role="status" className="notice green mt16">{message}</p> : null}{error ? <p role="alert" className="notice amber mt16">{describeError(error).message}</p> : null}
  </section><section className="panel pad mt24"><h3>费用保护</h3><p className="small muted mt8">付费生成由服务端报价与预算闸门保护，相关设置见“用量与预算”。</p><div className="notice mt16">真实密钥只提交到受保护的后端，页面仅显示掩码。</div></section></div>;
}

function BudgetSettings({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
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
      if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(perJob) || perJob < 0) throw new Error('预算需要非负整数 Credits');
      return client.billing.setBudget(workspaceId, { period, limitCredits: limit, perJobMaxCredits: perJob });
    },
    onSuccess: () => { setMessage('预算已更新'); void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'billing-status'] }); },
  });
  return <div className="qf-settings-content"><section className="panel pad"><h3>用量与预算</h3><p className="small muted mt8">余额和用量读取自服务端。0 Credits 的预算设置表示不限制。</p>{billing.isPending ? <StateBlock variant="loading" title="正在读取用量" /> : billing.isError ? <StateBlock variant="error" title="用量读取失败" description={describeError(billing.error).message} action={{ label: '重试', onClick: () => void billing.refetch() }} /> : <><div className="qf-metric-row mt24"><div><span className="small muted">可用余额</span><h2>{billing.data?.balanceCredits ?? 0} Credits</h2></div><div><span className="small muted">本期已用</span><h2>{billing.data?.usage.spentCredits ?? 0}</h2></div><div><span className="small muted">已预留</span><h2>{billing.data?.usage.reservedCredits ?? 0}</h2></div></div><form className="mt32" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}><div className="qf-budget-fields"><label className="label">预算周期<select className="field select" value={period} disabled={!canManage} onChange={(event) => setPeriod(event.target.value as typeof period)}><option value="MONTHLY">每月</option><option value="DAILY">每日</option></select></label><label className="label">周期上限（Credits）<input className="field" type="number" min="0" step="1" value={limitCredits} disabled={!canManage} onChange={(event) => setLimitCredits(event.target.value)} /></label><label className="label">单任务上限（Credits）<input className="field" type="number" min="0" step="1" value={perJobMaxCredits} disabled={!canManage} onChange={(event) => setPerJobMaxCredits(event.target.value)} /></label></div><button type="submit" className="btn primary small mt24" disabled={!canManage || save.isPending}>保存预算</button></form><Link className="textbtn mt24" href={'/w/' + workspaceId + '/billing'}>查看账单和明细 →</Link></>}{message ? <p role="status" className="notice green mt16">{message}</p> : null}{save.isError ? <p role="alert" className="notice amber mt16">{describeError(save.error).message}</p> : null}</section></div>;
}

function WorkspaceDetails({ workspaceId, privacyOnly }: { workspaceId: string; privacyOnly: boolean }) {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ['workspaces', workspaceId, 'details'], queryFn: () => client.workspaces.get(workspaceId) });
  const [name, setName] = useState('');
  const [privacyTier, setPrivacyTier] = useState<PrivacyTier>('STANDARD');
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { setName(workspace.data?.name ?? ''); setPrivacyTier(workspace.data?.privacyTier ?? 'STANDARD'); }, [workspace.data?.name, workspace.data?.privacyTier]);
  const canManage = workspace.data?.role === 'OWNER' || workspace.data?.role === 'ADMIN';
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'details'] });
  const saveName = useMutation({ mutationFn: () => client.workspaces.update(workspaceId, { name: name.trim() }), onSuccess: () => { setMessage('工作区名称已保存'); refresh(); } });
  const savePrivacy = useMutation({ mutationFn: () => client.workspaces.setPrivacyTier(workspaceId, { privacyTier }), onSuccess: () => { setMessage('隐私档位已保存'); refresh(); } });
  return <div className="qf-settings-content"><section className="panel pad"><h3>{privacyOnly ? '安全与隐私' : '工作区与成员'}</h3>{workspace.isPending ? <StateBlock variant="loading" title="正在读取工作区" /> : workspace.isError ? <StateBlock variant="error" title="工作区读取失败" description={describeError(workspace.error).message} action={{ label: '重试', onClick: () => void workspace.refetch() }} /> : privacyOnly ? <><p className="small muted mt8">隐私档位由服务端权益校验；变更不会静默改写历史内容。</p><form className="mt24" onSubmit={(event) => { event.preventDefault(); savePrivacy.mutate(); }}><label className="label">当前隐私档位<select className="field select" value={privacyTier} disabled={!canManage} onChange={(event) => setPrivacyTier(event.target.value as PrivacyTier)}><option value="STANDARD">Standard</option><option value="PRIVATE">Private</option><option value="ENTERPRISE">Enterprise</option></select></label><button type="submit" className="btn primary small mt16" disabled={!canManage || savePrivacy.isPending}>保存隐私档位</button></form><div className="notice mt24">Private 和 Enterprise 需要对应套餐权益。成员权限与素材访问始终由服务端执行。</div><Link className="textbtn mt24" href={'/w/' + workspaceId + '/team'}>查看团队与隐私详情 →</Link></> : <><p className="small muted mt8">当前角色：{workspace.data?.role}。成员与邀请通过团队页管理。</p><form className="mt24" onSubmit={(event) => { event.preventDefault(); saveName.mutate(); }}><label className="label">工作区名称<input className="field" value={name} maxLength={80} disabled={!canManage} onChange={(event) => setName(event.target.value)} /></label><button type="submit" className="btn primary small mt16" disabled={!canManage || saveName.isPending || !name.trim()}>保存名称</button></form><div className="settings-row mt24"><div><h4>成员与邀请</h4><p>角色、席位与邀请在团队页以真实成员记录展示</p></div><Link className="btn small" href={'/w/' + workspaceId + '/team'}>管理团队</Link></div></>}{message ? <p role="status" className="notice green mt16">{message}</p> : null}{saveName.isError || savePrivacy.isError ? <p role="alert" className="notice amber mt16">{describeError(saveName.error ?? savePrivacy.error).message}</p> : null}</section></div>;
}

function FeatureSettings({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const features = useQuery({ queryKey: ['workspaces', workspaceId, 'features'], queryFn: () => client.workspaces.features(workspaceId) });
  const update = useMutation({
    mutationFn: (input: { feature: WorkspaceFeature; enabled: boolean }) => client.workspaces.setFeature(workspaceId, input.feature.key, input.enabled),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'features'] }),
  });
  return <div className="qf-settings-content"><section className="panel pad"><h3>v0.4 新能力</h3><p className="small muted mt8">工作区可以提前选择需要的能力。服务端发布门通过前只保留读取，选择不会触发生成、扣费或改写旧项目。</p>
    {features.isPending ? <StateBlock variant="loading" title="正在读取能力状态" /> : features.isError ? <StateBlock variant="error" title="能力状态读取失败" description={describeError(features.error).message} action={{ label: '重试', onClick: () => void features.refetch() }} /> : <div className="mt24">{features.data?.map((feature) => <div className="settings-row" key={feature.key}><div><div className="row"><h4>{feature.label}</h4><span className={'badge' + (feature.effectiveState === 'ENABLED' ? ' green' : '')}>{feature.effectiveState === 'ENABLED' ? '已启用' : feature.effectiveState === 'READ_ONLY' ? '等待发布门' : '未选择'}</span></div><p>{feature.description}</p><p className="small muted">发布门 {feature.releaseGate} · {feature.platforms.join(' / ')} · 需{capabilityLevelLabel[feature.minimumCapabilityLevel]}</p></div><button type="button" className="btn small qf-feature-action" disabled={!canManage || update.isPending} aria-pressed={feature.requestedEnabled} onClick={() => update.mutate({ feature, enabled: !feature.requestedEnabled })}>{feature.requestedEnabled ? '取消选择' : '选择此能力'}</button></div>)}</div>}
    {update.isError ? <p role="alert" className="notice amber mt16">{describeError(update.error).message}</p> : null}
    <div className="notice mt24">功能开关只控制新增写入和收费入口；历史项目、版本与素材不会因关闭开关被删除。</div>
  </section></div>;
}

function AppearanceSettings() {
  const { accountAppearanceMode, deviceOverride, appearancePending, appearanceError, refetchAppearance, setAccountAppearance, setDeviceOverride } = useWorkspaceSelection();
  const save = useMutation({ mutationFn: setAccountAppearance });
  return <section className="panel pad qf-settings-content">
    <h3>外观与偏好</h3><p className="small muted mt8">外观只影响工作台界面，不改变素材或作品画面。</p>
    {appearanceError ? <StateBlock variant="error" title="账号外观读取失败" description="账号默认外观暂不可修改；本机外观仍可切换。" action={{ label: '重试', onClick: refetchAppearance }} /> : null}
    <div className="settings-row mt24"><div><h4>账号默认外观</h4><p>在设备之间同步选择。跟随系统只同步这一选择，每台设备仍按自己的系统外观显示。</p></div><label className="label">账号外观<select className="field select" value={accountAppearanceMode} disabled={appearancePending || appearanceError || save.isPending} onChange={(event) => save.mutate(event.target.value as typeof accountAppearanceMode)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label></div>
    <div className="settings-row"><div><h4>当前设备覆盖</h4><p>可只在这台设备使用不同外观；“使用账号设置”会清除设备覆盖。</p></div><label className="label">设备外观<select className="field select" value={deviceOverride ?? 'inherit'} onChange={(event) => setDeviceOverride(event.target.value === 'inherit' ? null : event.target.value as typeof accountAppearanceMode)}><option value="inherit">使用账号设置</option><option value="system">跟随本机系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label></div>
    {save.isError ? <p role="alert" className="notice amber mt16">{describeError(save.error).message}</p> : null}
    <div className="settings-row"><div><h4>设计规范</h4><p>查看颜色、字号、组件状态与操作层级。</p></div><Link className="btn small" href="/design-system">查看设计系统</Link></div>
  </section>;
}

export function WorkspaceSettings({ workspaceId }: { workspaceId: string }) {
  const [tab, setTab] = useState<SettingsTab>('模型与连接');
  const client = useAncsClient();
  const workspace = useQuery({ queryKey: ['workspaces', workspaceId, 'details'], queryFn: () => client.workspaces.get(workspaceId) });
  const canManage = workspace.data?.role === 'OWNER' || workspace.data?.role === 'ADMIN';
  return <main className="page narrow qf-workspace-page"><div className="page-head"><h1>保持掌控，也保持简单。</h1><p>默认设置服务于创作，技术细节按需展开。</p></div><div className="settings-layout mt32"><aside className="setting-nav qf-setting-nav" aria-label="设置分类">{tabs.map((item) => <button key={item} type="button" className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{item}</button>)}</aside>
    {tab === '模型与连接' ? <ProviderSettings workspaceId={workspaceId} canManage={canManage} /> : tab === '用量与预算' ? <BudgetSettings workspaceId={workspaceId} canManage={canManage} /> : tab === '新能力' ? <FeatureSettings workspaceId={workspaceId} canManage={canManage} /> : tab === '工作区与成员' ? <WorkspaceDetails workspaceId={workspaceId} privacyOnly={false} /> : tab === '安全与隐私' ? <WorkspaceDetails workspaceId={workspaceId} privacyOnly /> : <AppearanceSettings />}
  </div></main>;
}
