'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContentSource } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useNarrative, useWorkspace } from '@/lib/queries';
import { StateBlock } from '@/ui/StateBlock';
import { useWorkflowDialog } from '@/components/quiet-frame/workflow-dialog';
import '@/components/quiet-frame/workflow.css';

const duration = (ms: number) => Math.floor(ms / 60000) + ' 分 ' + String(Math.floor((ms % 60000) / 1000)).padStart(2, '0') + ' 秒';
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
      setBlockError(described.kind === 'conflict' ? '旁白修改发生冲突，未提交文本；草稿已保留。' + described.message : described.message);
    },
  });

  if (narrative.isPending) return <div className="page qf-workflow"><StateBlock variant="loading" title="正在加载叙事计划…" /></div>;
  if (narrative.isError) {
    const described = describeError(narrative.error);
    return <div className="page qf-workflow"><StateBlock variant={described.kind === 'forbidden' ? 'forbidden' : 'error'} title="加载叙事计划失败" description={described.message} diagnostics={described.code ?? undefined} action={{ label: '重试', onClick: () => void narrative.refetch() }} /></div>;
  }
  const plan = narrative.data;
  if (plan == null) return <div className="page qf-workflow qf-script-empty">
    <StateBlock variant="empty" title="还没有叙事计划" description="导入文章后系统会抽取可追溯事实、生成叙事计划。当前 V1 使用 Mock LLM，结果须人工核对。">
      {workspace.isError ? <p role="alert" className="qf-error">无法确认工作区权限：{describeError(workspace.error).message}</p> : !canEdit && workspace.data ? <p className="small muted">当前角色只能查看脚本。</p> : null}
      <form className="row qf-import-form" onSubmit={(event) => { event.preventDefault(); if (canEdit && articleUrl.trim()) importAndGenerate.mutate(articleUrl.trim()); }}>
        <input aria-label="文章链接" type="url" required value={articleUrl} onChange={(event) => setArticleUrl(event.target.value)} placeholder="https://example.com/article" className="field" disabled={!canEdit} />
        <button type="submit" disabled={!canEdit || importAndGenerate.isPending} className="btn primary">{importAndGenerate.isPending ? '生成中…' : '导入并生成叙事'}</button>
      </form>
      {importAndGenerate.isError ? <p role="alert" className="qf-error">{describeError(importAndGenerate.error).message}</p> : null}
    </StateBlock>
  </div>;

  const shownClaim = claims.data?.find((claim) => claim.id === selectedClaimId);
  return <div className="page qf-workflow qf-script-page" style={{ paddingTop: 29 }}>
    <div className="script-layout">
      <nav className="chapter-nav" aria-label="作品大纲">
        <div className="eyebrow" style={{ padding: '7px 10px 12px' }}>作品大纲</div>
        {plan.chapters.map((chapter, index) => <button type="button" key={chapter.id} className={(activeChapterId ?? plan.chapters[0]?.id) === chapter.id ? 'active' : ''} onClick={() => { setActiveChapterId(chapter.id); document.getElementById('chapter-' + chapter.id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }}><span className="qf-chapter-number">{String(index + 1).padStart(2, '0')}</span>{chapter.title}</button>)}
        <hr className="divider" /><p className="small muted qf-outline-meta">约 {duration(plan.estimatedDurationMs)}<br />阅读视图 · 中文旁白</p>
      </nav>
      <article className="paper">
        {workspace.isError ? <p role="alert" className="qf-error">无法确认工作区权限：{describeError(workspace.error).message}</p> : !canEdit && workspace.data ? <p className="notice">当前角色只能查看脚本。</p> : null}
        <div className="row between"><span className="badge blue">脚本草稿</span><span className="small muted">已锁定 {plan.narrationBlocks.filter((block) => block.locked).length} / {plan.narrationBlocks.length} 段</span></div>
        <h1>{plan.title}</h1>
        <div className="row gap8 small muted"><span>Revision {plan.revision}</span><span>·</span><span>约 {duration(plan.estimatedDurationMs)}</span><span>·</span><span>{plan.generation.method === 'LLM' ? 'AI 草稿 · 请核对事实' : '人工脚本'}</span></div>
        <p className="lead">{plan.hook || plan.thesis}</p>
        {blockError !== null ? <StateBlock variant="conflict" title="旁白块操作被拒绝" description={blockError} action={{ label: '知道了', onClick: () => setBlockError(null) }} /> : null}
        {plan.chapters.map((chapter, index) => <section key={chapter.id} id={'chapter-' + chapter.id} className="qf-script-chapter">
          <h2>{String(index + 1).padStart(2, '0')} · {chapter.title}</h2>
          {plan.narrationBlocks.filter((block) => block.chapterId === chapter.id).map((block) => <div key={block.id} className="qf-script-block">
            {editingBlockId === block.id ? <div className="qf-script-edit"><textarea aria-label={'旁白文本 ' + block.id} className="field" rows={4} value={editingText} disabled={!canEdit} onChange={(event) => { setEditingText(event.target.value); setEditingDrafts((current) => ({ ...current, [block.id]: event.target.value })); }} /><div className="row"><button type="button" disabled={!canEdit || updateBlock.isPending || !editingText.trim() || block.locked} onClick={() => updateBlock.mutate({ blockId: block.id, text: editingText })} className="btn small primary">保存文本</button><button type="button" onClick={() => { setEditingBlockId(null); setEditingDrafts((current) => { const next = { ...current }; delete next[block.id]; return next; }); }} className="btn small ghost">取消</button></div></div> : <p>{block.text}{block.claimIds.map((claimId, claimIndex) => <button type="button" key={claimId} className="source-ref" aria-label={'查看事实引用 ' + claimId} onClick={(event) => { drawerTrigger.current = event.currentTarget; setSelectedClaimId(claimId); }}>{claimIndex + 1}</button>)}</p>}
            <div className="qf-block-actions"><span className="small muted">{block.status === 'APPROVED' ? '已确认' : block.status === 'NEEDS_REVIEW' ? '待核对' : '草稿'} · 约 {duration(block.estimatedDurationMs)}</span><div className="row gap8"><button type="button" disabled={!canEdit || updateBlock.isPending} className="textbtn small" onClick={() => updateBlock.mutate({ blockId: block.id, locked: !block.locked })}>{block.locked ? '解锁' : '锁定'}</button><button type="button" disabled={!canEdit || block.locked || updateBlock.isPending} title={block.locked ? '先解锁该旁白段落' : !canEdit ? '当前角色只能查看' : undefined} className="textbtn small" onClick={() => { setEditingBlockId(block.id); setEditingText(editingDrafts[block.id] ?? block.text); }}>编辑</button></div></div>
          </div>)}
        </section>)}
        <div className="row between qf-paper-footer"><span className="sample-note">修改后需保存 · 锁定段落不会被静默覆盖</span><Link className="textbtn" href={'/w/' + workspaceId + '/p/' + projectId + '/storyboard'}>到导演工作台使用 AI 编辑 →</Link></div>
      </article>
      <aside className="sources-side col" aria-label="来源与核对">
        <section className="panel pad qf-source-panel"><div className="row between"><h3>来源与核对</h3><span className="badge">{sources.data?.length ?? 0} 处来源</span></div>
          {sources.isPending ? <p className="small muted mt16">正在读取来源…</p> : sources.isError ? <p className="qf-error mt16">来源读取失败。<button type="button" className="textbtn small" onClick={() => void sources.refetch()}>重试</button></p> : sources.data?.length === 0 ? <p className="small muted mt16">尚无可追溯来源；请先核对事实和数据。</p> : sources.data?.map((source, index) => <div className="sourceitem" key={source.id}><span className="source-index">{index + 1}</span><div><strong>{source.title}</strong><p>{source.publisher} · {source.snapshotKind === 'fixture_reconstruction' ? '演示来源' : source.snapshotKind === 'document_upload' ? '本地文档' : '在线快照'}</p><button type="button" className="textbtn small" onClick={(event) => { drawerTrigger.current = event.currentTarget; setSelectedSource(source); }}>查看来源 →</button></div></div>)}
          <hr className="divider" /><p className="small muted qf-source-note">来源计数代表关联，不代表事实已经核验。AI 建议不会覆盖锁定的内容。</p>
        </section>
        <section className="panel pad qf-source-panel"><h3>让表达更进一步</h3><p className="small muted mt8">在导演工作台生成可审阅的 AI 修改计划。</p><Link href={'/w/' + workspaceId + '/p/' + projectId + '/storyboard'} className="btn small full ghost mt16">打开 AI 编辑</Link></section>
      </aside>
    </div>
    {selectedSource !== null || selectedClaimId !== null ? <div className="qf-workflow-backdrop" onClick={closeDrawer}><aside ref={drawerRef} tabIndex={-1} className="qf-workflow-drawer" role="dialog" aria-modal="true" aria-label="来源详情" onClick={(event) => event.stopPropagation()}><div className="row between"><h2>{selectedSource?.title ?? '事实引用'}</h2><button type="button" autoFocus className="btn small ghost" onClick={closeDrawer}>关闭</button></div>{selectedSource !== null ? <><p className="small muted mt16">{selectedSource.publisher} · 获取于 {selectedSource.retrievedAt}</p><p className="mt16">{selectedSource.excerpt}</p>{sourceHref(selectedSource) !== null ? <a className="textbtn mt16" href={sourceHref(selectedSource) ?? undefined} target="_blank" rel="noopener noreferrer">打开原始地址 →</a> : <p className="small muted mt16">此来源没有可安全打开的网页地址。</p>}</> : <>{claims.isPending || citations.isPending ? <p className="small muted mt16">正在读取引用…</p> : claims.isError || citations.isError ? <p role="alert" className="qf-error mt16">引用读取失败：{describeError(claims.error ?? citations.error).message}<button type="button" className="textbtn" onClick={() => { void claims.refetch(); void citations.refetch(); }}>重试</button></p> : <><p className="mt16">{shownClaim?.text ?? '未找到事实记录'}</p><p className="small muted mt8">{shownClaim?.factuality ?? '未知类型'} · {citations.data?.length ?? 0} 处引用</p>{citations.data?.map((citation) => <div className="sourceitem" key={citation.id}><span className="source-index">↗</span><div><strong>{sources.data?.find((source) => source.id === citation.sourceId)?.title ?? citation.sourceId}</strong><p>{citation.quotedText ?? citation.locator}</p></div></div>)}</>}</>}</aside></div> : null}
  </div>;
}
