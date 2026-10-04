import { createHash } from 'node:crypto';
import {
  MOTION_VALIDATION_REPORT_VERSION,
  type MotionValidationFixture,
  type MotionValidationReport,
} from '@ancs/contracts';
import { analyzeMotionCode } from './analysis.ts';
import { runMotionSandbox } from './sandbox.ts';
import { typecheckMotionCode } from './typecheck.ts';
import { MOTION_VALIDATION_LIMITS } from './limits.ts';

/**
 * Motion 四道门禁（P07-02 / 规范 §11.2 安全 MUST 10 条）：
 *   1) 静态分析（词法，宿主+子进程双重）；2) 类型检查（tsc 内存程序，不执行代码）；
 *   3) 沙箱评估（隔离子进程 + vm 白名单上下文 + 硬超时）；4) 抽帧（多帧渲染 smoke，逐帧哈希）。
 *
 * 任一失败 → verdict=REJECTED（**不进入项目**；报告随任务错误返回）。
 * 纪律：报告 sourceSha256 = 被验证代码的 SHA-256——落库前由 domain 复核，杜绝"验 A 存 B"。
 */

export interface ValidateMotionInput {
  code: string;
  name: string;
  fixture: MotionValidationFixture;
  sampleFrames: number[];
}

export async function validateMotion(input: ValidateMotionInput): Promise<MotionValidationReport> {
  const sourceSha256 = createHash('sha256').update(input.code, 'utf8').digest('hex');
  const stages: MotionValidationReport['stages'] = [];
  const warnings: string[] = [];

  // 1) 静态分析（第一道门；沙箱子进程会再做一次——双保险）
  const analysis = analyzeMotionCode(input.code);
  stages.push({
    stage: 'STATIC_ANALYSIS',
    ok: analysis.ok,
    message: analysis.ok ? null : `命中 ${String(analysis.issues.length)} 条危险模式`,
    details: { issues: analysis.issues.slice(0, 20) },
  });
  if (!analysis.ok) {
    return reportRejected(sourceSha256, stages, warnings);
  }

  // 2) 类型检查（编译检查；不执行代码）
  const typecheck = typecheckMotionCode(input.code);
  stages.push({
    stage: 'TYPE_CHECK',
    ok: typecheck.ok,
    message: typecheck.ok ? null : `类型检查未通过（${String(typecheck.diagnostics.length)} 条诊断）`,
    details: { diagnostics: typecheck.diagnostics.slice(0, 20) },
  });
  if (!typecheck.ok) {
    return reportRejected(sourceSha256, stages, warnings);
  }

  // 3) + 4) 沙箱评估 + 多帧抽帧（同一次隔离执行：评估通过才渲染；渲染即抽帧）
  const sandbox = await runMotionSandbox(
    { code: input.code, fixture: { ...input.fixture, frame: input.sampleFrames[0] ?? 0 }, sampleFrames: input.sampleFrames },
    MOTION_VALIDATION_LIMITS,
  );

  if (sandbox.verdict === 'APPROVED') {
    stages.push({
      stage: 'SANDBOX_EVALUATION',
      ok: true,
      message: null,
      details: { globals: 'whitelist-context', sampleFrames: input.sampleFrames },
    });
    stages.push({
      stage: 'FRAME_SAMPLES',
      ok: sandbox.frames.every((frame) => frame.markupLength > 0),
      message: sandbox.frames.some((frame) => frame.markupLength === 0) ? '存在空渲染帧（markup 长度为 0）' : null,
      details: { frames: sandbox.frames.map((frame) => ({ frame: frame.frame, markupLength: frame.markupLength, sha256: frame.sha256 })) },
    });
    const framesOk = sandbox.frames.every((frame) => frame.markupLength > 0);
    if (!framesOk) return reportRejected(sourceSha256, stages, warnings);
    const distinct = new Set(sandbox.frames.map((frame) => frame.sha256));
    if (sandbox.frames.length > 1 && distinct.size === 1) {
      warnings.push('抽帧样本在不同帧的输出完全一致：组件可能未使用 useCurrentFrame 动画（允许，但请确认是否期望静态画面）。');
    }
    return {
      schemaVersion: MOTION_VALIDATION_REPORT_VERSION,
      verdict: 'APPROVED',
      sourceSha256,
      analyzerVersion: MOTION_VALIDATION_LIMITS.analyzerVersion,
      stages,
      frames: sandbox.frames.map((frame) => ({
        frame: frame.frame,
        sha256: frame.sha256,
        markupLength: frame.markupLength,
        markup: frame.markup.length > 20_000 ? frame.markup.slice(0, 20_000) : frame.markup,
        truncated: frame.markup.length > 20_000,
      })),
      renderMs: sandbox.renderMs,
      warnings,
    };
  }

  // 失败路径：映射沙箱结论到阶段报告
  if (sandbox.verdict === 'REJECTED' && sandbox.stage === 'STATIC_ANALYSIS') {
    stages.push({ stage: 'SANDBOX_EVALUATION', ok: false, message: '子进程侧静态分析再次拒绝（双保险命中）', details: { issues: sandbox.issues.slice(0, 20) } });
  } else if (sandbox.verdict === 'REJECTED' && sandbox.stage === 'EVALUATION') {
    stages.push({ stage: 'SANDBOX_EVALUATION', ok: false, message: sandbox.message, details: {} });
  } else if (sandbox.verdict === 'REJECTED' && sandbox.stage === 'RENDER_SMOKE') {
    stages.push({ stage: 'SANDBOX_EVALUATION', ok: true, message: null, details: {} });
    stages.push({ stage: 'FRAME_SAMPLES', ok: false, message: sandbox.message, details: {} });
  } else if (sandbox.verdict === 'TIMEOUT') {
    stages.push({ stage: 'SANDBOX_EVALUATION', ok: false, message: `执行超时（${String(sandbox.timeoutMs)}ms 后被强杀——无限循环防线）`, details: { timeoutMs: sandbox.timeoutMs } });
  } else {
    stages.push({ stage: 'SANDBOX_EVALUATION', ok: false, message: sandbox.message, details: { crashed: true } });
  }
  return reportRejected(sourceSha256, stages, warnings);
}

const reportRejected = (
  sourceSha256: string,
  stages: MotionValidationReport['stages'],
  warnings: string[],
): MotionValidationReport => ({
  schemaVersion: MOTION_VALIDATION_REPORT_VERSION,
  verdict: 'REJECTED',
  sourceSha256,
  analyzerVersion: MOTION_VALIDATION_LIMITS.analyzerVersion,
  stages,
  frames: [],
  renderMs: null,
  warnings,
});

/** RenderExecutor 风格：编排层（domain/worker）消费的统一入口。 */
export function createMotionValidator(): {
  kind: string;
  validate: (input: ValidateMotionInput) => Promise<MotionValidationReport>;
} {
  return { kind: 'motion-worker-inprocess', validate: validateMotion };
}
