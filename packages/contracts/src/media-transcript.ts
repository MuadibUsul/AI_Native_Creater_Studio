import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { mediaRationalSchema } from './assets.js';

export const MEDIA_TRANSCRIPT_JOB_TYPE = 'MEDIA_TRANSCRIPT';
export const MEDIA_TRANSCRIPT_PROCESSOR_VERSION = 'source-transcript-v1';
export const MEDIA_TRANSCRIPT_STATUSES = ['QUEUED', 'RUNNING', 'READY', 'FAILED', 'STALE'] as const;
export const mediaTranscriptStatusSchema = z.enum(MEDIA_TRANSCRIPT_STATUSES);
const ptsSchema = z.string().regex(/^-?\d+$/);

export const transcriptAnchorSchema = z.object({
  sourceStartPts: ptsSchema,
  sourceEndPts: ptsSchema,
  timeBase: mediaRationalSchema,
}).strict();

export const transcriptSpeakerSchema = z.object({
  id: z.string().min(1).max(80),
  displayName: z.string().trim().min(1).max(120).nullable(),
  identityState: z.enum(['UNKNOWN', 'INFERRED', 'USER_CONFIRMED']),
  confidencePermille: z.number().int().min(0).max(1000).nullable(),
}).strict().superRefine((speaker, context) => {
  if (speaker.identityState === 'UNKNOWN' && speaker.displayName !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['displayName'], message: 'unknown speaker cannot have a display name' });
  }
});

export const transcriptWordSchema = transcriptAnchorSchema.extend({
  ordinal: z.number().int().nonnegative(),
  text: z.string().min(1).max(500),
  speakerId: z.string().min(1).max(80).nullable(),
  confidencePermille: z.number().int().min(0).max(1000).nullable(),
}).strict();

export const transcriptSegmentSchema = transcriptAnchorSchema.extend({
  id: opaqueIdSchema,
  ordinal: z.number().int().nonnegative(),
  text: z.string().min(1).max(10_000),
  speakerId: z.string().min(1).max(80).nullable(),
  wordStartOrdinal: z.number().int().nonnegative(),
  wordEndOrdinal: z.number().int().nonnegative(),
  evidence: z.literal('ASR_INFERENCE'),
  reviewState: z.enum(['UNREVIEWED', 'CORRECTED']),
}).strict();

export const mediaTranscriptSnapshotSchema = z.object({
  language: z.string().min(2).max(35),
  speakers: z.array(transcriptSpeakerSchema).max(100),
  words: z.array(transcriptWordSchema).max(200_000),
  segments: z.array(transcriptSegmentSchema).max(20_000),
  terminology: z.array(z.object({ source: z.string().trim().min(1).max(200), preferred: z.string().trim().min(1).max(200) }).strict()).max(500),
}).strict();

export const generatedMediaTranscriptSchema = mediaTranscriptSnapshotSchema.extend({
  schemaVersion: z.literal('1.0'),
  processorVersion: z.literal(MEDIA_TRANSCRIPT_PROCESSOR_VERSION),
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
}).strict();

export const mediaTranscriptJobInputSchema = z.object({
  runId: opaqueIdSchema,
  sourceAssetId: opaqueIdSchema,
  sourceAssetVersionId: opaqueIdSchema,
  sourceStorageKey: z.string().min(1).max(512),
  sourceChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  processorVersion: z.literal(MEDIA_TRANSCRIPT_PROCESSOR_VERSION),
}).strict();

export const mediaTranscriptVersionSchema = mediaTranscriptSnapshotSchema.extend({
  id: opaqueIdSchema,
  version: z.number().int().positive(),
  source: z.enum(['ASR', 'CORRECTION', 'TERMINOLOGY']),
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  affectedSegmentIds: z.array(opaqueIdSchema),
  createdAt: isoDateTimeSchema,
}).strict();

export const mediaTranscriptSchema = z.object({
  runId: opaqueIdSchema.nullable(),
  sourceAssetVersionId: opaqueIdSchema,
  processorVersion: z.string().min(1),
  status: mediaTranscriptStatusSchema.nullable(),
  errorSummary: z.string().nullable(),
  currentVersion: mediaTranscriptVersionSchema.nullable(),
}).strict();

export const correctTranscriptSegmentRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  segmentId: opaqueIdSchema,
  text: z.string().trim().min(1).max(10_000),
}).strict();

export const updateTranscriptTerminologyRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  entries: mediaTranscriptSnapshotSchema.shape.terminology,
}).strict();

export type TranscriptSpeaker = z.infer<typeof transcriptSpeakerSchema>;
export type TranscriptWord = z.infer<typeof transcriptWordSchema>;
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type MediaTranscriptSnapshot = z.infer<typeof mediaTranscriptSnapshotSchema>;
export type GeneratedMediaTranscript = z.infer<typeof generatedMediaTranscriptSchema>;
export type MediaTranscriptJobInput = z.infer<typeof mediaTranscriptJobInputSchema>;
export type MediaTranscriptVersion = z.infer<typeof mediaTranscriptVersionSchema>;
export type MediaTranscript = z.infer<typeof mediaTranscriptSchema>;
export type CorrectTranscriptSegmentRequest = z.infer<typeof correctTranscriptSegmentRequestSchema>;
export type UpdateTranscriptTerminologyRequest = z.infer<typeof updateTranscriptTerminologyRequestSchema>;

/** Worker I/O seam. A result is evidence from an ASR provider, never authoritative captions. */
export interface SpeechRecognitionAdapter {
  readonly kind: string;
  transcribe(input: { sourcePath: string }): Promise<GeneratedMediaTranscript>;
}
