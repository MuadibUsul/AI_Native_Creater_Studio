import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  HANDOFF_ERROR_REASONS,
  handoffRecordSchema,
  type HandoffRecord,
} from '@ancs/contracts';
import { assets, handoffs } from '@ancs/db';
import type { DomainDeps } from './deps.js';

/**
 * Handoff 服务（P13-05 / §42.3；计划 §8 P13）：
 * 可撤销、限时（TTL 上限 7 天）、绑定账号与 Artifact 的跨端交接记录。
 * - 创建：Artifact 必须属于该项目（绑定真实）；expiresAt = now + TTL；
 * - 领取（claim，供移动端 P15-06 消费）：PENDING 且未过期且同租户——**过期/跨租户访问失败**；
 * - 取消：PENDING/CLAIMED → REVOKED（终态）；
 * - 状态查询：isExpired 读取时计算。
 */

const DEFAULT_TTL_SECONDS = 24 * 3600;

const isExpiredRow = (row: { expiresAt: Date }): boolean => row.expiresAt.getTime() <= Date.now();

const toDto = (row: typeof handoffs.$inferSelect): HandoffRecord =>
  handoffRecordSchema.parse({
    handoffId: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    state: row.state,
    artifactIds: row.artifactIds,
    targetPlatform: row.targetPlatform,
    createdBy: row.createdBy,
    claimedBy: row.claimedBy,
    claimedAt: row.claimedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    isExpired: isExpiredRow(row),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });

async function loadHandoff(deps: DomainDeps, input: { workspaceId: string; projectId: string; handoffId: string }): Promise<typeof handoffs.$inferSelect> {
  const rows = await deps.db
    .select()
    .from(handoffs)
    .where(
      and(
        eq(handoffs.id, input.handoffId),
        eq(handoffs.workspaceId, input.workspaceId),
        eq(handoffs.projectId, input.projectId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    // 跨租户访问 → 404 反枚举（不泄露他租户 handoff 存在性）
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'handoff 不存在', 404, { reason: HANDOFF_ERROR_REASONS.NOT_FOUND });
  }
  return row;
}

/** 创建 Handoff（限时 + Artifact 绑定校验）。 */
export async function createHandoff(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; artifactIds: string[]; targetPlatform: string | null; ttlSeconds?: number; createdBy?: string | null },
): Promise<HandoffRecord> {
  // Artifact 绑定校验：必须属于该项目（assets）
  for (const artifactId of input.artifactIds) {
    const rows = await deps.db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, artifactId), eq(assets.projectId, input.projectId), eq(assets.workspaceId, input.workspaceId)))
      .limit(1);
    if (rows[0] === undefined) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `Artifact ${artifactId} 不属于该项目（绑定必须真实）`, 422, {
        reason: HANDOFF_ERROR_REASONS.ARTIFACT_NOT_TRACEABLE,
        artifactId,
      });
    }
  }
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const inserted = await deps.db
    .insert(handoffs)
    .values({
      id: `hdf_${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      state: 'PENDING',
      artifactIds: input.artifactIds,
      targetPlatform: input.targetPlatform,
      createdBy: input.createdBy ?? null,
      expiresAt: new Date(Date.now() + ttl * 1000),
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'handoff insert failed', 500);
  return toDto(row);
}

/** 领取（PENDING → CLAIMED；过期 → 410 HANDOFF_EXPIRED；跨租户 → 404；已撤销/已完成 → 409）。 */
export async function claimHandoff(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; handoffId: string; claimedBy: string },
): Promise<HandoffRecord> {
  const row = await loadHandoff(deps, input);
  if (isExpiredRow(row)) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'handoff 已过期（限时性）', 410, { reason: HANDOFF_ERROR_REASONS.HANDOFF_EXPIRED, handoffId: row.id });
  }
  if (row.state !== 'PENDING') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `handoff 状态 ${row.state} 不可领取`, 409, {
      reason: HANDOFF_ERROR_REASONS.INVALID_STATE,
      handoffId: row.id,
    });
  }
  const updated = await deps.db
    .update(handoffs)
    .set({ state: 'CLAIMED', claimedBy: input.claimedBy, claimedAt: new Date() })
    .where(and(eq(handoffs.id, row.id), eq(handoffs.state, 'PENDING')))
    .returning();
  const next = updated[0];
  if (next === undefined) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'handoff 状态已变化（并发领取）', 409, { reason: HANDOFF_ERROR_REASONS.INVALID_STATE });
  return toDto(next);
}

/** 取消（可撤销：PENDING/CLAIMED → REVOKED；终态不可取消）。 */
export async function cancelHandoff(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; handoffId: string },
): Promise<HandoffRecord> {
  const row = await loadHandoff(deps, input);
  if (row.state === 'REVOKED' || row.state === 'COMPLETED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `handoff 状态 ${row.state} 不可取消`, 409, {
      reason: HANDOFF_ERROR_REASONS.INVALID_STATE,
      handoffId: row.id,
    });
  }
  const updated = await deps.db
    .update(handoffs)
    .set({ state: 'REVOKED', revokedAt: new Date() })
    .where(and(eq(handoffs.id, row.id), eq(handoffs.state, row.state)))
    .returning();
  const next = updated[0];
  if (next === undefined) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'handoff 状态已变化（并发）', 409, { reason: HANDOFF_ERROR_REASONS.INVALID_STATE });
  return toDto(next);
}

/** 状态查询（单条；isExpired 读取时计算）。 */
export async function getHandoff(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; handoffId: string },
): Promise<HandoffRecord> {
  return toDto(await loadHandoff(deps, input));
}

/** Handoff 列表（新→旧）。 */
export async function listProjectHandoffs(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<HandoffRecord[]> {
  const rows = await deps.db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.workspaceId, input.workspaceId), eq(handoffs.projectId, input.projectId)))
    .orderBy(desc(handoffs.createdAt));
  return rows.map(toDto);
}
