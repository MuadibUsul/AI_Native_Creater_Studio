import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * 最小运营（Admin）契约（P08-02 / 规范 §67；计划 §8 P08-02）。
 *
 * 纪律：
 * - **平台管理员与普通用户角色严格分离**（REQ-67-02：不复用 workspace 角色）：
 *   N15-02 起由独立 admin_principals、role_grants 和 TOTP 后签发的运营会话判定，
 *   非管理员访问 `/api/v1/admin/*` → 404（反枚举）；历史白名单不再授予权限；
 * - 运营面为**只读聚合 + 人工重试**：重试走既有任务服务（天然遵守预算/幂等/版本规则，§67 验收）。
 */

export const opsAlertSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['CRITICAL', 'WARNING']),
  summary: z.string().min(1).max(300),
  value: z.number(),
  threshold: z.number(),
});

export type OpsAlert = z.infer<typeof opsAlertSchema>;

export const opsOverviewSchema = z.object({
  generatedAt: isoDateTimeSchema,
  jobs: z.object({
    byStatus: z.record(z.string(), z.number().int().nonnegative()).default({}),
    failedRetryable: z.number().int().nonnegative(),
    failedFinal: z.number().int().nonnegative(),
    needsReconciliation: z.number().int().nonnegative(),
    /** 最老的在途任务年龄（秒；无 → null）——队列积压信号 */
    oldestActiveAgeSeconds: z.number().int().nonnegative().nullable().default(null),
  }),
  renders: z.object({
    byStatus: z.record(z.string(), z.number().int().nonnegative()).default({}),
  }),
  qa: z.object({
    last24hPass: z.number().int().nonnegative(),
    last24hFail: z.number().int().nonnegative(),
  }),
  approvals: z.object({
    approved: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }),
  providerGenerations: z.object({
    byStatus: z.record(z.string(), z.number().int().nonnegative()).default({}),
  }),
  /** 告警条件（P08-03：可检查阈值——无外部 Alertmanager 时的证据面） */
  alerts: z.array(opsAlertSchema).default([]),
  spend: z.object({
    /** 全平台 DEBIT 合计（整数 Credits；账本只追加，余额=效果之和） */
    debitsTotal: z.number().int().nonnegative(),
    /** 有账本条目的 workspace 数 */
    workspacesWithLedger: z.number().int().nonnegative(),
  }),
});

export type OpsOverview = z.infer<typeof opsOverviewSchema>;

export const opsAuditKindSchema = z.enum(['JOB', 'RENDER', 'APPROVAL']);
export type OpsAuditKind = z.infer<typeof opsAuditKindSchema>;

export const opsAuditEntrySchema = z.object({
  id: z.string().min(1),
  kind: opsAuditKindSchema,
  at: isoDateTimeSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema.nullable().default(null),
  /** 人类可读摘要（含任务类型/事件类型/状态） */
  summary: z.string().min(1).max(300),
  details: z.record(z.string(), z.unknown()).default({}),
});

export type OpsAuditEntry = z.infer<typeof opsAuditEntrySchema>;

export const opsAdminActionSchema = z.object({
  action: z.enum(['JOB_RETRY']),
  jobId: opaqueIdSchema,
  reason: z.string().max(300).nullable().default(null),
});

export type OpsAdminAction = z.infer<typeof opsAdminActionSchema>;

/** 管理员名单解析（逗号分隔 user_id；空白忽略；去重）。 */
export function parsePlatformAdmins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return [...new Set(raw.split(',').map((item) => item.trim()).filter((item) => item !== ''))];
}
