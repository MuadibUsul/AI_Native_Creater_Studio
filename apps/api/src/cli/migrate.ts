import { formatEnvFailure, migrateCliEnvSchema, validateEnv } from '@ancs/contracts';
import { createDb, redactDatabaseUrl, runMigrationsLocked } from '@ancs/db';

/**
 * 数据库迁移（部署时一次性运行，先于 API / Worker 新版本启动）：
 *
 *   pnpm db:migrate        （= pnpm --filter @ancs/api run db:migrate）
 *
 * 取咨询锁后迁移（多个实例同时执行时只有一个在跑，其余等它完成后发现已是最新）；幂等，可重复执行。
 * 退出码：0 = 已是最新；1 = 配置错误或迁移失败（新版本不应启动）。
 */

const envResult = validateEnv(migrateCliEnvSchema, process.env);
if (!envResult.ok || envResult.value === null) {
  console.error(formatEnvFailure('migrate', envResult.issues));
  process.exit(1);
}
const databaseUrl = envResult.value.DATABASE_URL;
const handle = createDb(databaseUrl);
const started = Date.now();
try {
  const { waitedMs } = await runMigrationsLocked(handle);
  const applied = await handle.pool.query<{ count: string }>('select count(*)::text as count from drizzle.__drizzle_migrations');
  console.log(`[migrate] ${redactDatabaseUrl(databaseUrl)}：已是最新（共 ${applied.rows[0]?.count ?? '?'} 个迁移；等锁 ${String(waitedMs)} ms，用时 ${String(Date.now() - started)} ms）`);
  await handle.close();
} catch (error) {
  console.error(`[migrate] 迁移失败：${error instanceof Error ? error.message : String(error)}`);
  await handle.close().catch(() => undefined);
  process.exit(1);
}
