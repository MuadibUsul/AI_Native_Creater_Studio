'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_SPEECH_PROFILE, DEFAULT_THEME_TOKENS } from '@ancs/contracts';
import type { CreatorIdentity, SpeechProfile, VoiceClone } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { StateBlock } from '@/ui/StateBlock';
import { useDeliveryDialog } from './delivery-dialog';
import './workspace.css';

// 声音生命周期操作（按钮顺序即此数组顺序；文案见 messages.workspaceAdmin.creatorIdentity.voiceActions）
const VOICE_ACTIONS = ['refresh', 'retire', 'unlink'] as const;
type VoiceAction = (typeof VOICE_ACTIONS)[number];
type VoiceConfirmation = { action: VoiceAction; identityId: string; identityName: string; cloneId: string; status: VoiceClone['status'] };

function allowsVoiceAction(clone: VoiceClone, action: VoiceAction) {
  if (action === 'refresh') return (clone.status === 'SUBMITTED' || clone.status === 'TRAINING') && clone.providerJobId !== null;
  if (action === 'retire') return clone.status === 'READY' || clone.status === 'FAILED' || clone.status === 'DRAFT';
  return (clone.status === 'READY' || clone.status === 'RETIRED' || clone.status === 'FAILED') && clone.providerVoiceId !== null;
}

export function WorkspaceIdentity({ workspaceId }: { workspaceId: string }) {
  const { messages, locale } = useI18n();
  const t = messages.workspaceAdmin.creatorIdentity;
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
      if (!trimmed) throw new Error(t.errors.nameRequired);
      return identity === null ? client.creatorIdentities.create(workspaceId, { displayName: trimmed }) :
        client.creatorIdentities.update(workspaceId, identity.id, { displayName: trimmed });
    },
    onSuccess: (result) => { setSelectedId(result.id); setMessage(t.notices.identitySaved); invalidate(); },
  });
  const saveBrand = useMutation({
    mutationFn: async () => {
      if (identity === null) throw new Error(t.errors.identityRequired);
      if (!brandName.trim()) throw new Error(t.errors.brandNameRequired);
      const base = identity.brandIdentity?.themeTokens ?? DEFAULT_THEME_TOKENS;
      return client.creatorIdentities.update(workspaceId, identity.id, {
        brandIdentity: { name: brandName.trim(), themeTokens: { ...base, color: { ...base.color, accent: brandAccent } } },
      });
    },
    onSuccess: () => { setMessage(t.notices.brandSaved); invalidate(); },
  });
  const saveProfile = useMutation({
    mutationFn: async () => {
      const parsedSpeed = Number(speed);
      if (!Number.isFinite(parsedSpeed) || parsedSpeed < 0.5 || parsedSpeed > 2) throw new Error(t.errors.speedRange);
      if (!tone.trim()) throw new Error(t.errors.toneRequired);
      const entries = dictionary.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const separator = line.indexOf('=');
        if (separator <= 0 || separator === line.length - 1) throw new Error(t.errors.dictionaryFormat);
        return { term: line.slice(0, separator).trim(), reading: line.slice(separator + 1).trim() };
      });
      const fields = { ...(profile?.latest.fields ?? DEFAULT_SPEECH_PROFILE), defaultSpeed: parsedSpeed, tone: tone.trim(), pronunciationDictionary: entries };
      return profile === null ? client.speechProfiles.create(workspaceId, { name: profileName.trim() || t.defaultProfileName, fields }) :
        client.speechProfiles.update(workspaceId, profile.id, { name: profileName.trim() || profile.name, fields });
    },
    onSuccess: (saved) => { setSelectedProfileId(saved.id); setMessage(t.notices.profileSaved); invalidate(); },
  });
  const selectProfile = useMutation({
    mutationFn: async (chosen: SpeechProfile) => {
      const current: CreatorIdentity['voiceIdentity'] = identity?.voiceIdentity ?? null;
      if (identity === null || current === null) throw new Error(t.errors.voiceNotBound);
      return client.creatorIdentities.update(workspaceId, identity.id, {
        voiceIdentity: {
          provider: current.provider, providerVoiceId: current.providerVoiceId, cloneType: current.cloneType,
          ownershipType: current.ownershipType, verificationStatus: current.verificationStatus,
          managedMode: current.managedMode, languageProfile: current.languageProfile,
          defaultSpeechProfileId: chosen.id, status: current.status,
        },
      });
    },
    onSuccess: () => { setMessage(t.notices.defaultProfileUpdated); invalidate(); },
  });
  const confirmConsent = useMutation({
    mutationFn: () => client.voiceClone.confirmConsent(workspaceId, identity?.id ?? '', { subjectType }),
    onSuccess: () => { setConsentChecked(false); setMessage(t.notices.consentSaved); invalidate(); },
  });
  const revokeConsent = useMutation({
    mutationFn: () => client.voiceClone.revokeConsent(workspaceId, identity?.id ?? ''),
    onSuccess: () => { setMessage(t.notices.consentRevoked); invalidate(); },
  });
  const addSample = useMutation({
    mutationFn: () => {
      const asset = audioAssets.data?.find((item) => item.id === sampleAssetId);
      if (asset?.currentVersionId == null) throw new Error(t.errors.sampleRequired);
      return client.voiceClone.addSample(workspaceId, identity?.id ?? '', { assetId: asset.id, assetVersionId: asset.currentVersionId });
    },
    onSuccess: () => { setSampleAssetId(''); setMessage(t.notices.sampleSubmitted); invalidate(); },
  });
  const voiceAction = useMutation({
    mutationFn: async (confirmation: VoiceConfirmation) => {
      if (!canEdit || confirmation.identityId !== identity?.id) throw new Error(t.errors.contextChanged);
      const current = await client.voiceClone.state(workspaceId, confirmation.identityId);
      if (current.clone?.id !== confirmation.cloneId || current.clone.status !== confirmation.status || !allowsVoiceAction(current.clone, confirmation.action)) {
        invalidate();
        throw new Error(t.errors.voiceStateChanged);
      }
      return client.voiceClone[confirmation.action](workspaceId, confirmation.identityId);
    },
    onSuccess: (_result, confirmation) => { setVoiceConfirmation(null); setMessage(t.voiceActions[confirmation.action].success); invalidate(); },
    retry: false,
  });
  const closeVoiceConfirmation = () => { if (!voiceAction.isPending) setVoiceConfirmation(null); };
  const voiceDialog = useDeliveryDialog(voiceConfirmation !== null, closeVoiceConfirmation);
  const error = [saveIdentity, saveBrand, saveProfile, selectProfile, confirmConsent, revokeConsent, addSample].find((item) => item.isError)?.error;
  const speak = () => {
    if (!('speechSynthesis' in window)) { setMessage(t.previewUnsupported); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(t.previewText);
    utterance.lang = t.previewLang;
    window.speechSynthesis.speak(utterance);
  };

  return <div className="page narrow qf-workspace-page">
    <div className="sectionhead"><div><div className="eyebrow mb16">{t.eyebrow}</div><h1>{t.title}</h1><p>{t.lead}</p></div>
      <button type="submit" form="identity-form" disabled={!canEdit || saveIdentity.isPending || identities.isPending} className="btn primary">{t.saveIdentity}</button></div>
    {workspace.isError ? <p role="alert" className="notice amber mt16">{t.roleUnavailable(describeError(workspace.error).message)}</p> : !workspace.isPending && !canEdit ? <p className="notice mt16">{t.readOnly}</p> : null}
    {message ? <p role="status" className="notice green mt16">{message}</p> : null}
    {error ? <p role="alert" className="notice amber mt16">{describeError(error).message}</p> : null}
    {identities.isError ? <StateBlock variant="error" title={t.identitiesFailed} description={describeError(identities.error).message} action={{ label: messages.common.retry, onClick: () => void identities.refetch() }} /> : null}
    <form id="identity-form" className="qf-identity-form mt24" onSubmit={(event) => { event.preventDefault(); saveIdentity.mutate(); }}>
    {identities.data?.length ? <label className="label">{t.currentIdentity}<select className="field select" value={identity?.id ?? '__new__'} disabled={voiceConfirmation !== null} onChange={(event) => { setSelectedId(event.target.value); setMessage(null); setConsentChecked(false); setSampleAssetId(''); }}><option value="__new__">{t.newIdentity}</option>{identities.data.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label> : null}
      <label className="label">{t.identityName}<input className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder={t.identityNamePlaceholder} maxLength={80} /></label>
      {identity ? <span className="small muted">{t.identityMeta(identity.id, new Date(identity.updatedAt).toLocaleDateString(locale))}</span> : <span className="small muted">{t.createFirst}</span>}
    </form>
    {!identities.isPending && !identities.isError && !identity ? <section className="panel qf-identity-onboarding mt32" aria-label={t.onboardingAria}>
      {t.steps.map((step, index) => <div className="qf-identity-step" key={step.title}><span className="qf-identity-step-index">{index + 1}</span><strong>{step.title}</strong><p>{step.body}</p></div>)}
    </section> : null}
    {identity ? <div className="identity-grid mt32">
      <section className="panel qf-voice-panel">
        <div className="voice-hero"><div className="row between"><h3>{t.voiceTitle}</h3><span className="badge green">{identity.voiceIdentity?.status === 'ACTIVE' ? t.voiceBound : t.voiceUnbound}</span></div><div className="voice-sphere" aria-hidden="true" /><div className="row between"><div><h2>{identity.voiceIdentity?.provider ?? t.systemVoiceSample}</h2><p className="small muted mt8">{identity.voiceIdentity?.languageProfile ?? t.noAuthorizedVoice}</p></div><button type="button" className="btn icononly primary" aria-label={t.previewAria} onClick={speak}>▶</button></div><p className="sample-note mt24">{t.previewNote}</p></div>
        {profiles.isPending ? <p className="small muted qf-voice-note">{t.profilesLoading}</p> : profiles.isError ? <p className="qf-voice-note">{t.profilesFailed}<button type="button" className="textbtn" onClick={() => void profiles.refetch()}>{messages.common.retry}</button></p> : profiles.data?.map((item) => <div className={'voice-row' + (identity.voiceIdentity?.defaultSpeechProfileId === item.id ? ' selected' : '')} key={item.id}><span className="voice-avatar">{item.name.slice(0, 1)}</span><div className="grow"><h4>{item.name}</h4><p>{item.latest.fields.tone} · {t.speedValue(String(item.latest.fields.defaultSpeed))}</p></div><button type="button" className="btn small" disabled={!canEdit || selectProfile.isPending || !identity.voiceIdentity} onClick={() => { setSelectedProfileId(item.id); selectProfile.mutate(item); }}>{identity.voiceIdentity?.defaultSpeechProfileId === item.id ? t.selected : t.select}</button></div>)}
        <button type="button" className="voice-row qf-voice-action" onClick={() => setShowConsent((value) => !value)} aria-expanded={showConsent}><span className="voice-avatar">＋</span><span className="grow"><strong>{voice.data?.clone ? t.manageVoice : t.createVoice}</strong><small>{voice.data?.clone ? t.manageVoiceHint : t.createVoiceHint}</small></span><span>→</span></button>
      </section>
      <div className="col">
        <section className="panel pad"><div className="row between"><h3>{t.profileTitle}</h3><span>{t.profileGlyph}</span></div>
          <label className="label mt24">{t.currentProfile}<select className="field select" value={profile?.id ?? '__new__'} onChange={(event) => setSelectedProfileId(event.target.value)}><option value="__new__">{t.newProfile}</option>{profiles.data?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <form onSubmit={(event) => { event.preventDefault(); saveProfile.mutate(); }}><label className="label mt16">{t.profileName}<input className="field" value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={80} /></label><div className="settings-row"><div><h4>{t.speed}</h4><p>{t.speedHint}</p></div><input aria-label={t.speedAria} className="field qf-short-field" type="number" min="0.5" max="2" step="0.1" value={speed} onChange={(event) => setSpeed(event.target.value)} /></div><div className="settings-row"><div><h4>{t.tone}</h4><p>{t.toneHint}</p></div><input aria-label={t.toneAria} className="field qf-short-field" value={tone} onChange={(event) => setTone(event.target.value)} /></div><label className="label mt24">{t.dictionary}<textarea className="field" rows={3} placeholder={t.dictionaryPlaceholder} value={dictionary} onChange={(event) => setDictionary(event.target.value)} /></label><button type="submit" disabled={!canEdit || saveProfile.isPending} className="btn small mt16">{t.saveProfile}</button></form>
        </section>
        <section className="panel pad"><div className="row between"><h3>{t.brandTitle}</h3><span>▱</span></div><div className="row mt24"><span className="logomark">C</span><div className="grow"><strong>{identity.brandIdentity?.name ?? t.brandUnset}</strong><p className="small muted mt8">{t.brandUsage}</p></div><span className="small muted">{t.brandVersion(String(identity.brandIdentity?.version ?? '—'))}</span></div><form onSubmit={(event) => { event.preventDefault(); saveBrand.mutate(); }}><label className="label mt24">{t.brandName}<input className="field" value={brandName} onChange={(event) => setBrandName(event.target.value)} maxLength={80} /></label><label className="label mt16">{t.brandAccent}<input aria-label={t.brandAccent} type="color" value={brandAccent} onChange={(event) => setBrandAccent(event.target.value)} /></label><button type="submit" disabled={!canEdit || saveBrand.isPending} className="btn small mt16">{t.saveBrand}</button></form></section>
        <div className="notice">{t.consentNotice}</div>
      </div>
    </div> : null}
    {identity && showConsent ? <section className="panel pad mt24 qf-consent"><h2>{t.consentTitle}</h2><p className="small muted mt8">{t.consentLead}</p>
      {voice.isPending ? <p className="mt16">{t.stateLoading}</p> : voice.isError ? <p role="alert" className="qf-error mt16">{t.stateFailed(describeError(voice.error).message)}<button type="button" className="textbtn" onClick={() => void voice.refetch()}>{messages.common.retry}</button></p> : <div className="qf-consent-grid mt24"><div><h3>{t.consentHeading}</h3><p className="small muted mt8">{voice.data?.consent?.revokedAt ? t.consentRevoked : voice.data?.consent ? t.consentGranted(voice.data.consent.statementVersion) : t.consentMissing}</p>{consentStatement.isPending ? <p className="small muted mt16">{t.statementLoading}</p> : consentStatement.isError ? <p className="qf-error mt16">{t.statementUnavailable}</p> : <p className="qf-statement mt16">{consentStatement.data?.statement}</p>}{voice.data?.consent && !voice.data.consent.revokedAt ? <button type="button" className="btn small mt16" disabled={!canEdit || revokeConsent.isPending} onClick={() => revokeConsent.mutate()}>{t.revokeConsent}</button> : <><label className="label mt16">{t.subject}<select className="field select" value={subjectType} onChange={(event) => setSubjectType(event.target.value as 'SELF' | 'AUTHORIZED_OTHER')}><option value="SELF">{t.subjectSelf}</option><option value="AUTHORIZED_OTHER">{t.subjectOther}</option></select></label><label className="checkboxrow mt16"><input type="checkbox" checked={consentChecked} onChange={(event) => setConsentChecked(event.target.checked)} />{t.consentAgree}</label><button type="button" className="btn small mt16" disabled={!canEdit || !consentChecked || consentStatement.data == null || confirmConsent.isPending} onClick={() => confirmConsent.mutate()}>{t.confirmConsent}</button></>}</div>
      <div><h3>{t.samplesHeading}</h3><p className="small muted mt8">{t.samplesHint}</p>{voice.data?.samples.length ? voice.data.samples.map((sample) => <div className="settings-row" key={sample.id}><span>{sample.assetId.slice(0, 12)}…</span><span className={'badge ' + (sample.quality.verdict === 'PASS' ? 'green' : 'amber')}>{sample.quality.verdict} · {sample.quality.durationMs == null ? t.durationUnknown : t.durationSeconds(String(Math.round(sample.quality.durationMs / 1000)))}</span></div>) : <p className="small muted mt16">{t.noSamples}</p>}<label className="label mt16">{t.chooseAudio}<select className="field select" value={sampleAssetId} onChange={(event) => setSampleAssetId(event.target.value)}><option value="">{t.chooseAudioPlaceholder}</option>{audioAssets.data?.filter((asset) => asset.status === 'READY' && asset.currentVersionId).map((asset) => <option key={asset.id} value={asset.id}>{asset.id}</option>)}</select></label><button type="button" className="btn small mt16" disabled={!canEdit || !sampleAssetId || addSample.isPending} onClick={() => addSample.mutate()}>{t.addSample}</button></div>
      <div><div className="row between"><h3>{t.cloneHeading}</h3><button type="button" className="textbtn small" disabled={voice.isFetching || voiceAction.isPending} onClick={() => { setMessage(null); void voice.refetch(); }}>{voice.isFetching ? t.refreshing : t.refreshState}</button></div><p className="small muted mt8">{voice.data?.clone ? voice.data.clone.status + ' · ' + voice.data.clone.provider : t.noClone}</p>
        {voice.data?.clone ? <><p className="small muted mt8">{voice.data.boundToIdentity ? t.boundToIdentity : t.notBoundToIdentity} · {t.updatedAt(new Date(voice.data.clone.updatedAt).toLocaleString(locale))}</p>
          {voice.data.clone.failure ? <p className="notice amber mt16">{t.trainingFailed(voice.data.clone.failure.message)}</p> : null}
          <div className="row mt16" style={{ flexWrap: 'wrap' }}>{canEdit ? VOICE_ACTIONS.filter((action) => voice.data?.clone && allowsVoiceAction(voice.data.clone, action)).map((action) => <button key={action} type="button" className="btn small" disabled={voice.isFetching || voiceAction.isPending} onClick={(event) => {
            const clone = voice.data?.clone;
            if (!clone) return;
            voiceAction.reset(); setMessage(null); voiceDialog.triggerRef.current = event.currentTarget;
            setVoiceConfirmation({ action, identityId: identity.id, identityName: identity.displayName, cloneId: clone.id, status: clone.status });
          }}>{t.voiceActions[action].label}</button>) : null}</div>
          {voice.data.clone.status === 'SUBMITTED' || voice.data.clone.status === 'TRAINING' ? <p className="small muted mt16">{t.trainingInProgress}</p> : null}
          {voice.data.clone.retiredAt ? <p className="small muted mt8">{t.retiredAt(new Date(voice.data.clone.retiredAt).toLocaleString(locale))}</p> : null}
          {voice.data.clone.unlinkedAt ? <p className="small muted mt8">{t.unlinkedAt(new Date(voice.data.clone.unlinkedAt).toLocaleString(locale))}</p> : null}
          {voice.data.clone.providerDeletedAt ? <p className="small muted mt8">{t.providerDeletedAt(new Date(voice.data.clone.providerDeletedAt).toLocaleString(locale))}</p> : <p className="small muted mt16">{t.providerDeleteUnavailable}</p>}
        </> : null}
        <p className="small muted mt16">{t.trainingCostNote}</p></div></div>}
    </section> : null}
    {voiceConfirmation ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeVoiceConfirmation(); }}><div ref={voiceDialog.dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="voice-action-title" aria-describedby="voice-action-description">
      <h2 id="voice-action-title">{t.voiceActions[voiceConfirmation.action].confirm}</h2>
      <p className="small muted mt16">{t.confirmSubject(voiceConfirmation.identityName, voiceConfirmation.status)}</p>
      <p id="voice-action-description" className="mt16">{t.voiceActions[voiceConfirmation.action].description}</p>
      {voiceAction.isError ? <p role="alert" className="notice amber mt16">{t.actionFailed(describeError(voiceAction.error).message)}</p> : null}
      <div className="row mt24" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" disabled={voiceAction.isPending} onClick={closeVoiceConfirmation}>{t.cancel}</button><button type="button" className="btn primary" disabled={!canEdit || voiceAction.isPending} onClick={() => voiceAction.mutate(voiceConfirmation)}>{voiceAction.isPending ? t.processing : t.voiceActions[voiceConfirmation.action].confirm}</button></div>
    </div></div> : null}
  </div>;
}
