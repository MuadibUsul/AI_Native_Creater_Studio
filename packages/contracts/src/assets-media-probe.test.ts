import { describe, expect, it } from 'vitest';
import { mediaProbeJobInputSchema, sourceMediaProbeResultSchema } from './assets.js';

describe('source media probe contracts', () => {
  const result = {
    schemaVersion: '1.0' as const,
    status: 'READY' as const,
    formatNames: ['mov', 'mp4'],
    formatLongName: 'QuickTime / MOV',
    startTimeMs: 0,
    durationMs: 4004,
    bitRate: 92_000,
    streams: [{
      index: 0, type: 'VIDEO' as const, codecName: 'h264', codecLongName: 'H.264', profile: 'High',
      timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0', durationTicks: '61440', durationMs: 4000,
      width: 320, height: 180, rotationDegrees: 90, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709',
      colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 },
      averageFrameRate: { numerator: 3600, denominator: 143 }, frameCount: '119', sampleRate: null, channels: null,
      channelLayout: null, cadence: 'VARIABLE' as const, sampledPacketCount: 119, sampledPtsDeltaTicks: ['512', '1024'],
    }],
    decodeCheck: { status: 'PASSED' as const, errorCode: null, message: null },
    capabilities: { upload: 'AVAILABLE' as const, decode: 'AVAILABLE' as const, preview: 'AVAILABLE' as const, export: 'AVAILABLE' as const, reasons: [] },
  };

  it('accepts precise stream timebase, PTS cadence, rotation, color and capability states', () => {
    expect(sourceMediaProbeResultSchema.parse(result)).toEqual(result);
    expect(mediaProbeJobInputSchema.parse({
      assetId: 'ast_1', assetVersionId: 'av_1', storageKey: 'workspaces/ws_1/source.mp4', declaredMimeType: 'video/mp4',
    })).toMatchObject({ assetId: 'ast_1', assetVersionId: 'av_1' });
  });

  it('rejects invalid enum values, fractional stream indexes and non-rational time bases', () => {
    expect(sourceMediaProbeResultSchema.safeParse({ ...result, status: 'DONE' }).success).toBe(false);
    expect(sourceMediaProbeResultSchema.safeParse({ ...result, streams: [{ ...result.streams[0], index: 0.5 }] }).success).toBe(false);
    expect(sourceMediaProbeResultSchema.safeParse({ ...result, streams: [{ ...result.streams[0], timeBase: { numerator: 1, denominator: 0 } }] }).success).toBe(false);
  });
});
