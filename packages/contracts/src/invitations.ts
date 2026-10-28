import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { workspaceRoleSchema } from './workspaces.js';

/**
 * Workspace 邀请契约（P09-04 / 规范 §22 团队管理、计划 §8）。
 *
 * 模型：邀请 = **邮箱 + 角色**的待决记录（账号由内部创建，故创建邀请**不要求**账号已存在）；
 * 接受时校验"登录邮箱 = 邀请邮箱"（邮箱匹配 = 身份占有的凭据），并在**接受时**强制席位额度
 * （权威口径 = 成员数；邀请创建时做早期检查避免无效邀请堆积）。
 * 撤销（成员/邀请）后访问**立即受限**（授权入口每请求重读成员资格）。
 */

/** 存储状态（EXPIRED 为读取时的推导展示态：PENDING 且已过期）。 */
export const INVITATION_STORED_STATUSES = ['PENDING', 'ACCEPTED', 'REVOKED'] as const;
export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'] as const;

export const invitationStatusSchema = z.enum(INVITATION_STATUSES);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const workspaceInvitationSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  email: z.email(),
  role: workspaceRoleSchema,
  status: invitationStatusSchema,
  invitedByUserId: opaqueIdSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
  /** 到期时间（到期后不可接受；列表展示为 EXPIRED） */
  expiresAt: isoDateTimeSchema,
  acceptedAt: isoDateTimeSchema.nullable().default(null),
  acceptedByUserId: opaqueIdSchema.nullable().default(null),
});

export type WorkspaceInvitation = z.infer<typeof workspaceInvitationSchema>;

/** 我的待处理邀请（附带 Workspace 名称便于界面展示） */
export const myInvitationSchema = workspaceInvitationSchema.extend({
  workspaceName: z.string().min(1).max(80),
});

export type MyInvitation = z.infer<typeof myInvitationSchema>;

export const createInvitationRequestSchema = z.object({
  email: z.email(),
  role: workspaceRoleSchema,
  /** 邀请邮件的语言（邀请人界面语言；缺省英文）。配置了发信才会寄出邀请邮件（D-04） */
  locale: z.enum(['zh-CN', 'en']).optional(),
});

export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;

export const INVITATION_ERROR_REASONS = {
  /** 邀请不存在（或不属于该 Workspace；抗枚举） */
  INVITATION_NOT_FOUND: 'INVITATION_NOT_FOUND',
  /** 邀请状态不允许接受/撤销（已接受/已撤销） */
  INVITATION_NOT_PENDING: 'INVITATION_NOT_PENDING',
  /** 邀请已过期 */
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  /** 登录邮箱与邀请邮箱不一致 */
  EMAIL_MISMATCH: 'EMAIL_MISMATCH',
  /** 该邮箱已是成员 */
  ALREADY_MEMBER: 'ALREADY_MEMBER',
} as const;

export type InvitationErrorReason = (typeof INVITATION_ERROR_REASONS)[keyof typeof INVITATION_ERROR_REASONS];
