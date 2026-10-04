import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { claimJob, createJob, listJobs, NOOP_JOB_TYPE, type DomainDeps } from '@ancs/domain';
import { createDefaultRegistry } from './handlers.js';
import { executeJob } from './runner.js';

/**
 * Worker 执行器闭环（P03-01，真实 DB）：认领 → 执行器（NOOP handler）→ SUCCEEDED；
 * 未知任务类型 → FAILED_FINAL（明确结果，不静默吞）。
 *
 * 说明：这是 apps/worker 自己的测试（R1：apps 之间不得互相依赖，API 测试不引用 worker 包）。
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

describe('Worker 执行器', () => {
  it('NOOP：认领 → 执行 → SUCCEEDED（结果落库、租约释放）', async () => {
    const workspaceId = `ws_${randomUUID()}`;
    await handle.db.insert(workspaces).values({ id: workspaceId, name: 'Worker 测试租户' });
    const registry = createDefaultRegistry();

    const job = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: { echo: 'x' } });
    const claimed = await claimJob(deps(), { workerId: 'w-test', leaseSeconds: 30, types: registry.types() });
    expect(claimed?.id).toBe(job.id);

    const outcome = await executeJob(deps(), registry, { workerId: 'w-test', leaseSeconds: 30, heartbeatIntervalMs: 1000 }, claimed!);
    expect(outcome).toBe('succeeded');

    const rows = await listJobs(deps(), { workspaceId });
    expect(rows[0]?.status).toBe('SUCCEEDED');
    expect(rows[0]?.result).toMatchObject({ ok: true, echo: 'x' });
    expect(rows[0]?.completedAt).not.toBeNull();
  });

  it('未知任务类型 → FAILED_FINAL（含已注册类型清单，便于排查）', async () => {
    const workspaceId = `ws_${randomUUID()}`;
    await handle.db.insert(workspaces).values({ id: workspaceId, name: 'Worker 测试租户' });
    const registry = createDefaultRegistry();

    await createJob(deps(), { workspaceId, type: 'NOT_REGISTERED', input: {} });
    const claimed = await claimJob(deps(), { workerId: 'w-test', leaseSeconds: 30, types: ['NOT_REGISTERED'] });
    expect(claimed).not.toBeNull();

    const outcome = await executeJob(deps(), registry, { workerId: 'w-test', leaseSeconds: 30, heartbeatIntervalMs: 1000 }, claimed!);
    expect(outcome).toBe('failed');

    const rows = await listJobs(deps(), { workspaceId });
    expect(rows[0]?.status).toBe('FAILED_FINAL');
    expect(rows[0]?.error).toMatchObject({ reason: 'UNKNOWN_JOB_TYPE', type: 'NOT_REGISTERED' });
  });
});
