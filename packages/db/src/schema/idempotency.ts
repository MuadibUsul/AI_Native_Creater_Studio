import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * 写请求幂等键存储（P01-05 基线 / 计划 §4.6、规范 §33）。
 *
 * 语义：
 * - scope = user:{userId}:{method}:{routePattern}；同 scope + 同 key：
 *   同请求摘要 → 返回已存储响应；不同摘要 → 409 IDEMPOTENCY_CONFLICT；
 * - 未完成（in-flight）重复请求 → 409 IDEMPOTENCY_CONFLICT（不排队等待，基线行为）；
 * - 仅存储 <500 的响应（5xx 视为未发生，允许重试）；
 * - 记录清理（TTL）随 P02-05 保留策略建立。
 */

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code'),
    responseJson: jsonb('response_json'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('idempotency_keys_scope_key_uq').on(table.scope, table.key),
    index('idempotency_keys_created_idx').on(table.createdAt),
  ],
);
