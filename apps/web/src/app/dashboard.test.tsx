import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import DashboardPage from './page.js';
import { apiError, mockClient, renderWithClient } from '@/test-utils.js';

const replace = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push }) }));

/**
 * Dashboard 状态矩阵（P05-03）：加载（由 pending 覆盖于其他用例）/
 * 未登录（可去登录）/ 失败（可重试）/ 空工作区（可创建）/ 空项目（可创建）/ 正常列表。
 */

const session = () => ({ user: { id: 'usr_1', email: 'a@test.local' } });
const workspace = (id: string, name: string) => ({ id, name, role: 'OWNER' });

describe('Dashboard', () => {
  it('未登录：进入公开欢迎页，不显示私有创作台状态', async () => {
    replace.mockClear();
    const client = mockClient({
      auth: { session: vi.fn().mockRejectedValue(apiError(401, 'UNAUTHENTICATED')) },
      workspaces: { list: vi.fn().mockResolvedValue([]) },
    });
    renderWithClient(<DashboardPage />, client);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/welcome'));
    expect(screen.queryByText('需要登录')).toBeNull();
  });

  it('会话服务故障：保留局部重试入口，不显示已登录创作台', async () => {
    const getSession = vi.fn().mockRejectedValueOnce(apiError(503, 'UNAVAILABLE')).mockResolvedValue(session());
    const client = mockClient({
      auth: { session: getSession },
      workspaces: { list: vi.fn().mockResolvedValue([workspace('ws_1', '财经观察')]) },
      projects: { list: vi.fn().mockResolvedValue([]) },
    });
    renderWithClient(<DashboardPage />, client);
    expect(await screen.findByText('会话暂不可用')).toBeTruthy();
    expect(screen.queryByText('继续创作')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));
  });

  it('工作区为空：创建入口可用（调用 SDK）', async () => {
    const create = vi.fn().mockResolvedValue(workspace('ws_new', '财经观察'));
    const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([workspace('ws_new', '财经观察')]);
    const client = mockClient({
      auth: { session: vi.fn().mockResolvedValue(session()) },
      workspaces: { list, create },
      projects: { list: vi.fn().mockResolvedValue([]) },
    });
    renderWithClient(<DashboardPage />, client);
    expect(await screen.findByText('还没有工作区')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('工作区名称'), '财经观察');
    await userEvent.click(screen.getByRole('button', { name: '创建工作区' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: '财经观察' }));
  });

  it('项目为空：创建项目（自动复用/创建默认栏目）', async () => {
    const channel = { id: 'ch_1', name: '默认栏目' };
    const createProject = vi.fn().mockResolvedValue({ id: 'prj_new', title: '利率周报视频' });
    const client = mockClient({
      auth: { session: vi.fn().mockResolvedValue(session()) },
      workspaces: { list: vi.fn().mockResolvedValue([workspace('ws_1', '财经观察')]) },
      channels: { list: vi.fn().mockResolvedValue([channel]), create: vi.fn() },
      projects: { list: vi.fn().mockResolvedValue([]), create: createProject },
    });
    renderWithClient(<DashboardPage />, client);
    expect(await screen.findByText('该工作区还没有项目')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('项目标题'), '利率周报视频');
    await userEvent.click(screen.getByRole('button', { name: '创建项目' }));
    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith('ws_1', { title: '利率周报视频', channelId: 'ch_1' }),
    );
  });

  it('正常：项目列表可见并带状态信息', async () => {
    const client = mockClient({
      auth: { session: vi.fn().mockResolvedValue(session()) },
      workspaces: { list: vi.fn().mockResolvedValue([workspace('ws_1', '财经观察')]) },
      projects: {
        list: vi.fn().mockResolvedValue([
          { id: 'prj_1', title: '利率周报视频', status: 'DRAFT', revision: 3, aspectRatio: '16:9', fps: 30 },
        ]),
      },
    });
    renderWithClient(<DashboardPage />, client);
    const projectLink = await screen.findByRole('link', { name: /利率周报视频/ });
    expect(projectLink.getAttribute('href')).toBe('/w/ws_1/p/prj_1/script');
    expect(screen.getByText('草稿')).toBeTruthy();
    expect(screen.getByText(/目标 时长待定 · 16:9/)).toBeTruthy();
  });

  it('英文界面：首页文案、阶段与时长都随语言切换', async () => {
    const client = mockClient({
      auth: { session: vi.fn().mockResolvedValue(session()) },
      workspaces: { list: vi.fn().mockResolvedValue([workspace('ws_1', 'Market Watch')]) },
      projects: {
        list: vi.fn().mockResolvedValue([
          { id: 'prj_1', title: 'Weekly rates', status: 'DRAFT', revision: 3, aspectRatio: '16:9', fps: 30, targetDurationMs: 90_000 },
        ]),
      },
    });
    renderWithClient(<I18nProvider initialLocale="en"><DashboardPage /></I18nProvider>, client);
    expect(await screen.findByRole('link', { name: /Weekly rates/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'What video shall we make today?' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Footage' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText('Target 1 min 30 s · 16:9')).toBeTruthy();
    expect(screen.getByText('1 project')).toBeTruthy();
    expect(screen.getByRole('link', { name: /New project/ })).toBeTruthy();
    expect(screen.queryByText(/[一-龥]/)).toBeNull();
  });

  it('首页输入框（参照 Stitch）：素材剪辑带着想法进新建页；文章讲述要先贴文章；素材与文章作品都进共看片室', async () => {
    push.mockClear();
    window.sessionStorage.clear();
    const client = mockClient({
      auth: { session: vi.fn().mockResolvedValue(session()) },
      workspaces: { list: vi.fn().mockResolvedValue([workspace('ws_1', '旅行')]) },
      projects: {
        list: vi.fn().mockResolvedValue([
          { id: 'prj_f', title: '冰岛自驾', status: 'DRAFT', mode: 'FOOTAGE_EDIT', revision: 1, aspectRatio: '16:9', fps: 30 },
          { id: 'prj_a', title: '冰川为什么后退', status: 'DRAFT', mode: 'HYBRID', revision: 1, aspectRatio: '16:9', fps: 30 },
        ]),
      },
    });
    renderWithClient(<DashboardPage />, client);
    expect((await screen.findByRole('link', { name: /冰岛自驾/ })).getAttribute('href')).toBe('/w/ws_1/studio/prj_f');
    expect(screen.getByRole('link', { name: /冰川为什么后退/ }).getAttribute('href')).toBe('/w/ws_1/studio/prj_a');
    expect(screen.getByText('素材剪辑 · 16:9')).toBeTruthy();
    expect(screen.getByText('文章讲述 · 16:9')).toBeTruthy();
    // 建议只填进输入框，不直接发送
    await userEvent.click(screen.getByRole('button', { name: /竖屏 30 秒城市夜跑/ }));
    expect((screen.getByRole('textbox', { name: '想做的视频' }) as HTMLTextAreaElement).value).toBe('竖屏 30 秒城市夜跑，跟着音乐卡点');
    await userEvent.click(screen.getByRole('button', { name: '开始创作' }));
    expect(push).toHaveBeenCalledWith('/w/ws_1/studio/new');
    expect(JSON.parse(window.sessionStorage.getItem('ancs-studio-draft') ?? 'null')).toEqual({ start: 'footage', brief: '竖屏 30 秒城市夜跑，跟着音乐卡点' });
    // 文章讲述：没贴文章时不能开始
    await userEvent.click(screen.getByRole('radio', { name: '文章讲述' }));
    await userEvent.clear(screen.getByRole('textbox', { name: '想做的视频' }));
    expect(screen.getByRole('button', { name: '开始创作' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('group', { name: '试试这样说' })).toBeNull();
  });

  it('失败：错误块可重试（重新调用 SDK）', async () => {
    const list = vi.fn().mockRejectedValueOnce(apiError(500, 'INTERNAL', 'boom')).mockResolvedValue([]);
    const client = mockClient({
      auth: { session: vi.fn().mockResolvedValue(session()) },
      workspaces: { list },
    });
    renderWithClient(<DashboardPage />, client);
    expect(await screen.findByText('加载工作区失败')).toBeTruthy();
    expect(screen.getByTestId('state-diagnostics').textContent).toBe('INTERNAL');
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});
