import { Redis } from 'ioredis';
import { retryAfterSeconds, type RateLimitDecision, type RateLimitRule, type RateLimitStore } from '@ancs/contracts';

/**
 * Redis 共享限流（多台 API 共用同一份额度）：令牌桶在一个 Lua 脚本里原子完成"补充 → 取一个 → 写回"，
 * 时间取 Redis 服务器时钟（各机器时钟不一致也不影响）；每个桶在装满所需时间后自动过期，不占内存。
 * Redis 出错时调用方决定怎么退（API 退回本进程限流，不放行也不拒绝全部请求）。
 */

const TOKEN_BUCKET_SCRIPT = `
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end
tokens = math.min(capacity, tokens + math.max(0, now - ts) * refill_per_ms)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refill_per_ms) + 1000)
return { allowed, tostring(tokens) }
`;

export interface RedisRateLimitOptions {
  url: string;
  /** 键前缀（多个环境共用一个 Redis 时区分） */
  keyPrefix?: string;
  /** 单次调用的上限（毫秒）；超时按出错处理，交给调用方退回 */
  commandTimeoutMs?: number;
}

export class RedisRateLimitStore implements RateLimitStore {
  readonly kind = 'redis';
  private readonly redis: Redis;
  private readonly prefix: string;

  constructor(options: RedisRateLimitOptions) {
    this.redis = new Redis(options.url, {
      lazyConnect: false,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: options.commandTimeoutMs ?? 200,
    });
    // 连接错误由 take() 的失败体现；这里只防止未处理的 error 事件让进程退出
    this.redis.on('error', () => undefined);
    this.prefix = options.keyPrefix ?? 'ancs:rl:';
  }

  async take(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    const result = await this.redis.eval(TOKEN_BUCKET_SCRIPT, 1, `${this.prefix}${key}`, String(rule.capacity), String(rule.perMinute / 60_000)) as [number, string];
    if (result[0] === 1) return { allowed: true };
    return { allowed: false, retryAfterSeconds: retryAfterSeconds(Number(result[1]), rule) };
  }

  /** 启动自检：等连接就绪（离线队列已关闭，未就绪时的命令会立即失败）再 PING；超时视为不可达 */
  async ping(timeoutMs = 3000): Promise<boolean> {
    if (this.redis.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('redis not ready')); }, timeoutMs);
        const onReady = (): void => { cleanup(); resolve(); };
        const cleanup = (): void => { clearTimeout(timer); this.redis.off('ready', onReady); };
        this.redis.on('ready', onReady);
      });
    }
    return (await this.redis.ping()) === 'PONG';
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
