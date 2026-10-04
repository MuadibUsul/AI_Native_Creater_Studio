import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  eventCursorSchema,
  notificationSchema,
  workspaceEventSchema,
  type EventCursor,
  type Notification,
  type WorkspaceEvent,
} from '@ancs/contracts';
import { notifications, outboxEvents, workspaceMembers } from '@ancs/db';
import type { DomainDeps } from './channels.js';

/**
 * 事件通道与通知（P02-06 / 规范 §34；计划 §10）。
 *
 * 职责划分：
 * - **事件流（SSE）**：以 outbox_events.seq 为游标、workspace 为边界的**只读**实时通道；
 *   客户端断线后带 Last-Event-ID/cursor 重连即续传（不丢不重）；权威状态仍通过 API 查询（§29.6）。
 * - **消费者（通知派发）**：`runNotificationDispatch` 读取未投递 Outbox 事件（published_at 为空），
 *   按规则生成持久化通知并标记 published_at（P02-02 遗留义务：Outbox 消费者）。
 *
 * 游标协议：
 * - 缺省（无 cursor）→ 从当前 head 开始（只收新事件）；
 * - `cursor=0` → 从最早开始全量重放；
 * - cursor 超出 head → 409 PRECONDITION_FAILED（details.reason=CURSOR_AHEAD，附 headSeq 供刷新）；
 * - 非法 cursor → 400 VALIDATION_FAILED（路由层契约校验）。
 */

export interface NotificationDispatchReport {
  scanned: number;
  dispatched: number;
  notificationsCreated: number;
  notificationsMerged: number;
}

interface OutboxRow {
  id: string;
  seq: number;
  workspaceId: string;
  type: string;
  payload: unknown;
  createdAt: Date;
  publishedAt: Date | null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const toWorkspaceEvent = (row: OutboxRow): WorkspaceEvent => {
  const payload = asRecord(row.payload);
  const resourceId = typeof payload['projectId'] === 'string' ? payload['projectId'] : row.id;
  const revision = typeof payload['revision'] === 'number' ? payload['revision'] : null;
  return workspaceEventSchema.parse({
    seq: row.seq,
    eventId: row.id,
    eventType: row.type,
    workspaceId: row.workspaceId,
    resourceId,
    resourceRevision: revision,
    occurredAt: row.createdAt.toISOString(),
    payload,
  });
};

/** 事件游标快照（head）。 */
export async function getEventCursor(deps: DomainDeps, input: { workspaceId: string }): Promise<EventCursor> {
  const rows = await deps.db
    .select({ max: sql<number>`coalesce(max(${outboxEvents.seq}), 0)` })
    .from(outboxEvents)
    .where(eq(outboxEvents.workspaceId, input.workspaceId));
  return eventCursorSchema.parse({
    headSeq: Number(rows[0]?.max ?? 0),
    serverTime: new Date().toISOString(),
  });
}

export interface EventPage {
  events: WorkspaceEvent[];
  headSeq: number;
}

/**
 * 按游标读取事件（升序，≤ limit）。cursor 超出 head → 409（客户端应刷新后重连）。
 * cursor=null 表示"从 head 开始"（不返回历史）。
 */
export async function listEventsAfter(
  deps: DomainDeps,
  input: { workspaceId: string; cursor: number | null; limit?: number },
): Promise<EventPage> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const head = await getEventCursor(deps, { workspaceId: input.workspaceId });
  if (input.cursor !== null && input.cursor > head.headSeq) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'cursor 超出当前事件头（客户端应刷新后重连）', 409, {
      reason: 'CURSOR_AHEAD',
      cursor: input.cursor,
      headSeq: head.headSeq,
    });
  }
  if (input.cursor === null) return { events: [], headSeq: head.headSeq };

  const rows = await deps.db
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.workspaceId, input.workspaceId), gt(outboxEvents.seq, input.cursor)))
    .orderBy(asc(outboxEvents.seq))
    .limit(limit);
  return { events: rows.map((row) => toWorkspaceEvent(row as OutboxRow)), headSeq: head.headSeq };
}

/** ---------- 通知（持久化 inbox） ---------- */

const toNotificationDto = (row: typeof notifications.$inferSelect): Notification =>
  notificationSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    type: row.type,
    title: row.title,
    body: row.body,
    resourceId: row.resourceId,
    payload: row.payload,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

export async function listNotifications(
  deps: DomainDeps,
  input: { userId: string; workspaceId?: string; unreadOnly?: boolean; limit?: number },
): Promise<Notification[]> {
  const conditions = [eq(notifications.userId, input.userId)];
  if (input.workspaceId !== undefined) conditions.push(eq(notifications.workspaceId, input.workspaceId));
  if (input.unreadOnly === true) conditions.push(isNull(notifications.readAt));
  const rows = await deps.db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 200));
  return rows.map(toNotificationDto);
}

export async function getUnreadNotificationCount(
  deps: DomainDeps,
  input: { userId: string; workspaceId?: string },
): Promise<number> {
  const conditions = [eq(notifications.userId, input.userId), isNull(notifications.readAt)];
  if (input.workspaceId !== undefined) conditions.push(eq(notifications.workspaceId, input.workspaceId));
  const rows = await deps.db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(...conditions));
  return Number(rows[0]?.count ?? 0);
}

/** 标记已读：只能操作**自己的**通知（他人/不存在 → 404 抗枚举）。 */
export async function markNotificationRead(
  deps: DomainDeps,
  input: { userId: string; notificationId: string },
): Promise<Notification> {
  const updated = await deps.db
    .update(notifications)
    .set({ readAt: new Date(), updatedAt: new Date() })
    .where(and(eq(notifications.id, input.notificationId), eq(notifications.userId, input.userId)))
    .returning();
  const row = updated[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'notification not found', 404);
  return toNotificationDto(row);
}

export async function markAllNotificationsRead(
  deps: DomainDeps,
  input: { userId: string; workspaceId?: string },
): Promise<number> {
  const conditions = [eq(notifications.userId, input.userId), isNull(notifications.readAt)];
  if (input.workspaceId !== undefined) conditions.push(eq(notifications.workspaceId, input.workspaceId));
  const updated = await deps.db
    .update(notifications)
    .set({ readAt: new Date(), updatedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: notifications.id });
  return updated.length;
}

/** ---------- Outbox 消费者（通知派发） ---------- */

interface NotificationRule {
  type: string;
  title: (context: { actorId: string | null }) => string;
  body: (payload: Record<string, unknown>, context: { actorId: string | null }) => string;
}

/** V1 规则：项目被他人编辑（actorId 为空则视为系统动作，通知所有成员）。 */
const NOTIFICATION_RULES: readonly NotificationRule[] = [
  {
    type: 'project.updated',
    title: () => '项目有新的编辑',
    body: (payload, context) => {
      const actor = context.actorId === null ? '系统/自动化' : '其他成员';
      const operations = Array.isArray(payload['operations']) ? (payload['operations'] as unknown[]).map(String) : [];
      const revision = typeof payload['revision'] === 'number' ? payload['revision'] : null;
      return `${actor}修改了项目${revision !== null ? `（revision ${String(revision)}）` : ''}：${operations.join('、') || '更新'}`;
    },
  },
];

/**
 * 消费未投递的 Outbox 事件（跨 workspace），按规则生成持久化通知并标记 published_at。
 * 可重入：已投递（published_at 非空）不重复派发；同一 (收件人, type, resourceId) 的**未读**通知合并更新。
 */
export async function runNotificationDispatch(
  deps: DomainDeps,
  options: { limit?: number } = {},
): Promise<NotificationDispatchReport> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const pending = await deps.db
    .select()
    .from(outboxEvents)
    .where(isNull(outboxEvents.publishedAt))
    .orderBy(asc(outboxEvents.seq))
    .limit(limit);

  const report: NotificationDispatchReport = { scanned: pending.length, dispatched: 0, notificationsCreated: 0, notificationsMerged: 0 };

  for (const row of pending) {
    const payload = asRecord(row.payload);
    const rule = NOTIFICATION_RULES.find((candidate) => candidate.type === row.type);
    const actorId = typeof payload['actorId'] === 'string' ? payload['actorId'] : null;
    const projectId = typeof payload['projectId'] === 'string' ? payload['projectId'] : null;

    await deps.db.transaction(async (tx) => {
      // 行锁 + 复核：多个消费者（SSE 轮询/CLI）并发时不重复派发
      await tx.execute(sql`select id from outbox_events where id = ${row.id} for update`);
      const freshRows = await tx
        .select({ id: outboxEvents.id, publishedAt: outboxEvents.publishedAt })
        .from(outboxEvents)
        .where(eq(outboxEvents.id, row.id))
        .limit(1);
      const fresh = freshRows[0];
      if (!fresh || fresh.publishedAt !== null) return;

      if (rule !== undefined) {
        const members = await tx
          .select({ userId: workspaceMembers.userId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.workspaceId, row.workspaceId));
        const now = new Date();
        for (const member of members) {
          if (actorId !== null && member.userId === actorId) continue; // 不通知动作发起人
          const existing = await tx
            .select({ id: notifications.id })
            .from(notifications)
            .where(
              and(
                eq(notifications.userId, member.userId),
                eq(notifications.workspaceId, row.workspaceId),
                eq(notifications.type, row.type.toUpperCase().replace(/\./g, '_')),
                isNull(notifications.readAt),
                projectId === null ? isNull(notifications.resourceId) : eq(notifications.resourceId, projectId),
              ),
            )
            .limit(1);
          const notificationType = row.type.toUpperCase().replace(/\./g, '_');
          if (existing[0] !== undefined) {
            await tx
              .update(notifications)
              .set({
                body: rule.body(payload, { actorId }),
                payload,
                updatedAt: now,
              })
              .where(eq(notifications.id, existing[0].id));
            report.notificationsMerged += 1;
          } else {
            await tx.insert(notifications).values({
              id: `ntf_${randomUUID()}`,
              workspaceId: row.workspaceId,
              userId: member.userId,
              type: notificationType,
              title: rule.title({ actorId }),
              body: rule.body(payload, { actorId }),
              resourceId: projectId,
              payload,
            });
            report.notificationsCreated += 1;
          }
        }
      }

      await tx.update(outboxEvents).set({ publishedAt: new Date() }).where(eq(outboxEvents.id, row.id));
      report.dispatched += 1;
    });
  }

  return report;
}

/** 便捷：订阅端一次"投递 + 读取"的组合（SSE 轮询 tick 使用）。 */
export async function pollEvents(
  deps: DomainDeps,
  input: { workspaceId: string; cursor: number | null; limit?: number; dispatch?: boolean },
): Promise<EventPage> {
  if (input.dispatch !== false) {
    await runNotificationDispatch(deps, { limit: 25 });
  }
  return listEventsAfter(deps, { workspaceId: input.workspaceId, cursor: input.cursor, limit: input.limit ?? 100 });
}
