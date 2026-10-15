'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContentSource } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useNarrative, useWorkspace } from '@/lib/queries';
import { StateBlock } from '@/ui/StateBlock';
import { useWorkflowDialog } from '@/components/quiet-frame/workflow-dialog';
import '@/components/quiet-frame/workflow.css';

const duration = (ms: number, format: (minutes: string, seconds: string) => string) => format(String(Math.floor(ms / 60000)), String(Math.floor((ms % 60000) / 1000)).padStart(2, '0'));
const sourceHref = (source: ContentSource): string | null => {
  try {
    const url = new URL(source.url);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

/** Server snapshots and edit permissions stay authoritative; this page only changes their presentation. */
export default function ScriptPage() {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const t = useI18n().messages.projectFlow.script;
  const formatDuration = (ms: number) => duration(ms, t.duration);
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  const narrative = useNarrative(workspaceId, projectId);
  const workspace = useWorkspace(workspaceId);
  const canEdit = workspace.data?.role === 'OWNER' || workspace.data?.role === 'ADMIN' || workspace.data?.role === 'EDITOR';
  const [articleUrl, setArticleUrl] = useState('');
  const [blockError, setBlockError] = useState<string | null>(null);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [editingDrafts, setEditingDrafts] = useState<Record<string, string>>({});
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<ContentSource | null>(null);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const closeDrawer = () => { setSelectedSource(null); setSelectedClaimId(null); };
  const drawerRef = useWorkflowDialog(selectedSource !== null || selectedClaimId !== null, closeDrawer, drawerTrigger);

  const sources = useQuery({
    queryKey: ['projects', projectId, 'sources', workspaceId],
    enabled: narrative.data != null,
    queryFn: () => client.content.sources(workspaceId, projectId),
  });
  const claims = useQuery({
    queryKey: ['projects', projectId, 'claims', workspaceId],
    enabled: selectedClaimId !== null,
    queryFn: () => client.evidence.claims(workspaceId, projectId),
  });
  const citations = useQuery({
    queryKey: ['projects', projectId, 'citations', workspaceId, selectedClaimId],
    enabled: selectedClaimId !== null,
    queryFn: () => client.evidence.citations(workspaceId, projectId, selectedClaimId as string),
  });

  const importAndGenerate = useMutation({
    mutationFn: async (url: string) => {
      const document = await client.content.create(workspaceId, projectId, { sourceType: 'URL_ARTICLE', url });
      await client.evidence.extract(workspaceId, projectId, document.document.id);
      return client.narrative.generate(workspaceId, projectId, document.document.id, { targetDurationMs: 120_000 });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.narrative(workspaceId, projectId) }),
  });
  const updateBlock = useMutation({
    mutationFn: (input: { blockId: string; text?: string; locked?: boolean }) =>
      client.narrative.updateBlock(workspaceId, projectId, narrative.data?.id ?? '', input.blockId, {
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.locked !== undefined ? { locked: input.locked } : {}),
      }),
    onSuccess: (_result, input) => {
      setBlockError(null);
      if (input.text !== undefined) {
        setEditingBlockId(null);
        setEditingDrafts((current) => {
          const next = { ...current };
          delete next[input.blockId];
          return next;
        });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.narrative(workspaceId, projectId) });
    },
    onError: (error) => {
      const described = describeError(error);
      setBlockError(described.kind === 'conflict' ? t.conflictMessage(described.message) : described.message);
    },
  });

  if (narrative.isPending) return <div className="page qf-workflow"><StateBlock variant="loading" title={t.loading} /></div>;
  if (narrative.isError) {
    const described = describeError(narrative.error);
    return <div className="page qf-workflow"><StateBlock variant={described.kind === 'forbidden' ? 'forbidden' : 'error'} title={t.loadFailed} description={described.message} diagnostics={described.code ?? undefined} action={{ label: t.retry, onClick: () => void narrative.refetch() }} /></div>;
  }
  const plan = narrative.data;
  if (plan == null) return <div className="page qf-workflow qf-script-empty">
    <StateBlock variant="empty" title={t.emptyTitle} description={t.emptyDescription}>
      {workspace.isError ? <p role="alert" className="qf-error">{t.workspaceRoleUnknown(describeError(workspace.error).message)}</p> : !canEdit && workspace.data ? <p className="small muted">{t.readOnly}</p> : null}
      <form className="row qf-import-form" onSubmit={(event) => { event.preventDefault(); if (canEdit && articleUrl.trim()) importAndGenerate.mutate(articleUrl.trim()); }}>
        <input aria-label={t.articleUrlAria} type="url" required value={articleUrl} onChange={(event) => setArticleUrl(event.target.value)} placeholder="https://example.com/article" className="field" disabled={!canEdit} />
        <button type="submit" disabled={!canEdit || importAndGenerate.isPending} className="btn primary">{importAndGenerate.isPending ? t.generating : t.importAndGenerate}</button>
      </form>
      {importAndGenerate.isError ? <p role="alert" className="qf-error">{describeError(importAndGenerate.error).message}</p> : null}
    </StateBlock>
  </div>;

  const shownClaim = claims.data?.find((claim) => claim.id === selectedClaimId);
  return <div className="page qf-workflow qf-script-page" style={{ paddingTop: 29 }}>
    <div className="script-layout">
      <nav className="chapter-nav" aria-label={t.outline}>
        <div className="eyebrow" style={{ padding: '7px 10px 12px' }}>{t.outline}</div>
        {plan.chapters.map((chapter, index) => <button type="button" key={chapter.id} className={(activeChapterId ?? plan.chapters[0]?.id) === chapter.id ? 'active' : ''} onClick={() => { setActiveChapterId(chapter.id); document.getElementById('chapter-' + chapter.id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }}><span className="qf-chapter-number">{String(index + 1).padStart(2, '0')}</span>{chapter.title}</button>)}
        <hr className="divider" /><p className="small muted qf-outline-meta">{t.approxDuration(formatDuration(plan.estimatedDurationMs))}<br />{t.readingView}</p>
      </nav>
      <article className="paper">
        {workspace.isError ? <p role="alert" className="qf-error">{t.workspaceRoleUnknown(describeError(workspace.error).message)}</p> : !canEdit && workspace.data ? <p className="notice">{t.readOnly}</p> : null}
        <div className="row between"><span className="badge blue">{t.draftBadge}</span><span className="small muted">{t.lockedCount(plan.narrationBlocks.filter((block) => block.locked).length, plan.narrationBlocks.length)}</span></div>
        <h1>{plan.title}</h1>
        <div className="row gap8 small muted"><span>Revision {plan.revision}</span><span>·</span><span>{t.approxDuration(formatDuration(plan.estimatedDurationMs))}</span><span>·</span><span>{plan.generation.method === 'LLM' ? t.aiDraft : t.manualScript}</span></div>
        <p className="lead">{plan.hook || plan.thesis}</p>
        {blockError !== null ? <StateBlock variant="conflict" title={t.blockRejected} description={blockError} action={{ label: t.gotIt, onClick: () => setBlockError(null) }} /> : null}
        {plan.chapters.map((chapter, index) => <section key={chapter.id} id={'chapter-' + chapter.id} className="qf-script-chapter">
          <h2>{String(index + 1).padStart(2, '0')} · {chapter.title}</h2>
          {plan.narrationBlocks.filter((block) => block.chapterId === chapter.id).map((block) => <div key={block.id} className="qf-script-block">
            {editingBlockId === block.id ? <div className="qf-script-edit"><textarea aria-label={t.narrationTextAria(block.id)} className="field" rows={4} value={editingText} disabled={!canEdit} onChange={(event) => { setEditingText(event.target.value); setEditingDrafts((current) => ({ ...current, [block.id]: event.target.value })); }} /><div className="row"><button type="button" disabled={!canEdit || updateBlock.isPending || !editingText.trim() || block.locked} onClick={() => updateBlock.mutate({ blockId: block.id, text: editingText })} className="btn small primary">{t.saveText}</button><button type="button" onClick={() => { setEditingBlockId(null); setEditingDrafts((current) => { const next = { ...current }; delete next[block.id]; return next; }); }} className="btn small ghost">{t.cancel}</button></div></div> : <p>{block.text}{block.claimIds.map((claimId, claimIndex) => <button type="button" key={claimId} className="source-ref" aria-label={t.claimRefAria(claimId)} onClick={(event) => { drawerTrigger.current = event.currentTarget; setSelectedClaimId(claimId); }}>{claimIndex + 1}</button>)}</p>}
            <div className="qf-block-actions"><span className="small muted">{t.blockMeta(block.status === 'APPROVED' ? t.blockStatus.approved : block.status === 'NEEDS_REVIEW' ? t.blockStatus.needsReview : t.blockStatus.draft, formatDuration(block.estimatedDurationMs))}</span><div className="row gap8"><button type="button" disabled={!canEdit || updateBlock.isPending} className="textbtn small" onClick={() => updateBlock.mutate({ blockId: block.id, locked: !block.locked })}>{block.locked ? t.unlock : t.lock}</button><button type="button" disabled={!canEdit || block.locked || updateBlock.isPending} title={block.locked ? t.unlockFirst : !canEdit ? t.viewOnly : undefined} className="textbtn small" onClick={() => { setEditingBlockId(block.id); setEditingText(editingDrafts[block.id] ?? block.text); }}>{t.edit}</button></div></div>
          </div>)}
        </section>)}
        <div className="row between qf-paper-footer"><span className="sample-note">{t.footerNote}</span><Link className="textbtn" href={'/w/' + workspaceId + '/p/' + projectId + '/storyboard'}>{t.toDirector}</Link></div>
      </article>
      <aside className="sources-side col" aria-label={t.sourcesTitle}>
        <section className="panel pad qf-source-panel"><div className="row between"><h3>{t.sourcesTitle}</h3><span className="badge">{t.sourceCount(sources.data?.length ?? 0)}</span></div>
          {sources.isPending ? <p className="small muted mt16">{t.sourcesLoading}</p> : sources.isError ? <p className="qf-error mt16">{t.sourcesFailed}<button type="button" className="textbtn small" onClick={() => void sources.refetch()}>{t.retry}</button></p> : sources.data?.length === 0 ? <p className="small muted mt16">{t.sourcesEmpty}</p> : sources.data?.map((source, index) => <div className="sourceitem" key={source.id}><span className="source-index">{index + 1}</span><div><strong>{source.title}</strong><p>{source.publisher} · {source.snapshotKind === 'fixture_reconstruction' ? t.snapshotKinds.fixture : source.snapshotKind === 'document_upload' ? t.snapshotKinds.upload : t.snapshotKinds.live}</p><button type="button" className="textbtn small" onClick={(event) => { drawerTrigger.current = event.currentTarget; setSelectedSource(source); }}>{t.viewSource}</button></div></div>)}
          <hr className="divider" /><p className="small muted qf-source-note">{t.sourcesNote}</p>
        </section>
        <section className="panel pad qf-source-panel"><h3>{t.improveTitle}</h3><p className="small muted mt8">{t.improveBody}</p><Link href={'/w/' + workspaceId + '/p/' + projectId + '/storyboard'} className="btn small full ghost mt16">{t.openAiEdit}</Link></section>
      </aside>
    </div>
    {selectedSource !== null || selectedClaimId !== null ? <div className="qf-workflow-backdrop" onClick={closeDrawer}><aside ref={drawerRef} tabIndex={-1} className="qf-workflow-drawer" role="dialog" aria-modal="true" aria-label={t.drawerAria} onClick={(event) => event.stopPropagation()}><div className="row between"><h2>{selectedSource?.title ?? t.claimFallbackTitle}</h2><button type="button" autoFocus className="btn small ghost" onClick={closeDrawer}>{t.close}</button></div>{selectedSource !== null ? <><p className="small muted mt16">{t.sourceMeta(selectedSource.publisher, selectedSource.retrievedAt)}</p><p className="mt16">{selectedSource.excerpt}</p>{sourceHref(selectedSource) !== null ? <a className="textbtn mt16" href={sourceHref(selectedSource) ?? undefined} target="_blank" rel="noopener noreferrer">{t.openOriginal}</a> : <p className="small muted mt16">{t.noSafeUrl}</p>}</> : <>{claims.isPending || citations.isPending ? <p className="small muted mt16">{t.citationsLoading}</p> : claims.isError || citations.isError ? <p role="alert" className="qf-error mt16">{t.citationsFailed(describeError(claims.error ?? citations.error).message)}<button type="button" className="textbtn" onClick={() => { void claims.refetch(); void citations.refetch(); }}>{t.retry}</button></p> : <><p className="mt16">{shownClaim?.text ?? t.claimMissing}</p><p className="small muted mt8">{t.citationMeta(shownClaim?.factuality ?? t.factualityUnknown, citations.data?.length ?? 0)}</p>{citations.data?.map((citation) => <div className="sourceitem" key={citation.id}><span className="source-index">↗</span><div><strong>{sources.data?.find((source) => source.id === citation.sourceId)?.title ?? citation.sourceId}</strong><p>{citation.quotedText ?? citation.locator}</p></div></div>)}</>}</>}</aside></div> : null}
  </div>;
}
