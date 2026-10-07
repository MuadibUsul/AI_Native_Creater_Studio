'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_SPEECH_PROFILE, DEFAULT_THEME_TOKENS } from '@ancs/contracts';
import type { CreatorIdentity, SpeechProfile, VoiceClone } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { StateBlock } from '@/ui/StateBlock';
import { useDeliveryDialog } from './delivery-dialog';
import './workspace.css';

const voiceActions = {
  refresh: { label: '查询训练进度', description: '向供应商查询现有训练任务；任务就绪后，服务端会将声音绑定到当前身份。此操作不会重新提交训练。', success: '训练状态已更新' },
  retire: { label: '本地退休', description: '停止将该声音作为当前身份的可用声音，保留历史引用与供应商侧声音。此操作不会撤销授权或删除样本。', success: '声音已在本地退休，供应商侧声音保留' },
  unlink: { label: '平台解绑', description: '清除当前身份的声音关联，保留克隆记录、历史引用和供应商侧声音。此操作不会撤销授权或删除样本。', success: '身份的声音关联已解除，供应商侧声音保留' },
} as const;
type VoiceAction = keyof typeof voiceActions;
type VoiceConfirmation = { action: VoiceAction; identityId: string; identityName: string; cloneId: string; status: VoiceClone['status'] };

function allowsVoiceAction(clone: VoiceClone, action: VoiceAction) {
  if (action === 'refresh') return (clone.status === 'SUBMITTED' || clone.status === 'TRAINING') && clone.providerJobId !== null;
  if (action === 'retire') return clone.status === 'READY' || clone.status === 'FAILED' || clone.status === 'DRAFT';
  return (clone.status === 'READY' || clone.status === 'RETIRED' || clone.status === 'FAILED') && clone.providerVoiceId !== null;
}

export function WorkspaceIdentity({ workspaceId }: { workspaceId: string }) {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ['workspaces', workspaceId, 'details'], queryFn: () => client.workspaces.get(workspaceId) });
  const canEdit = workspace.data?.role === 'OWNER' || workspace.data?.role === 'ADMIN' || workspace.data?.role === 'EDITOR';
  const identities = useQuery({ queryKey: ['workspaces', workspaceId, 'creator-identities'], queryFn: () => client.creatorIdentities.list(workspaceId) });
  const profiles = useQuery({ queryKey: ['workspaces', workspaceId, 'speech-profiles'], queryFn: () => client.speechProfiles.list(workspaceId) });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const identity = selectedId === '__new__' ? null : identities.data?.find((item) => item.id === selectedId) ?? identities.data?.[0] ?? null;
  const [name, setName] = useState('');
  const [brandName, setBrandName] = useState('');
  const [brandAccent, setBrandAccent] = useState(DEFAULT_THEME_TOKENS.color.accent);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const profile = selectedProfileId === '__new__' ? null : profiles.data?.find((item) => item.id === selectedProfileId) ??
    profiles.data?.find((item) => item.id === identity?.voiceIdentity?.defaultSpeechProfileId) ?? profiles.data?.[0] ?? null;
  const [profileName, setProfileName] = useState('');
  const [speed, setSpeed] = useState('1');
  const [tone, setTone] = useState('');
  const [dictionary, setDictionary] = useState('');
  const [showConsent, setShowConsent] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [subjectType, setSubjectType] = useState<'SELF' | 'AUTHORIZED_OTHER'>('SELF');
  const [sampleAssetId, setSampleAssetId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [voiceConfirmation, setVoiceConfirmation] = useState<VoiceConfirmation | null>(null);

  useEffect(() => {
    setName(identity?.displayName ?? '');
    setBrandName(identity?.brandIdentity?.name ?? '');
    setBrandAccent(identity?.brandIdentity?.themeTokens.color.accent ?? DEFAULT_THEME_TOKENS.color.accent);
  }, [identity?.id, identity?.displayName, identity?.brandIdentity]);
  useEffect(() => {
    setProfileName(profile?.name ?? '');
    setSpeed(String(profile?.latest.fields.defaultSpeed ?? 1));
    setTone(profile?.latest.fields.tone ?? '');
    setDictionary(profile?.latest.fields.pronunciationDictionary.map((entry) => entry.term + '=' + entry.reading).join('\n') ?? '');
  }, [profile?.id, profile?.latest]);

  const voice = useQuery({
    queryKey: ['workspaces', workspaceId, 'voice-clone', identity?.id],
    enabled: identity !== null,
    queryFn: () => client.voiceClone.state(workspaceId, identity?.id ?? ''),
  });
  const consentStatement = useQuery({
    queryKey: ['workspaces', workspaceId, 'voice-consent-statement', identity?.id],
    enabled: identity !== null && showConsent,
    queryFn: () => client.voiceClone.consentStatement(workspaceId, identity?.id ?? ''),
  });
  const audioAssets = useQuery({
    queryKey: ['workspaces', workspaceId, 'audio-assets'],
    enabled: identity !== null && showConsent,
    queryFn: () => client.assets.list(workspaceId, { assetType: 'VOICE_AUDIO' }),
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'creator-identities'] });
    void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'speech-profiles'] });
    void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'voice-clone'] });
  };
  const saveIdentity = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('请填写身份名称');
      return identity === null ? client.creatorIdentities.create(workspaceId, { displayName: trimmed }) :
        client.creatorIdentities.update(workspaceId, identity.id, { displayName: trimmed });
    },
    onSuccess: (result) => { setSelectedId(result.id); setMessage('身份已保存'); invalidate(); },
  });
  const saveBrand = useMutation({
    mutationFn: async () => {
      if (identity === null) throw new Error('请先创建身份');
      if (!brandName.trim()) throw new Error('请填写品牌名称');
      const base = identity.brandIdentity?.themeTokens ?? DEFAULT_THEME_TOKENS;
      return client.creatorIdentities.update(workspaceId, identity.id, {
        brandIdentity: { name: brandName.trim(), themeTokens: { ...base, color: { ...base.color, accent: brandAccent } } },
      });
    },
    onSuccess: () => { setMessage('品牌已保存'); invalidate(); },
  });
  const saveProfile = useMutation({
    mutationFn: async () => {
      const parsedSpeed = Number(speed);
      if (!Number.isFinite(parsedSpeed) || parsedSpeed < 0.5 || parsedSpeed > 2) throw new Error('语速须在 0.5 至 2.0 之间');
      if (!tone.trim()) throw new Error('请填写语气');
      const entries = dictionary.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const separator = line.indexOf('=');
        if (separator <= 0 || separator === line.length - 1) throw new Error('读音词典每行应为“术语=读音”');
        return { term: line.slice(0, separator).trim(), reading: line.slice(separator + 1).trim() };
      });
      const fields = { ...(profile?.latest.fields ?? DEFAULT_SPEECH_PROFILE), defaultSpeed: parsedSpeed, tone: tone.trim(), pronunciationDictionary: entries };
      return profile === null ? client.speechProfiles.create(workspaceId, { name: profileName.trim() || '旁白风格', fields }) :
        client.speechProfiles.update(workspaceId, profile.id, { name: profileName.trim() || profile.name, fields });
    },
    onSuccess: (saved) => { setSelectedProfileId(saved.id); setMessage('表达风格已保存'); invalidate(); },
  });
  const selectProfile = useMutation({
    mutationFn: async (chosen: SpeechProfile) => {
      const current: CreatorIdentity['voiceIdentity'] = identity?.voiceIdentity ?? null;
      if (identity === null || current === null) throw new Error('当前身份尚未绑定声音，无法设置默认表达风格');
      return client.creatorIdentities.update(workspaceId, identity.id, {
        voiceIdentity: {
          provider: current.provider, providerVoiceId: current.providerVoiceId, cloneType: current.cloneType,
          ownershipType: current.ownershipType, verificationStatus: current.verificationStatus,
          managedMode: current.managedMode, languageProfile: current.languageProfile,
          defaultSpeechProfileId: chosen.id, status: current.status,
        },
      });
    },
    onSuccess: () => { setMessage('默认表达风格已更新'); invalidate(); },
  });
  const confirmConsent = useMutation({
    mutationFn: () => client.voiceClone.confirmConsent(workspaceId, identity?.id ?? '', { subjectType }),
    onSuccess: () => { setConsentChecked(false); setMessage('授权记录已保存'); invalidate(); },
  });
  const revokeConsent = useMutation({
    mutationFn: () => client.voiceClone.revokeConsent(workspaceId, identity?.id ?? ''),
    onSuccess: () => { setMessage('授权已撤销'); invalidate(); },
  });
  const addSample = useMutation({
    mutationFn: () => {
      const asset = audioAssets.data?.find((item) => item.id === sampleAssetId);
      if (asset?.currentVersionId == null) throw new Error('请选择已完成上传的音频素材');
      return client.voiceClone.addSample(workspaceId, identity?.id ?? '', { assetId: asset.id, assetVersionId: asset.currentVersionId });
    },
    onSuccess: () => { setSampleAssetId(''); setMessage('样本已提交音质检测'); invalidate(); },
  });
  const voiceAction = useMutation({
    mutationFn: async (confirmation: VoiceConfirmation) => {
      if (!canEdit || confirmation.identityId !== identity?.id) throw new Error('当前身份或编辑权限已变化，请关闭后重新检查。');
      const current = await client.voiceClone.state(workspaceId, confirmation.identityId);
      if (current.clone?.id !== confirmation.cloneId || current.clone.status !== confirmation.status || !allowsVoiceAction(current.clone, confirmation.action)) {
        invalidate();
        throw new Error('声音状态已变化，请关闭后刷新状态再确认。');
      }
      return client.voiceClone[confirmation.action](workspaceId, confirmation.identityId);
    },
    onSuccess: (_result, confirmation) => { setVoiceConfirmation(null); setMessage(voiceActions[confirmation.action].success); invalidate(); },
    retry: false,
  });
  const closeVoiceConfirmation = () => { if (!voiceAction.isPending) setVoiceConfirmation(null); };
  const voiceDialog = useDeliveryDialog(voiceConfirmation !== null, closeVoiceConfirmation);
  const error = [saveIdentity, saveBrand, saveProfile, selectProfile, confirmConsent, revokeConsent, addSample].find((item) => item.isError)?.error;
  const speak = () => {
    if (!('speechSynthesis' in window)) { setMessage('此浏览器不支持系统语音试听'); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance('一篇好文章，一部好作品。');
    utterance.lang = 'zh-CN';
    window.speechSynthesis.speak(utterance);
  };

  return <div className="page narrow qf-workspace-page">
    <div className="sectionhead"><div><div className="eyebrow mb16">A VOICE THAT FEELS LIKE YOU</div><h1>让每部作品，都有你的辨识度。</h1><p>声音、表达与品牌，成为可以复用的创作者身份。</p></div>
      <button type="submit" form="identity-form" disabled={!canEdit || saveIdentity.isPending || identities.isPending} className="btn primary">保存身份</button></div>
    {workspace.isError ? <p role="alert" className="notice amber mt16">无法确认当前角色，编辑操作已停用。{describeError(workspace.error).message}</p> : !workspace.isPending && !canEdit ? <p className="notice mt16">当前角色可查看身份；编辑需要工作区编辑权限。</p> : null}
    {message ? <p role="status" className="notice green mt16">{message}</p> : null}
    {error ? <p role="alert" className="notice amber mt16">{describeError(error).message}</p> : null}
    {identities.isError ? <StateBlock variant="error" title="身份读取失败" description={describeError(identities.error).message} action={{ label: '重试', onClick: () => void identities.refetch() }} /> : null}
    <form id="identity-form" className="qf-identity-form mt24" onSubmit={(event) => { event.preventDefault(); saveIdentity.mutate(); }}>
    {identities.data?.length ? <label className="label">当前身份<select className="field select" value={identity?.id ?? '__new__'} disabled={voiceConfirmation !== null} onChange={(event) => { setSelectedId(event.target.value); setMessage(null); setConsentChecked(false); setSampleAssetId(''); }}><option value="__new__">新建身份</option>{identities.data.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label> : null}
      <label className="label">身份名称<input className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="填写你的创作者身份名称" maxLength={80} /></label>
      {identity ? <span className="small muted">身份 {identity.id} · 更新于 {new Date(identity.updatedAt).toLocaleDateString('zh-CN')}</span> : <span className="small muted">先创建身份，再配置声音、表达和品牌。</span>}
    </form>
    {identity ? <div className="identity-grid mt32">
      <section className="panel qf-voice-panel">
        <div className="voice-hero"><div className="row between"><h3>你的旁白声音</h3><span className="badge green">{identity.voiceIdentity?.status === 'ACTIVE' ? '已绑定' : '尚未绑定'}</span></div><div className="voice-sphere" aria-hidden="true" /><div className="row between"><div><h2>{identity.voiceIdentity?.provider ?? '系统声音示意'}</h2><p className="small muted mt8">{identity.voiceIdentity?.languageProfile ?? '尚无已授权的专属声音'}</p></div><button type="button" className="btn icononly primary" aria-label="试听系统示例声音" onClick={speak}>▶</button></div><p className="sample-note mt24">试听使用浏览器系统语音，不代表供应商或克隆音质。</p></div>
        {profiles.isPending ? <p className="small muted qf-voice-note">正在读取表达风格…</p> : profiles.isError ? <p className="qf-voice-note">表达风格读取失败。<button type="button" className="textbtn" onClick={() => void profiles.refetch()}>重试</button></p> : profiles.data?.map((item) => <div className={'voice-row' + (identity.voiceIdentity?.defaultSpeechProfileId === item.id ? ' selected' : '')} key={item.id}><span className="voice-avatar">{item.name.slice(0, 1)}</span><div className="grow"><h4>{item.name}</h4><p>{item.latest.fields.tone} · {item.latest.fields.defaultSpeed}× 语速</p></div><button type="button" className="btn small" disabled={!canEdit || selectProfile.isPending || !identity.voiceIdentity} onClick={() => { setSelectedProfileId(item.id); selectProfile.mutate(item); }}>{identity.voiceIdentity?.defaultSpeechProfileId === item.id ? '已选用' : '选用'}</button></div>)}
        <button type="button" className="voice-row qf-voice-action" onClick={() => setShowConsent((value) => !value)} aria-expanded={showConsent}><span className="voice-avatar">＋</span><span className="grow"><strong>{voice.data?.clone ? '管理我的声音' : '创建我的声音'}</strong><small>{voice.data?.clone ? '查看授权、样本与生命周期' : '先完成授权，再上传样本'}</small></span><span>→</span></button>
      </section>
      <div className="col">
        <section className="panel pad"><div className="row between"><h3>表达风格</h3><span>文</span></div>
          <label className="label mt24">当前风格<select className="field select" value={profile?.id ?? '__new__'} onChange={(event) => setSelectedProfileId(event.target.value)}><option value="__new__">新建表达风格</option>{profiles.data?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <form onSubmit={(event) => { event.preventDefault(); saveProfile.mutate(); }}><label className="label mt16">风格名称<input className="field" value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={80} /></label><div className="settings-row"><div><h4>语速</h4><p>为理解留下必要停顿</p></div><input aria-label="旁白语速" className="field qf-short-field" type="number" min="0.5" max="2" step="0.1" value={speed} onChange={(event) => setSpeed(event.target.value)} /></div><div className="settings-row"><div><h4>语气</h4><p>与你的内容保持一致</p></div><input aria-label="旁白语气" className="field qf-short-field" value={tone} onChange={(event) => setTone(event.target.value)} /></div><label className="label mt24">专有名词与读音<textarea className="field" rows={3} placeholder="每行：术语=读音" value={dictionary} onChange={(event) => setDictionary(event.target.value)} /></label><button type="submit" disabled={!canEdit || saveProfile.isPending} className="btn small mt16">保存表达风格</button></form>
        </section>
        <section className="panel pad"><div className="row between"><h3>品牌外观</h3><span>▱</span></div><div className="row mt24"><span className="logomark">C</span><div className="grow"><strong>{identity.brandIdentity?.name ?? '尚未设置品牌'}</strong><p className="small muted mt8">片头 / 片尾 / 字幕</p></div><span className="small muted">版本 {identity.brandIdentity?.version ?? '—'}</span></div><form onSubmit={(event) => { event.preventDefault(); saveBrand.mutate(); }}><label className="label mt24">品牌名称<input className="field" value={brandName} onChange={(event) => setBrandName(event.target.value)} maxLength={80} /></label><label className="label mt16">品牌强调色<input aria-label="品牌强调色" type="color" value={brandAccent} onChange={(event) => setBrandAccent(event.target.value)} /></label><button type="submit" disabled={!canEdit || saveBrand.isPending} className="btn small mt16">保存品牌</button></form></section>
        <div className="notice">声音克隆与数字人需要可核验的本人授权。未授权时，服务端不会接受克隆任务。</div>
      </div>
    </div> : null}
    {identity && showConsent ? <section className="panel pad mt24 qf-consent"><h2>声音授权与样本</h2><p className="small muted mt8">授权、样本与克隆状态分别保存；授权可以撤销。</p>
      {voice.isPending ? <p className="mt16">正在读取状态…</p> : voice.isError ? <p role="alert" className="qf-error mt16">状态读取失败：{describeError(voice.error).message}<button type="button" className="textbtn" onClick={() => void voice.refetch()}>重试</button></p> : <div className="qf-consent-grid mt24"><div><h3>授权</h3><p className="small muted mt8">{voice.data?.consent?.revokedAt ? '授权已撤销' : voice.data?.consent ? '已授权 · ' + voice.data.consent.statementVersion : '尚未授权'}</p>{consentStatement.isPending ? <p className="small muted mt16">正在读取授权声明…</p> : consentStatement.isError ? <p className="qf-error mt16">授权声明暂不可用；不能确认授权。</p> : <p className="qf-statement mt16">{consentStatement.data?.statement}</p>}{voice.data?.consent && !voice.data.consent.revokedAt ? <button type="button" className="btn small mt16" disabled={!canEdit || revokeConsent.isPending} onClick={() => revokeConsent.mutate()}>撤销授权</button> : <><label className="label mt16">授权主体<select className="field select" value={subjectType} onChange={(event) => setSubjectType(event.target.value as 'SELF' | 'AUTHORIZED_OTHER')}><option value="SELF">本人</option><option value="AUTHORIZED_OTHER">已获他人授权</option></select></label><label className="checkboxrow mt16"><input type="checkbox" checked={consentChecked} onChange={(event) => setConsentChecked(event.target.checked)} />我已阅读并同意当前版本的授权声明</label><button type="button" className="btn small mt16" disabled={!canEdit || !consentChecked || consentStatement.data == null || confirmConsent.isPending} onClick={() => confirmConsent.mutate()}>确认授权</button></>}</div>
      <div><h3>音频样本</h3><p className="small muted mt8">先在素材库上传音频，选择 READY 版本做质量检测。</p>{voice.data?.samples.length ? voice.data.samples.map((sample) => <div className="settings-row" key={sample.id}><span>{sample.assetId.slice(0, 12)}…</span><span className={'badge ' + (sample.quality.verdict === 'PASS' ? 'green' : 'amber')}>{sample.quality.verdict} · {sample.quality.durationMs == null ? '时长未知' : Math.round(sample.quality.durationMs / 1000) + ' 秒'}</span></div>) : <p className="small muted mt16">还没有声音样本。</p>}<label className="label mt16">选择音频素材<select className="field select" value={sampleAssetId} onChange={(event) => setSampleAssetId(event.target.value)}><option value="">选择已上传音频</option>{audioAssets.data?.filter((asset) => asset.status === 'READY' && asset.currentVersionId).map((asset) => <option key={asset.id} value={asset.id}>{asset.id}</option>)}</select></label><button type="button" className="btn small mt16" disabled={!canEdit || !sampleAssetId || addSample.isPending} onClick={() => addSample.mutate()}>检测并添加样本</button></div>
      <div><div className="row between"><h3>克隆状态</h3><button type="button" className="textbtn small" disabled={voice.isFetching || voiceAction.isPending} onClick={() => { setMessage(null); void voice.refetch(); }}>{voice.isFetching ? '读取中…' : '刷新状态'}</button></div><p className="small muted mt8">{voice.data?.clone ? voice.data.clone.status + ' · ' + voice.data.clone.provider : '尚未提交克隆'}</p>
        {voice.data?.clone ? <><p className="small muted mt8">{voice.data.boundToIdentity ? '已绑定到当前身份' : '未绑定到当前身份'} · 更新于 {new Date(voice.data.clone.updatedAt).toLocaleString('zh-CN')}</p>
          {voice.data.clone.failure ? <p className="notice amber mt16">训练失败：{voice.data.clone.failure.message}。重新训练需要新的费用与授权检查。</p> : null}
          <div className="row mt16" style={{ flexWrap: 'wrap' }}>{canEdit ? (Object.keys(voiceActions) as VoiceAction[]).filter((action) => voice.data?.clone && allowsVoiceAction(voice.data.clone, action)).map((action) => <button key={action} type="button" className="btn small" disabled={voice.isFetching || voiceAction.isPending} onClick={(event) => {
            const clone = voice.data?.clone;
            if (!clone) return;
            voiceAction.reset(); setMessage(null); voiceDialog.triggerRef.current = event.currentTarget;
            setVoiceConfirmation({ action, identityId: identity.id, identityName: identity.displayName, cloneId: clone.id, status: clone.status });
          }}>{voiceActions[action].label}</button>) : null}</div>
          {voice.data.clone.status === 'SUBMITTED' || voice.data.clone.status === 'TRAINING' ? <p className="small muted mt16">训练进行中。请先查询训练进度；当前界面不在训练中执行退休或解绑。</p> : null}
          {voice.data.clone.retiredAt ? <p className="small muted mt8">本地退休：{new Date(voice.data.clone.retiredAt).toLocaleString('zh-CN')}</p> : null}
          {voice.data.clone.unlinkedAt ? <p className="small muted mt8">平台解绑：{new Date(voice.data.clone.unlinkedAt).toLocaleString('zh-CN')}</p> : null}
          {voice.data.clone.providerDeletedAt ? <p className="small muted mt8">供应商侧删除：{new Date(voice.data.clone.providerDeletedAt).toLocaleString('zh-CN')}</p> : <p className="small muted mt16">供应商侧删除尚不可用：服务端需要先核验目标供应商、连接归属与声音版本。退休和解绑会保留供应商侧声音。</p>}
        </> : null}
        <p className="small muted mt16">正式训练可能产生费用。当前页面不在缺少费用估算和 Provider 确认时提交或重试训练任务。</p></div></div>}
    </section> : null}
    {voiceConfirmation ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeVoiceConfirmation(); }}><div ref={voiceDialog.dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="voice-action-title" aria-describedby="voice-action-description">
      <h2 id="voice-action-title">确认{voiceActions[voiceConfirmation.action].label}</h2>
      <p className="small muted mt16">身份：{voiceConfirmation.identityName} · 当前状态：{voiceConfirmation.status}</p>
      <p id="voice-action-description" className="mt16">{voiceActions[voiceConfirmation.action].description}</p>
      {voiceAction.isError ? <p role="alert" className="notice amber mt16">操作未完成：{describeError(voiceAction.error).message}</p> : null}
      <div className="row mt24" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" disabled={voiceAction.isPending} onClick={closeVoiceConfirmation}>取消</button><button type="button" className="btn primary" disabled={!canEdit || voiceAction.isPending} onClick={() => voiceAction.mutate(voiceConfirmation)}>{voiceAction.isPending ? '处理中…' : '确认' + voiceActions[voiceConfirmation.action].label}</button></div>
    </div></div> : null}
  </div>;
}
