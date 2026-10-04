import { hostname } from 'node:os';
import { createDb, redactDatabaseUrl } from '@ancs/db';
import { claimJob, runMaintenanceTick } from '@ancs/domain';
import { createDefaultRegistry, type JobHandlerRegistry } from './handlers.js';
import { createProcessRenderExecutor } from './render-executor-process.js';
import { createProcessMotionValidator } from './motion-validator-process.js';
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
/** 故障注入（P03-02）：在关键阶段退出进程，用于演练"杀 Worker 后可继续" */
const crashAt = process.env['ANCS_WORKER_CRASH_AT'] ?? '';
const workerId = process.env['ANCS_WORKER_ID'] ?? `${hostname()}-${String(process.pid)}`;
const tickIntervalMs = Number(process.env['ANCS_WORKER_TICK_MS'] ?? 1000);
const leaseSeconds = Number(process.env['ANCS_WORKER_LEASE_SECONDS'] ?? 60);
const heartbeatIntervalMs = Number(process.env['ANCS_WORKER_HEARTBEAT_MS'] ?? Math.max(1000, (leaseSeconds * 1000) / 3));

const handle = createDb(databaseUrl);
const deps = createDomainDeps(handle);
// P07-04：Final 合成任务注册（进程隔离渲染执行器；ANCS_DISABLE_RENDER=1 可显式关闭，
// 此时 RENDER_FINAL 落入"未知类型 → FAILED_FINAL"——明确失败，不静默吞）
const registry: JobHandlerRegistry =
  process.env['ANCS_DISABLE_RENDER'] === '1'
    ? createDefaultRegistry()
    : createDefaultRegistry({ renderExecutor: createProcessRenderExecutor(), motionValidator: createProcessMotionValidator() });

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
  // 1) 维护（可重入）：租约回收（崩溃恢复）→ 重试退避推进 → 孤儿依赖检查 → Outbox 派发
  const tickReport = await runMaintenanceTick(deps, { limit: 50 });
  if (tickReport.leases.requeued > 0) {
    console.log(`[worker ${workerId}] 租约回收：${String(tickReport.leases.requeued)}（需对账 ${String(tickReport.leases.needsReconciliation)}）`);
  }
  if (tickReport.retries.promoted > 0 || tickReport.dependents.resolved > 0) {
    console.log(
      `[worker ${workerId}] 恢复推进：重试升级 ${String(tickReport.retries.promoted)}、孤儿依赖解析 ${String(tickReport.dependents.resolved)}`,
    );
  }
  if (tickReport.dispatch.enqueued > 0 || tickReport.dispatch.failed > 0) {
    console.log(`[worker ${workerId}] 派发：enqueued=${String(tickReport.dispatch.enqueued)} failed=${String(tickReport.dispatch.failed)}`);
  }

  // 2) 认领并执行
  let executed = 0;
  for (;;) {
    if (stopping) break;
    const claimed = await claimJob(deps, { workerId, leaseSeconds, types: registry.types() });
    if (claimed === null) break;
    console.log(`[worker ${workerId}] 认领 ${claimed.id}（${claimed.type}，attempt ${String(claimed.attempts)}）`);
    const outcome = await executeJob(
      deps,
      registry,
      {
        workerId,
        leaseSeconds,
        heartbeatIntervalMs,
        onPhase: (phase) => {
          if (crashAt !== '' && crashAt === phase) {
            console.error(`[worker ${workerId}] 故障注入：在 ${phase} 阶段退出（模拟 Worker 崩溃）`);
            process.exit(86);
          }
        },
      },
      claimed,
    );
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
