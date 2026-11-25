import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

/**
 * 本地零上传素材注册表：
 * - 只登记用户通过原生文件对话框明确授权的本地路径（杜绝网页任意文件读取）；
 * - 用"文件大小 + 首尾 64 KiB 哈希"做毫秒级快速指纹（不读完 20 GB 原片），支持移动文件夹后的快速 Relink；
 * - 经 ffprobe 探测时长、分辨率、帧率与音视频流，直接返回给云端工程元数据。
 */

export interface LocalMediaRecord {
  localId: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  fingerprint: string;
  durationMs: number | null;
  videoDurationMs: number | null;
  width: number | null;
  height: number | null;
  fps: { num: number; den: number } | null;
  hasVideo: boolean;
  hasAudio: boolean;
  registeredAt: string;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const FINGERPRINT_SLICE_BYTES = 64 * 1024;

export async function fastFileFingerprint(filePath: string): Promise<{ sizeBytes: number; fingerprint: string }> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error('selected path is not a file');
  const sizeBytes = info.size;
  const hash = createHash('sha256');
  hash.update(String(sizeBytes));
  hash.update('\0');
  const handle = await open(filePath, 'r');
  try {
    const headLen = Math.min(sizeBytes, FINGERPRINT_SLICE_BYTES);
    if (headLen > 0) {
      const head = Buffer.alloc(headLen);
      await handle.read(head, 0, headLen, 0);
      hash.update(head);
    }
    if (sizeBytes > FINGERPRINT_SLICE_BYTES) {
      const tailLen = Math.min(sizeBytes - headLen, FINGERPRINT_SLICE_BYTES);
      const tail = Buffer.alloc(tailLen);
      await handle.read(tail, 0, tailLen, sizeBytes - tailLen);
      hash.update(tail);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { sizeBytes, fingerprint: hash.digest('hex') };
}

function parseRational(value: unknown): { num: number; den: number } | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (match === null) return null;
  const num = Number(match[1]);
  const den = Number(match[2]);
  return num > 0 && den > 0 ? { num, den } : null;
}

function parseDurationMs(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
}

export interface ProbedMediaSummary {
  durationMs: number | null;
  videoDurationMs: number | null;
  width: number | null;
  height: number | null;
  fps: { num: number; den: number } | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

async function runFfprobe(ffprobePath: string, filePath: string, timeoutMs = 15_000): Promise<ProbedMediaSummary> {
  const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(ffprobePath, [
      '-v', 'error',
      '-protocol_whitelist', 'file,pipe',
      '-print_format', 'json',
      '-show_format', '-show_streams',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let settled = false;
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err !== null) rejectPromise(err);
      else resolvePromise(out);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('ffprobe timed out')); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { if (out.length < 2_000_000) out += chunk.toString('utf8'); });
    child.stderr.on('data', () => undefined);
    child.on('error', () => finish(new Error('ffprobe could not be started')));
    child.on('close', (code) => finish(code === 0 ? null : new Error(`ffprobe exited with ${String(code)}`)));
  });
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: unknown };
    streams?: { codec_type?: unknown; duration?: unknown; width?: unknown; height?: unknown; r_frame_rate?: unknown; avg_frame_rate?: unknown }[];
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const durationMs = parseDurationMs(parsed.format?.duration);
  const videoDurationMs = parseDurationMs(video?.duration) ?? durationMs;
  return {
    durationMs,
    videoDurationMs,
    width: typeof video?.width === 'number' && video.width > 0 ? video.width : null,
    height: typeof video?.height === 'number' && video.height > 0 ? video.height : null,
    fps: parseRational(video?.r_frame_rate) ?? parseRational(video?.avg_frame_rate),
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
  };
}

export class LocalMediaRegistry {
  private readonly byId = new Map<string, LocalMediaRecord>();
  private readonly byPath = new Map<string, string>();
  private readonly ffprobePath: string;
  private readonly probeFn: (filePath: string) => Promise<ProbedMediaSummary>;

  constructor(options: { ffprobePath?: string; probeFn?: (filePath: string) => Promise<ProbedMediaSummary> } = {}) {
    this.ffprobePath = options.ffprobePath ?? 'ffprobe';
    this.probeFn = options.probeFn ?? ((filePath) => runFfprobe(this.ffprobePath, filePath));
  }

  async registerFile(rawPath: string): Promise<LocalMediaRecord> {
    const filePath = resolve(rawPath);
    const existingId = this.byPath.get(filePath);
    const { sizeBytes, fingerprint } = await fastFileFingerprint(filePath);
    if (existingId !== undefined) {
      const existing = this.byId.get(existingId);
      if (existing !== undefined && existing.fingerprint === fingerprint) return existing;
    }
    const mimeType = MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const summary = await this.probeFn(filePath).catch((): ProbedMediaSummary => ({
      durationMs: null, videoDurationMs: null, width: null, height: null, fps: null, hasVideo: mimeType.startsWith('video/'), hasAudio: mimeType.startsWith('audio/'),
    }));
    const localId = existingId ?? `lmed_${randomUUID()}`;
    const record: LocalMediaRecord = {
      localId,
      filePath,
      fileName: basename(filePath),
      mimeType,
      sizeBytes,
      fingerprint,
      ...summary,
      registeredAt: new Date().toISOString(),
    };
    this.byId.set(localId, record);
    this.byPath.set(filePath, localId);
    return record;
  }

  /** Relink：素材文件夹移动后，用新路径重新绑定已有的 localId（校验快速指纹匹配）。 */
  async relink(localId: string, newRawPath: string): Promise<LocalMediaRecord> {
    const existing = this.byId.get(localId);
    if (existing === undefined) throw new Error(`local media ${localId} not found`);
    const filePath = resolve(newRawPath);
    const { sizeBytes, fingerprint } = await fastFileFingerprint(filePath);
    if (fingerprint !== existing.fingerprint) {
      throw new Error('relink fingerprint mismatch: selected file differs from original media');
    }
    this.byPath.delete(existing.filePath);
    const updated: LocalMediaRecord = { ...existing, filePath, fileName: basename(filePath), sizeBytes };
    this.byId.set(localId, updated);
    this.byPath.set(filePath, localId);
    return updated;
  }

  get(localId: string): LocalMediaRecord | undefined {
    return this.byId.get(localId);
  }

  list(): LocalMediaRecord[] {
    return [...this.byId.values()];
  }

  remove(localId: string): boolean {
    const existing = this.byId.get(localId);
    if (existing === undefined) return false;
    this.byPath.delete(existing.filePath);
    return this.byId.delete(localId);
  }
}
