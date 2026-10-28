'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useSession, useWorkspaces } from '@/lib/queries';
import { QuietIcon } from '@/ui/QuietIcon';
import { StateBlock } from '@/ui/StateBlock';
import { useWorkspaceSelection } from '@/ui/StudioShell';
import { PendingInvitations } from '@/ui/PendingInvitations';
import { useI18n } from '@/i18n/I18nProvider';
import type { Locale } from '@/i18n/locale';
import type { Messages } from '@/i18n/messages';
import styles from './dashboard.module.css';

type DashboardText = Messages['dashboard'];
type StartMode = 'footage' | 'article' | 'link';
const START_MODES: StartMode[] = ['footage', 'article', 'link'];
const MODE_ICONS: Record<StartMode, string> = { footage: 'film', article: 'text', link: 'link' };

/** 素材剪辑与文章讲述的作品在共看片室打开（V6）；其余沿用旧版导演工作台 */
function projectHref(workspaceId: string, project: { id: string; mode?: string; status: string }): string {
  if (project.mode === 'FOOTAGE_EDIT' || project.mode === 'HYBRID') return `/w/${workspaceId}/studio/${project.id}`;
  const stage = project.status === 'READY' || project.status === 'READY_FOR_REVIEW' ? 'render' : project.status === 'DRAFT' || project.status === 'SCRIPTING' ? 'script' : 'storyboard';
  return `/w/${workspaceId}/p/${project.id}/${stage}`;
}

/** 卡片缩略区里的画幅框（不画假内容，只表达这条视频的形状） */
function aspectBox(aspectRatio: string): { width: string; height: string } {
  const [width = 16, height = 9] = aspectRatio.split(':').map(Number);
  return width >= height ? { width: '46%', height: `${String((46 * height) / width * 1.6)}%` } : { width: `${String((58 * width) / height / 1.6)}%`, height: '58%' };
}

// 目标时长是旧版生成作品的显示值（毫秒字段只用于展示，不参与时间线计算）
function projectDuration(ms: number | null, t: DashboardText): string {
  if (ms === null) return t.durationUnknown;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return seconds > 0 ? t.durationMinutesSeconds(minutes, seconds) : t.durationMinutes(minutes);
}

function editedAt(value: string, t: DashboardText, locale: Locale): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return t.editedUnknown;
  const now = new Date();
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes >= 0 && minutes < 60) return t.editedMinutesAgo(Math.max(1, minutes));
  const clock = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (at.toDateString() === now.toDateString()) return t.editedToday(clock);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return t.editedYesterday(clock);
  return t.editedOn(at.toLocaleDateString(locale), clock);
}

export default function DashboardPage() {
  const router = useRouter();
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const session = useSession();
  const workspaces = useWorkspaces();
  const selection = useWorkspaceSelection();
  const { messages, locale } = useI18n();
  const t = messages.dashboard;
  const [localWorkspaceId, setLocalWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [projectTitle, setProjectTitle] = useState('');
  const [source, setSource] = useState('');
  const [mode, setMode] = useState<StartMode>('footage');
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
      const channel = channels[0] ?? (await client.channels.create(workspaceId, { name: messages.entry.newProject.defaultChannel }));
      return client.projects.create(workspaceId, { title, channelId: channel.id });
    },
    onSuccess: () => {
      setProjectTitle('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects(effectiveWorkspaceId ?? 'none') });
    },
  });
  /**
   * 开始：三种起点都进共看片室新建页（V6）——想法预填作品名并在进入后预填到对话框；文章预填到文章框；
   * 链接由服务端抓取正文后填进文章框给用户核对（不再走旧版导入 + 模板脚本）。草稿只放在本标签页的 sessionStorage，不上传。
   */
  const start = (chosen: StartMode, text: string) => {
    if (!effectiveWorkspaceId) return;
    const value = text.trim();
    const draft = chosen === 'article' ? { start: 'article', article: value }
      : chosen === 'link' ? { start: 'link', url: value }
        : { start: 'footage', brief: value };
    try {
      window.sessionStorage.setItem('ancs-studio-draft', JSON.stringify(draft));
    } catch { /* The new project page still works without session storage. */ }
    router.push(`/w/${effectiveWorkspaceId}/studio/new`);
  };
  const canStart = mode === 'footage' || source.trim().length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canStart) start(mode, source);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 文章是多段文字：Ctrl/⌘ + Enter 提交；其余模式 Enter 提交、Shift + Enter 换行
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    if (mode === 'article' ? !(event.metaKey || event.ctrlKey) : event.shiftKey) return;
    event.preventDefault();
    if (canStart) start(mode, source);
  };
  const isUnauthenticated = session.isError && describeError(session.error).kind === 'unauthenticated';
  useEffect(() => {
    if (isUnauthenticated) router.replace('/welcome');
  }, [isUnauthenticated, router]);
  if (isUnauthenticated) return null;
  if (session.isPending || workspaces.isPending) return <div className="page narrow"><StateBlock variant="loading" title={t.loadingWorkspaces} /></div>;
  if (session.isError) return <div className="page narrow"><StateBlock variant="error" title={t.sessionUnavailable} description={describeError(session.error).message} action={{ label: t.retry, onClick: () => void session.refetch() }} /></div>;
  if (workspaces.isError) {
    const error = describeError(workspaces.error);
    return <div className="page narrow"><StateBlock variant={error.kind === 'unavailable' ? 'unavailable' : 'error'} title={t.workspacesFailed} description={error.message} diagnostics={error.code ?? undefined} action={{ label: t.retry, onClick: () => void workspaces.refetch() }} /></div>;
  }

  const ordered = [...(projects.data ?? [])].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt ?? '') || 0;
    const bTime = Date.parse(b.updatedAt ?? '') || 0;
    return sortOrder === 'recent' ? bTime - aTime : aTime - bTime;
  });
  const hasProjects = (projects.data?.length ?? 0) > 0;
  return <div className={`page ${styles['home']}`} lang={locale}>
    <section className={styles['hero']} aria-labelledby="home-title">
      <div className={styles['aurora']} aria-hidden="true" />
      <h1 id="home-title" className={styles['heroTitle']}>{t.heroTitle}</h1>
      <p className={styles['heroSubtitle']}>{t.heroSubtitle}</p>
      <PendingInvitations onJoined={(workspaceId) => { setLocalWorkspaceId(workspaceId); selection.selectWorkspace(workspaceId); }} />
      {workspaces.data?.length === 0 ? <div className={styles['heroState']}><StateBlock variant="empty" title={t.noWorkspaceTitle} description={t.noWorkspaceBody}>
        <form className="row mt16" onSubmit={(event) => { event.preventDefault(); if (workspaceName.trim()) createWorkspace.mutate(workspaceName.trim()); }}>
          <input className="field" aria-label={t.workspaceNameLabel} placeholder={t.workspaceNamePlaceholder} value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} />
          <button className="btn primary" type="submit" disabled={createWorkspace.isPending}>{t.createWorkspace}</button>
        </form>
        {createWorkspace.isError ? <p role="alert">{describeError(createWorkspace.error).message}</p> : null}
      </StateBlock></div> : <>
        {workspaces.data && workspaces.data.length > 1 ? <div className={styles['workspacePick']}><label htmlFor="workspace-select">{t.workspaceLabel}</label><select id="workspace-select" className="field" value={effectiveWorkspaceId ?? ''} onChange={(event) => { setLocalWorkspaceId(event.target.value); selection.selectWorkspace(event.target.value); }}>{workspaces.data.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select></div> : null}
        <form className={`ui-prompt ${styles['prompt']}`} onSubmit={submit}>
          <textarea id="home-source" rows={3} aria-label={t.sourceLabel} placeholder={t.placeholders[mode]} value={source} onChange={(event) => setSource(event.target.value)} onKeyDown={onKeyDown} />
          <div className="ui-prompt-footer">
            <button type="button" className="ui-round" aria-label={t.addFootage} title={t.addFootage} onClick={() => start('footage', '')}><QuietIcon name="plus" /></button>
            <div className={`ui-seg ${styles['modes']}`} role="radiogroup" aria-label={t.startLabel}>
              {START_MODES.map((option) => <button key={option} type="button" role="radio" aria-checked={mode === option} onClick={() => setMode(option)}><QuietIcon name={MODE_ICONS[option]} /><span>{t.startModes[option]}</span></button>)}
            </div>
            <span className="ui-grow" />
            <button type="submit" className="ui-round ui-send" aria-label={t.start} title={t.start} disabled={!canStart}><QuietIcon name="arrowUp" /></button>
          </div>
        </form>
        {mode === 'footage' ? <div className={styles['suggestions']} role="group" aria-label={t.suggestionsLabel}>
          {t.suggestions.map((suggestion) => <button key={suggestion} type="button" className="ui-suggestion" onClick={() => setSource(suggestion)}><span className="ui-ai-mark" aria-hidden="true" /><span>{suggestion}</span></button>)}
        </div> : null}
      </>}
    </section>
    {workspaces.data?.length === 0 ? null : <section className={styles['recent']} aria-label={t.continueTitle}>
      {/* 没有作品时不显示无意义的排序切换；"新建作品"始终保留（完整新建流程的入口）。
          空状态里的"只建空项目"保留为次要操作：它是不导入内容就建项目的唯一入口，历史验收脚本 n02-15 也依赖它 */}
      <div className={styles['recentHead']}>
        <div className="row gap8"><h2>{t.continueTitle}</h2>{projects.data ? <span className="badge">{t.projectCount(projects.data.length)}</span> : null}</div>
        <div className="row gap8">{hasProjects ? <button className="btn ghost small" onClick={() => setSortOrder(sortOrder === 'recent' ? 'oldest' : 'recent')}>{sortOrder === 'recent' ? t.sortRecent : t.sortOldest} <QuietIcon name="down" /></button> : null}<Link className="btn small" href={`/w/${effectiveWorkspaceId}/new`}><QuietIcon name="plus" />{t.newProject}</Link></div>
      </div>
      {projects.isPending ? <StateBlock variant="loading" title={t.projectsLoading} /> : null}
      {projects.isError ? <StateBlock variant={describeError(projects.error).kind === 'forbidden' ? 'forbidden' : 'error'} title={t.projectsFailed} description={describeError(projects.error).message} action={{ label: t.retry, onClick: () => void projects.refetch() }} /> : null}
      {projects.data?.length === 0 ? <StateBlock variant="empty" title={t.emptyTitle} description={t.emptyBody}><form className="row mt16" onSubmit={(event) => { event.preventDefault(); if (projectTitle.trim()) createProject.mutate(projectTitle.trim()); }}><input className="field" aria-label={t.projectTitleLabel} placeholder={t.projectTitlePlaceholder} value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} /><button className="btn" type="submit" disabled={createProject.isPending}>{t.createProject}</button></form>{createProject.isError ? <p role="alert">{describeError(createProject.error).message}</p> : null}</StateBlock> : null}
      <div className={styles['grid']}>{ordered.map((project) => {
        const kind = project.mode === 'FOOTAGE_EDIT' ? 'footage' : project.mode === 'HYBRID' ? 'article' : 'legacy';
        return <Link className={styles['card']} href={projectHref(effectiveWorkspaceId ?? '', project)} key={project.id}>
          <div className={styles['thumb']} aria-hidden="true">
            <span className={styles['thumbFrame']} style={aspectBox(project.aspectRatio)}><QuietIcon name={kind === 'article' ? 'text' : 'film'} /></span>
          </div>
          <div className={styles['cardBody']}>
            <h3>{project.title}</h3>
            <div className={styles['cardMeta']}><span>{kind === 'footage' ? t.kindFootage(project.aspectRatio) : kind === 'article' ? t.kindArticle(project.aspectRatio) : t.target(projectDuration(project.targetDurationMs ?? null, t), project.aspectRatio)}</span><span className="badge">{t.stages[project.status] ?? project.status}</span></div>
            <div className={styles['edited']}>{project.updatedAt ? editedAt(project.updatedAt, t, locale) : t.editedUnknown}</div>
          </div>
        </Link>;
      })}</div>
    </section>}
  </div>;
}
