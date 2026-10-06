import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { approveDerivationRequestSchema, derivationListSchema, derivationListItemSchema, errorEnvelopeSchema, opaqueIdSchema } from '@ancs/contracts';
import { approveDerivation, listProjectDerivations, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * 派生血缘路由（P11-04 / §93）：
 * - GET  .../derivations —— 血缘列表（stale 过期提示对照当前核心 digest；只提示不改状态）；
 * - POST .../derivations/:lineageId/approve —— 批准（PLAN → APPROVED；已批准重复 409；
 *   可选绑定产出项目版本 projectVersionId——同项目校验，来源链闭合 ProjectVersion）。
 */

const paramsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const approveParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, lineageId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema };

export function registerLineageRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.get(
    '/workspaces/:id/projects/:projectId/derivations',
    {
      schema: {
        tags: ['derivations'],
        summary: '派生血缘（只追加；stale=核心更新后过期提示——已批准行不被覆盖）',
        params: paramsSchema,
        response: { 200: derivationListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listProjectDerivations(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
      return { items };
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/derivations/:lineageId/approve',
    {
      schema: {
        tags: ['derivations'],
        summary: '批准派生（PLAN → APPROVED；已批准重复 409；过期提示不因批准消失；可选绑定产出项目版本）',
        params: approveParamsSchema,
        body: approveDerivationRequestSchema.optional(),
        response: { 200: derivationListItemSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return approveDerivation(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        lineageId: request.params.lineageId,
        projectVersionId: request.body?.projectVersionId ?? null,
      });
    },
  );
}
