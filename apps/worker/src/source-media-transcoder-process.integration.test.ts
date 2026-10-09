/**
 * 真实 FFmpeg 转码（N02-03）：**需要系统 ffmpeg/ffprobe**，因此归入 integration 项目
 * （unit 项目的定义是"无外部依赖的快速测试"；CI 的 verify 作业会先安装 ffmpeg）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapProxyPtsToSourcePts, mapSourcePtsToProxyPts } from '@ancs/contracts';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';
import { createFfmpegMediaProxyTranscoder } from './source-media-transcoder-process.js';

const fixtures = resolve('packages/testing/fixtures/media-v04');
let tempDir: string;

beforeAll(async () => { tempDir = await mkdtemp(join(tmpdir(), 'ancs-media-proxy-unit-')); });
afterAll(async () => { await rm(tempDir, { recursive: true, force: true }); });

describe('ffmpeg media proxy transcoder', () => {
  const probe = createFfmpegSourceMediaProbe({ timeoutMs: 30_000 });
  const transcoder = createFfmpegMediaProxyTranscoder({ timeoutMs: 60_000 });

  it('creates a browser proxy and exact start/middle/end VFR PTS mapping', { timeout: 90_000 }, async () => {
    const sourcePath = join(fixtures, 'clip-d-synthetic-vfr.mp4');
    const sourceProbe = await probe.probe({ filePath: sourcePath, declaredMimeType: 'video/mp4' });
    const outputPath = join(tempDir, 'vfr-proxy.mp4');
    const result = await transcoder.transcode({ sourcePath, outputPath, profileKey: 'web-edit-video-720p-v1', sourceProbe });
    expect(result).toMatchObject({ profileKey: 'web-edit-video-720p-v1', mimeType: 'video/mp4', width: 320, height: 180 });
    const mapping = result.timeMappings.find((item) => item.streamType === 'VIDEO');
    expect(mapping).toBeDefined();
    expect(mapping?.anchors.map((anchor) => anchor.position)).toEqual(['START', 'MIDDLE', 'END']);
    for (const anchor of mapping?.anchors ?? []) {
      expect(mapSourcePtsToProxyPts(mapping!, anchor.sourcePts)).toBe(anchor.proxyPts);
      expect(mapProxyPtsToSourcePts(mapping!, anchor.proxyPts)).toBe(anchor.sourcePts);
    }
    expect(mapping?.sourceTimeBase).toEqual({ numerator: 1, denominator: 15_360 });
  });

  it('conforms 5.1 PCM audio to a 48 kHz stereo editing proxy', { timeout: 90_000 }, async () => {
    const sourcePath = join(fixtures, 'multichannel-48k-5.1.wav');
    const sourceProbe = await probe.probe({ filePath: sourcePath, declaredMimeType: 'audio/wav' });
    const result = await transcoder.transcode({ sourcePath, outputPath: join(tempDir, 'audio-proxy.m4a'), profileKey: 'web-edit-audio-48k-stereo-v1', sourceProbe });
    expect(result).toMatchObject({ mimeType: 'audio/mp4', audioSampleRate: 48_000, audioChannels: 2 });
    expect(result.sourceFacts.audioChannelLayout).toBe('5.1');
    expect(result.timeMappings).toHaveLength(1);
    expect(result.timeMappings[0]?.streamType).toBe('AUDIO');
  });
});
