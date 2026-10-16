import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  mediaEvidenceBundleSchema,
  mediaEvidenceRequestSchema,
  unifiedMediaIndexPageSchema,
  type MediaEvidenceBundle,
  type MediaEvidenceRequest,
} from '@ancs/contracts';
import { assets, assetVersions, mediaEvidenceCaches, mediaIndexRuns, mediaRangeTags, mediaTranscriptRuns } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { listUnifiedMediaIndex } from './unified-media-index.js';

const sha256 = (...parts: string[]): string => createHash('sha256').update(parts.join('\0')).digest('hex');

const whyFetched = (consumer: MediaEvidenceRequest['consumer']): string => ({
  DIRECTOR: 'Director 规划读取当前素材的已授权多模态证据。',
  SELECTION: '选区解析读取当前源范围内的已授权声画证据。',
  REFERENCE_ANALYSIS: '参考分析读取当前源范围内的已授权结构证据。',
})[consumer];

export async function getMediaEvidenceBundle(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; permissionContext: string; request: MediaEvidenceRequest },
): Promise<MediaEvidenceBundle> {
  const request = mediaEvidenceRequestSchema.parse(input.request);
  const sourceRows = await deps.db.select({ asset: assets, version: assetVersions }).from(assets)
    .innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId), isNull(assets.deletedAt))).limit(1);
  const source = sourceRows[0];
  if (!source) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset not found', 404);

  const [runs, transcripts, tags] = await Promise.all([
    deps.db.select().from(mediaIndexRuns).where(and(eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(mediaIndexRuns.sourceAssetVersionId, source.version.id))).orderBy(asc(mediaIndexRuns.processorVersion)),
    deps.db.select().from(mediaTranscriptRuns).where(and(eq(mediaTranscriptRuns.workspaceId, input.workspaceId), eq(mediaTranscriptRuns.sourceAssetVersionId, source.version.id))).orderBy(asc(mediaTranscriptRuns.processorVersion)),
    deps.db.select({ id: mediaRangeTags.id, createdAt: mediaRangeTags.createdAt }).from(mediaRangeTags).where(and(eq(mediaRangeTags.workspaceId, input.workspaceId), eq(mediaRangeTags.sourceAssetVersionId, source.version.id))).orderBy(asc(mediaRangeTags.id)),
  ]);
  const indexFingerprint = sha256(JSON.stringify({
    runs: runs.map((run) => [run.processorVersion, run.analysisConfigHash, run.indexVersion, run.status]),
    transcripts: transcripts.map((run) => [run.processorVersion, run.currentVersion, run.status]),
    tags: tags.map((tag) => [tag.id, tag.createdAt.toISOString()]),
  }));
  const permissionContextHash = sha256(input.permissionContext);
  const rangeKey = request.sourceStartPts === undefined ? 'ALL' : `${request.sourceStartPts}:${request.sourceEndPts}:${String(request.timeBaseNumerator)}:${String(request.timeBaseDenominator)}`;
  const cacheKey = sha256(input.workspaceId, source.version.id, request.consumer, request.kind ?? 'ALL', rangeKey, request.analysisConfigHash, indexFingerprint, permissionContextHash);
  const existingRows = await deps.db.select().from(mediaEvidenceCaches).where(and(eq(mediaEvidenceCaches.workspaceId, input.workspaceId), eq(mediaEvidenceCaches.cacheKey, cacheKey))).limit(1);
  const existing = existingRows[0];
  const sourceRange = request.sourceStartPts === undefined ? null : { startPts: request.sourceStartPts, endPts: request.sourceEndPts!, timeBase: { numerator: request.timeBaseNumerator!, denominator: request.timeBaseDenominator! } };
  if (existing) {
    const [updated] = await deps.db.update(mediaEvidenceCaches).set({ hitCount: sql`${mediaEvidenceCaches.hitCount} + 1`, lastAccessedAt: new Date() }).where(eq(mediaEvidenceCaches.id, existing.id)).returning();
    const row = updated ?? existing;
    return mediaEvidenceBundleSchema.parse({ cacheKey, cacheStatus: 'HIT', consumer: request.consumer, permissionContextHash, sourceAssetVersionId: source.version.id, sourceRange, requestedKind: request.kind ?? null, analysisConfigHash: request.analysisConfigHash, indexFingerprint, whyFetched: whyFetched(request.consumer), usage: { hitCount: row.hitCount, analysisReadCount: row.analysisReadCount, rangeReadCount: row.rangeReadCount }, page: unifiedMediaIndexPageSchema.parse(row.payload) });
  }

  const page = await listUnifiedMediaIndex(deps, { workspaceId: input.workspaceId, assetId: input.assetId, query: { ...(request.kind === undefined ? {} : { kind: request.kind }), ...(sourceRange === null ? {} : { sourceStartPts: sourceRange.startPts, sourceEndPts: sourceRange.endPts, timeBaseNumerator: sourceRange.timeBase.numerator, timeBaseDenominator: sourceRange.timeBase.denominator }), limit: 100 } });
  const rangeReadCount = sourceRange === null ? 0 : 1;
  await deps.db.insert(mediaEvidenceCaches).values({
    id: `mec_${randomUUID()}`, workspaceId: input.workspaceId, sourceAssetVersionId: source.version.id, cacheKey, consumer: request.consumer,
    sourceStartPts: sourceRange?.startPts ?? null, sourceEndPts: sourceRange?.endPts ?? null, timeBaseNumerator: sourceRange?.timeBase.numerator ?? null, timeBaseDenominator: sourceRange?.timeBase.denominator ?? null,
    requestedKind: request.kind ?? null, analysisConfigHash: request.analysisConfigHash, indexFingerprint, permissionContextHash, payload: page, hitCount: 0, analysisReadCount: 1, rangeReadCount,
  }).onConflictDoNothing({ target: mediaEvidenceCaches.cacheKey });
  return mediaEvidenceBundleSchema.parse({ cacheKey, cacheStatus: 'MISS', consumer: request.consumer, permissionContextHash, sourceAssetVersionId: source.version.id, sourceRange, requestedKind: request.kind ?? null, analysisConfigHash: request.analysisConfigHash, indexFingerprint, whyFetched: whyFetched(request.consumer), usage: { hitCount: 0, analysisReadCount: 1, rangeReadCount }, page });
}
