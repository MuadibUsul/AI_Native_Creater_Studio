import { describe, expect, it, vi } from 'vitest';
import { readinessResponseSchema } from '@ancs/contracts';
import { buildServer } from './server.js';
import { createShutdown } from './shutdown.js';

/** 生产部署：就绪探针（依赖检查、超时、排空）与优雅退出顺序。 */
describe('就绪探针', () => {
  it('依赖都可用 → 200 ready；/health 只看存活', async () => {
    const app = await buildServer({ readiness: { checks: { database: async () => true } } });
    const ready = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(ready.statusCode).toBe(200);
    expect(readinessResponseSchema.parse(ready.json())).toEqual({ status: 'ready', service: 'ancs-api', draining: false, checks: { database: 'ok' } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    await app.close();
  });

  it('数据库报错 / 返回不可用 / 超时 → 503，不带错误细节', async () => {
    const app = await buildServer({
      readiness: {
        timeoutMs: 50,
        checks: {
          database: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'); },
          storage: async () => false,
          queue: () => new Promise<boolean>(() => undefined),
        },
      },
    });
    const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', service: 'ancs-api', draining: false, checks: { database: 'error', storage: 'error', queue: 'timeout' } });
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('10.0.0.5');
    await app.close();
  });

  it('退出排空中 → 503（依赖正常也一样），存活检查不受影响', async () => {
    let draining = false;
    const app = await buildServer({ readiness: { checks: { database: async () => true }, draining: () => draining } });
    draining = true;
    const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'not_ready', draining: true, checks: { database: 'ok' } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('优雅退出', () => {
  it('排空 → 等待 → 停止接新请求 → 释放资源 → 退出码 0；重复信号只执行一次', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const lifecycle = createShutdown({
      drainMs: 5000, timeoutMs: 60_000,
      sleep: async (ms) => { order.push(`sleep ${String(ms)}`); },
      closeServer: async () => { order.push('closeServer'); },
      closeResources: async () => { order.push('closeResources'); },
      exit, log: () => undefined,
    });
    expect(lifecycle.isDraining()).toBe(false);
    const first = lifecycle.shutdown('SIGTERM');
    expect(lifecycle.isDraining()).toBe(true);
    const second = lifecycle.shutdown('SIGINT');
    await Promise.all([first, second]);
    expect(order).toEqual(['sleep 5000', 'closeServer', 'closeResources']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('关闭出错 → 退出码 1；卡住超过上限 → 强制退出码 1', async () => {
    const failed = vi.fn();
    await createShutdown({ drainMs: 0, timeoutMs: 60_000, closeServer: async () => { throw new Error('boom'); }, closeResources: async () => undefined, exit: failed, log: () => undefined }).shutdown('SIGTERM');
    expect(failed).toHaveBeenCalledWith(1);

    vi.useFakeTimers();
    try {
      const stuck = vi.fn();
      void createShutdown({ drainMs: 0, timeoutMs: 1000, closeServer: () => new Promise<void>(() => undefined), closeResources: async () => undefined, exit: stuck, log: () => undefined }).shutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(1001);
      expect(stuck).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
