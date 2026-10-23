import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_ANALYSIS_ERROR_CODES, MEDIA_VISUAL_ANALYSIS_JOB_TYPE, mediaVisualAnalysisJobInputSchema, type MediaVisualAnalysisAdapter, type MediaVisualAnalysisUsage } from '@ancs/contracts';
import { beginMediaVisualAnalysis, completeMediaVisualAnalysis, failMediaVisualAnalysis, modelIsPriced, recordAiUsage, workspaceAiSpend } from '@ancs/domain';
import type { JobHandler } from './handlers.js';

const LIMIT_MESSAGE = '工作区本月的 AI 额度已用完，画面理解暂停；额度恢复后可重试。原视频与基础索引未受影响。';
const unpricedMessage = (model: string): string => `视觉模型 ${model} 没有单价，设了月度 AI 上限时不调用；请在 ANCS_MODEL_PRICES_JSON 补上单价后重试。原视频与基础索引未受影响。`;

export function createMediaVisualAnalysisHandler(options: { adapter?: MediaVisualAnalysisAdapter }): JobHandler {
  return {
    type: MEDIA_VISUAL_ANALYSIS_JOB_TYPE,
    description: '源视频对象、动作、匿名人物轨迹、视觉事件与运动强度分析',
    async handle(deps, rawInput, context) {
      const jobInput = mediaVisualAnalysisJobInputSchema.parse(rawInput);
      const current = await beginMediaVisualAnalysis(deps, { workspaceId: context.workspaceId, jobInput });
      if (current.alreadyComplete) return { runId: jobInput.runId, status: 'READY', idempotent: true };
      if (options.adapter === undefined) {
        await failMediaVisualAnalysis(deps, { workspaceId: context.workspaceId, jobInput, message: '视觉分析检测器尚未配置；原视频与基础索引未受影响。', code: MEDIA_ANALYSIS_ERROR_CODES.CAPABILITY_NOT_CONFIGURED });
        throw new Error('VISUAL_ANALYSIS_CAPABILITY_UNAVAILABLE');
      }
      // 工作区本月 AI 额度：开始前查一次（不白白取回源文件），模型调用前再逐次查——本次分析已花的还没入账，要一并算上
      // 设了上限时，没有单价的模型（开始前看适配器声明的模型；调用后看实际计费的模型）不调用——花多少无法核算
      let limitReached = false;
      let unpricedModel: string | null = null;
      let usage: MediaVisualAnalysisUsage | null = null;
      const canSpend = async (): Promise<boolean> => {
        const spend = await workspaceAiSpend(deps, { workspaceId: context.workspaceId });
        if (spend.capMicros === null) return true;
        if (usage !== null && usage.unpricedCalls > 0) unpricedModel = usage.model;
        else if (options.adapter?.model !== undefined && !modelIsPriced(options.adapter.model)) unpricedModel = options.adapter.model;
        if (unpricedModel !== null) return false;
        limitReached = spend.spentMicros + (usage?.costMicros ?? 0) >= spend.capMicros;
        return !limitReached;
      };
      const stopReason = (): { message: string; code: string } | null => (unpricedModel !== null
        ? { message: unpricedMessage(unpricedModel), code: MEDIA_ANALYSIS_ERROR_CODES.AI_MODEL_UNPRICED }
        : limitReached ? { message: LIMIT_MESSAGE, code: MEDIA_ANALYSIS_ERROR_CODES.AI_MONTHLY_CAP_REACHED } : null);
      if (!(await canSpend())) {
        await failMediaVisualAnalysis(deps, { workspaceId: context.workspaceId, jobInput, ...stopReason()! });
        throw new Error(unpricedModel !== null ? 'VISUAL_ANALYSIS_MODEL_UNPRICED' : 'VISUAL_ANALYSIS_AI_MONTHLY_CAP_REACHED');
      }
      const storage = deps.storage;
      if (storage?.materializeObject === undefined) {
        await failMediaVisualAnalysis(deps, { workspaceId: context.workspaceId, jobInput, message: '当前对象存储不支持视觉分析源文件读取。' });
        throw new Error('VISUAL_ANALYSIS_STORAGE_UNAVAILABLE');
      }
      const workDir = await mkdtemp(join(tmpdir(), 'ancs-media-visual-'));
      const sourcePath = join(workDir, 'source');
      const record = (): Promise<void> => (usage === null ? Promise.resolve() : recordAiUsage(deps, { workspaceId: context.workspaceId, kind: 'FOOTAGE_DESCRIPTION', subjectRef: jobInput.runId, usage }));
      try {
        await storage.materializeObject({ key: jobInput.sourceStorageKey, destinationPath: sourcePath });
        const result = await options.adapter.analyze({ sourcePath, beforeModelCall: canSpend, onUsage: (value) => { usage = value; } });
        await context.heartbeat();
        // 先记用量再落结果：调用已经发生，结果落库失败也照样计费
        await record();
        usage = null;
        return { ...(await completeMediaVisualAnalysis(deps, { workspaceId: context.workspaceId, jobInput, result })), adapter: result.adapter, modelVersion: result.modelVersion };
      } catch (error) {
        // 失败前已完成的调用照样计入（尽力记录，不掩盖原来的错误）
        await record().catch(() => undefined);
        const stopped = stopReason();
        if (stopped !== null) {
          await failMediaVisualAnalysis(deps, { workspaceId: context.workspaceId, jobInput, ...stopped });
        } else {
          await failMediaVisualAnalysis(deps, { workspaceId: context.workspaceId, jobInput, message: error instanceof Error && error.message === 'VISUAL_ANALYSIS_CAPABILITY_UNAVAILABLE' ? '视觉分析检测器尚未配置，等待管理员配置后重试。' : '视觉分析失败；原视频与基础索引未受影响。' });
        }
        throw error;
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}
