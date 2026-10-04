import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { createDb, redactDatabaseUrl } from '@ancs/db';
import { runRetentionSweep, type DomainDeps } from '@ancs/domain';
import { LocalObjectStorage } from '@ancs/providers-storage-local';

/**
 * 保留清理入口（P02-05；CLI/Worker 形态，可重入）。
 *
 *   pnpm --filter @ancs/api run retention:sweep
 *
 * 语义：Trash 到期硬删（含对象）、保留类 TTL 到期清理、过期上传意图收敛、幂等键 TTL；
 * 重复执行/中断后重跑收敛（详见 domain/retention.ts）。退出码：0 = 成功，1 = 配置错误/执行失败。
 * 关键点（崩溃重启）后再次执行即可继续——本命令不维护内存状态。
 */

const databaseUrl = process.env['DATABASE_URL'] ?? '';
if (databaseUrl === '') {
  console.error('清理失败：DATABASE_URL 未配置。');
  process.exit(1);
}

const storageDriver = process.env['ANCS_STORAGE_DRIVER'] ?? 'local';
if (storageDriver !== 'local') {
  console.error(`清理失败：未知的 ANCS_STORAGE_DRIVER=${storageDriver}（当前仅支持 local）。`);
  process.exit(1);
}
const baseSecret = process.env['ANCS_STORAGE_SECRET'] ?? process.env['BETTER_AUTH_SECRET'];
if (baseSecret === undefined || baseSecret.length < 16) {
  console.error('清理失败：ANCS_STORAGE_SECRET（或 BETTER_AUTH_SECRET）未配置或过短（≥16）。');
  process.exit(1);
}
const storageSecret = process.env['ANCS_STORAGE_SECRET'] ?? createHmac('sha256', baseSecret).update('storage-local-v1').digest('hex');

const handle = createDb(databaseUrl);
const storage = new LocalObjectStorage({
  rootDir: resolve(process.env['ANCS_STORAGE_LOCAL_DIR'] ?? '.storage'),
  publicBaseUrl: process.env['ANCS_STORAGE_PUBLIC_BASE_URL'] ?? 'http://localhost:3001',
  signingSecret: storageSecret,
});

const deps: DomainDeps = {
  db: handle.db,
  storage,
  retention: {
    ...(process.env['ANCS_TRASH_RETENTION_DAYS'] !== undefined
      ? { trashRetentionDays: Number(process.env['ANCS_TRASH_RETENTION_DAYS']) }
      : {}),
    ...(process.env['ANCS_IDEMPOTENCY_TTL_HOURS'] !== undefined
      ? { idempotencyKeyTtlHours: Number(process.env['ANCS_IDEMPOTENCY_TTL_HOURS']) }
      : {}),
  },
};

try {
  const report = await runRetentionSweep(deps);
  console.log(JSON.stringify({ database: redactDatabaseUrl(databaseUrl), report }, null, 2));
  await handle.close();
  process.exit(0);
} catch (error) {
  console.error(`清理失败：${error instanceof Error ? error.message : String(error)}`);
  await handle.close().catch(() => undefined);
  process.exit(1);
}
