import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioShell, useWorkspaceSelection } from './StudioShell';
import { DesignSystemControls, DesignSystemExampleActions, DesignSystemStatusAction } from '@/components/quiet-frame/DesignSystemControls';
import { DesignSystemPage } from '@/components/quiet-frame/workspace-public';
import { mockClient, renderWithClient } from '@/test-utils';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

function client() {
  return mockClient({
    auth: {
      session: vi.fn().mockResolvedValue({ user: { id: 'usr_1', name: '作者', email: 'a@example.com' } }),
      getAppearance: vi.fn().mockResolvedValue({ userId: 'usr_1', mode: 'system', updatedAt: null }),
      setAppearance: vi.fn().mockResolvedValue({ userId: 'usr_1', mode: 'dark', updatedAt: '2026-10-08T00:00:00.000Z' }),
    },
    workspaces: { list: vi.fn().mockResolvedValue([{ id: 'ws_1', name: '研究室' }]) },
    projects: { list: vi.fn().mockResolvedValue([{ id: 'prj_1', title: '真实作品', status: 'DRAFT' }]) },
    notifications: { list: vi.fn().mockResolvedValue([{ id: 'ntf_1', title: '任务完成', body: '作品已更新', createdAt: '2026-10-07T00:00:00Z' }]) },
  });
}

function AppearanceProbe() {
  const { setDeviceOverride, setAccountAppearance } = useWorkspaceSelection();
  return <>
    <button onClick={() => setDeviceOverride('system')}>覆盖本机系统</button>
    <button onClick={() => setDeviceOverride(null)}>继承账号</button>
    <button onClick={() => void setAccountAppearance('light')}>账号浅色</button>
  </>;
}

describe('Quiet Frame 工作台外壳', () => {
  beforeEach(() => { window.localStorage.clear(); document.cookie = 'ancs-qf-appearance=; Path=/; Max-Age=0'; document.body.classList.remove('theme-dark'); delete document.body.dataset['appearanceMode']; });
  afterEach(() => vi.unstubAllGlobals());

  it('用真实工作区和项目生成导航，通知只从 SDK 读取', async () => {
    const sdk = client();
    renderWithClient(<StudioShell><div>页面内容</div></StudioShell>, sdk);
    expect((await screen.findByRole('link', { name: /真实作品/ })).getAttribute('href')).toBe('/w/ws_1/p/prj_1/storyboard');
    expect(screen.getByRole('link', { name: /素材库/ }).getAttribute('href')).toBe('/w/ws_1/assets');
    expect(screen.getByRole('button', { name: '切换工作区' }).textContent).toContain('研究室');
    await userEvent.click(screen.getByRole('button', { name: '打开任务通知' }));
    expect(await screen.findByText('任务完成')).toBeTruthy();
    expect(sdk.notifications.list).toHaveBeenCalledWith({ workspaceId: 'ws_1', limit: 20 });
  });

  it('窄屏导航提供抽屉内关闭入口并恢复导航语义', async () => {
    renderWithClient(<StudioShell><div>页面内容</div></StudioShell>, client());
    await screen.findByRole('link', { name: /真实作品/ });
    await userEvent.click(screen.getByRole('button', { name: '打开导航' }));
    expect(screen.getByRole('dialog', { name: '主导航' })).toBeTruthy();
    const closeButtons = screen.getAllByRole('button', { name: '关闭导航' });
    await userEvent.click(closeButtons[0]!);
    expect(screen.queryByRole('dialog', { name: '主导航' })).toBeNull();
    expect(screen.getByRole('complementary', { name: '主导航' })).toBeTruthy();
  });

  it('命令搜索支持快捷键、过滤、Esc 关闭与焦点返回', async () => {
    renderWithClient(<StudioShell><div>页面内容</div></StudioShell>, client());
    const trigger = screen.getByRole('button', { name: /快速搜索/ });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: '快速搜索' })).toBeTruthy();
    await userEvent.type(screen.getByRole('textbox', { name: '搜索页面或作品' }), '导演');
    expect(screen.getByRole('link', { name: /导演工作台/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /账单/ })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog', { name: '快速搜索' })).toBeTruthy();
  });

  it('旧 V4 流水线下线（服务端报告 off）：快速搜索不再列出脚本与导演工作台，出片等入口保留', async () => {
    const sdk = mockClient({ ...client(), capabilities: vi.fn().mockResolvedValue({ legacyPipeline: 'off' }) });
    renderWithClient(<StudioShell><div>页面内容</div></StudioShell>, sdk);
    await screen.findByRole('link', { name: /真实作品/ });
    await waitFor(() => expect(sdk.capabilities).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: /快速搜索/ }));
    const search = screen.getByRole('textbox', { name: '搜索页面或作品' });
    await userEvent.type(search, '导演');
    await waitFor(() => expect(screen.queryByRole('link', { name: /导演工作台/ })).toBeNull());
    await userEvent.clear(search);
    await userEvent.type(search, '脚本');
    expect(screen.queryByRole('link', { name: /^脚本/ })).toBeNull();
  });

  it('主题切换只改变用户偏好，不触发业务写入', async () => {
    const sdk = client();
    renderWithClient(<StudioShell><div>页面内容</div></StudioShell>, sdk);
    await screen.findByRole('link', { name: /真实作品/ });
    await userEvent.click(screen.getByRole('button', { name: '切换浅深色' }));
    expect(document.body.classList.contains('theme-dark')).toBe(true);
    expect(window.localStorage.getItem('ancs-qf-appearance:usr_1')).toBe('dark');
    expect(document.cookie).toContain('ancs-qf-appearance=usr_1.dark');
    expect(sdk.projects.list).toHaveBeenCalledTimes(1);
  });

  it('默认跟随系统变化，固定外观后不受系统变化影响', async () => {
    const media = Object.assign(new EventTarget(), { matches: true, media: '(prefers-color-scheme: dark)' });
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    renderWithClient(<StudioShell><div>页面内容</div></StudioShell>, client());
    await waitFor(() => expect(document.body.classList.contains('theme-dark')).toBe(true));
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    await waitFor(() => expect(document.body.classList.contains('theme-dark')).toBe(false));
    await userEvent.click(screen.getByRole('button', { name: '切换浅深色' }));
    expect(document.body.classList.contains('theme-dark')).toBe(true);
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    expect(document.body.classList.contains('theme-dark')).toBe(true);
  });

  it('设备覆盖按用户隔离，旧版全局偏好不被继承', async () => {
    window.localStorage.setItem('ancs-qf-theme', 'dark');
    window.localStorage.setItem('ancs-qf-appearance:usr_1', 'dark');
    const first = renderWithClient(<StudioShell><div>页面内容</div></StudioShell>, client());
    await waitFor(() => expect(document.body.classList.contains('theme-dark')).toBe(true));
    first.unmount();
    const second = client();
    second.auth.session = vi.fn().mockResolvedValue({ user: { id: 'usr_2', name: '第二人', email: 'b@example.com' } });
    second.auth.getAppearance = vi.fn().mockResolvedValue({ userId: 'usr_2', mode: 'system', updatedAt: null });
    renderWithClient(<StudioShell><div>页面内容</div></StudioShell>, second);
    await waitFor(() => expect(document.body.dataset['appearanceMode']).toBe('system'));
    expect(document.body.classList.contains('theme-dark')).toBe(false);
  });

  it('设备覆盖优先于同步账号偏好，显式 system 可覆盖账号 dark', async () => {
    const sdk = client();
    sdk.auth.getAppearance = vi.fn().mockResolvedValue({ userId: 'usr_1', mode: 'dark', updatedAt: '2026-10-08T00:00:00.000Z' });
    sdk.auth.setAppearance = vi.fn().mockResolvedValue({ userId: 'usr_1', mode: 'light', updatedAt: '2026-10-08T00:01:00.000Z' });
    renderWithClient(<StudioShell><AppearanceProbe /></StudioShell>, sdk);
    await waitFor(() => expect(document.body.classList.contains('theme-dark')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: '覆盖本机系统' }));
    expect(document.body.classList.contains('theme-dark')).toBe(false);
    expect(window.localStorage.getItem('ancs-qf-appearance:usr_1')).toBe('system');
    await userEvent.click(screen.getByRole('button', { name: '继承账号' }));
    expect(document.body.classList.contains('theme-dark')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '账号浅色' }));
    await waitFor(() => expect(document.body.classList.contains('theme-dark')).toBe(false));
    expect(sdk.auth.setAppearance).toHaveBeenCalledWith({ mode: 'light' });
    expect(sdk.projects.list).toHaveBeenCalledTimes(1);
  });

  it('账号偏好接口失败时仍应用本机设备覆盖', async () => {
    window.localStorage.setItem('ancs-qf-appearance:usr_1', 'dark');
    const sdk = client();
    sdk.auth.getAppearance = vi.fn().mockRejectedValue(new Error('offline'));
    renderWithClient(<StudioShell><div>页面内容</div></StudioShell>, sdk);
    await waitFor(() => expect(document.body.classList.contains('theme-dark')).toBe(true));
    expect(document.body.dataset['appearanceMode']).toBe('dark');
    expect(window.localStorage.getItem('ancs-qf-appearance:usr_1')).toBe('dark');
  });

  it('账号偏好接口失败且无设备覆盖时保留服务端首屏外观', async () => {
    document.body.dataset['appearanceMode'] = 'dark';
    document.body.classList.add('theme-dark');
    const sdk = client();
    sdk.auth.getAppearance = vi.fn().mockRejectedValue(new Error('offline'));
    renderWithClient(<StudioShell><div>页面内容</div></StudioShell>, sdk);
    await waitFor(() => expect(sdk.auth.getAppearance).toHaveBeenCalled());
    expect(document.body.dataset['appearanceMode']).toBe('dark');
    expect(document.body.classList.contains('theme-dark')).toBe(true);
  });

  it('设计系统中的主题与快捷键按钮调用工作台的真实交互', async () => {
    renderWithClient(<StudioShell><DesignSystemControls /></StudioShell>, client());
    await userEvent.click(screen.getByRole('button', { name: '切换深浅色' }));
    expect(document.body.classList.contains('theme-dark')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '查看快捷键' }));
    expect(screen.getByRole('dialog', { name: '帮助与快捷键' })).toBeTruthy();
  });

  it('设计系统示例动作引导到当前工作区的新建页，取消只显示说明', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      renderWithClient(<StudioShell><DesignSystemPage /></StudioShell>, client());
      await waitFor(() => expect(screen.getByRole('button', { name: '切换工作区' }).textContent).toContain('研究室'));
      expect(screen.getByRole('link', { name: '开始创作 →' }).getAttribute('href')).toBe('/w/ws_1/new');
      expect(screen.getByRole('link', { name: '生成草稿 ✧' }).getAttribute('href')).toBe('/w/ws_1/new');
      await userEvent.click(screen.getByRole('button', { name: '取消' }));
      expect(screen.getByRole('status').textContent).toContain('当前没有待取消的操作');
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it('没有工作区时示例动作回到创作台选择工作区', () => {
    renderWithClient(<DesignSystemExampleActions />, mockClient({}));
    expect(screen.getByRole('link', { name: '开始创作 →' }).getAttribute('href')).toBe('/');
    expect(screen.getByRole('link', { name: '生成草稿 ✧' }).getAttribute('href')).toBe('/');
  });

  it('设计系统状态动作只展示说明，Esc 关闭并保留焦点，不写入作品或授权', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      renderWithClient(<StudioShell><DesignSystemStatusAction kind="conflict" /><DesignSystemStatusAction kind="consent" /></StudioShell>, client());
      await waitFor(() => expect(screen.getByRole('button', { name: '切换工作区' }).textContent).toContain('研究室'));
      const conflict = screen.getByRole('button', { name: '查看解决方式' });
      await userEvent.click(conflict);
      expect(screen.getByRole('dialog', { name: '作品已有更新。你的修改仍在。' }).textContent).toContain('演示差异');
      expect(screen.queryByRole('button', { name: '保留本地草稿' })).toBeNull();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(conflict);

      await userEvent.click(screen.getByRole('button', { name: '查看授权流程' }));
      expect(screen.getByRole('dialog', { name: '这段声音，属于你吗？' }).textContent).toContain('不提交授权');
      expect(screen.getByRole('link', { name: '前往创作者身份' }).getAttribute('href')).toBe('/w/ws_1/identity');
      await userEvent.click(screen.getByRole('button', { name: '知道了' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it('无工作区时授权说明只引导进入创作台', async () => {
    renderWithClient(<DesignSystemStatusAction kind="consent" />, mockClient({}));
    await userEvent.click(screen.getByRole('button', { name: '查看授权流程' }));
    expect(screen.getByRole('link', { name: '进入创作台' }).getAttribute('href')).toBe('/');
  });

  it('切换工作区后保留首页深链接，避免刷新后串回第一个工作区', async () => {
    const sdk = mockClient({
      auth: {
        session: vi.fn().mockResolvedValue({ user: { id: 'usr_1', name: '作者', email: 'a@example.com' } }),
        getAppearance: vi.fn().mockResolvedValue({ userId: 'usr_1', mode: 'system', updatedAt: null }),
        setAppearance: vi.fn().mockResolvedValue({ userId: 'usr_1', mode: 'dark', updatedAt: '2026-10-08T00:00:00.000Z' }),
      },
      workspaces: { list: vi.fn().mockResolvedValue([{ id: 'ws_1', name: '第一工作区' }, { id: 'ws_2', name: '第二工作区' }]) },
      projects: { list: vi.fn().mockResolvedValue([]) },
    });
    renderWithClient(<StudioShell><div>页面内容</div></StudioShell>, sdk);
    await waitFor(() => expect(screen.getByRole('button', { name: '切换工作区' }).textContent).toContain('第一工作区'));
    await userEvent.click(screen.getByRole('button', { name: '切换工作区' }));
    await userEvent.click(screen.getByRole('button', { name: '第二工作区' }));
    expect(screen.getByRole('link', { name: 'Creator Studio 创作台' }).getAttribute('href')).toBe('/?workspaceId=ws_2');
    expect(screen.getByRole('link', { name: '创作台' }).getAttribute('aria-current')).toBe('page');
    expect(window.location.search).toBe('?workspaceId=ws_2');
  });
});
