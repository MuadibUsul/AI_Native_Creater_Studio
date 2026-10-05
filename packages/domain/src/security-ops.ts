import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gt, ilike, isNull, or, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ABUSE_ERROR_REASONS,
  ERROR_CODES,
  SUPPORT_ERROR_REASONS,
  abuseFlagSchema,
  adminProjectSummarySchema,
  adminProviderStatusSchema,
  adminStorageSummarySchema,
  adminUserSummarySchema,
  adminWorkspaceSummarySchema,
  supportAccessGrantSchema,
  supportViewSchema,
  auditLogEntrySchema,
  workspaceAbuseStateSchema,
  createAbuseFlagRequestSchema,
  resolveAbuseFlagRequestSchema,
  setWorkspaceAbuseStateRequestSchema,
  createSupportGrantRequestSchema,
  privacyTierSchema,
  type AbuseFlag,
  type AdminProjectSummary,
  type AdminProviderStatus,
  type AdminStorageSummary,
  type AdminUserSummary,
  type AdminWorkspaceSummary,
  type AuditLogEntry,
  type SupportAccessGrant,
  type SupportGrantStatus,
  type SupportView,
  type WorkspaceAbuseState,
} from '@ancs/contracts';
import {
  abuseFlags,
  assetVersions,
  assets,
  auditLog,
  jobs,
  outboxEvents,
  plans,
  projects,
  providerGenerations,
  renders,
  supportAccessGrants,
  user,
  workspaceMembers,
  workspaceSubscriptions,
  workspaces,
} from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { getBalanceCredits } from './billing.js';
import { defaultPlanKeyForUnsubscribed } from './plans.js';

/**
 * SaaS 安全运营服务（P09-05 / 规范 §43.3、§67、§24.2；计划 §8）。
 *
 * - **审计表（append-only）**：`recordAudit` 覆盖所有平台管理动作与系统安全事件
 *   （details 不含 Secret/私密内容/完整 Prompt——§24.2）；
 * - **滥用处理**：标记（调查）+ 工作区限制状态（`RESTRICTED` 阻止**新的成本性任务**——
 *   闸门在 `createJobInTx`；已入队/运行中任务不受影响）；状态仅平台可见；
 * - **支持工具（不可无痕）**：访问需显式**时限授权**；授权创建与每次支持视图访问都
 *   ①写 audit_log ②向工作区追加 Outbox 事件（成员经既有事件流可见）；支持视图只含元数据摘要；
 * - **完整 Admin**：users / workspaces / projects / provider status / storage 只读聚合（§67 列表）。
 */

/* ---------- 审计 ---------- */

export async function recordAudit(
  deps: DomainDeps,
  entry: { actorKind: 'PLATFORM_ADMIN' | 'SYSTEM'; actorUserId?: string | null; action: string; targetType: string; targetId?: string | null; workspaceId?: string | null; details?: Record<string, unknown> },
): Promise<void> {
  await deps.db.insert(auditLog).values({
    id: `aud_${randomUUID()}`,
    actorKind: entry.actorKind,
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    workspaceId: entry.workspaceId ?? null,
    details: entry.details ?? {},
  });
}

export async function listAuditLog(
  deps: DomainDeps,
  input: { limit?: number; workspaceId?: string; action?: string } = {},
): Promise<AuditLogEntry[]> {
  const conditions = [
    ...(input.workspaceId !== undefined ? [eq(auditLog.workspaceId, input.workspaceId)] : []),
    ...(input.action !== undefined ? [eq(auditLog.action, input.action)] : []),
  ];
  const rows = await deps.db
    .select()
    .from(auditLog)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(auditLog.occurredAt))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
  return rows.map((row) =>
    auditLogEntrySchema.parse({
      id: row.id,
      actorKind: row.actorKind,
      actorUserId: row.actorUserId,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      workspaceId: row.workspaceId,
      details: row.details as Record<string, unknown>,
      occurredAt: row.occurredAt.toISOString(),
    }),
  );
}

/* ---------- 滥用处理 ---------- */

const toAbuseFlagDto = (row: typeof abuseFlags.$inferSelect): AbuseFlag =>
  abuseFlagSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    category: row.category,
    severity: row.severity,
    status: row.status,
    note: row.note,
    createdByUserId: row.createdByUserId,
    resolvedByUserId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

export async function createAbuseFlag(
  deps: DomainDeps,
  input: { workspaceId: string; request: unknown; actorUserId: string },
): Promise<AbuseFlag> {
  const body = createAbuseFlagRequestSchema.parse(input.request);
  const rows = await deps.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
  if (rows[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'workspace not found', 404);
  const inserted = await deps.db
    .insert(abuseFlags)
    .values({
      id: `abf_${randomUUID()}`,
      workspaceId: input.workspaceId,
      category: body.category,
      severity: body.severity,
      status: 'OPEN',
      note: body.note,
      createdByUserId: input.actorUserId,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'abuse flag insert failed', 500);
  await recordAudit(deps, {
    actorKind: 'PLATFORM_ADMIN',
    actorUserId: input.actorUserId,
    action: 'abuse.flag.create',
    targetType: 'abuse_flag',
    targetId: row.id,
    workspaceId: input.workspaceId,
    details: { category: body.category, severity: body.severity },
  });
  return toAbuseFlagDto(row);
}

export async function listAbuseFlags(
  deps: DomainDeps,
  input: { workspaceId?: string; status?: string; limit?: number } = {},
): Promise<AbuseFlag[]> {
  const conditions = [
    ...(input.workspaceId !== undefined ? [eq(abuseFlags.workspaceId, input.workspaceId)] : []),
    ...(input.status !== undefined ? [eq(abuseFlags.status, input.status)] : []),
  ];
  const rows = await deps.db
    .select()
    .from(abuseFlags)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(abuseFlags.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
  return rows.map(toAbuseFlagDto);
}

export async function resolveAbuseFlag(
  deps: DomainDeps,
  input: { flagId: string; request: unknown; actorUserId: string },
): Promise<AbuseFlag> {
  const body = resolveAbuseFlagRequestSchema.parse(input.request);
  const rows = await deps.db.select().from(abuseFlags).where(eq(abuseFlags.id, input.flagId)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'abuse flag not found', 404);
  if (row.status !== 'OPEN') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `标记状态不允许解决（${row.status}）`, 409);
  }
  const now = new Date();
  const updated = await deps.db
    .update(abuseFlags)
    .set({ status: 'RESOLVED', resolvedByUserId: input.actorUserId, resolvedAt: now, resolutionNote: body.resolutionNote, updatedAt: now })
    .where(eq(abuseFlags.id, row.id))
    .returning();
  const result = updated[0];
  if (result === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'abuse flag resolve failed', 500);
  await recordAudit(deps, {
    actorKind: 'PLATFORM_ADMIN',
    actorUserId: input.actorUserId,
    action: 'abuse.flag.resolve',
    targetType: 'abuse_flag',
    targetId: row.id,
    workspaceId: row.workspaceId,
    details: { resolutionNote: body.resolutionNote.slice(0, 200) },
  });
  return toAbuseFlagDto(result);
}

/** 设置工作区限制状态（`RESTRICTED` = 阻止新的成本性任务；闸门在 createJobInTx）。 */
export async function setWorkspaceAbuseState(
  deps: DomainDeps,
  input: { workspaceId: string; request: unknown; actorUserId: string },
): Promise<{ workspaceId: string; abuseState: WorkspaceAbuseState }> {
  const body = setWorkspaceAbuseStateRequestSchema.parse(input.request);
  const updated = await deps.db
    .update(workspaces)
    .set({ abuseState: body.abuseState, updatedAt: new Date() })
    .where(eq(workspaces.id, input.workspaceId))
    .returning({ id: workspaces.id, abuseState: workspaces.abuseState });
  const row = updated[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'workspace not found', 404);
  await recordAudit(deps, {
    actorKind: 'PLATFORM_ADMIN',
    actorUserId: input.actorUserId,
    action: 'abuse.state.set',
    targetType: 'workspace',
    targetId: input.workspaceId,
    workspaceId: input.workspaceId,
    details: { abuseState: body.abuseState, note: body.note.slice(0, 200) },
  });
  return { workspaceId: row.id, abuseState: workspaceAbuseStateSchema.parse(row.abuseState) };
}

/* ---------- 支持工具（不可无痕） ---------- */

const toGrantDto = (row: typeof supportAccessGrants.$inferSelect): SupportAccessGrant => {
  const expired = row.status === 'ACTIVE' && row.expiresAt.getTime() <= Date.now();
  const status: SupportGrantStatus = expired ? 'EXPIRED' : (row.status as SupportGrantStatus);
  return supportAccessGrantSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    requestedByUserId: row.requestedByUserId,
    purpose: row.purpose,
    status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedByUserId: row.revokedByUserId,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  });
};

/** 授权创建 → 审计 + **对工作区可见的 Outbox 事件**（不可无痕从授权即开始）。 */
export async function createSupportGrant(
  deps: DomainDeps,
  input: { workspaceId: string; request: unknown; actorUserId: string },
): Promise<SupportAccessGrant> {
  const body = createSupportGrantRequestSchema.parse(input.request);
  const rows = await deps.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
  if (rows[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'workspace not found', 404);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + body.ttlHours * 60 * 60 * 1000);
  const inserted = await deps.db
    .insert(supportAccessGrants)
    .values({
      id: `sag_${randomUUID()}`,
      workspaceId: input.workspaceId,
      requestedByUserId: input.actorUserId,
      purpose: body.purpose,
      status: 'ACTIVE',
      expiresAt,
      createdAt: now,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'support grant insert failed', 500);
  await deps.db.insert(outboxEvents).values({
    id: `obx_${randomUUID()}`,
    workspaceId: input.workspaceId,
    type: 'support.access_granted',
    payload: { grantId: row.id, purpose: body.purpose, expiresAt: expiresAt.toISOString(), actorType: 'PLATFORM_ADMIN', actorId: input.actorUserId },
  });
  await recordAudit(deps, {
    actorKind: 'PLATFORM_ADMIN',
    actorUserId: input.actorUserId,
    action: 'support.grant.create',
    targetType: 'support_grant',
    targetId: row.id,
    workspaceId: input.workspaceId,
    details: { purpose: body.purpose.slice(0, 200), ttlHours: body.ttlHours },
  });
  return toGrantDto(row);
}

export async function revokeSupportGrant(deps: DomainDeps, input: { grantId: string; actorUserId: string }): Promise<SupportAccessGrant> {
  const rows = await deps.db.select().from(supportAccessGrants).where(eq(supportAccessGrants.id, input.grantId)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'support grant not found', 404);
  if (row.status !== 'ACTIVE') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `授权状态不允许撤销（${row.status}）`, 409);
  }
  const now = new Date();
  const updated = await deps.db
    .update(supportAccessGrants)
    .set({ status: 'REVOKED', revokedByUserId: input.actorUserId, revokedAt: now })
    .where(eq(supportAccessGrants.id, row.id))
    .returning();
  const result = updated[0];
  if (result === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'support grant revoke failed', 500);
  await recordAudit(deps, {
    actorKind: 'PLATFORM_ADMIN',
    actorUserId: input.actorUserId,
    action: 'support.grant.revoke',
    targetType: 'support_grant',
    targetId: row.id,
    workspaceId: row.workspaceId,
    details: {},
  });
  return toGrantDto(result);
}

export async function listSupportGrants(
  deps: DomainDeps,
  input: { workspaceId?: string; status?: string; limit?: number } = {},
): Promise<SupportAccessGrant[]> {
  const conditions = [
    ...(input.workspaceId !== undefined ? [eq(supportAccessGrants.workspaceId, input.workspaceId)] : []),
    ...(input.status !== undefined ? [eq(supportAccessGrants.status, input.status)] : []),
  ];
  const rows = await deps.db
    .select()
    .from(supportAccessGrants)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(supportAccessGrants.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
  return rows.map(toGrantDto);
}

/**
 * 支持视图（**需有效授权**；只含非私密元数据摘要）。
 * 每次访问：①audit_log（support.view）②工作区可见事件（support.viewed）——"不可无痕"。
 */
export async function getSupportView(deps: DomainDeps, input: { workspaceId: string; actorUserId: string }): Promise<SupportView> {
  const grantRows = await deps.db
    .select()
    .from(supportAccessGrants)
    .where(
      and(
        eq(supportAccessGrants.workspaceId, input.workspaceId),
        eq(supportAccessGrants.status, 'ACTIVE'),
        gt(supportAccessGrants.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(supportAccessGrants.createdAt))
    .limit(1);
  const grantRow = grantRows[0];
  if (grantRow === undefined) {
    throw new ApiFailure(ERROR_CODES.FORBIDDEN, '无有效支持访问授权（需先创建时限授权）', 403, { reason: SUPPORT_ERROR_REASONS.SUPPORT_GRANT_REQUIRED });
  }

  const [workspaceRows, memberRows, projectRows, assetRows, storageRows, renderRows, jobRows, creditsBalance] = await Promise.all([
    deps.db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1),
    deps.db.select({ total: count() }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, input.workspaceId)),
    deps.db.select({ total: count() }).from(projects).where(eq(projects.workspaceId, input.workspaceId)),
    deps.db.select({ total: count() }).from(assets).where(eq(assets.workspaceId, input.workspaceId)),
    deps.db
      .select({ total: sql<number>`coalesce(sum(${assetVersions.sizeBytes}), 0)` })
      .from(assetVersions)
      .where(and(eq(assetVersions.workspaceId, input.workspaceId), isNull(assetVersions.deletedAt))),
    deps.db.select({ status: renders.status, total: count() }).from(renders).where(eq(renders.workspaceId, input.workspaceId)).groupBy(renders.status),
    deps.db.select({ status: jobs.status, total: count() }).from(jobs).where(eq(jobs.workspaceId, input.workspaceId)).groupBy(jobs.status),
    getBalanceCredits(deps, { workspaceId: input.workspaceId }),
  ]);
  const workspace = workspaceRows[0];
  if (workspace === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'workspace not found', 404);

  const subscriptionRows = await deps.db
    .select({ planKey: plans.planKey })
    .from(workspaceSubscriptions)
    .innerJoin(plans, eq(plans.id, workspaceSubscriptions.planId))
    .where(and(eq(workspaceSubscriptions.workspaceId, input.workspaceId), eq(workspaceSubscriptions.status, 'ACTIVE')))
    .limit(1);
  const planKey = subscriptionRows[0]?.planKey ?? defaultPlanKeyForUnsubscribed();

  const viewedAt = new Date();
  // 访问留痕（先写审计与事件，再返回数据——即使响应中断也已记录）
  await recordAudit(deps, {
    actorKind: 'PLATFORM_ADMIN',
    actorUserId: input.actorUserId,
    action: 'support.view',
    targetType: 'workspace',
    targetId: input.workspaceId,
    workspaceId: input.workspaceId,
    details: { grantId: grantRow.id, purpose: grantRow.purpose.slice(0, 200) },
  });
  await deps.db.insert(outboxEvents).values({
    id: `obx_${randomUUID()}`,
    workspaceId: input.workspaceId,
    type: 'support.viewed',
    payload: { grantId: grantRow.id, actorType: 'PLATFORM_ADMIN', actorId: input.actorUserId, viewedAt: viewedAt.toISOString() },
  });

  return supportViewSchema.parse({
    workspaceId: input.workspaceId,
    name: workspace.name,
    privacyTier: privacyTierSchema.parse(workspace.privacyTier),
    abuseState: workspaceAbuseStateSchema.parse(workspace.abuseState),
    planKey,
    counts: {
      members: Number(memberRows[0]?.total ?? 0),
      projects: Number(projectRows[0]?.total ?? 0),
      assets: Number(assetRows[0]?.total ?? 0),
      storageBytesUsed: Number(storageRows[0]?.total ?? 0),
      creditsBalance,
      renders: Object.fromEntries(renderRows.map((row) => [row.status, Number(row.total)])),
      jobs: Object.fromEntries(jobRows.map((row) => [row.status, Number(row.total)])),
    },
    grant: toGrantDto(grantRow),
    viewedAt: viewedAt.toISOString(),
  });
}

/* ---------- 完整 Admin（§67 只读聚合） ---------- */

export async function listAdminUsers(deps: DomainDeps, input: { query?: string; limit?: number } = {}): Promise<AdminUserSummary[]> {
  const pattern = input.query !== undefined && input.query !== '' ? `%${input.query}%` : null;
  const rows = await deps.db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
      workspaceCount: sql<number>`(select count(*)::int from workspace_members wm where wm.user_id = "user".id)`,
    })
    .from(user)
    .where(pattern === null ? undefined : or(ilike(user.email, pattern), ilike(user.name, pattern)))
    .orderBy(desc(user.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  return rows.map((row) =>
    adminUserSummarySchema.parse({
      id: row.id,
      email: row.email,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      workspaceCount: Number(row.workspaceCount),
    }),
  );
}

export async function listAdminWorkspaces(deps: DomainDeps, input: { query?: string; limit?: number } = {}): Promise<AdminWorkspaceSummary[]> {
  const pattern = input.query !== undefined && input.query !== '' ? `%${input.query}%` : null;
  const rows = await deps.db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      privacyTier: workspaces.privacyTier,
      abuseState: workspaces.abuseState,
      createdAt: workspaces.createdAt,
      membersUsed: sql<number>`(select count(*)::int from workspace_members wm where wm.workspace_id = "workspaces".id)`,
      storageBytesUsed: sql<number>`(select coalesce(sum(av.size_bytes), 0)::bigint from asset_versions av where av.workspace_id = "workspaces".id and av.deleted_at is null)`,
      openAbuseFlags: sql<number>`(select count(*)::int from abuse_flags af where af.workspace_id = "workspaces".id and af.status = 'OPEN')`,
      planKey: sql<string | null>`(select p.plan_key from workspace_subscriptions ws2 join plans p on p.id = ws2.plan_id where ws2.workspace_id = "workspaces".id and ws2.status = 'ACTIVE' limit 1)`,
    })
    .from(workspaces)
    .where(pattern === null ? undefined : ilike(workspaces.name, pattern))
    .orderBy(desc(workspaces.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  const balances = await Promise.all(rows.map((row) => getBalanceCredits(deps, { workspaceId: row.id })));
  return rows.map((row, index) =>
    adminWorkspaceSummarySchema.parse({
      id: row.id,
      name: row.name,
      privacyTier: row.privacyTier,
      abuseState: row.abuseState,
      planKey: row.planKey ?? defaultPlanKeyForUnsubscribed(),
      membersUsed: Number(row.membersUsed),
      storageBytesUsed: Number(row.storageBytesUsed),
      creditsBalance: balances[index] ?? 0,
      openAbuseFlags: Number(row.openAbuseFlags),
      createdAt: row.createdAt.toISOString(),
    }),
  );
}

export async function listAdminProjects(
  deps: DomainDeps,
  input: { query?: string; workspaceId?: string; limit?: number } = {},
): Promise<AdminProjectSummary[]> {
  const pattern = input.query !== undefined && input.query !== '' ? `%${input.query}%` : null;
  const conditions = [
    ...(pattern !== null ? [ilike(projects.title, pattern)] : []),
    ...(input.workspaceId !== undefined ? [eq(projects.workspaceId, input.workspaceId)] : []),
  ];
  const rows = await deps.db
    .select()
    .from(projects)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(projects.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  return rows.map((row) =>
    adminProjectSummarySchema.parse({
      id: row.id,
      workspaceId: row.workspaceId,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }),
  );
}

/** Provider 状态（近 7 天生成记录聚合；错误类别截断——不含 Secret/响应体）。 */
export async function getAdminProviderStatus(deps: DomainDeps): Promise<AdminProviderStatus> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await deps.db
    .select({ providerId: providerGenerations.providerId, status: providerGenerations.status, total: count() })
    .from(providerGenerations)
    .where(sql`${providerGenerations.createdAt} >= ${since}`)
    .groupBy(providerGenerations.providerId, providerGenerations.status);

  const byProvider = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const bucket = byProvider.get(row.providerId) ?? {};
    bucket[row.status] = Number(row.total);
    byProvider.set(row.providerId, bucket);
  }
  const items: AdminProviderStatus['items'] = [];
  for (const [providerId, byStatus] of byProvider) {
    const failureRows = await deps.db
      .select({ error: providerGenerations.error, updatedAt: providerGenerations.updatedAt })
      .from(providerGenerations)
      .where(and(eq(providerGenerations.providerId, providerId), sql`${providerGenerations.error} is not null`))
      .orderBy(desc(providerGenerations.updatedAt))
      .limit(1);
    const failure = failureRows[0];
    const errorRecord = (failure?.error ?? null) as Record<string, unknown> | null;
    const categoryRaw = errorRecord === null ? null : (errorRecord['code'] ?? errorRecord['category'] ?? errorRecord['message'] ?? null);
    const lastErrorCategory = categoryRaw === null ? null : String(categoryRaw).slice(0, 120);
    items.push({
      providerId,
      byStatus,
      lastFailureAt: failure === undefined ? null : failure.updatedAt.toISOString(),
      lastErrorCategory,
    });
  }
  items.sort((a, b) => a.providerId.localeCompare(b.providerId));
  return adminProviderStatusSchema.parse({ items });
}

/** 存储用量（按工作区聚合，Top-N；含总量）。 */
export async function getAdminStorageSummary(deps: DomainDeps, input: { limit?: number } = {}): Promise<AdminStorageSummary> {
  const rows = await deps.db
    .select({
      workspaceId: assetVersions.workspaceId,
      bytesUsed: sql<number>`coalesce(sum(${assetVersions.sizeBytes}), 0)::bigint`,
      assetCount: sql<number>`count(distinct ${assetVersions.assetId})::int`,
    })
    .from(assetVersions)
    .where(isNull(assetVersions.deletedAt))
    .groupBy(assetVersions.workspaceId)
    .orderBy(sql`coalesce(sum(${assetVersions.sizeBytes}), 0) desc`)
    .limit(Math.min(Math.max(input.limit ?? 20, 1), 100));
  const names = await deps.db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces);
  const nameById = new Map(names.map((row) => [row.id, row.name]));
  const totalRows = await deps.db
    .select({ total: sql<number>`coalesce(sum(${assetVersions.sizeBytes}), 0)::bigint` })
    .from(assetVersions)
    .where(isNull(assetVersions.deletedAt));
  return adminStorageSummarySchema.parse({
    totalBytes: Number(totalRows[0]?.total ?? 0),
    items: rows.map((row) => ({
      workspaceId: row.workspaceId,
      workspaceName: nameById.get(row.workspaceId) ?? row.workspaceId,
      bytesUsed: Number(row.bytesUsed),
      assetCount: Number(row.assetCount),
    })),
  });
}

/** 受限工作区闸门（供 jobs.ts 的 createJobInTx 复用；返回 null = 放行）。 */
export function workspaceRestrictedFailure(): ApiFailure {
  return new ApiFailure(ERROR_CODES.FORBIDDEN, '工作区处于限制状态：新的任务被阻止（联系平台支持）', 403, {
    reason: ABUSE_ERROR_REASONS.WORKSPACE_RESTRICTED,
  });
}
