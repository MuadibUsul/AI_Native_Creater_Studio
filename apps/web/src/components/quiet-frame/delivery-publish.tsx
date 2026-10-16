'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_CAPABILITY_MATRIX, type ExportPackage, type ExportPackageRecord, type HandoffRecord, type RenderRecord } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import type { Messages } from '@/i18n/messages';
import type { PreferredPlatformId } from '@/i18n/pages/delivery';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useRenders } from '@/lib/queries';
import { QuietIcon } from '@/ui/QuietIcon';
import styles from './delivery.module.css';

const PREFERRED_IDS: readonly PreferredPlatformId[] = ['YOUTUBE', 'BILIBILI', 'DOUYIN', 'X'];

function downloadInstructions(record: ExportPackageRecord, t: Messages['delivery']['publish']['instructions']): void {
  const { payload } = record;
  const lines = [
    t.platform(record.platformId), t.work(payload.title),
    t.projectVersion(payload.projectVersionId), t.videoAsset(payload.videoAssetId),
    t.cover(payload.coverAssetId ?? payload.coverNote ?? t.notProvided),
    t.description(payload.description ?? ''), t.disclosure(payload.disclosure ?? t.notFilled),
    '', t.steps, ...payload.checklist.map((step, index) => `${index + 1}. ${step}`),
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ANCS-${record.platformId}-handoff.txt`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DeliveryPublish({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const { messages, locale } = useI18n();
  const t = messages.delivery.publish;
  const preferred = PREFERRED_IDS.map((id) => ({ id, ...t.platforms[id] }));
  const client = useAncsClient();
  const cache = useQueryClient();
  const renders = useRenders(workspaceId, projectId);
  const project = useQuery({ queryKey: ['project', projectId, 'publish'], queryFn: () => client.projects.get(projectId) });
  const publications = useQuery({ queryKey: ['publications', workspaceId, projectId], queryFn: () => client.publications.list(workspaceId, projectId) });
  const packages = useQuery({ queryKey: ['export-packages', workspaceId, projectId], queryFn: () => client.exportPackages.list(workspaceId, projectId) });
  const handoffs = useQuery({ queryKey: ['handoffs', workspaceId, projectId], queryFn: () => client.handoffs.list(workspaceId, projectId) });
  const approved = useQuery({
    queryKey: ['approved-renders', workspaceId, projectId, renders.data?.map((render) => `${render.id}:${render.status}`).join(',')],
    enabled: renders.data !== undefined,
    queryFn: async (): Promise<RenderRecord | null> => {
      for (const render of renders.data ?? []) {
        if (render.status !== 'READY') continue;
        const approval = await client.renders.approval(workspaceId, render.id);
        if (approval?.decision === 'APPROVED') return render;
      }
      return null;
    },
  });
  const video = useQuery({
    queryKey: ['approved-video', workspaceId, approved.data?.id], enabled: !!approved.data,
    queryFn: async () => {
      for (const assetId of approved.data?.outputAssetIds ?? []) {
        const detail = await client.assets.get(workspaceId, assetId);
        const version = detail.versions.find((entry) => entry.id === detail.currentVersionId);
        if (version?.mimeType.startsWith('video/')) return assetId;
      }
      return null;
    },
  });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [disclosure, setDisclosure] = useState('');
  const [activePackage, setActivePackage] = useState<ExportPackageRecord | null>(null);
  const [renderBundle, setRenderBundle] = useState<ExportPackage | null>(null);
  const [activeHandoff, setActiveHandoff] = useState<HandoffRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const handoffRequestKey = useRef<string | null>(null);
  const createPackage = useMutation({
    mutationFn: (platformId: 'DOUYIN' | 'X') => {
      if (!approved.data || !video.data || !project.data) throw new Error(t.errors.needVideoAndTitle);
      return client.exportPackages.create(workspaceId, projectId, {
        platformId, projectVersionId: approved.data.input.projectVersionId, outputAssetId: video.data,
        coverAssetId: null, title: title.trim() || project.data.title,
        description: description.trim() || null, tags: [], disclosure: disclosure.trim() || null,
      });
    },
    onSuccess: async (record) => { setActivePackage(record); setNotice(t.notices.packageCreated); await cache.invalidateQueries({ queryKey: ['export-packages', workspaceId, projectId] }); },
    onError: (error) => setNotice(t.notices.packageFailed(describeError(error).message)),
  });
  const exportRender = useMutation({ mutationFn: (renderId: string) => client.renders.exportPackage(workspaceId, renderId), onSuccess: (bundle) => { setRenderBundle(bundle); setNotice(null); }, onError: (error) => setNotice(t.notices.downloadUnavailable(describeError(error).message)) });
  const reconcile = useMutation({
    mutationFn: (publicationId: string) => client.publications.reconcile(workspaceId, projectId, publicationId),
    onSuccess: async () => { setNotice(t.notices.reconciled); await cache.invalidateQueries({ queryKey: ['publications', workspaceId, projectId] }); },
    onError: (error) => setNotice(t.notices.reconcileFailed(describeError(error).message)),
  });
  const createHandoff = useMutation({
    mutationFn: () => {
      if (!approved.data || !video.data) throw new Error(t.errors.needVideo);
      handoffRequestKey.current ??= crypto.randomUUID();
      return client.handoffs.create(workspaceId, projectId, { artifactIds: [video.data], targetPlatform: null, ttlSeconds: 86_400 }, { idempotencyKey: handoffRequestKey.current });
    },
    onSuccess: async (record) => { handoffRequestKey.current = null; setActiveHandoff(record); setNotice(t.notices.handoffCreated); await cache.invalidateQueries({ queryKey: ['handoffs', workspaceId, projectId] }); },
    onError: (error) => setNotice(t.notices.handoffFailed(describeError(error).message)),
  });
  const cancelHandoff = useMutation({
    mutationFn: (handoffId: string) => client.handoffs.cancel(workspaceId, projectId, handoffId),
    onSuccess: async (record) => { setActiveHandoff(record); setNotice(t.notices.handoffRevoked); await cache.invalidateQueries({ queryKey: ['handoffs', workspaceId, projectId] }); },
    onError: (error) => setNotice(t.notices.revokeFailed(describeError(error).message)),
  });
  const activeBundle = renderBundle?.renderId === approved.data?.id ? renderBundle : null;
  const visibleHandoffs = activeHandoff ? [activeHandoff, ...(handoffs.data?.items ?? []).filter((item) => item.handoffId !== activeHandoff.handoffId)] : handoffs.data?.items ?? [];
  const shownPackage = activePackage ?? packages.data?.items[0];
  const otherPlatforms = PLATFORM_CAPABILITY_MATRIX.filter((entry) => !preferred.some((item) => item.id === entry.platformId));

  return <div className="page" data-testid="quiet-publish">
    <header className="sectionhead mobile-stack"><div><h1>{t.title}</h1><p>{t.subtitle}</p></div><span className="badge"><QuietIcon name="shield" />{t.verifiedFirst}</span></header>
    {notice && <p role="status" className="notice amber mb24">{notice}</p>}
    {renders.isError && <p role="alert" className="notice amber mb24">{t.loadErrors.renders(describeError(renders.error).message)} <button type="button" className="textbtn small" onClick={() => void renders.refetch()}>{t.retry}</button></p>}
    {approved.isError && <p role="alert" className="notice amber mb24">{t.loadErrors.approval(describeError(approved.error).message)} <button type="button" className="textbtn small" onClick={() => void approved.refetch()}>{t.retry}</button></p>}
    {video.isError && <p role="alert" className="notice amber mb24">{t.loadErrors.video(describeError(video.error).message)} <button type="button" className="textbtn small" onClick={() => void video.refetch()}>{t.retry}</button></p>}
    {project.isError && <p role="alert" className="notice amber mb24">{t.loadErrors.project(describeError(project.error).message)} <button type="button" className="textbtn small" onClick={() => void project.refetch()}>{t.retry}</button></p>}
    {publications.isError && <p role="alert" className="notice amber mb24">{t.loadErrors.publications(describeError(publications.error).message)} <button type="button" className="textbtn small" onClick={() => void publications.refetch()}>{t.retry}</button></p>}
    <div className="split wide mt32"><section><div className="row between mb24"><h3>{t.channels.title}</h3><a className="textbtn small" href="#capability-notes">{t.channels.learnTiers} <QuietIcon name="info" /></a></div>
      {preferred.map((platform) => {
        const entry = PLATFORM_CAPABILITY_MATRIX.find((item) => item.platformId === platform.id);
        const manual = entry?.declaredCapabilities.includes('EXPORT_PACKAGE') === true;
        return <div className="platform-row" key={platform.id}><span className="platform-logo">{platform.mark}</span><div className="grow"><div className="row gap8"><h3>{platform.name}</h3><span className={`badge ${manual ? '' : 'blue'}`}>{platform.label}</span></div><p>{platform.description}</p></div><button type="button" className="btn small" disabled={!manual || !approved.data || !video.data || !project.data || createPackage.isPending} onClick={() => { if (platform.id === 'DOUYIN' || platform.id === 'X') createPackage.mutate(platform.id); }} title={!manual ? t.channels.notVerified : !approved.data ? t.channels.approveFirst : !video.data ? t.channels.noVideo : undefined}><QuietIcon name={manual ? 'download' : 'link'} />{manual ? t.channels.preparePackage : t.channels.awaitingConnection}</button></div>;
      })}
      <div className="notice mt24"><QuietIcon name="shield" /><div><strong>{t.honest.title}</strong><br />{t.honest.body}</div></div>
      <section className="panel pad mt24" id="capability-notes"><h3>{t.capability.title}</h3><p className="small muted mt8">{t.capability.body}</p>{otherPlatforms.map((entry) => <p key={entry.platformId} className="small muted mt8">{entry.platformId} · {entry.tier} · {entry.verification}</p>)}</section>
      <section className="panel pad mt24"><div className="row between"><div><h3>{t.extensions.title}</h3><p className="small muted mt8">{t.extensions.body}</p></div><Link className="btn small" href={`/w/${workspaceId}/extensions`}><QuietIcon name="box" />{t.extensions.choose}</Link></div></section>
      <section className="panel pad mt24"><h3>{t.records.title}</h3>{publications.isPending && <p className="small muted mt16">{t.records.loading}</p>}{publications.isError && <p className="small muted mt16">{t.loadErrors.publications(describeError(publications.error).message)}</p>}{publications.data?.items.length === 0 && <p className="small muted mt16">{t.records.empty}</p>}{publications.data?.items.map((record) => <div key={record.id} className={`${styles['recordRow']} mt16`}><span>{record.platformId} · {record.title}</span><span className={`badge ${record.state === 'PUBLISHED' ? 'green' : record.state === 'FAILED' ? 'red' : 'amber'}`}>{record.state === 'DRAFT' ? t.records.draft : record.state === 'PUBLISHED' ? t.records.published : record.state === 'PUBLISHING' || record.state === 'QUEUED' ? t.records.pending : record.state}</span>{record.state === 'QUEUED' || record.state === 'PUBLISHING' || record.state === 'FAILED' ? <button type="button" className="btn small" disabled={reconcile.isPending} onClick={() => reconcile.mutate(record.id)}>{reconcile.isPending ? t.records.reconciling : t.records.reconcile}</button> : null}{record.remoteUrl && <a className="textbtn small" href={record.remoteUrl} target="_blank" rel="noopener noreferrer">{t.records.viewRemote}</a>}</div>)}</section>
    </section><aside className="col"><section className="panel pad"><div className={`publication-cover ${styles['packagePreview']}`} data-testid="package-preview"><div className="cover"><div className="cover-art art-0" aria-hidden="true" /><span className="cover-label">CREATOR STUDIO / EDITORIAL</span><span className={`cover-title ${styles['previewTitle']}`}>{project.data?.title ?? t.preview.currentWork}</span><span className={styles['previewDisclosure']}>{approved.data ? t.preview.coverMock : t.preview.awaitingApproval}</span></div></div><h3 className="mt16">{project.data?.title ?? t.preview.currentWork}</h3><div className="row mt8 gap8"><span className="badge">{approved.data ? `${approved.data.input.format.width} × ${approved.data.input.format.height}` : t.preview.unknownFormat}</span><span className={`badge ${approved.data ? 'green' : 'amber'}`}>{approved.data ? t.preview.approved : t.preview.notApproved}</span></div>{approved.data && <p className="small muted mt8">{t.preview.renderVersion(approved.data.id, approved.data.input.projectVersionId)}</p>}<hr className="divider" />
      <label className="label">{t.form.title}<input className="field" value={title || project.data?.title || ''} onChange={(event) => setTitle(event.target.value)} maxLength={300} /></label><label className="label mt16">{t.form.description}<textarea className="field" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5000} rows={3} /></label><label className="label mt16">{t.form.disclosure}<textarea className="field" value={disclosure} onChange={(event) => setDisclosure(event.target.value)} rows={2} placeholder={t.form.disclosurePlaceholder} /></label>
      <hr className="divider" /><h4 className="small">{t.downloads.title}</h4><p className="small muted mt8">{t.downloads.body}</p><div className="mt24"><button type="button" className="btn full" disabled={!approved.data || exportRender.isPending} onClick={() => { if (approved.data) exportRender.mutate(approved.data.id); }}><QuietIcon name="download" />{exportRender.isPending ? t.downloads.preparing : t.downloads.get}</button></div>{activeBundle && <div className="mt16" data-testid="publish-render-export">{activeBundle.projectEditedSinceApproval && <p className="notice amber">{t.downloads.editedSince}</p>}{activeBundle.entries.map((item) => Date.parse(item.download.expiresAt) > Date.now() + 5000 ? <a key={item.kind} className="textbtn" href={item.download.url} target="_blank" rel="noopener noreferrer" onClick={(event) => { if (Date.parse(item.download.expiresAt) <= Date.now() + 5000) { event.preventDefault(); setNotice(t.notices.linkExpired); } }}>{t.downloads.item(item.kind, item.mimeType)}</a> : <p key={item.kind} className="small muted">{t.downloads.expired(item.kind)}</p>)}</div>}
    </section><section className="panel pad"><h3>{t.checklist.title}</h3>{packages.isPending && <p className="small muted mt16">{t.checklist.loading}</p>}{packages.isError && <p role="alert" className="small muted mt16">{t.checklist.failed(describeError(packages.error).message)} <button type="button" className="textbtn small" onClick={() => void packages.refetch()}>{t.retry}</button></p>}{!activePackage && packages.data?.items.length === 0 && <p className="small muted mt16">{t.checklist.empty}</p>}{shownPackage && <div className="mt16"><span className="badge blue">{shownPackage.platformId}</span><ol className={styles['checklist']}>{shownPackage.payload.checklist.map((step) => <li key={step}>{step}</li>)}</ol><p className="small muted">{t.checklist.summary(shownPackage.payload.projectVersionId, shownPackage.payload.coverNote ?? t.checklist.coverBound)}</p><button type="button" className="btn small mt16" onClick={() => { const record = activePackage ?? packages.data?.items[0]; if (record) downloadInstructions(record, t.instructions); }}><QuietIcon name="download" />{t.checklist.downloadTxt}</button></div>}</section><section className="panel pad"><h3>{t.handoff.title}</h3><p className="small muted mt8">{t.handoff.body}</p>{handoffs.isError && <p role="alert" className="small muted mt16">{t.handoff.failed(describeError(handoffs.error).message)} <button type="button" className="textbtn small" onClick={() => void handoffs.refetch()}>{t.retry}</button></p>}<button type="button" className="btn small mt16" disabled={!approved.data || !video.data || createHandoff.isPending} onClick={() => createHandoff.mutate()}>{createHandoff.isPending ? t.handoff.creating : t.handoff.create}</button>{visibleHandoffs.length === 0 && !handoffs.isPending ? <p className="small muted mt16">{t.handoff.empty}</p> : null}{visibleHandoffs.map((record) => <div key={record.handoffId} className="mt16"><span className="small">{record.handoffId}</span><span className={`badge ${record.state === 'PENDING' && !record.isExpired ? 'amber' : ''}`}>{record.isExpired ? t.handoff.expired : record.state === 'PENDING' ? t.handoff.pending : record.state === 'REVOKED' ? t.handoff.revoked : record.state === 'CLAIMED' ? t.handoff.claimed : t.handoff.completed}</span><p className="small muted mt8">{t.handoff.expiresAt(new Date(record.expiresAt).toLocaleString(locale))}</p>{record.state === 'PENDING' && !record.isExpired ? <button type="button" className="btn small mt8" disabled={cancelHandoff.isPending} onClick={() => cancelHandoff.mutate(record.handoffId)}>{t.handoff.revoke}</button> : null}</div>)}</section><div className="notice"><QuietIcon name="phone" /><span>{t.mobileNote}</span></div></aside></div>
  </div>;
}
