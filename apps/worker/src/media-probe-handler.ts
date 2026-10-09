import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { MEDIA_PROBE_JOB_TYPE, mediaProbeJobInputSchema, sourceMediaProbeResultSchema, type SourceMediaProbe } from '@ancs/contracts';
import { beginAssetMediaProbe, completeAssetMediaProbe } from '@ancs/domain';
import type { JobHandler } from './handlers.js';

export function createAssetMediaProbeHandler(options: { probe: SourceMediaProbe }): JobHandler {
  return {
    type: MEDIA_PROBE_JOB_TYPE,
    description: '源媒体 ffprobe 与完整解码能力检查（隔离进程、有界临时文件）',
    async handle(deps, rawInput, context) {
      const input = mediaProbeJobInputSchema.parse(rawInput);
      const current = await beginAssetMediaProbe(deps, {
        workspaceId: context.workspaceId,
        assetId: input.assetId,
        assetVersionId: input.assetVersionId,
      });
      if (current.alreadyComplete) {
        return {
          assetId: input.assetId,
          assetVersionId: input.assetVersionId,
          status: current.result?.status ?? 'FAILED',
          idempotent: true,
        };
      }
      const storage = deps.storage;
      if (storage?.materializeObject === undefined) {
        throw new Error(`对象存储 ${storage?.kind ?? 'unconfigured'} 不支持流式媒体探测物化`);
      }
      const workDir = await mkdtemp(join(tmpdir(), 'ancs-source-probe-'));
      const suffix = extname(input.storageKey).replace(/[^A-Za-z0-9.]/g, '').slice(0, 12);
      const filePath = join(workDir, `source${suffix}`);
      try {
        await context.heartbeat();
        const result = await storage.materializeObject({ key: input.storageKey, destinationPath: filePath })
          .then(() => options.probe.probe({ filePath, declaredMimeType: input.declaredMimeType }))
          .catch(() => sourceMediaProbeResultSchema.parse({
            schemaVersion: '1.0',
            status: 'FAILED',
            formatNames: [],
            formatLongName: null,
            startTimeMs: null,
            durationMs: null,
            bitRate: null,
            streams: [],
            decodeCheck: { status: 'FAILED', errorCode: 'PROBE_EXECUTION_FAILED', message: '媒体分析服务未能读取或检查该原件。' },
            capabilities: {
              upload: 'AVAILABLE',
              decode: 'UNKNOWN',
              preview: 'UNAVAILABLE',
              export: 'UNAVAILABLE',
              reasons: [{ code: 'PROBE_EXECUTION_FAILED', message: '媒体分析服务未能读取或检查该原件。', nextAction: '重新上传；若问题持续，请联系管理员检查媒体工具配置。' }],
            },
          }));
        await context.heartbeat();
        const persisted = await completeAssetMediaProbe(deps, {
          workspaceId: context.workspaceId,
          assetId: input.assetId,
          assetVersionId: input.assetVersionId,
          result,
        });
        return {
          assetId: input.assetId,
          assetVersionId: input.assetVersionId,
          probeKind: options.probe.kind,
          ...persisted,
          capabilities: result.capabilities,
        };
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
