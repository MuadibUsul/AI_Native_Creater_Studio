import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ASSET_RELINK_ERROR_REASONS,
  ERROR_CODES,
  applyAssetRelinkRequestSchema,
  assetRelinkComparisonSchema,
  assetRelinkResultSchema,
  assetRelinkStateSchema,
  preflightAssetRelinkRequestSchema,
  sourceMediaProbeResultSchema,
  type AssetRelinkComparison,
  type AssetRelinkState,
  type AssetRelinkTrack,
} from '@ancs/contracts';
import {
  assetDerivationEdges,
  assetRelinks,
  assetVersions,
  assets,
  mediaDerivatives,
  projects,
  scenes,
  sequenceClips,
} from '@ancs/db';
import type { DomainDeps } from './channels.js';

const id = (prefix: string): string => `${prefix}_${randomUUID()}`;

function requireStorage(deps: DomainDeps) {
  if (deps.storage === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'object storage is not configured', 500);
  return deps.storage;
}

function tracksOf(version: typeof assetVersions.$inferSelect): AssetRelinkTrack[] {
  const parsed = sourceMediaProbeResultSchema.safeParse(version.mediaProbe);
  if (!parsed.success) return [];
  return parsed.data.streams.map((stream) => ({
    type: stream.type,
    codecName: stream.codecName,
    width: stream.width,
    height: stream.height,
    channels: stream.channels,
    sampleRate: stream.sampleRate,
  }));
}

function bindingsContainAsset(value: unknown, assetId: string): boolean {
  return Array.isArray(value) && value.some((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    return (entry as { assetId?: unknown }).assetId === assetId;
  });
}

async function referencedProjects(deps: DomainDeps, workspaceId: string, assetId: string, versionId: string): Promise<{ clipCount: number; projectIds: string[] }> {
  const clips = await deps.db.select({ projectId: sequenceClips.projectId }).from(sequenceClips).where(and(
    eq(sequenceClips.workspaceId, workspaceId), eq(sequenceClips.assetVersionId, versionId),
  ));
  const sceneRows = await deps.db.select({ projectId: scenes.projectId, assetBindings: scenes.assetBindings }).from(scenes).where(eq(scenes.workspaceId, workspaceId));
  const projectIds = new Set(clips.map((row) => row.projectId));
  for (const row of sceneRows) if (bindingsContainAsset(row.assetBindings, assetId)) projectIds.add(row.projectId);
  return { clipCount: clips.length, projectIds: [...projectIds].sort() };
}

async function loadTarget(deps: DomainDeps, workspaceId: string, assetId: string, versionId: string) {
  const rows = await deps.db.select({ asset: assets, version: assetVersions }).from(assets)
    .innerJoin(assetVersions, eq(assetVersions.assetId, assets.id))
    .where(and(
      eq(assets.id, assetId), eq(assets.workspaceId, workspaceId), isNull(assets.deletedAt),
      eq(assetVersions.id, versionId), eq(assetVersions.workspaceId, workspaceId), isNull(assetVersions.deletedAt),
    )).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, '重新链接的目标版本不存在', 404, { reason: ASSET_RELINK_ERROR_REASONS.TARGET_VERSION_NOT_FOUND });
  return row;
}

async function loadCandidate(deps: DomainDeps, workspaceId: string, candidateAssetId: string) {
  const rows = await deps.db.select({ asset: assets, version: assetVersions }).from(assets)
    .innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(
      eq(assets.id, candidateAssetId), eq(assets.workspaceId, workspaceId), isNull(assets.deletedAt),
      eq(assetVersions.workspaceId, workspaceId), isNull(assetVersions.deletedAt),
    )).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, '候选素材不存在', 404);
  if (row.asset.status !== 'READY' || row.version.status !== 'READY' || row.version.checksumSha256 === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '候选素材尚未完成上传和媒体探测', 409, { reason: ASSET_RELINK_ERROR_REASONS.CANDIDATE_NOT_READY });
  }
  const probe = await requireStorage(deps).probeObject(row.version.storageKey);
  if (!probe.exists) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '候选素材对象缺失', 409, { reason: ASSET_RELINK_ERROR_REASONS.CANDIDATE_OBJECT_MISSING });
  const actualChecksum = await requireStorage(deps).computeObjectSha256(row.version.storageKey);
  if (actualChecksum === null || actualChecksum !== row.version.checksumSha256) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '候选素材内容已变化，请重新上传', 409, { reason: ASSET_RELINK_ERROR_REASONS.CANDIDATE_CHANGED });
  }
  return row;
}

export async function getAssetRelinkState(deps: DomainDeps, input: { workspaceId: string; assetId: string }): Promise<AssetRelinkState> {
  const assetRows = await deps.db.select().from(assets).where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId), isNull(assets.deletedAt))).limit(1);
  const asset = assetRows[0];
  if (asset === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset not found', 404);
  const versions = await deps.db.select().from(assetVersions).where(and(
    eq(assetVersions.assetId, input.assetId), eq(assetVersions.workspaceId, input.workspaceId), isNull(assetVersions.deletedAt),
  )).orderBy(desc(assetVersions.versionNumber));
  const states = await Promise.all(versions.map(async (version) => {
    const [object, references] = await Promise.all([
      requireStorage(deps).probeObject(version.storageKey),
      deps.db.select({ id: sequenceClips.id }).from(sequenceClips).where(and(eq(sequenceClips.workspaceId, input.workspaceId), eq(sequenceClips.assetVersionId, version.id))),
    ]);
    return {
      assetVersionId: version.id,
      versionNumber: version.versionNumber,
      current: asset.currentVersionId === version.id,
      availability: object.exists ? 'AVAILABLE' as const : 'MISSING' as const,
      checksumSha256: version.checksumSha256,
      durationMs: version.durationMs,
      tracks: tracksOf(version),
      activeClipReferences: references.length,
    };
  }));
  return assetRelinkStateSchema.parse({ assetId: asset.id, versions: states });
}

export async function preflightAssetRelink(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; request: unknown },
): Promise<AssetRelinkComparison> {
  const request = preflightAssetRelinkRequestSchema.parse(input.request);
  const target = await loadTarget(deps, input.workspaceId, input.assetId, request.targetVersionId);
  if ((await requireStorage(deps).probeObject(target.version.storageKey)).exists) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '目标原件仍可用，无需重新链接', 409, { reason: ASSET_RELINK_ERROR_REASONS.TARGET_OBJECT_STILL_AVAILABLE });
  }
  const candidate = await loadCandidate(deps, input.workspaceId, request.candidateAssetId);
  const checksumMatches = target.version.checksumSha256 !== null && target.version.checksumSha256 === candidate.version.checksumSha256;
  const targetTracks = tracksOf(target.version);
  const candidateTracks = tracksOf(candidate.version);
  const mediaCandidate = candidate.version.mimeType.startsWith('video/') || candidate.version.mimeType.startsWith('audio/');
  if (!checksumMatches && mediaCandidate && (target.version.probeStatus !== 'READY' || candidate.version.probeStatus !== 'READY')) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '替代文件必须先完成原件和候选的媒体探测', 409, { reason: ASSET_RELINK_ERROR_REASONS.MEDIA_PROBE_REQUIRED });
  }
  const refs = await referencedProjects(deps, input.workspaceId, input.assetId, target.version.id);
  const deltaMs = target.version.durationMs === null || candidate.version.durationMs === null ? null : candidate.version.durationMs - target.version.durationMs;
  return assetRelinkComparisonSchema.parse({
    mode: checksumMatches ? 'EXACT_RESTORE' : 'REPLACEMENT',
    targetVersionId: target.version.id,
    candidateAssetId: candidate.asset.id,
    candidateVersionId: candidate.version.id,
    candidateChecksumSha256: candidate.version.checksumSha256,
    checksumMatches,
    duration: {
      targetMs: target.version.durationMs,
      candidateMs: candidate.version.durationMs,
      deltaMs,
      matches: target.version.durationMs === candidate.version.durationMs,
    },
    tracks: { target: targetTracks, candidate: candidateTracks, matches: JSON.stringify(targetTracks) === JSON.stringify(candidateTracks) },
    activeClipReferences: refs.clipCount,
    affectedProjectIds: refs.projectIds,
    confirmationText: checksumMatches ? '恢复原件' : '确认替换',
    reviewRequired: !checksumMatches,
  });
}

export async function applyAssetRelink(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; userId: string | null; request: unknown },
) {
  const request = applyAssetRelinkRequestSchema.parse(input.request);
  const comparison = await preflightAssetRelink(deps, {
    workspaceId: input.workspaceId,
    assetId: input.assetId,
    request: { targetVersionId: request.targetVersionId, candidateAssetId: request.candidateAssetId },
  });
  if (request.expectedCandidateChecksumSha256 !== comparison.candidateChecksumSha256) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '候选文件在确认前已变化，请重新校验', 409, { reason: ASSET_RELINK_ERROR_REASONS.CANDIDATE_CHANGED });
  }
  if (request.confirmationText !== comparison.confirmationText) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `请输入“${comparison.confirmationText}”确认`, 422, { reason: ASSET_RELINK_ERROR_REASONS.CONFIRMATION_MISMATCH });
  }
  const target = await loadTarget(deps, input.workspaceId, input.assetId, comparison.targetVersionId);
  const candidate = await loadCandidate(deps, input.workspaceId, comparison.candidateAssetId);
  const relinkId = id('arl');
  let createdVersionId: string | null = null;

  if (comparison.mode === 'EXACT_RESTORE') {
    const storage = requireStorage(deps);
    if (storage.copyObject === undefined) throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '当前对象存储不支持原件内部复制', 501, { reason: ASSET_RELINK_ERROR_REASONS.STORAGE_COPY_UNAVAILABLE });
    await storage.copyObject({ sourceKey: candidate.version.storageKey, destinationKey: target.version.storageKey });
    const restoredChecksum = await storage.computeObjectSha256(target.version.storageKey);
    if (restoredChecksum !== comparison.candidateChecksumSha256) {
      await storage.deleteObject(target.version.storageKey).catch(() => undefined);
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '恢复后的原件校验失败', 409, { reason: ASSET_RELINK_ERROR_REASONS.CANDIDATE_CHANGED });
    }
    await deps.db.insert(assetRelinks).values({
      id: relinkId, workspaceId: input.workspaceId, assetId: input.assetId,
      targetVersionId: target.version.id, candidateAssetId: candidate.asset.id, candidateVersionId: candidate.version.id,
      action: 'EXACT_RESTORE', candidateChecksumSha256: comparison.candidateChecksumSha256,
      validation: comparison, activeClipReferencesPreserved: comparison.activeClipReferences,
      reviewRequired: false, createdBy: input.userId,
    });
  } else {
    createdVersionId = id('av');
    await deps.db.transaction(async (tx) => {
      await tx.execute(sql`select id from assets where id = ${input.assetId} and workspace_id = ${input.workspaceId} for update`);
      const latestRows = await tx.select({ versionNumber: assetVersions.versionNumber }).from(assetVersions)
        .where(and(eq(assetVersions.assetId, input.assetId), eq(assetVersions.workspaceId, input.workspaceId)))
        .orderBy(desc(assetVersions.versionNumber)).limit(1);
      const versionNumber = (latestRows[0]?.versionNumber ?? 0) + 1;
      await tx.insert(assetVersions).values({
        id: createdVersionId as string, assetId: input.assetId, workspaceId: input.workspaceId, versionNumber,
        storageKey: candidate.version.storageKey, mimeType: candidate.version.mimeType, sizeBytes: candidate.version.sizeBytes,
        checksumSha256: candidate.version.checksumSha256, durationMs: candidate.version.durationMs,
        width: candidate.version.width, height: candidate.version.height, status: 'READY',
        probeStatus: candidate.version.probeStatus, mediaProbe: candidate.version.mediaProbe,
        metadata: { ...(candidate.version.metadata as Record<string, unknown>), relink: { targetVersionId: target.version.id, candidateAssetId: candidate.asset.id, candidateVersionId: candidate.version.id } },
      });
      await tx.update(assets).set({ currentVersionId: createdVersionId, status: 'READY', updatedAt: new Date() })
        .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId)));
      await tx.insert(assetDerivationEdges).values([
        { id: id('ade'), workspaceId: input.workspaceId, sourceAssetId: target.asset.id, sourceAssetVersionId: target.version.id, derivedAssetId: target.asset.id, derivedAssetVersionId: createdVersionId as string, kind: 'MEDIA_RELINK_REPLACEMENT' },
        { id: id('ade'), workspaceId: input.workspaceId, sourceAssetId: candidate.asset.id, sourceAssetVersionId: candidate.version.id, derivedAssetId: target.asset.id, derivedAssetVersionId: createdVersionId as string, kind: 'MEDIA_RELINK_CANDIDATE' },
      ]);
      const derivatives = await tx.select().from(mediaDerivatives).where(and(eq(mediaDerivatives.workspaceId, input.workspaceId), eq(mediaDerivatives.sourceAssetVersionId, candidate.version.id)));
      if (derivatives.length > 0) {
        await tx.insert(mediaDerivatives).values(derivatives.map((row) => ({
          id: id('mdv'), workspaceId: input.workspaceId, sourceAssetVersionId: createdVersionId as string,
          kind: row.kind, profileKey: row.profileKey, status: row.status,
          derivativeAssetVersionId: row.derivativeAssetVersionId, sourceChecksumSha256: row.sourceChecksumSha256,
          metadata: { ...(row.metadata as Record<string, unknown>), relinkSourceVersionId: candidate.version.id }, errorSummary: row.errorSummary,
        })));
      }
      const affectedScenes = await tx.select({ id: scenes.id, projectId: scenes.projectId, assetBindings: scenes.assetBindings }).from(scenes)
        .where(and(eq(scenes.workspaceId, input.workspaceId), inArray(scenes.projectId, comparison.affectedProjectIds.length > 0 ? comparison.affectedProjectIds : ['__none__'])));
      const sceneIds = affectedScenes.filter((row) => bindingsContainAsset(row.assetBindings, input.assetId)).map((row) => row.id);
      if (sceneIds.length > 0) await tx.update(scenes).set({ needsReview: true, revision: sql`${scenes.revision} + 1`, updatedAt: new Date() }).where(inArray(scenes.id, sceneIds));
      if (comparison.affectedProjectIds.length > 0) await tx.update(projects).set({ revision: sql`${projects.revision} + 1`, updatedAt: new Date() }).where(and(eq(projects.workspaceId, input.workspaceId), inArray(projects.id, comparison.affectedProjectIds)));
      await tx.insert(assetRelinks).values({
        id: relinkId, workspaceId: input.workspaceId, assetId: input.assetId,
        targetVersionId: target.version.id, candidateAssetId: candidate.asset.id, candidateVersionId: candidate.version.id,
        action: 'REPLACEMENT', candidateChecksumSha256: comparison.candidateChecksumSha256,
        validation: comparison, createdVersionId, activeClipReferencesPreserved: comparison.activeClipReferences,
        reviewRequired: true, createdBy: input.userId,
      });
    });
  }
  const state = await getAssetRelinkState(deps, { workspaceId: input.workspaceId, assetId: input.assetId });
  return assetRelinkResultSchema.parse({
    relinkId, assetId: input.assetId, action: comparison.mode,
    restoredVersionId: target.version.id, createdVersionId,
    activeClipReferencesPreserved: comparison.activeClipReferences,
    reviewRequired: comparison.reviewRequired, state,
  });
}
