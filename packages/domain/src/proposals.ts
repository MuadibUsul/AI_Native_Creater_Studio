import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  PROPOSAL_ERROR_REASONS,
  editOperationSchema,
  mediaTimeToLegacyMilliseconds,
  mediaRangeSchema,
  proposalSchema,
  proposalTrialSchema,
  selectionFingerprintInput,
  type CreateProposalRequest,
  type EditOperation,
  type Proposal,
  type ProposalTrial,
} from '@ancs/contracts';
import { editEvents, projects, proposalTrials, proposals, sequenceClips, selectionAnchors } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { processEdits } from './edits.js';

/**
 * N06-01／N06-02／N06-04：私有候选 → 确定性试改 → 原子采用。
 *
 * - `createProposalBranch` 只存操作集与绑定，**不改工程**；
 * - `previewProposal` 用**真实执行器在事务内跑一遍再回滚**（不是近似动画、不是第二套模拟器），
 *   因此"同一操作集 → 同一结果"，且 `projectUntouched` 是结构性保证；
 * - `adoptProposal` 做**采用绑定校验**（base revision／操作哈希／锚点指纹／意图修订），
 *   通过统一编辑协议**原子**执行；失败时确认版保持完整且不显示"已采用"；
 * - 幂等：采用使用调用方幂等键，重放返回同一结果（不产生第二次写入）。
 */

const canonicalOperations = (operations: readonly EditOperation[]): string =>
  JSON.stringify(operations.map((operation) => JSON.parse(JSON.stringify(operation)) as unknown));

const hashOperations = (operations: readonly EditOperation[]): string =>
  createHash('sha256').update(canonicalOperations(operations)).digest('hex');

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * N06-04：试片缓存依赖键。覆盖 base revision + 操作哈希 + 选择指纹 + 意图修订 + **素材版本签名**——
 * 任一依赖变化（含片段换源）都会得到不同的键，从而自然失效，不返回陈旧试片。
 */
async function computeTrialDependencies(deps: DomainDeps, row: typeof proposals.$inferSelect): Promise<{ dependencyKey: string; assetVersionSignature: string }> {
  const clips = await deps.db.select({ id: sequenceClips.id, assetVersionId: sequenceClips.assetVersionId }).from(sequenceClips).where(and(
    eq(sequenceClips.workspaceId, row.workspaceId), eq(sequenceClips.projectId, row.projectId),
  ));
  const assetVersionSignature = sha256(clips.map((clip) => `${clip.id}:${clip.assetVersionId ?? 'null'}`).sort().join('|'));
  const dependencyKey = sha256(JSON.stringify({
    baseProjectRevision: row.baseProjectRevision,
    operationsHash: row.operationsHash,
    selectionFingerprint: row.selectionFingerprint ?? null,
    intentRevisionId: row.intentRevisionId ?? null,
    assetVersionSignature,
  }));
  return { dependencyKey, assetVersionSignature };
}

async function loadCachedTrial(deps: DomainDeps, row: typeof proposals.$inferSelect, dependencyKey: string): Promise<ProposalTrial | null> {
  const rows = await deps.db.select().from(proposalTrials).where(and(
    eq(proposalTrials.workspaceId, row.workspaceId),
    eq(proposalTrials.projectId, row.projectId),
    eq(proposalTrials.dependencyKey, dependencyKey),
  )).limit(1);
  const cached = rows[0];
  if (!cached) return null;
  return proposalTrialSchema.parse({ ...proposalTrialSchema.parse(cached.trial), proposalId: row.id, cached: true, dependencyKey });
}

async function storeTrial(deps: DomainDeps, row: typeof proposals.$inferSelect, input: { dependencyKey: string; assetVersionSignature: string; trial: ProposalTrial }): Promise<void> {
  const stored = proposalTrialSchema.parse({ ...input.trial, proposalId: row.id, cached: false, dependencyKey: input.dependencyKey });
  const now = new Date();
  await deps.db.insert(proposalTrials).values({
    dependencyKey: input.dependencyKey,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    proposalId: row.id,
    baseProjectRevision: row.baseProjectRevision,
    operationsHash: row.operationsHash,
    selectionFingerprint: row.selectionFingerprint ?? null,
    intentRevisionId: row.intentRevisionId ?? null,
    assetVersionSignature: input.assetVersionSignature,
    trial: stored,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [proposalTrials.workspaceId, proposalTrials.projectId, proposalTrials.dependencyKey],
    set: { proposalId: row.id, trial: stored, updatedAt: now },
  });
}

/** N06-04：显式依赖失效（如素材版本变化后主动清理）。返回删除的缓存行数。 */
export async function invalidateProposalTrials(deps: DomainDeps, input: { workspaceId: string; projectId: string; dependencyKey?: string }): Promise<number> {
  const condition = input.dependencyKey === undefined
    ? and(eq(proposalTrials.workspaceId, input.workspaceId), eq(proposalTrials.projectId, input.projectId))
    : and(eq(proposalTrials.workspaceId, input.workspaceId), eq(proposalTrials.projectId, input.projectId), eq(proposalTrials.dependencyKey, input.dependencyKey));
  const deleted = await deps.db.delete(proposalTrials).where(condition).returning({ dependencyKey: proposalTrials.dependencyKey });
  return deleted.length;
}

/** 候选采用/丢弃后清理其缓存行（键失效为主，这里是容量与归属清理）。 */
async function invalidateProposalTrialRows(deps: DomainDeps, row: typeof proposals.$inferSelect): Promise<void> {
  await deps.db.delete(proposalTrials).where(and(
    eq(proposalTrials.workspaceId, row.workspaceId),
    eq(proposalTrials.projectId, row.projectId),
    eq(proposalTrials.proposalId, row.id),
  ));
}

const toProposal = (row: typeof proposals.$inferSelect): Proposal => proposalSchema.parse({
  proposalId: row.id,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  baseProjectRevision: row.baseProjectRevision,
  selectionAnchorId: row.selectionAnchorId ?? null,
  selectionFingerprint: row.selectionFingerprint ?? null,
  intentRevisionId: row.intentRevisionId ?? null,
  operationsHash: row.operationsHash,
  operations: row.operations,
  status: row.status,
  committedRevision: row.committedRevision ?? null,
  createdAt: row.createdAt.toISOString(),
  committedAt: row.committedAt === null ? null : row.committedAt.toISOString(),
  discardedAt: row.discardedAt === null ? null : row.discardedAt.toISOString(),
});

const loadProposalRow = async (deps: DomainDeps, input: { workspaceId: string; projectId: string; proposalId: string }) => {
  const rows = await deps.db.select().from(proposals).where(and(
    eq(proposals.id, input.proposalId),
    eq(proposals.workspaceId, input.workspaceId),
    eq(proposals.projectId, input.projectId),
  )).limit(1);
  const row = rows[0];
  if (!row) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'proposal not found', 404, { reason: PROPOSAL_ERROR_REASONS.NOT_FOUND });
  }
  return row;
};

const loadProjectRevision = async (deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<number> => {
  const rows = await deps.db.select({ revision: projects.revision }).from(projects).where(and(
    eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId),
  )).limit(1);
  const revision = rows[0]?.revision;
  if (revision === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  }
  return revision;
};

export async function createProposalBranch(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  actorId?: string;
  request: CreateProposalRequest;
}): Promise<Proposal> {
  const currentRevision = await loadProjectRevision(deps, input);
  if (input.request.baseProjectRevision !== currentRevision) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proposal base revision is stale', 409, {
      reason: PROPOSAL_ERROR_REASONS.STALE_BASE, currentRevision, baseProjectRevision: input.request.baseProjectRevision,
    });
  }
  const operations = input.request.operations.map((operation) => editOperationSchema.parse(operation));
  let selectionFingerprint: string | null = null;
  if (input.request.selectionAnchorId !== null) {
    const rows = await deps.db.select().from(selectionAnchors).where(and(
      eq(selectionAnchors.id, input.request.selectionAnchorId),
      eq(selectionAnchors.workspaceId, input.workspaceId),
      eq(selectionAnchors.projectId, input.projectId),
    )).orderBy(desc(selectionAnchors.revision)).limit(1);
    const anchorRow = rows[0];
    if (!anchorRow) {
      throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'selection anchor not found', 404, { reason: PROPOSAL_ERROR_REASONS.FINGERPRINT_MISMATCH });
    }
    selectionFingerprint = anchorRow.fingerprint;
  }
  const proposalId = `prop_${randomUUID()}`;
  const now = new Date();
  await deps.db.insert(proposals).values({
    id: proposalId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actorId: input.actorId ?? null,
    baseProjectRevision: currentRevision,
    selectionAnchorId: input.request.selectionAnchorId,
    selectionFingerprint,
    intentRevisionId: input.request.intentRevisionId,
    operationsHash: hashOperations(operations),
    operations,
    status: 'OPEN',
    createdAt: now,
    updatedAt: now,
  });
  return toProposal(await loadProposalRow(deps, { ...input, proposalId }));
}

/**
 * 确定性试改：在**事务内**用真实执行器跑一遍完整操作集，然后**无条件回滚**。
 * 因此结果与正式采用完全一致，而工程零变更（不与"预览即预测"混淆：这里跑的是权威路径）。
 */
export async function previewProposal(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  proposalId: string;
  actorId?: string;
}): Promise<ProposalTrial> {
  const row = await loadProposalRow(deps, input);
  if (row.status !== 'OPEN') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proposal is not open', 409, {
      reason: row.status === 'SUPERSEDED' ? PROPOSAL_ERROR_REASONS.SUPERSEDED : PROPOSAL_ERROR_REASONS.NOT_OPEN, status: row.status,
    });
  }
  // N06-04：先查局部试片缓存；依赖键一致则直接复用确定性结果（不重复跑执行器）。
  const { dependencyKey, assetVersionSignature } = await computeTrialDependencies(deps, row);
  const cachedTrial = await loadCachedTrial(deps, row, dependencyKey);
  if (cachedTrial !== null) return cachedTrial;

  const operations = editOperationSchema.array().parse(row.operations);
  const eventsBefore = await deps.db.select({ seq: editEvents.seq }).from(editEvents).where(eq(editEvents.projectId, input.projectId));
  const maxSeqBefore = eventsBefore.reduce((max, event) => Math.max(max, event.seq), 0);

  class RollbackSentinel extends Error {
    constructor(readonly trial: ProposalTrial) {
      super('trial-rollback');
    }
  }

  try {
    await deps.db.transaction(async (tx) => {
      const result = await processEdits({ ...deps, db: tx }, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actor: { type: 'USER', id: input.actorId ?? 'proposal-trial' },
        request: {
          schemaVersion: '1.0',
          baseProjectRevision: row.baseProjectRevision,
          expectedSceneRevisions: {},
          operations,
          idempotencyKey: `trial_${randomUUID()}`,
        },
      });
      const clips = await tx.select().from(sequenceClips).where(and(
        eq(sequenceClips.workspaceId, input.workspaceId), eq(sequenceClips.projectId, input.projectId),
      ));
      const trial = proposalTrialSchema.parse({
        proposalId: row.id,
        operationsHash: row.operationsHash,
        trialRevision: result.response.project.revision,
        events: result.response.editEvents.map((event) => ({
          action: event.action,
          objectKind: event.objectKind ?? null,
          objectId: event.objectId ?? null,
          summary: typeof event.patch['op'] === 'string' ? String(event.patch['op']) : '',
        })),
        clipRanges: clips.map((clip) => {
          const sequenceRange = mediaRangeSchema.parse(clip.sequenceRange);
          const sourceRange = mediaRangeSchema.parse(clip.sourceRange);
          return {
            clipId: clip.id,
            trackId: clip.trackId,
            sequenceStartMs: mediaTimeToLegacyMilliseconds(sequenceRange.start),
            sequenceEndMs: mediaTimeToLegacyMilliseconds(sequenceRange.end),
            sourceStartMs: mediaTimeToLegacyMilliseconds(sourceRange.start),
            sourceEndMs: mediaTimeToLegacyMilliseconds(sourceRange.end),
          };
        }),
        projectUntouched: true,
      });
      // 无条件回滚：试改绝不落地
      throw new RollbackSentinel(trial);
    });
  } catch (error) {
    if (error instanceof RollbackSentinel) {
      await storeTrial(deps, row, { dependencyKey, assetVersionSignature, trial: error.trial });
      return proposalTrialSchema.parse({ ...error.trial, proposalId: row.id, cached: false, dependencyKey });
    }
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'proposal trial failed', 422, {
      reason: PROPOSAL_ERROR_REASONS.TRIAL_FAILED,
      cause: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    });
  }
  // 事务未被回滚是不可能的（上面必然 throw）；保守 fail-closed
  const maxSeqAfter = (await deps.db.select({ seq: editEvents.seq }).from(editEvents).where(eq(editEvents.projectId, input.projectId)))
    .reduce((max, event) => Math.max(max, event.seq), maxSeqBefore);
  throw new ApiFailure(ERROR_CODES.INTERNAL, `proposal trial did not roll back (seq ${String(maxSeqBefore)}→${String(maxSeqAfter)})`, 500, {
    reason: PROPOSAL_ERROR_REASONS.TRIAL_FAILED,
  });
}

/** 原子采用：绑定校验 → 统一编辑协议原子执行 → 候选标记 COMMITTED。 */
export async function adoptProposal(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  proposalId: string;
  actorId?: string;
  expectedOperationsHash: string;
  expectedSelectionFingerprint: string | null;
  idempotencyKey: string;
}): Promise<{ proposal: Proposal; projectRevision: number }> {
  const row = await loadProposalRow(deps, input);
  // 幂等：同一幂等键重放返回同一结果（不产生第二次写入）
  if (row.status === 'COMMITTED') {
    if (row.adoptionIdempotencyKey === input.idempotencyKey) {
      return { proposal: toProposal(row), projectRevision: row.committedRevision ?? row.baseProjectRevision };
    }
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proposal has already been committed', 409, { reason: PROPOSAL_ERROR_REASONS.NOT_OPEN });
  }
  if (row.status === 'DISCARDED' || row.status === 'SUPERSEDED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proposal can no longer be adopted', 409, {
      reason: row.status === 'SUPERSEDED' ? PROPOSAL_ERROR_REASONS.SUPERSEDED : PROPOSAL_ERROR_REASONS.NOT_OPEN, status: row.status,
    });
  }
  if (input.expectedOperationsHash !== row.operationsHash) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proposal operations changed since the user reviewed it', 409, {
      reason: PROPOSAL_ERROR_REASONS.HASH_MISMATCH, expected: input.expectedOperationsHash, actual: row.operationsHash,
    });
  }
  if (row.selectionAnchorId !== null) {
    const rows = await deps.db.select().from(selectionAnchors).where(and(
      eq(selectionAnchors.id, row.selectionAnchorId),
      eq(selectionAnchors.workspaceId, input.workspaceId),
      eq(selectionAnchors.projectId, input.projectId),
    )).orderBy(desc(selectionAnchors.revision)).limit(1);
    const anchorRow = rows[0];
    const currentFingerprint = anchorRow === undefined
      ? null
      : createHash('sha256').update(selectionFingerprintInput(anchorRow.anchor as never)).digest('hex');
    if (input.expectedSelectionFingerprint !== row.selectionFingerprint || currentFingerprint !== row.selectionFingerprint) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'selection changed since the proposal was created', 409, {
        reason: PROPOSAL_ERROR_REASONS.FINGERPRINT_MISMATCH,
        expected: row.selectionFingerprint,
        received: input.expectedSelectionFingerprint,
        current: currentFingerprint,
      });
    }
  }
  const currentRevision = await loadProjectRevision(deps, input);
  if (currentRevision !== row.baseProjectRevision) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'project changed since the proposal was created', 409, {
      reason: PROPOSAL_ERROR_REASONS.STALE_BASE, currentRevision, baseProjectRevision: row.baseProjectRevision,
    });
  }
  const operations = editOperationSchema.array().parse(row.operations);
  const result = await processEdits(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actor: { type: 'USER', id: input.actorId ?? 'proposal-adopt' },
    request: {
      schemaVersion: '1.0',
      baseProjectRevision: row.baseProjectRevision,
      expectedSceneRevisions: {},
      operations,
      idempotencyKey: input.idempotencyKey,
    },
  });
  const now = new Date();
  await deps.db.update(proposals).set({
    status: 'COMMITTED',
    committedRevision: result.response.project.revision,
    adoptionIdempotencyKey: input.idempotencyKey,
    committedAt: now,
    updatedAt: now,
  }).where(eq(proposals.id, row.id));
  await invalidateProposalTrialRows(deps, row);
  const updated = await loadProposalRow(deps, input);
  return { proposal: toProposal(updated), projectRevision: result.response.project.revision };
}

/** 只读读取候选（GET 路径，不触发试改/采用）。 */
export async function loadProposalForRead(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  proposalId: string;
}): Promise<Proposal> {
  return toProposal(await loadProposalRow(deps, input));
}

/** 丢弃候选（晚到/过期候选只能被丢弃或取代，不得更新新候选）。 */
export async function discardProposal(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  proposalId: string;
  reason?: string;
}): Promise<Proposal> {
  const row = await loadProposalRow(deps, input);
  if (row.status === 'DISCARDED') return toProposal(row);
  if (row.status === 'COMMITTED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'committed proposal cannot be discarded', 409, { reason: PROPOSAL_ERROR_REASONS.NOT_OPEN });
  }
  const now = new Date();
  await deps.db.update(proposals).set({ status: 'DISCARDED', discardedAt: now, updatedAt: now }).where(eq(proposals.id, row.id));
  await invalidateProposalTrialRows(deps, row);
  return toProposal(await loadProposalRow(deps, input));
}

/** 同一选区/意图的新候选取代旧候选（旧候选只能被丢弃或标记 SUPERSEDED）。 */
export async function supersedeProposals(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  intentRevisionId: string;
  keepProposalId: string;
}): Promise<number> {
  const rows = await deps.db.select().from(proposals).where(and(
    eq(proposals.workspaceId, input.workspaceId),
    eq(proposals.projectId, input.projectId),
    eq(proposals.intentRevisionId, input.intentRevisionId),
    eq(proposals.status, 'OPEN'),
  ));
  let superseded = 0;
  for (const row of rows) {
    if (row.id === input.keepProposalId) continue;
    await deps.db.update(proposals).set({ status: 'SUPERSEDED', updatedAt: new Date() }).where(eq(proposals.id, row.id));
    superseded += 1;
  }
  return superseded;
}
