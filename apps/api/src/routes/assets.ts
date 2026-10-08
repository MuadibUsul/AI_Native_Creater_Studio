import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  assetDetailSchema,
  assetSchema,
  assetTypeSchema,
  confirmUploadRequestSchema,
  completeUploadPartRequestSchema,
  createUploadIntentRequestSchema,
  downloadUrlResponseSchema,
  mediaPlaybackResponseSchema,
  mediaIndexPageSchema,
  mediaIndexQuerySchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  uploadIntentResponseSchema,
  uploadIntentStatusSchema,
  uploadPartTargetResponseSchema,
} from '@ancs/contracts';
import {
  confirmUpload,
  cancelUploadIntent,
  completeUploadPart,
  createUploadPartTarget,
  createAssetDownloadUrl,
  createAssetPlaybackUrl,
  createUploadIntent,
  getAsset,
  getUploadIntentStatus,
  listAssets,
  restoreAsset,
  rebuildMediaProxy,
  listMediaIndex,
  rebuildMediaIndex,
  softDeleteAsset,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';
import type { StorageDeps } from '../plugins/storage.js';

/**
 * 资产路由（P02-04 / 规范 §26、§51）。
 *
 * 授权：读取（列表/详情/下载 URL）需 workspace:read；写（上传意图/确认）需 asset:manage
 * （EDITOR 及以上）。所有服务层查询再强制 workspace_id（§4.3 不变量 1/2）。
 */

const wsParamsSchema = z.object({ id: opaqueIdSchema });
const assetParamsSchema = z.object({ id: opaqueIdSchema, assetId: opaqueIdSchema });
const intentParamsSchema = z.object({ id: opaqueIdSchema, intentId: opaqueIdSchema });
const partParamsSchema = intentParamsSchema.extend({ partNumber: z.coerce.number().int().positive() });
const assetListQuerySchema = z.object({
  projectId: opaqueIdSchema.optional(),
  assetType: assetTypeSchema.optional(),
  /** Trash 视图（默认排除已软删资产） */
  trashed: z.enum(['true', 'false']).optional(),
});
const assetListSchema = pageResponseSchema(assetSchema);
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

export function registerAssetRoutes(app: FastifyInstance, deps: AuthDeps, storage: StorageDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db, storage: storage.adapter };

  typed.post(
    '/workspaces/:id/assets/upload-intents',
    {
      schema: {
        tags: ['assets'],
        summary: '创建上传意图（返回带作用域与 TTL 的直传 Signed URL；命中 workspace 哈希去重时不创建对象）',
        params: wsParamsSchema,
        body: createUploadIntentRequestSchema,
        response: {
          201: uploadIntentResponseSchema,
          415: errorEnvelopeSchema,
          501: errorEnvelopeSchema,
          ...ERROR_RESPONSES,
        },
      },
    },
    async (request, reply) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'asset:manage');
      const result = await createUploadIntent(domain, {
        workspaceId: request.params.id,
        userId: context.userId,
        input: request.body,
      });
      return reply.status(201).send(result);
    },
  );

  typed.get(
    '/workspaces/:id/assets/:assetId/media-index',
    {
      schema: {
        tags: ['assets'],
        summary: '分页读取绑定源 AssetVersion 的缩略、波形、镜头和质量索引',
        params: assetParamsSchema,
        querystring: mediaIndexQuerySchema,
        response: { 200: mediaIndexPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return listMediaIndex(domain, { workspaceId: request.params.id, assetId: request.params.assetId, ...request.query });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/media-index/rebuild',
    {
      schema: {
        tags: ['assets'],
        summary: '重新生成失败、过期或已完成的源媒体索引；不修改原件和代理',
        params: assetParamsSchema,
        response: { 200: mediaIndexPageSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return rebuildMediaIndex(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.get(
    '/workspaces/:id/assets/upload-intents/:intentId',
    {
      schema: {
        tags: ['assets'],
        summary: '读取可恢复上传意图与已确认分片',
        params: intentParamsSchema,
        response: { 200: uploadIntentStatusSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return getUploadIntentStatus(domain, { workspaceId: request.params.id, intentId: request.params.intentId });
    },
  );

  typed.post(
    '/workspaces/:id/assets/upload-intents/:intentId/parts/:partNumber',
    {
      schema: {
        tags: ['assets'],
        summary: '为单个未确认分片签发短期直传地址',
        params: partParamsSchema,
        response: { 200: uploadPartTargetResponseSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return createUploadPartTarget(domain, {
        workspaceId: request.params.id,
        intentId: request.params.intentId,
        partNumber: request.params.partNumber,
      });
    },
  );

  typed.post(
    '/workspaces/:id/assets/upload-intents/:intentId/parts/:partNumber/complete',
    {
      schema: {
        tags: ['assets'],
        summary: '校验并确认一个上传分片',
        params: partParamsSchema,
        body: completeUploadPartRequestSchema,
        response: { 200: uploadIntentStatusSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return completeUploadPart(domain, {
        workspaceId: request.params.id,
        intentId: request.params.intentId,
        partNumber: request.params.partNumber,
        input: request.body,
      });
    },
  );

  typed.delete(
    '/workspaces/:id/assets/upload-intents/:intentId',
    {
      schema: {
        tags: ['assets'],
        summary: '取消未完成上传并清理已上传分片',
        params: intentParamsSchema,
        response: { 200: uploadIntentStatusSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return cancelUploadIntent(domain, { workspaceId: request.params.id, intentId: request.params.intentId });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/confirm',
    {
      schema: {
        tags: ['assets'],
        summary: '确认上传（服务端真实探测：存在性/大小/SHA-256/内容嗅探；重复确认幂等）',
        params: assetParamsSchema,
        body: confirmUploadRequestSchema,
        response: { 200: assetDetailSchema, 409: errorEnvelopeSchema, 415: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return confirmUpload(domain, { workspaceId: request.params.id, assetId: request.params.assetId, input: request.body });
    },
  );

  typed.get(
    '/workspaces/:id/assets',
    {
      schema: {
        tags: ['assets'],
        summary: '资产列表（workspace 内，可按 projectId / assetType 过滤）',
        params: wsParamsSchema,
        querystring: assetListQuerySchema,
        response: { 200: assetListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      const items = await listAssets(domain, {
        workspaceId: request.params.id,
        projectId: request.query.projectId,
        assetType: request.query.assetType,
        trashed: request.query.trashed === 'true',
      });
      return { items, nextCursor: null };
    },
  );

  typed.get(
    '/workspaces/:id/assets/:assetId',
    {
      schema: {
        tags: ['assets'],
        summary: '资产详情（含版本历史；只存 storage_key，不含任何对象 URL）',
        params: assetParamsSchema,
        response: { 200: assetDetailSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return getAsset(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.get(
    '/workspaces/:id/assets/:assetId/download-url',
    {
      schema: {
        tags: ['assets'],
        summary: '签发下载 Signed URL（短 TTL；不经 API 流式代理大文件，§26.2）',
        params: assetParamsSchema,
        response: { 200: downloadUrlResponseSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return createAssetDownloadUrl(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.get(
    '/workspaces/:id/assets/:assetId/playback-url',
    {
      schema: {
        tags: ['assets'],
        summary: '签发当前可用播放地址（优先标准代理；代理未就绪时仅在原件可直接预览时回退）',
        params: assetParamsSchema,
        response: { 200: mediaPlaybackResponseSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return createAssetPlaybackUrl(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/proxy/rebuild',
    {
      schema: {
        tags: ['assets'],
        summary: '重新生成失败或丢失的编辑代理（原件与 checksum 保持不变）',
        params: assetParamsSchema,
        response: { 200: mediaPlaybackResponseSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return rebuildMediaProxy(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.delete(
    '/workspaces/:id/assets/:assetId',
    {
      schema: {
        tags: ['assets'],
        summary: '软删除资产（Trash，保留 30 天；引用保护由清理流程执行，§27）',
        params: assetParamsSchema,
        response: { 200: assetSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return softDeleteAsset(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/restore',
    {
      schema: {
        tags: ['assets'],
        summary: '从 Trash 恢复资产（保留期内）',
        params: assetParamsSchema,
        response: { 200: assetSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return restoreAsset(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );
}
