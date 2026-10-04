import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * 通知契约（P02-06 / 规范 §34）。
 *
 * 通知在后端**持久化**（前端只是视图）；类型白名单允许扩展，V1 已实现 PROJECT_UPDATED 规则
 * （其他类型为 Provider/渲染阶段的预留位）。
 */

export const NOTIFICATION_TYPES = ['PROJECT_UPDATED', 'ASSET_READY', 'JOB_FAILED', 'JOB_COMPLETED'] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const notificationSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  /** 收件用户（读取方必须是本人） */
  userId: z.string().min(1),
  type: notificationTypeSchema.or(z.string().min(1)),
  title: z.string().min(1),
  body: z.string().default(''),
  resourceId: opaqueIdSchema.nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
  readAt: isoDateTimeSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type Notification = z.infer<typeof notificationSchema>;

export const unreadCountResponseSchema = z.object({
  unread: z.number().int().nonnegative(),
});

export type UnreadCountResponse = z.infer<typeof unreadCountResponseSchema>;

/** SSE 事件帧的有线格式（id 字段为 outbox seq，供 Last-Event-ID 续传） */
export const workspaceEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  eventId: opaqueIdSchema,
  eventType: z.string().min(1),
  workspaceId: opaqueIdSchema,
  resourceId: opaqueIdSchema,
  resourceRevision: z.number().int().nonnegative().nullable().default(null),
  occurredAt: isoDateTimeSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;

/** 事件游标快照（客户端引导：从 head 开始仅收新事件；显式 cursor=0 表示全量重放） */
export const eventCursorSchema = z.object({
  headSeq: z.number().int().nonnegative(),
  serverTime: isoDateTimeSchema,
});

export type EventCursor = z.infer<typeof eventCursorSchema>;
