'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useAncsClient } from '@/lib/client';
import { QuietIcon } from '@/ui/QuietIcon';

const TABS = [
  { segment: 'script', label: '脚本' },
  { segment: 'storyboard', label: '分镜与编辑' },
  { segment: 'render', label: '成片' },
  { segment: 'publish', label: '交付' },
] as const;

const STATUS_LABELS: Record<string, string> = {
  DRAFT: '草稿', SCRIPTING: '脚本中', STORYBOARDING: '分镜中',
  GENERATING_AUDIO: '声音生成中', GENERATING_ASSETS: '素材生成中',
  READY_FOR_REVIEW: '待审核', RENDER_QUEUED: '排队中',
  RENDERING: '成片中', READY: '待审核', FAILED: '需处理', ARCHIVED: '已归档',
};

/** Project context stays in the URL and is read from the server; the bar never claims an unsaved edit is saved. */
export default function ProjectLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ workspaceId: string; projectId: string }>();
  const pathname = usePathname() ?? '';
  const client = useAncsClient();
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
        <Link className="btn ghost icononly small" href={`/?workspaceId=${encodeURIComponent(params.workspaceId)}`} aria-label="返回创作台"><QuietIcon name="chevron" style={{ transform: 'rotate(180deg)' }} /></Link>
        <span className="title qf-ellipsis">{project.data?.title ?? (project.isPending ? '正在加载作品…' : '作品信息暂不可用')}</span>
        {project.isError ? <button type="button" className="textbtn small" onClick={() => void project.refetch()}>重试</button> : null}
      </div>
      <nav className="project-tabs" aria-label="项目导航">
        {TABS.map(({ segment, label }) => {
          const active = pathname.startsWith(`${base}/${segment}`) || (segment === 'storyboard' && pathname.startsWith(`${base}/editor`));
          return <Link key={segment} href={`${base}/${segment}`} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>{label}</Link>;
        })}
      </nav>
      <div className="row gap6">
        {project.data ? <span className="badge" title="服务器上的项目状态">{STATUS_LABELS[project.data.status] ?? project.data.status}</span> : null}
        <Link href={`${base}/history`} className="btn icononly ghost small" aria-label="版本历史"><QuietIcon name="clock" /></Link>
        {inEditor ? <Link className="btn primary small" href={`${base}/render`}><QuietIcon name="arrow" />制作成片</Link> : inScript ? <Link className="btn primary small" href={`${base}/storyboard`}><QuietIcon name="arrow" />查看分镜</Link> : <details className="qf-project-more"><summary className="btn small">更多 <QuietIcon name="more" /></summary><div className="qf-project-menu"><Link href={`${base}/assets`}>项目素材</Link><Link href={`${base}/analytics`}>作品表现</Link><Link href={`${base}/history`}>版本历史</Link></div></details>}
      </div>
    </div>
    {children}
  </>;
}
