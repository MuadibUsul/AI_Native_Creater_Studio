'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useSession, useWorkspaces } from '@/lib/queries';
import { QuietIcon } from '@/ui/QuietIcon';
import { StateBlock } from '@/ui/StateBlock';
import { useWorkspaceSelection } from '@/ui/StudioShell';
import { useI18n } from '@/i18n/I18nProvider';
import type { Locale } from '@/i18n/locale';
import type { Messages } from '@/i18n/messages';
import styles from './dashboard.module.css';

type DashboardText = Messages['dashboard'];

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
      const channel = channels[0] ?? (await client.channels.create(workspaceId, { name: messages.entry.newProject.defaultChannel }));
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
  return <div className={`page narrow ${styles['dashboard']}`} lang={locale}>
    <div className="home-intro">
      <div><div className="eyebrow mb16">{t.eyebrow}</div><h1>{t.title}</h1><p>{t.subtitle}</p></div>
    </div>
    {workspaces.data?.length === 0 ? <div className="mt32"><StateBlock variant="empty" title={t.noWorkspaceTitle} description={t.noWorkspaceBody}>
      <form className="row mt16" onSubmit={(event) => { event.preventDefault(); if (workspaceName.trim()) createWorkspace.mutate(workspaceName.trim()); }}>
        <input className="field" aria-label={t.workspaceNameLabel} placeholder={t.workspaceNamePlaceholder} value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} />
        <button className="btn primary" type="submit" disabled={createWorkspace.isPending}>{t.createWorkspace}</button>
      </form>
      {createWorkspace.isError ? <p role="alert">{describeError(createWorkspace.error).message}</p> : null}
    </StateBlock></div> : <>
      {workspaces.data && workspaces.data.length > 1 ? <div className="qf-dashboard-workspace"><label htmlFor="workspace-select">{t.workspaceLabel}</label><select id="workspace-select" className="field" value={effectiveWorkspaceId ?? ''} onChange={(event) => { setLocalWorkspaceId(event.target.value); selection.selectWorkspace(event.target.value); }}>{workspaces.data.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select></div> : null}
      <div className="composer">
        <textarea id="home-source" aria-label={t.sourceLabel} placeholder={t.sourcePlaceholder} value={source} onChange={(event) => setSource(event.target.value)} />
        <div className="composer-footer">
          <div className="composer-tools">
            <button type="button" aria-pressed={sourceKind === 'url'} className={`btn ghost small ${sourceKind === 'url' ? 'qf-mode-active' : ''}`} onClick={() => setSourceKind('url')}><QuietIcon name="link" />{t.modeLink}</button>
            <button type="button" className={`btn ghost small ${sourceKind === 'file' ? 'qf-mode-active' : ''}`} onClick={() => start('file')}><QuietIcon name="upload" />{t.modeUpload}</button>
            <button type="button" aria-pressed={sourceKind === 'text'} className={`btn ghost small ${sourceKind === 'text' ? 'qf-mode-active' : ''}`} onClick={() => setSourceKind('text')}><QuietIcon name="text" />{t.modeText}</button>
          </div>
          <button type="button" className="btn primary" onClick={() => start()}>{t.start} <QuietIcon name="arrow" /></button>
        </div>
      </div>
      <div className={styles['studioEntry']}>
        <QuietIcon name="film" />
        <div className="grow"><strong>{messages.home.studioTitle}</strong><p className="small muted">{messages.home.studioBody}</p></div>
        <Link className="btn small" href={`/w/${effectiveWorkspaceId}/studio/new`}>{messages.home.studioAction}<QuietIcon name="arrow" /></Link>
      </div>
      <div className="homeflow"><QuietIcon name="shield" /><span>{t.flowNote}</span>{t.flowSteps.map((step, index) => <Fragment key={step}>{index > 0 ? <QuietIcon name="chevron" /> : null}<span>{step}</span></Fragment>)}</div>
      <section className="mt40" aria-label={t.continueTitle}>
        {/* 没有作品时不显示无意义的排序切换；"新建作品"始终保留（完整新建流程的入口）。
            空状态里的"只建空项目"保留为次要操作（一屏只有一个主操作——上方的"开始创作"）：它是不导入内容就建项目的唯一入口，历史验收脚本 n02-15 也依赖它 */}
        <div className="sectionhead"><div className="row gap16"><h2>{t.continueTitle}</h2>{projects.data ? <span className="badge">{t.projectCount(projects.data.length)}</span> : null}</div><div className="row gap8">{hasProjects ? <button className="btn ghost small" onClick={() => setSortOrder(sortOrder === 'recent' ? 'oldest' : 'recent')}>{sortOrder === 'recent' ? t.sortRecent : t.sortOldest} <QuietIcon name="down" /></button> : null}<Link className="btn small" href={`/w/${effectiveWorkspaceId}/new`}><QuietIcon name="plus" />{t.newProject}</Link></div></div>
        {projects.isPending ? <StateBlock variant="loading" title={t.projectsLoading} /> : null}
        {projects.isError ? <StateBlock variant={describeError(projects.error).kind === 'forbidden' ? 'forbidden' : 'error'} title={t.projectsFailed} description={describeError(projects.error).message} action={{ label: t.retry, onClick: () => void projects.refetch() }} /> : null}
        {projects.data?.length === 0 ? <StateBlock variant="empty" title={t.emptyTitle} description={t.emptyBody}><form className="row mt16" onSubmit={(event) => { event.preventDefault(); if (projectTitle.trim()) createProject.mutate(projectTitle.trim()); }}><input className="field" aria-label={t.projectTitleLabel} placeholder={t.projectTitlePlaceholder} value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} /><button className="btn" type="submit" disabled={createProject.isPending}>{t.createProject}</button></form>{createProject.isError ? <p role="alert">{describeError(createProject.error).message}</p> : null}</StateBlock> : null}
        <div className="project-grid">{ordered.map((project) => <Link className="project-card" href={project.mode === 'FOOTAGE_EDIT' ? `/w/${effectiveWorkspaceId}/studio/${project.id}` : `/w/${effectiveWorkspaceId}/p/${project.id}/${project.status === 'READY' || project.status === 'READY_FOR_REVIEW' ? 'render' : project.status === 'DRAFT' || project.status === 'SCRIPTING' ? 'script' : 'storyboard'}`} key={project.id}>
          <div className={styles['projectPreview']} aria-hidden="true"><span className={styles['previewLabel']}>{t.previewLabel}</span><strong className={styles['previewTitle']}>{project.title}</strong><span className={styles['previewNote']}>{t.noCover}</span></div>
          <h3>{project.title}</h3><div className="project-meta"><span>{t.target(projectDuration(project.targetDurationMs ?? null, t), project.aspectRatio)}</span><span className="badge">{t.stages[project.status] ?? project.status}</span></div>
          <div className="muted" style={{ fontSize: 10, marginTop: 8 }}>{project.updatedAt ? editedAt(project.updatedAt, t, locale) : t.editedUnknown}</div>
        </Link>)}</div>
      </section>
      <div className="guide-row">
        <div className="guide"><QuietIcon name="voice" /><div><strong>{t.guides.identityTitle}</strong><p>{t.guides.identityBody}</p><Link className="textbtn small" href={`/w/${effectiveWorkspaceId}/identity`}>{t.guides.identityLink} <QuietIcon name="arrow" /></Link></div></div>
        <div className="guide"><QuietIcon name="layers" /><div><strong>{t.guides.assetsTitle}</strong><p>{t.guides.assetsBody}</p><Link className="textbtn small" href={`/w/${effectiveWorkspaceId}/assets`}>{t.guides.assetsLink} <QuietIcon name="arrow" /></Link></div></div>
        <div className="guide"><QuietIcon name="box" /><div><strong>{t.guides.extensionsTitle}</strong><p>{t.guides.extensionsBody}</p><Link className="textbtn small" href={`/w/${effectiveWorkspaceId}/extensions`}>{t.guides.extensionsLink} <QuietIcon name="arrow" /></Link></div></div>
      </div>
    </>}
  </div>;
}
