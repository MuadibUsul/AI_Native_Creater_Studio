import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_ANALYSIS_ERROR_CODES, MEDIA_AUDIO_ANALYSIS_JOB_TYPE, mediaAudioAnalysisJobInputSchema, type MediaAudioAnalysisAdapter } from '@ancs/contracts';
import { beginMediaAudioAnalysis, completeMediaAudioAnalysis, failMediaAudioAnalysis } from '@ancs/domain';
import type { JobHandler } from './handlers.js';

export function createMediaAudioAnalysisHandler(options: { adapter?: MediaAudioAnalysisAdapter }): JobHandler {
  return {
    type: MEDIA_AUDIO_ANALYSIS_JOB_TYPE,
    description: '源音频事件、音乐节拍、分段 tempo 与声画时间关联分析',
    async handle(deps, rawInput, context) {
      const jobInput = mediaAudioAnalysisJobInputSchema.parse(rawInput);
      const current = await beginMediaAudioAnalysis(deps, { workspaceId: context.workspaceId, jobInput });
      if (current.alreadyComplete) return { runId: jobInput.runId, status: 'READY', idempotent: true };
      if (options.adapter === undefined) {
        await failMediaAudioAnalysis(deps, { workspaceId: context.workspaceId, jobInput, message: '音频事件检测器尚未配置；原音和基础波形未受影响。', code: MEDIA_ANALYSIS_ERROR_CODES.CAPABILITY_NOT_CONFIGURED });
        throw new Error('AUDIO_ANALYSIS_CAPABILITY_UNAVAILABLE');
      }
      const storage = deps.storage;
      if (storage?.materializeObject === undefined) {
        await failMediaAudioAnalysis(deps, { workspaceId: context.workspaceId, jobInput, message: '当前对象存储不支持音频分析源文件读取。' });
        throw new Error('AUDIO_ANALYSIS_STORAGE_UNAVAILABLE');
      }
      const workDir = await mkdtemp(join(tmpdir(), 'ancs-media-audio-'));
      const sourcePath = join(workDir, 'source');
      try {
        await storage.materializeObject({ key: jobInput.sourceStorageKey, destinationPath: sourcePath });
        const result = await options.adapter.analyze({ sourcePath });
        await context.heartbeat();
        return { ...(await completeMediaAudioAnalysis(deps, { workspaceId: context.workspaceId, jobInput, result })), adapter: result.adapter, modelVersion: result.modelVersion };
      } catch (error) {
        await failMediaAudioAnalysis(deps, { workspaceId: context.workspaceId, jobInput, message: error instanceof Error && error.message === 'AUDIO_ANALYSIS_CAPABILITY_UNAVAILABLE' ? '音频事件检测器尚未配置，等待管理员配置后重试。' : '音频分析失败；原音和基础波形未受影响。' });
        throw error;
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}
