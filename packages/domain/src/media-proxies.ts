import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ApiFailure,
  DOWNLOAD_URL_TTL_SECONDS,
  ERROR_CODES,
  MAX_SIGNED_URL_TTL_SECONDS,
  MEDIA_PROXY_JOB_TYPE,
  mediaPlaybackResponseSchema,
  mediaProxyJobInputSchema,
  mediaProxyTranscodeResultSchema,
  sourceMediaProbeResultSchema,
  type MediaPlaybackResponse,
  type MediaProxyJobInput,
  type MediaProxyProfileKey,
  type MediaProxyTranscodeResult,
  type SourceMediaProbeResult,
} from '@ancs/contracts';
import { assetDerivationEdges, assetVersions, assets, mediaDerivatives } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { createJobInTx } from './jobs.js';

type DomainTx = Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0];

function stableId(prefix: string, sourceVersionId: string, profileKey: string): string {
  return `${prefix}_${createHash('sha256').update(`${sourceVersionId}\0${profileKey}`).digest('hex').slice(0, 24)}`;
}

export function selectMediaProxyProfile(probe: SourceMediaProbeResult): MediaProxyProfileKey | null {
  const parsed = sourceMediaProbeResultSchema.parse(probe);
  if (parsed.status !== 'READY') return null;
  if (parsed.streams.some((stream) => stream.type === 'VIDEO')) return 'web-edit-video-720p-v1';
  if (parsed.streams.some((stream) => stream.type === 'AUDIO')) return 'web-edit-audio-48k-stereo-v1';
  return null;
}

export async function scheduleMediaProxyInTx(
  tx: DomainTx,
  input: {
    workspaceId: string;
    projectId: string | null;
    sourceAsset: typeof assets.$inferSelect;
    sourceVersion: typeof assetVersions.$inferSelect;
    probe: SourceMediaProbeResult;
  },
): Promise<{ scheduled: boolean; derivativeId: string | null }> {
  const profileKey = selectMediaProxyProfile(input.probe);
  if (profileKey === null || input.sourceVersion.checksumSha256 === null || input.sourceVersion.status !== 'READY') {
    return { scheduled: false, derivativeId: null };
  }
  const outputAssetId = stableId('ast_prx', input.sourceVersion.id, profileKey);
  const outputAssetVersionId = stableId('av_prx', input.sourceVersion.id, profileKey);
  const derivativeId = stableId('mdr', input.sourceVersion.id, profileKey);
  const isVideo = profileKey === 'web-edit-video-720p-v1';
  const extension = isVideo ? 'mp4' : 'm4a';
  const mimeType = isVideo ? 'video/mp4' : 'audio/mp4';
  const outputStorageKey = `workspaces/${input.workspaceId}/library/renders/assets/${outputAssetId}/v1/proxy.${extension}`;
  const now = new Date();

  await tx.insert(assets).values({
    id: outputAssetId,
    workspaceId: input.workspaceId,
    projectId: null,
    assetType: 'DRAFT_RENDER',
    origin: 'SYSTEM_RENDER',
    status: 'PROCESSING',
    retentionClass: 'PREVIEW_CACHE_7D',
    license: input.sourceAsset.license,
    metadata: { internalDerivative: true, sourceAssetId: input.sourceAsset.id, sourceAssetVersionId: input.sourceVersion.id, profileKey },
    currentVersionId: outputAssetVersionId,
    createdBy: input.sourceAsset.createdBy,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({ target: assets.id });
  await tx.insert(assetVersions).values({
    id: outputAssetVersionId,
    assetId: outputAssetId,
    workspaceId: input.workspaceId,
    versionNumber: 1,
    storageKey: outputStorageKey,
    mimeType,
    sizeBytes: 0,
    status: 'UPLOADING',
    probeStatus: 'NOT_REQUIRED',
    metadata: { internalDerivative: true, sourceAssetVersionId: input.sourceVersion.id, profileKey },
    createdAt: now,
  }).onConflictDoNothing({ target: assetVersions.id });
  await tx.insert(assetDerivationEdges).values({
    id: stableId('adl', input.sourceVersion.id, profileKey),
    workspaceId: input.workspaceId,
    sourceAssetId: input.sourceAsset.id,
    sourceAssetVersionId: input.sourceVersion.id,
    derivedAssetId: outputAssetId,
    derivedAssetVersionId: outputAssetVersionId,
    kind: 'MEDIA_PROXY',
    createdAt: now,
  }).onConflictDoNothing({ target: [assetDerivationEdges.sourceAssetVersionId, assetDerivationEdges.derivedAssetVersionId, assetDerivationEdges.kind] });
  const inserted = await tx.insert(mediaDerivatives).values({
    id: derivativeId,
    workspaceId: input.workspaceId,
    sourceAssetVersionId: input.sourceVersion.id,
    kind: 'PROXY',
    profileKey,
    status: 'PENDING',
    derivativeAssetVersionId: outputAssetVersionId,
    sourceChecksumSha256: input.sourceVersion.checksumSha256,
    metadata: { outputAssetId, outputStorageKey },
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({
    target: [mediaDerivatives.sourceAssetVersionId, mediaDerivatives.kind, mediaDerivatives.profileKey],
  }).returning({ id: mediaDerivatives.id });
  if (inserted[0] === undefined) return { scheduled: false, derivativeId };
  const jobInput = mediaProxyJobInputSchema.parse({
    derivativeId,
    sourceAssetId: input.sourceAsset.id,
    sourceAssetVersionId: input.sourceVersion.id,
    outputAssetId,
    outputAssetVersionId,
    sourceStorageKey: input.sourceVersion.storageKey,
    outputStorageKey,
    sourceChecksumSha256: input.sourceVersion.checksumSha256,
    profileKey,
  });
  await createJobInTx(tx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    type: MEDIA_PROXY_JOB_TYPE,
    input: jobInput,
    maxAttempts: 2,
    createdBy: input.sourceAsset.createdBy,
    classification: 'SYSTEM',
  });
  return { scheduled: true, derivativeId };
}

export async function beginMediaProxy(
  deps: DomainDeps,
  input: { workspaceId: string; jobInput: MediaProxyJobInput },
): Promise<{ alreadyComplete: boolean; sourceProbe: SourceMediaProbeResult; outputStorageKey: string }> {
  const jobInput = mediaProxyJobInputSchema.parse(input.jobInput);
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from media_derivatives where id = ${jobInput.derivativeId} for update`);
    const derivativeRows = await tx.select().from(mediaDerivatives).where(and(
      eq(mediaDerivatives.id, jobInput.derivativeId),
      eq(mediaDerivatives.workspaceId, input.workspaceId),
      eq(mediaDerivatives.sourceAssetVersionId, jobInput.sourceAssetVersionId),
    )).limit(1);
    const derivative = derivativeRows[0];
    if (!derivative) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'media proxy derivative not found', 404);
    const sourceRows = await tx.select().from(assetVersions).where(and(
      eq(assetVersions.id, jobInput.sourceAssetVersionId), eq(assetVersions.workspaceId, input.workspaceId),
    )).limit(1);
    const source = sourceRows[0];
    if (!source || source.status !== 'READY' || source.probeStatus !== 'READY' || source.mediaProbe === null) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source media is not ready for proxy generation', 409, { reason: 'SOURCE_NOT_PROBED' });
    }
    if (source.checksumSha256 !== jobInput.sourceChecksumSha256 || derivative.sourceChecksumSha256 !== jobInput.sourceChecksumSha256) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source checksum changed before proxy generation', 409, { reason: 'SOURCE_CHECKSUM_CHANGED' });
    }
    if (derivative.status === 'READY') {
      return { alreadyComplete: true, sourceProbe: sourceMediaProbeResultSchema.parse(source.mediaProbe), outputStorageKey: jobInput.outputStorageKey };
    }
    await tx.update(mediaDerivatives).set({ status: 'PROCESSING', errorSummary: null, updatedAt: new Date() }).where(eq(mediaDerivatives.id, derivative.id));
    await tx.update(assets).set({ status: 'PROCESSING', updatedAt: new Date() }).where(and(eq(assets.id, jobInput.outputAssetId), eq(assets.workspaceId, input.workspaceId)));
    await tx.update(assetVersions).set({ status: 'UPLOADING' }).where(and(eq(assetVersions.id, jobInput.outputAssetVersionId), eq(assetVersions.workspaceId, input.workspaceId)));
    return { alreadyComplete: false, sourceProbe: sourceMediaProbeResultSchema.parse(source.mediaProbe), outputStorageKey: jobInput.outputStorageKey };
  });
}

export async function completeMediaProxy(
  deps: DomainDeps,
  input: { workspaceId: string; jobInput: MediaProxyJobInput; result: MediaProxyTranscodeResult },
): Promise<{ derivativeId: string; outputAssetVersionId: string; checksumSha256: string; sizeBytes: number }> {
  const jobInput = mediaProxyJobInputSchema.parse(input.jobInput);
  const result = mediaProxyTranscodeResultSchema.parse(input.result);
  const storage = deps.storage;
  if (storage === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'object storage is not configured', 500);
  const [object, checksumSha256] = await Promise.all([
    storage.probeObject(jobInput.outputStorageKey),
    storage.computeObjectSha256(jobInput.outputStorageKey),
  ]);
  if (!object.exists || object.sizeBytes <= 0 || checksumSha256 === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'proxy output is missing or incomplete', 409, { reason: 'PROXY_OUTPUT_MISSING' });
  }
  return deps.db.transaction(async (tx) => {
    const sourceRows = await tx.select({ checksumSha256: assetVersions.checksumSha256 }).from(assetVersions).where(and(
      eq(assetVersions.id, jobInput.sourceAssetVersionId), eq(assetVersions.workspaceId, input.workspaceId),
    )).limit(1);
    if (sourceRows[0]?.checksumSha256 !== jobInput.sourceChecksumSha256) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source checksum changed while proxy was generated', 409, { reason: 'SOURCE_CHECKSUM_CHANGED' });
    }
    await tx.update(assetVersions).set({
      status: 'READY',
      checksumSha256,
      sizeBytes: object.sizeBytes,
      mimeType: result.mimeType,
      durationMs: result.durationMs,
      width: result.width,
      height: result.height,
      metadata: { internalDerivative: true, sourceAssetVersionId: jobInput.sourceAssetVersionId, profileKey: jobInput.profileKey, transcode: result },
    }).where(and(eq(assetVersions.id, jobInput.outputAssetVersionId), eq(assetVersions.workspaceId, input.workspaceId)));
    await tx.update(assets).set({ status: 'READY', currentVersionId: jobInput.outputAssetVersionId, updatedAt: new Date() }).where(and(
      eq(assets.id, jobInput.outputAssetId), eq(assets.workspaceId, input.workspaceId),
    ));
    await tx.update(mediaDerivatives).set({
      status: 'READY', derivativeAssetVersionId: jobInput.outputAssetVersionId, metadata: result, errorSummary: null, updatedAt: new Date(),
    }).where(and(eq(mediaDerivatives.id, jobInput.derivativeId), eq(mediaDerivatives.workspaceId, input.workspaceId)));
    return { derivativeId: jobInput.derivativeId, outputAssetVersionId: jobInput.outputAssetVersionId, checksumSha256, sizeBytes: object.sizeBytes };
  });
}

export async function failMediaProxy(
  deps: DomainDeps,
  input: { workspaceId: string; jobInput: MediaProxyJobInput; message: string },
): Promise<void> {
  const jobInput = mediaProxyJobInputSchema.parse(input.jobInput);
  const message = input.message.slice(0, 500);
  await deps.db.transaction(async (tx) => {
    await tx.update(mediaDerivatives).set({ status: 'FAILED', errorSummary: message, updatedAt: new Date() }).where(and(
      eq(mediaDerivatives.id, jobInput.derivativeId), eq(mediaDerivatives.workspaceId, input.workspaceId),
    ));
    await tx.update(assetVersions).set({ status: 'FAILED' }).where(and(eq(assetVersions.id, jobInput.outputAssetVersionId), eq(assetVersions.workspaceId, input.workspaceId)));
    await tx.update(assets).set({ status: 'FAILED', updatedAt: new Date() }).where(and(eq(assets.id, jobInput.outputAssetId), eq(assets.workspaceId, input.workspaceId)));
  });
}

function directPreviewAvailable(version: typeof assetVersions.$inferSelect): boolean {
  if (version.mediaProbe === null) return false;
  const parsed = sourceMediaProbeResultSchema.safeParse(version.mediaProbe);
  return parsed.success && parsed.data.capabilities.preview === 'AVAILABLE';
}

export async function createAssetPlaybackUrl(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; ttlSeconds?: number },
): Promise<MediaPlaybackResponse> {
  const storage = deps.storage;
  if (storage === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'object storage is not configured', 500);
  const rows = await deps.db.select({ asset: assets, version: assetVersions }).from(assets)
    .innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset not found', 404);
  if (row.version.status !== 'READY' || row.version.checksumSha256 === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'source asset is not ready for playback', 409, { reason: 'SOURCE_NOT_READY' });
  }
  const derivatives = await deps.db.select().from(mediaDerivatives).where(and(
    eq(mediaDerivatives.workspaceId, input.workspaceId),
    eq(mediaDerivatives.sourceAssetVersionId, row.version.id),
    eq(mediaDerivatives.kind, 'PROXY'),
  )).orderBy(desc(mediaDerivatives.updatedAt)).limit(1);
  const derivative = derivatives[0];
  const ttlSeconds = Math.min(input.ttlSeconds ?? DOWNLOAD_URL_TTL_SECONDS, MAX_SIGNED_URL_TTL_SECONDS);
  let proxyStatus: MediaPlaybackResponse['proxyStatus'] = derivative === undefined
    ? 'NOT_REQUIRED'
    : derivative.status === 'READY' || derivative.status === 'FAILED' || derivative.status === 'PROCESSING' || derivative.status === 'PENDING'
      ? derivative.status
      : 'FAILED';
  if (derivative?.status === 'READY' && derivative.derivativeAssetVersionId !== null) {
    const outputs = await deps.db.select().from(assetVersions).where(and(
      eq(assetVersions.id, derivative.derivativeAssetVersionId), eq(assetVersions.workspaceId, input.workspaceId),
    )).limit(1);
    const output = outputs[0];
    if (output?.status === 'READY') {
      const object = await storage.probeObject(output.storageKey);
      if (object.exists) {
        const target = await storage.createDownloadUrl({ key: output.storageKey, ttlSeconds, downloadFilename: `proxy-${row.asset.id}.${output.mimeType === 'audio/mp4' ? 'm4a' : 'mp4'}` });
        const metadata = mediaProxyTranscodeResultSchema.safeParse(derivative.metadata);
        return mediaPlaybackResponseSchema.parse({
          assetId: row.asset.id,
          sourceVersionId: row.version.id,
          rendition: 'PROXY',
          renditionVersionId: output.id,
          mimeType: output.mimeType,
          url: target.url,
          expiresAt: target.expiresAt,
          proxyStatus: 'READY',
          proxyProfileKey: derivative.profileKey,
          timeMappings: metadata.success ? metadata.data.timeMappings : [],
          message: null,
        });
      }
    }
    proxyStatus = 'MISSING';
  }
  if (directPreviewAvailable(row.version)) {
    const target = await storage.createDownloadUrl({ key: row.version.storageKey, ttlSeconds, downloadFilename: row.version.storageKey.split('/').pop() });
    return mediaPlaybackResponseSchema.parse({
      assetId: row.asset.id,
      sourceVersionId: row.version.id,
      rendition: 'ORIGINAL',
      renditionVersionId: row.version.id,
      mimeType: row.version.mimeType,
      url: target.url,
      expiresAt: target.expiresAt,
      proxyStatus,
      proxyProfileKey: derivative?.profileKey ?? null,
      timeMappings: [],
      message: derivative === undefined ? '尚未创建标准编辑代理，当前使用原件。' : proxyStatus === 'FAILED' ? '编辑代理生成失败，当前使用可直接预览的原件。' : proxyStatus === 'MISSING' ? '编辑代理已丢失，当前使用原件；可重新生成代理。' : '编辑代理正在生成，当前使用原件。',
    });
  }
  return mediaPlaybackResponseSchema.parse({
    assetId: row.asset.id,
    sourceVersionId: row.version.id,
    rendition: null,
    renditionVersionId: null,
    mimeType: null,
    url: null,
    expiresAt: null,
    proxyStatus,
    proxyProfileKey: derivative?.profileKey ?? null,
    timeMappings: [],
    message: proxyStatus === 'FAILED' ? '编辑代理生成失败，请重新生成。' : proxyStatus === 'MISSING' ? '编辑代理文件缺失，请重新生成。' : '原件不能直接预览，编辑代理尚未就绪。',
  });
}

export async function rebuildMediaProxy(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string },
): Promise<MediaPlaybackResponse> {
  const storage = deps.storage;
  if (storage === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'object storage is not configured', 500);
  const rows = await deps.db.select({ asset: assets, version: assetVersions }).from(assets)
    .innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.version.mediaProbe === null || row.version.checksumSha256 === null) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'probed source asset not found', 404);
  const derivativeRows = await deps.db.select().from(mediaDerivatives).where(and(
    eq(mediaDerivatives.workspaceId, input.workspaceId), eq(mediaDerivatives.sourceAssetVersionId, row.version.id), eq(mediaDerivatives.kind, 'PROXY'),
  )).orderBy(desc(mediaDerivatives.updatedAt)).limit(1);
  const derivative = derivativeRows[0];
  if (!derivative) {
    await deps.db.transaction(async (tx) => scheduleMediaProxyInTx(tx, {
      workspaceId: input.workspaceId, projectId: row.asset.projectId, sourceAsset: row.asset, sourceVersion: row.version,
      probe: sourceMediaProbeResultSchema.parse(row.version.mediaProbe),
    }));
    return createAssetPlaybackUrl(deps, input);
  }
  if (derivative.status === 'PENDING' || derivative.status === 'PROCESSING') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'media proxy is already queued or processing', 409, { reason: 'PROXY_ALREADY_RUNNING' });
  }
  if (derivative.derivativeAssetVersionId === null) throw new ApiFailure(ERROR_CODES.INTERNAL, 'proxy derivative output version is missing', 500);
  const outputRows = await deps.db.select().from(assetVersions).where(and(
    eq(assetVersions.id, derivative.derivativeAssetVersionId), eq(assetVersions.workspaceId, input.workspaceId),
  )).limit(1);
  const output = outputRows[0];
  if (!output) throw new ApiFailure(ERROR_CODES.INTERNAL, 'proxy output version is missing', 500);
  if (derivative.status === 'READY' && (await storage.probeObject(output.storageKey)).exists) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'media proxy is already ready', 409, { reason: 'PROXY_ALREADY_READY' });
  }
  const outputAssetRows = await deps.db.select().from(assets).where(and(eq(assets.id, output.assetId), eq(assets.workspaceId, input.workspaceId))).limit(1);
  const outputAsset = outputAssetRows[0];
  if (!outputAsset) throw new ApiFailure(ERROR_CODES.INTERNAL, 'proxy output asset is missing', 500);
  const jobInput = mediaProxyJobInputSchema.parse({
    derivativeId: derivative.id,
    sourceAssetId: row.asset.id,
    sourceAssetVersionId: row.version.id,
    outputAssetId: outputAsset.id,
    outputAssetVersionId: output.id,
    sourceStorageKey: row.version.storageKey,
    outputStorageKey: output.storageKey,
    sourceChecksumSha256: row.version.checksumSha256,
    profileKey: derivative.profileKey,
  });
  await deps.db.transaction(async (tx) => {
    await tx.update(mediaDerivatives).set({ status: 'PENDING', errorSummary: null, updatedAt: new Date() }).where(eq(mediaDerivatives.id, derivative.id));
    await tx.update(assetVersions).set({ status: 'UPLOADING', checksumSha256: null, sizeBytes: 0 }).where(eq(assetVersions.id, output.id));
    await tx.update(assets).set({ status: 'PROCESSING', updatedAt: new Date() }).where(eq(assets.id, outputAsset.id));
    await createJobInTx(tx, { workspaceId: input.workspaceId, projectId: row.asset.projectId, type: MEDIA_PROXY_JOB_TYPE, input: jobInput, maxAttempts: 2, createdBy: row.asset.createdBy, classification: 'SYSTEM' });
  });
  return createAssetPlaybackUrl(deps, input);
}
