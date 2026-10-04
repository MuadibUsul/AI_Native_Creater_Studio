import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, type DbHandle } from './client.js';

const TABLE = 'p0003_smoke_items';

/**
 * P00-03 兼容性验证：Drizzle 事务语义（真实 PostgreSQL）。
 * 这里验证的"条件更新 + revision"正是 P02-02 编辑事务协议的原语。
 */
describe('Drizzle 事务（真实 PostgreSQL）', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    const url = resolveTestDatabaseUrl();
    handle = createDb(url);
    try {
      await handle.pool.query('select 1');
    } catch (error) {
      await handle.close();
      throw new Error(
        `无法连接测试数据库 ${redactDatabaseUrl(url)}。请先运行：` +
          'docker compose -f infra/docker-compose.dev.yml up -d，或设置 ANCS_TEST_DATABASE_URL。',
        { cause: error },
      );
    }
    await handle.db.execute(sql.raw(`drop table if exists ${TABLE}`));
    await handle.db.execute(
      sql.raw(`create table ${TABLE} (id integer primary key, label text not null, revision integer not null default 1)`),
    );
  });

  afterAll(async () => {
    await handle.db.execute(sql.raw(`drop table if exists ${TABLE}`));
    await handle.close();
  });

  beforeEach(async () => {
    await handle.db.execute(sql.raw(`truncate ${TABLE}`));
  });

  it('事务提交：写入在事务结束后可见', async () => {
    await handle.db.transaction(async (tx) => {
      await tx.execute(sql`insert into ${sql.raw(TABLE)} (id, label) values (1, 'a'), (2, 'b')`);
    });
    const result = await handle.db.execute<{ count: number }>(
      sql.raw(`select count(*)::int as count from ${TABLE}`),
    );
    expect(result.rows[0]?.count).toBe(2);
  });

  it('事务回滚：抛错后不留下任何写入', async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(sql`insert into ${sql.raw(TABLE)} (id, label) values (1, 'a')`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const result = await handle.db.execute<{ count: number }>(
      sql.raw(`select count(*)::int as count from ${TABLE}`),
    );
    expect(result.rows[0]?.count).toBe(0);
  });

  it('事务中途数据库错误：整个事务原子回滚', async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(sql`insert into ${sql.raw(TABLE)} (id, label) values (1, 'a')`);
        // 主键冲突：第二条插入失败，第一条必须一并回滚
        await tx.execute(sql`insert into ${sql.raw(TABLE)} (id, label) values (1, 'duplicate')`);
      }),
    ).rejects.toThrowError();

    const result = await handle.db.execute<{ count: number }>(
      sql.raw(`select count(*)::int as count from ${TABLE}`),
    );
    expect(result.rows[0]?.count).toBe(0);
  });

  it('条件更新（revision）：并发竞争只有一个成功（P02-02 并发协议原语）', async () => {
    await handle.db.execute(sql`insert into ${sql.raw(TABLE)} (id, label, revision) values (1, 'v1', 1)`);

    const first = await handle.db.execute(
      sql`update ${sql.raw(TABLE)} set label = 'v2', revision = revision + 1 where id = 1 and revision = 1`,
    );
    expect(first.rowCount).toBe(1);

    // 第二个基于旧 revision 的更新必须失败（0 行受影响 → 上层返回 409 VERSION_CONFLICT）
    const second = await handle.db.execute(
      sql`update ${sql.raw(TABLE)} set label = 'v3', revision = revision + 1 where id = 1 and revision = 1`,
    );
    expect(second.rowCount).toBe(0);

    const result = await handle.db.execute<{ label: string; revision: number }>(
      sql.raw(`select label, revision from ${TABLE} where id = 1`),
    );
    expect(result.rows[0]).toEqual({ label: 'v2', revision: 2 });
  });
});
