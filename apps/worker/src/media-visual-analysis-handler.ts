import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_VISUAL_ANALYSIS_JOB_TYPE, mediaVisualAnalysisJobInputSchema, type MediaVisualAnalysisAdapter } from '@ancs/contracts';
import { beginMediaVisualAnalysis, completeMediaVisualAnalysis, failMediaVisualAnalysis } from '@ancs/domain';
import type { JobHandler } from './handlers.js';

export function createMediaVisualAnalysisHandler(options: { adapter?: MediaVisualAnalysisAdapter }): JobHandler {
  return {
    type: MEDIA_VISUAL_ANALYSIS_JOB_TYPE,
    description: '源视频对象、动作、匿名人物轨迹、视觉事件与运动强度分析',
    async handle(deps, rawInput, context) {
      const jobInput = mediaVisualAnalysisJobInputSchema.parse(rawInput);
      const current = await beginMediaVisualAnalysis(deps, { workspaceId: context.workspaceId, jobInput });
      if (current.alreadyComplete) return { runId: jobInput.runId, status: 'READY', idempotent: true };
      if (options.adapter === undefined) {
        await failMediaVisualAnalysis(deps, { workspaceId: context.workspaceId, jobInput, message: '视觉分析检测器尚未配置；原视频与基础索引未受影响。' });
        throw new Error('VISUAL_ANALYSIS_CAPABILITY_UNAVAILABLE');
      }
      const storage = deps.storage;
      if (storage?.materializeObject === undefined) {
        await failMediaVisualAnalysis(deps, { workspaceId: context.workspaceId, jobInput, message: '当前对象存储不支持视觉分析源文件读取。' });
        throw new Error('VISUAL_ANALYSIS_STORAGE_UNAVAILABLE');
      }
      const workDir = await mkdtemp(join(tmpdir(), 'ancs-media-visual-'));
      const sourcePath = join(workDir, 'source');
      try {
        await storage.materializeObject({ key: jobInput.sourceStorageKey, destinationPath: sourcePath });
        const result = await options.adapter.analyze({ sourcePath });
        await context.heartbeat();
        return { ...(await completeMediaVisualAnalysis(deps, { workspaceId: context.workspaceId, jobInput, result })), adapter: result.adapter, modelVersion: result.modelVersion };
      } catch (error) {
        await failMediaVisualAnalysis(deps, { workspaceId: context.workspaceId, jobInput, message: error instanceof Error && error.message === 'VISUAL_ANALYSIS_CAPABILITY_UNAVAILABLE' ? '视觉分析检测器尚未配置，等待管理员配置后重试。' : '视觉分析失败；原视频与基础索引未受影响。' });
        throw error;
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}
