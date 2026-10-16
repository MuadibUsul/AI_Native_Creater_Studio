/**
 * 真实 FFmpeg 索引（N02-04）：**需要系统 ffmpeg/ffprobe**，因此归入 integration 项目
 * （unit 项目的定义是"无外部依赖的快速测试"；CI 的 verify 作业会先安装 ffmpeg）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';
import { createFfmpegMediaIndexer } from './source-media-indexer-process.js';

describe('N02-04 ffmpeg media indexer', () => {
  it('creates real thumbnails, waveform peaks, source-time shots and measured quality markers', { timeout: 90_000 }, async () => {
    const sourcePath = resolve('packages/testing/fixtures/media-v04/clip-a-24000-1001.mp4');
    const work = await mkdtemp(join(tmpdir(), 'ancs-indexer-test-'));
    try {
      const probe = await createFfmpegSourceMediaProbe({ timeoutMs: 30_000 }).probe({ filePath: sourcePath, declaredMimeType: 'video/mp4' });
      const result = await createFfmpegMediaIndexer({ timeoutMs: 60_000 }).index({ sourcePath, outputDirectory: work, sourceProbe: probe });
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.entries.some((entry) => entry.kind === 'THUMBNAIL' && entry.localFilename?.endsWith('.jpg') === true)).toBe(true);
      expect(result.entries.some((entry) => entry.kind === 'WAVEFORM' && Array.isArray(entry.payload['peaks']))).toBe(true);
      const shot = result.entries.find((entry) => entry.kind === 'SHOT');
      expect(shot).toMatchObject({ sourceStartPts: expect.stringMatching(/^-?\d+$/), confidencePermille: expect.any(Number) });
      expect(BigInt(shot!.sourceEndPts)).toBeGreaterThan(BigInt(shot!.sourceStartPts));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('records measured black-frame and silence ranges without inventing a quality score', { timeout: 90_000 }, async () => {
    const work = await mkdtemp(join(tmpdir(), 'ancs-indexer-quality-'));
    const sourcePath = join(work, 'black-silence.mp4');
    const output = join(work, 'index');
    try {
      await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=25:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath]);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(output);
      const probe = await createFfmpegSourceMediaProbe({ timeoutMs: 30_000 }).probe({ filePath: sourcePath, declaredMimeType: 'video/mp4' });
      const result = await createFfmpegMediaIndexer({ timeoutMs: 60_000 }).index({ sourcePath, outputDirectory: output, sourceProbe: probe });
      expect(result.entries.some((entry) => entry.kind === 'QUALITY' && entry.payload['marker'] === 'BLACK_FRAME')).toBe(true);
      expect(result.entries.some((entry) => entry.kind === 'QUALITY' && entry.payload['marker'] === 'SILENCE')).toBe(true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
  it('waveform peaks follow loudness: a -6 dBFS tone reads about 500, silence reads 0', { timeout: 90_000 }, async () => {
    const work = await mkdtemp(join(tmpdir(), 'ancs-indexer-peaks-'));
    const sourcePath = join(work, 'tone-then-silence.wav');
    try {
      // 1 秒 440 Hz、振幅 0.5（-6 dBFS）的正弦，接 1 秒静音
      await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1', '-filter_complex', '[0]volume=4.0[a];[a][1]concat=n=2:v=0:a=1', sourcePath]);
      const probe = await createFfmpegSourceMediaProbe({ timeoutMs: 30_000 }).probe({ filePath: sourcePath, declaredMimeType: 'audio/wav' });
      const result = await createFfmpegMediaIndexer({ timeoutMs: 60_000 }).index({ sourcePath, outputDirectory: work, sourceProbe: probe });
      const peaks = result.entries.filter((entry) => entry.kind === 'WAVEFORM').sort((a, b) => a.ordinal - b.ordinal).flatMap((entry) => entry.payload['peaks'] as number[]);
      expect(peaks.length).toBeGreaterThanOrEqual(198);
      expect(peaks.length).toBeLessThanOrEqual(202);
      const tone = peaks.slice(5, 95);
      const silence = peaks.slice(105, 195);
      // sine 源默认振幅 1/8，乘 4 后为 0.5：每 10 ms 窗口的峰值都应接近 500
      expect(Math.min(...tone)).toBeGreaterThan(450);
      expect(Math.max(...tone)).toBeLessThan(560);
      expect(Math.max(...silence)).toBe(0);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
