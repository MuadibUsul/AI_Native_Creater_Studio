import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OpsSession } from '@ancs/contracts';
import { apiError, mockClient, renderWithClient } from '@/test-utils.js';
import { I18nProvider } from '@/i18n/I18nProvider';

const { default: AdminPage } = await import('@/app/admin/page.js');

const session = (roles: OpsSession['roles'], environment: OpsSession['environment'] = 'TEST'): OpsSession => ({
  id: 'opss_test', principalId: 'oppr_test', environment, roles,
  createdAt: '2026-10-08T08:00:00.000Z', idleExpiresAt: '2026-10-08T09:00:00.000Z',
  absoluteExpiresAt: '2026-10-08T16:00:00.000Z', reauthenticatedAt: '2026-10-08T08:00:00.000Z', securityNotice: null,
});

describe('N15-03 独立运营入口', () => {
  it('无 ops 会话时仅显示登录与权限说明，不请求旧 admin 数据', async () => {
    const overview = vi.fn();
    renderWithClient(<AdminPage />, mockClient({
      ops: { session: vi.fn().mockRejectedValue(apiError(404, 'NOT_FOUND')) },
      admin: { overview },
    }));
    expect(await screen.findByText('需要独立运营会话')).toBeTruthy();
    expect(screen.getByRole('link', { name: '前往登录' })).toBeTruthy();
    expect(screen.queryByTestId('security-ops')).toBeNull();
    expect(overview).not.toHaveBeenCalled();
  });

  it('独立会话决定身份并显示当前角色的只读诊断', async () => {
    const overview = vi.fn();
    renderWithClient(<AdminPage />, mockClient({
      ops: { session: vi.fn().mockResolvedValue(session(['PRODUCTION_OPERATOR'])) },
      admin: { overview, projects: vi.fn(), storage: vi.fn() },
    }));
    expect(await screen.findByRole('heading', { name: '工作区诊断' })).toBeTruthy();
    expect(screen.getByText(/运营环境：TEST/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '工单支持' })).toBeNull();
    expect(overview).not.toHaveBeenCalled();
  });

  it('生产会话不开放旧 /admin 查询', async () => {
    const projects = vi.fn();
    renderWithClient(<AdminPage />, mockClient({
      ops: { session: vi.fn().mockResolvedValue(session(['PRODUCTION_OPERATOR'], 'PRODUCTION')) },
      admin: { projects },
    }));
    expect(await screen.findByText('生产运营诊断暂未开放')).toBeTruthy();
    expect(screen.queryByTestId('security-ops')).toBeNull();
    expect(projects).not.toHaveBeenCalled();
  });

  it('英文界面：无会话时的说明、登录入口与验证器配置均为英文', async () => {
    const { container } = renderWithClient(<I18nProvider initialLocale="en"><AdminPage /></I18nProvider>, mockClient({
      ops: { session: vi.fn().mockRejectedValue(apiError(404, 'NOT_FOUND')) },
    }));
    expect(await screen.findByText('A separate operations session is required')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Operations diagnostics' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to sign-in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(screen.getByText('Granted operations access? Set up your authenticator')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set up authenticator' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });

  it('英文界面：会话面板与两类诊断均为英文', async () => {
    const { container } = renderWithClient(<I18nProvider initialLocale="en"><AdminPage /></I18nProvider>, mockClient({
      ops: { session: vi.fn().mockResolvedValue({ ...session(['PRODUCTION_OPERATOR', 'SUPPORT_L2']), securityNotice: 'NEW_DEVICE' }) },
      admin: { projects: vi.fn(), storage: vi.fn(), supportGrants: vi.fn() },
    }));
    expect(await screen.findByRole('heading', { name: 'Workspace diagnostics' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Ticket support' })).toBeTruthy();
    expect(screen.getByText('Operations environment: TEST')).toBeTruthy();
    expect(screen.getByText(/^Roles PRODUCTION_OPERATOR, SUPPORT_L2 · Absolute expiry /)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/new device/);
    expect(screen.getByLabelText('Re-verify for sensitive actions')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke this device' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });
});
