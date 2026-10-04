import {
  ALIGNMENT_ERROR_REASONS,
  ApiFailure,
  ERROR_CODES,
  captionStyleSchema,
  mixPlanRequestSchema,
  type CaptionStyle,
  type MasterNarration,
  type MixPlan,
  type MixPlanRequest,
  type SubtitleFormat,
  type SubtitleOutput,
} from '@ancs/contracts';
import { buildSubtitles, planAudioMix, wrapCaption, type CaptionCue } from '@ancs/contracts';
import { getCurrentMasterNarration } from './alignment.js';
import type { DomainDeps } from './channels.js';

/**
 * 混音与字幕服务（P06-06 / §58、§59）。
 *
 * - **字幕 = Alignment 的派生视图**：每个旁白段 → 一个字幕 cue（文本来自段、时间来自绝对对齐）；
 *   按 CaptionStyle 断行；越界只报 warning（不静默裁切）；
 * - **混音计划 = Alignment cues + 非旁白轨道的增益包络**（纯计算）：
 *   输入含 NARRATION 轨 → 422 MULTIPLE_NARRATION_TRACKS（无重叠双人声）；
 *   **全程不调用 TTS**——"音量调整不重做 TTS"是结构性保证（本模块不依赖 AudioSynthesisAdapter）。
 */

/** 由 Master Narration 派生字幕 cue（文本 + 绝对时间）。 */
export function captionCuesOf(master: MasterNarration): CaptionCue[] {
  return master.segments.map((segment) => ({ startMs: segment.startMs, durationMs: segment.durationMs, text: segment.text }));
}

async function requireMaster(deps: DomainDeps, input: { workspaceId: string; projectId: string; planId: string }): Promise<MasterNarration> {
  const master = await getCurrentMasterNarration(deps, input);
  if (master === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '尚未生成 Master Narration：先合成对齐后再生成字幕/混音', 409, {
      reason: ALIGNMENT_ERROR_REASONS.NO_NARRATION_BLOCKS,
    });
  }
  return master;
}

/** 生成字幕输出（SRT/VTT；风格可覆盖）。 */
export async function buildSubtitleOutput(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; planId: string; format: SubtitleFormat; style?: unknown },
): Promise<SubtitleOutput> {
  const master = await requireMaster(deps, input);
  const style: CaptionStyle = captionStyleSchema.parse(input.style ?? {});
  return buildSubtitles({ format: input.format, cues: captionCuesOf(master), style });
}

/** 生成混音计划（非旁白轨道 + ducking；拒绝第二"人声"）。 */
export async function buildMixPlan(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; planId: string; request: MixPlanRequest },
): Promise<MixPlan> {
  const master = await requireMaster(deps, input);
  const body = mixPlanRequestSchema.parse(input.request);
  const narrationTrack = body.tracks.find((track) => (track.kind as string) === 'NARRATION');
  if (narrationTrack !== undefined) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '混音输入不得包含 NARRATION 轨：旁白唯一来源是 Master Narration（无重叠双人声）', 422, {
      reason: 'MULTIPLE_NARRATION_TRACKS',
      trackId: narrationTrack.id,
    });
  }
  return planAudioMix({
    projectId: input.projectId,
    durationMs: master.totalDurationMs,
    cues: master.cues,
    tracks: body.tracks,
    ducking: body.ducking,
  });
}

/** 单行预览（供编辑器/测试查看断行结果）。 */
export function previewCaptionLines(text: string, style?: unknown): { lines: string[]; truncated: boolean } {
  return wrapCaption(text, captionStyleSchema.parse(style ?? {}));
}
