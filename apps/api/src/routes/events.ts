import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ApiFailure,
  ERROR_CODES,
  errorEnvelopeSchema,
  eventCursorSchema,
  notificationSchema,
  opaqueIdSchema,
  pageResponseSchema,
  unreadCountResponseSchema,
  workspaceEventSchema,
} from '@ancs/contracts';
import {
  getEventCursor,
  getUnreadNotificationCount,
  listEventsAfter,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  pollEvents,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * 事件通道（SSE）与通知（P02-06 / 规范 §34）。
 *
 * - `GET /workspaces/:id/events`：按游标分页拉取事件（断线恢复的权威原语；JSON）；
 * - `GET /workspaces/:id/events/stream`：SSE 实时流（同一游标语义；`Last-Event-ID` 续传；
 *   心跳注释帧保活；服务端 tick 同时驱动 Outbox 消费者 marking published_at）；
 * - `GET /workspaces/:id/events/cursor`：head 快照（客户端引导）；
 * - 通知：用户级 inbox（持久化在服务端），越权/他人通知一律 404。
 */

const wsParamsSchema = z.object({ id: opaqueIdSchema });
const cursorQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});
const notificationsQuerySchema = z.object({
  workspaceId: opaqueIdSchema.optional(),
  unreadOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});
const eventListSchema = z.object({
  events: z.array(workspaceEventSchema),
  headSeq: z.number().int().nonnegative(),
});
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };
const SSE_HEARTBEAT_MS = 15_000;
const SSE_POLL_MS = 1_000;

export function registerEventRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  async function requireUser(request: FastifyRequest): Promise<{ userId: string }> {
    const context = await app.authResolve(request);
    if (context === null) throw new ApiFailure(ERROR_CODES.UNAUTHENTICATED, 'Not authenticated', 401);
    return { userId: context.userId };
  }

  /** Last-Event-ID（SSE 标准）与 query cursor 的解析：header 优先。 */
  function resolveCursor(request: FastifyRequest, queryCursor: number | undefined): number | null {
    const header = request.headers['last-event-id'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    const raw = headerValue ?? (queryCursor === undefined ? undefined : String(queryCursor));
    if (raw === undefined) return null;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'cursor 必须是 ≥0 的整数', 400, { cursor: raw });
    }
    return parsed;
  }

  typed.get(
    '/workspaces/:id/events/cursor',
    {
      schema: {
        tags: ['events'],
        summary: '事件游标快照（headSeq；客户端引导：从 head 起仅收新事件）',
        params: wsParamsSchema,
        response: { 200: eventCursorSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return getEventCursor(domain, { workspaceId: request.params.id });
    },
  );

  typed.get(
    '/workspaces/:id/events',
    {
      schema: {
        tags: ['events'],
        summary: '按游标拉取事件（断线恢复原语；cursor=0 表示全量重放；超出 head → 409 CURSOR_AHEAD）',
        params: wsParamsSchema,
        querystring: cursorQuerySchema,
        response: { 200: eventListSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      const cursor = resolveCursor(request, request.query.cursor);
      const page = await listEventsAfter(domain, {
        workspaceId: request.params.id,
        cursor,
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
      return { events: page.events, headSeq: page.headSeq };
    },
  );

  typed.get(
    '/workspaces/:id/events/stream',
    {
      schema: {
        hide: true,
        params: wsParamsSchema,
        querystring: cursorQuerySchema,
      },
    },
    async (request, reply) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      const workspaceId = request.params.id;
      const cursor = resolveCursor(request, request.query.cursor);
      // 初始读取同时完成游标校验（CURSOR_AHEAD → 409，未建立流）
      const initial = await listEventsAfter(domain, { workspaceId, cursor });

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.write('retry: 2000\n\n');
      reply.raw.write(`: connected headSeq=${String(initial.headSeq)}\n\n`);

      let lastSeq = cursor ?? initial.headSeq;
      let closed = false;

      const sendEvent = (event: { seq: number; eventType: string; payload: unknown; eventId: string; workspaceId: string; resourceId: string; resourceRevision: number | null; occurredAt: string }): void => {
        reply.raw.write(`id: ${String(event.seq)}\n`);
        reply.raw.write(`event: ${event.eventType}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        lastSeq = event.seq;
      };

      for (const event of initial.events) sendEvent(event);

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeatTimer);
        clearInterval(pollTimer);
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);

      const heartbeatTimer = setInterval(() => {
        if (closed) return;
        reply.raw.write(`: ping ${new Date().toISOString()}\n\n`);
      }, SSE_HEARTBEAT_MS);

      const pollTimer = setInterval(() => {
        void (async () => {
          if (closed) return;
          try {
            // tick 同时驱动 Outbox 消费者（published_at 标记与通知派发；可重入）
            const page = await pollEvents(domain, { workspaceId, cursor: lastSeq, limit: 100 });
            for (const event of page.events) sendEvent(event);
          } catch (error) {
            if (closed) return;
            const message = error instanceof Error ? error.message : 'event poll failed';
            reply.raw.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
          }
        })();
      }, SSE_POLL_MS);

      // 由客户端断开驱动；等待 raw 流关闭（Fastify 需要 promise 挂起以保持连接）
      await new Promise<void>((resolve) => {
        request.raw.on('close', () => {
          cleanup();
          resolve();
        });
        request.raw.on('error', () => {
          cleanup();
          resolve();
        });
      });
      return reply;
    },
  );

  typed.get(
    '/notifications',
    {
      schema: {
        tags: ['notifications'],
        summary: '通知列表（本人；可按 workspace 过滤/仅未读）',
        querystring: notificationsQuerySchema,
        response: { 200: pageResponseSchema(notificationSchema), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { userId } = await requireUser(request);
      const items = await listNotifications(domain, {
        userId,
        ...(request.query.workspaceId !== undefined ? { workspaceId: request.query.workspaceId } : {}),
        unreadOnly: request.query.unreadOnly === 'true',
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
      return { items, nextCursor: null };
    },
  );

  typed.get(
    '/notifications/unread-count',
    {
      schema: {
        tags: ['notifications'],
        summary: '未读通知数（本人；可按 workspace 过滤）',
        querystring: z.object({ workspaceId: opaqueIdSchema.optional() }),
        response: { 200: unreadCountResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { userId } = await requireUser(request);
      const unread = await getUnreadNotificationCount(domain, {
        userId,
        ...(request.query.workspaceId !== undefined ? { workspaceId: request.query.workspaceId } : {}),
      });
      return { unread };
    },
  );

  typed.post(
    '/notifications/:notificationId/read',
    {
      schema: {
        tags: ['notifications'],
        summary: '标记一条通知已读（只能操作本人通知）',
        params: z.object({ notificationId: opaqueIdSchema }),
        response: { 200: notificationSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { userId } = await requireUser(request);
      return markNotificationRead(domain, { userId, notificationId: request.params.notificationId });
    },
  );

  typed.post(
    '/notifications/read-all',
    {
      schema: {
        tags: ['notifications'],
        summary: '全部标记已读（可按 workspace 过滤）',
        querystring: z.object({ workspaceId: opaqueIdSchema.optional() }),
        response: { 200: z.object({ updated: z.number().int().nonnegative() }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { userId } = await requireUser(request);
      const updated = await markAllNotificationsRead(domain, {
        userId,
        ...(request.query.workspaceId !== undefined ? { workspaceId: request.query.workspaceId } : {}),
      });
      return { updated };
    },
  );
}
