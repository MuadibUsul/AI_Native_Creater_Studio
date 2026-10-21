import { crossCheckStorageEnv, formatEnvFailure, retentionCliEnvSchema, validateEnv } from '@ancs/contracts';
import { createDb, redactDatabaseUrl } from '@ancs/db';
import { runRetentionSweep, type DomainDeps } from '@ancs/domain';
import { LocalObjectStorage, localStorageOptionsFromEnv } from '@ancs/providers-storage-local';
import { S3ObjectStorage, s3StorageOptionsFromEnv } from '@ancs/providers-storage-s3';

/**
 * 保留清理入口（P02-05；CLI/Worker 形态，可重入）。
 *
 *   pnpm --filter @ancs/api run retention:sweep
 *
 * 语义：Trash 到期硬删（含对象）、保留类 TTL 到期清理、过期上传意图收敛、幂等键 TTL；
 * 重复执行/中断后重跑收敛（详见 domain/retention.ts）。退出码：0 = 成功，1 = 配置错误/执行失败。
 * 关键点（崩溃重启）后再次执行即可继续——本命令不维护内存状态。
 */

// 与 API/Worker 同一套校验与存储签名规则（非法数值在启动期 fail-closed，不会变成 NaN）
const envResult = validateEnv(retentionCliEnvSchema, process.env);
if (!envResult.ok || envResult.value === null) {
  console.error(formatEnvFailure('retention-sweep', envResult.issues));
  process.exit(1);
}
const config = envResult.value;
const configIssues = [
  ...crossCheckStorageEnv(config),
  ...(config.NODE_ENV === 'production' && config.ANCS_STORAGE_DRIVER === 'local' && config.ANCS_STORAGE_SECRET === undefined
    ? [{ variable: 'ANCS_STORAGE_SECRET', message: '生产环境必须显式配置（与 API 同一把签名密钥）' }]
    : []),
];
if (configIssues.length > 0) {
  console.error(formatEnvFailure('retention-sweep', configIssues));
  process.exit(1);
}
const databaseUrl = config.DATABASE_URL;

const handle = createDb(databaseUrl);
const storage = config.ANCS_STORAGE_DRIVER === 's3' ? new S3ObjectStorage(s3StorageOptionsFromEnv(config)) : new LocalObjectStorage(localStorageOptionsFromEnv(config));

const deps: DomainDeps = {
  db: handle.db,
  storage,
  retention: {
    ...(config.ANCS_TRASH_RETENTION_DAYS !== undefined ? { trashRetentionDays: config.ANCS_TRASH_RETENTION_DAYS } : {}),
    ...(config.ANCS_IDEMPOTENCY_TTL_HOURS !== undefined ? { idempotencyKeyTtlHours: config.ANCS_IDEMPOTENCY_TTL_HOURS } : {}),
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
