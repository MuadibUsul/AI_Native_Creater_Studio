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
import { useDeliveryDialog } from './delivery-dialog';
import styles from './delivery.module.css';

type Filter = '全部素材' | '图片' | '图表' | '声音' | '文档' | '视频';
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
const filters: Filter[] = ['全部素材', '图片', '图表', '声音', '文档', '视频'];
const analysisStageLabels: Record<MediaAnalysisStageName, string> = { PROBE: '媒体探测', PROXY: '编辑代理', WAVEFORM: '波形', ASR: '语音识别', SHOT: '镜头检测', SAMPLING: '采样', VISION: '视觉理解', OCR: '画面文字', AUDIO: '音频事件', EMBEDDINGS: '语义向量', SEARCH_INDEX: '检索索引' };
const analysisStatusLabels = { NOT_REQUESTED: '尚未请求', QUEUED: '排队中', RUNNING: '处理中', PARTIAL: '部分完成', READY: '已就绪', EMPTY: '无结果', FAILED: '失败', DISABLED: '未启用', STALE: '等待重建', CANCEL_REQUESTED: '取消中', CANCELLED: '已取消' } as const;
function assetKind(asset: Asset): Filter {
  const mimeType = typeof asset.metadata?.['mimeType'] === 'string' ? asset.metadata['mimeType'] : '';
  if (mimeType.startsWith('image/')) return '图片';
  if (mimeType.startsWith('audio/')) return '声音';
  if (mimeType.startsWith('video/')) return '视频';
  if (['SOURCE_IMAGE', 'GENERATED_IMAGE', 'THUMBNAIL'].includes(asset.assetType)) return '图片';
  if (['CHART_RENDER', 'CUSTOM_MOTION_RENDER'].includes(asset.assetType)) return '图表';
  if (['VOICE_AUDIO', 'MUSIC'].includes(asset.assetType)) return '声音';
  if (['SOURCE_DOCUMENT', 'SUBTITLE', 'MANIFEST'].includes(asset.assetType)) return '文档';
  if (['AVATAR_CLIP', 'GENERATED_VIDEO', 'DRAFT_RENDER', 'FINAL_VIDEO', 'SHORT_VIDEO'].includes(asset.assetType)) return '视频';
  return '全部素材';
}
function assetName(asset: Asset): string {
  for (const key of ['filename', 'name', 'title']) {
    const value = asset.metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return `${asset.assetType.replaceAll('_', ' ')} · ${asset.id.slice(0, 8)}`;
}
const originLabels: Partial<Record<Asset['origin'], string>> = {
  USER_UPLOAD: '用户上传', USER_LIBRARY: '用户素材库', SOURCE_DOCUMENT: '来源文件', LICENSED_STOCK: '授权素材', PUBLIC_SOURCE: '公开来源', GENERATED: 'AI 生成', PROVIDER_IMPORT: '平台导入', SOURCE_IMPORT: '来源导入', PROVIDER_GENERATED: '平台生成', SYSTEM_RENDER: '系统渲染',
};
const assetStatusLabels: Record<Asset['status'], string> = {
  PENDING_UPLOAD: '等待上传',
  PROCESSING: '正在分析',
  READY: '可用',
  FAILED: '需要处理',
  DELETED: '已删除',
};
function licenseLabel(asset: Asset): string {
  return { USER_OWNED: '用户自有', LICENSED: '已有许可', PUBLIC_DOMAIN: '公有领域', PROVIDER_TERMS: '平台条款', UNKNOWN: '授权未确认' }[asset.license?.type ?? 'UNKNOWN'];
}
function uploadAssetType(file: File): 'SOURCE_IMAGE' | 'VOICE_AUDIO' | 'USER_UPLOAD' {
  return file.type.startsWith('image/') ? 'SOURCE_IMAGE' : file.type.startsWith('audio/') ? 'VOICE_AUDIO' : 'USER_UPLOAD';
}

const capabilityLabels = {
  AVAILABLE: '可直接使用',
  PROXY_REQUIRED: '需要预览代理',
  TRANSCODE_REQUIRED: '导出时转码',
  UNAVAILABLE: '不可用',
  UNKNOWN: '等待判断',
} as const;

function rationalLabel(value: { numerator: number; denominator: number } | null): string {
  return value === null ? '未知' : `${String(value.numerator)}/${String(value.denominator)}`;
}

function clockLabel(value: unknown): string {
  const totalMilliseconds = Math.max(0, Math.round(typeof value === 'number' && Number.isFinite(value) ? value : 0));
  const seconds = Math.floor(totalMilliseconds / 1000);
  const wholeSeconds = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const remainder = totalMilliseconds % 1000;
  return remainder === 0 ? wholeSeconds : `${wholeSeconds}.${String(remainder).padStart(3, '0')}`;
}

const indexKindLabels = { THUMBNAIL: '缩略', WAVEFORM: '波形', SHOT: '镜头', QUALITY: '质量' } as const;
const searchModalityLabels = { VISUAL: '画面', AUDIO: '声音', TRANSCRIPT: '转写', USER_TAG: '用户标签' } as const;
const searchEvidenceLabels = { OBSERVATION: '媒体观测', INFERENCE: '机器推测', USER_ASSERTED: '用户标记' } as const;

function AssetPreview({ kind, name, id }: { kind: Filter; name: string; id: string }) {
  const art = [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 5;
  return <div className={`cover ${styles['assetPreview']}`} data-preview-kind={kind}>
    {kind === '图片' ? <><div className={`cover-art art-${art}`} aria-hidden="true" /><span className={`cover-title ${styles['previewTitle']}`}>{name}</span></> : null}
    {kind === '图表' ? <div className="asset-chart" aria-hidden="true">{[26, 45, 62, 87, 105].map((height) => <i key={height} style={{ height }} />)}</div> : null}
    {kind === '声音' ? <div className="asset-sound" aria-hidden="true"><div className="wave">{Array.from({ length: 32 }, (_, index) => <span key={index} style={{ height: `${Math.round(4 + (Math.sin(index * 2.4) + 1) * 6 + (Math.sin(index * .83) + 1) * 3)}px` }} />)}</div></div> : null}
    {kind === '文档' ? <div className="asset-doc" aria-hidden="true"><div className="document-mini">{Array.from({ length: 8 }, (_, index) => <i key={index} />)}</div></div> : null}
    {(kind === '视频' || kind === '全部素材') ? <div className={styles['genericPreview']} aria-hidden="true"><QuietIcon name={kind === '视频' ? 'film' : 'image'} /></div> : null}
    <span id={`asset-preview-${id}`} className={styles['previewDisclosure']}>{kind === '图表' ? '无数值示意 · 非事实图表' : '示意 · 非资产原图'}</span>
  </div>;
}

const permittedUseLabels = { EDIT: '编辑', PUBLISH: '发布', COMMERCIAL: '商业使用', AI_ANALYSIS: 'AI 分析', MODEL_TRAINING: '模型训练' } as const;
const sensitivityLabels = { PUBLIC: '公开', INTERNAL: '内部', SENSITIVE: '敏感', RESTRICTED: '受限' } as const;
const licenseStateLabels = { ACTIVE: '许可有效', EXPIRED: '许可已到期', PUBLISH_NOT_PERMITTED: '不允许发布', UNCONFIRMED: '权利未确认' } as const;

function AssetLifecyclePanel({ workspaceId, lifecycle, onAssetChanged, onAssetDeleted }: { workspaceId: string; lifecycle: AssetLifecycle; onAssetChanged: (next: AssetLifecycle) => void; onAssetDeleted: () => void }) {
  const client = useAncsClient();
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
      if (reference.kind !== 'SCENE' || reference.sceneId === null || reference.sceneRevision === null || reference.role === null) throw new Error('冻结版本引用不可直接移除');
      return client.projects.edit(reference.projectId, {
        baseProjectRevision: reference.projectRevision,
        expectedSceneRevisions: { [reference.sceneId]: reference.sceneRevision },
        operations: [{ op: 'replace_asset', sceneId: reference.sceneId, role: reference.role, newAssetId: null }],
        idempotencyKey: `idem_asset_unlink_${reference.sceneId}_${String(reference.sceneRevision)}_${Date.now()}`,
        intent: '从当前场景移除素材引用',
      });
    },
    onSuccess: async () => onAssetChanged(await client.assets.lifecycle(workspaceId, lifecycle.asset.id)),
  });
  const trash = useMutation({ mutationFn: () => client.assets.delete(workspaceId, lifecycle.asset.id), onSuccess: onAssetDeleted });
  const privacy = useMutation({
    mutationFn: () => client.assets.requestPrivacyDeletion(workspaceId, lifecycle.asset.id, { confirmationAssetId: privacyConfirmation.trim(), reason: privacyReason.trim() }),
    onSuccess: (result) => {
      setPrivacyResult(result.status === 'SCHEDULED' ? '隐私删除已排入清理；无引用时将立即清除原件。' : `仍有 ${String(result.missingDependencies.length)} 项依赖，原件会保留到依赖解除。`);
      setPrivacyOpen(false);
    },
  });
  const updateText = (key: 'holder' | 'attribution' | 'sourceUrl' | 'termsUrl' | 'notes', value: string) => setDraft((current) => ({ ...current, [key]: value.trim().length === 0 ? null : value }));
  return <section className={`${styles['rightsPanel']} panel pad mt24`} aria-label="来源、许可与媒体生命周期">
    <div className="row between"><div><strong>来源、许可与生命周期</strong><p className="small muted mt8">权利状态会在新发布和导出前重新检查。</p></div><span className={`badge ${lifecycle.licenseState === 'ACTIVE' ? 'green' : 'amber'}`}>{licenseStateLabels[lifecycle.licenseState]}</span></div>
    {!editing ? <>
      <dl className={styles['rightsSummary']}><div><dt>来源</dt><dd>{licenseLabel(lifecycle.asset)}</dd></div><div><dt>允许用途</dt><dd>{initial.permittedUses.length ? initial.permittedUses.map((use) => permittedUseLabels[use]).join('、') : '未授予用途'}</dd></div><div><dt>敏感级别</dt><dd>{sensitivityLabels[lifecycle.asset.sensitivityClass]}</dd></div><div><dt>许可期限</dt><dd>{initial.expiresAt ? new Date(initial.expiresAt).toLocaleString('zh-CN') : '未设置期限'}</dd></div></dl>
      {initial.attribution && <p className="small muted mt8">署名：{initial.attribution}</p>}
      <button type="button" className="btn small mt16" onClick={() => setEditing(true)}>编辑来源与许可</button>
    </> : <form className={styles['rightsForm']} onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <label className="label">权利类型<select className="field select" value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as UpdateAssetRightsRequest['type'], userOwnedDeclared: event.target.value === 'USER_OWNED' }))}><option value="USER_OWNED">用户自有</option><option value="LICENSED">已有许可</option><option value="PUBLIC_DOMAIN">公有领域</option><option value="PROVIDER_TERMS">平台条款</option><option value="UNKNOWN">尚未确认</option></select></label>
      <label className="label">权利人<input className="field" value={draft.holder ?? ''} onChange={(event) => updateText('holder', event.target.value)} /></label>
      <label className="label">署名文本<input className="field" value={draft.attribution ?? ''} onChange={(event) => updateText('attribution', event.target.value)} /></label>
      <label className="label">来源网址<input className="field" type="url" value={draft.sourceUrl ?? ''} onChange={(event) => updateText('sourceUrl', event.target.value)} /></label>
      <label className="label">许可条款网址<input className="field" type="url" value={draft.termsUrl ?? ''} onChange={(event) => updateText('termsUrl', event.target.value)} /></label>
      <label className="label">许可到期时间<input className="field" type="datetime-local" value={draft.expiresAt ? draft.expiresAt.slice(0, 16) : ''} onChange={(event) => setDraft((current) => ({ ...current, expiresAt: event.target.value ? new Date(event.target.value).toISOString() : null }))} /></label>
      <label className="label">敏感级别<select className="field select" value={draft.sensitivityClass} onChange={(event) => setDraft((current) => ({ ...current, sensitivityClass: event.target.value as UpdateAssetRightsRequest['sensitivityClass'] }))}>{Object.entries(sensitivityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <fieldset className={styles['useChoices']}><legend>允许用途</legend>{ASSET_PERMITTED_USES.map((use) => <label className="checkboxrow" key={use}><input type="checkbox" checked={draft.permittedUses.includes(use)} onChange={(event) => setDraft((current) => ({ ...current, permittedUses: event.target.checked ? [...new Set([...current.permittedUses, use])] : current.permittedUses.filter((item) => item !== use) }))} />{permittedUseLabels[use]}</label>)}</fieldset>
      {draft.type === 'USER_OWNED' && <label className="checkboxrow"><input type="checkbox" checked={draft.userOwnedDeclared} onChange={(event) => setDraft((current) => ({ ...current, userOwnedDeclared: event.target.checked }))} />我声明拥有该素材，或有权代表权利人管理上述用途</label>}
      <label className="label">备注<textarea className="field" rows={3} value={draft.notes ?? ''} onChange={(event) => updateText('notes', event.target.value)} /></label>
      {save.isError && <p className="notice amber" role="alert">保存失败：{describeError(save.error).message}</p>}
      <div className="row"><button className="btn" type="button" onClick={() => setEditing(false)}>取消</button><button className="btn primary" type="submit" disabled={save.isPending || (draft.type === 'USER_OWNED' && !draft.userOwnedDeclared)}>{save.isPending ? '保存中…' : '保存许可'}</button></div>
    </form>}
    <div className={styles['lifecycleSection']}><div className="row between"><strong>引用与派生</strong><span className="small muted">{lifecycle.gcProtected ? '原件受保护' : '没有阻止清理的依赖'}</span></div>
      {lifecycle.references.length === 0 && lifecycle.derivations.length === 0 ? <p className="small muted mt8">当前没有场景、冻结版本或派生产物引用。</p> : null}
      {lifecycle.references.map((reference) => <div className={styles['referenceRow']} key={`${reference.kind}-${reference.sceneId ?? reference.projectVersionId}`}><div><strong>{reference.kind === 'SCENE' ? `${reference.projectTitle} · 当前场景` : `${reference.projectTitle} · 冻结版本 ${String(reference.versionNumber)}`}</strong><span>{reference.kind === 'SCENE' ? `角色 ${reference.role ?? '未知'} · 场景仍在使用` : `${reference.versionReason ?? '历史版本'} · 为恢复与审计保留`}</span></div>{reference.kind === 'SCENE' && <button className="textbtn small" type="button" disabled={removeReference.isPending} onClick={() => removeReference.mutate(reference)}>移除这一处引用</button>}</div>)}
      {lifecycle.derivations.map((edge) => <div className={styles['referenceRow']} key={`${edge.direction}-${edge.relatedAssetVersionId}`}><div><strong>{edge.direction === 'DERIVED' ? '派生产物' : '来源原件'} · {edge.kind}</strong><span>{edge.relatedAssetId}</span></div></div>)}
      {removeReference.isError && <p className="notice amber mt8" role="alert">移除失败：{describeError(removeReference.error).message}</p>}
    </div>
    <details className={styles['dangerDetails']}><summary>删除与隐私</summary><p className="small muted mt8">“删除原件”进入可恢复的废纸篓；“隐私删除”会在依赖解除后清除原始字节，并保留不含素材内容的审计记录。</p><div className="row mt16"><button type="button" className="btn small" disabled={trash.isPending} onClick={() => trash.mutate()}>{trash.isPending ? '正在移入…' : '删除原件到废纸篓'}</button><button type="button" className="btn small" onClick={() => setPrivacyOpen((value) => !value)}>请求隐私删除</button></div>{privacyOpen && <div className={styles['privacyForm']}><label className="label">删除原因<textarea className="field" rows={2} value={privacyReason} onChange={(event) => setPrivacyReason(event.target.value)} /></label><label className="label">输入素材 ID 以确认<input className="field" value={privacyConfirmation} onChange={(event) => setPrivacyConfirmation(event.target.value)} placeholder={lifecycle.asset.id} /></label><button type="button" className="btn primary small" disabled={privacy.isPending || privacyReason.trim().length === 0 || privacyConfirmation.trim() !== lifecycle.asset.id} onClick={() => privacy.mutate()}>{privacy.isPending ? '正在提交…' : '确认隐私删除'}</button></div>}{privacy.isError && <p className="notice amber mt8" role="alert">提交失败：{describeError(privacy.error).message}</p>}{privacyResult && <p className="notice mt8" role="status">{privacyResult}</p>}</details>
  </section>;
}

function trackSummary(tracks: AssetRelinkComparison['tracks']['target']): string {
  if (tracks.length === 0) return '无可比对轨道';
  return tracks.map((track) => track.type === 'VIDEO'
    ? `视频 ${track.codecName ?? '未知编码'} ${track.width ?? '?'}×${track.height ?? '?'}`
    : track.type === 'AUDIO'
      ? `音频 ${track.codecName ?? '未知编码'} ${track.channels ?? '?'} 声道`
      : `${track.type} ${track.codecName ?? '未知编码'}`).join('；');
}

function AssetRelinkPanel({ workspaceId, asset, candidates, state, onApplied }: { workspaceId: string; asset: Asset; candidates: Asset[]; state: AssetRelinkState; onApplied: (state: AssetRelinkState) => void }) {
  const client = useAncsClient();
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
      if (comparison === null) throw new Error('请先校验候选文件');
      return client.assets.applyRelink(workspaceId, asset.id, {
        targetVersionId: comparison.targetVersionId,
        candidateAssetId: comparison.candidateAssetId,
        expectedCandidateChecksumSha256: comparison.candidateChecksumSha256,
        confirmationText: comparison.confirmationText,
      });
    },
    onSuccess: (result) => { onApplied(result.state); setComparison(null); setConfirmation(''); },
  });
  return <section className={`${styles['relinkPanel']} panel pad mt16`} aria-label="原件在线状态与重新链接">
    <div className="row between"><div><strong>原件与重新链接</strong><p className="small muted mt8">按内容校验和识别原件；文件名相同不会自动替换。</p></div><span className={`badge ${missing.length === 0 ? 'green' : 'amber'}`}>{missing.length === 0 ? '原件在线' : `${String(missing.length)} 个版本缺失`}</span></div>
    {missing.length === 0 ? <p className="small muted mt16">所有保留版本均可读取，无需重新链接。</p> : <div className={styles['relinkForm']}>
      <label className="label">缺失版本<select className="field select" value={targetVersionId} onChange={(event) => { setTargetVersionId(event.target.value); setComparison(null); }}>{missing.map((version) => <option key={version.assetVersionId} value={version.assetVersionId}>版本 {String(version.versionNumber)}{version.current ? ' · 当前版本' : ''} · {String(version.activeClipReferences)} 个活动剪辑引用</option>)}</select></label>
      <label className="label">已上传候选素材<select className="field select" value={candidateAssetId} onChange={(event) => { setCandidateAssetId(event.target.value); setComparison(null); }}><option value="">选择候选素材</option>{candidates.filter((candidate) => candidate.id !== asset.id && candidate.status === 'READY').map((candidate) => <option key={candidate.id} value={candidate.id}>{assetName(candidate)}</option>)}</select></label>
      <button type="button" className="btn small" disabled={!targetVersionId || !candidateAssetId || preflight.isPending} onClick={() => preflight.mutate()}>{preflight.isPending ? '正在校验…' : '校验候选文件'}</button>
      {preflight.isError && <p role="alert" className="notice amber">校验失败：{describeError(preflight.error).message}</p>}
      {comparison && <div className={styles['relinkComparison']}>
        <div className="row between"><strong>{comparison.mode === 'EXACT_RESTORE' ? '内容完全一致' : '检测到不同内容'}</strong><span className={`badge ${comparison.mode === 'EXACT_RESTORE' ? 'green' : 'amber'}`}>{comparison.mode === 'EXACT_RESTORE' ? '恢复原版本' : '建立新版本并审阅'}</span></div>
        <dl className={styles['rightsSummary']}><div><dt>校验和</dt><dd>{comparison.checksumMatches ? '一致' : '不同'}</dd></div><div><dt>时长</dt><dd>{comparison.duration.matches ? '一致' : `${comparison.duration.targetMs ?? '未知'} → ${comparison.duration.candidateMs ?? '未知'} ms`}</dd></div><div><dt>轨道</dt><dd>{comparison.tracks.matches ? '一致' : '存在差异'}</dd></div><div><dt>离线引用</dt><dd>保留 {String(comparison.activeClipReferences)} 个</dd></div></dl>
        {!comparison.tracks.matches && <p className="small muted">原轨道：{trackSummary(comparison.tracks.target)}<br />候选轨道：{trackSummary(comparison.tracks.candidate)}</p>}
        <p className="small muted mt8">{comparison.mode === 'EXACT_RESTORE' ? '确认后只恢复缺失对象，版本 ID、裁剪范围和代理关系保持不变。' : '确认后建立新的当前版本；旧离线版本及其剪辑引用保留，相关场景进入待审。'}</p>
        <label className="label mt16">输入“{comparison.confirmationText}”确认<input className="field" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <button type="button" className="btn primary small" disabled={confirmation !== comparison.confirmationText || apply.isPending} onClick={() => apply.mutate()}>{apply.isPending ? '正在应用…' : comparison.confirmationText}</button>
      </div>}
      {apply.isError && <p role="alert" className="notice amber">重新链接失败：{describeError(apply.error).message}</p>}
    </div>}
  </section>;
}

export function DeliveryAssets({ workspaceId, projectId }: { workspaceId: string; projectId?: string }) {
  const client = useAncsClient();
  const cache = useQueryClient();
  const assetsKey = projectId === undefined ? ['workspaces', workspaceId, 'assets'] as const : queryKeys.assets(workspaceId, projectId);
  const assets = useQuery({ queryKey: assetsKey, queryFn: () => client.assets.list(workspaceId, projectId ? { projectId } : undefined) });
  const [filter, setFilter] = useState<Filter>('全部素材');
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
    mutationFn: ({ generationId, assetId }: { generationId: string; assetId: string }) => client.billing.rebindExternalResult(workspaceId, generationId, { assetId, note: '平台外处理完成后回绑' }),
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
  if (assets.isPending) return <StateBlock variant="loading" title="正在加载素材…" />;
  if (assets.isError) return <StateBlock variant="error" title="素材加载失败" description={describeError(assets.error).message} action={{ label: '重试', onClick: () => void assets.refetch() }} />;
  const items = assets.data ?? [];
  const shown = items.filter((asset) => (filter === '全部素材' || assetKind(asset) === filter) && (!search.trim() || `${assetName(asset)} ${asset.assetType} ${originLabels[asset.origin] ?? asset.origin}`.toLowerCase().includes(search.trim().toLowerCase())));
  return <div className="page" data-testid="quiet-assets">
    <header className="sectionhead mobile-stack"><div><div className="eyebrow mb16">YOUR CREATIVE LIBRARY</div><h1>好素材，值得留下。</h1><p>作品、来源与授权，放在同一个地方。</p></div><button type="button" className="btn primary" aria-label="上传素材" onClick={(event) => { uploadDialog.triggerRef.current = event.currentTarget; setUploadOpen(true); }}><QuietIcon name="plus" />上传素材</button></header>
    <input ref={picker} type="file" multiple className={styles['hiddenInput']} aria-label="选择文件" onChange={(event) => chooseFiles(event.target.files)} />
    <div className="row between mt32 mb24" style={{ flexWrap: 'wrap' }}><div className="chips" role="group" aria-label="素材类型筛选">{filters.map((name) => <button key={name} type="button" className={`chip ${filter === name ? 'active' : ''}`} aria-pressed={filter === name} onClick={() => setFilter(name)}>{name}</button>)}</div><label className="searchbox"><QuietIcon name="search" /><input aria-label="搜索素材" placeholder="按名称筛选" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
    <section className={`${styles['segmentSearch']} panel pad mb24`} aria-labelledby="segment-search-title">
      <div className={styles['segmentSearchHead']}><div><strong id="segment-search-title">搜索真实片段</strong><p className="small muted mt8">从画面、声音、转写与用户标签中查找，结果始终回到原素材时间范围。</p></div><form className={styles['segmentSearchForm']} onSubmit={(event) => { event.preventDefault(); setSegmentQuery(segmentDraft.trim()); }}><label className="searchbox"><QuietIcon name="search" /><input aria-label="搜索素材片段" placeholder="例如：产品近景、第二次回答" value={segmentDraft} onChange={(event) => setSegmentDraft(event.target.value)} /></label><button type="submit" className="btn primary small" disabled={segmentDraft.trim().length < 2}>搜索片段</button></form></div>
      {segmentSearch.isPending && segmentQuery && <p role="status" className="small muted mt16">正在查找真实片段…</p>}
      {segmentSearch.isError && <p role="alert" className="small mt16" style={{ color: 'var(--bad)' }}>片段搜索失败：{describeError(segmentSearch.error).message}</p>}
      {segmentSearch.data?.items.length === 0 && <div className={styles['segmentEmpty']}><strong>没有找到真实片段</strong><span>可以换一个说法或先为素材添加片段标签；系统不会生成替代素材。</span></div>}
      {(segmentSearch.data?.items.length ?? 0) > 0 && <div className={styles['segmentResults']}>{segmentSearch.data?.items.map((result) => <article key={result.id} className={styles['segmentResult']}><div className="grow"><div className="row gap8" style={{ flexWrap: 'wrap' }}><span className="badge">{searchModalityLabels[result.modality]}</span><span className="small muted">{searchEvidenceLabels[result.evidence]}</span></div><strong title={result.label}>{result.label}</strong><span className="small muted">{clockLabel(Number(result.sourceStartPts) * result.timeBase.numerator / result.timeBase.denominator * 1000)}–{clockLabel(Number(result.sourceEndPts) * result.timeBase.numerator / result.timeBase.denominator * 1000)} · 内容仅作检索依据</span></div><div className="row gap8"><button type="button" className="btn small" onClick={(event) => { assetDialog.triggerRef.current = event.currentTarget; setMediaErrorAssetId(null); setPendingSearchResult(result); setSelectedId(result.assetId); }}>播放片段</button>{projectId && <Link className="btn small primary" href={`/w/${workspaceId}/p/${projectId}/editor`} onClick={() => { try { sessionStorage.setItem(`ancs-media-selection:${workspaceId}:${projectId}`, JSON.stringify(result)); } catch { /* The URL remains a valid editor entry if storage is unavailable. */ } }}>带到编辑器</Link>}</div></article>)}</div>}
    </section>
    {shown.length === 0 ? <div className="panel pad"><StateBlock variant="empty" title={items.length === 0 ? '还没有资产' : '没有匹配的素材'} description={items.length === 0 ? '上传图片、视频、音频或文件后，可在分镜中绑定。' : '试试其他类型或搜索词。'} /></div> : <div className="asset-grid">{shown.map((asset) => {
      const kind = assetKind(asset);
      return <button key={asset.id} type="button" className="asset-item" aria-label={`查看素材 ${assetName(asset)}`} aria-describedby={`asset-preview-${asset.id}`} onClick={(event) => { assetDialog.triggerRef.current = event.currentTarget; setMediaErrorAssetId(null); setSelectedId(asset.id); }}><AssetPreview kind={kind} name={assetName(asset)} id={asset.id} /><div className="asset-info"><h3>{assetName(asset)}</h3><p>{originLabels[asset.origin] ?? asset.origin} · <span>{asset.assetType}</span></p><div className="row between mt16"><span className={`badge ${(asset.license?.type ?? 'UNKNOWN') === 'UNKNOWN' ? 'amber' : 'green'}`}>{licenseLabel(asset)}</span><span className="sample-note">{assetStatusLabels[asset.status]}</span></div></div></button>;
    })}</div>}
    <div className="notice mt32"><QuietIcon name="shield" /><div>素材可用于创作，不代表可用作事实证据。真实照片、AI 画面与结构示意须分别标记，并核对授权信息。</div></div>
    {projectId && <details id="finance-pack" className="panel pad mt24" onToggle={(event) => setFinanceOpen(event.currentTarget.open)}><summary className={styles['summary']}>Finance 图表素材</summary><p className="small muted mt8">管理当前工作区的数据来源、许可证、单位与版本化模板；产物不会自动绑定到分镜。</p>{financeOpen && <div className={styles['advanced']}><FinanceWorkspace workspaceId={workspaceId} /></div>}</details>}
    <details className="panel pad mt24" data-testid="external-results" open={(external.data?.length ?? 0) > 0}><summary className={styles['summary']}>外部处理产物回绑</summary><p className="small muted mt8">平台外完成的产物先上传，再选择对应任务回绑；此处不会代替 Provider 执行。</p>{external.isPending && <p className="small muted mt16">正在加载任务引用…</p>}{external.isError && <p role="alert" className="small muted mt16">任务引用加载失败：{describeError(external.error).message} <button type="button" className="textbtn small" onClick={() => void external.refetch()}>重试</button></p>}{external.data?.length === 0 && <p className="small muted mt16">没有待回绑的 Provider 任务引用。</p>}{(external.data ?? []).map((generation) => <div key={generation.id} className={`${styles['rebindRow']} mt16`} data-testid={`external-result-${generation.id}`}><div><strong>{generation.providerId}</strong><p className="small muted">任务 {generation.providerJobId ?? generation.id} · {generation.status}</p></div><select className="field select" aria-label={`回绑资产 ${generation.id}`} value={rebindIds[generation.id] ?? ''} onChange={(event) => setRebindIds((current) => ({ ...current, [generation.id]: event.target.value }))}><option value="">选择已上传素材</option>{items.filter((asset) => asset.status === 'READY').map((asset) => <option key={asset.id} value={asset.id}>{assetName(asset)}</option>)}</select><button type="button" className="btn small" disabled={rebind.isPending || !rebindIds[generation.id]} onClick={() => rebind.mutate({ generationId: generation.id, assetId: rebindIds[generation.id] ?? '' })}>回绑</button></div>)}{rebind.isError && <p role="alert" className="small" style={{ color: 'var(--bad)' }}>回绑失败：{describeError(rebind.error).message}</p>}</details>
    {uploadOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) dismissUpload(); }}><div ref={uploadDialog.dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title"><div className="row between"><h2 id="upload-title">上传素材</h2><button type="button" className="btn ghost icononly" aria-label="关闭" disabled={uploadItems.some((item) => item.state === 'uploading')} onClick={dismissUpload}><QuietIcon name="close" /></button></div><p className="small muted mt8">文件按块直传并逐片校验。暂停或断线后，只继续尚未确认的分片。</p><button type="button" className={`${styles['dropZone']} mt24`} onClick={() => picker.current?.click()}><QuietIcon name="upload" /><strong>{uploadItems.length > 0 ? `已选择 ${String(uploadItems.length)} 个文件` : '选择图片、视频、音频或文件'}</strong><span className="small muted">可多选；单个文件最高 5 GiB</span></button>{uploadItems.length > 0 && <div className={styles['uploadQueue']} aria-label="上传队列">{uploadItems.map((item) => <div key={item.id} className={styles['uploadRow']}><div className={styles['uploadMeta']}><strong title={item.file.name}>{item.file.name}</strong><span className="small muted">{(item.file.size / 1024 / 1024).toFixed(1)} MB · {item.state === 'queued' ? '等待上传' : item.state === 'uploading' ? `上传中 ${String(item.progress)}%` : item.state === 'paused' ? `已暂停 ${String(item.progress)}%` : item.state === 'complete' ? item.assetStatus === 'PROCESSING' ? '上传完成 · 正在分析媒体' : '已完成' : item.state === 'cancelled' ? '已取消' : '上传失败'}</span><progress max={100} value={item.progress} aria-label={`${item.file.name} 上传进度`} /></div><div className={styles['uploadActions']}>{item.state === 'uploading' && <button type="button" className="textbtn small" onClick={() => pauseUpload(item.id)}>暂停</button>}{(item.state === 'paused' || item.state === 'error') && <button type="button" className="textbtn small" onClick={() => void runUpload(item.id)}>继续</button>}{!['complete', 'cancelled'].includes(item.state) && <button type="button" className="textbtn small" onClick={() => void cancelUpload(item.id)}>取消</button>}</div>{item.error && <p role="alert" className={styles['uploadError']}>{item.error}</p>}</div>)}</div>}<div className="row mt24" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" disabled={uploadItems.some((item) => item.state === 'uploading')} onClick={dismissUpload}>{uploadItems.some((item) => item.state === 'complete') ? '完成' : '关闭'}</button><button type="button" className="btn primary" disabled={uploadItems.length === 0 || uploadItems.every((item) => ['uploading', 'complete', 'cancelled'].includes(item.state))} onClick={() => void startQueuedUploads()}>开始上传</button></div></div></div>}
    {selected && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}><div ref={assetDialog.dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="asset-title"><div className="row between"><h2 id="asset-title">{assetName(selected)}</h2><button type="button" className="btn ghost icononly" aria-label="关闭" onClick={() => setSelectedId(null)}><QuietIcon name="close" /></button></div><p className="small muted mt8">{selected.assetType} · {assetStatusLabels[selected.status]} · {originLabels[selected.origin] ?? selected.origin}</p>{lifecycle.isPending && <div className="panel pad mt24"><p className="small muted">正在读取来源、许可与引用…</p></div>}{lifecycle.isError && <p role="alert" className="notice amber mt16">生命周期读取失败：{describeError(lifecycle.error).message} <button type="button" className="textbtn small" onClick={() => void lifecycle.refetch()}>重试</button></p>}{lifecycle.data && <AssetLifecyclePanel workspaceId={workspaceId} lifecycle={lifecycle.data} onAssetChanged={(next) => { cache.setQueryData(lifecycleKey, next); void cache.invalidateQueries({ queryKey: assetsKey }); }} onAssetDeleted={() => { setSelectedId(null); void cache.invalidateQueries({ queryKey: assetsKey }); void cache.invalidateQueries({ queryKey: ['asset-segment-search', workspaceId] }); }} />}{relinkState.isPending && <div className="panel pad mt16"><p className="small muted">正在检查原件在线状态…</p></div>}{relinkState.isError && <p role="alert" className="notice amber mt16">原件检查失败：{describeError(relinkState.error).message} <button type="button" className="textbtn small" onClick={() => void relinkState.refetch()}>重试</button></p>}{relinkState.data && <AssetRelinkPanel workspaceId={workspaceId} asset={selected} candidates={assets.data ?? []} state={relinkState.data} onApplied={(next) => { cache.setQueryData(relinkKey, next); void cache.invalidateQueries({ queryKey: ['asset-detail', workspaceId, selected.id] }); void cache.invalidateQueries({ queryKey: lifecycleKey }); void cache.invalidateQueries({ queryKey: assetsKey }); }} />}{detail.isError && <p role="alert" className="notice amber mt16">详情加载失败：{describeError(detail.error).message} <button type="button" className="textbtn small" onClick={() => void detail.refetch()}>重试</button></p>}{detail.data && <p className="small muted mt16">{detail.data.versions.length} 个版本 · {currentMimeType ?? '未知格式'}</p>}{analysis.isPending && <section className="panel pad mt16" aria-label="分析阶段"><p className="small muted">正在读取分析阶段…</p></section>}{analysis.isError && <p role="alert" className="notice amber mt16">分析阶段读取失败：{describeError(analysis.error).message} <button type="button" className="textbtn small" onClick={() => void analysis.refetch()}>重试</button></p>}{analysis.data && <details className="panel pad mt16" open={analysis.data.stages.some((stage) => ['FAILED', 'STALE', 'CANCEL_REQUESTED'].includes(stage.status))}><summary className={styles['summary']}>渐进分析 · {analysis.data.deterministicEditingReady ? '可剪辑' : analysis.data.playable ? '可播放' : '准备中'}</summary><p className="small muted mt8">各阶段独立恢复。语音或深度分析失败不会阻止已探测素材的确定性剪辑。</p><div className={styles['analysisStages']}>{analysis.data.stages.map((stage) => <div key={stage.stage} className={styles['analysisStage']}><div><strong>{analysisStageLabels[stage.stage]}</strong><span className="small muted">{analysisStatusLabels[stage.status]}{stage.status === 'PARTIAL' ? ` · ${String(Math.round(stage.coveragePermille / 10))}%` : ''}</span></div><div className="row">{['FAILED', 'STALE', 'CANCELLED'].includes(stage.status) && ['PROXY', 'WAVEFORM', 'SHOT', 'ASR', 'SAMPLING', 'VISION', 'AUDIO'].includes(stage.stage) && <button type="button" className="textbtn small" disabled={rebuildAnalysis.isPending} onClick={() => rebuildAnalysis.mutate(stage.stage)}>重试本阶段</button>}{['QUEUED', 'RUNNING', 'PARTIAL'].includes(stage.status) && <button type="button" className="textbtn small" disabled={cancelAnalysis.isPending} onClick={() => cancelAnalysis.mutate(stage.stage)}>取消</button>}<span className={`badge ${stage.status === 'READY' || stage.status === 'EMPTY' ? 'green' : stage.status === 'FAILED' ? 'amber' : ''}`}>{analysisStatusLabels[stage.status]}</span></div>{stage.errorSummary && <p role="alert" className="small">{stage.errorSummary}</p>}</div>)}</div>{(rebuildAnalysis.isError || cancelAnalysis.isError) && <p role="alert" className="notice amber mt8">{describeError(rebuildAnalysis.error ?? cancelAnalysis.error).message}</p>}</details>}{currentVersion?.probeStatus && currentVersion.probeStatus !== 'NOT_REQUIRED' && <section className={`${styles['capabilityPanel']} panel pad mt16`} aria-label="媒体能力"><div className="row between"><strong>媒体能力</strong><span className={`badge ${currentVersion.probeStatus === 'READY' ? 'green' : currentVersion.probeStatus === 'FAILED' ? 'amber' : ''}`}>{currentVersion.probeStatus === 'PENDING' ? '等待探测' : currentVersion.probeStatus === 'PROCESSING' ? '正在探测' : currentVersion.probeStatus === 'READY' ? '探测完成' : '探测失败'}</span></div>{currentVersion.mediaProbe ? <><div className={styles['capabilityGrid']}><span>上传<strong>{capabilityLabels[currentVersion.mediaProbe.capabilities.upload]}</strong></span><span>解码<strong>{capabilityLabels[currentVersion.mediaProbe.capabilities.decode]}</strong></span><span>预览<strong>{capabilityLabels[currentVersion.mediaProbe.capabilities.preview]}</strong></span><span>导出<strong>{capabilityLabels[currentVersion.mediaProbe.capabilities.export]}</strong></span></div>{currentVersion.mediaProbe.streams.map((stream) => <p className="small muted mt8" key={stream.index}>{stream.type === 'VIDEO' ? '视频' : stream.type === 'AUDIO' ? '音频' : stream.type} #{stream.index} · {stream.codecName ?? '未知编码'}{stream.type === 'VIDEO' ? ` · ${String(stream.width ?? '?')}×${String(stream.height ?? '?')} · ${rationalLabel(stream.averageFrameRate)} · ${stream.cadence}` : ''}{stream.type === 'AUDIO' ? ` · ${String(stream.sampleRate ?? '?')} Hz · ${String(stream.channels ?? '?')} 声道` : ''}</p>)}{currentVersion.mediaProbe.capabilities.reasons.map((reason) => <p className="small mt8" key={reason.code}>{reason.message}{reason.nextAction ? ` ${reason.nextAction}` : ''}</p>)}</> : <p className="small muted mt8">原件已上传，正在隔离检查容器、编码、时间基、旋转、色彩与音频声道。</p>}</section>}{currentVersion?.probeStatus === 'READY' && <section className="panel pad mt16" aria-label="编辑代理"><div className="row between"><strong>编辑代理</strong><span className={`badge ${playback.data?.proxyStatus === 'READY' ? 'green' : playback.data?.proxyStatus === 'FAILED' || playback.data?.proxyStatus === 'MISSING' ? 'amber' : ''}`}>{playback.isPending ? '正在读取' : playback.data?.proxyStatus === 'READY' ? '已就绪' : playback.data?.proxyStatus === 'FAILED' ? '生成失败' : playback.data?.proxyStatus === 'MISSING' ? '文件缺失' : playback.data?.proxyStatus === 'NOT_REQUIRED' ? '尚未创建' : '正在生成'}</span></div><p className="small muted mt8">{playback.data?.message ?? (playback.data?.rendition === 'PROXY' ? '预览使用标准代理，正式输出仍回链原件。' : '代理转码保留源时间映射、色彩与几何事实。')}</p>{playback.data?.timeMappings.map((mapping) => <p key={`${mapping.streamType}-${String(mapping.sourceStreamIndex)}`} className="small muted mt8">{mapping.streamType === 'VIDEO' ? '视频' : '音频'} PTS 映射 · {mapping.sourceTimeBase.numerator}/{mapping.sourceTimeBase.denominator} → {mapping.proxyTimeBase.numerator}/{mapping.proxyTimeBase.denominator}</p>)}{(playback.data?.proxyStatus === 'FAILED' || playback.data?.proxyStatus === 'MISSING' || playback.data?.proxyStatus === 'NOT_REQUIRED') && <button type="button" className="btn small mt16" disabled={rebuildProxy.isPending} onClick={() => rebuildProxy.mutate()}>{rebuildProxy.isPending ? '正在提交…' : playback.data?.proxyStatus === 'NOT_REQUIRED' ? '生成编辑代理' : '重新生成代理'}</button>}{rebuildProxy.isError && <p role="alert" className="small mt8" style={{ color: 'var(--bad)' }}>{describeError(rebuildProxy.error).message}</p>}</section>}{previewUrl && previewMimeType?.startsWith('video/') && <div className={styles['assetMediaPreview']}><video ref={(node) => { mediaRef.current = node; }} key={`${selected.id}-${playback.data?.rendition ?? 'legacy'}`} controls preload="metadata" playsInline src={previewUrl} aria-label={`预览视频 ${assetName(selected)}`} onTimeUpdate={stopAtIndexRangeEnd} onError={() => setMediaErrorAssetId(selected.id)} onLoadedMetadata={() => setMediaErrorAssetId(null)} /></div>}{previewUrl && previewMimeType?.startsWith('audio/') && <div className={styles['assetMediaPreview']}><audio ref={(node) => { mediaRef.current = node; }} key={`${selected.id}-${playback.data?.rendition ?? 'legacy'}`} controls preload="metadata" src={previewUrl} aria-label={`预览音频 ${assetName(selected)}`} onTimeUpdate={stopAtIndexRangeEnd} onError={() => setMediaErrorAssetId(selected.id)} onLoadedMetadata={() => setMediaErrorAssetId(null)} /></div>}{mediaErrorAssetId === selected.id && <p role="alert" className="small muted mt16">媒体预览失败，请重新获取链接或下载原文件。</p>}<section className={`${styles['mediaIndex']} panel pad mt16`} aria-label="源媒体索引">
  <div className="row between" style={{ flexWrap: 'wrap' }}><div><strong>源媒体索引</strong><p className="small muted mt8">缩略、波形和检测结果绑定原始版本与源时间，点击后只播放该区间。</p></div><span className={`badge ${mediaIndex.data?.status === 'READY' ? 'green' : mediaIndex.data?.status === 'FAILED' ? 'amber' : ''}`}>{mediaIndex.isPending ? '正在读取' : mediaIndex.data?.status === 'READY' ? '已就绪' : mediaIndex.data?.status === 'FAILED' ? '生成失败' : mediaIndex.data?.status === 'EMPTY' ? '暂无索引' : '正在生成'}</span></div>
  <div className={`${styles['indexTabs']} mt16`} role="tablist" aria-label="媒体索引类型">{(Object.keys(indexKindLabels) as Array<keyof typeof indexKindLabels>).map((kind) => <button key={kind} type="button" role="tab" aria-selected={indexKind === kind} className={`chip ${indexKind === kind ? 'active' : ''}`} onClick={() => { setIndexKind(kind); setIndexCursor(undefined); }}>{indexKindLabels[kind]}</button>)}</div>
  {mediaIndex.isError && <p role="alert" className="small mt16" style={{ color: 'var(--bad)' }}>索引读取失败：{describeError(mediaIndex.error).message}</p>}
  {mediaIndex.data?.status === 'FAILED' && <div className="notice amber mt16"><div><strong>索引生成失败</strong><p className="small mt8">{mediaIndex.data.errorSummary ?? '原件和编辑代理仍可播放。'}</p><button type="button" className="btn small mt16" disabled={rebuildIndex.isPending} onClick={() => rebuildIndex.mutate()}>{rebuildIndex.isPending ? '正在提交…' : '重新生成索引'}</button></div></div>}
  {mediaIndex.data?.items.length === 0 && mediaIndex.data.status !== 'FAILED' && <p className="small muted mt16">{['QUEUED', 'RUNNING', 'PARTIAL'].includes(mediaIndex.data.status) ? '正在分析源媒体，完成的索引会自动出现。' : '这一类索引没有检测结果。'}</p>}
  {(mediaIndex.data?.items.length ?? 0) > 0 && <div className={styles['indexGrid']}>{mediaIndex.data?.items.map((entry) => <button key={entry.id} type="button" className={styles['indexItem']} onClick={() => playIndexRange(entry)} aria-label={`播放 ${indexKindLabels[entry.kind]} ${clockLabel(entry.payload['sourceStartMs'])} 到 ${clockLabel(entry.payload['sourceEndMs'])}`}>
    {entry.kind === 'THUMBNAIL' && entry.previewUrl ? <img src={entry.previewUrl} alt="" /> : null}
    {entry.kind === 'WAVEFORM' ? <span className={styles['waveform']} aria-hidden="true">{(Array.isArray(entry.payload['peaks']) ? entry.payload['peaks'] as number[] : []).filter((_, index) => index % 8 === 0).map((peak, index) => <i key={index} style={{ height: `${String(Math.max(2, Math.round(peak / 35)))}px` }} />)}</span> : null}
    {entry.kind === 'SHOT' ? <span className={styles['indexGlyph']}><QuietIcon name="film" /></span> : null}
    {entry.kind === 'QUALITY' ? <span className={styles['indexGlyph']}><QuietIcon name="info" /></span> : null}
    <span><strong>{entry.kind === 'SHOT' ? `镜头 ${String(entry.ordinal + 1)}` : entry.kind === 'QUALITY' ? (entry.payload['marker'] === 'SILENCE' ? '静音区间' : '黑场区间') : indexKindLabels[entry.kind]}</strong><small>{clockLabel(entry.payload['sourceStartMs'])}–{clockLabel(entry.payload['sourceEndMs'])}</small></span>
  </button>)}</div>}
  {mediaIndex.data && (indexCursor !== undefined || mediaIndex.data.nextCursor !== null) && <div className="row between mt16"><button type="button" className="textbtn small" disabled={indexCursor === undefined} onClick={() => setIndexCursor(undefined)}>第一页</button><button type="button" className="textbtn small" disabled={mediaIndex.data.nextCursor === null} onClick={() => setIndexCursor(mediaIndex.data?.nextCursor ?? undefined)}>下一页</button></div>}
</section>{hasAudio && <section className={`${styles['transcriptPanel']} panel pad mt16`} aria-label="源媒体转写">
  <div className="row between" style={{ flexWrap: 'wrap' }}><div><strong>源媒体转写</strong><p className="small muted mt8">词句绑定原始音频时间。机器识别仅供核对，不作为已确认字幕。</p></div><span className={`badge ${transcript.data?.status === 'READY' ? 'green' : transcript.data?.status === 'FAILED' ? 'amber' : ''}`}>{transcript.isPending ? '正在读取' : transcript.data?.status === 'READY' ? `版本 ${String(transcript.data.currentVersion?.version ?? 0)}` : transcript.data?.status === 'FAILED' ? '等待处理' : transcript.data?.status === 'RUNNING' ? '正在识别' : '等待识别'}</span></div>
  {transcript.isError && <p role="alert" className="small mt16" style={{ color: 'var(--bad)' }}>转写读取失败：{describeError(transcript.error).message}</p>}
  {transcript.data?.status === 'FAILED' && <div className="notice amber mt16"><div><strong>转写暂不可用</strong><p className="small mt8">{transcript.data.errorSummary ?? '原音、播放和媒体索引仍可使用。'}</p><button type="button" className="btn small mt16" disabled={retryTranscript.isPending} onClick={() => retryTranscript.mutate()}>{retryTranscript.isPending ? '正在提交…' : '配置完成后重试'}</button></div></div>}
  {transcript.data?.status === null && <div className="mt16"><p className="small muted">这个已有音频还没有转写记录。</p><button type="button" className="btn small mt8" disabled={retryTranscript.isPending} onClick={() => retryTranscript.mutate()}>{retryTranscript.isPending ? '正在提交…' : '开始转写'}</button></div>}
  {retryTranscript.isError && <p role="alert" className="small mt8" style={{ color: 'var(--bad)' }}>{describeError(retryTranscript.error).message}</p>}
  {['QUEUED', 'RUNNING'].includes(transcript.data?.status ?? '') && <p role="status" className="small muted mt16">正在识别源音频；播放、下载与其他媒体结果不受影响。</p>}
  {transcript.data?.currentVersion && <><div className={styles['transcriptMeta']}><span>{transcript.data.currentVersion.source === 'ASR' ? '机器识别 · 待核对' : '人工覆盖 · 已确认'}</span><span>{transcript.data.currentVersion.language}</span><span>{transcript.data.currentVersion.provider} / {transcript.data.currentVersion.model}</span></div><div className={styles['transcriptList']}>{transcript.data.currentVersion.segments.map((segment) => {
    const speaker = transcript.data.currentVersion?.speakers.find((candidate) => candidate.id === segment.speakerId);
    const editing = editingTranscriptSegmentId === segment.id;
    return <article key={segment.id} className={styles['transcriptSegment']}><button type="button" className={styles['transcriptTime']} onClick={() => playTranscriptRange(segment)} aria-label={`播放 ${clockLabel(Number(segment.sourceStartPts) * segment.timeBase.numerator / segment.timeBase.denominator * 1000)} 开始的转写片段`}><QuietIcon name="play" />{clockLabel(Number(segment.sourceStartPts) * segment.timeBase.numerator / segment.timeBase.denominator * 1000)}</button><div><span className="small muted">{speaker?.displayName ?? '说话人未知'} · {segment.reviewState === 'CORRECTED' ? '已人工校正' : '机器识别'}</span>{editing ? <><textarea className={styles['transcriptEditor']} rows={3} value={transcriptDraft} onChange={(event) => setTranscriptDraft(event.target.value)} aria-label="校正转写文本" /><div className="row mt8"><button type="button" className="btn small primary" disabled={!transcriptDraft.trim() || correctSegment.isPending} onClick={() => correctSegment.mutate({ segmentId: segment.id, text: transcriptDraft.trim() })}>保存校正</button><button type="button" className="btn ghost small" onClick={() => { setEditingTranscriptSegmentId(null); setTranscriptDraft(''); }}>取消</button></div></> : <button type="button" className={styles['transcriptText']} onClick={() => { setEditingTranscriptSegmentId(segment.id); setTranscriptDraft(segment.text); }}>{segment.text}</button>}</div></article>;
  })}</div>{correctSegment.isError && <p role="alert" className="small mt8" style={{ color: 'var(--bad)' }}>保存失败：{describeError(correctSegment.error).message} 请刷新版本后再试。</p>}<details className="mt16"><summary className={styles['summary']}>术语字典</summary><p className="small muted mt8">每行填写“识别词=首选写法”。修改会创建新版本，不改动原音。</p><textarea className={styles['terminologyEditor']} rows={4} value={terminologyDraft ?? transcript.data.currentVersion.terminology.map((entry) => `${entry.source}=${entry.preferred}`).join('\n')} onChange={(event) => setTerminologyDraft(event.target.value)} aria-label="转写术语字典" /><button type="button" className="btn small mt8" disabled={updateTerminology.isPending} onClick={() => updateTerminology.mutate()}>{updateTerminology.isPending ? '正在保存…' : '保存术语版本'}</button>{updateTerminology.isError && <p role="alert" className="small mt8" style={{ color: 'var(--bad)' }}>{describeError(updateTerminology.error).message}</p>}</details></>}
</section>}{currentVersion?.probeStatus === 'READY' && <section className={`${styles['rangeTags']} panel pad mt16`} aria-label="片段标签"><div><strong>片段标签</strong><p className="small muted mt8">把确定的源时间范围命名，之后可直接搜索并播放。时间单位为秒。</p></div><div className={styles['rangeTagForm']}><label><span className="label">标签</span><input className="field" aria-label="片段标签名称" placeholder="例如：产品近景" value={tagLabel} onChange={(event) => setTagLabel(event.target.value)} /></label><label><span className="label">开始</span><input className="field" aria-label="片段开始秒数" type="number" min="0" step="0.001" value={tagStartSeconds} onChange={(event) => setTagStartSeconds(event.target.value)} /></label><label><span className="label">结束</span><input className="field" aria-label="片段结束秒数" type="number" min="0" step="0.001" value={tagEndSeconds} onChange={(event) => setTagEndSeconds(event.target.value)} /></label><button type="button" className="btn small" disabled={createRangeTag.isPending || !tagLabel.trim() || !Number.isFinite(Number(tagStartSeconds)) || !Number.isFinite(Number(tagEndSeconds)) || Number(tagEndSeconds) <= Number(tagStartSeconds)} onClick={() => createRangeTag.mutate()}>{createRangeTag.isPending ? '正在添加…' : '添加标签'}</button></div>{rangeTags.isPending && <p role="status" className="small muted mt16">正在读取片段标签…</p>}{rangeTags.isError && <p role="alert" className="small mt16" style={{ color: 'var(--bad)' }}>标签读取失败：{describeError(rangeTags.error).message}</p>}{createRangeTag.isError && <p role="alert" className="small mt8" style={{ color: 'var(--bad)' }}>标签添加失败：{describeError(createRangeTag.error).message}</p>}{rangeTags.data?.items.length === 0 && <p className="small muted mt16">还没有片段标签。</p>}{(rangeTags.data?.items.length ?? 0) > 0 && <div className={styles['rangeTagList']}>{rangeTags.data?.items.map((tag) => <div key={tag.id} className={styles['rangeTagItem']}><div className="grow"><strong>{tag.label}</strong><span className="small muted">{clockLabel(Number(tag.sourceStartPts) * tag.timeBase.numerator / tag.timeBase.denominator * 1000)}–{clockLabel(Number(tag.sourceEndPts) * tag.timeBase.numerator / tag.timeBase.denominator * 1000)}</span></div><button type="button" className="textbtn small" disabled={deleteRangeTag.isPending} onClick={() => deleteRangeTag.mutate(tag.id)}>删除</button></div>)}</div>}</section>}<div className="row mt24" style={{ flexWrap: 'wrap' }}>{signedDownloadUrl && <a className="btn" href={signedDownloadUrl} target="_blank" rel="noopener noreferrer"><QuietIcon name="download" />下载原文件</a>}{selected.status === 'READY' && (selected.projectId ?? projectId) && <Link className="btn" href={`/w/${workspaceId}/p/${selected.projectId ?? projectId}/storyboard`}>前往分镜</Link>}</div>{!signedDownloadUrl && !download.isError && !download.isPending && <p role="status" className="small muted mt16">签名下载链接已到期或暂未生成。<button type="button" className="textbtn small" onClick={() => void download.refetch()}>重新获取链接</button></p>}{download.isError && <p role="alert" className="small" style={{ color: 'var(--bad)' }}>下载链接暂不可用：{describeError(download.error).message} <button type="button" className="textbtn small" onClick={() => void download.refetch()}>重试</button></p>}</div></div>}
  </div>;
}
