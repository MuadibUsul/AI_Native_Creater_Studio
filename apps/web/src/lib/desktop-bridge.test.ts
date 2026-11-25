import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportLocalWithGpu, getDesktopBridge, isDesktopApp, sampleLocalFrames, type DesktopEngineInfo } from './desktop-bridge';

const ENGINE: DesktopEngineInfo = {
  baseUrl: 'http://127.0.0.1:49123',
  token: 'test-token-placeholder', // secrets:check-ignore：单测假令牌
  gpu: { backend: 'nvenc', codec: 'h264_nvenc', hardwareAccelerated: true, probeMs: 120 },
};

describe('desktop-bridge', () => {
  afterEach(() => {
    delete window.kinoraDesktop;
    vi.restoreAllMocks();
  });

  it('returns null in standard browsers and detects window.kinoraDesktop in Electron', () => {
    expect(isDesktopApp()).toBe(false);
    expect(getDesktopBridge()).toBeNull();
    window.kinoraDesktop = {
      platform: 'win32',
      getEngineInfo: async () => ENGINE,
      pickMediaFiles: async () => [],
      relinkMediaFile: async () => null,
      pickExportPath: async () => null,
      revealInFolder: async () => undefined,
    };
    expect(isDesktopApp()).toBe(true);
    expect(getDesktopBridge()?.platform).toBe('win32');
  });

  it('calls local GPU engine with Bearer token for frame sampling and local export', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/frames')) {
        return new Response(JSON.stringify({ frames: [{ at: '1.000', mediaType: 'image/jpeg', data: 'YQ==' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ outputPath: 'C:/out.mp4', sizeBytes: 1024, videoEncoder: 'h264_nvenc', fallbackUsed: false, elapsedMs: 800 }), { status: 200 });
    });

    const frames = await sampleLocalFrames(ENGINE, { localId: 'lmed_1', times: ['1.000'] });
    expect(frames).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:49123/media/lmed_1/frames', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer test-token-placeholder' }),
    }));

    const exported = await exportLocalWithGpu(ENGINE, { localId: 'lmed_1', outputPath: 'C:/out.mp4' });
    expect(exported.videoEncoder).toBe('h264_nvenc');
    expect(exported.fallbackUsed).toBe(false);
  });
});
