import {
  compareMediaTime,
  frameIndexToMediaTime,
  isMediaTimeFrameAligned,
  mediaRangeSchema,
  mediaTimeSchema,
  mediaTimeToFrameIndex,
  normalizeRational,
  rescaleMediaTime,
  subtractMediaTime,
  type MediaRange,
  type MediaTime,
  type RenderPlan,
  type RenderRequirement,
} from '@ancs/contracts';
import { sequenceTimeToSourcePts } from '@ancs/time';
import { renderPlanHash } from './compile.js';

/**
 * 改哪里渲染哪里（V6 §7.4）：把 RenderPlan 切成固定长度的时间窗，每个窗口是一个**独立可渲染**的计划。
 *
 * - 视频切片：只含与窗口相交的视频段（裁到窗口并平移到 0 起），不含音频与字幕；
 *   切片的 planHash 只取决于窗口内的画面内容与源校验和——内容没变的窗口哈希不变，可以直接复用已渲染的段；
 * - 音频计划：整条时间线只含音频（不切，避免淡变曲线与编码器前置样本在窗口接缝处出错）；
 * - 字幕不进入预览渲染：浏览器按快照叠加（零等待）；
 * - 纯函数：不做 I/O、不取墙钟。
 */

/** 只与音频有关的需求（视频切片不需要）。 */
const AUDIO_ONLY_REQUIREMENTS: ReadonlySet<RenderRequirement> = new Set(['AUDIO_GAIN_FADE_PAN', 'AUDIO_CROSSFADE']);
/** 只与画面有关的需求（音频计划不需要）。 */
const VIDEO_ONLY_REQUIREMENTS: ReadonlySet<RenderRequirement> = new Set([
  'PER_SEGMENT_TRANSFORM', 'PER_SEGMENT_CROP', 'PER_SEGMENT_OPACITY', 'GRAPHICS_COMPONENT_RENDER', 'MULTI_TRACK_COMPOSITE', 'CAPTIONS_BURNED_IN',
]);

const frameTimebase = (plan: Pick<RenderPlan, 'frameRate'>) => normalizeRational(plan.frameRate.den, plan.frameRate.num);

/** 能在帧时基精确表示的时间统一写成帧时基（保证同一内容得到同一哈希），否则保持原样。 */
function canonical(time: MediaTime, plan: Pick<RenderPlan, 'frameRate'>): MediaTime {
  const parsed = mediaTimeSchema.parse(time);
  if (!isMediaTimeFrameAligned(parsed, plan.frameRate)) return parsed;
  return rescaleMediaTime(parsed, frameTimebase(plan), 'nearest');
}

const maxTime = (left: MediaTime, right: MediaTime): MediaTime => (compareMediaTime(left, right) >= 0 ? left : right);
const minTime = (left: MediaTime, right: MediaTime): MediaTime => (compareMediaTime(left, right) <= 0 ? left : right);

/**
 * 预览时间窗：每窗 `segmentFrames` 帧（按序列帧率），最后一窗止于成片终点。
 * 窗口边界落在帧网格上，内容不变时窗口划分稳定。
 */
export function renderPlanWindows(plan: Pick<RenderPlan, 'frameRate' | 'duration'>, segmentFrames: number): MediaRange[] {
  if (!Number.isInteger(segmentFrames) || segmentFrames < 1) throw new RangeError('segmentFrames must be a positive integer');
  const duration = mediaTimeSchema.parse(plan.duration);
  const totalFrames = BigInt(mediaTimeToFrameIndex(duration, plan.frameRate, 'ceil'));
  const windows: MediaRange[] = [];
  for (let start = 0n; start < totalFrames; start += BigInt(segmentFrames)) {
    const end = start + BigInt(segmentFrames);
    const startTime = frameIndexToMediaTime(start.toString(), plan.frameRate);
    const endTime = end >= totalFrames ? canonical(duration, plan) : frameIndexToMediaTime(end.toString(), plan.frameRate);
    windows.push({ start: startTime, end: endTime });
  }
  return windows;
}

function withHash(plan: Omit<RenderPlan, 'planHash'>): RenderPlan {
  return { ...plan, planHash: renderPlanHash(plan) };
}

/** 视频切片：窗口内的画面（音频、字幕清空），时间平移到 0 起。 */
export function sliceRenderPlanVideo(plan: RenderPlan, window: MediaRange): RenderPlan {
  const bounds = mediaRangeSchema.parse(window);
  const shift = (time: MediaTime): MediaTime => canonical(subtractMediaTime(time, bounds.start), plan);
  const usedSources = new Set<string>();
  const videoLayers = plan.videoLayers.map((layer) => ({
    ...layer,
    segments: layer.segments.flatMap((segment) => {
      const start = maxTime(segment.sequenceRange.start, bounds.start);
      const end = minTime(segment.sequenceRange.end, bounds.end);
      if (compareMediaTime(end, start) <= 0) return [];
      usedSources.add(segment.sourceVersionId);
      return [{
        ...segment,
        sequenceRange: { start: shift(start), end: shift(end) },
        sourceRange: {
          start: sequenceTimeToSourcePts(start, segment.sequenceRange, segment.sourceRange, 'nearest'),
          end: sequenceTimeToSourcePts(end, segment.sequenceRange, segment.sourceRange, 'nearest'),
        },
      }];
    }),
  })).filter((layer) => layer.segments.length > 0);
  return withHash({
    irVersion: plan.irVersion,
    projectId: plan.projectId,
    sequenceId: plan.sequenceId,
    documentRevision: plan.documentRevision,
    frameRate: plan.frameRate,
    duration: canonical(subtractMediaTime(bounds.end, bounds.start), plan),
    sources: plan.sources.filter((source) => usedSources.has(source.assetVersionId)),
    videoLayers,
    audio: [],
    captions: [],
    graphicsElementIds: plan.graphicsElementIds,
    animatedTargets: plan.animatedTargets,
    requirements: plan.requirements.filter((requirement) => !AUDIO_ONLY_REQUIREMENTS.has(requirement)),
    excludedTrackIds: plan.excludedTrackIds,
    warnings: [],
  });
}

/** 音频计划：整条时间线的声音（画面清空，字幕清空），用于与视频段拼接。 */
export function audioOnlyRenderPlan(plan: RenderPlan): RenderPlan {
  const usedSources = new Set(plan.audio.map((entry) => entry.sourceVersionId));
  return withHash({
    irVersion: plan.irVersion,
    projectId: plan.projectId,
    sequenceId: plan.sequenceId,
    documentRevision: plan.documentRevision,
    frameRate: plan.frameRate,
    duration: canonical(plan.duration, plan),
    sources: plan.sources.filter((source) => usedSources.has(source.assetVersionId)),
    videoLayers: [],
    audio: plan.audio,
    captions: [],
    graphicsElementIds: [],
    animatedTargets: plan.animatedTargets.filter((target) => target.targetKind === 'AUDIO_REGION'),
    requirements: plan.requirements.filter((requirement) => !VIDEO_ONLY_REQUIREMENTS.has(requirement)),
    excludedTrackIds: plan.excludedTrackIds,
    warnings: [],
  });
}
