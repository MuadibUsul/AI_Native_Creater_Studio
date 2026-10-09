import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { mediaRationalSchema } from './assets.js';

export const MEDIA_VISUAL_ANALYSIS_JOB_TYPE = 'MEDIA_VISUAL_ANALYSIS';
export const MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION = 'source-visual-analysis-v1';
const ptsSchema = z.string().regex(/^-?\d+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const visualSourceAnchorSchema = z.object({
  sourceStartPts: ptsSchema,
  sourceEndPts: ptsSchema,
  timeBase: mediaRationalSchema,
}).strict().superRefine((value, context) => {
  if (BigInt(value.sourceEndPts) <= BigInt(value.sourceStartPts)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceEndPts'], message: 'visual source range must be positive' });
});

export const visualEvidenceFrameSchema = z.object({
  pts: ptsSchema,
  timeBase: mediaRationalSchema,
  frameRef: z.string().min(1).max(200),
}).strict();

export const visualTrackKeyframeSchema = z.object({
  pts: ptsSchema,
  box: z.array(z.number().min(0).max(1)).length(4),
  state: z.enum(['VISIBLE', 'OCCLUDED', 'UNCERTAIN']),
  confidencePermille: z.number().int().min(0).max(1000),
}).strict();

const trackBase = visualSourceAnchorSchema.extend({
  id: z.string().min(1).max(120),
  label: z.string().trim().min(1).max(200),
  confidencePermille: z.number().int().min(0).max(1000),
  lifecycle: z.enum(['CONTINUOUS', 'OCCLUDED', 'LOST']),
  keyframes: z.array(visualTrackKeyframeSchema).min(1).max(10_000),
  evidenceFrames: z.array(visualEvidenceFrameSchema).min(1).max(100),
}).strict();

export const generatedObjectTrackSchema = trackBase;
export const generatedPersonTrackSchema = trackBase.safeExtend({
  label: z.literal('person'),
  identityState: z.literal('UNKNOWN'),
}).strict();

export const generatedVisualEventSchema = visualSourceAnchorSchema.extend({
  id: z.string().min(1).max(120),
  label: z.string().trim().min(1).max(200),
  subjectTrackId: z.string().min(1).max(120).nullable(),
  confidencePermille: z.number().int().min(0).max(1000),
  evidenceFrames: z.array(visualEvidenceFrameSchema).min(1).max(100),
}).strict();

export const generatedMotionIntensitySchema = visualSourceAnchorSchema.extend({
  id: z.string().min(1).max(120),
  valuePermille: z.number().int().min(0).max(1000),
  method: z.string().min(1).max(160),
  evidenceFrames: z.array(visualEvidenceFrameSchema).min(1).max(100),
}).strict();

export const generatedMediaVisualAnalysisSchema = z.object({
  schemaVersion: z.literal('1.0'),
  processorVersion: z.literal(MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION),
  adapter: z.string().min(1).max(120),
  modelVersion: z.string().min(1).max(160),
  sampledFrameCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  objectTracks: z.array(generatedObjectTrackSchema).max(100_000),
  personTracks: z.array(generatedPersonTrackSchema).max(100_000),
  actionEvents: z.array(generatedVisualEventSchema).max(100_000),
  visualEvents: z.array(generatedVisualEventSchema).max(100_000),
  motionIntensity: z.array(generatedMotionIntensitySchema).max(100_000),
}).strict();

export const mediaVisualAnalysisJobInputSchema = z.object({
  runId: opaqueIdSchema,
  sourceAssetId: opaqueIdSchema,
  sourceAssetVersionId: opaqueIdSchema,
  sourceStorageKey: z.string().min(1).max(512),
  sourceChecksumSha256: sha256Schema,
  processorVersion: z.literal(MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION),
  analysisConfigHash: sha256Schema,
}).strict();

export type GeneratedMediaVisualAnalysis = z.infer<typeof generatedMediaVisualAnalysisSchema>;
export type MediaVisualAnalysisJobInput = z.infer<typeof mediaVisualAnalysisJobInputSchema>;

/** Worker I/O seam. Implementations return candidates and evidence only; they never assign real-world identity. */
export interface MediaVisualAnalysisAdapter {
  readonly kind: string;
  analyze(input: { sourcePath: string }): Promise<GeneratedMediaVisualAnalysis>;
}
