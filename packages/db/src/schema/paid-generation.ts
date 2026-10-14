import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { agentSessions, agentTurns } from './agent.js';
import { assets, assetVersions } from './assets.js';
import { user } from './auth.js';
import { creatorIdentities } from './creator.js';
import { projects } from './projects.js';
import { proposals } from './proposals.js';
import { workflowRuns } from './workflow.js';
import { workspaces } from './workspaces.js';

/**
 * V6-7/V6-8 付费生成：一行 = 一份报价及其后续（确认、生成、结算）。
 * 状态：QUOTED → DECLINED | RUNNING → SUCCEEDED | FAILED | NEEDS_RECONCILIATION（过期是读出时推出的）。
 * `provider_called_at` 在调用供应商之前写入：之后任何中断都只能进入待对账，不会再次调用。
 */
export const generationRequests = pgTable(
  'generation_requests',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => agentSessions.id, { onDelete: 'set null' }),
    quoteTurnId: text('quote_turn_id').references(() => agentTurns.id, { onDelete: 'set null' }),
    turnId: text('turn_id').references(() => agentTurns.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('QUOTED'),
    request: jsonb('request').notNull(),
    summary: text('summary').notNull(),
    providerId: text('provider_id').notNull(),
    providerImplementation: text('provider_implementation').notNull(),
    model: text('model').notNull(),
    estimatedSeconds: text('estimated_seconds').notNull(),
    estimateMinMicros: bigint('estimate_min_micros', { mode: 'number' }).notNull(),
    estimateMaxMicros: bigint('estimate_max_micros', { mode: 'number' }).notNull(),
    reserveCredits: integer('reserve_credits').notNull(),
    /** 生成时使用的身份档案快照（授权记录 id、参考素材版本），可追溯 */
    identitySnapshot: jsonb('identity_snapshot'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedBy: text('accepted_by').references(() => user.id, { onDelete: 'set null' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    workflowRunId: text('workflow_run_id').references(() => workflowRuns.id, { onDelete: 'set null' }),
    providerCalledAt: timestamp('provider_called_at', { withTimezone: true }),
    providerJobId: text('provider_job_id'),
    chargedMicros: bigint('charged_micros', { mode: 'number' }),
    costSource: text('cost_source'),
    assetId: text('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    footageId: text('footage_id').references(() => assetVersions.id, { onDelete: 'set null' }),
    proposalId: text('proposal_id').references(() => proposals.id, { onDelete: 'set null' }),
    outsideRegionChange: real('outside_region_change'),
    error: jsonb('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('generation_requests_project_idx').on(table.projectId, table.createdAt),
    index('generation_requests_status_idx').on(table.workspaceId, table.status),
    check('generation_requests_kind_ck', sql`${table.kind} in ('AVATAR_CLIP','VIDEO_SHOT','VIDEO_REGION')`),
    check('generation_requests_status_ck', sql`${table.status} in ('QUOTED','DECLINED','RUNNING','SUCCEEDED','FAILED','NEEDS_RECONCILIATION')`),
    check('generation_requests_impl_ck', sql`${table.providerImplementation} in ('REAL','SCRIPTED')`),
    check('generation_requests_cost_source_ck', sql`${table.costSource} is null or ${table.costSource} in ('PROVIDER','QUOTE_MAX')`),
    check('generation_requests_money_ck', sql`${table.estimateMinMicros} >= 0 and ${table.estimateMaxMicros} >= ${table.estimateMinMicros} and ${table.reserveCredits} >= 0 and (${table.chargedMicros} is null or ${table.chargedMicros} >= 0)`),
  ],
);

/**
 * V6-7 形象/声音授权记录：**只增不改**（数据库触发器拒绝 UPDATE/DELETE；工作区删除时随级联清理）。
 * 当前是否有效 = 该身份该类最近一条记录是 GRANT。
 */
export const identityConsentRecords = pgTable(
  'identity_consent_records',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    creatorIdentityId: text('creator_identity_id').notNull().references(() => creatorIdentities.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    action: text('action').notNull(),
    subject: text('subject'),
    statementVersion: text('statement_version').notNull(),
    locale: text('locale'),
    statementSha256: text('statement_sha256'),
    /** 授权时的参考素材版本（证明同意针对的是哪张照片/哪段声音） */
    referenceFootageId: text('reference_footage_id'),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('identity_consent_records_identity_idx').on(table.creatorIdentityId, table.kind, table.createdAt),
    check('identity_consent_records_kind_ck', sql`${table.kind} in ('LIKENESS','VOICE')`),
    check('identity_consent_records_action_ck', sql`${table.action} in ('GRANT','REVOKE')`),
    check('identity_consent_records_grant_ck', sql`${table.action} = 'REVOKE' or (${table.subject} in ('SELF','AUTHORIZED_OTHER') and ${table.locale} in ('zh-CN','en') and ${table.statementSha256} is not null)`),
  ],
);

/** V6-7 身份档案的参考素材：每个身份每类一份当前参考（更换 = 新行，旧行标记 replaced_at）。 */
export const identityReferences = pgTable(
  'identity_references',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    creatorIdentityId: text('creator_identity_id').notNull().references(() => creatorIdentities.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    assetId: text('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
    footageId: text('footage_id').notNull().references(() => assetVersions.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
  },
  (table) => [
    index('identity_references_identity_idx').on(table.creatorIdentityId, table.kind, table.createdAt),
    uniqueIndex('identity_references_current_uq').on(table.creatorIdentityId, table.kind).where(sql`${table.replacedAt} is null`),
    check('identity_references_kind_ck', sql`${table.kind} in ('LIKENESS','VOICE')`),
  ],
);
