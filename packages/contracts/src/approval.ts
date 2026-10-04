import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { downloadTargetSchema } from './storage.js';

/**
 * 审批与受控导出契约（P07-06 / 规范 §87、§54、§36；计划 §8 P07-06）。
 *
 * 纪律（§87 / REQ-54-02）：
 * - **批准绑定固定 Render + manifestHash**（+ 当时的 projectVersionId/projectRevision）——
 *   "新编辑需重新审批"：批准只对"这一次渲染的这一份产物"有效，新编辑 → 新渲染 → 新批准；
 * - **未批准不能正式导出**：导出入口在服务端校验（批准存在且 manifestHash 与 Render 一致）；
 * - 导出 = **受控下载入口**（带 TTL 的签名 URL，逐产物；服务端签发，客户端不持存储凭据 §75）。
 */

export const APPROVAL_DECISIONS = ['APPROVED', 'REJECTED'] as const;
export const approvalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const renderApprovalSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  renderId: opaqueIdSchema,
  decision: approvalDecisionSchema,
  /** 批准时的 manifestHash（= Render 当前值；导出前复核） */
  manifestHashAtApproval: z.string().regex(/^[0-9a-f]{64}$/),
  /** 批准时绑定的版本（快照引用） */
  projectVersionIdAtApproval: opaqueIdSchema,
  /** 批准时的项目 revision（之后有新编辑 → 导出面板提示"导出为已批准快照"） */
  projectRevisionAtApproval: z.number().int().nonnegative(),
  note: z.string().max(600).nullable().default(null),
  decidedBy: z.string().nullable().default(null),
  createdAt: isoDateTimeSchema,
});

export type RenderApproval = z.infer<typeof renderApprovalSchema>;

export const decideApprovalRequestSchema = z.object({
  decision: approvalDecisionSchema,
  note: z.string().max(600).optional(),
});

export type DecideApprovalRequest = z.input<typeof decideApprovalRequestSchema>;

export const APPROVAL_ERROR_REASONS = {
  /** Render 不可审批（非 READY：QA 未通过/未完成） */
  RENDER_NOT_READY: 'RENDER_NOT_READY',
  /** Render 缺 manifestHash（不应发生：READY 必有） */
  MANIFEST_MISSING: 'MANIFEST_MISSING',
  /** 未批准就导出（或批准已被新渲染取代） */
  NOT_APPROVED: 'NOT_APPROVED',
  /** 批准后 Render 的 manifestHash 变化（重渲/篡改）→ 批准失效（需重新批准） */
  APPROVAL_STALE: 'APPROVAL_STALE',
  /** 产物资产缺失（导出不可用） */
  EXPORT_ARTIFACT_MISSING: 'EXPORT_ARTIFACT_MISSING',
  /** 未配置对象存储（无法签发下载入口） */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const;

export type ApprovalErrorReason = (typeof APPROVAL_ERROR_REASONS)[keyof typeof APPROVAL_ERROR_REASONS];

/** 导出包条目（受控下载入口；TTL 由存储适配器决定——默认 15 分钟） */
export const exportPackageEntrySchema = z.object({
  kind: z.enum(['VIDEO', 'SUBTITLE_SRT', 'SUBTITLE_VTT', 'MANIFEST']),
  assetId: opaqueIdSchema,
  download: downloadTargetSchema,
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  mimeType: z.string().min(1),
});

export type ExportPackageEntry = z.infer<typeof exportPackageEntrySchema>;

export const exportPackageSchema = z.object({
  schemaVersion: z.literal('render-export-v1'),
  renderId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  projectVersionId: opaqueIdSchema,
  profile: z.string().min(1),
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  approvalId: opaqueIdSchema,
  approvedAt: isoDateTimeSchema,
  approvedBy: z.string().nullable().default(null),
  /** 批准后项目又有新编辑（提示：导出内容仍为已批准快照） */
  projectEditedSinceApproval: z.boolean().default(false),
  entries: z.array(exportPackageEntrySchema).min(1),
});

export type ExportPackage = z.infer<typeof exportPackageSchema>;
