import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

/** One synced UI appearance intent per user; absence means system. */
export const userAppearancePreferences = pgTable('user_appearance_preferences', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull().default('system'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [check('user_appearance_mode_check', sql`${table.mode} in ('system', 'light', 'dark')`)]);
