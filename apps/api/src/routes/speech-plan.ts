import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorEnvelopeSchema, opaqueIdSchema, speechPlanSchema } from '@ancs/contracts';
import { planSpeech, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Speech Director 路由（P04-06 / 规范 §94）。
 *
 * GET .../narrative/:planId/speech-plan：把旁白语义 + 声音身份（可指定）+ SpeechProfile 版本 +
 * 时长目标转为**供应商无关** SpeechPlan（不泄漏 Provider 私有参数）。
 */

const planParamsSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  planId: opaqueIdSchema,
});
const planQuerySchema = z.object({
  /** 覆盖身份来源（默认 Channel 样式的 creatorIdentityId） */
  identityId: opaqueIdSchema.optional(),
  /** 覆盖风格档案（默认 Channel 样式 → 身份默认 → 系统默认） */
  speechProfileId: opaqueIdSchema.optional(),
});
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

export function registerSpeechPlanRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.get(
    '/workspaces/:id/projects/:projectId/narrative/:planId/speech-plan',
    {
      schema: {
        tags: ['narrative'],
        summary: 'SpeechPlan（供应商无关：角色/语速/能量/停顿/强调/发音覆盖；身份与风格版本化引用）',
        params: planParamsSchema,
        querystring: planQuerySchema,
        response: { 200: speechPlanSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return planSpeech(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        planId: request.params.planId,
        ...(request.query.identityId !== undefined ? { identityId: request.query.identityId } : {}),
        ...(request.query.speechProfileId !== undefined ? { speechProfileId: request.query.speechProfileId } : {}),
      });
    },
  );
}
