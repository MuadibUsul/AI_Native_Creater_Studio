import { z } from 'zod';
import { mediaRationalSchema } from './assets.js';
import { opaqueIdSchema } from './common/ids.js';

export const MEDIA_AUDIO_ANALYSIS_JOB_TYPE = 'MEDIA_AUDIO_ANALYSIS';
export const MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION = 'source-audio-analysis-v1';
export const MEDIA_AUDIO_EVENT_TYPES = ['SILENCE', 'APPLAUSE', 'AMBIENT', 'MUSIC', 'OTHER', 'UNKNOWN'] as const;
const ptsSchema = z.string().regex(/^-?\d+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const audioSourceAnchorSchema = z.object({
  sourceStartPts: ptsSchema,
  sourceEndPts: ptsSchema,
  timeBase: mediaRationalSchema,
  streamIndex: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (BigInt(value.sourceEndPts) <= BigInt(value.sourceStartPts)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceEndPts'], message: 'audio source range must be positive' });
});

export const audioEvidenceWindowSchema = z.object({
  sourceStartPts: ptsSchema,
  sourceEndPts: ptsSchema,
  timeBase: mediaRationalSchema,
  windowRef: z.string().min(1).max(200),
}).strict().superRefine((value, context) => {
  if (BigInt(value.sourceEndPts) <= BigInt(value.sourceStartPts)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceEndPts'], message: 'audio evidence range must be positive' });
});

export const generatedAudioEventSchema = audioSourceAnchorSchema.extend({
  id: z.string().min(1).max(120),
  eventType: z.enum(MEDIA_AUDIO_EVENT_TYPES),
  label: z.string().trim().min(1).max(200),
  channel: z.number().int().nonnegative().nullable(),
  confidencePermille: z.number().int().min(0).max(1000),
  evidenceWindows: z.array(audioEvidenceWindowSchema).min(1).max(100),
}).strict();

export const generatedMusicBeatSchema = audioSourceAnchorSchema.extend({
  id: z.string().min(1).max(120),
  musicSegmentId: z.string().min(1).max(120).nullable(),
  beatOrdinal: z.number().int().nonnegative(),
  downbeat: z.boolean(),
  tempoBpm: z.number().positive().max(1000).nullable(),
  channel: z.number().int().nonnegative().nullable(),
  confidencePermille: z.number().int().min(0).max(1000),
  evidenceWindows: z.array(audioEvidenceWindowSchema).min(1).max(100),
}).strict();

export const generatedMediaAudioAnalysisSchema = z.object({
  schemaVersion: z.literal('1.0'),
  processorVersion: z.literal(MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION),
  adapter: z.string().min(1).max(120),
  modelVersion: z.string().min(1).max(160),
  durationMs: z.number().int().nonnegative(),
  audioEvents: z.array(generatedAudioEventSchema).max(100_000),
  musicBeats: z.array(generatedMusicBeatSchema).max(500_000),
}).strict().superRefine((value, context) => {
  const ids = [...value.audioEvents, ...value.musicBeats].map((item) => item.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['audioEvents'], message: 'audio analysis record ids must be unique' });
  const musicIds = new Set(value.audioEvents.filter((event) => event.eventType === 'MUSIC').map((event) => event.id));
  value.musicBeats.forEach((beat, index) => {
    if (beat.musicSegmentId !== null && !musicIds.has(beat.musicSegmentId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['musicBeats', index, 'musicSegmentId'], message: 'music beat must reference a MUSIC event' });
  });
});

export const mediaAudioAnalysisJobInputSchema = z.object({
  runId: opaqueIdSchema,
  sourceAssetId: opaqueIdSchema,
  sourceAssetVersionId: opaqueIdSchema,
  sourceStorageKey: z.string().min(1).max(512),
  sourceChecksumSha256: sha256Schema,
  processorVersion: z.literal(MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION),
  analysisConfigHash: sha256Schema,
}).strict();

export type GeneratedMediaAudioAnalysis = z.infer<typeof generatedMediaAudioAnalysisSchema>;
export type MediaAudioAnalysisJobInput = z.infer<typeof mediaAudioAnalysisJobInputSchema>;

/** Worker I/O seam. Implementations return source-time evidence and never modify source audio. */
export interface MediaAudioAnalysisAdapter {
  readonly kind: string;
  analyze(input: { sourcePath: string }): Promise<GeneratedMediaAudioAnalysis>;
}
