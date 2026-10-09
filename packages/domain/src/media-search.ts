import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  createMediaRangeTagRequestSchema,
  mediaRangeTagListSchema,
  mediaSegmentSearchQuerySchema,
  mediaSegmentSearchResponseSchema,
  mediaTranscriptSnapshotSchema,
  type CreateMediaRangeTagRequest,
  type MediaRangeTag,
  type MediaSegmentSearchResponse,
  type MediaSegmentSearchResult,
} from '@ancs/contracts';
import { assets, assetVersions, mediaIndexEntries, mediaIndexRuns, mediaRangeTags, mediaTranscriptRuns, mediaTranscriptVersions } from '@ancs/db';
import type { DomainDeps } from './channels.js';

const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const chineseOrdinal = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'] as const;
const resultId = (...parts: string[]): string => `msr_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;

function matchConcept(query: string, concepts: string[]): string[] {
  const normalizedQuery = normalize(query);
  return concepts.filter((concept) => {
    const normalized = normalize(concept);
    return normalized.includes(normalizedQuery) || (normalized.length >= 2 && normalizedQuery.includes(normalized));
  });
}

function tagDto(row: typeof mediaRangeTags.$inferSelect): MediaRangeTag {
  return { id: row.id, assetId: row.assetId, sourceAssetVersionId: row.sourceAssetVersionId, label: row.label, sourceStartPts: row.sourceStartPts, sourceEndPts: row.sourceEndPts, timeBase: { numerator: row.timeBaseNumerator, denominator: row.timeBaseDenominator }, createdAt: row.createdAt.toISOString() };
}

async function loadCurrentAsset(deps: DomainDeps, workspaceId: string, assetId: string) {
  const rows = await deps.db.select({ asset: assets, version: assetVersions }).from(assets).innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId), eq(assetVersions.workspaceId, workspaceId), isNull(assets.deletedAt))).limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset not found', 404);
  return row;
}

export async function listMediaRangeTags(deps: DomainDeps, input: { workspaceId: string; assetId: string }): Promise<{ items: MediaRangeTag[] }> {
  const row = await loadCurrentAsset(deps, input.workspaceId, input.assetId);
  const tags = await deps.db.select().from(mediaRangeTags).where(and(eq(mediaRangeTags.workspaceId, input.workspaceId), eq(mediaRangeTags.assetId, row.asset.id), eq(mediaRangeTags.sourceAssetVersionId, row.version.id))).orderBy(desc(mediaRangeTags.createdAt));
  return mediaRangeTagListSchema.parse({ items: tags.map(tagDto) });
}

export async function createMediaRangeTag(deps: DomainDeps, input: { workspaceId: string; assetId: string; userId: string | null; request: CreateMediaRangeTagRequest }): Promise<MediaRangeTag> {
  const request = createMediaRangeTagRequestSchema.parse(input.request);
  const row = await loadCurrentAsset(deps, input.workspaceId, input.assetId);
  const inserted = await deps.db.insert(mediaRangeTags).values({ id: `mrt_${randomUUID()}`, workspaceId: input.workspaceId, assetId: row.asset.id, sourceAssetVersionId: row.version.id, label: request.label, sourceStartPts: request.sourceStartPts, sourceEndPts: request.sourceEndPts, timeBaseNumerator: request.timeBase.numerator, timeBaseDenominator: request.timeBase.denominator, createdBy: input.userId }).returning();
  return tagDto(inserted[0]!);
}

export async function deleteMediaRangeTag(deps: DomainDeps, input: { workspaceId: string; assetId: string; tagId: string }): Promise<void> {
  await loadCurrentAsset(deps, input.workspaceId, input.assetId);
  const deleted = await deps.db.delete(mediaRangeTags).where(and(eq(mediaRangeTags.id, input.tagId), eq(mediaRangeTags.workspaceId, input.workspaceId), eq(mediaRangeTags.assetId, input.assetId))).returning({ id: mediaRangeTags.id });
  if (deleted[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'media range tag not found', 404);
}

export async function searchMediaSegments(deps: DomainDeps, input: { workspaceId: string; query: string; limit?: number }): Promise<MediaSegmentSearchResponse> {
  const request = mediaSegmentSearchQuerySchema.parse({ q: input.query, limit: input.limit });
  const results: Array<MediaSegmentSearchResult & { score: number }> = [];

  const tags = await deps.db.select({ tag: mediaRangeTags }).from(mediaRangeTags).innerJoin(assets, and(eq(assets.id, mediaRangeTags.assetId), eq(assets.workspaceId, input.workspaceId), eq(assets.currentVersionId, mediaRangeTags.sourceAssetVersionId)))
    .where(and(eq(mediaRangeTags.workspaceId, input.workspaceId), isNull(assets.deletedAt))).limit(500);
  for (const { tag } of tags) {
    const matchedTerms = matchConcept(request.q, [tag.label]);
    if (matchedTerms.length === 0) continue;
    results.push({ id: resultId('tag', tag.id), assetId: tag.assetId, sourceAssetVersionId: tag.sourceAssetVersionId, modality: 'USER_TAG', evidence: 'USER_ASSERTED', label: tag.label, sourceStartPts: tag.sourceStartPts, sourceEndPts: tag.sourceEndPts, timeBase: { numerator: tag.timeBaseNumerator, denominator: tag.timeBaseDenominator }, matchedTerms, confidencePermille: 1000, contentTreatment: 'REFERENCE_DATA_ONLY', score: 300 });
  }

  const transcriptRows = await deps.db.select({ run: mediaTranscriptRuns, version: mediaTranscriptVersions, asset: assets }).from(mediaTranscriptRuns)
    .innerJoin(mediaTranscriptVersions, and(eq(mediaTranscriptVersions.runId, mediaTranscriptRuns.id), eq(mediaTranscriptVersions.version, mediaTranscriptRuns.currentVersion)))
    .innerJoin(assetVersions, eq(assetVersions.id, mediaTranscriptRuns.sourceAssetVersionId))
    .innerJoin(assets, and(eq(assets.id, assetVersions.assetId), eq(assets.currentVersionId, assetVersions.id)))
    .where(and(eq(mediaTranscriptRuns.workspaceId, input.workspaceId), eq(mediaTranscriptVersions.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId), eq(assets.workspaceId, input.workspaceId), eq(mediaTranscriptRuns.status, 'READY'), isNull(assets.deletedAt))).limit(200);
  for (const row of transcriptRows) {
    const snapshot = mediaTranscriptSnapshotSchema.parse(row.version.snapshot);
    for (const segment of snapshot.segments) {
      const position = segment.ordinal + 1;
      const ordinal = position <= 10 ? `第${chineseOrdinal[position - 1]}次回答` : `第${String(position)}次回答`;
      const concepts = [segment.text, ordinal, `第${String(position)}次回答`];
      const matchedTerms = matchConcept(request.q, concepts);
      if (matchedTerms.length === 0) continue;
      results.push({ id: resultId('transcript', row.version.id, segment.id), assetId: row.asset.id, sourceAssetVersionId: row.run.sourceAssetVersionId, modality: 'TRANSCRIPT', evidence: 'INFERENCE', label: segment.text, sourceStartPts: segment.sourceStartPts, sourceEndPts: segment.sourceEndPts, timeBase: segment.timeBase, matchedTerms, confidencePermille: null, contentTreatment: 'REFERENCE_DATA_ONLY', score: normalize(segment.text).includes(normalize(request.q)) ? 220 : 180 });
    }
  }

  const indexRows = await deps.db.select({ entry: mediaIndexEntries, run: mediaIndexRuns, asset: assets }).from(mediaIndexEntries)
    .innerJoin(mediaIndexRuns, eq(mediaIndexRuns.id, mediaIndexEntries.runId))
    .innerJoin(assetVersions, eq(assetVersions.id, mediaIndexRuns.sourceAssetVersionId))
    .innerJoin(assets, and(eq(assets.id, assetVersions.assetId), eq(assets.currentVersionId, assetVersions.id)))
    .where(and(eq(mediaIndexEntries.workspaceId, input.workspaceId), eq(mediaIndexEntries.lifecycleState, 'ACTIVE'), eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId), eq(assets.workspaceId, input.workspaceId), isNull(assets.deletedAt))).limit(1000);
  for (const row of indexRows) {
    const payload = row.entry.payload as Record<string, unknown>;
    const payloadLabels = Object.values(payload).flatMap((value) => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    const label = ['OBJECT_TRACK', 'ACTION_EVENT', 'PERSON_TRACK', 'VISUAL_EVENT'].includes(row.entry.kind)
      ? String(payload['label'] ?? '视觉候选')
      : row.entry.kind === 'MOTION_INTENSITY'
        ? `运动强度 ${String(payload['valuePermille'] ?? '')}`.trim()
        : row.entry.kind === 'SHOT' ? `镜头 ${String(row.entry.ordinal + 1)}` : row.entry.kind === 'QUALITY' ? String(payload['marker'] ?? '质量标记') : row.entry.kind === 'WAVEFORM' ? '音频波形' : `缩略图 ${String(row.entry.ordinal + 1)}`;
    const matchedTerms = matchConcept(request.q, [label, ...payloadLabels]);
    if (matchedTerms.length === 0) continue;
    const score = normalize(label) === normalize(request.q) ? 260 : normalize(label).includes(normalize(request.q)) ? 230 : 200;
    results.push({ id: resultId('index', row.entry.id), assetId: row.asset.id, sourceAssetVersionId: row.run.sourceAssetVersionId, modality: row.entry.kind === 'WAVEFORM' || payload['marker'] === 'SILENCE' ? 'AUDIO' : 'VISUAL', evidence: row.entry.basis === 'MODEL_INFERRED' ? 'INFERENCE' : 'OBSERVATION', label, sourceStartPts: row.entry.sourceStartPts, sourceEndPts: row.entry.sourceEndPts, timeBase: { numerator: row.entry.timeBaseNumerator, denominator: row.entry.timeBaseDenominator }, matchedTerms, confidencePermille: row.entry.confidencePermille, contentTreatment: 'REFERENCE_DATA_ONLY', score });
  }

  results.sort((a, b) => {
    const score = b.score - a.score;
    if (score !== 0) return score;
    const asset = a.assetId.localeCompare(b.assetId);
    if (asset !== 0) return asset;
    const left = BigInt(a.sourceStartPts);
    const right = BigInt(b.sourceStartPts);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return mediaSegmentSearchResponseSchema.parse({ query: request.q, items: results.slice(0, request.limit).map(({ score: _score, ...result }) => result), truncated: results.length > request.limit });
}
