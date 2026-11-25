import { spawn } from 'node:child_process';
import type { FinalRenderProfile } from '@ancs/contracts';
import { MEDIA_CHILD_ENV, childProcessEnv } from '../child-env.js';

/**
 * 主流 GPU 硬件视频编码适配与探测（NVIDIA NVENC / Apple VideoToolbox / Intel QSV / AMD AMF + CPU 兜底）。
 *
 * 设计原则：
 * - 纯函数 `videoEncoderArgs` 生成对应后端的 FFmpeg 编码参数；`cpu` 与原有 libx264 参数逐项一致，保证旧行为与确定性测试不变；
 * - `probeVideoEncoder` 启动时执行真实 1 帧空输出编码探针（`-f null -`），过滤掉"FFmpeg 编译支持但本机无对应显卡/驱动"的假阳性；
 * - `preference='auto'` 自动按平台顺序选择首个可用 GPU 编码器，均不可用时静默回退 `cpu`；
 * - 显式指定某种 GPU（如 `nvenc`）但探针失败时直接抛错（fail-closed）。
 */

export type VideoEncoderBackend = 'cpu' | 'nvenc' | 'videotoolbox' | 'qsv' | 'amf';
export type HwaccelPreference = 'auto' | VideoEncoderBackend;

export interface ResolvedVideoEncoder {
  backend: VideoEncoderBackend;
  codec: string;
  hardwareAccelerated: boolean;
  probeMs: number;
}

export const VIDEO_ENCODER_CODECS: Readonly<Record<VideoEncoderBackend, string>> = {
  cpu: 'libx264',
  nvenc: 'h264_nvenc',
  videotoolbox: 'h264_videotoolbox',
  qsv: 'h264_qsv',
  amf: 'h264_amf',
};

const NVENC_PRESET: Readonly<Record<FinalRenderProfile['encoderPreset'], string>> = {
  veryfast: 'p3',
  medium: 'p5',
};

const AMF_QUALITY: Readonly<Record<FinalRenderProfile['encoderPreset'], string>> = {
  veryfast: 'speed',
  medium: 'balanced',
};

/** CRF (0-51, 越低画质越高) → Apple VideoToolbox `-q:v` (1-100, 越高画质越高)。 */
function crfToVideoToolboxQuality(crf: number): number {
  const clamped = Math.max(0, Math.min(51, crf));
  // CRF 18 -> ~72, CRF 23 -> ~62, CRF 28 -> ~52
  return Math.max(20, Math.min(95, Math.round(108 - clamped * 2)));
}

/** 按目标硬件后端生成 FFmpeg 视频编码参数（含 `-pix_fmt yuv420p` 保证主流播放器最大兼容性）。 */
export function videoEncoderArgs(
  backend: VideoEncoderBackend,
  options: { preset: FinalRenderProfile['encoderPreset']; crf: number },
): string[] {
  const crf = Math.max(0, Math.min(51, Math.round(options.crf)));
  switch (backend) {
    case 'cpu':
      return ['-c:v', 'libx264', '-preset', options.preset, '-crf', String(crf), '-pix_fmt', 'yuv420p'];
    case 'nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', NVENC_PRESET[options.preset], '-rc', 'vbr', '-cq', String(crf), '-b:v', '0', '-pix_fmt', 'yuv420p'];
    case 'videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-q:v', String(crfToVideoToolboxQuality(crf)), '-pix_fmt', 'yuv420p'];
    case 'qsv':
      return ['-c:v', 'h264_qsv', '-preset', options.preset, '-global_quality', String(crf), '-pix_fmt', 'yuv420p'];
    case 'amf':
      return ['-c:v', 'h264_amf', '-quality', AMF_QUALITY[options.preset], '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf), '-pix_fmt', 'yuv420p'];
  }
}

/** 各主流平台的自动探测候选顺序（不含 cpu 兜底）。 */
export function candidateGpuBackends(platform: NodeJS.Platform = process.platform): VideoEncoderBackend[] {
  if (platform === 'darwin') return ['videotoolbox'];
  if (platform === 'win32') return ['nvenc', 'qsv', 'amf'];
  return ['nvenc', 'qsv', 'amf'];
}

async function smokeTestEncoder(ffmpegPath: string, backend: VideoEncoderBackend, timeoutMs: number): Promise<boolean> {
  const codec = VIDEO_ENCODER_CODECS[backend];
  const args = [
    '-hide_banner', '-v', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=30:d=0.1',
    '-frames:v', '1',
    '-c:v', codec,
    '-pix_fmt', 'yuv420p',
    '-f', 'null', '-',
  ];
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, {
      env: childProcessEnv(process.env, MEDIA_CHILD_ENV),
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

export interface ProbeVideoEncoderOptions {
  ffmpegPath?: string;
  preference?: HwaccelPreference;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** 测试注入：覆盖真实的 FFmpeg 1 帧探针 */
  testEncoder?: (backend: VideoEncoderBackend) => Promise<boolean>;
}

/**
 * 探测本机可用的视频编码器（Worker 启动时调用一次）。
 * - `cpu`：直接返回 `libx264`，不触发 GPU 探针；
 * - `auto`：按平台顺序实测 GPU 编码器，首个通过即启用，否则回退 `cpu`；
 * - 显式 GPU（`nvenc`/`videotoolbox`/`qsv`/`amf`）：实测不通过则抛错（fail-closed）。
 */
export async function probeVideoEncoder(options: ProbeVideoEncoderOptions = {}): Promise<ResolvedVideoEncoder> {
  const preference = options.preference ?? 'auto';
  const started = Date.now();
  if (preference === 'cpu') {
    return { backend: 'cpu', codec: VIDEO_ENCODER_CODECS.cpu, hardwareAccelerated: false, probeMs: 0 };
  }
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const timeoutMs = options.timeoutMs ?? 8_000;
  const check = options.testEncoder ?? ((backend) => smokeTestEncoder(ffmpegPath, backend, timeoutMs));

  if (preference !== 'auto') {
    const ok = await check(preference);
    if (!ok) {
      throw new Error(`指定的硬件视频编码器不可用：${preference}（${VIDEO_ENCODER_CODECS[preference]}）；请检查显卡驱动或改用 ANCS_FFMPEG_HWACCEL=auto / cpu`);
    }
    return { backend: preference, codec: VIDEO_ENCODER_CODECS[preference], hardwareAccelerated: true, probeMs: Date.now() - started };
  }

  for (const candidate of candidateGpuBackends(options.platform)) {
    if (await check(candidate)) {
      return { backend: candidate, codec: VIDEO_ENCODER_CODECS[candidate], hardwareAccelerated: true, probeMs: Date.now() - started };
    }
  }
  return { backend: 'cpu', codec: VIDEO_ENCODER_CODECS.cpu, hardwareAccelerated: false, probeMs: Date.now() - started };
}
