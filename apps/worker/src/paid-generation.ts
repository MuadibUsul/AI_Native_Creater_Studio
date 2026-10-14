import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PaidGenerationFailure,
  type FrameRegion,
  type GenerationKind,
  type GenerationOffer,
  type ObjectStorageAdapter,
  type PaidGenerationExecutor,
  type PaidGenerationJob,
  type SourceMediaProbe,
} from '@ancs/contracts';
import { MEDIA_CHILD_ENV, childProcessEnv } from './child-env.js';

/**
 * V6-7 / V6-8 付费生成的 Worker 端（执行器 + 供应商适配）。
 *
 * 执行器（与供应商无关）：把参考素材从自有存储取到临时目录（照片、声音样本；选区重绘时按源时间裁出被重绘的片段，
 * 适配到生成画布）→ 调用供应商**一次** → 读回产物并真实探测 → 选区重绘时测量圈外画面变化 → 交回领域层入库。
 *
 * 供应商：
 * - process：部署方接入的生成子进程（任意供应商）。协议：stdin 一行 JSON（见 `GenerationProviderInput`），
 *   子进程把视频写到 `outputPath`；退出码 0 = 成功（stdout 最后一行 JSON `{providerJobId, costMicros, model}`），
 *   2 = 失败（stdout 最后一行 JSON `{error, costMicros?, providerJobId?}`；costMicros > 0 表示失败但已扣费），
 *   其他退出码 / 超时 / 崩溃 = 结果不明（待对账，不会重试）。子进程只继承白名单环境变量 + 部署方声明要传的变量。
 * - scripted：FFmpeg 测试替身（SCRIPTED，只用于测试与演示；不会由环境变量装配进生产）。
 */

export interface GenerationProviderInput {
  kind: GenerationKind;
  prompt: string | null;
  script: string | null;
  language: string | null;
  seconds: number;
  maxSeconds: number;
  width: number;
  height: number;
  fps: number;
  outputPath: string;
  likenessPath: string | null;
  voicePath: string | null;
  /** 选区重绘：被重绘的片段（已适配到 width×height、fps，无声） */
  sourcePath: string | null;
  region: FrameRegion | null;
}

export interface GenerationProviderResult {
  providerJobId: string | null;
  costMicros: number | null;
  model: string;
}

export interface GenerationProvider {
  readonly offers: readonly GenerationOffer[];
  generate(input: GenerationProviderInput): Promise<GenerationProviderResult>;
}

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function runProcess(command: string, args: readonly string[], options: { input?: string; timeoutMs: number; env: NodeJS.ProcessEnv; maxOutput?: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: options.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const limit = options.maxOutput ?? 1024 * 1024;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < limit) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8_000) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`${path.basename(command)} could not start: ${error.message}`)); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
}

const tail = (text: string): string => text.trim().split('\n').slice(-2).join(' ').slice(0, 300);

async function ffmpeg(ffmpegPath: string, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  const result = await runProcess(ffmpegPath, ['-nostdin', '-hide_banner', '-v', 'error', ...args], { timeoutMs, env: childProcessEnv(process.env, MEDIA_CHILD_ENV), maxOutput: 8 * 1024 * 1024 });
  if (result.timedOut) throw new Error('ffmpeg timed out');
  if (result.code !== 0) throw new Error(`ffmpeg exited with ${String(result.code)}: ${tail(result.stderr)}`);
  return result;
}

const extensionFor = (mimeType: string): string => {
  const sub = mimeType.split('/')[1]?.split(';')[0]?.trim() ?? 'bin';
  return ({ jpeg: 'jpg', 'x-wav': 'wav', 'wave': 'wav', mpeg: 'mp3', quicktime: 'mov' } as Record<string, string>)[sub] ?? (/^[a-z0-9]{1,8}$/.test(sub) ? sub : 'bin');
};

async function fetchTo(storage: ObjectStorageAdapter, key: string, destination: string): Promise<string> {
  if (storage.materializeObject !== undefined) {
    await storage.materializeObject({ key, destinationPath: destination });
    return destination;
  }
  const bytes = await storage.getObject(key);
  if (bytes === null) throw new Error('a reference file is missing from storage');
  await writeFile(destination, bytes);
  return destination;
}

/** 选区重绘的源片段：按源时间裁出，适配到生成画布（等比缩放 + 补边，不拉伸），固定帧率，无声。 */
async function cutSource(ffmpegPath: string, input: { file: string; start: string; end: string; width: number; height: number; fps: number; output: string }): Promise<void> {
  const length = Math.max(0.04, Number(input.end) - Number(input.start)).toFixed(6);
  await ffmpeg(ffmpegPath, [
    '-y', '-ss', input.start, '-i', input.file, '-t', length,
    '-vf', `scale=${String(input.width)}:${String(input.height)}:force_original_aspect_ratio=decrease,pad=${String(input.width)}:${String(input.height)}:(ow-iw)/2:(oh-ih)/2,fps=${String(input.fps)},format=yuv420p`,
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', input.output,
  ], 300_000);
}

/**
 * 圈外平均像素差（0–255）：两段画面转灰度逐帧求差，圈内涂黑，统计平均亮度后换算为圈外的平均差。
 * FFmpeg 的 signalstats 读的是有限范围亮度（黑 = 16），这里换回全范围。
 */
export async function measureOutsideRegionChange(ffmpegPath: string, input: { sourcePath: string; outputPath: string; region: FrameRegion; width: number; height: number; fps: number }): Promise<number> {
  const area = Math.min(1, input.region.width * input.region.height);
  if (area >= 0.999) return 0;
  const box = {
    x: Math.round(input.region.x * input.width), y: Math.round(input.region.y * input.height),
    w: Math.round(input.region.width * input.width), h: Math.round(input.region.height * input.height),
  };
  const scale = `scale=${String(input.width)}:${String(input.height)},fps=${String(input.fps)},format=gray,setpts=PTS-STARTPTS`;
  const result = await ffmpeg(ffmpegPath, [
    '-i', input.sourcePath, '-i', input.outputPath,
    '-filter_complex', `[0:v]${scale}[a];[1:v]${scale}[b];[a][b]blend=all_mode=difference:shortest=1,format=yuv420p,drawbox=x=${String(box.x)}:y=${String(box.y)}:w=${String(box.w)}:h=${String(box.h)}:color=black:t=fill,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`,
    '-f', 'null', '-',
  ], 300_000);
  const values = [...result.stdout.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((match) => Number(match[1]));
  if (values.length === 0) throw new Error('could not compare the generated video with the source');
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const full = Math.max(0, ((mean - 16) * 255) / 219);
  return Math.round((full / (1 - area)) * 100) / 100;
}

/** 与供应商无关的执行器：取参考 → 调用一次 → 读回、探测、测量。 */
export function createPaidGenerationExecutor(options: { provider: GenerationProvider; storage: ObjectStorageAdapter; probe: SourceMediaProbe; ffmpegPath?: string; workRoot?: string }): PaidGenerationExecutor {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  return {
    offers: () => options.provider.offers,
    async execute(job: PaidGenerationJob, hooks) {
      const dir = await mkdtemp(path.join(options.workRoot ?? os.tmpdir(), 'ancs-gen-'));
      try {
        const fps = job.frameRate.num / job.frameRate.den;
        const likenessPath = job.likeness === null ? null : await fetchTo(options.storage, job.likeness.storageKey, path.join(dir, `likeness.${extensionFor(job.likeness.mimeType)}`));
        const voicePath = job.voice === null ? null : await fetchTo(options.storage, job.voice.storageKey, path.join(dir, `voice.${extensionFor(job.voice.mimeType)}`));
        let sourcePath: string | null = null;
        if (job.source !== null) {
          const original = await fetchTo(options.storage, job.source.storageKey, path.join(dir, `original.${extensionFor(job.source.mimeType)}`));
          sourcePath = path.join(dir, 'source.mp4');
          await cutSource(ffmpegPath, { file: original, start: job.source.startSeconds, end: job.source.endSeconds, width: job.width, height: job.height, fps, output: sourcePath });
        }
        const outputPath = path.join(dir, 'output.mp4');
        await hooks.beforeProviderCall();
        const result = await options.provider.generate({
          kind: job.kind, prompt: job.prompt, script: job.script, language: job.language, seconds: job.seconds, maxSeconds: job.maxSeconds,
          width: job.width, height: job.height, fps, outputPath, likenessPath, voicePath, sourcePath, region: job.region,
        });
        const video = await readFile(outputPath).catch(() => null);
        if (video === null || video.byteLength === 0) {
          throw new PaidGenerationFailure('the provider reported success but wrote no video', 'CHARGED', result.costMicros, result.providerJobId);
        }
        const probe = await options.probe.probe({ filePath: outputPath, declaredMimeType: 'video/mp4' });
        const videoStream = probe.streams.find((stream) => stream.type === 'VIDEO');
        const durationMs = probe.durationMs ?? videoStream?.durationMs ?? 0;
        if (probe.status !== 'READY' || videoStream === undefined || durationMs <= 0) {
          throw new PaidGenerationFailure('the generated file is not a decodable video', 'CHARGED', result.costMicros, result.providerJobId);
        }
        const outsideRegionChange = job.region !== null && sourcePath !== null
          ? await measureOutsideRegionChange(ffmpegPath, { sourcePath, outputPath, region: job.region, width: job.width, height: job.height, fps })
          : null;
        const quicktime = probe.formatNames.includes('mov') && !probe.formatNames.includes('mp4');
        return {
          video: new Uint8Array(video), mimeType: quicktime ? 'video/quicktime' : 'video/mp4', probe, durationMs,
          hasAudio: probe.streams.some((stream) => stream.type === 'AUDIO'),
          providerJobId: result.providerJobId, costMicros: result.costMicros, model: result.model, outsideRegionChange,
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/** 本部署没有配置生成供应商：没有报价依据；万一有运行到达（供应商在报价后被移除），明确失败且不扣费。 */
export const UNCONFIGURED_GENERATION_EXECUTOR: PaidGenerationExecutor = {
  offers: () => [],
  execute: () => Promise.reject(new PaidGenerationFailure('no generation provider is configured in this deployment', 'NOT_CHARGED')),
};

// ---------------------------------------------------------------------------
// 供应商：部署方接入的生成子进程
// ---------------------------------------------------------------------------

const lastJsonLine = (stdout: string): Record<string, unknown> | null => {
  const lines = stdout.trim().split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'));
  const line = lines.at(-1);
  if (line === undefined) return null;
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
};
const microsOf = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);
const textOf = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value.slice(0, 200) : null);

export function createProcessGenerationProvider(options: { executable: string; args?: readonly string[]; offers: readonly GenerationOffer[]; timeoutMs?: number; passEnv?: readonly string[] }): GenerationProvider {
  const timeoutMs = options.timeoutMs ?? 1_200_000;
  const env = childProcessEnv(process.env, { keys: [...(MEDIA_CHILD_ENV.keys ?? []), ...(options.passEnv ?? [])], prefixes: MEDIA_CHILD_ENV.prefixes ?? [] });
  return {
    offers: options.offers,
    async generate(input) {
      const offer = options.offers.find((item) => item.kind === input.kind);
      let result: RunResult;
      try {
        result = await runProcess(options.executable, options.args ?? [], { input: `${JSON.stringify(input)}\n`, timeoutMs, env });
      } catch (error) {
        // 进程没能启动：供应商没有被调用
        throw new PaidGenerationFailure(error instanceof Error ? error.message : String(error), 'NOT_CHARGED');
      }
      const reported = lastJsonLine(result.stdout);
      if (result.timedOut) throw new PaidGenerationFailure(`the generation process timed out after ${String(Math.round(timeoutMs / 1000))} s`, 'UNKNOWN');
      if (result.code === 0) {
        return { providerJobId: textOf(reported?.['providerJobId']), costMicros: microsOf(reported?.['costMicros']), model: textOf(reported?.['model']) ?? offer?.model ?? 'unknown' };
      }
      if (result.code === 2) {
        const cost = microsOf(reported?.['costMicros']);
        const message = textOf(reported?.['error']) ?? (tail(result.stderr) || 'the provider refused the request');
        throw new PaidGenerationFailure(message, cost !== null && cost > 0 ? 'CHARGED' : 'NOT_CHARGED', cost, textOf(reported?.['providerJobId']));
      }
      throw new PaidGenerationFailure(`the generation process exited with ${String(result.code)}: ${tail(result.stderr)}`, 'UNKNOWN', null, textOf(reported?.['providerJobId']));
    },
  };
}

// ---------------------------------------------------------------------------
// 测试替身：FFmpeg 生成（SCRIPTED）
// ---------------------------------------------------------------------------

/** 测试替身的报价依据（价格取 V6 §10.1 的规划区间，只用于测试与演示）。 */
export const SCRIPTED_GENERATION_OFFERS: readonly GenerationOffer[] = [
  { kind: 'AVATAR_CLIP', providerId: 'scripted-avatar', implementation: 'SCRIPTED', model: 'ffmpeg-still-flite', perSecondMicros: { min: 35_000, max: 100_000 }, maxSeconds: 20, languages: ['en'] },
  { kind: 'VIDEO_SHOT', providerId: 'scripted-video', implementation: 'SCRIPTED', model: 'ffmpeg-gradients', perSecondMicros: { min: 50_000, max: 400_000 }, maxSeconds: 8, languages: [] },
  { kind: 'VIDEO_REGION', providerId: 'scripted-video', implementation: 'SCRIPTED', model: 'ffmpeg-region-hue', perSecondMicros: { min: 50_000, max: 400_000 }, maxSeconds: 8, languages: [] },
];

export type ScriptedGenerationBehavior = 'normal' | 'touch-outside' | 'fail-not-charged' | 'fail-unknown' | 'omit-cost';

/**
 * FFmpeg 测试替身：数字人 = 参考照片 + flite 读讲稿（英文）；生成镜头 = 程序化渐变；选区重绘 = 圈内调色、圈外原样。
 * 行为可切换以覆盖失败、结果不明、圈外被改、没报告费用等分支。它不是供应商，只验证流程。
 */
export function createScriptedGenerationProvider(options: { ffmpegPath?: string; ffprobePath?: string; behavior?: () => ScriptedGenerationBehavior; offers?: readonly GenerationOffer[] } = {}): GenerationProvider {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  const offers = options.offers ?? SCRIPTED_GENERATION_OFFERS;
  return {
    offers,
    async generate(input) {
      const behavior = options.behavior?.() ?? 'normal';
      if (behavior === 'fail-not-charged') throw new PaidGenerationFailure('scripted provider refused the request', 'NOT_CHARGED');
      if (behavior === 'fail-unknown') throw new PaidGenerationFailure('scripted provider timed out', 'UNKNOWN', null, `scripted-${randomUUID()}`);
      const size = `${String(input.width)}x${String(input.height)}`;
      const fit = `scale=${String(input.width)}:${String(input.height)}:force_original_aspect_ratio=decrease,pad=${String(input.width)}:${String(input.height)}:(ow-iw)/2:(oh-ih)/2:color=0x1f2937,fps=${String(input.fps)},format=yuv420p`;
      let seconds = input.seconds;
      if (input.kind === 'AVATAR_CLIP') {
        if (input.likenessPath === null || input.script === null) throw new PaidGenerationFailure('missing likeness or script', 'NOT_CHARGED');
        const scriptFile = `${input.outputPath}.txt`;
        await writeFile(scriptFile, input.script.replace(/\s+/g, ' '), 'utf8');
        const voiceFile = `${input.outputPath}.wav`;
        await ffmpeg(ffmpegPath, ['-y', '-f', 'lavfi', '-i', `flite=textfile='${scriptFile.replace(/'/g, "'\\''")}':voice=slt`, '-ar', '48000', '-ac', '2', voiceFile], 120_000);
        await ffmpeg(ffmpegPath, [
          '-y', '-loop', '1', '-i', input.likenessPath, '-i', voiceFile, '-vf', fit, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage',
          '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', input.outputPath,
        ], 300_000);
        const probe = await runProcess(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input.outputPath], { timeoutMs: 60_000, env: childProcessEnv(process.env, MEDIA_CHILD_ENV) });
        seconds = Number(probe.stdout.trim()) || input.seconds;
      } else if (input.kind === 'VIDEO_SHOT') {
        const seed = Number.parseInt(createHash('sha256').update(input.prompt ?? '').digest('hex').slice(0, 6), 16);
        await ffmpeg(ffmpegPath, [
          '-y', '-f', 'lavfi', '-i', `gradients=s=${size}:r=${String(input.fps)}:d=${input.seconds.toFixed(3)}:seed=${String(seed)}:speed=0.02`,
          '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart', input.outputPath,
        ], 300_000);
      } else {
        if (input.sourcePath === null || input.region === null) throw new PaidGenerationFailure('missing source or region', 'NOT_CHARGED');
        const box = {
          x: Math.round(input.region.x * input.width / 2) * 2, y: Math.round(input.region.y * input.height / 2) * 2,
          w: Math.max(2, Math.round(input.region.width * input.width / 2) * 2), h: Math.max(2, Math.round(input.region.height * input.height / 2) * 2),
        };
        const inside = `[0:v]split[a][b];[b]crop=${String(box.w)}:${String(box.h)}:${String(box.x)}:${String(box.y)},hue=h=140:s=1.6[r];[a][r]overlay=${String(box.x)}:${String(box.y)}`;
        await ffmpeg(ffmpegPath, [
          '-y', '-i', input.sourcePath, '-filter_complex', behavior === 'touch-outside' ? `${inside},eq=brightness=0.1` : inside,
          '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-movflags', '+faststart', input.outputPath,
        ], 300_000);
      }
      const offer = offers.find((item) => item.kind === input.kind);
      const perSecond = offer === undefined ? 0 : (offer.perSecondMicros.min + offer.perSecondMicros.max) / 2;
      return {
        providerJobId: `scripted-${randomUUID()}`,
        costMicros: behavior === 'omit-cost' ? null : Math.round(seconds * perSecond),
        model: offer?.model ?? 'scripted',
      };
    },
  };
}
