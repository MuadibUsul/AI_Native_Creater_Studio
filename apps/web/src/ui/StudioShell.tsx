'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { applyAppearance, deviceAppearance, saveDeviceAppearance, type AppearanceMode } from '@/lib/appearance';
import { queryKeys, useSession, useWorkspaces } from '@/lib/queries';
import { QuietIcon } from './QuietIcon';

type WorkspaceSelection = { workspaceId: string | null; selectWorkspace: (id: string) => void; appearanceMode: AppearanceMode; setAppearanceMode: (mode: AppearanceMode) => void; toggleTheme: () => void; openHelp: () => void };
const WorkspaceSelectionContext = createContext<WorkspaceSelection>({ workspaceId: null, selectWorkspace: () => undefined, appearanceMode: 'system', setAppearanceMode: () => undefined, toggleTheme: () => undefined, openHelp: () => undefined });
export const useWorkspaceSelection = () => useContext(WorkspaceSelectionContext);

const LABELS: Record<string, string> = {
  script: '脚本', storyboard: '导演工作台', editor: '导演工作台', assets: '素材库',
  identity: '创作者身份', render: '成片与审核', publish: '交付与发布',
  analytics: '作品表现', extensions: '扩展工具', settings: '设置与用量',
  team: '团队', billing: '账单', history: '版本历史', new: '新建作品', admin: '运营', 'design-system': '设计系统',
};

function Brand({ href = '/' }: { href?: string }) {
  return <Link href={href} className="logo" aria-label="Creator Studio 创作台">
    <span className="logomark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5" /><path d="m10 8 6 4-6 4Z" fill="currentColor" stroke="none" /></svg></span>
    <span className="logotext">Creator Studio</span>
  </Link>;
}

function PrivateShell({ children, pathname }: { children: ReactNode; pathname: string }) {
  const client = useAncsClient();
  const session = useSession();
  const workspaces = useWorkspaces();
  const [chosenWorkspaceId, setChosenWorkspaceId] = useState<string | null>(null);
  const [panel, setPanel] = useState<'workspace' | 'command' | 'notifications' | 'help' | null>(null);
  const [command, setCommand] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [appearanceMode, setAppearanceModeState] = useState<AppearanceMode>('system');
  const triggerRef = useRef<HTMLElement | null>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const routeWorkspaceId = pathname.match(/^\/w\/([^/]+)/)?.[1] ?? null;
  const projectId = pathname.match(/^\/w\/[^/]+\/p\/([^/]+)/)?.[1] ?? null;
  const workspaceId = routeWorkspaceId ?? chosenWorkspaceId ?? workspaces.data?.[0]?.id ?? null;
  const projects = useQuery({
    queryKey: queryKeys.projects(workspaceId ?? 'none'),
    queryFn: () => client.projects.list(workspaceId ?? ''),
    enabled: workspaceId !== null,
  });
  const notifications = useQuery({
    queryKey: ['notifications', workspaceId],
    queryFn: () => client.notifications.list({ workspaceId: workspaceId ?? undefined, limit: 20 }),
    enabled: workspaceId !== null && panel === 'notifications',
  });
  const segments = pathname.split('/').filter(Boolean);
  const activeSegment = segments.at(-1) ?? '';
  const title = pathname === '/' ? '创作台' : LABELS[activeSegment] ?? LABELS[segments.at(-2) ?? ''] ?? '创作台';
  const workspaceName = workspaces.data?.find((item) => item.id === workspaceId)?.name ?? '工作空间';
  const userName = session.data?.user?.name || session.data?.user?.email || 'Creator';
  const initial = workspaceName.slice(0, 1).toUpperCase() || 'C';
  const base = workspaceId ? `/w/${workspaceId}` : '/';
  const homeHref = workspaceId ? `/?workspaceId=${encodeURIComponent(workspaceId)}` : '/';
  const projectBase = projectId && workspaceId ? `${base}/p/${projectId}` : projects.data?.[0] ? `${base}/p/${projects.data[0].id}` : null;

  useEffect(() => {
    if (routeWorkspaceId) setChosenWorkspaceId(routeWorkspaceId);
  }, [routeWorkspaceId]);
  useEffect(() => {
    if (pathname !== '/' || !workspaces.data?.length) return;
    const requested = new URLSearchParams(window.location.search).get('workspaceId');
    if (requested && workspaces.data.some((item) => item.id === requested)) setChosenWorkspaceId(requested);
  }, [pathname, workspaces.data]);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onSystemChange = () => {
      if (document.body.dataset['appearanceMode'] === 'system') applyAppearance('system');
    };
    media?.addEventListener('change', onSystemChange);
    return () => media?.removeEventListener('change', onSystemChange);
  }, []);
  useEffect(() => {
    if (session.isPending) return;
    const mode = session.data?.user?.id ? deviceAppearance(session.data.user.id) : 'system';
    setAppearanceModeState(mode);
    applyAppearance(mode);
  }, [session.data?.user?.id, session.isPending]);
  useEffect(() => {
    setMobileOpen(false);
    setPanel(null);
  }, [pathname]);
  useEffect(() => {
    if (!panel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanel(null);
      if (event.key === 'k' && (event.ctrlKey || event.metaKey)) event.preventDefault();
      if (event.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((item) => item.getClientRects().length > 0);
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    panelRef.current?.querySelector<HTMLElement>('input, button, a')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      triggerRef.current?.focus();
    };
  }, [panel]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        triggerRef.current = document.activeElement as HTMLElement;
        setPanel('command');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    const sidebar = document.querySelector<HTMLElement>('.sidebar.mobile-open');
    sidebar?.querySelector<HTMLElement>('a.navitem, button.navitem')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMobileOpen(false); return; }
      if (event.key !== 'Tab' || !sidebar) return;
      const items = Array.from(sidebar.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')).filter((item) => item.getClientRects().length > 0);
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); mobileTriggerRef.current?.focus(); };
  }, [mobileOpen]);
  const open = (next: typeof panel) => {
    triggerRef.current = document.activeElement as HTMLElement;
    setPanel(next);
  };
  const selectWorkspace = (id: string) => {
    setChosenWorkspaceId(id);
    if (pathname === '/') window.history.replaceState(null, '', `/?workspaceId=${encodeURIComponent(id)}`);
  };
  const setAppearanceMode = (mode: AppearanceMode) => {
    setAppearanceModeState(mode);
    applyAppearance(mode);
    if (session.data?.user?.id) saveDeviceAppearance(session.data.user.id, mode);
  };
  const toggleTheme = () => setAppearanceMode(document.body.classList.contains('theme-dark') ? 'light' : 'dark');
  const workspaceLinks = workspaceId ? [
    { href: homeHref, label: '创作台', icon: 'grid' },
    { href: `${base}/assets`, label: '素材库', icon: 'folder' },
    { href: `${base}/identity`, label: '创作者身份', icon: 'voice' },
    { href: `${base}/extensions`, label: '扩展工具', icon: 'box' },
  ] : [{ href: homeHref, label: '创作台', icon: 'grid' }];
  const commands = [
    ...workspaceLinks,
    ...(projects.data ?? []).map((item) => ({ href: `${base}/p/${item.id}/storyboard`, label: item.title, icon: 'film' })),
    ...(projectBase ? [
      { href: `${projectBase}/script`, label: '脚本', icon: 'file' },
      { href: `${projectBase}/storyboard`, label: '导演工作台', icon: 'film' },
      { href: `${projectBase}/render`, label: '成片与审核', icon: 'check' },
      { href: `${projectBase}/publish`, label: '交付与发布', icon: 'upload' },
      { href: `${projectBase}/analytics`, label: '作品表现', icon: 'chart' },
    ] : []),
    ...(workspaceId ? [
      { href: `${base}/settings`, label: '设置与用量', icon: 'settings' },
      { href: `${base}/team`, label: '团队', icon: 'voice' },
      { href: `${base}/billing`, label: '账单', icon: 'file' },
    ] : []),
  ];

  return <WorkspaceSelectionContext.Provider value={{ workspaceId, selectWorkspace, appearanceMode, setAppearanceMode, toggleTheme, openHelp: () => open('help') }}>
    <div className="app">
      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`} aria-label="主导航" role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen ? 'true' : undefined}>
        <Brand href={homeHref} />
        <button type="button" className="workspace-switch" onClick={() => open('workspace')} aria-label="切换工作区">
          <span className="circle">{initial}</span><span className="grow small">{workspaceName}</span><QuietIcon name="down" />
        </button>
        <div className="navgroup"><div className="navlabel">工作空间</div>
          {workspaceLinks.map(({ href, label, icon }) => <Link key={href} href={href} className={`navitem ${pathname === href.split('?')[0] ? 'active' : ''}`} aria-label={label} aria-current={pathname === href.split('?')[0] ? 'page' : undefined}><QuietIcon name={icon} /><span>{label}</span></Link>)}
        </div>
        <div className="navgroup"><div className="navlabel">最近作品</div>
          {(projects.data ?? []).slice(0, 3).map((item) => <Link key={item.id} href={`${base}/p/${item.id}/storyboard`} className={`navitem ${projectId === item.id ? 'active' : ''}`} aria-label={item.title}><QuietIcon name="film" /><span className="qf-ellipsis">{item.title}</span></Link>)}
          {projects.isError ? <span className="small muted">作品暂不可用</span> : null}
        </div>
        <div className="sidebottom">
          <button type="button" className="navitem" aria-label="快速搜索" onClick={() => open('command')}><QuietIcon name="search" /><span className="grow">快速搜索</span><span className="kbd">⌘ K</span></button>
          {workspaceId ? <Link href={`${base}/settings`} className={`navitem ${pathname.includes('/settings') ? 'active' : ''}`} aria-label="设置与用量"><QuietIcon name="settings" /><span>设置与用量</span></Link> : null}
          <button type="button" className="navitem" aria-label="帮助与快捷键" onClick={() => open('help')}><QuietIcon name="help" /><span>帮助与快捷键</span></button>
          <div className="userrow"><span className="circle">{userName.slice(0, 1).toUpperCase()}</span><span className="grow"><strong className="small">{userName}</strong><br /><span className="small muted">{workspaceName}</span></span></div>
        </div>
      </aside>
      <header className="topbar">
        <div className="row"><button ref={mobileTriggerRef} type="button" className="btn icononly ghost mobile-menu" aria-label={mobileOpen ? '关闭导航' : '打开导航'} onClick={() => setMobileOpen(!mobileOpen)}><QuietIcon name={mobileOpen ? 'close' : 'menu'} /></button><div className="breadcrumb"><span className="desktop-only">工作空间</span><QuietIcon name="chevron" className="desktop-only" /><strong>{title}</strong></div></div>
        <div className="top-actions"><button type="button" className="btn icononly ghost desktop-only" aria-label="切换浅深色" onClick={toggleTheme}><QuietIcon name="sun" /></button><button type="button" className="btn icononly ghost" aria-label="打开任务通知" onClick={() => open('notifications')}><QuietIcon name="bell" /></button><span className="circle" style={{ width: 28, height: 28 }}>{userName.slice(0, 1).toUpperCase()}</span></div>
      </header>
      <main id="main" className={pathname.includes('/storyboard') || pathname.includes('/editor') ? 'editor-page' : ''}>{children}</main>
    </div>
    {mobileOpen ? <button type="button" className="qf-mobile-backdrop" aria-label="关闭导航" onClick={() => setMobileOpen(false)} /> : null}
    {panel ? <div className="qf-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setPanel(null); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={{ workspace: '切换工作区', command: '快速搜索', notifications: '任务与通知', help: '帮助与快捷键' }[panel]} className={`qf-layer ${panel === 'notifications' ? 'qf-layer-right' : ''}`}>
        <div className="row between"><h2>{ { workspace: '切换工作区', command: '快速前往', notifications: '任务与通知', help: '帮助与快捷键' }[panel]}</h2><button type="button" className="btn icononly ghost" aria-label="关闭" onClick={() => setPanel(null)}><QuietIcon name="close" /></button></div>
        {panel === 'workspace' ? <div className="col mt24">{(workspaces.data ?? []).map((item) => <button type="button" key={item.id} className="btn" aria-current={item.id === workspaceId ? 'true' : undefined} onClick={() => { selectWorkspace(item.id); setPanel(null); if (pathname !== '/') window.location.href = `/?workspaceId=${encodeURIComponent(item.id)}`; }}>{item.name}</button>)}</div> : null}
        {panel === 'command' ? <><input className="field mt24" aria-label="搜索页面或作品" placeholder="搜索页面、作品或操作…" value={command} onChange={(event) => setCommand(event.target.value)} /><div className="qf-command-list mt16">{commands.filter((item) => item.label.includes(command.trim()) || command.trim() === '').map((item) => <Link key={`${item.href}:${item.label}`} href={item.href} onClick={() => setPanel(null)}><QuietIcon name={item.icon} />{item.label}<QuietIcon name="arrow" /></Link>)}</div></> : null}
        {panel === 'notifications' ? <div className="col mt24">{notifications.isPending ? <p className="muted">正在读取任务通知…</p> : notifications.isError ? <p className="muted">通知暂不可用。<button className="textbtn" onClick={() => void notifications.refetch()}>重试</button></p> : notifications.data?.length ? notifications.data.map((item) => <div className="qf-notification" key={item.id}><strong>{item.title}</strong><p>{item.body}</p><small className="muted">{new Date(item.createdAt).toLocaleString('zh-CN')}</small></div>) : <p className="muted">暂无通知</p>}</div> : null}
        {panel === 'help' ? <div className="col mt24"><p>按 <kbd className="kbd">Ctrl/⌘ K</kbd> 快速前往页面或作品。</p><p>按 <kbd className="kbd">Esc</kbd> 关闭当前面板。所有修改仍由服务端验证与保存。</p></div> : null}
      </div>
    </div> : null}
  </WorkspaceSelectionContext.Provider>;
}

export function StudioShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  if (pathname === '/sign-in' || pathname === '/welcome') return <>{children}</>;
  return <PrivateShell pathname={pathname}>{children}</PrivateShell>;
}
