import { and, eq, sql } from 'drizzle-orm';
import { ApiFailure, ERROR_CODES, sourceMediaProbeResultSchema, type SourceMediaProbeResult } from '@ancs/contracts';
import { assetVersions, assets } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { scheduleMediaProxyInTx } from './media-proxies.js';
import { scheduleMediaIndexInTx } from './media-index.js';
import { scheduleMediaTranscriptInTx } from './media-transcripts.js';
import { scheduleMediaVisualAnalysisInTx } from './media-visual-analysis.js';
import { scheduleMediaAudioAnalysisInTx } from './media-audio-analysis.js';

export async function beginAssetMediaProbe(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; assetVersionId: string },
): Promise<{ alreadyComplete: boolean; result: SourceMediaProbeResult | null }> {
  return deps.db.transaction(async (tx) => {
    // The version row is the concurrency authority for retries/recovery.
    await tx.execute(sql`select id from asset_versions where id = ${input.assetVersionId} for update`);
    const rows = await tx
      .select({ version: assetVersions, asset: assets })
      .from(assetVersions)
      .innerJoin(assets, eq(assets.id, assetVersions.assetId))
      .where(
        and(
          eq(assetVersions.id, input.assetVersionId),
          eq(assetVersions.workspaceId, input.workspaceId),
          eq(assets.id, input.assetId),
          eq(assets.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset version not found', 404);
    if (row.version.probeStatus === 'READY' || row.version.probeStatus === 'FAILED') {
      return {
        alreadyComplete: true,
        result: row.version.mediaProbe === null ? null : sourceMediaProbeResultSchema.parse(row.version.mediaProbe),
      };
    }
    if (row.version.probeStatus !== 'PENDING' && row.version.probeStatus !== 'PROCESSING') {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '该资产版本不需要媒体探测', 409, {
        probeStatus: row.version.probeStatus,
      });
    }
    await tx
      .update(assetVersions)
      .set({ probeStatus: 'PROCESSING' })
      .where(and(eq(assetVersions.id, input.assetVersionId), eq(assetVersions.workspaceId, input.workspaceId)));
    await tx
      .update(assets)
      .set({ status: 'PROCESSING', updatedAt: new Date() })
      .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId)));
    return { alreadyComplete: false, result: null };
  });
}

export async function completeAssetMediaProbe(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; assetVersionId: string; result: SourceMediaProbeResult },
): Promise<{ status: 'READY' | 'FAILED'; durationMs: number | null; width: number | null; height: number | null }> {
  const result = sourceMediaProbeResultSchema.parse(input.result);
  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .select({ version: assetVersions, asset: assets })
      .from(assetVersions)
      .innerJoin(assets, eq(assets.id, assetVersions.assetId))
      .where(
        and(
          eq(assetVersions.id, input.assetVersionId),
          eq(assetVersions.workspaceId, input.workspaceId),
          eq(assets.id, input.assetId),
          eq(assets.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset version not found', 404);
    const video = result.streams.find((stream) => stream.type === 'VIDEO');
    const durationMs = result.durationMs ?? result.streams.reduce<number | null>((max, stream) => {
      if (stream.durationMs === null) return max;
      return max === null ? stream.durationMs : Math.max(max, stream.durationMs);
    }, null);
    const status = result.status;
    await tx
      .update(assetVersions)
      .set({
        probeStatus: status,
        mediaProbe: result,
        durationMs,
        width: video?.width ?? null,
        height: video?.height ?? null,
      })
      .where(and(eq(assetVersions.id, input.assetVersionId), eq(assetVersions.workspaceId, input.workspaceId)));
    await tx
      .update(assets)
      .set({ status, currentVersionId: input.assetVersionId, updatedAt: new Date() })
      .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId), eq(assets.currentVersionId, input.assetVersionId)));
    if (status === 'READY') {
      await scheduleMediaProxyInTx(tx, {
        workspaceId: input.workspaceId,
        projectId: row.asset.projectId,
        sourceAsset: row.asset,
        sourceVersion: row.version,
        probe: result,
      });
      await scheduleMediaIndexInTx(tx, {
        workspaceId: input.workspaceId,
        projectId: row.asset.projectId,
        sourceAsset: row.asset,
        sourceVersion: row.version,
        probe: result,
      });
      await scheduleMediaTranscriptInTx(tx, {
        workspaceId: input.workspaceId,
        projectId: row.asset.projectId,
        sourceAsset: row.asset,
        sourceVersion: row.version,
        hasAudio: result.streams.some((stream) => stream.type === 'AUDIO'),
      });
      await scheduleMediaVisualAnalysisInTx(tx, {
        workspaceId: input.workspaceId,
        projectId: row.asset.projectId,
        sourceAsset: row.asset,
        sourceVersion: row.version,
        hasVideo: result.streams.some((stream) => stream.type === 'VIDEO'),
      });
      await scheduleMediaAudioAnalysisInTx(tx, {
        workspaceId: input.workspaceId,
        projectId: row.asset.projectId,
        sourceAsset: row.asset,
        sourceVersion: row.version,
        hasAudio: result.streams.some((stream) => stream.type === 'AUDIO'),
      });
    }
    return { status, durationMs, width: video?.width ?? null, height: video?.height ?? null };
  });
}
