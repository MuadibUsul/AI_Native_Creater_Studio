/**
 * 真实 FFmpeg 探测（N02-02）：**需要系统 ffmpeg/ffprobe**，因此归入 integration 项目
 * （unit 项目的定义是"无外部依赖的快速测试"；CI 的 verify 作业会先安装 ffmpeg）。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';

const fixtures = resolve('packages/testing/fixtures/media-v04');
let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ancs-source-probe-unit-'));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('ffmpeg source media probe', () => {
  const probe = createFfmpegSourceMediaProbe({ timeoutMs: 30_000 });

  it('detects sampled VFR cadence and fractional time bases from real media', { timeout: 30_000 }, async () => {
    const result = await probe.probe({ filePath: join(fixtures, 'clip-d-synthetic-vfr.mp4'), declaredMimeType: 'video/mp4' });
    const video = result.streams.find((stream) => stream.type === 'VIDEO');
    expect(result.status).toBe('READY');
    expect(video?.timeBase).toEqual({ numerator: 1, denominator: 15_360 });
    expect(video?.cadence).toBe('VARIABLE');
    expect(video?.sampledPtsDeltaTicks).toEqual(expect.arrayContaining(['512', '1024']));
    expect(result.decodeCheck.status).toBe('PASSED');
  });

  it('preserves display rotation and reports six-channel audio layout', { timeout: 30_000 }, async () => {
    const rotated = await probe.probe({ filePath: join(fixtures, 'clip-e-rotation-90.mp4'), declaredMimeType: 'video/mp4' });
    expect(rotated.streams.find((stream) => stream.type === 'VIDEO')?.rotationDegrees).toBe(90);
    const multichannel = await probe.probe({ filePath: join(fixtures, 'multichannel-48k-5.1.wav'), declaredMimeType: 'audio/wav' });
    const audio = multichannel.streams.find((stream) => stream.type === 'AUDIO');
    expect(audio).toMatchObject({ codecName: 'pcm_s16le', sampleRate: 48_000, channels: 6, channelLayout: '5.1' });
    expect(multichannel.capabilities.preview).toBe('PROXY_REQUIRED');
  });

  it('does not trust filename extensions and returns a repairable reason for corrupt input', { timeout: 30_000 }, async () => {
    const disguised = join(tempDir, 'audio-disguised-as-video.mp4');
    const wavBytes = await import('node:fs/promises').then(({ readFile }) => readFile(join(fixtures, 'independent-48k-stereo.wav')));
    await writeFile(disguised, wavBytes);
    const recognized = await probe.probe({ filePath: disguised, declaredMimeType: 'video/mp4' });
    expect(recognized.formatNames).toContain('wav');
    expect(recognized.streams.find((stream) => stream.type === 'AUDIO')?.codecName).toBe('pcm_s16le');

    const corrupt = join(tempDir, 'corrupt.mp4');
    await writeFile(corrupt, Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]));
    const failed = await probe.probe({ filePath: corrupt, declaredMimeType: 'video/mp4' });
    expect(failed.status).toBe('FAILED');
    expect(failed.capabilities.decode).toBe('UNAVAILABLE');
    expect(failed.capabilities.reasons[0]?.nextAction).toMatch(/转换|检查/);
    expect(JSON.stringify(failed)).not.toContain(tempDir);
  });
});
