import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockClient, renderWithClient } from '@/test-utils.js';

vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws_1', projectId: 'prj_1' }),
  usePathname: () => '/w/ws_1/p/prj_1/render',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: unknown; href: string }) => <a href={href}>{children as never}</a>,
}));

const { default: RenderPage } = await import('@/app/w/[workspaceId]/p/[projectId]/render/page.js');

/**
 * Render 与审核界面（P07-05）状态矩阵：
 * - 预检报告（含失败项）与渲染队列状态；
 * - 创建渲染调用 SDK（档位）；
 * - QA 报告逐项展示（阻止项/警告/跳过）+ QA 状态可重触发；
 * - READY 明确"等待人工批准"（不提供假批准按钮——批准属 P07-06）。
 */

const renderRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'rnd_1',
  workspaceId: 'ws_1',
  projectId: 'prj_1',
  profile: 'STUDIO_1080',
  status: 'QA',
  input: { projectVersionId: 'pv_1', masterNarrationId: 'mna_1', assetVersionIds: [], format: { width: 1920, height: 1080, fps: 30 } },
  estimatedCost: null,
  manifestHash: null,
  outputAssetIds: [],
  error: null,
  createdBy: null,
  createdAt: '2026-10-05T10:00:00.000Z',
  updatedAt: '2026-10-05T10:00:00.000Z',
  ...overrides,
});

const qaReport = (checks: { id: string; category: string; severity: string; status: string; message: string | null }[]) => ({
  schemaVersion: 'render-qa-v1',
  scope: 'FINAL_RENDER',
  workspaceId: 'ws_1',
  projectId: 'prj_1',
  renderId: 'rnd_1',
  verdict: checks.some((check) => check.status === 'FAIL' && check.severity === 'BLOCKER') ? 'FAIL' : 'PASS',
  checks: checks.map((check) => ({ ...check, details: {} })),
  summary: {
    blockersFailed: checks.filter((check) => check.status === 'FAIL' && check.severity === 'BLOCKER').length,
    warningsFailed: checks.filter((check) => check.status === 'FAIL' && check.severity === 'WARNING').length,
    skipped: checks.filter((check) => check.status === 'SKIP').length,
  },
  createdAt: '2026-10-05T10:01:00.000Z',
  createdBy: null,
});

describe('Render 与审核（P07-05）', () => {
  it('空态 + 创建渲染：调用 SDK（所选档位）并刷新列表', async () => {
    const create = vi.fn().mockResolvedValue(renderRecord());
    const client = mockClient({
      renders: { list: vi.fn().mockResolvedValue([]), create, qa: vi.fn(), qaReport: vi.fn().mockResolvedValue(null), approval: vi.fn().mockResolvedValue(null) },
      projects: { renderPrecheck: vi.fn() },
    });
    renderWithClient(<RenderPage />, client);
    expect(await screen.findByText(/还没有渲染/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('渲染档位'), 'DRAFT_720');
    await userEvent.click(screen.getByRole('button', { name: '创建渲染' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('ws_1', 'prj_1', { profile: 'DRAFT_720' }));
  });

  it('渲染前预检：展示逐项检查与失败原因（阻止项）', async () => {
    const precheck = qaReport([
      { id: 'SCENES_PRESENT', category: 'PRE_RENDER', severity: 'BLOCKER', status: 'PASS', message: null },
      { id: 'SCENE_STATUS_NO_PLACEHOLDER', category: 'PRE_RENDER', severity: 'BLOCKER', status: 'FAIL', message: '存在未解决的占位场景（2 个）' },
      { id: 'MASTER_NARRATION_PRESENT', category: 'PRE_RENDER', severity: 'BLOCKER', status: 'PASS', message: null },
    ]);
    const client = mockClient({
      renders: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), qa: vi.fn(), qaReport: vi.fn().mockResolvedValue(null), approval: vi.fn().mockResolvedValue(null) },
      projects: { renderPrecheck: vi.fn().mockResolvedValue(precheck) },
    });
    renderWithClient(<RenderPage />, client);
    await userEvent.click(await screen.findByRole('button', { name: '渲染前预检' }));
    expect(await screen.findByTestId('qa-report')).toBeTruthy();
    expect(screen.getByTestId('qa-check-SCENE_STATUS_NO_PLACEHOLDER')).toBeTruthy();
    expect(screen.getByText(/存在未解决的占位场景（2 个）/)).toBeTruthy();
    expect(screen.getByText(/FAIL · 阻止项失败 1/)).toBeTruthy();
  });

  it('QA 报告：阻止项失败与显式 SKIP 都可见；QA 状态可重新触发', async () => {
    const qa = vi.fn().mockResolvedValue({ jobId: 'job_qa' });
    const report = qaReport([
      { id: 'VIDEO_RESOLUTION_FPS', category: 'TECHNICAL', severity: 'BLOCKER', status: 'PASS', message: null },
      { id: 'AUDIO_TRACK_PRESENT', category: 'TECHNICAL', severity: 'BLOCKER', status: 'FAIL', message: '成片缺少音轨（§86）' },
      { id: 'AI_VISUAL_QA', category: 'TECHNICAL', severity: 'WARNING', status: 'SKIP', message: 'AI/Visual QA 未交付' },
    ]);
    const client = mockClient({
      renders: { list: vi.fn().mockResolvedValue([renderRecord({ status: 'QA' })]), create: vi.fn(), qa, qaReport: vi.fn().mockResolvedValue(report), approval: vi.fn().mockResolvedValue(null) },
      projects: { renderPrecheck: vi.fn() },
    });
    renderWithClient(<RenderPage />, client);
    expect(await screen.findByTestId('qa-check-AUDIO_TRACK_PRESENT')).toBeTruthy();
    expect(screen.getByText('成片缺少音轨（§86）')).toBeTruthy();
    expect(screen.getByTestId('qa-check-AI_VISUAL_QA')).toBeTruthy();
    expect(screen.getByText(/跳过（记录）/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '重新触发 QA' }));
    await waitFor(() => expect(qa).toHaveBeenCalledWith('ws_1', 'rnd_1'));
  });

  it('READY + 未审批：提供真实批准/驳回按钮；批准调用 SDK（绑定 manifest 快照）', async () => {
    const decideApproval = vi.fn().mockResolvedValue({
      id: 'rap_1',
      workspaceId: 'ws_1',
      projectId: 'prj_1',
      renderId: 'rnd_1',
      decision: 'APPROVED',
      manifestHashAtApproval: 'f'.repeat(64),
      projectVersionIdAtApproval: 'pv_1',
      projectRevisionAtApproval: 3,
      note: null,
      decidedBy: 'user_1',
      createdAt: '2026-10-05T10:05:00.000Z',
    });
    const client = mockClient({
      renders: {
        list: vi.fn().mockResolvedValue([renderRecord({ status: 'READY', manifestHash: 'f'.repeat(64) })]),
        create: vi.fn(),
        qa: vi.fn(),
        qaReport: vi.fn().mockResolvedValue(qaReport([{ id: 'VIDEO_RESOLUTION_FPS', category: 'TECHNICAL', severity: 'BLOCKER', status: 'PASS', message: null }])),
        approval: vi.fn().mockResolvedValue(null),
        decideApproval,
      },
      projects: { renderPrecheck: vi.fn() },
    });
    renderWithClient(<RenderPage />, client);
    expect(await screen.findByTestId('approval-panel')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '批准' }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith('ws_1', 'rnd_1', { decision: 'APPROVED' }));
  });

  it('READY + 已批准：展示批准信息与受控导出入口（导出包逐产物链接；编辑提示可见）', async () => {
    const exportPackage = vi.fn().mockResolvedValue({
      schemaVersion: 'render-export-v1',
      renderId: 'rnd_1',
      projectId: 'prj_1',
      projectVersionId: 'pv_1',
      profile: 'STUDIO_1080',
      manifestHash: 'f'.repeat(64),
      approvalId: 'rap_1',
      approvedAt: '2026-10-05T10:05:00.000Z',
      approvedBy: 'user_1',
      projectEditedSinceApproval: true,
      entries: [
        { kind: 'VIDEO', assetId: 'ast_v', download: { url: 'https://storage.local/final.mp4?t=1', expiresAt: '2026-10-05T10:20:00.000Z' }, sizeBytes: 1048576, mimeType: 'video/mp4' },
        { kind: 'MANIFEST', assetId: 'ast_m', download: { url: 'https://storage.local/manifest.json?t=1', expiresAt: '2026-10-05T10:20:00.000Z' }, sizeBytes: 2048, mimeType: 'application/json' },
      ],
    });
    const client = mockClient({
      renders: {
        list: vi.fn().mockResolvedValue([renderRecord({ status: 'READY', manifestHash: 'f'.repeat(64) })]),
        create: vi.fn(),
        qa: vi.fn(),
        qaReport: vi.fn().mockResolvedValue(qaReport([])),
        approval: vi.fn().mockResolvedValue({
          id: 'rap_1',
          workspaceId: 'ws_1',
          projectId: 'prj_1',
          renderId: 'rnd_1',
          decision: 'APPROVED',
          manifestHashAtApproval: 'f'.repeat(64),
          projectVersionIdAtApproval: 'pv_1',
          projectRevisionAtApproval: 3,
          note: '金样批准',
          decidedBy: 'user_1',
          createdAt: '2026-10-05T10:05:00.000Z',
        }),
        decideApproval: vi.fn(),
        exportPackage,
      },
      projects: { renderPrecheck: vi.fn() },
    });
    renderWithClient(<RenderPage />, client);
    expect(await screen.findByText(/已批准/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '导出受控下载入口' }));
    await waitFor(() => expect(exportPackage).toHaveBeenCalledWith('ws_1', 'rnd_1'));
    expect(await screen.findByTestId('export-package')).toBeTruthy();
    expect(screen.getByText(/批准后项目有新编辑/)).toBeTruthy();
    const videoLink = screen.getByRole('link', { name: /VIDEO/ });
    expect(videoLink.getAttribute('href')).toContain('final.mp4');
  });

  it('READY + 已驳回：显示驳回备注并允许重新批准（不显示导出入口）', async () => {
    const client = mockClient({
      renders: {
        list: vi.fn().mockResolvedValue([renderRecord({ status: 'READY', manifestHash: 'f'.repeat(64) })]),
        create: vi.fn(),
        qa: vi.fn(),
        qaReport: vi.fn().mockResolvedValue(qaReport([])),
        approval: vi.fn().mockResolvedValue({
          id: 'rap_0',
          workspaceId: 'ws_1',
          projectId: 'prj_1',
          renderId: 'rnd_1',
          decision: 'REJECTED',
          manifestHashAtApproval: 'f'.repeat(64),
          projectVersionIdAtApproval: 'pv_1',
          projectRevisionAtApproval: 3,
          note: '标题需要调整',
          decidedBy: 'user_1',
          createdAt: '2026-10-05T10:04:00.000Z',
        }),
        decideApproval: vi.fn(),
        exportPackage: vi.fn(),
      },
      projects: { renderPrecheck: vi.fn() },
    });
    renderWithClient(<RenderPage />, client);
    expect(await screen.findByText(/最近一次审批为驳回：标题需要调整/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '批准' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '导出受控下载入口' })).toBeNull();
  });

  it('FAILED：显示失败原因（error.reason）', async () => {
    const client = mockClient({
      renders: {
        list: vi.fn().mockResolvedValue([renderRecord({ status: 'FAILED', error: { reason: 'QA_FAILED' } })]),
        create: vi.fn(),
        qa: vi.fn(),
        qaReport: vi.fn().mockResolvedValue(null),
      },
      projects: { renderPrecheck: vi.fn() },
    });
    renderWithClient(<RenderPage />, client);
    expect(await screen.findByText('QA_FAILED')).toBeTruthy();
  });
});
