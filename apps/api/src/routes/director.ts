import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  directorApplyRequestSchema,
  directorPlanSchema,
  directorPolicySchema,
  editResponseSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  type DirectorPolicyInput,
} from '@ancs/contracts';
import { ApiFailure, ERROR_CODES } from '@ancs/contracts';
import { applyDirectorPlan, planDirector, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Director 路由（P04-05 / 规范 §9）。
 *
 * - GET  .../director-plan：确定性规划（场景/资产/任务/成本/告警/决策摘要；不落库）；
 * - POST .../director-plan/apply：验证（Schema/来源/Lock/预算）后经编辑协议原子应用（仅空项目）。
 */

const planParamsSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  planId: opaqueIdSchema,
});
const planQuerySchema = z.object({
  /** 视觉策略覆盖（URL 编码的 JSON 字符串；不提供则用 §9.4 默认值） */
  policy: z.string().max(2000).optional(),
});

const parsePolicyQuery = (raw: string | undefined): DirectorPolicyInput | undefined => {
  if (raw === undefined) return undefined;
  try {
    return directorPolicySchema.partial().parse(JSON.parse(raw));
  } catch {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'policy 查询参数必须是合法的策略 JSON', 400, {});
  }
};
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

export function registerDirectorRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.get(
    '/workspaces/:id/projects/:projectId/narrative/:planId/director-plan',
    {
      schema: {
        tags: ['narrative'],
        summary: 'Director 计划（场景/资产/任务/成本/告警/决策摘要；应用前须验证）',
        params: planParamsSchema,
        querystring: planQuerySchema,
        response: { 200: directorPlanSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context, membership } = await app.requireWorkspace(request, request.params.id, 'project:read');
      const policy = parsePolicyQuery(request.query.policy);
      return planDirector(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        planId: request.params.planId,
        evidencePermissionContext: `${request.params.id}:${context.userId}:${membership.role}:project:read`,
        ...(policy !== undefined ? { policy } : {}),
      });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/narrative/:planId/director-plan/apply',
    {
      schema: {
        tags: ['narrative'],
        summary: '应用 Director 计划（Schema/来源/Lock/预算验证 + 原子编辑；仅空项目）',
        params: planParamsSchema,
        body: directorApplyRequestSchema,
        response: { 200: editResponseSchema, 402: errorEnvelopeSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      const result = await applyDirectorPlan(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        planId: request.params.planId,
        actorId: context.userId,
        ...(request.body.policy !== undefined ? { policy: request.body.policy } : {}),
        ...(request.body.intent !== undefined ? { intent: request.body.intent } : {}),
      });
      return result.edit.response;
    },
  );
}
