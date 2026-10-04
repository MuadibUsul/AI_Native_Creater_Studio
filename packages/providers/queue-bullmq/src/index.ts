import { jobQueueMessageSchema, type JobQueueAdapter, type JobQueueMessage } from '@ancs/contracts';

/**
 * BullMQ 队列适配器（P03-01 / 计划 §5.5："BullMQ 消息只携带任务 ID 和必要路由信息"）。
 *
 * 设计（诚实边界）：
 * - **权威状态永远在 PostgreSQL**：本适配器只负责"及时唤醒 Worker"；消息体仅 `{ jobId, queue, attempt }`；
 * - `bullmq` 客户端为**惰性加载/可注入**：默认工厂 `import('bullmq')`；
 *   测试注入假工厂即可验证契约（消息形状、队列名路由、关闭）；真实 Redis 端到端在具备
 *   Redis 的环境执行（CI 未加 redis service —— 已记录为交接义务）；
 * - 消息丢失/投递失败不影响正确性：`runJobDispatch` 不标记 published_at，重跑即恢复（Outbox 语义）。
 */

export interface MinimalQueue {
  add(name: string, data: unknown, options?: { jobId?: string; removeOnComplete?: boolean; removeOnFail?: boolean }): Promise<unknown>;
  close(): Promise<void>;
}

export interface BullMqOptions {
  redisUrl: string;
  /** Redis 键前缀（默认与 BullMQ 默认一致：bull；自定义部署可覆盖） */
  prefix?: string;
  /** 注入式工厂（默认惰性 import('bullmq')） */
  createQueue?: (name: string, connection: { url: string }, prefix: string) => Promise<MinimalQueue> | MinimalQueue;
}

const queues = new WeakMap<BullMqJobQueue, Map<string, MinimalQueue>>();

export class BullMqJobQueue implements JobQueueAdapter {
  readonly kind = 'bullmq';
  private readonly options: BullMqOptions;

  constructor(options: BullMqOptions) {
    if (options.redisUrl.length === 0) throw new Error('BullMqJobQueue 需要 REDIS_URL');
    this.options = options;
    queues.set(this, new Map());
  }

  private async queueFor(name: string): Promise<MinimalQueue> {
    const registry = queues.get(this);
    if (!registry) throw new Error('queue registry missing');
    const existing = registry.get(name);
    if (existing !== undefined) return existing;
    const factory =
      this.options.createQueue ??
      (async (queueName: string, connection: { url: string }, prefix: string) => {
        // 惰性加载：未安装 bullmq 时给出明确错误（不静默降级）
        const moduleName = 'bullmq';
        const bullmq = (await import(moduleName).catch(() => null)) as
          | { Queue?: new (name: string, opts: { connection: { url: string }; prefix: string }) => MinimalQueue }
          | null;
        if (bullmq?.Queue === undefined) {
          throw new Error('bullmq 未安装：请添加依赖或注入 createQueue 工厂（真实 Redis 环境）');
        }
        return new bullmq.Queue(queueName, { connection, prefix });
      });
    const created = await factory(name, { url: this.options.redisUrl }, this.options.prefix ?? 'bull');
    registry.set(name, created);
    return created;
  }

  /** 只投递 { jobId, queue, attempt }；jobId 作为 BullMQ 任务 ID（天然去重）。 */
  async enqueue(message: JobQueueMessage): Promise<void> {
    const parsed = jobQueueMessageSchema.parse(message);
    const queue = await this.queueFor(parsed.queue);
    await queue.add(parsed.queue, parsed, {
      jobId: `${parsed.jobId}:${String(parsed.attempt)}`,
      removeOnComplete: true,
      removeOnFail: false,
    });
  }

  async close(): Promise<void> {
    const registry = queues.get(this);
    if (!registry) return;
    for (const queue of registry.values()) {
      await queue.close().catch(() => undefined);
    }
    registry.clear();
  }
}
