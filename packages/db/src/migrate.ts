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

/** 迁移互斥锁的键（pg_advisory_lock 的 bigint；固定值，所有部署实例相同） */
export const MIGRATION_LOCK_KEY = 7_201_906_420_026_001n;

/**
 * 部署用迁移：先取会话级咨询锁再迁移，多个实例 / 多个迁移任务同时启动时只有一个在跑，其余等它完成后发现已是最新。
 * 锁占用一条专用连接，迁移本身走连接池；无论成败都释放。
 */
export async function runMigrationsLocked(handle: DbHandle, migrationsFolder: string = MIGRATIONS_DIR): Promise<{ waitedMs: number }> {
  const client = await handle.pool.connect();
  const started = Date.now();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    const waitedMs = Date.now() - started;
    try {
      await runMigrations(handle, migrationsFolder);
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
    }
    return { waitedMs };
  } finally {
    client.release();
  }
}
