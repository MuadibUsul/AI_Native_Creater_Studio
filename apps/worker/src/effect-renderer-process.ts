import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentEffectRenderer, SourceMediaProbe } from '@ancs/contracts';
import { MEDIA_CHILD_ENV, childProcessEnv } from './child-env.js';
import { findRepoRoot } from './render-executor-process.js';

/**
 * 进程隔离的特效图层渲染器（V6-3；与渲染执行器、Motion 验证器同一范式）。
 *
 * - Worker spawn `apps/render-worker/src/run-effect.ts`：`<workDir>/effect.json` 进，`<workDir>/out/{layer.mov,poster.png}` 出；
 * - 子进程环境走白名单（只有平台启动项 + Remotion 浏览器 / FFmpeg 路径；没有数据库、密钥、Provider Key）；
 *   特效代码在子进程的无头浏览器页面里执行，页面的网络/存储/DOM 能力被遮蔽（EffectLayer.tsx）；
 * - 输出经真实媒体探测（同一 FFmpeg 探测器）后才交回：时长、流、alpha 像素格式以探测为准；
 * - 硬超时后 SIGKILL；命令可经 `ANCS_EFFECT_RENDER_CMD` 覆盖。
 */

export interface ProcessEffectRendererOptions {
  probe: SourceMediaProbe;
  command?: string[];
  timeoutMs?: number;
  cwd?: string;
}

export const DEFAULT_EFFECT_RENDER_TIMEOUT_MS = 3 * 60 * 1000;

export function resolveDefaultEffectRenderCommand(override?: string): string[] {
  if (override !== undefined && override.trim() !== '') return override.trim().split(/\s+/);
  const repoRoot = findRepoRoot(import.meta.dirname);
  if (repoRoot === null) throw new Error('无法定位仓库根（pnpm-workspace.yaml）：请以 ANCS_EFFECT_RENDER_CMD 显式配置特效渲染命令');
  return [process.execPath, '--no-warnings', path.join(repoRoot, 'apps', 'render-worker', 'src', 'run-effect.ts')];
}

/**
 * 子进程失败时交回的一行错误：子进程自己捕获的错误是一行 JSON（只含错误消息，不含环境信息），取其 message；
 * 未被捕获的异常（如 Remotion 在没配浏览器时去联网下载失败）由 Node 打印堆栈、最后一行是 "Node.js vX"，
 * 这时取抛出的那一行 "XxxError: …"，否则才是最后一行。
 */
export function effectChildError(stderr: string): string {
  const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '').reverse();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const message = (JSON.parse(line) as { message?: unknown }).message;
      if (message !== undefined) return String(message);
    } catch { /* 不是 JSON */ }
  }
  return lines.find((line) => /^[A-Za-z]*Error\b[^:]*:/.test(line)) ?? lines[0] ?? '';
}

export function createProcessEffectRenderer(options: ProcessEffectRendererOptions): AgentEffectRenderer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EFFECT_RENDER_TIMEOUT_MS;
  return {
    implementation: 'REAL',
    async render(request) {
      const command = options.command ?? resolveDefaultEffectRenderCommand();
      const executable = command[0];
      if (executable === undefined) throw new Error('特效渲染命令为空');
      const cwd = options.cwd ?? findRepoRoot(import.meta.dirname) ?? process.cwd();
      const workDir = await mkdtemp(path.join(os.tmpdir(), 'ancs-effect-'));
      try {
        await writeFile(path.join(workDir, 'effect.json'), JSON.stringify(request));
        const child = spawn(executable, [...command.slice(1), '--workdir', workDir], { cwd, env: childProcessEnv(process.env, MEDIA_CHILD_ENV), stdio: ['ignore', 'pipe', 'pipe'] });
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
          let stderr = '';
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            reject(new Error(`特效渲染超时（${String(timeoutMs)}ms）：已终止子进程`));
          }, timeoutMs);
          child.stdout.resume();
          child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
          child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`特效渲染启动失败：${error.message}`));
          });
          child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, signal, stderr });
          });
        });
        if (exit.code !== 0) {
          const message = effectChildError(exit.stderr);
          throw new Error(`特效渲染失败：${message.slice(0, 500) || `code=${String(exit.code)} signal=${String(exit.signal)}`}`);
        }
        const file = path.join(workDir, 'out', 'layer.mov');
        const result = JSON.parse(await readFile(path.join(workDir, 'out', 'result.json'), 'utf8')) as { renderMs?: unknown };
        const probe = await options.probe.probe({ filePath: file, declaredMimeType: 'video/quicktime' });
        return {
          video: new Uint8Array(await readFile(file)),
          poster: new Uint8Array(await readFile(path.join(workDir, 'out', 'poster.png'))),
          probe,
          renderMs: typeof result.renderMs === 'number' ? result.renderMs : 0,
        };
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}
