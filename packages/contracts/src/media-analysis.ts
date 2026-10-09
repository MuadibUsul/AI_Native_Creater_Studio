import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

export const MEDIA_ANALYSIS_STAGES = ['PROBE', 'PROXY', 'WAVEFORM', 'ASR', 'SHOT', 'SAMPLING', 'VISION', 'OCR', 'AUDIO', 'EMBEDDINGS', 'SEARCH_INDEX'] as const;
export const MEDIA_ANALYSIS_STAGE_STATUSES = ['NOT_REQUESTED', 'QUEUED', 'RUNNING', 'PARTIAL', 'READY', 'EMPTY', 'FAILED', 'DISABLED', 'STALE', 'CANCEL_REQUESTED', 'CANCELLED'] as const;
export const mediaAnalysisStageNameSchema = z.enum(MEDIA_ANALYSIS_STAGES);
export const mediaAnalysisStageStatusSchema = z.enum(MEDIA_ANALYSIS_STAGE_STATUSES);
export const mediaAnalysisCheckpointSchema = z.object({
  cursor: z.string().max(200).nullable(),
  completedUnits: z.number().int().nonnegative(),
  totalUnits: z.number().int().nonnegative().nullable(),
}).strict();
export const mediaAnalysisStageSchema = z.object({
  id: opaqueIdSchema,
  stage: mediaAnalysisStageNameSchema,
  dependencies: z.array(mediaAnalysisStageNameSchema),
  status: mediaAnalysisStageStatusSchema,
  coveragePermille: z.number().int().min(0).max(1000),
  checkpoint: mediaAnalysisCheckpointSchema,
  detectorConfigHash: z.string().regex(/^[a-f0-9]{64}$/),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  jobId: opaqueIdSchema.nullable(),
  budgetMicros: z.number().int().nonnegative().nullable(),
  spentMicros: z.number().int().nonnegative(),
  errorSummary: z.string().max(500).nullable(),
  reusable: z.boolean(),
  updatedAt: isoDateTimeSchema,
}).strict();
export const mediaAnalysisGraphSchema = z.object({
  assetId: opaqueIdSchema,
  sourceAssetVersionId: opaqueIdSchema,
  playable: z.boolean(),
  deterministicEditingReady: z.boolean(),
  stages: z.array(mediaAnalysisStageSchema).length(MEDIA_ANALYSIS_STAGES.length),
}).strict().superRefine((value, context) => {
  const kinds = new Set(value.stages.map((stage) => stage.stage));
  if (kinds.size !== MEDIA_ANALYSIS_STAGES.length || MEDIA_ANALYSIS_STAGES.some((stage) => !kinds.has(stage))) context.addIssue({ code: z.ZodIssueCode.custom, path: ['stages'], message: 'analysis graph must contain every stage exactly once' });
});
export const rebuildMediaAnalysisStageRequestSchema = z.object({ detectorConfigHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export type MediaAnalysisStageName = z.infer<typeof mediaAnalysisStageNameSchema>;
export type MediaAnalysisStageStatus = z.infer<typeof mediaAnalysisStageStatusSchema>;
export type MediaAnalysisStage = z.infer<typeof mediaAnalysisStageSchema>;
export type MediaAnalysisGraph = z.infer<typeof mediaAnalysisGraphSchema>;
export type RebuildMediaAnalysisStageRequest = z.infer<typeof rebuildMediaAnalysisStageRequestSchema>;
