import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockClient, renderWithClient } from '@/test-utils.js';
import { SecurityOps } from '@/ui/SecurityOps';

/**
 * SaaS 安全运营面板（P09-05）：
 * - 检索（users/workspaces）与 Provider/存储聚合展示；
 * - 滥用标记：创建/解决调用 SDK；限制/解除调用 SDK（提示"阻止新任务"）；
 * - 支持工具界面的工单/受益主体请求形状；API 在 AdminAction 接线前仍拒绝旧直写；
 * - 运营审计（audit_log）列表可见。
 */

const client = (overrides: Record<string, unknown> = {}) =>
  mockClient({
    admin: {
      users: vi.fn().mockResolvedValue([{ id: 'usr_1', email: 'owner@test.local', name: 'Owner', createdAt: '2026-10-05T10:00:00.000Z', workspaceCount: 2 }]),
      workspaces: vi.fn().mockResolvedValue([
        {
          id: 'ws_1',
          name: '工作室',
          privacyTier: 'STANDARD',
          abuseState: 'RESTRICTED',
          planKey: 'STUDIO',
          membersUsed: 3,
          storageBytesUsed: 512 * 1024 ** 2,
          creditsBalance: 120,
          openAbuseFlags: 1,
          createdAt: '2026-10-05T10:00:00.000Z',
        },
      ]),
      abuseFlags: vi.fn().mockResolvedValue([
        { id: 'abf_1', workspaceId: 'ws_1', category: 'SPAM', severity: 'HIGH', status: 'OPEN', note: '垃圾项目', createdByUserId: 'usr_a', resolvedByUserId: null, resolvedAt: null, resolutionNote: null, createdAt: '2026-10-05T10:00:00.000Z', updatedAt: '2026-10-05T10:00:00.000Z' },
      ]),
      storage: vi.fn().mockResolvedValue({ totalBytes: 512 * 1024 ** 2, items: [{ workspaceId: 'ws_1', workspaceName: '工作室', bytesUsed: 512 * 1024 ** 2, assetCount: 4 }] }),
      providerStatus: vi.fn().mockResolvedValue({ items: [{ providerId: 'mock-video', byStatus: { SUCCEEDED: 3 }, lastFailureAt: null, lastErrorCategory: null }] }),
      auditLog: vi.fn().mockResolvedValue([{ id: 'aud_1', actorKind: 'PLATFORM_ADMIN', actorUserId: 'usr_a', action: 'support.view', targetType: 'workspace', targetId: 'ws_1', workspaceId: 'ws_1', details: {}, occurredAt: '2026-10-05T10:00:00.000Z' }]),
      supportGrants: vi.fn().mockResolvedValue([]),
      createAbuseFlag: vi.fn().mockResolvedValue({}),
      resolveAbuseFlag: vi.fn().mockResolvedValue({}),
      setAbuseState: vi.fn().mockResolvedValue({ workspaceId: 'ws_1', abuseState: 'RESTRICTED' }),
      createSupportGrant: vi.fn().mockResolvedValue({ id: 'sag_1', workspaceId: 'ws_1', requestedByUserId: 'usr_a', purpose: '排查工单', status: 'ACTIVE', createdAt: '2026-10-05T10:00:00.000Z', expiresAt: '2026-10-05T12:00:00.000Z', revokedByUserId: null, revokedAt: null }),
      revokeSupportGrant: vi.fn().mockResolvedValue({}),
      supportView: vi.fn().mockResolvedValue({
        workspaceId: 'ws_1',
        name: '工作室',
        privacyTier: 'STANDARD',
        abuseState: 'NORMAL',
        planKey: 'STUDIO',
        counts: { members: 3, projects: 2, assets: 4, storageBytesUsed: 512 * 1024 ** 2, creditsBalance: 120, renders: {}, jobs: {} },
        grant: { id: 'sag_1', workspaceId: 'ws_1', requestedByUserId: 'usr_a', purpose: '排查工单', status: 'ACTIVE', createdAt: '2026-10-05T10:00:00.000Z', expiresAt: '2026-10-05T12:00:00.000Z', revokedByUserId: null, revokedAt: null },
        viewedAt: '2026-10-05T10:05:00.000Z',
      }),
      ...overrides,
    },
  });

describe('SaaS 安全运营面板（P09-05）', () => {
  it('聚合展示：users/workspaces（限制状态/未解决标记）/Provider/存储/审计', async () => {
    renderWithClient(<SecurityOps />, client());
    expect(await screen.findByText(/owner@test\.local · 参与 2 个 Workspace/)).toBeTruthy();
    expect(screen.getByText(/工作室 · STUDIO · 成员 3/)).toBeTruthy();
    expect(screen.getByText(/未解决标记 1/)).toBeTruthy();
    expect(screen.getByText(/mock-video/)).toBeTruthy();
    expect((await screen.findByTestId('ops-audit-log')).textContent).toMatch(/support\.view/);
  });

  it('滥用处理：创建标记与限制/解除调用 SDK，提示阻止新任务', async () => {
    const createAbuseFlag = vi.fn().mockResolvedValue({});
    const setAbuseState = vi.fn().mockResolvedValue({ workspaceId: 'ws_1', abuseState: 'RESTRICTED' });
    renderWithClient(<SecurityOps />, client({ createAbuseFlag, setAbuseState }));

    await userEvent.type(await screen.findByLabelText('标记 Workspace ID'), 'ws_1');
    await userEvent.type(screen.getByLabelText('标记备注'), '批量垃圾内容');
    await userEvent.click(screen.getByRole('button', { name: '创建标记' }));
    await waitFor(() => expect(createAbuseFlag).toHaveBeenCalledWith('ws_1', { category: 'OTHER', severity: 'MEDIUM', note: '批量垃圾内容' }));

    await userEvent.click(screen.getByRole('button', { name: '限制（阻止新任务）' }));
    await waitFor(() => expect(setAbuseState).toHaveBeenCalledWith('ws_1', { abuseState: 'RESTRICTED', note: '运营面板操作（见审计）' }));
    expect((await screen.findByTestId('secops-notice')).textContent).toMatch(/新的成本性任务将被阻止/);
  });

  it('支持工具：授权创建提示"成员可见"→ 支持视图展示元数据摘要 → 撤销', async () => {
    const createSupportGrant = vi.fn().mockResolvedValue({ id: 'sag_1' });
    const revokeSupportGrant = vi.fn().mockResolvedValue({});
    renderWithClient(
      <SecurityOps />,
      client({
        createSupportGrant,
        revokeSupportGrant,
        supportGrants: vi.fn().mockResolvedValue([
          { id: 'sag_1', workspaceId: 'ws_1', requestedByUserId: 'usr_a', purpose: '排查工单', status: 'ACTIVE', createdAt: '2026-10-05T10:00:00.000Z', expiresAt: '2026-10-05T12:00:00.000Z', revokedByUserId: null, revokedAt: null },
        ]),
      }),
    );

    await userEvent.type(await screen.findByLabelText('支持 Workspace ID'), 'ws_1');
    await userEvent.type(screen.getByLabelText('支持目的'), '排查渲染失败工单');
    await userEvent.type(screen.getByLabelText('支持工单 ID'), 'ticket-42');
    await userEvent.type(screen.getByLabelText('受益运营主体 ID'), 'oppr_alice');
    await userEvent.click(screen.getByRole('button', { name: '创建授权（2h）' }));
    await waitFor(() => expect(createSupportGrant).toHaveBeenCalledWith('ws_1', {
      purpose: '排查渲染失败工单', ticketId: 'ticket-42', beneficiaryPrincipalId: 'oppr_alice', scope: 'SUMMARY_READ', ttlHours: 2,
    }));
    expect(screen.getByTestId('secops-notice').textContent).toMatch(/成员可见/);
    expect((await screen.findByTestId('support-grants')).textContent).toMatch(/排查工单/);

    await userEvent.click(screen.getByRole('button', { name: '打开支持视图' }));
    expect((await screen.findByTestId('support-view')).textContent).toMatch(/仅元数据；本次访问已留痕并对成员可见/);

    await userEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(revokeSupportGrant).toHaveBeenCalledWith('sag_1'));
  });

  it('无有效授权时支持视图被拒：明示 403 与"需先创建时限授权"', async () => {
    const { AncsApiError } = await import('@ancs/sdk');
    renderWithClient(
      <SecurityOps />,
      client({
        supportView: vi.fn().mockRejectedValue(new AncsApiError({ status: 403, code: 'FORBIDDEN', message: '无有效支持访问授权', requestId: 'req_1', details: { reason: 'SUPPORT_GRANT_REQUIRED' } })),
      }),
    );
    await userEvent.type(await screen.findByLabelText('支持 Workspace ID'), 'ws_1');
    await userEvent.type(screen.getByLabelText('支持工单 ID'), 'ticket-42');
    await userEvent.click(screen.getByRole('button', { name: '打开支持视图' }));
    expect((await screen.findByTestId('secops-notice')).textContent).toMatch(/需先创建时限授权/);
  });
});
