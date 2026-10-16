import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import { apiError, mockClient, renderWithClient } from '@/test-utils';
import { DeliveryRender } from './delivery-render';

const now = '2026-10-07T08:00:00.000Z';
const base = {
  workspaceId: 'ws_1', projectId: 'prj_1', profile: 'STUDIO_1080' as const, status: 'READY' as const,
  input: { projectVersionId: 'pv_1', masterNarrationId: 'mn_1', assetVersionIds: [], format: { width: 1920, height: 1080, fps: 30 } },
  estimatedCost: null, manifestHash: 'a'.repeat(64), outputAssetIds: [], error: null, createdBy: null, createdAt: now, updatedAt: now,
};
const passingQa = { verdict: 'PASS', checks: [], summary: { blockersFailed: 0, warningsFailed: 0, skipped: 0 }, createdAt: now };
const failingQa = { ...passingQa, verdict: 'FAIL', summary: { blockersFailed: 1, warningsFailed: 0, skipped: 0 } };
const master = { id: 'mn_1', narrativePlanRevision: 1, assetId: 'ast_voice', assetVersionId: 'av_voice', totalDurationMs: 4500, alignmentMethod: 'PROVIDER_TIMESTAMPS', segments: [], warnings: [] };
const prerequisites = () => ({
  workspaces: { get: vi.fn().mockResolvedValue({ role: 'EDITOR' }) },
  narrative: { current: vi.fn().mockResolvedValue({ id: 'plan_1', revision: 1 }), masterNarration: vi.fn().mockResolvedValue(master) },
});

describe('Quiet Frame render approval', () => {
  it('approves only the render selected by the reviewer after an explicit check', async () => {
    const decideApproval = vi.fn().mockResolvedValue({ decision: 'APPROVED', createdAt: now });
    const client = mockClient({
      ...prerequisites(),
      renders: { list: vi.fn().mockResolvedValue([{ ...base, id: 'rnd_new' }, { ...base, id: 'rnd_old' }]), qaReport: vi.fn().mockResolvedValue(passingQa), approval: vi.fn().mockResolvedValue(null), decideApproval },
      projects: { renderPrecheck: vi.fn() },
    });
    renderWithClient(<DeliveryRender workspaceId="ws_1" projectId="prj_1" />, client);
    await screen.findByTestId('render-rnd_old');
    await userEvent.click(screen.getByTestId('render-rnd_old'));
    const button = screen.getByRole('button', { name: /批准这一版/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(button);
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith('ws_1', 'rnd_old', { decision: 'APPROVED' }));
  });

  it('keeps approval unavailable when the server QA report has a blocker', async () => {
    const decideApproval = vi.fn();
    const client = mockClient({
      ...prerequisites(),
      renders: { list: vi.fn().mockResolvedValue([{ ...base, id: 'rnd_1' }]), qaReport: vi.fn().mockResolvedValue(failingQa), approval: vi.fn().mockResolvedValue(null), decideApproval },
      projects: { renderPrecheck: vi.fn() },
    });
    renderWithClient(<DeliveryRender workspaceId="ws_1" projectId="prj_1" />, client);
    await screen.findByTestId('qa-report');
    expect((screen.getByRole('button', { name: '批准这一版' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: /我已核对/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/需要一份通过的服务端 QA 报告/)).toBeTruthy();
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it('blocks a new render after a failing server precheck', async () => {
    const create = vi.fn();
    const client = mockClient({
      ...prerequisites(),
      renders: { list: vi.fn().mockResolvedValue([]), create, qaReport: vi.fn().mockResolvedValue(null), approval: vi.fn().mockResolvedValue(null) },
      projects: { renderPrecheck: vi.fn().mockResolvedValue(failingQa) },
    });
    renderWithClient(<DeliveryRender workspaceId="ws_1" projectId="prj_1" />, client);
    await userEvent.click(screen.getByRole('button', { name: '渲染前预检' }));
    expect(await screen.findByText(/预检存在阻止项/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '创建新渲染' }) as HTMLButtonElement).disabled).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('does not play an expired signed URL and can request a fresh one', async () => {
    const downloadUrl = vi.fn().mockResolvedValue({ url: 'https://storage.local/expired.mp4', expiresAt: '2020-01-01T00:00:00.000Z' });
    const client = mockClient({
      ...prerequisites(),
      renders: { list: vi.fn().mockResolvedValue([{ ...base, id: 'rnd_1', outputAssetIds: ['ast_video'] }]), qaReport: vi.fn().mockResolvedValue(passingQa), approval: vi.fn().mockResolvedValue(null) },
      assets: { get: vi.fn().mockResolvedValue({ currentVersionId: 'av_1', versions: [{ id: 'av_1', mimeType: 'video/mp4' }] }), downloadUrl },
    });
    renderWithClient(<DeliveryRender workspaceId="ws_1" projectId="prj_1" />, client);
    const refresh = await screen.findByRole('button', { name: '刷新预览链接' });
    expect(screen.queryByLabelText('当前成片预览')).toBeNull();
    await userEvent.click(refresh);
    await waitFor(() => expect(downloadUrl).toHaveBeenCalledTimes(2));
  });

  it('reads the current script narration and refreshes a missing result without submitting unsafe synthesis', async () => {
    const masterNarration = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(master);
    const synthesizeMasterNarration = vi.fn();
    const create = vi.fn();
    const client = mockClient({
      ...prerequisites(),
      narrative: { current: vi.fn().mockResolvedValue({ id: 'plan_1', revision: 1 }), masterNarration, synthesizeMasterNarration },
      renders: { list: vi.fn().mockResolvedValue([]), create },
    });
    renderWithClient(<DeliveryRender workspaceId="ws_1" projectId="prj_1" />, client);
    expect(await screen.findByText('当前脚本尚无旁白，暂不能创建新渲染。')).toBeTruthy();
    expect(masterNarration).toHaveBeenCalledWith('ws_1', 'prj_1', 'plan_1');
    await userEvent.click(screen.getByRole('button', { name: '刷新旁白状态' }));
    expect(await screen.findByText('旁白已就绪')).toBeTruthy();
    expect(synthesizeMasterNarration).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('shows stale narration and keeps a passing content precheck from substituting for a cost quote', async () => {
    const create = vi.fn();
    const client = mockClient({
      ...prerequisites(),
      narrative: { current: vi.fn().mockResolvedValue({ id: 'plan_1', revision: 2 }), masterNarration: vi.fn().mockResolvedValue(master) },
      renders: { list: vi.fn().mockResolvedValue([]), create },
      projects: { renderPrecheck: vi.fn().mockResolvedValue(passingQa) },
    });
    renderWithClient(<DeliveryRender workspaceId="ws_1" projectId="prj_1" />, client);
    expect(await screen.findByText(/现有旁白对应旧版本/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '渲染前预检' }));
    expect(await screen.findByText('检查通过')).toBeTruthy();
    expect(screen.getByText(/尚未提供所选规格的费用报价/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '创建新渲染' }));
    expect(create).not.toHaveBeenCalled();
  });

  it('lets a read-only reviewer retry narration reads without exposing synthesis or create mutations', async () => {
    const masterNarration = vi.fn().mockRejectedValueOnce(apiError(503, 'SERVICE_UNAVAILABLE', '旁白服务暂不可用')).mockResolvedValue(master);
    const create = vi.fn();
    const synthesizeMasterNarration = vi.fn();
    const client = mockClient({
      workspaces: { get: vi.fn().mockResolvedValue({ role: 'VIEWER' }) },
      narrative: { current: vi.fn().mockResolvedValue({ id: 'plan_1', revision: 1 }), masterNarration, synthesizeMasterNarration },
      renders: { list: vi.fn().mockResolvedValue([]), create },
    });
    renderWithClient(<DeliveryRender workspaceId="ws_1" projectId="prj_1" />, client);
    expect(await screen.findByText(/旁白状态读取失败/)).toBeTruthy();
    expect(screen.getByText('当前角色只能查看，无法创建新渲染。')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '刷新旁白状态' }));
    expect(await screen.findByText('旁白已就绪')).toBeTruthy();
    expect((screen.getByRole('button', { name: '创建新渲染' }) as HTMLButtonElement).disabled).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(synthesizeMasterNarration).not.toHaveBeenCalled();
  });

  it('renders the review page in English without Chinese interface text', async () => {
    const client = mockClient({
      ...prerequisites(),
      renders: { list: vi.fn().mockResolvedValue([{ ...base, id: 'rnd_1' }]), qaReport: vi.fn().mockResolvedValue(passingQa), approval: vi.fn().mockResolvedValue(null) },
      projects: { renderPrecheck: vi.fn().mockResolvedValue(failingQa) },
    });
    const { container } = renderWithClient(<I18nProvider initialLocale="en"><DeliveryRender workspaceId="ws_1" projectId="prj_1" /></I18nProvider>, client);
    expect(await screen.findByText('Narration ready')).toBeTruthy();
    await screen.findByTestId('qa-report');
    expect(screen.getByRole('heading', { name: 'The final pass is yours.' })).toBeTruthy();
    expect(screen.getByText(/Script revision 1 · 4\.5s · 0 narration segments · Provider timestamps/)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Render profile' })).toBeTruthy();
    expect(screen.getAllByText('Studio HD · 1080p').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Approve this version' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /I've reviewed this real render/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Pre-render check' }));
    expect(await screen.findByText(/The precheck found blockers/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create new render' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    expect(container.innerHTML).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
