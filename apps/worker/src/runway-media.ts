import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import type { GenerationOffer } from '@ancs/contracts';
import { RunwayHttpError, nearestRunwayRatio, type RunwayAleph } from '@ancs/providers-runway';
import { MEDIA_CHILD_ENV, childProcessEnv } from './child-env.js';
import { createHostedVideoShotProvider, type HostedVideoClient } from './hosted-video-shot.js';
import type { GenerationProvider } from './paid-generation.js';

/**
 * Runway 选区重绘（ANCS_RUNWAY_OFFER_JSON + RUNWAYML_API_SECRET）：执行器已按源时间裁出被重绘的那一段原片并适配到生成画布；
 * 这里把它压成小体积（长边 ≤ 1280、去掉声音）以 data URI 交给 gen4_aleph，连同一句提示词；成片走共用的托管视频供应商
 * （轮询 → 下载 → 统一画布与帧率；计费结局与不重试规则见 `hosted-video-shot.ts`），之后执行器只取框内并测量框外变化。
 * 压缩后仍超过上限时**不提交**（不扣费）。
 */

/** data URI 的原片上限（字节）：保守取值，以 Runway 文档为准 */
export const RUNWAY_DEFAULT_MAX_SOURCE_BYTES = 12 * 1024 * 1024;

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

export function runwayRegionClient(aleph: RunwayAleph, options: { ffmpegPath?: string; maxSourceBytes?: number } = {}): HostedVideoClient {
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const maxSourceBytes = options.maxSourceBytes ?? RUNWAY_DEFAULT_MAX_SOURCE_BYTES;
  return {
    label: 'Runway',
    model: aleph.model,
    kinds: ['VIDEO_REGION'],
    async start({ prompt, width, height, sourcePath }) {
      if (sourcePath === null) throw new RunwayHttpError('Runway region repaint needs the source clip', null, null, true);
      const upload = `${sourcePath}.runway.mp4`;
      try {
        await runFfmpeg(ffmpeg, [
          '-y', '-i', sourcePath, '-map', '0:v:0', '-an',
          '-vf', "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))'",
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', upload,
        ], 180_000);
        const bytes = await readFile(upload);
        if (bytes.byteLength > maxSourceBytes) {
          throw new RunwayHttpError(`the source clip is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB after compression, over the ${(maxSourceBytes / 1024 / 1024).toFixed(0)} MB limit; select a shorter range`, null, null, true);
        }
        return await aleph.start({ promptText: prompt, videoUri: `data:video/mp4;base64,${bytes.toString('base64')}`, ratio: nearestRunwayRatio(width, height) });
      } catch (error) {
        // 本地准备原片失败（还没调用 Runway）同样确定没有发出请求
        if (error instanceof RunwayHttpError) throw error;
        throw new RunwayHttpError(`preparing the source clip failed: ${error instanceof Error ? error.message : String(error)}`, null, null, true);
      } finally {
        await rm(upload, { force: true });
      }
    },
    poll: async (job) => {
      const state = await aleph.poll(job);
      if (!state.done) return { done: false };
      return state.videoUri === null
        ? { done: true, videoUri: null, error: state.error, filtered: state.filtered }
        : { done: true, videoUri: state.videoUri, error: null, filtered: null };
    },
    download: (uri) => aleph.download(uri),
  };
}

export function createRunwayRegionProvider(options: {
  aleph: RunwayAleph;
  offer: GenerationOffer;
  ffmpegPath?: string;
  maxSourceBytes?: number;
  pollIntervalMs?: number;
  renderTimeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
}): GenerationProvider {
  const { aleph, maxSourceBytes, ...rest } = options;
  return createHostedVideoShotProvider({
    client: runwayRegionClient(aleph, { ...(options.ffmpegPath === undefined ? {} : { ffmpegPath: options.ffmpegPath }), ...(maxSourceBytes === undefined ? {} : { maxSourceBytes }) }),
    ...rest,
  });
}
