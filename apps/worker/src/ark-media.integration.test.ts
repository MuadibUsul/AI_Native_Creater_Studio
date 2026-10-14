import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaidGenerationFailure, type GenerationOffer } from '@ancs/contracts';
import { createSeedance } from '@ancs/providers-ark';
import { createSeedanceGenerationProvider } from './ark-media.js';
import type { GenerationProviderInput } from './paid-generation.js';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';

/**
 * Seedance 生成镜头经共用托管视频供应商的协议契约测试（**本地替身服务**，按火山方舟公开接口形状回应；不是真实服务验证）：
 * 画面比例按画布取最接近一档、时长按整数秒档位计费、下载成片不带密钥、统一到项目画布与帧率并保留声音；
 * 配额不足 = 不扣费、内容审核拦下 = 不扣费（带任务 id）。
 */

const KEY = 'ark-test-key-00000000000000'; // secrets:check-ignore: test-only dummy
let workRoot: string;
let api: Server;
let storage: Server;
let base: string;
let storageBase: string;
let videoMp4: Buffer;
interface Recorded { method: string; path: string; headers: IncomingMessage['headers']; body: string }
let requests: Recorded[] = [];
let storageRequests: Recorded[] = [];
let behavior: 'ok' | 'quota' | 'blocked' = 'ok';
const probe = createFfmpegSourceMediaProbe({ timeoutMs: 60_000 });

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
};

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'ancs-ark-media-'));
  const file = join(workRoot, 'seedance.mp4');
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1248x704:rate=24:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=5', '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', file]);
  videoMp4 = await readFile(file);
  storage = createServer((request, response) => {
    storageRequests.push({ method: request.method ?? '', path: request.url ?? '', headers: request.headers, body: '' });
    response.writeHead(200, { 'content-type': 'video/mp4' });
    response.end(videoMp4);
  });
  storageBase = await listen(storage);
  let polls = 0;
  api = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    request.on('end', () => {
      const path = request.url ?? '/';
      requests.push({ method: request.method ?? '', path, headers: request.headers, body });
      const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { code: 'AuthenticationError', message: 'invalid key' } });
      if (request.method === 'POST' && path === '/api/v3/contents/generations/tasks') {
        polls = 0;
        if (behavior === 'quota') return json(429, { error: { code: 'QuotaExceeded', message: 'quota exceeded' } });
        return json(200, { id: 'cgt-test-1' });
      }
      if (path === '/api/v3/contents/generations/tasks/cgt-test-1') {
        polls += 1;
        if (polls < 2) return json(200, { id: 'cgt-test-1', status: 'running' });
        if (behavior === 'blocked') return json(200, { id: 'cgt-test-1', status: 'failed', error: { code: 'InputTextSensitiveContentDetected', message: 'sensitive prompt' } });
        return json(200, { id: 'cgt-test-1', status: 'succeeded', content: { video_url: `${storageBase}/tos/cgt-test-1.mp4?X-Tos-Signature=s` }, usage: { completion_tokens: 103_000 } });
      }
      return json(404, { error: { code: 'NotFound', message: path } });
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

const offer: GenerationOffer = { kind: 'VIDEO_SHOT', providerId: 'seedance', implementation: 'REAL', model: 'doubao-seedance-test', perSecondMicros: { min: 100_000, max: 100_000 }, maxSeconds: 10, languages: [], durationOptions: [5, 10] };
const provider = () => createSeedanceGenerationProvider({ seedance: createSeedance({ apiKey: KEY, model: offer.model, baseUrl: `${base}/api/v3` }), offer, pollIntervalMs: 1, wait: () => Promise.resolve() });
const input = (name: string, overrides: Partial<GenerationProviderInput> = {}): GenerationProviderInput => ({
  kind: 'VIDEO_SHOT', providerId: 'seedance', prompt: '清晨的山间湖面，薄雾，缓慢推进', script: null, language: null, seconds: 3, maxSeconds: 5,
  width: 1080, height: 1350, fps: 30, outputPath: join(workRoot, name), likenessPath: null, voicePath: null, sourcePath: null, region: null, ...overrides,
});

describe('Seedance 生成镜头', () => {
  it('3 秒的镜头按 5 秒档位提交、4:5 画布取 3:4；下载不带密钥；统一到项目画布与帧率并保留声音', { timeout: 120_000 }, async () => {
    const result = await provider().generate(input('ok.mp4'));
    expect(result).toEqual({ providerJobId: 'cgt-test-1', costMicros: null, model: 'doubao-seedance-test' });
    expect(JSON.parse(requests[0]!.body)).toEqual({ model: 'doubao-seedance-test', content: [{ type: 'text', text: '清晨的山间湖面，薄雾，缓慢推进' }], ratio: '3:4', duration: 5, generate_audio: true, watermark: false });
    expect(storageRequests).toHaveLength(1);
    expect(storageRequests[0]!.headers.authorization).toBeUndefined();
    const probed = await probe.probe({ filePath: join(workRoot, 'ok.mp4'), declaredMimeType: 'video/mp4' });
    expect(probed.streams.find((item) => item.type === 'VIDEO')).toMatchObject({ width: 1080, height: 1350, averageFrameRate: { numerator: 30, denominator: 1 } });
    expect(probed.streams.some((item) => item.type === 'AUDIO')).toBe(true);
  });

  it('配额不足 = 不扣费（不轮询）；内容审核拦下 = 不扣费并带任务 id；错误信息不含密钥', { timeout: 60_000 }, async () => {
    behavior = 'quota';
    const quota = await provider().generate(input('q.mp4')).catch((error: unknown) => error);
    expect(quota).toBeInstanceOf(PaidGenerationFailure);
    expect(quota).toMatchObject({ outcome: 'NOT_CHARGED', message: 'Seedance request failed: QuotaExceeded: quota exceeded' });
    expect(requests).toHaveLength(1);
    behavior = 'blocked';
    const blocked = await provider().generate(input('b.mp4')).catch((error: unknown) => error);
    expect(blocked).toMatchObject({ outcome: 'NOT_CHARGED', providerJobId: 'cgt-test-1', message: 'Seedance returned no video (InputTextSensitiveContentDetected: sensitive prompt)' });
    expect(String((blocked as Error).message)).not.toContain(KEY);
  });
});
