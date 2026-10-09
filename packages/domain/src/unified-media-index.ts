import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION,
  MEDIA_INDEX_PROCESSOR_VERSION,
  MEDIA_TRANSCRIPT_PROCESSOR_VERSION,
  MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION,
  UNIFIED_MEDIA_INDEX_KINDS,
  mediaIndexRecordSchema,
  mediaTranscriptSnapshotSchema,
  sourceMediaProbeResultSchema,
  unifiedMediaIndexPageSchema,
  unifiedMediaIndexQuerySchema,
  type MediaIndexCapability,
  type MediaIndexRecord,
  type UnifiedMediaIndexKind,
  type UnifiedMediaIndexPage,
} from '@ancs/contracts';
import {
  assets,
  assetVersions,
  mediaIndexEntries,
  mediaIndexRuns,
  mediaRangeTags,
  mediaTranscriptRuns,
  mediaTranscriptVersions,
} from '@ancs/db';
import type { DomainDeps } from './channels.js';

type Query = {
  kind?: UnifiedMediaIndexKind;
  sourceStartPts?: string;
  sourceEndPts?: string;
  timeBaseNumerator?: number;
  timeBaseDenominator?: number;
  cursor?: number;
  limit?: number;
};

const sha256 = (...values: string[]): string => createHash('sha256').update(values.join('\0')).digest('hex');

function overlaps(record: MediaIndexRecord, query: ReturnType<typeof unifiedMediaIndexQuerySchema.parse>): boolean {
  if (query.sourceStartPts === undefined || query.sourceEndPts === undefined || query.timeBaseNumerator === undefined || query.timeBaseDenominator === undefined) return true;
  const recordBase = record.sourceRange.timeBase;
  const queryStartInCommon = BigInt(query.sourceStartPts) * BigInt(query.timeBaseNumerator) * BigInt(recordBase.denominator);
  const queryEndInCommon = BigInt(query.sourceEndPts) * BigInt(query.timeBaseNumerator) * BigInt(recordBase.denominator);
  const recordStartInCommon = BigInt(record.sourceRange.startPts) * BigInt(recordBase.numerator) * BigInt(query.timeBaseDenominator);
  const recordEndInCommon = BigInt(record.sourceRange.endPts) * BigInt(recordBase.numerator) * BigInt(query.timeBaseDenominator);
  return recordStartInCommon < queryEndInCommon && recordEndInCommon > queryStartInCommon;
}

function statusForRun(status: string | undefined, count: number): MediaIndexCapability['status'] {
  if (status === undefined) return 'NOT_ANALYZED';
  if (status === 'FAILED') return 'FAILED';
  if (status === 'PARTIAL' || status === 'RUNNING' || status === 'QUEUED') return 'PARTIAL';
  if (status === 'READY') return count === 0 ? 'EMPTY' : 'READY';
  if (status === 'EMPTY') return 'EMPTY';
  return 'NOT_ANALYZED';
}

export async function listUnifiedMediaIndex(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; query?: Query },
): Promise<UnifiedMediaIndexPage> {
  const query = unifiedMediaIndexQuerySchema.parse(input.query ?? {});
  const sourceRows = await deps.db.select({ asset: assets, version: assetVersions }).from(assets)
    .innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(
      eq(assets.id, input.assetId),
      eq(assets.workspaceId, input.workspaceId),
      eq(assetVersions.workspaceId, input.workspaceId),
      isNull(assets.deletedAt),
    )).limit(1);
  const source = sourceRows[0];
  if (!source) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset not found', 404);

  const [indexRunRows, transcriptRunRows, tags] = await Promise.all([
    deps.db.select().from(mediaIndexRuns).where(and(
      eq(mediaIndexRuns.workspaceId, input.workspaceId),
      eq(mediaIndexRuns.sourceAssetVersionId, source.version.id),
    )),
    deps.db.select().from(mediaTranscriptRuns).where(and(
      eq(mediaTranscriptRuns.workspaceId, input.workspaceId),
      eq(mediaTranscriptRuns.sourceAssetVersionId, source.version.id),
      eq(mediaTranscriptRuns.processorVersion, MEDIA_TRANSCRIPT_PROCESSOR_VERSION),
    )).limit(1),
    deps.db.select().from(mediaRangeTags).where(and(
      eq(mediaRangeTags.workspaceId, input.workspaceId),
      eq(mediaRangeTags.assetId, source.asset.id),
      eq(mediaRangeTags.sourceAssetVersionId, source.version.id),
    )).orderBy(asc(mediaRangeTags.createdAt), asc(mediaRangeTags.id)),
  ]);
  const indexRun = indexRunRows.find((run) => run.processorVersion === MEDIA_INDEX_PROCESSOR_VERSION);
  const visualRun = indexRunRows.find((run) => run.processorVersion === MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION);
  const audioRun = indexRunRows.find((run) => run.processorVersion === MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION);
  const transcriptRun = transcriptRunRows[0];
  const [indexEntries, transcriptVersionRows] = await Promise.all([
    indexRunRows.length === 0 ? Promise.resolve([]) : deps.db.select().from(mediaIndexEntries).where(and(
      eq(mediaIndexEntries.workspaceId, input.workspaceId),
      inArray(mediaIndexEntries.runId, indexRunRows.map((run) => run.id)),
      eq(mediaIndexEntries.lifecycleState, 'ACTIVE'),
    )).orderBy(asc(mediaIndexEntries.kind), asc(mediaIndexEntries.ordinal), asc(mediaIndexEntries.id)),
    transcriptRun === undefined || transcriptRun.currentVersion < 1 ? Promise.resolve([]) : deps.db.select().from(mediaTranscriptVersions).where(and(
      eq(mediaTranscriptVersions.workspaceId, input.workspaceId),
      eq(mediaTranscriptVersions.runId, transcriptRun.id),
      eq(mediaTranscriptVersions.version, transcriptRun.currentVersion),
    )).limit(1),
  ]);

  const probe = source.version.mediaProbe === null ? null : sourceMediaProbeResultSchema.safeParse(source.version.mediaProbe);
  const audioStream = probe?.success ? probe.data.streams.find((stream) => stream.type === 'AUDIO') : undefined;
  const transcriptVersion = transcriptVersionRows[0];
  const transcript = transcriptVersion === undefined ? null : mediaTranscriptSnapshotSchema.parse(transcriptVersion.snapshot);
  const privacyClass = source.asset.sensitivityClass === 'SENSITIVE' || source.asset.sensitivityClass === 'RESTRICTED' ? 'SENSITIVE' as const : 'WORKSPACE' as const;
  const records: MediaIndexRecord[] = [];

  for (const entry of indexEntries) {
    const kind = entry.kind === 'SHOT' ? 'SHOT_BOUNDARY' : entry.kind as UnifiedMediaIndexKind;
    records.push(mediaIndexRecordSchema.parse({
      id: entry.id,
      workspaceId: input.workspaceId,
      sourceAssetVersionId: source.version.id,
      streamId: entry.streamId,
      sourceRange: { startPts: entry.sourceStartPts, endPts: entry.sourceEndPts, timeBase: { numerator: entry.timeBaseNumerator, denominator: entry.timeBaseDenominator } },
      kind,
      payloadSchemaVersion: entry.payloadSchemaVersion,
      payload: entry.payload,
      evidenceRefs: entry.evidenceRefs,
      observedBy: entry.observedBy,
      observedAt: entry.observedAt.toISOString(),
      basis: entry.basis,
      confidenceValue: entry.confidencePermille === null ? null : entry.confidencePermille / 1000,
      confidenceMethod: entry.confidenceMethod,
      calibrationStatus: entry.calibrationStatus,
      toolId: entry.toolId,
      toolVersion: entry.toolVersion,
      modelVersion: entry.modelVersion,
      analysisConfigHash: entry.analysisConfigHash,
      indexVersion: entry.indexVersion,
      supersedesRecordId: entry.supersedesRecordId,
      correctionRecordId: entry.correctionRecordId,
      privacyClass,
      accessPolicyRef: entry.accessPolicyRef,
      lifecycleState: entry.lifecycleState,
    }));
  }

  if (transcript !== null && transcriptVersion !== undefined) {
    const configHash = sha256(MEDIA_TRANSCRIPT_PROCESSOR_VERSION, transcriptVersion.provider, transcriptVersion.model);
    const common = {
      workspaceId: input.workspaceId,
      sourceAssetVersionId: source.version.id,
      streamId: audioStream === undefined ? null : `audio:${String(audioStream.index)}`,
      payloadSchemaVersion: '1.0' as const,
      observedBy: transcriptVersion.provider,
      observedAt: transcriptVersion.createdAt.toISOString(),
      basis: transcriptVersion.source === 'ASR' ? 'MODEL_INFERRED' as const : 'USER_CONFIRMED' as const,
      confidenceMethod: 'ASR_PROVIDER_CONFIDENCE',
      calibrationStatus: transcriptVersion.source === 'ASR' ? 'UNCALIBRATED' as const : 'USER_CONFIRMED' as const,
      toolId: 'speech-recognition-adapter',
      toolVersion: MEDIA_TRANSCRIPT_PROCESSOR_VERSION,
      modelVersion: transcriptVersion.model,
      analysisConfigHash: configHash,
      indexVersion: transcriptVersion.version,
      supersedesRecordId: null,
      correctionRecordId: transcriptVersion.source === 'ASR' ? null : transcriptVersion.id,
      privacyClass,
      accessPolicyRef: 'workspace:read',
      lifecycleState: 'ACTIVE' as const,
    };
    for (const word of transcript.words) {
      const sourceRange = { startPts: word.sourceStartPts, endPts: word.sourceEndPts, timeBase: word.timeBase };
      records.push(mediaIndexRecordSchema.parse({ ...common, id: `umi_tw_${sha256(transcriptVersion.id, String(word.ordinal)).slice(0, 24)}`, kind: 'TRANSCRIPT_WORD', sourceRange, payload: { text: word.text, speakerId: word.speakerId, language: transcript.language }, evidenceRefs: [{ type: 'AUDIO_WINDOW', refId: `${source.version.id}:${word.sourceStartPts}-${word.sourceEndPts}`, sourceRange }], confidenceValue: word.confidencePermille === null ? null : word.confidencePermille / 1000 }));
    }
    const speakers = new Map(transcript.speakers.map((speaker) => [speaker.id, speaker]));
    for (const segment of transcript.segments) {
      const words = transcript.words.filter((word) => word.ordinal >= segment.wordStartOrdinal && word.ordinal <= segment.wordEndOrdinal);
      const confidences = words.flatMap((word) => word.confidencePermille === null ? [] : [word.confidencePermille]);
      const confidenceValue = confidences.length === 0 ? null : confidences.reduce((sum, value) => sum + value, 0) / confidences.length / 1000;
      const sourceRange = { startPts: segment.sourceStartPts, endPts: segment.sourceEndPts, timeBase: segment.timeBase };
      records.push(mediaIndexRecordSchema.parse({ ...common, id: `umi_ts_${sha256(transcriptVersion.id, segment.id).slice(0, 24)}`, kind: 'TRANSCRIPT_SEGMENT', sourceRange, payload: { text: segment.text, speakerId: segment.speakerId, language: transcript.language, reviewState: segment.reviewState }, evidenceRefs: [{ type: 'AUDIO_WINDOW', refId: `${source.version.id}:${segment.sourceStartPts}-${segment.sourceEndPts}`, sourceRange }], confidenceValue }));
      const speaker = segment.speakerId === null ? undefined : speakers.get(segment.speakerId);
      if (speaker !== undefined) records.push(mediaIndexRecordSchema.parse({ ...common, id: `umi_sp_${sha256(transcriptVersion.id, segment.id, speaker.id).slice(0, 24)}`, kind: 'SPEAKER_SEGMENT', sourceRange, payload: { speakerId: speaker.id, displayName: speaker.displayName, identityState: speaker.identityState }, evidenceRefs: [{ type: 'RECORD', refId: `umi_ts_${sha256(transcriptVersion.id, segment.id).slice(0, 24)}`, sourceRange }], confidenceValue: speaker.confidencePermille === null ? null : speaker.confidencePermille / 1000 }));
    }
  }

  const markerConfigHash = sha256('ancs-user-marker', '1');
  for (const tag of tags) {
    const sourceRange = { startPts: tag.sourceStartPts, endPts: tag.sourceEndPts, timeBase: { numerator: tag.timeBaseNumerator, denominator: tag.timeBaseDenominator } };
    records.push(mediaIndexRecordSchema.parse({
      id: tag.id, workspaceId: input.workspaceId, sourceAssetVersionId: source.version.id, streamId: null, sourceRange,
      kind: 'USER_MARKER', payloadSchemaVersion: '1.0', payload: { label: tag.label }, evidenceRefs: [{ type: 'SOURCE_RANGE', refId: tag.id, sourceRange }],
      observedBy: tag.createdBy ?? 'workspace-user', observedAt: tag.createdAt.toISOString(), basis: 'USER_SUPPLIED', confidenceValue: null, confidenceMethod: null,
      calibrationStatus: 'NOT_APPLICABLE', toolId: 'ancs-user-marker', toolVersion: '1', modelVersion: null, analysisConfigHash: markerConfigHash,
      indexVersion: 1, supersedesRecordId: null, correctionRecordId: null, privacyClass, accessPolicyRef: 'workspace:read', lifecycleState: 'ACTIVE',
    }));
  }

  const counts = new Map<UnifiedMediaIndexKind, number>(UNIFIED_MEDIA_INDEX_KINDS.map((kind) => [kind, 0]));
  for (const record of records) counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
  const legacyKinds = new Set<UnifiedMediaIndexKind>(['THUMBNAIL', 'WAVEFORM', 'QUALITY', 'SHOT_BOUNDARY']);
  const transcriptKinds = new Set<UnifiedMediaIndexKind>(['TRANSCRIPT_WORD', 'TRANSCRIPT_SEGMENT', 'SPEAKER_SEGMENT']);
  const visualKinds = new Set<UnifiedMediaIndexKind>(['OBJECT_TRACK', 'ACTION_EVENT', 'PERSON_TRACK', 'VISUAL_EVENT', 'MOTION_INTENSITY']);
  const audioKinds = new Set<UnifiedMediaIndexKind>(['AUDIO_EVENT', 'MUSIC_BEAT']);
  const supportedLegacy = new Set((indexRun?.supportedKinds as string[] | undefined) ?? []);
  const capabilities = UNIFIED_MEDIA_INDEX_KINDS.map((kind): MediaIndexCapability => {
    const count = counts.get(kind) ?? 0;
    if (kind === 'USER_MARKER') return { kind, supported: true, status: count === 0 ? 'EMPTY' : 'READY', coveragePermille: 1000, recordCount: count, errorSummary: null, toolId: 'ancs-user-marker', toolVersion: '1', modelVersion: null };
    if (legacyKinds.has(kind)) {
      const streamSupported = kind === 'WAVEFORM' ? audioStream !== undefined : probe?.success === true && probe.data.streams.some((stream) => stream.type === 'VIDEO');
      const supported = streamSupported && (indexRun === undefined || supportedLegacy.has(kind));
      if (!supported) return { kind, supported: false, status: 'UNSUPPORTED', coveragePermille: 0, recordCount: 0, errorSummary: null, toolId: null, toolVersion: null, modelVersion: null };
      return { kind, supported: true, status: statusForRun(indexRun?.status, count), coveragePermille: indexRun?.coveragePermille ?? 0, recordCount: count, errorSummary: indexRun?.errorSummary ?? null, toolId: indexRun?.toolId ?? 'ffmpeg', toolVersion: indexRun?.toolVersion ?? MEDIA_INDEX_PROCESSOR_VERSION, modelVersion: null };
    }
    if (transcriptKinds.has(kind)) {
      if (audioStream === undefined) return { kind, supported: false, status: 'UNSUPPORTED', coveragePermille: 0, recordCount: 0, errorSummary: null, toolId: null, toolVersion: null, modelVersion: null };
      const status = statusForRun(transcriptRun?.status, count);
      return { kind, supported: true, status, coveragePermille: status === 'READY' || status === 'EMPTY' ? 1000 : 0, recordCount: count, errorSummary: transcriptRun?.errorSummary ?? null, toolId: 'speech-recognition-adapter', toolVersion: MEDIA_TRANSCRIPT_PROCESSOR_VERSION, modelVersion: transcriptVersion?.model ?? null };
    }
    if (visualKinds.has(kind)) {
      const hasVideo = probe?.success === true && probe.data.streams.some((stream) => stream.type === 'VIDEO');
      if (!hasVideo) return { kind, supported: false, status: 'UNSUPPORTED', coveragePermille: 0, recordCount: 0, errorSummary: null, toolId: null, toolVersion: null, modelVersion: null };
      const status = statusForRun(visualRun?.status, count);
      const firstRecord = records.find((record) => record.kind === kind);
      return { kind, supported: true, status, coveragePermille: visualRun?.coveragePermille ?? 0, recordCount: count, errorSummary: visualRun?.errorSummary ?? null, toolId: visualRun?.toolId ?? 'visual-analysis-adapter', toolVersion: visualRun?.toolVersion ?? MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION, modelVersion: firstRecord?.modelVersion ?? null };
    }
    if (audioKinds.has(kind)) {
      if (audioStream === undefined) return { kind, supported: false, status: 'UNSUPPORTED', coveragePermille: 0, recordCount: 0, errorSummary: null, toolId: null, toolVersion: null, modelVersion: null };
      const status = statusForRun(audioRun?.status, count);
      const firstRecord = records.find((record) => record.kind === kind);
      return { kind, supported: true, status, coveragePermille: audioRun?.coveragePermille ?? 0, recordCount: count, errorSummary: audioRun?.errorSummary ?? null, toolId: audioRun?.toolId ?? 'audio-analysis-adapter', toolVersion: audioRun?.toolVersion ?? MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION, modelVersion: firstRecord?.modelVersion ?? null };
    }
    return { kind, supported: false, status: 'UNSUPPORTED', coveragePermille: 0, recordCount: 0, errorSummary: null, toolId: null, toolVersion: null, modelVersion: null };
  });

  const filtered = records.filter((record) => (query.kind === undefined || record.kind === query.kind) && overlaps(record, query));
  filtered.sort((left, right) => {
    const leftStart = BigInt(left.sourceRange.startPts) * BigInt(left.sourceRange.timeBase.numerator) * BigInt(right.sourceRange.timeBase.denominator);
    const rightStart = BigInt(right.sourceRange.startPts) * BigInt(right.sourceRange.timeBase.numerator) * BigInt(left.sourceRange.timeBase.denominator);
    if (leftStart !== rightStart) return leftStart < rightStart ? -1 : 1;
    return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
  });
  const cursor = query.cursor ?? 0;
  const page = filtered.slice(cursor, cursor + query.limit);
  return unifiedMediaIndexPageSchema.parse({
    sourceAssetVersionId: source.version.id,
    indexVersion: Math.max(...indexRunRows.map((run) => run.indexVersion), transcriptVersion?.version ?? 1),
    capabilities,
    items: page,
    nextCursor: cursor + query.limit < filtered.length ? String(cursor + query.limit) : null,
  });
}
