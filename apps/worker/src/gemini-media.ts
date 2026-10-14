import { spawn } from 'node:child_process';
import { rename, rm, writeFile } from 'node:fs/promises';
import { PaidGenerationFailure, type GenerationOffer, type NarrationSynthesizer, type NarrationVoice, type SourceMediaProbe } from '@ancs/contracts';
import { billedSeconds } from '@ancs/domain';
import { GeminiHttpError, type GeminiSpeech, type GeminiVeo, type VeoOperationState } from '@ancs/providers-gemini';
import { MEDIA_CHILD_ENV, childProcessEnv } from './child-env.js';
import { createHttpNarrationSynthesizer } from './narration-synthesizer-process.js';
import type { GenerationProvider, GenerationProviderInput } from './paid-generation.js';

/**
 * Google Gemini 的媒体能力接到平台端口上：
 *
 * - 讲述配音（ANCS_NARRATION_DRIVER=gemini）：Gemini TTS 模型 + 预置声音，逐句合成；Gemini 没有语速参数，语速由 FFmpeg 统一调整；
 * - 生成镜头（ANCS_VEO_OFFER_JSON）：Veo 文生视频。一次生成 = 提交一次长任务 → 轮询 → 下载 → 统一到项目画布与帧率。
 *   计费结局：提交被明确拒绝（4xx）= 没有开始、不扣费；提交时网络中断或 5xx = 不知道是否已开始（待对账）；
 *   任务报错或被供应商安全过滤拦下 = 没有产出，按不扣费处理（以 Google 账单为准，已写入接入清单待核对）；
 *   超时 / 一直查不到状态 = 结果不明；已产出但下载或转换失败 = 已扣费。平台从不自动重试。
 *   Veo 不在响应里报告费用 → costMicros 为空，按报价上限结算并标明。
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

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function runFfmpeg(ffmpegPath: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-nostdin', '-hide_banner', '-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: childProcessEnv(process.env, MEDIA_CHILD_ENV) });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4_000) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${String(code)}: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`));
    });
  });
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
  const { veo, offer } = options;
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const renderTimeoutMs = options.renderTimeoutMs ?? 20 * 60_000;
  const wait = options.wait ?? sleep;
  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

  return {
    offers: [offer],
    async generate(input: GenerationProviderInput) {
      if (input.kind !== 'VIDEO_SHOT' || input.prompt === null) {
        throw new PaidGenerationFailure('Veo here only makes new shots from a prompt', 'NOT_CHARGED');
      }
      const durationSeconds = billedSeconds(offer, input.seconds);
      if (durationSeconds > input.maxSeconds + 1e-9) {
        throw new PaidGenerationFailure(`a ${String(durationSeconds)} s Veo clip is longer than the quoted ${String(input.maxSeconds)} s`, 'NOT_CHARGED');
      }
      // 1. 提交（这一步之后才可能计费）
      let operation: string;
      try {
        operation = await veo.start({ prompt: input.prompt, durationSeconds, aspectRatio: input.width >= input.height ? '16:9' : '9:16', resolution: '720p' });
      } catch (error) {
        const status = error instanceof GeminiHttpError ? error.status : null;
        throw new PaidGenerationFailure(`Veo request failed: ${describe(error)}`, status !== null && status >= 400 && status < 500 ? 'NOT_CHARGED' : 'UNKNOWN');
      }
      // 2. 轮询
      const deadline = Date.now() + renderTimeoutMs;
      let videoUri: string | null = null;
      let pollErrors = 0;
      while (videoUri === null) {
        if (Date.now() > deadline) throw new PaidGenerationFailure(`Veo did not finish within ${String(Math.round(renderTimeoutMs / 60_000))} minutes`, 'UNKNOWN', null, operation);
        await wait(pollIntervalMs);
        let state: VeoOperationState;
        try {
          state = await veo.poll(operation);
          pollErrors = 0;
        } catch (error) {
          pollErrors += 1;
          if (pollErrors >= 5) throw new PaidGenerationFailure(`could not read the Veo job status: ${describe(error)}`, 'UNKNOWN', null, operation);
          continue;
        }
        if (!state.done) continue;
        if (state.videoUri === null) {
          const why = state.filtered === null ? `Veo could not make the video: ${state.error ?? 'unknown reason'}` : `Veo returned no video (${state.filtered})`;
          throw new PaidGenerationFailure(why, 'NOT_CHARGED', null, operation);
        }
        videoUri = state.videoUri;
      }
      // 3. 下载（供应商链接是临时的）并统一到项目画布与帧率：等比放大铺满后居中裁切，保留 Veo 生成的声音
      const raw = `${input.outputPath}.veo.mp4`;
      try {
        await writeFile(raw, await veo.download(videoUri));
        await runFfmpeg(ffmpeg, [
          '-y', '-i', raw, '-map', '0:v:0', '-map', '0:a:0?',
          '-vf', `scale=${String(input.width)}:${String(input.height)}:force_original_aspect_ratio=increase,crop=${String(input.width)}:${String(input.height)},fps=${String(input.fps)},setsar=1`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
          `${input.outputPath}.part.mp4`,
        ], 300_000);
        await rename(`${input.outputPath}.part.mp4`, input.outputPath);
      } catch (error) {
        throw new PaidGenerationFailure(`fetching the Veo video failed: ${describe(error)}`, 'CHARGED', null, operation);
      } finally {
        await rm(raw, { force: true });
        await rm(`${input.outputPath}.part.mp4`, { force: true });
      }
      return { providerJobId: operation, costMicros: null, model: veo.model };
    },
  };
}
