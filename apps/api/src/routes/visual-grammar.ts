import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorEnvelopeSchema, opaqueIdSchema, visualPlanSchema } from '@ancs/contracts';
import { planVisual, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Visual Grammar 路由（P04-04 / 规范 §10）。
 *
 * GET .../narrative/:planId/visual-plan：对叙事计划做**确定性语义识别**并给出每个旁白块的
 * 允许场景类型 + 数据/来源门控与受控降级（§10.3）。纯投影、可重复：同一叙事版本必得同一计划。
 */

const planParamsSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  planId: opaqueIdSchema,
});
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

export function registerVisualGrammarRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.get(
    '/workspaces/:id/projects/:projectId/narrative/:planId/visual-plan',
    {
      schema: {
        tags: ['narrative'],
        summary: '视觉计划（§10 语义识别 + 场景类型映射 + §10.3 数据/来源门控与降级）',
        params: planParamsSchema,
        response: { 200: visualPlanSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return planVisual(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        planId: request.params.planId,
      });
    },
  );
}
