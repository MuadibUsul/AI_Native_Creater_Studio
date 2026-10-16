import { spawn } from 'node:child_process';
import { referenceMeasurementSchema, type ReferenceAnalyzer, type ReferenceMeasurement } from '@ancs/contracts';
import { detectBeats } from '@ancs/domain';
import { MEDIA_CHILD_ENV, childProcessEnv } from './child-env.js';

/**
 * 参考视频分析（V6-6 蒸馏器；FFmpeg 子进程，确定性测量，无模型、无网络）：
 * - 画面一遍：缩到 160 宽，逐帧场景变化分数（剪点 = 分数 > 0.3，与镜头索引同一阈值）+ signalstats 色彩统计；
 * - 黑场：blackdetect（淡入淡出到黑的过渡）；
 * - 声音：ebur128 综合响度与响度范围、silencedetect 静音占比、11.025 kHz 单声道 PCM → 节拍检测（domain 纯函数）。
 * 子进程只继承白名单环境变量；每个子进程有硬超时与输出上限。超过分析上限的部分不分析（如实记录 analyzedSeconds）。
 */

export interface FfmpegReferenceAnalyzerOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
}

const SCENE_CUT_THRESHOLD = 0.3;
const MIN_CUT_GAP_SECONDS = 0.2;
const PCM_RATE = 11025;

interface Run { code: number | null; stdout: Buffer; stderr: string }

function run(executable: string, args: string[], timeoutMs: number, maxStdoutBytes = 256 * 1024 * 1024): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: childProcessEnv(process.env, MEDIA_CHILD_ENV), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let settled = false;
    const finish = (error: Error | null, value?: Run) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== null) { child.kill('SIGKILL'); reject(error); } else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(`参考视频分析超时（${String(timeoutMs)}ms）`)), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxStdoutBytes) { finish(new Error('参考视频分析输出超过上限')); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-200_000); });
    child.on('error', (error) => finish(new Error(`媒体工具启动失败：${error.message}`)));
    child.on('close', (code) => finish(null, { code, stdout: Buffer.concat(chunks), stderr }));
  });
}

const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const round = (value: number, digits = 3): number => Math.round(value * 10 ** digits) / 10 ** digits;

function rational(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const [num, den] = text.split('/').map(Number);
  if (num === undefined || !Number.isFinite(num)) return null;
  const value = den === undefined ? num : den === 0 ? NaN : num / den;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** 解析 `metadata=mode=print` 的逐帧输出。 */
export function parseFrameMetadata(text: string): { time: number; values: Record<string, number> }[] {
  const frames: { time: number; values: Record<string, number> }[] = [];
  let current: { time: number; values: Record<string, number> } | null = null;
  for (const line of text.split('\n')) {
    const header = /pts_time:([\d.]+)/.exec(line);
    if (line.startsWith('frame:') && header !== null) {
      current = { time: Number(header[1]), values: {} };
      frames.push(current);
      continue;
    }
    const pair = /^lavfi\.(?:signalstats\.)?([A-Za-z_]+)=([-\d.]+)/.exec(line.trim());
    if (current !== null && pair !== null) current.values[pair[1]!] = Number(pair[2]);
  }
  return frames;
}

/** 剪点：场景分数超过阈值的帧（相邻剪点至少相隔 0.2 秒，取分数更高的那个）。 */
export function cutsFromScenes(frames: readonly { time: number; values: Record<string, number> }[]): { cuts: number[]; activity: number | null } {
  const cuts: { time: number; score: number }[] = [];
  const calm: number[] = [];
  for (const frame of frames) {
    const score = frame.values['scene_score'] ?? 0;
    if (frame.time > 0.05 && score > SCENE_CUT_THRESHOLD) {
      const last = cuts.at(-1);
      if (last !== undefined && frame.time - last.time < MIN_CUT_GAP_SECONDS) {
        if (score > last.score) cuts[cuts.length - 1] = { time: frame.time, score };
      } else cuts.push({ time: frame.time, score });
    } else if (frame.time > 0.05) calm.push(score);
  }
  const activity = mean(calm);
  return { cuts: cuts.map((cut) => round(cut.time)), activity: activity === null ? null : round(clamp(activity * 10, 0, 1)) };
}

/**
 * 黑场过渡：blackdetect 找到的近黑段里，排除片头片尾，以及两端都是硬切的段（那是一个暗镜头，不是淡入淡出过渡）。
 */
export function blackDipTransitions(stderr: string, cuts: readonly number[], analyzedSeconds: number): { start: number; end: number }[] {
  const nearCut = (time: number) => cuts.some((cut) => Math.abs(cut - time) <= 0.1);
  return [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)]
    .map((match) => ({ start: round(Number(match[1])), end: round(Number(match[2])) }))
    .filter((dip) => dip.start > 0.05 && dip.end < analyzedSeconds - 0.05 && !(nearCut(dip.start) && nearCut(dip.end)));
}

export function colorFromFrames(frames: readonly { values: Record<string, number> }[]): ReferenceMeasurement['color'] {
  const usable = frames.filter((frame) => frame.values['YAVG'] !== undefined);
  if (usable.length === 0) return null;
  const pick = (key: string) => usable.map((frame) => frame.values[key] ?? 0);
  const luma = mean(pick('YAVG'))! / 255;
  const saturation = mean(pick('SATAVG'))! / 128;
  const contrast = mean(usable.map((frame) => (frame.values['YHIGH'] ?? 0) - (frame.values['YLOW'] ?? 0)))! / 255;
  const warmth = mean(usable.map((frame) => ((frame.values['VAVG'] ?? 128) - 128) - ((frame.values['UAVG'] ?? 128) - 128)))! / 128;
  return { luma: round(clamp(luma, 0, 1)), saturation: round(clamp(saturation, 0, 1)), contrast: round(clamp(contrast, 0, 1)), warmth: round(clamp(warmth, -1, 1)) };
}

export function createFfmpegReferenceAnalyzer(options: FfmpegReferenceAnalyzerOptions = {}): ReferenceAnalyzer {
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const ffprobe = options.ffprobePath ?? 'ffprobe';
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  return {
    kind: 'ffmpeg-reference-analyzer',
    async analyze(input): Promise<ReferenceMeasurement> {
      const probe = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-protocol_whitelist', 'file', input.filePath], 60_000, 8 * 1024 * 1024);
      if (probe.code !== 0) throw new Error('参考视频无法读取（不是视频或文件损坏）');
      const info = JSON.parse(probe.stdout.toString('utf8')) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; duration?: string }[] };
      const video = info.streams?.find((stream) => stream.codec_type === 'video');
      if (video === undefined) throw new Error('参考文件里没有视频画面');
      const hasAudio = info.streams?.some((stream) => stream.codec_type === 'audio') === true;
      const durationSeconds = Number(info.format?.duration ?? video.duration ?? NaN);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('参考视频时长未知');
      const analyzedSeconds = Math.min(durationSeconds, input.maxSeconds);
      const limit = ['-t', analyzedSeconds.toFixed(3)];
      const common = ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file'];

      const picture = await run(ffmpeg, [...common, '-v', 'error', ...limit, '-i', input.filePath, '-map', '0:v:0', '-vf', "scale=160:-2,signalstats,select='gte(scene\\,0)',metadata=mode=print:file=-", '-an', '-f', 'null', '-'], timeoutMs);
      if (picture.code !== 0) throw new Error(`画面分析失败：${picture.stderr.trim().slice(-300)}`);
      const frames = parseFrameMetadata(picture.stdout.toString('utf8'));
      const { cuts, activity } = cutsFromScenes(frames);

      const black = await run(ffmpeg, [...common, '-v', 'info', ...limit, '-i', input.filePath, '-map', '0:v:0', '-vf', 'blackdetect=d=0.1:pix_th=0.10', '-an', '-f', 'null', '-'], timeoutMs, 1024 * 1024);
      const blackDips = blackDipTransitions(black.stderr, cuts, analyzedSeconds);

      let audio: ReferenceMeasurement['audio'] = null;
      let beats: ReferenceMeasurement['beats'] = null;
      if (hasAudio) {
        const loud = await run(ffmpeg, [...common, '-v', 'info', ...limit, '-i', input.filePath, '-map', '0:a:0', '-af', 'ebur128=framelog=quiet', '-vn', '-f', 'null', '-'], timeoutMs, 1024 * 1024);
        const integrated = /I:\s+(-?[\d.]+) LUFS/.exec(loud.stderr.slice(loud.stderr.lastIndexOf('Summary:')));
        const range = /LRA:\s+([\d.]+) LU/.exec(loud.stderr.slice(loud.stderr.lastIndexOf('Summary:')));
        const silence = await run(ffmpeg, [...common, '-v', 'info', ...limit, '-i', input.filePath, '-map', '0:a:0', '-af', 'silencedetect=n=-45dB:d=0.4', '-vn', '-f', 'null', '-'], timeoutMs, 1024 * 1024);
        const starts = [...silence.stderr.matchAll(/silence_start: (-?[\d.]+)/g)].map((match) => Number(match[1]));
        const ends = [...silence.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((match) => Number(match[1]));
        const silent = starts.reduce((sum, start, index) => sum + Math.max(0, (ends[index] ?? analyzedSeconds) - Math.max(0, start)), 0);
        const lufs = integrated === null ? null : Number(integrated[1]);
        audio = {
          integratedLufs: lufs === null || !Number.isFinite(lufs) || lufs < -70 ? null : lufs,
          loudnessRange: range === null ? null : Number(range[1]),
          silenceRatio: round(clamp(silent / analyzedSeconds, 0, 1)),
        };
        const pcm = await run(ffmpeg, [...common, '-v', 'error', ...limit, '-i', input.filePath, '-map', '0:a:0', '-ac', '1', '-ar', String(PCM_RATE), '-f', 'f32le', '-'], timeoutMs);
        if (pcm.code === 0 && pcm.stdout.byteLength >= 4) {
          const aligned = new Uint8Array(pcm.stdout.byteLength - (pcm.stdout.byteLength % 4));
          aligned.set(pcm.stdout.subarray(0, aligned.byteLength));
          const detected = detectBeats(new Float32Array(aligned.buffer), PCM_RATE);
          beats = detected === null ? null : { bpm: detected.bpm, confidence: detected.confidence, times: detected.times.filter((time) => time <= analyzedSeconds) };
        }
      }

      const frameRate = rational(video.avg_frame_rate) ?? rational(video.r_frame_rate);
      return referenceMeasurementSchema.parse({
        label: input.label.slice(0, 300),
        durationSeconds: round(durationSeconds),
        analyzedSeconds: round(analyzedSeconds),
        width: video.width ?? null,
        height: video.height ?? null,
        frameRate: frameRate === null ? null : round(frameRate),
        hasAudio,
        cuts,
        blackDips,
        sceneActivity: activity,
        color: colorFromFrames(frames),
        audio,
        beats,
        speech: null,
      });
    },
  };
}
