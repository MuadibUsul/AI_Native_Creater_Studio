import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  MEDIA_AUDIO_ANALYSIS_JOB_TYPE,
  MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION,
  generatedMediaAudioAnalysisSchema,
  mediaAudioAnalysisJobInputSchema,
  sourceMediaProbeResultSchema,
  type GeneratedMediaAudioAnalysis,
  type MediaAudioAnalysisJobInput,
} from '@ancs/contracts';
import { assets, assetVersions, mediaIndexEntries, mediaIndexRuns } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { createJobInTx } from './jobs.js';

type DomainTx = Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0];
type SourceRange = { sourceStartPts: string; sourceEndPts: string; timeBase: { numerator: number; denominator: number } };
const AUDIO_KINDS = ['AUDIO_EVENT', 'MUSIC_BEAT'] as const;
const VISUAL_CORRELATION_KINDS = ['ACTION_EVENT', 'VISUAL_EVENT', 'MOTION_INTENSITY'] as const;
export const MEDIA_AUDIO_ANALYSIS_CONFIG_HASH = createHash('sha256').update(`${MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION}\0default-v1`).digest('hex');
const stableId = (prefix: string, ...parts: string[]): string => `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;

function rangesOverlap(left: SourceRange, right: SourceRange): boolean {
  const leftStart = BigInt(left.sourceStartPts) * BigInt(left.timeBase.numerator) * BigInt(right.timeBase.denominator);
  const leftEnd = BigInt(left.sourceEndPts) * BigInt(left.timeBase.numerator) * BigInt(right.timeBase.denominator);
  const rightStart = BigInt(right.sourceStartPts) * BigInt(right.timeBase.numerator) * BigInt(left.timeBase.denominator);
  const rightEnd = BigInt(right.sourceEndPts) * BigInt(right.timeBase.numerator) * BigInt(left.timeBase.denominator);
  return leftStart < rightEnd && leftEnd > rightStart;
}

export async function scheduleMediaAudioAnalysisInTx(
  tx: DomainTx,
  input: { workspaceId: string; projectId: string | null; sourceAsset: typeof assets.$inferSelect; sourceVersion: typeof assetVersions.$inferSelect; hasAudio: boolean },
): Promise<{ scheduled: boolean; runId: string | null }> {
  if (!input.hasAudio || input.sourceVersion.checksumSha256 === null) return { scheduled: false, runId: null };
  const runId = stableId('mar', input.sourceVersion.id, MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION);
  const inserted = await tx.insert(mediaIndexRuns).values({
    id: runId,
    workspaceId: input.workspaceId,
    sourceAssetVersionId: input.sourceVersion.id,
    sourceChecksumSha256: input.sourceVersion.checksumSha256,
    processorVersion: MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION,
    analysisConfigHash: MEDIA_AUDIO_ANALYSIS_CONFIG_HASH,
    indexVersion: 1,
    toolId: 'audio-analysis-adapter',
    toolVersion: MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION,
    supportedKinds: [...AUDIO_KINDS],
    status: 'QUEUED',
  }).onConflictDoNothing({ target: [mediaIndexRuns.sourceAssetVersionId, mediaIndexRuns.processorVersion] }).returning({ id: mediaIndexRuns.id });
  if (inserted[0] === undefined) return { scheduled: false, runId };
  await createJobInTx(tx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    type: MEDIA_AUDIO_ANALYSIS_JOB_TYPE,
    input: mediaAudioAnalysisJobInputSchema.parse({
      runId,
      sourceAssetId: input.sourceAsset.id,
      sourceAssetVersionId: input.sourceVersion.id,
      sourceStorageKey: input.sourceVersion.storageKey,
      sourceChecksumSha256: input.sourceVersion.checksumSha256,
      processorVersion: MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION,
      analysisConfigHash: MEDIA_AUDIO_ANALYSIS_CONFIG_HASH,
    }),
    maxAttempts: 1,
    createdBy: input.sourceAsset.createdBy,
    classification: 'SYSTEM',
  });
  return { scheduled: true, runId };
}

export async function beginMediaAudioAnalysis(deps: DomainDeps, input: { workspaceId: string; jobInput: MediaAudioAnalysisJobInput }): Promise<{ alreadyComplete: boolean }> {
  const jobInput = mediaAudioAnalysisJobInputSchema.parse(input.jobInput);
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from media_index_runs where id = ${jobInput.runId} for update`);
    const rows = await tx.select({ run: mediaIndexRuns, version: assetVersions }).from(mediaIndexRuns).innerJoin(assetVersions, eq(assetVersions.id, mediaIndexRuns.sourceAssetVersionId))
      .where(and(eq(mediaIndexRuns.id, jobInput.runId), eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId))).limit(1);
    const row = rows[0];
    if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'media audio analysis run not found', 404);
    if (row.run.sourceChecksumSha256 !== jobInput.sourceChecksumSha256 || row.version.checksumSha256 !== jobInput.sourceChecksumSha256) {
      await tx.update(mediaIndexRuns).set({ status: 'STALE', errorSummary: '源文件校验值已变化。', updatedAt: new Date() }).where(eq(mediaIndexRuns.id, jobInput.runId));
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source checksum changed before audio analysis', 409);
    }
    if (row.run.status === 'READY' || row.run.status === 'EMPTY') return { alreadyComplete: true };
    await tx.update(mediaIndexRuns).set({ status: 'RUNNING', errorSummary: null, updatedAt: new Date() }).where(eq(mediaIndexRuns.id, jobInput.runId));
    return { alreadyComplete: false };
  });
}

export async function completeMediaAudioAnalysis(deps: DomainDeps, input: { workspaceId: string; jobInput: MediaAudioAnalysisJobInput; result: GeneratedMediaAudioAnalysis }): Promise<{ runId: string; status: 'READY' | 'EMPTY'; entryCount: number }> {
  const jobInput = mediaAudioAnalysisJobInputSchema.parse(input.jobInput);
  const result = generatedMediaAudioAnalysisSchema.parse(input.result);
  const entryCount = result.audioEvents.length + result.musicBeats.length;
  const status = entryCount === 0 ? 'EMPTY' as const : 'READY' as const;
  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from media_index_runs where id = ${jobInput.runId} for update`);
    const rows = await tx.select({ run: mediaIndexRuns, asset: assets, version: assetVersions }).from(mediaIndexRuns)
      .innerJoin(assetVersions, eq(assetVersions.id, mediaIndexRuns.sourceAssetVersionId)).innerJoin(assets, eq(assets.id, assetVersions.assetId))
      .where(and(eq(mediaIndexRuns.id, jobInput.runId), eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId), eq(assets.workspaceId, input.workspaceId))).limit(1);
    const row = rows[0];
    if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'media audio analysis run not found', 404);
    if (row.run.sourceChecksumSha256 !== jobInput.sourceChecksumSha256) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source checksum changed during audio analysis', 409);
    const parsedProbe = row.version.mediaProbe === null ? null : sourceMediaProbeResultSchema.safeParse(row.version.mediaProbe);
    const audioStreamIndexes = new Set(parsedProbe?.success ? parsedProbe.data.streams.filter((stream) => stream.type === 'AUDIO').map((stream) => stream.index) : []);
    for (const item of [...result.audioEvents, ...result.musicBeats]) {
      if (!audioStreamIndexes.has(item.streamIndex)) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'audio analysis referenced an unknown audio stream', 409, { streamIndex: item.streamIndex });
    }
    const visualRows = await tx.select({ entry: mediaIndexEntries }).from(mediaIndexEntries).innerJoin(mediaIndexRuns, eq(mediaIndexRuns.id, mediaIndexEntries.runId))
      .where(and(eq(mediaIndexEntries.workspaceId, input.workspaceId), eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(mediaIndexRuns.sourceAssetVersionId, jobInput.sourceAssetVersionId), inArray(mediaIndexEntries.kind, [...VISUAL_CORRELATION_KINDS]), eq(mediaIndexEntries.lifecycleState, 'ACTIVE')));
    const relatedVisual = (item: SourceRange) => visualRows.filter(({ entry }) => rangesOverlap(item, { sourceStartPts: entry.sourceStartPts, sourceEndPts: entry.sourceEndPts, timeBase: { numerator: entry.timeBaseNumerator, denominator: entry.timeBaseDenominator } }));
    const privacyClass = row.asset.sensitivityClass === 'SENSITIVE' || row.asset.sensitivityClass === 'RESTRICTED' ? 'SENSITIVE' : 'WORKSPACE';
    const groups = [
      ['AUDIO_EVENT', result.audioEvents.map((item) => ({ item, payload: { label: item.label, eventType: item.eventType, channel: item.channel, relatedVisualRecordIds: relatedVisual(item).map(({ entry }) => entry.id) } }))],
      ['MUSIC_BEAT', result.musicBeats.map((item) => ({ item, payload: { bpm: item.tempoBpm, beatOrdinal: item.beatOrdinal, downbeat: item.downbeat, musicSegmentId: item.musicSegmentId, channel: item.channel, relatedVisualRecordIds: relatedVisual(item).map(({ entry }) => entry.id) } }))],
    ] as const;
    await tx.update(mediaIndexEntries).set({ lifecycleState: 'STALE' }).where(and(eq(mediaIndexEntries.workspaceId, input.workspaceId), eq(mediaIndexEntries.runId, jobInput.runId), inArray(mediaIndexEntries.kind, [...AUDIO_KINDS])));
    for (const [kind, values] of groups) {
      for (const [ordinal, value] of values.entries()) {
        const item = value.item;
        const correlations = relatedVisual(item);
        const record = {
          id: stableId('mie', jobInput.runId, kind, item.id), workspaceId: input.workspaceId, runId: jobInput.runId, kind, ordinal,
          sourceStartPts: item.sourceStartPts, sourceEndPts: item.sourceEndPts, timeBaseNumerator: item.timeBase.numerator, timeBaseDenominator: item.timeBase.denominator,
          streamId: `audio:${String(item.streamIndex)}`, confidencePermille: item.confidencePermille, payload: value.payload, payloadSchemaVersion: '1.0',
          evidenceRefs: [
            ...item.evidenceWindows.map((window) => ({ type: 'AUDIO_WINDOW', refId: window.windowRef, sourceRange: { startPts: window.sourceStartPts, endPts: window.sourceEndPts, timeBase: window.timeBase } })),
            ...correlations.map(({ entry }) => ({ type: 'RECORD', refId: entry.id, sourceRange: { startPts: entry.sourceStartPts, endPts: entry.sourceEndPts, timeBase: { numerator: entry.timeBaseNumerator, denominator: entry.timeBaseDenominator } } })),
          ],
          observedBy: result.adapter, observedAt: new Date(), basis: 'MODEL_INFERRED', confidenceMethod: 'AUDIO_ANALYSIS_ADAPTER_CONFIDENCE', calibrationStatus: 'UNCALIBRATED',
          toolId: result.adapter, toolVersion: result.processorVersion, modelVersion: result.modelVersion, analysisConfigHash: jobInput.analysisConfigHash, indexVersion: 1,
          privacyClass, accessPolicyRef: 'workspace:read', lifecycleState: 'ACTIVE', storageKey: null,
        };
        const { id: _stableRecordId, ...updates } = record;
        await tx.insert(mediaIndexEntries).values(record).onConflictDoUpdate({ target: [mediaIndexEntries.runId, mediaIndexEntries.kind, mediaIndexEntries.ordinal], set: updates });
      }
    }
    await tx.delete(mediaIndexEntries).where(and(eq(mediaIndexEntries.workspaceId, input.workspaceId), eq(mediaIndexEntries.runId, jobInput.runId), inArray(mediaIndexEntries.kind, [...AUDIO_KINDS]), eq(mediaIndexEntries.lifecycleState, 'STALE')));
    await tx.update(mediaIndexRuns).set({ status, coveragePermille: 1000, checkpointMs: result.durationMs, errorSummary: null, toolId: result.adapter, toolVersion: result.processorVersion, supportedKinds: [...AUDIO_KINDS], updatedAt: new Date() }).where(eq(mediaIndexRuns.id, jobInput.runId));
  });
  return { runId: jobInput.runId, status, entryCount };
}

export async function failMediaAudioAnalysis(deps: DomainDeps, input: { workspaceId: string; jobInput: MediaAudioAnalysisJobInput; message: string }): Promise<void> {
  const jobInput = mediaAudioAnalysisJobInputSchema.parse(input.jobInput);
  await deps.db.update(mediaIndexRuns).set({ status: 'FAILED', errorSummary: input.message.slice(0, 500), updatedAt: new Date() }).where(and(eq(mediaIndexRuns.id, jobInput.runId), eq(mediaIndexRuns.workspaceId, input.workspaceId)));
}

export async function retryMediaAudioAnalysis(deps: DomainDeps, input: { workspaceId: string; assetId: string; analysisConfigHash?: string }): Promise<void> {
  const rows = await deps.db.select({ asset: assets, version: assetVersions }).from(assets).innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId))).limit(1);
  const row = rows[0];
  if (!row || row.version.checksumSha256 === null) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'ready source asset not found', 404);
  const probe = row.version.mediaProbe === null ? null : sourceMediaProbeResultSchema.safeParse(row.version.mediaProbe);
  if (!probe?.success || probe.data.status !== 'READY' || !probe.data.streams.some((stream) => stream.type === 'AUDIO')) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source asset has no ready audio stream', 409);
  const runRows = await deps.db.select().from(mediaIndexRuns).where(and(eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(mediaIndexRuns.sourceAssetVersionId, row.version.id), eq(mediaIndexRuns.processorVersion, MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION))).limit(1);
  const run = runRows[0];
  if (!run) {
    await deps.db.transaction((tx) => scheduleMediaAudioAnalysisInTx(tx, { workspaceId: input.workspaceId, projectId: row.asset.projectId, sourceAsset: row.asset, sourceVersion: row.version, hasAudio: true }));
    return;
  }
  if (!['FAILED', 'STALE', 'EMPTY', 'READY'].includes(run.status)) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'media audio analysis is already queued or processing', 409, { status: run.status });
  const analysisConfigHash = input.analysisConfigHash ?? run.analysisConfigHash;
  const jobInput = mediaAudioAnalysisJobInputSchema.parse({ runId: run.id, sourceAssetId: row.asset.id, sourceAssetVersionId: row.version.id, sourceStorageKey: row.version.storageKey, sourceChecksumSha256: row.version.checksumSha256, processorVersion: MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION, analysisConfigHash });
  await deps.db.transaction(async (tx) => {
    await tx.update(mediaIndexRuns).set({ status: 'QUEUED', coveragePermille: 0, checkpointMs: 0, errorSummary: null, sourceChecksumSha256: row.version.checksumSha256!, analysisConfigHash, updatedAt: new Date() }).where(eq(mediaIndexRuns.id, run.id));
    await tx.update(mediaIndexEntries).set({ lifecycleState: 'STALE' }).where(and(eq(mediaIndexEntries.workspaceId, input.workspaceId), eq(mediaIndexEntries.runId, run.id), inArray(mediaIndexEntries.kind, [...AUDIO_KINDS])));
    await createJobInTx(tx, { workspaceId: input.workspaceId, projectId: row.asset.projectId, type: MEDIA_AUDIO_ANALYSIS_JOB_TYPE, input: jobInput, maxAttempts: 1, createdBy: row.asset.createdBy, classification: 'SYSTEM' });
  });
}
