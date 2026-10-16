import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { PaidGenerationFailure, type GenerationOffer } from '@ancs/contracts';
import { MEDIA_CHILD_ENV, childProcessEnv } from './child-env.js';
import type { FishAudioClient } from './fish-audio.js';
import type { GenerationProvider, GenerationProviderInput } from './paid-generation.js';

/**
 * HeyGen（https://www.heygen.com）数字人出镜：参考照片 → 会说话的照片（talking photo），用"你的声音"读讲稿的音频驱动口型。
 *
 * 流程（一次生成）：
 * 1. 声音：用身份档案的声音样本在 Fish Audio 找到/建立私有声音，合成讲稿（WAV），超出报价时长上限 → 不调用 HeyGen、不扣费；
 * 2. 上传照片（talking photo）与音频（asset）到 HeyGen；
 * 3. 提交视频生成（这一步之后才可能计费）；轮询状态直到完成或失败；超时 → 结果不明（待对账，不重试）；
 * 4. 把生成的视频下载到本地（供应商链接是临时的，平台随后拉回自有存储）。
 * 密钥只在 Worker 内存中使用（`HEYGEN_API_KEY`），不进日志与错误信息。HeyGen 不在响应里报告美元费用 → costMicros 为空，
 * 平台按报价上限结算并标明。
 */

export interface HeyGenClientOptions {
  apiKey: string;
  apiBase?: string;
  uploadBase?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class HeyGenError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'HeyGenError';
  }
}

export interface HeyGenVideoStatus {
  status: 'pending' | 'waiting' | 'processing' | 'completed' | 'failed' | string;
  videoUrl: string | null;
  error: string | null;
}

export interface HeyGenClient {
  uploadTalkingPhoto(bytes: Uint8Array, mimeType: string): Promise<string>;
  uploadAudio(bytes: Uint8Array, mimeType: string): Promise<string>;
  generateVideo(input: { talkingPhotoId: string; audioAssetId: string; width: number; height: number; title: string }): Promise<string>;
  videoStatus(videoId: string): Promise<HeyGenVideoStatus>;
  download(url: string): Promise<Uint8Array>;
}

async function reason(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).slice(0, 400);
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string | null; message?: unknown };
    const message = typeof body.error === 'string' ? body.error : typeof body.error?.message === 'string' ? body.error.message : typeof body.message === 'string' ? body.message : text;
    return message.replace(/\s+/g, ' ').slice(0, 200);
  } catch {
    return text.replace(/\s+/g, ' ').slice(0, 200);
  }
}

export function createHeyGenClient(options: HeyGenClientOptions): HeyGenClient {
  const apiBase = (options.apiBase ?? 'https://api.heygen.com').replace(/\/+$/, '');
  const uploadBase = (options.uploadBase ?? 'https://upload.heygen.com').replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const auth = { 'x-api-key': options.apiKey };
  const call = async (url: string, init: RequestInit, what: string): Promise<Response> => {
    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new HeyGenError(`HeyGen ${what}: ${error instanceof Error ? error.message : String(error)}`, null);
    }
    if (!response.ok) throw new HeyGenError(`HeyGen ${what} failed (${String(response.status)}): ${await reason(response)}`, response.status);
    return response;
  };
  const data = async (response: Response, what: string): Promise<Record<string, unknown>> => {
    const body = await response.json() as { data?: Record<string, unknown> | null; error?: unknown };
    if (body.data === undefined || body.data === null) throw new HeyGenError(`HeyGen ${what}: unexpected response`, response.status);
    return body.data;
  };
  return {
    async uploadTalkingPhoto(bytes, mimeType) {
      const response = await call(`${uploadBase}/v1/talking_photo`, { method: 'POST', headers: { ...auth, 'content-type': mimeType }, body: bytes }, 'photo upload');
      const id = (await data(response, 'photo upload'))['talking_photo_id'];
      if (typeof id !== 'string') throw new HeyGenError('HeyGen photo upload returned no id', response.status);
      return id;
    },
    async uploadAudio(bytes, mimeType) {
      const response = await call(`${uploadBase}/v1/asset`, { method: 'POST', headers: { ...auth, 'content-type': mimeType }, body: bytes }, 'audio upload');
      const id = (await data(response, 'audio upload'))['id'];
      if (typeof id !== 'string') throw new HeyGenError('HeyGen audio upload returned no id', response.status);
      return id;
    },
    async generateVideo(input) {
      const response = await call(`${apiBase}/v2/video/generate`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          title: input.title,
          video_inputs: [{ character: { type: 'talking_photo', talking_photo_id: input.talkingPhotoId }, voice: { type: 'audio', audio_asset_id: input.audioAssetId } }],
          dimension: { width: input.width, height: input.height },
        }),
      }, 'video request');
      const id = (await data(response, 'video request'))['video_id'];
      if (typeof id !== 'string') throw new HeyGenError('HeyGen did not return a video id', response.status);
      return id;
    },
    async videoStatus(videoId) {
      const response = await call(`${apiBase}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, { method: 'GET', headers: auth }, 'status');
      const body = await data(response, 'status');
      const error = body['error'];
      return {
        status: String(body['status'] ?? 'unknown'),
        videoUrl: typeof body['video_url'] === 'string' ? body['video_url'] : null,
        error: error === null || error === undefined ? null : typeof error === 'string' ? error : JSON.stringify(error).slice(0, 200),
      };
    },
    async download(url) {
      // 视频链接是供应商的临时签名链接：不带密钥
      const response = await call(url, { method: 'GET' }, 'video download');
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/** HeyGen 数字人的缺省报价依据：V6 §10.1 的规划区间（约 $2–6/分钟），部署方按自己的套餐用 ANCS_AVATAR_OFFER_JSON 覆盖。 */
export const HEYGEN_DEFAULT_OFFER: GenerationOffer = {
  kind: 'AVATAR_CLIP', providerId: 'heygen', implementation: 'REAL', model: 'heygen-talking-photo', perSecondMicros: { min: 33_334, max: 100_000 }, maxSeconds: 30,
  languages: ['en', 'zh', 'ja', 'ko', 'fr', 'de', 'es', 'ar'],
};

interface RunResult { code: number | null; stdout: string; stderr: string }
function run(command: string, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childProcessEnv(process.env, MEDIA_CHILD_ENV) });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4_000) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

export function createHeyGenAvatarProvider(options: {
  heygen: HeyGenClient;
  fish: FishAudioClient;
  offer?: GenerationOffer;
  ffmpegPath?: string;
  ffprobePath?: string;
  pollIntervalMs?: number;
  /** 等待 HeyGen 完成的上限（缺省 20 分钟）；超时 = 结果不明 */
  renderTimeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
}): GenerationProvider {
  const offer = options.offer ?? HEYGEN_DEFAULT_OFFER;
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const ffprobe = options.ffprobePath ?? 'ffprobe';
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const renderTimeoutMs = options.renderTimeoutMs ?? 20 * 60_000;
  const wait = options.wait ?? sleep;
  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

  return {
    offers: [offer],
    async generate(input: GenerationProviderInput) {
      if (input.kind !== 'AVATAR_CLIP' || input.likenessPath === null || input.voicePath === null || input.script === null) {
        throw new PaidGenerationFailure('the digital-human provider needs a photo, a voice sample and a script', 'NOT_CHARGED');
      }
      // 1. 你的声音读讲稿（Fish Audio）；量时长，超过报价上限就不继续
      const speechMp3 = `${input.outputPath}.speech.mp3`;
      try {
        const sample = await readFile(input.voicePath);
        const voiceId = await options.fish.voiceFromSample({ sample, mimeType: input.voicePath.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', label: 'ANCS identity voice' });
        const speech = await options.fish.tts({ text: input.script, referenceId: voiceId, format: 'wav' });
        const speechWav = `${input.outputPath}.speech.wav`;
        await writeFile(speechWav, speech);
        const probed = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', speechWav], 60_000);
        const seconds = Number(probed.stdout.trim());
        if (!(seconds > 0)) throw new Error('the synthesized speech is empty');
        if (seconds > input.maxSeconds + 0.5) throw new Error(`the script runs ${seconds.toFixed(1)} s, longer than the quoted ${String(input.maxSeconds)} s`);
        const converted = await run(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', speechWav, '-ac', '1', '-ar', '44100', '-b:a', '128k', speechMp3], 120_000);
        if (converted.code !== 0) throw new Error(`audio conversion failed: ${converted.stderr.trim().slice(-200)}`);
      } catch (error) {
        throw new PaidGenerationFailure(`voice synthesis failed: ${describe(error)}`, 'NOT_CHARGED');
      }
      // 2. 上传照片与音频
      let talkingPhotoId: string;
      let audioAssetId: string;
      try {
        const photo = await readFile(input.likenessPath);
        talkingPhotoId = await options.heygen.uploadTalkingPhoto(photo, input.likenessPath.endsWith('.png') ? 'image/png' : 'image/jpeg');
        audioAssetId = await options.heygen.uploadAudio(await readFile(speechMp3), 'audio/mpeg');
      } catch (error) {
        throw new PaidGenerationFailure(`upload to HeyGen failed: ${describe(error)}`, 'NOT_CHARGED');
      }
      // 3. 提交生成：明确的 4xx 拒绝 = 没有开始（不扣费）；网络中断/5xx = 不知道是否已开始（待对账）
      let videoId: string;
      try {
        videoId = await options.heygen.generateVideo({ talkingPhotoId, audioAssetId, width: input.width, height: input.height, title: 'ANCS digital-human clip' });
      } catch (error) {
        const status = error instanceof HeyGenError ? error.status : null;
        throw new PaidGenerationFailure(`HeyGen video request failed: ${describe(error)}`, status !== null && status >= 400 && status < 500 ? 'NOT_CHARGED' : 'UNKNOWN');
      }
      // 4. 轮询：失败 = 供应商不计费；超时或一直查不到状态 = 结果不明
      const deadline = Date.now() + renderTimeoutMs;
      let videoUrl: string | null = null;
      let pollErrors = 0;
      while (videoUrl === null) {
        if (Date.now() > deadline) throw new PaidGenerationFailure(`HeyGen did not finish within ${String(Math.round(renderTimeoutMs / 60_000))} minutes`, 'UNKNOWN', null, videoId);
        await wait(pollIntervalMs);
        let state: HeyGenVideoStatus;
        try {
          state = await options.heygen.videoStatus(videoId);
          pollErrors = 0;
        } catch (error) {
          pollErrors += 1;
          if (pollErrors >= 5) throw new PaidGenerationFailure(`could not read the HeyGen video status: ${describe(error)}`, 'UNKNOWN', null, videoId);
          continue;
        }
        if (state.status === 'failed') throw new PaidGenerationFailure(`HeyGen could not make the video: ${state.error ?? 'unknown reason'}`, 'NOT_CHARGED', null, videoId);
        if (state.status === 'completed') {
          if (state.videoUrl === null) throw new PaidGenerationFailure('HeyGen finished but returned no video link', 'CHARGED', null, videoId);
          videoUrl = state.videoUrl;
        }
      }
      // 5. 下载到本地（平台随后拉回自有存储并探测）
      try {
        await writeFile(input.outputPath, await options.heygen.download(videoUrl));
      } catch (error) {
        throw new PaidGenerationFailure(`downloading the HeyGen video failed: ${describe(error)}`, 'CHARGED', null, videoId);
      }
      return { providerJobId: videoId, costMicros: null, model: `${offer.model}+fish-audio-${options.fish.model}` };
    },
  };
}

/** 多个供应商合在一起：报价依据取并集，生成按类型交给声明了该类型的供应商。 */
export function combineGenerationProviders(providers: readonly GenerationProvider[]): GenerationProvider {
  return {
    offers: providers.flatMap((provider) => provider.offers),
    generate(input) {
      const provider = providers.find((item) => item.offers.some((offer) => offer.kind === input.kind && offer.providerId === input.providerId))
        ?? providers.find((item) => item.offers.some((offer) => offer.kind === input.kind));
      if (provider === undefined) return Promise.reject(new PaidGenerationFailure(`no provider for ${input.kind}`, 'NOT_CHARGED'));
      return provider.generate(input);
    },
  };
}
