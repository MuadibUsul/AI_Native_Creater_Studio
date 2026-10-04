import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue, Worker, type Job as BullJob } from 'bullmq';
import type { JobQueueMessage } from '@ancs/contracts';
import { BullMqJobQueue } from './index.js';

/**
 * BullMQ 真实 Redis 端到端（P03-02，兑现 P03-01 交接义务）。
 *
 * 需要 Redis：`docker compose -f infra/docker-compose.dev.yml up -d redis`
 * （CI 由 workflow 的 redis service 提供，环境变量 ANCS_TEST_REDIS_URL）。
 * 与 Postgres 集成测试一致：缺 Redis 时**失败并给出启动指引**（不静默跳过）。
 *
 * 覆盖：
 * - 适配器投递 → 真实 BullMQ Worker 消费（消息只含 { jobId, queue, attempt }）；
 * - "Worker 崩溃/未启动"期间消息在 Redis 中持久（不丢任务；恢复的 Worker 仍能消费）；
 * - 多 Worker 竞争同一队列：每条消息恰好被一个 Worker 消费（无重复消费）。
 */

const redisUrl = process.env['ANCS_TEST_REDIS_URL'] ?? 'redis://127.0.0.1:56379';

function connection(): { url: string } {
  return { url: redisUrl };
}

let reachable = false;

beforeAll(async () => {
  try {
    const probe = new Queue(`probe-${randomUUID()}`, { connection: connection() });
    await probe.waitUntilReady();
    await probe.close();
    reachable = true;
  } catch (error) {
    throw new Error(
      `无法连接测试 Redis（${redisUrl}）。请先运行：docker compose -f infra/docker-compose.dev.yml up -d redis，` +
        '或设置 ANCS_TEST_REDIS_URL。',
      { cause: error },
    );
  }
});

afterAll(() => {
  expect(reachable).toBe(true);
});

describe('BullMQ 端到端（真实 Redis）', () => {
  it('适配器投递 → Worker 消费（消息只含任务 ID 与路由）', async () => {
    const queueName = `ancs-e2e-${randomUUID().slice(0, 8)}`;
    const adapter = new BullMqJobQueue({ redisUrl });

    const received: JobQueueMessage[] = [];
    const worker = new Worker(
      queueName,
      async (job: BullJob) => {
        received.push(job.data as JobQueueMessage);
        return { ok: true };
      },
      { connection: connection(), concurrency: 1 },
    );
    await worker.waitUntilReady();

    const message: JobQueueMessage = { jobId: `job_${randomUUID()}`, queue: queueName, attempt: 0 };
    await adapter.enqueue(message);
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(message);
    expect(Object.keys(received[0] ?? {}).sort()).toEqual(['attempt', 'jobId', 'queue']);

    await worker.close();
    await adapter.close();
  });

  it('"Worker 未运行/崩溃"期间消息持久在 Redis；恢复的 Worker 仍能消费（不丢任务）', async () => {
    const queueName = `ancs-e2e-resume-${randomUUID().slice(0, 8)}`;
    const adapter = new BullMqJobQueue({ redisUrl });
    const message: JobQueueMessage = { jobId: `job_${randomUUID()}`, queue: queueName, attempt: 1 };

    // 无消费者：投递后消息停留在队列（Redis 持久）
    await adapter.enqueue(message);
    const inspect = new Queue(queueName, { connection: connection() });
    await inspect.waitUntilReady();
    expect(await inspect.getWaitingCount()).toBe(1);
    expect(await inspect.getActiveCount()).toBe(0);

    // 恢复：启动 Worker → 立即消费
    const received: JobQueueMessage[] = [];
    const worker = new Worker(
      queueName,
      async (job: BullJob) => {
        received.push(job.data as JobQueueMessage);
      },
      { connection: connection(), concurrency: 1 },
    );
    await worker.waitUntilReady();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(received).toHaveLength(1);
    expect(received[0]?.jobId).toBe(message.jobId);

    await worker.close();
    await inspect.close();
    await adapter.close();
  });

  it('多 Worker 竞争：每条消息恰好被消费一次（无重复副作用）', async () => {
    const queueName = `ancs-e2e-race-${randomUUID().slice(0, 8)}`;
    const adapter = new BullMqJobQueue({ redisUrl });
    const seen: string[] = [];
    const duplicates: string[] = [];

    const handle = async (job: BullJob): Promise<void> => {
      const payload = job.data as JobQueueMessage;
      if (seen.includes(payload.jobId)) duplicates.push(payload.jobId);
      seen.push(payload.jobId);
      await new Promise((resolve) => setTimeout(resolve, 30));
    };

    const workers = await Promise.all(
      [0, 1, 2].map(async () => {
        const worker = new Worker(queueName, handle, { connection: connection(), concurrency: 1 });
        await worker.waitUntilReady();
        return worker;
      }),
    );

    const jobIds = Array.from({ length: 6 }, () => `job_${randomUUID()}`);
    for (const jobId of jobIds) {
      await adapter.enqueue({ jobId, queue: queueName, attempt: 0 });
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(new Set(seen).size).toBe(jobIds.length);
    expect(duplicates).toHaveLength(0);

    await Promise.all(workers.map((worker) => worker.close()));
    await adapter.close();
  }, 20_000);
});
