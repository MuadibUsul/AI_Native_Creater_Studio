import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockClient as buildMockClient, renderWithClient } from '@/test-utils.js';

vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws_1', projectId: 'prj_1' }),
  usePathname: () => '/w/ws_1/p/prj_1/render',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: unknown; href: string }) => <a href={href}>{children as never}</a>,
}));

const { default: RenderPage } = await import('@/app/w/[workspaceId]/p/[projectId]/render/page.js');
const mockClient = (overrides: Record<string, unknown>) => buildMockClient({
  workspaces: { get: vi.fn().mockResolvedValue({ role: 'EDITOR' }) },
  narrative: {
    current: vi.fn().mockResolvedValue({ id: 'plan_1', revision: 1 }),
    masterNarration: vi.fn().mockResolvedValue({ id: 'mn_1', narrativePlanRevision: 1, assetId: 'ast_voice', assetVersionId: 'av_voice', totalDurationMs: 4500, alignmentMethod: 'PROVIDER_TIMESTAMPS', segments: [], warnings: [] }),
  },
  ...overrides,
});

/**
 * Render 与审核界面（P07-05）状态矩阵：
 * - 预检报告（含失败项）与渲染队列状态；
 * - 缺少后端报价与能力确认时，内容预检不替代创建闸门；
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
  it('空态可以选择规格，但缺后端报价和能力确认时不提交渲染', async () => {
    const create = vi.fn().mockResolvedValue(renderRecord());
    const client = mockClient({
      renders: { list: vi.fn().mockResolvedValue([]), create, qa: vi.fn(), qaReport: vi.fn().mockResolvedValue(null), approval: vi.fn().mockResolvedValue(null) },
      projects: { renderPrecheck: vi.fn() },
    });
    renderWithClient(<RenderPage />, client);
    expect(await screen.findByText(/还没有渲染/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('渲染规格'), 'DRAFT_720');
    await userEvent.click(screen.getByRole('button', { name: '创建新渲染' }));
    expect((screen.getByLabelText('渲染规格') as HTMLSelectElement).value).toBe('DRAFT_720');
    expect(screen.getByText(/尚未提供所选规格的费用报价/)).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
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
    expect(screen.getByText(/阻止项 1 · 警告 0/)).toBeTruthy();
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
    expect(screen.getAllByText('成片缺少音轨（§86）').length).toBeGreaterThan(0);
    expect(screen.getByTestId('qa-check-AI_VISUAL_QA')).toBeTruthy();
    expect(screen.getByText(/跳过 1/)).toBeTruthy();
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
    await userEvent.click(screen.getByRole('checkbox', { name: /我已核对这个真实渲染版本/ }));
    await userEvent.click(screen.getByRole('button', { name: '批准这一版' }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith('ws_1', 'rnd_1', { decision: 'APPROVED' }));
  });

  it('READY + 已批准：展示批准信息与受控导出入口（导出包逐产物链接；编辑提示可见）', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
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
        { kind: 'VIDEO', assetId: 'ast_v', download: { url: 'https://storage.local/final.mp4?t=1', expiresAt }, sizeBytes: 1048576, mimeType: 'video/mp4' },
        { kind: 'MANIFEST', assetId: 'ast_m', download: { url: 'https://storage.local/manifest.json?t=1', expiresAt }, sizeBytes: 2048, mimeType: 'application/json' },
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
    expect(await screen.findByTestId('approval-panel')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: '获取受控下载链接' }));
    await waitFor(() => expect(exportPackage).toHaveBeenCalledWith('ws_1', 'rnd_1'));
    expect(await screen.findByTestId('export-package')).toBeTruthy();
    expect(screen.getByText(/批准后已有新编辑/)).toBeTruthy();
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
    expect(screen.getByRole('button', { name: '批准这一版' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '获取受控下载链接' })).toBeNull();
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
    expect(await screen.findByText(/渲染失败：QA_FAILED/)).toBeTruthy();
  });
});
