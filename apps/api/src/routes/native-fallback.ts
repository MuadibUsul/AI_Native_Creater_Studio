import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorEnvelopeSchema, opaqueIdSchema, pageResponseSchema, providerGenerationSchema, rebindExternalResultRequestSchema } from '@ancs/contracts';
import { listRebindableGenerations, rebindExternalResult, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Native Fallback 路由（P06-07 / §39、§40、§45）：
 * - GET .../external-results：Provider 任务引用（外部处理入口；onlyUnfulfilled 可筛未回绑）；
 * - POST .../external-results/:generationId/rebind：把外部处理产物（READY 资产）回绑到任务引用
 *   （场景绑定仍由编辑协议 replace_asset 完成——编辑历史可追溯）。
 */

const wsParamsSchema = z.object({ id: opaqueIdSchema });
const rebindParamsSchema = z.object({ id: opaqueIdSchema, generationId: opaqueIdSchema });
const listQuerySchema = z.object({ onlyUnfulfilled: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().positive().max(500).optional() });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerNativeFallbackRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.get(
    '/workspaces/:id/external-results',
    {
      schema: {
        tags: ['billing'],
        summary: 'Provider 任务引用（外部处理/回绑入口；含结果资产与回绑时间）',
        params: wsParamsSchema,
        querystring: listQuerySchema,
        response: { 200: pageResponseSchema(providerGenerationSchema), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'billing:manage');
      const items = await listRebindableGenerations(domain, {
        workspaceId: request.params.id,
        ...(request.query.onlyUnfulfilled !== undefined ? { onlyUnfulfilled: request.query.onlyUnfulfilled === 'true' } : {}),
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
      return { items, nextCursor: null };
    },
  );

  typed.post(
    '/workspaces/:id/external-results/:generationId/rebind',
    {
      schema: {
        tags: ['billing'],
        summary: '回绑外部处理产物（READY 资产 → 新版本引用；不原地覆盖）',
        params: rebindParamsSchema,
        body: rebindExternalResultRequestSchema,
        response: { 200: providerGenerationSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'billing:manage');
      return rebindExternalResult(domain, {
        workspaceId: request.params.id,
        generationId: request.params.generationId,
        request: request.body,
      });
    },
  );
}
