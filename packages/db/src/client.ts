import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export interface DbHandle {
  readonly db: NodePgDatabase;
  readonly pool: Pool;
  close(): Promise<void>;
}

/**
 * 创建数据库句柄（P00-03 基线）。
 * 表结构与迁移在 P02 起按任务加入（DEC-12：按实际阶段建表）。
 */
export function createDb(connectionString: string): DbHandle {
  const pool = new Pool({ connectionString, max: 5 });
  const db = drizzle(pool);
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

/** 本地开发默认连接（infra/docker-compose.dev.yml）；测试不得使用它。 */
export const DEFAULT_TEST_DATABASE_URL = 'postgres://ancs:ancs@localhost:55432/ancs_dev';

export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env['ANCS_TEST_DATABASE_URL'];
  if (!value) throw new Error('测试必须显式设置 ANCS_TEST_DATABASE_URL，指向独立测试数据库。');
  let databaseName: string;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new Error('unsupported protocol');
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error('ANCS_TEST_DATABASE_URL 格式无效。');
  }
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName) || value === env['DATABASE_URL']) {
    throw new Error('ANCS_TEST_DATABASE_URL 必须指向独立测试数据库，不能使用开发数据库。');
  }
  return value;
}

/** 便于日志输出的脱敏连接串（不泄漏密码）。 */
export function redactDatabaseUrl(url: string): string {
  return url.replace(/:\/\/[^@/]+@/, '://***@');
}
