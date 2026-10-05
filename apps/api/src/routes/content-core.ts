import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { contentCoreMigrationSchema, contentCoreStateSchema, errorEnvelopeSchema, opaqueIdSchema } from '@ancs/contracts';
import { getProjectContentCoreState, migrateProjectToContentCore, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Content Core（P11-01 / §92—93）：
 * - POST .../content-core/migrate：幂等迁移（派生映射；原文档保留；输入未变 → 复用）；
 * - GET  .../content-core：核心状态（核心 + 一致性摘要 + **实时**原始侧计数对照）。
 */

const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerContentCoreRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.post(
    '/workspaces/:id/projects/:projectId/content-core/migrate',
    {
      schema: {
        tags: ['content-core'],
        summary: '迁移到 Content Core（1:1 派生映射；原文档保留；幂等——输入未变即复用）',
        params: projectParamsSchema,
        response: { 200: contentCoreMigrationSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return migrateProjectToContentCore(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/content-core',
    {
      schema: {
        tags: ['content-core'],
        summary: '核心状态（一致性摘要 + 实时原始侧计数——迁移后漂移可直接对照）',
        params: projectParamsSchema,
        response: { 200: contentCoreStateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return getProjectContentCoreState(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
    },
  );
}
