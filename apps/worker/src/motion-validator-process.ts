import { spawn } from 'node:child_process';
import { accessSync } from 'node:fs';
import path from 'node:path';
import { motionValidationReportSchema, type MotionValidator, type MotionValidationReport } from '@ancs/contracts';

/**
 * 进程隔离的 Motion 验证器（P07-02 生产装配；与渲染执行器同一范式）。
 *
 * Worker 进程 spawn `apps/motion-worker/src/run-validate.ts`：
 * - 验证（含沙箱子进程）与任务进程隔离：验证崩溃不影响 Worker（任务租约回收可续跑）；
 * - 协议：stdin JSON `{ code, name, fixture, sampleFrames }` → stdout 一行 report JSON；
 * - 命令可经 `ANCS_MOTION_VALIDATOR_CMD` 覆盖（部署差异，P08-01）；默认按仓库根定位脚本。
 */

export interface ProcessMotionValidatorOptions {
  command?: string[];
  /** 硬超时（毫秒；沙箱自身亦有超时——这里是宿主侧的最后防线） */
  timeoutMs?: number;
  cwd?: string;
}

export const DEFAULT_MOTION_VALIDATOR_TIMEOUT_MS = 3 * 60 * 1000;

export function findRepoRootForMotion(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      accessSync(path.join(current, 'pnpm-workspace.yaml'));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}

export function resolveDefaultMotionValidatorCommand(): string[] {
  const fromEnv = process.env['ANCS_MOTION_VALIDATOR_CMD'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv.trim().split(/\s+/);
  }
  const repoRoot = findRepoRootForMotion(import.meta.dirname);
  if (repoRoot === null) {
    throw new Error('无法定位仓库根（pnpm-workspace.yaml）：请以 ANCS_MOTION_VALIDATOR_CMD 显式配置验证器命令');
  }
  return [process.execPath, '--no-warnings', path.join(repoRoot, 'apps', 'motion-worker', 'src', 'run-validate.ts')];
}

export function createProcessMotionValidator(options: ProcessMotionValidatorOptions = {}): MotionValidator {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MOTION_VALIDATOR_TIMEOUT_MS;
  return {
    kind: 'motion-worker-subprocess',
    async validate(input): Promise<MotionValidationReport> {
      const command = options.command ?? resolveDefaultMotionValidatorCommand();
      const executable = command[0];
      if (executable === undefined) throw new Error('Motion 验证器命令为空');
      const cwd = options.cwd ?? findRepoRootForMotion(import.meta.dirname) ?? process.cwd();

      const child = spawn(executable, command.slice(1), { cwd, env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`Motion 验证器超时（${String(timeoutMs)}ms）：已终止子进程`));
        }, timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Motion 验证器启动失败：${error.message}`));
        });
        child.on('close', (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, signal });
        });
        child.stdin.write(`${JSON.stringify(input)}\n`);
        child.stdin.end();
      });

      const lastLine = stdout.trim().split('\n').at(-1) ?? '';
      if (exit.code !== 0 || lastLine === '') {
        throw new Error(`Motion 验证器失败（code=${String(exit.code)} signal=${String(exit.signal)}）：${stderr.trim().slice(-400) || '无 stderr'}`);
      }
      return motionValidationReportSchema.parse(JSON.parse(lastLine));
    },
  };
}
