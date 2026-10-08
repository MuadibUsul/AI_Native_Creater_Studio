import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockClient, renderWithClient, testFile } from '@/test-utils';
import { DeliveryAssets } from './delivery-assets';

describe('Quiet Frame asset flow', () => {
  it('uses the SDK resumable flow for every selected real file without whole-file reads', async () => {
    const uploadResumable = vi.fn().mockImplementation(async (_workspaceId, input, options) => {
      options?.onIntent?.({ intentId: `upi_${input.filename}`, assetId: `ast_${input.filename}` });
      options?.onProgress?.({ uploadedBytes: input.data.size, totalBytes: input.data.size, completedParts: 1, partCount: 1 });
      return { id: `ast_${input.filename}` };
    });
    const client = mockClient({
      assets: { list: vi.fn().mockResolvedValue([]), uploadResumable, cancelUpload: vi.fn() },
      billing: { externalResults: vi.fn().mockResolvedValue([]) },
    });
    renderWithClient(<DeliveryAssets workspaceId="ws_1" projectId="prj_1" />, client);
    await screen.findByText('还没有资产');
    await userEvent.click(screen.getByRole('button', { name: '上传素材' }));
    const files = [testFile('cover.png', 'PNG_DATA', 'image/png'), testFile('clip.mp4', 'VIDEO_DATA', 'video/mp4')];
    await userEvent.upload(screen.getByLabelText('选择文件'), files);
    expect(screen.getByText('已选择 2 个文件')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '开始上传' }));
    await waitFor(() => expect(uploadResumable).toHaveBeenCalledTimes(2));
    expect(uploadResumable).toHaveBeenCalledWith('ws_1', expect.objectContaining({ projectId: 'prj_1', filename: 'cover.png', contentType: 'image/png', assetType: 'SOURCE_IMAGE', data: files[0] }), expect.objectContaining({ concurrency: 3 }));
    expect(uploadResumable).toHaveBeenCalledWith('ws_1', expect.objectContaining({ projectId: 'prj_1', filename: 'clip.mp4', contentType: 'video/mp4', assetType: 'USER_UPLOAD', data: files[1] }), expect.objectContaining({ concurrency: 3 }));
    expect(screen.getAllByText((_text, element) => element?.tagName === 'SPAN' && element.textContent?.includes('已完成') === true)).toHaveLength(2);
  });

  it('loads the workspace library without inventing a project binding', async () => {
    const list = vi.fn().mockResolvedValue([]);
    const client = mockClient({ assets: { list }, billing: { externalResults: vi.fn().mockResolvedValue([]) } });
    renderWithClient(<DeliveryAssets workspaceId="ws_1" />, client);
    await screen.findByText('还没有资产');
    expect(list).toHaveBeenCalledWith('ws_1', undefined);
  });

  it('keeps the project Finance entry reachable while a Finance failure leaves assets visible', async () => {
    const asset = { id: 'ast_image', workspaceId: 'ws_1', projectId: 'prj_1', assetType: 'SOURCE_IMAGE', origin: 'USER_UPLOAD', status: 'READY', metadata: { filename: '图像.png' }, license: { type: 'USER_OWNED' } };
    const listDataSources = vi.fn().mockRejectedValue(new Error('Finance 暂不可用'));
    const client = mockClient({
      assets: { list: vi.fn().mockResolvedValue([asset]) },
      billing: { externalResults: vi.fn().mockResolvedValue([]) },
      finance: { listDataSources, listTemplates: vi.fn().mockResolvedValue({ items: [] }), listArtifacts: vi.fn().mockResolvedValue({ items: [] }) },
    });
    renderWithClient(<DeliveryAssets workspaceId="ws_1" projectId="prj_1" />, client);
    const card = await screen.findByRole('button', { name: '查看素材 图像.png' });
    expect(listDataSources).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Finance 图表素材'));
    expect(await screen.findByText('Finance 图表素材加载失败')).toBeTruthy();
    expect(card.isConnected).toBe(true);
    expect(listDataSources).toHaveBeenCalledWith('ws_1');
  });

  it('renders distinct illustrative previews without presenting them as asset content or chart data', async () => {
    const assets = [
      { id: 'ast_image', assetType: 'SOURCE_IMAGE', metadata: { filename: '图像.png' } },
      { id: 'ast_imageb', assetType: 'SOURCE_IMAGE', metadata: { filename: '图像绿.png' } },
      { id: 'ast_imagec', assetType: 'SOURCE_IMAGE', metadata: { filename: '图像蓝.png' } },
      { id: 'ast_chart', assetType: 'CHART_RENDER', metadata: { filename: '结构图' } },
      { id: 'ast_audio', assetType: 'VOICE_AUDIO', metadata: { filename: '旁白.wav' } },
      { id: 'ast_doc', assetType: 'SOURCE_DOCUMENT', metadata: { filename: '来源.pdf' } },
    ].map((asset) => ({ ...asset, workspaceId: 'ws_1', projectId: 'prj_1', origin: 'USER_UPLOAD', status: 'READY', license: { type: 'USER_OWNED' } }));
    const client = mockClient({ assets: { list: vi.fn().mockResolvedValue(assets) }, billing: { externalResults: vi.fn().mockResolvedValue([]) } });
    renderWithClient(<DeliveryAssets workspaceId="ws_1" projectId="prj_1" />, client);
    const image = await screen.findByRole('button', { name: '查看素材 图像.png' });
    const greenImage = screen.getByRole('button', { name: '查看素材 图像绿.png' });
    const blueImage = screen.getByRole('button', { name: '查看素材 图像蓝.png' });
    const chart = screen.getByRole('button', { name: '查看素材 结构图' });
    const audio = screen.getByRole('button', { name: '查看素材 旁白.wav' });
    const document = screen.getByRole('button', { name: '查看素材 来源.pdf' });
    expect(image.querySelector('.cover-art.art-3')).not.toBeNull();
    expect(greenImage.querySelector('.cover-art.art-1')).not.toBeNull();
    expect(blueImage.querySelector('.cover-art.art-2')).not.toBeNull();
    expect(chart.querySelectorAll('.asset-chart i')).toHaveLength(5);
    expect(audio.querySelectorAll('.asset-sound .wave span')).toHaveLength(32);
    expect(document.querySelectorAll('.asset-doc .document-mini i')).toHaveLength(8);
    expect(chart.textContent).toContain('无数值示意 · 非事实图表');
    expect(image.textContent).toContain('示意 · 非资产原图');
    expect(image.textContent).toContain('用户自有');
    expect(image.querySelector('img')).toBeNull();
  });

  it('plays only the authorized current video version while its signed URL is valid', async () => {
    const asset = { id: 'ast_video', workspaceId: 'ws_1', projectId: 'prj_1', assetType: 'USER_UPLOAD', origin: 'USER_UPLOAD', status: 'READY', metadata: { filename: 'source.mp4' }, license: { type: 'USER_OWNED' } };
    const client = mockClient({
      assets: {
        list: vi.fn().mockResolvedValue([asset]),
        get: vi.fn().mockResolvedValue({ ...asset, currentVersionId: 'av_video', versions: [{ id: 'av_old', mimeType: 'image/png' }, { id: 'av_video', mimeType: 'video/mp4' }] }),
        downloadUrl: vi.fn().mockResolvedValue({ url: 'https://storage.local/signed-source.mp4', expiresAt: '2099-01-01T00:00:00.000Z' }),
      },
      billing: { externalResults: vi.fn().mockResolvedValue([]) },
    });
    renderWithClient(<DeliveryAssets workspaceId="ws_1" projectId="prj_1" />, client);
    await userEvent.click(await screen.findByRole('button', { name: '查看素材 source.mp4' }));
    const video = await screen.findByLabelText('预览视频 source.mp4');
    expect(video.getAttribute('src')).toBe('https://storage.local/signed-source.mp4');
    expect(video.getAttribute('controls')).not.toBeNull();
  });

  it('does not expose an expired signed URL as a playable video', async () => {
    const asset = { id: 'ast_video', workspaceId: 'ws_1', projectId: 'prj_1', assetType: 'USER_UPLOAD', origin: 'USER_UPLOAD', status: 'READY', metadata: { filename: 'source.mp4' }, license: { type: 'USER_OWNED' } };
    const client = mockClient({
      assets: {
        list: vi.fn().mockResolvedValue([asset]),
        get: vi.fn().mockResolvedValue({ ...asset, currentVersionId: 'av_video', versions: [{ id: 'av_video', mimeType: 'video/mp4' }] }),
        downloadUrl: vi.fn().mockResolvedValue({ url: 'https://storage.local/expired.mp4', expiresAt: '2000-01-01T00:00:00.000Z' }),
      },
      billing: { externalResults: vi.fn().mockResolvedValue([]) },
    });
    renderWithClient(<DeliveryAssets workspaceId="ws_1" projectId="prj_1" />, client);
    await userEvent.click(await screen.findByRole('button', { name: '查看素材 source.mp4' }));
    expect(await screen.findByText(/签名下载链接已到期/)).toBeTruthy();
    expect(screen.queryByLabelText('预览视频 source.mp4')).toBeNull();
  });

  it('shows upload, decode, preview and export capability states with a recovery reason', async () => {
    const asset = { id: 'ast_failed', workspaceId: 'ws_1', projectId: 'prj_1', assetType: 'USER_UPLOAD', origin: 'USER_UPLOAD', status: 'FAILED', metadata: { filename: 'damaged.mp4' }, license: { type: 'USER_OWNED' } };
    const mediaProbe = {
      status: 'FAILED',
      streams: [{ index: 0, type: 'VIDEO', codecName: 'h264', width: 1920, height: 1080, averageFrameRate: { numerator: 30000, denominator: 1001 }, cadence: 'UNKNOWN' }],
      capabilities: {
        upload: 'AVAILABLE', decode: 'UNAVAILABLE', preview: 'UNAVAILABLE', export: 'UNAVAILABLE',
        reasons: [{ code: 'DECODE_FAILED', message: '文件无法完整解码。', nextAction: '修复或转封装后重新上传。' }],
      },
    };
    const client = mockClient({
      assets: {
        list: vi.fn().mockResolvedValue([asset]),
        get: vi.fn().mockResolvedValue({ ...asset, currentVersionId: 'av_failed', versions: [{ id: 'av_failed', mimeType: 'video/mp4', probeStatus: 'FAILED', mediaProbe }] }),
        downloadUrl: vi.fn().mockResolvedValue({ url: 'https://storage.local/damaged.mp4', expiresAt: '2099-01-01T00:00:00.000Z' }),
      },
      billing: { externalResults: vi.fn().mockResolvedValue([]) },
    });
    renderWithClient(<DeliveryAssets workspaceId="ws_1" projectId="prj_1" />, client);
    await userEvent.click(await screen.findByRole('button', { name: '查看素材 damaged.mp4' }));
    const capabilityRegion = await screen.findByRole('region', { name: '媒体能力' });
    expect(capabilityRegion.textContent).toContain('上传可直接使用');
    expect(capabilityRegion.textContent).toContain('解码不可用');
    expect(screen.getByText(/修复或转封装后重新上传/)).toBeTruthy();
    expect(screen.queryByLabelText('预览视频 damaged.mp4')).toBeNull();
    expect(screen.getByRole('link', { name: '下载原文件' })).toBeTruthy();
  });

  it('keeps asset dialog keyboard focus inside and restores the selected card on Escape', async () => {
    const asset = { id: 'ast_1', workspaceId: 'ws_1', projectId: 'prj_1', assetType: 'SOURCE_IMAGE', origin: 'USER_UPLOAD', status: 'READY', metadata: { filename: 'cover.png' }, license: { type: 'USER_OWNED' } };
    const client = mockClient({
      assets: {
        list: vi.fn().mockResolvedValue([asset]),
        get: vi.fn().mockResolvedValue({ ...asset, currentVersionId: 'av_1', versions: [{ id: 'av_1', mimeType: 'image/png' }] }),
        downloadUrl: vi.fn().mockResolvedValue({ url: 'https://storage.local/cover.png', expiresAt: '2099-01-01T00:00:00.000Z' }),
      },
      billing: { externalResults: vi.fn().mockResolvedValue([]) },
    });
    renderWithClient(<DeliveryAssets workspaceId="ws_1" projectId="prj_1" />, client);
    const card = await screen.findByRole('button', { name: '查看素材 cover.png' });
    await userEvent.click(card);
    const dialog = screen.getByRole('dialog', { name: 'cover.png' });
    const close = screen.getByRole('button', { name: '关闭' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(close);
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: '前往分镜' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(card);
  });
});
