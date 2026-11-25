'use client';

/**
 * Kinora 桌面客户端桥接（浏览器/PWA 中返回 null，零副作用；在 Electron 桌面壳内自动发现本机 GPU 媒体引擎）。
 */

export interface DesktopGpuStatus {
  backend: 'cpu' | 'nvenc' | 'videotoolbox' | 'qsv' | 'amf';
  codec: string;
  hardwareAccelerated: boolean;
  probeMs: number;
}

export interface DesktopEngineInfo {
  baseUrl: string;
  token: string;
  gpu: DesktopGpuStatus;
}

export interface DesktopLocalMedia {
  localId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  fingerprint: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: { num: number; den: number } | null;
  hasVideo: boolean;
  hasAudio: boolean;
  streamUrl: string;
}

export interface DesktopLocalExportResult {
  outputPath: string;
  sizeBytes: number;
  segmentCount?: number;
  videoEncoder: string;
  fallbackUsed: boolean;
  elapsedMs: number;
}

export interface DesktopRenderSegment {
  localId: string;
  startSeconds: number;
  endSeconds: number;
}

export interface KinoraDesktopApi {
  readonly platform: string;
  getEngineInfo(): Promise<DesktopEngineInfo>;
  pickMediaFiles(): Promise<DesktopLocalMedia[]>;
  relinkMediaFile(localId: string): Promise<{ localId: string; fileName: string; streamUrl: string } | null>;
  pickExportPath(defaultName: string): Promise<string | null>;
  revealInFolder(filePath: string): Promise<void>;
}

declare global {
  interface Window {
    kinoraDesktop?: KinoraDesktopApi;
  }
}

export function getDesktopBridge(): KinoraDesktopApi | null {
  if (typeof window === 'undefined') return null;
  return window.kinoraDesktop ?? null;
}

export function isDesktopApp(): boolean {
  return getDesktopBridge() !== null;
}

/** 经本地 127.0.0.1 GPU 媒体引擎抽取本地素材帧（无需上传原片到云端）。 */
export async function sampleLocalFrames(
  engine: DesktopEngineInfo,
  input: { localId: string; times: readonly (string | number)[]; maxWidth?: number },
): Promise<{ at: string; mediaType: 'image/jpeg'; data: string }[]> {
  const response = await fetch(`${engine.baseUrl}/media/${encodeURIComponent(input.localId)}/frames`, {
    method: 'POST',
    headers: { authorization: `Bearer ${engine.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ times: input.times, ...(input.maxWidth === undefined ? {} : { maxWidth: input.maxWidth }) }),
  });
  if (!response.ok) throw new Error(`local frame sampling failed (${String(response.status)})`);
  const parsed = await response.json() as { frames: { at: string; mediaType: 'image/jpeg'; data: string }[] };
  return parsed.frames;
}

/** 经本地 127.0.0.1 GPU 媒体引擎直接导出成片到本机磁盘（零服务器负载、零带宽费）。 */
export async function exportLocalWithGpu(
  engine: DesktopEngineInfo,
  input: { localId: string; outputPath: string; preset?: 'veryfast' | 'medium'; crf?: number },
): Promise<DesktopLocalExportResult> {
  const response = await fetch(`${engine.baseUrl}/export`, {
    method: 'POST',
    headers: { authorization: `Bearer ${engine.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`local GPU export failed (${String(response.status)})`);
  return await response.json() as DesktopLocalExportResult;
}

/** 经本地 127.0.0.1 GPU 媒体引擎合成多片段时间线并导出到本机磁盘。 */
export async function renderLocalTimelineWithGpu(
  engine: DesktopEngineInfo,
  input: {
    segments: readonly DesktopRenderSegment[];
    outputPath: string;
    width: number;
    height: number;
    fps?: number;
    preset?: 'veryfast' | 'medium';
    crf?: number;
  },
): Promise<DesktopLocalExportResult> {
  const response = await fetch(`${engine.baseUrl}/render-plan`, {
    method: 'POST',
    headers: { authorization: `Bearer ${engine.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`local GPU timeline render failed (${String(response.status)})`);
  return await response.json() as DesktopLocalExportResult;
}

/** 桌面安装包下载链接（由部署期构建参数 NEXT_PUBLIC_KINORA_WIN_DOWNLOAD_URL 注入；未配置返回 null，界面展示构建/下载页）。 */
export function desktopWindowsDownloadUrl(): string | null {
  const url = process.env['NEXT_PUBLIC_KINORA_WIN_DOWNLOAD_URL']?.trim();
  return url && /^https?:\/\/\S+$/i.test(url) ? url : null;
}
