/**
 * 维护调度（I-10）：按时间表运行维护任务——固定间隔（如通知派发）或每天固定的 UTC 时刻（如保留清理）。
 *
 * - 同一任务不重叠：到点时上一轮还在跑，这一轮跳过并记一条 skipped（不排队、不并发）；
 * - 一轮失败只记日志，下一次照常排程；
 * - 间隔任务启动时先跑一次，每天的任务等到下一个该时刻；
 * - stop()：不再排程，并等正在跑的那一轮结束。
 */

export type Schedule = { everyMs: number } | { dailyUtc: string };

export interface ScheduledJob {
  name: string;
  schedule: Schedule;
  run: () => Promise<void>;
}

export interface SchedulerEvent {
  job: string;
  event: 'scheduled' | 'start' | 'done' | 'failed' | 'skipped';
  at: string;
  ms?: number;
  error?: string;
  nextAt?: string;
}

/** 距下一个 HH:MM（UTC）还有多少毫秒；正好在该时刻时算到明天。 */
export function msUntilNextDailyUtc(now: Date, hhmm: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (match === null) throw new Error(`daily time must be HH:MM (UTC): ${hhmm}`);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(match[1]), Number(match[2])));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export interface Scheduler {
  start(): void;
  stop(): Promise<void>;
}

export function createScheduler(jobs: readonly ScheduledJob[], log: (event: SchedulerEvent) => void = () => undefined): Scheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Map<string, Promise<void>>();
  let stopped = false;

  const delayFor = (job: ScheduledJob): number => ('everyMs' in job.schedule ? job.schedule.everyMs : msUntilNextDailyUtc(new Date(), job.schedule.dailyUtc));

  const schedule = (job: ScheduledJob, delay: number): void => {
    if (stopped) return;
    timers.set(job.name, setTimeout(() => fire(job), delay));
    log({ job: job.name, event: 'scheduled', at: new Date().toISOString(), nextAt: new Date(Date.now() + delay).toISOString() });
  };

  const fire = (job: ScheduledJob): void => {
    if (stopped) return;
    schedule(job, delayFor(job));
    if (running.has(job.name)) {
      log({ job: job.name, event: 'skipped', at: new Date().toISOString() });
      return;
    }
    const started = Date.now();
    log({ job: job.name, event: 'start', at: new Date(started).toISOString() });
    const run = job.run().then(
      () => { log({ job: job.name, event: 'done', at: new Date().toISOString(), ms: Date.now() - started }); },
      (error: unknown) => { log({ job: job.name, event: 'failed', at: new Date().toISOString(), ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) }); },
    ).finally(() => { running.delete(job.name); });
    running.set(job.name, run);
  };

  return {
    start() {
      for (const job of jobs) {
        if ('everyMs' in job.schedule) fire(job);
        else schedule(job, delayFor(job));
      }
    },
    async stop() {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.all(running.values());
    },
  };
}
