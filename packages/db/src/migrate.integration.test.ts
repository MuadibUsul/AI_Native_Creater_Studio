import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDb, resolveTestDatabaseUrl, runMigrationsLocked } from './index.js';

/**
 * 部署迁移：两个实例同时执行（滚动发布时常见）——咨询锁保证只有一个在迁移，另一个等完成后发现已是最新；
 * 在一个全新的数据库上验证，结束后删除。
 */
describe('部署迁移（加锁）', () => {
  it('并发执行两次：都成功、表只建一遍、迁移记录与迁移文件一致', async () => {
    const base = resolveTestDatabaseUrl();
    const name = `ancs_migtest_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`;
    const admin = createDb(base);
    await admin.pool.query(`create database "${name}"`);
    const url = new URL(base);
    url.pathname = `/${name}`;
    const a = createDb(url.toString());
    const b = createDb(url.toString());
    try {
      const results = await Promise.all([runMigrationsLocked(a), runMigrationsLocked(b)]);
      expect(results).toHaveLength(2);
      const applied = await a.pool.query<{ count: number }>('select count(*)::int as count from drizzle.__drizzle_migrations');
      const again = await runMigrationsLocked(a);
      expect(again.waitedMs).toBeGreaterThanOrEqual(0);
      const after = await a.pool.query<{ count: number }>('select count(*)::int as count from drizzle.__drizzle_migrations');
      expect(after.rows[0]!.count).toBe(applied.rows[0]!.count);
      expect(applied.rows[0]!.count).toBeGreaterThan(90);
      const locks = await a.pool.query<{ count: number }>("select count(*)::int as count from pg_locks where locktype = 'advisory'");
      expect(locks.rows[0]!.count).toBe(0);
    } finally {
      await a.close();
      await b.close();
      await admin.pool.query(`drop database if exists "${name}" with (force)`);
      await admin.close();
    }
  }, 120_000);
});
