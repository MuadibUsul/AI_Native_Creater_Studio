import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  MEDIA_VISUAL_ANALYSIS_JOB_TYPE,
  MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION,
  generatedMediaVisualAnalysisSchema,
  mediaVisualAnalysisJobInputSchema,
  sourceMediaProbeResultSchema,
  type GeneratedMediaVisualAnalysis,
  type MediaVisualAnalysisJobInput,
} from '@ancs/contracts';
import { assets, assetVersions, mediaIndexEntries, mediaIndexRuns } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { createJobInTx } from './jobs.js';

type DomainTx = Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0];
const VISUAL_KINDS = ['OBJECT_TRACK', 'ACTION_EVENT', 'PERSON_TRACK', 'VISUAL_EVENT', 'MOTION_INTENSITY'] as const;
export const MEDIA_VISUAL_ANALYSIS_CONFIG_HASH = createHash('sha256').update(`${MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION}\0default-v1`).digest('hex');
const stableId = (prefix: string, ...parts: string[]): string => `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;

export async function scheduleMediaVisualAnalysisInTx(
  tx: DomainTx,
  input: { workspaceId: string; projectId: string | null; sourceAsset: typeof assets.$inferSelect; sourceVersion: typeof assetVersions.$inferSelect; hasVideo: boolean },
): Promise<{ scheduled: boolean; runId: string | null }> {
  if (!input.hasVideo || input.sourceVersion.checksumSha256 === null) return { scheduled: false, runId: null };
  const runId = stableId('mvr', input.sourceVersion.id, MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION);
  const inserted = await tx.insert(mediaIndexRuns).values({
    id: runId,
    workspaceId: input.workspaceId,
    sourceAssetVersionId: input.sourceVersion.id,
    sourceChecksumSha256: input.sourceVersion.checksumSha256,
    processorVersion: MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION,
    analysisConfigHash: MEDIA_VISUAL_ANALYSIS_CONFIG_HASH,
    indexVersion: 1,
    toolId: 'visual-analysis-adapter',
    toolVersion: MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION,
    supportedKinds: [...VISUAL_KINDS],
    status: 'QUEUED',
  }).onConflictDoNothing({ target: [mediaIndexRuns.sourceAssetVersionId, mediaIndexRuns.processorVersion] }).returning({ id: mediaIndexRuns.id });
  if (inserted[0] === undefined) return { scheduled: false, runId };
  await createJobInTx(tx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    type: MEDIA_VISUAL_ANALYSIS_JOB_TYPE,
    input: mediaVisualAnalysisJobInputSchema.parse({
      runId,
      sourceAssetId: input.sourceAsset.id,
      sourceAssetVersionId: input.sourceVersion.id,
      sourceStorageKey: input.sourceVersion.storageKey,
      sourceChecksumSha256: input.sourceVersion.checksumSha256,
      processorVersion: MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION,
      analysisConfigHash: MEDIA_VISUAL_ANALYSIS_CONFIG_HASH,
    }),
    maxAttempts: 1,
    createdBy: input.sourceAsset.createdBy,
    classification: 'SYSTEM',
  });
  return { scheduled: true, runId };
}

export async function beginMediaVisualAnalysis(deps: DomainDeps, input: { workspaceId: string; jobInput: MediaVisualAnalysisJobInput }): Promise<{ alreadyComplete: boolean }> {
  const jobInput = mediaVisualAnalysisJobInputSchema.parse(input.jobInput);
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from media_index_runs where id = ${jobInput.runId} for update`);
    const rows = await tx.select({ run: mediaIndexRuns, version: assetVersions }).from(mediaIndexRuns).innerJoin(assetVersions, eq(assetVersions.id, mediaIndexRuns.sourceAssetVersionId))
      .where(and(eq(mediaIndexRuns.id, jobInput.runId), eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId))).limit(1);
    const row = rows[0];
    if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'media visual analysis run not found', 404);
    if (row.run.sourceChecksumSha256 !== jobInput.sourceChecksumSha256 || row.version.checksumSha256 !== jobInput.sourceChecksumSha256) {
      await tx.update(mediaIndexRuns).set({ status: 'STALE', errorSummary: '源文件校验值已变化。', updatedAt: new Date() }).where(eq(mediaIndexRuns.id, jobInput.runId));
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source checksum changed before visual analysis', 409);
    }
    if (row.run.status === 'READY' || row.run.status === 'EMPTY') return { alreadyComplete: true };
    await tx.update(mediaIndexRuns).set({ status: 'RUNNING', errorSummary: null, updatedAt: new Date() }).where(eq(mediaIndexRuns.id, jobInput.runId));
    return { alreadyComplete: false };
  });
}

function sourceRange(item: { sourceStartPts: string; sourceEndPts: string; timeBase: { numerator: number; denominator: number } }) {
  return { startPts: item.sourceStartPts, endPts: item.sourceEndPts, timeBase: item.timeBase };
}

export async function completeMediaVisualAnalysis(deps: DomainDeps, input: { workspaceId: string; jobInput: MediaVisualAnalysisJobInput; result: GeneratedMediaVisualAnalysis }): Promise<{ runId: string; status: 'READY' | 'EMPTY'; entryCount: number }> {
  const jobInput = mediaVisualAnalysisJobInputSchema.parse(input.jobInput);
  const result = generatedMediaVisualAnalysisSchema.parse(input.result);
  const groups = [
    ['OBJECT_TRACK', result.objectTracks.map((item) => ({ item, payload: { label: item.label, trackId: item.id, lifecycle: item.lifecycle, regionKeyframes: item.keyframes }, confidencePermille: item.confidencePermille }))],
    ['ACTION_EVENT', result.actionEvents.map((item) => ({ item, payload: { label: item.label, subjectTrackId: item.subjectTrackId }, confidencePermille: item.confidencePermille }))],
    ['PERSON_TRACK', result.personTracks.map((item) => ({ item, payload: { label: 'person', trackId: item.id, lifecycle: item.lifecycle, regionKeyframes: item.keyframes, identityState: 'UNKNOWN' }, confidencePermille: item.confidencePermille }))],
    ['VISUAL_EVENT', result.visualEvents.map((item) => ({ item, payload: { label: item.label, subjectTrackId: item.subjectTrackId }, confidencePermille: item.confidencePermille }))],
    ['MOTION_INTENSITY', result.motionIntensity.map((item) => ({ item, payload: { valuePermille: item.valuePermille, method: item.method }, confidencePermille: null }))],
  ] as const;
  const entryCount = groups.reduce((total, [, values]) => total + values.length, 0);
  const status = entryCount === 0 ? 'EMPTY' as const : 'READY' as const;
  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from media_index_runs where id = ${jobInput.runId} for update`);
    const rows = await tx.select({ run: mediaIndexRuns, asset: assets, version: assetVersions }).from(mediaIndexRuns).innerJoin(assetVersions, eq(assetVersions.id, mediaIndexRuns.sourceAssetVersionId)).innerJoin(assets, eq(assets.id, assetVersions.assetId))
      .where(and(eq(mediaIndexRuns.id, jobInput.runId), eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId), eq(assets.workspaceId, input.workspaceId))).limit(1);
    const row = rows[0];
    if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'media visual analysis run not found', 404);
    if (row.run.sourceChecksumSha256 !== jobInput.sourceChecksumSha256) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source checksum changed during visual analysis', 409);
    const privacyClass = row.asset.sensitivityClass === 'SENSITIVE' || row.asset.sensitivityClass === 'RESTRICTED' ? 'SENSITIVE' : 'WORKSPACE';
    const parsedProbe = row.version.mediaProbe === null ? null : sourceMediaProbeResultSchema.safeParse(row.version.mediaProbe);
    const videoStream = parsedProbe?.success ? parsedProbe.data.streams.find((stream) => stream.type === 'VIDEO') : undefined;
    const streamId = videoStream === undefined ? null : `video:${String(videoStream.index)}`;
    await tx.update(mediaIndexEntries).set({ lifecycleState: 'STALE' }).where(and(eq(mediaIndexEntries.workspaceId, input.workspaceId), eq(mediaIndexEntries.runId, jobInput.runId), inArray(mediaIndexEntries.kind, [...VISUAL_KINDS])));
    for (const [kind, values] of groups) {
      for (const [ordinal, value] of values.entries()) {
        const item = value.item;
        const range = sourceRange(item);
        const record = {
          id: stableId('mie', jobInput.runId, kind, item.id), workspaceId: input.workspaceId, runId: jobInput.runId, kind, ordinal,
          sourceStartPts: item.sourceStartPts, sourceEndPts: item.sourceEndPts, timeBaseNumerator: item.timeBase.numerator, timeBaseDenominator: item.timeBase.denominator,
          streamId, confidencePermille: value.confidencePermille, payload: value.payload, payloadSchemaVersion: '1.0',
          evidenceRefs: item.evidenceFrames.map((frame) => ({ type: 'FRAME', refId: frame.frameRef, sourceRange: range })),
          observedBy: result.adapter, observedAt: new Date(), basis: 'MODEL_INFERRED', confidenceMethod: 'VISUAL_ANALYSIS_ADAPTER_CONFIDENCE', calibrationStatus: 'UNCALIBRATED',
          toolId: result.adapter, toolVersion: result.processorVersion, modelVersion: result.modelVersion, analysisConfigHash: jobInput.analysisConfigHash, indexVersion: 1,
          privacyClass, accessPolicyRef: 'workspace:read', lifecycleState: 'ACTIVE', storageKey: null,
        };
        const { id: _stableRecordId, ...updates } = record;
        await tx.insert(mediaIndexEntries).values(record).onConflictDoUpdate({ target: [mediaIndexEntries.runId, mediaIndexEntries.kind, mediaIndexEntries.ordinal], set: updates });
      }
    }
    await tx.delete(mediaIndexEntries).where(and(eq(mediaIndexEntries.workspaceId, input.workspaceId), eq(mediaIndexEntries.runId, jobInput.runId), inArray(mediaIndexEntries.kind, [...VISUAL_KINDS]), eq(mediaIndexEntries.lifecycleState, 'STALE')));
    await tx.update(mediaIndexRuns).set({ status, coveragePermille: 1000, checkpointMs: result.durationMs, errorSummary: null, toolId: result.adapter, toolVersion: result.processorVersion, supportedKinds: [...VISUAL_KINDS], updatedAt: new Date() }).where(eq(mediaIndexRuns.id, jobInput.runId));
  });
  return { runId: jobInput.runId, status, entryCount };
}

export async function failMediaVisualAnalysis(deps: DomainDeps, input: { workspaceId: string; jobInput: MediaVisualAnalysisJobInput; message: string; code?: string }): Promise<void> {
  const jobInput = mediaVisualAnalysisJobInputSchema.parse(input.jobInput);
  await deps.db.update(mediaIndexRuns).set({ status: 'FAILED', errorSummary: input.message.slice(0, 500), errorCode: input.code ?? null, updatedAt: new Date() }).where(and(eq(mediaIndexRuns.id, jobInput.runId), eq(mediaIndexRuns.workspaceId, input.workspaceId)));
}

export async function retryMediaVisualAnalysis(deps: DomainDeps, input: { workspaceId: string; assetId: string; analysisConfigHash?: string }): Promise<void> {
  const rows = await deps.db.select({ asset: assets, version: assetVersions }).from(assets).innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId))).limit(1);
  const row = rows[0];
  if (!row || row.version.checksumSha256 === null) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'ready source asset not found', 404);
  const probe = row.version.mediaProbe === null ? null : sourceMediaProbeResultSchema.safeParse(row.version.mediaProbe);
  if (!probe?.success || probe.data.status !== 'READY' || !probe.data.streams.some((stream) => stream.type === 'VIDEO')) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source asset has no ready video stream', 409);
  const runRows = await deps.db.select().from(mediaIndexRuns).where(and(eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(mediaIndexRuns.sourceAssetVersionId, row.version.id), eq(mediaIndexRuns.processorVersion, MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION))).limit(1);
  const run = runRows[0];
  if (!run) {
    await deps.db.transaction((tx) => scheduleMediaVisualAnalysisInTx(tx, { workspaceId: input.workspaceId, projectId: row.asset.projectId, sourceAsset: row.asset, sourceVersion: row.version, hasVideo: true }));
    return;
  }
  if (!['FAILED', 'STALE', 'EMPTY', 'READY'].includes(run.status)) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'media visual analysis is already queued or processing', 409, { status: run.status });
  const analysisConfigHash = input.analysisConfigHash ?? run.analysisConfigHash;
  const jobInput = mediaVisualAnalysisJobInputSchema.parse({ runId: run.id, sourceAssetId: row.asset.id, sourceAssetVersionId: row.version.id, sourceStorageKey: row.version.storageKey, sourceChecksumSha256: row.version.checksumSha256, processorVersion: MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION, analysisConfigHash });
  await deps.db.transaction(async (tx) => {
    await tx.update(mediaIndexRuns).set({ status: 'QUEUED', coveragePermille: 0, checkpointMs: 0, errorSummary: null, sourceChecksumSha256: row.version.checksumSha256!, analysisConfigHash, updatedAt: new Date() }).where(eq(mediaIndexRuns.id, run.id));
    await tx.update(mediaIndexEntries).set({ lifecycleState: 'STALE' }).where(and(eq(mediaIndexEntries.workspaceId, input.workspaceId), eq(mediaIndexEntries.runId, run.id), inArray(mediaIndexEntries.kind, [...VISUAL_KINDS])));
    await createJobInTx(tx, { workspaceId: input.workspaceId, projectId: row.asset.projectId, type: MEDIA_VISUAL_ANALYSIS_JOB_TYPE, input: jobInput, maxAttempts: 1, createdBy: row.asset.createdBy, classification: 'SYSTEM' });
  });
}
