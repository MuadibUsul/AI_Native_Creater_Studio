import { describe, expect, it } from 'vitest';
import { clipsInTemporalSelection, pointSelection, projectSequenceToTimeline } from './timeline-projection.js';
import type { TimelineProjectionClip, TimelineProjectionTrack } from './timeline-projection.js';
import { timelineViewportSchema } from './timeline-band.js';
import { legacyMillisecondsToMediaTime } from './common/media-time.js';

/**
 * N04-04（主体）：真实片段/轨道 → 横向时间带投影 + 时间选区覆盖解析。
 * 关键点：有理时基换算、越界裁剪如实标注、零宽不假装可见、显式多区间不合并。
 */
const mt = (ms: number) => legacyMillisecondsToMediaTime(ms);
const range = (startMs: number, endMs: number) => ({ start: mt(startMs), end: mt(endMs) });
/** 视窗：0—10s 映射到 1000px（1s = 100px）。 */
const viewport = timelineViewportSchema.parse({ start: mt(0), end: mt(10_000), widthPx: 1_000 });

const tracks: TimelineProjectionTrack[] = [
  { trackId: 'trk_v', kind: 'VIDEO', position: 0, name: 'V1', hidden: false, muted: false, locked: false },
  { trackId: 'trk_a', kind: 'AUDIO', position: 1, name: 'A1', hidden: false, muted: false, locked: false },
];
const clips: TimelineProjectionClip[] = [
  { clipId: 'clip_a', trackId: 'trk_v', sequenceRange: range(0, 3_000), label: 'A', hidden: false },
  { clipId: 'clip_b', trackId: 'trk_v', sequenceRange: range(4_000, 7_000), label: 'B', hidden: false },
  { clipId: 'clip_audio', trackId: 'trk_a', sequenceRange: range(0, 3_000), label: 'A audio', hidden: false },
];

describe('N04-04 projectSequenceToTimeline', () => {
  it('按轨道 position 与片段开始时间排序，像素几何来自有理时基换算', () => {
    const projection = projectSequenceToTimeline({ tracks, clips, viewport });
    expect(projection.lanes.map((lane) => lane.trackId)).toEqual(['trk_v', 'trk_a']);
    const video = projection.lanes[0]!;
    expect(video.segments.map((segment) => segment.clipId)).toEqual(['clip_a', 'clip_b']);
    expect(video.segments[0]).toMatchObject({ startPx: 0, endPx: 300, widthPx: 300, clippedLeft: false, clippedRight: false });
    expect(video.segments[1]).toMatchObject({ startPx: 400, endPx: 700, widthPx: 300 });
    expect(projection.lanes[1]!.kind).toBe('AUDIO');
  });

  it('部分落在可视窗口外的片段如实标注被裁剪，不假装整段可见', () => {
    const wideViewport = timelineViewportSchema.parse({ start: mt(2_000), end: mt(6_000), widthPx: 400 }); // 1s = 100px
    const projection = projectSequenceToTimeline({ tracks, clips, viewport: wideViewport });
    const segments = projection.lanes[0]!.segments;
    // clip_a：0—3s，视窗从 2s 起 → 左侧被裁
    const a = segments.find((segment) => segment.clipId === 'clip_a')!;
    expect(a).toMatchObject({ clippedLeft: true, clippedRight: false, startPx: 0, endPx: 100 });
    // clip_b：4—7s，视窗到 6s → 右侧被裁
    const b = segments.find((segment) => segment.clipId === 'clip_b')!;
    expect(b).toMatchObject({ clippedLeft: false, clippedRight: true, startPx: 200, endPx: 400 });
  });

  it('完全在可视窗口外的片段不进 segments，但如实列入 outsideViewportClipIds', () => {
    const tailViewport = timelineViewportSchema.parse({ start: mt(8_000), end: mt(10_000), widthPx: 200 });
    const projection = projectSequenceToTimeline({ tracks, clips, viewport: tailViewport });
    expect(projection.visibleClipIds).toEqual([]);
    expect(projection.outsideViewportClipIds.sort()).toEqual(['clip_a', 'clip_audio', 'clip_b']);
    expect(projection.lanes.every((lane) => lane.empty)).toBe(true);
  });

  it('引用不存在轨道的片段如实回报为孤儿，不静默丢弃', () => {
    const projection = projectSequenceToTimeline({
      tracks, clips: [...clips, { clipId: 'clip_orphan', trackId: 'trk_missing', sequenceRange: range(0, 1_000), label: '', hidden: false }],
      viewport,
    });
    expect(projection.orphanClipIds).toEqual(['clip_orphan']);
  });

  it('不可见（hidden）片段仍保留在数据里并标 hidden（可见性交给渲染层）', () => {
    const projection = projectSequenceToTimeline({
      tracks, clips: [{ ...clips[0]!, hidden: true }], viewport,
    });
    expect(projection.lanes[0]!.segments[0]).toMatchObject({ clipId: 'clip_a', hidden: true });
  });
});

describe('N04-04 clipsInTemporalSelection', () => {
  it('POINT：半开区间 [start,end) 内包含该时间点的片段命中', () => {
    const coverage = clipsInTemporalSelection({ clips, selection: pointSelection(mt(3_000)) });
    // 3s 是 clip_a 的结束边界 → 不含（半开）
    expect(coverage.atTime).toEqual([]);
    expect(clipsInTemporalSelection({ clips, selection: pointSelection(mt(2_999)) }).atTime.sort()).toEqual(['clip_a', 'clip_audio']);
  });

  it('RANGES：区分完整覆盖与部分相交，且不合并显式多区间', () => {
    const selection = { kind: 'RANGES' as const, ranges: [range(0, 3_000), range(5_000, 6_000)] };
    const coverage = clipsInTemporalSelection({ clips, selection });
    expect(coverage.fullyCovered.sort()).toEqual(['clip_a', 'clip_audio']);
    expect(coverage.partiallyCovered).toEqual(['clip_b']);
  });

  it('轨道作用域：只看指定轨道', () => {
    const selection = { kind: 'RANGES' as const, ranges: [range(0, 3_000)] };
    const coverage = clipsInTemporalSelection({ clips, selection, trackIds: ['trk_a'] });
    expect(coverage.fullyCovered).toEqual(['clip_audio']);
    expect(coverage.partiallyCovered).toEqual([]);
  });

  it('空选择返回全空（不猜测）', () => {
    expect(clipsInTemporalSelection({ clips, selection: null })).toEqual({ atTime: [], fullyCovered: [], partiallyCovered: [] });
  });
});
