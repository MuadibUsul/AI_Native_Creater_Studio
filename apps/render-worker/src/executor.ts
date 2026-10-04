import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import {
  RENDER_EXECUTION_FILE_MIME_TYPES,
  RENDER_EXECUTION_FILE_NAMES,
  RENDER_EXECUTION_RESULT_VERSION,
  buildSubtitles,
  renderExecutionResultSchema,
  renderExecutionSpecSchema,
  renderManifestSchema,
  type RenderExecutionFile,
  type RenderExecutionFileKind,
  type RenderExecutionResult,
  type RenderExecutionSpec,
  type RenderExecutor,
} from '@ancs/contracts';

/**
 * Final 合成执行器（P07-04 / §39）。
 *
 * - `executeRenderSpec`：纯"文件进、文件出"——输入 spec（+ 工作目录内已落盘的冻结素材），
 *   输出 `out/final.mp4`、`out/subtitles.srt`、`out/subtitles.vtt`、`out/manifest.json`、`out/result.json`；
 * - 素材经 bundle 的静态目录（`/assets/<fileName>`）同源提供：组件不访问网络/凭据；
 * - 时长/帧数由 **remotion-core 的 timelineOf**（预览/成片唯一换算入口）派生，Composition 经
 *   calculateMetadata 消费——预览与成片不漂移；
 * - `createRenderExecutor`：编排层（domain/worker）依赖的 RenderExecutor 实现。
 */

const here = import.meta.dirname;
const ENTRY_POINT = path.resolve(here, 'index.ts');
export const FINAL_COMPOSITION_ID = 'FinalComposition';

export function resolveBrowserExecutable(): string | undefined {
  const fromEnv = process.env['REMOTION_BROWSER_EXECUTABLE'];
  if (fromEnv) return fromEnv;
  if (process.platform === 'win32') {
    const candidates = [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface ExecuteRenderSpecInput {
  spec: unknown;
  workDir: string;
  browserExecutable?: string | undefined;
  onProgress?: (progress: { renderedFrames: number; encodedFrames: number; progress: number }) => void | Promise<void>;
}

export async function executeRenderSpec(input: ExecuteRenderSpecInput): Promise<RenderExecutionResult> {
  const spec: RenderExecutionSpec = renderExecutionSpecSchema.parse(input.spec);
  const outDir = path.join(input.workDir, 'out');
  const assetsDir = path.join(input.workDir, 'assets');
  const bundleDir = path.join(input.workDir, 'bundle');
  await mkdir(outDir, { recursive: true });

  // 1) bundle（entry = index.ts；FinalComposition 已在 root 注册）
  const serveUrl = await bundle({ entryPoint: ENTRY_POINT, outDir: bundleDir });

  // 2) 冻结素材就位：复制到 bundle 静态目录（Remotion 的本地静态服务器直接服务 bundle 目录）
  const bundleAssetsDir = path.join(bundleDir, 'assets');
  await mkdir(bundleAssetsDir, { recursive: true });
  const stagedFileNames = new Set<string>();
  for (const asset of spec.assets) stagedFileNames.add(asset.fileName);
  if (spec.narration !== null) stagedFileNames.add(spec.narration.fileName);
  for (const track of spec.musicTracks) stagedFileNames.add(track.fileName);
  for (const fileName of stagedFileNames) {
    await copyFile(path.join(assetsDir, fileName), path.join(bundleAssetsDir, fileName));
  }

  // 3) 选择 Composition（时长/画幅/fps 由 calculateMetadata 从 spec 派生）
  const browserExecutable = input.browserExecutable ?? resolveBrowserExecutable();
  const composition = await selectComposition({
    serveUrl,
    id: FINAL_COMPOSITION_ID,
    inputProps: { spec },
    ...(browserExecutable !== undefined ? { browserExecutable } : {}),
  });

  // 4) 服务端渲染（MP4：h264 + aac 音轨；音频来自 Master Narration 与 BGM 叠加）
  const videoName = RENDER_EXECUTION_FILE_NAMES.VIDEO;
  const videoPath = path.join(outDir, videoName);
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    audioCodec: 'aac',
    outputLocation: videoPath,
    ...(browserExecutable !== undefined ? { browserExecutable } : {}),
    ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
  });

  // 5) 字幕产物（SRT/VTT；时间权威 = Alignment cue；越界仅告警）
  const srt = buildSubtitles({ format: 'SRT', cues: spec.captions.cues, style: spec.captions.style });
  const vtt = buildSubtitles({ format: 'VTT', cues: spec.captions.cues, style: spec.captions.style });
  const srtName = RENDER_EXECUTION_FILE_NAMES.SUBTITLE_SRT;
  const vttName = RENDER_EXECUTION_FILE_NAMES.SUBTITLE_VTT;
  await writeFile(path.join(outDir, srtName), srt.content, 'utf8');
  await writeFile(path.join(outDir, vttName), vtt.content, 'utf8');

  const warnings = [...spec.warnings, ...srt.warnings, ...vtt.warnings];

  const fileFor = async (kind: RenderExecutionFileKind, fileName: string): Promise<{ file: RenderExecutionFile; bytes: Uint8Array }> => {
    const bytes = await readFile(path.join(outDir, fileName));
    const info = await stat(path.join(outDir, fileName));
    return {
      file: { kind, fileName, mimeType: RENDER_EXECUTION_FILE_MIME_TYPES[kind], sizeBytes: info.size, sha256: sha256Hex(bytes) },
      bytes,
    };
  };

  const video = await fileFor('VIDEO', videoName);
  const subtitleSrt = await fileFor('SUBTITLE_SRT', srtName);
  const subtitleVtt = await fileFor('SUBTITLE_VTT', vttName);

  // 6) Manifest（§28）：基线 + 产物事实（Manifest 自身不自引用——hash 单独给出）
  const manifest = renderManifestSchema.parse({
    ...spec.manifestBase,
    outputs: [video.file, subtitleSrt.file, subtitleVtt.file],
    createdAt: new Date().toISOString(),
    warnings,
  });
  const manifestName = RENDER_EXECUTION_FILE_NAMES.MANIFEST;
  const manifestBytes = new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  await writeFile(path.join(outDir, manifestName), manifestBytes);
  const manifestHash = sha256Hex(manifestBytes);
  const manifestFile: RenderExecutionFile = {
    kind: 'MANIFEST',
    fileName: manifestName,
    mimeType: RENDER_EXECUTION_FILE_MIME_TYPES.MANIFEST,
    sizeBytes: manifestBytes.byteLength,
    sha256: manifestHash,
  };

  const durationMs = Math.round((composition.durationInFrames / composition.fps) * 1000);
  const result = renderExecutionResultSchema.parse({
    schemaVersion: RENDER_EXECUTION_RESULT_VERSION,
    renderId: spec.renderId,
    executorKind: 'remotion-server',
    format: { width: composition.width, height: composition.height, fps: composition.fps },
    durationMs,
    durationInFrames: composition.durationInFrames,
    files: [video.file, subtitleSrt.file, subtitleVtt.file, manifestFile],
    manifestHash,
    warnings,
  });
  await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  return result;
}

/** 编排层（domain/worker）消费的 RenderExecutor 实现（同进程；生产可用 CLI 子进程包装，见 apps/worker）。 */
export function createRenderExecutor(options: { browserExecutable?: string | undefined } = {}): RenderExecutor {
  return {
    kind: 'remotion-server',
    async execute(input) {
      return executeRenderSpec({ spec: input.spec, workDir: input.workDir, onProgress: input.onProgress, browserExecutable: options.browserExecutable });
    },
  };
}
