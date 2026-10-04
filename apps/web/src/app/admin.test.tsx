import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, mockClient, renderWithClient } from '@/test-utils.js';

const { default: AdminPage } = await import('@/app/admin/page.js');

/**
 * 最小运营界面（P08-02）：
 * - 非管理员（404）→ 无权限块，**不显示任何运营数据**；
 * - 未登录（401）→ 需要登录；
 * - 管理员：总览（队列/成本/QA/审批/Provider）+ 失败任务重试（复用任务服务）+ 审计列表。
 */

const overview = {
  generatedAt: '2026-10-05T12:00:00.000Z',
  jobs: { byStatus: { QUEUED: 3, FAILED_FINAL: 1 }, failedRetryable: 0, failedFinal: 1, needsReconciliation: 0, oldestActiveAgeSeconds: 42 },
  renders: { byStatus: { READY: 2 } },
  qa: { last24hPass: 2, last24hFail: 1 },
  approvals: { approved: 1, rejected: 1 },
  providerGenerations: { byStatus: { SUCCEEDED: 4 } },
  spend: { debitsTotal: 120, workspacesWithLedger: 2 },
};

describe('运营界面（P08-02）', () => {
  it('非管理员（404）→ 无权限块（不渲染运营数据）', async () => {
    const client = mockClient({
      admin: {
        overview: vi.fn().mockRejectedValue(apiError(404, 'NOT_FOUND', 'not found')),
        jobs: vi.fn().mockResolvedValue([]),
        audit: vi.fn().mockResolvedValue([]),
        retryJob: vi.fn(),
      },
    });
    renderWithClient(<AdminPage />, client);
    expect(await screen.findByText(/无权限访问（或不存在）/)).toBeTruthy();
    expect(screen.queryByTestId('ops-summary')).toBeNull();
  });

  it('未登录（401）→ 需要登录', async () => {
    const client = mockClient({
      admin: {
        overview: vi.fn().mockRejectedValue(apiError(401, 'UNAUTHENTICATED', 'not authenticated')),
        jobs: vi.fn().mockResolvedValue([]),
        audit: vi.fn().mockResolvedValue([]),
        retryJob: vi.fn(),
      },
    });
    renderWithClient(<AdminPage />, client);
    expect(await screen.findByText('需要登录')).toBeTruthy();
  });

  it('管理员：总览 + 失败任务重试（经任务服务）+ 审计可见', async () => {
    const retryJob = vi.fn().mockResolvedValue({ id: 'job_1', type: 'RENDER_FINAL', status: 'QUEUED', attempts: 2, maxAttempts: 2, needsReconciliation: false, input: {}, result: null, error: null, stage: null, submitState: 'NOT_SUBMITTED', priority: 0, nextAttemptAt: null, enqueuedAt: null, startedAt: null, completedAt: null, workspaceId: 'ws_1', projectId: null, createdAt: '2026-10-05T11:00:00.000Z', updatedAt: '2026-10-05T12:00:00.000Z' });
    const client = mockClient({
      admin: {
        overview: vi.fn().mockResolvedValue(overview),
        jobs: vi.fn().mockImplementation((query: { status?: string }) =>
          Promise.resolve(
            query?.status === 'FAILED_FINAL'
              ? [
                  {
                    id: 'job_1',
                    workspaceId: 'ws_1',
                    projectId: 'prj_1',
                    type: 'RENDER_FINAL',
                    status: 'FAILED_FINAL',
                    stage: null,
                    submitState: 'NOT_SUBMITTED',
                    input: {},
                    result: null,
                    error: { reason: 'RENDER_EXECUTION_FAILED' },
                    attempts: 2,
                    maxAttempts: 2,
                    priority: 0,
                    needsReconciliation: false,
                    nextAttemptAt: null,
                    enqueuedAt: null,
                    startedAt: null,
                    completedAt: null,
                    createdAt: '2026-10-05T11:00:00.000Z',
                    updatedAt: '2026-10-05T11:30:00.000Z',
                  },
                ]
              : [],
          ),
        ),
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
    expect(await screen.findByText('RENDER_EXECUTION_FAILED')).toBeTruthy();
    expect(screen.getByText(/render rnd_1 → QA/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(retryJob).toHaveBeenCalledWith('job_1', { reason: '运营人工重试' }));
    expect(await screen.findByText(/已重新入队/)).toBeTruthy();
  });
});
