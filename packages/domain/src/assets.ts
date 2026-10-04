import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ASSET_DEFAULT_RETENTION,
  ASSET_MIME_ALLOWLIST,
  DIRECT_UPLOAD_ASSET_TYPES,
  DOWNLOAD_URL_TTL_SECONDS,
  ERROR_CODES,
  MAX_SIGNED_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
  assetDetailSchema,
  assetSchema,
  assetVersionSchema,
  downloadUrlResponseSchema,
  licenseMetadataSchema,
  mimeMatches,
  probeImageDimensions,
  sniffMimeType,
  uploadIntentResponseSchema,
  type Asset,
  type AssetDetail,
  type AssetOrigin,
  type AssetType,
  type ConfirmUploadRequest,
  createUploadIntentRequestSchema,
  type CreateUploadIntentInput,
  type DownloadUrlResponse,
  type LicenseMetadata,
} from '@ancs/contracts';
import { assetVersions, assets, projects, scenes, uploadIntents } from '@ancs/db';
import type { DomainDeps } from './channels.js';

/**
 * 资产服务（P02-04 / 规范 §22.5、§26、§27；计划 P02-04）。
 *
 * 流程（§26.1）：POST upload-intents（校验类型/MIME/大小 → 建 Asset+AssetVersion+UploadIntent
 * → 签发带作用域与 TTL 的直传 URL）→ 客户端直传 → confirm（服务端**真实探测**：存在性/大小/
 * SHA-256/内容嗅探 → 通过才 Ready；重复确认幂等）。
 *
 * 安全要点：
 * - 所有查询强制 workspace_id（§4.3 不变量 1）；跨租户一律 404 抗枚举；
 * - 数据库只存 storage_key（§26）；下载经 Signed URL（§26.2）；
 * - "伪造 MIME / 越权对象 / 不完整上传" 一律不可 Ready（计划 P02-04 验收）。
 */

const ORIGIN_BY_ASSET_TYPE: Readonly<Partial<Record<AssetType, AssetOrigin>>> = {
  SOURCE_DOCUMENT: 'SOURCE_IMPORT',
  SOURCE_IMAGE: 'SOURCE_IMPORT',
  USER_UPLOAD: 'USER_UPLOAD',
  AVATAR_CLIP: 'USER_UPLOAD',
  VOICE_AUDIO: 'USER_UPLOAD',
  MUSIC: 'USER_UPLOAD',
  SUBTITLE: 'USER_UPLOAD',
};

const CATEGORY_BY_ASSET_TYPE: Readonly<Partial<Record<AssetType, string>>> = {
  SOURCE_DOCUMENT: 'sources',
  SOURCE_IMAGE: 'sources',
  USER_UPLOAD: 'uploads',
  AVATAR_CLIP: 'scenes',
  VOICE_AUDIO: 'audio',
  MUSIC: 'audio',
  SUBTITLE: 'scenes',
  DRAFT_RENDER: 'renders',
  FINAL_VIDEO: 'exports',
  SHORT_VIDEO: 'exports',
  THUMBNAIL: 'renders',
  MANIFEST: 'renders',
};

export function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : 'file';
}

/** §26 逻辑路径：workspaces/{ws}/projects/{project|library}/{category}/assets/{assetId}/v{n}/{filename} */
export function buildStorageKey(input: {
  workspaceId: string;
  projectId: string | null;
  assetType: AssetType;
  assetId: string;
  versionNumber: number;
  filename: string;
}): string {
  const scope = input.projectId === null ? 'library' : `projects/${input.projectId}`;
  const category = CATEGORY_BY_ASSET_TYPE[input.assetType] ?? 'uploads';
  return `workspaces/${input.workspaceId}/${scope}/${category}/assets/${input.assetId}/v${String(input.versionNumber)}/${sanitizeFilename(input.filename)}`;
}

function requireStorage(deps: DomainDeps) {
  if (deps.storage === undefined) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, '对象存储适配器未配置（DomainDeps.storage）', 500);
  }
  return deps.storage;
}

const toAssetDto = (row: typeof assets.$inferSelect): Asset =>
  assetSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sceneId: row.sceneId,
    assetType: row.assetType,
    origin: row.origin,
    provider: row.provider,
    providerAssetId: row.providerAssetId,
    status: row.status,
    retentionClass: row.retentionClass,
    license: licenseMetadataSchema.parse(row.license),
    metadata: row.metadata,
    currentVersionId: row.currentVersionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

const toVersionDto = (row: typeof assetVersions.$inferSelect) =>
  assetVersionSchema.parse({
    id: row.id,
    assetId: row.assetId,
    versionNumber: row.versionNumber,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    checksumSha256: row.checksumSha256,
    durationMs: row.durationMs,
    width: row.width,
    height: row.height,
    status: row.status,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  });

function defaultLicense(input: CreateUploadIntentInput, origin: AssetOrigin, userId: string | null): LicenseMetadata {
  const now = new Date().toISOString();
  if (input.license !== undefined) {
    return licenseMetadataSchema.parse({
      type: input.license.type,
      holder: input.license.holder ?? null,
      attribution: input.license.attribution ?? null,
      sourceUrl: input.license.sourceUrl ?? null,
      termsUrl: input.license.termsUrl ?? null,
      notes: input.license.notes ?? null,
      confirmedBy: userId,
      confirmedAt: now,
    });
  }
  const fallback = origin === 'PROVIDER_GENERATED' || origin === 'SYSTEM_RENDER' ? 'PROVIDER_TERMS' : 'USER_OWNED';
  return licenseMetadataSchema.parse({ type: fallback, confirmedBy: userId, confirmedAt: now });
}

async function loadAssetRow(
  deps: DomainDeps,
  workspaceId: string,
  assetId: string,
): Promise<typeof assets.$inferSelect> {
  const rows = await deps.db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId), isNull(assets.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset not found', 404);
  return row;
}

export async function createUploadIntent(
  deps: DomainDeps,
  input: { workspaceId: string; userId: string | null; input: CreateUploadIntentInput },
): Promise<ReturnType<typeof uploadIntentResponseSchema.parse>> {
  const storage = requireStorage(deps);
  const { workspaceId, userId } = input;
  const request = createUploadIntentRequestSchema.parse(input.input);

  if (!DIRECT_UPLOAD_ASSET_TYPES.includes(request.assetType)) {
    throw new ApiFailure(
      ERROR_CODES.CAPABILITY_UNAVAILABLE,
      `资产类型 ${request.assetType} 不支持直传（生成类资产由 Provider 回收链路创建，P03-06/P06）`,
      501,
      { assetType: request.assetType, plannedPhase: 'P03-06（Provider 结果回收）' },
    );
  }

  const allowed = ASSET_MIME_ALLOWLIST[request.assetType];
  if (!allowed.includes(request.contentType)) {
    throw new ApiFailure(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, `资产类型 ${request.assetType} 不接受 ${request.contentType}`, 415, {
      assetType: request.assetType,
      declaredContentType: request.contentType,
      allowedContentTypes: allowed,
    });
  }

  if (request.projectId !== null) {
    const projectRows = await deps.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, request.projectId), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    if (projectRows.length === 0) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  }
  if (request.sceneId !== null) {
    const sceneRows = await deps.db
      .select({ id: scenes.id })
      .from(scenes)
      .where(and(eq(scenes.id, request.sceneId), eq(scenes.workspaceId, workspaceId)))
      .limit(1);
    if (sceneRows.length === 0) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'scene not found', 404);
  }

  const origin: AssetOrigin = ORIGIN_BY_ASSET_TYPE[request.assetType] ?? 'USER_UPLOAD';

  // workspace 内哈希去重（§26.3）：命中则不创建对象，客户端可直接绑定既有资产
  if (request.checksumSha256 !== undefined) {
    const existingRows = await deps.db
      .select({ asset: assets, version: assetVersions })
      .from(assetVersions)
      .innerJoin(assets, eq(assets.id, assetVersions.assetId))
      .where(
        and(
          eq(assetVersions.workspaceId, workspaceId),
          eq(assetVersions.checksumSha256, request.checksumSha256),
          eq(assetVersions.status, 'READY'),
          eq(assets.status, 'READY'),
          isNull(assets.deletedAt),
          isNull(assetVersions.deletedAt),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      return uploadIntentResponseSchema.parse({
        intentId: null,
        upload: null,
        expiresAt: null,
        deduped: true,
        asset: toAssetDto(existing.asset),
      });
    }
  }

  const assetId = `ast_${randomUUID()}`;
  const versionId = `av_${randomUUID()}`;
  const intentId = `upi_${randomUUID()}`;
  const storageKey = buildStorageKey({
    workspaceId,
    projectId: request.projectId,
    assetType: request.assetType,
    assetId,
    versionNumber: 1,
    filename: request.filename,
  });
  const now = new Date();
  const uploadTtlSeconds = deps.uploadIntentTtlSeconds ?? UPLOAD_URL_TTL_SECONDS;
  const expiresAt = new Date(now.getTime() + uploadTtlSeconds * 1000);
  const license = defaultLicense(request, origin, userId);

  await deps.db.transaction(async (tx) => {
    await tx.insert(assets).values({
      id: assetId,
      workspaceId,
      projectId: request.projectId,
      sceneId: request.sceneId,
      assetType: request.assetType,
      origin,
      status: 'PENDING_UPLOAD',
      retentionClass: ASSET_DEFAULT_RETENTION[request.assetType],
      license,
      metadata: {},
      createdBy: userId,
    });
    await tx.insert(assetVersions).values({
      id: versionId,
      assetId,
      workspaceId,
      versionNumber: 1,
      storageKey,
      mimeType: request.contentType,
      sizeBytes: request.sizeBytes,
      checksumSha256: request.checksumSha256 ?? null,
      status: 'UPLOADING',
      metadata: {},
    });
    await tx.insert(uploadIntents).values({
      id: intentId,
      workspaceId,
      assetId,
      assetVersionId: versionId,
      storageKey,
      expectedMimeType: request.contentType,
      expectedSizeBytes: request.sizeBytes,
      expectedChecksumSha256: request.checksumSha256 ?? null,
      status: 'PENDING',
      expiresAt,
      createdBy: userId,
    });
  });

  const upload = await storage.createUploadTarget({
    key: storageKey,
    contentType: request.contentType,
    maxBytes: request.sizeBytes,
    ttlSeconds: uploadTtlSeconds,
    scope: { workspaceId, assetId, versionId },
  });

  const assetRows = await deps.db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  const assetRow = assetRows[0];
  if (!assetRow) throw new ApiFailure(ERROR_CODES.INTERNAL, 'asset insert failed', 500);

  return uploadIntentResponseSchema.parse({
    intentId,
    upload,
    expiresAt: expiresAt.toISOString(),
    deduped: false,
    asset: toAssetDto(assetRow),
  });
}

/** 上传失败的状态收敛（伪造 MIME / 校验和不符：版本 FAILED、意图 FAILED、对象删除）。 */
async function failUpload(
  deps: DomainDeps,
  args: { workspaceId: string; assetId: string; versionId: string; intentId: string; storageKey: string; reason: string },
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await tx
      .update(assetVersions)
      .set({ status: 'FAILED', metadata: { failureReason: args.reason } })
      .where(and(eq(assetVersions.id, args.versionId), eq(assetVersions.workspaceId, args.workspaceId)));
    await tx
      .update(assets)
      .set({ status: 'FAILED', updatedAt: new Date() })
      .where(and(eq(assets.id, args.assetId), eq(assets.workspaceId, args.workspaceId)));
    await tx
      .update(uploadIntents)
      .set({ status: 'FAILED', completedAt: new Date() })
      .where(and(eq(uploadIntents.id, args.intentId), eq(uploadIntents.workspaceId, args.workspaceId)));
  });
  await requireStorage(deps).deleteObject(args.storageKey);
}

export async function confirmUpload(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; input: ConfirmUploadRequest },
): Promise<AssetDetail> {
  const storage = requireStorage(deps);
  const { workspaceId, assetId } = input;
  const asset = await loadAssetRow(deps, workspaceId, assetId);

  const intentRows = await deps.db
    .select()
    .from(uploadIntents)
    .where(and(eq(uploadIntents.assetId, assetId), eq(uploadIntents.workspaceId, workspaceId)))
    .orderBy(desc(uploadIntents.createdAt))
    .limit(1);
  const intent = intentRows[0];
  if (!intent) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'upload intent not found', 404);

  // 幂等：已完成 → 直接返回当前结果（不重复副作用）
  if (intent.status === 'COMPLETED' || asset.status === 'READY') {
    return getAsset(deps, { workspaceId, assetId });
  }
  if (intent.status === 'FAILED' || asset.status === 'FAILED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '该上传已被标记失败（伪造 MIME 或校验和不符）', 409, {
      reason: 'UPLOAD_FAILED',
    });
  }
  if (intent.status === 'EXPIRED' || intent.expiresAt.getTime() <= Date.now()) {
    await deps.db
      .update(uploadIntents)
      .set({ status: 'EXPIRED' })
      .where(and(eq(uploadIntents.id, intent.id), eq(uploadIntents.workspaceId, workspaceId)));
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '上传意图已过期（请重新创建上传意图）', 409, {
      reason: 'INTENT_EXPIRED',
    });
  }

  // 真实探测：存在性与大小
  const probe = await storage.probeObject(intent.storageKey);
  if (!probe.exists) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '上传未完成：对象不存在', 409, { reason: 'OBJECT_MISSING' });
  }
  if (probe.sizeBytes !== Number(intent.expectedSizeBytes)) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '上传不完整：实际大小与声明的 sizeBytes 不一致', 409, {
      reason: 'SIZE_MISMATCH',
      expectedSizeBytes: Number(intent.expectedSizeBytes),
      actualSizeBytes: probe.sizeBytes,
    });
  }

  // 内容嗅探（伪造 MIME ↔ 实际内容）
  const prefix = (await storage.readObjectPrefix(intent.storageKey, 64)) ?? new Uint8Array();
  const sniffed = sniffMimeType(prefix);
  if (!mimeMatches(intent.expectedMimeType, sniffed)) {
    await failUpload(deps, {
      workspaceId,
      assetId,
      versionId: intent.assetVersionId,
      intentId: intent.id,
      storageKey: intent.storageKey,
      reason: 'MIME_MISMATCH',
    });
    throw new ApiFailure(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, '内容与声明的内容类型不符（疑似伪造 MIME）', 415, {
      declaredMimeType: intent.expectedMimeType,
      sniffedMimeType: sniffed,
    });
  }

  // 校验和（客户端在意图或确认阶段声明的 SHA-256 必须与服务端计算结果一致）
  const actualSha = await storage.computeObjectSha256(intent.storageKey);
  if (actualSha === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '上传未完成：对象不可读', 409, { reason: 'OBJECT_UNREADABLE' });
  }
  const declaredSha = input.input.checksumSha256 ?? intent.expectedChecksumSha256 ?? null;
  if (declaredSha !== null && actualSha !== declaredSha) {
    await failUpload(deps, {
      workspaceId,
      assetId,
      versionId: intent.assetVersionId,
      intentId: intent.id,
      storageKey: intent.storageKey,
      reason: 'CHECKSUM_MISMATCH',
    });
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '校验和不符（上传内容被破坏或与声明不一致）', 409, {
      reason: 'CHECKSUM_MISMATCH',
      expectedChecksumSha256: declaredSha,
      actualChecksumSha256: actualSha,
    });
  }

  // 探测元数据（真实可探测的字段以探测为准；其余按确认请求声明记录）
  const probedDimensions = probeImageDimensions(prefix, sniffed);
  const declared = {
    ...(input.input.durationMs !== undefined ? { durationMs: input.input.durationMs } : {}),
    ...(input.input.width !== undefined ? { width: input.input.width } : {}),
    ...(input.input.height !== undefined ? { height: input.input.height } : {}),
  };

  // 去重（确认阶段）：同 workspace 已有相同 checksum+size 的 READY 版本 → 复用对象，删除本次上传
  const duplicateRows = await deps.db
    .select({ asset: assets, version: assetVersions })
    .from(assetVersions)
    .innerJoin(assets, eq(assets.id, assetVersions.assetId))
    .where(
      and(
        eq(assetVersions.workspaceId, workspaceId),
        eq(assetVersions.checksumSha256, actualSha),
        eq(assetVersions.status, 'READY'),
        eq(assets.status, 'READY'),
        ne(assetVersions.assetId, assetId),
        isNull(assets.deletedAt),
        isNull(assetVersions.deletedAt),
      ),
    )
    .limit(1);
  const duplicate = duplicateRows[0];

  const now = new Date();
  let deletedDuplicateObject = false;
  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from assets where id = ${assetId} for update`);
    const freshIntents = await tx
      .select()
      .from(uploadIntents)
      .where(and(eq(uploadIntents.id, intent.id), eq(uploadIntents.workspaceId, workspaceId)))
      .limit(1);
    const fresh = freshIntents[0];
    if (!fresh || fresh.status !== 'PENDING') return; // 并发确认由另一请求完成（幂等）

    await tx
      .update(assetVersions)
      .set({
        status: 'READY',
        checksumSha256: actualSha,
        sizeBytes: probe.sizeBytes,
        mimeType: intent.expectedMimeType,
        width: probedDimensions?.width ?? input.input.width ?? null,
        height: probedDimensions?.height ?? input.input.height ?? null,
        durationMs: input.input.durationMs ?? null,
        storageKey: duplicate ? duplicate.version.storageKey : intent.storageKey,
        metadata: {
          probed: { mimeType: sniffed, ...(probedDimensions ?? {}), sizeBytes: probe.sizeBytes },
          ...(Object.keys(declared).length > 0 ? { declared } : {}),
          ...(duplicate ? { dedupeOf: { assetId: duplicate.asset.id, versionId: duplicate.version.id } } : {}),
        },
      })
      .where(and(eq(assetVersions.id, intent.assetVersionId), eq(assetVersions.workspaceId, workspaceId)));
    await tx
      .update(assets)
      .set({
        status: 'READY',
        currentVersionId: intent.assetVersionId,
        updatedAt: now,
        metadata: duplicate ? { deduplicatedFrom: duplicate.asset.id } : {},
      })
      .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)));
    await tx
      .update(uploadIntents)
      .set({ status: 'COMPLETED', completedAt: now })
      .where(and(eq(uploadIntents.id, intent.id), eq(uploadIntents.workspaceId, workspaceId)));
    deletedDuplicateObject = duplicate !== undefined;
  });

  // 去重时删除本次上传的冗余对象（事务提交后）
  if (deletedDuplicateObject) {
    await storage.deleteObject(intent.storageKey);
  }

  return getAsset(deps, { workspaceId, assetId });
}

export async function listAssets(
  deps: DomainDeps,
  input: { workspaceId: string; projectId?: string; assetType?: AssetType },
): Promise<Asset[]> {
  const conditions = [eq(assets.workspaceId, input.workspaceId), isNull(assets.deletedAt)];
  if (input.projectId !== undefined) conditions.push(eq(assets.projectId, input.projectId));
  if (input.assetType !== undefined) conditions.push(eq(assets.assetType, input.assetType));
  const rows = await deps.db
    .select()
    .from(assets)
    .where(and(...conditions))
    .orderBy(desc(assets.createdAt));
  return rows.map(toAssetDto);
}

export async function getAsset(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string },
): Promise<AssetDetail> {
  const asset = await loadAssetRow(deps, input.workspaceId, input.assetId);
  const versionRows = await deps.db
    .select()
    .from(assetVersions)
    .where(and(eq(assetVersions.assetId, asset.id), eq(assetVersions.workspaceId, input.workspaceId)))
    .orderBy(assetVersions.versionNumber);
  return assetDetailSchema.parse({ ...toAssetDto(asset), versions: versionRows.map(toVersionDto) });
}

export async function createAssetDownloadUrl(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; ttlSeconds?: number },
): Promise<DownloadUrlResponse> {
  const storage = requireStorage(deps);
  const asset = await loadAssetRow(deps, input.workspaceId, input.assetId);
  if (asset.status !== 'READY' || asset.currentVersionId === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '资产尚未就绪（不可下载）', 409, { status: asset.status });
  }
  const versionRows = await deps.db
    .select()
    .from(assetVersions)
    .where(and(eq(assetVersions.id, asset.currentVersionId), eq(assetVersions.workspaceId, input.workspaceId)))
    .limit(1);
  const version = versionRows[0];
  if (!version) throw new ApiFailure(ERROR_CODES.INTERNAL, 'asset current version missing（数据不一致）', 500);

  const ttlSeconds = Math.min(input.ttlSeconds ?? DOWNLOAD_URL_TTL_SECONDS, MAX_SIGNED_URL_TTL_SECONDS);
  const target = await storage.createDownloadUrl({
    key: version.storageKey,
    ttlSeconds,
    downloadFilename: version.storageKey.split('/').pop(),
  });
  return downloadUrlResponseSchema.parse({
    assetId: asset.id,
    versionId: version.id,
    url: target.url,
    expiresAt: target.expiresAt,
  });
}

/** 绑定校验（replace_asset 用）：READY + 同 workspace + 项目归属兼容。 */
export async function assertAssetBindable(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; projectId: string },
): Promise<{ assetId: string; currentVersionId: string }> {
  const asset = await loadAssetRow(deps, input.workspaceId, input.assetId);
  if (asset.status !== 'READY' || asset.currentVersionId === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '资产尚未就绪，不能绑定到 Scene', 409, {
      assetId: input.assetId,
      status: asset.status,
    });
  }
  if (asset.projectId !== null && asset.projectId !== input.projectId) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '资产属于其他项目', 409, {
      assetId: input.assetId,
      assetProjectId: asset.projectId,
    });
  }
  return { assetId: asset.id, currentVersionId: asset.currentVersionId };
}
