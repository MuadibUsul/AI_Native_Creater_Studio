import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  RETENTION_TTL_SECONDS,
  assetSchema,
  projectSchema,
  type Asset,
  type Project,
  type RetentionClass,
} from '@ancs/contracts';
import {
  assetDerivationEdges,
  assetVersions,
  assets,
  idempotencyKeys,
  mediaAnalysisStages,
  mediaIndexEntries,
  mediaIndexRuns,
  mediaTranscriptRuns,
  projectVersions,
  projects,
  proposalArtifacts,
  proposalTrials,
  referenceEdges,
  scenes,
  sequenceClips,
  uploadIntents,
  isForeignKeyViolation,
} from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { licenseMetadataSchema } from '@ancs/contracts';

/**
 * 保留与删除（P02-05 / 规范 §27、§40；计划 P02-05）。
 *
 * 语义：
 * - 删除 = **软删**（deleted_at 进 Trash，默认保留 30 天；期间可恢复）；
 * - 到期由**可重入**清理流程硬删（`runRetentionSweep`）：重复执行/中途中断后重跑都收敛，
 *   每一步以数据库实际状态驱动（条件查询 + 行锁 + 幂等删除），不依赖内存状态；
 * - **引用保护**：
 *   1) Scene.assetBindings（含"绑定到其他 Scene"）阻止资产硬删；
 *   2) 任何存活 ProjectVersion 快照中出现的资产（保守匹配：快照 JSON 含该 id）阻止硬删；
 *   3) 去重共享的 storage_key：仅当**无其他版本行引用该键**时才删除对象（§26.3 的后果）；
 * - Provider 临时 URL/对象不得依赖（§75）：对象清理按 storage_key 精确执行。
 *   注：对象存储的**全量孤儿扫描**（列举桶内所有对象与版本行比对）需要 S3/R2 ListObjects，
 *   属 P08 运维接入项；本流程已覆盖"已知 key 的引用检查与删除"（含直传未确认的孤儿 key）。
 */

export const TRASH_RETENTION_DAYS = 30;
export const DEFAULT_IDEMPOTENCY_KEY_TTL_HOURS = 24;
/** N06-06：隔离产物（晚到/代际不符）的保留小时数；到期清理孤儿行 */
export const DEFAULT_PROPOSAL_ARTIFACT_QUARANTINE_TTL_HOURS = 72;
/** N06-04：局部试片缓存 TTL（小时）与每工程容量上限（超出按最旧淘汰）。 */
export const DEFAULT_PROPOSAL_TRIAL_TTL_HOURS = 24;
export const DEFAULT_PROPOSAL_TRIAL_MAX_PER_PROJECT = 50;

export interface RetentionConfig {
  /** Trash 保留天数（默认 30，测试可调小为 0） */
  trashRetentionDays?: number;
  /** 幂等键保留小时数（默认 24） */
  idempotencyKeyTtlHours?: number;
  /** N06-06：隔离产物保留小时数（默认 72，测试可调小为 0） */
  proposalArtifactQuarantineTtlHours?: number;
  /** N06-04：试片缓存 TTL（小时，默认 24） */
  proposalTrialTtlHours?: number;
  /** N06-04：每工程试片缓存行数上限（默认 50，超出淘汰最旧） */
  proposalTrialMaxPerProject?: number;
}

export interface RetentionSweepReport {
  ranAt: string;
  /** 过期 Trash 项目（整体硬删，含 scenes/versions/events；其资产转入资产清理） */
  projectsPurged: number;
  /** 项目清理随行删除的资产 */
  projectAssetsPurged: number;
  /** Trash 到期资产 */
  trashAssetsPurged: number;
  /** 保留类 TTL 到期资产（如 Draft Render 30 天） */
  retentionAssetsPurged: number;
  /** 因引用保护（Scene 绑定 / 时间线片段 / 版本快照 / 派生 / 外键仍有引用）而跳过的资产 */
  assetsSkippedByReference: number;
  /** 单条处理失败的资产（不中断整轮；下次清理重试） */
  assetsFailed: number;
  /** 失败明细（最多 20 条，供运维排查；不含敏感内容） */
  failures: { assetId: string; reason: string }[];
  /** 上传意图过期处理（PENDING → EXPIRED；未完成版本 → FAILED） */
  uploadIntentsExpired: number;
  /** N06-06：过期的**隔离**产物清理（bound=false 的孤儿行；bound=true 的已接受结果保留） */
  proposalArtifactsPurged: number;
  /** N06-06：保留未清理的已绑定产物数（作为候选结果证据） */
  proposalArtifactsKeptBound: number;
  /** N06-04：过期的局部试片缓存清理数 */
  proposalTrialCachePurged: number;
  /** 幂等键 TTL 清理 */
  idempotencyKeysPurged: number;
  /** 实际删除的对象数（含孤儿对象） */
  objectsDeleted: number;
  /** 因共享/仍被引用而保留的对象数 */
  objectsKeptShared: number;
  /** 孤儿对象（已无版本行引用，如中途中断的直传） */
  orphanObjectsDeleted: number;
}

const toProjectDto = (row: typeof projects.$inferSelect): Project => projectSchema.parse({
  id: row.id,
  workspaceId: row.workspaceId,
  channelId: row.channelId,
  title: row.title,
  sourceType: row.sourceType,
  status: row.status,
  revision: row.revision,
  aspectRatio: row.aspectRatio,
  resolution: row.resolution,
  fps: row.fps,
  targetDurationMs: row.targetDurationMs,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toAssetDto = (row: typeof assets.$inferSelect): Asset =>
  assetSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sceneId: row.sceneId,
    assetType: row.assetType,
    origin: row.origin,
    provider: row.provider,
    providerAssetId: row.providerAssetId,
    status: row.status,
    retentionClass: row.retentionClass,
    license: licenseMetadataSchema.parse(row.license),
    sensitivityClass: row.sensitivityClass,
    privacyDeletionRequestedAt: row.privacyDeletionRequestedAt?.toISOString() ?? null,
    metadata: row.metadata,
    currentVersionId: row.currentVersionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

function requireStorage(deps: DomainDeps) {
  if (deps.storage === undefined) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, '对象存储适配器未配置（DomainDeps.storage）', 500);
  }
  return deps.storage;
}

/** ---------- Trash：软删 / 恢复 ---------- */

export async function softDeleteProject(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; now?: Date },
): Promise<Project> {
  const rows = await deps.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId), isNull(projects.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  const updated = await deps.db
    .update(projects)
    .set({ deletedAt: input.now ?? new Date(), updatedAt: new Date() })
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId)))
    .returning();
  const next = updated[0];
  if (!next) throw new ApiFailure(ERROR_CODES.INTERNAL, 'project soft delete failed', 500);
  return toProjectDto(next);
}

export async function restoreProject(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<Project> {
  const rows = await deps.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId), isNotNull(projects.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'trashed project not found', 404);
  const updated = await deps.db
    .update(projects)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId)))
    .returning();
  const next = updated[0];
  if (!next) throw new ApiFailure(ERROR_CODES.INTERNAL, 'project restore failed', 500);
  return toProjectDto(next);
}

export async function softDeleteAsset(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; now?: Date },
): Promise<Asset> {
  const rows = await deps.db
    .select()
    .from(assets)
    .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset not found', 404);
  const now = input.now ?? new Date();
  const updated = await deps.db.transaction(async (tx) => {
    const versionRows = await tx.select({ id: assetVersions.id }).from(assetVersions).where(and(
      eq(assetVersions.workspaceId, input.workspaceId),
      eq(assetVersions.assetId, input.assetId),
    ));
    const versionIds = versionRows.map((version) => version.id);
    if (row.deletedAt === null) {
      await tx.update(assets).set({ deletedAt: now, updatedAt: now }).where(eq(assets.id, input.assetId));
      await tx.update(assetVersions).set({ deletedAt: now }).where(eq(assetVersions.assetId, input.assetId));
    }
    if (versionIds.length > 0) {
      const runRows = await tx.select({ id: mediaIndexRuns.id }).from(mediaIndexRuns).where(and(
        eq(mediaIndexRuns.workspaceId, input.workspaceId),
        inArray(mediaIndexRuns.sourceAssetVersionId, versionIds),
      ));
      const runIds = runRows.map((run) => run.id);
      if (runIds.length > 0) {
        await tx.update(mediaIndexEntries).set({ lifecycleState: 'DELETED' }).where(and(
          eq(mediaIndexEntries.workspaceId, input.workspaceId),
          inArray(mediaIndexEntries.runId, runIds),
        ));
        await tx.update(mediaIndexRuns).set({ status: 'STALE', errorSummary: '源资产已删除，派生索引已撤销。', updatedAt: now }).where(and(
          eq(mediaIndexRuns.workspaceId, input.workspaceId),
          inArray(mediaIndexRuns.id, runIds),
        ));
      }
      await tx.update(mediaTranscriptRuns).set({ status: 'STALE', errorSummary: '源资产已删除，转写索引已撤销。', updatedAt: now }).where(and(
        eq(mediaTranscriptRuns.workspaceId, input.workspaceId),
        inArray(mediaTranscriptRuns.sourceAssetVersionId, versionIds),
      ));
      await tx.update(mediaAnalysisStages).set({ status: 'STALE', errorSummary: '源资产已删除，分析结果已撤销。', invalidatedAt: now, updatedAt: now }).where(and(
        eq(mediaAnalysisStages.workspaceId, input.workspaceId),
        inArray(mediaAnalysisStages.sourceAssetVersionId, versionIds),
        notInArray(mediaAnalysisStages.status, ['DISABLED', 'NOT_REQUESTED']),
      ));
    }
    return tx.select().from(assets).where(eq(assets.id, input.assetId)).limit(1);
  });
  const next = updated[0];
  if (!next) throw new ApiFailure(ERROR_CODES.INTERNAL, 'asset soft delete failed', 500);

  const derivedRows = await deps.db.select({ id: mediaIndexEntries.id, storageKey: mediaIndexEntries.storageKey })
    .from(mediaIndexEntries)
    .innerJoin(mediaIndexRuns, eq(mediaIndexRuns.id, mediaIndexEntries.runId))
    .innerJoin(assetVersions, eq(assetVersions.id, mediaIndexRuns.sourceAssetVersionId))
    .where(and(
      eq(mediaIndexEntries.workspaceId, input.workspaceId),
      eq(assetVersions.assetId, input.assetId),
      isNotNull(mediaIndexEntries.storageKey),
    ));
  if (derivedRows.length > 0) {
    const storage = requireStorage(deps);
    for (const derived of derivedRows) {
      if (derived.storageKey !== null) await storage.deleteObject(derived.storageKey);
    }
    await deps.db.update(mediaIndexEntries).set({ storageKey: null }).where(inArray(mediaIndexEntries.id, derivedRows.map((derived) => derived.id)));
  }
  return toAssetDto(next);
}

export async function restoreAsset(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string },
): Promise<Asset> {
  const rows = await deps.db
    .select()
    .from(assets)
    .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId), isNotNull(assets.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'trashed asset not found', 404);
  const updated = await deps.db.transaction(async (tx) => {
    await tx.update(assets).set({ deletedAt: null, updatedAt: new Date() }).where(eq(assets.id, input.assetId));
    await tx.update(assetVersions).set({ deletedAt: null }).where(eq(assetVersions.assetId, input.assetId));
    return tx.select().from(assets).where(eq(assets.id, input.assetId)).limit(1);
  });
  const next = updated[0];
  if (!next) throw new ApiFailure(ERROR_CODES.INTERNAL, 'asset restore failed', 500);
  return toAssetDto(next);
}

/** ---------- 引用保护 ---------- */

/** Scene 绑定引用（jsonb 数组包含 {assetId}）。 */
export async function isAssetBoundToScene(deps: DomainDeps, workspaceId: string, assetId: string): Promise<boolean> {
  const rows = await deps.db
    .select({ count: sql<number>`count(*)::int` })
    .from(scenes)
    .where(and(eq(scenes.workspaceId, workspaceId), sql`${scenes.assetBindings} @> ${JSON.stringify([{ assetId }])}::jsonb`));
  return Number(rows[0]?.count ?? 0) > 0;
}

/** v0.4 时间线片段引用（sequence_clips → asset_versions；外键为 restrict，不检查会让硬删整轮失败）。 */
export async function isAssetReferencedByTimeline(deps: DomainDeps, workspaceId: string, assetId: string): Promise<boolean> {
  const rows = await deps.db
    .select({ count: sql<number>`count(*)::int` })
    .from(sequenceClips)
    .innerJoin(assetVersions, eq(assetVersions.id, sequenceClips.assetVersionId))
    .where(and(eq(sequenceClips.workspaceId, workspaceId), eq(assetVersions.assetId, assetId)));
  return Number(rows[0]?.count ?? 0) > 0;
}

/**
 * 引用图中的引用（V5-M2）：当前与**历史**引用边都算——撤销/恢复可以让历史引用重新生效，
 * 资产在其项目存续期间不得被硬删（项目硬删时边随项目级联删除）。
 */
export async function isAssetReferencedByReferenceEdge(deps: DomainDeps, workspaceId: string, assetId: string): Promise<boolean> {
  const rows = await deps.db
    .select({ count: sql<number>`count(*)::int` })
    .from(referenceEdges)
    .innerJoin(assetVersions, eq(assetVersions.id, referenceEdges.toId))
    .where(and(eq(referenceEdges.workspaceId, workspaceId), eq(referenceEdges.toKind, 'ASSET_VERSION'), eq(assetVersions.assetId, assetId)));
  return Number(rows[0]?.count ?? 0) > 0;
}

/** 资产是否仍被任何已知位置引用（Scene 绑定 / 引用图 / 时间线片段 / 版本快照 / 派生边）。 */
export async function isAssetReferenced(deps: DomainDeps, workspaceId: string, assetId: string): Promise<boolean> {
  return (await isAssetBoundToScene(deps, workspaceId, assetId))
    || (await isAssetReferencedByReferenceEdge(deps, workspaceId, assetId))
    || (await isAssetReferencedByTimeline(deps, workspaceId, assetId))
    || (await isAssetReferencedByVersionSnapshot(deps, workspaceId, assetId))
    || (await isAssetReferencedByDerivation(deps, workspaceId, assetId));
}

/**
 * 存活项目版本快照中的引用（保守匹配：快照 JSON 文本包含 assetId）。
 * 快照是"可恢复的历史"，其中的资产不得在仍可恢复时被硬删（§23.2 与 §40 的一致性）。
 */
export async function isAssetReferencedByVersionSnapshot(
  deps: DomainDeps,
  workspaceId: string,
  assetId: string,
): Promise<boolean> {
  const rows = await deps.db
    .select({ count: sql<number>`count(*)::int` })
    .from(projectVersions)
    .where(
      and(
        eq(projectVersions.workspaceId, workspaceId),
        // strpos 是纯子串匹配：资产 id 中的 `_` 不会像 LIKE 那样被当作通配符
        sql`strpos(${projectVersions.snapshot}::text, ${assetId}) > 0`,
      ),
    );
  return Number(rows[0]?.count ?? 0) > 0;
}

export async function isAssetReferencedByDerivation(deps: DomainDeps, workspaceId: string, assetId: string): Promise<boolean> {
  const rows = await deps.db.select({ count: sql<number>`count(*)::int` }).from(assetDerivationEdges).where(and(
    eq(assetDerivationEdges.workspaceId, workspaceId),
    eq(assetDerivationEdges.sourceAssetId, assetId),
  ));
  return Number(rows[0]?.count ?? 0) > 0;
}

/** 对象是否仍被其他版本行引用（去重共享时不得删除对象，§26.3）。 */
async function storageKeyStillReferenced(deps: DomainDeps, key: string, excludedVersionIds: string[]): Promise<boolean> {
  const rows = await deps.db
    .select({ count: sql<number>`count(*)::int` })
    .from(assetVersions)
    .where(
      excludedVersionIds.length === 0
        ? eq(assetVersions.storageKey, key)
        : and(eq(assetVersions.storageKey, key), notInArray(assetVersions.id, excludedVersionIds)),
    );
  return Number(rows[0]?.count ?? 0) > 0;
}

interface ObjectDisposition {
  deleted: number;
  kept: number;
}

async function deleteObjectsForKey(
  deps: DomainDeps,
  keys: string[],
  excludedVersionIds: string[],
): Promise<ObjectDisposition> {
  const storage = requireStorage(deps);
  const disposition: ObjectDisposition = { deleted: 0, kept: 0 };
  for (const key of new Set(keys)) {
    if (await storageKeyStillReferenced(deps, key, excludedVersionIds)) {
      disposition.kept += 1;
      continue;
    }
    const probe = await storage.probeObject(key);
    if (!probe.exists) continue;
    await storage.deleteObject(key);
    disposition.deleted += 1;
  }
  return disposition;
}

/** ---------- 清理流程（可重入） ---------- */

export async function runRetentionSweep(
  deps: DomainDeps,
  options: { now?: Date; limit?: number } = {},
): Promise<RetentionSweepReport> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 100;
  const trashDays = deps.retention?.trashRetentionDays ?? TRASH_RETENTION_DAYS;
  const idempotencyTtlHours = deps.retention?.idempotencyKeyTtlHours ?? DEFAULT_IDEMPOTENCY_KEY_TTL_HOURS;
  const artifactQuarantineTtlHours = deps.retention?.proposalArtifactQuarantineTtlHours ?? DEFAULT_PROPOSAL_ARTIFACT_QUARANTINE_TTL_HOURS;
  const proposalTrialTtlHours = deps.retention?.proposalTrialTtlHours ?? DEFAULT_PROPOSAL_TRIAL_TTL_HOURS;
  const trashCutoff = new Date(now.getTime() - trashDays * 24 * 60 * 60 * 1000);
  const artifactCutoff = new Date(now.getTime() - artifactQuarantineTtlHours * 60 * 60 * 1000);
  const trialCutoff = new Date(now.getTime() - proposalTrialTtlHours * 60 * 60 * 1000);

  const report: RetentionSweepReport = {
    ranAt: now.toISOString(),
    projectsPurged: 0,
    projectAssetsPurged: 0,
    trashAssetsPurged: 0,
    retentionAssetsPurged: 0,
    assetsSkippedByReference: 0,
    assetsFailed: 0,
    failures: [],
    uploadIntentsExpired: 0,
    idempotencyKeysPurged: 0,
    proposalArtifactsPurged: 0,
    proposalArtifactsKeptBound: 0,
    proposalTrialCachePurged: 0,
    objectsDeleted: 0,
    objectsKeptShared: 0,
    orphanObjectsDeleted: 0,
  };

  /**
   * 硬删单个资产（引用保护 + 共享对象保护），返回 'purged' | 'skipped' | 'missing' | 'failed'。
   * - 引用检查与删除在**同一事务**内、锁定资产行之后执行（检查与删除之间不留 TOCTOU 窗口）；
   * - 外键仍有引用（如审计用的 relink 记录、未来新增的引用表）→ 计为跳过，绝不让整轮清理中断；
   * - 其他异常只影响这一条（计入 assetsFailed），下一条继续——队头的一条坏数据不能永久阻塞后续清理（含隐私删除）。
   */
  async function purgeAssetRow(assetRow: typeof assets.$inferSelect): Promise<'purged' | 'skipped' | 'missing' | 'failed'> {
    try {
      const versionRows = await deps.db
        .select({ id: assetVersions.id, storageKey: assetVersions.storageKey })
        .from(assetVersions)
        .where(eq(assetVersions.assetId, assetRow.id));
      const versionIds = versionRows.map((row) => row.id);
      const keys = versionRows.map((row) => row.storageKey);

      const outcome = await deps.db.transaction(async (tx): Promise<'purged' | 'skipped' | 'missing'> => {
        await tx.execute(sql`select id from assets where id = ${assetRow.id} for update`);
        const fresh = await tx.select({ id: assets.id }).from(assets).where(eq(assets.id, assetRow.id)).limit(1);
        if (fresh.length === 0) return 'missing'; // 已被其他清理进程处理（幂等）
        if (await isAssetReferenced({ ...deps, db: tx }, assetRow.workspaceId, assetRow.id)) return 'skipped';
        await tx.delete(assets).where(eq(assets.id, assetRow.id));
        return 'purged';
      });
      if (outcome !== 'purged') return outcome;

      const disposition = await deleteObjectsForKey(deps, keys, versionIds);
      report.objectsDeleted += disposition.deleted;
      report.objectsKeptShared += disposition.kept;
      return 'purged';
    } catch (error) {
      if (isForeignKeyViolation(error)) return 'skipped';
      report.assetsFailed += 1;
      if (report.failures.length < 20) {
        report.failures.push({ assetId: assetRow.id, reason: error instanceof Error ? error.name : 'UNKNOWN' });
      }
      return 'failed';
    }
  }

  // 1) 幂等键 TTL（先做：无引用关系，纯时间清理）
  const idempotencyCutoff = new Date(now.getTime() - idempotencyTtlHours * 60 * 60 * 1000);
  const purgedKeys = await deps.db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, idempotencyCutoff))
    .returning({ id: idempotencyKeys.id });
  report.idempotencyKeysPurged = purgedKeys.length;

  // 2) 过期上传意图（PENDING 且已过期）：标记 EXPIRED；未完成版本置 FAILED 并清理孤儿对象
  const expiredIntents = await deps.db
    .select()
    .from(uploadIntents)
    .where(and(eq(uploadIntents.status, 'PENDING'), lt(uploadIntents.expiresAt, now)))
    .orderBy(asc(uploadIntents.createdAt))
    .limit(limit);
  for (const intent of expiredIntents) {
    const outcome = await deps.db.transaction(async (tx) => {
      await tx.execute(sql`select id from upload_intents where id = ${intent.id} for update`);
      const freshRows = await tx.select().from(uploadIntents).where(eq(uploadIntents.id, intent.id)).limit(1);
      const fresh = freshRows[0];
      if (!fresh || fresh.status !== 'PENDING') return null;
      await tx.update(uploadIntents).set({ status: 'EXPIRED' }).where(eq(uploadIntents.id, intent.id));
      const versionRows = await tx.select().from(assetVersions).where(eq(assetVersions.id, intent.assetVersionId)).limit(1);
      const version = versionRows[0];
      if (!version || version.status !== 'UPLOADING') return null; // 已完成/已失败：不动对象
      await tx.update(assetVersions).set({ status: 'FAILED', metadata: { failureReason: 'INTENT_EXPIRED' } }).where(eq(assetVersions.id, version.id));
      await tx
        .update(assets)
        .set({ status: 'FAILED', updatedAt: now })
        .where(and(eq(assets.id, intent.assetId), eq(assets.status, 'PENDING_UPLOAD')));
      return { key: version.storageKey };
    });
    if (outcome === null) continue;
    report.uploadIntentsExpired += 1;
    const disposition = await deleteObjectsForKey(deps, [outcome.key], [intent.assetVersionId]);
    report.orphanObjectsDeleted += disposition.deleted;
    report.objectsKeptShared += disposition.kept;
  }

  // 3) 过期 Trash 项目：整体硬删（scenes/versions/events 级联），其资产随后单独清理
  const trashedProjects = await deps.db
    .select()
    .from(projects)
    .where(and(isNotNull(projects.deletedAt), lt(projects.deletedAt, trashCutoff)))
    .orderBy(asc(projects.deletedAt))
    .limit(limit);
  for (const project of trashedProjects) {
    const projectAssetRows = await deps.db
      .select()
      .from(assets)
      .where(and(eq(assets.workspaceId, project.workspaceId), eq(assets.projectId, project.id)));
    const removed = await deps.db.transaction(async (tx) => {
      await tx.execute(sql`select id from projects where id = ${project.id} for update`);
      const fresh = await tx.select({ id: projects.id, deletedAt: projects.deletedAt }).from(projects).where(eq(projects.id, project.id)).limit(1);
      const row = fresh[0];
      if (!row || row.deletedAt === null || row.deletedAt.getTime() > trashCutoff.getTime()) return false;
      await tx.delete(projects).where(eq(projects.id, project.id));
      return true;
    });
    if (!removed) continue;
    report.projectsPurged += 1;

    // 项目资产：随项目清理（引用保护仍然生效——例如同一资产被其他项目 Scene 绑定）
    for (const assetRow of projectAssetRows) {
      const outcome = await purgeAssetRow(assetRow);
      if (outcome === 'purged') report.projectAssetsPurged += 1;
      if (outcome === 'skipped') report.assetsSkippedByReference += 1;
    }
  }

  /**
   * 资产候选的分页扫描：已跳过/失败的行在本轮内排除后继续往后取，
   * 避免"排在最前、但被引用或损坏的若干行"让后面所有到期资产（含隐私删除）永远轮不到。
   * 每步最多硬删 `limit` 条、最多检查 `limit × 10` 条。
   */
  const maxScanPerStep = limit * 10;
  async function sweepAssets(where: SQL, orderBy: SQL[], onPurged: () => void): Promise<void> {
    const passed: string[] = [];
    let purged = 0;
    while (purged < limit && passed.length < maxScanPerStep) {
      const rows = await deps.db
        .select()
        .from(assets)
        .where(passed.length === 0 ? where : and(where, notInArray(assets.id, passed)))
        .orderBy(...orderBy)
        .limit(limit - purged);
      if (rows.length === 0) break;
      for (const assetRow of rows) {
        const outcome = await purgeAssetRow(assetRow);
        if (outcome === 'purged') {
          purged += 1;
          onPurged();
        } else {
          passed.push(assetRow.id);
          if (outcome === 'skipped') report.assetsSkippedByReference += 1;
        }
      }
    }
  }

  // 4) 显式隐私删除：无引用时无需等待普通 Trash TTL；有引用时保留原件并继续报告跳过。
  await sweepAssets(
    and(isNotNull(assets.deletedAt), isNotNull(assets.privacyDeletionRequestedAt))!,
    [asc(assets.privacyDeletionRequestedAt), asc(assets.id)],
    () => { report.trashAssetsPurged += 1; },
  );

  // 5) Trash 到期资产
  await sweepAssets(
    and(isNotNull(assets.deletedAt), lt(assets.deletedAt, trashCutoff))!,
    [asc(assets.deletedAt), asc(assets.id)],
    () => { report.trashAssetsPurged += 1; },
  );

  // 6) 保留类 TTL 到期资产（未进 Trash 的缓存类，如 DRAFT_RENDER_30D）。
  //    按保留类把到期条件下推到 SQL：永久类（KEEP_*）不再占用扫描窗口。
  const ttlConditions = (Object.entries(RETENTION_TTL_SECONDS) as [RetentionClass, number | null][])
    .filter((entry): entry is [RetentionClass, number] => entry[1] !== null)
    .map(([retentionClass, ttlSeconds]) => and(
      eq(assets.retentionClass, retentionClass),
      lte(assets.createdAt, new Date(now.getTime() - ttlSeconds * 1000)),
    ));
  if (ttlConditions.length > 0) {
    await sweepAssets(
      and(isNull(assets.deletedAt), or(...ttlConditions))!,
      [asc(assets.createdAt), asc(assets.id)],
      () => { report.retentionAssetsPurged += 1; },
    );
  }

  // 7) N06-06 隔离产物：`bound=false` 的孤儿行按保留期清理；`bound=true`（已接受结果）保留。
  const purgedArtifacts = await deps.db.delete(proposalArtifacts).where(and(
    eq(proposalArtifacts.bound, false), lt(proposalArtifacts.createdAt, artifactCutoff),
  )).returning({ id: proposalArtifacts.id });
  report.proposalArtifactsPurged = purgedArtifacts.length;
  // 8) N06-04 过期的局部试片缓存（依赖键失效为主，这里是容量与陈旧性清理）
  const purgedTrials = await deps.db.delete(proposalTrials).where(lt(proposalTrials.createdAt, trialCutoff)).returning({ dependencyKey: proposalTrials.dependencyKey });
  report.proposalTrialCachePurged = purgedTrials.length;
  const boundArtifacts = await deps.db.select({ id: proposalArtifacts.id }).from(proposalArtifacts).where(eq(proposalArtifacts.bound, true));
  report.proposalArtifactsKeptBound = boundArtifacts.length;

  return report;
}

/** 便捷查询：Trash 中的项目/资产（列表接口用；workspace 作用域）。 */
export async function listTrashedProjects(deps: DomainDeps, workspaceId: string): Promise<Project[]> {
  const rows = await deps.db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), isNotNull(projects.deletedAt)))
    .orderBy(asc(projects.deletedAt));
  return rows.map(toProjectDto);
}

export async function listTrashedAssets(deps: DomainDeps, workspaceId: string): Promise<Asset[]> {
  const rows = await deps.db
    .select()
    .from(assets)
    .where(and(eq(assets.workspaceId, workspaceId), isNotNull(assets.deletedAt)))
    .orderBy(asc(assets.deletedAt));
  return rows.map(toAssetDto);
}
