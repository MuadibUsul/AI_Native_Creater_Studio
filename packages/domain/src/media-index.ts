import { createHash } from 'node:crypto';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  MEDIA_INDEX_JOB_TYPE,
  MEDIA_INDEX_ANALYSIS_CONFIG_HASH,
  MEDIA_INDEX_PROCESSOR_VERSION,
  MEDIA_INDEX_VERSION,
  generatedMediaIndexSchema,
  mediaIndexJobInputSchema,
  mediaIndexPageSchema,
  sourceMediaProbeResultSchema,
  type GeneratedMediaIndex,
  type MediaIndexJobInput,
  type MediaIndexPage,
  type SourceMediaProbeResult,
} from '@ancs/contracts';
import { assetVersions, assets, mediaIndexEntries, mediaIndexRuns } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { createJobInTx } from './jobs.js';

type DomainTx = Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0];

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
}

export async function scheduleMediaIndexInTx(
  tx: DomainTx,
  input: {
    workspaceId: string;
    projectId: string | null;
    sourceAsset: typeof assets.$inferSelect;
    sourceVersion: typeof assetVersions.$inferSelect;
    probe: SourceMediaProbeResult;
  },
): Promise<{ scheduled: boolean; runId: string | null }> {
  const probe = sourceMediaProbeResultSchema.parse(input.probe);
  if (probe.status !== 'READY' || input.sourceVersion.checksumSha256 === null || input.sourceVersion.status !== 'READY') return { scheduled: false, runId: null };
  const hasMedia = probe.streams.some((stream) => stream.type === 'VIDEO' || stream.type === 'AUDIO');
  if (!hasMedia) return { scheduled: false, runId: null };
  const runId = stableId('mix', input.sourceVersion.id, MEDIA_INDEX_PROCESSOR_VERSION);
  const now = new Date();
  const inserted = await tx.insert(mediaIndexRuns).values({
    id: runId,
    workspaceId: input.workspaceId,
    sourceAssetVersionId: input.sourceVersion.id,
    sourceChecksumSha256: input.sourceVersion.checksumSha256,
    processorVersion: MEDIA_INDEX_PROCESSOR_VERSION,
    analysisConfigHash: MEDIA_INDEX_ANALYSIS_CONFIG_HASH,
    indexVersion: MEDIA_INDEX_VERSION,
    toolId: 'ffmpeg',
    toolVersion: MEDIA_INDEX_PROCESSOR_VERSION,
    supportedKinds: ['THUMBNAIL', 'WAVEFORM', 'SHOT_BOUNDARY', 'QUALITY'],
    status: 'QUEUED',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({ target: [mediaIndexRuns.sourceAssetVersionId, mediaIndexRuns.processorVersion] }).returning({ id: mediaIndexRuns.id });
  if (inserted[0] === undefined) return { scheduled: false, runId };
  const jobInput = mediaIndexJobInputSchema.parse({
    runId,
    sourceAssetId: input.sourceAsset.id,
    sourceAssetVersionId: input.sourceVersion.id,
    sourceStorageKey: input.sourceVersion.storageKey,
    sourceChecksumSha256: input.sourceVersion.checksumSha256,
    processorVersion: MEDIA_INDEX_PROCESSOR_VERSION,
    analysisConfigHash: MEDIA_INDEX_ANALYSIS_CONFIG_HASH,
    indexVersion: MEDIA_INDEX_VERSION,
  });
  await createJobInTx(tx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    type: MEDIA_INDEX_JOB_TYPE,
    input: jobInput,
    maxAttempts: 2,
    createdBy: input.sourceAsset.createdBy,
    classification: 'SYSTEM',
  });
  return { scheduled: true, runId };
}

export async function beginMediaIndex(
  deps: DomainDeps,
  input: { workspaceId: string; jobInput: MediaIndexJobInput },
): Promise<{ alreadyComplete: boolean; sourceProbe: SourceMediaProbeResult }> {
  const jobInput = mediaIndexJobInputSchema.parse(input.jobInput);
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from media_index_runs where id = ${jobInput.runId} for update`);
    const rows = await tx.select({ run: mediaIndexRuns, version: assetVersions }).from(mediaIndexRuns)
      .innerJoin(assetVersions, eq(assetVersions.id, mediaIndexRuns.sourceAssetVersionId))
      .where(and(eq(mediaIndexRuns.id, jobInput.runId), eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId))).limit(1);
    const row = rows[0];
    if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'media index run not found', 404);
    if (row.version.checksumSha256 !== jobInput.sourceChecksumSha256 || row.run.sourceChecksumSha256 !== jobInput.sourceChecksumSha256) {
      await tx.update(mediaIndexRuns).set({ status: 'STALE', errorSummary: '源文件校验值已变化。', updatedAt: new Date() }).where(eq(mediaIndexRuns.id, jobInput.runId));
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source checksum changed before indexing', 409, { reason: 'SOURCE_CHECKSUM_CHANGED' });
    }
    if (row.run.status === 'READY' || row.run.status === 'EMPTY') return { alreadyComplete: true, sourceProbe: sourceMediaProbeResultSchema.parse(row.version.mediaProbe) };
    if (row.version.probeStatus !== 'READY' || row.version.mediaProbe === null) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source media is not ready for indexing', 409);
    await tx.update(mediaIndexRuns).set({ status: 'RUNNING', errorSummary: null, updatedAt: new Date() }).where(eq(mediaIndexRuns.id, jobInput.runId));
    return { alreadyComplete: false, sourceProbe: sourceMediaProbeResultSchema.parse(row.version.mediaProbe) };
  });
}

export async function completeMediaIndex(
  deps: DomainDeps,
  input: { workspaceId: string; jobInput: MediaIndexJobInput; result: GeneratedMediaIndex; storageKeys: Map<string, string> },
): Promise<{ runId: string; status: 'READY' | 'EMPTY'; entryCount: number }> {
  const jobInput = mediaIndexJobInputSchema.parse(input.jobInput);
  const result = generatedMediaIndexSchema.parse(input.result);
  let privacyClass: 'WORKSPACE' | 'SENSITIVE' = 'WORKSPACE';
  await deps.db.transaction(async (tx) => {
    const current = await tx.select({ run: mediaIndexRuns, asset: assets }).from(mediaIndexRuns)
      .innerJoin(assetVersions, eq(assetVersions.id, mediaIndexRuns.sourceAssetVersionId))
      .innerJoin(assets, eq(assets.id, assetVersions.assetId))
      .where(and(eq(mediaIndexRuns.id, jobInput.runId), eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId), eq(assets.workspaceId, input.workspaceId))).limit(1);
    if (current[0]?.run.sourceChecksumSha256 !== jobInput.sourceChecksumSha256) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source checksum changed while indexing', 409);
    privacyClass = current[0].asset.sensitivityClass === 'SENSITIVE' || current[0].asset.sensitivityClass === 'RESTRICTED' ? 'SENSITIVE' : 'WORKSPACE';
  });
  const kinds = ['THUMBNAIL', 'WAVEFORM', 'SHOT', 'QUALITY'] as const;
  let written = 0;
  for (const kind of kinds) {
    const entries = result.entries.filter((entry) => entry.kind === kind);
    if (entries.length === 0) continue;
    written += entries.length;
    await deps.db.transaction(async (tx) => {
      const rows = entries.map((entry) => ({
        id: stableId('mie', jobInput.runId, entry.kind, String(entry.ordinal)),
        workspaceId: input.workspaceId,
        runId: jobInput.runId,
        kind: entry.kind,
        ordinal: entry.ordinal,
        sourceStartPts: entry.sourceStartPts,
        sourceEndPts: entry.sourceEndPts,
        timeBaseNumerator: entry.timeBase.numerator,
        timeBaseDenominator: entry.timeBase.denominator,
        streamId: entry.streamId,
        confidencePermille: entry.confidencePermille,
        payload: entry.payload,
        payloadSchemaVersion: '1.0',
        evidenceRefs: [{ type: entry.kind === 'WAVEFORM' ? 'AUDIO_WINDOW' : entry.kind === 'THUMBNAIL' ? 'FRAME' : 'SOURCE_RANGE', refId: `${jobInput.sourceAssetVersionId}:${entry.streamId}:${entry.sourceStartPts}-${entry.sourceEndPts}`, sourceRange: { startPts: entry.sourceStartPts, endPts: entry.sourceEndPts, timeBase: entry.timeBase } }],
        observedBy: 'ffmpeg-source-media-indexer',
        basis: 'MEASURED',
        confidenceMethod: entry.kind === 'SHOT' ? 'FFMPEG_SCENE_SCORE' : entry.kind === 'QUALITY' ? 'FFMPEG_DETECTOR' : null,
        calibrationStatus: entry.kind === 'THUMBNAIL' || entry.kind === 'WAVEFORM' ? 'NOT_APPLICABLE' : 'UNCALIBRATED',
        toolId: 'ffmpeg',
        toolVersion: jobInput.processorVersion,
        analysisConfigHash: jobInput.analysisConfigHash,
        indexVersion: jobInput.indexVersion,
        privacyClass,
        accessPolicyRef: 'workspace:read',
        lifecycleState: 'ACTIVE',
        storageKey: entry.localFilename === null ? null : input.storageKeys.get(entry.localFilename) ?? null,
      }));
      for (const row of rows) await tx.insert(mediaIndexEntries).values(row).onConflictDoUpdate({
        target: [mediaIndexEntries.runId, mediaIndexEntries.kind, mediaIndexEntries.ordinal],
        set: { sourceStartPts: row.sourceStartPts, sourceEndPts: row.sourceEndPts, timeBaseNumerator: row.timeBaseNumerator, timeBaseDenominator: row.timeBaseDenominator, streamId: row.streamId, confidencePermille: row.confidencePermille, payload: row.payload, evidenceRefs: row.evidenceRefs, observedBy: row.observedBy, observedAt: new Date(), basis: row.basis, confidenceMethod: row.confidenceMethod, calibrationStatus: row.calibrationStatus, toolId: row.toolId, toolVersion: row.toolVersion, analysisConfigHash: row.analysisConfigHash, indexVersion: row.indexVersion, privacyClass: row.privacyClass, lifecycleState: 'ACTIVE', storageKey: row.storageKey },
      });
      await tx.update(mediaIndexRuns).set({ status: 'PARTIAL', coveragePermille: Math.max(1, Math.floor(written / result.entries.length * 999)), checkpointMs: Math.floor(result.durationMs * written / result.entries.length), updatedAt: new Date() }).where(eq(mediaIndexRuns.id, jobInput.runId));
    });
  }
  const status = result.entries.length === 0 ? 'EMPTY' as const : 'READY' as const;
  await deps.db.delete(mediaIndexEntries).where(and(eq(mediaIndexEntries.runId, jobInput.runId), eq(mediaIndexEntries.workspaceId, input.workspaceId), ne(mediaIndexEntries.lifecycleState, 'ACTIVE')));
  await deps.db.update(mediaIndexRuns).set({ status, coveragePermille: 1000, checkpointMs: result.durationMs, errorSummary: null, updatedAt: new Date() }).where(and(eq(mediaIndexRuns.id, jobInput.runId), eq(mediaIndexRuns.workspaceId, input.workspaceId)));
  return { runId: jobInput.runId, status, entryCount: result.entries.length };
}

export async function failMediaIndex(deps: DomainDeps, input: { workspaceId: string; jobInput: MediaIndexJobInput; message: string }): Promise<void> {
  const jobInput = mediaIndexJobInputSchema.parse(input.jobInput);
  await deps.db.update(mediaIndexRuns).set({ status: 'FAILED', errorSummary: input.message.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(mediaIndexRuns.id, jobInput.runId), eq(mediaIndexRuns.workspaceId, input.workspaceId)));
}

export async function listMediaIndex(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; kind?: 'THUMBNAIL' | 'WAVEFORM' | 'SHOT' | 'QUALITY'; cursor?: number; limit?: number },
): Promise<MediaIndexPage> {
  const limit = Math.min(Math.max(input.limit ?? 24, 1), 100);
  const cursor = input.cursor ?? 0;
  const sourceRows = await deps.db.select({ version: assetVersions }).from(assets).innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId))).limit(1);
  const source = sourceRows[0]?.version;
  if (!source) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset not found', 404);
  const runs = await deps.db.select().from(mediaIndexRuns).where(and(eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(mediaIndexRuns.sourceAssetVersionId, source.id), eq(mediaIndexRuns.processorVersion, MEDIA_INDEX_PROCESSOR_VERSION))).limit(1);
  const run = runs[0];
  if (!run) return mediaIndexPageSchema.parse({ runId: null, sourceAssetVersionId: source.id, processorVersion: MEDIA_INDEX_PROCESSOR_VERSION, status: 'EMPTY', coveragePermille: 0, checkpointMs: 0, errorSummary: null, items: [], nextCursor: null });
  const predicates = [eq(mediaIndexEntries.workspaceId, input.workspaceId), eq(mediaIndexEntries.runId, run.id)];
  if (input.kind !== undefined) predicates.push(eq(mediaIndexEntries.kind, input.kind));
  const rows = await deps.db.select().from(mediaIndexEntries).where(and(...predicates)).orderBy(asc(mediaIndexEntries.kind), asc(mediaIndexEntries.ordinal), asc(mediaIndexEntries.id)).offset(cursor).limit(limit + 1);
  const page = rows.slice(0, limit);
  const storage = deps.storage;
  const items = await Promise.all(page.map(async (entry) => {
    const signed = entry.storageKey !== null && storage !== undefined ? await storage.createDownloadUrl({ key: entry.storageKey, ttlSeconds: 900 }) : null;
    return {
      id: entry.id,
      kind: entry.kind,
      ordinal: entry.ordinal,
      sourceStartPts: entry.sourceStartPts,
      sourceEndPts: entry.sourceEndPts,
      timeBase: { numerator: entry.timeBaseNumerator, denominator: entry.timeBaseDenominator },
      streamId: entry.streamId,
      confidencePermille: entry.confidencePermille,
      payload: entry.payload as Record<string, unknown>,
      previewUrl: signed?.url ?? null,
      previewExpiresAt: signed?.expiresAt ?? null,
    };
  }));
  return mediaIndexPageSchema.parse({ runId: run.id, sourceAssetVersionId: source.id, processorVersion: run.processorVersion, status: run.status, coveragePermille: run.coveragePermille, checkpointMs: run.checkpointMs, errorSummary: run.errorSummary, items, nextCursor: rows.length > limit ? String(cursor + limit) : null });
}

export async function rebuildMediaIndex(deps: DomainDeps, input: { workspaceId: string; assetId: string }): Promise<MediaIndexPage> {
  const rows = await deps.db.select({ asset: assets, version: assetVersions }).from(assets).innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId))).limit(1);
  const row = rows[0];
  if (!row || row.version.mediaProbe === null || row.version.checksumSha256 === null) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'probed source asset not found', 404);
  const runRows = await deps.db.select().from(mediaIndexRuns).where(and(eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(mediaIndexRuns.sourceAssetVersionId, row.version.id), eq(mediaIndexRuns.processorVersion, MEDIA_INDEX_PROCESSOR_VERSION))).limit(1);
  const run = runRows[0];
  if (!run) {
    await deps.db.transaction((tx) => scheduleMediaIndexInTx(tx, { workspaceId: input.workspaceId, projectId: row.asset.projectId, sourceAsset: row.asset, sourceVersion: row.version, probe: sourceMediaProbeResultSchema.parse(row.version.mediaProbe) }));
    return listMediaIndex(deps, input);
  }
  if (run.status === 'QUEUED' || run.status === 'RUNNING' || run.status === 'PARTIAL') throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'media index is already queued or processing', 409, { reason: 'MEDIA_INDEX_ALREADY_RUNNING' });
  const jobInput = mediaIndexJobInputSchema.parse({ runId: run.id, sourceAssetId: row.asset.id, sourceAssetVersionId: row.version.id, sourceStorageKey: row.version.storageKey, sourceChecksumSha256: row.version.checksumSha256, processorVersion: MEDIA_INDEX_PROCESSOR_VERSION, analysisConfigHash: MEDIA_INDEX_ANALYSIS_CONFIG_HASH, indexVersion: MEDIA_INDEX_VERSION });
  await deps.db.transaction(async (tx) => {
    await tx.update(mediaIndexRuns).set({ status: 'QUEUED', coveragePermille: 0, checkpointMs: 0, errorSummary: null, sourceChecksumSha256: row.version.checksumSha256!, updatedAt: new Date() }).where(eq(mediaIndexRuns.id, run.id));
    await tx.update(mediaIndexEntries).set({ lifecycleState: 'STALE' }).where(and(eq(mediaIndexEntries.workspaceId, input.workspaceId), eq(mediaIndexEntries.runId, run.id)));
    await createJobInTx(tx, { workspaceId: input.workspaceId, projectId: row.asset.projectId, type: MEDIA_INDEX_JOB_TYPE, input: jobInput, maxAttempts: 2, createdBy: row.asset.createdBy, classification: 'SYSTEM' });
  });
  return listMediaIndex(deps, input);
}
