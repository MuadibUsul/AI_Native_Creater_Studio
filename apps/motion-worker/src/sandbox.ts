import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { analyzeMotionCode, type MotionAnalysisIssue } from './analysis.js';

/**
 * Motion 沙箱宿主（P07-01 / REQ-11-03）。
 *
 * 执行模型（"不能只依赖静态代码检查"，§11.2）：
 *   宿主进程 spawn **隔离子进程**（`sandbox-child.mjs`）：
 *   - 静态分析（第一道门，见 analysis.ts）在宿主与子进程**双重**执行；
 *   - 代码在 `node:vm` 新上下文中评估：上下文仅含白名单全局（无 fetch/require/process/fs）；
 *   - 渲染 smoke：react-dom/server 以固定 fixture 帧渲染（确定性、有界）；
 *   - **CPU/RAM/超时**：子进程 `--max-old-space-size`（RAM 上限）+ 宿主硬超时 **kill**（无限循环防逃逸）；
 *   - 资源上限参数可配置（默认 RAM 256MB / CPU 10s）。
 *
 * OS 级网络隔离（gVisor/容器网络策略）属部署层（计划 §3.1 沙箱选型；P08 落地）——
 * V1 进程内隔离：上下文无任何网络能力 + 静态分析拒绝网络词法。
 */

export interface MotionSandboxInput {
  code: string;
  /** 渲染 smoke 的固定输入（props + 帧） */
  fixture: { props: Record<string, unknown>; frame: number; fps: number; durationInFrames: number; width: number; height: number };
}

export type MotionSandboxVerdict =
  | { verdict: 'REJECTED'; stage: 'STATIC_ANALYSIS'; issues: MotionAnalysisIssue[] }
  | { verdict: 'REJECTED'; stage: 'EVALUATION'; message: string }
  | { verdict: 'REJECTED'; stage: 'RENDER_SMOKE'; message: string }
  | { verdict: 'TIMEOUT'; stage: 'EXECUTION'; timeoutMs: number }
  | { verdict: 'CRASHED'; stage: 'EXECUTION'; message: string }
  | { verdict: 'APPROVED'; stage: 'RENDER_SMOKE'; markupLength: number; renderMs: number };

export interface MotionSandboxLimits {
  /** 子进程最大堆（MB） */
  maxOldSpaceSizeMb: number;
  /** 硬超时（毫秒；超时 kill —— 无限循环攻击的防线） */
  timeoutMs: number;
}

export const DEFAULT_SANDBOX_LIMITS: MotionSandboxLimits = { maxOldSpaceSizeMb: 256, timeoutMs: 10_000 };

const CHILD_SCRIPT = path.resolve(import.meta.dirname, 'sandbox-child.ts');

/** 运行沙箱（宿主侧入口；每次提交一个全新子进程——无跨提交状态）。 */
export async function runMotionSandbox(input: MotionSandboxInput, limits: MotionSandboxLimits = DEFAULT_SANDBOX_LIMITS): Promise<MotionSandboxVerdict> {
  // 第一道门（宿主侧静态分析；子进程会再做一次——双保险）
  const analysis = analyzeMotionCode(input.code);
  if (!analysis.ok) {
    return { verdict: 'REJECTED', stage: 'STATIC_ANALYSIS', issues: analysis.issues };
  }

  const submissionId = `msb_${randomUUID()}`;
  const child = spawn(
    process.execPath,
    [
      `--max-old-space-size=${String(limits.maxOldSpaceSizeMb)}`,
      '--no-warnings',
      CHILD_SCRIPT,
      submissionId,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } },
  );

  return new Promise<MotionSandboxVerdict>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ verdict: 'TIMEOUT', stage: 'EXECUTION', timeoutMs: limits.timeoutMs });
    }, limits.timeoutMs);

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
      resolve({ verdict: 'CRASHED', stage: 'EXECUTION', message: `子进程启动失败：${error.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lastLine = stdout.trim().split(String.fromCharCode(10)).at(-1) ?? '';
      try {
        const parsed = JSON.parse(lastLine) as MotionSandboxVerdict & { submissionId?: string };
        // 防伪造：校验回执 ID（子进程回显提交 ID）
        if (parsed.submissionId !== submissionId) {
          resolve({ verdict: 'CRASHED', stage: 'EXECUTION', message: '沙箱回执校验失败（回执 ID 不匹配）' });
          return;
        }
        const { submissionId: _ignored, ...verdict } = parsed;
        void _ignored;
        resolve(verdict);
      } catch {
        resolve({
          verdict: 'CRASHED',
          stage: 'EXECUTION',
          message: `子进程异常退出（code=${String(code)}）：${stderr.slice(-400) || '无 stderr'}`,
        });
      }
    });

    child.stdin.write(`${JSON.stringify({ submissionId, code: input.code, fixture: input.fixture })}\n`);
    child.stdin.end();
  });
}
