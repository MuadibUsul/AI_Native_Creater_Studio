import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * 派生血缘契约（P11-04 / 规范 §93；计划 §8）。
 *
 * 纪律（验收："更新 Core 仅提示派生内容过期，**不覆盖已批准产物**"）：
 * - **血缘 = 派生时输入快照**（coreInputsDigest + packVersion + atomCount）——不复制内容；
 * - **过期是提示不是撤销**：当前核心 digest ≠ 派生时 digest → `stale=true`（行保留、状态不变）；
 *   **已 APPROVED 的派生行永不改写**（approve 幂等，重复 approve → 409）；
 * - analyze 每次运行追加一条 PLAN 行（血缘只追加——历史不篡改）。
 */

export const DERIVATION_LINEAGE_VERSION = 'derivation-lineage-v1' as const;

export const DERIVATION_STATUSES = ['PLAN', 'APPROVED'] as const;
export const derivationStatusSchema = z.enum(DERIVATION_STATUSES);

export const derivationLineageSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  packId: z.string().min(3).max(120),
  packVersion: z.string().min(1).max(40),
  channelKey: z.string().max(60).nullable().default(null),
  status: derivationStatusSchema,
  /** 派生时的核心输入摘要（核心未迁移时 null——该情形无法判定过期） */
  coreInputsDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  /** 派生时输入规模快照（Atom 数/声明数——规模对账用） */
  inputsSnapshot: z.object({
    atomCount: z.number().int().nonnegative(),
    claimCount: z.number().int().nonnegative(),
  }),
  summary: z.string().min(1).max(500),
  /** 产出的项目版本（approve 时可选绑定；须属于同项目——来源链闭合 ProjectVersion 一环） */
  projectVersionId: opaqueIdSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
  approvedAt: isoDateTimeSchema.nullable().default(null),
});

export type DerivationLineage = z.infer<typeof derivationLineageSchema>;

/** 列表项 = 血缘 + 过期判定（对照当前核心 digest；stale 仅提示，不改状态） */
export const derivationListItemSchema = derivationLineageSchema.extend({
  /** 当前核心 digest ≠ 派生时 digest → true（提示过期；**不覆盖已批准产物**） */
  stale: z.boolean(),
  currentCoreInputsDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});

export type DerivationListItem = z.infer<typeof derivationListItemSchema>;

export const derivationListSchema = z.object({
  items: z.array(derivationListItemSchema),
});

export type DerivationList = z.infer<typeof derivationListSchema>;

/** approve 请求体：可选绑定产出项目版本（不传/null = 不绑定） */
export const approveDerivationRequestSchema = z.object({
  projectVersionId: opaqueIdSchema.nullable().optional(),
});

export type ApproveDerivationRequest = z.infer<typeof approveDerivationRequestSchema>;

export const LINEAGE_ERROR_REASONS = {
  LINEAGE_NOT_FOUND: 'LINEAGE_NOT_FOUND',
  /** 已批准的派生行不可重复 approve（状态不回退） */
  ALREADY_APPROVED: 'ALREADY_APPROVED',
  /** approve 绑定的项目版本不存在或不属于该项目 */
  PROJECT_VERSION_NOT_FOUND: 'PROJECT_VERSION_NOT_FOUND',
} as const;
