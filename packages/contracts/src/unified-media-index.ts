import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { mediaRationalSchema } from './assets.js';

const ptsSchema = z.string().regex(/^-?\d+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const UNIFIED_MEDIA_INDEX_KINDS = [
  'THUMBNAIL', 'WAVEFORM', 'QUALITY',
  'TRANSCRIPT_WORD', 'TRANSCRIPT_SEGMENT', 'SPEAKER_SEGMENT', 'SHOT_BOUNDARY',
  'OCR_TEXT', 'OBJECT_TRACK', 'ACTION_EVENT', 'PERSON_TRACK', 'VISUAL_EVENT', 'MOTION_INTENSITY',
  'AUDIO_EVENT', 'MUSIC_BEAT', 'SEMANTIC_EMBEDDING', 'USER_MARKER',
] as const;
export const MEDIA_INDEX_BASIS = ['MEASURED', 'MODEL_INFERRED', 'USER_SUPPLIED', 'USER_CONFIRMED'] as const;
export const MEDIA_INDEX_CALIBRATION_STATUSES = ['NOT_APPLICABLE', 'UNCALIBRATED', 'CALIBRATED', 'USER_CONFIRMED'] as const;
export const MEDIA_INDEX_CAPABILITY_STATUSES = ['NOT_ANALYZED', 'PARTIAL', 'READY', 'EMPTY', 'FAILED', 'UNSUPPORTED'] as const;

export const unifiedMediaIndexKindSchema = z.enum(UNIFIED_MEDIA_INDEX_KINDS);
export const mediaIndexBasisSchema = z.enum(MEDIA_INDEX_BASIS);
export const mediaIndexCalibrationStatusSchema = z.enum(MEDIA_INDEX_CALIBRATION_STATUSES);
export const mediaIndexCapabilityStatusSchema = z.enum(MEDIA_INDEX_CAPABILITY_STATUSES);
export const mediaIndexSourceRangeSchema = z.object({
  startPts: ptsSchema,
  endPts: ptsSchema,
  timeBase: mediaRationalSchema,
}).strict().superRefine((value, context) => {
  if (BigInt(value.endPts) <= BigInt(value.startPts)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['endPts'], message: 'source range must be positive' });
});

export const mediaIndexEvidenceRefSchema = z.object({
  type: z.enum(['SOURCE_RANGE', 'FRAME', 'AUDIO_WINDOW', 'RECORD']),
  refId: z.string().min(1).max(200),
  sourceRange: mediaIndexSourceRangeSchema.nullable(),
}).strict();

const timedMsSchema = z.object({ sourceStartMs: z.number().int().nonnegative(), sourceEndMs: z.number().int().nonnegative() }).strict();
const thumbnailPayloadSchema = timedMsSchema;
const waveformPayloadSchema = timedMsSchema.extend({ sampleIntervalMs: z.number().int().positive(), peaks: z.array(z.number().int().min(0).max(1000)).max(20_000) }).strict();
const qualityPayloadSchema = timedMsSchema.extend({ marker: z.enum(['BLACK_FRAME', 'SILENCE']), detectionBasis: z.string().min(1).max(160) }).strict();
const shotPayloadSchema = timedMsSchema.extend({ transitionType: z.string().min(1).max(80), detectionBasis: z.string().min(1).max(160), errorMarginMs: z.number().int().nonnegative() }).strict();
const transcriptWordPayloadSchema = z.object({ text: z.string().min(1).max(500), speakerId: z.string().min(1).max(80).nullable(), language: z.string().min(2).max(35) }).strict();
const transcriptSegmentPayloadSchema = z.object({ text: z.string().min(1).max(10_000), speakerId: z.string().min(1).max(80).nullable(), language: z.string().min(2).max(35), reviewState: z.enum(['UNREVIEWED', 'CORRECTED']) }).strict();
const speakerPayloadSchema = z.object({ speakerId: z.string().min(1).max(80), displayName: z.string().min(1).max(120).nullable(), identityState: z.enum(['UNKNOWN', 'INFERRED', 'USER_CONFIRMED']) }).strict();
const ocrPayloadSchema = z.object({ text: z.string().min(1).max(10_000), region: z.array(z.number().min(0).max(1)).length(4).nullable(), language: z.string().min(2).max(35).nullable() }).strict();
const trackPayloadSchema = z.object({ label: z.string().min(1).max(200), trackId: z.string().min(1).max(120), regionKeyframes: z.array(z.object({ pts: ptsSchema, box: z.array(z.number().min(0).max(1)).length(4) }).strict()).max(10_000) }).strict();
const eventPayloadSchema = z.object({ label: z.string().min(1).max(200), subjectTrackId: z.string().min(1).max(120).nullable() }).strict();
const motionPayloadSchema = z.object({ valuePermille: z.number().int().min(0).max(1000), method: z.string().min(1).max(160) }).strict();
const audioEventPayloadSchema = z.object({ label: z.string().min(1).max(200), channel: z.number().int().nonnegative().nullable() }).strict();
const beatPayloadSchema = z.object({ bpm: z.number().positive().nullable(), beatOrdinal: z.number().int().nonnegative().nullable(), downbeat: z.boolean() }).strict();
const embeddingPayloadSchema = z.object({ embeddingRef: z.string().min(1).max(240), dimensions: z.number().int().positive(), model: z.string().min(1).max(160) }).strict();
const markerPayloadSchema = z.object({ label: z.string().min(1).max(160) }).strict();

const recordBase = {
  id: z.string().min(1).max(160),
  workspaceId: opaqueIdSchema,
  sourceAssetVersionId: opaqueIdSchema,
  streamId: z.string().min(1).max(120).nullable(),
  sourceRange: mediaIndexSourceRangeSchema,
  payloadSchemaVersion: z.literal('1.0'),
  evidenceRefs: z.array(mediaIndexEvidenceRefSchema).min(1).max(100),
  observedBy: z.string().min(1).max(160),
  observedAt: isoDateTimeSchema,
  basis: mediaIndexBasisSchema,
  confidenceValue: z.number().min(0).max(1).nullable(),
  confidenceMethod: z.string().min(1).max(160).nullable(),
  calibrationStatus: mediaIndexCalibrationStatusSchema,
  toolId: z.string().min(1).max(120),
  toolVersion: z.string().min(1).max(120),
  modelVersion: z.string().min(1).max(160).nullable(),
  analysisConfigHash: sha256Schema,
  indexVersion: z.number().int().positive(),
  supersedesRecordId: z.string().min(1).max(160).nullable(),
  correctionRecordId: z.string().min(1).max(160).nullable(),
  privacyClass: z.enum(['WORKSPACE', 'SENSITIVE']),
  accessPolicyRef: z.string().min(1).max(240),
  lifecycleState: z.enum(['ACTIVE', 'STALE', 'DELETED']),
};

const record = <K extends typeof UNIFIED_MEDIA_INDEX_KINDS[number]>(kind: K, payload: z.ZodTypeAny) => z.object({ ...recordBase, kind: z.literal(kind), payload }).strict();
export const mediaIndexRecordSchema = z.discriminatedUnion('kind', [
  record('THUMBNAIL', thumbnailPayloadSchema), record('WAVEFORM', waveformPayloadSchema), record('QUALITY', qualityPayloadSchema),
  record('TRANSCRIPT_WORD', transcriptWordPayloadSchema), record('TRANSCRIPT_SEGMENT', transcriptSegmentPayloadSchema), record('SPEAKER_SEGMENT', speakerPayloadSchema),
  record('SHOT_BOUNDARY', shotPayloadSchema), record('OCR_TEXT', ocrPayloadSchema), record('OBJECT_TRACK', trackPayloadSchema), record('ACTION_EVENT', eventPayloadSchema),
  record('PERSON_TRACK', trackPayloadSchema), record('VISUAL_EVENT', eventPayloadSchema), record('MOTION_INTENSITY', motionPayloadSchema), record('AUDIO_EVENT', audioEventPayloadSchema),
  record('MUSIC_BEAT', beatPayloadSchema), record('SEMANTIC_EMBEDDING', embeddingPayloadSchema), record('USER_MARKER', markerPayloadSchema),
]);

export const mediaIndexCapabilitySchema = z.object({
  kind: unifiedMediaIndexKindSchema,
  supported: z.boolean(),
  status: mediaIndexCapabilityStatusSchema,
  coveragePermille: z.number().int().min(0).max(1000),
  recordCount: z.number().int().nonnegative(),
  errorSummary: z.string().max(500).nullable(),
  toolId: z.string().min(1).max(120).nullable(),
  toolVersion: z.string().min(1).max(120).nullable(),
  modelVersion: z.string().min(1).max(160).nullable(),
}).strict().superRefine((value, context) => {
  if (value.supported && value.status === 'UNSUPPORTED') context.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'supported capability cannot be UNSUPPORTED' });
  if (!value.supported && value.status !== 'UNSUPPORTED') context.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'unsupported capability must use UNSUPPORTED status' });
});

export const unifiedMediaIndexQuerySchema = z.object({
  kind: unifiedMediaIndexKindSchema.optional(),
  sourceStartPts: ptsSchema.optional(),
  sourceEndPts: ptsSchema.optional(),
  timeBaseNumerator: z.coerce.number().int().positive().optional(),
  timeBaseDenominator: z.coerce.number().int().positive().optional(),
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict().superRefine((value, context) => {
  const range = [value.sourceStartPts, value.sourceEndPts, value.timeBaseNumerator, value.timeBaseDenominator];
  if (range.some((item) => item !== undefined) && range.some((item) => item === undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'source range and time base must be provided together' });
  if (value.sourceStartPts !== undefined && value.sourceEndPts !== undefined && BigInt(value.sourceEndPts) <= BigInt(value.sourceStartPts)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceEndPts'], message: 'source range must be positive' });
});

export const unifiedMediaIndexPageSchema = z.object({
  sourceAssetVersionId: opaqueIdSchema,
  indexVersion: z.number().int().positive(),
  capabilities: z.array(mediaIndexCapabilitySchema).length(UNIFIED_MEDIA_INDEX_KINDS.length),
  items: z.array(mediaIndexRecordSchema),
  nextCursor: z.string().nullable(),
}).strict().superRefine((value, context) => {
  const kinds = new Set(value.capabilities.map((capability) => capability.kind));
  if (kinds.size !== UNIFIED_MEDIA_INDEX_KINDS.length || UNIFIED_MEDIA_INDEX_KINDS.some((kind) => !kinds.has(kind))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities'], message: 'capability coverage must contain every kind exactly once' });
  }
});

export type UnifiedMediaIndexKind = z.infer<typeof unifiedMediaIndexKindSchema>;
export type MediaIndexRecord = z.infer<typeof mediaIndexRecordSchema>;
export type MediaIndexCapability = z.infer<typeof mediaIndexCapabilitySchema>;
export type UnifiedMediaIndexPage = z.infer<typeof unifiedMediaIndexPageSchema>;
