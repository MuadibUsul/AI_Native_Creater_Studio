import { spawn } from 'node:child_process';
import {
  sourceMediaProbeResultSchema,
  type MediaRational,
  type MediaStreamProbe,
  type SourceMediaProbe,
  type SourceMediaProbeResult,
} from '@ancs/contracts';
import { MEDIA_CHILD_ENV, childProcessEnv } from './child-env.js';

export interface FfmpegSourceMediaProbeOptions {
  ffprobePath?: string;
  ffmpegPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export const DEFAULT_SOURCE_PROBE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_SOURCE_PROBE_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * 完整解码检查的时限随素材时长增长：在 timeoutMs 之外，每秒素材再给 2 秒（允许按半倍速解码）。
 * 固定 5 分钟时，共享机器上 10 分钟的 4K HEVC 会解码超时，整段素材被判失败，永远不能用。
 */
export function decodeCheckTimeoutMs(baseTimeoutMs: number, mediaDurationMs: number | null): number {
  return baseTimeoutMs + 2 * Math.max(0, mediaDurationMs ?? 0);
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function runBoundedProcess(input: {
  executable: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, { env: childProcessEnv(process.env, MEDIA_CHILD_ENV), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const finishWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
    };
    const timer = setTimeout(() => finishWithError(new Error(`媒体探测超时（${String(input.timeoutMs)}ms）`)), input.timeoutMs);
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > input.maxOutputBytes) {
        finishWithError(new Error(`媒体探测输出超过上限（${String(input.maxOutputBytes)} bytes）`));
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (error) => finishWithError(new Error(`媒体工具启动失败：${error.message}`)));
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function rational(value: unknown): MediaRational | null {
  if (typeof value !== 'string') return null;
  const match = /^(-?\d+)\/(\d+)$/.exec(value);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) return null;
  return { numerator, denominator };
}

function integerString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return typeof value === 'string' && /^-?\d+$/.test(value) ? value : null;
}

function integer(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function milliseconds(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1000) : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' && value !== 'N/A' ? value : null;
}

function streamType(value: unknown): MediaStreamProbe['type'] {
  if (value === 'video') return 'VIDEO';
  if (value === 'audio') return 'AUDIO';
  if (value === 'subtitle') return 'SUBTITLE';
  if (value === 'data') return 'DATA';
  if (value === 'attachment') return 'ATTACHMENT';
  return 'UNKNOWN';
}

function rotation(stream: Record<string, unknown>): number | null {
  const tags = stream['tags'];
  if (tags && typeof tags === 'object' && !Array.isArray(tags)) {
    const tagged = integer((tags as Record<string, unknown>)['rotate']);
    if (tagged !== null) return tagged;
  }
  const sideData = stream['side_data_list'];
  if (!Array.isArray(sideData)) return null;
  for (const item of sideData) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const found = integer((item as Record<string, unknown>)['rotation']);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * 前 120 秒视频包的显示时间戳（pts，缺失时取 dts）；容器标记为丢弃（flags 含 D，如编辑列表裁掉的包）的不计。
 * 读包不解码：此前用 `-show_frames` 取解码后帧的时间戳，ffprobe 单线程解码，30 秒 4K HEVC 要 69 秒，
 * 而包时间戳排序后与帧时间戳相同（契约字段本就叫 sampledPacketCount）。
 */
function sampledPts(packets: unknown): { count: number; deltas: string[]; cadence: MediaStreamProbe['cadence'] } {
  if (!Array.isArray(packets)) return { count: 0, deltas: [], cadence: 'UNKNOWN' };
  const values = packets
    .map((packet) => {
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return null;
      const fields = packet as Record<string, unknown>;
      if (typeof fields['flags'] === 'string' && fields['flags'].includes('D')) return null;
      return integerString(fields['pts']) ?? integerString(fields['dts']);
    })
    .filter((value): value is string => value !== null)
    .map((value) => BigInt(value))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const unique = [...new Set(values.map(String))].map((value) => BigInt(value));
  const deltas = new Set<string>();
  for (let index = 1; index < unique.length; index += 1) {
    const delta = unique[index]! - unique[index - 1]!;
    if (delta > 0n) deltas.add(String(delta));
  }
  const sorted = [...deltas].sort((a, b) => {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return {
    count: values.length,
    deltas: sorted.slice(0, 32),
    cadence: sorted.length > 1 ? 'VARIABLE' : sorted.length === 1 && values.length >= 3 ? 'CONSTANT' : 'UNKNOWN',
  };
}

function failedResult(code: string, message: string): SourceMediaProbeResult {
  return sourceMediaProbeResultSchema.parse({
    schemaVersion: '1.0',
    status: 'FAILED',
    formatNames: [],
    formatLongName: null,
    startTimeMs: null,
    durationMs: null,
    bitRate: null,
    streams: [],
    decodeCheck: { status: 'FAILED', errorCode: code, message },
    capabilities: {
      upload: 'AVAILABLE',
      decode: 'UNAVAILABLE',
      preview: 'UNAVAILABLE',
      export: 'UNAVAILABLE',
      reasons: [{ code, message, nextAction: '检查文件是否完整，或转换为受支持的媒体格式后重新上传。' }],
    },
  });
}

function isDirectPreview(formatNames: string[], streams: MediaStreamProbe[]): boolean {
  const formats = new Set(formatNames);
  const video = streams.find((stream) => stream.type === 'VIDEO')?.codecName ?? null;
  const audioStream = streams.find((stream) => stream.type === 'AUDIO');
  const audio = audioStream?.codecName ?? null;
  if (video === null) {
    return (formats.has('wav') && (audioStream?.channels ?? 0) <= 2 && (audio === 'pcm_s16le' || audio === 'pcm_s24le' || audio === 'pcm_f32le')) ||
      (formats.has('mp3') && audio === 'mp3') ||
      ((formats.has('ogg') || formats.has('matroska') || formats.has('webm')) && (audio === 'opus' || audio === 'vorbis')) ||
      ((formats.has('mov') || formats.has('mp4') || formats.has('m4a') || formats.has('3gp') || formats.has('3g2') || formats.has('mj2')) && audio === 'aac');
  }
  return ((formats.has('mov') || formats.has('mp4') || formats.has('m4a') || formats.has('3gp') || formats.has('3g2') || formats.has('mj2')) &&
      (video === 'h264' || video === 'av1') && (audio === null || audio === 'aac' || audio === 'mp3')) ||
    ((formats.has('matroska') || formats.has('webm')) && (video === 'vp8' || video === 'vp9' || video === 'av1') &&
      (audio === null || audio === 'opus' || audio === 'vorbis'));
}

export function createFfmpegSourceMediaProbe(options: FfmpegSourceMediaProbeOptions = {}): SourceMediaProbe {
  const ffprobePath = options.ffprobePath ?? process.env['ANCS_FFPROBE_PATH'] ?? 'ffprobe';
  const ffmpegPath = options.ffmpegPath ?? process.env['ANCS_FFMPEG_PATH'] ?? 'ffmpeg';
  const timeoutMs = options.timeoutMs ?? DEFAULT_SOURCE_PROBE_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_SOURCE_PROBE_OUTPUT_BYTES;
  return {
    kind: 'ffmpeg-source-media-probe',
    async probe(input): Promise<SourceMediaProbeResult> {
      const info = await runBoundedProcess({
        executable: ffprobePath,
        args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-protocol_whitelist', 'file,pipe', input.filePath],
        timeoutMs,
        maxOutputBytes,
      });
      if (info.code !== 0 || info.stdout.trim() === '') {
        return failedResult('INVALID_OR_UNSUPPORTED_MEDIA', '文件容器不完整或编码不受支持，无法读取音视频流。');
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(info.stdout) as Record<string, unknown>;
      } catch {
        return failedResult('INVALID_PROBE_OUTPUT', '媒体探测器返回了无法解析的结果。');
      }
      const rawStreams = Array.isArray(parsed['streams']) ? parsed['streams'] : [];
      const videoIndex = rawStreams.findIndex(
        (stream) => stream && typeof stream === 'object' && !Array.isArray(stream) && (stream as Record<string, unknown>)['codec_type'] === 'video',
      );
      let pts = { count: 0, deltas: [] as string[], cadence: 'UNKNOWN' as MediaStreamProbe['cadence'] };
      if (videoIndex >= 0) {
        const packetProbe = await runBoundedProcess({
          executable: ffprobePath,
          args: [
            '-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+120', '-show_packets',
            '-show_entries', 'packet=pts,dts,flags', '-print_format', 'json', '-protocol_whitelist', 'file,pipe', input.filePath,
          ],
          timeoutMs,
          maxOutputBytes,
        });
        if (packetProbe.code === 0 && packetProbe.stdout.trim() !== '') {
          try {
            const packets = JSON.parse(packetProbe.stdout) as Record<string, unknown>;
            pts = sampledPts(packets['packets']);
          } catch {
            pts = { count: 0, deltas: [], cadence: 'UNKNOWN' };
          }
        }
      }
      const streams = rawStreams.flatMap((raw, index): MediaStreamProbe[] => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const stream = raw as Record<string, unknown>;
        const type = streamType(stream['codec_type']);
        return [{
          index: integer(stream['index']) ?? index,
          type,
          codecName: nullableString(stream['codec_name']),
          codecLongName: nullableString(stream['codec_long_name']),
          profile: nullableString(stream['profile']),
          timeBase: rational(stream['time_base']),
          startPts: integerString(stream['start_pts']),
          durationTicks: integerString(stream['duration_ts']),
          durationMs: milliseconds(stream['duration']),
          width: type === 'VIDEO' ? positiveInteger(stream['width']) : null,
          height: type === 'VIDEO' ? positiveInteger(stream['height']) : null,
          rotationDegrees: type === 'VIDEO' ? rotation(stream) : null,
          pixelFormat: type === 'VIDEO' ? nullableString(stream['pix_fmt']) : null,
          colorRange: type === 'VIDEO' ? nullableString(stream['color_range']) : null,
          colorSpace: type === 'VIDEO' ? nullableString(stream['color_space']) : null,
          colorTransfer: type === 'VIDEO' ? nullableString(stream['color_transfer']) : null,
          colorPrimaries: type === 'VIDEO' ? nullableString(stream['color_primaries']) : null,
          nominalFrameRate: type === 'VIDEO' ? rational(stream['r_frame_rate']) : null,
          averageFrameRate: type === 'VIDEO' ? rational(stream['avg_frame_rate']) : null,
          frameCount: type === 'VIDEO' ? integerString(stream['nb_frames']) : null,
          sampleRate: type === 'AUDIO' ? positiveInteger(stream['sample_rate']) : null,
          channels: type === 'AUDIO' ? positiveInteger(stream['channels']) : null,
          channelLayout: type === 'AUDIO' ? nullableString(stream['channel_layout']) : null,
          cadence: type === 'VIDEO' && index === videoIndex ? pts.cadence : 'UNKNOWN',
          sampledPacketCount: type === 'VIDEO' && index === videoIndex ? pts.count : 0,
          sampledPtsDeltaTicks: type === 'VIDEO' && index === videoIndex ? pts.deltas : [],
        }];
      });
      if (!streams.some((stream) => stream.type === 'VIDEO' || stream.type === 'AUDIO')) {
        return failedResult('NO_PLAYABLE_STREAMS', '文件中没有可解码的视频或音频流。');
      }
      const rawFormat = parsed['format'];
      const format = rawFormat && typeof rawFormat === 'object' && !Array.isArray(rawFormat) ? rawFormat as Record<string, unknown> : {};
      const decode = await runBoundedProcess({
        executable: ffmpegPath,
        args: ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe', '-i', input.filePath, '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-'],
        timeoutMs: decodeCheckTimeoutMs(timeoutMs, milliseconds(format['duration']) ?? Math.max(0, ...streams.map((stream) => stream.durationMs ?? 0))),
        maxOutputBytes,
      });
      const formatNames = (nullableString(format['format_name']) ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      if (decode.code !== 0) {
        const message = '完整解码失败，文件可能损坏或包含当前环境不支持的编码。';
        return sourceMediaProbeResultSchema.parse({
          schemaVersion: '1.0', status: 'FAILED', formatNames, formatLongName: nullableString(format['format_long_name']),
          startTimeMs: milliseconds(format['start_time']), durationMs: milliseconds(format['duration']),
          bitRate: positiveInteger(format['bit_rate']), streams,
          decodeCheck: { status: 'FAILED', errorCode: 'DECODE_FAILED', message },
          capabilities: {
            upload: 'AVAILABLE', decode: 'UNAVAILABLE', preview: 'UNAVAILABLE', export: 'UNAVAILABLE',
            reasons: [{ code: 'DECODE_FAILED', message, nextAction: '保留原件；修复或转封装后重新上传。' }],
          },
        });
      }
      const directPreview = isDirectPreview(formatNames, streams);
      const reasons = directPreview ? [] : [{
        code: 'PROXY_REQUIRED',
        message: '原件可以解码，但当前浏览器不能可靠直接预览该容器或编码。',
        nextAction: '生成预览代理后继续编辑；导出时转码为目标格式。',
      }];
      return sourceMediaProbeResultSchema.parse({
        schemaVersion: '1.0', status: 'READY', formatNames, formatLongName: nullableString(format['format_long_name']),
        startTimeMs: milliseconds(format['start_time']), durationMs: milliseconds(format['duration']),
        bitRate: positiveInteger(format['bit_rate']), streams,
        decodeCheck: { status: 'PASSED', errorCode: null, message: null },
        capabilities: {
          upload: 'AVAILABLE', decode: 'AVAILABLE', preview: directPreview ? 'AVAILABLE' : 'PROXY_REQUIRED',
          export: directPreview ? 'AVAILABLE' : 'TRANSCODE_REQUIRED', reasons,
        },
      });
    },
  };
}
