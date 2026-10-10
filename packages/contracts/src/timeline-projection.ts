import { z } from 'zod';
import { compareMediaTime, mediaRangeSchema, mediaTimeSchema, type MediaRange, type MediaTime } from './common/media-time.js';
import { temporalSelectionRanges, timelineViewportSchema, xAtSequenceTime, type TimelineViewport } from './timeline-band.js';
import type { TemporalSelection } from './selection.js';

/**
 * N04-04（主体）：把**真实序列片段/轨道**投影到横向时间带，并解析时间选区覆盖的片段。
 *
 * 纪律（增量设计 §2.1、§4）：
 * - 投影是**纯函数**：只吃 `(tracks, clips, viewport)`，不读工程、不写任何东西；
 * - 横向坐标一律经 `timeline-band` 的**有理时基**换算（不把浮点毫秒当权威）；
 * - 部分落在可视窗口外的片段**如实标注被裁剪**（`clippedLeft/Right`），不假装整段可见；
 * - 可视宽度为 0 的片段不进结果（但**不**从数据里"删掉"——调用方仍可据 range 查到它）；
 * - 轨道按 `position` 排序、轨道内按开始时间排序，保证渲染顺序确定。
 */

export const timelineProjectionTrackSchema = z.object({
  trackId: z.string().min(1),
  kind: z.enum(['VIDEO', 'AUDIO', 'GRAPHIC', 'CAPTION']),
  position: z.number().int(),
  name: z.string().max(200).default(''),
  /** 轨道级状态只映射到展示，不参与几何计算 */
  hidden: z.boolean().default(false),
  muted: z.boolean().default(false),
  locked: z.boolean().default(false),
}).strict();
export type TimelineProjectionTrack = z.infer<typeof timelineProjectionTrackSchema>;

export const timelineProjectionClipSchema = z.object({
  clipId: z.string().min(1),
  trackId: z.string().min(1),
  sequenceRange: mediaRangeSchema,
  label: z.string().max(200).default(''),
  /** 片段自身可为隐藏（如隐藏图形对象），语义与轨道隐藏不同 */
  hidden: z.boolean().default(false),
}).strict();
export type TimelineProjectionClip = z.infer<typeof timelineProjectionClipSchema>;

export const timelineLaneSegmentSchema = z.object({
  clipId: z.string().min(1),
  label: z.string().max(200),
  /** 真实序列区间（权威） */
  sequenceRange: mediaRangeSchema,
  /** 可视窗口内的像素几何（相对时间带左缘） */
  startPx: z.number(),
  endPx: z.number(),
  widthPx: z.number().nonnegative(),
  /** 是否被可视窗口裁掉左/右侧 */
  clippedLeft: z.boolean(),
  clippedRight: z.boolean(),
  hidden: z.boolean(),
}).strict();
export type TimelineLaneSegment = z.infer<typeof timelineLaneSegmentSchema>;

export const timelineLaneSchema = z.object({
  trackId: z.string().min(1),
  kind: timelineProjectionTrackSchema.shape.kind,
  position: z.number().int(),
  name: z.string().max(200),
  hidden: z.boolean(),
  muted: z.boolean(),
  locked: z.boolean(),
  segments: z.array(timelineLaneSegmentSchema),
  /** 该轨在可视窗口内是否一个可见片段都没有（用于空轨占位） */
  empty: z.boolean(),
}).strict();
export type TimelineLane = z.infer<typeof timelineLaneSchema>;

export const timelineProjectionSchema = z.object({
  viewport: timelineViewportSchema,
  lanes: z.array(timelineLaneSchema),
  /** 可视窗口内可见片段的 id（不含宽度为 0 者） */
  visibleClipIds: z.array(z.string().min(1)),
  /** 可视窗口之外但仍存在于此投影输入中的片段 id（供调用方提示"还有内容"，不是"不存在"） */
  outsideViewportClipIds: z.array(z.string().min(1)),
  /** 输入里引用不存在轨道的片段 id（脏数据，如实回报而非静默丢弃） */
  orphanClipIds: z.array(z.string().min(1)),
}).strict();
export type TimelineProjection = z.infer<typeof timelineProjectionSchema>;

/** 把真实轨道与片段投影到横向时间带（纯函数）。 */
export function projectSequenceToTimeline(input: {
  tracks: readonly TimelineProjectionTrack[];
  clips: readonly TimelineProjectionClip[];
  viewport: TimelineViewport;
}): TimelineProjection {
  const { viewport } = input;
  const trackIds = new Set(input.tracks.map((track) => track.trackId));
  const orphanClipIds = input.clips.filter((clip) => !trackIds.has(clip.trackId)).map((clip) => clip.clipId);
  const visibleClipIds: string[] = [];
  const outsideViewportClipIds: string[] = [];

  const lanes = [...input.tracks]
    .sort((left, right) => left.position - right.position)
    .map((track) => {
      const own = input.clips
        .filter((clip) => clip.trackId === track.trackId)
        .sort((left, right) => compareMediaTime(left.sequenceRange.start, right.sequenceRange.start));
      const segments: TimelineLaneSegment[] = [];
      for (const clip of own) {
        const rawStart = xAtSequenceTime(viewport, clip.sequenceRange.start);
        const rawEnd = xAtSequenceTime(viewport, clip.sequenceRange.end);
        const clippedLeft = rawStart < 0;
        const clippedRight = rawEnd > viewport.widthPx;
        const startPx = Math.max(0, Math.min(viewport.widthPx, rawStart));
        const endPx = Math.max(0, Math.min(viewport.widthPx, rawEnd));
        const widthPx = Math.max(0, endPx - startPx);
        if (widthPx === 0) {
          outsideViewportClipIds.push(clip.clipId);
          continue;
        }
        visibleClipIds.push(clip.clipId);
        segments.push({
          clipId: clip.clipId, label: clip.label, sequenceRange: clip.sequenceRange,
          startPx, endPx, widthPx, clippedLeft, clippedRight, hidden: clip.hidden,
        });
      }
      return {
        trackId: track.trackId, kind: track.kind, position: track.position, name: track.name,
        hidden: track.hidden, muted: track.muted, locked: track.locked,
        segments, empty: segments.length === 0,
      };
    });

  return timelineProjectionSchema.parse({
    viewport, lanes, visibleClipIds, outsideViewportClipIds, orphanClipIds,
  });
}

export const temporalSelectionCoverageSchema = z.object({
  /** 该时间点所在（或与之相交）的片段 id（POINT 选择用） */
  atTime: z.array(z.string().min(1)),
  /** 被选择区间**完整**覆盖的片段 id */
  fullyCovered: z.array(z.string().min(1)),
  /** 与选择区间**部分**相交的片段 id */
  partiallyCovered: z.array(z.string().min(1)),
}).strict();
export type TemporalSelectionCoverage = z.infer<typeof temporalSelectionCoverageSchema>;

/**
 * 时间选区覆盖了哪些片段（纯函数；用于"按时间选段 → 作用到真实片段"）。
 * - `POINT`：返回包含该时间点的片段（半开区间 `[start,end)`）；
 * - `RANGES`：分别给出完全覆盖与部分相交；**不合并**显式区间（与 §4.1 一致）。
 */
export function clipsInTemporalSelection(input: {
  clips: readonly TimelineProjectionClip[];
  selection: TemporalSelection | null;
  /** 只看这些轨道（缺省 = 全部）；可用于"轨道作用域" */
  trackIds?: readonly string[];
}): TemporalSelectionCoverage {
  const empty: TemporalSelectionCoverage = { atTime: [], fullyCovered: [], partiallyCovered: [] };
  if (input.selection === null) return empty;
  const scoped = input.trackIds === undefined
    ? input.clips
    : input.clips.filter((clip) => input.trackIds!.includes(clip.trackId));

  if (input.selection.kind === 'POINT') {
    const at = input.selection.at;
    const atTime = scoped.filter((clip) =>
      compareMediaTime(clip.sequenceRange.start, at) <= 0 && compareMediaTime(at, clip.sequenceRange.end) < 0)
      .map((clip) => clip.clipId);
    return temporalSelectionCoverageSchema.parse({ ...empty, atTime });
  }

  const ranges: readonly MediaRange[] = temporalSelectionRanges(input.selection);
  const fullyCovered = new Set<string>();
  const partiallyCovered = new Set<string>();
  for (const clip of scoped) {
    for (const range of ranges) {
      const startsInside = compareMediaTime(clip.sequenceRange.start, range.start) >= 0;
      const endsInside = compareMediaTime(clip.sequenceRange.end, range.end) <= 0;
      const overlaps = compareMediaTime(clip.sequenceRange.start, range.end) < 0
        && compareMediaTime(range.start, clip.sequenceRange.end) < 0;
      if (!overlaps) continue;
      if (startsInside && endsInside) fullyCovered.add(clip.clipId);
      else partiallyCovered.add(clip.clipId);
    }
  }
  for (const id of fullyCovered) partiallyCovered.delete(id);
  return temporalSelectionCoverageSchema.parse({ ...empty, fullyCovered: [...fullyCovered], partiallyCovered: [...partiallyCovered] });
}

/** 供调用方构造 `POINT` 选择的最小助手（避免各处手写形状）。 */
export function pointSelection(time: MediaTime): TemporalSelection {
  return { kind: 'POINT', at: mediaTimeSchema.parse(time), boundaryDirection: 'AT' };
}
