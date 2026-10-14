import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaidGenerationFailure, type GenerationOffer } from '@ancs/contracts';
import { createGeminiSpeech, createGeminiVeo } from '@ancs/providers-gemini';
import { createGeminiNarrationSynthesizer, createVeoGenerationProvider } from './gemini-media.js';
import type { GenerationProviderInput } from './paid-generation.js';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';

/**
 * Gemini TTS + Veo 适配器的协议契约测试（**本地替身服务**，按 Gemini API 公开形状回应；不是真实服务验证）：
 * - 讲述：逐句合成（预置声音名首字母大写）→ 裸 PCM 包成 WAV → FFmpeg 统一格式与语速 → 句界精确；
 * - Veo 生成镜头：按 4/6/8 秒档位提交 → 轮询 → 下载（跳转到存储主机时不带密钥）→ 统一到项目画布与帧率、保留声音；
 *   计费结局：提交 4xx = 不扣费；提交 5xx = 结果不明；任务报错 / 被过滤 = 不扣费；超时 = 结果不明；下载失败 = 已扣费。
 */

const KEY = 'gemini-test-key-0000000000'; // secrets:check-ignore: test-only dummy
let workRoot: string;
let api: Server;
let storage: Server;
let base: string;
let storageBase: string;
let veoMp4: Buffer;
let tonePcm: Buffer;
const probe = createFfmpegSourceMediaProbe({ timeoutMs: 60_000 });

interface Recorded { method: string; path: string; headers: IncomingMessage['headers']; body: string }
let requests: Recorded[] = [];
let storageRequests: Recorded[] = [];
let behavior: { start?: 'ok' | 'reject' | 'server-error'; result?: 'video' | 'error' | 'filtered' | 'never'; download?: 'ok' | 'missing' } = {};

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
};

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'ancs-gemini-media-'));
  const veoFile = join(workRoot, 'veo.mp4');
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=4', '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', veoFile]);
  veoMp4 = await readFile(veoFile);
  // 0.8 秒 24 kHz 单声道 s16le（Gemini TTS 的裸 PCM 形状）
  tonePcm = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=0.8', '-ar', '24000', '-ac', '1', '-f', 's16le', 'pipe:1']);

  storage = createServer((request, response) => {
    storageRequests.push({ method: request.method ?? '', path: request.url ?? '', headers: request.headers, body: '' });
    if (behavior.download === 'missing') { response.writeHead(404); response.end('gone'); return; }
    response.writeHead(200, { 'content-type': 'video/mp4' });
    response.end(veoMp4);
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
      if (request.headers['x-goog-api-key'] !== KEY) return json(403, { error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' } });
      if (path === '/v1beta/models/tts-test:generateContent') {
        return json(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: tonePcm.toString('base64') } }] }, finishReason: 'STOP' }] });
      }
      if (path === '/v1beta/models/veo-test:predictLongRunning') {
        polls = 0;
        if (behavior.start === 'reject') return json(400, { error: { code: 400, message: 'durationSeconds must be one of 4, 6, 8', status: 'INVALID_ARGUMENT' } });
        if (behavior.start === 'server-error') return json(500, { error: { code: 500, message: 'internal', status: 'INTERNAL' } });
        return json(200, { name: 'models/veo-test/operations/op-1' });
      }
      if (path === '/v1beta/models/veo-test/operations/op-1') {
        polls += 1;
        if (behavior.result === 'never' || polls < 2) return json(200, { name: 'op-1', done: false });
        if (behavior.result === 'error') return json(200, { name: 'op-1', done: true, error: { code: 13, message: 'generation failed' } });
        if (behavior.result === 'filtered') return json(200, { name: 'op-1', done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['prompt blocked'] } } });
        return json(200, { name: 'op-1', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${base}/v1beta/files/vid-1:download?alt=media` } }] } } });
      }
      if (path.startsWith('/v1beta/files/vid-1:download')) {
        response.writeHead(302, { location: `${storageBase}/signed/vid-1.mp4` });
        return response.end();
      }
      return json(404, { error: { code: 404, message: `unexpected ${path}` } });
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
  behavior = {};
});

const offer: GenerationOffer = { kind: 'VIDEO_SHOT', providerId: 'veo', implementation: 'REAL', model: 'veo-test', perSecondMicros: { min: 100_000, max: 100_000 }, maxSeconds: 8, languages: [], durationOptions: [4, 6, 8] };
const noWait = () => Promise.resolve();
const input = (name: string, overrides: Partial<GenerationProviderInput> = {}): GenerationProviderInput => ({
  kind: 'VIDEO_SHOT', providerId: 'veo', prompt: 'a calm lake at dawn', script: null, language: null, seconds: 2.5, maxSeconds: 4,
  width: 640, height: 360, fps: 30, outputPath: join(workRoot, name), likenessPath: null, voicePath: null, sourcePath: null, region: null, ...overrides,
});
const provider = (overrides: { renderTimeoutMs?: number } = {}) => createVeoGenerationProvider({
  veo: createGeminiVeo({ apiKey: KEY, model: 'veo-test', baseUrl: `${base}/v1beta` }), offer, pollIntervalMs: 1, wait: noWait, ...overrides,
});
const failure = async (promise: Promise<unknown>): Promise<PaidGenerationFailure> => {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(PaidGenerationFailure);
  expect(String((error as Error).message)).not.toContain(KEY);
  return error as PaidGenerationFailure;
};

describe('Gemini 讲述配音', () => {
  it('逐句合成：预置声音名、裸 PCM → WAV、语速由 FFmpeg 调整、句界精确', { timeout: 60_000 }, async () => {
    const synthesizer = createGeminiNarrationSynthesizer({ speech: createGeminiSpeech({ apiKey: KEY, model: 'tts-test', baseUrl: `${base}/v1beta` }), probe });
    expect(synthesizer.engine).toBe('gemini:tts-test');
    expect(synthesizer.voices().map((voice) => voice.id)).toContain('kore');
    const result = await synthesizer.synthesize({ sentences: ['城市里的树能降温。', 'Trees cool the city.'], voice: 'kore', speed: 1 });
    const synthesis = requests.filter((item) => item.path.endsWith(':generateContent'));
    expect(synthesis).toHaveLength(2);
    expect(JSON.parse(synthesis[0]!.body)).toMatchObject({ contents: [{ parts: [{ text: '城市里的树能降温。' }] }], generationConfig: { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } } });
    expect(result.sentences).toHaveLength(2);
    expect(result.sentences[0]!.endMs).toBeCloseTo(800, -1);
    expect(result.sentences[1]!.startMs).toBeGreaterThan(result.sentences[0]!.endMs);
    expect(result.durationMs).toBeGreaterThan(1_500);

    const faster = await synthesizer.synthesize({ sentences: ['Trees cool the city.'], voice: 'puck', speed: 1.25 });
    expect(faster.sentences[0]!.endMs).toBeCloseTo(640, -1);
    expect(JSON.parse(requests.at(-1)!.body)).toMatchObject({ generationConfig: { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } } } });
  });
});

describe('Veo 生成镜头', () => {
  it('按档位提交 → 轮询 → 下载（跳转后不带密钥）→ 统一到项目画布与帧率、保留声音', { timeout: 120_000 }, async () => {
    const result = await provider().generate(input('ok.mp4'));
    expect(result).toEqual({ providerJobId: 'models/veo-test/operations/op-1', costMicros: null, model: 'veo-test' });
    const submitted = requests.find((item) => item.path.endsWith(':predictLongRunning'))!;
    expect(JSON.parse(submitted.body)).toEqual({ instances: [{ prompt: 'a calm lake at dawn' }], parameters: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' } });
    expect(requests.find((item) => item.path.startsWith('/v1beta/files/'))!.headers['x-goog-api-key']).toBe(KEY);
    expect(storageRequests).toHaveLength(1);
    expect(storageRequests[0]!.headers['x-goog-api-key']).toBeUndefined();
    const probed = await probe.probe({ filePath: join(workRoot, 'ok.mp4'), declaredMimeType: 'video/mp4' });
    expect(probed.streams.find((item) => item.type === 'VIDEO')).toMatchObject({ width: 640, height: 360, averageFrameRate: { numerator: 30, denominator: 1 } });
    expect(probed.streams.some((item) => item.type === 'AUDIO')).toBe(true);
    expect(probed.durationMs).toBeGreaterThanOrEqual(3_900);
    await expect(stat(join(workRoot, 'ok.mp4.veo.mp4'))).rejects.toThrow();

    await provider().generate(input('portrait.mp4', { width: 360, height: 640, seconds: 5, maxSeconds: 6 }));
    expect(JSON.parse(requests.filter((item) => item.path.endsWith(':predictLongRunning')).at(-1)!.body)).toMatchObject({ parameters: { aspectRatio: '9:16', durationSeconds: 6 } });
    expect((await probe.probe({ filePath: join(workRoot, 'portrait.mp4'), declaredMimeType: 'video/mp4' })).streams.find((item) => item.type === 'VIDEO')).toMatchObject({ width: 360, height: 640 });
  });

  it('计费结局：提交被拒 = 不扣费；提交 5xx = 结果不明；任务出错 / 被过滤 = 不扣费；超时 = 结果不明；下载失败 = 已扣费；超出报价档位不提交', { timeout: 120_000 }, async () => {
    behavior = { start: 'reject' };
    expect((await failure(provider().generate(input('a.mp4')))).outcome).toBe('NOT_CHARGED');
    behavior = { start: 'server-error' };
    expect((await failure(provider().generate(input('b.mp4')))).outcome).toBe('UNKNOWN');
    behavior = { result: 'error' };
    expect(await failure(provider().generate(input('c.mp4')))).toMatchObject({ outcome: 'NOT_CHARGED', providerJobId: 'models/veo-test/operations/op-1', message: 'Veo could not make the video: generation failed' });
    behavior = { result: 'filtered' };
    expect(await failure(provider().generate(input('d.mp4')))).toMatchObject({ outcome: 'NOT_CHARGED', message: 'Veo returned no video (prompt blocked)' });
    behavior = { result: 'never' };
    expect((await failure(provider({ renderTimeoutMs: 30 }).generate(input('e.mp4')))).outcome).toBe('UNKNOWN');
    behavior = { download: 'missing' };
    expect((await failure(provider().generate(input('f.mp4')))).outcome).toBe('CHARGED');

    requests = [];
    expect((await failure(provider().generate(input('g.mp4', { seconds: 5, maxSeconds: 4 })))).outcome).toBe('NOT_CHARGED');
    expect((await failure(provider().generate(input('h.mp4', { kind: 'VIDEO_REGION' })))).outcome).toBe('NOT_CHARGED');
    expect(requests).toHaveLength(0);
  });
});
