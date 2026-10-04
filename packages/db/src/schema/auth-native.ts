import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

/**
 * 原生客户端令牌表（P01-02）。
 *
 * 安全约定（REQ-30-01 / §30）：
 * - 只存储令牌的 sha256 哈希（token_hash），明文令牌仅存在于客户端内存/系统安全存储；
 * - Access Token 短生命周期；Refresh Token 轮换（单次使用），重放触发整个 family 撤销；
 * - 所有过期时间与撤销状态以数据库为权威（服务端可随时撤销）。
 */

export const authAuthorizationCodes = pgTable(
  'auth_authorization_codes',
  {
    id: text('id').primaryKey(),
    codeHash: text('code_hash').notNull().unique(),
    clientId: text('client_id').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('auth_authorization_codes_user_idx').on(table.userId)],
);

export const authRefreshTokens = pgTable(
  'auth_refresh_tokens',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    /** 轮换家族：同一授权派生的 refresh 序列共享 familyId；重放时整族撤销 */
    familyId: text('family_id').notNull(),
    clientId: text('client_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('auth_refresh_tokens_family_idx').on(table.familyId),
    index('auth_refresh_tokens_user_idx').on(table.userId),
  ],
);

export const authAccessTokens = pgTable(
  'auth_access_tokens',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    familyId: text('family_id').notNull(),
    clientId: text('client_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('auth_access_tokens_family_idx').on(table.familyId),
    index('auth_access_tokens_user_idx').on(table.userId),
  ],
);
