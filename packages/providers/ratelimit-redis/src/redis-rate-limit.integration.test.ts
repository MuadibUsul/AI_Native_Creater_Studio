import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisRateLimitStore } from './index.js';

/**
 * 对真实 Redis 的共享限流验收（CI 由 workflow 的 redis service 提供，环境变量 ANCS_TEST_REDIS_URL）：
 * 两个存储实例相当于两台 API，共用同一份额度；补充速率与过期如实生效；Redis 不可达时调用失败（交给调用方退回）。
 */
const redisUrl = process.env['ANCS_TEST_REDIS_URL'] ?? 'redis://127.0.0.1:56379';
const prefix = `ancs:test:${randomUUID()}:`;
let first: RedisRateLimitStore;
let second: RedisRateLimitStore;

beforeAll(async () => {
  first = new RedisRateLimitStore({ url: redisUrl, keyPrefix: prefix });
  second = new RedisRateLimitStore({ url: redisUrl, keyPrefix: prefix });
  if (!(await first.ping().catch(() => false))) throw new Error(`无法连接测试 Redis ${redisUrl}，请启动本地 Redis 或设置 ANCS_TEST_REDIS_URL。`);
});
afterAll(async () => {
  await first.close();
  await second.close();
});

describe('Redis 共享限流', () => {
  it('两台 API 共用同一份额度：容量用完后另一台也被拒，并给出等待秒数', async () => {
    const rule = { capacity: 3, perMinute: 6 };
    expect(await first.take('auth:1.2.3.4', rule)).toEqual({ allowed: true });
    expect(await second.take('auth:1.2.3.4', rule)).toEqual({ allowed: true });
    expect(await first.take('auth:1.2.3.4', rule)).toEqual({ allowed: true });
    const denied = await second.take('auth:1.2.3.4', rule);
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(await first.take('auth:5.6.7.8', rule)).toEqual({ allowed: true });
  });

  it('按 Redis 服务器时间补充令牌；桶在装满所需时间后过期', async () => {
    const rule = { capacity: 1, perMinute: 60_000 };
    expect(await first.take('read:refill', rule)).toEqual({ allowed: true });
    await new Promise((done) => setTimeout(done, 20));
    expect(await second.take('read:refill', rule)).toEqual({ allowed: true });
    const probe = new Redis(redisUrl);
    try {
      const ttl = await probe.pttl(`${prefix}read:refill`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(1001);
    } finally {
      probe.disconnect();
    }
  });

  it('Redis 不可达：取令牌失败（不静默放行），由 API 退回本进程限流', async () => {
    const down = new RedisRateLimitStore({ url: 'redis://127.0.0.1:1', keyPrefix: prefix, commandTimeoutMs: 200 });
    try {
      await expect(down.take('write:x', { capacity: 5, perMinute: 5 })).rejects.toThrow();
      expect(await down.ping().catch(() => false)).toBe(false);
    } finally {
      await down.close();
    }
  });
});
