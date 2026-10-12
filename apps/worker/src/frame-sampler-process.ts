import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDecimalSecondsText, type AgentFrameSampler, type AgentImage, type ObjectStorageAdapter } from '@ancs/contracts';
import { MEDIA_CHILD_ENV, childProcessEnv } from './child-env.js';

/**
 * 素材抽帧（V6-1b）：给 AI 导演"看"素材，也给视觉理解分析器取样。
 *
 * - 源文件经对象存储流式物化到 Worker 临时目录（不把数 GiB 原件读进内存），按存储键缓存最近几份；
 * - 每帧一次 FFmpeg 解码：输入先定位（-ss 在 -i 前，按关键帧快速定位后精确解码），缩放到不超过给定宽度，输出 JPEG；
 * - 子进程走环境变量白名单与协议白名单（只允许本地文件与管道），有超时与输出上限。
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

async function run(executable: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: childProcessEnv(process.env, MEDIA_CHILD_ENV), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const fail = (message: string): void => { if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); reject(new Error(message)); };
    const timer = setTimeout(() => fail('frame extraction timed out'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > MAX_FRAME_BYTES) fail('frame output exceeds limit'); else chunks.push(chunk); });
    child.stderr.on('data', () => undefined);
    child.on('error', () => fail('ffmpeg could not be started'));
    child.on('close', (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks) }); });
  });
}

/** 从本地文件取一帧 JPEG（at 为十进制秒文本）。 */
export async function extractJpegFrame(input: { ffmpegPath?: string; sourcePath: string; at: string; maxWidth: number; timeoutMs?: number }): Promise<AgentImage> {
  if (!isDecimalSecondsText(input.at)) throw new Error(`invalid frame time ${JSON.stringify(input.at)}`);
  if (!Number.isInteger(input.maxWidth) || input.maxWidth < 16 || input.maxWidth > 4096) throw new Error('invalid frame width');
  const { code, stdout } = await run(input.ffmpegPath ?? 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-protocol_whitelist', 'file,pipe',
    '-ss', input.at, '-i', input.sourcePath,
    '-frames:v', '1',
    '-vf', `scale='min(${String(input.maxWidth)},iw)':-2`,
    '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
  ], input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // 时间落在最后一帧之后时 FFmpeg 不报错但没有输出：明确失败
  if (code !== 0 || stdout.byteLength < 4 || stdout[0] !== 0xff || stdout[1] !== 0xd8) throw new Error(`no frame decoded at ${input.at}s`);
  return { mediaType: 'image/jpeg', data: stdout.toString('base64') };
}

export interface StorageFrameSamplerOptions {
  storage: ObjectStorageAdapter | undefined;
  ffmpegPath?: string;
  timeoutMs?: number;
  /** 本进程缓存的源文件份数（LRU） */
  maxCachedFiles?: number;
}

export function createStorageFrameSampler(options: StorageFrameSamplerOptions): AgentFrameSampler & { close(): Promise<void> } {
  const cache = new Map<string, Promise<string>>();
  const maxCached = Math.max(1, options.maxCachedFiles ?? 4);
  let directory: Promise<string> | null = null;

  async function localPath(storageKey: string): Promise<string> {
    const storage = options.storage;
    if (storage?.materializeObject === undefined) throw new Error('object storage cannot materialize source files');
    const cached = cache.get(storageKey);
    if (cached !== undefined) {
      cache.delete(storageKey);
      cache.set(storageKey, cached);
      return cached;
    }
    directory ??= mkdtemp(join(tmpdir(), 'ancs-frames-'));
    const path = join(await directory, createHash('sha256').update(storageKey).digest('hex'));
    const pending = storage.materializeObject({ key: storageKey, destinationPath: path }).then(() => path);
    cache.set(storageKey, pending);
    while (cache.size > maxCached) {
      const [oldestKey, oldest] = cache.entries().next().value as [string, Promise<string>];
      cache.delete(oldestKey);
      void oldest.then((file) => rm(file, { force: true })).catch(() => undefined);
    }
    try {
      return await pending;
    } catch (error) {
      cache.delete(storageKey);
      throw error;
    }
  }

  return {
    async sample(input) {
      const sourcePath = await localPath(input.storageKey);
      const images: AgentImage[] = [];
      for (const at of input.times) {
        images.push(await extractJpegFrame({ ...(options.ffmpegPath === undefined ? {} : { ffmpegPath: options.ffmpegPath }), sourcePath, at, maxWidth: input.maxWidth, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }));
      }
      return images;
    },
    async close() {
      cache.clear();
      if (directory !== null) await rm(await directory, { recursive: true, force: true });
      directory = null;
    },
  };
}
