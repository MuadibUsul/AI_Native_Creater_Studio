import { RENDER_QA_JOB_TYPE, type RenderMediaProbe } from '@ancs/contracts';
import { ApiFailure } from '@ancs/contracts';
import { failJob, runRenderQa, type DomainDeps } from '@ancs/domain';
import type { JobHandler } from './handlers.js';

/**
 * Final QA 任务处理器（P07-05 / §86）。
 *
 * 路径：任务（RENDER_QA，渲染完成后自动入队）→ `runRenderQa`（冻结快照内容检查 + 产物字节独立复核）
 *   → 落库报告（append-only）→ PASS：Render=READY（等待人工批准 §87）/ FAIL：Render=FAILED（QA_FAILED）。
 * - 媒体探测注入（生产 = 进程隔离 CLI；测试可直接用同进程实现）——处理器不 import 渲染栈（R1/R8）；
 * - 明确错误（不在 QA 状态/产物缺失）→ 任务 FAILED_FINAL（不自动重试）；基础设施错误向上抛出（按尝试次数重试）。
 */

export interface RenderQaHandlerOptions {
  probe: RenderMediaProbe;
}

export function createRenderQaHandler(options: RenderQaHandlerOptions): JobHandler {
  return {
    type: RENDER_QA_JOB_TYPE,
    description: 'Final QA（内容检查 + 产物独立复核 → READY/FAILED；报告落库）',
    async handle(deps: DomainDeps, rawInput, context) {
      const renderId = rawInput['renderId'];
      if (typeof renderId !== 'string' || renderId === '') {
        throw new Error('RENDER_QA 任务输入缺少 renderId');
      }
      try {
        const { report, render } = await runRenderQa(deps, {
          workspaceId: context.workspaceId,
          renderId,
          probe: options.probe,
        });
        return {
          renderId,
          status: render.status,
          verdict: report.verdict,
          blockersFailed: report.summary.blockersFailed,
          warningsFailed: report.summary.warningsFailed,
          skipped: report.summary.skipped,
          failedChecks: report.checks.filter((check) => check.status === 'FAIL').map((check) => ({ id: check.id, severity: check.severity, message: check.message })),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ApiFailure) {
          await failJob(deps, {
            workspaceId: context.workspaceId,
            jobId: context.jobId,
            error: { reason: 'RENDER_QA_FAILED', renderId, message, details: error.details },
            retryable: false,
          }).catch(() => undefined);
          return { renderId, failed: true, message };
        }
        throw error;
      }
    },
  };
}
