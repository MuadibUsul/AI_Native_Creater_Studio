'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useSession, useWorkspaces } from '@/lib/queries';
import { QuietIcon } from '@/ui/QuietIcon';
import { StateBlock } from '@/ui/StateBlock';
import { useWorkspaceSelection } from '@/ui/StudioShell';

const stageLabel: Record<string, string> = {
  DRAFT: '草稿', SCRIPTING: '脚本中', STORYBOARDING: '分镜中',
  GENERATING_AUDIO: '声音生成中', GENERATING_ASSETS: '素材生成中',
  READY_FOR_REVIEW: '待审核', RENDER_QUEUED: '排队中',
  RENDERING: '成片中', READY: '待审核', FAILED: '需处理', ARCHIVED: '已归档',
};

function projectDuration(ms: number | null): string {
  if (ms === null) return '时长待定';
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

function editedAt(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '更新时间未知';
  const now = new Date();
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes >= 0 && minutes < 60) return `${Math.max(1, minutes)} 分钟前编辑`;
  const clock = at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (at.toDateString() === now.toDateString()) return `今天 ${clock} 编辑`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return `昨天 ${clock} 编辑`;
  return `${at.toLocaleDateString('zh-CN')} ${clock} 编辑`;
}

export default function DashboardPage() {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const session = useSession();
  const workspaces = useWorkspaces();
  const selection = useWorkspaceSelection();
  const [localWorkspaceId, setLocalWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [projectTitle, setProjectTitle] = useState('');
  const [source, setSource] = useState('');
  const [sourceKind, setSourceKind] = useState<'url' | 'text' | 'file'>('url');
  const [sortOrder, setSortOrder] = useState<'recent' | 'oldest'>('recent');
  const effectiveWorkspaceId = selection.workspaceId ?? localWorkspaceId ?? workspaces.data?.[0]?.id ?? null;
  const projects = useQuery({
    queryKey: queryKeys.projects(effectiveWorkspaceId ?? 'none'),
    queryFn: () => client.projects.list(effectiveWorkspaceId ?? ''),
    enabled: effectiveWorkspaceId !== null,
  });
  const createWorkspace = useMutation({
    mutationFn: (name: string) => client.workspaces.create({ name }),
    onSuccess: (workspace) => {
      setLocalWorkspaceId(workspace.id);
      selection.selectWorkspace(workspace.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });
  const createProject = useMutation({
    mutationFn: async (title: string) => {
      const workspaceId = effectiveWorkspaceId ?? '';
      const channels = await client.channels.list(workspaceId);
      const channel = channels[0] ?? (await client.channels.create(workspaceId, { name: '默认栏目' }));
      return client.projects.create(workspaceId, { title, channelId: channel.id });
    },
    onSuccess: () => {
      setProjectTitle('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects(effectiveWorkspaceId ?? 'none') });
    },
  });
  const start = (kind = sourceKind) => {
    if (!effectiveWorkspaceId) return;
    const resolvedKind = kind === 'url' && source.trim() && !/^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(source.trim()) ? 'text' : kind;
    try {
      window.sessionStorage.setItem('ancs-new-project-draft', JSON.stringify({ kind: resolvedKind, value: source }));
    } catch { /* The new project page still works without session storage. */ }
    window.location.href = `/w/${effectiveWorkspaceId}/new`;
  };
  if (session.isPending || workspaces.isPending) return <div className="page narrow"><StateBlock variant="loading" title="正在加载工作区…" /></div>;
  if (session.isError && describeError(session.error).kind === 'unauthenticated') return <div className="page narrow"><StateBlock variant="unauthenticated" title="需要登录" description="登录后继续创作。" action={{ label: '前往登录', onClick: () => { window.location.href = '/sign-in'; } }} /></div>;
  if (session.isError) return <div className="page narrow"><StateBlock variant="error" title="会话暂不可用" description={describeError(session.error).message} action={{ label: '重试', onClick: () => void session.refetch() }} /></div>;
  if (workspaces.isError) {
    const error = describeError(workspaces.error);
    return <div className="page narrow"><StateBlock variant={error.kind === 'unavailable' ? 'unavailable' : 'error'} title="加载工作区失败" description={error.message} diagnostics={error.code ?? undefined} action={{ label: '重试', onClick: () => void workspaces.refetch() }} /></div>;
  }

  const ordered = [...(projects.data ?? [])].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt ?? '') || 0;
    const bTime = Date.parse(b.updatedAt ?? '') || 0;
    return sortOrder === 'recent' ? bTime - aTime : aTime - bTime;
  });
  return <div className="page narrow">
    <div className="home-intro">
      <div><div className="eyebrow mb16">YOUR NEXT GOOD STORY</div><h1>把观点，变成作品。</h1><p>从一篇文章开始，做出属于你的专业视频。</p></div>
      <div className="little-frames" aria-hidden="true"><span className="frame" /><span className="frame" /><span className="frame"><QuietIcon name="play" /></span></div>
    </div>
    {workspaces.data?.length === 0 ? <div className="mt32"><StateBlock variant="empty" title="还没有工作区" description="工作区是项目、预算与成员的边界。">
      <form className="row mt16" onSubmit={(event) => { event.preventDefault(); if (workspaceName.trim()) createWorkspace.mutate(workspaceName.trim()); }}>
        <input className="field" aria-label="工作区名称" placeholder="例如：财经观察" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} />
        <button className="btn primary" type="submit" disabled={createWorkspace.isPending}>创建工作区</button>
      </form>
      {createWorkspace.isError ? <p role="alert">{describeError(createWorkspace.error).message}</p> : null}
    </StateBlock></div> : <>
      {workspaces.data && workspaces.data.length > 1 ? <div className="qf-dashboard-workspace"><label htmlFor="workspace-select">工作区</label><select id="workspace-select" className="field" value={effectiveWorkspaceId ?? ''} onChange={(event) => { setLocalWorkspaceId(event.target.value); selection.selectWorkspace(event.target.value); }}>{workspaces.data.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select></div> : null}
      <div className="composer">
        <textarea id="home-source" aria-label="文章链接或创作想法" placeholder="粘贴文章链接，或写下你的想法…" value={source} onChange={(event) => setSource(event.target.value)} />
        <div className="composer-footer">
          <div className="composer-tools">
            <button type="button" className={`btn ghost small ${sourceKind === 'url' ? 'qf-mode-active' : ''}`} onClick={() => setSourceKind('url')}><QuietIcon name="link" />文章链接</button>
            <button type="button" className={`btn ghost small ${sourceKind === 'file' ? 'qf-mode-active' : ''}`} onClick={() => start('file')}><QuietIcon name="upload" />上传资料</button>
            <button type="button" className={`btn ghost small ${sourceKind === 'text' ? 'qf-mode-active' : ''}`} onClick={() => setSourceKind('text')}><QuietIcon name="text" />粘贴正文</button>
          </div>
          <button type="button" className="btn primary" onClick={() => start()}>开始创作 <QuietIcon name="arrow" /></button>
        </div>
      </div>
      <div className="homeflow"><QuietIcon name="shield" /><span>先看脚本与草稿，再确认付费生成</span><span>导入内容</span><QuietIcon name="chevron" /><span>确认脚本</span><QuietIcon name="chevron" /><span>分镜与成片</span></div>
      <section className="mt40" aria-label="继续创作">
        <div className="sectionhead"><div className="row gap16"><h2>继续创作</h2>{projects.data ? <span className="badge">{projects.data.length} 个作品</span> : null}</div><div className="row gap8"><button className="btn ghost small" onClick={() => setSortOrder(sortOrder === 'recent' ? 'oldest' : 'recent')}>{sortOrder === 'recent' ? '最近编辑' : '最早编辑'} <QuietIcon name="down" /></button><Link className="btn small" href={`/w/${effectiveWorkspaceId}/new`}><QuietIcon name="plus" />新建作品</Link></div></div>
        {projects.isPending ? <StateBlock variant="loading" title="正在加载项目…" /> : null}
        {projects.isError ? <StateBlock variant={describeError(projects.error).kind === 'forbidden' ? 'forbidden' : 'error'} title="加载项目失败" description={describeError(projects.error).message} action={{ label: '重试', onClick: () => void projects.refetch() }} /> : null}
        {projects.data?.length === 0 ? <StateBlock variant="empty" title="该工作区还没有项目" description="创建第一个项目开始：导入文章 → 生成叙事 → 分镜 → 编辑。"><form className="row mt16" onSubmit={(event) => { event.preventDefault(); if (projectTitle.trim()) createProject.mutate(projectTitle.trim()); }}><input className="field" aria-label="项目标题" placeholder="例如：利率周报视频" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} /><button className="btn primary" type="submit" disabled={createProject.isPending}>创建项目</button></form>{createProject.isError ? <p role="alert">{describeError(createProject.error).message}</p> : null}</StateBlock> : null}
        <div className="project-grid">{ordered.map((project, index) => <Link className="project-card" href={`/w/${effectiveWorkspaceId}/p/${project.id}/${project.status === 'READY' || project.status === 'READY_FOR_REVIEW' ? 'render' : project.status === 'DRAFT' || project.status === 'SCRIPTING' ? 'script' : 'storyboard'}`} key={project.id}>
          <div className="cover"><div className={`cover-art art-${index % 5}`} /><div className="cover-label">CREATOR STUDIO / EDITORIAL</div><div className="cover-title">{project.title}</div><div className="cover-sub">项目封面占位</div></div>
          <h3>{project.title}</h3><div className="project-meta"><span>目标 {projectDuration(project.targetDurationMs ?? null)} · {project.aspectRatio}</span><span className={`badge ${project.status === 'READY' || project.status === 'READY_FOR_REVIEW' ? 'amber' : project.status === 'FAILED' ? 'red' : 'blue'}`}>{stageLabel[project.status] ?? project.status}</span></div>
          <div className="muted" style={{ fontSize: 10, marginTop: 8 }}>{project.updatedAt ? editedAt(project.updatedAt) : '更新时间未知'}</div>
        </Link>)}</div>
      </section>
      <div className="guide-row">
        <div className="guide"><QuietIcon name="voice" /><div><strong>让作品听起来像你</strong><p>设置旁白风格与已授权声音</p><Link className="textbtn small" href={`/w/${effectiveWorkspaceId}/identity`}>设置创作者身份 <QuietIcon name="arrow" /></Link></div></div>
        <div className="guide"><QuietIcon name="layers" /><div><strong>素材，随作品积累</strong><p>来源、授权与历史版本一起保留</p><Link className="textbtn small" href={`/w/${effectiveWorkspaceId}/assets`}>打开素材库 <QuietIcon name="arrow" /></Link></div></div>
        <div className="guide"><QuietIcon name="box" /><div><strong>长视频之外，按需扩展</strong><p>短视频、播客与发布不打断创作</p><Link className="textbtn small" href={`/w/${effectiveWorkspaceId}/extensions`}>浏览扩展工具 <QuietIcon name="arrow" /></Link></div></div>
      </div>
    </>}
  </div>;
}
