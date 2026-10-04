import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

/**
 * Provider Catalog 版本表（P03-03 / 计划 P03-03）。
 *
 * - **平台级配置**（不含 workspace_id：§4.3 不变量针对租户数据；Catalog 是平台数据）；
 * - **不可变版本**：任何能力/价格/限额/地区/保留策略变更写入新版本（version 单调递增，
 *   与 ChannelStyleVersion 同模式）；当前版本 = MAX(version)。
 */

export const providerCatalogVersions = pgTable(
  'provider_catalog_versions',
  {
    id: text('id').primaryKey(),
    version: integer('version').notNull(),
    /** ProviderCatalog（契约校验后的完整文档：entries → models → price/limits/regions/verifiedAt） */
    catalog: jsonb('catalog').notNull(),
    note: text('note'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('provider_catalog_versions_version_uq').on(table.version),
    index('provider_catalog_versions_created_idx').on(table.createdAt),
  ],
);
