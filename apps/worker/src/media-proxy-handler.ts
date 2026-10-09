import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_PROXY_JOB_TYPE, mediaProxyJobInputSchema, type SourceMediaTranscoder } from '@ancs/contracts';
import { beginMediaProxy, completeMediaProxy, failMediaProxy } from '@ancs/domain';
import type { JobHandler } from './handlers.js';

export function createMediaProxyHandler(options: { transcoder: SourceMediaTranscoder }): JobHandler {
  return {
    type: MEDIA_PROXY_JOB_TYPE,
    description: '标准编辑代理转码、音频 conform 与源 PTS 映射',
    async handle(deps, rawInput, context) {
      const jobInput = mediaProxyJobInputSchema.parse(rawInput);
      const current = await beginMediaProxy(deps, { workspaceId: context.workspaceId, jobInput });
      if (current.alreadyComplete) return { derivativeId: jobInput.derivativeId, status: 'READY', idempotent: true };
      const storage = deps.storage;
      if (storage?.materializeObject === undefined || storage.persistFile === undefined) {
        await failMediaProxy(deps, { workspaceId: context.workspaceId, jobInput, message: '当前对象存储不支持流式代理转码。' });
        throw new Error('当前对象存储不支持流式代理转码');
      }
      const workDir = await mkdtemp(join(tmpdir(), 'ancs-media-proxy-'));
      const sourcePath = join(workDir, 'source');
      const outputPath = join(workDir, `proxy.${jobInput.profileKey === 'web-edit-video-720p-v1' ? 'mp4' : 'm4a'}`);
      try {
        await context.heartbeat();
        await storage.materializeObject({ key: jobInput.sourceStorageKey, destinationPath: sourcePath });
        const result = await options.transcoder.transcode({ sourcePath, outputPath, profileKey: jobInput.profileKey, sourceProbe: current.sourceProbe });
        await context.heartbeat();
        await storage.persistFile({ sourcePath: outputPath, destinationKey: jobInput.outputStorageKey, contentType: result.mimeType });
        const completed = await completeMediaProxy(deps, { workspaceId: context.workspaceId, jobInput, result });
        return { ...completed, status: 'READY', profileKey: result.profileKey, timeMappings: result.timeMappings };
      } catch {
        await failMediaProxy(deps, { workspaceId: context.workspaceId, jobInput, message: '编辑代理生成失败；原件保持不变，可稍后重试。' }).catch(() => undefined);
        throw new Error('编辑代理生成失败；原件保持不变，可稍后重试。');
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
