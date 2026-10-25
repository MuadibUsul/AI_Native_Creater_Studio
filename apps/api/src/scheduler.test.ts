import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduler, msUntilNextDailyUtc, type SchedulerEvent } from './scheduler.js';

/** 维护调度（I-10）：时间表、不重叠、失败后照常排程、停止时等正在跑的一轮。 */

describe('msUntilNextDailyUtc', () => {
  it('今天还没到 → 今天；已过或正好在该时刻 → 明天；跨月', () => {
    expect(msUntilNextDailyUtc(new Date('2026-10-25T01:00:00Z'), '03:30')).toBe(2.5 * 3_600_000);
    expect(msUntilNextDailyUtc(new Date('2026-10-25T04:00:00Z'), '03:30')).toBe(23.5 * 3_600_000);
    expect(msUntilNextDailyUtc(new Date('2026-10-25T03:30:00Z'), '03:30')).toBe(24 * 3_600_000);
    expect(msUntilNextDailyUtc(new Date('2026-10-31T23:59:00Z'), '00:00')).toBe(60_000);
  });

  it('格式不对就报错', () => {
    expect(() => msUntilNextDailyUtc(new Date(), '3:30')).toThrow('HH:MM');
    expect(() => msUntilNextDailyUtc(new Date(), '24:00')).toThrow('HH:MM');
  });
});

describe('createScheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T03:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('间隔任务启动即跑一次，之后每隔一段跑一次', async () => {
    const run = vi.fn(() => Promise.resolve());
    const scheduler = createScheduler([{ name: 'dispatch', schedule: { everyMs: 60_000 }, run }]);
    scheduler.start();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(4);
    await scheduler.stop();
  });

  it('每天的任务等到该 UTC 时刻，之后每 24 小时', async () => {
    const run = vi.fn(() => Promise.resolve());
    const scheduler = createScheduler([{ name: 'retention', schedule: { dailyUtc: '03:30' }, run }]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(new Date().toISOString()).toBe('2026-10-25T03:30:00.000Z');
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(run).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('上一轮没跑完时到点：跳过这一轮，不并发', async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const events: SchedulerEvent[] = [];
    const scheduler = createScheduler([{ name: 'dispatch', schedule: { everyMs: 60_000 }, run }], (event) => events.push(event));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(130_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.event === 'skipped')).toHaveLength(2);
    release();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await scheduler.stop();
  });

  it('一轮失败只记日志，下一次照常跑', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('database is down')).mockResolvedValue(undefined);
    const events: SchedulerEvent[] = [];
    const scheduler = createScheduler([{ name: 'dispatch', schedule: { everyMs: 60_000 }, run }], (event) => events.push(event));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContainEqual(expect.objectContaining({ job: 'dispatch', event: 'failed', error: 'database is down' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ job: 'dispatch', event: 'done' });
    await scheduler.stop();
  });

  it('stop：不再排程，并等正在跑的一轮结束', async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const scheduler = createScheduler([{ name: 'dispatch', schedule: { everyMs: 60_000 }, run }]);
    scheduler.start();
    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
