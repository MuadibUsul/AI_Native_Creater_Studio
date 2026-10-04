import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { accessSync } from 'node:fs';
import path from 'node:path';
import {
  renderExecutionResultSchema,
  type RenderExecutionResult,
  type RenderExecutor,
} from '@ancs/contracts';

/**
 * 进程隔离的渲染执行器（P07-04 生产装配）。
 *
 * Worker 进程 spawn `apps/render-worker/src/run-render.ts`（Node 24 原生 TS 直跑）：
 * - 渲染进程与任务进程隔离：浏览器/编码器崩溃不影响 Worker（任务租约回收可续跑一次）；
 * - 协议：`<workDir>/spec.json` + `<workDir>/assets/` 进，`<workDir>/out/*`（含 result.json）出；
 * - 命令可经 `ANCS_RENDER_EXECUTOR_CMD` 覆盖（部署差异，P08-01）；默认按仓库根定位脚本。
 */

export interface ProcessRenderExecutorOptions {
  /** 命令（argv；[0] 为可执行文件）。缺省：process.execPath + 仓库内 run-render.ts */
  command?: string[];
  /** 硬超时（毫秒；超时 SIGKILL 并失败——渲染不得无限挂起） */
  timeoutMs?: number;
  /** 子进程工作目录（缺省 = 仓库根） */
  cwd?: string;
}

export const DEFAULT_RENDER_EXECUTOR_TIMEOUT_MS = 30 * 60 * 1000;

/** 仓库根定位（pnpm-workspace.yaml 上溯；dist 构建产物与 src 直跑均可工作）。 */
export function findRepoRoot(startDir: string): string | null {
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

export function resolveDefaultRenderExecutorCommand(): string[] {
  const fromEnv = process.env['ANCS_RENDER_EXECUTOR_CMD'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv.trim().split(/\s+/);
  }
  const repoRoot = findRepoRoot(import.meta.dirname);
  if (repoRoot === null) {
    throw new Error('无法定位仓库根（pnpm-workspace.yaml）：请以 ANCS_RENDER_EXECUTOR_CMD 显式配置渲染执行器命令');
  }
  return [process.execPath, '--no-warnings', path.join(repoRoot, 'apps', 'render-worker', 'src', 'run-render.ts')];
}

export function createProcessRenderExecutor(options: ProcessRenderExecutorOptions = {}): RenderExecutor {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_EXECUTOR_TIMEOUT_MS;
  return {
    kind: 'remotion-server-subprocess',
    async execute(input): Promise<RenderExecutionResult> {
      const command = options.command ?? resolveDefaultRenderExecutorCommand();
      const executable = command[0];
      if (executable === undefined) throw new Error('渲染执行器命令为空');
      const cwd = options.cwd ?? findRepoRoot(import.meta.dirname) ?? process.cwd();

      const child = spawn(executable, [...command.slice(1), '--workdir', input.workDir], {
        cwd,
        env: { ...process.env, NODE_OPTIONS: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`渲染执行器超时（${String(timeoutMs)}ms）：已终止子进程`));
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
          reject(new Error(`渲染执行器启动失败：${error.message}`));
        });
        child.on('close', (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, signal, stdout, stderr });
        });
      });

      if (exit.code !== 0) {
        throw new Error(`渲染执行器失败（code=${String(exit.code)} signal=${String(exit.signal)}）：${exit.stderr.trim().split('\n').slice(-4).join(' | ') || '无 stderr'}`);
      }

      // 回执以文件为准（stdout 只作日志）：out/result.json 由执行器原子写出
      const raw = await readFile(path.join(input.workDir, 'out', 'result.json'), 'utf8');
      return renderExecutionResultSchema.parse(JSON.parse(raw));
    },
  };
}
