import { createDb, redactDatabaseUrl } from '@ancs/db';
import { runNotificationDispatch, type DomainDeps } from '@ancs/domain';

/**
 * Outbox 消费者入口（P02-06；CLI/Worker 形态，可重入）。
 *
 *   pnpm --filter @ancs/api run events:dispatch [-- --loop]
 *
 * 默认单轮：消费未投递 Outbox 事件（生成持久化通知 + 标记 published_at）。
 * `--loop` 常驻（1s 间隔；P03-01 引入 BullMQ 后由调度器接管）。
 * SSE 连接在每次 tick 也会驱动同样的消费者（可重入、行锁复核，不重复派发）。
 */

const databaseUrl = process.env['DATABASE_URL'] ?? '';
if (databaseUrl === '') {
  console.error('派发失败：DATABASE_URL 未配置。');
  process.exit(1);
}

const handle = createDb(databaseUrl);
const deps: DomainDeps = { db: handle.db };
const loop = process.argv.includes('--loop');

const once = async (): Promise<void> => {
  const report = await runNotificationDispatch(deps, { limit: 100 });
  if (!loop || report.scanned > 0) {
    console.log(JSON.stringify({ database: redactDatabaseUrl(databaseUrl), report }));
  }
};

try {
  if (loop) {
    for (;;) {
      await once();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await once();
  await handle.close();
  process.exit(0);
} catch (error) {
  console.error(`派发失败：${error instanceof Error ? error.message : String(error)}`);
  await handle.close().catch(() => undefined);
  process.exit(1);
}
