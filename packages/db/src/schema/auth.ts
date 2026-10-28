import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Better Auth 核心表（P01-02）。
 *
 * 注意：JS 字段名必须与 Better Auth 期望的字段名一致；数据库列名遵循计划 §4.1（snake_case）。
 * 认证表属于全局目录，不携带 workspace_id（DEC-03 例外）。
 */

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Better Auth twoFactor 插件表；seed 与恢复码由插件加密后保存。 */
export const twoFactor = pgTable('two_factor', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  verified: boolean('verified').notNull().default(false),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
}, (table) => [uniqueIndex('two_factor_user_unique').on(table.userId)]);

/**
 * 平台注册邀请（D-04 invite 模式）：运营给一个邮箱发"可以注册"的资格，与工作区邀请（加入某个工作区）是两回事。
 * 同一邮箱同一时刻至多一条有效（PENDING）邀请；注册成功即标记 ACCEPTED；撤销立即生效。
 */
export const signupInvitations = pgTable(
  'signup_invitations',
  {
    id: text('id').primaryKey(),
    /** 归一化（小写、去空白）存储 */
    email: text('email').notNull(),
    /** PENDING / ACCEPTED / REVOKED（EXPIRED 为读取时推导） */
    status: text('status').notNull().default('PENDING'),
    /** 谁发的邀请（运营备注，如姓名或工单号；不是账号外键） */
    invitedBy: text('invited_by'),
    note: text('note'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedUserId: text('accepted_user_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('signup_invitations_pending_email_uq').on(table.email).where(sql`${table.status} = 'PENDING'`),
    check('signup_invitations_status_ck', sql`${table.status} in ('PENDING','ACCEPTED','REVOKED')`),
  ],
);
