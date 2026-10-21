import { describe, expect, it } from 'vitest';
import { createDb, dbPoolOptionsFromEnv, resolveTestDatabaseUrl } from './client.js';

/** 连接池参数由配置注入：语句超时真的生效、连不上时按连接超时失败而不是挂起；缺省保持原值。 */
describe('数据库连接池参数', () => {
  it('配置映射：只带出配置了的项', () => {
    expect(dbPoolOptionsFromEnv({})).toEqual({});
    expect(dbPoolOptionsFromEnv({ ANCS_DB_POOL_MAX: 20, ANCS_DB_CONNECT_TIMEOUT_MS: 5000, ANCS_DB_STATEMENT_TIMEOUT_MS: 30_000 })).toEqual({ max: 20, connectionTimeoutMs: 5000, statementTimeoutMs: 30_000 });
  });

  it('上限与语句超时生效：pg_sleep 超过上限被数据库取消', async () => {
    const handle = createDb(resolveTestDatabaseUrl(), { max: 3, statementTimeoutMs: 1000 });
    try {
      expect(handle.pool.options.max).toBe(3);
      expect((await handle.pool.query('show statement_timeout')).rows[0]).toEqual({ statement_timeout: '1s' });
      await expect(handle.pool.query('select pg_sleep(3)')).rejects.toThrow(/statement timeout/);
      expect((await handle.pool.query('select 1 as ok')).rows[0]).toEqual({ ok: 1 });
    } finally {
      await handle.close();
    }
  });

  it('连接超时：数据库不可达时在上限内失败', async () => {
    const unreachable = new URL(resolveTestDatabaseUrl());
    unreachable.hostname = '10.255.255.1';
    const handle = createDb(unreachable.toString(), { connectionTimeoutMs: 500 });
    const started = Date.now();
    try {
      await expect(handle.pool.query('select 1')).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await handle.close();
    }
  });
});
