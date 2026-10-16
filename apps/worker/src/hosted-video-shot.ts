import { spawn } from 'node:child_process';
import { rename, rm, writeFile } from 'node:fs/promises';
import { PaidGenerationFailure, type GenerationKind, type GenerationOffer } from '@ancs/contracts';
import { billedSeconds } from '@ancs/domain';
import { MEDIA_CHILD_ENV, childProcessEnv } from './child-env.js';
import type { GenerationProvider, GenerationProviderInput } from './paid-generation.js';

/**
 * 托管视频生成（Google Veo、火山方舟 Seedance……）共用的"生成镜头"供应商：一次生成 = 提交一次长任务 → 轮询 → 下载 →
 * 统一到项目画布与帧率（等比放大铺满后居中裁切，保留供应商生成的声音）。供应商差异只在 `HostedVideoClient` 里。
 *
 * 计费结局（平台从不自动重试）：
 * - 提交被明确拒绝（4xx，含限流与配额不足）或请求确定没发出去（DNS / 拒绝连接 / 网络白名单拦截）= 没有开始、不扣费；
 *   提交时连接中途断开、超时或 5xx = 不知道是否已开始（结果不明，待对账）；
 * - 任务报错或被供应商安全过滤拦下 = 没有产出，按不扣费处理（以供应商账单为准，接入清单里写明待核对）；
 * - 超时 / 一直查不到状态 = 结果不明；已产出但下载或转换失败 = 已扣费。
 * 供应商不在响应里报告金额 → costMicros 为空，按报价上限结算并标明。
 */

export type HostedVideoState =
  | { done: false }
  | { done: true; videoUri: string; error: null; filtered: null }
  | { done: true; videoUri: null; error: string | null; filtered: string | null };

export interface HostedVideoClient {
  /** 给人看的供应商名（出现在失败说明里），如 Veo、Seedance */
  readonly label: string;
  readonly model: string;
  /** 能做的生成类型（缺省只做生成镜头 VIDEO_SHOT）；选区重绘（VIDEO_REGION）的客户端会拿到被重绘的那段原片 */
  readonly kinds?: readonly GenerationKind[];
  /**
   * 提交生成，返回任务 id；durationSeconds 已按报价依据的档位取好，画面比例由客户端按 width/height 选最接近的一档；
   * sourcePath：选区重绘时被重绘的那段原片（已适配到 width×height），其他类型为 null。
   */
  start(input: { kind: GenerationKind; prompt: string; durationSeconds: number; width: number; height: number; sourcePath: string | null }): Promise<string>;
  poll(job: string): Promise<HostedVideoState>;
  download(uri: string): Promise<Uint8Array>;
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

/** HTTP 错误的状态码（各供应商的错误类都带 status；没有 = 连接层失败） */
const statusOf = (error: unknown): number | null => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
};

export function createHostedVideoShotProvider(options: {
  client: HostedVideoClient;
  offer: GenerationOffer;
  ffmpegPath?: string;
  pollIntervalMs?: number;
  /** 等待供应商完成的上限（缺省 20 分钟）；超时 = 结果不明 */
  renderTimeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
}): GenerationProvider {
  const { client, offer } = options;
  const label = client.label;
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const renderTimeoutMs = options.renderTimeoutMs ?? 20 * 60_000;
  const wait = options.wait ?? sleep;
  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

  return {
    offers: [offer],
    async generate(input: GenerationProviderInput) {
      const kinds = client.kinds ?? ['VIDEO_SHOT'];
      if (!kinds.includes(input.kind) || input.prompt === null || (input.kind === 'VIDEO_REGION' && input.sourcePath === null)) {
        throw new PaidGenerationFailure(`${label} here only handles ${kinds.join(' / ')} with a prompt${kinds.includes('VIDEO_REGION') ? ' and a source clip' : ''}`, 'NOT_CHARGED');
      }
      const durationSeconds = billedSeconds(offer, input.seconds);
      if (durationSeconds > input.maxSeconds + 1e-9) {
        throw new PaidGenerationFailure(`a ${String(durationSeconds)} s ${label} clip is longer than the quoted ${String(input.maxSeconds)} s`, 'NOT_CHARGED');
      }
      // 1. 提交（这一步之后才可能计费）
      let job: string;
      try {
        job = await client.start({ kind: input.kind, prompt: input.prompt, durationSeconds, width: input.width, height: input.height, sourcePath: input.sourcePath });
      } catch (error) {
        // 明确拒绝（4xx）或请求根本没发出去（DNS / 拒绝连接 / 网络白名单拦截）= 没有开始；其余连接失败可能已送达 = 结果不明
        const status = statusOf(error);
        const neverSent = (error as { neverSent?: unknown } | null)?.neverSent === true;
        throw new PaidGenerationFailure(`${label} request failed: ${describe(error)}`, neverSent || (status !== null && status >= 400 && status < 500) ? 'NOT_CHARGED' : 'UNKNOWN');
      }
      // 2. 轮询
      const deadline = Date.now() + renderTimeoutMs;
      let videoUri: string | null = null;
      let pollErrors = 0;
      while (videoUri === null) {
        if (Date.now() > deadline) throw new PaidGenerationFailure(`${label} did not finish within ${String(Math.round(renderTimeoutMs / 60_000))} minutes`, 'UNKNOWN', null, job);
        await wait(pollIntervalMs);
        let state: HostedVideoState;
        try {
          state = await client.poll(job);
          pollErrors = 0;
        } catch (error) {
          pollErrors += 1;
          if (pollErrors >= 5) throw new PaidGenerationFailure(`could not read the ${label} job status: ${describe(error)}`, 'UNKNOWN', null, job);
          continue;
        }
        if (!state.done) continue;
        if (state.videoUri === null) {
          const why = state.filtered === null ? `${label} could not make the video: ${state.error ?? 'unknown reason'}` : `${label} returned no video (${state.filtered})`;
          throw new PaidGenerationFailure(why, 'NOT_CHARGED', null, job);
        }
        videoUri = state.videoUri;
      }
      // 3. 下载（供应商链接是临时的）并统一到项目画布与帧率
      const raw = `${input.outputPath}.provider.mp4`;
      try {
        await writeFile(raw, await client.download(videoUri));
        await runFfmpeg(ffmpeg, [
          '-y', '-i', raw, '-map', '0:v:0', '-map', '0:a:0?',
          '-vf', `scale=${String(input.width)}:${String(input.height)}:force_original_aspect_ratio=increase,crop=${String(input.width)}:${String(input.height)},fps=${String(input.fps)},setsar=1`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
          `${input.outputPath}.part.mp4`,
        ], 300_000);
        await rename(`${input.outputPath}.part.mp4`, input.outputPath);
      } catch (error) {
        throw new PaidGenerationFailure(`fetching the ${label} video failed: ${describe(error)}`, 'CHARGED', null, job);
      } finally {
        await rm(raw, { force: true });
        await rm(`${input.outputPath}.part.mp4`, { force: true });
      }
      return { providerJobId: job, costMicros: null, model: client.model };
    },
  };
}
