import { spawn } from 'node:child_process';
import {
  mediaProxyStreamTimeMapSchema,
  mediaProxyTranscodeResultSchema,
  type MediaProxyStreamTimeMap,
  type MediaRational,
  type MediaStreamProbe,
  type SourceMediaTranscoder,
} from '@ancs/contracts';
import { MEDIA_CHILD_ENV, childProcessEnv } from './child-env.js';

export interface FfmpegMediaProxyTranscoderOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_OUTPUT_BYTES = 8 * 1024 * 1024;

async function runProcess(input: { executable: string; args: string[]; timeoutMs: number; maxOutputBytes: number }): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, { env: childProcessEnv(process.env, MEDIA_CHILD_ENV), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let outputBytes = 0;
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail('媒体代理处理超时'), input.timeoutMs);
    const collect = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > input.maxOutputBytes) {
        fail('媒体代理工具输出超过上限');
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.on('error', () => fail('媒体代理工具无法启动'));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

function rational(value: unknown): MediaRational | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  return Number.isSafeInteger(numerator) && numerator > 0 && Number.isSafeInteger(denominator) && denominator > 0
    ? { numerator, denominator }
    : null;
}

function integerString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return typeof value === 'string' && /^-?\d+$/.test(value) ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function milliseconds(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1000) : null;
}

function targetDimensions(stream: MediaStreamProbe): { width: number; height: number } {
  const rotation = Math.abs(stream.rotationDegrees ?? 0) % 180;
  const sourceWidth = rotation === 90 ? stream.height : stream.width;
  const sourceHeight = rotation === 90 ? stream.width : stream.height;
  if (sourceWidth === null || sourceHeight === null) return { width: 1280, height: 720 };
  const scale = Math.min(1, 1280 / sourceWidth, 720 / sourceHeight);
  const even = (value: number): number => Math.max(2, Math.floor(value / 2) * 2);
  return { width: even(sourceWidth * scale), height: even(sourceHeight * scale) };
}

function ticksFromMilliseconds(millisecondsValue: number, timeBase: MediaRational): bigint {
  const numerator = BigInt(millisecondsValue) * BigInt(timeBase.denominator);
  const denominator = 1000n * BigInt(timeBase.numerator);
  return (numerator + denominator / 2n) / denominator;
}

function mapPts(sourcePts: bigint, sourceOrigin: bigint, proxyOrigin: bigint, sourceBase: MediaRational, proxyBase: MediaRational): bigint {
  const numerator = (sourcePts - sourceOrigin) * BigInt(sourceBase.numerator) * BigInt(proxyBase.denominator);
  const denominator = BigInt(sourceBase.denominator) * BigInt(proxyBase.numerator);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder === 0n ? quotient : quotient + ((remainder < 0n ? -remainder : remainder) * 2n >= denominator ? (numerator < 0n ? -1n : 1n) : 0n);
  return proxyOrigin + rounded;
}

function buildTimeMap(source: MediaStreamProbe, proxy: Record<string, unknown>): MediaProxyStreamTimeMap {
  if ((source.type !== 'VIDEO' && source.type !== 'AUDIO') || source.timeBase === null) throw new Error('源媒体缺少可映射时基');
  const proxyBase = rational(proxy['time_base']);
  if (proxyBase === null) throw new Error('代理媒体缺少可映射时基');
  const sourceOrigin = BigInt(source.startPts ?? '0');
  const proxyOrigin = BigInt(integerString(proxy['start_pts']) ?? '0');
  const proxyDuration = integerString(proxy['duration_ts']);
  let sourceDuration = source.durationTicks === null ? null : BigInt(source.durationTicks);
  if (sourceDuration === null && source.durationMs !== null) sourceDuration = ticksFromMilliseconds(source.durationMs, source.timeBase);
  if (sourceDuration === null && proxyDuration !== null) {
    const proxyTicks = BigInt(proxyDuration);
    sourceDuration = mapPts(proxyOrigin + proxyTicks, proxyOrigin, sourceOrigin, proxyBase, source.timeBase) - sourceOrigin;
  }
  if (sourceDuration === null || sourceDuration <= 0n) throw new Error('源媒体缺少有效持续时间，无法建立 PTS 映射');
  const points = [
    { position: 'START' as const, sourcePts: sourceOrigin },
    { position: 'MIDDLE' as const, sourcePts: sourceOrigin + sourceDuration / 2n },
    { position: 'END' as const, sourcePts: sourceOrigin + sourceDuration },
  ];
  return mediaProxyStreamTimeMapSchema.parse({
    schemaVersion: '1.0',
    kind: 'PTS_AFFINE',
    streamType: source.type,
    sourceStreamIndex: source.index,
    proxyStreamIndex: positiveInteger(proxy['index']) ?? 0,
    sourceTimeBase: source.timeBase,
    proxyTimeBase: proxyBase,
    sourceOriginPts: String(sourceOrigin),
    proxyOriginPts: String(proxyOrigin),
    sourceDurationTicks: String(sourceDuration),
    proxyDurationTicks: proxyDuration,
    anchors: points.map((point) => ({ position: point.position, sourcePts: String(point.sourcePts), proxyPts: String(mapPts(point.sourcePts, sourceOrigin, proxyOrigin, source.timeBase!, proxyBase)) })),
  });
}

export function createFfmpegMediaProxyTranscoder(options: FfmpegMediaProxyTranscoderOptions = {}): SourceMediaTranscoder {
  const ffmpegPath = options.ffmpegPath ?? process.env['ANCS_FFMPEG_PATH'] ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? process.env['ANCS_FFPROBE_PATH'] ?? 'ffprobe';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  return {
    kind: 'ffmpeg-media-proxy-transcoder',
    async transcode(input) {
      const video = input.sourceProbe.streams.find((stream) => stream.type === 'VIDEO');
      const audio = input.sourceProbe.streams.find((stream) => stream.type === 'AUDIO');
      const args = ['-nostdin', '-v', 'error', '-y', '-copyts', '-start_at_zero', '-protocol_whitelist', 'file,pipe', '-i', input.sourcePath];
      if (input.profileKey === 'web-edit-video-720p-v1') {
        if (!video) throw new Error('视频代理 profile 未找到视频流');
        const dimensions = targetDimensions(video);
        args.push(
          '-map', '0:v:0', '-map', '0:a:0?',
          '-vf', `scale=${String(dimensions.width)}:${String(dimensions.height)}:flags=lanczos,setsar=1`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-fps_mode', 'passthrough',
          '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k',
          '-movflags', '+faststart', input.outputPath,
        );
      } else {
        if (!audio) throw new Error('音频代理 profile 未找到音频流');
        args.push('-map', '0:a:0', '-vn', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k', '-movflags', '+faststart', input.outputPath);
      }
      const encoded = await runProcess({ executable: ffmpegPath, args, timeoutMs, maxOutputBytes });
      if (encoded.code !== 0) throw new Error('媒体代理转码失败');
      const inspected = await runProcess({
        executable: ffprobePath,
        args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-protocol_whitelist', 'file,pipe', input.outputPath],
        timeoutMs,
        maxOutputBytes,
      });
      if (inspected.code !== 0 || inspected.stdout.trim() === '') throw new Error('媒体代理结果无法探测');
      const parsed = JSON.parse(inspected.stdout) as Record<string, unknown>;
      const outputStreams = Array.isArray(parsed['streams']) ? parsed['streams'].filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)) : [];
      const outputVideo = outputStreams.find((stream) => stream['codec_type'] === 'video');
      const outputAudio = outputStreams.find((stream) => stream['codec_type'] === 'audio');
      const timeMappings: MediaProxyStreamTimeMap[] = [];
      if (video && outputVideo) timeMappings.push(buildTimeMap(video, outputVideo));
      if (audio && outputAudio) timeMappings.push(buildTimeMap(audio, outputAudio));
      if (timeMappings.length === 0) throw new Error('媒体代理结果没有可映射流');
      const formatValue = parsed['format'];
      const format = formatValue !== null && typeof formatValue === 'object' && !Array.isArray(formatValue) ? formatValue as Record<string, unknown> : {};
      return mediaProxyTranscodeResultSchema.parse({
        schemaVersion: '1.0',
        profileKey: input.profileKey,
        mimeType: input.profileKey === 'web-edit-video-720p-v1' ? 'video/mp4' : 'audio/mp4',
        fileExtension: input.profileKey === 'web-edit-video-720p-v1' ? 'mp4' : 'm4a',
        durationMs: milliseconds(format['duration']),
        width: outputVideo ? positiveInteger(outputVideo['width']) : null,
        height: outputVideo ? positiveInteger(outputVideo['height']) : null,
        audioSampleRate: outputAudio ? positiveInteger(outputAudio['sample_rate']) : null,
        audioChannels: outputAudio ? positiveInteger(outputAudio['channels']) : null,
        timeMappings,
        sourceFacts: {
          formatNames: input.sourceProbe.formatNames,
          videoRotationDegrees: video?.rotationDegrees ?? null,
          videoColorRange: video?.colorRange ?? null,
          videoColorSpace: video?.colorSpace ?? null,
          videoColorTransfer: video?.colorTransfer ?? null,
          videoColorPrimaries: video?.colorPrimaries ?? null,
          audioChannelLayout: audio?.channelLayout ?? null,
        },
      });
    },
  };
}
