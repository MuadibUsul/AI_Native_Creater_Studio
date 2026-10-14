import type { GenerationOffer, NarrationSynthesizer, NarrationVoice, SourceMediaProbe } from '@ancs/contracts';
import type { GeminiSpeech, GeminiVeo } from '@ancs/providers-gemini';
import { createHostedVideoShotProvider, type HostedVideoClient } from './hosted-video-shot.js';
import { createHttpNarrationSynthesizer } from './narration-synthesizer-process.js';
import type { GenerationProvider } from './paid-generation.js';

/**
 * Google Gemini 的媒体能力接到平台端口上：
 *
 * - 讲述配音（ANCS_NARRATION_DRIVER=gemini）：Gemini TTS 模型 + 预置声音，逐句合成；Gemini 没有语速参数，语速由 FFmpeg 统一调整；
 * - 生成镜头（ANCS_VEO_OFFER_JSON）：Veo 文生视频，走共用的托管视频供应商（`hosted-video-shot.ts`：提交一次 → 轮询 → 下载 →
 *   统一到项目画布与帧率；计费结局与不重试规则见那里）。
 * 密钥只在 Worker 内存中使用（GEMINI_API_KEY），只放请求头。
 */

/** Gemini 预置声音（id 为小写声音名，合成时首字母大写）。可用 ANCS_NARRATION_VOICES_JSON 覆盖。 */
export const GEMINI_DEFAULT_VOICES: readonly NarrationVoice[] = [
  { id: 'kore', name: 'Kore', languages: ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de'], description: 'firm, clear voice; good default for explainers' },
  { id: 'charon', name: 'Charon', languages: ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de'], description: 'informative, calm voice; documentaries and tutorials' },
  { id: 'puck', name: 'Puck', languages: ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de'], description: 'upbeat, lively voice; vlogs and entertainment' },
  { id: 'aoede', name: 'Aoede', languages: ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de'], description: 'breezy, light voice; travel and lifestyle' },
];

export const geminiVoiceName = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);

export function createGeminiNarrationSynthesizer(options: { speech: GeminiSpeech; voices?: readonly NarrationVoice[]; probe: SourceMediaProbe; ffmpegPath?: string }): NarrationSynthesizer {
  return createHttpNarrationSynthesizer({
    engine: `gemini:${options.speech.model}`,
    voices: options.voices ?? GEMINI_DEFAULT_VOICES,
    probe: options.probe,
    applySpeed: true,
    ...(options.ffmpegPath === undefined ? {} : { ffmpegPath: options.ffmpegPath }),
    fetchAudio: ({ text, voice }) => options.speech.synthesize({ text, voiceName: geminiVoiceName(voice) }),
  });
}

/** Veo 文生视频接到共用的托管视频供应商上（16:9 / 9:16，720p） */
export function veoVideoClient(veo: GeminiVeo): HostedVideoClient {
  return {
    label: 'Veo',
    model: veo.model,
    start: ({ prompt, durationSeconds, width, height }) => veo.start({ prompt, durationSeconds, aspectRatio: width >= height ? '16:9' : '9:16', resolution: '720p' }),
    poll: (job) => veo.poll(job),
    download: (uri) => veo.download(uri),
  };
}

export function createVeoGenerationProvider(options: {
  veo: GeminiVeo;
  offer: GenerationOffer;
  ffmpegPath?: string;
  pollIntervalMs?: number;
  /** 等待 Veo 完成的上限（缺省 20 分钟）；超时 = 结果不明 */
  renderTimeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
}): GenerationProvider {
  const { veo, ...rest } = options;
  return createHostedVideoShotProvider({ client: veoVideoClient(veo), ...rest });
}
