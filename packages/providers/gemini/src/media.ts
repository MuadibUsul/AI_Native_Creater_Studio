import { GeminiHttpError, createGeminiHttp, retryDelayMs, truncate, type GeminiHttp, type GeminiHttpOptions } from './http.js';

/**
 * Gemini 媒体能力：语音合成（TTS 模型，预置声音）与 Veo 视频生成（长任务：提交 → 轮询 → 下载）。
 * 只做 HTTP 与格式；计费、重试与授权规则在调用方（讲述端口 / 付费生成执行器）。
 */

// ---------------------------------------------------------------------------
// 语音合成
// ---------------------------------------------------------------------------

export interface GeminiSpeech {
  readonly model: string;
  /** 一句话 → WAV 字节。voiceName 为 Gemini 预置声音名（如 Kore） */
  synthesize(input: { text: string; voiceName: string }): Promise<Uint8Array>;
}

interface InlineData { mimeType?: string; data?: string }
interface SpeechResponse { candidates?: { content?: { parts?: { inlineData?: InlineData; text?: string }[] }; finishReason?: string }[] }

/** 16 位小端 PCM 包成 WAV（Gemini TTS 可能以 audio/L16;rate=24000 返回裸 PCM） */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels = 1): Uint8Array {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

export function speechAudio(inline: InlineData): Uint8Array {
  if (typeof inline.data !== 'string' || inline.data.length === 0) throw new GeminiHttpError('Gemini returned no audio', null);
  const bytes = new Uint8Array(Buffer.from(inline.data, 'base64'));
  const mimeType = (inline.mimeType ?? '').toLowerCase();
  if (mimeType.startsWith('audio/l16') || mimeType.startsWith('audio/pcm')) {
    const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? '24000');
    return pcmToWav(bytes, rate);
  }
  return bytes;
}

export function createGeminiSpeech(options: GeminiHttpOptions & { model: string; http?: GeminiHttp; maxRetries?: number; wait?: (ms: number) => Promise<void> }): GeminiSpeech {
  const http = options.http ?? createGeminiHttp({ timeoutMs: 120_000, ...options });
  // 逐句合成会在短时间内连发多次请求：按分钟计的配额触发 429 时等供应商给的时间再试（有界）
  const maxRetries = options.maxRetries ?? 4;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  return {
    model: options.model,
    async synthesize({ text, voiceName }) {
      const body = {
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
      };
      let response: SpeechResponse;
      for (let attempt = 0; ; attempt += 1) {
        try {
          response = await http.postJson<SpeechResponse>(`/models/${encodeURIComponent(options.model)}:generateContent`, body);
          break;
        } catch (error) {
          const delay = attempt < maxRetries ? retryDelayMs(error, attempt) : null;
          if (delay === null) throw error;
          await wait(delay);
        }
      }
      const inline = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData !== undefined)?.inlineData;
      if (inline === undefined) {
        throw new GeminiHttpError(`Gemini returned no audio (finish reason ${response.candidates?.[0]?.finishReason ?? 'unknown'})`, null);
      }
      return speechAudio(inline);
    },
  };
}

// ---------------------------------------------------------------------------
// Veo 视频生成
// ---------------------------------------------------------------------------

export interface VeoRequest {
  prompt: string;
  /** 供应商支持的时长档位之一（Veo 3.1：4 / 6 / 8 秒） */
  durationSeconds: number;
  aspectRatio: '16:9' | '9:16';
  resolution?: '720p' | '1080p';
  negativePrompt?: string;
}

export type VeoOperationState =
  | { done: false }
  | { done: true; videoUri: string; error: null; filtered: null }
  | { done: true; videoUri: null; error: string | null; filtered: string | null };

interface OperationResponse {
  name?: string;
  done?: boolean;
  error?: { message?: string };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: { video?: { uri?: string } }[];
      raiMediaFilteredCount?: number;
      raiMediaFilteredReasons?: string[];
    };
  };
}

export interface GeminiVeo {
  readonly model: string;
  /** 提交生成，返回长任务名（operations/…） */
  start(request: VeoRequest): Promise<string>;
  poll(operation: string): Promise<VeoOperationState>;
  download(uri: string): Promise<Uint8Array>;
}

export function createGeminiVeo(options: GeminiHttpOptions & { model: string; http?: GeminiHttp }): GeminiVeo {
  const http = options.http ?? createGeminiHttp({ timeoutMs: 300_000, ...options });
  return {
    model: options.model,
    async start(request) {
      const response = await http.postJson<OperationResponse>(`/models/${encodeURIComponent(options.model)}:predictLongRunning`, {
        instances: [{ prompt: request.prompt }],
        parameters: {
          aspectRatio: request.aspectRatio,
          durationSeconds: request.durationSeconds,
          ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
          ...(request.negativePrompt === undefined ? {} : { negativePrompt: request.negativePrompt }),
        },
      }, { timeoutMs: 120_000 });
      if (typeof response.name !== 'string' || response.name.length === 0) throw new GeminiHttpError('Veo did not return an operation name', null);
      return response.name;
    },
    async poll(operation) {
      if (!/^(models\/[A-Za-z0-9._-]+\/)?operations\/[A-Za-z0-9_-]+$/.test(operation)) throw new GeminiHttpError('unexpected Veo operation name', null);
      const state = await http.getJson<OperationResponse>(`/${operation}`);
      if (state.done !== true) return { done: false };
      if (state.error !== undefined) return { done: true, videoUri: null, error: truncate(state.error.message ?? 'Veo reported an error'), filtered: null };
      const result = state.response?.generateVideoResponse;
      const uri = result?.generatedSamples?.[0]?.video?.uri;
      if (typeof uri === 'string' && uri.length > 0) return { done: true, videoUri: uri, error: null, filtered: null };
      const reasons = result?.raiMediaFilteredReasons ?? [];
      return { done: true, videoUri: null, error: null, filtered: truncate(reasons.length > 0 ? reasons.join('; ') : (result?.raiMediaFilteredCount ?? 0) > 0 ? 'blocked by the provider safety filter' : 'no video in the result') };
    },
    download(uri) {
      return http.download(uri, { maxBytes: 512 * 1024 * 1024 });
    },
  };
}
