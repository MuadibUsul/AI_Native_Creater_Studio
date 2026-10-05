import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
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
 */

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

declare module 'fastify' {
  interface FastifyRequest {
    idempotency: { scope: string; key: string } | null;
  }
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
    const requestHash = createHash('sha256').update(JSON.stringify(request.body ?? null), 'utf8').digest('hex');

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
        throw new ApiFailure(ERROR_CODES.IDEMPOTENCY_CONFLICT, '相同幂等键的请求仍在处理中', 409);
      }
      void reply.status(existing.statusCode).header('idempotency-replayed', 'true').send(existing.responseJson);
      return reply;
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
    if (typeof payload !== 'string') return payload;

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
