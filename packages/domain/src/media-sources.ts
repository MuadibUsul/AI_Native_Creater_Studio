import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  clipInstanceViewSchema,
  legacyClipProjectionSchema,
  legacyMillisecondsToMediaTime,
  mediaDerivativeSchema,
  mediaSourceViewSchema,
  mediaTimeToLegacyMilliseconds,
  type ClipInstanceView,
  type EditOperation,
  type LegacyClipProjection,
  type MediaDerivative,
  type MediaSourceView,
} from '@ancs/contracts';
import { assetVersions, assets, mediaDerivatives, projects, sequenceClips } from '@ancs/db';
import type { DomainDeps } from './deps.js';

const toDerivative = (row: typeof mediaDerivatives.$inferSelect): MediaDerivative => mediaDerivativeSchema.parse({
  id: row.id,
  sourceAssetVersionId: row.sourceAssetVersionId,
  kind: row.kind,
  profileKey: row.profileKey,
  status: row.status,
  derivativeAssetVersionId: row.derivativeAssetVersionId,
  sourceChecksumSha256: row.sourceChecksumSha256,
  metadata: row.metadata,
  errorSummary: row.errorSummary,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function listProjectMediaViews(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<{ mediaSources: MediaSourceView[]; clipInstances: ClipInstanceView[] }> {
  const project = await deps.db.select({ id: projects.id }).from(projects).where(and(
    eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId),
  )).limit(1);
  if (!project[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  const clips = await deps.db.select().from(sequenceClips).where(and(
    eq(sequenceClips.workspaceId, input.workspaceId), eq(sequenceClips.projectId, input.projectId),
  ));
  const versionIds = [...new Set(clips.flatMap((clip) => clip.assetVersionId === null ? [] : [clip.assetVersionId]))];
  const versionRows = versionIds.length === 0 ? [] : await deps.db.select({ version: assetVersions, asset: assets })
    .from(assetVersions)
    .innerJoin(assets, eq(assetVersions.assetId, assets.id))
    .where(and(eq(assetVersions.workspaceId, input.workspaceId), inArray(assetVersions.id, versionIds)));
  const derivativeRows = versionIds.length === 0 ? [] : await deps.db.select().from(mediaDerivatives).where(and(
    eq(mediaDerivatives.workspaceId, input.workspaceId), inArray(mediaDerivatives.sourceAssetVersionId, versionIds),
  ));
  const derivativeMap = new Map<string, MediaDerivative[]>();
  for (const row of derivativeRows) derivativeMap.set(row.sourceAssetVersionId, [...(derivativeMap.get(row.sourceAssetVersionId) ?? []), toDerivative(row)]);
  const mediaSources = versionRows.map(({ version, asset }) => mediaSourceViewSchema.parse({
    id: version.id,
    workspaceId: version.workspaceId,
    assetId: asset.id,
    sourceAssetVersionId: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    checksumSha256: version.checksumSha256,
    mimeType: version.mimeType,
    sizeBytes: version.sizeBytes,
    duration: version.durationMs === null ? null : legacyMillisecondsToMediaTime(version.durationMs),
    width: version.width,
    height: version.height,
    mediaMetadata: version.metadata,
    derivatives: (derivativeMap.get(version.id) ?? []).sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.profileKey.localeCompare(right.profileKey) || left.id.localeCompare(right.id)),
    createdAt: version.createdAt.toISOString(),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const clipInstances = clips.map((clip) => clipInstanceViewSchema.parse({
    id: clip.id,
    clipId: clip.id,
    projectId: clip.projectId,
    sequenceId: clip.sequenceId,
    trackId: clip.trackId,
    sourceKind: clip.assetVersionId === null ? 'NESTED_SEQUENCE' : 'MEDIA_SOURCE',
    sourceId: clip.assetVersionId ?? clip.nestedSequenceId,
    sourceStreamId: clip.sourceStreamId,
    sourceRange: clip.sourceRange,
    sequenceRange: clip.sequenceRange,
    timeMapping: clip.timeMapping,
    avGroupId: clip.avGroupId,
    parentClipId: clip.parentClipId,
  })).sort((left, right) => left.id.localeCompare(right.id));
  return { mediaSources, clipInstances };
}

export async function upsertMediaDerivativeState(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    sourceAssetVersionId: string;
    kind: MediaDerivative['kind'];
    profileKey: string;
    status: MediaDerivative['status'];
    derivativeAssetVersionId?: string | null;
    metadata?: Record<string, unknown>;
    errorSummary?: string | null;
  },
): Promise<MediaDerivative> {
  const parsed = mediaDerivativeSchema.pick({ kind: true, profileKey: true, status: true }).extend({
    derivativeAssetVersionId: mediaDerivativeSchema.shape.derivativeAssetVersionId.optional(),
    metadata: mediaDerivativeSchema.shape.metadata.optional(),
    errorSummary: mediaDerivativeSchema.shape.errorSummary.optional(),
  }).parse({
    kind: input.kind,
    profileKey: input.profileKey,
    status: input.status,
    derivativeAssetVersionId: input.derivativeAssetVersionId,
    metadata: input.metadata,
    errorSummary: input.errorSummary,
  });
  if (parsed.kind === 'PROXY' && parsed.status === 'READY' && parsed.derivativeAssetVersionId == null) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'ready proxy requires a derivative asset version', 422, { reason: 'PROXY_OUTPUT_REQUIRED' });
  }
  if (parsed.derivativeAssetVersionId === input.sourceAssetVersionId) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'derivative output must differ from the source version', 422, { reason: 'DERIVATIVE_SOURCE_ALIAS' });
  }
  return deps.db.transaction(async (tx) => {
    const sourceRows = await tx.select().from(assetVersions).where(and(
      eq(assetVersions.id, input.sourceAssetVersionId), eq(assetVersions.workspaceId, input.workspaceId),
    )).limit(1).for('share');
    const source = sourceRows[0];
    if (!source) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'source asset version not found', 404);
    if (source.status !== 'READY' || source.checksumSha256 === null) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source asset version is not ready with an immutable checksum', 409, { reason: 'SOURCE_NOT_IMMUTABLE' });
    }
    if (parsed.derivativeAssetVersionId != null) {
      const output = await tx.select({
        id: assetVersions.id,
        status: assetVersions.status,
        checksumSha256: assetVersions.checksumSha256,
      }).from(assetVersions).where(and(
        eq(assetVersions.id, parsed.derivativeAssetVersionId), eq(assetVersions.workspaceId, input.workspaceId),
      )).limit(1);
      if (!output[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'derivative asset version not found', 404);
      if (parsed.status === 'READY' && (output[0].status !== 'READY' || output[0].checksumSha256 === null)) {
        throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'ready derivative requires a ready output with an immutable checksum', 409, { reason: 'DERIVATIVE_OUTPUT_NOT_READY' });
      }
    }
    const existing = await tx.select({ sourceChecksumSha256: mediaDerivatives.sourceChecksumSha256 })
      .from(mediaDerivatives).where(and(
        eq(mediaDerivatives.sourceAssetVersionId, source.id),
        eq(mediaDerivatives.kind, parsed.kind),
        eq(mediaDerivatives.profileKey, parsed.profileKey),
      )).limit(1);
    if (existing[0] && existing[0].sourceChecksumSha256 !== source.checksumSha256) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source checksum changed after derivative tracking began', 409, { reason: 'SOURCE_CHECKSUM_CHANGED' });
    }
    const now = new Date();
    const rows = await tx.insert(mediaDerivatives).values({
      id: `mdr_${randomUUID()}`,
      workspaceId: input.workspaceId,
      sourceAssetVersionId: source.id,
      kind: parsed.kind,
      profileKey: parsed.profileKey,
      status: parsed.status,
      derivativeAssetVersionId: parsed.derivativeAssetVersionId ?? null,
      sourceChecksumSha256: source.checksumSha256,
      metadata: parsed.metadata ?? {},
      errorSummary: parsed.errorSummary ?? null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [mediaDerivatives.sourceAssetVersionId, mediaDerivatives.kind, mediaDerivatives.profileKey],
      set: {
        status: parsed.status,
        derivativeAssetVersionId: parsed.derivativeAssetVersionId ?? null,
        metadata: parsed.metadata ?? {},
        errorSummary: parsed.errorSummary ?? null,
        updatedAt: now,
      },
    }).returning();
    return toDerivative(rows[0]!);
  });
}

export function clipInstanceToLegacyProjection(instance: ClipInstanceView): LegacyClipProjection {
  try {
    return legacyClipProjectionSchema.parse({
      clipId: instance.clipId,
      assetVersionId: instance.sourceKind === 'MEDIA_SOURCE' ? instance.sourceId : null,
      nestedSequenceId: instance.sourceKind === 'NESTED_SEQUENCE' ? instance.sourceId : null,
      sourceInMs: mediaTimeToLegacyMilliseconds(instance.sourceRange.start),
      sourceOutMs: mediaTimeToLegacyMilliseconds(instance.sourceRange.end),
      sequenceStartMs: mediaTimeToLegacyMilliseconds(instance.sequenceRange.start),
      sequenceEndMs: mediaTimeToLegacyMilliseconds(instance.sequenceRange.end),
    });
  } catch (error) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'clip cannot be represented without precision loss in the legacy projection', 409, {
      reason: 'LEGACY_TIME_PRECISION_LOSS',
      clipId: instance.clipId,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Legacy input is compiled into the canonical edit protocol; it never writes AssetVersion facts. */
export function compileLegacyClipProjectionUpdate(
  current: ClipInstanceView,
  update: Omit<LegacyClipProjection, 'clipId' | 'assetVersionId' | 'nestedSequenceId'>,
): EditOperation {
  const parsed = legacyClipProjectionSchema.parse({
    ...update,
    clipId: current.clipId,
    assetVersionId: current.sourceKind === 'MEDIA_SOURCE' ? current.sourceId : null,
    nestedSequenceId: current.sourceKind === 'NESTED_SEQUENCE' ? current.sourceId : null,
  });
  return {
    op: 'update_clip',
    clipId: current.clipId,
    changes: {
      sourceRange: { start: legacyMillisecondsToMediaTime(parsed.sourceInMs), end: legacyMillisecondsToMediaTime(parsed.sourceOutMs) },
      sequenceRange: { start: legacyMillisecondsToMediaTime(parsed.sequenceStartMs), end: legacyMillisecondsToMediaTime(parsed.sequenceEndMs) },
      timeMapping: current.timeMapping,
    },
  };
}
