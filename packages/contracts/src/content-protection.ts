import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { revisionSchema } from './common/revision.js';
import { objectLockKindSchema } from './object-locks.js';

/**
 * N06-07：已确认内容的**保护指纹**与范围外变化报告。
 *
 * 纪律：
 * - 用户确认过的内容（开场/声音/产品外观等）在后续轮次里必须**仍引用相同资产与参数**；
 * - 指纹分三轴：`CONTENT`（参数/源区间/映射）、`POSITION`（轨道与序列区间）、`ASSET`（素材版本/嵌套序列/源流）；
 * - **范围外变化（意外移位）必须阻止自动采用**：只允许"本批显式目标"变化，
 *   受保护对象上的**附带**变化一律 fail-closed；
 * - "其他别动"遇总时长改变时：**先解释**，或改用**等长方案**（`resolveScopeGuard`）。
 */

/** 保护指纹的三个维度轴。 */
export const CONFIRMED_CONTENT_AXES = ['CONTENT', 'POSITION', 'ASSET'] as const;
export const confirmedContentAxisSchema = z.enum(CONFIRMED_CONTENT_AXES);
export type ConfirmedContentAxis = z.infer<typeof confirmedContentAxisSchema>;

const digestSchema = z.string().length(64);

/** 单个受保护对象的三轴指纹（缺失对象记 null digest）。 */
export const confirmedContentObjectSchema = z.object({
  objectKind: objectLockKindSchema,
  objectId: z.string().min(1),
  label: z.string().max(120).nullable().default(null),
  contentDigest: digestSchema.nullable().default(null),
  positionDigest: digestSchema.nullable().default(null),
  assetDigest: digestSchema.nullable().default(null),
}).strict();
export type ConfirmedContentObject = z.infer<typeof confirmedContentObjectSchema>;

export const confirmedContentRecordSchema = z.object({
  protectionId: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  label: z.string().max(120).nullable().default(null),
  /** 采集指纹时的工程 revision（仅作对照，不参与"是否变化"判定） */
  capturedRevision: revisionSchema,
  objects: z.array(confirmedContentObjectSchema).min(1),
  /** 三轴摘要的聚合指纹（整体一致性校验） */
  fingerprint: digestSchema,
  createdAt: isoDateTimeSchema,
}).strict();
export type ConfirmedContentRecord = z.infer<typeof confirmedContentRecordSchema>;

export const regressionDiffSchema = z.object({
  objectKind: objectLockKindSchema,
  objectId: z.string().min(1),
  label: z.string().max(120).nullable().default(null),
  axes: z.array(confirmedContentAxisSchema).min(1),
  /** 是否为本批采用的**显式目标**（true = 预期内变化，不算范围外） */
  explicitTarget: z.boolean(),
  before: z.string().max(200).nullable().default(null),
  after: z.string().max(200).nullable().default(null),
}).strict();
export type RegressionDiff = z.infer<typeof regressionDiffSchema>;

export const REGRESSION_STATUSES = ['UNCHANGED', 'CONTENT_CHANGED', 'POSITION_SHIFTED', 'ASSET_CHANGED', 'OBJECT_MISSING'] as const;
export const regressionStatusSchema = z.enum(REGRESSION_STATUSES);
export type RegressionStatus = z.infer<typeof regressionStatusSchema>;

export const regressionReportSchema = z.object({
  protectionId: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  capturedRevision: revisionSchema,
  currentRevision: revisionSchema,
  status: regressionStatusSchema,
  /** 受保护内容是否原样（true = 三轴全部未变） */
  intact: z.boolean(),
  diffs: z.array(regressionDiffSchema),
  /** 受保护对象中**非本批显式目标**却被改动的对象（意外移位/附带变化） */
  outOfScope: z.array(regressionDiffSchema),
}).strict();
export type RegressionReport = z.infer<typeof regressionReportSchema>;

export const PROTECTION_ERROR_REASONS = {
  NOT_FOUND: 'CONTENT_PROTECTION_NOT_FOUND',
  /** 采用会附带改动受保护内容（意外移位/范围外变化）→ 阻止自动采用 */
  REGRESSION_BLOCKED: 'CONFIRMED_CONTENT_REGRESSION',
  /** 保护对象类型当前不支持（只支持 CLIP：视频与音频片段） */
  UNSUPPORTED_OBJECT_KIND: 'CONTENT_PROTECTION_UNSUPPORTED_KIND',
  INVALID_SCOPE: 'CONTENT_PROTECTION_INVALID_SCOPE',
} as const;
export type ProtectionErrorReason = (typeof PROTECTION_ERROR_REASONS)[keyof typeof PROTECTION_ERROR_REASONS];

export const captureConfirmedContentRequestSchema = z.object({
  label: z.string().max(120).optional(),
  /** 显式保护哪些对象；缺省 = 保护当前工程全部片段（scope=ALL） */
  objects: z.array(z.object({
    objectKind: objectLockKindSchema,
    objectId: z.string().min(1),
    label: z.string().max(120).optional(),
  }).strict()).max(512).optional(),
}).strict();
export type CaptureConfirmedContentRequest = z.infer<typeof captureConfirmedContentRequestSchema>;

/**
 * "其他别动"范围守卫：在**不得改动其他内容**的约束下，若方案改变了总时长，
 * 必须先解释，或改用等长方案（不允许悄悄改变总时长）。
 */
export const SCOPE_GUARD_VERDICTS = ['SAFE', 'EXPLAIN_DURATION_CHANGE', 'EQUAL_LENGTH_PLAN_RECOMMENDED'] as const;
export const scopeGuardVerdictSchema = z.enum(SCOPE_GUARD_VERDICTS);
export type ScopeGuardVerdict = z.infer<typeof scopeGuardVerdictSchema>;

export interface ScopeGuardInput {
  /** 是否声明了"其他别动"（未声明则不受此约束） */
  preservesEverythingElse: boolean;
  /** 方案导致的总时长变化（有理毫秒的整数近似；0 = 等长） */
  durationDeltaMs: number;
  /** 是否存在等长替代方案（调用方/规划器判定） */
  equalLengthAlternativeAvailable: boolean;
  /** 总时长变化是否可**确定**（false = 由操作负载无法确定 → 必须按"需解释"处理，不得当作等长放行） */
  exact?: boolean;
}

export interface ScopeGuardResolution {
  verdict: ScopeGuardVerdict;
  /** 是否必须先向用户解释（不得直接执行） */
  requiresExplanation: boolean;
  /** 是否建议改用等长方案 */
  recommendEqualLength: boolean;
  reason: string;
}

export function resolveScopeGuard(input: ScopeGuardInput): ScopeGuardResolution {
  if (!input.preservesEverythingElse) {
    return { verdict: 'SAFE', requiresExplanation: false, recommendEqualLength: false, reason: 'NO_ELSE_UNTOUCHED_CONSTRAINT' };
  }
  if (input.exact === false) {
    return {
      verdict: 'EXPLAIN_DURATION_CHANGE', requiresExplanation: true, recommendEqualLength: false,
      reason: 'DURATION_CHANGE_UNKNOWN',
    };
  }
  if (input.durationDeltaMs === 0) {
    return { verdict: 'SAFE', requiresExplanation: false, recommendEqualLength: false, reason: 'LENGTH_PRESERVED' };
  }
  if (input.equalLengthAlternativeAvailable) {
    return {
      verdict: 'EQUAL_LENGTH_PLAN_RECOMMENDED', requiresExplanation: true, recommendEqualLength: true,
      reason: 'DURATION_CHANGED_BUT_EQUAL_LENGTH_AVAILABLE',
    };
  }
  return {
    verdict: 'EXPLAIN_DURATION_CHANGE', requiresExplanation: true, recommendEqualLength: false,
    reason: 'DURATION_CHANGED_NO_EQUAL_LENGTH_ALTERNATIVE',
  };
}
