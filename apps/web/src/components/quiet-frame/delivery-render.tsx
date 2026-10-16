'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExportPackage, QaReport, RenderProfile } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useNarrative, useRenderApproval, useRenderQaReport, useRenders, useWorkspace } from '@/lib/queries';
import { QuietIcon } from '@/ui/QuietIcon';
import styles from './delivery.module.css';

const PROFILE_VALUES: readonly RenderProfile[] = ['DRAFT_720', 'STUDIO_1080', 'PREMIUM_4K', 'SHORT_1080x1920'];

function QaPanel({ report, title }: { report: QaReport; title: string }) {
  const { messages, locale } = useI18n();
  const t = messages.delivery.render.qa;
  return <section className="panel pad" data-testid="qa-report"><div className="row between"><h3>{title}</h3><span className={`badge ${report.verdict === 'PASS' ? 'green' : 'red'}`}>{report.verdict === 'PASS' ? t.passed : t.failed}</span></div>
    <div className="check-list">{report.checks.map((check) => <div key={check.id} className="check-item" data-testid={`qa-check-${check.id}`}><QuietIcon name={check.status === 'PASS' ? 'check' : 'info'} /><div><strong>{check.category} · {check.id}</strong><p>{check.message ?? (check.status === 'SKIP' ? t.skipped : check.status === 'PASS' ? t.checkPass : t.checkFail)}{check.status === 'FAIL' && check.severity === 'BLOCKER' ? t.blocksDelivery : ''}</p></div></div>)}</div>
    <p className="small muted mt16">{t.summary(report.summary.blockersFailed, report.summary.warningsFailed, report.summary.skipped, new Date(report.createdAt).toLocaleString(locale))}</p>
  </section>;
}

export function DeliveryRender({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const { messages, locale } = useI18n();
  const t = messages.delivery.render;
  const profiles = PROFILE_VALUES.map((value) => ({ value, label: t.profiles[value] }));
  const statusLabel = t.status;
  const client = useAncsClient();
  const cache = useQueryClient();
  const renders = useRenders(workspaceId, projectId);
  const narrative = useNarrative(workspaceId, projectId);
  const workspace = useWorkspace(workspaceId);
  const canCreate = workspace.data?.role === 'OWNER' || workspace.data?.role === 'ADMIN' || workspace.data?.role === 'EDITOR';
  const masterNarration = useQuery({
    queryKey: ['projects', projectId, 'master-narration', workspaceId, narrative.data?.id, narrative.data?.revision],
    enabled: narrative.data != null,
    queryFn: () => client.narrative.masterNarration(workspaceId, projectId, narrative.data?.id ?? ''),
    refetchInterval: 5000,
  });
  const narrationReady = narrative.data != null && masterNarration.data != null
    && masterNarration.data.narrativePlanRevision === narrative.data.revision
    && masterNarration.data.assetId !== null && masterNarration.data.assetVersionId !== null;
  const [selectedId, setSelectedId] = useState('');
  const [profile, setProfile] = useState<RenderProfile>('STUDIO_1080');
  const [precheck, setPrecheck] = useState<QaReport | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [exportBundle, setExportBundle] = useState<ExportPackage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const current = renders.data?.find((render) => render.id === selectedId) ?? renders.data?.[0];
  const qa = useRenderQaReport(workspaceId, current?.id ?? null);
  const approval = useRenderApproval(workspaceId, current?.id ?? null);
  const media = useQuery({
    queryKey: ['render-media', workspaceId, current?.id], enabled: !!current && current.outputAssetIds.length > 0,
    queryFn: async () => {
      for (const assetId of current?.outputAssetIds ?? []) {
        const detail = await client.assets.get(workspaceId, assetId);
        const version = detail.versions.find((entry) => entry.id === detail.currentVersionId);
        if (version?.mimeType.startsWith('video/')) return client.assets.downloadUrl(workspaceId, assetId);
      }
      return null;
    }, staleTime: 0,
  });
  const invalidate = async () => cache.invalidateQueries({ queryKey: queryKeys.renders(workspaceId, projectId) });
  const runPrecheck = useMutation({ mutationFn: () => client.projects.renderPrecheck(projectId), onMutate: () => setPrecheck(null), onSuccess: setPrecheck, onError: (error) => setNotice(t.notices.precheckFailed(describeError(error).message)) });
  const runQa = useMutation({ mutationFn: () => client.renders.qa(workspaceId, current?.id ?? ''), onSuccess: async () => { setNotice(t.notices.qaRequeued); await invalidate(); }, onError: (error) => setNotice(t.notices.qaFailed(describeError(error).message)) });
  const decide = useMutation({ mutationFn: (decision: 'APPROVED' | 'REJECTED') => client.renders.decideApproval(workspaceId, current?.id ?? '', { decision, ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}) }), onSuccess: async (record) => { setReviewed(false); setExportBundle(null); setNotice(record.decision === 'APPROVED' ? t.notices.approved : t.notices.rejected); await cache.invalidateQueries({ queryKey: queryKeys.renderApproval(workspaceId, current?.id ?? 'none') }); }, onError: (error) => setNotice(t.notices.decideFailed(describeError(error).message)) });
  const exportRender = useMutation({ mutationFn: (renderId: string) => client.renders.exportPackage(workspaceId, renderId), onSuccess: (bundle) => { setExportBundle(bundle); setNotice(null); }, onError: (error) => setNotice(t.notices.exportBlocked(describeError(error).message)) });
  const approved = approval.data?.decision === 'APPROVED';
  const canApprove = qa.data?.verdict === 'PASS' && approval.isSuccess;
  const previewUrl = media.data && Date.parse(media.data.expiresAt) > Date.now() + 5000 ? media.data.url : null;
  const activeExportBundle = exportBundle?.renderId === current?.id ? exportBundle : null;

  return <div className="page" data-testid="quiet-render">
    <header className="sectionhead mobile-stack"><div><h1>{t.title}</h1><p>{t.subtitle}</p></div><span className={`badge ${approved ? 'green' : current?.status === 'FAILED' ? 'red' : 'amber'}`}><QuietIcon name={approved ? 'check' : 'clock'} />{approved ? t.versionApproved : current ? statusLabel[current.status] : t.noRenderYet}</span></header>
    {notice && <p role="status" className="notice amber mb24">{notice}</p>}
    <section className="panel pad mt24" data-testid="master-narration-status">
      <div className="row between"><div><h3>{t.narration.title}</h3><p className="small muted mt8">{t.narration.intro}</p></div><span className={`badge ${narrationReady ? 'green' : 'amber'}`}>{narrationReady ? t.narration.ready : t.narration.waiting}</span></div>
      {narrative.isPending ? <p className="small muted mt16">{t.narration.loadingScript}</p> : narrative.isError ? <p role="alert" className="notice amber mt16">{t.narration.scriptFailed(describeError(narrative.error).message)} <button type="button" className="textbtn small" onClick={() => void narrative.refetch()}>{t.narration.retryScript}</button></p> : !narrative.data ? <p className="small muted mt16">{t.narration.noScript}</p> : masterNarration.isPending ? <p className="small muted mt16">{t.narration.loadingStatus}</p> : masterNarration.isError ? <p role="alert" className="notice amber mt16">{t.narration.statusFailed(describeError(masterNarration.error).message)}</p> : masterNarration.data ? <>
        <p className="small muted mt16">{t.narration.summary(masterNarration.data.narrativePlanRevision, (masterNarration.data.totalDurationMs / 1000).toFixed(1), masterNarration.data.segments.length, masterNarration.data.alignmentMethod === 'PROVIDER_TIMESTAMPS' ? t.narration.providerTimestamps : t.narration.audioAligner)}</p>
        {masterNarration.data.narrativePlanRevision !== narrative.data.revision ? <p role="status" className="notice amber mt16">{t.narration.stale}</p> : !narrationReady ? <p role="status" className="notice amber mt16">{t.narration.notReady}</p> : null}
        {masterNarration.data.warnings.map((warning) => <p className="small muted mt8" key={warning}>{warning}</p>)}
      </> : <p role="status" className="notice amber mt16">{t.narration.missing}</p>}
      <div className="row mt16" style={{ flexWrap: 'wrap' }}><Link className="btn small" href={`/w/${workspaceId}/p/${projectId}/script`}>{t.narration.viewScript}</Link><Link className="btn small" href={`/w/${workspaceId}/identity`}>{t.narration.configureVoice}</Link>{narrative.data && <button type="button" className="btn small" disabled={masterNarration.isFetching} onClick={() => void masterNarration.refetch()}>{masterNarration.isFetching ? t.narration.refreshing : t.narration.refresh}</button>}</div>
      {!narrationReady && <p className="small muted mt16">{t.narration.synthesisPending}</p>}
      {workspace.isError ? <p role="alert" className="small muted mt16">{t.narration.permissionFailed(describeError(workspace.error).message)} <button type="button" className="textbtn small" onClick={() => void workspace.refetch()}>{t.narration.retryPermission}</button></p> : workspace.data && !canCreate ? <p className="small muted mt16">{t.narration.readOnly}</p> : null}
    </section>
    <div className="review-layout mt32"><section>
      <div className={styles['renderPlayer']}>{previewUrl && current?.status === 'READY' ? <video controls preload="metadata" src={previewUrl} aria-label={t.player.previewLabel} onError={() => setNotice(t.player.previewFailed)} /> : <div className={styles['renderEmpty']}><QuietIcon name={current?.status === 'FAILED' ? 'info' : 'film'} /><strong>{current ? statusLabel[current.status] : t.player.noRender}</strong><span>{current?.status === 'READY' ? t.player.readyNoLink : current?.status === 'FAILED' ? t.player.failedHint : t.player.realOnly}</span></div>}</div>
      {current?.status === 'READY' && current.outputAssetIds.length > 0 && <div className="row mt8"><button type="button" className="textbtn small" disabled={media.isFetching} onClick={() => void media.refetch()}>{media.isFetching ? t.player.fetchingLink : t.player.refreshLink}</button>{media.isError && <span role="alert" className="small muted">{t.player.linkFailed(describeError(media.error).message)}</span>}</div>}
      <section className="panel pad mt24"><div className="row between"><h3>{t.version.title}</h3>{current && <span className="badge blue">{current.id.slice(0, 10)}</span>}</div><div className="row between mt16" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}><div><strong className="small">{profiles.find((item) => item.value === current?.profile)?.label ?? t.version.notSelected}</strong><p className="small muted mt8">{current ? t.version.format(current.input.format.width, current.input.format.height, current.input.format.fps, current.input.projectVersionId.slice(0, 10)) : t.version.immutable}</p></div><label className="small">{t.version.profileLabel} <select className="field select" aria-label={t.version.profileLabel} value={profile} onChange={(event) => setProfile(event.target.value as RenderProfile)}>{profiles.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label></div>
        <div className="row mt24" style={{ flexWrap: 'wrap' }}><button type="button" className="btn" disabled={runPrecheck.isPending} onClick={() => runPrecheck.mutate()}>{runPrecheck.isPending ? t.version.prechecking : t.version.precheck}</button><button type="button" className="btn primary" disabled aria-describedby="render-cost-blocker">{t.version.create}</button>{current?.status === 'QA' && <button type="button" className="btn" disabled={runQa.isPending} onClick={() => runQa.mutate()}>{t.version.rerunQa}</button>}</div>
        <p id="render-cost-blocker" role="status" className="notice amber mt16">{t.version.costBlocker}</p>
        {precheck?.verdict === 'FAIL' && <p role="alert" className="small muted mt16">{t.version.precheckBlocked}</p>}
        <p className="small muted mt16">{t.version.workerNote}</p></section>
      <div className="row between mt24"><span className="small muted">{t.version.needChanges}</span><Link className="btn small" href={`/w/${workspaceId}/p/${projectId}/editor`}><QuietIcon name="undo" />{t.version.backToStoryboard}</Link></div>
      <section className="panel pad mt24"><div className="row between"><h3>{t.queue.title}</h3>{renders.isFetching && <span className="small muted">{t.queue.updating}</span>}</div>{renders.isPending && <p className="small muted mt16">{t.queue.loading}</p>}{renders.isError && <p className="small muted mt16">{t.queue.failed(describeError(renders.error).message)}</p>}{renders.data?.length === 0 && <p className="small muted mt16">{t.queue.empty}</p>}<div className={styles['renderQueue']}>{renders.data?.slice(0, 8).map((render) => <button key={render.id} type="button" data-testid={`render-${render.id}`} className={`${styles['queueItem']} ${current?.id === render.id ? styles['queueSelected'] : ''}`} onClick={() => { setSelectedId(render.id); setReviewed(false); setExportBundle(null); }}><span className={`badge ${render.status === 'READY' ? 'green' : render.status === 'FAILED' ? 'red' : 'amber'}`}>{statusLabel[render.status]}</span><span>{profiles.find((item) => item.value === render.profile)?.label}</span><span className="small muted">{new Date(render.createdAt).toLocaleString(locale)}</span></button>)}</div></section>
    </section><aside className="col"><section className="panel pad"><div className="row between"><h3>{t.check.title}</h3>{qa.data && <span className={`badge ${qa.data.verdict === 'PASS' ? 'green' : 'red'}`}>{qa.data.verdict}</span>}</div>{qa.isPending && current && <p className="small muted mt16">{t.check.loading}</p>}{qa.isError && <p role="alert" className="small muted mt16">{t.check.failed(describeError(qa.error).message)} <button type="button" className="textbtn small" onClick={() => void qa.refetch()}>{t.check.retry}</button></p>}{qa.data ? <div className="check-list">{qa.data.checks.map((check) => <div key={check.id} className="check-item"><QuietIcon name={check.status === 'PASS' ? 'check' : 'info'} /><div><strong>{check.category} · {check.id}</strong><p>{check.message ?? check.status}</p></div></div>)}</div> : <p className="small muted mt16">{t.check.empty}</p>}{current?.status === 'FAILED' && <div className="notice amber mt16"><QuietIcon name="info" /><span>{t.check.renderFailed(String(current.error?.['reason'] ?? t.check.seeLogs))}</span></div>}</section>
      {current?.status === 'READY' && <section className="panel pad" data-testid="approval-panel"><h3>{t.approval.title}</h3><p className="small muted mt8">{t.approval.binding(current.manifestHash?.slice(0, 12) ?? t.approval.unknownManifest)}</p>{approved ? <><p className="badge green mt16"><QuietIcon name="check" />{t.approval.approvedAt(approval.data?.createdAt ? new Date(approval.data.createdAt).toLocaleString(locale) : t.approval.unknownTime)}</p><div className="mt24"><button type="button" className="btn primary full" disabled={exportRender.isPending} onClick={() => exportRender.mutate(current.id)}>{exportRender.isPending ? t.approval.preparing : t.approval.getDownload}</button></div><Link className="textbtn mt16" href={`/w/${workspaceId}/p/${projectId}/publish`}>{t.approval.goToPublish} <QuietIcon name="arrow" /></Link></> : <>{approval.data?.decision === 'REJECTED' && <p className="notice amber mt16">{t.approval.lastRejected(approval.data.note ?? t.approval.noNote)}</p>}<label className="checkboxrow mt16"><input type="checkbox" disabled={!canApprove} checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} /><span>{t.approval.confirm}</span></label><label className="label mt16">{t.approval.noteLabel}<input className="field" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} /></label><div className="mt24"><button type="button" className="btn primary full" disabled={!reviewed || !canApprove || decide.isPending} onClick={() => decide.mutate('APPROVED')}><QuietIcon name="check" />{t.approval.approve}</button></div><button type="button" className="textbtn small mt8" disabled={decide.isPending} onClick={() => decide.mutate('REJECTED')} style={{ width: '100%', justifyContent: 'center' }}>{t.approval.reject}</button></>}{activeExportBundle && <div data-testid="export-package" className="notice green mt24"><div><strong>{t.approval.snapshot(activeExportBundle.projectVersionId.slice(0, 12))}</strong>{activeExportBundle.projectEditedSinceApproval && <p>{t.approval.editedSince}</p>}<ul className="mt8">{activeExportBundle.entries.map((entry) => <li key={entry.kind}>{Date.parse(entry.download.expiresAt) > Date.now() + 5000 ? <a href={entry.download.url} target="_blank" rel="noopener noreferrer" onClick={(event) => { if (Date.parse(entry.download.expiresAt) <= Date.now() + 5000) { event.preventDefault(); setNotice(t.approval.linkExpired); } }}>{t.approval.download(entry.kind)}</a> : <span>{t.approval.kindExpired(entry.kind)}</span>}</li>)}</ul></div></div>}</section>}
      {current?.status === 'READY' && !approved && !canApprove && <p role="status" className="small muted">{t.approval.unavailable(qa.isPending || approval.isPending ? t.approval.loadingState : qa.isError ? t.approval.qaFailed : approval.isError ? t.approval.approvalReadFailed : t.approval.needPassingQa)}</p>}
      {approval.isError && current?.status === 'READY' && <p role="alert" className="small muted">{t.approval.loadFailed(describeError(approval.error).message)} <button type="button" className="textbtn small" onClick={() => void approval.refetch()}>{t.check.retry}</button></p>}
    </aside></div>
    {precheck && <div className="mt24"><QaPanel report={precheck} title={t.precheckTitle} /></div>}
    {qa.data && <div className="mt24"><QaPanel report={qa.data} title={t.fullQaTitle} /></div>}
  </div>;
}
