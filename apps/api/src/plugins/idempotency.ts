import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { ApiFailure, ERROR_CODES, idempotencyKeySchema } from '@ancs/contracts';
import { idempotencyKeys, isUniqueViolation } from '@ancs/db';
import type { AuthDeps } from './auth.js';

/**
 * 写请求幂等基线（P01-05 / 计划 §4.6、规范 §33）：
 * - 仅作用于已认证的写请求（匿名请求——如 sign-in——由各自的凭据语义处理）；
 * - scope = user:{userId}:{method}:{routePattern}，因此幂等键天然按用户隔离；
 * - 同键同摘要 → 回放已存储响应（带 idempotency-replayed: true 头）；
 * - 同键不同摘要 / 同键请求处理中 → 409 IDEMPOTENCY_CONFLICT；
 * - 仅缓存 <500 的响应；5xx 视为未发生（删除记录，允许重试）。
 * 编辑协议（P02-02）的幂等在此基础上扩展请求级语义。
 *
 * V5-M0 修正（代码审查 P1-2）：
 * - 请求摘要包含**实际路径与查询**（不只 body）：同键用于 `DELETE /projects/A` 与 `/projects/B` 时
 *   不再把 A 的结果回放给 B，而是 409（键被复用于不同请求）；
 * - "处理中"行超过 IN_FLIGHT_TAKEOVER_MS 视为崩溃遗留，可被同摘要重试接管（不再永久 409）；
 * - 非 JSON 文本响应（Buffer/Stream）不可回放：记录终态并在重放时明确 409，而不是永远停在"处理中"。
 */

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
/** 处理中记录的接管阈值：超过该时长仍未完成，视为进程崩溃遗留。 */
export const IN_FLIGHT_TAKEOVER_MS = 5 * 60 * 1000;
/** 非 JSON 响应的终态标记（无法回放）。 */
const NON_REPLAYABLE_MARKER = '__ancsNonReplayable';

declare module 'fastify' {
  interface FastifyRequest {
    idempotency: { scope: string; key: string } | null;
  }
}

function isNonReplayable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>)[NON_REPLAYABLE_MARKER] === true;
}

export function registerIdempotency(app: FastifyInstance, deps: AuthDeps): void {
  app.decorateRequest('idempotency', null);

  app.addHook('preHandler', async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;

    // 幂等键来源：请求头优先；其次请求体内的 idempotencyKey（编辑协议 §4.6 的信封字段）
    const headerKey = request.headers['idempotency-key'];
    const bodyKey =
      typeof request.body === 'object' && request.body !== null && 'idempotencyKey' in request.body
        ? (request.body as { idempotencyKey?: unknown }).idempotencyKey
        : undefined;
    const rawKey: unknown = headerKey ?? bodyKey;
    if (rawKey === undefined) return;
    if (typeof rawKey !== 'string' || !idempotencyKeySchema.safeParse(rawKey).success) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'Idempotency-Key 非法（8—200 字符）', 400);
    }

    const context = await app.authResolve(request);
    if (context === null) return;

    const scope = `user:${context.userId}:${request.method}:${request.routeOptions.url ?? request.url}`;
    const requestHash = createHash('sha256').update(JSON.stringify({ url: request.url, body: request.body ?? null }), 'utf8').digest('hex');

    const existingRows = await deps.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, rawKey)))
      .limit(1);
    const existing = existingRows[0];

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ApiFailure(ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Idempotency-Key 已用于不同的请求内容', 409);
      }
      if (existing.statusCode === null) {
        const stale = Date.now() - existing.createdAt.getTime() > IN_FLIGHT_TAKEOVER_MS;
        if (!stale) {
          throw new ApiFailure(ERROR_CODES.IDEMPOTENCY_CONFLICT, '相同幂等键的请求仍在处理中', 409);
        }
        // 崩溃遗留：只删除仍处于"处理中"的这一行，再走下面的插入（并发接管由唯一键裁决）
        await deps.db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.id, existing.id), isNull(idempotencyKeys.statusCode)));
      } else {
        if (isNonReplayable(existing.responseJson)) {
          throw new ApiFailure(ERROR_CODES.IDEMPOTENCY_CONFLICT, '相同幂等键的请求已完成，但其响应不可回放', 409, { completedStatus: existing.statusCode });
        }
        void reply.status(existing.statusCode).header('idempotency-replayed', 'true').send(existing.responseJson);
        return reply;
      }
    }

    try {
      await deps.db.insert(idempotencyKeys).values({
        id: `idem_${randomUUID()}`,
        scope,
        key: rawKey,
        requestHash,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiFailure(ERROR_CODES.IDEMPOTENCY_CONFLICT, '相同幂等键的请求仍在处理中', 409);
      }
      throw error;
    }

    request.idempotency = { scope, key: rawKey };
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const idempotency = request.idempotency;
    if (idempotency === null) return payload;
    if (typeof payload !== 'string') {
      // 非文本响应：5xx 仍视为未发生；其余落终态（不可回放），避免该键永远停在"处理中"
      if (reply.statusCode >= 500) {
        await deps.db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.scope, idempotency.scope), eq(idempotencyKeys.key, idempotency.key)));
      } else {
        await deps.db.update(idempotencyKeys)
          .set({ statusCode: reply.statusCode, responseJson: { [NON_REPLAYABLE_MARKER]: true }, completedAt: new Date() })
          .where(and(eq(idempotencyKeys.scope, idempotency.scope), eq(idempotencyKeys.key, idempotency.key)));
      }
      return payload;
    }

    if (reply.statusCode >= 500) {
      // 视为未发生：允许重试
      await deps.db
        .delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.scope, idempotency.scope), eq(idempotencyKeys.key, idempotency.key)));
      return payload;
    }

    let parsed: unknown = null;
    if (payload.trim().length > 0) {
      try {
        parsed = JSON.parse(payload) as unknown;
      } catch {
        parsed = null;
      }
    }
    await deps.db
      .update(idempotencyKeys)
      .set({ statusCode: reply.statusCode, responseJson: parsed, completedAt: new Date() })
      .where(and(eq(idempotencyKeys.scope, idempotency.scope), eq(idempotencyKeys.key, idempotency.key)));
    return payload;
  });
}
