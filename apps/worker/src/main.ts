import { hostname } from 'node:os';
import { createDb, redactDatabaseUrl } from '@ancs/db';
import { claimJob, requeueExpiredLeases, runJobDispatch } from '@ancs/domain';
import { createDefaultRegistry, type JobHandlerRegistry } from './handlers.js';
import { executeJob } from './runner.js';
import { createDomainDeps } from './domain.js';

/**
 * Worker 主循环（P03-01）。见 domain.ts 的说明。
 * 退出码：0 = 正常结束（once/信号停止）；1 = 配置错误或致命失败。
 */

const databaseUrl = process.env['DATABASE_URL'] ?? '';
if (databaseUrl === '') {
  console.error('Worker 启动失败：DATABASE_URL 未配置。');
  process.exit(1);
}

const once = process.env['ANCS_WORKER_ONCE'] === '1' || process.argv.includes('--once');
const workerId = process.env['ANCS_WORKER_ID'] ?? `${hostname()}-${String(process.pid)}`;
const tickIntervalMs = Number(process.env['ANCS_WORKER_TICK_MS'] ?? 1000);
const leaseSeconds = Number(process.env['ANCS_WORKER_LEASE_SECONDS'] ?? 60);
const heartbeatIntervalMs = Number(process.env['ANCS_WORKER_HEARTBEAT_MS'] ?? Math.max(1000, (leaseSeconds * 1000) / 3));

const handle = createDb(databaseUrl);
const deps = createDomainDeps(handle);
const registry: JobHandlerRegistry = createDefaultRegistry();

let stopping = false;
const stop = (signal: string): void => {
  stopping = true;
  console.log(`[worker ${workerId}] 收到 ${signal}，当前任务完成后退出。`);
};
process.on('SIGINT', () => {
  stop('SIGINT');
});
process.on('SIGTERM', () => {
  stop('SIGTERM');
});

async function tick(): Promise<number> {
  // 1) 维护：租约回收（崩溃恢复）+ Outbox 派发（投递中断可恢复）
  const leases = await requeueExpiredLeases(deps, { limit: 50 });
  if (leases.requeued > 0) {
    console.log(`[worker ${workerId}] 租约回收：${String(leases.requeued)}（需对账 ${String(leases.needsReconciliation)}）`);
  }
  const dispatch = await runJobDispatch(deps, { limit: 50 });
  if (dispatch.enqueued > 0 || dispatch.failed > 0) {
    console.log(`[worker ${workerId}] 派发：enqueued=${String(dispatch.enqueued)} failed=${String(dispatch.failed)}`);
  }

  // 2) 认领并执行
  let executed = 0;
  for (;;) {
    if (stopping) break;
    const claimed = await claimJob(deps, { workerId, leaseSeconds, types: registry.types() });
    if (claimed === null) break;
    console.log(`[worker ${workerId}] 认领 ${claimed.id}（${claimed.type}，attempt ${String(claimed.attempts)}）`);
    const outcome = await executeJob(deps, registry, { workerId, leaseSeconds, heartbeatIntervalMs }, claimed);
    console.log(`[worker ${workerId}] 完成 ${claimed.id} → ${outcome}`);
    executed += 1;
    if (once) break;
  }
  return executed;
}

try {
  let total = 0;
  if (once) {
    total += await tick();
  } else {
    while (!stopping) {
      total += await tick();
      if (stopping) break;
      await new Promise((resolve) => setTimeout(resolve, tickIntervalMs));
    }
  }
  console.log(JSON.stringify({ workerId, database: redactDatabaseUrl(databaseUrl), executed: total }));
  await deps.queue?.close?.();
  await handle.close();
  process.exit(0);
} catch (error) {
  console.error(`Worker 失败：${error instanceof Error ? error.message : String(error)}`);
  await handle.close().catch(() => undefined);
  process.exit(1);
}
