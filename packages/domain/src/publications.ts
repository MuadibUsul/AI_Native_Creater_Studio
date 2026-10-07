import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  PUBLICATION_ERROR_REASONS,
  publicationRecordSchema,
  validationResultSchema,
  type DistributionCapabilities,
  type DistributionProvider,
  type PublicationJob,
  type PublicationRecord,
  type PublicationRequest,
  type ValidationResult,
} from '@ancs/contracts';
import { projectVersions, publications, renderApprovals, renders } from '@ancs/db';
import type { DomainDeps } from './channels.js';

/**
 * 发布核心服务（P13-01 / 规范 §90；计划 §8 P13）。
 *
 * - **未批准版本不能发布**：输出资产必须属于该 projectVersion 的某个 Render，
 *   且该 Render 的最新批准为 APPROVED 且 manifestHash 一致（漂移 → NOT_APPROVED，同 P07-06 导出守卫）；
 * - **重复请求只形成一个逻辑发布**：幂等键固定四元组（platform+account+projectVersion+outputAsset）
 *   有唯一索引——冲突即返回既有行（deduped=true）；
 * - **结果未知时先查询和对账，不自动重发**：reconcile 以 Provider getStatus 为准回填状态，
 *   绝不重新调用 publish；
 * - **禁止浏览器自动化冒充可靠发布**（§90）：只经 DistributionProvider 契约接口发布；
 *   真实平台（YouTube 等）接入随 P13-02/03——未注册 Provider 501 明确失败。
 */

const requireProviders = (deps: DomainDeps): readonly DistributionProvider[] => deps.distributionProviders ?? [];

const toRecordDto = (row: typeof publications.$inferSelect): PublicationRecord =>
  publicationRecordSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    platformId: row.platformId,
    accountId: row.accountId,
    projectVersionId: row.projectVersionId,
    outputAssetId: row.outputAssetId,
    state: row.state,
    remoteId: row.remoteId,
    remoteUrl: row.remoteUrl,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    title: row.title,
    description: row.description,
    tags: row.tags,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    disclosure: row.disclosure,
    lastError: row.lastError,
    transferInstructions: row.transferInstructions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

/** 发布列表（状态查询；新→旧）。 */
export async function listProjectPublications(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<PublicationRecord[]> {
  const rows = await deps.db
    .select()
    .from(publications)
    .where(and(eq(publications.workspaceId, input.workspaceId), eq(publications.projectId, input.projectId)))
    .orderBy(desc(publications.createdAt));
  return rows.map(toRecordDto);
}

/** 单条状态查询（跨租户 → 404）。 */
export async function getPublication(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; publicationId: string },
): Promise<PublicationRecord> {
  const rows = await deps.db
    .select()
    .from(publications)
    .where(
      and(
        eq(publications.id, input.publicationId),
        eq(publications.workspaceId, input.workspaceId),
        eq(publications.projectId, input.projectId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '发布记录不存在', 404, { reason: PUBLICATION_ERROR_REASONS.NOT_FOUND });
  }
  return toRecordDto(row);
}

/**
 * 批准闸门（未批准版本不能发布/打包）：
 * 输出资产必须属于该版本的某个 Render，且该 Render 最新批准 = APPROVED + manifestHash 一致 + 版本一致。
 */
export async function assertPublicationApproval(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; projectVersionId: string; outputAssetId: string },
): Promise<void> {
  // 该版本的 Render（input JSONB 内嵌 projectVersionId）
  const renderRows = await deps.db
    .select()
    .from(renders)
    .where(and(eq(renders.workspaceId, input.workspaceId), eq(renders.projectId, input.projectId)))
    .orderBy(desc(renders.createdAt));
  const owning = renderRows.find(
    (render) =>
      (render.input as { projectVersionId?: string } | null)?.projectVersionId === input.projectVersionId &&
      Array.isArray(render.outputAssetIds) &&
      (render.outputAssetIds as string[]).includes(input.outputAssetId),
  );
  if (owning === undefined) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '输出资产不属于该版本的任何 Render：无可发布的已产出产物', 422, {
      reason: PUBLICATION_ERROR_REASONS.OUTPUT_ASSET_UNKNOWN,
      outputAssetId: input.outputAssetId,
    });
  }
  // 最新批准（append-only；最新一行 = 当前决定）
  const approvalRows = await deps.db
    .select()
    .from(renderApprovals)
    .where(and(eq(renderApprovals.renderId, owning.id), eq(renderApprovals.workspaceId, input.workspaceId)))
    .orderBy(desc(renderApprovals.createdAt))
    .limit(1);
  const approval = approvalRows[0];
  if (
    approval === undefined ||
    approval.decision !== 'APPROVED' ||
    approval.manifestHashAtApproval !== owning.manifestHash ||
    approval.projectVersionIdAtApproval !== input.projectVersionId
  ) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '未批准版本不能发布（无批准 / manifest 漂移 / 版本不一致）', 409, {
      reason: PUBLICATION_ERROR_REASONS.NOT_APPROVED,
      renderId: owning.id,
    });
  }
}

/**
 * 请求发布（P13-01 核心）：
 * 版本存在 → 批准闸门 → Provider 注册与能力 → **幂等落库** → validate → publish → 状态回填。
 * 重复请求（幂等键四元组冲突）→ 返回既有逻辑发布（deduped=true），不产生第二行、不重发。
 */
export async function requestPublication(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; request: PublicationRequest; createdBy?: string | null },
): Promise<{ publication: PublicationRecord; deduped: boolean }> {
  const body = input.request;

  // 0) 版本存在且属于该项目
  const versions = await deps.db
    .select({ id: projectVersions.id })
    .from(projectVersions)
    .where(and(eq(projectVersions.id, body.publicationKey.projectVersionId), eq(projectVersions.projectId, input.projectId)))
    .limit(1);
  if (versions[0] === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '项目版本不存在或不属于该项目', 404, { reason: PUBLICATION_ERROR_REASONS.NOT_FOUND });
  }

  // 1) 批准闸门
  await assertPublicationApproval(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    projectVersionId: body.publicationKey.projectVersionId,
    outputAssetId: body.publicationKey.outputAssetId,
  });

  // 2) Provider 注册 + 能力分级（与真实 capability 一致；未注册 501 明确失败）
  const provider = requireProviders(deps).find((candidate) => candidate.providerId === body.publicationKey.platformId);
  if (provider === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, `分发 Provider 未注册：${body.publicationKey.platformId}（真实平台接入随 P13-02/03）`, 501, {
      reason: PUBLICATION_ERROR_REASONS.PROVIDER_UNREGISTERED,
      platformId: body.publicationKey.platformId,
    });
  }
  const capabilities: DistributionCapabilities = await provider.capabilities({ workspaceId: input.workspaceId, providerConnectionId: null });
  // 能力闸门按投递方式取值（P13-04）：DRAFT → UPLOAD_DRAFT；PUBLISH → DIRECT_PUBLISH
  const requiredCapability = body.deliveryMode === 'DRAFT' ? 'UPLOAD_DRAFT' : 'DIRECT_PUBLISH';
  if (!capabilities.capabilities.includes(requiredCapability)) {
    throw new ApiFailure(
      ERROR_CODES.VALIDATION_FAILED,
      `平台 ${body.publicationKey.platformId} 能力不含 ${requiredCapability}（tier=${capabilities.tier}）——能力分级与真实 capability 一致`,
      422,
      {
        reason: body.deliveryMode === 'DRAFT' ? PUBLICATION_ERROR_REASONS.DRAFT_NOT_SUPPORTED : PUBLICATION_ERROR_REASONS.CAPABILITY_MISSING,
        platformId: body.publicationKey.platformId,
        tier: capabilities.tier,
      },
    );
  }

  // 3) 幂等落库（唯一索引四元组；冲突 → 返回既有行）
  const now = new Date();
  const inserted = await deps.db
    .insert(publications)
    .values({
      id: `pub_${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      platformId: body.publicationKey.platformId,
      accountId: body.publicationKey.accountId,
      projectVersionId: body.publicationKey.projectVersionId,
      outputAssetId: body.publicationKey.outputAssetId,
      state: 'QUEUED',
      title: body.title,
      description: body.description ?? null,
      tags: body.tags,
      scheduledAt: body.scheduledAt === null ? null : new Date(body.scheduledAt),
      disclosure: body.disclosure ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  let row = inserted[0];
  if (row === undefined) {
    // 重复请求 → 只形成一个逻辑发布（返回既有行；不重发、不更新）
    const existing = await deps.db
      .select()
      .from(publications)
      .where(
        and(
          eq(publications.platformId, body.publicationKey.platformId),
          eq(publications.accountId, body.publicationKey.accountId),
          eq(publications.projectVersionId, body.publicationKey.projectVersionId),
          eq(publications.outputAssetId, body.publicationKey.outputAssetId),
        ),
      )
      .limit(1);
    const existingRow = existing[0];
    if (existingRow === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'publication idempotency read failed', 500);
    return { publication: toRecordDto(existingRow), deduped: true };
  }

  // 4) Provider validate（问题逐条返回，不静默）
  const validation: ValidationResult = await provider.validate(body);
  if (!validationResultSchema.parse(validation).ok) {
    await deps.db
      .update(publications)
      .set({ state: 'FAILED', lastError: `PROVIDER_VALIDATION_FAILED: ${validation.issues.map((issue) => issue.code).join(',')}`, updatedAt: new Date() })
      .where(eq(publications.id, row.id));
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'Provider validate 拒绝本次发布', 422, {
      reason: PUBLICATION_ERROR_REASONS.PROVIDER_VALIDATION_FAILED,
      issues: validation.issues,
      publicationId: row.id,
    });
  }

  // 5a) Send to Draft（P13-04 P3 路径）：uploadDraft → **状态记 DRAFT（不显示为 Published）**
  if (body.deliveryMode === 'DRAFT') {
    if (provider.uploadDraft === undefined) {
      throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'Provider 未实现 uploadDraft（能力分级声明与实现不一致）', 501, {
        reason: PUBLICATION_ERROR_REASONS.DRAFT_NOT_SUPPORTED,
      });
    }
    const draft = await provider.uploadDraft(body);
    const draftRows = await deps.db
      .update(publications)
      .set({
        state: 'DRAFT',
        remoteId: draft.transferId,
        remoteUrl: draft.openUrl,
        transferInstructions: draft.instructions,
        updatedAt: new Date(),
      })
      .where(eq(publications.id, row.id))
      .returning();
    const draftRow = draftRows[0];
    if (draftRow === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'draft publication update failed', 500);
    return { publication: toRecordDto(draftRow), deduped: false };
  }

  // 5) publish（失败 → FAILED + lastError；不自动重发）
  let published: { jobId: string; state: PublicationJob['state']; remoteId: string | null; remoteUrl: string | null };
  try {
    const job = await provider.publish?.(body);
    if (job === undefined) {
      throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'Provider 未实现 publish（能力分级声明与实现不一致）', 501, {
        reason: PUBLICATION_ERROR_REASONS.CAPABILITY_MISSING,
      });
    }
    published = { jobId: job.jobId, state: job.state, remoteId: job.remoteId ?? null, remoteUrl: job.remoteUrl ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.db
      .update(publications)
      .set({ state: 'FAILED', lastError: message.slice(0, 500), updatedAt: new Date() })
      .where(eq(publications.id, row.id));
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, `Provider publish 失败：${message.slice(0, 200)}`, 502, {
      reason: PUBLICATION_ERROR_REASONS.PROVIDER_PUBLISH_FAILED,
    });
  }

  // 6) 状态回填（PUBLISHED → 经 getStatus 对账补全 remoteId/remoteUrl/publishedAt；缺失则保留 publish 返回）
  const updates: Partial<typeof publications.$inferInsert> = { state: published.state, updatedAt: new Date() };
  if (published.state === 'PUBLISHED') {
    updates.remoteId = published.remoteId ?? published.jobId;
    updates.remoteUrl = published.remoteUrl;
    updates.publishedAt = new Date();
    if (provider.getStatus !== undefined) {
      const status = await provider.getStatus(updates.remoteId as string).catch(() => null);
      if (status !== null) {
        updates.remoteId = status.remoteId ?? updates.remoteId;
        updates.remoteUrl = status.remoteUrl ?? updates.remoteUrl;
        updates.publishedAt = status.publishedAt === null ? updates.publishedAt : new Date(status.publishedAt);
      }
    }
  }
  const finalRows = await deps.db.update(publications).set(updates).where(eq(publications.id, row.id)).returning();
  row = finalRows[0] ?? row;
  return { publication: toRecordDto(row), deduped: false };
}

/**
 * 对账（结果未知时先查询；以 Provider getStatus 为准回填状态——**绝不自动重发**）。
 */
export async function reconcilePublication(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; publicationId: string },
): Promise<PublicationRecord> {
  const current = await getPublication(deps, input);
  const provider = requireProviders(deps).find((candidate) => candidate.providerId === current.platformId);
  if (provider === undefined || provider.getStatus === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '对账不可用（Provider 未实现 getStatus）', 422, {
      reason: PUBLICATION_ERROR_REASONS.RECONCILE_UNAVAILABLE,
      publicationId: current.id,
    });
  }
  let remoteId = current.remoteId;
  if (remoteId === null && provider.findByPublicationKey !== undefined) {
    // 超时恢复（P13-02）：无远端引用 → 按幂等键回查远端——命中即采纳（不重复创建、不重发）
    const found = await provider.findByPublicationKey({
      platformId: current.platformId,
      accountId: current.accountId,
      projectVersionId: current.projectVersionId,
      outputAssetId: current.outputAssetId,
    });
    if (found === null) {
      throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '对账不可用（无远端引用且按幂等键未回查到远端发布）', 422, {
        reason: PUBLICATION_ERROR_REASONS.RECONCILE_UNAVAILABLE,
        publicationId: current.id,
      });
    }
    remoteId = found.remoteId;
  }
  if (remoteId === null) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '对账不可用（无远端引用）', 422, {
      reason: PUBLICATION_ERROR_REASONS.RECONCILE_UNAVAILABLE,
      publicationId: current.id,
    });
  }
  const status = await provider.getStatus(remoteId);
  const updates: Partial<typeof publications.$inferInsert> = {
    state: status.state,
    remoteId: status.remoteId ?? current.remoteId,
    remoteUrl: status.remoteUrl ?? current.remoteUrl,
    publishedAt:
      status.publishedAt === null
        ? current.publishedAt === null
          ? null
          : new Date(current.publishedAt)
        : new Date(status.publishedAt),
    updatedAt: new Date(),
  };
  const updated = await deps.db.update(publications).set(updates).where(eq(publications.id, current.id)).returning();
  const row = updated[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'publication reconcile failed', 500);
  return toRecordDto(row);
}

/** 未发布（QUEUED 且无远端引用）的发布不会出现在对外查询中——保留内部状态查询路径。 */
export async function listPendingPublications(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<PublicationRecord[]> {
  const rows = await deps.db
    .select()
    .from(publications)
    .where(
      and(
        eq(publications.workspaceId, input.workspaceId),
        eq(publications.projectId, input.projectId),
        isNull(publications.publishedAt),
      ),
    )
    .orderBy(desc(publications.createdAt));
  return rows.map(toRecordDto);
}
