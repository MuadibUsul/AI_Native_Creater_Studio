import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  assetBundleExportSchema,
  errorEnvelopeSchema,
  graphExportSchema,
  opaqueIdSchema,
  searchEntityKindSchema,
  searchResponseSchema,
} from '@ancs/contracts';
import { exportProjectAssetBundle, exportProjectGraph, searchWorkspace, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * 搜索与项目导出（P10-06 / §62、§85、§26）：
 * - `GET /workspaces/:id/search`——跨 Project/Scene/Source/Asset/Component；**租户内 + 排除软删**；
 * - `GET .../projects/:projectId/graph-export`——Scene Graph 可移植 JSON（引用式资产，无 URL/Secret）+ 来源；
 * - `GET .../projects/:projectId/asset-bundle`——原素材清单 + 逐件签名 URL；**缺权素材明确列出**；
 *   软删项目一律 409（Trash 不可导出）。
 */

const workspaceParamsSchema = z.object({ id: opaqueIdSchema });
const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema };

export function registerSearchExportRoutes(app: FastifyInstance, deps: AuthDeps, storage?: import('@ancs/contracts').ObjectStorageAdapter): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db, ...(storage !== undefined ? { storage } : {}) };

  typed.get(
    '/workspaces/:id/search',
    {
      schema: {
        tags: ['search'],
        summary: '工作区搜索（Project/Scene/Source/Asset/Component；租户内 + 排除软删；命中字段可解释）',
        params: workspaceParamsSchema,
        querystring: z.object({
          q: z.string().min(1).max(200),
          kinds: z.string().max(120).optional(),
          limit: z.coerce.number().int().positive().max(25).optional(),
        }),
        response: { 200: searchResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const kinds = request.query.kinds === undefined ? undefined : request.query.kinds.split(',').map((kind) => searchEntityKindSchema.parse(kind.trim()));
      return searchWorkspace(domain, {
        workspaceId: request.params.id,
        query: request.query.q,
        ...(kinds !== undefined ? { kinds } : {}),
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/graph-export',
    {
      schema: {
        tags: ['exports'],
        summary: 'Scene Graph 导出（可移植 JSON：资产引用式、无 URL/Secret；来源自包含）',
        params: projectParamsSchema,
        response: { 200: graphExportSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return exportProjectGraph(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/asset-bundle',
    {
      schema: {
        tags: ['exports'],
        summary: '原素材 Bundle（清单 + 逐件签名 URL；许可受限/渲染产物/无版本 → 明确列出不打包）',
        params: projectParamsSchema,
        response: { 200: assetBundleExportSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return exportProjectAssetBundle(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
    },
  );
}
