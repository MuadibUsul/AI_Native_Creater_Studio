import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { ApiFailure, ERROR_CODES, workspaceRoleSchema, type WorkspaceRole } from '@ancs/contracts';
import { workspaceMembers, workspaces } from '@ancs/db';

/**
 * Workspace 授权规则（P01-03 / 规范 §31、计划 §6.2）。
 *
 * 服务端统一授权入口：所有 workspace 范围资源请求必须经过 authorizeWorkspace
 * （REQ-31-02：每个资源请求验证 membership；禁止只按资源 id 查询后直接返回）。
 * 未来的 Project/Asset/Job/事件接口一律先调用本函数，再加载资源。
 *
 * 失败语义（抗枚举）：
 * - workspace 不存在 或 请求者不是成员 → **404 NOT_FOUND**（两者不可区分，避免探测他人租户）；
 * - 是成员但角色缺少能力 → **403 FORBIDDEN**（details.requiredCapability）。
 */

export const WORKSPACE_CAPABILITIES = [
  'workspace:read',
  'workspace:update',
  'workspace:transfer_ownership',
  'member:manage',
  'billing:manage',
  'provider:manage',
  'project:read',
  'project:write',
  'project:delete',
  'asset:manage',
  'generation:run',
  'render:run',
  'review:comment',
  'review:approve',
] as const;

export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];

/**
 * 角色 → 能力矩阵（计划 §6.2 默认权限；内部单人用户可同时拥有编辑与批准权限——
 * 即给同一账号分配多个角色，见 P09-04 团队管理）。
 * 说明：PLATFORM_ADMIN 不是 Workspace 角色（规范 §67），不在本矩阵内。
 */
export const ROLE_CAPABILITIES: Readonly<Record<WorkspaceRole, readonly WorkspaceCapability[]>> = {
  OWNER: WORKSPACE_CAPABILITIES,
  ADMIN: [
    'workspace:read',
    'workspace:update',
    'member:manage',
    'provider:manage',
    'project:read',
    'project:write',
    'project:delete',
    'asset:manage',
    'generation:run',
    'render:run',
    'review:comment',
    'review:approve',
  ],
  EDITOR: [
    'workspace:read',
    'project:read',
    'project:write',
    'asset:manage',
    'generation:run',
    'render:run',
    'review:comment',
  ],
  REVIEWER: ['workspace:read', 'project:read', 'review:comment', 'review:approve'],
  VIEWER: ['workspace:read', 'project:read'],
};

export function roleHasCapability(role: WorkspaceRole, capability: WorkspaceCapability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export interface Membership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export async function getMembership(
  db: NodePgDatabase,
  userId: string,
  workspaceId: string,
): Promise<Membership | null> {
  const rows = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { workspaceId: row.workspaceId, userId: row.userId, role: workspaceRoleSchema.parse(row.role) };
}

/** 统一授权入口：校验 workspace 存在 + membership + 能力；返回成员的授权上下文。 */
export async function authorizeWorkspace(
  db: NodePgDatabase,
  input: { userId: string; workspaceId: string; capability: WorkspaceCapability },
): Promise<Membership> {
  const existing = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  if (!existing[0]) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'workspace not found', 404);
  }

  const membership = await getMembership(db, input.userId, input.workspaceId);
  if (!membership) {
    // 抗枚举：非成员与不存在返回相同结果
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'workspace not found', 404);
  }

  if (!roleHasCapability(membership.role, input.capability)) {
    throw new ApiFailure(ERROR_CODES.FORBIDDEN, `role ${membership.role} lacks capability ${input.capability}`, 403, {
      requiredCapability: input.capability,
      role: membership.role,
    });
  }

  return membership;
}
