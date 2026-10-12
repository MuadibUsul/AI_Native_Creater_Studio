import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  PREVIEW_ERROR_REASONS,
  PREVIEW_RENDER_JOB_TYPE,
  editOperationSchema,
  finalRenderProfileSchema,
  renderPlanSchema,
  requestSequencePreviewSchema,
  sequencePreviewSchema,
  type FinalRenderProfile,
  type RenderPlan,
  type RequestSequencePreview,
  type SequencePreview,
} from '@ancs/contracts';
import { assetVersions, mediaDerivatives, previewSegments, projectSequences, projects, sequencePreviews } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { processEdits } from './edits.js';
import { createJobInTx } from './jobs.js';
import { compileSequenceRenderPlan } from './playback.js';
import { loadProposalForRead } from './proposals.js';

/**
 * 低清预览（V6 §7.4，改哪里渲染哪里）。
 *
 * - 请求：编译当前版本或提案（事务内试改后回滚，工程不变）的 RenderPlan，冻结进预览行并排队 PREVIEW_RENDER；
 *   同一序列 + 同一计划哈希的预览只渲一次（采用刚预览过的提案时直接命中）；
 * - 渲染（Worker）：画面按时间窗切片、按内容哈希查缓存，只渲变化的窗口；声音整条渲；流复制拼接；
 * - 读取：READY 返回短期签名地址（不是永久文件地址）与浏览器叠加用的字幕。
 */

type PreviewRow = typeof sequencePreviews.$inferSelect;

/** 预览档位：540p 级、快速编码；画幅随工程。 */
export function previewProfileFor(aspectRatio: string): FinalRenderProfile {
  const size = ((): { width: number; height: number } => {
    switch (aspectRatio) {
      case '9:16': return { width: 540, height: 960 };
      case '1:1': return { width: 720, height: 720 };
      case '4:5': return { width: 576, height: 720 };
      case '4:3': return { width: 720, height: 540 };
      default: return { width: 960, height: 540 };
    }
  })();
  return finalRenderProfileSchema.parse({ ...size, videoCrf: 30, audioBitrateKbps: 96, captionDelivery: 'SIDECAR', encoderPreset: 'veryfast' });
}

/** 提案的试改计划：在事务里真执行提案操作后编译，再无条件回滚（工程零变更）。 */
export async function compileProposalRenderPlan(deps: DomainDeps, input: { workspaceId: string; projectId: string; sequenceId: string; proposalId: string; actorId: string }): Promise<RenderPlan> {
  const proposal = await loadProposalForRead(deps, input);
  if (proposal.status !== 'OPEN') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'only open proposals can be previewed', 409, { reason: PREVIEW_ERROR_REASONS.PROPOSAL_STALE, status: proposal.status });
  }
  class Rollback extends Error {
    constructor(readonly plan: RenderPlan) { super('preview-rollback'); }
  }
  try {
    await deps.db.transaction(async (tx) => {
      const scoped: DomainDeps = { ...deps, db: tx };
      await processEdits(scoped, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actor: { type: 'USER', id: input.actorId },
        request: {
          schemaVersion: '1.0',
          baseProjectRevision: proposal.baseProjectRevision,
          expectedSceneRevisions: {},
          operations: editOperationSchema.array().parse(proposal.operations),
          idempotencyKey: `preview_${randomUUID()}`,
        },
      });
      throw new Rollback(await compileSequenceRenderPlan(scoped, input));
    });
  } catch (error) {
    if (error instanceof Rollback) return error.plan;
    if (error instanceof ApiFailure && error.code === ERROR_CODES.VERSION_CONFLICT) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'the project changed after this proposal was made', 409, { reason: PREVIEW_ERROR_REASONS.PROPOSAL_STALE });
    }
    throw error;
  }
  throw new ApiFailure(ERROR_CODES.INTERNAL, 'proposal preview did not roll back', 500);
}

async function toPreview(deps: DomainDeps, row: PreviewRow): Promise<SequencePreview> {
  const plan = renderPlanSchema.parse(row.plan);
  const profile = finalRenderProfileSchema.parse(row.profile);
  let playbackUrl: string | null = null;
  if (row.status === 'READY' && row.storageKey !== null && deps.storage !== undefined) {
    playbackUrl = (await deps.storage.createDownloadUrl({ key: row.storageKey, ttlSeconds: 3600 })).url;
  }
  return sequencePreviewSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sequenceId: row.sequenceId,
    source: row.source,
    projectRevision: row.projectRevision,
    proposalId: row.proposalId,
    planHash: row.planHash,
    status: row.status,
    width: profile.width,
    height: profile.height,
    frameRate: plan.frameRate,
    duration: plan.duration,
    captions: plan.captions,
    playbackUrl,
    segments: { total: row.segmentsTotal, reused: row.segmentsReused, rendered: row.segmentsRendered },
    renderMs: row.renderMs,
    error: row.error as Record<string, unknown> | null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

export async function requestSequencePreview(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
  request: RequestSequencePreview;
  createdBy?: string | null;
}): Promise<SequencePreview> {
  const request = requestSequencePreviewSchema.parse(input.request);
  const projectRows = await deps.db.select({ revision: projects.revision, aspectRatio: projects.aspectRatio }).from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId), isNull(projects.deletedAt))).limit(1);
  const project = projectRows[0];
  if (project === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  const sequence = await deps.db.select({ id: projectSequences.id }).from(projectSequences).where(and(
    eq(projectSequences.id, input.sequenceId), eq(projectSequences.workspaceId, input.workspaceId), eq(projectSequences.projectId, input.projectId),
  )).limit(1);
  if (sequence[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);

  const plan = request.proposalId === null
    ? await compileSequenceRenderPlan(deps, input)
    : await compileProposalRenderPlan(deps, { ...input, proposalId: request.proposalId, actorId: input.createdBy ?? 'preview' });
  const profile = previewProfileFor(project.aspectRatio);

  const findActive = async (): Promise<PreviewRow | undefined> => (await deps.db.select().from(sequencePreviews).where(and(
    eq(sequencePreviews.workspaceId, input.workspaceId),
    eq(sequencePreviews.sequenceId, input.sequenceId),
    eq(sequencePreviews.planHash, plan.planHash),
    inArray(sequencePreviews.status, ['QUEUED', 'RENDERING', 'READY']),
  )).limit(1))[0];
  const existing = await findActive();
  if (existing !== undefined) return toPreview(deps, existing);

  const previewId = `prv_${randomUUID()}`;
  const inserted = await deps.db.transaction(async (tx) => {
    const rows = await tx.insert(sequencePreviews).values({
      id: previewId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      sequenceId: input.sequenceId,
      source: request.proposalId === null ? 'REVISION' : 'PROPOSAL',
      projectRevision: request.proposalId === null ? project.revision : plan.documentRevision,
      proposalId: request.proposalId,
      planHash: plan.planHash,
      plan,
      profile,
      createdBy: input.createdBy ?? null,
    }).onConflictDoNothing().returning();
    const row = rows[0];
    if (row === undefined) return null;
    // 预览是交互等待：高优先级；渲染失败不自动无限重试（maxAttempts 2：一次重试覆盖瞬时故障）
    const job = await createJobInTx(tx, { workspaceId: input.workspaceId, projectId: input.projectId, type: PREVIEW_RENDER_JOB_TYPE, input: { previewId }, priority: 100, maxAttempts: 2, createdBy: input.createdBy ?? null });
    const [withJob] = await tx.update(sequencePreviews).set({ jobId: job.id }).where(eq(sequencePreviews.id, previewId)).returning();
    return withJob ?? row;
  });
  if (inserted !== null) return toPreview(deps, inserted);
  const raced = await findActive();
  if (raced === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'preview request conflicted but no active preview was found', 500);
  return toPreview(deps, raced);
}

export async function getSequencePreview(deps: DomainDeps, input: { workspaceId: string; previewId: string }): Promise<SequencePreview> {
  const rows = await deps.db.select().from(sequencePreviews).where(and(eq(sequencePreviews.id, input.previewId), eq(sequencePreviews.workspaceId, input.workspaceId))).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'preview not found', 404, { reason: PREVIEW_ERROR_REASONS.NOT_FOUND });
  return toPreview(deps, row);
}

export async function latestSequencePreview(deps: DomainDeps, input: { workspaceId: string; sequenceId: string }): Promise<SequencePreview | null> {
  const rows = await deps.db.select().from(sequencePreviews)
    .where(and(eq(sequencePreviews.workspaceId, input.workspaceId), eq(sequencePreviews.sequenceId, input.sequenceId), eq(sequencePreviews.source, 'REVISION')))
    .orderBy(desc(sequencePreviews.createdAt)).limit(1);
  return rows[0] === undefined ? null : toPreview(deps, rows[0]);
}

// ── Worker 侧 ────────────────────────────────────────────

export interface PreviewRenderTask {
  id: string;
  workspaceId: string;
  projectId: string;
  status: string;
  plan: RenderPlan;
  profile: FinalRenderProfile;
}

export async function beginPreviewRender(deps: DomainDeps, input: { workspaceId: string; previewId: string }): Promise<PreviewRenderTask | null> {
  const rows = await deps.db.update(sequencePreviews).set({ status: 'RENDERING' })
    .where(and(eq(sequencePreviews.id, input.previewId), eq(sequencePreviews.workspaceId, input.workspaceId), inArray(sequencePreviews.status, ['QUEUED', 'RENDERING'])))
    .returning();
  const row = rows[0];
  if (row === undefined) return null;
  return { id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, status: row.status, plan: renderPlanSchema.parse(row.plan), profile: finalRenderProfileSchema.parse(row.profile) };
}

/**
 * 预览用的源文件：优先已就绪的低清代理（时长与时间轴同原件，解码快），否则用原件。
 * 只解析本工作区内 READY 的源版本；缺失的 id 不出现在结果里（由渲染方明确失败）。
 */
export async function resolvePreviewSourceKeys(deps: DomainDeps, input: { workspaceId: string; assetVersionIds: readonly string[] }): Promise<Map<string, string>> {
  if (input.assetVersionIds.length === 0) return new Map();
  const originals = await deps.db.select({ id: assetVersions.id, storageKey: assetVersions.storageKey }).from(assetVersions)
    .where(and(eq(assetVersions.workspaceId, input.workspaceId), inArray(assetVersions.id, [...input.assetVersionIds]), eq(assetVersions.status, 'READY')));
  const result = new Map(originals.map((row) => [row.id, row.storageKey]));
  const proxies = await deps.db.select({ sourceId: mediaDerivatives.sourceAssetVersionId, storageKey: assetVersions.storageKey }).from(mediaDerivatives)
    .innerJoin(assetVersions, eq(assetVersions.id, mediaDerivatives.derivativeAssetVersionId))
    .where(and(
      eq(mediaDerivatives.workspaceId, input.workspaceId),
      inArray(mediaDerivatives.sourceAssetVersionId, [...input.assetVersionIds]),
      eq(mediaDerivatives.kind, 'PROXY'),
      eq(mediaDerivatives.status, 'READY'),
    ));
  for (const proxy of proxies) if (result.has(proxy.sourceId)) result.set(proxy.sourceId, proxy.storageKey);
  return result;
}

/** 查缓存片段（命中时刷新最近使用时间）。 */
export async function findPreviewSegment(deps: DomainDeps, input: { workspaceId: string; kind: 'VIDEO' | 'AUDIO'; cacheKey: string }): Promise<{ storageKey: string } | null> {
  const rows = await deps.db.update(previewSegments).set({ lastUsedAt: new Date() })
    .where(and(eq(previewSegments.workspaceId, input.workspaceId), eq(previewSegments.kind, input.kind), eq(previewSegments.cacheKey, input.cacheKey)))
    .returning({ storageKey: previewSegments.storageKey });
  return rows[0] ?? null;
}

export async function recordPreviewSegment(deps: DomainDeps, input: { workspaceId: string; kind: 'VIDEO' | 'AUDIO'; cacheKey: string; storageKey: string; sizeBytes: number }): Promise<void> {
  await deps.db.insert(previewSegments).values({ id: `pvs_${randomUUID()}`, ...input }).onConflictDoNothing();
}

export async function completePreviewRender(deps: DomainDeps, input: { workspaceId: string; previewId: string; storageKey: string; total: number; reused: number; rendered: number; renderMs: number }): Promise<void> {
  await deps.db.update(sequencePreviews).set({
    status: 'READY', storageKey: input.storageKey, segmentsTotal: input.total, segmentsReused: input.reused, segmentsRendered: input.rendered,
    renderMs: input.renderMs, error: null, completedAt: new Date(),
  }).where(and(eq(sequencePreviews.id, input.previewId), eq(sequencePreviews.workspaceId, input.workspaceId)));
}

export async function failPreviewRender(deps: DomainDeps, input: { workspaceId: string; previewId: string; error: Record<string, unknown> }): Promise<void> {
  await deps.db.update(sequencePreviews).set({ status: 'FAILED', error: input.error, completedAt: new Date() })
    .where(and(eq(sequencePreviews.id, input.previewId), eq(sequencePreviews.workspaceId, input.workspaceId), sql`${sequencePreviews.status} <> 'READY'`));
}
