import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaidGenerationFailure } from '@ancs/contracts';
import { createFishAudioClient, createFishAudioNarrationSynthesizer, type FishAudioClient } from './fish-audio.js';
import { createHeyGenAvatarProvider, createHeyGenClient, type HeyGenClient } from './heygen.js';
import { createPaidGenerationExecutor } from './paid-generation.js';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';

/**
 * Fish Audio + HeyGen 适配器的协议契约测试（**本地替身服务**，按两家公开 HTTP 接口的形状回应；不是真实服务验证）：
 * - Fish：讲述逐句合成（请求头 model、reference_id、prosody.speed、Bearer 密钥）→ 拼接 WAV、句界精确；
 *   声音样本按内容哈希只建一次私有声音；402 等错误如实上抛且不含密钥；
 * - HeyGen 数字人：你的声音（Fish）读讲稿 → 上传照片与音频 → 提交生成 → 轮询 → 下载；
 *   超出报价时长 → 不提交（不扣费）；生成失败 → 不扣费并带任务 id；提交时连接中断 → 结果不明；
 * - 经执行器：产物可解码、有声音、任务 id 与费用（HeyGen 不报美元 → 空）如实交回。
 */

const FISH_KEY = 'fish-test-key-0000000000'; // secrets:check-ignore: test-only dummy
const HEYGEN_KEY = 'heygen-test-key-000000000'; // secrets:check-ignore: test-only dummy
let workRoot: string;
let server: Server;
let base: string;
let speechWav: Buffer;
let longSpeechWav: Buffer;
let avatarMp4: Buffer;
const probe = createFfmpegSourceMediaProbe({ timeoutMs: 60_000 });

interface Recorded { method: string; path: string; headers: IncomingMessage['headers']; body: Buffer }
let requests: Recorded[] = [];
let behavior: { tts?: number; longSpeech?: boolean; generate?: 'ok' | 'reject' | 'drop'; status?: 'completed' | 'failed' } = {};
const models: { _id: string; title: string; state: string }[] = [];

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'ancs-fish-heygen-'));
  const make = (name: string, args: string[]) => { const file = join(workRoot, name); execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args, file]); return readFile(file); };
  speechWav = await make('speech.wav', ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=1.2', '-ar', '44100']);
  longSpeechWav = await make('long.wav', ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=9', '-ar', '44100']);
  avatarMp4 = await make('avatar.mp4', ['-f', 'lavfi', '-i', 'color=c=0x3b82f6:s=320x180:d=1.2', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1.2', '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac']);
  await writeFile(join(workRoot, 'face.png'), await make('face-src.png', ['-f', 'lavfi', '-i', 'color=c=0xfacc15:s=256x256:d=1', '-frames:v', '1']));
  await writeFile(join(workRoot, 'voice.wav'), await make('voice-src.wav', ['-f', 'lavfi', '-i', 'sine=frequency=200:duration=2']));
  let statusCalls = 0;
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const body = Buffer.concat(chunks);
        requests.push({ method: request.method ?? '', path: url.pathname + url.search, headers: request.headers, body });
        const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
        const fishAuthorized = request.headers['authorization'] === `Bearer ${FISH_KEY}`;
        const heygenAuthorized = request.headers['x-api-key'] === HEYGEN_KEY;
        if (url.pathname === '/fish/v1/tts') {
          if (!fishAuthorized) return json(401, { status: 401, message: 'Invalid API key' });
          if (behavior.tts !== undefined) return json(behavior.tts, { status: behavior.tts, message: 'Insufficient balance' });
          response.writeHead(200, { 'content-type': 'audio/wav' });
          return response.end(behavior.longSpeech === true ? longSpeechWav : speechWav);
        }
        if (url.pathname === '/fish/model' && request.method === 'GET') {
          return json(200, { total: models.length, items: models.filter((model) => model.title === url.searchParams.get('title')) });
        }
        if (url.pathname === '/fish/model' && request.method === 'POST') {
          const form = await new Request('http://x', { method: 'POST', headers: request.headers as Record<string, string>, body }).formData();
          const model = { _id: `model${String(models.length + 1)}`, title: String(form.get('title')), state: 'trained' };
          models.push(model);
          return json(201, model);
        }
        if (url.pathname === '/upload/v1/talking_photo') return heygenAuthorized ? json(200, { code: 100, data: { talking_photo_id: 'tp_1' } }) : json(401, { error: 'unauthorized' });
        if (url.pathname === '/upload/v1/asset') return json(200, { code: 100, data: { id: 'asset_1' } });
        if (url.pathname === '/api/v2/video/generate') {
          if (behavior.generate === 'reject') return json(400, { error: { code: 'invalid_parameter', message: 'talking photo is not usable' } });
          if (behavior.generate === 'drop') { request.socket.destroy(); return; }
          statusCalls = 0;
          return json(200, { error: null, data: { video_id: 'vid_1' } });
        }
        if (url.pathname === '/api/v1/video_status.get') {
          statusCalls += 1;
          if (statusCalls < 2) return json(200, { code: 100, data: { status: 'processing', video_url: null, error: null } });
          return behavior.status === 'failed'
            ? json(200, { code: 100, data: { status: 'failed', video_url: null, error: { code: 'MOVIO_RENDER', message: 'face not detected' } } })
            : json(200, { code: 100, data: { status: 'completed', video_url: `${base}/cdn/vid_1.mp4?sig=abc`, error: null } });
        }
        if (url.pathname === '/cdn/vid_1.mp4') { response.writeHead(200, { 'content-type': 'video/mp4' }); return response.end(avatarMp4); }
        return json(404, { message: 'not found' });
      })();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(workRoot, { recursive: true, force: true });
});

beforeEach(() => { requests = []; behavior = {}; });

const fish = (): FishAudioClient => createFishAudioClient({ apiKey: FISH_KEY, baseUrl: `${base}/fish` });
const heygen = (): HeyGenClient => createHeyGenClient({ apiKey: HEYGEN_KEY, apiBase: `${base}/api`, uploadBase: `${base}/upload` });
const provider = () => createHeyGenAvatarProvider({ heygen: heygen(), fish: fish(), pollIntervalMs: 1, wait: () => Promise.resolve() });
const avatarInput = (overrides: Record<string, unknown> = {}) => ({
  kind: 'AVATAR_CLIP' as const, providerId: 'heygen', prompt: null, script: 'Hello and welcome.', language: 'en', seconds: 1.5, maxSeconds: 2,
  width: 320, height: 180, fps: 30, outputPath: join(workRoot, `out-${String(Date.now())}.mp4`), likenessPath: join(workRoot, 'face.png'), voicePath: join(workRoot, 'voice.wav'),
  sourcePath: null, region: null, ...overrides,
});
const failure = async (promise: Promise<unknown>): Promise<PaidGenerationFailure> => {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(PaidGenerationFailure);
  return caught as PaidGenerationFailure;
};

describe('Fish Audio 与 HeyGen 适配器（本地替身服务，协议契约）', () => {
  it('Fish 讲述：逐句合成、带密钥与模型、语速交给供应商；拼成 WAV、句界精确；错误不含密钥', { timeout: 120_000 }, async () => {
    const synthesizer = createFishAudioNarrationSynthesizer({ client: fish(), voices: [{ id: 'abc123', name: 'Mine', languages: ['zh', 'en'], description: 'test' }], probe });
    expect(synthesizer.engine).toBe('fish-audio:s1');
    const result = await synthesizer.synthesize({ sentences: ['第一句。', '第二句。'], voice: 'abc123', speed: 1.1 });
    expect(result.probe.status).toBe('READY');
    expect(result.sentences).toHaveLength(2);
    expect(result.sentences[0]!.startMs).toBe(0);
    expect(result.sentences[1]!.startMs).toBeCloseTo(1_450, -1);
    expect(result.durationMs).toBeCloseTo(2_650, -1);
    const tts = requests.filter((item) => item.path === '/fish/v1/tts');
    expect(tts).toHaveLength(2);
    expect(tts[0]!.headers['model']).toBe('s1');
    expect(JSON.parse(tts[0]!.body.toString('utf8'))).toMatchObject({ text: '第一句。', reference_id: 'abc123', format: 'wav', prosody: { speed: 1.1 } });

    behavior.tts = 402;
    const error = await synthesizer.synthesize({ sentences: ['x'], voice: 'abc123', speed: 1 }).then(() => null, (caught: unknown) => caught as Error);
    expect(error?.message).toContain('Fish Audio speech synthesis failed (402): Insufficient balance');
    expect(error?.message).not.toContain(FISH_KEY);
  });

  it('Fish 声音克隆：同一段样本只建一次私有声音', async () => {
    const client = fish();
    const sample = await readFile(join(workRoot, 'voice.wav'));
    const first = await client.voiceFromSample({ sample, mimeType: 'audio/wav', label: 'me' });
    const second = await client.voiceFromSample({ sample, mimeType: 'audio/wav', label: 'me' });
    expect(second).toBe(first);
    expect(requests.filter((item) => item.path === '/fish/model' && item.method === 'POST')).toHaveLength(1);
    expect(models.find((model) => model._id === first)?.title).toMatch(/^ancs-voice-[0-9a-f]{24}$/);
  });

  it('HeyGen 数字人：你的声音 → 上传 → 生成 → 轮询 → 下载；经执行器得到有声视频，任务 id 如实交回', { timeout: 120_000 }, async () => {
    const executor = createPaidGenerationExecutor({ provider: provider(), storage: { kind: 'test', getObject: async (key: string) => readFile(join(workRoot, key)) } as never, probe });
    const product = await executor.execute({
      generationId: 'gen_1', kind: 'AVATAR_CLIP', providerId: 'heygen', prompt: null, script: 'Hello and welcome.', language: 'en', seconds: 1.5, maxSeconds: 2,
      width: 320, height: 180, frameRate: { num: 30, den: 1 }, likeness: { storageKey: 'face.png', mimeType: 'image/png' }, voice: { storageKey: 'voice.wav', mimeType: 'audio/wav' },
      source: null, region: null,
    }, { beforeProviderCall: async () => undefined });
    expect(product).toMatchObject({ providerJobId: 'vid_1', costMicros: null, model: 'heygen-talking-photo+fish-audio-s1', hasAudio: true, outsideRegionChange: null });
    expect(product.durationMs).toBeGreaterThan(1_000);
    const generate = requests.find((item) => item.path === '/api/v2/video/generate')!;
    expect(generate.headers['x-api-key']).toBe(HEYGEN_KEY);
    expect(JSON.parse(generate.body.toString('utf8'))).toMatchObject({
      video_inputs: [{ character: { type: 'talking_photo', talking_photo_id: 'tp_1' }, voice: { type: 'audio', audio_asset_id: 'asset_1' } }], dimension: { width: 320, height: 180 },
    });
    // 视频链接是临时签名链接：下载时不带密钥
    expect(requests.find((item) => item.path.startsWith('/cdn/'))!.headers['x-api-key']).toBeUndefined();
    expect(requests.find((item) => item.path === '/upload/v1/talking_photo')!.headers['content-type']).toBe('image/png');
    expect(requests.find((item) => item.path === '/upload/v1/asset')!.headers['content-type']).toBe('audio/mpeg');
  });

  it('HeyGen 失败分类：超出报价时长不提交；生成失败不扣费；明确拒绝不扣费；提交时连接中断 = 结果不明', { timeout: 120_000 }, async () => {
    behavior = { longSpeech: true };
    const tooLong = await failure(provider().generate(avatarInput()));
    expect(tooLong).toMatchObject({ outcome: 'NOT_CHARGED' });
    expect(tooLong.message).toContain('longer than the quoted 2 s');
    expect(requests.some((item) => item.path.startsWith('/api/v2/'))).toBe(false);

    behavior = { status: 'failed' };
    const failed = await failure(provider().generate(avatarInput()));
    expect(failed).toMatchObject({ outcome: 'NOT_CHARGED', providerJobId: 'vid_1' });
    expect(failed.message).toContain('face not detected');

    behavior = { generate: 'reject' };
    expect(await failure(provider().generate(avatarInput()))).toMatchObject({ outcome: 'NOT_CHARGED', message: expect.stringContaining('talking photo is not usable') as string });

    behavior = { generate: 'drop' };
    const dropped = await failure(provider().generate(avatarInput()));
    expect(dropped.outcome).toBe('UNKNOWN');
    expect(dropped.message).not.toContain(HEYGEN_KEY);
  });
});
