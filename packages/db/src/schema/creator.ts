import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

/**
 * Creator / Channel 领域表（P01-04 / 规范 §6）。
 *
 * 版本语义：
 * - channels.current_style_version + channel_style_versions（不可变版本行）：
 *   修改 Channel 产生新版本；消费方（Project）快照其版本 → 旧项目不受后续修改影响。
 * - speech_profiles / speech_profile_versions：同上（发音词典随版本保存）。
 * - avatar/voice/brand_identities：单行 + version 计数器（更新 +1），
 *   历史 Manifest 记录 id+version（§6.1）。
 * 所有表携带 workspace_id（DEC-03）。
 */

export const channels = pgTable(
  'channels',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    language: text('language').notNull(),
    currentStyleVersion: integer('current_style_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('channels_workspace_idx').on(table.workspaceId)],
);

export const channelStyleVersions = pgTable(
  'channel_style_versions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** ChannelStyleDefaults（契约校验后写入；不可变） */
    defaults: jsonb('defaults').notNull(),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('channel_style_versions_channel_version_uq').on(table.channelId, table.version),
    index('channel_style_versions_workspace_idx').on(table.workspaceId),
  ],
);

export const creatorIdentities = pgTable(
  'creator_identities',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('creator_identities_workspace_idx').on(table.workspaceId)],
);

/** 每个 Creator Identity 至多一个（upsert 语义；更新 version+1） */
export const avatarIdentities = pgTable(
  'avatar_identities',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    creatorIdentityId: text('creator_identity_id')
      .notNull()
      .references(() => creatorIdentities.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    provider: text('provider'),
    providerAvatarId: text('provider_avatar_id'),
    providerAccountScope: text('provider_account_scope'),
    displayName: text('display_name'),
    status: text('status').notNull().default('ACTIVE'),
    consentMetadata: jsonb('consent_metadata').notNull().default({}),
    defaultLook: jsonb('default_look').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('avatar_identities_creator_uq').on(table.creatorIdentityId),
    index('avatar_identities_workspace_idx').on(table.workspaceId),
  ],
);

export const voiceIdentities = pgTable(
  'voice_identities',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    creatorIdentityId: text('creator_identity_id')
      .notNull()
      .references(() => creatorIdentities.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    provider: text('provider'),
    providerVoiceId: text('provider_voice_id'),
    cloneType: text('clone_type'),
    ownershipType: text('ownership_type'),
    verificationStatus: text('verification_status'),
    managedMode: text('managed_mode'),
    languageProfile: text('language_profile'),
    defaultSpeechProfileId: text('default_speech_profile_id'),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('voice_identities_creator_uq').on(table.creatorIdentityId),
    index('voice_identities_workspace_idx').on(table.workspaceId),
  ],
);

export const brandIdentities = pgTable(
  'brand_identities',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    creatorIdentityId: text('creator_identity_id')
      .notNull()
      .references(() => creatorIdentities.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    name: text('name').notNull(),
    /** ThemeTokens（规范 §57） */
    themeTokens: jsonb('theme_tokens').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('brand_identities_creator_uq').on(table.creatorIdentityId),
    index('brand_identities_workspace_idx').on(table.workspaceId),
  ],
);

export const speechProfiles = pgTable(
  'speech_profiles',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    currentVersion: integer('current_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('speech_profiles_workspace_idx').on(table.workspaceId)],
);

export const speechProfileVersions = pgTable(
  'speech_profile_versions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    speechProfileId: text('speech_profile_id')
      .notNull()
      .references(() => speechProfiles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** SpeechProfileFields（契约校验后写入；不可变） */
    fields: jsonb('fields').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('speech_profile_versions_profile_version_uq').on(table.speechProfileId, table.version),
    index('speech_profile_versions_workspace_idx').on(table.workspaceId),
  ],
);
