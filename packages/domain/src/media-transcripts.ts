import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  MEDIA_TRANSCRIPT_JOB_TYPE,
  MEDIA_TRANSCRIPT_PROCESSOR_VERSION,
  correctTranscriptSegmentRequestSchema,
  generatedMediaTranscriptSchema,
  mediaTranscriptJobInputSchema,
  mediaTranscriptSchema,
  mediaTranscriptSnapshotSchema,
  updateTranscriptTerminologyRequestSchema,
  sourceMediaProbeResultSchema,
  type CorrectTranscriptSegmentRequest,
  type GeneratedMediaTranscript,
  type MediaTranscript,
  type MediaTranscriptJobInput,
  type UpdateTranscriptTerminologyRequest,
} from '@ancs/contracts';
import { assetVersions, assets, mediaTranscriptRuns, mediaTranscriptVersions } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { createJobInTx } from './jobs.js';

type DomainTx = Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0];
const stableId = (prefix: string, ...parts: string[]): string => `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;

function applyTranscriptOverlay(
  base: ReturnType<typeof mediaTranscriptSnapshotSchema.parse>,
  previous: ReturnType<typeof mediaTranscriptSnapshotSchema.parse>,
  correctedSegmentIds: string[],
  preserveTerminology: boolean,
) {
  const correctedIds = new Set(correctedSegmentIds);
  const replacementByIndex = new Map<number, (typeof previous.segments)[number]>();
  for (const corrected of previous.segments.filter((segment) => correctedIds.has(segment.id))) {
    let index = base.segments.findIndex((candidate) => candidate.id === corrected.id);
    if (index < 0) index = base.segments.findIndex((candidate) =>
      candidate.sourceStartPts === corrected.sourceStartPts
      && candidate.sourceEndPts === corrected.sourceEndPts
      && candidate.timeBase.numerator === corrected.timeBase.numerator
      && candidate.timeBase.denominator === corrected.timeBase.denominator,
    );
    if (index >= 0) replacementByIndex.set(index, corrected);
  }
  const replacedRanges = [...replacementByIndex.keys()].map((index) => {
    const segment = base.segments[index]!;
    return { start: segment.wordStartOrdinal, end: segment.wordEndOrdinal };
  });
  const replacementWords = [...replacementByIndex.entries()].map(([index, corrected]) => {
    const target = base.segments[index]!;
    return {
      ordinal: target.wordStartOrdinal,
      text: corrected.text,
      speakerId: corrected.speakerId,
      confidencePermille: null,
      sourceStartPts: corrected.sourceStartPts,
      sourceEndPts: corrected.sourceEndPts,
      timeBase: corrected.timeBase,
    };
  });
  return mediaTranscriptSnapshotSchema.parse({
    ...base,
    terminology: preserveTerminology ? previous.terminology : base.terminology,
    segments: base.segments.map((segment, index) => {
      const corrected = replacementByIndex.get(index);
      return corrected === undefined ? segment : { ...corrected, ordinal: segment.ordinal, wordStartOrdinal: segment.wordStartOrdinal, wordEndOrdinal: segment.wordStartOrdinal };
    }),
    words: [...base.words.filter((word) => !replacedRanges.some((range) => word.ordinal >= range.start && word.ordinal <= range.end)), ...replacementWords].sort((left, right) => left.ordinal - right.ordinal),
  });
}

export async function scheduleMediaTranscriptInTx(
  tx: DomainTx,
  input: { workspaceId: string; projectId: string | null; sourceAsset: typeof assets.$inferSelect; sourceVersion: typeof assetVersions.$inferSelect; hasAudio: boolean },
): Promise<{ scheduled: boolean; runId: string | null }> {
  if (!input.hasAudio || input.sourceVersion.checksumSha256 === null) return { scheduled: false, runId: null };
  const runId = stableId('mtr', input.sourceVersion.id, MEDIA_TRANSCRIPT_PROCESSOR_VERSION);
  const now = new Date();
  const inserted = await tx.insert(mediaTranscriptRuns).values({
    id: runId,
    workspaceId: input.workspaceId,
    sourceAssetVersionId: input.sourceVersion.id,
    sourceChecksumSha256: input.sourceVersion.checksumSha256,
    processorVersion: MEDIA_TRANSCRIPT_PROCESSOR_VERSION,
    status: 'QUEUED',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({ target: [mediaTranscriptRuns.sourceAssetVersionId, mediaTranscriptRuns.processorVersion] }).returning({ id: mediaTranscriptRuns.id });
  if (inserted[0] === undefined) return { scheduled: false, runId };
  await createJobInTx(tx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    type: MEDIA_TRANSCRIPT_JOB_TYPE,
    input: mediaTranscriptJobInputSchema.parse({
      runId,
      sourceAssetId: input.sourceAsset.id,
      sourceAssetVersionId: input.sourceVersion.id,
      sourceStorageKey: input.sourceVersion.storageKey,
      sourceChecksumSha256: input.sourceVersion.checksumSha256,
      processorVersion: MEDIA_TRANSCRIPT_PROCESSOR_VERSION,
    }),
    maxAttempts: 1,
    createdBy: input.sourceAsset.createdBy,
    classification: 'SYSTEM',
  });
  return { scheduled: true, runId };
}

export async function beginMediaTranscript(deps: DomainDeps, input: { workspaceId: string; jobInput: MediaTranscriptJobInput }): Promise<{ alreadyComplete: boolean }> {
  const jobInput = mediaTranscriptJobInputSchema.parse(input.jobInput);
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from media_transcript_runs where id = ${jobInput.runId} for update`);
    const rows = await tx.select({ run: mediaTranscriptRuns, version: assetVersions }).from(mediaTranscriptRuns)
      .innerJoin(assetVersions, eq(assetVersions.id, mediaTranscriptRuns.sourceAssetVersionId))
      .where(and(eq(mediaTranscriptRuns.id, jobInput.runId), eq(mediaTranscriptRuns.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId))).limit(1);
    const row = rows[0];
    if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'media transcript run not found', 404);
    if (row.version.checksumSha256 !== jobInput.sourceChecksumSha256 || row.run.sourceChecksumSha256 !== jobInput.sourceChecksumSha256) {
      await tx.update(mediaTranscriptRuns).set({ status: 'STALE', errorSummary: '源文件校验值已变化。', updatedAt: new Date() }).where(eq(mediaTranscriptRuns.id, jobInput.runId));
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source checksum changed before transcription', 409);
    }
    if (row.run.status === 'READY') return { alreadyComplete: true };
    await tx.update(mediaTranscriptRuns).set({ status: 'RUNNING', errorSummary: null, updatedAt: new Date() }).where(eq(mediaTranscriptRuns.id, jobInput.runId));
    return { alreadyComplete: false };
  });
}

export async function completeMediaTranscript(deps: DomainDeps, input: { workspaceId: string; jobInput: MediaTranscriptJobInput; result: GeneratedMediaTranscript }): Promise<{ runId: string; version: number }> {
  const jobInput = mediaTranscriptJobInputSchema.parse(input.jobInput);
  const result = generatedMediaTranscriptSchema.parse(input.result);
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from media_transcript_runs where id = ${jobInput.runId} for update`);
    const rows = await tx.select().from(mediaTranscriptRuns).where(and(eq(mediaTranscriptRuns.id, jobInput.runId), eq(mediaTranscriptRuns.workspaceId, input.workspaceId))).limit(1);
    const run = rows[0];
    if (!run) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'media transcript run not found', 404);
    if (run.sourceChecksumSha256 !== jobInput.sourceChecksumSha256) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source checksum changed while transcribing', 409);
    if (run.status === 'READY' && run.currentVersion > 0) return { runId: run.id, version: run.currentVersion };
    const history = run.currentVersion > 0
      ? await tx.select().from(mediaTranscriptVersions).where(and(
        eq(mediaTranscriptVersions.workspaceId, input.workspaceId),
        eq(mediaTranscriptVersions.runId, run.id),
      )).orderBy(asc(mediaTranscriptVersions.version))
      : [];
    const previous = history.find((candidate) => candidate.version === run.currentVersion);
    const version = run.currentVersion + 1;
    const snapshot = mediaTranscriptSnapshotSchema.parse({ language: result.language, speakers: result.speakers, words: result.words, segments: result.segments, terminology: result.terminology });
    await tx.insert(mediaTranscriptVersions).values({
      id: stableId('mtv', run.id, String(version)), workspaceId: input.workspaceId, runId: run.id, version,
      source: 'ASR', provider: result.provider, model: result.model, snapshot, affectedSegmentIds: snapshot.segments.map((segment) => segment.id),
    });
    let currentVersion = version;
    if (previous !== undefined && previous.source !== 'ASR') {
      const latestAsrIndex = history.findLastIndex((candidate) => candidate.source === 'ASR');
      const overlays = history.slice(latestAsrIndex + 1);
      const correctedSegmentIds = [...new Set(overlays.filter((candidate) => candidate.source === 'CORRECTION').flatMap((candidate) =>
        Array.isArray(candidate.affectedSegmentIds) ? candidate.affectedSegmentIds.filter((id): id is string => typeof id === 'string') : [],
      ))];
      const preserveTerminology = overlays.some((candidate) => candidate.source === 'TERMINOLOGY');
      const previousSnapshot = mediaTranscriptSnapshotSchema.parse(previous.snapshot);
      const overlaySnapshot = applyTranscriptOverlay(snapshot, previousSnapshot, correctedSegmentIds, preserveTerminology);
      currentVersion += 1;
      await tx.insert(mediaTranscriptVersions).values({
        id: stableId('mtv', run.id, String(currentVersion)),
        workspaceId: input.workspaceId,
        runId: run.id,
        version: currentVersion,
        source: correctedSegmentIds.length > 0 ? 'CORRECTION' : 'TERMINOLOGY',
        provider: result.provider,
        model: result.model,
        snapshot: overlaySnapshot,
        affectedSegmentIds: correctedSegmentIds,
        createdBy: previous.createdBy,
      });
    }
    await tx.update(mediaTranscriptRuns).set({ status: 'READY', currentVersion, errorSummary: null, updatedAt: new Date() }).where(eq(mediaTranscriptRuns.id, run.id));
    return { runId: run.id, version: currentVersion };
  });
}

export async function failMediaTranscript(deps: DomainDeps, input: { workspaceId: string; jobInput: MediaTranscriptJobInput; message: string }): Promise<void> {
  const jobInput = mediaTranscriptJobInputSchema.parse(input.jobInput);
  await deps.db.update(mediaTranscriptRuns).set({ status: 'FAILED', errorSummary: input.message.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(mediaTranscriptRuns.id, jobInput.runId), eq(mediaTranscriptRuns.workspaceId, input.workspaceId)));
}

async function assetTranscriptRows(deps: DomainDeps, workspaceId: string, assetId: string) {
  const sourceRows = await deps.db.select({ version: assetVersions }).from(assets).innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId), eq(assetVersions.workspaceId, workspaceId))).limit(1);
  const source = sourceRows[0]?.version;
  if (!source) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset not found', 404);
  const runs = await deps.db.select().from(mediaTranscriptRuns).where(and(eq(mediaTranscriptRuns.workspaceId, workspaceId), eq(mediaTranscriptRuns.sourceAssetVersionId, source.id), eq(mediaTranscriptRuns.processorVersion, MEDIA_TRANSCRIPT_PROCESSOR_VERSION))).limit(1);
  return { source, run: runs[0] };
}

export async function getMediaTranscript(deps: DomainDeps, input: { workspaceId: string; assetId: string }): Promise<MediaTranscript> {
  const { source, run } = await assetTranscriptRows(deps, input.workspaceId, input.assetId);
  if (!run) return mediaTranscriptSchema.parse({ runId: null, sourceAssetVersionId: source.id, processorVersion: MEDIA_TRANSCRIPT_PROCESSOR_VERSION, status: null, errorSummary: null, currentVersion: null });
  const versions = run.currentVersion > 0 ? await deps.db.select().from(mediaTranscriptVersions).where(and(eq(mediaTranscriptVersions.workspaceId, input.workspaceId), eq(mediaTranscriptVersions.runId, run.id), eq(mediaTranscriptVersions.version, run.currentVersion))).limit(1) : [];
  const version = versions[0];
  return mediaTranscriptSchema.parse({
    runId: run.id, sourceAssetVersionId: source.id, processorVersion: run.processorVersion, status: run.status, errorSummary: run.errorSummary,
    currentVersion: version ? { id: version.id, version: version.version, source: version.source, provider: version.provider, model: version.model, ...mediaTranscriptSnapshotSchema.parse(version.snapshot), affectedSegmentIds: version.affectedSegmentIds, createdAt: version.createdAt.toISOString() } : null,
  });
}

export async function retryMediaTranscript(deps: DomainDeps, input: { workspaceId: string; assetId: string }): Promise<MediaTranscript> {
  const rows = await deps.db.select({ asset: assets, version: assetVersions }).from(assets).innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId))).limit(1);
  const row = rows[0];
  if (!row || row.version.checksumSha256 === null) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'ready source asset not found', 404);
  const runRows = await deps.db.select().from(mediaTranscriptRuns).where(and(eq(mediaTranscriptRuns.workspaceId, input.workspaceId), eq(mediaTranscriptRuns.sourceAssetVersionId, row.version.id), eq(mediaTranscriptRuns.processorVersion, MEDIA_TRANSCRIPT_PROCESSOR_VERSION))).limit(1);
  const run = runRows[0];
  if (!run) {
    const probe = row.version.mediaProbe === null ? null : sourceMediaProbeResultSchema.safeParse(row.version.mediaProbe);
    if (!probe?.success || probe.data.status !== 'READY' || !probe.data.streams.some((stream) => stream.type === 'AUDIO')) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source asset has no ready audio stream', 409);
    }
    await deps.db.transaction((tx) => scheduleMediaTranscriptInTx(tx, { workspaceId: input.workspaceId, projectId: row.asset.projectId, sourceAsset: row.asset, sourceVersion: row.version, hasAudio: true }));
    return getMediaTranscript(deps, input);
  }
  if (!['FAILED', 'STALE'].includes(run.status)) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'media transcript is not waiting for retry', 409, { status: run.status });
  const jobInput = mediaTranscriptJobInputSchema.parse({ runId: run.id, sourceAssetId: row.asset.id, sourceAssetVersionId: row.version.id, sourceStorageKey: row.version.storageKey, sourceChecksumSha256: row.version.checksumSha256, processorVersion: MEDIA_TRANSCRIPT_PROCESSOR_VERSION });
  await deps.db.transaction(async (tx) => {
    await tx.update(mediaTranscriptRuns).set({ status: 'QUEUED', errorSummary: null, sourceChecksumSha256: row.version.checksumSha256!, updatedAt: new Date() }).where(eq(mediaTranscriptRuns.id, run.id));
    await createJobInTx(tx, { workspaceId: input.workspaceId, projectId: row.asset.projectId, type: MEDIA_TRANSCRIPT_JOB_TYPE, input: jobInput, maxAttempts: 1, createdBy: row.asset.createdBy, classification: 'SYSTEM' });
  });
  return getMediaTranscript(deps, input);
}

async function appendEditedVersion(deps: DomainDeps, input: { workspaceId: string; assetId: string; userId: string | null; expectedVersion: number; source: 'CORRECTION' | 'TERMINOLOGY'; edit: (snapshot: ReturnType<typeof mediaTranscriptSnapshotSchema.parse>) => { snapshot: ReturnType<typeof mediaTranscriptSnapshotSchema.parse>; affectedSegmentIds: string[] } }): Promise<MediaTranscript> {
  const { run } = await assetTranscriptRows(deps, input.workspaceId, input.assetId);
  if (!run) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'media transcript run not found', 404);
  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from media_transcript_runs where id = ${run.id} for update`);
    const currentRows = await tx.select().from(mediaTranscriptRuns).where(and(eq(mediaTranscriptRuns.id, run.id), eq(mediaTranscriptRuns.workspaceId, input.workspaceId))).limit(1);
    const current = currentRows[0];
    if (!current || current.currentVersion !== input.expectedVersion || current.status !== 'READY') throw new ApiFailure(ERROR_CODES.VERSION_CONFLICT, 'transcript version changed; refresh before editing', 409, { currentVersion: current?.currentVersion ?? 0 });
    const versionRows = await tx.select().from(mediaTranscriptVersions).where(and(eq(mediaTranscriptVersions.runId, run.id), eq(mediaTranscriptVersions.version, current.currentVersion), eq(mediaTranscriptVersions.workspaceId, input.workspaceId))).limit(1);
    const previous = versionRows[0];
    if (!previous) throw new ApiFailure(ERROR_CODES.INTERNAL, 'current transcript version missing', 500);
    const edited = input.edit(mediaTranscriptSnapshotSchema.parse(previous.snapshot));
    const version = current.currentVersion + 1;
    await tx.insert(mediaTranscriptVersions).values({ id: `mtv_${randomUUID()}`, workspaceId: input.workspaceId, runId: run.id, version, source: input.source, provider: previous.provider, model: previous.model, snapshot: edited.snapshot, affectedSegmentIds: edited.affectedSegmentIds, createdBy: input.userId });
    await tx.update(mediaTranscriptRuns).set({ currentVersion: version, updatedAt: new Date() }).where(eq(mediaTranscriptRuns.id, run.id));
  });
  return getMediaTranscript(deps, { workspaceId: input.workspaceId, assetId: input.assetId });
}

export async function correctTranscriptSegment(deps: DomainDeps, input: { workspaceId: string; assetId: string; userId: string | null; request: CorrectTranscriptSegmentRequest }): Promise<MediaTranscript> {
  const request = correctTranscriptSegmentRequestSchema.parse(input.request);
  return appendEditedVersion(deps, { ...input, expectedVersion: request.expectedVersion, source: 'CORRECTION', edit(snapshot) {
    const segment = snapshot.segments.find((candidate) => candidate.id === request.segmentId);
    if (!segment) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'transcript segment not found', 404);
    const replacementWord = { ordinal: segment.wordStartOrdinal, text: request.text, speakerId: segment.speakerId, confidencePermille: null, sourceStartPts: segment.sourceStartPts, sourceEndPts: segment.sourceEndPts, timeBase: segment.timeBase };
    return { snapshot: mediaTranscriptSnapshotSchema.parse({ ...snapshot, segments: snapshot.segments.map((candidate) => candidate.id === segment.id ? { ...candidate, text: request.text, wordEndOrdinal: segment.wordStartOrdinal, reviewState: 'CORRECTED' } : candidate), words: [...snapshot.words.filter((word) => word.ordinal < segment.wordStartOrdinal || word.ordinal > segment.wordEndOrdinal), replacementWord].sort((a, b) => a.ordinal - b.ordinal) }), affectedSegmentIds: [segment.id] };
  } });
}

export async function updateTranscriptTerminology(deps: DomainDeps, input: { workspaceId: string; assetId: string; userId: string | null; request: UpdateTranscriptTerminologyRequest }): Promise<MediaTranscript> {
  const request = updateTranscriptTerminologyRequestSchema.parse(input.request);
  return appendEditedVersion(deps, { ...input, expectedVersion: request.expectedVersion, source: 'TERMINOLOGY', edit(snapshot) { return { snapshot: mediaTranscriptSnapshotSchema.parse({ ...snapshot, terminology: request.entries }), affectedSegmentIds: [] }; } });
}
