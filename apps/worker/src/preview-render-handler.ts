import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApiFailure,
  PREVIEW_ERROR_REASONS,
  PREVIEW_RENDER_JOB_TYPE,
  PREVIEW_SEGMENT_SECONDS,
  previewRenderJobInputSchema,
  type FinalRenderProfile,
  type RenderPlan,
  type RenderPlanExecutor,
} from '@ancs/contracts';
import {
  audioOnlyRenderPlan,
  beginPreviewRender,
  completePreviewRender,
  failPreviewRender,
  findPreviewSegment,
  recordPreviewSegment,
  renderPlanWindows,
  resolvePreviewSourceKeys,
  sliceRenderPlanVideo,
} from '@ancs/domain';
import { MEDIA_CHILD_ENV, childProcessEnv } from './child-env.js';
import type { JobHandler } from './handlers.js';

/**
 * 预览渲染（V6 §7.4，改哪里渲染哪里）。
 *
 * 1. 画面：按固定时间窗（≈2 秒，落在帧网格上）切片；每个切片按"切片计划哈希 + 档位 + 后端"查缓存，
 *    只渲染没命中的窗口（同一个 FFmpeg 后端、同一档位 → 每段以关键帧开始、编码参数一致）；
 * 2. 声音：整条时间线只渲声音（避免窗口接缝处的淡变与编码器前置样本问题），同样按内容哈希缓存；
 * 3. 拼接：视频段流复制拼接 + 声音流复制混流 → 一个可播放的 MP4（faststart），写回对象存储；
 * 失败只标记这次预览失败（不自动重试刷费用），用户可再次请求；工程不受影响。
 */

const CACHE_FORMAT = 'preview-cache/1';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

async function runFfmpeg(executable: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: childProcessEnv(process.env, MEDIA_CHILD_ENV), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('preview mux timed out')); }, timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('ffmpeg could not be started')); });
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`preview mux failed (exit ${String(code)}): ${stderr.slice(-800)}`)); });
  });
}

export interface PreviewRenderHandlerOptions {
  executor: RenderPlanExecutor;
  ffmpegPath?: string;
  segmentSeconds?: number;
  muxTimeoutMs?: number;
}

export function createPreviewRenderHandler(options: PreviewRenderHandlerOptions): JobHandler {
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const segmentSeconds = options.segmentSeconds ?? PREVIEW_SEGMENT_SECONDS;
  return {
    type: PREVIEW_RENDER_JOB_TYPE,
    description: '低清预览：按时间窗缓存复用画面段，整条渲声音，流复制拼接',
    async handle(deps, rawInput, context) {
      const { previewId } = previewRenderJobInputSchema.parse(rawInput);
      const task = await beginPreviewRender(deps, { workspaceId: context.workspaceId, previewId });
      if (task === null) return { previewId, skipped: true };
      const storage = deps.storage;
      if (storage?.materializeObject === undefined || storage.persistFile === undefined) {
        await failPreviewRender(deps, { workspaceId: context.workspaceId, previewId, error: { reason: PREVIEW_ERROR_REASONS.RENDER_FAILED, message: 'object storage cannot stream files for preview rendering' } });
        return { previewId, failed: true };
      }
      const materialize = storage.materializeObject.bind(storage);
      const persist = storage.persistFile.bind(storage);
      const started = Date.now();
      const workDir = await mkdtemp(join(tmpdir(), 'ancs-preview-'));
      try {
        await mkdir(join(workDir, 'assets'), { recursive: true });
        await mkdir(join(workDir, 'parts'), { recursive: true });
        const sourceKeys = await resolvePreviewSourceKeys(deps, { workspaceId: task.workspaceId, assetVersionIds: task.plan.sources.map((source) => source.assetVersionId) });
        const staged = new Map<string, string>();
        const stage = async (plan: RenderPlan): Promise<{ assetVersionId: string; fileName: string }[]> => {
          const files: { assetVersionId: string; fileName: string }[] = [];
          for (const source of plan.sources) {
            let fileName = staged.get(source.assetVersionId);
            if (fileName === undefined) {
              const key = sourceKeys.get(source.assetVersionId);
              if (key === undefined) throw new Error(`preview source ${source.assetVersionId} is not available`);
              fileName = `${source.assetVersionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.media`;
              await materialize({ key, destinationPath: join(workDir, 'assets', fileName) });
              staged.set(source.assetVersionId, fileName);
            }
            files.push({ assetVersionId: source.assetVersionId, fileName });
          }
          return files;
        };
        const profileKey = sha256(JSON.stringify(task.profile));
        const cacheKeyOf = (plan: RenderPlan): string => sha256(`${CACHE_FORMAT}|${options.executor.kind}|${profileKey}|${plan.planHash}`);
        /** 取一段：命中缓存则物化，否则渲染后写回缓存。返回本地文件路径与是否复用。 */
        const obtain = async (kind: 'VIDEO' | 'AUDIO', plan: RenderPlan, profile: FinalRenderProfile, localName: string): Promise<{ path: string; reused: boolean }> => {
          const cacheKey = cacheKeyOf(plan);
          const path = join(workDir, 'parts', localName);
          const hit = await findPreviewSegment(deps, { workspaceId: task.workspaceId, kind, cacheKey });
          if (hit !== null) {
            await materialize({ key: hit.storageKey, destinationPath: path });
            return { path, reused: true };
          }
          await options.executor.execute({ plan, profile, workDir, sources: await stage(plan) });
          if (kind === 'VIDEO') {
            // 画面段只保留视频流：段内静音音轨的编码填充会让容器时长略长，拼接时累积成错帧
            await runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', join('out', 'final.mp4'), '-map', '0:v:0', '-c', 'copy', '-movflags', '+faststart', '-y', path], workDir, options.muxTimeoutMs ?? 10 * 60_000);
          } else {
            await rename(join(workDir, 'out', 'final.mp4'), path);
          }
          const storageKey = `workspaces/${task.workspaceId}/preview-cache/${kind.toLowerCase()}/${cacheKey}.mp4`;
          await persist({ sourcePath: path, destinationKey: storageKey, contentType: 'video/mp4' });
          await recordPreviewSegment(deps, { workspaceId: task.workspaceId, kind, cacheKey, storageKey, sizeBytes: (await stat(path)).size });
          return { path, reused: false };
        };

        const segmentFrames = Math.max(1, Math.round((segmentSeconds * task.plan.frameRate.num) / task.plan.frameRate.den));
        const windows = renderPlanWindows(task.plan, segmentFrames);
        let reused = 0;
        let rendered = 0;
        const parts: string[] = [];
        for (const [index, window] of windows.entries()) {
          const part = await obtain('VIDEO', sliceRenderPlanVideo(task.plan, window), task.profile, `v${String(index).padStart(5, '0')}.mp4`);
          parts.push(part.path);
          if (part.reused) reused += 1; else rendered += 1;
          await context.heartbeat();
        }
        const audio = await obtain('AUDIO', audioOnlyRenderPlan(task.plan), task.profile, 'audio.mp4');
        if (audio.reused) reused += 1; else rendered += 1;

        const list = parts.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join('\n');
        await writeFile(join(workDir, 'parts.txt'), `${list}\n`, 'utf8');
        const output = join(workDir, 'preview.mp4');
        await runFfmpeg(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-protocol_whitelist', 'file,pipe',
          '-f', 'concat', '-safe', '0', '-i', 'parts.txt',
          '-i', audio.path,
          '-map', '0:v:0', '-map', '1:a:0',
          '-c', 'copy', '-shortest', '-movflags', '+faststart',
          '-y', output,
        ], workDir, options.muxTimeoutMs ?? 10 * 60_000);
        const storageKey = `workspaces/${task.workspaceId}/previews/${previewId}.mp4`;
        await persist({ sourcePath: output, destinationKey: storageKey, contentType: 'video/mp4' });
        const renderMs = Date.now() - started;
        await completePreviewRender(deps, { workspaceId: task.workspaceId, previewId, storageKey, total: windows.length + 1, reused, rendered, renderMs });
        return { previewId, segments: windows.length + 1, reused, rendered, renderMs };
      } catch (error) {
        const unsupported = error instanceof ApiFailure && error.httpStatus === 501;
        await failPreviewRender(deps, {
          workspaceId: context.workspaceId,
          previewId,
          error: unsupported
            ? { reason: PREVIEW_ERROR_REASONS.UNSUPPORTED, details: error.details }
            : { reason: PREVIEW_ERROR_REASONS.RENDER_FAILED, message: (error instanceof Error ? error.message : String(error)).slice(0, 500) },
        });
        return { previewId, failed: true };
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}
