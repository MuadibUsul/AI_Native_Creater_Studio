import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { projects, scenes } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * 资产模型（P02-04 / 规范 §22.5、§26、§27；计划 §4.2：Asset / AssetVersion / UploadIntent /
 * LicenseMetadata / RetentionClass）。
 *
 * - 数据库只存 `storage_key`，不存 Object URL（§26）；
 * - Asset = 逻辑身份；AssetVersion = 不可变对象事实（替换内容 = 新版本行，不覆盖旧行）；
 * - current_version_id **有意不建 FK**（与 asset_versions.asset_id 构成类型循环会使行类型坍缩；
 *   版本行随 asset 级联删除，由 asset_versions.asset_id 一侧负责）；
 * - 所有表携带 workspace_id（§4.3 不变量 1）。
 */

export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /** 来源场景（可选，非绑定关系；绑定在 scenes.asset_bindings） */
    sceneId: text('scene_id').references(() => scenes.id, { onDelete: 'set null' }),
    assetType: text('asset_type').notNull(),
    origin: text('origin').notNull(),
    provider: text('provider'),
    providerAssetId: text('provider_asset_id'),
    status: text('status').notNull().default('PENDING_UPLOAD'),
    retentionClass: text('retention_class').notNull(),
    /** LicenseMetadata（授权/来源审计） */
    license: jsonb('license').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    /** 当前版本（无 FK，见文件头注释） */
    currentVersionId: text('current_version_id'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Trash 软删（P02-05） */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('assets_workspace_idx').on(table.workspaceId),
    index('assets_project_idx').on(table.projectId),
    index('assets_workspace_type_idx').on(table.workspaceId, table.assetType),
  ],
);

export const assetVersions = pgTable(
  'asset_versions',
  {
    id: text('id').primaryKey(),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    /** 逻辑路径见 §26；对象内容由存储适配器管理 */
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    /** 5 GiB 上限超出 int4 → bigint */
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksumSha256: text('checksum_sha256'),
    durationMs: integer('duration_ms'),
    width: integer('width'),
    height: integer('height'),
    status: text('status').notNull().default('UPLOADING'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('asset_versions_asset_version_uq').on(table.assetId, table.versionNumber),
    /** workspace 内哈希去重查询（§26.3） */
    index('asset_versions_workspace_checksum_idx').on(table.workspaceId, table.checksumSha256),
    index('asset_versions_storage_key_idx').on(table.storageKey),
  ],
);

export const uploadIntents = pgTable(
  'upload_intents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    assetVersionId: text('asset_version_id')
      .notNull()
      .references(() => assetVersions.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    expectedMimeType: text('expected_mime_type').notNull(),
    expectedSizeBytes: bigint('expected_size_bytes', { mode: 'number' }).notNull(),
    expectedChecksumSha256: text('expected_checksum_sha256'),
    /** SINGLE 为旧整对象直传；MULTIPART 为 N02-01 可恢复分片直传。 */
    uploadMode: text('upload_mode').notNull().default('SINGLE'),
    partSizeBytes: integer('part_size_bytes'),
    partCount: integer('part_count'),
    /** PENDING / COMPLETED / EXPIRED / FAILED */
    status: text('status').notNull().default('PENDING'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('upload_intents_asset_idx').on(table.assetId),
    index('upload_intents_workspace_status_idx').on(table.workspaceId, table.status),
    index('upload_intents_expires_idx').on(table.expiresAt),
  ],
);

export const uploadParts = pgTable(
  'upload_parts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    uploadIntentId: text('upload_intent_id')
      .notNull()
      .references(() => uploadIntents.id, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    storageKey: text('storage_key').notNull(),
    status: text('status').notNull().default('PENDING'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    checksumSha256: text('checksum_sha256'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('upload_parts_intent_number_uq').on(table.uploadIntentId, table.partNumber),
    index('upload_parts_workspace_intent_idx').on(table.workspaceId, table.uploadIntentId),
  ],
);
