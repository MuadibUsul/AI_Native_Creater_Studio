import { CMS_WRITEBACK_JOB_TYPE } from '@ancs/contracts';
import { executeCmsWritebackAttempt, failJob } from '@ancs/domain';
import type { JobHandler } from './handlers.js';

export const cmsWritebackHandler: JobHandler = {
  type: CMS_WRITEBACK_JOB_TYPE,
  description: 'CMS 签名回写（deliveryId 幂等；尝试与响应只追加）',
  async handle(deps, input, context) {
    const deliveryId = input['deliveryId'];
    if (typeof deliveryId !== 'string' || deliveryId === '') throw new Error('CMS_WRITEBACK 任务输入缺少 deliveryId');
    const result = await executeCmsWritebackAttempt(deps, { workspaceId: context.workspaceId, jobId: context.jobId, deliveryId });
    if (!result.ok) {
      await failJob(deps, {
        workspaceId: context.workspaceId,
        jobId: context.jobId,
        retryable: result.retryable,
        error: { reason: result.reason ?? 'CMS_WRITEBACK_FAILED', deliveryId, attemptId: result.attempt.id },
      });
    }
    return { deliveryId, attemptId: result.attempt.id, status: result.attempt.status };
  },
};
