# Kinora Desktop (`@ancs/desktop`)

Electron hybrid desktop client for Kinora (Windows x64 primary, macOS Apple Silicon / Intel compatible):

- **Local GPU Media Engine (`127.0.0.1`)**:
  - Auto-probes mainstream GPU H.264 encoders (`h264_nvenc`, `h264_videotoolbox`, `h264_qsv`, `h264_amf`) with automatic `libx264` CPU fallback.
  - Zero-upload local footage registration with fast head/tail fingerprinting & Relink.
  - O(1) HTTP `Range` streaming playback directly from local SSD.
  - Local 512px JPEG frame sampling for cloud AI director, local GPU 720p proxy generation, and local GPU MP4 export.
- **Cloud AI & Commercial Backend**:
  - Loads Kinora Web (`KINORA_WEB_URL`, default `http://localhost:3000`, production `https://darely.xyz`) inside a sandboxed Electron `BrowserWindow` (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`).
  - All provider keys, subscriptions, monthly AI caps, and project documents stay on the server.

## Run Locally

```bash
# 1. Build desktop engine & shell
pnpm --filter @ancs/desktop run build

# 2. Test standalone Local GPU Media Engine (no Electron binary needed)
pnpm --filter @ancs/desktop run engine

# 3. Install Electron runtime & launch full desktop window
pnpm --filter @ancs/desktop add -D electron electron-builder
KINORA_WEB_URL=https://darely.xyz pnpm --filter @ancs/desktop run start

# 4. Package Windows x64 installer (.exe)
pnpm --filter @ancs/desktop run pack:win
```
