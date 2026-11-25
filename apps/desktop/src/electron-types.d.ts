/**
 * Minimal ambient typings for Electron so `@ancs/desktop` typechecks cleanly in CI/headless workspaces
 * without requiring the 100MB+ Electron binary to be downloaded during monorepo static verification.
 * When `electron` is installed (`pnpm --filter @ancs/desktop add -D electron electron-builder`),
 * Node resolves the real runtime module at launch time.
 */
declare module 'electron' {
  export interface BrowserWindowOptions {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    title?: string;
    backgroundColor?: string;
    webPreferences?: {
      preload?: string;
      contextIsolation?: boolean;
      nodeIntegration?: boolean;
      sandbox?: boolean;
    };
  }
  export class BrowserWindow {
    constructor(options: BrowserWindowOptions);
    loadURL(url: string): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): this;
    static getAllWindows(): BrowserWindow[];
  }
  export interface OpenDialogOptions {
    title?: string;
    properties?: string[];
    filters?: { name: string; extensions: string[] }[];
  }
  export interface SaveDialogOptions {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }
  export const app: {
    whenReady(): Promise<void>;
    quit(): void;
    getPath(name: string): string;
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
  export const dialog: {
    showOpenDialog(options: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
    showSaveDialog(options: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
  };
  export const ipcMain: {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  };
  export const shell: {
    showItemInFolder(fullPath: string): void;
  };
  export const contextBridge: {
    exposeInMainWorld(apiKey: string, api: unknown): void;
  };
  export const ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  };
}
