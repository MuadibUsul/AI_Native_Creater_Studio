import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, mockClient, renderWithClient } from '@/test-utils.js';

const { default: AdminPage } = await import('@/app/admin/page.js');

/**
 * 最小运营界面（P08-02）：
 * - 非管理员（404）→ 无权限块，**不显示任何运营数据**；
 * - 未登录（401）→ 需要登录；
 * - 管理员：总览、显式工作区过滤后的安全任务摘要、审计列表；旧写入口不展示。
 */

const overview = {
  generatedAt: '2026-10-05T12:00:00.000Z',
  jobs: { byStatus: { QUEUED: 3, FAILED_FINAL: 1 }, failedRetryable: 0, failedFinal: 1, needsReconciliation: 0, oldestActiveAgeSeconds: 42 },
  renders: { byStatus: { READY: 2 } },
  qa: { last24hPass: 2, last24hFail: 1 },
  approvals: { approved: 1, rejected: 1 },
  providerGenerations: { byStatus: { SUCCEEDED: 4 } },
  spend: { debitsTotal: 120, workspacesWithLedger: 2 },
  alerts: [{ id: 'JOBS_FAILED_FINAL', severity: 'CRITICAL', summary: '存在终态失败任务（1 个）', value: 1, threshold: 0 }],
};

describe('运营界面（P08-02）', () => {
  it('非管理员（404）→ 无权限块（不渲染运营数据）', async () => {
    const client = mockClient({
      admin: {
        users: vi.fn().mockResolvedValue([]),
        workspaces: vi.fn().mockResolvedValue([]),
        abuseFlags: vi.fn().mockResolvedValue([]),
        storage: vi.fn().mockResolvedValue({ totalBytes: 0, items: [] }),
        providerStatus: vi.fn().mockResolvedValue({ items: [] }),
        auditLog: vi.fn().mockResolvedValue([]),
        supportGrants: vi.fn().mockResolvedValue([]),
        overview: vi.fn().mockRejectedValue(apiError(404, 'NOT_FOUND', 'not found')),
        jobs: vi.fn().mockResolvedValue([]),
        audit: vi.fn().mockResolvedValue([]),
        retryJob: vi.fn(),
      },
    });
    renderWithClient(<AdminPage />, client);
    expect(await screen.findByText('需要运营身份与多因素验证')).toBeTruthy();
    expect(screen.queryByTestId('ops-summary')).toBeNull();
  });

  it('未登录（401）→ 需要登录', async () => {
    const client = mockClient({
      admin: {
        users: vi.fn().mockResolvedValue([]),
        workspaces: vi.fn().mockResolvedValue([]),
        abuseFlags: vi.fn().mockResolvedValue([]),
        storage: vi.fn().mockResolvedValue({ totalBytes: 0, items: [] }),
        providerStatus: vi.fn().mockResolvedValue({ items: [] }),
        auditLog: vi.fn().mockResolvedValue([]),
        supportGrants: vi.fn().mockResolvedValue([]),
        overview: vi.fn().mockRejectedValue(apiError(401, 'UNAUTHENTICATED', 'not authenticated')),
        jobs: vi.fn().mockResolvedValue([]),
        audit: vi.fn().mockResolvedValue([]),
        retryJob: vi.fn(),
      },
    });
    renderWithClient(<AdminPage />, client);
    expect(await screen.findByText('需要登录')).toBeTruthy();
  });

  it('管理员：总览 + 工作区范围的安全任务摘要 + 审计可见', async () => {
    const retryJob = vi.fn();
    const listJobs = vi.fn().mockImplementation((query: { workspaceId: string; status?: string }) =>
      Promise.resolve(query.workspaceId === 'ws_1' && query.status === 'FAILED_FINAL' ? [{
        id: 'job_1', workspaceId: 'ws_1', projectId: 'prj_1', status: 'FAILED_FINAL',
        submitState: 'NOT_SUBMITTED', attempts: 2, maxAttempts: 2, needsReconciliation: false,
        nextAttemptAt: null, createdAt: '2026-10-05T11:00:00.000Z', updatedAt: '2026-10-05T11:30:00.000Z',
        errorCategory: 'FINAL',
      }] : []),
    );
    const client = mockClient({
      admin: {
        users: vi.fn().mockResolvedValue([]),
        workspaces: vi.fn().mockResolvedValue([]),
        abuseFlags: vi.fn().mockResolvedValue([]),
        storage: vi.fn().mockResolvedValue({ totalBytes: 0, items: [] }),
        providerStatus: vi.fn().mockResolvedValue({ items: [] }),
        auditLog: vi.fn().mockResolvedValue([]),
        supportGrants: vi.fn().mockResolvedValue([]),
        overview: vi.fn().mockResolvedValue(overview),
        jobs: listJobs,
        audit: vi.fn().mockResolvedValue([
          {
            id: 'evt_1',
            kind: 'RENDER',
            at: '2026-10-05T11:31:00.000Z',
            workspaceId: 'ws_1',
            projectId: null,
            summary: 'render rnd_1 → QA（合成完成）',
            details: {},
          },
        ]),
        retryJob,
      },
    });
    renderWithClient(<AdminPage />, client);
    expect(await screen.findByTestId('ops-summary')).toBeTruthy();
    expect(screen.getByText('42s')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
    expect(listJobs).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('工作区 ID'), 'ws_1');
    await userEvent.click(screen.getByRole('button', { name: '查看任务' }));
    expect(await screen.findByText('job_1')).toBeTruthy();
    expect(screen.getByText('FINAL')).toBeTruthy();
    await waitFor(() => expect(listJobs).toHaveBeenCalledWith({ workspaceId: 'ws_1', status: 'FAILED_FINAL', limit: 50 }));
    expect(screen.getByText(/render rnd_1 → QA/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(retryJob).not.toHaveBeenCalled();
  });
});
