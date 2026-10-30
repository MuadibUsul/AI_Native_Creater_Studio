import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MEDIA_INDEX_PROCESSOR_VERSION,
  generatedMediaIndexSchema,
  type GeneratedMediaIndexEntry,
  type MediaRational,
  type MediaStreamProbe,
  type SourceMediaIndexer,
} from '@ancs/contracts';
import { MEDIA_CHILD_ENV, childProcessEnv } from './child-env.js';

export interface FfmpegMediaIndexerOptions { ffmpegPath?: string; timeoutMs?: number; maxOutputBytes?: number }
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_OUTPUT_BYTES = 32 * 1024 * 1024;

async function run(input: { executable: string; args: string[]; timeoutMs: number; maxOutputBytes: number }): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, { env: childProcessEnv(process.env, MEDIA_CHILD_ENV), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const fail = (message: string): void => { if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); reject(new Error(message)); };
    const timer = setTimeout(() => fail('媒体索引处理超时'), input.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > input.maxOutputBytes) fail('媒体索引工具输出超过上限'); else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > input.maxOutputBytes) fail('媒体索引工具输出超过上限'); else stderr += chunk.toString('utf8'); });
    child.on('error', () => fail('媒体索引工具无法启动'));
    child.on('close', (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks), stderr }); });
  });
}

/**
 * 波形峰值（每 10 ms 一个值，0–1000 = 该窗口内采样绝对值的最大值）。
 * 流式读取 16 kHz 单声道 PCM 并逐窗口取峰值，不缓存整段音频，所以长素材也不受输出上限影响。
 * （此前直接把音频重采样到 100 Hz 取样本值：重采样的低通会滤掉 50 Hz 以上的声音，读数接近 0，并不是响度。）
 */
const PEAK_SAMPLE_RATE = 16_000;
const PEAK_WINDOW_SAMPLES = PEAK_SAMPLE_RATE / 100;
export async function audioPeakEnvelope(input: { executable: string; sourcePath: string; timeoutMs: number }): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', input.sourcePath, '-map', '0:a:0', '-ac', '1', '-ar', String(PEAK_SAMPLE_RATE), '-f', 's16le', 'pipe:1'], { env: childProcessEnv(process.env, MEDIA_CHILD_ENV), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const peaks: number[] = [];
    let windowPeak = 0;
    let windowCount = 0;
    let carry: Buffer | null = null;
    let stderrBytes = 0;
    let settled = false;
    const fail = (message: string): void => { if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); reject(new Error(message)); };
    const timer = setTimeout(() => fail('媒体索引处理超时'), input.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      const data: Buffer = carry === null ? chunk : Buffer.concat([carry, chunk]);
      const usable = data.byteLength - (data.byteLength % 2);
      for (let offset = 0; offset < usable; offset += 2) {
        const sample = Math.abs(data.readInt16LE(offset));
        if (sample > windowPeak) windowPeak = sample;
        windowCount += 1;
        if (windowCount === PEAK_WINDOW_SAMPLES) { peaks.push(Math.min(1000, Math.round((windowPeak / 32768) * 1000))); windowPeak = 0; windowCount = 0; }
      }
      carry = usable < data.byteLength ? data.subarray(usable) : null;
    });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.byteLength; if (stderrBytes > 64 * 1024) fail('媒体索引工具输出超过上限'); });
    child.on('error', () => fail('媒体索引工具无法启动'));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) { reject(new Error('波形分析失败')); return; }
      if (windowCount > 0) peaks.push(Math.min(1000, Math.round((windowPeak / 32768) * 1000)));
      resolve(peaks);
    });
  });
}

function durationMs(probe: { durationMs: number | null; streams: MediaStreamProbe[] }): number {
  return probe.durationMs ?? probe.streams.reduce((max, stream) => Math.max(max, stream.durationMs ?? 0), 0);
}

function ticksAt(ms: number, stream: MediaStreamProbe): string {
  const base = stream.timeBase ?? { numerator: 1, denominator: 1000 };
  const origin = BigInt(stream.startPts ?? '0');
  return String(origin + (BigInt(Math.max(0, Math.round(ms))) * BigInt(base.denominator) + BigInt(base.numerator * 500)) / BigInt(base.numerator * 1000));
}

function baseOf(stream: MediaStreamProbe): MediaRational { return stream.timeBase ?? { numerator: 1, denominator: 1000 }; }
function clampMs(value: number, total: number): number { return Math.max(0, Math.min(total, Math.round(value))); }

export function createFfmpegMediaIndexer(options: FfmpegMediaIndexerOptions = {}): SourceMediaIndexer {
  const ffmpegPath = options.ffmpegPath ?? process.env['ANCS_FFMPEG_PATH'] ?? 'ffmpeg';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  return {
    kind: 'ffmpeg-source-media-indexer',
    async index(input) {
      const total = durationMs(input.sourceProbe);
      if (total <= 0) return generatedMediaIndexSchema.parse({ schemaVersion: '1.0', processorVersion: MEDIA_INDEX_PROCESSOR_VERSION, durationMs: 0, entries: [] });
      const video = input.sourceProbe.streams.find((stream) => stream.type === 'VIDEO');
      const audio = input.sourceProbe.streams.find((stream) => stream.type === 'AUDIO');
      const entries: GeneratedMediaIndexEntry[] = [];

      if (video) {
        const intervalSeconds = Math.max(2, Math.ceil(total / 100_000));
        const pattern = join(input.outputDirectory, 'thumb-%06d.jpg');
        // 一次解码分三路：缩略图、镜头边界（showinfo 打出 pts_time）、黑场（blackdetect 打出 black_start/black_end）。
        // 此前三遍各解码一次全分辨率原片，30 秒 4K HEVC 要 76 秒；合成一遍 42 秒，三路结果与分开跑逐字节相同。
        const pass = await run({
          executable: ffmpegPath,
          args: [
            '-nostdin', '-hide_banner', '-nostats', '-y', '-protocol_whitelist', 'file,pipe', '-i', input.sourcePath,
            '-filter_complex', `[0:v:0]split=3[t][s][b];[t]fps=1/${String(intervalSeconds)},scale=320:-2:flags=lanczos[thumbs];[s]select='gt(scene,0.3)',showinfo[cuts];[b]blackdetect=d=0.5:pix_th=0.10[black]`,
            '-map', '[thumbs]', '-frames:v', '100', '-q:v', '4', pattern,
            '-map', '[cuts]', '-f', 'null', '-',
            '-map', '[black]', '-f', 'null', '-',
          ],
          timeoutMs,
          maxOutputBytes,
        });
        if (pass.code !== 0) throw new Error('画面索引失败（缩略图、镜头边界、黑场）');
        const names = (await readdir(input.outputDirectory)).filter((name) => /^thumb-\d{6}\.jpg$/.test(name)).sort();
        names.forEach((name, ordinal) => {
          const start = clampMs(ordinal * intervalSeconds * 1000, total);
          const end = clampMs(Math.min(total, start + intervalSeconds * 1000), total);
          entries.push({ kind: 'THUMBNAIL', ordinal, sourceStartPts: ticksAt(start, video), sourceEndPts: ticksAt(end, video), timeBase: baseOf(video), streamId: `video:${String(video.index)}`, confidencePermille: 1000, payload: { sourceStartMs: start, sourceEndMs: end }, localFilename: name });
        });

        const boundaries = [0, ...Array.from(pass.stderr.matchAll(/pts_time:([0-9.]+)/g), (match) => clampMs(Number(match[1]) * 1000, total)), total]
          .filter((value, index, all) => Number.isFinite(value) && (index === 0 || value - all[index - 1]! >= 250));
        for (let ordinal = 0; ordinal < boundaries.length - 1; ordinal += 1) {
          const start = boundaries[ordinal]!;
          const end = boundaries[ordinal + 1]!;
          if (end <= start) continue;
          entries.push({ kind: 'SHOT', ordinal, sourceStartPts: ticksAt(start, video), sourceEndPts: ticksAt(end, video), timeBase: baseOf(video), streamId: `video:${String(video.index)}`, confidencePermille: ordinal === 0 ? 1000 : 700, payload: { sourceStartMs: start, sourceEndMs: end, transitionType: ordinal === 0 ? 'START' : 'CUT', detectionBasis: 'FFMPEG_SCENE_SCORE_GT_0_3', errorMarginMs: 250 }, localFilename: null });
        }
        let qualityOrdinal = 0;
        for (const match of pass.stderr.matchAll(/black_start:([0-9.]+)\s+black_end:([0-9.]+)/g)) {
          const start = clampMs(Number(match[1]) * 1000, total); const end = clampMs(Number(match[2]) * 1000, total);
          entries.push({ kind: 'QUALITY', ordinal: qualityOrdinal++, sourceStartPts: ticksAt(start, video), sourceEndPts: ticksAt(end, video), timeBase: baseOf(video), streamId: `video:${String(video.index)}`, confidencePermille: 900, payload: { sourceStartMs: start, sourceEndMs: end, marker: 'BLACK_FRAME', detectionBasis: 'FFMPEG_BLACKDETECT' }, localFilename: null });
        }
      }

      if (audio) {
        const values = await audioPeakEnvelope({ executable: ffmpegPath, sourcePath: input.sourcePath, timeoutMs });
        const chunkSize = 256;
        for (let offset = 0, ordinal = 0; offset < values.length; offset += chunkSize, ordinal += 1) {
          const peaks = values.slice(offset, Math.min(values.length, offset + chunkSize));
          const start = clampMs(offset * 10, total); const end = clampMs(Math.min(values.length, offset + chunkSize) * 10, total);
          entries.push({ kind: 'WAVEFORM', ordinal, sourceStartPts: ticksAt(start, audio), sourceEndPts: ticksAt(end, audio), timeBase: baseOf(audio), streamId: `audio:${String(audio.index)}`, confidencePermille: 1000, payload: { sourceStartMs: start, sourceEndMs: end, sampleIntervalMs: 10, peaks }, localFilename: null });
        }
        const silence = await run({ executable: ffmpegPath, args: ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file,pipe', '-i', input.sourcePath, '-map', '0:a:0', '-af', 'silencedetect=n=-50dB:d=0.5', '-vn', '-f', 'null', '-'], timeoutMs, maxOutputBytes });
        if (silence.code !== 0) throw new Error('静音检测失败');
        let qualityOrdinal = entries.filter((entry) => entry.kind === 'QUALITY').length;
        for (const match of silence.stderr.matchAll(/silence_start:\s*([0-9.]+)[\s\S]*?silence_end:\s*([0-9.]+)/g)) {
          const start = clampMs(Number(match[1]) * 1000, total); const end = clampMs(Number(match[2]) * 1000, total);
          entries.push({ kind: 'QUALITY', ordinal: qualityOrdinal++, sourceStartPts: ticksAt(start, audio), sourceEndPts: ticksAt(end, audio), timeBase: baseOf(audio), streamId: `audio:${String(audio.index)}`, confidencePermille: 900, payload: { sourceStartMs: start, sourceEndMs: end, marker: 'SILENCE', detectionBasis: 'FFMPEG_SILENCEDETECT' }, localFilename: null });
        }
      }
      return generatedMediaIndexSchema.parse({ schemaVersion: '1.0', processorVersion: MEDIA_INDEX_PROCESSOR_VERSION, durationMs: total, entries });
    },
  };
}
