import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ApiFailure,
  ERROR_CODES,
  customMotionComponentSchema,
  errorEnvelopeSchema,
  jobSchema,
  opaqueIdSchema,
  startCustomMotionRequestSchema,
} from '@ancs/contracts';
import { projects } from '@ancs/db';
import { getCustomMotionComponent, listCustomMotionComponents, startCustomMotionGeneration, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Custom Motion 路由（P07-02 / §11.2）：
 * - POST /projects/:projectId/scenes/:sceneId/custom-motion：发起生成（入队 MOTION_GENERATE；
 *   去重键防重复生成）——成功后组件版本自动落库（仅 APPROVED）；
 * - GET  /projects/:projectId/custom-motion[?sceneId=]：组件列表（含最新版本）；
 * - GET  /projects/:projectId/custom-motion/:componentId：组件详情（全部版本）。
 * 项目级路径（工作区由项目反查鉴权）——与 renders/scene-generation 同一约定。
 */

const sceneParamsSchema = z.object({ projectId: opaqueIdSchema, sceneId: opaqueIdSchema });
const componentParamsSchema = z.object({ projectId: opaqueIdSchema, componentId: opaqueIdSchema });
const listQuerySchema = z.object({ sceneId: opaqueIdSchema.optional() });
const startResponseSchema = z.object({
  job: jobSchema,
  dedupeKey: z.string().min(1),
  reused: z.boolean(),
});
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema };

export function registerCustomMotionRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  const requireWorkspaceOfProject = async (projectId: string): Promise<string> => {
    const rows = await deps.db
      .select({ workspaceId: projects.workspaceId })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
    return row.workspaceId;
  };

  typed.post(
    '/projects/:projectId/scenes/:sceneId/custom-motion',
    {
      schema: {
        tags: ['jobs'],
        summary: '发起 Custom Motion 生成（LLM → 四道门禁 → 仅通过时版本化落库）',
        params: sceneParamsSchema,
        body: startCustomMotionRequestSchema,
        response: { 200: startResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const workspaceId = await requireWorkspaceOfProject(request.params.projectId);
      const { context } = await app.requireWorkspace(request, workspaceId, 'project:write');
      const result = await startCustomMotionGeneration(domain, {
        workspaceId,
        projectId: request.params.projectId,
        sceneId: request.params.sceneId,
        brief: request.body.brief ?? null,
        requestedBy: context.userId,
      });
      return { job: result.job, dedupeKey: result.dedupeKey, reused: result.reused };
    },
  );

  typed.get(
    '/projects/:projectId/custom-motion',
    {
      schema: {
        tags: ['projects'],
        summary: 'Custom Motion 组件列表（含最新版本）',
        params: z.object({ projectId: opaqueIdSchema }),
        querystring: listQuerySchema,
        response: { 200: z.object({ items: z.array(customMotionComponentSchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const workspaceId = await requireWorkspaceOfProject(request.params.projectId);
      await app.requireWorkspace(request, workspaceId, 'project:read');
      const items = await listCustomMotionComponents(domain, {
        workspaceId,
        projectId: request.params.projectId,
        ...(request.query.sceneId !== undefined ? { sceneId: request.query.sceneId } : {}),
      });
      return { items };
    },
  );

  typed.get(
    '/projects/:projectId/custom-motion/:componentId',
    {
      schema: {
        tags: ['projects'],
        summary: 'Custom Motion 组件详情（全部版本，新→旧）',
        params: componentParamsSchema,
        response: { 200: customMotionComponentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const workspaceId = await requireWorkspaceOfProject(request.params.projectId);
      await app.requireWorkspace(request, workspaceId, 'project:read');
      const result = await getCustomMotionComponent(domain, {
        workspaceId,
        projectId: request.params.projectId,
        componentId: request.params.componentId,
      });
      return result.component;
    },
  );
}
