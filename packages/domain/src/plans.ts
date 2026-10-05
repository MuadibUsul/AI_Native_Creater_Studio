import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import {
  ApiFailure,
  DEFAULT_PLAN_SEEDS,
  ENTITLEMENT_ERROR_REASONS,
  ERROR_CODES,
  createPlanVersionRequestSchema,
  entitlementUsageSchema,
  planEntitlementsSchema,
  planSchema,
  planPriceSchema,
  workspaceEntitlementSchema,
  workspaceSubscriptionSchema,
  type CreatePlanVersionRequest,
  type EntitlementUsage,
  type Plan,
  type PlanKey,
  type WorkspaceEntitlement,
  type WorkspaceSubscription,
} from '@ancs/contracts';
import { assetVersions, channels, creatorIdentities, customMotionComponentVersions, plans, workspaceMembers, workspaceSubscriptions, workspaces } from '@ancs/db';
import type { DomainDeps } from './channels.js';

/**
 * 套餐与权益服务（P09-01 / 规范 §73、§35—36、§31）。
 *
 * - **版本化**：Plan 变更 = 追加新版本行（`createPlanVersion`）；种子负责首播（`ensureDefaultPlans`，幂等）；
 * - **订阅不可篡改历史**：换套餐 = 追加订阅行（旧行记 supersededAt）；账本/历史不被改写；
 * - **所有额度在服务层强制执行**（API 必经）：存储/渠道/身份/席位/BYOK/4K 渲染/Custom Motion 预算/Pack；
 *   违约 = 明确 422/403（带 reason/limit/current），绝不静默放行；
 * - 无订阅的 workspace 按部署默认套餐（ANCS_DEFAULT_PLAN；预上线默认 ENTERPRISE，SaaS 上线门要求 FREE）——无"无套餐"空档，额度始终有口径。
 */

/**
 * 未订阅 workspace 的默认套餐（部署配置 ANCS_DEFAULT_PLAN；默认 ENTERPRISE = 预上线内部模式）。
 * **SaaS 上线门（P09-06）要求正式环境置为 FREE（或注册流程显式分配）**——默认值即默认额度口径。
 */
function defaultPlanKeyForUnsubscribed(): PlanKey {
  const raw = process.env['ANCS_DEFAULT_PLAN'];
  if (raw === undefined || raw === '') return 'ENTERPRISE';
  const allowed: readonly string[] = ['FREE', 'CREATOR', 'PRO', 'STUDIO', 'ENTERPRISE'];
  if (!allowed.includes(raw)) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, `ANCS_DEFAULT_PLAN 非法：${raw}（允许 FREE/CREATOR/PRO/STUDIO/ENTERPRISE）`, 500);
  }
  return raw as PlanKey;
}

const toPlanDto = (row: typeof plans.$inferSelect): Plan =>
  planSchema.parse({
    id: row.id,
    planKey: row.planKey,
    version: row.version,
    name: row.name,
    entitlements: planEntitlementsSchema.parse(row.entitlements),
    price: planPriceSchema.parse(row.price ?? null),
    status: row.status,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  });

const toSubscriptionDto = (row: typeof workspaceSubscriptions.$inferSelect): WorkspaceSubscription =>
  workspaceSubscriptionSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    planId: row.planId,
    planKey: row.planKey,
    planVersion: row.planVersion,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    supersededAt: row.supersededAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    assignedBy: row.assignedBy,
  });

/* ---------- Plan 版本（不可变） ---------- */

/** 首播默认套餐（幂等：仅当该 Key 无任何版本时写入 version 1；价格 null——数据，非业务硬编码）。 */
export async function ensureDefaultPlans(deps: DomainDeps): Promise<{ created: PlanKey[] }> {
  const anyRows = await deps.db.select({ id: plans.id }).from(plans).limit(1);
  if (anyRows[0] !== undefined) return { created: [] };
  const created: PlanKey[] = [];
  for (const seed of DEFAULT_PLAN_SEEDS) {
    const existing = await deps.db.select({ id: plans.id }).from(plans).where(eq(plans.planKey, seed.planKey)).limit(1);
    if (existing[0] !== undefined) continue;
    await deps.db.insert(plans).values({
      id: `pln_${randomUUID()}`,
      planKey: seed.planKey,
      version: 1,
      name: seed.name,
      entitlements: seed.entitlements,
      price: null,
      status: 'ACTIVE',
      note: '默认种子（P09-01）；价格留给运营/支付阶段以新版本写入',
    });
    created.push(seed.planKey);
  }
  return { created };
}

/** 追加 Plan 新版本（版本行不可变：变更必须走新版本；同 Key 版本号单调递增）。 */
export async function createPlanVersion(deps: DomainDeps, request: CreatePlanVersionRequest): Promise<Plan> {
  const body = createPlanVersionRequestSchema.parse(request);
  const maxRows = await deps.db
    .select({ max: sql<number>`coalesce(max(${plans.version}), 0)` })
    .from(plans)
    .where(eq(plans.planKey, body.planKey));
  const version = Number(maxRows[0]?.max ?? 0) + 1;
  const inserted = await deps.db
    .insert(plans)
    .values({
      id: `pln_${randomUUID()}`,
      planKey: body.planKey,
      version,
      name: body.name,
      entitlements: body.entitlements,
      price: body.price ?? null,
      status: body.status,
      note: body.note ?? null,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'plan insert failed', 500);
  return toPlanDto(row);
}

/** Plan 版本列表（同 Key 全部版本，新→旧）。 */
export async function listPlans(deps: DomainDeps, input: { planKey?: PlanKey } = {}): Promise<Plan[]> {
  const rows =
    input.planKey === undefined
      ? await deps.db.select().from(plans).orderBy(plans.planKey, desc(plans.version))
      : await deps.db.select().from(plans).where(eq(plans.planKey, input.planKey)).orderBy(desc(plans.version));
  return rows.map(toPlanDto);
}

/** 某 Key 的最新 ACTIVE 版本（无 → 明确 500：种子未执行）。 */
export async function getActivePlanVersion(deps: DomainDeps, planKey: PlanKey): Promise<Plan> {
  const rows = await deps.db
    .select()
    .from(plans)
    .where(and(eq(plans.planKey, planKey), eq(plans.status, 'ACTIVE')))
    .orderBy(desc(plans.version))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, `套餐目录缺失：${planKey}（ensureDefaultPlans 未执行？）`, 500);
  }
  return toPlanDto(row);
}

/* ---------- 订阅（append-only） ---------- */

/** 指派套餐（平台管理员）：追加订阅行；旧 ACTIVE 行记 supersededAt（历史保留）。 */
export async function assignWorkspacePlan(
  deps: DomainDeps,
  input: { workspaceId: string; planKey: PlanKey; assignedBy?: string | null; note?: string | null },
): Promise<WorkspaceSubscription> {
  const workspaceRows = await deps.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
  if (workspaceRows[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'workspace not found', 404);
  const plan = await getActivePlanVersion(deps, input.planKey);
  const now = new Date();

  return deps.db.transaction(async (tx) => {
    // 旧订阅保留（supersededAt），不删除、不改写内容——"修改套餐不篡改历史账单"
    await tx
      .update(workspaceSubscriptions)
      .set({ status: 'CANCELLED', supersededAt: now, cancelledAt: now })
      .where(and(eq(workspaceSubscriptions.workspaceId, input.workspaceId), eq(workspaceSubscriptions.status, 'ACTIVE'), isNull(workspaceSubscriptions.supersededAt)));
    const inserted = await tx
      .insert(workspaceSubscriptions)
      .values({
        id: `sub_${randomUUID()}`,
        workspaceId: input.workspaceId,
        planId: plan.id,
        planKey: plan.planKey,
        planVersion: plan.version,
        status: 'ACTIVE',
        startedAt: now,
        assignedBy: input.assignedBy ?? null,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'subscription insert failed', 500);
    return toSubscriptionDto(row);
  });
}

/** 当前订阅（最新 ACTIVE；无 → null）。 */
export async function getWorkspaceSubscription(deps: DomainDeps, input: { workspaceId: string }): Promise<WorkspaceSubscription | null> {
  const rows = await deps.db
    .select()
    .from(workspaceSubscriptions)
    .where(and(eq(workspaceSubscriptions.workspaceId, input.workspaceId), eq(workspaceSubscriptions.status, 'ACTIVE'), isNull(workspaceSubscriptions.supersededAt)))
    .orderBy(desc(workspaceSubscriptions.startedAt))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toSubscriptionDto(row);
}

/* ---------- 权益解析与用量 ---------- */

async function loadUsage(deps: DomainDeps, workspaceId: string): Promise<EntitlementUsage> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [storageRows, seatsRows, channelRows, identityRows, motionRows] = await Promise.all([
    deps.db
      .select({ total: sql<number>`coalesce(sum(${assetVersions.sizeBytes}), 0)` })
      .from(assetVersions)
      .where(and(eq(assetVersions.workspaceId, workspaceId), isNull(assetVersions.deletedAt))),
    deps.db.select({ total: count() }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)),
    deps.db.select({ total: count() }).from(channels).where(eq(channels.workspaceId, workspaceId)),
    deps.db.select({ total: count() }).from(creatorIdentities).where(eq(creatorIdentities.workspaceId, workspaceId)),
    deps.db
      .select({ total: count() })
      .from(customMotionComponentVersions)
      .where(and(eq(customMotionComponentVersions.workspaceId, workspaceId), gte(customMotionComponentVersions.createdAt, monthStart))),
  ]);
  return entitlementUsageSchema.parse({
    storageBytesUsed: Number(storageRows[0]?.total ?? 0),
    seatsUsed: Number(seatsRows[0]?.total ?? 0),
    channelsUsed: Number(channelRows[0]?.total ?? 0),
    creatorIdentitiesUsed: Number(identityRows[0]?.total ?? 0),
    customMotionUsedThisMonth: Number(motionRows[0]?.total ?? 0),
  });
}

/** 解析 workspace 当前权益（订阅 → 固定版本；无订阅 → 默认 FREE 版本）+ 实时用量。 */
export async function getWorkspaceEntitlement(deps: DomainDeps, input: { workspaceId: string }): Promise<WorkspaceEntitlement> {
  // 目录惰性播种（幂等；内部/测试环境无需显式 boot 播种）
  await ensureDefaultPlans(deps);
  const subscription = await getWorkspaceSubscription(deps, input);
  let plan: Plan;
  let source: 'SUBSCRIPTION' | 'DEFAULT_FREE';
  if (subscription === null) {
    plan = await getActivePlanVersion(deps, defaultPlanKeyForUnsubscribed());
    source = 'DEFAULT_FREE';
  } else {
    const rows = await deps.db.select().from(plans).where(eq(plans.id, subscription.planId)).limit(1);
    const row = rows[0];
    if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, `订阅引用缺失的 Plan 版本：${subscription.planId}`, 500);
    plan = toPlanDto(row);
    source = 'SUBSCRIPTION';
  }
  const usage = await loadUsage(deps, input.workspaceId);
  return workspaceEntitlementSchema.parse({
    workspaceId: input.workspaceId,
    plan,
    entitlements: plan.entitlements,
    usage,
    source,
  });
}

/* ---------- 额度断言（**API 强制执行**；违约 = 明确 4xx） ---------- */

const deny = (reason: (typeof ENTITLEMENT_ERROR_REASONS)[keyof typeof ENTITLEMENT_ERROR_REASONS], message: string, httpStatus: number, details: Record<string, unknown>): ApiFailure =>
  new ApiFailure(httpStatus === 403 ? ERROR_CODES.FORBIDDEN : ERROR_CODES.VALIDATION_FAILED, message, httpStatus, { reason, ...details });

/** 存储额度（§36）：现有用量 + 新增 ≤ 上限（本地驱动无云配额，服务端统一核算）。 */
export async function assertStorageQuota(deps: DomainDeps, input: { workspaceId: string; additionalBytes: number }): Promise<void> {
  const entitlement = await getWorkspaceEntitlement(deps, input);
  const limit = entitlement.entitlements.storageBytes;
  if (limit === null) return;
  const projected = entitlement.usage.storageBytesUsed + Math.max(0, input.additionalBytes);
  if (projected > limit) {
    throw deny(
      ENTITLEMENT_ERROR_REASONS.STORAGE_QUOTA_EXCEEDED,
      `存储额度不足：已用 ${String(entitlement.usage.storageBytesUsed)} + 新增 ${String(input.additionalBytes)} 超过套餐上限 ${String(limit)} 字节（升级套餐或清理 Trash）`,
      422,
      { limit, used: entitlement.usage.storageBytesUsed, additionalBytes: input.additionalBytes, planKey: entitlement.plan.planKey },
    );
  }
}

/** 席位（P09-04 邀请入口接入时会先经此断言）。 */
export async function assertSeatsAvailable(deps: DomainDeps, input: { workspaceId: string; additionalSeats?: number }): Promise<void> {
  const entitlement = await getWorkspaceEntitlement(deps, input);
  const limit = entitlement.entitlements.seats;
  if (limit === null) return;
  const projected = entitlement.usage.seatsUsed + (input.additionalSeats ?? 1);
  if (projected > limit) {
    throw deny(ENTITLEMENT_ERROR_REASONS.SEATS_EXCEEDED, `席位不足：当前 ${String(entitlement.usage.seatsUsed)} + 新增 ${String(input.additionalSeats ?? 1)} 超过套餐上限 ${String(limit)}`, 422, {
      limit,
      used: entitlement.usage.seatsUsed,
      planKey: entitlement.plan.planKey,
    });
  }
}

export async function assertChannelQuota(deps: DomainDeps, input: { workspaceId: string }): Promise<void> {
  const entitlement = await getWorkspaceEntitlement(deps, input);
  const limit = entitlement.entitlements.maxChannels;
  if (limit === null) return;
  if (entitlement.usage.channelsUsed + 1 > limit) {
    throw deny(ENTITLEMENT_ERROR_REASONS.CHANNELS_EXCEEDED, `栏目数超过套餐上限（${String(limit)}）：请升级套餐`, 422, {
      limit,
      used: entitlement.usage.channelsUsed,
      planKey: entitlement.plan.planKey,
    });
  }
}

export async function assertIdentityQuota(deps: DomainDeps, input: { workspaceId: string }): Promise<void> {
  const entitlement = await getWorkspaceEntitlement(deps, input);
  const limit = entitlement.entitlements.maxCreatorIdentities;
  if (limit === null) return;
  if (entitlement.usage.creatorIdentitiesUsed + 1 > limit) {
    throw deny(ENTITLEMENT_ERROR_REASONS.IDENTITIES_EXCEEDED, `创作者身份数超过套餐上限（${String(limit)}）：请升级套餐`, 422, {
      limit,
      used: entitlement.usage.creatorIdentitiesUsed,
      planKey: entitlement.plan.planKey,
    });
  }
}

export async function assertByokAllowed(deps: DomainDeps, input: { workspaceId: string }): Promise<void> {
  const entitlement = await getWorkspaceEntitlement(deps, input);
  if (!entitlement.entitlements.byok) {
    throw deny(ENTITLEMENT_ERROR_REASONS.BYOK_NOT_ALLOWED, `当前套餐（${entitlement.plan.planKey}）不支持 BYOK（自带 Provider 凭据）：请升级或使用平台托管`, 403, {
      planKey: entitlement.plan.planKey,
    });
  }
}

/** 渲染档位（4K 等）：PREMIUM_4K 需 fourK 权益。 */
export async function assertRenderProfileAllowed(deps: DomainDeps, input: { workspaceId: string; profile: string }): Promise<void> {
  if (input.profile !== 'PREMIUM_4K') return;
  const entitlement = await getWorkspaceEntitlement(deps, input);
  if (!entitlement.entitlements.fourK) {
    throw deny(ENTITLEMENT_ERROR_REASONS.RENDER_PROFILE_NOT_ALLOWED, `当前套餐（${entitlement.plan.planKey}）不支持 4K 渲染（PREMIUM_4K）：请升级`, 422, {
      planKey: entitlement.plan.planKey,
      profile: input.profile,
    });
  }
}

/** Pack 白名单（P11 Pack 运行基础接入；此处为强制执行点）。 */
export async function assertPackEnabled(deps: DomainDeps, input: { workspaceId: string; packId: string }): Promise<void> {
  const entitlement = await getWorkspaceEntitlement(deps, input);
  const packs = entitlement.entitlements.packs;
  if (packs === null) return;
  if (!packs.includes(input.packId)) {
    throw deny(ENTITLEMENT_ERROR_REASONS.PACK_NOT_ENABLED, `Pack 未包含在当前套餐（${entitlement.plan.planKey}）：${input.packId}`, 403, {
      planKey: entitlement.plan.planKey,
      packId: input.packId,
      enabled: packs,
    });
  }
}

/** Custom Motion 月度预算（生成入口强制执行）。 */
export async function assertCustomMotionBudget(deps: DomainDeps, input: { workspaceId: string }): Promise<void> {
  const entitlement = await getWorkspaceEntitlement(deps, input);
  const limit = entitlement.entitlements.customMotionPerMonth;
  if (limit === null) return;
  if (entitlement.usage.customMotionUsedThisMonth + 1 > limit) {
    throw deny(ENTITLEMENT_ERROR_REASONS.CUSTOM_MOTION_BUDGET_EXCEEDED, `本月 Custom Motion 生成已达套餐上限（${String(limit)}）：请升级套餐`, 422, {
      limit,
      used: entitlement.usage.customMotionUsedThisMonth,
      planKey: entitlement.plan.planKey,
    });
  }
}

/** 渲染优先级（映射 jobs.priority；越大越先）。 */
export async function resolveRenderPriority(deps: DomainDeps, input: { workspaceId: string }): Promise<number> {
  const entitlement = await getWorkspaceEntitlement(deps, input);
  return entitlement.entitlements.renderPriority;
}
