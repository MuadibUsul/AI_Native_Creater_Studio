import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { mediaRationalSchema } from './assets.js';

export const MEDIA_SEARCH_MODALITIES = ['VISUAL', 'AUDIO', 'TRANSCRIPT', 'USER_TAG'] as const;
export const MEDIA_SEARCH_EVIDENCE = ['OBSERVATION', 'INFERENCE', 'USER_ASSERTED'] as const;
export const mediaSearchModalitySchema = z.enum(MEDIA_SEARCH_MODALITIES);
export const mediaSearchEvidenceSchema = z.enum(MEDIA_SEARCH_EVIDENCE);
const ptsSchema = z.string().regex(/^-?\d+$/);

export const mediaRangeTagSchema = z.object({
  id: opaqueIdSchema,
  assetId: opaqueIdSchema,
  sourceAssetVersionId: opaqueIdSchema,
  label: z.string().trim().min(1).max(160),
  sourceStartPts: ptsSchema,
  sourceEndPts: ptsSchema,
  timeBase: mediaRationalSchema,
  createdAt: isoDateTimeSchema,
}).strict();

export const createMediaRangeTagRequestSchema = z.object({
  label: z.string().trim().min(1).max(160),
  sourceStartPts: ptsSchema,
  sourceEndPts: ptsSchema,
  timeBase: mediaRationalSchema,
}).strict().superRefine((value, context) => {
  if (BigInt(value.sourceEndPts) <= BigInt(value.sourceStartPts)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceEndPts'], message: 'source range must be positive' });
});

export const mediaRangeTagListSchema = z.object({ items: z.array(mediaRangeTagSchema) }).strict();

export const mediaSegmentSearchQuerySchema = z.object({ q: z.string().trim().min(2).max(160), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export const mediaSegmentSearchResultSchema = z.object({
  id: z.string().min(1).max(128),
  assetId: opaqueIdSchema,
  sourceAssetVersionId: opaqueIdSchema,
  modality: mediaSearchModalitySchema,
  evidence: mediaSearchEvidenceSchema,
  label: z.string().min(1).max(500),
  sourceStartPts: ptsSchema,
  sourceEndPts: ptsSchema,
  timeBase: mediaRationalSchema,
  matchedTerms: z.array(z.string().min(1).max(160)),
  confidencePermille: z.number().int().min(0).max(1000).nullable(),
  /** External/media text is reference data only and can never carry an executable action. */
  contentTreatment: z.literal('REFERENCE_DATA_ONLY'),
}).strict();
export const mediaSegmentSearchResponseSchema = z.object({ query: z.string().min(2).max(160), items: z.array(mediaSegmentSearchResultSchema), truncated: z.boolean() }).strict();

export type MediaRangeTag = z.infer<typeof mediaRangeTagSchema>;
export type CreateMediaRangeTagRequest = z.infer<typeof createMediaRangeTagRequestSchema>;
export type MediaSegmentSearchResult = z.infer<typeof mediaSegmentSearchResultSchema>;
export type MediaSegmentSearchResponse = z.infer<typeof mediaSegmentSearchResponseSchema>;
