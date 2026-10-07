import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockClient, renderWithClient } from '@/test-utils';
import { DeliveryPublish } from './delivery-publish';

const now = '2026-10-07T08:00:00.000Z';
const renderRecord = {
  id: 'rnd_1', workspaceId: 'ws_1', projectId: 'prj_1', profile: 'STUDIO_1080' as const,
  status: 'READY' as const, input: { projectVersionId: 'pv_1', masterNarrationId: 'mn_1', assetVersionIds: [], format: { width: 1920, height: 1080, fps: 30 } },
  estimatedCost: null, manifestHash: 'a'.repeat(64), outputAssetIds: ['ast_video'], error: null, createdBy: null, createdAt: now, updatedAt: now,
};

function clientForPublish(approved: boolean, exportPackage = vi.fn()) {
  const create = vi.fn().mockResolvedValue({
    id: 'exp_1', workspaceId: 'ws_1', projectId: 'prj_1', platformId: 'DOUYIN', createdAt: now,
    payload: { platformId: 'DOUYIN', projectVersionId: 'pv_1', videoAssetId: 'ast_video', coverAssetId: null, coverNote: '无封面', title: '真实作品', description: null, tags: [], disclosure: null, checklist: ['下载视频', '由用户完成发布'], finalStepByUser: true },
  });
  const reconcile = vi.fn().mockResolvedValue({ id: 'pub_1', state: 'PUBLISHED' });
  const handoff = { handoffId: 'hdf_1', workspaceId: 'ws_1', projectId: 'prj_1', state: 'PENDING', artifactIds: ['ast_video'], targetPlatform: null, createdBy: 'usr_1', claimedBy: null, claimedAt: null, revokedAt: null, isExpired: false, expiresAt: '2030-01-01T00:00:00.000Z', createdAt: now };
  const createHandoff = vi.fn().mockResolvedValue(handoff);
  const cancelHandoff = vi.fn().mockResolvedValue({ ...handoff, state: 'REVOKED' });
  const client = mockClient({
    renders: { list: vi.fn().mockResolvedValue([renderRecord]), approval: vi.fn().mockResolvedValue(approved ? { decision: 'APPROVED', renderId: 'rnd_1' } : null), exportPackage },
    projects: { get: vi.fn().mockResolvedValue({ id: 'prj_1', title: '真实作品' }) },
    assets: { get: vi.fn().mockResolvedValue({ id: 'ast_video', currentVersionId: 'av_1', versions: [{ id: 'av_1', mimeType: 'video/mp4' }] }) },
    publications: { list: vi.fn().mockResolvedValue({ items: [] }), reconcile },
    exportPackages: { list: vi.fn().mockResolvedValue({ items: [] }), create },
    handoffs: { list: vi.fn().mockResolvedValue({ items: [] }), create: createHandoff, cancel: cancelHandoff },
  });
  return { client, create, reconcile, createHandoff, cancelHandoff };
}

describe('Quiet Frame publish gates', () => {
  it('does not expose a fake direct publish action or P4 package before approval', async () => {
    const { client, create } = clientForPublish(false);
    renderWithClient(<DeliveryPublish workspaceId="ws_1" projectId="prj_1" />, client);
    await screen.findByRole('heading', { name: '真实作品' });
    expect(screen.getByTestId('package-preview').textContent).toContain('示意 · 等待成片批准');
    expect(screen.getByTestId('package-preview').querySelector('.cover-duration')).toBeNull();
    expect(screen.getAllByRole('button', { name: /待连接与核验/ }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getAllByRole('button', { name: /准备素材包/ }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect((screen.getByRole('button', { name: '创建 24 小时交接记录' }) as HTMLButtonElement).disabled).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('passes the approved frozen version and real output asset to the P4 package API', async () => {
    const { client, create } = clientForPublish(true);
    renderWithClient(<DeliveryPublish workspaceId="ws_1" projectId="prj_1" />, client);
    const buttons = await screen.findAllByRole('button', { name: /准备素材包/ });
    await waitFor(() => expect((buttons[0] as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('package-preview').querySelector('.cover-art.art-0')).not.toBeNull();
    expect(screen.getByTestId('package-preview').textContent).toContain('封面示意 · 非成片画面');
    expect(screen.getByRole('link', { name: /选择扩展/ }).getAttribute('href')).toBe('/w/ws_1/extensions');
    expect(screen.getByText(/Render rnd_1 · 项目版本 pv_1/)).toBeTruthy();
    await userEvent.click(buttons[0]!);
    await waitFor(() => expect(create).toHaveBeenCalledWith('ws_1', 'prj_1', expect.objectContaining({ platformId: 'DOUYIN', projectVersionId: 'pv_1', outputAssetId: 'ast_video', title: '真实作品' })));
    expect(screen.getByText(/平台发布仍需由你完成/)).toBeTruthy();
  });

  it('does not expose an expired export link', async () => {
    const exportPackage = vi.fn().mockResolvedValue({
      renderId: 'rnd_1', projectEditedSinceApproval: false,
      entries: [{ kind: 'VIDEO', mimeType: 'video/mp4', download: { url: 'https://storage.local/expired.mp4', expiresAt: '2020-01-01T00:00:00.000Z' } }],
    });
    const { client } = clientForPublish(true, exportPackage);
    renderWithClient(<DeliveryPublish workspaceId="ws_1" projectId="prj_1" />, client);
    const button = await screen.findByRole('button', { name: '获取成片下载链接' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(button);
    expect(await screen.findByText(/VIDEO 下载链接已过期/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /下载 VIDEO/ })).toBeNull();
    expect(exportPackage).toHaveBeenCalledWith('ws_1', 'rnd_1');
  });

  it('queries uncertain publication results without resending', async () => {
    const { client, reconcile } = clientForPublish(true);
    client.publications.list = vi.fn().mockResolvedValue({ items: [{ id: 'pub_1', platformId: 'YOUTUBE', title: '真实作品', state: 'PUBLISHING', remoteUrl: null }] });
    renderWithClient(<DeliveryPublish workspaceId="ws_1" projectId="prj_1" />, client);
    await userEvent.click(await screen.findByRole('button', { name: '查询平台状态' }));
    await waitFor(() => expect(reconcile).toHaveBeenCalledWith('ws_1', 'prj_1', 'pub_1'));
    expect(screen.getByText(/已重新查询平台状态/)).toBeTruthy();
  });

  it('creates a bounded handoff for an approved video and can revoke it', async () => {
    const { client, createHandoff, cancelHandoff } = clientForPublish(true);
    renderWithClient(<DeliveryPublish workspaceId="ws_1" projectId="prj_1" />, client);
    const createButton = await screen.findByRole('button', { name: '创建 24 小时交接记录' });
    await waitFor(() => expect((createButton as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(createButton);
    await waitFor(() => expect(createHandoff).toHaveBeenCalledWith('ws_1', 'prj_1', { artifactIds: ['ast_video'], targetPlatform: null, ttlSeconds: 86_400 }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    expect(await screen.findByText('hdf_1')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '撤销交接' }));
    await waitFor(() => expect(cancelHandoff).toHaveBeenCalledWith('ws_1', 'prj_1', 'hdf_1'));
    expect(screen.getByText('已撤销')).toBeTruthy();
  });
});
