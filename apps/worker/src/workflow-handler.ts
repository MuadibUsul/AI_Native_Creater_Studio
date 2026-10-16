import { WORKFLOW_ADVANCE_JOB_TYPE } from '@ancs/contracts';
import { advanceWorkflow, type WorkflowRegistry } from '@ancs/domain';
import type { JobHandler } from './handlers.js';

/**
 * V5-M4（§11.1）：工作流推进任务处理器。
 *
 * 任务只携带 `runId`；推进者身份 = 任务 ID（引擎比较 `active_job_id`，被替换的任务直接退出、不写入）。
 * 步骤执行期间按任务心跳续租；步骤重试由引擎另起推进任务（带退避），本任务不靠任务级重试重复执行业务步骤。
 */
export interface WorkflowAdvanceHandlerOptions {
  registry: WorkflowRegistry;
  heartbeatIntervalMs?: number;
}

export function createWorkflowAdvanceHandler(options: WorkflowAdvanceHandlerOptions): JobHandler {
  return {
    type: WORKFLOW_ADVANCE_JOB_TYPE,
    description: '工作流推进（运行/步骤持久化；冻结 → 执行 → QA 等长流程）',
    async handle(deps, input, context) {
      const runId = input['runId'];
      if (typeof runId !== 'string' || runId === '') throw new Error('WORKFLOW_ADVANCE 任务输入缺少 runId');
      const result = await advanceWorkflow(deps, options.registry, {
        workspaceId: context.workspaceId,
        runId,
        jobId: context.jobId,
        heartbeat: context.heartbeat,
        ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      });
      return { runId, ...result };
    },
  };
}
