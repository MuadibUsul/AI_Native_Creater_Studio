import type { RealtimeVoice, RealtimeWord, StreamingAsrEvents, StreamingAsrSession, StreamingSpeechRecognizer, StreamingSpeechSynthesizer } from '@ancs/contracts';

/**
 * OpenAI 兼容的语音接口（**真实 Provider**，Issue #9）：识别走 `/audio/transcriptions`，语音回应走 `/audio/speech`。
 * 官方接口或兼容网关都可以（`baseUrl` 含 /v1）。
 *
 * 识别不是供应商侧的流式：网关自己断句——按 20 ms 帧算音量、跟踪噪声底，连续发声即"开口"（立刻通知打断 AI 的语音回应），
 * 说话中每隔 interimMs 把这一句已收到的音频转写一次作为临时转写（可修订），静音 endSilenceMs 后转写整句作为最终结果。
 * 指代绑定需要逐词时间：whisper-1 由供应商给出；其余模型没有词时间，按"发声帧 + 临时转写出现的时刻"估算（见 estimateWordTimes）。
 *
 * 纪律：密钥只在请求头；错误信息只取供应商的 message（截断），不含密钥；401/403/4xx 不可重试，429/5xx 可重试；
 * 网关**不自动重试**任何一次转写或合成（失败如实告诉用户，由用户决定是否再说一次）。
 */

export interface OpenAiAudioHttpOptions {
  apiKey: string;
  /** 含 /v1 的基址（缺省 https://api.openai.com/v1） */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** 单次请求超时（毫秒，缺省 30000） */
  timeoutMs?: number;
}

export class OpenAiAudioError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly status: number | null) {
    super(message);
    this.name = 'OpenAiAudioError';
  }
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320; // 20 ms
const FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE;
const PRE_ROLL_FRAMES = 15; // 开口前留 300 ms，避免吞掉第一个字
const START_FRAMES = 3; // 连续 60 ms 发声才算开口
const MAX_SEGMENT_SECONDS = 30;
/** 临时转写里还没出现的词，最早可能在请求时刻之前这么久就已说出（识别对最后半个词的滞后） */
const RECOGNITION_LAG_SECONDS = 0.35;

function http(options: OpenAiAudioHttpOptions) {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return async (path: string, init: { body: FormData | string; contentType?: string; signal?: AbortSignal }): Promise<Response> => {
    const signal = init.signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, ...(init.contentType === undefined ? {} : { 'content-type': init.contentType }) },
        body: init.body,
        signal,
      });
    } catch (error) {
      if (init.signal?.aborted === true) throw new OpenAiAudioError('ABORTED', 'request aborted', false, null);
      throw new OpenAiAudioError('CONNECT_FAILED', `could not reach the speech service (${error instanceof Error ? error.name : 'error'})`, true, null);
    }
    if (response.ok) return response;
    const detail = await response.json().then(
      (body: unknown) => {
        const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
        return typeof message === 'string' ? message.slice(0, 200) : '';
      },
      () => '',
    );
    const status = response.status;
    const code = status === 401 || status === 403 ? 'AUTH_FAILED' : status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'UNAVAILABLE' : 'REQUEST_REJECTED';
    throw new OpenAiAudioError(code, `speech service HTTP ${String(status)}${detail === '' ? '' : `: ${detail}`}`, status === 429 || status >= 500, status);
  };
}

/** PCM16 小端单声道 → WAV（RIFF） */
export function pcmToWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const data = samples.length * 2;
  const buffer = new ArrayBuffer(44 + data);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => { for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + data, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, data, true);
  new Int16Array(buffer, 44).set(samples);
  return new Uint8Array(buffer);
}

/** 断句与估时用的"词"：每个汉字一个、拉丁文按词（标点不算） */
export function speechTokens(text: string): string[] {
  return [...text.matchAll(/[㐀-鿿豈-﫿]|[A-Za-z0-9][A-Za-z0-9'’-]*/g)].map((match) => match[0]);
}

const tokenWeight = (token: string): number => (/^[A-Za-z0-9]/.test(token) ? Math.max(1, Math.round(token.length / 3)) : 1);

/**
 * 纯函数：没有供应商词时间时估算每个词的起止（秒，绝对时间）。
 * 1. 按字/音节权重把词摊到**发声帧**组成的时间线上（静音段不分配）；
 * 2. 用临时转写收紧：第 k 次临时转写（音频截至 at_k）已认出的前 n_k 个词，结束不晚于 at_k；
 *    还没认出的词，开始不早于 at_k − 识别滞后。
 * 结果是估算，指代绑定按它取说出"这里"那一刻的指向（文档如实标注）。
 */
export function estimateWordTimes(input: { text: string; voiced: readonly [number, number][]; marks: readonly { at: number; text: string }[] }): RealtimeWord[] {
  const tokens = speechTokens(input.text);
  const voiced = input.voiced.filter(([start, end]) => end > start);
  if (tokens.length === 0 || voiced.length === 0) return [];
  const total = voiced.reduce((sum, [start, end]) => sum + (end - start), 0);
  const weights = tokens.map(tokenWeight);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const atVoiced = (offset: number): number => {
    let remaining = offset;
    for (const [start, end] of voiced) {
      if (remaining <= end - start) return start + remaining;
      remaining -= end - start;
    }
    return voiced[voiced.length - 1]![1];
  };
  let cursor = 0;
  const words = tokens.map((token, index) => {
    const from = (cursor / weightSum) * total;
    cursor += weights[index]!;
    return { text: token, start: atVoiced(from), end: atVoiced((cursor / weightSum) * total) };
  });
  const normalized = tokens.map((token) => token.toLowerCase());
  for (const mark of input.marks) {
    const seen = speechTokens(mark.text).map((token) => token.toLowerCase());
    let known = 0;
    while (known < seen.length && known < normalized.length && seen[known] === normalized[known]) known += 1;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index]!;
      if (index < known) word.end = Math.min(word.end, mark.at);
      else word.start = Math.max(word.start, mark.at - RECOGNITION_LAG_SECONDS);
      if (word.start > word.end) word.start = word.end;
    }
  }
  for (let index = 1; index < words.length; index += 1) {
    const previous = words[index - 1]!;
    const word = words[index]!;
    if (word.start < previous.start) word.start = previous.start;
    if (word.end < word.start) word.end = word.start;
  }
  return words.map((word) => ({ text: word.text, start: Math.max(0, Number(word.start.toFixed(3))), end: Math.max(0, Number(word.end.toFixed(3))) }));
}

export interface OpenAiRecognizerOptions extends OpenAiAudioHttpOptions {
  /** 转写模型（缺省 gpt-4o-transcribe；whisper-1 带回逐词时间） */
  model?: string;
  /** 说话中出临时转写的间隔（毫秒，缺省 900；0 = 只在一句话说完时转写） */
  interimMs?: number;
  /** 静音多久算一句话说完（毫秒，缺省 700） */
  endSilenceMs?: number;
  /** 发声判定的最低电平（0–1 RMS，缺省 0.012）与相对噪声底的倍数（缺省 3.5） */
  minLevel?: number;
  noiseRatio?: number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

interface TranscribeResult { text: string; words: RealtimeWord[] | null }

/**
 * 转写提示（OpenAI 转写接口的 prompt）：说明场景与书写体例。实测 gpt-4o-transcribe 只给 language=zh 时会输出繁体、
 * 并把"剪短"听成"簡短"；给出简体的剪辑口令示例后按简体与剪辑用词转写。只描述场景，不含任何用户内容。
 */
export const TRANSCRIPTION_PROMPTS: Record<'zh-CN' | 'en', string> = {
  'zh-CN': '这是用简体中文说的视频剪辑口令，例如：把这一段剪短一点；把这里的音乐调小；结尾淡出；不对，保留三秒。',
  en: 'These are spoken video editing instructions, for example: make this clip shorter; turn the music down here; fade out the ending.',
};

export function createOpenAiTranscriptionRecognizer(options: OpenAiRecognizerOptions): StreamingSpeechRecognizer {
  const post = http(options);
  const model = options.model ?? 'gpt-4o-transcribe';
  const providerWords = model.startsWith('whisper');
  const interimMs = options.interimMs ?? 900;
  const endFrames = Math.max(5, Math.round((options.endSilenceMs ?? 700) / (FRAME_SECONDS * 1000)));
  const minLevel = options.minLevel ?? 0.012;
  const noiseRatio = options.noiseRatio ?? 3.5;
  const log = options.log ?? (() => undefined);

  const transcribe = async (samples: Int16Array, locale: 'zh-CN' | 'en', withWords: boolean, signal: AbortSignal): Promise<TranscribeResult> => {
    const form = new FormData();
    form.append('file', new Blob([pcmToWav(samples)], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', model);
    form.append('language', locale === 'zh-CN' ? 'zh' : 'en');
    form.append('prompt', TRANSCRIPTION_PROMPTS[locale]);
    if (withWords) {
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
    } else {
      form.append('response_format', 'json');
    }
    const response = await post('/audio/transcriptions', { body: form, signal });
    const body = await response.json() as { text?: unknown; words?: { word?: unknown; start?: unknown; end?: unknown }[] };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const words = withWords && Array.isArray(body.words)
      ? body.words.flatMap((word) => (typeof word.word === 'string' && typeof word.start === 'number' && typeof word.end === 'number' ? [{ text: word.word, start: word.start, end: word.end }] : []))
      : null;
    return { text, words };
  };

  return {
    providerId: 'openai',
    implementation: 'REAL',
    model,
    open: async (session, events: StreamingAsrEvents): Promise<StreamingAsrSession> => {
      const locale = session.locale;
      const controller = new AbortController();
      const pending = new Set<Promise<void>>();
      let closed = false;
      let finishing = false;
      let carry: number | null = null;
      let frame = new Int16Array(FRAME_SAMPLES);
      let frameFill = 0;
      let processed = 0; // 已处理的采样数（音频时钟）
      let noise = 0.004;
      let voicedRun = 0;
      let silentRun = 0;
      const preRoll: Int16Array[] = [];
      let generation = 0;
      let segment: { id: number; startSample: number; frames: Int16Array[]; voiced: [number, number][]; marks: { at: number; text: string }[]; lastInterim: number; interimInFlight: boolean; speechAt: number } | null = null;

      const track = (work: Promise<void>) => {
        pending.add(work);
        void work.finally(() => pending.delete(work));
      };
      const segmentSamples = () => (segment === null ? 0 : segment.frames.length * FRAME_SAMPLES);
      const concat = (frames: Int16Array[]) => {
        const all = new Int16Array(frames.length * FRAME_SAMPLES);
        frames.forEach((item, index) => all.set(item, index * FRAME_SAMPLES));
        return all;
      };

      const requestInterim = () => {
        const current = segment;
        if (current === null || current.interimInFlight || interimMs <= 0) return;
        if ((segmentSamples() - current.lastInterim) / SAMPLE_RATE * 1000 < interimMs) return;
        current.lastInterim = segmentSamples();
        current.interimInFlight = true;
        const at = (current.startSample + segmentSamples()) / SAMPLE_RATE;
        const audio = concat(current.frames);
        const started = Date.now();
        track(transcribe(audio, locale, false, controller.signal).then((result) => {
          current.interimInFlight = false;
          if (closed || segment !== current || result.text.length === 0) return;
          current.marks.push({ at, text: result.text });
          log('asr_interim', { ms: Date.now() - started, audioSeconds: Number((audio.length / SAMPLE_RATE).toFixed(2)) });
          const start = current.startSample / SAMPLE_RATE;
          events.onResult({ start, duration: at - start, text: result.text, words: estimateWordTimes({ text: result.text, voiced: current.voiced, marks: [] }), isFinal: false, speechFinal: false });
        }, () => { current.interimInFlight = false; }));
      };

      const endSegment = () => {
        const current = segment;
        segment = null;
        silentRun = 0;
        voicedRun = 0;
        if (current === null) return;
        const audio = concat(current.frames);
        const start = current.startSample / SAMPLE_RATE;
        const started = Date.now();
        track(transcribe(audio, locale, providerWords, controller.signal).then((result) => {
          if (closed) return;
          log('asr_final', { ms: Date.now() - started, audioSeconds: Number((audio.length / SAMPLE_RATE).toFixed(2)), characters: result.text.length, wordTimes: result.words === null ? 'estimated' : 'provider' });
          const words = result.words === null
            ? estimateWordTimes({ text: result.text, voiced: current.voiced, marks: current.marks })
            : result.words.map((word) => ({ text: word.text, start: Number((start + word.start).toFixed(3)), end: Number((start + word.end).toFixed(3)) }));
          events.onResult({ start, duration: audio.length / SAMPLE_RATE, text: result.text, words, isFinal: true, speechFinal: true });
          events.onUtteranceEnd(words.length > 0 ? words[words.length - 1]!.end : null);
        }, (error: unknown) => {
          if (closed) return;
          const failure = error instanceof OpenAiAudioError ? error : new OpenAiAudioError('ASR_FAILED', 'speech recognition failed', true, null);
          if (failure.code === 'ABORTED') return;
          log('asr_failed', { code: failure.code, status: failure.status });
          events.onError({ code: failure.code === 'AUTH_FAILED' ? 'ASR_AUTH_FAILED' : 'ASR_FAILED', message: failure.message, retryable: failure.retryable });
        }));
      };

      const processFrame = (samples: Int16Array) => {
        let energy = 0;
        for (const sample of samples) energy += (sample / 32768) ** 2;
        const level = Math.sqrt(energy / samples.length);
        const at = processed / SAMPLE_RATE;
        processed += samples.length;
        const voiced = level > Math.max(minLevel, noise * noiseRatio);
        if (segment === null) {
          preRoll.push(samples);
          if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
          if (voiced) voicedRun += 1;
          else { voicedRun = 0; noise = Math.max(0.0005, noise * 0.95 + level * 0.05); }
          if (voicedRun >= START_FRAMES) {
            generation += 1;
            const onset = at - (START_FRAMES - 1) * FRAME_SECONDS;
            segment = { id: generation, startSample: processed - preRoll.length * FRAME_SAMPLES, frames: [...preRoll], voiced: [[onset, at + FRAME_SECONDS]], marks: [], lastInterim: 0, interimInFlight: false, speechAt: onset };
            preRoll.length = 0;
            voicedRun = 0;
            silentRun = 0;
            events.onSpeechStart?.(Number(onset.toFixed(3)));
          }
          return;
        }
        segment.frames.push(samples);
        if (voiced) {
          silentRun = 0;
          const last = segment.voiced[segment.voiced.length - 1];
          if (last !== undefined && at - last[1] < FRAME_SECONDS * 1.5) last[1] = at + FRAME_SECONDS;
          else segment.voiced.push([at, at + FRAME_SECONDS]);
        } else {
          silentRun += 1;
        }
        if (silentRun >= endFrames || segmentSamples() / SAMPLE_RATE >= MAX_SEGMENT_SECONDS) endSegment();
        else requestInterim();
      };

      return {
        sendAudio(chunk) {
          if (closed || finishing) return;
          let offset = 0;
          if (carry !== null && chunk.length > 0) {
            const value = (chunk[0]! << 8) | carry;
            frame[frameFill++] = value >= 0x8000 ? value - 0x10000 : value;
            carry = null;
            offset = 1;
            if (frameFill === FRAME_SAMPLES) { processFrame(frame); frame = new Int16Array(FRAME_SAMPLES); frameFill = 0; }
          }
          for (; offset + 1 < chunk.length; offset += 2) {
            const value = chunk[offset]! | (chunk[offset + 1]! << 8);
            frame[frameFill++] = value >= 0x8000 ? value - 0x10000 : value;
            if (frameFill === FRAME_SAMPLES) { processFrame(frame); frame = new Int16Array(FRAME_SAMPLES); frameFill = 0; }
          }
          if (offset < chunk.length) carry = chunk[offset]!;
        },
        finish() {
          if (finishing || closed) return;
          finishing = true;
          if (segment !== null) endSegment();
          void Promise.allSettled([...pending]).then(() => { if (!closed) { closed = true; events.onClose(); } });
        },
        close() {
          if (closed) return;
          closed = true;
          controller.abort();
          segment = null;
        },
      };
    },
  };
}

export interface OpenAiSynthesizerOptions extends OpenAiAudioHttpOptions {
  /** 语音模型（缺省 gpt-4o-mini-tts） */
  model?: string;
  /** 实际可用的声音（缺省只有 coral） */
  voices?: readonly RealtimeVoice[];
}

/** AI 语音回应：`/audio/speech`（response_format=pcm：24 kHz PCM16 小端单声道），边收边回调；中止即停 */
export function createOpenAiSpeechSynthesizer(options: OpenAiSynthesizerOptions): StreamingSpeechSynthesizer {
  const post = http({ ...options, timeoutMs: options.timeoutMs ?? 60_000 });
  const model = options.model ?? 'gpt-4o-mini-tts';
  const voices = options.voices !== undefined && options.voices.length > 0 ? options.voices : [{ id: 'coral', name: 'Coral' }];
  return {
    providerId: 'openai',
    implementation: 'REAL',
    model,
    sampleRate: 24_000,
    voices,
    async synthesize(input, onChunk) {
      const response = await post('/audio/speech', {
        contentType: 'application/json',
        body: JSON.stringify({ model, voice: input.voiceId, input: input.text, response_format: 'pcm' }),
        // 契约只要求结构化的 aborted；运行时网关传入真正的 AbortSignal（否则只在读流时按 aborted 停）
        ...(input.signal instanceof AbortSignal ? { signal: input.signal } : {}),
      });
      if (response.body === null) throw new OpenAiAudioError('UNAVAILABLE', 'speech service returned no audio', true, response.status);
      const reader = response.body.getReader();
      let carry: number | null = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || input.signal.aborted) break;
          let bytes: Uint8Array = value;
          if (carry !== null) {
            const joined = new Uint8Array(bytes.length + 1);
            joined[0] = carry;
            joined.set(bytes, 1);
            bytes = joined;
            carry = null;
          }
          if (bytes.length % 2 === 1) { carry = bytes[bytes.length - 1]!; bytes = bytes.subarray(0, bytes.length - 1); }
          if (bytes.length > 0) onChunk(bytes);
        }
      } catch (error) {
        if (input.signal.aborted) throw new OpenAiAudioError('ABORTED', 'speech aborted', false, null);
        throw new OpenAiAudioError('UNAVAILABLE', `speech stream interrupted (${error instanceof Error ? error.name : 'error'})`, true, null);
      } finally {
        reader.releaseLock();
      }
      if (input.signal.aborted) throw new OpenAiAudioError('ABORTED', 'speech aborted', false, null);
      return { characters: input.text.length };
    },
  };
}
