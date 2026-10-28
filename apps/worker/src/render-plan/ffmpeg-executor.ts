import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RENDER_PLAN_EXECUTION_RESULT_VERSION,
  RENDER_PLAN_IR_VERSION,
  finalRenderProfileSchema,
  mediaTimeToDisplayMilliseconds,
  contentLabelSchema,
  renderPlanExecutionResultSchema,
  type ContentLabel,
  type FinalRenderProfile,
  type RenderBackendCapabilities,
  type RenderPlan,
  type RenderPlanExecutionFile,
  type RenderPlanExecutionResult,
  type RenderPlanExecutor,
} from '@ancs/contracts';
import { assertRenderPlanSupported, requirementsForDelivery } from '@ancs/domain';
import { MEDIA_CHILD_ENV, childProcessEnv } from '../child-env.js';
import { compileFfmpegMediaGraph, type FfmpegStagedSource } from './ffmpeg-graph.js';

/**
 * V5-M4：FFmpeg 媒体图终渲染后端（进程隔离）。
 *
 * 只消费 RenderPlan（不读数据库、不取凭据）：编排层把冻结的源对象落到 `workDir/assets/`，本执行器
 * 探测流事实 → 纯函数编译媒体图 → 子进程执行（环境白名单、协议白名单、硬超时、输出上限）→
 * 侧载字幕与 Manifest → 逐文件 SHA-256。任何计划需求不被本后端支持 → 501（显式拒绝，不静默省略）。
 */

export const FFMPEG_MEDIA_GRAPH_CAPABILITIES: RenderBackendCapabilities = {
  backend: 'FFMPEG_MEDIA_GRAPH',
  videoPrecision: 'FRAME_ACCURATE',
  audioPrecision: 'FRAME_ACCURATE',
  supported: ['MULTI_TRACK_COMPOSITE', 'PER_SEGMENT_TRANSFORM', 'PER_SEGMENT_CROP', 'PER_SEGMENT_OPACITY', 'AUDIO_GAIN_FADE_PAN', 'AUDIO_CROSSFADE'],
  // 字幕烧录需要可复现的字体管线（含 CJK），图形/关键帧需要 Remotion 图形层：均属 N09-10 后续，显式不支持
  unsupported: ['CAPTIONS_BURNED_IN', 'GRAPHICS_COMPONENT_RENDER', 'KEYFRAME_ANIMATION', 'TIME_REMAP', 'NESTED_SEQUENCE'],
};

export interface FfmpegRenderPlanExecutorOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  /** 硬超时（毫秒；超时 SIGKILL 并失败） */
  timeoutMs?: number;
  /** AI 生成标识用的中文字体文件；缺省经 fontconfig 找一款支持简体中文的字体 */
  labelFontFile?: string;
}

const PREFERRED_CJK_FONTS = /NotoSansCJK|Noto Sans CJK|SourceHanSans|wqy|WenQuanYi/i;

/** 找一款支持简体中文的字体（显式标识必须真的显示出汉字；找不到就失败，不画成方块） */
async function resolveLabelFont(override: string | undefined, cwd: string): Promise<string> {
  if (override !== undefined) return override;
  const listed = await runTool('fc-list', [':lang=zh-cn', 'file'], { cwd, timeoutMs: 30_000 }).catch(() => null);
  const files = (listed?.stdout ?? '').split('\n').map((line) => line.replace(/:\s*$/, '').trim()).filter((line) => line.length > 0).sort();
  const chosen = files.find((file) => PREFERRED_CJK_FONTS.test(file)) ?? files[0];
  if (chosen === undefined) throw new Error('找不到支持中文的字体，无法渲染 AI 生成显式标识（中英文案共用一款字体；Worker 镜像应包含 fonts-noto-cjk）');
  return chosen;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;

async function runTool(executable: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: childProcessEnv(process.env, MEDIA_CHILD_ENV), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail('终渲染超时'), options.timeoutMs);
    const collect = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > MAX_TOOL_OUTPUT_BYTES) {
        fail('终渲染工具输出超过上限');
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.on('error', () => fail('终渲染工具无法启动'));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const RATIONAL = /^(\d+)\/(\d+)$/;

/** 探测落盘源的流事实（只读本地文件；协议白名单）。 */
async function probeStaged(ffprobePath: string, workDir: string, assetVersionId: string, path: string, timeoutMs: number): Promise<FfmpegStagedSource> {
  const result = await runTool(ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-print_format', 'json', '-show_streams', path], { cwd: workDir, timeoutMs });
  if (result.code !== 0) throw new Error(`源探测失败：${assetVersionId}`);
  const parsed = JSON.parse(result.stdout) as { streams?: { codec_type?: string; time_base?: string; channels?: number }[] };
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const timeBase = video?.time_base === undefined ? null : RATIONAL.exec(video.time_base);
  return {
    assetVersionId,
    path,
    videoTimeBase: timeBase === null ? null : { num: Number(timeBase[1]), den: Number(timeBase[2]) },
    audioChannels: typeof audio?.channels === 'number' && audio.channels > 0 ? audio.channels : null,
  };
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');
/** 显示边界：字幕时间码只用 mediaTimeToDisplay*（毫秒仅用于文件格式，不回写权威字段）。 */
function timecode(time: Parameters<typeof mediaTimeToDisplayMilliseconds>[0], separator: ',' | '.'): string {
  const total = mediaTimeToDisplayMilliseconds(time, 'nearest');
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secondsPart = Math.floor((total % 60_000) / 1000);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secondsPart, 2)}${separator}${pad(total % 1000, 3)}`;
}

export function captionsToSrt(plan: Pick<RenderPlan, 'captions'>): string {
  return plan.captions.map((caption, index) => `${String(index + 1)}\n${timecode(caption.sequenceRange.start, ',')} --> ${timecode(caption.sequenceRange.end, ',')}\n${caption.text}\n`).join('\n');
}

export function captionsToVtt(plan: Pick<RenderPlan, 'captions'>): string {
  return `WEBVTT\n\n${plan.captions.map((caption) => `${timecode(caption.sequenceRange.start, '.')} --> ${timecode(caption.sequenceRange.end, '.')}\n${caption.text}\n`).join('\n')}`;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function createFfmpegRenderPlanExecutor(options: FfmpegRenderPlanExecutorOptions = {}): RenderPlanExecutor {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    kind: 'FFMPEG_MEDIA_GRAPH',
    capabilities: FFMPEG_MEDIA_GRAPH_CAPABILITIES,
    async execute(input): Promise<RenderPlanExecutionResult> {
      const profile: FinalRenderProfile = finalRenderProfileSchema.parse(input.profile);
      // 后端裁决（交付方式已计入：侧载字幕不需要烧录能力）
      assertRenderPlanSupported(requirementsForDelivery(input.plan, profile), FFMPEG_MEDIA_GRAPH_CAPABILITIES);
      const needed = new Set([...input.plan.videoLayers.flatMap((layer) => layer.segments.map((segment) => segment.sourceVersionId)), ...input.plan.audio.filter((entry) => entry.audible).map((entry) => entry.sourceVersionId)]);
      const staged: FfmpegStagedSource[] = [];
      for (const source of input.sources) {
        if (!needed.has(source.assetVersionId)) continue;
        if (!/^[A-Za-z0-9_.-]+$/.test(source.fileName)) throw new Error(`非法的落盘文件名：${source.fileName}`);
        staged.push(await probeStaged(ffprobePath, input.workDir, source.assetVersionId, `assets/${source.fileName}`, timeoutMs));
      }
      for (const versionId of needed) {
        if (!staged.some((source) => source.assetVersionId === versionId)) throw new Error(`冻结源未落盘：${versionId}`);
      }
      const label: ContentLabel | null = input.label == null ? null : contentLabelSchema.parse(input.label);
      const labelFont = label === null ? null : await resolveLabelFont(options.labelFontFile, input.workDir);
      const graph = compileFfmpegMediaGraph({ plan: input.plan, profile, sources: staged, label: label === null || labelFont === null ? null : { content: label, fontFile: labelFont } });
      await mkdir(join(input.workDir, 'out'), { recursive: true });
      await writeFile(join(input.workDir, 'graph.json'), `${JSON.stringify({ graphHash: graph.graphHash, args: graph.args }, null, 2)}\n`, 'utf8');
      const run = await runTool(ffmpegPath, graph.args, { cwd: input.workDir, timeoutMs });
      if (run.code !== 0) {
        // 只回传有限的诊断尾部（不含环境；参数来自本地生成）
        throw new Error(`FFmpeg 终渲染失败（exit ${String(run.code)}）：${run.stderr.slice(-2_000)}`);
      }

      const files: RenderPlanExecutionFile[] = [];
      const record = async (kind: RenderPlanExecutionFile['kind'], fileName: string): Promise<void> => {
        const bytes = await readFile(join(input.workDir, 'out', fileName));
        files.push({ kind, fileName, sizeBytes: (await stat(join(input.workDir, 'out', fileName))).size, sha256: sha256(bytes) });
      };
      await record('VIDEO', 'final.mp4');
      const warnings = [...input.plan.warnings];
      if (input.plan.captions.length > 0) {
        await writeFile(join(input.workDir, 'out', 'subtitles.srt'), captionsToSrt(input.plan), 'utf8');
        await writeFile(join(input.workDir, 'out', 'subtitles.vtt'), captionsToVtt(input.plan), 'utf8');
        await record('SUBTITLE_SRT', 'subtitles.srt');
        await record('SUBTITLE_VTT', 'subtitles.vtt');
      }
      const version = await runTool(ffmpegPath, ['-version'], { cwd: input.workDir, timeoutMs: 30_000 });
      const manifest = {
        schemaVersion: 'final-render-manifest/1.0',
        irVersion: RENDER_PLAN_IR_VERSION,
        planHash: input.plan.planHash,
        graphHash: graph.graphHash,
        backend: FFMPEG_MEDIA_GRAPH_CAPABILITIES.backend,
        tool: version.stdout.split('\n')[0] ?? 'ffmpeg',
        profile,
        frameRate: input.plan.frameRate,
        duration: input.plan.duration,
        frameCount: graph.frameCount.toString(),
        sampleCount: graph.sampleCount.toString(),
        sources: input.plan.sources,
        outputs: files,
        // AI 生成合成内容标识（显式文字 + 写进文件的 AIGC 元数据），没有则为 null
        contentLabel: label,
        warnings,
      };
      await writeFile(join(input.workDir, 'out', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      await record('MANIFEST', 'manifest.json');
      return renderPlanExecutionResultSchema.parse({
        schemaVersion: RENDER_PLAN_EXECUTION_RESULT_VERSION,
        backend: FFMPEG_MEDIA_GRAPH_CAPABILITIES.backend,
        planHash: input.plan.planHash,
        graphHash: graph.graphHash,
        frameCount: graph.frameCount.toString(),
        sampleCount: graph.sampleCount.toString(),
        files,
        warnings,
      });
    },
  };
}
