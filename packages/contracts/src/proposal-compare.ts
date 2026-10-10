import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { objectLockDimensionSchema, objectLockKindSchema } from './object-locks.js';

/**
 * N06-08：A/B 对照与差异标记（服务端对照载荷；播放器侧的"切换前后/循环回放"消费本载荷）。
 *
 * 纪律：
 * - 对照引用的是**实际资产与参数**（回带 `assetVersionId`），不是"重新生成的近似"；
 * - **时长/片段数不同时用内容锚点对齐**（同一素材版本 + 同一源区间视为同源），避免"相同锚点对照错位"；
 * - 对齐方式如实回报（`CLIP_ID` vs `CONTENT_ANCHOR`），并把无法唯一对齐的锚点单列（`unmatchedAnchors`）。
 */

export const COMPARE_ALIGNMENT_MODES = ['CLIP_ID', 'CONTENT_ANCHOR'] as const;
export const compareAlignmentSchema = z.enum(COMPARE_ALIGNMENT_MODES);
export type CompareAlignment = z.infer<typeof compareAlignmentSchema>;

export const COMPARE_CHANGES = ['ADDED', 'REMOVED', 'CHANGED', 'UNCHANGED'] as const;
export const compareChangeSchema = z.enum(COMPARE_CHANGES);
export type CompareChange = z.infer<typeof compareChangeSchema>;

export const compareObjectDiffSchema = z.object({
  objectKind: objectLockKindSchema,
  objectId: z.string().min(1),
  label: z.string().max(120).nullable().default(null),
  change: compareChangeSchema,
  axes: z.array(objectLockDimensionSchema),
  /** 对照双方的**实际素材版本**（证明对照的是真资产，不是重新生成） */
  beforeAssetVersionId: z.string().nullable().default(null),
  afterAssetVersionId: z.string().nullable().default(null),
  beforeTrackId: z.string().nullable().default(null),
  afterTrackId: z.string().nullable().default(null),
  /** 该对照是按什么对齐的 */
  alignedBy: compareAlignmentSchema,
}).strict();
export type CompareObjectDiff = z.infer<typeof compareObjectDiffSchema>;

export const compareReportSchema = z.object({
  proposalId: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  /** 对照对象：当前确认版，或另一个候选 */
  comparedAgainst: z.object({
    kind: z.enum(['CURRENT', 'PROPOSAL']),
    ref: z.string().nullable().default(null),
  }).strict(),
  leftLabel: z.string().max(120),
  rightLabel: z.string().max(120),
  /** 整体对齐方式（全部以 clip id 对齐时才是 CLIP_ID） */
  alignment: compareAlignmentSchema,
  diffs: z.array(compareObjectDiffSchema),
  unchangedCount: z.number().int().min(0),
  addedCount: z.number().int().min(0),
  removedCount: z.number().int().min(0),
  changedCount: z.number().int().min(0),
  /** 两侧都存在但 clip id 不同、必须靠内容锚点才对齐得上的对象（提示"同一素材不同实例"） */
  anchorMatchedCount: z.number().int().min(0),
  /** 无法唯一对齐的锚点（对照时必须提示用户可能错位，而不是假装对齐） */
  unmatchedAnchors: z.array(z.string().max(200)),
  /** 对照涉及的全部实际素材版本 id（供调用方核对"用的是真资产"） */
  assetVersionIds: z.array(z.string().min(1)),
}).strict();
export type CompareReport = z.infer<typeof compareReportSchema>;

export const COMPARE_ERROR_REASONS = {
  NOT_FOUND: 'COMPARE_PROPOSAL_NOT_FOUND',
  INVALID: 'COMPARE_INVALID_REQUEST',
} as const;
export type CompareErrorReason = (typeof COMPARE_ERROR_REASONS)[keyof typeof COMPARE_ERROR_REASONS];

export const compareProposalRequestSchema = z.object({
  /** 缺省 = 与当前确认版对照；给定 = 与另一候选对照（A/B） */
  againstProposalId: opaqueIdSchema.nullable().default(null),
  /** 至少对照哪些轴；缺省 = 全部三轴 */
  axes: z.array(objectLockDimensionSchema).optional(),
}).strict();
export type CompareProposalRequest = z.infer<typeof compareProposalRequestSchema>;
