import { contextBridge, ipcRenderer } from 'electron';

/**
 * Electron 安全 Preload 桥接（contextIsolation=true, sandbox=true, nodeIntegration=false）：
 * 只向 Kinora Web 前端暴露最小化的本地 GPU 能力，绝不暴露 Node.js 原生 API 或文件系统写权限。
 */
contextBridge.exposeInMainWorld('kinoraDesktop', {
  platform: process.platform,
  getEngineInfo: () => ipcRenderer.invoke('kinora:engine-info'),
  pickMediaFiles: () => ipcRenderer.invoke('kinora:pick-media-files'),
  relinkMediaFile: (localId: string) => ipcRenderer.invoke('kinora:relink-media-file', localId),
  pickExportPath: (defaultName: string) => ipcRenderer.invoke('kinora:pick-export-path', defaultName),
  revealInFolder: (filePath: string) => ipcRenderer.invoke('kinora:reveal-in-folder', filePath),
});
