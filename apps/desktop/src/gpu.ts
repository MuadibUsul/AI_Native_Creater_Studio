import { spawn } from 'node:child_process';
import type { FinalRenderProfile } from '@ancs/contracts';

/**
 * 桌面端主流 GPU 硬件视频编码适配与探测（NVIDIA NVENC / Apple VideoToolbox / Intel QSV / AMD AMF + libx264 兜底）。
 */

export type DesktopGpuBackend = 'cpu' | 'nvenc' | 'videotoolbox' | 'qsv' | 'amf';
export type DesktopGpuPreference = 'auto' | DesktopGpuBackend;

export interface DesktopGpuInfo {
  backend: DesktopGpuBackend;
  codec: string;
  hardwareAccelerated: boolean;
  probeMs: number;
}

export const DESKTOP_GPU_CODECS: Readonly<Record<DesktopGpuBackend, string>> = {
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

export function desktopVideoEncoderArgs(
  backend: DesktopGpuBackend,
  options: { preset: FinalRenderProfile['encoderPreset']; crf: number },
): string[] {
  const crf = Math.max(0, Math.min(51, Math.round(options.crf)));
  switch (backend) {
    case 'cpu':
      return ['-c:v', 'libx264', '-preset', options.preset, '-crf', String(crf), '-pix_fmt', 'yuv420p'];
    case 'nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', NVENC_PRESET[options.preset], '-rc', 'vbr', '-cq', String(crf), '-b:v', '0', '-pix_fmt', 'yuv420p'];
    case 'videotoolbox': {
      const qv = Math.max(20, Math.min(95, Math.round(108 - crf * 2)));
      return ['-c:v', 'h264_videotoolbox', '-q:v', String(qv), '-pix_fmt', 'yuv420p'];
    }
    case 'qsv':
      return ['-c:v', 'h264_qsv', '-preset', options.preset, '-global_quality', String(crf), '-pix_fmt', 'yuv420p'];
    case 'amf':
      return ['-c:v', 'h264_amf', '-quality', AMF_QUALITY[options.preset], '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf), '-pix_fmt', 'yuv420p'];
  }
}

export function platformGpuOrder(platform: NodeJS.Platform = process.platform): DesktopGpuBackend[] {
  if (platform === 'darwin') return ['videotoolbox'];
  return ['nvenc', 'qsv', 'amf'];
}

async function testOneFrame(ffmpegPath: string, backend: DesktopGpuBackend, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-v', 'error', '-nostdin',
      '-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=30:d=0.1',
      '-frames:v', '1',
      '-c:v', DESKTOP_GPU_CODECS[backend],
      '-pix_fmt', 'yuv420p',
      '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(false); }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

export async function probeDesktopGpu(options: {
  ffmpegPath?: string;
  preference?: DesktopGpuPreference;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  testEncoder?: (backend: DesktopGpuBackend) => Promise<boolean>;
} = {}): Promise<DesktopGpuInfo> {
  const preference = options.preference ?? 'auto';
  const started = Date.now();
  if (preference === 'cpu') {
    return { backend: 'cpu', codec: DESKTOP_GPU_CODECS.cpu, hardwareAccelerated: false, probeMs: 0 };
  }
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const timeoutMs = options.timeoutMs ?? 8_000;
  const check = options.testEncoder ?? ((backend) => testOneFrame(ffmpegPath, backend, timeoutMs));
  if (preference !== 'auto') {
    const ok = await check(preference);
    if (!ok) throw new Error(`Desktop GPU encoder unavailable: ${preference} (${DESKTOP_GPU_CODECS[preference]})`);
    return { backend: preference, codec: DESKTOP_GPU_CODECS[preference], hardwareAccelerated: true, probeMs: Date.now() - started };
  }
  for (const candidate of platformGpuOrder(options.platform)) {
    if (await check(candidate)) {
      return { backend: candidate, codec: DESKTOP_GPU_CODECS[candidate], hardwareAccelerated: true, probeMs: Date.now() - started };
    }
  }
  return { backend: 'cpu', codec: DESKTOP_GPU_CODECS.cpu, hardwareAccelerated: false, probeMs: Date.now() - started };
}
