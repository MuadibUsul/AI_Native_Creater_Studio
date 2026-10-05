import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  errorEnvelopeSchema,
  opaqueIdSchema,
  stockAcquisitionResultSchema,
  stockAssetKindSchema,
  stockSearchResultSchema,
  type AssetSearchProvider,
} from '@ancs/contracts';
import { acquireStockAsset, searchStockAssets, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * 素材搜索/获取路由（P10-03 / §84、§12）。
 * - 搜索：结果**携带许可状态**（不可用结果可见但明确标注，不自称已授权）；
 * - 获取：服务端 `lookup` **复核许可** → 不可用 422 LICENSE_REQUIRED；入库固化 origin/许可/署名。
 * 未装配搜索 Provider → 501 fail-closed。
 */

const workspaceParamsSchema = z.object({ id: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema };

export interface StockRouteDeps {
  stockSearch?: AssetSearchProvider;
}

export function registerStockRoutes(app: FastifyInstance, deps: AuthDeps, stockDeps: StockRouteDeps = {}, storage?: import('@ancs/contracts').ObjectStorageAdapter): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db, ...(storage !== undefined ? { storage } : {}) };

  typed.get(
    '/workspaces/:id/stock/search',
    {
      schema: {
        tags: ['stock'],
        summary: '素材搜索（许可状态随结果返回；usable=false 明确原因——不自称已授权）',
        params: workspaceParamsSchema,
        querystring: z.object({
          query: z.string().max(200).optional(),
          kind: stockAssetKindSchema.optional(),
          usableOnly: z.coerce.boolean().optional(),
          limit: z.coerce.number().int().positive().max(50).optional(),
        }),
        response: { 200: z.object({ providerId: z.string(), items: z.array(stockSearchResultSchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return searchStockAssets(domain, { workspaceId: request.params.id, request: request.query, provider: stockDeps.stockSearch });
    },
  );

  typed.post(
    '/workspaces/:id/stock/acquire',
    {
      schema: {
        tags: ['stock'],
        summary: '获取素材（服务端复核许可；未授权 422；入库固化 origin/许可/**自动署名**）',
        params: workspaceParamsSchema,
        body: z.object({ providerAssetId: z.string().min(1).max(200), projectId: opaqueIdSchema.optional() }),
        response: { 201: stockAcquisitionResultSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'asset:manage');
      const result = await acquireStockAsset(domain, {
        workspaceId: request.params.id,
        projectId: request.body.projectId ?? null,
        request: request.body,
        provider: stockDeps.stockSearch,
        actorId: context.userId,
      });
      return reply.status(201).send(result);
    },
  );
}
