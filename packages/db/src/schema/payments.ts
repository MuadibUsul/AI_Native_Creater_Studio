import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

/**
 * 订阅收款事件与状态（P09-02 / 规范 §35、§73.1）。
 *
 * - `billing_events`：**幂等闸门**（providerEventId 唯一）——重复事件不重复生效；原始负载审计；
 * - `workspace_billing_states`：workspace 级收款状态（状态/套餐/渠道引用/水位 lastEventAt）——
 *   乱序事件（occurredAt ≤ 水位）被忽略并留审计；**用户从成功页返回不改变任何状态**。
 */

export const billingEvents = pgTable(
  'billing_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    providerEventId: text('provider_event_id').notNull(),
    type: text('type').notNull(),
    planKey: text('plan_key'),
    packCode: text('pack_code'),
    providerSubscriptionRef: text('provider_subscription_ref'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    payload: jsonb('payload').notNull().default({}),
    /** APPLIED / DUPLICATE / OUT_OF_ORDER（审计：重复与乱序同样落一行，绝不静默） */
    outcome: text('outcome').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('billing_events_provider_event_uq').on(table.providerEventId), index('billing_events_ws_idx').on(table.workspaceId, table.receivedAt)],
);

export const workspaceBillingStates = pgTable(
  'workspace_billing_states',
  {
    workspaceId: text('workspace_id')
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    state: text('state').notNull().default('NONE'),
    planKey: text('plan_key'),
    providerSubscriptionRef: text('provider_subscription_ref'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    /** 已应用事件的事件时间水位（乱序忽略依据；同刻事件按到达顺序） */
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('workspace_billing_states_state_idx').on(table.state)],
);

/** Credits 包（P09-03 / §35：价格是**版本化数据**；同 code 追加新版本，旧行不可变）。 */
export const creditPacks = pgTable(
  'credit_packs',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    credits: integer('credits').notNull(),
    priceMinor: integer('price_minor').notNull().default(0),
    currency: text('currency').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('credit_packs_code_version_uq').on(table.code, table.version), index('credit_packs_code_idx').on(table.code, table.version)],
);
