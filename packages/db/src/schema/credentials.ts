import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { workspaces } from './workspaces.js';

/**
 * Provider 连接与凭据（P03-04 / 规范 §17.2、§17.3）。
 *
 * - `provider_connections`：workspace 自有（BYOK）连接。**密文只存 `encrypted_secret` jsonb**
 *   （AES-256-GCM 封套：algorithm/keyVersion/ciphertext/nonce/authTag），明文永不落库；
 *   UI 只显示 `masked_token`；记录 created/updated/rotated/revoked/last_used/last_tested（§17.3 MUST）；
 * - 平台托管凭据不在本表：由运行环境/KMS 解析（`PlatformCredentialRegistry`），
 *   本表仅保存"平台托管可用"的登记行可选（workspace_id 为空的行表示平台登记，不含密文）；
 * - `workspace_provider_settings`：按 Provider 类别的托管模式覆盖（§17.2 的 Workspace 级覆盖）；
 *   身份级覆盖（Avatar/Voice Identity）随 P06-02 接入。
 */

export const providerConnections = pgTable(
  'provider_connections',
  {
    id: text('id').primaryKey(),
    /** NULL = 平台登记（不含密文）；非空 = 该 workspace 的 BYOK 连接 */
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    /** AES-256-GCM 封套（仅服务端；绝不外发） */
    encryptedSecret: jsonb('encrypted_secret'),
    /** UI 展示用掩码（如 ••••abcd） */
    maskedToken: text('masked_token').notNull(),
    keyVersion: text('key_version').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestStatus: text('last_test_status'),
    lastTestMode: text('last_test_mode'),
  },
  (table) => [
    index('provider_connections_workspace_idx').on(table.workspaceId, table.providerId),
    index('provider_connections_status_idx').on(table.workspaceId, table.status),
  ],
);

export const workspaceProviderSettings = pgTable(
  'workspace_provider_settings',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Provider 类别（AVATAR/VOICE 类 → TTS/AVATAR/AI_VIDEO…） */
    kind: text('kind').notNull(),
    /** AUTOMATIC | PLATFORM_MANAGED | BYOK */
    selectionMode: text('selection_mode').notNull().default('AUTOMATIC'),
    /** selectionMode=BYOK 时的连接引用（同 workspace） */
    connectionId: text('connection_id').references(() => providerConnections.id, { onDelete: 'set null' }),
    /** 预留：身份级覆盖（P06-02）时记录 scope */
    scopeIdentityId: text('scope_identity_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('workspace_provider_settings_scope_kind_uq').on(table.workspaceId, table.kind, table.scopeIdentityId),
  ],
);
