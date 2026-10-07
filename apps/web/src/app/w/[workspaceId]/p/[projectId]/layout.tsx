'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * 项目工作区：创作、交付与发布后学习入口共用项目路由上下文。
 * 路由参数由 URL 承载（workspaceId/projectId），页面组件不复制权威状态。
 */

const TABS = [
  { segment: 'script', label: 'Script' },
  { segment: 'storyboard', label: 'Storyboard' },
  { segment: 'editor', label: 'Scene Editor' },
  { segment: 'assets', label: 'Assets' },
  { segment: 'history', label: 'History' },
  { segment: 'render', label: 'Render' },
  { segment: 'analytics', label: 'Analytics' },
] as const;

export default function ProjectLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ workspaceId: string; projectId: string }>();
  const pathname = usePathname();
  const base = `/w/${params.workspaceId}/p/${params.projectId}`;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">
            ← 工作区
          </Link>
          <span className="text-xs text-slate-500">
            项目 {params.projectId.slice(0, 12)}… · 工作区 {params.workspaceId.slice(0, 12)}…
          </span>
        </div>
        <nav className="flex flex-wrap gap-2" aria-label="项目导航">
          {TABS.map((tab) => {
            const href = `${base}/${tab.segment}`;
            const active = pathname?.startsWith(href) ?? false;
            return (
              <Link
                key={tab.segment}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`rounded px-3 py-1.5 text-sm ${
                  active ? 'bg-sky-600 text-white' : 'border border-slate-700 text-slate-300 hover:bg-slate-800'
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </header>
      {children}
    </div>
  );
}
