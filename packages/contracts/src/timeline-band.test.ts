import { describe, expect, it } from 'vitest';
import {
  MAX_TIMELINE_RANGES,
  addTemporalRange,
  composeSelectionAnchor,
  describeTemporalSelection,
  mediaRangeSchema,
  mediaTimeSchema,
  mediaTimeToFrameIndex,
  sequenceTimeAtX,
  temporalSelectionEquals,
  temporalSelectionFromDrag,
  temporalSelectionRanges,
  timelineViewportSchema,
  xAtSequenceTime,
} from './index.js';

/** N04-04-s1：横向时间带换算（可视窗口 → 有理时基）与播放头/时间选区分离。 */

const mt = (seconds: number) => mediaTimeSchema.parse({ ticks: String(Math.round(seconds * 1000)), timebase: { num: 1, den: 1000 } });
const viewport = (start: number, end: number, widthPx = 1000) =>
  timelineViewportSchema.parse({ start: mt(start), end: mt(end), widthPx });

describe('timeline-band 可视窗口换算', () => {
  it('中点/端点映射到有理时基，且 xAtSequenceTime 可逆', () => {
    const window = viewport(0, 10);
    expect(sequenceTimeAtX(window, 0).ticks).toBe('0');
    expect(sequenceTimeAtX(window, 500).timebase).toEqual({ num: 1, den: 1_000_000_000 });
    expect(Number(sequenceTimeAtX(window, 500).ticks) / 1e9).toBeCloseTo(5, 6);
    expect(Number(sequenceTimeAtX(window, 1000).ticks) / 1e9).toBeCloseTo(10, 6);
    expect(xAtSequenceTime(window, sequenceTimeAtX(window, 250))).toBeCloseTo(250, 6);
  });

  it('结果不落在浮点毫秒上，而是精确有理时基；非零起点窗口正确', () => {
    const window = viewport(2, 6, 800);
    const time = sequenceTimeAtX(window, 200); // 2 + 0.25*4 = 3s
    expect(time.timebase).toEqual({ num: 1, den: 1_000_000_000 });
    expect(Number(time.ticks) / 1e9).toBeCloseTo(3, 6);
    expect(xAtSequenceTime(window, mt(4))).toBeCloseTo(400, 6);
  });

  it('提供 frameRate 时吸附到最近帧边界', () => {
    const window = viewport(0, 10);
    const frameRate = { num: 30, den: 1 };
    const snapped = sequenceTimeAtX(window, 333, { frameRate });
    expect(mediaTimeToFrameIndex(snapped, frameRate, 'nearest')).toBe('100');
  });

  it('非法/空窗口被拒（start 必须早于 end）', () => {
    expect(() => timelineViewportSchema.parse({ start: mt(5), end: mt(5), widthPx: 100 })).toThrow();
    expect(() => timelineViewportSchema.parse({ start: mt(6), end: mt(1), widthPx: 100 })).toThrow();
    expect(() => sequenceTimeAtX(viewport(0, 10), Number.NaN)).toThrow();
  });
});

describe('timeline-band 播放头与时间选区分离', () => {
  it('单击（位移小于阈值）产生 POINT，而不是零长度 RANGE', () => {
    const selection = temporalSelectionFromDrag({ viewport: viewport(0, 10), anchorXPx: 400, focusXPx: 401 });
    expect(selection.kind).toBe('POINT');
    if (selection.kind === 'POINT') expect(Number(selection.at.ticks) / 1e9).toBeCloseTo(4, 6);
  });

  it('拖动产生半开区间；逆序拖动被规范化但保留时间范围', () => {
    const forward = temporalSelectionFromDrag({ viewport: viewport(0, 10), anchorXPx: 200, focusXPx: 800 });
    expect(forward.kind).toBe('RANGES');
    if (forward.kind === 'RANGES') {
      expect(Number(forward.ranges[0]!.start.ticks) / 1e9).toBeCloseTo(2, 6);
      expect(Number(forward.ranges[0]!.end.ticks) / 1e9).toBeCloseTo(8, 6);
    }
    const reverse = temporalSelectionFromDrag({ viewport: viewport(0, 10), anchorXPx: 800, focusXPx: 200 });
    expect(temporalSelectionEquals(forward, reverse)).toBe(true);
  });

  it('帧吸附导致拖动坍缩为同一点时如实降级为 POINT（不制造非法空区间）', () => {
    const selection = temporalSelectionFromDrag({
      viewport: viewport(0, 10),
      anchorXPx: 100,
      focusXPx: 110,
      frameRate: { num: 1, den: 1 },
    });
    expect(selection.kind).toBe('POINT');
  });

  it('多区间保留显式区间，不合并中间整段；重复区间去重', () => {
    const first = mediaRangeSchema.parse({ start: mt(1), end: mt(2) });
    const second = mediaRangeSchema.parse({ start: mt(5), end: mt(6) });
    const multi = addTemporalRange(addTemporalRange(null, first), second);
    expect(temporalSelectionRanges(multi)).toHaveLength(2);
    const deduped = addTemporalRange(multi, first);
    expect(temporalSelectionRanges(deduped)).toHaveLength(2);
    // 中间 2–5 秒没有被并入（不是 1–6 的单区间）
    expect(describeTemporalSelection(multi, (time) => `${String(Number(time.ticks) / 1000)}s`)).toBe('1s–2s · 5s–6s');
  });

  it('区间数量上限 fail-closed', () => {
    let result = addTemporalRange(null, mediaRangeSchema.parse({ start: mt(0), end: mt(1) }));
    for (let index = 1; index < MAX_TIMELINE_RANGES; index += 1) {
      result = addTemporalRange(result, mediaRangeSchema.parse({ start: mt(index * 2), end: mt(index * 2 + 1) }));
    }
    expect(temporalSelectionRanges(result)).toHaveLength(MAX_TIMELINE_RANGES);
    expect(() => addTemporalRange(result, mediaRangeSchema.parse({ start: mt(500), end: mt(501) }))).toThrow();
  });
});

describe('timeline-band 与 SelectionAnchor 组合', () => {
  it('时间选区 + 对象引用组装成规范锚点并带确定性指纹', () => {
    const temporal = temporalSelectionFromDrag({ viewport: viewport(0, 10), anchorXPx: 120, focusXPx: 450 });
    const anchor = composeSelectionAnchor({
      anchorId: 'anc_1',
      workspaceId: 'ws_1',
      projectId: 'prj_1',
      sequenceId: 'seq_1',
      temporalSelection: temporal,
      orderedTargetRefs: [{ targetRef: 'clip_1', targetKind: 'CLIP', label: 'A', assetVersionId: 'av_1' }],
    });
    expect(anchor.temporalSelection?.kind).toBe('RANGES');
    expect(anchor.fingerprintInput).toContain('clip_1');
    const again = composeSelectionAnchor({
      anchorId: 'anc_1',
      workspaceId: 'ws_1',
      projectId: 'prj_1',
      sequenceId: 'seq_1',
      temporalSelection: temporal,
      orderedTargetRefs: [{ targetRef: 'clip_1', targetKind: 'CLIP', label: 'A', assetVersionId: 'av_1' }],
    });
    expect(again.fingerprintInput).toBe(anchor.fingerprintInput);
  });
});
