'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Asset } from '@ancs/contracts';
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
  error?: string;
}
const filters: Filter[] = ['全部素材', '图片', '图表', '声音', '文档', '视频'];
function assetKind(asset: Asset): Filter {
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
function licenseLabel(asset: Asset): string {
  return { USER_OWNED: '用户自有', LICENSED: '已有许可', PUBLIC_DOMAIN: '公有领域', PROVIDER_TERMS: '平台条款', UNKNOWN: '授权未确认' }[asset.license?.type ?? 'UNKNOWN'];
}
function uploadAssetType(file: File): 'SOURCE_IMAGE' | 'VOICE_AUDIO' | 'USER_UPLOAD' {
  return file.type.startsWith('image/') ? 'SOURCE_IMAGE' : file.type.startsWith('audio/') ? 'VOICE_AUDIO' : 'USER_UPLOAD';
}

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

export function DeliveryAssets({ workspaceId, projectId }: { workspaceId: string; projectId?: string }) {
  const client = useAncsClient();
  const cache = useQueryClient();
  const assetsKey = projectId === undefined ? ['workspaces', workspaceId, 'assets'] as const : queryKeys.assets(workspaceId, projectId);
  const assets = useQuery({ queryKey: assetsKey, queryFn: () => client.assets.list(workspaceId, projectId ? { projectId } : undefined) });
  const [filter, setFilter] = useState<Filter>('全部素材');
  const [search, setSearch] = useState('');
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mediaErrorAssetId, setMediaErrorAssetId] = useState<string | null>(null);
  const [financeOpen, setFinanceOpen] = useState(false);
  const [rebindIds, setRebindIds] = useState<Record<string, string>>({});
  const picker = useRef<HTMLInputElement>(null);
  const uploadItemsRef = useRef<UploadItem[]>([]);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const selected = assets.data?.find((asset) => asset.id === selectedId);
  const detail = useQuery({ queryKey: ['asset-detail', workspaceId, selectedId], enabled: selectedId !== null, queryFn: () => client.assets.get(workspaceId, selectedId as string) });
  const download = useQuery({ queryKey: ['asset-download', workspaceId, selectedId], enabled: selected?.status === 'READY', queryFn: () => client.assets.downloadUrl(workspaceId, selectedId as string), staleTime: 0 });
  const signedDownloadUrl = download.data && Date.parse(download.data.expiresAt) > Date.now() + 5000 ? download.data.url : null;
  const currentMimeType = detail.data?.versions.find((version) => version.id === detail.data.currentVersionId)?.mimeType ?? null;
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
      await client.assets.uploadResumable(workspaceId, {
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
      updateUploadItems((current) => current.map((candidate) => candidate.id === itemId ? { ...candidate, state: 'complete', progress: 100 } : candidate));
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
    <div className="row between mt32 mb24" style={{ flexWrap: 'wrap' }}><div className="chips" role="group" aria-label="素材类型筛选">{filters.map((name) => <button key={name} type="button" className={`chip ${filter === name ? 'active' : ''}`} aria-pressed={filter === name} onClick={() => setFilter(name)}>{name}</button>)}</div><label className="searchbox"><QuietIcon name="search" /><input aria-label="搜索素材" placeholder="搜索素材" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
    {shown.length === 0 ? <div className="panel pad"><StateBlock variant="empty" title={items.length === 0 ? '还没有资产' : '没有匹配的素材'} description={items.length === 0 ? '上传图片、视频、音频或文件后，可在分镜中绑定。' : '试试其他类型或搜索词。'} /></div> : <div className="asset-grid">{shown.map((asset) => {
      const kind = assetKind(asset);
      return <button key={asset.id} type="button" className="asset-item" aria-label={`查看素材 ${assetName(asset)}`} aria-describedby={`asset-preview-${asset.id}`} onClick={(event) => { assetDialog.triggerRef.current = event.currentTarget; setMediaErrorAssetId(null); setSelectedId(asset.id); }}><AssetPreview kind={kind} name={assetName(asset)} id={asset.id} /><div className="asset-info"><h3>{assetName(asset)}</h3><p>{originLabels[asset.origin] ?? asset.origin} · <span>{asset.assetType}</span></p><div className="row between mt16"><span className={`badge ${(asset.license?.type ?? 'UNKNOWN') === 'UNKNOWN' ? 'amber' : 'green'}`}>{licenseLabel(asset)}</span><span className="sample-note">{asset.status}</span></div></div></button>;
    })}</div>}
    <div className="notice mt32"><QuietIcon name="shield" /><div>素材可用于创作，不代表可用作事实证据。真实照片、AI 画面与结构示意须分别标记，并核对授权信息。</div></div>
    {projectId && <details id="finance-pack" className="panel pad mt24" onToggle={(event) => setFinanceOpen(event.currentTarget.open)}><summary className={styles['summary']}>Finance 图表素材</summary><p className="small muted mt8">管理当前工作区的数据来源、许可证、单位与版本化模板；产物不会自动绑定到分镜。</p>{financeOpen && <div className={styles['advanced']}><FinanceWorkspace workspaceId={workspaceId} /></div>}</details>}
    <details className="panel pad mt24" data-testid="external-results" open={(external.data?.length ?? 0) > 0}><summary className={styles['summary']}>外部处理产物回绑</summary><p className="small muted mt8">平台外完成的产物先上传，再选择对应任务回绑；此处不会代替 Provider 执行。</p>{external.isPending && <p className="small muted mt16">正在加载任务引用…</p>}{external.isError && <p role="alert" className="small muted mt16">任务引用加载失败：{describeError(external.error).message} <button type="button" className="textbtn small" onClick={() => void external.refetch()}>重试</button></p>}{external.data?.length === 0 && <p className="small muted mt16">没有待回绑的 Provider 任务引用。</p>}{(external.data ?? []).map((generation) => <div key={generation.id} className={`${styles['rebindRow']} mt16`} data-testid={`external-result-${generation.id}`}><div><strong>{generation.providerId}</strong><p className="small muted">任务 {generation.providerJobId ?? generation.id} · {generation.status}</p></div><select className="field select" aria-label={`回绑资产 ${generation.id}`} value={rebindIds[generation.id] ?? ''} onChange={(event) => setRebindIds((current) => ({ ...current, [generation.id]: event.target.value }))}><option value="">选择已上传素材</option>{items.filter((asset) => asset.status === 'READY').map((asset) => <option key={asset.id} value={asset.id}>{assetName(asset)}</option>)}</select><button type="button" className="btn small" disabled={rebind.isPending || !rebindIds[generation.id]} onClick={() => rebind.mutate({ generationId: generation.id, assetId: rebindIds[generation.id] ?? '' })}>回绑</button></div>)}{rebind.isError && <p role="alert" className="small" style={{ color: 'var(--bad)' }}>回绑失败：{describeError(rebind.error).message}</p>}</details>
    {uploadOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) dismissUpload(); }}><div ref={uploadDialog.dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title"><div className="row between"><h2 id="upload-title">上传素材</h2><button type="button" className="btn ghost icononly" aria-label="关闭" disabled={uploadItems.some((item) => item.state === 'uploading')} onClick={dismissUpload}><QuietIcon name="close" /></button></div><p className="small muted mt8">文件按块直传并逐片校验。暂停或断线后，只继续尚未确认的分片。</p><button type="button" className={`${styles['dropZone']} mt24`} onClick={() => picker.current?.click()}><QuietIcon name="upload" /><strong>{uploadItems.length > 0 ? `已选择 ${String(uploadItems.length)} 个文件` : '选择图片、视频、音频或文件'}</strong><span className="small muted">可多选；单个文件最高 5 GiB</span></button>{uploadItems.length > 0 && <div className={styles['uploadQueue']} aria-label="上传队列">{uploadItems.map((item) => <div key={item.id} className={styles['uploadRow']}><div className={styles['uploadMeta']}><strong title={item.file.name}>{item.file.name}</strong><span className="small muted">{(item.file.size / 1024 / 1024).toFixed(1)} MB · {item.state === 'queued' ? '等待上传' : item.state === 'uploading' ? `上传中 ${String(item.progress)}%` : item.state === 'paused' ? `已暂停 ${String(item.progress)}%` : item.state === 'complete' ? '已完成' : item.state === 'cancelled' ? '已取消' : '上传失败'}</span><progress max={100} value={item.progress} aria-label={`${item.file.name} 上传进度`} /></div><div className={styles['uploadActions']}>{item.state === 'uploading' && <button type="button" className="textbtn small" onClick={() => pauseUpload(item.id)}>暂停</button>}{(item.state === 'paused' || item.state === 'error') && <button type="button" className="textbtn small" onClick={() => void runUpload(item.id)}>继续</button>}{!['complete', 'cancelled'].includes(item.state) && <button type="button" className="textbtn small" onClick={() => void cancelUpload(item.id)}>取消</button>}</div>{item.error && <p role="alert" className={styles['uploadError']}>{item.error}</p>}</div>)}</div>}<div className="row mt24" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" disabled={uploadItems.some((item) => item.state === 'uploading')} onClick={dismissUpload}>{uploadItems.some((item) => item.state === 'complete') ? '完成' : '关闭'}</button><button type="button" className="btn primary" disabled={uploadItems.length === 0 || uploadItems.every((item) => ['uploading', 'complete', 'cancelled'].includes(item.state))} onClick={() => void startQueuedUploads()}>开始上传</button></div></div></div>}
    {selected && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}><div ref={assetDialog.dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="asset-title"><div className="row between"><h2 id="asset-title">{assetName(selected)}</h2><button type="button" className="btn ghost icononly" aria-label="关闭" onClick={() => setSelectedId(null)}><QuietIcon name="close" /></button></div><p className="small muted mt8">{selected.assetType} · {selected.status} · {originLabels[selected.origin] ?? selected.origin}</p><div className="panel pad mt24"><strong>来源与授权</strong><p className="small muted mt8">{licenseLabel(selected)}{selected.license?.attribution ? ` · ${selected.license.attribution}` : ''}</p><p className="small muted mt8">资产 ID：{selected.id}</p></div>{detail.isError && <p role="alert" className="notice amber mt16">详情加载失败：{describeError(detail.error).message} <button type="button" className="textbtn small" onClick={() => void detail.refetch()}>重试</button></p>}{detail.data && <p className="small muted mt16">{detail.data.versions.length} 个版本 · {currentMimeType ?? '未知格式'}</p>}{signedDownloadUrl && currentMimeType?.startsWith('video/') && <div className={styles['assetMediaPreview']}><video key={selected.id} controls preload="metadata" playsInline src={signedDownloadUrl} aria-label={`预览视频 ${assetName(selected)}`} onError={() => setMediaErrorAssetId(selected.id)} onLoadedMetadata={() => setMediaErrorAssetId(null)} /></div>}{signedDownloadUrl && currentMimeType?.startsWith('audio/') && <div className={styles['assetMediaPreview']}><audio key={selected.id} controls preload="metadata" src={signedDownloadUrl} aria-label={`预览音频 ${assetName(selected)}`} onError={() => setMediaErrorAssetId(selected.id)} onLoadedMetadata={() => setMediaErrorAssetId(null)} /></div>}{mediaErrorAssetId === selected.id && <p role="alert" className="small muted mt16">媒体预览失败，请重新获取链接或下载原文件。</p>}<div className="row mt24" style={{ flexWrap: 'wrap' }}>{signedDownloadUrl && <a className="btn" href={signedDownloadUrl} target="_blank" rel="noopener noreferrer"><QuietIcon name="download" />下载原文件</a>}{(selected.projectId ?? projectId) && <Link className="btn" href={`/w/${workspaceId}/p/${selected.projectId ?? projectId}/storyboard`}>前往分镜</Link>}</div>{selected.status === 'READY' && !signedDownloadUrl && !download.isError && !download.isPending && <p role="status" className="small muted mt16">签名下载链接已到期或暂未生成。<button type="button" className="textbtn small" onClick={() => void download.refetch()}>重新获取链接</button></p>}{download.isError && <p role="alert" className="small" style={{ color: 'var(--bad)' }}>下载链接暂不可用：{describeError(download.error).message} <button type="button" className="textbtn small" onClick={() => void download.refetch()}>重试</button></p>}</div></div>}
  </div>;
}
