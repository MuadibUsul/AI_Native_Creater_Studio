import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gt } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  ENTITLEMENT_ERROR_REASONS,
  INVITATION_ERROR_REASONS,
  createInvitationRequestSchema,
  invitationStatusSchema,
  myInvitationSchema,
  workspaceInvitationSchema,
  workspaceRoleSchema,
  type InvitationStatus,
  type MyInvitation,
  type WorkspaceInvitation,
  type WorkspaceRole,
} from '@ancs/contracts';
import { isUniqueViolation, user, workspaceInvitations, workspaceMembers, workspaces } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { getWorkspaceEntitlement } from './plans.js';

/**
 * Workspace 邀请服务（P09-04 / 规范 §22 团队管理；计划 §8）。
 *
 * 口径：
 * - **创建不要求账号存在**（账号由内部创建，见 P01-02 CLI）；接受时校验"登录邮箱 = 邀请邮箱"；
 * - **席位检查双重**：创建时按 成员数 + 未过期 PENDING 邀请数 做早期检查（避免无效邀请堆积），
 *   接受时按 成员数 权威检查（assertSeatsAvailable）——降级套餐后已接受的成员**保留**（不自动移除），
 *   只阻止新增；
 * - 同 Workspace 同邮箱至多一条 PENDING（部分唯一索引兜底并发）；
 * - **撤销（邀请/成员）立即生效**：授权入口每请求重读成员资格，无需额外失效动作。
 */

/** 邀请有效期（天）。 */
export const INVITATION_TTL_DAYS = 14;

const toInvitationDto = (row: typeof workspaceInvitations.$inferSelect): WorkspaceInvitation => {
  const storedStatus = invitationStatusSchema.parse(row.status);
  const expired = storedStatus === 'PENDING' && row.expiresAt.getTime() <= Date.now();
  const status: InvitationStatus = expired ? 'EXPIRED' : storedStatus;
  return workspaceInvitationSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    role: workspaceRoleSchema.parse(row.role),
    status,
    invitedByUserId: row.invitedByUserId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    acceptedByUserId: row.acceptedByUserId,
  });
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** 未过期 PENDING 邀请数（席位早期检查用）。 */
async function pendingInvitationCount(deps: DomainDeps, workspaceId: string): Promise<number> {
  const rows = await deps.db
    .select({ total: count() })
    .from(workspaceInvitations)
    .where(and(eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.status, 'PENDING'), gt(workspaceInvitations.expiresAt, new Date())));
  return Number(rows[0]?.total ?? 0);
}

/**
 * 创建邀请（member:manage 由路由强制；授予 OWNER 仅限 OWNER——与 addMember 同规则）。
 */
export async function createInvitation(
  deps: DomainDeps,
  input: { workspaceId: string; request: unknown; invitedByUserId: string; requesterRole: WorkspaceRole },
): Promise<WorkspaceInvitation> {
  const body = createInvitationRequestSchema.parse(input.request);
  if (body.role === 'OWNER' && input.requesterRole !== 'OWNER') {
    throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'only OWNER can grant OWNER role', 403);
  }
  const email = normalizeEmail(body.email);

  // 已是成员 → 409（不是"邀请"场景）
  const targetRows = await deps.db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  const target = targetRows[0];
  if (target !== undefined) {
    const existing = await deps.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, target.id)))
      .limit(1);
    if (existing[0] !== undefined) {
      throw new ApiFailure(ERROR_CODES.ALREADY_EXISTS, `user "${email}" is already a member`, 409, { reason: INVITATION_ERROR_REASONS.ALREADY_MEMBER });
    }
  }

  // 席位早期检查：成员 + 未过期 PENDING 邀请（新增 1 席）
  const entitlement = await getWorkspaceEntitlement(deps, { workspaceId: input.workspaceId });
  const limit = entitlement.entitlements.seats;
  if (limit !== null) {
    const pending = await pendingInvitationCount(deps, input.workspaceId);
    if (entitlement.usage.seatsUsed + pending + 1 > limit) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `席位不足：成员 ${String(entitlement.usage.seatsUsed)} + 待接受邀请 ${String(pending)} + 新增 1 超过套餐上限 ${String(limit)}`, 422, {
        reason: ENTITLEMENT_ERROR_REASONS.SEATS_EXCEEDED,
        limit,
        used: entitlement.usage.seatsUsed,
        pending,
        planKey: entitlement.plan.planKey,
      });
    }
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
  try {
    const inserted = await deps.db
      .insert(workspaceInvitations)
      .values({
        id: `winv_${randomUUID()}`,
        workspaceId: input.workspaceId,
        email,
        role: body.role,
        status: 'PENDING',
        invitedByUserId: input.invitedByUserId,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'invitation insert failed', 500);
    return toInvitationDto(row);
  } catch (error) {
    // 部分唯一索引兜底（并发重复邀请）
    if (isUniqueViolation(error)) {
      throw new ApiFailure(ERROR_CODES.ALREADY_EXISTS, `"${email}" 已有待接受邀请`, 409);
    }
    throw error;
  }
}

/** Workspace 邀请列表（member:manage 由路由强制；新→旧）。 */
export async function listInvitations(deps: DomainDeps, input: { workspaceId: string }): Promise<WorkspaceInvitation[]> {
  const rows = await deps.db
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.workspaceId, input.workspaceId))
    .orderBy(desc(workspaceInvitations.createdAt))
    .limit(200);
  return rows.map(toInvitationDto);
}

/** 我的待处理邀请（按登录用户邮箱；未过期 PENDING 且尚未成为成员）。 */
export async function listMyInvitations(deps: DomainDeps, input: { userId: string }): Promise<MyInvitation[]> {
  const userRows = await deps.db.select({ email: user.email }).from(user).where(eq(user.id, input.userId)).limit(1);
  const me = userRows[0];
  if (me === undefined) return [];
  const email = normalizeEmail(me.email);
  const rows = await deps.db
    .select({ invitation: workspaceInvitations, workspaceName: workspaces.name })
    .from(workspaceInvitations)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
    .where(and(eq(workspaceInvitations.email, email), eq(workspaceInvitations.status, 'PENDING'), gt(workspaceInvitations.expiresAt, new Date())))
    .orderBy(desc(workspaceInvitations.createdAt));
  return rows.map((row) => myInvitationSchema.parse({ ...toInvitationDto(row.invitation), workspaceName: row.workspaceName }));
}

/** 撤销邀请（PENDING → REVOKED；非 PENDING 明确 409）。 */
export async function revokeInvitation(deps: DomainDeps, input: { workspaceId: string; invitationId: string }): Promise<WorkspaceInvitation> {
  const rows = await deps.db
    .select()
    .from(workspaceInvitations)
    .where(and(eq(workspaceInvitations.id, input.invitationId), eq(workspaceInvitations.workspaceId, input.workspaceId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '邀请不存在', 404, { reason: INVITATION_ERROR_REASONS.INVITATION_NOT_FOUND });
  }
  if (row.status !== 'PENDING') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `邀请状态不允许撤销（${row.status}）`, 409, { reason: INVITATION_ERROR_REASONS.INVITATION_NOT_PENDING, status: row.status });
  }
  const updated = await deps.db
    .update(workspaceInvitations)
    .set({ status: 'REVOKED', updatedAt: new Date() })
    .where(eq(workspaceInvitations.id, row.id))
    .returning();
  const result = updated[0];
  if (result === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'invitation revoke failed', 500);
  return toInvitationDto(result);
}

/**
 * 接受邀请（登录邮箱必须与邀请邮箱一致；接受时**权威**强制席位）。
 * 成员写入 + 邀请置 ACCEPTED 同事务；并发重复接受由成员唯一约束兜底。
 */
export async function acceptInvitation(
  deps: DomainDeps,
  input: { invitationId: string; userId: string },
): Promise<{ invitation: WorkspaceInvitation; member: { workspaceId: string; userId: string; role: WorkspaceRole } }> {
  const rows = await deps.db.select().from(workspaceInvitations).where(eq(workspaceInvitations.id, input.invitationId)).limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '邀请不存在', 404, { reason: INVITATION_ERROR_REASONS.INVITATION_NOT_FOUND });
  }
  const userRows = await deps.db.select({ email: user.email }).from(user).where(eq(user.id, input.userId)).limit(1);
  const me = userRows[0];
  if (me === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, '用户不存在', 404);
  if (row.status !== 'PENDING') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `邀请状态不允许接受（${row.status}）`, 409, { reason: INVITATION_ERROR_REASONS.INVITATION_NOT_PENDING, status: row.status });
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '邀请已过期', 409, { reason: INVITATION_ERROR_REASONS.INVITATION_EXPIRED, expiresAt: row.expiresAt.toISOString() });
  }
  if (row.email !== normalizeEmail(me.email)) {
    throw new ApiFailure(ERROR_CODES.FORBIDDEN, '邀请邮箱与当前登录邮箱不一致', 403, { reason: INVITATION_ERROR_REASONS.EMAIL_MISMATCH });
  }

  // 已是成员 → 明确 409（不重复插入）
  const existing = await deps.db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, row.workspaceId), eq(workspaceMembers.userId, input.userId)))
    .limit(1);
  if (existing[0] !== undefined) {
    throw new ApiFailure(ERROR_CODES.ALREADY_EXISTS, '已是该 Workspace 成员', 409, { reason: INVITATION_ERROR_REASONS.ALREADY_MEMBER });
  }

  // 席位权威检查（降级后超额 → 明确 422；存量成员保留、新增被阻止）
  const entitlement = await getWorkspaceEntitlement(deps, { workspaceId: row.workspaceId });
  const limit = entitlement.entitlements.seats;
  if (limit !== null && entitlement.usage.seatsUsed + 1 > limit) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `席位不足：当前 ${String(entitlement.usage.seatsUsed)} + 新增 1 超过套餐上限 ${String(limit)}（请联系 Workspace 管理员升级套餐）`, 422, {
      reason: ENTITLEMENT_ERROR_REASONS.SEATS_EXCEEDED,
      limit,
      used: entitlement.usage.seatsUsed,
      planKey: entitlement.plan.planKey,
    });
  }

  const now = new Date();
  const role = workspaceRoleSchema.parse(row.role);
  try {
    await deps.db.transaction(async (tx) => {
      await tx.insert(workspaceMembers).values({
        id: `wsm_${randomUUID()}`,
        workspaceId: row.workspaceId,
        userId: input.userId,
        role,
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .update(workspaceInvitations)
        .set({ status: 'ACCEPTED', acceptedAt: now, acceptedByUserId: input.userId, updatedAt: now })
        .where(eq(workspaceInvitations.id, row.id));
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiFailure(ERROR_CODES.ALREADY_EXISTS, '已是该 Workspace 成员', 409, { reason: INVITATION_ERROR_REASONS.ALREADY_MEMBER });
    }
    throw error;
  }

  const refreshed = await deps.db.select().from(workspaceInvitations).where(eq(workspaceInvitations.id, row.id)).limit(1);
  const updatedRow = refreshed[0];
  if (updatedRow === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'invitation accept failed', 500);
  return {
    invitation: toInvitationDto(updatedRow),
    member: { workspaceId: row.workspaceId, userId: input.userId, role },
  };
}
