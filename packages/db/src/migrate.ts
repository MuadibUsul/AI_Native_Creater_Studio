import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { DbHandle } from './client.js';

/** 迁移目录（src 与 dist 下相对位置一致：包根/migrations）。 */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * 应用迁移（幂等；drizzle 通过 __drizzle_migrations 记录已应用版本）。
 * 本地/CI 测试与部署（P08-01 Runbook）使用同一入口。
 */
export async function runMigrations(handle: DbHandle, migrationsFolder: string = MIGRATIONS_DIR): Promise<void> {
  await migrate(handle.db, { migrationsFolder });
}
