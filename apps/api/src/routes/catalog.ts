import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { catalogResponseSchema, capabilitySelectionSchema, errorEnvelopeSchema, opaqueIdSchema } from '@ancs/contracts';
import { getCurrentCatalog, selectByCapability, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Provider Catalog 路由（P03-03）：只读。Catalog 为平台级配置（不含 workspace_id），
 * 但以 workspace 作用域暴露（workspace:read），便于后续接入 workspace 级权益/配额过滤。
 */

const wsParamsSchema = z.object({ id: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

export function registerCatalogRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.get(
    '/workspaces/:id/provider-catalog',
    {
      schema: {
        tags: ['providers'],
        summary: '当前 Provider Catalog（版本化配置：能力/模型/价格/限额/地区/保留/核验时间）',
        params: wsParamsSchema,
        response: { 200: catalogResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return getCurrentCatalog(domain);
    },
  );

  typed.get(
    '/workspaces/:id/provider-catalog/capabilities/:capability',
    {
      schema: {
        tags: ['providers'],
        summary: 'Router 按能力筛选候选（含可用性判定；默认只返回可真实调用的模型）',
        params: z.object({ id: opaqueIdSchema, capability: z.string().min(1).max(100) }),
        querystring: z.object({
          region: z.string().min(1).max(50).optional(),
          callableOnly: z.enum(['true', 'false']).optional(),
        }),
        response: { 200: capabilitySelectionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return selectByCapability(domain, {
        capability: request.params.capability,
        ...(request.query.region !== undefined ? { region: request.query.region } : {}),
        callableOnly: request.query.callableOnly !== 'false',
      });
    },
  );
}
