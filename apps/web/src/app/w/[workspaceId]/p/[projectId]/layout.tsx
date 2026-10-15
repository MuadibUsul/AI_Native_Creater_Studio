'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { useAncsClient } from '@/lib/client';
import { QuietIcon } from '@/ui/QuietIcon';

/** Tab labels and status labels come from messages.projectFlow.projectNav. */
const TABS = ['script', 'storyboard', 'render', 'publish'] as const;

/** Project context stays in the URL and is read from the server; the bar never claims an unsaved edit is saved. */
export default function ProjectLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ workspaceId: string; projectId: string }>();
  const pathname = usePathname() ?? '';
  const client = useAncsClient();
  const t = useI18n().messages.projectFlow.projectNav;
  const base = `/w/${params.workspaceId}/p/${params.projectId}`;
  const project = useQuery({
    queryKey: ['projects', params.projectId, 'detail'],
    queryFn: () => client.projects.get(params.projectId),
  });
  const inEditor = pathname.includes('/storyboard') || pathname.includes('/editor');
  const inScript = pathname.includes('/script');

  return <>
    <div className="projectbar">
      <div className="row gap8 qf-project-identity">
        <Link className="btn ghost icononly small" href={`/?workspaceId=${encodeURIComponent(params.workspaceId)}`} aria-label={t.backHome}><QuietIcon name="chevron" style={{ transform: 'rotate(180deg)' }} /></Link>
        <span className="title qf-ellipsis">{project.data?.title ?? (project.isPending ? t.loadingProject : t.projectUnavailable)}</span>
        {project.isError ? <button type="button" className="textbtn small" onClick={() => void project.refetch()}>{t.retry}</button> : null}
      </div>
      <nav className="project-tabs" aria-label={t.navAria}>
        {TABS.map((segment) => {
          const active = pathname.startsWith(`${base}/${segment}`) || (segment === 'storyboard' && pathname.startsWith(`${base}/editor`));
          return <Link key={segment} href={`${base}/${segment}`} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>{t.tabs[segment]}</Link>;
        })}
      </nav>
      <div className="row gap6">
        {project.data ? <span className="badge" title={t.statusTitle}>{t.statusLabels[project.data.status] ?? project.data.status}</span> : null}
        <Link href={`${base}/history`} className="btn icononly ghost small" aria-label={t.historyAria}><QuietIcon name="clock" /></Link>
        {inEditor ? <Link className="btn primary small" href={`${base}/render`}><QuietIcon name="arrow" />{t.makeRender}</Link> : inScript ? <Link className="btn primary small" href={`${base}/storyboard`}><QuietIcon name="arrow" />{t.viewStoryboard}</Link> : <details className="qf-project-more"><summary className="btn small">{t.more} <QuietIcon name="more" /></summary><div className="qf-project-menu"><Link href={`${base}/assets`}>{t.menu.assets}</Link><Link href={`${base}/analytics`}>{t.menu.analytics}</Link><Link href={`${base}/history`}>{t.menu.history}</Link></div></details>}
      </div>
    </div>
    {children}
  </>;
}
