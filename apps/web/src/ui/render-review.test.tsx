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
      renders: { list: vi.fn().mockResolvedValue([]), create, qa: vi.fn(), qaReport: vi.fn().mockResolvedValue(null) },
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
      renders: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), qa: vi.fn(), qaReport: vi.fn().mockResolvedValue(null) },
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
      renders: { list: vi.fn().mockResolvedValue([renderRecord({ status: 'QA' })]), create: vi.fn(), qa, qaReport: vi.fn().mockResolvedValue(report) },
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

  it('READY：提示"等待人工批准"且不提供假批准按钮（批准/导出属 P07-06）', async () => {
    const client = mockClient({
      renders: {
        list: vi.fn().mockResolvedValue([renderRecord({ status: 'READY', manifestHash: 'f'.repeat(64) })]),
        create: vi.fn(),
        qa: vi.fn(),
        qaReport: vi.fn().mockResolvedValue(qaReport([{ id: 'VIDEO_RESOLUTION_FPS', category: 'TECHNICAL', severity: 'BLOCKER', status: 'PASS', message: null }])),
      },
      projects: { renderPrecheck: vi.fn() },
    });
    renderWithClient(<RenderPage />, client);
    expect(await screen.findByText('QA 通过 · 等待人工批准')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /批准|导出/ })).toBeNull();
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
