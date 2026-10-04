import { z } from 'zod';
import { opaqueIdSchema } from './ids.js';
import { revisionSchema } from './revision.js';
import { isoDateTimeSchema } from './time.js';

/**
 * 事件契约（计划 §10）：
 * - 事件是通知通道；断线恢复后的权威状态仍通过 API 查询（§29.6）。
 * - eventType 允许扩展；V1 已知类型见 EVENT_TYPES。
 */

export const EVENT_TYPES = [
  'project.updated',
  'scene.updated',
  'job.started',
  'job.progress',
  'job.completed',
  'job.failed',
  'render.progress',
  'asset.ready',
] as const;

export const eventEnvelopeSchema = z.object({
  eventId: opaqueIdSchema,
  eventType: z.string().min(1),
  workspaceId: opaqueIdSchema,
  resourceId: opaqueIdSchema,
  /** 事件发生时的资源 revision；不适用时为 null */
  resourceRevision: revisionSchema.nullable(),
  occurredAt: isoDateTimeSchema,
  payload: z.record(z.string(), z.unknown()),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
