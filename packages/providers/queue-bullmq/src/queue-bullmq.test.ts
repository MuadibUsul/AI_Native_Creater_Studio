import { describe, expect, it } from 'vitest';
import { BullMqJobQueue, type MinimalQueue } from './index.js';

/**
 * BullMQ 适配器契约测试（P03-01）：用注入式假工厂验证
 * - 消息体只含 { jobId, queue, attempt }（计划 §5.5：只携带任务 ID 与必要路由信息）；
 * - 队列名路由（不同类型 → 不同队列，同队列复用客户端实例）；
 * - BullMQ 任务 ID = jobId:attempt（投递幂等）；
 * - close 关闭全部队列。
 *
 * 真实 Redis 端到端（Worker 崩溃/重启恢复）需 Redis 服务——CI 未加 redis service，
 * 已记录为交接义务（P03-02 恢复与取消一并覆盖）；投递失败不丢任务的正确性由
 * DB 权威路径的集成测试覆盖（apps/api/src/jobs.integration.test.ts）。
 */

interface RecordedAdd {
  queueName: string;
  name: string;
  data: unknown;
  options: unknown;
}

function makeHarness(): { adds: RecordedAdd[]; closed: string[]; createQueue: (name: string) => MinimalQueue } {
  const adds: RecordedAdd[] = [];
  const closed: string[] = [];
  let counter = 0;
  return {
    adds,
    closed,
    createQueue: (name: string): MinimalQueue => ({
      add: (jobName, data, options) => {
        adds.push({ queueName: name, name: jobName, data, options });
        counter += 1;
        return Promise.resolve({ id: `fake-${String(counter)}` });
      },
      close: () => {
        closed.push(name);
        return Promise.resolve();
      },
    }),
  };
}

describe('BullMQ 队列适配器（契约级）', () => {
  it('消息只含 { jobId, queue, attempt }；jobId 参与 BullMQ 任务 ID（幂等投递）', async () => {
    const harness = makeHarness();
    const adapter = new BullMqJobQueue({ redisUrl: 'redis://localhost:6379', createQueue: harness.createQueue });

    await adapter.enqueue({ jobId: 'job_1', queue: 'maintenance', attempt: 0 });
    expect(harness.adds).toHaveLength(1);
    expect(harness.adds[0]?.data).toEqual({ jobId: 'job_1', queue: 'maintenance', attempt: 0 });
    expect(JSON.stringify(harness.adds[0]?.data)).not.toContain('input'); // 权威输入不进消息
    expect(harness.adds[0]?.options).toMatchObject({ jobId: 'job_1:0' });

    await adapter.enqueue({ jobId: 'job_1', queue: 'maintenance', attempt: 1 });
    expect(harness.adds[1]?.options).toMatchObject({ jobId: 'job_1:1' });

    // 非法消息（缺少 jobId）→ 拒绝
    await expect(adapter.enqueue({ queue: 'x', attempt: 0 } as never)).rejects.toBeDefined();
  });

  it('队列名路由：同队列复用客户端、不同队列各自实例；close 全部关闭', async () => {
    const created: string[] = [];
    const harness = makeHarness();
    const adapter = new BullMqJobQueue({
      redisUrl: 'redis://localhost:6379',
      createQueue: (name) => {
        created.push(name);
        return harness.createQueue(name);
      },
    });

    await adapter.enqueue({ jobId: 'job_a', queue: 'default', attempt: 0 });
    await adapter.enqueue({ jobId: 'job_b', queue: 'default', attempt: 0 });
    await adapter.enqueue({ jobId: 'job_c', queue: 'maintenance', attempt: 0 });
    expect(created).toEqual(['default', 'maintenance']); // default 只创建一次

    await adapter.close();
    expect(harness.closed.sort()).toEqual(['default', 'maintenance']);
  });

  it('未配置 REDIS_URL → 构造即失败（fail-closed，不静默降级为内存队列）', () => {
    expect(() => new BullMqJobQueue({ redisUrl: '' })).toThrow(/REDIS_URL/);
  });
});
