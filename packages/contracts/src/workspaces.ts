import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * Workspace / 成员契约（规范 §22.1、§31 / 计划 §6.2；P01-03）。
 *
 * 角色集合为 Workspace 内部角色；PLATFORM_ADMIN 是独立的运营权限
 * （规范 §67：Admin 权限严格分离，不复用 Workspace ADMIN，自 P08-02 建立）。
 */

export const WORKSPACE_ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'VIEWER'] as const;

export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

/**
 * 隐私模式（P09-04 / 规范 §20.4）：Standard / Private / Enterprise。
 * 非 STANDARD 档需 Plan 权益 `privacyMode`（数据驱动）；降级不静默改写档位——
 * 进入超额清单（overCommitted），由运营/用户显式处理。
 */
export const PRIVACY_TIERS = ['STANDARD', 'PRIVATE', 'ENTERPRISE'] as const;
export const privacyTierSchema = z.enum(PRIVACY_TIERS);
export type PrivacyTier = z.infer<typeof privacyTierSchema>;

export const workspaceSchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1).max(80),
  privacyTier: privacyTierSchema.default('STANDARD'),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/** 列表场景附带请求者在该 Workspace 的角色（前端据此驱动界面能力） */
export const workspaceWithRoleSchema = workspaceSchema.extend({
  role: workspaceRoleSchema,
});

export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceWithRole = z.infer<typeof workspaceWithRoleSchema>;

export const workspaceMemberSchema = z.object({
  userId: opaqueIdSchema,
  email: z.email(),
  name: z.string().min(1),
  role: workspaceRoleSchema,
  joinedAt: isoDateTimeSchema,
});

export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export const createWorkspaceRequestSchema = z.object({
  name: z.string().min(1).max(80),
});

export const updateWorkspaceRequestSchema = z.object({
  name: z.string().min(1).max(80),
});

/** 按邮箱添加成员（账号由内部创建，见 P01-02 CLI） */
export const addWorkspaceMemberRequestSchema = z.object({
  email: z.email(),
  role: workspaceRoleSchema,
});

export const updateWorkspaceMemberRoleRequestSchema = z.object({
  role: workspaceRoleSchema,
});

/** 设置隐私模式档位（非 STANDARD 需 Plan 权益 privacyMode；PATCH /workspaces/:id/privacy） */
export const setPrivacyTierRequestSchema = z.object({
  privacyTier: privacyTierSchema,
});

export type SetPrivacyTierRequest = z.infer<typeof setPrivacyTierRequestSchema>;
