import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { creatorIdentities } from './creator.js';
import { workspaces } from './workspaces.js';

/**
 * Voice Clone 表（P10-02 / 规范 §6.2、§14.3 MUST、§20.x）。
 *
 * **字段不得混同**（§14.3）：原始样本（voice_clone_samples，字节在对象存储，此处只存引用+质量报告）/
 * 授权状态（voice_consents）/ provider_voice_id 与 provider_job_id（voice_clones）/ retention policy /
 * ownership metadata——各自独立字段。
 * 生命周期方向可区分：本地退休（retired_at）≠ 平台解绑（unlinked_at）≠ Provider 删除（provider_deleted_at）。
 */

export const voiceConsents = pgTable(
  'voice_consents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    creatorIdentityId: text('creator_identity_id')
      .notNull()
      .references(() => creatorIdentities.id, { onDelete: 'cascade' }),
    /** SELF / AUTHORIZED_OTHER（禁止"任意名人"——声明版本可核对） */
    subjectType: text('subject_type').notNull(),
    statementVersion: text('statement_version').notNull(),
    statementHash: text('statement_hash').notNull(),
    acceptedByUserId: text('accepted_by_user_id').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    notes: text('notes'),
  },
  (table) => [uniqueIndex('voice_consents_identity_uq').on(table.creatorIdentityId)],
);

export const voiceCloneSamples = pgTable(
  'voice_clone_samples',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    creatorIdentityId: text('creator_identity_id')
      .notNull()
      .references(() => creatorIdentities.id, { onDelete: 'cascade' }),
    assetId: text('asset_id').notNull(),
    assetVersionId: text('asset_version_id').notNull(),
    byteSize: integer('byte_size').notNull(),
    contentType: text('content_type').notNull(),
    /** VoiceQualityReport（噪声/削波/时长/有效语音比例；JSON 快照） */
    quality: jsonb('quality').notNull(),
    /** 被哪个 clone 使用（提交时回填；样本与克隆不混同） */
    cloneId: text('clone_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('voice_clone_samples_identity_idx').on(table.creatorIdentityId, table.createdAt), index('voice_clone_samples_clone_idx').on(table.cloneId)],
);

export const voiceClones = pgTable(
  'voice_clones',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    creatorIdentityId: text('creator_identity_id')
      .notNull()
      .references(() => creatorIdentities.id, { onDelete: 'cascade' }),
    /** INSTANT / PROFESSIONAL */
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),
    /** MANAGED / BYOK */
    mode: text('mode').notNull(),
    /** DRAFT/SUBMITTED/TRAINING/READY/FAILED/RETIRED/UNLINKED/PROVIDER_DELETED */
    status: text('status').notNull().default('DRAFT'),
    qualityVerdict: text('quality_verdict').notNull(),
    consentId: text('consent_id'),
    providerVoiceId: text('provider_voice_id'),
    providerJobId: text('provider_job_id'),
    retentionPolicy: text('retention_policy'),
    ownershipMetadata: jsonb('ownership_metadata').notNull().default({}),
    failure: jsonb('failure'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    trainedAt: timestamp('trained_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    unlinkedAt: timestamp('unlinked_at', { withTimezone: true }),
    providerDeletedAt: timestamp('provider_deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('voice_clones_identity_idx').on(table.creatorIdentityId, table.createdAt), index('voice_clones_workspace_idx').on(table.workspaceId, table.status)],
);
