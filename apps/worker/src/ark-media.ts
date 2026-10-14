import type { GenerationOffer } from '@ancs/contracts';
import { nearestSeedanceRatio, type Seedance } from '@ancs/providers-ark';
import { createHostedVideoShotProvider, type HostedVideoClient } from './hosted-video-shot.js';
import type { GenerationProvider } from './paid-generation.js';

/**
 * 火山方舟 Seedance 生成镜头（ANCS_SEEDANCE_OFFER_JSON + ARK_API_KEY）：走共用的托管视频供应商
 * （提交一次 → 轮询 → 下载 → 统一到项目画布与帧率；计费结局与不重试规则见 `hosted-video-shot.ts`）。
 * 画面比例按项目画布取 Seedance 支持的最接近一档；时长按报价依据的整数秒档位；缺省同时生成声音。
 */
export function seedanceVideoClient(seedance: Seedance, options: { generateAudio?: boolean; resolution?: string } = {}): HostedVideoClient {
  return {
    label: 'Seedance',
    model: seedance.model,
    start: ({ prompt, durationSeconds, width, height }) => seedance.start({
      prompt,
      durationSeconds,
      ratio: nearestSeedanceRatio(width, height),
      generateAudio: options.generateAudio ?? true,
      ...(options.resolution === undefined ? {} : { resolution: options.resolution }),
    }),
    poll: async (job) => {
      const state = await seedance.poll(job);
      if (!state.done) return { done: false };
      return state.videoUri === null
        ? { done: true, videoUri: null, error: state.error, filtered: state.filtered }
        : { done: true, videoUri: state.videoUri, error: null, filtered: null };
    },
    download: (uri) => seedance.download(uri),
  };
}

export function createSeedanceGenerationProvider(options: {
  seedance: Seedance;
  offer: GenerationOffer;
  generateAudio?: boolean;
  resolution?: string;
  ffmpegPath?: string;
  pollIntervalMs?: number;
  renderTimeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
}): GenerationProvider {
  const { seedance, generateAudio, resolution, ...rest } = options;
  return createHostedVideoShotProvider({
    client: seedanceVideoClient(seedance, { ...(generateAudio === undefined ? {} : { generateAudio }), ...(resolution === undefined ? {} : { resolution }) }),
    ...rest,
  });
}
