import { CUSTOM_MOTION_ERROR_REASONS, MOTION_GENERATE_JOB_TYPE, type MotionValidator } from '@ancs/contracts';
import { ApiFailure, ERROR_CODES } from '@ancs/contracts';
import { failJob, runCustomMotionGeneration, type DomainDeps } from '@ancs/domain';
import type { JobHandler } from './handlers.js';

/**
 * Motion 生成任务处理器（P07-02 / §11.2）。
 *
 * 路径：任务（MOTION_GENERATE）→ `runCustomMotionGeneration`（LLM → 四道门禁 → 仅通过时版本化落库）。
 * - 验证器注入（生产 = 进程隔离 CLI；测试可直接用同进程实现）——处理器不 import 验证栈（架构 R1/R8）；
 * - **门禁拒绝 → 任务 FAILED_FINAL**（确定性结果：不自动重试；用户可再次发起生成——LLM 输出会变化）；
 * - 基础设施错误（LLM 上游失败/验证器崩溃）→ 抛出 → 执行器按尝试次数判定可重试性；
 * - "失败不能进入项目"由服务层保证：拒绝路径不产生任何行/对象。
 */

export interface MotionGenerationHandlerOptions {
  validator: MotionValidator;
}

export function createMotionGenerationHandler(options: MotionGenerationHandlerOptions): JobHandler {
  return {
    type: MOTION_GENERATE_JOB_TYPE,
    description: 'Custom Motion 生成（LLM → 静态分析/类型检查/沙箱评估/抽帧 → 仅通过时版本化落库）',
    async handle(deps: DomainDeps, rawInput, context) {
      const sceneId = rawInput['sceneId'];
      const projectId = rawInput['projectId'];
      if (typeof sceneId !== 'string' || sceneId === '' || typeof projectId !== 'string' || projectId === '') {
        throw new Error('MOTION_GENERATE 任务输入缺少 sceneId/projectId');
      }
      const brief = typeof rawInput['brief'] === 'string' ? (rawInput['brief'] as string) : null;
      try {
        const outcome = await runCustomMotionGeneration(deps, {
          workspaceId: context.workspaceId,
          projectId,
          sceneId,
          brief,
          validator: options.validator,
          createdBy: typeof rawInput['requestedBy'] === 'string' ? (rawInput['requestedBy'] as string) : null,
        });
        return { ...outcome, validationGate: 'APPROVED' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = error instanceof ApiFailure ? String((error.details as Record<string, unknown>)['reason'] ?? 'ERROR') : 'ERROR';
        // 门禁拒绝 = 确定性失败（FAILED_FINAL）；其余基础设施错误向上抛出（执行器按可重试性判定）
        if (reason === CUSTOM_MOTION_ERROR_REASONS.VALIDATION_REJECTED) {
          await failJob(deps, {
            workspaceId: context.workspaceId,
            jobId: context.jobId,
            error: { reason, sceneId, message, report: (error as ApiFailure).details['report'] ?? null },
            retryable: false,
          }).catch(() => undefined);
          return { sceneId, validationGate: 'REJECTED', message };
        }
        if (error instanceof ApiFailure && error.httpStatus < 500 && error.code !== ERROR_CODES.INTERNAL) {
          // 输入/依赖类明确错误（场景不存在、依赖越界、LLM 输出不可解析等）→ 不可重试
          await failJob(deps, {
            workspaceId: context.workspaceId,
            jobId: context.jobId,
            error: { reason, sceneId, message },
            retryable: false,
          }).catch(() => undefined);
          return { sceneId, failed: true, reason, message };
        }
        throw error;
      }
    },
  };
}
