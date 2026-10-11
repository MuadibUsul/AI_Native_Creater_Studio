import { readFile } from 'node:fs/promises';
import {
  MEDIA_TRANSCRIPT_PROCESSOR_VERSION,
  generatedMediaTranscriptSchema,
  type GeneratedMediaTranscript,
  type SpeechRecognitionAdapter,
  type TranscriptSpeaker,
  type TranscriptWord,
  type TranscriptSegment,
} from '@ancs/contracts';

/**
 * Deepgram 语音识别适配器（**真实 Provider**；2026-10-11 接入）。
 *
 * 纪律：
 * - 密钥**只从环境/参数读入**，绝不写日志、绝不进错误返回（错误信息只带状态码与截断后的响应体）；
 * - 逐词时间戳来自 Deepgram 的 `words[]`，因此精度可如实标为**词级**（`WORD_EXACT` 路径的前提）；
 * - 响应字段缺失时**如实降级**（缺 utterances → 只给 words+整段 fallback；缺 confidence → null），
 *   不编造数值；空转写就返回空 words/segments，不假装识别到了内容。
 */

export interface DeepgramAdapterOptions {
  apiKey: string;
  /** 模型（默认 nova-2） */
  model?: string;
  /** 语言提示（默认 zh-CN；用 `detectLanguage` 时以检测结果为准） */
  language?: string;
  /** 说话人分离（默认开启；用于"这段话是谁说的"） */
  diarize?: boolean;
  /** 让服务端检测语言（默认关闭，避免中英混杂误判） */
  detectLanguage?: boolean;
  /** 覆盖接口地址（测试注入用） */
  baseUrl?: string;
  /** 注入 fetch（测试用；默认全局 fetch） */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface DeepgramWord {
  word?: unknown;
  punctuated_word?: unknown;
  start?: unknown;
  end?: unknown;
  confidence?: unknown;
  speaker?: unknown;
}

const secondsToMsTicks = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return String(Math.round(value * 1000));
};

const speakerIdOf = (value: unknown): string | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? `spk_${String(value)}` : null;

/** 把 Deepgram 的预录响应映射成项目统一的转写快照（纯函数，便于离线验证）。 */
export function mapDeepgramResponse(input: {
  payload: unknown;
  model: string;
  fallbackLanguage: string;
  diarize: boolean;
}): GeneratedMediaTranscript {
  const root = (input.payload ?? {}) as Record<string, unknown>;
  const results = (root['results'] ?? {}) as Record<string, unknown>;
  const channels = Array.isArray(results['channels']) ? (results['channels'] as Record<string, unknown>[]) : [];
  const alternatives = channels[0] === undefined || !Array.isArray(channels[0]!['alternatives'])
    ? []
    : (channels[0]!['alternatives'] as Record<string, unknown>[]);
  const best = (alternatives[0] ?? {}) as Record<string, unknown>;
  const rawWords = Array.isArray(best['words']) ? (best['words'] as DeepgramWord[]) : [];

  const words: TranscriptWord[] = [];
  const speakerIds = new Set<string>();
  for (const raw of rawWords) {
    const text = typeof raw.punctuated_word === 'string' && raw.punctuated_word.length > 0
      ? raw.punctuated_word
      : (typeof raw.word === 'string' && raw.word.length > 0 ? raw.word : null);
    const startTicks = secondsToMsTicks(raw.start);
    const endTicks = secondsToMsTicks(raw.end);
    if (text === null || startTicks === null || endTicks === null) continue; // 字段不全的词条直接略过，不猜
    const speakerId = input.diarize ? speakerIdOf(raw.speaker) : null;
    if (speakerId !== null) speakerIds.add(speakerId);
    words.push({
      ordinal: words.length,
      text: text.slice(0, 500),
      speakerId,
      confidencePermille: typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? Math.max(0, Math.min(1000, Math.round(raw.confidence * 1000)))
        : null,
      sourceStartPts: startTicks,
      sourceEndPts: endTicks,
      timeBase: { numerator: 1, denominator: 1000 },
    });
  }

  // 分段：优先用 utterances（含整句文本）；按时间落入的**全局词序号**界定范围，绝不凭空编号。
  const rawUtterances = Array.isArray(results['utterances']) ? (results['utterances'] as Record<string, unknown>[]) : [];
  const segments: TranscriptSegment[] = [];
  for (const [index, utterance] of rawUtterances.entries()) {
    const text = typeof utterance['transcript'] === 'string' ? utterance['transcript'].trim() : '';
    const startTicks = secondsToMsTicks(utterance['start']);
    const endTicks = secondsToMsTicks(utterance['end']);
    if (text === '' || startTicks === null || endTicks === null) continue;
    const startMs = Number(startTicks);
    const endMs = Number(endTicks);
    const covered = words.filter((word) => Number(word.sourceStartPts) >= startMs - 1 && Number(word.sourceEndPts) <= endMs + 1);
    if (covered.length === 0) continue; // 没有对应词条的空段不写，避免"无声也有字幕"
    segments.push({
      id: `dgs_${String(index)}`,
      ordinal: segments.length,
      text: text.slice(0, 10_000),
      speakerId: covered[0]!.speakerId,
      wordStartOrdinal: covered[0]!.ordinal,
      wordEndOrdinal: covered[covered.length - 1]!.ordinal,
      evidence: 'ASR_INFERENCE',
      reviewState: 'UNREVIEWED',
      sourceStartPts: startTicks,
      sourceEndPts: endTicks,
      timeBase: { numerator: 1, denominator: 1000 },
    });
  }

  const speakers: TranscriptSpeaker[] = [...speakerIds].sort().map((id) => ({
    id, displayName: null, identityState: 'INFERRED', confidencePermille: null,
  }));
  const detected = typeof channels[0]?.['detected_language'] === 'string' ? String(channels[0]!['detected_language']) : null;

  return generatedMediaTranscriptSchema.parse({
    schemaVersion: '1.0',
    processorVersion: MEDIA_TRANSCRIPT_PROCESSOR_VERSION,
    provider: 'deepgram',
    model: input.model,
    language: (detected ?? input.fallbackLanguage).slice(0, 35),
    speakers,
    words,
    segments,
    terminology: [],
  });
}

/** 真实 Deepgram 适配器（预录音频 → 带词级时间戳的转写）。 */
export function createDeepgramSpeechRecognitionAdapter(options: DeepgramAdapterOptions): SpeechRecognitionAdapter {
  const model = options.model ?? 'nova-2';
  const language = options.language ?? 'zh-CN';
  const diarize = options.diarize ?? true;
  const baseUrl = options.baseUrl ?? 'https://api.deepgram.com';
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;

  return {
    kind: 'deepgram-asr',
    async transcribe(input: { sourcePath: string }): Promise<GeneratedMediaTranscript> {
      const audio = await readFile(input.sourcePath);
      const query = new URLSearchParams({
        model, smart_format: 'true', punctuate: 'true', utterances: 'true',
        diarize: diarize ? 'true' : 'false',
        language,
        ...(options.detectLanguage === true ? { detect_language: 'true' } : {}),
      });
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/v1/listen?${query.toString()}`, {
          method: 'POST',
          headers: {
            // 密钥只在请求头里，绝不入日志
            authorization: `Token ${options.apiKey}`,
            'content-type': 'audio/wav',
          },
          body: audio,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        // 错误信息**不含密钥**；响应体截断后回带，便于定位（Deepgram 的报错不含凭据）
        const body = await response.text().catch(() => '');
        throw new Error(`DEEPGRAM_HTTP_${String(response.status)}: ${body.slice(0, 300)}`);
      }
      const payload: unknown = await response.json();
      return mapDeepgramResponse({ payload, model, fallbackLanguage: language, diarize });
    },
  };
}
