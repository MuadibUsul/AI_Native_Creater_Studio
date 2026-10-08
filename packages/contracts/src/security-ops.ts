import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { planKeySchema } from './plans.js';
import { privacyTierSchema } from './workspaces.js';

/**
 * SaaS 安全运营契约（P09-05 / 规范 §43.3、§67、§47；计划 §8）。
 *
 * 四块：
 * - **恶意文件扫描**（§43.3 上传安全：MIME 嗅探/大小限制已就位——"病毒/恶意文件扫描（上线 SaaS 前）"）；
 * - **滥用处理**（§67 Abuse/Moderation flag + 工作区限制状态：成本性任务被阻止；全部可审计）；
 * - **支持工具**（**支持访问不可无痕**：显式授权（时限）+ 每次访问留痕 + 对工作区成员可见的事件）；
 * - **运营审计表**（append-only audit_log：所有平台管理动作与系统安全事件；不含私密内容/Secret）。
 */

/* ---------- 恶意文件扫描（§43.3） ---------- */

export const MALWARE_SCAN_STATUSES = ['CLEAN', 'INFECTED'] as const;
export const malwareScanStatusSchema = z.enum(MALWARE_SCAN_STATUSES);
export type MalwareScanStatus = z.infer<typeof malwareScanStatusSchema>;

export const malwareFindingSchema = z.object({
  /** 检查器代码（如 EICAR_TEST_SIGNATURE / EXECUTABLE_MIME / DANGEROUS_DOUBLE_EXTENSION） */
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(300),
});

export type MalwareFinding = z.infer<typeof malwareFindingSchema>;

export const malwareScanResultSchema = z.object({
  status: malwareScanStatusSchema,
  /** 扫描器标识（heuristic = 确定性启发式，**非杀毒引擎**；真实引擎接入后替换） */
  scanner: z.string().min(1).max(64),
  findings: z.array(malwareFindingSchema).default([]),
  scannedAt: isoDateTimeSchema,
});

export type MalwareScanResult = z.infer<typeof malwareScanResultSchema>;

/**
 * 扫描器 seam（与 Provider 适配器同一范式）：本地启发式为确定性默认；
 * 真实引擎（clamd/云扫描）接入 = 实现本接口（**BLOCKED：部署决策/外部依赖**）。
 * 扫描对象 = 上传原始字节 + 声明类型；**绝不执行上传内容**。
 */
export interface MalwareScanner {
  readonly kind: string;
  scan(input: { bytes: Uint8Array; filename: string; contentType: string }): Promise<MalwareScanResult>;
}

export const MALWARE_ERROR_REASONS = {
  MALWARE_DETECTED: 'MALWARE_DETECTED',
} as const;

/* ---------- 滥用处理（§67 / §47） ---------- */

export const ABUSE_FLAG_CATEGORIES = ['SPAM', 'COPYRIGHT', 'HARASSMENT', 'FRAUD', 'POLICY', 'OTHER'] as const;
export const abuseFlagCategorySchema = z.enum(ABUSE_FLAG_CATEGORIES);
export type AbuseFlagCategory = z.infer<typeof abuseFlagCategorySchema>;

export const ABUSE_FLAG_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const abuseFlagSeveritySchema = z.enum(ABUSE_FLAG_SEVERITIES);

export const ABUSE_FLAG_STATUSES = ['OPEN', 'RESOLVED'] as const;
export const abuseFlagStatusSchema = z.enum(ABUSE_FLAG_STATUSES);

export const abuseFlagSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  category: abuseFlagCategorySchema,
  severity: abuseFlagSeveritySchema,
  status: abuseFlagStatusSchema,
  note: z.string().min(1).max(2000),
  createdByUserId: opaqueIdSchema.nullable().default(null),
  resolvedByUserId: opaqueIdSchema.nullable().default(null),
  resolvedAt: isoDateTimeSchema.nullable().default(null),
  resolutionNote: z.string().max(2000).nullable().default(null),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type AbuseFlag = z.infer<typeof abuseFlagSchema>;

export const createAbuseFlagRequestSchema = z.object({
  category: abuseFlagCategorySchema,
  severity: abuseFlagSeveritySchema,
  note: z.string().min(1).max(2000),
});

export const resolveAbuseFlagRequestSchema = z.object({
  resolutionNote: z.string().min(1).max(2000),
});

/** 工作区滥用限制状态（**仅平台可见**：不进入用户侧 Workspace DTO） */
export const WORKSPACE_ABUSE_STATES = ['NORMAL', 'RESTRICTED'] as const;
export const workspaceAbuseStateSchema = z.enum(WORKSPACE_ABUSE_STATES);
export type WorkspaceAbuseState = z.infer<typeof workspaceAbuseStateSchema>;

export const setWorkspaceAbuseStateRequestSchema = z.object({
  abuseState: workspaceAbuseStateSchema,
  note: z.string().min(1).max(2000),
});

export const ABUSE_ERROR_REASONS = {
  /** 受限工作区：新的成本性任务被阻止（运营限制；已入队/运行中的任务不受影响） */
  WORKSPACE_RESTRICTED: 'WORKSPACE_RESTRICTED',
} as const;

/* ---------- 支持工具（不可无痕） ---------- */

export const SUPPORT_GRANT_STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const;
export const supportGrantStatusSchema = z.enum(SUPPORT_GRANT_STATUSES);
export type SupportGrantStatus = z.infer<typeof supportGrantStatusSchema>;

export const supportAccessGrantSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  requestedByUserId: opaqueIdSchema,
  /** Legacy rows may predate ticket binding; those rows never authorize support-view. */
  ticketId: z.string().min(1).max(128).nullable(),
  beneficiaryPrincipalId: opaqueIdSchema.nullable(),
  scope: z.literal('SUMMARY_READ').nullable(),
  /** 访问目的（必填——授权即记录"为什么"） */
  purpose: z.string().min(5).max(500),
  status: supportGrantStatusSchema,
  createdAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  revokedByUserId: opaqueIdSchema.nullable().default(null),
  revokedAt: isoDateTimeSchema.nullable().default(null),
});

export type SupportAccessGrant = z.infer<typeof supportAccessGrantSchema>;

/** 支持访问授权上限（小时）——时限化，禁止长期通行 */
export const SUPPORT_GRANT_MAX_HOURS = 24;

export const createSupportGrantRequestSchema = z.object({
  purpose: z.string().min(5).max(500),
  ticketId: z.string().min(1).max(128),
  beneficiaryPrincipalId: opaqueIdSchema,
  scope: z.literal('SUMMARY_READ'),
  ttlHours: z.number().int().positive().max(SUPPORT_GRANT_MAX_HOURS).default(4),
});

export const supportViewQuerySchema = z.object({ ticketId: z.string().min(1).max(128) });

/**
 * 支持视图（授权内可见）：**仅非私密元数据摘要**（计数/状态/用量）——
 * 不返回项目内容、素材字节、Prompt、旁白文本等私密内容；
 * 每次访问都写 audit_log 并向工作区追加可见事件（`support.view`）。
 */
export const supportViewSchema = z.object({
  workspaceId: opaqueIdSchema,
  name: z.string().min(1).max(80),
  privacyTier: privacyTierSchema,
  abuseState: workspaceAbuseStateSchema,
  planKey: planKeySchema,
  counts: z.object({
    members: z.number().int().nonnegative(),
    projects: z.number().int().nonnegative(),
    assets: z.number().int().nonnegative(),
    storageBytesUsed: z.number().int().nonnegative(),
    creditsBalance: z.number().int(),
    renders: z.record(z.string(), z.number().int().nonnegative()),
    jobs: z.record(z.string(), z.number().int().nonnegative()),
  }),
  grant: supportAccessGrantSchema,
  viewedAt: isoDateTimeSchema,
});

export type SupportView = z.infer<typeof supportViewSchema>;

export const SUPPORT_ERROR_REASONS = {
  /** 无有效授权（未创建/已过期/已撤销）——支持视图 403 */
  SUPPORT_GRANT_REQUIRED: 'SUPPORT_GRANT_REQUIRED',
} as const;

/* ---------- 运营审计表（REQ-24-02 收敛） ---------- */

export const AUDIT_ACTOR_KINDS = ['PLATFORM_ADMIN', 'SYSTEM'] as const;
export const auditActorKindSchema = z.enum(AUDIT_ACTOR_KINDS);

/**
 * audit_log（append-only）：**所有运营动作可审计**。
 * action 约定 `<area>.<verb>`（如 job.retry / plan.assign / credits.grant / abuse.state.set /
 * support.grant.create / support.view / upload.malware_rejected）。
 * details 不得含 Secret、私密内容或完整 Prompt（§24.2）。
 */
export const auditLogEntrySchema = z.object({
  id: opaqueIdSchema,
  actorKind: auditActorKindSchema,
  actorUserId: opaqueIdSchema.nullable().default(null),
  action: z.string().min(1).max(80),
  targetType: z.string().min(1).max(40),
  targetId: z.string().max(128).nullable().default(null),
  workspaceId: opaqueIdSchema.nullable().default(null),
  details: z.record(z.string(), z.unknown()).default({}),
  occurredAt: isoDateTimeSchema,
});

export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

/* ---------- 完整 Admin 摘要（§67 列表：Users/Workspaces/Projects/Provider status/Storage…） ---------- */

export const adminUserSummarySchema = z.object({
  id: opaqueIdSchema,
  email: z.email(),
  name: z.string().min(1),
  createdAt: isoDateTimeSchema,
  workspaceCount: z.number().int().nonnegative(),
});

export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;

export const adminWorkspaceSummarySchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1).max(80),
  privacyTier: privacyTierSchema,
  abuseState: workspaceAbuseStateSchema,
  planKey: planKeySchema,
  membersUsed: z.number().int().nonnegative(),
  storageBytesUsed: z.number().int().nonnegative(),
  creditsBalance: z.number().int(),
  openAbuseFlags: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
});

export type AdminWorkspaceSummary = z.infer<typeof adminWorkspaceSummarySchema>;

export const adminProjectSummarySchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  title: z.string().min(1),
  status: z.string().min(1),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type AdminProjectSummary = z.infer<typeof adminProjectSummarySchema>;

export const adminProviderStatusSchema = z.object({
  items: z.array(
    z.object({
      providerId: z.string().min(1),
      /** 状态 → 计数（近 7 天 provider_generations） */
      byStatus: z.record(z.string(), z.number().int().nonnegative()),
      lastFailureAt: isoDateTimeSchema.nullable().default(null),
      /** 最近失败的错误类别（截断；不含 Secret/响应体） */
      lastErrorCategory: z.string().max(120).nullable().default(null),
    }),
  ),
});

export type AdminProviderStatus = z.infer<typeof adminProviderStatusSchema>;

export const adminStorageSummarySchema = z.object({
  totalBytes: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      workspaceId: opaqueIdSchema,
      workspaceName: z.string().min(1),
      bytesUsed: z.number().int().nonnegative(),
      assetCount: z.number().int().nonnegative(),
    }),
  ),
});

export type AdminStorageSummary = z.infer<typeof adminStorageSummarySchema>;
