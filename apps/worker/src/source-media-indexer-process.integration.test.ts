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
});
