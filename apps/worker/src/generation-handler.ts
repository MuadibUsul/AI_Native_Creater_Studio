import { sql } from 'drizzle-orm';
import type { GenerationProvider, ProviderCallback } from '@ancs/contracts';
import { ProviderRateLimitedError, ProviderSubmissionUnknownError } from '@ancs/contracts';
import type { DomainDeps } from '@ancs/domain';
import {
  collectProviderResult,
  registerProviderResultDescriptors,
  registerProviderResultPending,
  resolveCredentialForExecution,
  transitionJob,
} from '@ancs/domain';
import type { JobHandler } from './handlers.js';

/**
 * 生成任务处理器（P03-07）：把**真实/Mock Provider 适配器**接进任务系统，闭环：
 *   RUNNING → 解析凭据（P03-04）→ submit → PROVIDER_QUEUED（submitState=SUBMITTED + 结果登记）
 *     → 回调投递（进程内 processProviderCallback，与 HTTP Webhook **共用同一服务**）
 *       或轮询补偿（getStatus → 终态 → 登记描述符 → collect）
 *     → 回收（P03-06：下载/校验/自有存储/Asset）→ 任务完成（P03-06 内部完成）→ 计费结算。
 *
 * 故障语义（CI 可确定性重现）：
 * - **429（ProviderRateLimitedError）** → 抛给执行器 → FAILED_RETRYABLE + 退避（不终结、不重付费）；
 * - **提交结果未知（ProviderSubmissionUnknownError）** → `needs_reconciliation=true` +
 *   submitState=SUBMISSION_UNKNOWN + 任务 FAILED_RETRYABLE（**不自动重复付费提交**，§5.6）；
 * - **结果永不可得（getStatus UNKNOWN）** → 同"提交结果未知"的对账标记；
 * - **取消失败（cancel_fails）** → 取消钩子返回失败 → 任务保持 CANCEL_REQUESTED 供人工介入。
 */

export const GENERATE_JOB_TYPE = 'GENERATE';

export interface GenerationHandlerDeps {
  /** Provider 适配器注册表（Mock 见 packages/providers/mock-provider；真实见 P06） */
  providers: readonly GenerationProvider[];
  /** 回调投递方式：'inline' = 进程内共用回调服务（CI 默认）；'external' = 由外部（HTTP Webhook/轮询）投递 */
  delivery?: 'inline' | 'external';
  /** inline 模式的最大轮询次数（默认 10；Mock 的慢任务需要更多次） */
  maxInlinePolls?: number;
}

interface GenerationJobInput {
  providerId?: string;
  modelId?: string;
  operation?: string;
  credentialMode?: 'BYOK' | 'PLATFORM_MANAGED';
  inputHash?: string;
  estimatedCredits?: number;
  parameters?: Record<string, unknown>;
  /** 未指定 providerId 时用注册表中的第一个（Mock 场景） */
}

function providerFor(registry: GenerationHandlerDeps, input: GenerationJobInput): GenerationProvider {
  const requested = input.providerId;
  const provider = requested === undefined ? registry.providers[0] : registry.providers.find((candidate) => candidate.providerId === requested);
  if (provider === undefined) throw new Error(`未注册的 Provider 适配器：${requested ?? '(默认)'}`);
  return provider;
}

async function markNeedsReconciliation(
  deps: DomainDeps,
  args: { workspaceId: string; jobId: string; reason: string; providerId: string; attempt: number },
): Promise<void> {
  // 需对账：允许人工/适配器查询上游后再决定（绝不自动重复付费提交）
  await deps.db.execute(
    sql`update jobs set needs_reconciliation = true, submit_state = 'SUBMISSION_UNKNOWN', updated_at = now() where id = ${args.jobId}`,
  );
  await transitionJob(deps, {
    workspaceId: args.workspaceId,
    jobId: args.jobId,
    to: 'FAILED_RETRYABLE',
    error: { reason: args.reason, providerId: args.providerId, attempt: args.attempt, note: '需对账后再决定是否重试' },
    reason: args.reason,
  }).catch(() => undefined);
}

export function createGenerationHandler(options: GenerationHandlerDeps): JobHandler {
  const delivery = options.delivery ?? 'inline';
  return {
    type: GENERATE_JOB_TYPE,
    description: '生成任务（凭据 → Provider 提交 → 结果回收；含 429/未知提交/取消失败等故障语义）',
    async handle(deps, rawInput, context) {
      const input = rawInput as GenerationJobInput;
      const workspaceId = context.workspaceId;
      const jobId = context.jobId;
      const provider = providerFor(options, input);
      const kind = (rawInput['kind'] as string | undefined) ?? 'AI_VIDEO';

      // 1) 凭据（BYOK/Managed 决策在 P03-04；此处仅取用）
      const credential = await resolveCredentialForExecution(deps, { workspaceId, providerId: provider.providerId, kind });
      const secret = credential.secret ?? 'mock-platform-secret'; // 平台托管未配置时用占位（Mock 场景）

      // 2) 提交（429 → 抛出交给执行器进入退避；未知 → 对账标记）
      let submitted;
      try {
        submitted = await provider.submit({
          secret,
          request: {
            workspaceId,
            jobId,
            providerId: provider.providerId,
            modelId: input.modelId ?? 'unknown-model',
            operation: input.operation ?? 'generate',
            inputHash: input.inputHash ?? `job:${jobId}`,
            parameters: input.parameters ?? {},
          },
        });
      } catch (error) {
        if (error instanceof ProviderRateLimitedError) throw error; // 执行器 → FAILED_RETRYABLE + 退避
        if (error instanceof ProviderSubmissionUnknownError) {
          await markNeedsReconciliation(deps, {
            workspaceId,
            jobId,
            reason: 'SUBMISSION_UNKNOWN',
            providerId: provider.providerId,
            attempt: 1,
          });
          return { submitted: false, needsReconciliation: true };
        }
        throw error;
      }

      // 3) PROVIDER_QUEUED + 结果登记（回收链路的前置）
      await registerProviderResultPending(deps, {
        workspaceId,
        jobId,
        providerId: provider.providerId,
        providerJobId: submitted.providerJobId,
        attempt: 1,
      });
      await transitionJob(deps, {
        workspaceId,
        jobId,
        to: 'PROVIDER_QUEUED',
        submitState: 'SUBMITTED',
        stage: 'PROVIDER',
        reason: 'SUBMITTED_TO_PROVIDER',
      });

      // 4) 结果推进：inline = 进程内回调服务（CI 确定性）；external = 由 HTTP Webhook/轮询投递
      if (delivery === 'external') {
        return { submitted: true, providerJobId: submitted.providerJobId, delivery: 'external' };
      }

      // inline：轮询到终态（Mock 无真实等待；真实 Provider 应走回调或 external 轮询）
      const maxPolls = options.maxInlinePolls ?? 10;
      let status = await provider.getStatus({ secret, providerJobId: submitted.providerJobId });
      for (let poll = 1; poll < maxPolls && status.state !== 'SUCCEEDED' && status.state !== 'FAILED' && status.state !== 'UNKNOWN'; poll += 1) {
        await context.heartbeat();
        status = await provider.getStatus({ secret, providerJobId: submitted.providerJobId });
      }
      if (status.state === 'UNKNOWN') {
        await markNeedsReconciliation(deps, {
          workspaceId,
          jobId,
          reason: 'RESULT_UNKNOWN',
          providerId: provider.providerId,
          attempt: 1,
        });
        return { submitted: true, providerJobId: submitted.providerJobId, needsReconciliation: true };
      }
      if (status.state !== 'SUCCEEDED' || status.results === undefined) {
        // 仍在进行：交回调度（外部回调/轮询补偿）
        return { submitted: true, providerJobId: submitted.providerJobId, state: status.state };
      }

      // 回调载荷（与 HTTP Webhook 同契约；进程内直接经同一状态迁移与回收服务）
      const callback: ProviderCallback = {
        eventId: `evt_${submitted.providerJobId}`,
        eventType: 'job.succeeded',
        providerJobId: submitted.providerJobId,
        attempt: 1,
        results: status.results,
        error: null,
      };
      await registerProviderResultDescriptors(deps, {
        workspaceId,
        jobId,
        attempt: callback.attempt,
        results: callback.results,
      });
      const collection = await collectProviderResult(deps, { workspaceId, jobId });
      if (collection.failure !== null) {
        // 回收失败：任务保持 RUNNING（只重试回收，不重新生成；AC-09）
        return { submitted: true, providerJobId: submitted.providerJobId, collectFailure: collection.failure };
      }
      return { submitted: true, providerJobId: submitted.providerJobId, collected: collection.collected };
    },

    /** 取消钩子（P03-02 协作式取消的 Provider 侧联动；取消失败保持 CANCEL_REQUESTED） */
    async onCancel(deps, rawInput, context) {
      const input = rawInput as GenerationJobInput & { providerJobId?: string };
      const workspaceId = context.workspaceId;
      if (input.providerJobId === undefined) {
        return { ok: false, reason: 'MISSING_PROVIDER_JOB_ID' };
      }
      const provider = providerFor(options, input);
      const credential = await resolveCredentialForExecution(deps, {
        workspaceId,
        providerId: provider.providerId,
        kind: (rawInput['kind'] as string | undefined) ?? 'AI_VIDEO',
      });
      const result = await provider.cancel({ secret: credential.secret ?? 'mock-platform-secret', providerJobId: input.providerJobId });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? 'CANCEL_REJECTED' };
    },
  };
}
