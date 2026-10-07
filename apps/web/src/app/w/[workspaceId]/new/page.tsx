'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DOCUMENT_IMPORT_MAX_BYTES, type ContentDocumentRecord } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useWorkspace } from '@/lib/queries';
import { QuietIcon } from '@/ui/QuietIcon';

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
  const client = useAncsClient();
  const queryClient = useQueryClient();
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
        if (project.workspaceId !== workspaceId) throw new Error('保存的作品不属于当前工作区。');
        const record = typeof documentId === 'string' ? await client.content.get(workspaceId, projectId, documentId) : null;
        if (cancelled) return;
        projectRef.current = projectId;
        setTitle(project.title);
        if (project.targetDurationMs !== null) setDurationMs(project.targetDurationMs);
        setKind(sourceKind === 'url' || sourceKind === 'text' || sourceKind === 'file' ? sourceKind : project.sourceType === 'PASTED_TEXT' ? 'text' : project.sourceType === 'FILE' ? 'file' : 'url');
        setDocument(record);
        setRestoreError(null);
      } catch (cause) {
        if (!cancelled) setRestoreError('恢复上次作品失败：' + describeError(cause).message);
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
      if (!cleanTitle) throw new Error('请填写作品名称。');
      if (kind === 'url') {
        let parsed: URL;
        try { parsed = new URL(source.trim()); } catch { throw new Error('请填写完整的 http:// 或 https:// 文章地址。'); }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('文章地址必须以 http:// 或 https:// 开头。');
      } else if (kind === 'text' && !source.trim()) throw new Error('请粘贴正文。');
      else if (kind === 'file' && file === null) throw new Error('请选择支持的文档。');
      if (kind === 'file' && file) {
        if (file.size === 0) throw new Error('文档为空，请选择有内容的文件。');
        if (file.size > DOCUMENT_IMPORT_MAX_BYTES) throw new Error('文档不能超过 25 MiB。');
        const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
        if (ext !== 'txt' && FILE_TYPES[ext] === undefined) throw new Error('支持 TXT、Markdown、PDF、DOCX、EML 和 HTML。');
      }
      if (projectRef.current === null) {
        const channels = await client.channels.list(workspaceId);
        const channel = channels[0] ?? await client.channels.create(workspaceId, { name: '默认栏目' });
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
      if (projectId === null) throw new Error('作品创建后未返回 ID，请重试。');
      contentKeyRef.current ??= key();
      if (kind === 'url') return client.content.create(workspaceId, projectId, { sourceType: 'URL_ARTICLE', url: source.trim() }, { idempotencyKey: contentKeyRef.current });
      if (kind === 'text') return client.content.create(workspaceId, projectId, { sourceType: 'PASTED_TEXT', text: source.trim(), title: cleanTitle }, { idempotencyKey: contentKeyRef.current });
      if (!file) throw new Error('请选择文档。');
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
      if (!document || !projectId) throw new Error('请先读取内容。');
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

  return <div className="page narrow">
    <div className="page-head"><h1>你的作品，从这里开始。</h1><p>先理解内容，再决定怎么讲。</p></div>
    {restoring ? <p className="notice mt16" role="status">正在恢复上次作品…</p> : null}
    {restoreError ? <div className="notice amber mt16" role="alert"><span>{restoreError}</span><button type="button" className="textbtn" onClick={() => setRestoreRetry((value) => value + 1)}>重试恢复</button></div> : null}
    {!restoring && !restoreError && projectRef.current ? <p className="notice mt16" role="status">作品已创建。{document ? '内容快照已从服务器重新读取，可以继续生成脚本。' : '可重试读取，或改用其他来源；作品类型仍记录首次创建时的来源。'}</p> : null}
    {workspace.isError ? <p role="alert" className="notice amber mt16">无法确认工作区权限：{describeError(workspace.error).message}</p> : workspace.data && !canEdit ? <p className="notice mt16">当前角色可查看工作区，创建作品需要编辑权限。</p> : null}
    <div className="steps mb24" aria-label="创作步骤"><span className="step active"><span className="step-num">1</span>导入内容</span><span className="step-line" /><span className="step"><span className="step-num">2</span>确认脚本</span><span className="step-line" /><span className="step"><span className="step-num">3</span>分镜与编辑</span><span className="step-line" /><span className="step"><span className="step-num">4</span>成片交付</span></div>
    <div className="split">
      <section className="panel import-panel">
        <div className="import-tabs" role="tablist" aria-label="内容来源">
          {([['url', 'link', '文章链接'], ['text', 'text', '粘贴正文'], ['file', 'file', '上传资料']] as const).map(([value, icon, label]) => <button key={value} className={`import-tab ${kind === value ? 'active' : ''}`} role="tab" aria-selected={kind === value} disabled={!canEdit || restoring || restoreError !== null || ingest.isPending || (document !== null && kind !== value)} onClick={() => chooseKind(value)}><QuietIcon name={icon} />{label}</button>)}
        </div>
        <div className="import-body">
          {kind === 'url' ? <><label className="label" htmlFor="source-url">文章地址</label><div className="row inputline"><input id="source-url" className="field grow" type="url" value={source} onChange={(event) => changeSource(event.target.value)} placeholder="https://your-site.com/article" disabled={!canEdit || restoring || restoreError !== null || document !== null} /><button type="button" className="btn primary" onClick={() => ingest.mutate()} disabled={!canEdit || restoring || restoreError !== null || ingest.isPending || document !== null}><QuietIcon name="arrow" />{ingest.isPending ? '读取中…' : '读取文章'}</button></div><p className="small muted mt16">支持公开可读取的文章。受限内容可通过粘贴正文导入。</p></>
            : kind === 'text' ? <><label className="label" htmlFor="source-text">原始内容</label><textarea id="source-text" className="field" rows={8} value={source} onChange={(event) => changeSource(event.target.value)} placeholder="粘贴文章、研究笔记或完整脚本。数字与引用会作为来源保留。" disabled={!canEdit || restoring || restoreError !== null || document !== null} /><button type="button" className="btn primary mt16" onClick={() => ingest.mutate()} disabled={!canEdit || restoring || restoreError !== null || ingest.isPending || document !== null}><QuietIcon name="arrow" />{ingest.isPending ? '读取中…' : '读取正文'}</button></>
              : <><label className="filearea qf-filearea" htmlFor="source-file" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (canEdit && !restoring && !restoreError && !document) changeFile(event.dataTransfer.files[0] ?? null); }}><QuietIcon name="upload" /><h3>{file?.name ?? '拖入资料，或点击选择'}</h3><p className="small muted mt8">TXT、Markdown、PDF、DOCX、EML、HTML</p><input id="source-file" type="file" accept=".txt,.md,.markdown,.pdf,.docx,.eml,.html,.htm" className="qf-file-input" onChange={(event) => changeFile(event.target.files?.[0] ?? null)} disabled={!canEdit || restoring || restoreError !== null || document !== null} /></label><button type="button" className="btn primary mt16" onClick={() => ingest.mutate()} disabled={!canEdit || restoring || restoreError !== null || ingest.isPending || document !== null}><QuietIcon name="arrow" />{ingest.isPending ? '读取中…' : '读取文档'}</button></>}
          <div className="source-preview" aria-live="polite">
            <div className="row between"><span className="badge"><QuietIcon name="file" />{document ? '已解析的内容' : '内容预览'}</span><span className="small muted">{document ? '服务器保存的来源快照' : '读取后显示真实内容'}</span></div>
            {document ? <><h3 className="mt16">{document.document.title}</h3><p className="small muted mt8">{preview.slice(0, 220)}{preview.length > 220 ? '…' : ''}</p><div className="row mt16 gap8"><span className="badge">{document.normalization.blockCount} 个内容块</span><span className="badge">{document.document.language}</span><span className="badge">{document.normalization.claims} 处待核对信息</span></div></> : <p className="small muted mt16">输入链接、正文或文档并点击读取；这里会显示解析后的标题、摘要与来源信息。</p>}
          </div>
          {error ? <div className="notice amber mt24" role="alert"><QuietIcon name="info" /><span>{error}</span></div> : null}
          {projectRef.current && error ? <Link className="textbtn mt16" href={`/w/${workspaceId}/p/${projectRef.current}/script`}>打开已创建的作品 <QuietIcon name="arrow" /></Link> : null}
          <div className="notice mt24"><QuietIcon name="shield" /><div><strong>事实先行</strong><br />数字、图表和引用将回到原文核对。缺失的数据，不由 AI 补写。</div></div>
        </div>
      </section>
      <aside className="col">
        <section className="panel pad">
          <div className="row between"><h3>作品方向</h3><span className="badge">可随时调整</span></div>
          <label className="label mt24" htmlFor="project-name">作品名称</label><input id="project-name" className="field" value={title} onChange={(event) => { setTitle(event.target.value); createKeyRef.current = null; }} disabled={!canEdit || restoring || restoreError !== null || projectRef.current !== null} placeholder="输入你的作品名称" />
          <div className="settings-row"><div><h4>目标时长</h4><p>根据内容密度规划</p></div><select className="compact-select" aria-label="目标时长" value={durationMs} disabled={!canEdit || restoring || restoreError !== null || projectRef.current !== null} onChange={(event) => setDurationMs(Number(event.target.value))}><option value={180000}>约 2–3 分钟</option><option value={300000}>约 4–6 分钟</option><option value={540000}>约 8–10 分钟</option></select></div>
          <div className="settings-row"><div><h4>画面比例</h4><p>专业长视频</p></div><span className="badge">16:9 横屏</span></div>
          <div className="settings-row"><div><h4>表达方式</h4><p>以真实内容组织脚本</p></div><span className="small muted">研究型解说</span></div>
          <div className="settings-row"><div><h4>声音</h4><p>后续在身份中设置</p></div><Link className="textbtn small" href={`/w/${workspaceId}/identity`}>创作者身份</Link></div>
          <div className="mt24"><button type="button" className="btn primary full" disabled={!canEdit || restoring || restoreError !== null || document === null || generate.isPending} onClick={() => generate.mutate()}><QuietIcon name="spark" />{generate.isPending ? '正在生成脚本…' : '生成脚本草稿'}</button></div>
          <p className="small muted mt16">先检查解析内容。生成操作由服务端执行；来源和事实仍需人工核对。</p>
        </section>
        <p className="small muted" style={{ padding: '0 8px', lineHeight: 1.9 }}>先确认叙事，再进入分镜。数字人与生成镜头在草稿阶段只做占位。</p>
      </aside>
    </div>
  </div>;
}
