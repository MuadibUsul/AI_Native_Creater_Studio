/**
 * Worker 任务槽（V6-10 S4）：同一个 Worker 同时执行至多 `slots` 个任务。
 *
 * - 有空槽就认领；认领不到就等，直到下一个轮询周期，或某个任务结束空出一个槽；
 * - 维护（租约回收、重试推进、派发）每个周期跑一次，不占槽；
 * - 停下后不再认领，等进行中的任务结束再返回；
 * - 执行器本身抛错（不是任务失败，任务失败由执行器写进任务状态）：不再认领，等其余任务结束后抛出，
 *   进程以非零退出，与原来的串行循环相同。
 *
 * `slots = 1` 时与原来的串行循环一致：认领一个、执行完、再认领。
 */
export interface JobSlotOptions<J> {
  slots: number;
  /** 认领不到任务时多久再试一次；也是维护的周期 */
  pollMs: number;
  claim: () => Promise<J | null>;
  execute: (job: J) => Promise<unknown>;
  maintain?: () => Promise<void>;
  stopping: () => boolean;
  /** 最多认领几个任务（一次性运行用 1）；认领满后等进行中的任务结束就返回 */
  limit?: number;
  /** 认领不到任务、也没有进行中的任务时返回（一次性运行用），否则一直轮询到停下 */
  untilIdle?: boolean;
}

export interface JobSlotReport {
  executed: number;
  /** 同时在执行的任务数的峰值 */
  peak: number;
}

export async function runJobSlots<J>(options: JobSlotOptions<J>): Promise<JobSlotReport> {
  if (!Number.isInteger(options.slots) || options.slots < 1) throw new Error(`slots must be a positive integer, got ${String(options.slots)}`);
  const inFlight = new Set<Promise<void>>();
  let claimed = 0;
  let executed = 0;
  let peak = 0;
  let failure: { error: unknown } | null = null;
  let maintainedAt = Number.NEGATIVE_INFINITY;
  const exhausted = (): boolean => options.limit !== undefined && claimed >= options.limit;

  while (!options.stopping() && failure === null) {
    let empty = false;
    try {
      if (options.maintain !== undefined && Date.now() - maintainedAt >= options.pollMs) {
        maintainedAt = Date.now();
        await options.maintain();
      }
      while (inFlight.size < options.slots && !exhausted() && !options.stopping() && failure === null) {
        const job = await options.claim();
        if (job === null) {
          empty = true;
          break;
        }
        claimed += 1;
        const running: Promise<void> = options
          .execute(job)
          .then(
            () => {
              executed += 1;
            },
            (error: unknown) => {
              failure ??= { error };
            },
          )
          .finally(() => {
            inFlight.delete(running);
          });
        inFlight.add(running);
        peak = Math.max(peak, inFlight.size);
      }
    } catch (error) {
      // 认领或维护出错：同样先等进行中的任务结束再抛出，不在它们还在写库时关掉连接
      failure ??= { error };
      break;
    }
    if (inFlight.size === 0 && (exhausted() || (options.untilIdle === true && empty))) break;
    await nextWake(options.pollMs, inFlight);
  }

  await Promise.all(inFlight);
  if (failure !== null) throw (failure as { error: unknown }).error;
  return { executed, peak };
}

/** 等到下一个周期，或任一进行中的任务结束 */
async function nextWake(ms: number, inFlight: ReadonlySet<Promise<void>>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([tick, ...inFlight]);
  } finally {
    clearTimeout(timer);
  }
}
