import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

const nullableMetric = z.number().finite().nonnegative().nullable();

export const retentionPointSchema = z.object({
  positionMs: z.number().int().nonnegative(),
  rate: z.number().finite().min(0).max(1).nullable(),
});

export const analyticsSamplingSchema = z.object({
  from: isoDateTimeSchema.nullable().default(null),
  to: isoDateTimeSchema.nullable().default(null),
  granularity: z.enum(['LIFETIME', 'DAY', 'HOUR']).default('LIFETIME'),
  timezone: z.string().min(1).max(80).default('UTC'),
  source: z.string().min(1).max(120),
  fetchedAt: isoDateTimeSchema,
});

export const videoPerformanceMetricsSchema = z.object({
  views: nullableMetric,
  impressions: nullableMetric,
  clickThroughRate: z.number().finite().min(0).max(1).nullable(),
  watchTimeMs: nullableMetric,
  averageWatchTimeMs: nullableMetric,
  retention: z.array(retentionPointSchema),
});

export const videoPerformanceRecordSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  publicationId: opaqueIdSchema,
  projectVersionId: opaqueIdSchema,
  platformId: z.string().min(1).max(80),
  remoteId: z.string().min(1),
  sampling: analyticsSamplingSchema,
  metrics: videoPerformanceMetricsSchema,
  rawEventId: opaqueIdSchema,
  createdAt: isoDateTimeSchema,
});

export const collectPublicationAnalyticsRequestSchema = z.object({
  from: isoDateTimeSchema.nullable().default(null),
  to: isoDateTimeSchema.nullable().default(null),
  granularity: z.enum(['LIFETIME', 'DAY', 'HOUR']).default('LIFETIME'),
  timezone: z.string().min(1).max(80).default('UTC'),
});

export type CollectPublicationAnalyticsRequest = z.infer<typeof collectPublicationAnalyticsRequestSchema>;
export type CollectPublicationAnalyticsRequestInput = z.input<typeof collectPublicationAnalyticsRequestSchema>;
export type VideoPerformanceRecord = z.infer<typeof videoPerformanceRecordSchema>;
export type VideoPerformanceMetrics = z.infer<typeof videoPerformanceMetricsSchema>;

export const videoPerformanceListSchema = z.object({ items: z.array(videoPerformanceRecordSchema) });

export const scenePerformanceRecordSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  projectVersionId: opaqueIdSchema,
  videoPerformanceId: opaqueIdSchema,
  sceneId: opaqueIdSchema,
  sceneType: z.string().min(1),
  position: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  retentionRate: z.number().finite().min(0).max(1).nullable(),
  interpretation: z.literal('CORRELATION_ONLY'),
  derivation: z.object({ method: z.literal('TIME_WINDOW_AVERAGE'), sampleCount: z.number().int().nonnegative() }),
  createdAt: isoDateTimeSchema,
});
export type ScenePerformanceRecord = z.infer<typeof scenePerformanceRecordSchema>;
export const scenePerformanceListSchema = z.object({ items: z.array(scenePerformanceRecordSchema) });

export const creatorLearningSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  channelId: opaqueIdSchema,
  kind: z.enum(['RHYTHM', 'SCENE_TYPE', 'AVATAR_RATIO']),
  status: z.enum(['ACTIVE', 'DISABLED', 'ACCEPTED', 'REVERTED']),
  title: z.string().min(1).max(200),
  explanation: z.string().min(1).max(1000),
  evidence: z.object({ sampleCount: z.number().int().positive(), observations: z.array(z.string()), interpretation: z.literal('CORRELATION_ONLY') }),
  recommendation: z.record(z.string(), z.unknown()),
  channelMutationApplied: z.literal(false),
  acceptedAt: isoDateTimeSchema.nullable().default(null),
  disabledAt: isoDateTimeSchema.nullable().default(null),
  revertedAt: isoDateTimeSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type CreatorLearning = z.infer<typeof creatorLearningSchema>;
export const creatorLearningListSchema = z.object({ items: z.array(creatorLearningSchema) });
export const creatorLearningActionSchema = z.object({ action: z.enum(['DISABLE', 'ACCEPT', 'RESTORE']) });
export type CreatorLearningAction = z.infer<typeof creatorLearningActionSchema>;

export const ANALYTICS_ERROR_REASONS = {
  PUBLICATION_NOT_FOUND: 'PUBLICATION_NOT_FOUND',
  PUBLICATION_NOT_READY: 'PUBLICATION_NOT_READY',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  CAPABILITY_MISSING: 'CAPABILITY_MISSING',
  AUTHORIZATION_REVOKED: 'AUTHORIZATION_REVOKED',
  INVALID_PROVIDER_METRICS: 'INVALID_PROVIDER_METRICS',
  PERFORMANCE_NOT_FOUND: 'PERFORMANCE_NOT_FOUND',
} as const;
