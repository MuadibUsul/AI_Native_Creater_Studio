import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesktopGpuPreference } from './gpu.js';
import { startLocalMediaEngine, type LocalMediaEngine } from './media-engine.js';

/**
 * Kinora Desktop 主进程（Electron 混合架构）：
 * - 启动本机 127.0.0.1 GPU 媒体引擎（NVENC / VideoToolbox / QSV / AMF + libx264 兜底）；
 * - 窗口加载云端/本地 Kinora Web（默认 https://darely.xyz，可通过 KINORA_WEB_URL 覆盖，例如 http://localhost:3000）；
 * - 通过受限 IPC（preload）处理原生文件选择器、Relink、导出保存路径与资源管理器定位。
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
const webUrl = (process.env['KINORA_WEB_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');
const webOrigin = new URL(webUrl).origin;
const hwaccel = (process.env['ANCS_FFMPEG_HWACCEL'] ?? 'auto') as DesktopGpuPreference;

let engine: LocalMediaEngine | null = null;

async function createMainWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'Kinora',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(currentDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadURL(webUrl);
}

function registerIpc(activeEngine: LocalMediaEngine): void {
  ipcMain.handle('kinora:engine-info', () => ({
    baseUrl: activeEngine.baseUrl,
    token: activeEngine.token,
    gpu: activeEngine.gpu,
  }));

  ipcMain.handle('kinora:pick-media-files', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Select footage',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media Files', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'png', 'jpg', 'jpeg', 'webp'] },
      ],
    });
    if (picked.canceled || picked.filePaths.length === 0) return [];
    const registered = [];
    for (const filePath of picked.filePaths) {
      const record = await activeEngine.registry.registerFile(filePath);
      registered.push({
        localId: record.localId,
        fileName: record.fileName,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        fingerprint: record.fingerprint,
        durationMs: record.durationMs,
        width: record.width,
        height: record.height,
        fps: record.fps,
        hasVideo: record.hasVideo,
        hasAudio: record.hasAudio,
        streamUrl: `${activeEngine.baseUrl}/media/${encodeURIComponent(record.localId)}?token=${encodeURIComponent(activeEngine.token)}`,
      });
    }
    return registered;
  });

  ipcMain.handle('kinora:relink-media-file', async (_event, localId: unknown) => {
    if (typeof localId !== 'string' || localId.length === 0) throw new Error('invalid localId');
    const picked = await dialog.showOpenDialog({
      title: 'Relink missing media file',
      properties: ['openFile'],
    });
    if (picked.canceled || picked.filePaths[0] === undefined) return null;
    const record = await activeEngine.registry.relink(localId, picked.filePaths[0]);
    return {
      localId: record.localId,
      fileName: record.fileName,
      streamUrl: `${activeEngine.baseUrl}/media/${encodeURIComponent(record.localId)}?token=${encodeURIComponent(activeEngine.token)}`,
    };
  });

  ipcMain.handle('kinora:pick-export-path', async (_event, defaultName: unknown) => {
    const name = typeof defaultName === 'string' && defaultName.trim().length > 0 ? defaultName.trim() : 'kinora-export.mp4';
    const saved = await dialog.showSaveDialog({
      title: 'Export video (Local GPU)',
      defaultPath: name.toLowerCase().endsWith('.mp4') ? name : `${name}.mp4`,
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    });
    return saved.canceled ? null : (saved.filePath ?? null);
  });

  ipcMain.handle('kinora:reveal-in-folder', (_event, filePath: unknown) => {
    if (typeof filePath === 'string' && filePath.length > 0) {
      shell.showItemInFolder(filePath);
    }
  });
}

void app.whenReady().then(async () => {
  engine = await startLocalMediaEngine({
    allowedOrigins: [webOrigin],
    hwaccel,
    workRoot: join(app.getPath('userData'), 'media-cache'),
    ...(process.env['ANCS_FFMPEG_PATH'] === undefined ? {} : { ffmpegPath: process.env['ANCS_FFMPEG_PATH'] }),
    ...(process.env['ANCS_FFPROBE_PATH'] === undefined ? {} : { ffprobePath: process.env['ANCS_FFPROBE_PATH'] }),
  });
  registerIpc(engine);
  await createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void engine?.close().finally(() => app.quit());
  }
});
