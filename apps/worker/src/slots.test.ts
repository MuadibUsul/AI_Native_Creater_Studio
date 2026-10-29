import { describe, expect, it } from 'vitest';
import { runJobSlots } from './slots.js';

/** 一个排队的任务源：claim 依次取出，取完返回 null；available() 之前的任务还"没到期" */
function queue(jobs: number[], available: () => boolean = () => true) {
  const pending = [...jobs];
  const claims: number[] = [];
  return {
    claims,
    claim: (): Promise<number | null> => {
      if (!available()) return Promise.resolve(null);
      const next = pending.shift() ?? null;
      if (next !== null) claims.push(next);
      return Promise.resolve(next);
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 记录同时在执行的任务数 */
function tracker(ms: number) {
  let running = 0;
  const done: number[] = [];
  const overlaps: number[] = [];
  return {
    done,
    overlaps,
    execute: async (job: number): Promise<void> => {
      running += 1;
      overlaps.push(running);
      await sleep(ms);
      running -= 1;
      done.push(job);
    },
  };
}

describe('Worker 任务槽（V6-10 S4）', () => {
  it('一个槽：认领一个、执行完、再认领（与原来的串行循环一致）', async () => {
    const source = queue([1, 2, 3]);
    const work = tracker(5);
    const report = await runJobSlots({ slots: 1, pollMs: 1000, claim: source.claim, execute: work.execute, stopping: () => false, untilIdle: true });
    expect(report).toEqual({ executed: 3, peak: 1 });
    expect(work.done).toEqual([1, 2, 3]);
    expect(Math.max(...work.overlaps)).toBe(1);
  });

  it('三个槽：同时执行至多三个；一个结束马上认领下一个，不等轮询周期', async () => {
    const source = queue([1, 2, 3, 4, 5, 6, 7]);
    const work = tracker(40);
    const started = Date.now();
    // 轮询周期设得很长：如果空出的槽要等周期才认领，这里会超过 10 秒
    const report = await runJobSlots({ slots: 3, pollMs: 10_000, claim: source.claim, execute: work.execute, stopping: () => false, untilIdle: true });
    const elapsed = Date.now() - started;
    expect(report).toEqual({ executed: 7, peak: 3 });
    expect(Math.max(...work.overlaps)).toBe(3);
    expect([...work.done].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // 七个 40 ms 的任务，三个槽 → 三波，约 120 ms；串行要 280 ms
    expect(elapsed).toBeLessThan(250);
  });

  it('稍后才到期的任务：下一个轮询周期认领；维护每个周期跑一次，不按认领次数跑', async () => {
    let ready = false;
    const source = queue([1], () => ready);
    const work = tracker(1);
    let maintained = 0;
    let stop = false;
    setTimeout(() => {
      ready = true;
    }, 30);
    const run = runJobSlots({
      slots: 2,
      pollMs: 20,
      claim: source.claim,
      execute: async (job) => {
        await work.execute(job);
        stop = true;
      },
      maintain: () => {
        maintained += 1;
        return Promise.resolve();
      },
      stopping: () => stop,
    });
    const report = await run;
    expect(report.executed).toBe(1);
    expect(maintained).toBeGreaterThanOrEqual(2);
    expect(maintained).toBeLessThanOrEqual(4);
  });

  it('停下：不再认领，进行中的任务做完才返回', async () => {
    const source = queue([1, 2, 3, 4, 5]);
    const work = tracker(30);
    let stop = false;
    setTimeout(() => {
      stop = true;
    }, 10);
    const report = await runJobSlots({ slots: 2, pollMs: 5, claim: source.claim, execute: work.execute, stopping: () => stop });
    expect(source.claims).toEqual([1, 2]);
    expect(work.done.sort()).toEqual([1, 2]);
    expect(report.executed).toBe(2);
  });

  it('执行器抛错：不再认领，等其余任务做完再抛出', async () => {
    const source = queue([1, 2, 3, 4]);
    const work = tracker(30);
    const run = runJobSlots({
      slots: 2,
      pollMs: 5,
      claim: source.claim,
      execute: async (job) => {
        if (job === 1) throw new Error('executor broke');
        await work.execute(job);
      },
      stopping: () => false,
    });
    await expect(run).rejects.toThrow('executor broke');
    expect(source.claims).toEqual([1, 2]);
    expect(work.done).toEqual([2]);
  });

  it('认领出错：等进行中的任务做完再抛出（不在它们写库时关连接）', async () => {
    let calls = 0;
    const work = tracker(30);
    const run = runJobSlots({
      slots: 2,
      pollMs: 5,
      claim: () => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error('database gone'));
        return Promise.resolve(calls);
      },
      execute: work.execute,
      stopping: () => false,
    });
    await expect(run).rejects.toThrow('database gone');
    expect(work.done).toEqual([1]);
  });

  it('一次性运行（limit 1 + untilIdle）：只执行一个；没有任务时直接返回', async () => {
    const source = queue([1, 2]);
    const work = tracker(1);
    expect(await runJobSlots({ slots: 1, pollMs: 1000, claim: source.claim, execute: work.execute, stopping: () => false, limit: 1, untilIdle: true })).toEqual({ executed: 1, peak: 1 });
    expect(source.claims).toEqual([1]);
    const empty = queue([]);
    expect(await runJobSlots({ slots: 1, pollMs: 1000, claim: empty.claim, execute: work.execute, stopping: () => false, limit: 1, untilIdle: true })).toEqual({ executed: 0, peak: 0 });
  });

  it('槽数必须是正整数', async () => {
    await expect(runJobSlots({ slots: 0, pollMs: 5, claim: () => Promise.resolve(null), execute: () => Promise.resolve(), stopping: () => true })).rejects.toThrow('positive integer');
  });
});
