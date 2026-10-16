import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaidGenerationFailure, type GenerationOffer } from '@ancs/contracts';
import { createRunwayAleph } from '@ancs/providers-runway';
import type { GenerationProviderInput } from './paid-generation.js';
import { createRunwayRegionProvider } from './runway-media.js';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';

/**
 * Runway 选区重绘经共用托管视频供应商的协议契约测试（**本地替身服务**，按 Runway 公开接口形状回应；不是真实服务验证）：
 * 被重绘的原片压成小体积（去声音）以 data URI 提交、比例按画布取最接近一档、成片下载不带密钥并统一到画布与帧率；
 * 原片太大 / 不是选区重绘 = 不提交、不扣费；内容审核拦下 = 不扣费并带任务 id。
 */

const KEY = 'key_test_00000000000000000000000000'; // secrets:check-ignore: test-only dummy
let workRoot: string;
let api: Server;
let storage: Server;
let base: string;
let storageBase: string;
let outputMp4: Buffer;
let sourcePath: string;
interface Recorded { method: string; path: string; headers: IncomingMessage['headers']; body: string }
let requests: Recorded[] = [];
let storageRequests: Recorded[] = [];
let behavior: 'ok' | 'safety' = 'ok';
const probe = createFfmpegSourceMediaProbe({ timeoutMs: 60_000 });

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
};

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'ancs-runway-media-'));
  sourcePath = join(workRoot, 'source.mp4');
  // 被重绘的原片：执行器已适配到生成画布（这里 1920×1080，带声音）
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=400:duration=2', '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', sourcePath]);
  const out = join(workRoot, 'runway-out.mp4');
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptehdbars=size=1280x720:rate=24:duration=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', out]);
  outputMp4 = await readFile(out);
  storage = createServer((request, response) => {
    storageRequests.push({ method: request.method ?? '', path: request.url ?? '', headers: request.headers, body: '' });
    response.writeHead(200, { 'content-type': 'video/mp4' });
    response.end(outputMp4);
  });
  storageBase = await listen(storage);
  let polls = 0;
  api = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '/';
      requests.push({ method: request.method ?? '', path, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: 'Invalid API key' });
      if (request.method === 'POST' && path === '/v1/video_to_video') { polls = 0; return json(200, { id: 'task-1' }); }
      if (path === '/v1/tasks/task-1') {
        polls += 1;
        if (polls < 2) return json(200, { id: 'task-1', status: 'RUNNING' });
        if (behavior === 'safety') return json(200, { id: 'task-1', status: 'FAILED', failure: 'flagged by moderation', failureCode: 'SAFETY.INPUT.VIDEO' });
        return json(200, { id: 'task-1', status: 'SUCCEEDED', output: [`${storageBase}/out/task-1.mp4?sig=s`] });
      }
      return json(404, { error: `not found ${path}` });
    });
  });
  base = await listen(api);
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await new Promise<void>((resolve) => storage.close(() => resolve()));
  await rm(workRoot, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  storageRequests = [];
  behavior = 'ok';
});

const offer: GenerationOffer = { kind: 'VIDEO_REGION', providerId: 'runway', implementation: 'REAL', model: 'gen4_aleph', perSecondMicros: { min: 150_000, max: 150_000 }, maxSeconds: 5, languages: [] };
const provider = (maxSourceBytes?: number) => createRunwayRegionProvider({
  aleph: createRunwayAleph({ apiKey: KEY, model: offer.model, baseUrl: `${base}/v1` }), offer, pollIntervalMs: 1, wait: () => Promise.resolve(), ...(maxSourceBytes === undefined ? {} : { maxSourceBytes }),
});
const input = (name: string, overrides: Partial<GenerationProviderInput> = {}): GenerationProviderInput => ({
  kind: 'VIDEO_REGION', providerId: 'runway', prompt: 'turn the sky into a warm sunset', script: null, language: null, seconds: 2, maxSeconds: 2,
  width: 1920, height: 1080, fps: 30, outputPath: join(workRoot, name), likenessPath: null, voicePath: null, sourcePath, region: { x: 0.5, y: 0, width: 0.5, height: 0.4 }, ...overrides,
});

describe('Runway 选区重绘', () => {
  it('原片压成小体积（长边 ≤ 1280、无声）以 data URI 提交；比例 1280:720；成片下载不带密钥并统一到 1920×1080 / 30 fps', { timeout: 120_000 }, async () => {
    const result = await provider().generate(input('ok.mp4'));
    expect(result).toEqual({ providerJobId: 'task-1', costMicros: null, model: 'gen4_aleph' });
    const submitted = JSON.parse(requests[0]!.body) as { model: string; videoUri: string; promptText: string; ratio: string };
    expect(submitted).toMatchObject({ model: 'gen4_aleph', promptText: 'turn the sky into a warm sunset', ratio: '1280:720' });
    expect(submitted.videoUri.startsWith('data:video/mp4;base64,')).toBe(true);
    const uploaded = join(workRoot, 'uploaded.mp4');
    await writeFile(uploaded, Buffer.from(submitted.videoUri.slice('data:video/mp4;base64,'.length), 'base64'));
    const sent = await probe.probe({ filePath: uploaded, declaredMimeType: 'video/mp4' });
    expect(sent.streams.find((item) => item.type === 'VIDEO')).toMatchObject({ width: 1280, height: 720 });
    expect(sent.streams.some((item) => item.type === 'AUDIO')).toBe(false);
    expect(storageRequests[0]!.headers.authorization).toBeUndefined();
    const probed = await probe.probe({ filePath: join(workRoot, 'ok.mp4'), declaredMimeType: 'video/mp4' });
    expect(probed.streams.find((item) => item.type === 'VIDEO')).toMatchObject({ width: 1920, height: 1080, averageFrameRate: { numerator: 30, denominator: 1 } });
  });

  it('原片压缩后仍超过上限 / 不是选区重绘 / 没有原片 = 不提交、不扣费；内容审核拦下 = 不扣费并带任务 id', { timeout: 120_000 }, async () => {
    const tooLarge = await provider(1_000).generate(input('big.mp4')).catch((error: unknown) => error);
    expect(tooLarge).toBeInstanceOf(PaidGenerationFailure);
    expect(tooLarge).toMatchObject({ outcome: 'NOT_CHARGED' });
    expect(String((tooLarge as Error).message)).toContain('over the 0 MB limit');
    await expect(provider().generate(input('shot.mp4', { kind: 'VIDEO_SHOT' }))).rejects.toMatchObject({ outcome: 'NOT_CHARGED' });
    await expect(provider().generate(input('none.mp4', { sourcePath: null }))).rejects.toMatchObject({ outcome: 'NOT_CHARGED' });
    expect(requests).toHaveLength(0);

    behavior = 'safety';
    const blocked = await provider().generate(input('s.mp4')).catch((error: unknown) => error);
    expect(blocked).toMatchObject({ outcome: 'NOT_CHARGED', providerJobId: 'task-1', message: 'Runway returned no video (SAFETY.INPUT.VIDEO: flagged by moderation)' });
    expect(String((blocked as Error).message)).not.toContain(KEY);
  });
});
