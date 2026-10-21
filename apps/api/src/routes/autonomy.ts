import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { autonomyPolicySchema, errorEnvelopeSchema, opaqueIdSchema, productionPlanSchema, signAutonomyRequestSchema } from '@ancs/contracts';
import { getLatestProductionPlan, getProjectAutonomy, revokeProjectAutonomy, signProjectAutonomy, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * 自主制作（裁决 0020，V6-9）的服务端入口。
 * - GET    /workspaces/:id/projects/:projectId/autonomy：当前授权（档位、预算、签署记录）；
 * - PUT    /workspaces/:id/projects/:projectId/autonomy：签署或重新签署（签署人与时间由服务端写入，版本加一，写工作区事件）；
 * - DELETE /workspaces/:id/projects/:projectId/autonomy：撤回（回到逐项审批、不授权任何花费）；
 * - GET    /workspaces/:id/projects/:projectId/production-plan：最新一版制作计划（蓝图、场景契约、剪辑意图；没有为 null）。
 * 鉴权：读 project:read，签署与撤回 project:write；跨工作区 → 404（反枚举）。
 */

const projectParams = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerAutonomyRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.get('/workspaces/:id/projects/:projectId/autonomy', {
    schema: { tags: ['projects'], summary: '自主制作授权（审批档位、预算、签署记录）', params: projectParams, response: { 200: autonomyPolicySchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    return getProjectAutonomy(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
  });

  typed.put('/workspaces/:id/projects/:projectId/autonomy', {
    schema: { tags: ['projects'], summary: '签署自主制作授权（预算必填；总预算在任何档位都是硬上限）', params: projectParams, body: signAutonomyRequestSchema, response: { 200: autonomyPolicySchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
    return signProjectAutonomy(domain, { workspaceId: request.params.id, projectId: request.params.projectId, actorId: context.userId, request: request.body });
  });

  typed.get('/workspaces/:id/projects/:projectId/production-plan', {
    schema: { tags: ['projects'], summary: '最新一版制作计划（规划视图，不是时间线真相；带制定时与当前的工程版本号）', params: projectParams, response: { 200: productionPlanSchema.nullable(), ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    return getLatestProductionPlan(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
  });

  typed.delete('/workspaces/:id/projects/:projectId/autonomy', {
    schema: { tags: ['projects'], summary: '撤回自主制作授权（回到逐项审批）', params: projectParams, response: { 200: autonomyPolicySchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
    return revokeProjectAutonomy(domain, { workspaceId: request.params.id, projectId: request.params.projectId, actorId: context.userId });
  });
}
