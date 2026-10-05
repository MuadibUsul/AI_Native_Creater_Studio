import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorEnvelopeSchema, opaqueIdSchema, renderOutputEnhancementsSchema } from '@ancs/contracts';
import { buildRenderOutputEnhancements, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * 输出增强包（P10-05 / §4.2、§84、§85、§87）：仅对 **READY + 已批准未失效** 的渲染生成；
 * 章节/编码参数/署名与**正式版本（冻结快照 + 已批准 manifest）**一致，不一致即 422（不静默修正）。
 */

const renderParamsSchema = z.object({ id: opaqueIdSchema, renderId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema };

export function registerOutputEnhancementRoutes(app: FastifyInstance, deps: AuthDeps, storage?: import('@ancs/contracts').ObjectStorageAdapter): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db, ...(storage !== undefined ? { storage } : {}) };

  typed.get(
    '/workspaces/:id/renders/:renderId/outputs/enhancements',
    {
      schema: {
        tags: ['renders'],
        summary: '输出增强包（标题/描述/章节/来源/署名/封面；与已批准正式版本绑定，一致性校验失败即 422）',
        params: renderParamsSchema,
        response: { 200: renderOutputEnhancementsSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return buildRenderOutputEnhancements(domain, { workspaceId: request.params.id, renderId: request.params.renderId });
    },
  );
}
