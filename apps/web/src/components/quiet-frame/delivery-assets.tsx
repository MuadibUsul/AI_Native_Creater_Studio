'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSET_PERMITTED_USES, mapSourcePtsToProxyPts, type Asset, type AssetLifecycle, type AssetReference, type AssetRelinkComparison, type AssetRelinkState, type MediaAnalysisStageName, type MediaIndexEntry, type MediaSegmentSearchResult, type TranscriptSegment, type UpdateAssetRightsRequest } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys } from '@/lib/queries';
import { StateBlock } from '@/ui/StateBlock';
import { QuietIcon } from '@/ui/QuietIcon';
import { FinanceWorkspace } from '@/ui/FinanceWorkspace';
import { useI18n } from '@/i18n/I18nProvider';
import type { AssetLibraryText } from '@/i18n/pages/asset-library';
import { useDeliveryDialog } from './delivery-dialog';
import styles from './delivery.module.css';

type Filter = 'ALL' | 'IMAGE' | 'CHART' | 'AUDIO' | 'DOCUMENT' | 'VIDEO';
type AssetLabels = AssetLibraryText['labels'];
type UploadState = 'queued' | 'uploading' | 'paused' | 'complete' | 'error' | 'cancelled';
interface UploadItem {
  id: string;
  file: File;
  state: UploadState;
  progress: number;
  intentId?: string;
  assetStatus?: Asset['status'];
  error?: string;
}
const filters: Filter[] = ['ALL', 'IMAGE', 'CHART', 'AUDIO', 'DOCUMENT', 'VIDEO'];
function assetKind(asset: Asset): Filter {
  const mimeType = typeof asset.metadata?.['mimeType'] === 'string' ? asset.metadata['mimeType'] : '';
  if (mimeType.startsWith('image/')) return 'IMAGE';
  if (mimeType.startsWith('audio/')) return 'AUDIO';
  if (mimeType.startsWith('video/')) return 'VIDEO';
  if (['SOURCE_IMAGE', 'GENERATED_IMAGE', 'THUMBNAIL'].includes(asset.assetType)) return 'IMAGE';
  if (['CHART_RENDER', 'CUSTOM_MOTION_RENDER'].includes(asset.assetType)) return 'CHART';
  if (['VOICE_AUDIO', 'MUSIC'].includes(asset.assetType)) return 'AUDIO';
  if (['SOURCE_DOCUMENT', 'SUBTITLE', 'MANIFEST'].includes(asset.assetType)) return 'DOCUMENT';
  if (['AVATAR_CLIP', 'GENERATED_VIDEO', 'DRAFT_RENDER', 'FINAL_VIDEO', 'SHORT_VIDEO'].includes(asset.assetType)) return 'VIDEO';
  return 'ALL';
}
function assetName(asset: Asset): string {
  for (const key of ['filename', 'name', 'title']) {
    const value = asset.metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return `${asset.assetType.replaceAll('_', ' ')} · ${asset.id.slice(0, 8)}`;
}
function originLabel(origin: Asset['origin'], labels: AssetLabels): string {
  // 服务端若返回尚未登记的来源枚举，原样显示。
  return (labels.origins as Partial<Record<string, string>>)[origin] ?? origin;
}
function licenseLabel(asset: Asset, labels: AssetLabels): string {
  return labels.licenses[asset.license?.type ?? 'UNKNOWN'];
}
function uploadAssetType(file: File): 'SOURCE_IMAGE' | 'VOICE_AUDIO' | 'USER_UPLOAD' {
  return file.type.startsWith('image/') ? 'SOURCE_IMAGE' : file.type.startsWith('audio/') ? 'VOICE_AUDIO' : 'USER_UPLOAD';
}

function rationalLabel(value: { numerator: number; denominator: number } | null, unknown: string): string {
  return value === null ? unknown : `${String(value.numerator)}/${String(value.denominator)}`;
}

function clockLabel(value: unknown): string {
  const totalMilliseconds = Math.max(0, Math.round(typeof value === 'number' && Number.isFinite(value) ? value : 0));
  const seconds = Math.floor(totalMilliseconds / 1000);
  const wholeSeconds = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const remainder = totalMilliseconds % 1000;
  return remainder === 0 ? wholeSeconds : `${wholeSeconds}.${String(remainder).padStart(3, '0')}`;
}

function AssetPreview({ kind, name, id }: { kind: Filter; name: string; id: string }) {
  const t = useI18n().messages.assetLibrary.library;
  const art = [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 5;
  return <div className={`cover ${styles['assetPreview']}`} data-preview-kind={kind}>
    {kind === 'IMAGE' ? <><div className={`cover-art art-${art}`} aria-hidden="true" /><span className={`cover-title ${styles['previewTitle']}`}>{name}</span></> : null}
    {kind === 'CHART' ? <div className="asset-chart" aria-hidden="true">{[26, 45, 62, 87, 105].map((height) => <i key={height} style={{ height }} />)}</div> : null}
    {kind === 'AUDIO' ? <div className="asset-sound" aria-hidden="true"><div className="wave">{Array.from({ length: 32 }, (_, index) => <span key={index} style={{ height: `${Math.round(4 + (Math.sin(index * 2.4) + 1) * 6 + (Math.sin(index * .83) + 1) * 3)}px` }} />)}</div></div> : null}
    {kind === 'DOCUMENT' ? <div className="asset-doc" aria-hidden="true"><div className="document-mini">{Array.from({ length: 8 }, (_, index) => <i key={index} />)}</div></div> : null}
    {(kind === 'VIDEO' || kind === 'ALL') ? <div className={styles['genericPreview']} aria-hidden="true"><QuietIcon name={kind === 'VIDEO' ? 'film' : 'image'} /></div> : null}
    <span id={`asset-preview-${id}`} className={styles['previewDisclosure']}>{kind === 'CHART' ? t.previewChartDisclosure : t.previewDisclosure}</span>
  </div>;
}

function AssetLifecyclePanel({ workspaceId, lifecycle, onAssetChanged, onAssetDeleted }: { workspaceId: string; lifecycle: AssetLifecycle; onAssetChanged: (next: AssetLifecycle) => void; onAssetDeleted: () => void }) {
  const client = useAncsClient();
  const { messages, locale } = useI18n();
  const t = messages.assetLibrary.lifecycle;
  const labels = messages.assetLibrary.labels;
  const [editing, setEditing] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [privacyConfirmation, setPrivacyConfirmation] = useState('');
  const [privacyReason, setPrivacyReason] = useState('');
  const [privacyResult, setPrivacyResult] = useState<string | null>(null);
  const initial = lifecycle.asset.license;
  const [draft, setDraft] = useState<UpdateAssetRightsRequest>({
    type: initial.type, holder: initial.holder, attribution: initial.attribution, sourceUrl: initial.sourceUrl,
    termsUrl: initial.termsUrl, notes: initial.notes, userOwnedDeclared: initial.userOwnedDeclared,
    permittedUses: initial.permittedUses, expiresAt: initial.expiresAt, sensitivityClass: lifecycle.asset.sensitivityClass,
  });
  useEffect(() => {
    const license = lifecycle.asset.license;
    setDraft({ type: license.type, holder: license.holder, attribution: license.attribution, sourceUrl: license.sourceUrl, termsUrl: license.termsUrl, notes: license.notes, userOwnedDeclared: license.userOwnedDeclared, permittedUses: license.permittedUses, expiresAt: license.expiresAt, sensitivityClass: lifecycle.asset.sensitivityClass });
  }, [lifecycle]);
  const save = useMutation({
    mutationFn: () => client.assets.updateRights(workspaceId, lifecycle.asset.id, draft),
    onSuccess: (next) => { onAssetChanged(next); setEditing(false); },
  });
  const removeReference = useMutation({
    mutationFn: (reference: AssetReference) => {
      if (reference.kind !== 'SCENE' || reference.sceneId === null || reference.sceneRevision === null || reference.role === null) throw new Error(t.frozenReferenceError);
      return client.projects.edit(reference.projectId, {
        baseProjectRevision: reference.projectRevision,
        expectedSceneRevisions: { [reference.sceneId]: reference.sceneRevision },
        operations: [{ op: 'replace_asset', sceneId: reference.sceneId, role: reference.role, newAssetId: null }],
        idempotencyKey: `idem_asset_unlink_${reference.sceneId}_${String(reference.sceneRevision)}_${Date.now()}`,
        intent: t.unlinkIntent,
      });
    },
    onSuccess: async () => onAssetChanged(await client.assets.lifecycle(workspaceId, lifecycle.asset.id)),
  });
  const trash = useMutation({ mutationFn: () => client.assets.delete(workspaceId, lifecycle.asset.id), onSuccess: onAssetDeleted });
  const privacy = useMutation({
    mutationFn: () => client.assets.requestPrivacyDeletion(workspaceId, lifecycle.asset.id, { confirmationAssetId: privacyConfirmation.trim(), reason: privacyReason.trim() }),
    onSuccess: (result) => {
      setPrivacyResult(result.status === 'SCHEDULED' ? t.privacyScheduled : t.privacyBlocked(result.missingDependencies.length));
      setPrivacyOpen(false);
    },
  });
  const updateText = (key: 'holder' | 'attribution' | 'sourceUrl' | 'termsUrl' | 'notes', value: string) => setDraft((current) => ({ ...current, [key]: value.trim().length === 0 ? null : value }));
  return <section className={`${styles['rightsPanel']} panel pad mt24`} aria-label={t.aria}>
    <div className="row between"><div><strong>{t.title}</strong><p className="small muted mt8">{t.body}</p></div><span className={`badge ${lifecycle.licenseState === 'ACTIVE' ? 'green' : 'amber'}`}>{labels.licenseStates[lifecycle.licenseState]}</span></div>
    {!editing ? <>
      <dl className={styles['rightsSummary']}><div><dt>{t.source}</dt><dd>{licenseLabel(lifecycle.asset, labels)}</dd></div><div><dt>{t.permittedUses}</dt><dd>{initial.permittedUses.length ? initial.permittedUses.map((use) => labels.permittedUses[use]).join(t.listSeparator) : t.noPermittedUses}</dd></div><div><dt>{t.sensitivity}</dt><dd>{labels.sensitivity[lifecycle.asset.sensitivityClass]}</dd></div><div><dt>{t.expiry}</dt><dd>{initial.expiresAt ? new Date(initial.expiresAt).toLocaleString(locale) : t.noExpiry}</dd></div></dl>
      {initial.attribution && <p className="small muted mt8">{t.attribution(initial.attribution)}</p>}
      <button type="button" className="btn small mt16" onClick={() => setEditing(true)}>{t.edit}</button>
    </> : <form className={styles['rightsForm']} onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <label className="label">{t.rightsType}<select className="field select" value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as UpdateAssetRightsRequest['type'], userOwnedDeclared: event.target.value === 'USER_OWNED' }))}><option value="USER_OWNED">{t.rightsTypeOptions.USER_OWNED}</option><option value="LICENSED">{t.rightsTypeOptions.LICENSED}</option><option value="PUBLIC_DOMAIN">{t.rightsTypeOptions.PUBLIC_DOMAIN}</option><option value="PROVIDER_TERMS">{t.rightsTypeOptions.PROVIDER_TERMS}</option><option value="UNKNOWN">{t.rightsTypeOptions.UNKNOWN}</option></select></label>
      <label className="label">{t.holder}<input className="field" value={draft.holder ?? ''} onChange={(event) => updateText('holder', event.target.value)} /></label>
      <label className="label">{t.attributionText}<input className="field" value={draft.attribution ?? ''} onChange={(event) => updateText('attribution', event.target.value)} /></label>
      <label className="label">{t.sourceUrl}<input className="field" type="url" value={draft.sourceUrl ?? ''} onChange={(event) => updateText('sourceUrl', event.target.value)} /></label>
      <label className="label">{t.termsUrl}<input className="field" type="url" value={draft.termsUrl ?? ''} onChange={(event) => updateText('termsUrl', event.target.value)} /></label>
      <label className="label">{t.expiresAt}<input className="field" type="datetime-local" value={draft.expiresAt ? draft.expiresAt.slice(0, 16) : ''} onChange={(event) => setDraft((current) => ({ ...current, expiresAt: event.target.value ? new Date(event.target.value).toISOString() : null }))} /></label>
      <label className="label">{t.sensitivity}<select className="field select" value={draft.sensitivityClass} onChange={(event) => setDraft((current) => ({ ...current, sensitivityClass: event.target.value as UpdateAssetRightsRequest['sensitivityClass'] }))}>{Object.entries(labels.sensitivity).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <fieldset className={styles['useChoices']}><legend>{t.permittedUses}</legend>{ASSET_PERMITTED_USES.map((use) => <label className="checkboxrow" key={use}><input type="checkbox" checked={draft.permittedUses.includes(use)} onChange={(event) => setDraft((current) => ({ ...current, permittedUses: event.target.checked ? [...new Set([...current.permittedUses, use])] : current.permittedUses.filter((item) => item !== use) }))} />{labels.permittedUses[use]}</label>)}</fieldset>
      {draft.type === 'USER_OWNED' && <label className="checkboxrow"><input type="checkbox" checked={draft.userOwnedDeclared} onChange={(event) => setDraft((current) => ({ ...current, userOwnedDeclared: event.target.checked }))} />{t.ownershipDeclaration}</label>}
      <label className="label">{t.notes}<textarea className="field" rows={3} value={draft.notes ?? ''} onChange={(event) => updateText('notes', event.target.value)} /></label>
      {save.isError && <p className="notice amber" role="alert">{t.saveFailed(describeError(save.error).message)}</p>}
      <div className="row"><button className="btn" type="button" onClick={() => setEditing(false)}>{t.cancel}</button><button className="btn primary" type="submit" disabled={save.isPending || (draft.type === 'USER_OWNED' && !draft.userOwnedDeclared)}>{save.isPending ? t.saving : t.save}</button></div>
    </form>}
    <div className={styles['lifecycleSection']}><div className="row between"><strong>{t.referencesTitle}</strong><span className="small muted">{lifecycle.gcProtected ? t.gcProtected : t.gcFree}</span></div>
      {lifecycle.references.length === 0 && lifecycle.derivations.length === 0 ? <p className="small muted mt8">{t.noReferences}</p> : null}
      {lifecycle.references.map((reference) => <div className={styles['referenceRow']} key={`${reference.kind}-${reference.sceneId ?? reference.projectVersionId}`}><div><strong>{reference.kind === 'SCENE' ? t.sceneReference(reference.projectTitle) : t.versionReference(reference.projectTitle, String(reference.versionNumber))}</strong><span>{reference.kind === 'SCENE' ? t.sceneRole(reference.role ?? t.unknownRole) : t.versionRetained(reference.versionReason ?? t.historicalVersion)}</span></div>{reference.kind === 'SCENE' && <button className="textbtn small" type="button" disabled={removeReference.isPending} onClick={() => removeReference.mutate(reference)}>{t.removeReference}</button>}</div>)}
      {lifecycle.derivations.map((edge) => <div className={styles['referenceRow']} key={`${edge.direction}-${edge.relatedAssetVersionId}`}><div><strong>{edge.direction === 'DERIVED' ? t.derived : t.sourceOriginal} · {edge.kind}</strong><span>{edge.relatedAssetId}</span></div></div>)}
      {removeReference.isError && <p className="notice amber mt8" role="alert">{t.removeFailed(describeError(removeReference.error).message)}</p>}
    </div>
    <details className={styles['dangerDetails']}><summary>{t.dangerTitle}</summary><p className="small muted mt8">{t.dangerBody}</p><div className="row mt16"><button type="button" className="btn small" disabled={trash.isPending} onClick={() => trash.mutate()}>{trash.isPending ? t.trashing : t.trash}</button><button type="button" className="btn small" onClick={() => setPrivacyOpen((value) => !value)}>{t.requestPrivacy}</button></div>{privacyOpen && <div className={styles['privacyForm']}><label className="label">{t.privacyReason}<textarea className="field" rows={2} value={privacyReason} onChange={(event) => setPrivacyReason(event.target.value)} /></label><label className="label">{t.privacyConfirm}<input className="field" value={privacyConfirmation} onChange={(event) => setPrivacyConfirmation(event.target.value)} placeholder={lifecycle.asset.id} /></label><button type="button" className="btn primary small" disabled={privacy.isPending || privacyReason.trim().length === 0 || privacyConfirmation.trim() !== lifecycle.asset.id} onClick={() => privacy.mutate()}>{privacy.isPending ? t.submitting : t.confirmPrivacy}</button></div>}{privacy.isError && <p className="notice amber mt8" role="alert">{t.submitFailed(describeError(privacy.error).message)}</p>}{privacyResult && <p className="notice mt8" role="status">{privacyResult}</p>}</details>
  </section>;
}

function trackSummary(tracks: AssetRelinkComparison['tracks']['target'], labels: AssetLabels, text: AssetLibraryText['relink']): string {
  if (tracks.length === 0) return text.noTracks;
  return tracks.map((track) => track.type === 'VIDEO'
    ? labels.videoTrack(track.codecName ?? labels.unknownCodec, `${track.width ?? '?'}×${track.height ?? '?'}`)
    : track.type === 'AUDIO'
      ? labels.audioTrack(track.codecName ?? labels.unknownCodec, String(track.channels ?? '?'))
      : `${track.type} ${track.codecName ?? labels.unknownCodec}`).join(text.trackSeparator);
}

function AssetRelinkPanel({ workspaceId, asset, candidates, state, onApplied }: { workspaceId: string; asset: Asset; candidates: Asset[]; state: AssetRelinkState; onApplied: (state: AssetRelinkState) => void }) {
  const client = useAncsClient();
  const { messages } = useI18n();
  const t = messages.assetLibrary.relink;
  const labels = messages.assetLibrary.labels;
  const missing = state.versions.filter((version) => version.availability === 'MISSING');
  const [targetVersionId, setTargetVersionId] = useState(missing[0]?.assetVersionId ?? '');
  const [candidateAssetId, setCandidateAssetId] = useState('');
  const [comparison, setComparison] = useState<AssetRelinkComparison | null>(null);
  const [confirmation, setConfirmation] = useState('');
  useEffect(() => {
    setTargetVersionId(missing[0]?.assetVersionId ?? '');
    setCandidateAssetId('');
    setComparison(null);
    setConfirmation('');
  }, [asset.id, state]);
  const preflight = useMutation({
    mutationFn: () => client.assets.preflightRelink(workspaceId, asset.id, { targetVersionId, candidateAssetId }),
    onSuccess: (result) => { setComparison(result); setConfirmation(''); },
  });
  const apply = useMutation({
    mutationFn: () => {
      if (comparison === null) throw new Error(t.validateFirst);
      return client.assets.applyRelink(workspaceId, asset.id, {
        targetVersionId: comparison.targetVersionId,
        candidateAssetId: comparison.candidateAssetId,
        expectedCandidateChecksumSha256: comparison.candidateChecksumSha256,
        confirmationText: comparison.confirmationText,
      });
    },
    onSuccess: (result) => { onApplied(result.state); setComparison(null); setConfirmation(''); },
  });
  return <section className={`${styles['relinkPanel']} panel pad mt16`} aria-label={t.aria}>
    <div className="row between"><div><strong>{t.title}</strong><p className="small muted mt8">{t.body}</p></div><span className={`badge ${missing.length === 0 ? 'green' : 'amber'}`}>{missing.length === 0 ? t.online : t.missingCount(missing.length)}</span></div>
    {missing.length === 0 ? <p className="small muted mt16">{t.allAvailable}</p> : <div className={styles['relinkForm']}>
      <label className="label">{t.missingVersion}<select className="field select" value={targetVersionId} onChange={(event) => { setTargetVersionId(event.target.value); setComparison(null); }}>{missing.map((version) => <option key={version.assetVersionId} value={version.assetVersionId}>{t.versionOption(version.versionNumber, version.current, version.activeClipReferences)}</option>)}</select></label>
      <label className="label">{t.candidate}<select className="field select" value={candidateAssetId} onChange={(event) => { setCandidateAssetId(event.target.value); setComparison(null); }}><option value="">{t.chooseCandidate}</option>{candidates.filter((candidate) => candidate.id !== asset.id && candidate.status === 'READY').map((candidate) => <option key={candidate.id} value={candidate.id}>{assetName(candidate)}</option>)}</select></label>
      <button type="button" className="btn small" disabled={!targetVersionId || !candidateAssetId || preflight.isPending} onClick={() => preflight.mutate()}>{preflight.isPending ? t.validating : t.validate}</button>
      {preflight.isError && <p role="alert" className="notice amber">{t.validateFailed(describeError(preflight.error).message)}</p>}
      {comparison && <div className={styles['relinkComparison']}>
        <div className="row between"><strong>{comparison.mode === 'EXACT_RESTORE' ? t.exactMatch : t.differentContent}</strong><span className={`badge ${comparison.mode === 'EXACT_RESTORE' ? 'green' : 'amber'}`}>{comparison.mode === 'EXACT_RESTORE' ? t.restoreOriginal : t.newVersionReview}</span></div>
        <dl className={styles['rightsSummary']}><div><dt>{t.checksum}</dt><dd>{comparison.checksumMatches ? t.same : t.different}</dd></div><div><dt>{t.duration}</dt><dd>{comparison.duration.matches ? t.same : t.durationChange(String(comparison.duration.targetMs ?? labels.unknown), String(comparison.duration.candidateMs ?? labels.unknown))}</dd></div><div><dt>{t.tracks}</dt><dd>{comparison.tracks.matches ? t.same : t.tracksDiffer}</dd></div><div><dt>{t.offlineReferences}</dt><dd>{t.keptReferences(comparison.activeClipReferences)}</dd></div></dl>
        {!comparison.tracks.matches && <p className="small muted">{t.originalTracks(trackSummary(comparison.tracks.target, labels, t))}<br />{t.candidateTracks(trackSummary(comparison.tracks.candidate, labels, t))}</p>}
        <p className="small muted mt8">{comparison.mode === 'EXACT_RESTORE' ? t.exactRestoreNote : t.replacementNote}</p>
        <label className="label mt16">{t.typeToConfirm(comparison.confirmationText)}<input className="field" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <button type="button" className="btn primary small" disabled={confirmation !== comparison.confirmationText || apply.isPending} onClick={() => apply.mutate()}>{apply.isPending ? t.applying : comparison.confirmationText}</button>
      </div>}
      {apply.isError && <p role="alert" className="notice amber">{t.applyFailed(describeError(apply.error).message)}</p>}
    </div>}
  </section>;
}

export function DeliveryAssets({ workspaceId, projectId }: { workspaceId: string; projectId?: string }) {
  const client = useAncsClient();
  const cache = useQueryClient();
  const { messages } = useI18n();
  const labels = messages.assetLibrary.labels;
  const t = messages.assetLibrary.library;
  const u = messages.assetLibrary.upload;
  const d = messages.assetLibrary.detail;
  const assetsKey = projectId === undefined ? ['workspaces', workspaceId, 'assets'] as const : queryKeys.assets(workspaceId, projectId);
  const assets = useQuery({ queryKey: assetsKey, queryFn: () => client.assets.list(workspaceId, projectId ? { projectId } : undefined) });
  const [filter, setFilter] = useState<Filter>('ALL');
  const [search, setSearch] = useState('');
  const [segmentDraft, setSegmentDraft] = useState('');
  const [segmentQuery, setSegmentQuery] = useState('');
  const [pendingSearchResult, setPendingSearchResult] = useState<MediaSegmentSearchResult | null>(null);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mediaErrorAssetId, setMediaErrorAssetId] = useState<string | null>(null);
  const [financeOpen, setFinanceOpen] = useState(false);
  const [rebindIds, setRebindIds] = useState<Record<string, string>>({});
  const [indexKind, setIndexKind] = useState<'THUMBNAIL' | 'WAVEFORM' | 'SHOT' | 'QUALITY'>('THUMBNAIL');
  const [indexCursor, setIndexCursor] = useState<string | undefined>();
  const [editingTranscriptSegmentId, setEditingTranscriptSegmentId] = useState<string | null>(null);
  const [transcriptDraft, setTranscriptDraft] = useState('');
  const [terminologyDraft, setTerminologyDraft] = useState<string | null>(null);
  const [tagLabel, setTagLabel] = useState('');
  const [tagStartSeconds, setTagStartSeconds] = useState('0');
  const [tagEndSeconds, setTagEndSeconds] = useState('5');
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const playbackRangeEnd = useRef<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const uploadItemsRef = useRef<UploadItem[]>([]);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const selected = assets.data?.find((asset) => asset.id === selectedId);
  const detail = useQuery({ queryKey: ['asset-detail', workspaceId, selectedId], enabled: selectedId !== null, queryFn: () => client.assets.get(workspaceId, selectedId as string) });
  const lifecycleKey = ['asset-lifecycle', workspaceId, selectedId] as const;
  const lifecycle = useQuery({ queryKey: lifecycleKey, enabled: selectedId !== null, queryFn: () => client.assets.lifecycle(workspaceId, selectedId as string) });
  const relinkKey = ['asset-relink-state', workspaceId, selectedId] as const;
  const relinkState = useQuery({ queryKey: relinkKey, enabled: selectedId !== null, queryFn: () => client.assets.relinkState(workspaceId, selectedId as string) });
  const currentVersion = detail.data?.versions.find((version) => version.id === detail.data.currentVersionId) ?? null;
  const currentMimeType = currentVersion?.mimeType ?? null;
  const download = useQuery({ queryKey: ['asset-download', workspaceId, selectedId], enabled: selectedId !== null && selected !== undefined && ['READY', 'PROCESSING', 'FAILED'].includes(selected.status), queryFn: () => client.assets.downloadUrl(workspaceId, selectedId as string), staleTime: 0 });
  const signedDownloadUrl = download.data && Date.parse(download.data.expiresAt) > Date.now() + 5000 ? download.data.url : null;
  const playback = useQuery({
    queryKey: ['asset-playback', workspaceId, selectedId],
    enabled: selectedId !== null && currentVersion?.probeStatus === 'READY' && (currentMimeType?.startsWith('video/') === true || currentMimeType?.startsWith('audio/') === true),
    queryFn: () => client.assets.playbackUrl(workspaceId, selectedId as string),
    staleTime: 0,
    refetchInterval: 3000,
  });
  const signedPlaybackUrl = playback.data?.url && playback.data.expiresAt && Date.parse(playback.data.expiresAt) > Date.now() + 5000 ? playback.data.url : null;
  const legacyPreviewAllowed = currentVersion?.probeStatus === undefined || currentVersion.probeStatus === 'NOT_REQUIRED';
  const previewUrl = currentVersion?.probeStatus === 'READY' ? signedPlaybackUrl : legacyPreviewAllowed ? signedDownloadUrl : null;
  const previewMimeType = currentVersion?.probeStatus === 'READY' ? playback.data?.mimeType ?? null : legacyPreviewAllowed ? currentMimeType : null;
  const rebuildProxy = useMutation({
    mutationFn: () => client.assets.rebuildProxy(workspaceId, selectedId as string),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: ['asset-playback', workspaceId, selectedId] }); },
  });
  const segmentSearch = useQuery({
    queryKey: ['asset-segment-search', workspaceId, segmentQuery],
    enabled: segmentQuery.length >= 2,
    queryFn: () => client.assets.searchSegments(workspaceId, { q: segmentQuery, limit: 20 }),
  });
  const rangeTagsKey = ['asset-range-tags', workspaceId, selectedId] as const;
  const rangeTags = useQuery({
    queryKey: rangeTagsKey,
    enabled: selectedId !== null && currentVersion?.probeStatus === 'READY',
    queryFn: () => client.assets.listRangeTags(workspaceId, selectedId as string),
  });
  const createRangeTag = useMutation({
    mutationFn: () => client.assets.createRangeTag(workspaceId, selectedId as string, {
      label: tagLabel.trim(),
      sourceStartPts: String(Math.round(Number(tagStartSeconds) * 1000)),
      sourceEndPts: String(Math.round(Number(tagEndSeconds) * 1000)),
      timeBase: { numerator: 1, denominator: 1000 },
    }),
    onSuccess: async () => { setTagLabel(''); await cache.invalidateQueries({ queryKey: rangeTagsKey }); },
  });
  const deleteRangeTag = useMutation({
    mutationFn: (tagId: string) => client.assets.deleteRangeTag(workspaceId, selectedId as string, tagId),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: rangeTagsKey }); },
  });
  const mediaIndex = useQuery({
    queryKey: ['asset-media-index', workspaceId, selectedId, indexKind, indexCursor],
    enabled: selectedId !== null && currentVersion?.probeStatus === 'READY' && (currentMimeType?.startsWith('video/') === true || currentMimeType?.startsWith('audio/') === true),
    queryFn: () => client.assets.mediaIndex(workspaceId, selectedId as string, { kind: indexKind, cursor: indexCursor, limit: 24 }),
    refetchInterval: (query) => ['QUEUED', 'RUNNING', 'PARTIAL'].includes(query.state.data?.status ?? '') ? 3000 : false,
  });
  const rebuildIndex = useMutation({
    mutationFn: () => client.assets.rebuildMediaIndex(workspaceId, selectedId as string),
    onSuccess: async () => { setIndexCursor(undefined); await cache.invalidateQueries({ queryKey: ['asset-media-index', workspaceId, selectedId] }); },
  });
  const hasAudio = currentVersion?.mediaProbe?.streams.some((stream) => stream.type === 'AUDIO') === true;
  const transcriptKey = ['asset-transcript', workspaceId, selectedId] as const;
  const transcript = useQuery({
    queryKey: transcriptKey,
    enabled: selectedId !== null && currentVersion?.probeStatus === 'READY' && hasAudio,
    queryFn: () => client.assets.transcript(workspaceId, selectedId as string),
    refetchInterval: (query) => ['QUEUED', 'RUNNING'].includes(query.state.data?.status ?? '') ? 3000 : false,
  });
  const analysisKey = ['asset-analysis-stages', workspaceId, selectedId] as const;
  const analysis = useQuery({
    queryKey: analysisKey,
    enabled: selectedId !== null && typeof client.assets.analysisStages === 'function',
    queryFn: () => client.assets.analysisStages(workspaceId, selectedId as string),
    refetchInterval: (query) => query.state.data?.stages.some((stage) => ['QUEUED', 'RUNNING', 'PARTIAL', 'CANCEL_REQUESTED'].includes(stage.status)) ? 3000 : false,
  });
  const rebuildAnalysis = useMutation({
    mutationFn: (stage: MediaAnalysisStageName) => {
      const current = analysis.data?.stages.find((candidate) => candidate.stage === stage);
      if (!current) throw new Error('analysis stage is unavailable');
      return client.assets.rebuildAnalysisStage(workspaceId, selectedId as string, stage, current.detectorConfigHash);
    },
    onSuccess: (data) => cache.setQueryData(analysisKey, data),
  });
  const cancelAnalysis = useMutation({
    mutationFn: (stage: MediaAnalysisStageName) => client.assets.cancelAnalysisStage(workspaceId, selectedId as string, stage),
    onSuccess: (data) => cache.setQueryData(analysisKey, data),
  });
  const retryTranscript = useMutation({
    mutationFn: () => client.assets.retryTranscript(workspaceId, selectedId as string),
    onSuccess: (data) => cache.setQueryData(transcriptKey, data),
  });
  const correctSegment = useMutation({
    mutationFn: (input: { segmentId: string; text: string }) => client.assets.correctTranscriptSegment(workspaceId, selectedId as string, { expectedVersion: transcript.data?.currentVersion?.version ?? 0, ...input }),
    onSuccess: (data) => { cache.setQueryData(transcriptKey, data); setEditingTranscriptSegmentId(null); setTranscriptDraft(''); },
  });
  const updateTerminology = useMutation({
    mutationFn: () => client.assets.updateTranscriptTerminology(workspaceId, selectedId as string, { expectedVersion: transcript.data?.currentVersion?.version ?? 0, entries: (terminologyDraft ?? transcript.data?.currentVersion?.terminology.map((entry) => `${entry.source}=${entry.preferred}`).join('\n') ?? '').split('\n').map((line) => line.split('=')).filter((parts) => parts.length >= 2 && parts[0]?.trim() && parts.slice(1).join('=').trim()).map((parts) => ({ source: parts[0]!.trim(), preferred: parts.slice(1).join('=').trim() })) }),
    onSuccess: (data) => { cache.setQueryData(transcriptKey, data); setTerminologyDraft(null); },
  });
  const sourcePtsSeconds = (entry: MediaIndexEntry, pts: string): number => {
    const streamType = entry.kind === 'WAVEFORM' || entry.payload['marker'] === 'SILENCE' ? 'AUDIO' : 'VIDEO';
    const mapping = playback.data?.rendition === 'PROXY' ? playback.data.timeMappings.find((candidate) => candidate.streamType === streamType) : undefined;
    if (mapping) {
      const proxyPts = Number(mapSourcePtsToProxyPts(mapping, pts));
      return proxyPts * mapping.proxyTimeBase.numerator / mapping.proxyTimeBase.denominator;
    }
    return Number(pts) * entry.timeBase.numerator / entry.timeBase.denominator;
  };
  const playIndexRange = (entry: MediaIndexEntry) => {
    const media = mediaRef.current;
    if (!media) return;
    media.currentTime = Math.max(0, sourcePtsSeconds(entry, entry.sourceStartPts));
    playbackRangeEnd.current = Math.max(media.currentTime, sourcePtsSeconds(entry, entry.sourceEndPts));
    void media.play().catch(() => undefined);
  };
  const playTranscriptRange = (segment: TranscriptSegment) => {
    const media = mediaRef.current;
    if (!media) return;
    const mapping = playback.data?.rendition === 'PROXY' ? playback.data.timeMappings.find((candidate) => candidate.streamType === 'AUDIO') : undefined;
    const seconds = (pts: string) => mapping ? Number(mapSourcePtsToProxyPts(mapping, pts)) * mapping.proxyTimeBase.numerator / mapping.proxyTimeBase.denominator : Number(pts) * segment.timeBase.numerator / segment.timeBase.denominator;
    media.currentTime = Math.max(0, seconds(segment.sourceStartPts));
    playbackRangeEnd.current = Math.max(media.currentTime, seconds(segment.sourceEndPts));
    void media.play().catch(() => undefined);
  };
  useEffect(() => {
    if (!pendingSearchResult || pendingSearchResult.assetId !== selectedId || !previewUrl) return;
    const media = mediaRef.current;
    if (!media) return;
    const streamType = pendingSearchResult.modality === 'AUDIO' || pendingSearchResult.modality === 'TRANSCRIPT' ? 'AUDIO' : 'VIDEO';
    const mapping = playback.data?.rendition === 'PROXY' ? playback.data.timeMappings.find((candidate) => candidate.streamType === streamType) : undefined;
    const seconds = (pts: string): number => mapping
      ? Number(mapSourcePtsToProxyPts(mapping, pts)) * mapping.proxyTimeBase.numerator / mapping.proxyTimeBase.denominator
      : Number(pts) * pendingSearchResult.timeBase.numerator / pendingSearchResult.timeBase.denominator;
    media.currentTime = Math.max(0, seconds(pendingSearchResult.sourceStartPts));
    playbackRangeEnd.current = Math.max(media.currentTime, seconds(pendingSearchResult.sourceEndPts));
    void media.play().catch(() => undefined);
    setPendingSearchResult(null);
  }, [pendingSearchResult, playback.data, previewUrl, selectedId]);
  const stopAtIndexRangeEnd = () => {
    const media = mediaRef.current;
    if (media && playbackRangeEnd.current !== null && media.currentTime >= playbackRangeEnd.current) { media.pause(); playbackRangeEnd.current = null; }
  };
  const external = useQuery({ queryKey: [...assetsKey, 'external-results'], queryFn: () => client.billing.externalResults(workspaceId, { onlyUnfulfilled: true, limit: 20 }) });
  const updateUploadItems = (updater: (items: UploadItem[]) => UploadItem[]) => {
    const next = updater(uploadItemsRef.current);
    uploadItemsRef.current = next;
    setUploadItems(next);
  };
  const chooseFiles = (files: FileList | null) => {
    const next = Array.from(files ?? []).map((file, index): UploadItem => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${String(index)}`,
      file,
      state: 'queued',
      progress: 0,
    }));
    uploadItemsRef.current = next;
    setUploadItems(next);
  };
  const runUpload = async (itemId: string) => {
    const item = uploadItemsRef.current.find((candidate) => candidate.id === itemId);
    if (!item || item.state === 'complete' || item.state === 'cancelled') return;
    const controller = new AbortController();
    uploadControllers.current.set(itemId, controller);
    updateUploadItems((current) => current.map((candidate) => candidate.id === itemId ? { ...candidate, state: 'uploading', error: undefined } : candidate));
    try {
      const uploaded = await client.assets.uploadResumable(workspaceId, {
        assetType: uploadAssetType(item.file),
        filename: item.file.name,
        contentType: item.file.type || 'application/octet-stream',
        data: item.file,
        ...(projectId ? { projectId } : {}),
        ...(item.intentId ? { resumeIntentId: item.intentId } : {}),
      }, {
        signal: controller.signal,
        concurrency: 3,
        onIntent: ({ intentId }) => updateUploadItems((current) => current.map((candidate) => candidate.id === itemId ? { ...candidate, intentId } : candidate)),
        onProgress: ({ uploadedBytes, totalBytes }) => updateUploadItems((current) => current.map((candidate) => candidate.id === itemId ? { ...candidate, progress: totalBytes === 0 ? 0 : Math.round(uploadedBytes / totalBytes * 100) } : candidate)),
      });
      updateUploadItems((current) => current.map((candidate) => candidate.id === itemId ? { ...candidate, state: 'complete', progress: 100, assetStatus: uploaded.status } : candidate));
      await cache.invalidateQueries({ queryKey: assetsKey });
    } catch (error) {
      const current = uploadItemsRef.current.find((candidate) => candidate.id === itemId);
      if (controller.signal.aborted && current?.state !== 'cancelled') {
        updateUploadItems((items) => items.map((candidate) => candidate.id === itemId ? { ...candidate, state: 'paused' } : candidate));
      } else if (current?.state !== 'cancelled') {
        updateUploadItems((items) => items.map((candidate) => candidate.id === itemId ? { ...candidate, state: 'error', error: describeError(error).message } : candidate));
      }
    } finally {
      uploadControllers.current.delete(itemId);
    }
  };
  const startQueuedUploads = async () => {
    for (const item of uploadItemsRef.current) {
      if (item.state === 'queued' || item.state === 'paused' || item.state === 'error') await runUpload(item.id);
    }
  };
  const pauseUpload = (itemId: string) => uploadControllers.current.get(itemId)?.abort();
  const cancelUpload = async (itemId: string) => {
    uploadControllers.current.get(itemId)?.abort();
    const item = uploadItemsRef.current.find((candidate) => candidate.id === itemId);
    updateUploadItems((current) => current.map((candidate) => candidate.id === itemId ? { ...candidate, state: 'cancelled' } : candidate));
    if (item?.intentId) await client.assets.cancelUpload(workspaceId, item.intentId).catch(() => undefined);
  };
  const rebind = useMutation({
    mutationFn: ({ generationId, assetId }: { generationId: string; assetId: string }) => client.billing.rebindExternalResult(workspaceId, generationId, { assetId, note: t.rebindNote }),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: assetsKey }); },
  });
  const dismissUpload = () => {
    if (uploadItemsRef.current.some((item) => item.state === 'uploading')) return;
    setUploadOpen(false);
    uploadItemsRef.current = [];
    setUploadItems([]);
    if (picker.current) picker.current.value = '';
  };
  const uploadDialog = useDeliveryDialog(uploadOpen, dismissUpload);
  const assetDialog = useDeliveryDialog(selected !== undefined, () => setSelectedId(null));
  if (assets.isPending) return <StateBlock variant="loading" title={t.loading} />;
  if (assets.isError) return <StateBlock variant="error" title={t.loadFailed} description={describeError(assets.error).message} action={{ label: messages.common.retry, onClick: () => void assets.refetch() }} />;
  const items = assets.data ?? [];
  const shown = items.filter((asset) => (filter === 'ALL' || assetKind(asset) === filter) && (!search.trim() || `${assetName(asset)} ${asset.assetType} ${originLabel(asset.origin, labels)}`.toLowerCase().includes(search.trim().toLowerCase())));
  return <div className="page" data-testid="quiet-assets">
    <header className="sectionhead mobile-stack"><div><div className="eyebrow mb16">YOUR CREATIVE LIBRARY</div><h1>{t.title}</h1><p>{t.subtitle}</p></div><button type="button" className="btn primary" aria-label={t.upload} onClick={(event) => { uploadDialog.triggerRef.current = event.currentTarget; setUploadOpen(true); }}><QuietIcon name="plus" />{t.upload}</button></header>
    <input ref={picker} type="file" multiple className={styles['hiddenInput']} aria-label={t.chooseFiles} onChange={(event) => chooseFiles(event.target.files)} />
    <div className="row between mt32 mb24" style={{ flexWrap: 'wrap' }}><div className="chips" role="group" aria-label={t.filterGroup}>{filters.map((name) => <button key={name} type="button" className={`chip ${filter === name ? 'active' : ''}`} aria-pressed={filter === name} onClick={() => setFilter(name)}>{labels.filters[name]}</button>)}</div><label className="searchbox"><QuietIcon name="search" /><input aria-label={t.searchAria} placeholder={t.searchPlaceholder} value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
    <section className={`${styles['segmentSearch']} panel pad mb24`} aria-labelledby="segment-search-title">
      <div className={styles['segmentSearchHead']}><div><strong id="segment-search-title">{t.segmentSearchTitle}</strong><p className="small muted mt8">{t.segmentSearchBody}</p></div><form className={styles['segmentSearchForm']} onSubmit={(event) => { event.preventDefault(); setSegmentQuery(segmentDraft.trim()); }}><label className="searchbox"><QuietIcon name="search" /><input aria-label={t.segmentSearchAria} placeholder={t.segmentSearchPlaceholder} value={segmentDraft} onChange={(event) => setSegmentDraft(event.target.value)} /></label><button type="submit" className="btn primary small" disabled={segmentDraft.trim().length < 2}>{t.segmentSearchSubmit}</button></form></div>
      {segmentSearch.isPending && segmentQuery && <p role="status" className="small muted mt16">{t.segmentSearching}</p>}
      {segmentSearch.isError && <p role="alert" className="small mt16" style={{ color: 'var(--bad)' }}>{t.segmentSearchFailed(describeError(segmentSearch.error).message)}</p>}
      {segmentSearch.data?.items.length === 0 && <div className={styles['segmentEmpty']}><strong>{t.segmentEmptyTitle}</strong><span>{t.segmentEmptyBody}</span></div>}
      {(segmentSearch.data?.items.length ?? 0) > 0 && <div className={styles['segmentResults']}>{segmentSearch.data?.items.map((result) => <article key={result.id} className={styles['segmentResult']}><div className="grow"><div className="row gap8" style={{ flexWrap: 'wrap' }}><span className="badge">{labels.searchModalities[result.modality]}</span><span className="small muted">{labels.searchEvidence[result.evidence]}</span></div><strong title={result.label}>{result.label}</strong><span className="small muted">{clockLabel(Number(result.sourceStartPts) * result.timeBase.numerator / result.timeBase.denominator * 1000)}–{clockLabel(Number(result.sourceEndPts) * result.timeBase.numerator / result.timeBase.denominator * 1000)} · {t.referenceOnly}</span></div><div className="row gap8"><button type="button" className="btn small" onClick={(event) => { assetDialog.triggerRef.current = event.currentTarget; setMediaErrorAssetId(null); setPendingSearchResult(result); setSelectedId(result.assetId); }}>{t.playSegment}</button>{projectId && <Link className="btn small primary" href={`/w/${workspaceId}/p/${projectId}/editor`} onClick={() => { try { sessionStorage.setItem(`ancs-media-selection:${workspaceId}:${projectId}`, JSON.stringify(result)); } catch { /* The URL remains a valid editor entry if storage is unavailable. */ } }}>{t.openInEditor}</Link>}</div></article>)}</div>}
    </section>
    {shown.length === 0 ? <div className="panel pad"><StateBlock variant="empty" title={items.length === 0 ? t.emptyTitle : t.noMatchTitle} description={items.length === 0 ? t.emptyBody : t.noMatchBody} /></div> : <div className="asset-grid">{shown.map((asset) => {
      const kind = assetKind(asset);
      return <button key={asset.id} type="button" className="asset-item" aria-label={t.viewAsset(assetName(asset))} aria-describedby={`asset-preview-${asset.id}`} onClick={(event) => { assetDialog.triggerRef.current = event.currentTarget; setMediaErrorAssetId(null); setSelectedId(asset.id); }}><AssetPreview kind={kind} name={assetName(asset)} id={asset.id} /><div className="asset-info"><h3>{assetName(asset)}</h3><p>{originLabel(asset.origin, labels)} · <span>{asset.assetType}</span></p><div className="row between mt16"><span className={`badge ${(asset.license?.type ?? 'UNKNOWN') === 'UNKNOWN' ? 'amber' : 'green'}`}>{licenseLabel(asset, labels)}</span><span className="sample-note">{labels.assetStatuses[asset.status]}</span></div></div></button>;
    })}</div>}
    <div className="notice mt32"><QuietIcon name="shield" /><div>{t.evidenceNotice}</div></div>
    {projectId && <details id="finance-pack" className="panel pad mt24" onToggle={(event) => setFinanceOpen(event.currentTarget.open)}><summary className={styles['summary']}>{t.financeTitle}</summary><p className="small muted mt8">{t.financeBody}</p>{financeOpen && <div className={styles['advanced']}><FinanceWorkspace workspaceId={workspaceId} /></div>}</details>}
    <details className="panel pad mt24" data-testid="external-results" open={(external.data?.length ?? 0) > 0}><summary className={styles['summary']}>{t.externalTitle}</summary><p className="small muted mt8">{t.externalBody}</p>{external.isPending && <p className="small muted mt16">{t.externalLoading}</p>}{external.isError && <p role="alert" className="small muted mt16">{t.externalLoadFailed(describeError(external.error).message)} <button type="button" className="textbtn small" onClick={() => void external.refetch()}>{messages.common.retry}</button></p>}{external.data?.length === 0 && <p className="small muted mt16">{t.externalEmpty}</p>}{(external.data ?? []).map((generation) => <div key={generation.id} className={`${styles['rebindRow']} mt16`} data-testid={`external-result-${generation.id}`}><div><strong>{generation.providerId}</strong><p className="small muted">{t.externalJob(generation.providerJobId ?? generation.id)} · {generation.status}</p></div><select className="field select" aria-label={t.rebindAssetAria(generation.id)} value={rebindIds[generation.id] ?? ''} onChange={(event) => setRebindIds((current) => ({ ...current, [generation.id]: event.target.value }))}><option value="">{t.chooseUploadedAsset}</option>{items.filter((asset) => asset.status === 'READY').map((asset) => <option key={asset.id} value={asset.id}>{assetName(asset)}</option>)}</select><button type="button" className="btn small" disabled={rebind.isPending || !rebindIds[generation.id]} onClick={() => rebind.mutate({ generationId: generation.id, assetId: rebindIds[generation.id] ?? '' })}>{t.rebind}</button></div>)}{rebind.isError && <p role="alert" className="small" style={{ color: 'var(--bad)' }}>{t.rebindFailed(describeError(rebind.error).message)}</p>}</details>
    {uploadOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) dismissUpload(); }}><div ref={uploadDialog.dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title"><div className="row between"><h2 id="upload-title">{u.title}</h2><button type="button" className="btn ghost icononly" aria-label={messages.common.close} disabled={uploadItems.some((item) => item.state === 'uploading')} onClick={dismissUpload}><QuietIcon name="close" /></button></div><p className="small muted mt8">{u.body}</p><button type="button" className={`${styles['dropZone']} mt24`} onClick={() => picker.current?.click()}><QuietIcon name="upload" /><strong>{uploadItems.length > 0 ? u.selectedCount(uploadItems.length) : u.choose}</strong><span className="small muted">{u.limit}</span></button>{uploadItems.length > 0 && <div className={styles['uploadQueue']} aria-label={u.queueAria}>{uploadItems.map((item) => <div key={item.id} className={styles['uploadRow']}><div className={styles['uploadMeta']}><strong title={item.file.name}>{item.file.name}</strong><span className="small muted">{(item.file.size / 1024 / 1024).toFixed(1)} MB · {item.state === 'queued' ? u.queued : item.state === 'uploading' ? u.uploading(item.progress) : item.state === 'paused' ? u.paused(item.progress) : item.state === 'complete' ? item.assetStatus === 'PROCESSING' ? u.analyzing : u.complete : item.state === 'cancelled' ? u.cancelled : u.failed}</span><progress max={100} value={item.progress} aria-label={u.progressAria(item.file.name)} /></div><div className={styles['uploadActions']}>{item.state === 'uploading' && <button type="button" className="textbtn small" onClick={() => pauseUpload(item.id)}>{u.pause}</button>}{(item.state === 'paused' || item.state === 'error') && <button type="button" className="textbtn small" onClick={() => void runUpload(item.id)}>{u.resume}</button>}{!['complete', 'cancelled'].includes(item.state) && <button type="button" className="textbtn small" onClick={() => void cancelUpload(item.id)}>{u.cancel}</button>}</div>{item.error && <p role="alert" className={styles['uploadError']}>{item.error}</p>}</div>)}</div>}<div className="row mt24" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" disabled={uploadItems.some((item) => item.state === 'uploading')} onClick={dismissUpload}>{uploadItems.some((item) => item.state === 'complete') ? u.done : messages.common.close}</button><button type="button" className="btn primary" disabled={uploadItems.length === 0 || uploadItems.every((item) => ['uploading', 'complete', 'cancelled'].includes(item.state))} onClick={() => void startQueuedUploads()}>{u.start}</button></div></div></div>}
    {selected && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}><div ref={assetDialog.dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="asset-title"><div className="row between"><h2 id="asset-title">{assetName(selected)}</h2><button type="button" className="btn ghost icononly" aria-label={messages.common.close} onClick={() => setSelectedId(null)}><QuietIcon name="close" /></button></div><p className="small muted mt8">{selected.assetType} · {labels.assetStatuses[selected.status]} · {originLabel(selected.origin, labels)}</p>{lifecycle.isPending && <div className="panel pad mt24"><p className="small muted">{d.lifecycleLoading}</p></div>}{lifecycle.isError && <p role="alert" className="notice amber mt16">{d.lifecycleFailed(describeError(lifecycle.error).message)} <button type="button" className="textbtn small" onClick={() => void lifecycle.refetch()}>{messages.common.retry}</button></p>}{lifecycle.data && <AssetLifecyclePanel workspaceId={workspaceId} lifecycle={lifecycle.data} onAssetChanged={(next) => { cache.setQueryData(lifecycleKey, next); void cache.invalidateQueries({ queryKey: assetsKey }); }} onAssetDeleted={() => { setSelectedId(null); void cache.invalidateQueries({ queryKey: assetsKey }); void cache.invalidateQueries({ queryKey: ['asset-segment-search', workspaceId] }); }} />}{relinkState.isPending && <div className="panel pad mt16"><p className="small muted">{d.relinkLoading}</p></div>}{relinkState.isError && <p role="alert" className="notice amber mt16">{d.relinkFailed(describeError(relinkState.error).message)} <button type="button" className="textbtn small" onClick={() => void relinkState.refetch()}>{messages.common.retry}</button></p>}{relinkState.data && <AssetRelinkPanel workspaceId={workspaceId} asset={selected} candidates={assets.data ?? []} state={relinkState.data} onApplied={(next) => { cache.setQueryData(relinkKey, next); void cache.invalidateQueries({ queryKey: ['asset-detail', workspaceId, selected.id] }); void cache.invalidateQueries({ queryKey: lifecycleKey }); void cache.invalidateQueries({ queryKey: assetsKey }); }} />}{detail.isError && <p role="alert" className="notice amber mt16">{d.detailFailed(describeError(detail.error).message)} <button type="button" className="textbtn small" onClick={() => void detail.refetch()}>{messages.common.retry}</button></p>}{detail.data && <p className="small muted mt16">{d.versionCount(detail.data.versions.length)} · {currentMimeType ?? d.unknownFormat}</p>}{analysis.isPending && <section className="panel pad mt16" aria-label={d.analysisAria}><p className="small muted">{d.analysisLoading}</p></section>}{analysis.isError && <p role="alert" className="notice amber mt16">{d.analysisFailed(describeError(analysis.error).message)} <button type="button" className="textbtn small" onClick={() => void analysis.refetch()}>{messages.common.retry}</button></p>}{analysis.data && <details className="panel pad mt16" open={analysis.data.stages.some((stage) => ['FAILED', 'STALE', 'CANCEL_REQUESTED'].includes(stage.status))}><summary className={styles['summary']}>{d.analysisSummary(analysis.data.deterministicEditingReady ? d.analysisEditable : analysis.data.playable ? d.analysisPlayable : d.analysisPreparing)}</summary><p className="small muted mt8">{d.analysisBody}</p><div className={styles['analysisStages']}>{analysis.data.stages.map((stage) => <div key={stage.stage} className={styles['analysisStage']}><div><strong>{labels.analysisStages[stage.stage]}</strong><span className="small muted">{labels.analysisStatuses[stage.status]}{stage.status === 'PARTIAL' ? ` · ${String(Math.round(stage.coveragePermille / 10))}%` : ''}</span></div><div className="row">{['FAILED', 'STALE', 'CANCELLED'].includes(stage.status) && ['PROXY', 'WAVEFORM', 'SHOT', 'ASR', 'SAMPLING', 'VISION', 'AUDIO'].includes(stage.stage) && <button type="button" className="textbtn small" disabled={rebuildAnalysis.isPending} onClick={() => rebuildAnalysis.mutate(stage.stage)}>{d.retryStage}</button>}{['QUEUED', 'RUNNING', 'PARTIAL'].includes(stage.status) && <button type="button" className="textbtn small" disabled={cancelAnalysis.isPending} onClick={() => cancelAnalysis.mutate(stage.stage)}>{d.cancel}</button>}<span className={`badge ${stage.status === 'READY' || stage.status === 'EMPTY' ? 'green' : stage.status === 'FAILED' ? 'amber' : ''}`}>{labels.analysisStatuses[stage.status]}</span></div>{stage.errorSummary && <p role="alert" className="small">{stage.errorSummary}</p>}</div>)}</div>{(rebuildAnalysis.isError || cancelAnalysis.isError) && <p role="alert" className="notice amber mt8">{describeError(rebuildAnalysis.error ?? cancelAnalysis.error).message}</p>}</details>}{currentVersion?.probeStatus && currentVersion.probeStatus !== 'NOT_REQUIRED' && <section className={`${styles['capabilityPanel']} panel pad mt16`} aria-label={d.capabilityTitle}><div className="row between"><strong>{d.capabilityTitle}</strong><span className={`badge ${currentVersion.probeStatus === 'READY' ? 'green' : currentVersion.probeStatus === 'FAILED' ? 'amber' : ''}`}>{currentVersion.probeStatus === 'PENDING' ? d.probePending : currentVersion.probeStatus === 'PROCESSING' ? d.probeProcessing : currentVersion.probeStatus === 'READY' ? d.probeReady : d.probeFailed}</span></div>{currentVersion.mediaProbe ? <><div className={styles['capabilityGrid']}><span>{d.capabilityUpload}<strong>{labels.capabilities[currentVersion.mediaProbe.capabilities.upload]}</strong></span><span>{d.capabilityDecode}<strong>{labels.capabilities[currentVersion.mediaProbe.capabilities.decode]}</strong></span><span>{d.capabilityPreview}<strong>{labels.capabilities[currentVersion.mediaProbe.capabilities.preview]}</strong></span><span>{d.capabilityExport}<strong>{labels.capabilities[currentVersion.mediaProbe.capabilities.export]}</strong></span></div>{currentVersion.mediaProbe.streams.map((stream) => <p className="small muted mt8" key={stream.index}>{stream.type === 'VIDEO' ? labels.video : stream.type === 'AUDIO' ? labels.audio : stream.type} #{stream.index} · {stream.codecName ?? labels.unknownCodec}{stream.type === 'VIDEO' ? ` · ${String(stream.width ?? '?')}×${String(stream.height ?? '?')} · ${rationalLabel(stream.averageFrameRate, labels.unknown)} · ${stream.cadence}` : ''}{stream.type === 'AUDIO' ? ` · ${String(stream.sampleRate ?? '?')} Hz · ${labels.channels(String(stream.channels ?? '?'))}` : ''}</p>)}{currentVersion.mediaProbe.capabilities.reasons.map((reason) => <p className="small mt8" key={reason.code}>{reason.message}{reason.nextAction ? ` ${reason.nextAction}` : ''}</p>)}</> : <p className="small muted mt8">{d.probeInProgress}</p>}</section>}{currentVersion?.probeStatus === 'READY' && <section className="panel pad mt16" aria-label={d.proxyTitle}><div className="row between"><strong>{d.proxyTitle}</strong><span className={`badge ${playback.data?.proxyStatus === 'READY' ? 'green' : playback.data?.proxyStatus === 'FAILED' || playback.data?.proxyStatus === 'MISSING' ? 'amber' : ''}`}>{playback.isPending ? d.statusReading : playback.data?.proxyStatus === 'READY' ? d.statusReady : playback.data?.proxyStatus === 'FAILED' ? d.statusFailed : playback.data?.proxyStatus === 'MISSING' ? d.proxyMissing : playback.data?.proxyStatus === 'NOT_REQUIRED' ? d.proxyNotCreated : d.statusGenerating}</span></div><p className="small muted mt8">{playback.data?.message ?? (playback.data?.rendition === 'PROXY' ? d.proxyInUse : d.proxyKeepsFacts)}</p>{playback.data?.timeMappings.map((mapping) => <p key={`${mapping.streamType}-${String(mapping.sourceStreamIndex)}`} className="small muted mt8">{d.ptsMapping(mapping.streamType === 'VIDEO' ? labels.video : labels.audio)} · {mapping.sourceTimeBase.numerator}/{mapping.sourceTimeBase.denominator} → {mapping.proxyTimeBase.numerator}/{mapping.proxyTimeBase.denominator}</p>)}{(playback.data?.proxyStatus === 'FAILED' || playback.data?.proxyStatus === 'MISSING' || playback.data?.proxyStatus === 'NOT_REQUIRED') && <button type="button" className="btn small mt16" disabled={rebuildProxy.isPending} onClick={() => rebuildProxy.mutate()}>{rebuildProxy.isPending ? d.submitting : playback.data?.proxyStatus === 'NOT_REQUIRED' ? d.createProxy : d.rebuildProxy}</button>}{rebuildProxy.isError && <p role="alert" className="small mt8" style={{ color: 'var(--bad)' }}>{describeError(rebuildProxy.error).message}</p>}</section>}{previewUrl && previewMimeType?.startsWith('video/') && <div className={styles['assetMediaPreview']}><video ref={(node) => { mediaRef.current = node; }} key={`${selected.id}-${playback.data?.rendition ?? 'legacy'}`} controls preload="metadata" playsInline src={previewUrl} aria-label={d.previewVideoAria(assetName(selected))} onTimeUpdate={stopAtIndexRangeEnd} onError={() => setMediaErrorAssetId(selected.id)} onLoadedMetadata={() => setMediaErrorAssetId(null)} /></div>}{previewUrl && previewMimeType?.startsWith('audio/') && <div className={styles['assetMediaPreview']}><audio ref={(node) => { mediaRef.current = node; }} key={`${selected.id}-${playback.data?.rendition ?? 'legacy'}`} controls preload="metadata" src={previewUrl} aria-label={d.previewAudioAria(assetName(selected))} onTimeUpdate={stopAtIndexRangeEnd} onError={() => setMediaErrorAssetId(selected.id)} onLoadedMetadata={() => setMediaErrorAssetId(null)} /></div>}{mediaErrorAssetId === selected.id && <p role="alert" className="small muted mt16">{d.previewFailed}</p>}<section className={`${styles['mediaIndex']} panel pad mt16`} aria-label={d.indexTitle}>
  <div className="row between" style={{ flexWrap: 'wrap' }}><div><strong>{d.indexTitle}</strong><p className="small muted mt8">{d.indexBody}</p></div><span className={`badge ${mediaIndex.data?.status === 'READY' ? 'green' : mediaIndex.data?.status === 'FAILED' ? 'amber' : ''}`}>{mediaIndex.isPending ? d.statusReading : mediaIndex.data?.status === 'READY' ? d.statusReady : mediaIndex.data?.status === 'FAILED' ? d.statusFailed : mediaIndex.data?.status === 'EMPTY' ? d.indexEmptyBadge : d.statusGenerating}</span></div>
  <div className={`${styles['indexTabs']} mt16`} role="tablist" aria-label={d.indexTabsAria}>{(Object.keys(labels.indexKinds) as Array<keyof typeof labels.indexKinds>).map((kind) => <button key={kind} type="button" role="tab" aria-selected={indexKind === kind} className={`chip ${indexKind === kind ? 'active' : ''}`} onClick={() => { setIndexKind(kind); setIndexCursor(undefined); }}>{labels.indexKinds[kind]}</button>)}</div>
  {mediaIndex.isError && <p role="alert" className="small mt16" style={{ color: 'var(--bad)' }}>{d.indexReadFailed(describeError(mediaIndex.error).message)}</p>}
  {mediaIndex.data?.status === 'FAILED' && <div className="notice amber mt16"><div><strong>{d.indexGenerationFailed}</strong><p className="small mt8">{mediaIndex.data.errorSummary ?? d.indexFallback}</p><button type="button" className="btn small mt16" disabled={rebuildIndex.isPending} onClick={() => rebuildIndex.mutate()}>{rebuildIndex.isPending ? d.submitting : d.rebuildIndex}</button></div></div>}
  {mediaIndex.data?.items.length === 0 && mediaIndex.data.status !== 'FAILED' && <p className="small muted mt16">{['QUEUED', 'RUNNING', 'PARTIAL'].includes(mediaIndex.data.status) ? d.indexAnalyzing : d.indexNoResults}</p>}
  {(mediaIndex.data?.items.length ?? 0) > 0 && <div className={styles['indexGrid']}>{mediaIndex.data?.items.map((entry) => <button key={entry.id} type="button" className={styles['indexItem']} onClick={() => playIndexRange(entry)} aria-label={d.playIndexRange(labels.indexKinds[entry.kind], clockLabel(entry.payload['sourceStartMs']), clockLabel(entry.payload['sourceEndMs']))}>
    {entry.kind === 'THUMBNAIL' && entry.previewUrl ? <img src={entry.previewUrl} alt="" /> : null}
    {entry.kind === 'WAVEFORM' ? <span className={styles['waveform']} aria-hidden="true">{(Array.isArray(entry.payload['peaks']) ? entry.payload['peaks'] as number[] : []).filter((_, index) => index % 8 === 0).map((peak, index) => <i key={index} style={{ height: `${String(Math.max(2, Math.round(peak / 35)))}px` }} />)}</span> : null}
    {entry.kind === 'SHOT' ? <span className={styles['indexGlyph']}><QuietIcon name="film" /></span> : null}
    {entry.kind === 'QUALITY' ? <span className={styles['indexGlyph']}><QuietIcon name="info" /></span> : null}
    <span><strong>{entry.kind === 'SHOT' ? d.shotNumber(entry.ordinal + 1) : entry.kind === 'QUALITY' ? (entry.payload['marker'] === 'SILENCE' ? d.silenceRange : d.blackRange) : labels.indexKinds[entry.kind]}</strong><small>{clockLabel(entry.payload['sourceStartMs'])}–{clockLabel(entry.payload['sourceEndMs'])}</small></span>
  </button>)}</div>}
  {mediaIndex.data && (indexCursor !== undefined || mediaIndex.data.nextCursor !== null) && <div className="row between mt16"><button type="button" className="textbtn small" disabled={indexCursor === undefined} onClick={() => setIndexCursor(undefined)}>{d.firstPage}</button><button type="button" className="textbtn small" disabled={mediaIndex.data.nextCursor === null} onClick={() => setIndexCursor(mediaIndex.data?.nextCursor ?? undefined)}>{d.nextPage}</button></div>}
</section>{hasAudio && <section className={`${styles['transcriptPanel']} panel pad mt16`} aria-label={d.transcriptTitle}>
  <div className="row between" style={{ flexWrap: 'wrap' }}><div><strong>{d.transcriptTitle}</strong><p className="small muted mt8">{d.transcriptBody}</p></div><span className={`badge ${transcript.data?.status === 'READY' ? 'green' : transcript.data?.status === 'FAILED' ? 'amber' : ''}`}>{transcript.isPending ? d.statusReading : transcript.data?.status === 'READY' ? d.transcriptVersion(transcript.data.currentVersion?.version ?? 0) : transcript.data?.status === 'FAILED' ? d.transcriptNeedsAttention : transcript.data?.status === 'RUNNING' ? d.transcriptRecognizing : d.transcriptWaiting}</span></div>
  {transcript.isError && <p role="alert" className="small mt16" style={{ color: 'var(--bad)' }}>{d.transcriptReadFailed(describeError(transcript.error).message)}</p>}
  {transcript.data?.status === 'FAILED' && <div className="notice amber mt16"><div><strong>{d.transcriptUnavailable}</strong><p className="small mt8">{transcript.data.errorSummary ?? d.transcriptFallback}</p><button type="button" className="btn small mt16" disabled={retryTranscript.isPending} onClick={() => retryTranscript.mutate()}>{retryTranscript.isPending ? d.submitting : d.retryAfterConfig}</button></div></div>}
  {transcript.data?.status === null && <div className="mt16"><p className="small muted">{d.transcriptNone}</p><button type="button" className="btn small mt8" disabled={retryTranscript.isPending} onClick={() => retryTranscript.mutate()}>{retryTranscript.isPending ? d.submitting : d.startTranscript}</button></div>}
  {retryTranscript.isError && <p role="alert" className="small mt8" style={{ color: 'var(--bad)' }}>{describeError(retryTranscript.error).message}</p>}
  {['QUEUED', 'RUNNING'].includes(transcript.data?.status ?? '') && <p role="status" className="small muted mt16">{d.transcriptRunning}</p>}
  {transcript.data?.currentVersion && <><div className={styles['transcriptMeta']}><span>{transcript.data.currentVersion.source === 'ASR' ? d.transcriptAsr : d.transcriptManual}</span><span>{transcript.data.currentVersion.language}</span><span>{transcript.data.currentVersion.provider} / {transcript.data.currentVersion.model}</span></div><div className={styles['transcriptList']}>{transcript.data.currentVersion.segments.map((segment) => {
    const speaker = transcript.data.currentVersion?.speakers.find((candidate) => candidate.id === segment.speakerId);
    const editing = editingTranscriptSegmentId === segment.id;
    return <article key={segment.id} className={styles['transcriptSegment']}><button type="button" className={styles['transcriptTime']} onClick={() => playTranscriptRange(segment)} aria-label={d.playTranscriptAria(clockLabel(Number(segment.sourceStartPts) * segment.timeBase.numerator / segment.timeBase.denominator * 1000))}><QuietIcon name="play" />{clockLabel(Number(segment.sourceStartPts) * segment.timeBase.numerator / segment.timeBase.denominator * 1000)}</button><div><span className="small muted">{speaker?.displayName ?? d.unknownSpeaker} · {segment.reviewState === 'CORRECTED' ? d.segmentCorrected : d.segmentAsr}</span>{editing ? <><textarea className={styles['transcriptEditor']} rows={3} value={transcriptDraft} onChange={(event) => setTranscriptDraft(event.target.value)} aria-label={d.correctAria} /><div className="row mt8"><button type="button" className="btn small primary" disabled={!transcriptDraft.trim() || correctSegment.isPending} onClick={() => correctSegment.mutate({ segmentId: segment.id, text: transcriptDraft.trim() })}>{d.saveCorrection}</button><button type="button" className="btn ghost small" onClick={() => { setEditingTranscriptSegmentId(null); setTranscriptDraft(''); }}>{d.cancel}</button></div></> : <button type="button" className={styles['transcriptText']} onClick={() => { setEditingTranscriptSegmentId(segment.id); setTranscriptDraft(segment.text); }}>{segment.text}</button>}</div></article>;
  })}</div>{correctSegment.isError && <p role="alert" className="small mt8" style={{ color: 'var(--bad)' }}>{d.correctionFailed(describeError(correctSegment.error).message)}</p>}<details className="mt16"><summary className={styles['summary']}>{d.terminologyTitle}</summary><p className="small muted mt8">{d.terminologyBody}</p><textarea className={styles['terminologyEditor']} rows={4} value={terminologyDraft ?? transcript.data.currentVersion.terminology.map((entry) => `${entry.source}=${entry.preferred}`).join('\n')} onChange={(event) => setTerminologyDraft(event.target.value)} aria-label={d.terminologyAria} /><button type="button" className="btn small mt8" disabled={updateTerminology.isPending} onClick={() => updateTerminology.mutate()}>{updateTerminology.isPending ? d.saving : d.saveTerminology}</button>{updateTerminology.isError && <p role="alert" className="small mt8" style={{ color: 'var(--bad)' }}>{describeError(updateTerminology.error).message}</p>}</details></>}
</section>}{currentVersion?.probeStatus === 'READY' && <section className={`${styles['rangeTags']} panel pad mt16`} aria-label={d.rangeTagsTitle}><div><strong>{d.rangeTagsTitle}</strong><p className="small muted mt8">{d.rangeTagsBody}</p></div><div className={styles['rangeTagForm']}><label><span className="label">{d.tagLabel}</span><input className="field" aria-label={d.tagNameAria} placeholder={d.tagPlaceholder} value={tagLabel} onChange={(event) => setTagLabel(event.target.value)} /></label><label><span className="label">{d.tagStart}</span><input className="field" aria-label={d.tagStartAria} type="number" min="0" step="0.001" value={tagStartSeconds} onChange={(event) => setTagStartSeconds(event.target.value)} /></label><label><span className="label">{d.tagEnd}</span><input className="field" aria-label={d.tagEndAria} type="number" min="0" step="0.001" value={tagEndSeconds} onChange={(event) => setTagEndSeconds(event.target.value)} /></label><button type="button" className="btn small" disabled={createRangeTag.isPending || !tagLabel.trim() || !Number.isFinite(Number(tagStartSeconds)) || !Number.isFinite(Number(tagEndSeconds)) || Number(tagEndSeconds) <= Number(tagStartSeconds)} onClick={() => createRangeTag.mutate()}>{createRangeTag.isPending ? d.addingTag : d.addTag}</button></div>{rangeTags.isPending && <p role="status" className="small muted mt16">{d.tagsLoading}</p>}{rangeTags.isError && <p role="alert" className="small mt16" style={{ color: 'var(--bad)' }}>{d.tagsReadFailed(describeError(rangeTags.error).message)}</p>}{createRangeTag.isError && <p role="alert" className="small mt8" style={{ color: 'var(--bad)' }}>{d.tagAddFailed(describeError(createRangeTag.error).message)}</p>}{rangeTags.data?.items.length === 0 && <p className="small muted mt16">{d.tagsEmpty}</p>}{(rangeTags.data?.items.length ?? 0) > 0 && <div className={styles['rangeTagList']}>{rangeTags.data?.items.map((tag) => <div key={tag.id} className={styles['rangeTagItem']}><div className="grow"><strong>{tag.label}</strong><span className="small muted">{clockLabel(Number(tag.sourceStartPts) * tag.timeBase.numerator / tag.timeBase.denominator * 1000)}–{clockLabel(Number(tag.sourceEndPts) * tag.timeBase.numerator / tag.timeBase.denominator * 1000)}</span></div><button type="button" className="textbtn small" disabled={deleteRangeTag.isPending} onClick={() => deleteRangeTag.mutate(tag.id)}>{d.deleteTag}</button></div>)}</div>}</section>}<div className="row mt24" style={{ flexWrap: 'wrap' }}>{signedDownloadUrl && <a className="btn" href={signedDownloadUrl} target="_blank" rel="noopener noreferrer"><QuietIcon name="download" />{d.downloadOriginal}</a>}{selected.status === 'READY' && (selected.projectId ?? projectId) && <Link className="btn" href={`/w/${workspaceId}/p/${selected.projectId ?? projectId}/storyboard`}>{d.openStoryboard}</Link>}</div>{!signedDownloadUrl && !download.isError && !download.isPending && <p role="status" className="small muted mt16">{d.downloadExpired}<button type="button" className="textbtn small" onClick={() => void download.refetch()}>{d.refreshLink}</button></p>}{download.isError && <p role="alert" className="small" style={{ color: 'var(--bad)' }}>{d.downloadUnavailable(describeError(download.error).message)} <button type="button" className="textbtn small" onClick={() => void download.refetch()}>{messages.common.retry}</button></p>}</div></div>}
  </div>;
}
