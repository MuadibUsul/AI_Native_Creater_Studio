import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OpsSession } from '@ancs/contracts';
import { apiError, mockClient, renderWithClient } from '@/test-utils.js';

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
});
