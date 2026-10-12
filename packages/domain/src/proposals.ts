import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import {
  ApiFailure,
  EDIT_OPERATION_REGISTRY,
  ERROR_CODES,
  OBJECT_LOCK_DIMENSIONS,
  PROPOSAL_ERROR_REASONS,
  PROPOSAL_REVIEW_BLOCK_REASONS,
  computeOperationTargetRefs,
  editOperationSchema,
  isEditOperationName,
  isObjectLockKind,
  mediaTimeToDisplayMilliseconds,
  mediaRangeSchema,
  proposalImpactSchema,
  proposalArtifactSchema,
  proposalSchema,
  proposalTargetRefSchema,
  proposalTrialSchema,
  selectionFingerprintInput,
  targetRefsIntersect,
  type CreateProposalRequest,
  type EditOperation,
  type EditTargetRef,
  type Proposal,
  type ProposalArtifact,
  type ProposalArtifactBindingReason,
  type ProposalImpact,
  type ProposalImpactConflict,
  type ProposalInterveningChange,
  type ProposalReviewBlockReason,
  type ProposalTargetRef,
  type ProposalTrial,
  type SubmitProposalArtifactRequest,
} from '@ancs/contracts';
import { editEvents, projects, proposalArtifacts, proposalTrials, proposals, sequenceClips, selectionAnchors } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { assertProtectedContentStable, type ClipDigests, clipDigestsOf } from './content-protection.js';
import { processEdits } from './edits.js';
import { runEditTrial, type EditTrialOutcome } from './edit-trial.js';

/**
 * N06-01／N06-02／N06-04／N06-03：私有候选 → 确定性试改 → 原子采用 → 影响集与受控 rebase。
 *
 * - `createProposalBranch` 只存操作集与绑定，**不改工程**（N06-03 起同时**记录**字段读写集与具体写目标）；
 * - `previewProposal` 经试改引擎执行（V5-M2）：内核操作在**同一编辑内核**中内存执行（不写库、不取锁），
 *   其他操作在事务内跑真实执行器再回滚；不是近似动画、不是第二套规则，
 *   因此"同一操作集 → 同一结果"，且 `projectUntouched` 是结构性保证；
 * - `adoptProposal` 做**采用绑定校验**（base revision／操作哈希／锚点指纹／意图修订），
 *   通过统一编辑协议**原子**执行；失败时确认版保持完整且不显示"已采用"；
 * - `computeProposalImpact` 给出候选写目标与 base revision 之后干预改动的**竞争**（同对象同维度）；
 *   非冲突才允许 `rebaseProposal` 受控推进 base revision（仍经真实执行器验证），
 *   身份/源素材变化一律要求**重新审核**，绝不以最新 revision 强覆盖；
 * - 幂等：采用使用调用方幂等键，重放返回同一结果（不产生第二次写入）。
 */

const canonicalOperations = (operations: readonly EditOperation[]): string =>
  JSON.stringify(operations.map((operation) => JSON.parse(JSON.stringify(operation)) as unknown));

const hashOperations = (operations: readonly EditOperation[]): string =>
  createHash('sha256').update(canonicalOperations(operations)).digest('hex');

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** N06-04：试片缓存 TTL（小时）与每工程容量上限（可由 `deps.retention` 覆盖，便于测试）。 */
export const PROPOSAL_TRIAL_TTL_HOURS = 24;
export const PROPOSAL_TRIAL_MAX_PER_PROJECT = 50;
const trialTtlHours = (deps: DomainDeps): number => deps.retention?.proposalTrialTtlHours ?? PROPOSAL_TRIAL_TTL_HOURS;
const trialMaxPerProject = (deps: DomainDeps): number => deps.retention?.proposalTrialMaxPerProject ?? PROPOSAL_TRIAL_MAX_PER_PROJECT;
const trialTtlCutoff = (deps: DomainDeps, now: Date = new Date()): Date => new Date(now.getTime() - trialTtlHours(deps) * 60 * 60 * 1000);

/** N06-03：操作集 → 具体写目标（对象级 + 维度 + 来源操作下标）。纯函数，与编辑执行器同源。 */
function computeWriteTargets(operations: readonly EditOperation[], projectId: string): ProposalTargetRef[] {
  const targets: ProposalTargetRef[] = [];
  operations.forEach((operation, operationIndex) => {
    for (const target of computeOperationTargetRefs(operation as unknown as Record<string, unknown>, { projectId })) {
      targets.push({ objectKind: target.objectKind, objectId: target.objectId, dimensions: target.dimensions, operationIndex });
    }
  });
  return targets;
}

/** N06-03：字段读集／写集 = 各操作在编辑操作注册表中声明的集合的并集（去重排序）。 */
function computeReadWriteSets(operations: readonly EditOperation[]): { readSet: string[]; writeSet: string[] } {
  const readSet = new Set<string>();
  const writeSet = new Set<string>();
  for (const operation of operations) {
    const definition = EDIT_OPERATION_REGISTRY[operation.op];
    for (const item of definition.readSet) readSet.add(item);
    for (const item of definition.writeSet) writeSet.add(item);
  }
  return { readSet: [...readSet].sort(), writeSet: [...writeSet].sort() };
}

/** N06-03：候选引用片段的源素材绑定签名（缺失片段记 `missing`，变化即触发重新审核）。 */
async function computeTargetAssetSignature(deps: DomainDeps, input: { workspaceId: string; projectId: string; targets: readonly ProposalTargetRef[] }): Promise<string> {
  const clipIds = [...new Set(input.targets.filter((target) => target.objectKind === 'CLIP').map((target) => target.objectId))].sort();
  if (clipIds.length === 0) return sha256('no-asset-targets');
  const rows = await deps.db.select({ id: sequenceClips.id, assetVersionId: sequenceClips.assetVersionId }).from(sequenceClips).where(and(
    eq(sequenceClips.workspaceId, input.workspaceId), eq(sequenceClips.projectId, input.projectId), inArray(sequenceClips.id, clipIds),
  ));
  const bindings = new Map(rows.map((row) => [row.id, row.assetVersionId ?? 'null']));
  return sha256(clipIds.map((id) => `${id}:${bindings.get(id) ?? 'missing'}`).join('|'));
}

const parseStoredTargets = (value: unknown): ProposalTargetRef[] | null => {
  const parsed = proposalTargetRefSchema.array().safeParse(value);
  return parsed.success ? parsed.data : null;
};

/**
 * N06-03：把一条 `edit_events` 记录还原成"哪个对象、哪些维度被改动"。
 * 维度优先从 `patch` 按与候选同一套规则还原；读不出形状（如涟漪邻居的 `update_clip`）时
 * **保守取全维度**，宁可多报冲突也不漏报（漏报会让陈旧候选被静默 rebase）。
 */
function eventTargetRefs(event: typeof editEvents.$inferSelect, projectId: string): EditTargetRef[] {
  const patch = (typeof event.patch === 'object' && event.patch !== null ? event.patch : {}) as Record<string, unknown>;
  const patchTargets = isEditOperationName(patch['op']) ? computeOperationTargetRefs(patch, { projectId }) : [];
  const patchDimensions = OBJECT_LOCK_DIMENSIONS.filter((dimension) => patchTargets.some((target) => target.dimensions.includes(dimension)));
  const dimensions = patchDimensions.length > 0 ? patchDimensions : [...OBJECT_LOCK_DIMENSIONS];
  if (event.objectKind !== null && event.objectId !== null && isObjectLockKind(event.objectKind)) {
    return [{ objectKind: event.objectKind, objectId: event.objectId, dimensions }];
  }
  if (event.sceneId !== null) return [{ objectKind: 'SCENE', objectId: event.sceneId, dimensions }];
  // 无对象身份的事件（如 reorder_scenes）：完全从 patch 还原（reorder 展开为每个 Scene × POSITION）
  return patchTargets;
}

/** N06-03：候选写目标与干预改动在同一对象、同一维度上的竞争（"改同字段"判定）。 */
function computeConflicts(targets: readonly ProposalTargetRef[], changes: readonly ProposalInterveningChange[]): ProposalImpactConflict[] {
  const conflicts = new Map<string, ProposalImpactConflict>();
  for (const target of targets) {
    for (const change of changes) {
      const shared = targetRefsIntersect(target, change);
      if (shared.length === 0) continue;
      const key = `${target.objectKind}:${target.objectId}:${shared.join(',')}`;
      const existing = conflicts.get(key);
      if (existing === undefined) {
        conflicts.set(key, {
          objectKind: target.objectKind, objectId: target.objectId, dimensions: shared,
          operationIndexes: [target.operationIndex], interveningActions: [change.action],
        });
        continue;
      }
      if (!existing.operationIndexes.includes(target.operationIndex)) existing.operationIndexes.push(target.operationIndex);
      if (!existing.interveningActions.includes(change.action)) existing.interveningActions.push(change.action);
    }
  }
  return [...conflicts.values()];
}

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
    // N06-04：过期行不参与命中（依赖键失效为主，TTL 兜底陈旧与容量）
    gt(proposalTrials.createdAt, trialTtlCutoff(deps)),
  )).limit(1);
  const cached = rows[0];
  if (!cached) return null;
  // 旧版本写入的缓存行可能缺少后加字段：解析失败按未命中处理（重新试改），不让陈旧缓存让请求失败
  const parsed = proposalTrialSchema.safeParse(cached.trial);
  if (!parsed.success) return null;
  return proposalTrialSchema.parse({ ...parsed.data, proposalId: row.id, cached: true, dependencyKey });
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
  // N06-04：容量上限——按最新排序，超出前 N 的旧行直接淘汰（避免无限增长）。
  const cap = trialMaxPerProject(deps);
  const stale = await deps.db.select({ dependencyKey: proposalTrials.dependencyKey }).from(proposalTrials).where(and(
    eq(proposalTrials.workspaceId, row.workspaceId), eq(proposalTrials.projectId, row.projectId),
  )).orderBy(desc(proposalTrials.createdAt)).offset(cap);
  if (stale.length > 0) {
    await deps.db.delete(proposalTrials).where(and(
      eq(proposalTrials.workspaceId, row.workspaceId),
      eq(proposalTrials.projectId, row.projectId),
      inArray(proposalTrials.dependencyKey, stale.map((entry) => entry.dependencyKey)),
    ));
  }
}

/** N06-04：试片缓存可观测性（行数 / 过期数 / 生效策略）。 */
export async function proposalTrialCacheStats(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<{ rows: number; expired: number; capacity: number; ttlHours: number }> {
  const rows = await deps.db.select({ dependencyKey: proposalTrials.dependencyKey, createdAt: proposalTrials.createdAt }).from(proposalTrials).where(and(
    eq(proposalTrials.workspaceId, input.workspaceId), eq(proposalTrials.projectId, input.projectId),
  ));
  const cutoff = trialTtlCutoff(deps);
  return {
    rows: rows.length,
    expired: rows.filter((entry) => entry.createdAt.getTime() <= cutoff.getTime()).length,
    capacity: trialMaxPerProject(deps),
    ttlHours: trialTtlHours(deps),
  };
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

/** N06-06：候选的意图谱系键（意图修订优先；否则用绑定的选择锚点；都没有则无谱系）。 */
interface ProposalLineage { intentRevisionId: string | null; selectionAnchorId: string | null }
const lineageCondition = (lineage: ProposalLineage) =>
  lineage.intentRevisionId !== null
    ? eq(proposals.intentRevisionId, lineage.intentRevisionId)
    : lineage.selectionAnchorId !== null
      ? eq(proposals.selectionAnchorId, lineage.selectionAnchorId)
      : null;

/** N06-06：工程内代际单调递增（新指令得到更大代际）。 */
async function nextGeneration(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<number> {
  const rows = await deps.db.select({ generation: proposals.generation }).from(proposals).where(and(
    eq(proposals.workspaceId, input.workspaceId), eq(proposals.projectId, input.projectId),
  ));
  return rows.reduce((max, row) => Math.max(max, row.generation), 0) + 1;
}

/** N06-06：同一谱系内仍在 OPEN 的旧候选取代（标记 SUPERSEDED 并记录取代者）。返回被取代数。 */
async function supersedeLineage(deps: DomainDeps, input: {
  workspaceId: string; projectId: string; keepProposalId: string; lineage: ProposalLineage;
}): Promise<number> {
  const condition = lineageCondition(input.lineage);
  if (condition === null) return 0;
  const rows = await deps.db.select({ id: proposals.id }).from(proposals).where(and(
    eq(proposals.workspaceId, input.workspaceId),
    eq(proposals.projectId, input.projectId),
    eq(proposals.status, 'OPEN'),
    condition,
  ));
  const now = new Date();
  let superseded = 0;
  for (const row of rows) {
    if (row.id === input.keepProposalId) continue;
    await deps.db.update(proposals).set({
      status: 'SUPERSEDED', supersededByProposalId: input.keepProposalId, supersededAt: now, updatedAt: now,
    }).where(eq(proposals.id, row.id));
    superseded += 1;
  }
  return superseded;
}

/** N06-06：谱系当前代际（同谱系内最大代际；无谱系时为自身代际）。 */
async function currentGenerationForLineage(deps: DomainDeps, row: typeof proposals.$inferSelect): Promise<number> {
  const condition = lineageCondition({ intentRevisionId: row.intentRevisionId ?? null, selectionAnchorId: row.selectionAnchorId ?? null });
  if (condition === null) return row.generation;
  const rows = await deps.db.select({ generation: proposals.generation }).from(proposals).where(and(
    eq(proposals.workspaceId, row.workspaceId), eq(proposals.projectId, row.projectId), condition,
  ));
  return rows.reduce((max, item) => Math.max(max, item.generation), row.generation);
}

const toProposalArtifact = (row: typeof proposalArtifacts.$inferSelect): ProposalArtifact => proposalArtifactSchema.parse({
  artifactId: row.id,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  proposalId: row.proposalId ?? null,
  generation: row.generation,
  currentGeneration: row.currentGeneration ?? null,
  kind: row.kind,
  reference: row.reference,
  bound: row.bound,
  bindingReason: row.bindingReason,
  createdAt: row.createdAt.toISOString(),
});

/** N06-05：操作产生的对象 id 字段（用于依赖闭包）。 */
const PRODUCED_ID_FIELDS = ['createdClipId', 'createdAudioClipId', 'createdVideoClipId', 'createdCaptionId', 'createdTailCaptionId'] as const;
/** N06-05：操作消费的对象 id 字段（引用先前操作创建的对象时构成依赖）。 */
const CONSUMED_ID_FIELDS = [
  'clipId', 'leftClipId', 'rightClipId', 'videoClipId', 'audioClipId', 'captionId', 'afterClipId',
  'trackId', 'sequenceId', 'destinationTrackId', 'audioRegionId', 'leftRegionId', 'rightRegionId',
  'targetId', 'animationId', 'objectId',
] as const;

const readIdField = (operation: EditOperation, field: string): string | null => {
  const value = (operation as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

interface PartialAdoptClosure {
  /** 实际采用的操作下标（升序）= 用户选择 ∪ 依赖闭包 */
  adopted: number[];
  /** 是否因闭包扩大了作用范围 */
  expanded: boolean;
  effectiveWriteTargets: ProposalTargetRef[];
}

/**
 * N06-05：**部分采用**的依赖闭包。
 *
 * 规则（保守，宁可扩大也不切断依赖）：
 * 1. **引用闭包**：若采用的操作引用了本批中另一操作创建的对象（`createdClipId` 等），则创建操作必须一并采用；
 * 2. **音画配对**：若采用的操作与批内另一操作作用在**同一 `avGroupId`** 的片段上，两者必须一并采用，
 *    否则会出现"只改了画面那半边"的声画漂移；
 * 3. 其余情况不扩张。执行层仍会做自己的守卫（如涟漪跨轨同步、锁），失败时整批回滚、零部分写入。
 */
async function computePartialAdoptClosure(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  operations: readonly EditOperation[];
  selectedIndexes: readonly number[];
}): Promise<PartialAdoptClosure> {
  const total = input.operations.length;
  const unique = [...new Set(input.selectedIndexes)].sort((left, right) => left - right);
  if (unique.length === 0 || unique.some((index) => index < 0 || index >= total)) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'selected operation indexes are out of range', 422, {
      reason: PROPOSAL_ERROR_REASONS.PARTIAL_SCOPE_INVALID, operations: total, selected: unique,
    });
  }
  const selected = new Set<number>(unique);

  // 1) 引用闭包：消费 → 生产
  const producedBy = new Map<string, number[]>();
  input.operations.forEach((operation, index) => {
    for (const field of PRODUCED_ID_FIELDS) {
      const id = readIdField(operation, field);
      if (id !== null) producedBy.set(id, [...(producedBy.get(id) ?? []), index]);
    }
  });
  const expandReferences = (): void => {
    for (const index of [...selected]) {
      for (const field of CONSUMED_ID_FIELDS) {
        const id = readIdField(input.operations[index]!, field);
        if (id === null) continue;
        for (const producer of producedBy.get(id) ?? []) selected.add(producer);
      }
    }
  };

  // 2) 音画配对：批内**任一**被采用的操作触及的 avGroupId 上的其他操作必须同进
  //    （必须对全部候选目标解析 avGroupId，否则选中的那侧找不到另一样本）。
  const clipTargets = input.operations.flatMap((operation, index) =>
    computeOperationTargetRefs(operation as unknown as Record<string, unknown>, { projectId: input.projectId })
      .filter((target) => target.objectKind === 'CLIP')
      .map((target) => ({ index, clipId: target.objectId })));
  const allTargetClipIds = [...new Set(clipTargets.map((entry) => entry.clipId))];
  const groupOf = new Map<string, string>();
  if (allTargetClipIds.length > 0) {
    const clipRows = await deps.db.select({ id: sequenceClips.id, avGroupId: sequenceClips.avGroupId }).from(sequenceClips).where(and(
      eq(sequenceClips.workspaceId, input.workspaceId),
      eq(sequenceClips.projectId, input.projectId),
      inArray(sequenceClips.id, allTargetClipIds),
    ));
    for (const row of clipRows) if (row.avGroupId !== null) groupOf.set(row.id, row.avGroupId);
  }
  const expandAvPairs = (): void => {
    const touchedGroups = new Set<string>();
    for (const entry of clipTargets) {
      if (!selected.has(entry.index)) continue;
      const group = groupOf.get(entry.clipId);
      if (group !== undefined) touchedGroups.add(group);
    }
    if (touchedGroups.size === 0) return;
    for (const entry of clipTargets) {
      if (selected.has(entry.index)) continue;
      const group = groupOf.get(entry.clipId);
      if (group !== undefined && touchedGroups.has(group)) selected.add(entry.index);
    }
  };

  // 两条规则互相可能触发对方（AV 扩张可能引入新的引用依赖）→ 迭代到不动点。
  for (let pass = 0; pass < total + 1; pass += 1) {
    const sizeBefore = selected.size;
    expandReferences();
    expandAvPairs();
    if (selected.size === sizeBefore) break;
  }

  const adopted = [...selected].sort((left, right) => left - right);
  const effectiveWriteTargets = adopted.flatMap((index) =>
    computeWriteTargets([input.operations[index]!], input.projectId).map((target) => ({ ...target, operationIndex: index })));
  return { adopted, expanded: adopted.length !== unique.length, effectiveWriteTargets };
}

const toProposal = (row: typeof proposals.$inferSelect): Proposal => proposalSchema.parse({  proposalId: row.id,
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
  readSet: Array.isArray(row.readSet) ? row.readSet : [],
  writeSet: Array.isArray(row.writeSet) ? row.writeSet : [],
  writeTargets: parseStoredTargets(row.writeTargets) ?? [],
  rebaseCount: row.rebaseCount,
  rebasedFromRevision: row.rebasedFromRevision ?? null,
  generation: row.generation,
  supersededByProposalId: row.supersededByProposalId ?? null,
  supersededAt: row.supersededAt === null ? null : row.supersededAt.toISOString(),
  cancelledAt: row.cancelledAt === null ? null : row.cancelledAt.toISOString(),
  adoptedOperationIndexes: Array.isArray(row.adoptedOperationIndexes) ? (row.adoptedOperationIndexes as number[]) : [],
  createdAt: row.createdAt.toISOString(),
  committedAt: row.committedAt === null ? null : row.committedAt.toISOString(),
  discardedAt: row.discardedAt === null ? null : row.discardedAt.toISOString(),
});

const loadProposalRow = async (deps: DomainDeps, input: { workspaceId: string; projectId: string; proposalId: string }) => {  const rows = await deps.db.select().from(proposals).where(and(
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
  // N06-03：创建时**记录**字段读写集、具体写目标与源素材绑定签名（供影响集/受控 rebase 使用）。
  const writeTargets = computeWriteTargets(operations, input.projectId);
  const { readSet, writeSet } = computeReadWriteSets(operations);
  const assetVersionSignature = await computeTargetAssetSignature(deps, {
    workspaceId: input.workspaceId, projectId: input.projectId, targets: writeTargets,
  });
  // N06-06：代际 = 本工程历史最大代际 + 1（新指令得到更大的代际）。
  const generation = await nextGeneration(deps, input);
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
    readSet,
    writeSet,
    writeTargets,
    assetVersionSignature,
    rebaseCount: 0,
    rebaseLog: [],
    generation,
    status: 'OPEN',
    createdAt: now,
    updatedAt: now,
  });
  // N06-06：同一意图谱系（意图修订或选择锚点）的新候选**取代**旧 OPEN 候选：
  // 先慢后快的两个任务逆序完成时，仍只以最新一代为当前意图。
  await supersedeLineage(deps, {
    workspaceId: input.workspaceId, projectId: input.projectId, keepProposalId: proposalId,
    lineage: { intentRevisionId: input.request.intentRevisionId, selectionAnchorId: input.request.selectionAnchorId },
  });
  return toProposal(await loadProposalRow(deps, { ...input, proposalId }));
}

/** 试改失败原因的稳定摘要（错误码 + 业务 reason），不含内部异常文本。 */
function trialFailureCause(error: ApiFailure): { code: string; reason: string | null; message: string } {
  const reason = error.details['reason'];
  return { code: error.code, reason: typeof reason === 'string' ? reason : null, message: error.message.slice(0, 200) };
}

/**
 * 确定性试改核心（V5-M2 起经试改引擎）：全部为内核操作时在内核内存执行（零写入、不取项目行锁），
 * 否则在事务内跑真实执行器后无条件回滚。两条路径结果一致，工程零变更。
 * N06-03：rebase 前也用同一路径在**新 base** 上验证操作仍可执行。
 */
async function runDeterministicTrial(deps: DomainDeps, input: {
  row: typeof proposals.$inferSelect;
  workspaceId: string;
  projectId: string;
  baseProjectRevision: number;
  actorId?: string;
}): Promise<{ trial: ProposalTrial; postState: Map<string, ClipDigests> }> {
  const operations = editOperationSchema.array().parse(input.row.operations);
  let outcome: EditTrialOutcome;
  try {
    outcome = await runEditTrial(deps, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      baseProjectRevision: input.baseProjectRevision,
      operations,
      actorId: input.actorId ?? 'proposal-trial',
    });
  } catch (error) {
    // 只有业务拒绝（ApiFailure：锁、模式、源范围、时序等）才是"提案不合法"→ 422；
    // 数据库故障、编程错误等原样抛出走统一 500 信封（不把服务端故障伪装成提案问题，也不泄漏内部错误信息）。
    if (error instanceof ApiFailure) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'proposal trial failed', 422, {
        reason: PROPOSAL_ERROR_REASONS.TRIAL_FAILED,
        cause: trialFailureCause(error),
      });
    }
    throw error;
  }
  const trial = proposalTrialSchema.parse({
    proposalId: input.row.id,
    operationsHash: input.row.operationsHash,
    trialRevision: outcome.revision,
    events: outcome.events,
    clipRanges: outcome.clips.map((clip) => {
      const sequenceRange = mediaRangeSchema.parse(clip.sequenceRange);
      const sourceRange = mediaRangeSchema.parse(clip.sourceRange);
      return {
        clipId: clip.id,
        trackId: clip.trackId,
        sequenceRange,
        sourceRange,
        sequenceStartMs: mediaTimeToDisplayMilliseconds(sequenceRange.start),
        sequenceEndMs: mediaTimeToDisplayMilliseconds(sequenceRange.end),
        sourceStartMs: mediaTimeToDisplayMilliseconds(sourceRange.start),
        sourceEndMs: mediaTimeToDisplayMilliseconds(sourceRange.end),
      };
    }),
    projectUntouched: true,
  });
  // 试改后状态的三轴指纹（N06-07 已确认内容保护门要用）
  const postState = new Map(outcome.clips.map((clip) => [clip.id, clipDigestsOf(clip)]));
  return { trial, postState };
}

export async function previewProposal(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  proposalId: string;
  actorId?: string;
}): Promise<ProposalTrial> {
  const row = await loadProposalRow(deps, input);
  if (row.status !== 'OPEN') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proposal is not open', 409, {
      reason: row.status === 'SUPERSEDED'
        ? PROPOSAL_ERROR_REASONS.SUPERSEDED
        : row.status === 'CANCELLED' ? PROPOSAL_ERROR_REASONS.CANCELLED : PROPOSAL_ERROR_REASONS.NOT_OPEN,
      status: row.status,
    });
  }
  // N06-04：先查局部试片缓存；依赖键一致则直接复用确定性结果（不重复跑执行器）。
  const { dependencyKey, assetVersionSignature } = await computeTrialDependencies(deps, row);
  const cachedTrial = await loadCachedTrial(deps, row, dependencyKey);
  if (cachedTrial !== null) return cachedTrial;

  const { trial } = await runDeterministicTrial(deps, {
    row, workspaceId: input.workspaceId, projectId: input.projectId, baseProjectRevision: row.baseProjectRevision,
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
  });
  await storeTrial(deps, row, { dependencyKey, assetVersionSignature, trial });
  return proposalTrialSchema.parse({ ...trial, proposalId: row.id, cached: false, dependencyKey });
}

/**
 * N06-03：影响集视图 —— 候选的写目标、base revision 之后的干预改动、二者的竞争，
 * 以及身份（锚点指纹）／源素材绑定是否变化。**只读**，不改工程。
 */
export async function computeProposalImpact(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  proposalId: string;
}): Promise<ProposalImpact> {
  const row = await loadProposalRow(deps, input);
  const currentRevision = await loadProjectRevision(deps, input);
  const operations = editOperationSchema.array().parse(row.operations);
  const writeTargets = parseStoredTargets(row.writeTargets) ?? computeWriteTargets(operations, input.projectId);
  const sets = computeReadWriteSets(operations);
  const readSet = Array.isArray(row.readSet) ? (row.readSet as string[]) : sets.readSet;
  const writeSet = Array.isArray(row.writeSet) ? (row.writeSet as string[]) : sets.writeSet;

  // 干预改动：base revision 之后的全部 edit_events（别的编辑推进了工程）
  const events = await deps.db.select().from(editEvents).where(and(
    eq(editEvents.workspaceId, input.workspaceId),
    eq(editEvents.projectId, input.projectId),
    gt(editEvents.resultRevision, row.baseProjectRevision),
  ));
  const interveningChanges: ProposalInterveningChange[] = events.flatMap((event) =>
    eventTargetRefs(event, input.projectId).map((target) => ({ ...target, action: event.action })));
  const conflicts = computeConflicts(writeTargets, interveningChanges);

  // 身份：绑定的选择锚点指纹是否已变化
  let identityChanged = false;
  if (row.selectionAnchorId !== null) {
    const anchorRows = await deps.db.select().from(selectionAnchors).where(and(
      eq(selectionAnchors.id, row.selectionAnchorId),
      eq(selectionAnchors.workspaceId, input.workspaceId),
      eq(selectionAnchors.projectId, input.projectId),
    )).orderBy(desc(selectionAnchors.revision)).limit(1);
    const anchorRow = anchorRows[0];
    const current = anchorRow === undefined ? null : sha256(selectionFingerprintInput(anchorRow.anchor as never));
    identityChanged = current !== row.selectionFingerprint;
  }

  // 源素材：候选引用片段的源绑定签名是否变化（创建时已记录）
  const currentAssetSignature = await computeTargetAssetSignature(deps, {
    workspaceId: input.workspaceId, projectId: input.projectId, targets: writeTargets,
  });
  const assetChanged = row.assetVersionSignature !== null && row.assetVersionSignature !== currentAssetSignature;

  const blockReasons: ProposalReviewBlockReason[] = [];
  if (conflicts.length > 0) blockReasons.push(PROPOSAL_REVIEW_BLOCK_REASONS.CONFLICT);
  if (identityChanged) blockReasons.push(PROPOSAL_REVIEW_BLOCK_REASONS.IDENTITY_CHANGED);
  if (assetChanged) blockReasons.push(PROPOSAL_REVIEW_BLOCK_REASONS.ASSET_CHANGED);

  return proposalImpactSchema.parse({
    proposalId: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    baseProjectRevision: row.baseProjectRevision,
    currentProjectRevision: currentRevision,
    readSet, writeSet, writeTargets, interveningChanges, conflicts,
    identityChanged, assetChanged,
    rebaseable: blockReasons.length === 0,
    blockReasons,
  });
}

/**
 * N06-03：受控 rebase —— 仅在**无竞争、身份与源素材未变**时，把候选的 base revision
 * 推进到当前 revision（仍用真实执行器在新 base 上验证一次）。
 * 出现竞争（同对象同维度）或身份/素材变化一律 fail-closed：要求以最新状态重新审核，
 * **绝不**"以最新 revision 强覆盖"。
 */
export async function rebaseProposal(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  proposalId: string;
  expectedOperationsHash: string;
  actorId?: string;
}): Promise<{ proposal: Proposal; impact: ProposalImpact; rebasedFromRevision: number; rebasedToRevision: number; rebased: boolean }> {
  const row = await loadProposalRow(deps, input);
  if (row.status !== 'OPEN') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proposal can no longer be rebased', 409, {
      reason: row.status === 'SUPERSEDED'
        ? PROPOSAL_ERROR_REASONS.SUPERSEDED
        : row.status === 'CANCELLED' ? PROPOSAL_ERROR_REASONS.CANCELLED : PROPOSAL_ERROR_REASONS.NOT_OPEN,
      status: row.status,
    });
  }
  if (input.expectedOperationsHash !== row.operationsHash) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proposal operations changed since the user reviewed it', 409, {
      reason: PROPOSAL_ERROR_REASONS.HASH_MISMATCH, expected: input.expectedOperationsHash, actual: row.operationsHash,
    });
  }
  const impact = await computeProposalImpact(deps, input);
  if (impact.conflicts.length > 0) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proposal conflicts with edits made since its base revision', 409, {
      reason: PROPOSAL_ERROR_REASONS.REBASE_CONFLICT, conflicts: impact.conflicts,
    });
  }
  if (impact.identityChanged || impact.assetChanged) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proposal must be re-reviewed against the latest state', 409, {
      reason: PROPOSAL_ERROR_REASONS.REVIEW_REQUIRED,
      identityChanged: impact.identityChanged, assetChanged: impact.assetChanged, blockReasons: impact.blockReasons,
    });
  }
  const currentRevision = impact.currentProjectRevision;
  if (currentRevision === row.baseProjectRevision) {
    // 已是最新：幂等空操作，不写库
    return { proposal: toProposal(row), impact, rebasedFromRevision: row.baseProjectRevision, rebasedToRevision: currentRevision, rebased: false };
  }
  // 非冲突：先在新 base 上验证操作仍可执行（真实执行器事务内跑完回滚），再推进 base revision
  try {
    await runDeterministicTrial(deps, {
      row, workspaceId: input.workspaceId, projectId: input.projectId, baseProjectRevision: currentRevision,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    });
  } catch (error) {
    if (!(error instanceof ApiFailure)) throw error;
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proposal cannot be applied to the latest revision', 409, {
      reason: PROPOSAL_ERROR_REASONS.REVIEW_REQUIRED,
      cause: error.details['cause'] ?? trialFailureCause(error),
    });
  }
  const now = new Date();
  const rebaseLog = Array.isArray(row.rebaseLog) ? row.rebaseLog : [];
  await deps.db.update(proposals).set({
    baseProjectRevision: currentRevision,
    rebasedFromRevision: row.baseProjectRevision,
    rebaseCount: row.rebaseCount + 1,
    rebaseLog: [...rebaseLog, { fromRevision: row.baseProjectRevision, toRevision: currentRevision, at: now.toISOString() }],
    updatedAt: now,
  }).where(eq(proposals.id, row.id));
  // base revision 变化 → 依赖键变化（自然失效），这里同时清理旧缓存行（归属/容量）
  await invalidateProposalTrialRows(deps, row);
  const updated = await loadProposalRow(deps, input);
  return {
    proposal: toProposal(updated),
    impact: await computeProposalImpact(deps, input),
    rebasedFromRevision: row.baseProjectRevision,
    rebasedToRevision: currentRevision,
    rebased: true,
  };
}

/** 采用类操作的共同前置校验（操作哈希 = 用户看过的就是这一份；锚点指纹；base revision）。 */
async function assertAdoptPreconditions(deps: DomainDeps, input: {
  row: typeof proposals.$inferSelect;
  workspaceId: string;
  projectId: string;
  expectedOperationsHash: string;
  expectedSelectionFingerprint: string | null;
}): Promise<void> {
  const { row } = input;
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
  /** N06-07：已确认内容保护（附带的意外移位会阻止自动采用） */
  protectionIds?: readonly string[];
}): Promise<{ proposal: Proposal; projectRevision: number }> {
  const row = await loadProposalRow(deps, input);
  // 幂等：同一幂等键重放返回同一结果（不产生第二次写入）
  if (row.status === 'COMMITTED') {
    if (row.adoptionIdempotencyKey === input.idempotencyKey) {
      return { proposal: toProposal(row), projectRevision: row.committedRevision ?? row.baseProjectRevision };
    }
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proposal has already been committed', 409, { reason: PROPOSAL_ERROR_REASONS.NOT_OPEN });
  }
  if (row.status === 'DISCARDED' || row.status === 'SUPERSEDED' || row.status === 'CANCELLED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proposal can no longer be adopted', 409, {
      reason: row.status === 'SUPERSEDED'
        ? PROPOSAL_ERROR_REASONS.SUPERSEDED
        : row.status === 'CANCELLED' ? PROPOSAL_ERROR_REASONS.CANCELLED : PROPOSAL_ERROR_REASONS.NOT_OPEN,
      status: row.status,
    });
  }
  await assertAdoptPreconditions(deps, {
    row,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    expectedOperationsHash: input.expectedOperationsHash,
    expectedSelectionFingerprint: input.expectedSelectionFingerprint,
  });
  const operations = editOperationSchema.array().parse(row.operations);
  // N06-07：已确认内容保护 —— 用**试改后状态**核对，附带的意外移位一律阻止自动采用（零写入）。
  if (input.protectionIds !== undefined && input.protectionIds.length > 0) {
    const { postState } = await runDeterministicTrial(deps, {
      row, workspaceId: input.workspaceId, projectId: input.projectId, baseProjectRevision: row.baseProjectRevision,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    });
    await assertProtectedContentStable(deps, {
      workspaceId: input.workspaceId, projectId: input.projectId, proposalId: row.id,
      protectionIds: input.protectionIds,
      explicitTargetKeys: computeWriteTargets(operations, input.projectId).map((target) => `${target.objectKind}:${target.objectId}`),
      postState,
    });
  }
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

/**
 * N06-05：**部分采用** —— 只落地用户勾选的操作子集，但按**依赖闭包**扩张到合法采纳集
 * （被引用对象的创建操作 + 同一 AV 组的另一侧），并如实回报实际作用范围。
 *
 * - 该候选随后为一次性交付：状态置 `PARTIALLY_ADOPTED`（未采用的操作**不能**再从本候选落地，
 *   因为工程 revision 已推进；要再改须新建候选）——避免重复写入与声画漂移；
 * - 闭包覆盖全部操作时等价于完整采用（状态 `COMMITTED`）；
 * - 执行失败 → 统一编辑协议整批回滚、零部分写入、候选保持 OPEN。
 */
export async function adoptProposalPartial(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  proposalId: string;
  actorId?: string;
  selectedOperationIndexes: readonly number[];
  expectedOperationsHash: string;
  expectedSelectionFingerprint: string | null;
  idempotencyKey: string;
  /** N06-07：已确认内容保护（附带的意外移位会阻止自动采用） */
  protectionIds?: readonly string[];
}): Promise<{ proposal: Proposal; projectRevision: number; adoptedOperationIndexes: number[]; remainingOperationIndexes: number[]; closureExpanded: boolean; effectiveWriteTargets: ProposalTargetRef[] }> {
  const row = await loadProposalRow(deps, input);
  if (row.status !== 'OPEN') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proposal can no longer be adopted', 409, {
      reason: row.status === 'SUPERSEDED'
        ? PROPOSAL_ERROR_REASONS.SUPERSEDED
        : row.status === 'CANCELLED' ? PROPOSAL_ERROR_REASONS.CANCELLED : PROPOSAL_ERROR_REASONS.NOT_OPEN,
      status: row.status,
    });
  }
  await assertAdoptPreconditions(deps, {
    row,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    expectedOperationsHash: input.expectedOperationsHash,
    expectedSelectionFingerprint: input.expectedSelectionFingerprint,
  });
  const operations = editOperationSchema.array().parse(row.operations);
  const closure = await computePartialAdoptClosure(deps, {
    workspaceId: input.workspaceId, projectId: input.projectId, operations, selectedIndexes: input.selectedOperationIndexes,
  });
  const adoptedOperations = closure.adopted.map((index) => operations[index]!);
  const coversAll = closure.adopted.length === operations.length;
  // N06-07：已确认内容保护 —— 只对**本批实际采用的操作**做附带变化检查（用试改后状态）。
  if (input.protectionIds !== undefined && input.protectionIds.length > 0) {
    const { postState } = await runDeterministicTrial(deps, {
      row: { ...row, operations: adoptedOperations },
      workspaceId: input.workspaceId, projectId: input.projectId, baseProjectRevision: row.baseProjectRevision,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    });
    await assertProtectedContentStable(deps, {
      workspaceId: input.workspaceId, projectId: input.projectId, proposalId: row.id,
      protectionIds: input.protectionIds,
      explicitTargetKeys: computeWriteTargets(adoptedOperations, input.projectId).map((target) => `${target.objectKind}:${target.objectId}`),
      postState,
    });
  }
  const result = await processEdits(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actor: { type: 'USER', id: input.actorId ?? 'proposal-partial-adopt' },
    request: {
      schemaVersion: '1.0',
      baseProjectRevision: row.baseProjectRevision,
      expectedSceneRevisions: {},
      operations: adoptedOperations,
      idempotencyKey: input.idempotencyKey,
    },
  });
  const now = new Date();
  await deps.db.update(proposals).set({
    status: coversAll ? 'COMMITTED' : 'PARTIALLY_ADOPTED',
    committedRevision: result.response.project.revision,
    adoptionIdempotencyKey: coversAll ? input.idempotencyKey : null,
    committedAt: coversAll ? now : null,
    adoptedOperationIndexes: closure.adopted,
    updatedAt: now,
  }).where(eq(proposals.id, row.id));
  await invalidateProposalTrialRows(deps, row);
  const updated = await loadProposalRow(deps, input);
  return {
    proposal: toProposal(updated),
    projectRevision: result.response.project.revision,
    adoptedOperationIndexes: closure.adopted,
    remainingOperationIndexes: operations.map((_, index) => index).filter((index) => !closure.adopted.includes(index)),
    closureExpanded: closure.expanded,
    effectiveWriteTargets: closure.effectiveWriteTargets,
  };
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

/** V6-1c：在试改上继续后，新提案取代被延续的旧提案（只对仍 OPEN 的生效；已采用/已撤回保持原状态）。 */
export async function supersedeProposal(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  proposalId: string;
  byProposalId: string;
}): Promise<boolean> {
  const now = new Date();
  const rows = await deps.db.update(proposals).set({ status: 'SUPERSEDED', supersededByProposalId: input.byProposalId, supersededAt: now, updatedAt: now })
    .where(and(eq(proposals.id, input.proposalId), eq(proposals.workspaceId, input.workspaceId), eq(proposals.projectId, input.projectId), eq(proposals.status, 'OPEN')))
    .returning({ id: proposals.id });
  return rows.length > 0;
}

/** 同一选区/意图的新候选取代旧候选（旧候选只能被丢弃或标记 SUPERSEDED，并记录取代者）。 */
export async function supersedeProposals(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  intentRevisionId: string;
  keepProposalId: string;
}): Promise<number> {
  return supersedeLineage(deps, {
    workspaceId: input.workspaceId, projectId: input.projectId, keepProposalId: input.keepProposalId,
    lineage: { intentRevisionId: input.intentRevisionId, selectionAnchorId: null },
  });
}

/**
 * N06-06：取消候选 —— 标记 CANCELLED 表达"这个方向不要了"，但**保留已有结果**
 * （试片缓存与产物台账都不删除）。取消后采用被拒；晚到产物被隔离。
 */
export async function cancelProposal(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  proposalId: string;
  reason?: string;
}): Promise<Proposal> {
  const row = await loadProposalRow(deps, input);
  if (row.status === 'CANCELLED') return toProposal(row);
  if (row.status === 'COMMITTED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'committed proposal cannot be cancelled', 409, { reason: PROPOSAL_ERROR_REASONS.NOT_OPEN });
  }
  // 已丢弃/已取代的候选保持原状态（取消只对 OPEN 候选有意义；这里幂等返回，不覆盖已有终态）
  if (row.status !== 'OPEN') return toProposal(row);
  const now = new Date();
  await deps.db.update(proposals).set({ status: 'CANCELLED', cancelledAt: now, updatedAt: now }).where(eq(proposals.id, row.id));
  // 保留已有结果：不删除试片缓存、不删除产物台账（与 discardProposal 的清理语义不同）
  return toProposal(await loadProposalRow(deps, input));
}

/**
 * N06-06：外部晚到产物提交 —— 只有**候选仍 OPEN 且为其谱系当前代际**时绑定；
 * 其余（已提交/已取代/已取消/代际陈旧/非当前）一律**隔离**（`bound=false`），
 * 写入隔离台账而**不自动绑定**到候选或工程。同一产物重放幂等（按引用唯一）。
 */
export async function submitProposalArtifact(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  proposalId: string;
  request: SubmitProposalArtifactRequest;
}): Promise<{ artifact: ProposalArtifact; bound: boolean }> {
  const row = await loadProposalRow(deps, input);
  const currentGeneration = await currentGenerationForLineage(deps, row);
  let bindingReason: ProposalArtifactBindingReason;
  if (row.status === 'COMMITTED') bindingReason = 'ALREADY_BOUND';
  else if (row.status === 'SUPERSEDED') bindingReason = 'SUPERSEDED';
  else if (row.status === 'CANCELLED') bindingReason = 'CANCELLED';
  else if (row.status !== 'OPEN') bindingReason = 'NOT_OPEN';
  else if (input.request.generation !== row.generation) bindingReason = 'STALE_GENERATION';
  else if (currentGeneration !== row.generation) bindingReason = 'NOT_CURRENT';
  else bindingReason = 'BOUND';
  const bound = bindingReason === 'BOUND';
  const now = new Date();
  await deps.db.insert(proposalArtifacts).values({
    id: `art_${randomUUID()}`,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    proposalId: row.id,
    generation: input.request.generation,
    currentGeneration,
    kind: input.request.kind,
    reference: input.request.reference,
    bound,
    bindingReason,
    createdAt: now,
  }).onConflictDoUpdate({
    target: [proposalArtifacts.workspaceId, proposalArtifacts.projectId, proposalArtifacts.kind, proposalArtifacts.reference],
    set: { proposalId: row.id, generation: input.request.generation, currentGeneration, bound, bindingReason },
  });
  const stored = (await deps.db.select().from(proposalArtifacts).where(and(
    eq(proposalArtifacts.workspaceId, input.workspaceId),
    eq(proposalArtifacts.projectId, input.projectId),
    eq(proposalArtifacts.kind, input.request.kind),
    eq(proposalArtifacts.reference, input.request.reference),
  )).limit(1))[0]!;
  return { artifact: toProposalArtifact(stored), bound };
}

/** 只读读取候选的产物台账（隔离行同样可见，便于运维/客户端理由呈现）。 */
export async function listProposalArtifacts(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  proposalId: string;
}): Promise<ProposalArtifact[]> {
  await loadProposalRow(deps, input);
  const rows = await deps.db.select().from(proposalArtifacts).where(and(
    eq(proposalArtifacts.workspaceId, input.workspaceId),
    eq(proposalArtifacts.projectId, input.projectId),
    eq(proposalArtifacts.proposalId, input.proposalId),
  )).orderBy(desc(proposalArtifacts.createdAt));
  return rows.map(toProposalArtifact);
}
