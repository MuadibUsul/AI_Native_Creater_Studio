import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_ANALYSIS_ERROR_CODES, MEDIA_TRANSCRIPT_JOB_TYPE, mediaTranscriptJobInputSchema, type SpeechRecognitionAdapter } from '@ancs/contracts';
import { beginMediaTranscript, completeMediaTranscript, failMediaTranscript } from '@ancs/domain';
import type { JobHandler } from './handlers.js';

export function createMediaTranscriptHandler(options: { adapter?: SpeechRecognitionAdapter }): JobHandler {
  return {
    type: MEDIA_TRANSCRIPT_JOB_TYPE,
    description: '源音频 ASR 转写、词句与说话人时间锚点',
    async handle(deps, rawInput, context) {
      const jobInput = mediaTranscriptJobInputSchema.parse(rawInput);
      const current = await beginMediaTranscript(deps, { workspaceId: context.workspaceId, jobInput });
      if (current.alreadyComplete) return { runId: jobInput.runId, status: 'READY', idempotent: true };
      if (options.adapter === undefined) {
        await failMediaTranscript(deps, { workspaceId: context.workspaceId, jobInput, message: 'ASR 服务尚未配置，原音与已有媒体结果未受影响。', code: MEDIA_ANALYSIS_ERROR_CODES.CAPABILITY_NOT_CONFIGURED });
        throw new Error('ASR_CAPABILITY_UNAVAILABLE');
      }
      const storage = deps.storage;
      if (storage?.materializeObject === undefined) {
        await failMediaTranscript(deps, { workspaceId: context.workspaceId, jobInput, message: '当前对象存储不支持转写源文件读取。' });
        throw new Error('TRANSCRIPT_STORAGE_UNAVAILABLE');
      }
      const workDir = await mkdtemp(join(tmpdir(), 'ancs-media-transcript-'));
      const sourcePath = join(workDir, 'source');
      try {
        await storage.materializeObject({ key: jobInput.sourceStorageKey, destinationPath: sourcePath });
        const result = await options.adapter.transcribe({ sourcePath });
        await context.heartbeat();
        return { ...(await completeMediaTranscript(deps, { workspaceId: context.workspaceId, jobInput, result })), provider: result.provider, model: result.model };
      } catch (error) {
        await failMediaTranscript(deps, { workspaceId: context.workspaceId, jobInput, message: error instanceof Error && error.message === 'ASR_CAPABILITY_UNAVAILABLE' ? 'ASR 服务尚未配置，等待管理员配置后重试。' : 'ASR 转写失败，原音与已有媒体结果未受影响。' });
        throw error;
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}
