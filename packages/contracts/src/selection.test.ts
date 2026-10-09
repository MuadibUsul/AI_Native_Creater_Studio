import { describe, expect, it } from 'vitest';
import {
  canTransitionIntentRevision,
  geometrySelectionSchema,
  geometrySetIssues,
  intentRevisionSchema,
  polygonArea,
  polygonSelfIntersects,
  polylineLength,
  selectionAnchorSchema,
  selectionFingerprintInput,
  type GeometrySelection,
} from './index.js';

/** N04-09-s1：点线面几何 × 时间定位 × 选择锚点与意图修订的统一契约（增量设计 §3—§5、§8）。 */

const mt = (ticks: string) => ({ ticks, timebase: { num: 1, den: 1_000 } });
const space = { kind: 'PREVIEW_FRAME' as const, previewRevision: 3, viewport: { width: 1920, height: 1080 }, sequenceTime: mt('1500'), sourcePts: null };

const point = (x: number, y: number, role: GeometrySelection['role'] = 'TARGET') => ({ kind: 'POINT' as const, role, coordinateSpaceRef: space, point: { x, y }, geometryRevision: 1 });
const polyline = (points: { x: number; y: number }[], role: GeometrySelection['role'] = 'MOTION_PATH', extra: Record<string, unknown> = {}) =>
  ({ kind: 'POLYLINE' as const, role, coordinateSpaceRef: space, points, geometryRevision: 1, ...extra });
const polygon = (points: { x: number; y: number }[], role: GeometrySelection['role'] = 'EXCLUDE') =>
  ({ kind: 'POLYGON' as const, role, coordinateSpaceRef: space, points, closed: true, geometryRevision: 1 });
const rect = (role: GeometrySelection['role'] = 'TARGET') => ({ kind: 'RECT' as const, role, coordinateSpaceRef: space, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, geometryRevision: 1 });
const brush = (points: { x: number; y: number }[], polarity: 'INCLUDE' | 'EXCLUDE' = 'EXCLUDE') =>
  ({ kind: 'BRUSH' as const, role: 'PROTECT' as const, coordinateSpaceRef: space, points, stroke: { width: 0.05, polarity }, geometryRevision: 1 });

const anchorOf = (overrides: Partial<Record<string, unknown>> = {}) =>
  selectionAnchorSchema.parse({
    anchorId: 'anch_1', workspaceId: 'ws_1', projectId: 'prj_1', sequenceId: 'seq_1', revision: 1,
    geometries: [], orderedTargetRefs: [], temporalSelection: null,
    fingerprintInput: 'placeholder',
    ...overrides,
  });

describe('几何选择契约（点/线/面）', () => {
  it('点：归一化坐标与有限性；POINT 不表示时间范围', () => {
    expect(geometrySelectionSchema.safeParse(point(0.5, 0.5)).success).toBe(true);
    expect(geometrySelectionSchema.safeParse(point(3, 0.5)).success).toBe(false); // 超出允许范围
    expect(geometrySelectionSchema.safeParse(point(Number.NaN, 0.5)).success).toBe(false);
    // 时间点走 temporalSelection，而不是"零长度的几何"
    const anchor = anchorOf({ temporalSelection: { kind: 'POINT', at: mt('2000') } });
    expect(anchor.temporalSelection).toEqual({ kind: 'POINT', at: mt('2000'), boundaryDirection: 'AT' });
  });

  it('线：MOTION_PATH 必须给出方向；退化线被拒；BOUNDARY 必须明确边侧', () => {
    expect(geometrySelectionSchema.safeParse(polyline([{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.2 }])).success).toBe(false); // 缺 direction
    expect(geometrySelectionSchema.safeParse(polyline([{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.2 }], 'MOTION_PATH', { direction: 'FORWARD' })).success).toBe(true);
    expect(geometrySelectionSchema.safeParse(polyline([{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }], 'MOTION_PATH', { direction: 'FORWARD' })).success).toBe(false); // 退化
    expect(polylineLength([{ x: 0, y: 0 }, { x: 0.6, y: 0.8 }])).toBeCloseTo(1, 10);
    // 边界线：必须给边侧，且非边界不得给
    expect(geometrySelectionSchema.safeParse(polyline([{ x: 0, y: 0.4 }, { x: 1, y: 0.4 }], 'BOUNDARY')).success).toBe(false);
    expect(geometrySelectionSchema.safeParse(polyline([{ x: 0, y: 0.4 }, { x: 1, y: 0.4 }], 'BOUNDARY', { boundarySide: 'ABOVE' })).success).toBe(true);
    expect(geometrySelectionSchema.safeParse({ ...rect('TARGET'), boundarySide: 'ABOVE' }).success).toBe(false);
    // 非 MOTION_PATH 不得带 direction（用途不明确时就问用户，不猜）
    expect(geometrySelectionSchema.safeParse(polyline([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }], 'BOUNDARY', { direction: 'FORWARD', boundarySide: 'BELOW' })).success).toBe(false);
  });

  it('面：矩形需要正宽高；多边形拒绝空面与自交；笔刷保留宽度与正负意义', () => {
    expect(geometrySelectionSchema.safeParse(rect()).success).toBe(true);
    expect(geometrySelectionSchema.safeParse({ ...rect(), rect: { x: 0.1, y: 0.2, width: 0, height: 0.4 } }).success).toBe(false);
    expect(polygonArea([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }])).toBeCloseTo(1, 10);
    // 空面（三点共线）
    expect(geometrySelectionSchema.safeParse(polygon([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }])).success).toBe(false);
    // 自交（蝴蝶形）
    const bowtie = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
    expect(polygonSelfIntersects(bowtie)).toBe(true);
    expect(geometrySelectionSchema.safeParse(polygon(bowtie)).success).toBe(false);
    expect(geometrySelectionSchema.safeParse(polygon([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }])).success).toBe(true);
    // 笔刷：宽度必须为正，正负笔刷保留
    expect(geometrySelectionSchema.safeParse(brush([{ x: 0, y: 0 }, { x: 0.2, y: 0.2 }])).success).toBe(true);
    expect(geometrySelectionSchema.safeParse({ ...brush([{ x: 0, y: 0 }, { x: 0.2, y: 0.2 }]), stroke: { width: 0, polarity: 'EXCLUDE' } }).success).toBe(false);
  });

  it('工作区/来源/目标：SOURCE 与 DESTINATION 必须成对，且不能压成单点', () => {
    // 集合级校验作用于**解析后的**几何（default 已填充），因此这里显式 parse
    const source = geometrySelectionSchema.parse(polyline([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], 'SOURCE'));
    const destination = geometrySelectionSchema.parse(polyline([{ x: 0.7, y: 0.7 }, { x: 0.8, y: 0.8 }], 'DESTINATION'));
    expect(geometrySetIssues([source, destination])).toEqual([]);
    expect(geometrySetIssues([source])[0]).toContain('SOURCE/DESTINATION');
    expect(geometrySelectionSchema.safeParse(point(0.1, 0.1, 'SOURCE')).success).toBe(false); // 单点不能当指示线
  });
});

describe('SelectionAnchor 与 IntentRevision 契约', () => {
  it('作用域合法组合：OBJECT_TRACKED 需要 trackingRef；AMBIGUOUS 必须带候选证据；标题不重名', () => {
    expect(selectionAnchorSchema.safeParse({ anchorId: 'anch_1', workspaceId: 'ws_1', projectId: 'prj_1', sequenceId: 'seq_1', revision: 1, fingerprintInput: 'x' }).success).toBe(true);
    const tracked = selectionAnchorSchema.safeParse({
      anchorId: 'anch_1', workspaceId: 'ws_1', projectId: 'prj_1', sequenceId: 'seq_1', revision: 1,
      regionMode: 'OBJECT_TRACKED', trackingRef: 'trkobj_1', fingerprintInput: 'x',
    });
    expect(tracked.success).toBe(true);
    const trackedMissingRef = selectionAnchorSchema.safeParse({
      anchorId: 'anch_1', workspaceId: 'ws_1', projectId: 'prj_1', sequenceId: 'seq_1', revision: 1,
      regionMode: 'OBJECT_TRACKED', fingerprintInput: 'x',
    });
    expect(trackedMissingRef.success).toBe(false);
    const ambiguous = selectionAnchorSchema.safeParse({
      anchorId: 'anch_1', workspaceId: 'ws_1', projectId: 'prj_1', sequenceId: 'seq_1', revision: 1,
      resolutionStatus: 'AMBIGUOUS', fingerprintInput: 'x',
    });
    expect(ambiguous.success).toBe(false);
    const duplicateLabels = selectionAnchorSchema.safeParse({
      anchorId: 'anch_1', workspaceId: 'ws_1', projectId: 'prj_1', sequenceId: 'seq_1', revision: 1, fingerprintInput: 'x',
      orderedTargetRefs: [
        { targetRef: 'clp_1', targetKind: 'CLIP', label: 'A' },
        { targetRef: 'clp_2', targetKind: 'CLIP', label: 'A' },
      ],
    });
    expect(duplicateLabels.success).toBe(false);
  });

  it('时空联合：区间 + 多区间 + 轨道与属性作用域一并进入同一锚点', () => {
    const anchor = anchorOf({
      geometries: [rect()],
      orderedTargetRefs: [{ targetRef: 'clp_1', targetKind: 'CLIP', label: 'A', assetVersionId: 'av_1' }],
      temporalSelection: { kind: 'RANGES', ranges: [{ start: mt('12000'), end: mt('15000') }, { start: mt('18000'), end: mt('19000') }] },
      trackScope: { kind: 'TRACKS', trackIds: ['trk_1'] },
      propertyScope: ['opacity'],
      regionMode: 'SCREEN_FIXED',
      timeBindingPolicy: 'SEQUENCE_FIXED',
    });
    expect(anchor.temporalSelection).toMatchObject({ kind: 'RANGES' });
    expect(anchor.propertyScope).toEqual(['opacity']);
    expect(anchor.regionMode).toBe('SCREEN_FIXED');
  });

  it('指纹输入确定性：内容相同 → 相同；改变目标/时间/区域模式 → 不同（供采用绑定使用）', () => {
    const base = anchorOf({
      geometries: [rect()],
      orderedTargetRefs: [{ targetRef: 'clp_1', targetKind: 'CLIP', label: 'A', assetVersionId: 'av_1' }],
      temporalSelection: { kind: 'RANGES', ranges: [{ start: mt('1000'), end: mt('2000') }] },
    });
    const same = anchorOf({
      geometries: [rect()],
      orderedTargetRefs: [{ targetRef: 'clp_1', targetKind: 'CLIP', label: 'A', assetVersionId: 'av_1' }],
      temporalSelection: { kind: 'RANGES', ranges: [{ start: mt('1000'), end: mt('2000') }] },
    });
    const changedTrack = anchorOf({
      geometries: [rect()],
      orderedTargetRefs: [{ targetRef: 'clp_1', targetKind: 'CLIP', label: 'A', assetVersionId: 'av_1' }],
      temporalSelection: { kind: 'RANGES', ranges: [{ start: mt('1000'), end: mt('2000') }] },
      regionMode: 'OBJECT_TRACKED', trackingRef: 'trkobj_1',
    });
    expect(selectionFingerprintInput(base)).toBe(selectionFingerprintInput(same));
    expect(selectionFingerprintInput(base)).not.toBe(selectionFingerprintInput(changedTrack));
  });

  it('IntentRevision：状态机只允许单向前进；SEALED 不允许未解析指代；改口产生新修订', () => {
    expect(canTransitionIntentRevision('DRAFT', 'SEALED')).toBe(true);
    expect(canTransitionIntentRevision('DRAFT', 'NEEDS_CLARIFICATION')).toBe(true);
    expect(canTransitionIntentRevision('SEALED', 'SUPERSEDED')).toBe(true);
    expect(canTransitionIntentRevision('SEALED', 'DRAFT')).toBe(false);
    expect(canTransitionIntentRevision('SUPERSEDED', 'SEALED')).toBe(false);
    expect(canTransitionIntentRevision('CANCELLED', 'DRAFT')).toBe(false);

    const first = intentRevisionSchema.safeParse({
      intentRevisionId: 'ir_1', sessionId: 'sess_1', utteranceId: 'utt_1', intentId: 'int_1', revision: 1,
      selectionAnchorId: 'anch_1', transcriptRevision: 0, targetBindings: [], status: 'DRAFT',
    });
    expect(first.success).toBe(true);
    // 非首修订必须声明被取代者
    expect(intentRevisionSchema.safeParse({
      intentRevisionId: 'ir_2', sessionId: 'sess_1', utteranceId: 'utt_1', intentId: 'int_1', revision: 2,
      selectionAnchorId: 'anch_1', transcriptRevision: 1, targetBindings: [], status: 'DRAFT',
    }).success).toBe(false);
    const superseding = intentRevisionSchema.safeParse({
      intentRevisionId: 'ir_2', sessionId: 'sess_1', utteranceId: 'utt_2', intentId: 'int_1', revision: 2,
      selectionAnchorId: 'anch_1', transcriptRevision: 1, targetBindings: [], status: 'DRAFT', supersedesIntentRevisionId: 'ir_1',
    });
    expect(superseding.success).toBe(true);
    // SEALED 必须有已解析目标与解释动作（未完整语义不得变更确认工程）
    expect(intentRevisionSchema.safeParse({
      intentRevisionId: 'ir_3', sessionId: 'sess_1', utteranceId: 'utt_3', intentId: 'int_1', revision: 1,
      selectionAnchorId: 'anch_1', transcriptRevision: 2, status: 'SEALED', interpretedAction: 'trim_clip',
      targetBindings: [{ reference: '这个', role: 'TARGET', resolvedTargetRefs: [] }],
    }).success).toBe(false);
    expect(intentRevisionSchema.safeParse({
      intentRevisionId: 'ir_3', sessionId: 'sess_1', utteranceId: 'utt_3', intentId: 'int_1', revision: 1,
      selectionAnchorId: 'anch_1', transcriptRevision: 2, status: 'SEALED', interpretedAction: 'trim_clip',
      targetBindings: [{ reference: '这个', role: 'TARGET', resolvedTargetRefs: ['clp_1'] }],
    }).success).toBe(true);
  });
});
