'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { applyAppearance, deviceAppearance, saveDeviceAppearance, type AppearanceMode } from '@/lib/appearance';
import { queryKeys, useSession, useWorkspaces } from '@/lib/queries';
import { useI18n } from '@/i18n/I18nProvider';
import type { Messages } from '@/i18n/messages';
import { QuietIcon } from './QuietIcon';

type WorkspaceSelection = {
  workspaceId: string | null; selectWorkspace: (id: string) => void;
  appearanceMode: AppearanceMode; accountAppearanceMode: AppearanceMode; deviceOverride: AppearanceMode | null;
  appearancePending: boolean; appearanceError: boolean;
  refetchAppearance: () => void;
  setAccountAppearance: (mode: AppearanceMode) => Promise<void>;
  setDeviceOverride: (mode: AppearanceMode | null) => void;
  toggleTheme: () => void; openHelp: () => void;
};
const WorkspaceSelectionContext = createContext<WorkspaceSelection>({
  workspaceId: null, selectWorkspace: () => undefined, appearanceMode: 'system', accountAppearanceMode: 'system', deviceOverride: null,
  appearancePending: false, appearanceError: false, refetchAppearance: () => undefined, setAccountAppearance: async () => undefined, setDeviceOverride: () => undefined,
  toggleTheme: () => undefined, openHelp: () => undefined,
});
export const useWorkspaceSelection = () => useContext(WorkspaceSelectionContext);

/** 路由段 → 面包屑标题（文案来自当前语言的 shell.nav） */
function routeLabels(nav: Messages['shell']['nav']): Record<string, string> {
  return {
    script: nav.script, storyboard: nav.storyboard, editor: nav.storyboard, assets: nav.assets,
    identity: nav.identity, render: nav.render, publish: nav.publish,
    analytics: nav.analytics, extensions: nav.extensions, settings: nav.settings,
    team: nav.team, billing: nav.billing, history: nav.history, new: nav.new, admin: nav.admin, 'design-system': nav.designSystem,
  };
}

/** 作品入口：素材剪辑作品进共看片室（V6），其余沿用旧版导演工作台 */
function projectHref(base: string, project: { id: string; mode?: string }): string {
  return project.mode === 'FOOTAGE_EDIT' ? `${base}/studio/${project.id}` : `${base}/p/${project.id}/storyboard`;
}

function Brand({ href = '/', label }: { href?: string; label: string }) {
  return <Link href={href} className="logo" aria-label={label}>
    <span className="logomark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5" /><path d="m10 8 6 4-6 4Z" fill="currentColor" stroke="none" /></svg></span>
    <span className="logotext">Creator Studio</span>
  </Link>;
}

function PrivateShell({ children, pathname }: { children: ReactNode; pathname: string }) {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const session = useSession();
  const { messages, locale, setLocale } = useI18n();
  const t = messages.shell;
  const userId = session.data?.user?.id ?? null;
  const accountAppearance = useQuery({
    queryKey: ['user', userId, 'appearance'],
    queryFn: () => client.auth.getAppearance(),
    enabled: userId !== null,
  });
  const workspaces = useWorkspaces();
  const opsSession = useQuery({
    queryKey: ['ops', 'session'],
    queryFn: () => client.ops.session(),
    enabled: userId !== null,
    retry: false,
    staleTime: 30_000,
  });
  const [chosenWorkspaceId, setChosenWorkspaceId] = useState<string | null>(null);
  const [panel, setPanel] = useState<'workspace' | 'command' | 'notifications' | 'help' | null>(null);
  const [command, setCommand] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [deviceOverride, setDeviceOverrideState] = useState<AppearanceMode | null>(null);
  const accountAppearanceMode = accountAppearance.data?.mode ?? 'system';
  const appearanceMode = deviceOverride ?? accountAppearanceMode;
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
  const labels = routeLabels(t.nav);
  const title = pathname === '/' ? t.nav.home : labels[activeSegment] ?? labels[segments.at(-2) ?? ''] ?? t.nav.home;
  const workspaceName = workspaces.data?.find((item) => item.id === workspaceId)?.name ?? t.workspaceFallback;
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
    const override = userId ? deviceAppearance(userId) : null;
    setDeviceOverrideState(override);
    if (override !== null || !userId || (!accountAppearance.isPending && !accountAppearance.isError)) applyAppearance(override ?? accountAppearanceMode);
  }, [session.isPending, userId, accountAppearance.isPending, accountAppearance.isError, accountAppearanceMode]);
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
  const setDeviceOverride = (mode: AppearanceMode | null) => {
    setDeviceOverrideState(mode);
    applyAppearance(mode ?? accountAppearanceMode);
    if (userId) saveDeviceAppearance(userId, mode);
  };
  const setAccountAppearance = async (mode: AppearanceMode) => {
    const saved = await client.auth.setAppearance({ mode });
    queryClient.setQueryData(['user', userId, 'appearance'], saved);
    if (deviceOverride === null) applyAppearance(saved.mode);
  };
  const toggleTheme = () => setDeviceOverride(document.body.classList.contains('theme-dark') ? 'light' : 'dark');
  const workspaceLinks = workspaceId ? [
    { href: homeHref, label: t.nav.home, icon: 'grid' },
    { href: `${base}/assets`, label: t.nav.assets, icon: 'folder' },
    { href: `${base}/identity`, label: t.nav.identity, icon: 'voice' },
    { href: `${base}/extensions`, label: t.nav.extensions, icon: 'box' },
  ] : [{ href: homeHref, label: t.nav.home, icon: 'grid' }];
  const commands = [
    ...workspaceLinks,
    ...(projects.data ?? []).map((item) => ({ href: projectHref(base, item), label: item.title, icon: 'film' })),
    ...(projectBase ? [
      { href: `${projectBase}/script`, label: t.nav.script, icon: 'file' },
      { href: `${projectBase}/storyboard`, label: t.nav.storyboard, icon: 'film' },
      { href: `${projectBase}/render`, label: t.nav.render, icon: 'check' },
      { href: `${projectBase}/publish`, label: t.nav.publish, icon: 'upload' },
      { href: `${projectBase}/analytics`, label: t.nav.analytics, icon: 'chart' },
    ] : []),
    ...(workspaceId ? [
      { href: `${base}/settings`, label: t.nav.settings, icon: 'settings' },
      { href: `${base}/team`, label: t.nav.team, icon: 'voice' },
      { href: `${base}/billing`, label: t.nav.billing, icon: 'file' },
    ] : []),
    ...(opsSession.data ? [{ href: '/admin', label: t.nav.ops, icon: 'shield' }] : []),
  ];
  const panelTitles = { workspace: t.panels.workspace, command: t.panels.command, notifications: t.panels.notifications, help: t.panels.help };
  const panelLabels = { ...panelTitles, command: t.panels.commandAria };

  return <WorkspaceSelectionContext.Provider value={{ workspaceId, selectWorkspace, appearanceMode, accountAppearanceMode, deviceOverride, appearancePending: session.isPending || (userId !== null && accountAppearance.isPending), appearanceError: accountAppearance.isError, refetchAppearance: () => { void accountAppearance.refetch(); }, setAccountAppearance, setDeviceOverride, toggleTheme, openHelp: () => open('help') }}>
    <div className="app">
      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`} aria-label={t.mainNav} role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen ? 'true' : undefined}>
        <div className="qf-sidebar-head">
          <Brand href={homeHref} label={t.brandAria} />
          <button type="button" className="btn icononly ghost qf-sidebar-close" aria-label={t.closeNav} onClick={() => setMobileOpen(false)}><QuietIcon name="close" /></button>
        </div>
        <button type="button" className="workspace-switch" onClick={() => open('workspace')} aria-label={t.switchWorkspace}>
          <span className="circle">{initial}</span><span className="grow small">{workspaceName}</span><QuietIcon name="down" />
        </button>
        <div className="navgroup"><div className="navlabel">{t.workspaceGroup}</div>
          {workspaceLinks.map(({ href, label, icon }) => <Link key={href} href={href} className={`navitem ${pathname === href.split('?')[0] ? 'active' : ''}`} aria-label={label} aria-current={pathname === href.split('?')[0] ? 'page' : undefined}><QuietIcon name={icon} /><span>{label}</span></Link>)}
        </div>
        <div className="navgroup"><div className="navlabel">{t.recent}</div>
          {(projects.data ?? []).slice(0, 3).map((item) => <Link key={item.id} href={projectHref(base, item)} className={`navitem ${projectId === item.id ? 'active' : ''}`} aria-label={item.title}><QuietIcon name="film" /><span className="qf-ellipsis">{item.title}</span></Link>)}
          {projects.isError ? <span className="small muted">{t.projectsUnavailable}</span> : null}
        </div>
        <div className="sidebottom">
          <button type="button" className="navitem" aria-label={t.search} onClick={() => open('command')}><QuietIcon name="search" /><span className="grow">{t.search}</span><span className="kbd">⌘ K</span></button>
          {workspaceId ? <Link href={`${base}/settings`} className={`navitem ${pathname.includes('/settings') ? 'active' : ''}`} aria-label={t.nav.settings}><QuietIcon name="settings" /><span>{t.nav.settings}</span></Link> : null}
          {opsSession.data ? <Link href="/admin" className={`navitem ${pathname === '/admin' ? 'active' : ''}`} aria-label={t.nav.ops}><QuietIcon name="shield" /><span>{t.nav.ops}</span></Link> : null}
          <button type="button" className="navitem" aria-label={t.help} onClick={() => open('help')}><QuietIcon name="help" /><span>{t.help}</span></button>
          <div className="userrow"><span className="circle">{userName.slice(0, 1).toUpperCase()}</span><span className="grow"><strong className="small">{userName}</strong><br /><span className="small muted">{workspaceName}</span></span></div>
        </div>
      </aside>
      <header className="topbar">
        <div className="row"><button ref={mobileTriggerRef} type="button" className="btn icononly ghost mobile-menu" aria-label={mobileOpen ? t.closeNav : t.openNav} onClick={() => setMobileOpen(!mobileOpen)}><QuietIcon name={mobileOpen ? 'close' : 'menu'} /></button><div className="breadcrumb"><span className="desktop-only">{t.breadcrumbRoot}</span><QuietIcon name="chevron" className="desktop-only" /><strong>{title}</strong></div></div>
        <div className="top-actions"><button type="button" className="btn small ghost" aria-label={messages.common.switchLanguageAria} onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}><QuietIcon name="globe" /><span className="desktop-only">{messages.common.switchLanguage}</span></button><button type="button" className="btn icononly ghost desktop-only" aria-label={t.toggleTheme} onClick={toggleTheme}><QuietIcon name="sun" /></button><button type="button" className="btn icononly ghost" aria-label={t.notifications} onClick={() => open('notifications')}><QuietIcon name="bell" /></button><span className="circle" style={{ width: 28, height: 28 }}>{userName.slice(0, 1).toUpperCase()}</span></div>
      </header>
      <main id="main" className={pathname.includes('/storyboard') || pathname.includes('/editor') ? 'editor-page' : ''}>{children}</main>
    </div>
    {mobileOpen ? <button type="button" className="qf-mobile-backdrop" aria-label={t.closeNav} onClick={() => setMobileOpen(false)} /> : null}
    {panel ? <div className="qf-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setPanel(null); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={panelLabels[panel]} className={`qf-layer ${panel === 'notifications' ? 'qf-layer-right' : ''}`}>
        <div className="row between"><h2>{panelTitles[panel]}</h2><button type="button" className="btn icononly ghost" aria-label={t.close} onClick={() => setPanel(null)}><QuietIcon name="close" /></button></div>
        {panel === 'workspace' ? <div className="col mt24">{(workspaces.data ?? []).map((item) => <button type="button" key={item.id} className="btn" aria-current={item.id === workspaceId ? 'true' : undefined} onClick={() => { selectWorkspace(item.id); setPanel(null); if (pathname !== '/') window.location.href = `/?workspaceId=${encodeURIComponent(item.id)}`; }}>{item.name}</button>)}</div> : null}
        {panel === 'command' ? <><input className="field mt24" aria-label={t.searchAria} placeholder={t.searchPlaceholder} value={command} onChange={(event) => setCommand(event.target.value)} /><div className="qf-command-list mt16">{commands.filter((item) => item.label.toLowerCase().includes(command.trim().toLowerCase()) || command.trim() === '').map((item) => <Link key={`${item.href}:${item.label}`} href={item.href} onClick={() => setPanel(null)}><QuietIcon name={item.icon} />{item.label}<QuietIcon name="arrow" /></Link>)}</div></> : null}
        {panel === 'notifications' ? <div className="col mt24">{notifications.isPending ? <p className="muted">{t.notificationsLoading}</p> : notifications.isError ? <p className="muted">{t.notificationsFailed}<button className="textbtn" onClick={() => void notifications.refetch()}>{t.retry}</button></p> : notifications.data?.length ? notifications.data.map((item) => <div className="qf-notification" key={item.id}><strong>{item.title}</strong><p>{item.body}</p><small className="muted">{new Date(item.createdAt).toLocaleString(locale)}</small></div>) : <p className="muted">{t.notificationsEmpty}</p>}</div> : null}
        {panel === 'help' ? <div className="col mt24"><p>{t.helpGoTo.before} <kbd className="kbd">Ctrl/⌘ K</kbd> {t.helpGoTo.after}</p><p>{t.helpEscape.before} <kbd className="kbd">Esc</kbd> {t.helpEscape.after}</p></div> : null}
      </div>
    </div> : null}
  </WorkspaceSelectionContext.Provider>;
}

export function StudioShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  if (pathname === '/sign-in' || pathname === '/welcome') return <>{children}</>;
  // V6-1c 共看片室是单屏工作台：自带轻顶栏，不套用侧栏与全局顶栏
  if (/^\/w\/[^/]+\/studio\/(?!new$)[^/]+$/.test(pathname)) return <>{children}</>;
  // V6-4 审片（手机网页优先）：同样是自带顶栏的单屏页面
  if (/^\/w\/[^/]+\/review\/[^/]+$/.test(pathname)) return <>{children}</>;
  return <PrivateShell pathname={pathname}>{children}</PrivateShell>;
}
