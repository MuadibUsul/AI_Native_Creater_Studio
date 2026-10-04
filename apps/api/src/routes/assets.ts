import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  assetDetailSchema,
  assetSchema,
  assetTypeSchema,
  confirmUploadRequestSchema,
  createUploadIntentRequestSchema,
  downloadUrlResponseSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  uploadIntentResponseSchema,
} from '@ancs/contracts';
import {
  confirmUpload,
  createAssetDownloadUrl,
  createUploadIntent,
  getAsset,
  listAssets,
  restoreAsset,
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
