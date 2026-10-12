import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';

/**
 * V6-3 特效图层渲染：把特效代码渲染成**带透明通道**的视频 + 一张中间帧的小预览图。
 * Remotion 先出 ProRes 4444（yuva），再无损转成 PNG 编码的 QuickTime（rgba，约小 3 倍，FFmpeg 原生解码保留 alpha）。
 * 只在独立子进程里运行（apps/worker 以 sandboxEnv 白名单环境 spawn `run-effect.ts`），不接触凭据与数据库。
 * Remotion bundle 按源码哈希缓存在系统临时目录（同一版本只打包一次）。
 */

export interface EffectRenderRequest {
  code: string;
  params: Record<string, unknown>;
  seed: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

export interface EffectRenderResult {
  file: string;
  poster: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  renderMs: number;
}

const HERE = import.meta.dirname;
const ENTRY = path.join(HERE, 'entry.ts');

async function bundleOnce(): Promise<string> {
  const hash = createHash('sha256');
  for (const name of (await readdir(HERE)).filter((file) => /\.(tsx?|json)$/.test(file)).sort()) hash.update(name).update(await readFile(path.join(HERE, name)));
  const dir = path.join(os.tmpdir(), `ancs-effect-bundle-${hash.digest('hex').slice(0, 16)}`);
  if (existsSync(path.join(dir, 'index.html'))) return dir;
  const staging = `${dir}.${String(process.pid)}.tmp`;
  await rm(staging, { recursive: true, force: true });
  await bundle({ entryPoint: ENTRY, outDir: staging });
  await rename(staging, dir).catch(async () => { await rm(staging, { recursive: true, force: true }); });
  return dir;
}

/** 预览图最长边（给 AI 看效果、给界面做缩略图） */
const POSTER_MAX_SIDE = 480;

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    child.on('error', (error) => reject(new Error(`ffmpeg failed to start: ${error.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${String(code)}: ${stderr.trim()}`))));
  });
}

export async function renderEffectLayer(request: EffectRenderRequest, options: { outDir: string; browserExecutable?: string | undefined; ffmpegPath?: string | undefined }): Promise<EffectRenderResult> {
  const started = Date.now();
  await mkdir(options.outDir, { recursive: true });
  const serveUrl = await bundleOnce();
  const inputProps = {
    code: request.code, params: request.params, seed: request.seed,
    layout: { width: request.width, height: request.height, fps: request.fps, durationInFrames: request.durationInFrames },
  };
  const browser = options.browserExecutable === undefined ? {} : { browserExecutable: options.browserExecutable };
  const composition = await selectComposition({ serveUrl, id: 'EffectLayer', inputProps, ...browser });
  const prores = path.join(options.outDir, 'layer-prores.mov');
  await renderMedia({
    serveUrl, composition, inputProps, codec: 'prores', proResProfile: '4444', imageFormat: 'png', pixelFormat: 'yuva444p10le',
    outputLocation: prores, overwrite: true, ...browser,
  });
  const file = path.join(options.outDir, 'layer.mov');
  await runFfmpeg(options.ffmpegPath ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file', '-i', prores, '-map', '0:v:0', '-c:v', 'png', '-pix_fmt', 'rgba', '-an', file]);
  await rm(prores, { force: true });
  const poster = path.join(options.outDir, 'poster.png');
  const scale = Math.min(1, POSTER_MAX_SIDE / Math.max(composition.width, composition.height));
  await renderStill({ serveUrl, composition, inputProps, frame: Math.floor(request.durationInFrames / 2), output: poster, imageFormat: 'png', scale, overwrite: true, ...browser });
  await stat(file);
  return { file, poster, width: composition.width, height: composition.height, fps: composition.fps, durationInFrames: composition.durationInFrames, renderMs: Date.now() - started };
}
