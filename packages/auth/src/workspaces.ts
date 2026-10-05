import { randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  privacyTierSchema,
  workspaceRoleSchema,
  type PrivacyTier,
  type WorkspaceMember,
  type WorkspaceRole,
  type WorkspaceWithRole,
} from '@ancs/contracts';
import { isUniqueViolation, user, workspaceMembers, workspaces } from '@ancs/db';
import { authorizeWorkspace } from './authorization.js';

/**
 * Workspace 与成员服务（P01-03）。
 * 所有读写先经 authorizeWorkspace（统一授权入口）；OWNER 不变量在此层强制。
 * P09-04：隐私档位（§20.4）读写（**权益门在 API 层**——本层只管数据）。
 */

export interface WorkspaceServiceDeps {
  db: NodePgDatabase;
}

const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;

const toWorkspaceDto = (row: {
  id: string;
  name: string;
  privacyTier?: string;
  createdAt: Date;
  updatedAt: Date;
  role: string;
}): WorkspaceWithRole => ({
  id: row.id,
  name: row.name,
  privacyTier: privacyTierSchema.parse(row.privacyTier ?? 'STANDARD'),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  role: workspaceRoleSchema.parse(row.role),
});

/** 创建 Workspace：创建者成为 OWNER（同事务，避免出现无主租户）。 */
export async function createWorkspace(
  deps: WorkspaceServiceDeps,
  input: { userId: string; name: string },
): Promise<WorkspaceWithRole> {
  const now = new Date();
  const workspaceId = newId('ws');
  await deps.db.transaction(async (tx) => {
    await tx.insert(workspaces).values({ id: workspaceId, name: input.name, privacyTier: 'STANDARD', createdAt: now, updatedAt: now });
    await tx.insert(workspaceMembers).values({
      id: newId('wsm'),
      workspaceId,
      userId: input.userId,
      role: 'OWNER',
      createdAt: now,
      updatedAt: now,
    });
  });
  return {
    id: workspaceId,
    name: input.name,
    privacyTier: 'STANDARD',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    role: 'OWNER',
  };
}

/** 当前用户可见的 Workspace 列表（只包含其为成员的租户）。 */
export async function listWorkspaces(
  deps: WorkspaceServiceDeps,
  input: { userId: string },
): Promise<WorkspaceWithRole[]> {
  const rows = await deps.db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      privacyTier: workspaces.privacyTier,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, input.userId))
    .orderBy(workspaces.createdAt);
  return rows.map(toWorkspaceDto);
}

export async function getWorkspace(
  deps: WorkspaceServiceDeps,
  input: { userId: string; workspaceId: string },
): Promise<WorkspaceWithRole> {
  const membership = await authorizeWorkspace(deps.db, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    capability: 'workspace:read',
  });
  const rows = await deps.db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'workspace not found', 404);
  return toWorkspaceDto({ ...row, role: membership.role });
}

export async function updateWorkspace(
  deps: WorkspaceServiceDeps,
  input: { userId: string; workspaceId: string; name: string },
): Promise<WorkspaceWithRole> {
  const membership = await authorizeWorkspace(deps.db, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    capability: 'workspace:update',
  });
  const now = new Date();
  const updated = await deps.db
    .update(workspaces)
    .set({ name: input.name, updatedAt: now })
    .where(eq(workspaces.id, input.workspaceId))
    .returning();
  const row = updated[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'workspace not found', 404);
  return toWorkspaceDto({ ...row, role: membership.role });
}

/**
 * 设置隐私档位（P09-04 / §20.4）；**权益门在 API 层**（domain 断言 privacyMode 权益后调用本函数）。
 */
export async function setWorkspacePrivacyTier(
  deps: WorkspaceServiceDeps,
  input: { userId: string; workspaceId: string; privacyTier: PrivacyTier },
): Promise<WorkspaceWithRole> {
  const membership = await authorizeWorkspace(deps.db, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    capability: 'workspace:update',
  });
  const now = new Date();
  const updated = await deps.db
    .update(workspaces)
    .set({ privacyTier: input.privacyTier, updatedAt: now })
    .where(eq(workspaces.id, input.workspaceId))
    .returning();
  const row = updated[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'workspace not found', 404);
  return toWorkspaceDto({ ...row, role: membership.role });
}

export async function listMembers(
  deps: WorkspaceServiceDeps,
  input: { userId: string; workspaceId: string },
): Promise<WorkspaceMember[]> {
  await authorizeWorkspace(deps.db, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    capability: 'workspace:read',
  });
  const rows = await deps.db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.createdAt,
      email: user.email,
      name: user.name,
    })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, input.workspaceId))
    .orderBy(workspaceMembers.createdAt);
  return rows.map((row) => ({
    userId: row.userId,
    email: row.email,
    name: row.name,
    role: workspaceRoleSchema.parse(row.role),
    joinedAt: row.joinedAt.toISOString(),
  }));
}

/**
 * OWNER 不变量说明：角色变更与成员移除都在"锁定 Workspace 行（SELECT ... FOR UPDATE）"
 * 的事务内重读目标状态并执行计数，保证并发下不会出现零 OWNER
 * （例如两名 OWNER 同时降级对方时，只有一个能成功）。
 */

/** 按邮箱添加成员；只有 OWNER 可以授予 OWNER。 */
export async function addMember(
  deps: WorkspaceServiceDeps,
  input: { userId: string; workspaceId: string; email: string; role: WorkspaceRole },
): Promise<WorkspaceMember> {
  const requester = await authorizeWorkspace(deps.db, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    capability: 'member:manage',
  });
  if (input.role === 'OWNER' && requester.role !== 'OWNER') {
    throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'only OWNER can grant OWNER role', 403);
  }

  const targetRows = await deps.db.select().from(user).where(eq(user.email, input.email)).limit(1);
  const target = targetRows[0];
  if (!target) throw new ApiFailure(ERROR_CODES.NOT_FOUND, `user "${input.email}" not found`, 404);

  const existing = await deps.db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, target.id)))
    .limit(1);
  if (existing[0]) {
    throw new ApiFailure(ERROR_CODES.ALREADY_EXISTS, `user "${input.email}" is already a member`, 409);
  }

  const now = new Date();
  try {
    await deps.db.insert(workspaceMembers).values({
      id: newId('wsm'),
      workspaceId: input.workspaceId,
      userId: target.id,
      role: input.role,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    // 唯一约束兜底（并发添加同一成员）；drizzle 包装错误需解包 cause（isUniqueViolation）
    if (isUniqueViolation(error)) {
      throw new ApiFailure(ERROR_CODES.ALREADY_EXISTS, `user "${input.email}" is already a member`, 409);
    }
    throw error;
  }

  return {
    userId: target.id,
    email: target.email,
    name: target.name,
    role: input.role,
    joinedAt: now.toISOString(),
  };
}

async function loadTargetMembership(
  deps: WorkspaceServiceDeps,
  workspaceId: string,
  targetUserId: string,
): Promise<{ id: string; role: WorkspaceRole }> {
  const rows = await deps.db
    .select({ id: workspaceMembers.id, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'member not found', 404);
  return { id: row.id, role: workspaceRoleSchema.parse(row.role) };
}

/**
 * 变更成员角色。规则（计划 §6.2 + OWNER 不变量）：
 * - 非 OWNER 不得修改 OWNER 成员，也不得授予 OWNER；
 * - 不得将最后一名 OWNER 降级（PRECONDITION_FAILED）。
 */
export async function updateMemberRole(
  deps: WorkspaceServiceDeps,
  input: { userId: string; workspaceId: string; targetUserId: string; role: WorkspaceRole },
): Promise<WorkspaceMember> {
  const requester = await authorizeWorkspace(deps.db, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    capability: 'member:manage',
  });
  const target = await loadTargetMembership(deps, input.workspaceId, input.targetUserId);

  if (requester.role !== 'OWNER') {
    if (target.role === 'OWNER' || input.role === 'OWNER') {
      throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'only OWNER can modify or grant OWNER role', 403);
    }
  }

  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from workspaces where id = ${input.workspaceId} for update`);

    // 锁内重读目标角色与 OWNER 计数（一致视图，防并发双降级）
    const freshRows = await tx
      .select({ id: workspaceMembers.id, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.id, target.id))
      .limit(1);
    const fresh = freshRows[0];
    if (!fresh) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'member not found', 404);

    if (fresh.role === 'OWNER' && input.role !== 'OWNER') {
      const owners = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.role, 'OWNER')));
      if ((owners[0]?.count ?? 0) <= 1) {
        throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'cannot demote the last OWNER', 409);
      }
    }

    await tx
      .update(workspaceMembers)
      .set({ role: input.role, updatedAt: new Date() })
      .where(eq(workspaceMembers.id, target.id));
  });

  const rows = await deps.db
    .select({ userId: workspaceMembers.userId, role: workspaceMembers.role, joinedAt: workspaceMembers.createdAt, email: user.email, name: user.name })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.id, target.id))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'member not found', 404);
  return {
    userId: row.userId,
    email: row.email,
    name: row.name,
    role: workspaceRoleSchema.parse(row.role),
    joinedAt: row.joinedAt.toISOString(),
  };
}

/** 移除成员（访问立即失效）；不得移除最后一名 OWNER。 */
export async function removeMember(
  deps: WorkspaceServiceDeps,
  input: { userId: string; workspaceId: string; targetUserId: string },
): Promise<void> {
  const requester = await authorizeWorkspace(deps.db, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    capability: 'member:manage',
  });
  const target = await loadTargetMembership(deps, input.workspaceId, input.targetUserId);

  if (requester.role !== 'OWNER' && target.role === 'OWNER') {
    throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'only OWNER can remove an OWNER', 403);
  }

  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from workspaces where id = ${input.workspaceId} for update`);

    const freshRows = await tx
      .select({ id: workspaceMembers.id, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.id, target.id))
      .limit(1);
    const fresh = freshRows[0];
    if (!fresh) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'member not found', 404);

    if (fresh.role === 'OWNER') {
      const owners = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.role, 'OWNER')));
      if ((owners[0]?.count ?? 0) <= 1) {
        throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'cannot remove the last OWNER', 409);
      }
    }

    await tx.delete(workspaceMembers).where(eq(workspaceMembers.id, target.id));
  });
}
