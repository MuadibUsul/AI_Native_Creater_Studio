import { spawn } from 'node:child_process';
import path from 'node:path';
import { formatEnvFailure, schedulerEnvSchema, validateEnv } from '@ancs/contracts';
import { createScheduler, type SchedulerEvent } from '../scheduler.js';

/**
 * 维护调度器（I-10）：常驻进程，按时间表运行已有的两个维护命令，每次一个子进程：
 *
 *   - 通知派发 event-dispatch.js：每 ANCS_SCHEDULE_DISPATCH_SECONDS 秒（缺省 60），启动时先跑一次；
 *   - 保留清理 retention-sweep.js：每天 ANCS_SCHEDULE_RETENTION_UTC（缺省 03:30 UTC）。
 *
 *   node apps/api/dist/cli/scheduler.js        （编排样例：infra/docker-compose.prod.yml 的 scheduler 服务）
 *
 * 两个命令各自校验数据库与存储配置；子进程继承本进程环境（都是本仓库的受信入口，不运行用户代码）。
 * 同一命令不重叠；一轮失败记日志、下一次照常。SIGTERM / SIGINT：停止排程，等正在跑的一轮结束后退出 0。
 * 多台机器各跑一个调度器也安全（两个命令都可重入），但没有必要。
 */

const envResult = validateEnv(schedulerEnvSchema, process.env);
if (!envResult.ok || envResult.value === null) {
  console.error(formatEnvFailure('scheduler', envResult.issues));
  process.exit(1);
}
const config = envResult.value;

const runCommand = (file: string): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, file)], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  child.on('error', reject);
  child.on('close', (code, signal) => (code === 0 ? resolve() : reject(new Error(`${file} exited with ${signal ?? `code ${String(code)}`}`))));
});

const log = (event: SchedulerEvent): void => {
  if (event.event === 'failed' || event.event === 'skipped') console.error(JSON.stringify({ scheduler: event }));
  else if (event.event !== 'scheduled' || event.job === 'retention-sweep') console.log(JSON.stringify({ scheduler: event }));
};

const scheduler = createScheduler([
  { name: 'event-dispatch', schedule: { everyMs: config.ANCS_SCHEDULE_DISPATCH_SECONDS * 1000 }, run: () => runCommand('event-dispatch.js') },
  { name: 'retention-sweep', schedule: { dailyUtc: config.ANCS_SCHEDULE_RETENTION_UTC }, run: () => runCommand('retention-sweep.js') },
], log);

console.log(JSON.stringify({ scheduler: { event: 'started', dispatchEverySeconds: config.ANCS_SCHEDULE_DISPATCH_SECONDS, retentionDailyUtc: config.ANCS_SCHEDULE_RETENTION_UTC } }));
scheduler.start();

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ scheduler: { event: 'stopping', signal } }));
  void scheduler.stop().then(() => {
    console.log(JSON.stringify({ scheduler: { event: 'stopped' } }));
    process.exit(0);
  });
};
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
