import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

/**
 * 套餐与订阅（P09-01 / 规范 §73.1—73.2；计划 §8 P09-01）。
 *
 * - `plans`：**版本化且不可变**——每次变更追加新版本行（(planKey, version) 唯一）；
 *   价格是数据（可为 null）；业务逻辑绝不硬编码价格；
 * - `workspace_subscriptions`：append-only（历史保留；被取代的行记 supersededAt）——
 *   "修改套餐不篡改历史账单"：换套餐只新增订阅行，不改写既有订阅/账本。
 */

export const plans = pgTable(
  'plans',
  {
    id: text('id').primaryKey(),
    planKey: text('plan_key').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    /** PlanEntitlements（契约校验；权益维度见 §73.2） */
    entitlements: jsonb('entitlements').notNull(),
    /** 价格（数据；null = 未定价） */
    price: jsonb('price'),
    status: text('status').notNull().default('ACTIVE'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('plans_key_version_uq').on(table.planKey, table.version), index('plans_key_idx').on(table.planKey, table.version)],
);

export const workspaceSubscriptions = pgTable(
  'workspace_subscriptions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** 引用**具体 Plan 版本行**（不可变；同 Key 换版不追溯改写） */
    planId: text('plan_id').notNull(),
    planKey: text('plan_key').notNull(),
    planVersion: integer('plan_version').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** 被后续订阅取代（历史保留） */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    assignedBy: text('assigned_by'),
  },
  (table) => [index('workspace_subscriptions_ws_idx').on(table.workspaceId, table.startedAt)],
);
