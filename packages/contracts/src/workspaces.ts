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

export const workspaceSchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1).max(80),
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
