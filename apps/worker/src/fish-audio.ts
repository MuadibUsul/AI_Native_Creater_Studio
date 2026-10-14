import { createHash } from 'node:crypto';
import type { NarrationSynthesizer, NarrationVoice, SourceMediaProbe } from '@ancs/contracts';
import { createHttpNarrationSynthesizer } from './narration-synthesizer-process.js';

/**
 * Fish Audio（https://fish.audio）语音：文本转语音 + 用声音样本建私有声音（声音克隆）。
 *
 * - 密钥只在 Worker 进程内存里使用（`FISH_AUDIO_API_KEY`），不写日志、不进错误信息、不下发客户端；
 * - 合成：POST /v1/tts（`model` 请求头选模型，`reference_id` 选声音，`prosody.speed` 控制语速），返回音频字节；
 * - 克隆：POST /model（multipart：type=tts、train_mode=fast、visibility=private、voices=样本），按样本内容哈希命名，
 *   同一段样本只建一次（GET /model?self=true&title=… 先查）；
 * - 失败如实上抛（状态码 + 供应商给的简短原因），由调用方决定是否计费与是否重试（付费生成不自动重试）。
 */

export interface FishAudioClientOptions {
  apiKey: string;
  /** 缺省 https://api.fish.audio（测试可指向本地替身） */
  baseUrl?: string;
  /** TTS 模型（请求头 model），缺省 s1 */
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class FishAudioError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'FishAudioError';
  }
}

export interface FishAudioClient {
  readonly model: string;
  tts(input: { text: string; referenceId: string | null; speed?: number; format?: 'wav' | 'mp3' }): Promise<Uint8Array>;
  /** 用声音样本找到或新建一个私有声音，返回声音 id */
  voiceFromSample(input: { sample: Uint8Array; mimeType: string; label: string }): Promise<string>;
}

async function reason(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).slice(0, 400);
  try {
    const body = JSON.parse(text) as { message?: unknown; detail?: unknown };
    const message = typeof body.message === 'string' ? body.message : typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body).slice(0, 200);
    return message.slice(0, 200);
  } catch {
    return text.replace(/\s+/g, ' ').slice(0, 200);
  }
}

export function createFishAudioClient(options: FishAudioClientOptions): FishAudioClient {
  const base = (options.baseUrl ?? 'https://api.fish.audio').replace(/\/+$/, '');
  const model = options.model ?? 's1';
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const auth = { authorization: `Bearer ${options.apiKey}` };
  const call = async (path: string, init: RequestInit, what: string): Promise<Response> => {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new FishAudioError(`Fish Audio ${what}: ${error instanceof Error ? error.message : String(error)}`, null);
    }
    if (!response.ok) throw new FishAudioError(`Fish Audio ${what} failed (${String(response.status)}): ${await reason(response)}`, response.status);
    return response;
  };
  return {
    model,
    async tts(input) {
      const response = await call('/v1/tts', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', model },
        body: JSON.stringify({
          text: input.text,
          ...(input.referenceId === null ? {} : { reference_id: input.referenceId }),
          format: input.format ?? 'wav',
          normalize: true,
          latency: 'normal',
          prosody: { speed: input.speed ?? 1, volume: 0 },
        }),
      }, 'speech synthesis');
      const audio = new Uint8Array(await response.arrayBuffer());
      if (audio.byteLength === 0) throw new FishAudioError('Fish Audio returned no audio', response.status);
      return audio;
    },
    async voiceFromSample(input) {
      const title = `ancs-voice-${createHash('sha256').update(input.sample).digest('hex').slice(0, 24)}`;
      const found = await call(`/model?self=true&page_size=20&title=${encodeURIComponent(title)}`, { method: 'GET', headers: auth }, 'voice lookup');
      const listed = await found.json() as { items?: { _id?: unknown; title?: unknown; state?: unknown }[] };
      const existing = (listed.items ?? []).find((item) => item.title === title && typeof item._id === 'string' && item.state !== 'failed');
      if (existing !== undefined) return String(existing._id);
      const form = new FormData();
      form.set('type', 'tts');
      form.set('title', title);
      form.set('description', input.label.slice(0, 200));
      form.set('train_mode', 'fast');
      form.set('visibility', 'private');
      form.set('enhance_audio_quality', 'true');
      form.append('voices', new Blob([new Uint8Array(input.sample)], { type: input.mimeType }), `sample.${input.mimeType.includes('wav') ? 'wav' : input.mimeType.includes('mpeg') ? 'mp3' : 'audio'}`);
      const created = await call('/model', { method: 'POST', headers: auth, body: form }, 'voice cloning');
      const body = await created.json() as { _id?: unknown; state?: unknown };
      if (typeof body._id !== 'string') throw new FishAudioError('Fish Audio did not return a voice id', created.status);
      if (body.state === 'failed') throw new FishAudioError('Fish Audio could not build a voice from this sample', created.status);
      return body._id;
    },
  };
}

/** Fish Audio 的讲述配音：每个声音是 Fish 上的一个声音（reference_id），由部署方在 ANCS_NARRATION_VOICES_JSON 里声明。 */
export function createFishAudioNarrationSynthesizer(options: { client: FishAudioClient; voices: readonly NarrationVoice[]; probe: SourceMediaProbe; ffmpegPath?: string }): NarrationSynthesizer {
  return createHttpNarrationSynthesizer({
    engine: `fish-audio:${options.client.model}`,
    voices: options.voices,
    probe: options.probe,
    ...(options.ffmpegPath === undefined ? {} : { ffmpegPath: options.ffmpegPath }),
    fetchAudio: ({ text, voice, speed }) => options.client.tts({ text, referenceId: voice, speed, format: 'wav' }),
  });
}
