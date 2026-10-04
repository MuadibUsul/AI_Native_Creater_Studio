import { spawn } from 'node:child_process';
import { accessSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mediaProbeResultSchema, type MediaProbeResult, type RenderMediaProbe } from '@ancs/contracts';

/**
 * 进程隔离的媒体探测（P07-05 QA 生产装配；与渲染执行器/验证器同一范式）。
 *
 * Worker 进程 spawn `apps/render-worker/src/run-probe.ts --file <临时文件>`：
 * 产物字节写入临时文件 → 探测 → 清理；解析器崩溃不影响 Worker。
 * 命令可经 `ANCS_MEDIA_PROBE_CMD` 覆盖（部署差异，P08-01）。
 */

export interface ProcessMediaProbeOptions {
  command?: string[];
  timeoutMs?: number;
  cwd?: string;
}

export const DEFAULT_MEDIA_PROBE_TIMEOUT_MS = 60 * 1000;

export function findRepoRootForProbe(startDir: string): string | null {
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

export function resolveDefaultMediaProbeCommand(): string[] {
  const fromEnv = process.env['ANCS_MEDIA_PROBE_CMD'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv.trim().split(/\s+/);
  }
  const repoRoot = findRepoRootForProbe(import.meta.dirname);
  if (repoRoot === null) {
    throw new Error('无法定位仓库根（pnpm-workspace.yaml）：请以 ANCS_MEDIA_PROBE_CMD 显式配置媒体探测命令');
  }
  return [process.execPath, '--no-warnings', path.join(repoRoot, 'apps', 'render-worker', 'src', 'run-probe.ts')];
}

export function createProcessMediaProbe(options: ProcessMediaProbeOptions = {}): RenderMediaProbe {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEDIA_PROBE_TIMEOUT_MS;
  return {
    kind: 'render-worker-media-probe-subprocess',
    async probe(input): Promise<MediaProbeResult> {
      const command = options.command ?? resolveDefaultMediaProbeCommand();
      const executable = command[0];
      if (executable === undefined) throw new Error('媒体探测命令为空');
      const cwd = options.cwd ?? findRepoRootForProbe(import.meta.dirname) ?? process.cwd();
      const workDir = await mkdtemp(path.join(tmpdir(), 'ancs-probe-'));
      const mediaPath = path.join(workDir, 'artifact.bin');
      try {
        await writeFile(mediaPath, input.bytes);
        const child = spawn(executable, [...command.slice(1), '--file', mediaPath], { cwd, env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            reject(new Error(`媒体探测超时（${String(timeoutMs)}ms）：已终止子进程`));
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
            reject(new Error(`媒体探测启动失败：${error.message}`));
          });
          child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, signal });
          });
        });
        const lastLine = stdout.trim().split('\n').at(-1) ?? '';
        if (exit.code !== 0 || lastLine === '') {
          throw new Error(`媒体探测失败（code=${String(exit.code)} signal=${String(exit.signal)}）：${stderr.trim().slice(-300) || '无 stderr'}`);
        }
        return mediaProbeResultSchema.parse(JSON.parse(lastLine));
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
