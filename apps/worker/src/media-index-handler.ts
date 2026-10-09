import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_INDEX_JOB_TYPE, mediaIndexJobInputSchema, type SourceMediaIndexer } from '@ancs/contracts';
import { beginMediaIndex, completeMediaIndex, failMediaIndex } from '@ancs/domain';
import type { JobHandler } from './handlers.js';

export function createMediaIndexHandler(options: { indexer: SourceMediaIndexer }): JobHandler {
  return {
    type: MEDIA_INDEX_JOB_TYPE,
    description: '源时间缩略图、波形、镜头边界与质量标记索引',
    async handle(deps, rawInput, context) {
      const jobInput = mediaIndexJobInputSchema.parse(rawInput);
      const current = await beginMediaIndex(deps, { workspaceId: context.workspaceId, jobInput });
      if (current.alreadyComplete) return { runId: jobInput.runId, status: 'READY', idempotent: true };
      const storage = deps.storage;
      if (storage?.materializeObject === undefined || storage.persistFile === undefined) {
        await failMediaIndex(deps, { workspaceId: context.workspaceId, jobInput, message: '当前对象存储不支持媒体索引。' });
        throw new Error('当前对象存储不支持媒体索引');
      }
      const workDir = await mkdtemp(join(tmpdir(), 'ancs-media-index-'));
      const sourcePath = join(workDir, 'source');
      const outputDirectory = join(workDir, 'index');
      const { mkdir } = await import('node:fs/promises');
      try {
        await mkdir(outputDirectory, { recursive: true });
        await storage.materializeObject({ key: jobInput.sourceStorageKey, destinationPath: sourcePath });
        const result = await options.indexer.index({ sourcePath, outputDirectory, sourceProbe: current.sourceProbe });
        const storageKeys = new Map<string, string>();
        for (const entry of result.entries) {
          if (entry.localFilename === null) continue;
          const destinationKey = `workspaces/${context.workspaceId}/media-index/${jobInput.runId}/${entry.localFilename}`;
          await storage.persistFile({ sourcePath: join(outputDirectory, entry.localFilename), destinationKey, contentType: 'image/jpeg' });
          storageKeys.set(entry.localFilename, destinationKey);
        }
        await context.heartbeat();
        return { ...(await completeMediaIndex(deps, { workspaceId: context.workspaceId, jobInput, result, storageKeys })), processorVersion: result.processorVersion };
      } catch {
        await failMediaIndex(deps, { workspaceId: context.workspaceId, jobInput, message: '媒体索引生成失败；原件与编辑代理仍可播放，可稍后重试。' }).catch(() => undefined);
        throw new Error('媒体索引生成失败；原件与编辑代理仍可播放，可稍后重试。');
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
