import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OpsSession } from '@ancs/contracts';
import { apiError, mockClient, renderWithClient } from '@/test-utils.js';
import { SecurityOps } from '@/ui/SecurityOps';
import { I18nProvider } from '@/i18n/I18nProvider';

const session = (roles: OpsSession['roles']): OpsSession => ({
  id: 'opss_test', principalId: 'oppr_test', environment: 'TEST', roles,
  createdAt: '2026-10-08T08:00:00.000Z', idleExpiresAt: '2026-10-08T09:00:00.000Z',
  absoluteExpiresAt: '2026-10-08T16:00:00.000Z', reauthenticatedAt: '2026-10-08T08:00:00.000Z', securityNotice: null,
});

const project = (workspaceId: string) => ({
  id: `prj_${workspaceId}`, workspaceId, status: 'DRAFT',
  createdAt: '2026-10-08T08:00:00.000Z', updatedAt: '2026-10-08T08:10:00.000Z',
});

describe('N15-03 限定范围运营诊断', () => {
  it('运营角色显式提交 workspace 后才查询项目与存储，切换范围立即清理旧结果', async () => {
    const projects = vi.fn().mockImplementation(({ workspaceId }: { workspaceId: string }) =>
      workspaceId === 'ws_a' ? Promise.resolve([project('ws_a')]) : new Promise(() => {}));
    const storage = vi.fn().mockImplementation(({ workspaceId }: { workspaceId: string }) =>
      workspaceId === 'ws_a' ? Promise.resolve({ workspaceId, bytesUsed: 1048576, assetCount: 2 }) : new Promise(() => {}));
    const unsafeWrite = vi.fn();
    renderWithClient(<SecurityOps session={session(['PRODUCTION_OPERATOR'])} />, mockClient({
      admin: { projects, storage, setAbuseState: unsafeWrite },
    }));
    expect(projects).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('工作区 ID'), 'ws_a');
    expect(projects).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '查询工作区' }));
    expect(await screen.findByText('prj_ws_a')).toBeTruthy();
    expect(screen.getByTestId('admin-storage').textContent).toMatch(/1.0 MiB/);
    expect(projects).toHaveBeenCalledWith({ workspaceId: 'ws_a', limit: 50 });
    expect(screen.queryByRole('button', { name: /限制|创建标记|撤销/ })).toBeNull();
    expect(unsafeWrite).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText('工作区 ID'));
    await userEvent.type(screen.getByLabelText('工作区 ID'), 'ws_b');
    expect(screen.getByText('prj_ws_a')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '查询工作区' }));
    expect(screen.queryByText('prj_ws_a')).toBeNull();
    expect(screen.getByText(/当前范围/).textContent).toMatch(/ws_b/);
    expect(projects).toHaveBeenCalledWith({ workspaceId: 'ws_b', limit: 50 });
  });

  it('403 不显示上一次数据，保留范围并允许手动重试', async () => {
    const projects = vi.fn().mockRejectedValue(apiError(403, 'FORBIDDEN', '范围未授权'));
    renderWithClient(<SecurityOps session={session(['PRODUCTION_OPERATOR'])} />, mockClient({
      admin: { projects, storage: vi.fn().mockResolvedValue({ workspaceId: 'ws_other', bytesUsed: 0, assetCount: 0 }) },
    }));
    await userEvent.type(screen.getByLabelText('工作区 ID'), 'ws_other');
    await userEvent.click(screen.getByRole('button', { name: '查询工作区' }));
    expect(await screen.findByText('当前范围无权查看')).toBeTruthy();
    expect(screen.queryByTestId('admin-storage')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '重试查询' }));
    await waitFor(() => expect(projects).toHaveBeenCalledTimes(2));
  });

  it('支持人员仅在提交 workspace+ticket 后查当前授权，主动打开摘要并明示留痕', async () => {
    const supportGrants = vi.fn().mockResolvedValue([{
      id: 'sag_a', workspaceId: 'ws_a', scope: 'SUMMARY_READ', status: 'ACTIVE',
      createdAt: '2026-10-08T08:00:00.000Z', expiresAt: '2099-10-08T08:00:00.000Z',
    }]);
    const supportView = vi.fn().mockResolvedValue({
      workspaceId: 'ws_a', viewedAt: '2026-10-08T08:15:00.000Z',
      counts: { members: 3, projects: 2, assets: 4, storageBytesUsed: 1048576, creditsBalance: 100 },
    });
    renderWithClient(<SecurityOps session={session(['SUPPORT_L2'])} />, mockClient({ admin: { supportGrants, supportView } }));
    expect(screen.queryByRole('heading', { name: '工作区诊断' })).toBeNull();
    expect(screen.getByText(/oppr_test/)).toBeTruthy();
    expect(supportGrants).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('工作区 ID'), 'ws_a');
    await userEvent.type(screen.getByLabelText('工单 ID'), 'ticket_a');
    expect(supportGrants).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '查询授权' }));
    expect(await screen.findByText('sag_a')).toBeTruthy();
    expect(supportGrants).toHaveBeenCalledWith('ws_a', 'ticket_a');
    expect(supportView).not.toHaveBeenCalled();
    expect(screen.getByText(/每次访问都会留痕并对客户可见/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '确认并打开支持摘要' }));
    expect(await screen.findByTestId('support-view')).toBeTruthy();
    expect(supportView).toHaveBeenCalledWith('ws_a', 'ticket_a');
    expect(screen.getByTestId('support-view').textContent).toMatch(/本次访问已留痕/);
    expect(screen.queryByRole('button', { name: /创建授权|撤销|解决/ })).toBeNull();

    await userEvent.clear(screen.getByLabelText('工单 ID'));
    await userEvent.type(screen.getByLabelText('工单 ID'), 'ticket_b');
    await userEvent.click(screen.getByRole('button', { name: '查询授权' }));
    expect(screen.queryByTestId('support-view')).toBeNull();
    expect(screen.getByText(/当前范围/).textContent).toMatch(/ticket_b/);
  });

  it('其他角色不渲染运营查询或旧写入口', () => {
    const projects = vi.fn();
    renderWithClient(<SecurityOps session={session(['PLATFORM_OWNER'])} />, mockClient({ admin: { projects } }));
    expect(screen.getByText('当前角色暂无可用诊断')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(projects).not.toHaveBeenCalled();
  });

  it('英文界面：运营查询与支持摘要全部为英文，时间按英文格式显示', async () => {
    const projects = vi.fn().mockResolvedValue([project('ws_a')]);
    const storage = vi.fn().mockResolvedValue({ workspaceId: 'ws_a', bytesUsed: 1048576, assetCount: 2 });
    const supportGrants = vi.fn().mockResolvedValue([{
      id: 'sag_a', workspaceId: 'ws_a', scope: 'SUMMARY_READ', status: 'ACTIVE',
      createdAt: '2026-10-08T08:00:00.000Z', expiresAt: '2099-10-08T08:00:00.000Z',
    }]);
    const supportView = vi.fn().mockResolvedValue({
      workspaceId: 'ws_a', viewedAt: '2026-10-08T08:15:00.000Z',
      counts: { members: 3, projects: 2, assets: 4, storageBytesUsed: 1048576, creditsBalance: 100 },
    });
    const { container } = renderWithClient(<I18nProvider initialLocale="en"><SecurityOps session={session(['PRODUCTION_OPERATOR', 'SUPPORT_L2'])} /></I18nProvider>, mockClient({
      admin: { projects, storage, supportGrants, supportView },
    }));
    expect(screen.getByText('Enter an authorized workspace ID. Nothing is queried until you submit.')).toBeTruthy();
    expect(container.textContent).not.toMatch(/[一-鿿]/);

    const [workspaceInput, supportWorkspaceInput] = screen.getAllByLabelText('Workspace ID');
    await userEvent.type(workspaceInput!, 'ws_a');
    await userEvent.click(screen.getByRole('button', { name: 'Look up workspace' }));
    expect(await screen.findByText('prj_ws_a')).toBeTruthy();
    expect(screen.getByTestId('admin-storage').textContent).toBe('Storage used 1.0 MiBAssets 2');
    expect(screen.getByRole('columnheader', { name: 'Project ID' })).toBeTruthy();
    expect(screen.getByText('Project status · ws_a')).toBeTruthy();
    expect(screen.getByTestId('admin-projects').textContent).toContain(new Date('2026-10-08T08:00:00.000Z').toLocaleString('en'));

    await userEvent.type(supportWorkspaceInput!, 'ws_a');
    await userEvent.type(screen.getByLabelText('Ticket ID'), 'ticket_a');
    await userEvent.click(screen.getByRole('button', { name: 'Look up grants' }));
    expect(await screen.findByText('sag_a')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and open support summary' }));
    const summary = await screen.findByTestId('support-view');
    expect(summary.textContent).toContain('Redacted support summary');
    expect(summary.textContent).toContain(`Viewed ${new Date('2026-10-08T08:15:00.000Z').toLocaleString('en')}`);
    expect(summary.textContent).toContain('This access has been logged and is visible to workspace members.');
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });

  it('英文界面：其他角色看到英文说明', () => {
    const { container } = renderWithClient(<I18nProvider initialLocale="en"><SecurityOps session={session(['PLATFORM_OWNER'])} /></I18nProvider>, mockClient({ admin: {} }));
    expect(screen.getByText('No diagnostics available for your role')).toBeTruthy();
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });
});
