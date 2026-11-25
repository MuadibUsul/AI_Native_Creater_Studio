import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDecimalSecondsText } from '@ancs/contracts';
import { DESKTOP_GPU_CODECS, desktopVideoEncoderArgs, probeDesktopGpu, type DesktopGpuBackend, type DesktopGpuInfo, type DesktopGpuPreference } from './gpu.js';
import { LocalMediaRegistry, type LocalMediaRecord } from './registry.js';

/**
 * Kinora 桌面端本地 GPU 媒体引擎（127.0.0.1 环回服务）：
 * - 每次启动生成 256-bit 随机 Bearer 令牌（timingSafeEqual 校验）+ 严格 Origin 白名单；
 * - 仅服务经原生对话框注册到 LocalMediaRegistry 的本地素材（杜绝任意路径读取）；
 * - 零上传本地 Range 流式播放、本地 512px 抽帧、本地 16kHz 轻量音轨提取、本地 GPU 代理转码与导出。
 */

export interface LocalMediaEngineOptions {
  /** 允许调用的 Web 来源（如 https://darely.xyz, http://localhost:3000） */
  allowedOrigins: readonly string[];
  ffmpegPath?: string;
  ffprobePath?: string;
  hwaccel?: DesktopGpuPreference;
  /** 监听端口（缺省 0 = 系统分配随机可用端口） */
  port?: number;
  /** 本地导出与代理缓存根目录 */
  workRoot?: string;
  /** 覆盖随机令牌（仅测试用） */
  token?: string;
  registry?: LocalMediaRegistry;
  gpuInfo?: DesktopGpuInfo;
}

export interface LocalMediaEngine {
  readonly baseUrl: string;
  readonly port: number;
  readonly token: string;
  readonly gpu: DesktopGpuInfo;
  readonly registry: LocalMediaRegistry;
  close(): Promise<void>;
}

function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return 'unsatisfiable';
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return null;
  return { start, end };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > maxBytes) throw new Error('request body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON body must be an object');
  }
  return parsed as Record<string, unknown>;
}

async function runFfmpegBuffer(ffmpegPath: string, args: string[], timeoutMs = 60_000, maxBytes = 4 * 1024 * 1024): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      rejectPromise(new Error(message));
    };
    const timer = setTimeout(() => fail('ffmpeg timed out'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) fail('ffmpeg output exceeded limit');
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString('utf8'); });
    child.on('error', () => fail('ffmpeg could not be started'));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export async function startLocalMediaEngine(options: LocalMediaEngineOptions): Promise<LocalMediaEngine> {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  const token = options.token ?? randomBytes(32).toString('hex');
  const allowedOrigins = new Set(options.allowedOrigins.map((origin) => origin.replace(/\/+$/, '').toLowerCase()));
  const registry = options.registry ?? new LocalMediaRegistry({ ffprobePath });
  const workRoot = resolve(options.workRoot ?? join(tmpdir(), 'kinora-desktop-cache'));
  await mkdir(workRoot, { recursive: true });
  const gpu = options.gpuInfo ?? await probeDesktopGpu({ ffmpegPath, preference: options.hwaccel ?? 'auto' });

  const serializeRecord = (record: LocalMediaRecord, baseUrl: string) => ({
    localId: record.localId,
    fileName: record.fileName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    fingerprint: record.fingerprint,
    durationMs: record.durationMs,
    videoDurationMs: record.videoDurationMs,
    width: record.width,
    height: record.height,
    fps: record.fps,
    hasVideo: record.hasVideo,
    hasAudio: record.hasAudio,
    registeredAt: record.registeredAt,
    streamUrl: `${baseUrl}/media/${encodeURIComponent(record.localId)}?token=${encodeURIComponent(token)}`,
  });

  let boundBaseUrl = '';

  const server: Server = createServer(async (req, res) => {
    try {
      const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.replace(/\/+$/, '').toLowerCase() : null;
      if (originHeader !== null) {
        if (!allowedOrigins.has(originHeader)) {
          sendJson(res, 403, { error: 'origin not allowed' });
          return;
        }
        res.setHeader('access-control-allow-origin', originHeader);
        res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('access-control-allow-headers', 'authorization, content-type, range');
        res.setHeader('access-control-expose-headers', 'content-range, accept-ranges, content-length');
        res.setHeader('vary', 'Origin');
      }
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('cache-control', 'no-store');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const queryToken = url.searchParams.get('token') ?? '';
      // HTML5 <video> 无法携带自定义 Authorization 头，仅 GET /media/:id 允许 query token
      const isStreamGet = req.method === 'GET' && /^\/media\/[^/]+$/.test(url.pathname);
      const presented = bearerToken || (isStreamGet ? queryToken : '');
      if (!presented || !constantTimeEquals(presented, token)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { status: 'ok', gpu, mediaCount: registry.list().length });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/media') {
        sendJson(res, 200, { items: registry.list().map((r) => serializeRecord(r, boundBaseUrl)) });
        return;
      }

      const streamMatch = /^\/media\/([^/]+)$/.exec(url.pathname);
      if (streamMatch !== null && req.method === 'GET') {
        const localId = decodeURIComponent(streamMatch[1]!);
        const record = registry.get(localId);
        if (record === undefined) { sendJson(res, 404, { error: 'local media not found' }); return; }
        let fileSize: number;
        try {
          const info = await stat(record.filePath);
          if (!info.isFile()) { sendJson(res, 404, { error: 'file unavailable' }); return; }
          fileSize = info.size;
        } catch {
          sendJson(res, 404, { error: 'file missing on disk (relink required)' });
          return;
        }
        const range = parseByteRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, fileSize);
        if (range === 'unsatisfiable') {
          res.writeHead(416, { 'content-range': `bytes */${String(fileSize)}` });
          res.end();
          return;
        }
        if (range !== null) {
          res.writeHead(206, {
            'content-type': record.mimeType,
            'accept-ranges': 'bytes',
            'content-range': `bytes ${String(range.start)}-${String(range.end)}/${String(fileSize)}`,
            'content-length': String(range.end - range.start + 1),
          });
          createReadStream(record.filePath, { start: range.start, end: range.end }).pipe(res);
          return;
        }
        res.writeHead(200, {
          'content-type': record.mimeType,
          'accept-ranges': 'bytes',
          'content-length': String(fileSize),
        });
        createReadStream(record.filePath).pipe(res);
        return;
      }

      const framesMatch = /^\/media\/([^/]+)\/frames$/.exec(url.pathname);
      if (framesMatch !== null && req.method === 'POST') {
        const localId = decodeURIComponent(framesMatch[1]!);
        const record = registry.get(localId);
        if (record === undefined) { sendJson(res, 404, { error: 'local media not found' }); return; }
        const body = await readJsonBody(req);
        const rawTimes = Array.isArray(body['times']) ? body['times'] : [];
        if (rawTimes.length === 0 || rawTimes.length > 8) {
          sendJson(res, 400, { error: 'times must be an array of 1..8 seconds strings' });
          return;
        }
        const maxWidth = typeof body['maxWidth'] === 'number' && Number.isInteger(body['maxWidth'])
          ? Math.max(64, Math.min(1920, body['maxWidth'])) : 512;
        const maxMs = record.videoDurationMs ?? record.durationMs ?? 0;
        const safeEndSec = maxMs > 100 ? (maxMs - 50) / 1000 : 0;
        const frames: { at: string; mediaType: 'image/jpeg'; data: string }[] = [];
        for (const item of rawTimes) {
          const text = typeof item === 'number' ? item.toFixed(3) : typeof item === 'string' ? item : '';
          if (!isDecimalSecondsText(text)) { sendJson(res, 400, { error: `invalid frame timestamp ${JSON.stringify(item)}` }); return; }
          const clamped = maxMs > 0 ? Math.min(Number(text), safeEndSec).toFixed(3) : '0.000';
          const out = await runFfmpegBuffer(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-protocol_whitelist', 'file,pipe',
            '-ss', clamped, '-i', record.filePath,
            '-frames:v', '1',
            '-vf', `scale='min(${String(maxWidth)},iw)':-2`,
            '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
          ]);
          if (out.code !== 0 || out.stdout.byteLength < 4 || out.stdout[0] !== 0xff || out.stdout[1] !== 0xd8) {
            sendJson(res, 422, { error: `no frame decoded at ${clamped}s` });
            return;
          }
          frames.push({ at: clamped, mediaType: 'image/jpeg', data: out.stdout.toString('base64') });
        }
        sendJson(res, 200, { localId, frames });
        return;
      }

      const proxyMatch = /^\/media\/([^/]+)\/proxy$/.exec(url.pathname);
      if (proxyMatch !== null && req.method === 'POST') {
        const localId = decodeURIComponent(proxyMatch[1]!);
        const record = registry.get(localId);
        if (record === undefined) { sendJson(res, 404, { error: 'local media not found' }); return; }
        const proxyPath = join(workRoot, 'proxies', `${localId}.mp4`);
        await mkdir(dirname(proxyPath), { recursive: true });
        const encode = async (backend: DesktopGpuBackend) => runFfmpegBuffer(ffmpegPath, [
          '-hide_banner', '-v', 'error', '-nostdin', '-y',
          '-protocol_whitelist', 'file,pipe',
          '-i', record.filePath,
          '-map', '0:v:0', '-map', '0:a:0?',
          '-vf', "scale='min(1280,iw)':-2:flags=lanczos",
          ...desktopVideoEncoderArgs(backend, { preset: 'veryfast', crf: 24 }),
          '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
          '-movflags', '+faststart', proxyPath,
        ], 10 * 60_000, 1024 * 1024);
        const started = Date.now();
        let used: DesktopGpuBackend = gpu.backend;
        let fallbackUsed = false;
        let result = await encode(used);
        if (result.code !== 0 && used !== 'cpu') {
          used = 'cpu';
          fallbackUsed = true;
          result = await encode('cpu');
        }
        if (result.code !== 0) {
          sendJson(res, 500, { error: `proxy transcode failed: ${result.stderr.slice(-400)}` });
          return;
        }
        const proxyRecord = await registry.registerFile(proxyPath);
        sendJson(res, 200, {
          proxy: serializeRecord(proxyRecord, boundBaseUrl),
          videoEncoder: DESKTOP_GPU_CODECS[used],
          fallbackUsed,
          elapsedMs: Date.now() - started,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/export') {
        const body = await readJsonBody(req);
        const localId = typeof body['localId'] === 'string' ? body['localId'] : '';
        const outputPath = typeof body['outputPath'] === 'string' ? resolve(body['outputPath']) : '';
        const preset = body['preset'] === 'veryfast' ? 'veryfast' : 'medium';
        const crf = typeof body['crf'] === 'number' && Number.isFinite(body['crf']) ? body['crf'] : 18;
        const record = registry.get(localId);
        if (record === undefined) { sendJson(res, 404, { error: 'local media not found' }); return; }
        if (outputPath === '' || !outputPath.toLowerCase().endsWith('.mp4')) {
          sendJson(res, 400, { error: 'outputPath must end with .mp4' });
          return;
        }
        await mkdir(dirname(outputPath), { recursive: true });
        const encode = async (backend: DesktopGpuBackend) => runFfmpegBuffer(ffmpegPath, [
          '-hide_banner', '-v', 'error', '-nostdin', '-y',
          '-protocol_whitelist', 'file,pipe',
          '-i', record.filePath,
          ...desktopVideoEncoderArgs(backend, { preset, crf }),
          '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
          '-movflags', '+faststart', outputPath,
        ], 30 * 60_000, 1024 * 1024);
        const started = Date.now();
        let used: DesktopGpuBackend = gpu.backend;
        let fallbackUsed = false;
        let result = await encode(used);
        if (result.code !== 0 && used !== 'cpu') {
          used = 'cpu';
          fallbackUsed = true;
          result = await encode('cpu');
        }
        if (result.code !== 0) {
          sendJson(res, 500, { error: `local GPU export failed: ${result.stderr.slice(-400)}` });
          return;
        }
        const outStat = await stat(outputPath);
        sendJson(res, 200, {
          outputPath,
          sizeBytes: outStat.size,
          videoEncoder: DESKTOP_GPU_CODECS[used],
          fallbackUsed,
          elapsedMs: Date.now() - started,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/render-plan') {
        const body = await readJsonBody(req, 4 * 1024 * 1024);
        const outputPath = typeof body['outputPath'] === 'string' ? resolve(body['outputPath']) : '';
        const width = typeof body['width'] === 'number' && Number.isInteger(body['width']) ? Math.max(128, Math.min(3840, body['width'])) : 1920;
        const height = typeof body['height'] === 'number' && Number.isInteger(body['height']) ? Math.max(128, Math.min(2160, body['height'])) : 1080;
        const fps = typeof body['fps'] === 'number' && Number.isFinite(body['fps']) ? Math.max(1, Math.min(120, Math.round(body['fps']))) : 30;
        const preset = body['preset'] === 'veryfast' ? 'veryfast' : 'medium';
        const crf = typeof body['crf'] === 'number' && Number.isFinite(body['crf']) ? body['crf'] : 18;
        const rawSegments = Array.isArray(body['segments']) ? body['segments'] : [];
        if (outputPath === '' || !outputPath.toLowerCase().endsWith('.mp4')) {
          sendJson(res, 400, { error: 'outputPath must end with .mp4' });
          return;
        }
        if (rawSegments.length === 0 || rawSegments.length > 200) {
          sendJson(res, 400, { error: 'segments must be an array of 1..200 clips' });
          return;
        }
        const inputs: string[] = [];
        const filters: string[] = [];
        const concatInputs: string[] = [];
        for (let i = 0; i < rawSegments.length; i += 1) {
          const seg = rawSegments[i] as Record<string, unknown>;
          const localId = typeof seg['localId'] === 'string' ? seg['localId'] : '';
          const startSec = typeof seg['startSeconds'] === 'number' && Number.isFinite(seg['startSeconds']) && seg['startSeconds'] >= 0 ? seg['startSeconds'] : 0;
          const endSec = typeof seg['endSeconds'] === 'number' && Number.isFinite(seg['endSeconds']) && seg['endSeconds'] > startSec ? seg['endSeconds'] : null;
          const record = registry.get(localId);
          if (record === undefined) { sendJson(res, 404, { error: `segment ${String(i)} local media not found: ${localId}` }); return; }
          if (endSec === null) { sendJson(res, 400, { error: `segment ${String(i)} endSeconds must be greater than startSeconds` }); return; }
          const dur = (endSec - startSec).toFixed(3);
          inputs.push('-protocol_whitelist', 'file,pipe', '-ss', startSec.toFixed(3), '-t', dur, '-i', record.filePath);
          filters.push(`[${String(i)}:v:0]scale=${String(width)}:${String(height)}:force_original_aspect_ratio=decrease,pad=${String(width)}:${String(height)}:(ow-iw)/2:(oh-ih)/2:black,fps=${String(fps)},setsar=1,format=yuv420p[v${String(i)}]`);
          if (record.hasAudio) {
            filters.push(`[${String(i)}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${dur},asetpts=PTS-STARTPTS[a${String(i)}]`);
          } else {
            filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${dur}[a${String(i)}]`);
          }
          concatInputs.push(`[v${String(i)}][a${String(i)}]`);
        }
        filters.push(`${concatInputs.join('')}concat=n=${String(rawSegments.length)}:v=1:a=1[vout][aout]`);
        await mkdir(dirname(outputPath), { recursive: true });
        const encode = async (backend: DesktopGpuBackend) => runFfmpegBuffer(ffmpegPath, [
          '-hide_banner', '-v', 'error', '-nostdin', '-y',
          ...inputs,
          '-filter_complex', filters.join(';'),
          '-map', '[vout]', '-map', '[aout]',
          ...desktopVideoEncoderArgs(backend, { preset, crf }),
          '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
          '-movflags', '+faststart', outputPath,
        ], 30 * 60_000, 2 * 1024 * 1024);
        const started = Date.now();
        let used: DesktopGpuBackend = gpu.backend;
        let fallbackUsed = false;
        let result = await encode(used);
        if (result.code !== 0 && used !== 'cpu') {
          used = 'cpu';
          fallbackUsed = true;
          result = await encode('cpu');
        }
        if (result.code !== 0) {
          sendJson(res, 500, { error: `local GPU render-plan failed: ${result.stderr.slice(-400)}` });
          return;
        }
        const outStat = await stat(outputPath);
        sendJson(res, 200, {
          outputPath,
          sizeBytes: outStat.size,
          segmentCount: rawSegments.length,
          videoEncoder: DESKTOP_GPU_CODECS[used],
          fallbackUsed,
          elapsedMs: Date.now() - started,
        });
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message.slice(0, 300) : 'internal error' });
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  boundBaseUrl = `http://127.0.0.1:${String(port)}`;

  return {
    baseUrl: boundBaseUrl,
    port,
    token,
    gpu,
    registry,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}
