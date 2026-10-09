import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { mediaRangeSchema, mediaTimeSchema } from './common/media-time.js';

/**
 * 增量设计（鼠标点线面 × 横向时间定位 × 流式语音）第一批契约：
 * **GeometrySelection / SelectionAnchor / IntentRevision**。
 *
 * 设计纪律（见 `docs/V04/ANCS_v04_Mouse_Voice_Incremental_Design_20261010.md` §3—§5、§8）：
 * - 点、线、面是**同一选择协议**的几何变体，但各自保留几何用途（目标/路径/边界/起点终点/保护/排除），
 *   不得压成 bounding box，也不得用不受控 JSON 承载全部含义（严格判别联合 + 用途必填）；
 * - 空间（几何/对象）× 时间（点/连续区间/多区间）× 轨道与属性 × 绑定版本**合成一个可验证作用域**；
 * - 选择动作本身永不改工程（本文件全是只读数据契约）；
 * - 坐标一律归一化（0..1 相对预览画面），几何按用途做合法性校验（退化线、空面、自交、笔刷宽度）。
 */

export const GEOMETRY_KINDS = ['POINT', 'POLYLINE', 'RECT', 'POLYGON', 'BRUSH'] as const;
export const geometryKindSchema = z.enum(GEOMETRY_KINDS);
export type GeometryKind = z.infer<typeof geometryKindSchema>;

export const GEOMETRY_ROLES = ['TARGET', 'MOTION_PATH', 'BOUNDARY', 'SOURCE', 'DESTINATION', 'PROTECT', 'EXCLUDE'] as const;
export const geometryRoleSchema = z.enum(GEOMETRY_ROLES);
export type GeometryRole = z.infer<typeof geometryRoleSchema>;

/** 归一化画布坐标：允许略微超出画面（用户可能在边缘外起笔），但必须是有限数且不得离画面太远。 */
const normalizedCoord = z.number().finite().min(-0.5).max(1.5);
export const selectionPointSchema = z.object({ x: normalizedCoord, y: normalizedCoord }).strict();
export type SelectionPoint = z.infer<typeof selectionPointSchema>;

const MAX_POINTS = 5_000;
const MIN_SEGMENT_LENGTH = 1e-4;
const MIN_POLYGON_AREA = 1e-6;

export const geometryStrokeSchema = z.object({
  /** 笔刷/线条宽度（归一化，相对画面宽度） */
  width: z.number().finite().positive().max(0.5),
  /** 正笔刷=包含，负笔刷=排除（§3.2 笔刷正负意义必须保留） */
  polarity: z.enum(['INCLUDE', 'EXCLUDE']),
}).strict();

export type GeometryStroke = z.infer<typeof geometryStrokeSchema>;

/** 预览坐标系引用：几何只在某一帧的预览画面上有意义，必须绑定该帧与预览版本。 */
export const coordinateSpaceReferenceSchema = z.object({
  kind: z.literal('PREVIEW_FRAME'),
  previewRevision: z.number().int().nonnegative(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  /** 该帧对应的序列时间（可选：纯空间标注可省略） */
  sequenceTime: mediaTimeSchema.nullable().default(null),
  /** 源时间（源侧标注携带，便于跨 clip 重映射） */
  sourcePts: mediaTimeSchema.nullable().default(null),
}).strict();

export type CoordinateSpaceReference = z.infer<typeof coordinateSpaceReferenceSchema>;

const baseGeometryFields = {
  role: geometryRoleSchema,
  /** 边界线必须明确生效侧（§3.2：不能只按封闭区域处理） */
  boundarySide: z.enum(['ABOVE', 'BELOW', 'LEFT', 'RIGHT', 'INSIDE', 'OUTSIDE']).nullable().default(null),
  coordinateSpaceRef: coordinateSpaceReferenceSchema,
  /** 原始采样引用（复核用；简化几何用于预览，两者都绑定版本） */
  rawSamplesRef: z.string().min(1).max(200).nullable().default(null),
  geometryRevision: z.number().int().nonnegative(),
};

const pointGeometrySchema = z.object({
  kind: z.literal('POINT'),
  ...baseGeometryFields,
  point: selectionPointSchema,
}).strict();

const polylineGeometrySchema = z.object({
  kind: z.literal('POLYLINE'),
  ...baseGeometryFields,
  points: z.array(selectionPointSchema).min(2).max(MAX_POINTS),
  /** 轨迹方向（MOTION_PATH 必填；不得凭"看起来接近闭合"猜用途） */
  direction: z.enum(['FORWARD', 'REVERSE']).nullable().default(null),
  stroke: geometryStrokeSchema.nullable().default(null),
}).strict().superRefine((value, context) => {
  if (value.role === 'MOTION_PATH' && value.direction === null) {
    context.addIssue({ code: 'custom', path: ['direction'], message: 'MOTION_PATH requires an explicit direction' });
  }
  if (value.role !== 'MOTION_PATH' && value.direction !== null) {
    context.addIssue({ code: 'custom', path: ['direction'], message: 'direction is only meaningful for MOTION_PATH' });
  }
  // 退化线：任意相邻两段长度之和必须大于阈值（不能是原地抖动）
  const total = polylineLength(value.points);
  if (total < MIN_SEGMENT_LENGTH) {
    context.addIssue({ code: 'custom', path: ['points'], message: 'polyline is degenerate (zero total length)' });
  }
});

const rectGeometrySchema = z.object({
  kind: z.literal('RECT'),
  ...baseGeometryFields,
  rect: z.object({
    x: normalizedCoord, y: normalizedCoord,
    width: z.number().finite().positive().max(2), height: z.number().finite().positive().max(2),
  }).strict(),
  /** 固定区域还是跟随对象由 SelectionAnchor.regionMode 决定；矩形自身不改变语义 */
  stroke: geometryStrokeSchema.nullable().default(null),
}).strict();

const polygonGeometrySchema = z.object({
  kind: z.literal('POLYGON'),
  ...baseGeometryFields,
  points: z.array(selectionPointSchema).min(3).max(MAX_POINTS),
  closed: z.literal(true),
  stroke: geometryStrokeSchema.nullable().default(null),
}).strict().superRefine((value, context) => {
  if (polygonArea(value.points) < MIN_POLYGON_AREA) {
    context.addIssue({ code: 'custom', path: ['points'], message: 'polygon area is empty (degenerate polygon)' });
  }
  if (polygonSelfIntersects(value.points)) {
    context.addIssue({ code: 'custom', path: ['points'], message: 'polygon self-intersects' });
  }
});

const brushGeometrySchema = z.object({
  kind: z.literal('BRUSH'),
  ...baseGeometryFields,
  points: z.array(selectionPointSchema).min(2).max(MAX_POINTS),
  stroke: geometryStrokeSchema,
  /** 简化几何（预览用；原始采样保留在 rawSamplesRef） */
  simplifiedGeometry: z.object({ points: z.array(selectionPointSchema).min(2).max(MAX_POINTS) }).strict().nullable().default(null),
}).strict();

/**
 * 几何判别联合。用途与几何的合法组合（superRefine 于下方 `geometrySelectionSchema`）：
 * - MOTION_PATH 需要方向；BOUNDARY 需要边侧；SOURCE/DESTINATION 必须成对（§3.2 指示线）；
 * - POINT 只表示目标/锚点，**不得**被当作零长度的时间范围（时间见 `temporalSelection`）。
 */
export const geometrySelectionSchema = z.discriminatedUnion('kind', [
  pointGeometrySchema,
  polylineGeometrySchema,
  rectGeometrySchema,
  polygonGeometrySchema,
  brushGeometrySchema,
]).superRefine((value, context) => {
  if ((value.role === 'SOURCE' || value.role === 'DESTINATION') && value.kind === 'POINT') {
    context.addIssue({ code: 'custom', message: 'SOURCE/DESTINATION 指示线需要线或区域几何，不能用单点表示' });
  }
  if (value.role === 'BOUNDARY' && value.boundarySide === null) {
    context.addIssue({ code: 'custom', path: ['boundarySide'], message: 'BOUNDARY 需要明确边侧（哪一侧生效）' });
  }
  if (value.role !== 'BOUNDARY' && value.boundarySide !== null) {
    context.addIssue({ code: 'custom', path: ['boundarySide'], message: 'boundarySide 只对 BOUNDARY 有意义' });
  }
});

export type GeometrySelection = z.infer<typeof geometrySelectionSchema>;

/**
 * 几何集合级校验（单条几何无法表达的关系）：SOURCE/DESTINATION 必须成对出现（§3.2 指示线：
 * source 与 destination 是两个不同角色，终点不得改写原目标）。
 */
export function geometrySetIssues(geometries: readonly GeometrySelection[]): string[] {
  const issues: string[] = [];
  const sources = geometries.filter((geometry) => geometry.role === 'SOURCE');
  const destinations = geometries.filter((geometry) => geometry.role === 'DESTINATION');
  if ((sources.length > 0 || destinations.length > 0) && (sources.length !== 1 || destinations.length !== 1)) {
    issues.push('SOURCE/DESTINATION 必须各恰好一条（指示线是成对的两种角色）');
  }
  const pointAsTarget = geometries.filter((geometry) => geometry.kind === 'POINT' && geometry.role === 'TARGET');
  if (pointAsTarget.length > 1) {
    issues.push('同一锚点最多一个 TARGET 点（多目标请用 orderedTargetRefs 的显式顺序）');
  }
  return issues;
}

export const SELECTION_REGION_MODES = ['SCREEN_FIXED', 'SOURCE_FIXED', 'OBJECT_TRACKED'] as const;
export const selectionRegionModeSchema = z.enum(SELECTION_REGION_MODES);
export type SelectionRegionMode = z.infer<typeof selectionRegionModeSchema>;

export const SELECTION_TIME_BINDING_POLICIES = ['SEQUENCE_FIXED', 'FOLLOW_OBJECT', 'FOLLOW_SOURCE'] as const;
export const selectionTimeBindingPolicySchema = z.enum(SELECTION_TIME_BINDING_POLICIES);
export type SelectionTimeBindingPolicy = z.infer<typeof selectionTimeBindingPolicySchema>;

/** 时间选择：时间点与（多）区间是**不同**形状，POINT 不得伪装成零长度 RANGE（§4.1）。 */
export const temporalSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('POINT'), at: mediaTimeSchema, boundaryDirection: z.enum(['BEFORE', 'AFTER', 'AT']).default('AT') }).strict(),
  z.object({ kind: z.literal('RANGES'), ranges: z.array(mediaRangeSchema).min(1).max(64) }).strict(),
]);

export type TemporalSelection = z.infer<typeof temporalSelectionSchema>;

export const orderedTargetRefSchema = z.object({
  /** 目标引用（对象 id / 片段 id / 轨道 id 等，由 targetKind 解释） */
  targetRef: opaqueIdSchema,
  targetKind: z.enum(['CLIP', 'VISUAL_OBJECT', 'CAPTION', 'AUDIO_REGION', 'EFFECT_INSTANCE', 'TRACK', 'PIXEL_REGION']),
  /** 多选顺序标签（A、B…；后一次点击不得无条件覆盖前一个目标） */
  label: z.string().min(1).max(8),
  /** 该目标绑定的版本（可见即可选的版本语义） */
  assetVersionId: opaqueIdSchema.nullable().default(null),
}).strict();

export type OrderedTargetRef = z.infer<typeof orderedTargetRefSchema>;

export const selectionResolutionStatusSchema = z.enum(['RESOLVED', 'PARTIAL', 'AMBIGUOUS', 'FAILED']);

export const selectionRemapEntrySchema = z.object({
  fromRevision: z.number().int().nonnegative(),
  toRevision: z.number().int().nonnegative(),
  reason: z.string().min(1).max(200),
  at: z.string().min(1).max(40),
}).strict();

/**
 * SelectionAnchor（唯一权威选择结构；AttentionSnapshot 的选择子结构，见 N04-05/N04-09）。
 * 实际作用域 = 几何/对象 × 时间 × 轨道与属性 × 绑定版本。
 */
export const selectionAnchorSchema = z.object({
  anchorId: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  /** 锚点自身修订号（选择变化递增；不写工程） */
  revision: z.number().int().nonnegative(),
  geometries: z.array(geometrySelectionSchema).max(64).default([]),
  orderedTargetRefs: z.array(orderedTargetRefSchema).max(64).default([]),
  temporalSelection: temporalSelectionSchema.nullable().default(null),
  trackScope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ALL') }).strict(),
    z.object({ kind: z.literal('TRACKS'), trackIds: z.array(opaqueIdSchema).min(1).max(64) }).strict(),
  ]).default({ kind: 'ALL' }),
  /** 属性作用域（例如 ['opacity']、['audio.gain']；空 = 未限定） */
  propertyScope: z.array(z.string().min(1).max(64)).max(32).default([]),
  regionMode: selectionRegionModeSchema.default('SCREEN_FIXED'),
  timeBindingPolicy: selectionTimeBindingPolicySchema.default('SEQUENCE_FIXED'),
  /** OBJECT_TRACKED 必须给出跟踪引用（不能用固定矩形冒充跟踪） */
  trackingRef: opaqueIdSchema.nullable().default(null),
  resolutionStatus: selectionResolutionStatusSchema.default('RESOLVED'),
  evidenceRefs: z.array(z.string().min(1).max(200)).max(64).default([]),
  remapHistory: z.array(selectionRemapEntrySchema).max(64).default([]),
  /** 供采用绑定使用的确定性指纹输入（服务端 sha256 后作为 selectionFingerprint） */
  fingerprintInput: z.string().min(1).max(8_000),
}).strict().superRefine((value, context) => {
  if (value.regionMode === 'OBJECT_TRACKED' && value.trackingRef === null) {
    context.addIssue({ code: 'custom', path: ['trackingRef'], message: 'OBJECT_TRACKED 需要 trackingRef' });
  }
  if (value.resolutionStatus === 'AMBIGUOUS' && value.evidenceRefs.length === 0) {
    context.addIssue({ code: 'custom', path: ['evidenceRefs'], message: 'AMBIGUOUS 必须给出候选证据引用（不随机选一个）' });
  }
  const labels = new Set<string>();
  for (const target of value.orderedTargetRefs) {
    if (labels.has(target.label)) {
      context.addIssue({ code: 'custom', path: ['orderedTargetRefs'], message: `重复的目标标签：${target.label}` });
    }
    labels.add(target.label);
  }
  for (const issue of geometrySetIssues(value.geometries)) {
    context.addIssue({ code: 'custom', path: ['geometries'], message: issue });
  }
});

export type SelectionAnchor = z.infer<typeof selectionAnchorSchema>;

/** 几何辅助（纯函数，供校验与测试复用）。 */
export function polylineLength(points: readonly SelectionPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    total += Math.hypot(current.x - previous.x, current.y - previous.y);
  }
  return total;
}

export function polygonArea(points: readonly SelectionPoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}

const segmentsIntersect = (a1: SelectionPoint, a2: SelectionPoint, b1: SelectionPoint, b2: SelectionPoint): boolean => {
  const cross = (o: SelectionPoint, a: SelectionPoint, b: SelectionPoint): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};

/** 多边形自交检测（相邻边共享端点不算自交）。 */
export function polygonSelfIntersects(points: readonly SelectionPoint[]): boolean {
  const count = points.length;
  for (let i = 0; i < count; i += 1) {
    const a1 = points[i]!;
    const a2 = points[(i + 1) % count]!;
    for (let j = i + 1; j < count; j += 1) {
      // 跳过相邻边（共享端点）
      if (j === i || (j + 1) % count === i || j === (i + 1) % count) continue;
      const b1 = points[j]!;
      const b2 = points[(j + 1) % count]!;
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

export const INTENT_REVISION_STATUSES = ['DRAFT', 'NEEDS_CLARIFICATION', 'SEALED', 'SUPERSEDED', 'CANCELLED'] as const;
export const intentRevisionStatusSchema = z.enum(INTENT_REVISION_STATUSES);
export type IntentRevisionStatus = z.infer<typeof intentRevisionStatusSchema>;

/** 允许的状态迁移（终态不可回退；改口产生**新修订**而不是改写已确认修订）。 */
const INTENT_TRANSITIONS: Record<IntentRevisionStatus, readonly IntentRevisionStatus[]> = {
  DRAFT: ['NEEDS_CLARIFICATION', 'SEALED', 'CANCELLED', 'SUPERSEDED'],
  NEEDS_CLARIFICATION: ['DRAFT', 'SEALED', 'CANCELLED', 'SUPERSEDED'],
  SEALED: ['SUPERSEDED', 'CANCELLED'],
  SUPERSEDED: [],
  CANCELLED: [],
};

export function canTransitionIntentRevision(from: IntentRevisionStatus, to: IntentRevisionStatus): boolean {
  return from === to || INTENT_TRANSITIONS[from].includes(to);
}

export const intentTargetBindingSchema = z.object({
  /** 用户话语里的指代（"这个""这两个""中间那个"…） */
  reference: z.string().min(1).max(200),
  role: geometryRoleSchema,
  /** 解析出的目标（可为空 = 未解析，需澄清；不得随机选一个） */
  resolvedTargetRefs: z.array(opaqueIdSchema).max(64).default([]),
  evidenceRefs: z.array(z.string().min(1).max(200)).max(64).default([]),
}).strict();

export type IntentTargetBinding = z.infer<typeof intentTargetBindingSchema>;

/**
 * IntentRevision：一次用户意图的**可修订**记录（§8.3）。
 * 同一意图的"再小一点/不是左边是右边"产生新的 revision 并 supersede 旧修订；
 * 改变目标、时间范围或重要限制后，旧计算结果失效（由 status/ supersedes 链表达）。
 */
export const intentRevisionSchema = z.object({
  intentRevisionId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  utteranceId: opaqueIdSchema,
  intentId: opaqueIdSchema,
  revision: z.number().int().positive(),
  selectionAnchorId: opaqueIdSchema,
  transcriptRevision: z.number().int().nonnegative(),
  targetBindings: z.array(intentTargetBindingSchema).max(64),
  /** 解析出的动作（规范操作类型名；未解析为 null） */
  interpretedAction: z.string().min(1).max(64).nullable().default(null),
  explicitConstraints: z.array(z.string().min(1).max(200)).max(32).default([]),
  assumptions: z.array(z.string().min(1).max(200)).max(32).default([]),
  status: intentRevisionStatusSchema,
  supersedesIntentRevisionId: opaqueIdSchema.nullable().default(null),
  /** 该修订产出的候选操作（可能为空 = 还在澄清） */
  proposedOperationRefs: z.array(z.string().min(1).max(200)).max(256).default([]),
}).strict().superRefine((value, context) => {
  if (value.revision === 1 && value.supersedesIntentRevisionId !== null) {
    context.addIssue({ code: 'custom', path: ['supersedesIntentRevisionId'], message: '首个修订不能 supersede 任何东西' });
  }
  if (value.revision > 1 && value.supersedesIntentRevisionId === null) {
    context.addIssue({ code: 'custom', path: ['supersedesIntentRevisionId'], message: '非首个修订必须声明被取代的修订' });
  }
  const unresolved = value.targetBindings.filter((binding) => binding.resolvedTargetRefs.length === 0);
  if (value.status === 'SEALED' && unresolved.length > 0) {
    context.addIssue({ code: 'custom', path: ['targetBindings'], message: 'SEALED 修订不允许存在未解析指代' });
  }
  if (value.status === 'SEALED' && value.interpretedAction === null) {
    context.addIssue({ code: 'custom', path: ['interpretedAction'], message: 'SEALED 修订必须给出解释出的动作' });
  }
});

export type IntentRevision = z.infer<typeof intentRevisionSchema>;

/** 供采用绑定使用的确定性指纹输入（规范序列化；服务端对其做 sha256）。 */
export function selectionFingerprintInput(
  anchor: Pick<
    SelectionAnchor,
    'sequenceId' | 'geometries' | 'orderedTargetRefs' | 'temporalSelection' | 'trackScope' | 'propertyScope' | 'regionMode' | 'timeBindingPolicy' | 'trackingRef'
  >,
): string {
  const payload = {
    sequenceId: anchor.sequenceId,
    regionMode: anchor.regionMode,
    timeBindingPolicy: anchor.timeBindingPolicy,
    trackingRef: anchor.trackingRef ?? null,
    trackScope: anchor.trackScope,
    propertyScope: [...anchor.propertyScope].sort(),
    temporalSelection: anchor.temporalSelection ?? null,
    geometries: anchor.geometries,
    targets: anchor.orderedTargetRefs.map((target) => ({ kind: target.targetKind, ref: target.targetRef, label: target.label, version: target.assetVersionId })),
  };
  return JSON.stringify(payload);
}
