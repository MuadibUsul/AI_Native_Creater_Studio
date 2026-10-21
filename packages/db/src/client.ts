import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export interface DbHandle {
  readonly db: NodePgDatabase;
  readonly pool: Pool;
  close(): Promise<void>;
}

/** 连接池参数（由入口从已校验配置注入；缺省保持原值：最多 5 个连接、不设超时）。 */
export interface DbPoolOptions {
  /** 每个进程最多几个连接（API 副本数 × 它 + Worker 副本数 × 它 ≤ 数据库 max_connections 减余量） */
  max?: number;
  /** 等待取得连接的上限（毫秒）；数据库不可达时请求失败而不是无限挂起 */
  connectionTimeoutMs?: number;
  /** 单条语句的上限（毫秒，PostgreSQL statement_timeout）；防止失控查询占住连接 */
  statementTimeoutMs?: number;
}

/** 已校验配置 → 连接池参数（API、Worker、实时网关与命令行共用同一组变量）。 */
export function dbPoolOptionsFromEnv(env: { ANCS_DB_POOL_MAX?: number | undefined; ANCS_DB_CONNECT_TIMEOUT_MS?: number | undefined; ANCS_DB_STATEMENT_TIMEOUT_MS?: number | undefined }): DbPoolOptions {
  return {
    ...(env.ANCS_DB_POOL_MAX !== undefined ? { max: env.ANCS_DB_POOL_MAX } : {}),
    ...(env.ANCS_DB_CONNECT_TIMEOUT_MS !== undefined ? { connectionTimeoutMs: env.ANCS_DB_CONNECT_TIMEOUT_MS } : {}),
    ...(env.ANCS_DB_STATEMENT_TIMEOUT_MS !== undefined ? { statementTimeoutMs: env.ANCS_DB_STATEMENT_TIMEOUT_MS } : {}),
  };
}

/**
 * 创建数据库句柄（P00-03 基线）。
 * 表结构与迁移在 P02 起按任务加入（DEC-12：按实际阶段建表）。
 */
export function createDb(connectionString: string, options: DbPoolOptions = {}): DbHandle {
  const pool = new Pool({
    connectionString,
    max: options.max ?? 5,
    ...(options.connectionTimeoutMs !== undefined ? { connectionTimeoutMillis: options.connectionTimeoutMs } : {}),
    ...(options.statementTimeoutMs !== undefined ? { statement_timeout: options.statementTimeoutMs } : {}),
  });
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
