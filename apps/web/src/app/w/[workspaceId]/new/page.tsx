'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DOCUMENT_IMPORT_MAX_BYTES, type ContentDocumentRecord } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useLegacyPipelineOff, useWorkspace } from '@/lib/queries';
import { LegacyPipelineNotice } from '@/ui/LegacyPipelineNotice';
import { QuietIcon } from '@/ui/QuietIcon';
import { useI18n } from '@/i18n/I18nProvider';

type SourceKind = 'url' | 'text' | 'file';
const FILE_TYPES: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  eml: 'message/rfc822', html: 'text/html', htm: 'text/html',
};
const key = () => `idem_${crypto.randomUUID().replaceAll('-', '')}`;
const progressKey = (workspaceId: string) => `ancs-new-project-progress:${workspaceId}`;
const saveProgress = (workspaceId: string, projectId: string, documentId: string | null, sourceKind: SourceKind) => {
  try { window.sessionStorage.setItem(progressKey(workspaceId), JSON.stringify({ projectId, documentId, sourceKind })); }
  catch { /* The current session remains usable if browser storage is unavailable. */ }
};

export default function NewProjectPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const { messages } = useI18n();
  const t = messages.entry.newProject;
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const legacyOff = useLegacyPipelineOff();
  const workspace = useWorkspace(workspaceId);
  const canEdit = workspace.data?.role === 'OWNER' || workspace.data?.role === 'ADMIN' || workspace.data?.role === 'EDITOR';
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreRetry, setRestoreRetry] = useState(0);
  const [kind, setKind] = useState<SourceKind>('url');
  const [sources, setSources] = useState({ url: '', text: '' });
  const source = kind === 'file' ? '' : sources[kind];
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [durationMs, setDurationMs] = useState(300_000);
  const [document, setDocument] = useState<ContentDocumentRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectRef = useRef<string | null>(null);
  const createKeyRef = useRef<string | null>(null);
  const contentKeyRef = useRef<string | null>(null);
  const extractedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let stored: { projectId?: unknown; documentId?: unknown; sourceKind?: unknown } | null = null;
    try {
      const raw = window.sessionStorage.getItem(progressKey(workspaceId));
      stored = raw ? JSON.parse(raw) as { projectId?: unknown; documentId?: unknown; sourceKind?: unknown } : null;
    } catch { /* Bad or inaccessible storage is treated as no saved progress. */ }
    if (typeof stored?.projectId !== 'string' || (stored.documentId !== null && typeof stored.documentId !== 'string')) {
      setRestoring(false);
      return;
    }
    const projectId = stored.projectId;
    const documentId = stored.documentId;
    const sourceKind = stored.sourceKind;
    setRestoring(true);
    setRestoreError(null);
    void (async () => {
      try {
        const project = await client.projects.get(projectId);
        if (project.workspaceId !== workspaceId) throw new Error(t.restoreForeignProject);
        const record = typeof documentId === 'string' ? await client.content.get(workspaceId, projectId, documentId) : null;
        if (cancelled) return;
        projectRef.current = projectId;
        setTitle(project.title);
        if (project.targetDurationMs !== null) setDurationMs(project.targetDurationMs);
        setKind(sourceKind === 'url' || sourceKind === 'text' || sourceKind === 'file' ? sourceKind : project.sourceType === 'PASTED_TEXT' ? 'text' : project.sourceType === 'FILE' ? 'file' : 'url');
        setDocument(record);
        setRestoreError(null);
      } catch (cause) {
        if (!cancelled) setRestoreError(t.restoreFailed(describeError(cause).message));
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => { cancelled = true; };
  }, [client, workspaceId, restoreRetry]);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem('ancs-new-project-draft');
      if (!raw) return;
      const draft = JSON.parse(raw) as { kind?: SourceKind; value?: string };
      if (draft.kind === 'url' || draft.kind === 'text' || draft.kind === 'file') setKind(draft.kind);
      if (draft.value) {
        if (draft.kind === 'url' || draft.kind === 'text') setSources((current) => ({ ...current, [draft.kind as 'url' | 'text']: draft.value ?? '' }));
        if (draft.kind === 'text') setTitle(draft.value.trim().slice(0, 70).split('\n')[0] ?? '');
      }
      window.sessionStorage.removeItem('ancs-new-project-draft');
    } catch { /* A new project must remain usable if draft storage is unavailable. */ }
  }, []);

  const ingest = useMutation({
    mutationFn: async () => {
      const cleanTitle = title.trim();
      if (!cleanTitle) throw new Error(t.titleRequired);
      if (kind === 'url') {
        let parsed: URL;
        try { parsed = new URL(source.trim()); } catch { throw new Error(t.urlInvalid); }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(t.urlProtocol);
      } else if (kind === 'text' && !source.trim()) throw new Error(t.textRequired);
      else if (kind === 'file' && file === null) throw new Error(t.fileRequired);
      if (kind === 'file' && file) {
        if (file.size === 0) throw new Error(t.fileEmpty);
        if (file.size > DOCUMENT_IMPORT_MAX_BYTES) throw new Error(t.fileTooLarge);
        const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
        if (ext !== 'txt' && FILE_TYPES[ext] === undefined) throw new Error(t.fileUnsupported);
      }
      if (projectRef.current === null) {
        const channels = await client.channels.list(workspaceId);
        const channel = channels[0] ?? await client.channels.create(workspaceId, { name: t.defaultChannel });
        createKeyRef.current ??= key();
        const project = await client.projects.create(workspaceId, {
          title: cleanTitle,
          channelId: channel.id,
          sourceType: kind === 'url' ? 'URL' : kind === 'text' ? 'PASTED_TEXT' : 'FILE',
          targetDurationMs: durationMs,
        }, { idempotencyKey: createKeyRef.current });
        projectRef.current = project.id;
        saveProgress(workspaceId, project.id, null, kind);
        void queryClient.invalidateQueries({ queryKey: queryKeys.projects(workspaceId) });
      }
      const projectId = projectRef.current;
      if (projectId === null) throw new Error(t.missingProjectId);
      contentKeyRef.current ??= key();
      if (kind === 'url') return client.content.create(workspaceId, projectId, { sourceType: 'URL_ARTICLE', url: source.trim() }, { idempotencyKey: contentKeyRef.current });
      if (kind === 'text') return client.content.create(workspaceId, projectId, { sourceType: 'PASTED_TEXT', text: source.trim(), title: cleanTitle }, { idempotencyKey: contentKeyRef.current });
      if (!file) throw new Error(t.documentRequired);
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (ext === 'txt') return client.content.create(workspaceId, projectId, { sourceType: 'PASTED_TEXT', text: await file.text(), title: cleanTitle }, { idempotencyKey: contentKeyRef.current });
      return client.content.importDocument(workspaceId, projectId, { filename: file.name, contentType: FILE_TYPES[ext] ?? file.type, data: new Uint8Array(await file.arrayBuffer()) }, { idempotencyKey: contentKeyRef.current });
    },
    onSuccess: (result) => {
      if (projectRef.current) saveProgress(workspaceId, projectRef.current, result.document.id, kind);
      setDocument(result);
      setError(null);
    },
    onError: (cause) => setError(describeError(cause).message),
  });
  const generate = useMutation({
    mutationFn: async () => {
      const projectId = projectRef.current;
      if (!document || !projectId) throw new Error(t.readFirst);
      if (!extractedRef.current) {
        await client.evidence.extract(workspaceId, projectId, document.document.id);
        extractedRef.current = true;
      }
      return client.narrative.generate(workspaceId, projectId, document.document.id, { targetDurationMs: durationMs });
    },
    onSuccess: () => {
      const projectId = projectRef.current;
      if (projectId) {
        try { window.sessionStorage.removeItem(progressKey(workspaceId)); } catch { /* Navigation still succeeds. */ }
        void queryClient.invalidateQueries({ queryKey: queryKeys.narrative(workspaceId, projectId) });
        router.push(`/w/${workspaceId}/p/${projectId}/script`);
      }
    },
    onError: (cause) => setError(describeError(cause).message),
  });
  const chooseKind = (next: SourceKind) => { if (!canEdit || restoring || restoreError || ingest.isPending || document !== null) return; setKind(next); if (projectRef.current) saveProgress(workspaceId, projectRef.current, null, next); setDocument(null); setError(null); contentKeyRef.current = null; };
  const changeSource = (value: string) => { if (kind !== 'file') setSources((current) => ({ ...current, [kind]: value })); contentKeyRef.current = null; };
  const changeFile = (value: File | null) => { setFile(value); contentKeyRef.current = null; };
  const preview = document?.document.blocks.find((block) => block.text?.trim())?.text ?? '';

  // 旧 V4 流水线下线：这里的写稿 → 分镜流程不可用，只给说明和去共看片室的入口
  if (legacyOff) return <div className="page narrow"><LegacyPipelineNotice workspaceId={workspaceId} /></div>;

  return <div className="page narrow">
    <div className="page-head"><h1>{t.title}</h1><p>{t.subtitle}</p></div>
    {restoring ? <p className="notice mt16" role="status">{t.restoring}</p> : null}
    {restoreError ? <div className="notice amber mt16" role="alert"><span>{restoreError}</span><button type="button" className="textbtn" onClick={() => setRestoreRetry((value) => value + 1)}>{t.retryRestore}</button></div> : null}
    {!restoring && !restoreError && projectRef.current ? <p className="notice mt16" role="status">{document ? t.createdWithSnapshot : t.createdWithoutSnapshot}</p> : null}
    {workspace.isError ? <p role="alert" className="notice amber mt16">{t.workspaceCheckFailed(describeError(workspace.error).message)}</p> : workspace.data && !canEdit ? <p className="notice mt16">{t.viewerOnly}</p> : null}
    <div className="steps mb24" aria-label={t.stepsAria}><span className="step active"><span className="step-num">1</span>{t.steps.import}</span><span className="step-line" /><span className="step"><span className="step-num">2</span>{t.steps.script}</span><span className="step-line" /><span className="step"><span className="step-num">3</span>{t.steps.storyboard}</span><span className="step-line" /><span className="step"><span className="step-num">4</span>{t.steps.deliver}</span></div>
    <div className="split">
      <section className="panel import-panel">
        <div className="import-tabs" role="tablist" aria-label={t.sourceAria}>
          {([['url', 'link', t.tabs.url], ['text', 'text', t.tabs.text], ['file', 'file', t.tabs.file]] as const).map(([value, icon, label]) => <button key={value} className={`import-tab ${kind === value ? 'active' : ''}`} role="tab" aria-selected={kind === value} disabled={!canEdit || restoring || restoreError !== null || ingest.isPending || (document !== null && kind !== value)} onClick={() => chooseKind(value)}><QuietIcon name={icon} />{label}</button>)}
        </div>
        <div className="import-body">
          {kind === 'url' ? <><label className="label" htmlFor="source-url">{t.urlLabel}</label><div className="row inputline"><input id="source-url" className="field grow" type="url" value={source} onChange={(event) => changeSource(event.target.value)} placeholder="https://your-site.com/article" disabled={!canEdit || restoring || restoreError !== null || document !== null} /><button type="button" className="btn primary" onClick={() => ingest.mutate()} disabled={!canEdit || restoring || restoreError !== null || ingest.isPending || document !== null}><QuietIcon name="arrow" />{ingest.isPending ? t.reading : t.readArticle}</button></div><p className="small muted mt16">{t.urlHint}</p></>
            : kind === 'text' ? <><label className="label" htmlFor="source-text">{t.textLabel}</label><textarea id="source-text" className="field" rows={8} value={source} onChange={(event) => changeSource(event.target.value)} placeholder={t.textPlaceholder} disabled={!canEdit || restoring || restoreError !== null || document !== null} /><button type="button" className="btn primary mt16" onClick={() => ingest.mutate()} disabled={!canEdit || restoring || restoreError !== null || ingest.isPending || document !== null}><QuietIcon name="arrow" />{ingest.isPending ? t.reading : t.readText}</button></>
              : <><label className="filearea qf-filearea" htmlFor="source-file" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (canEdit && !restoring && !restoreError && !document) changeFile(event.dataTransfer.files[0] ?? null); }}><QuietIcon name="upload" /><h3>{file?.name ?? t.fileDrop}</h3><p className="small muted mt8">{t.fileFormats}</p><input id="source-file" type="file" accept=".txt,.md,.markdown,.pdf,.docx,.eml,.html,.htm" className="qf-file-input" onChange={(event) => changeFile(event.target.files?.[0] ?? null)} disabled={!canEdit || restoring || restoreError !== null || document !== null} /></label><button type="button" className="btn primary mt16" onClick={() => ingest.mutate()} disabled={!canEdit || restoring || restoreError !== null || ingest.isPending || document !== null}><QuietIcon name="arrow" />{ingest.isPending ? t.reading : t.readDocument}</button></>}
          <div className="source-preview" aria-live="polite">
            <div className="row between"><span className="badge"><QuietIcon name="file" />{document ? t.parsedBadge : t.previewBadge}</span><span className="small muted">{document ? t.parsedNote : t.previewNote}</span></div>
            {document ? <><h3 className="mt16">{document.document.title}</h3><p className="small muted mt8">{preview.slice(0, 220)}{preview.length > 220 ? '…' : ''}</p><div className="row mt16 gap8"><span className="badge">{t.blockCount(document.normalization.blockCount)}</span><span className="badge">{document.document.language}</span><span className="badge">{t.claimCount(document.normalization.claims)}</span></div></> : <p className="small muted mt16">{t.previewEmpty}</p>}
          </div>
          {error ? <div className="notice amber mt24" role="alert"><QuietIcon name="info" /><span>{error}</span></div> : null}
          {projectRef.current && error ? <Link className="textbtn mt16" href={`/w/${workspaceId}/p/${projectRef.current}/script`}>{t.openCreated} <QuietIcon name="arrow" /></Link> : null}
          <div className="notice mt24"><QuietIcon name="shield" /><div><strong>{t.factsTitle}</strong><br />{t.factsBody}</div></div>
        </div>
      </section>
      <aside className="col">
        <section className="panel pad">
          <div className="row between"><h3>{t.directionTitle}</h3><span className="badge">{t.adjustable}</span></div>
          <label className="label mt24" htmlFor="project-name">{t.nameLabel}</label><input id="project-name" className="field" value={title} onChange={(event) => { setTitle(event.target.value); createKeyRef.current = null; }} disabled={!canEdit || restoring || restoreError !== null || projectRef.current !== null} placeholder={t.namePlaceholder} />
          <div className="settings-row"><div><h4>{t.duration}</h4><p>{t.durationHint}</p></div><select className="compact-select" aria-label={t.duration} value={durationMs} disabled={!canEdit || restoring || restoreError !== null || projectRef.current !== null} onChange={(event) => setDurationMs(Number(event.target.value))}><option value={180000}>{t.durations.short}</option><option value={300000}>{t.durations.medium}</option><option value={540000}>{t.durations.long}</option></select></div>
          <div className="settings-row"><div><h4>{t.aspectTitle}</h4><p>{t.aspectHint}</p></div><span className="badge">{t.aspectValue}</span></div>
          <div className="settings-row"><div><h4>{t.styleTitle}</h4><p>{t.styleHint}</p></div><span className="small muted">{t.styleValue}</span></div>
          <div className="settings-row"><div><h4>{t.voiceTitle}</h4><p>{t.voiceHint}</p></div><Link className="textbtn small" href={`/w/${workspaceId}/identity`}>{t.identityLink}</Link></div>
          <div className="mt24"><button type="button" className="btn primary full" disabled={!canEdit || restoring || restoreError !== null || document === null || generate.isPending} onClick={() => generate.mutate()}><QuietIcon name="spark" />{generate.isPending ? t.generating : t.generate}</button></div>
          <p className="small muted mt16">{t.generateNote}</p>
        </section>
        <p className="small muted" style={{ padding: '0 8px', lineHeight: 1.9 }}>{t.footnote}</p>
      </aside>
    </div>
  </div>;
}
