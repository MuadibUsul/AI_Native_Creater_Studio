import { startLocalMediaEngine } from './media-engine.js';
import type { DesktopGpuPreference } from './gpu.js';

/**
 * 独立启动本地 GPU 媒体引擎（无需安装 Electron 即可实测本地 GPU 探测、零上传流式播放、代理与导出）。
 *
 *   pnpm --filter @ancs/desktop run build
 *   pnpm --filter @ancs/desktop run engine
 */

const allowedOrigins = (process.env['KINORA_WEB_ORIGIN'] ?? 'http://localhost:3000,https://darely.xyz')
  .split(',')
  .map((item) => item.trim())
  .filter((item) => item.length > 0);
const hwaccel = (process.env['ANCS_FFMPEG_HWACCEL'] ?? 'auto') as DesktopGpuPreference;
const port = Number(process.env['KINORA_LOCAL_ENGINE_PORT'] ?? '0');

const engine = await startLocalMediaEngine({
  allowedOrigins,
  hwaccel,
  port: Number.isInteger(port) && port >= 0 ? port : 0,
  ...(process.env['ANCS_FFMPEG_PATH'] === undefined ? {} : { ffmpegPath: process.env['ANCS_FFMPEG_PATH'] }),
  ...(process.env['ANCS_FFPROBE_PATH'] === undefined ? {} : { ffprobePath: process.env['ANCS_FFPROBE_PATH'] }),
});

console.info(`[kinora-desktop-engine] listening on ${engine.baseUrl}`);
console.info(`[kinora-desktop-engine] GPU encoder = ${engine.gpu.codec} (${engine.gpu.hardwareAccelerated ? `GPU, probe ${String(engine.gpu.probeMs)} ms` : 'CPU fallback'})`);

const shutdown = async () => {
  await engine.close();
  process.exit(0);
};
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
