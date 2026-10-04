import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RENDER_FINAL_JOB_TYPE, type RenderExecutor } from '@ancs/contracts';
import { failJob, getRender, runRenderExecution, transitionRender, type DomainDeps } from '@ancs/domain';
import type { JobHandler } from './handlers.js';

/**
 * Final 合成任务处理器（P07-04 / §39）。
 *
 * 路径：任务（RENDER_FINAL）→ `runRenderExecution`（快照 → spec → 冻结素材 → 执行器 → 产物入库 → QA）。
 * - 执行器注入（生产 = 进程隔离 CLI；测试可直接用同进程实现）——处理器不 import 渲染栈（架构 R1/R8）；
 * - **失败定性**：执行失败 → Render=FAILED + 任务 FAILED_FINAL（显式结果，不允许无限自动重试）；
 * - **崩溃恢复**：Worker 被杀 → 租约回收重新入队（maxAttempts=2）→ 渲染在 RENDERING 状态从零重做
 *   （产物按 (renderId, kind) 幂等复用）；
 * - **取消**：QUEUED 未开始 → CANCELLED；渲染中 → 拒绝（保持 CANCEL_REQUESTED 供人工介入，
 *   与 P03-02 协作式取消纪律一致——执行器不支持中途中断）。
 */

export interface RenderExecutionHandlerOptions {
  executor: RenderExecutor;
  /** 工作目录根（缺省系统临时目录；每次执行独立子目录，执行后清理） */
  workDirRoot?: string;
}

export function createRenderExecutionHandler(options: RenderExecutionHandlerOptions): JobHandler {
  return {
    type: RENDER_FINAL_JOB_TYPE,
    description: 'Final 合成（Remotion 服务端渲染 → MP4/SRT/VTT/Manifest 入自有存储 → QA）',
    async handle(deps: DomainDeps, rawInput, context) {
      const renderId = rawInput['renderId'];
      if (typeof renderId !== 'string' || renderId === '') {
        throw new Error('RENDER_FINAL 任务输入缺少 renderId');
      }
      const workDir = await mkdtemp(join(options.workDirRoot ?? tmpdir(), 'ancs-render-'));
      try {
        try {
          const outcome = await runRenderExecution(deps, { workspaceId: context.workspaceId, renderId, executor: options.executor, workDir });
          if (outcome.skipped !== null) {
            return { renderId, skipped: outcome.skipped, status: outcome.render.status };
          }
          return {
            renderId,
            status: outcome.render.status,
            manifestHash: outcome.render.manifestHash,
            outputAssetIds: outcome.render.outputAssetIds,
            durationMs: outcome.result?.durationMs ?? null,
            durationInFrames: outcome.result?.durationInFrames ?? null,
            files: (outcome.result?.files ?? []).map((file) => ({ kind: file.kind, fileName: file.fileName, sizeBytes: file.sizeBytes, sha256: file.sha256 })),
            warnings: outcome.result?.warnings ?? [],
          };
        } catch (error) {
          // 执行失败已由 runRenderExecution 定性（Render=FAILED）；任务侧定性 FAILED_FINAL（不自动重试）
          const message = error instanceof Error ? error.message : String(error);
          await failJob(deps, {
            workspaceId: context.workspaceId,
            jobId: context.jobId,
            error: { reason: 'RENDER_EXECUTION_FAILED', renderId, message },
            retryable: false,
          }).catch(() => undefined);
          return { renderId, failed: true, message };
        }
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    /** 取消钩子：仅"未开始"可取消；渲染进行中拒绝（保持 CANCEL_REQUESTED 供人工介入）。 */
    async onCancel(deps, rawInput, context) {
      const renderId = rawInput['renderId'];
      if (typeof renderId !== 'string' || renderId === '') return { ok: false, reason: 'MISSING_RENDER_ID' };
      const render = await getRender(deps, { workspaceId: context.workspaceId, renderId }).catch(() => null);
      if (render === null) return { ok: false, reason: 'RENDER_NOT_FOUND' };
      if (render.status === 'QUEUED') {
        await transitionRender(deps, { workspaceId: context.workspaceId, renderId, to: 'CANCELLED', note: '任务取消：渲染尚未开始' });
        return { ok: true };
      }
      if (render.status === 'RENDERING') return { ok: false, reason: 'EXECUTION_IN_PROGRESS' };
      return { ok: true };
    },
  };
}
