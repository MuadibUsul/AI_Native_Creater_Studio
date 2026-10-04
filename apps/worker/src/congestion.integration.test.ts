import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { NOOP_JOB_TYPE } from '@ancs/domain';
import { createDb, jobs, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { claimJob, createJob, type DomainDeps } from '@ancs/domain';
import { createDefaultRegistry } from './handlers.js';
import { executeJob } from './runner.js';

/**
 * P08-04 队列拥塞（真实 DB）：批量入队 → 单 Worker 串行认领/执行 →
 * - **恰好一次**：每任务 attempts=1、无重复执行（SKIP LOCKED 原子认领）；
 * - 吞吐可记录（本测试同时作为"队列不丢任务、不重复"的回归）。
 */

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try {
    await handle.pool.query('select 1');
  } catch (error) {
    await handle.close();
    throw new Error(`无法连接测试数据库 ${redactDatabaseUrl(url)}。`, { cause: error });
  }
  await runMigrations(handle);
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
});

describe('队列拥塞（P08-04）', () => {
  it('50 个任务：全部执行且恰好一次（attempts=1；无重复认领）', async () => {
    const workspaceId = `ws_${randomUUID()}`;
    await handle.db.insert(workspaces).values({ id: workspaceId, name: '拥塞租户' });
    const total = 50;
    for (let index = 0; index < total; index += 1) {
      await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: { echo: index } });
    }

    const registry = createDefaultRegistry();
    const started = process.hrtime.bigint();
    const executed: string[] = [];
    for (;;) {
      const claimed = await claimJob(deps(), { workerId: 'congestion-worker', leaseSeconds: 60, types: [NOOP_JOB_TYPE] });
      if (claimed === null) break;
      const outcome = await executeJob(deps(), registry, { workerId: 'congestion-worker', leaseSeconds: 60, heartbeatIntervalMs: 10_000 }, claimed);
      expect(outcome).toBe('succeeded');
      executed.push(claimed.id);
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // 恰好一次：执行数 = 入队数；无重复 id
    expect(executed).toHaveLength(total);
    expect(new Set(executed).size).toBe(total);

    const rows = await handle.db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId));
    expect(rows).toHaveLength(total);
    expect(rows.every((row) => row.status === 'SUCCEEDED')).toBe(true);
    // 每个任务恰好认领一次（attempts=1）
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    console.log(`[congestion] ${String(total)} 任务串行执行 ${elapsedMs.toFixed(0)}ms（≈${(total / (elapsedMs / 1000)).toFixed(1)} 任务/秒）`);
  }, 120_000);

  it('并发认领不重复：两个认领者在同一批次不会拿到同一任务（SKIP LOCKED）', async () => {
    const workspaceId = `ws_${randomUUID()}`;
    await handle.db.insert(workspaces).values({ id: workspaceId, name: '并发租户' });
    for (let index = 0; index < 10; index += 1) {
      await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: { echo: index } });
    }
    const [first, second] = await Promise.all([
      claimJob(deps(), { workerId: 'w-a', leaseSeconds: 60, types: [NOOP_JOB_TYPE] }),
      claimJob(deps(), { workerId: 'w-b', leaseSeconds: 60, types: [NOOP_JOB_TYPE] }),
    ]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.id).not.toBe(second?.id);
  }, 60_000);
});
