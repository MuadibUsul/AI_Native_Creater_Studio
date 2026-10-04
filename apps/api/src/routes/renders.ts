import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createRenderRequestSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  renderRecordSchema,
  renderStatusSchema,
} from '@ancs/contracts';
import { ApiFailure, ERROR_CODES } from '@ancs/contracts';
import { projects } from '@ancs/db';
import { createRender, getRender, listRenders, transitionRender, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Render 路由（P07-03 / §28、§39）：
 * - POST   /projects/:projectId/renders：创建渲染（冻结输入快照）；
 * - GET    /projects/:projectId/renders 与 /renders/:renderId：查询；
 * - POST   /renders/:renderId/transition：状态机推进（内部/Worker 用；审计入 render_events）。
 */

const projectParamsSchema = z.object({ projectId: opaqueIdSchema });
const renderParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, renderId: opaqueIdSchema });
const transitionParamsSchema = z.object({ id: opaqueIdSchema, renderId: opaqueIdSchema });
const listQuerySchema = z.object({ limit: z.coerce.number().int().positive().max(200).optional() });
const transitionBodySchema = z.object({ to: renderStatusSchema, note: z.string().max(300).optional() });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerRenderRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  /** 项目级路由：工作区由项目反查（鉴权仍走 workspace 成员判定；跨租户 → 404 反枚举） */
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
    '/projects/:projectId/renders',
    {
      schema: {
        tags: ['projects'],
        summary: '创建渲染（冻结输入快照：项目版本 + Master Narration + 资产版本清单）',
        params: projectParamsSchema,
        body: createRenderRequestSchema,
        response: { 200: renderRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const workspaceId = await requireWorkspaceOfProject(request.params.projectId);
      const { context } = await app.requireWorkspace(request, workspaceId, 'project:write');
      return createRender(domain, {
        workspaceId,
        projectId: request.params.projectId,
        request: request.body,
        createdBy: context.userId,
      });
    },
  );

  typed.get(
    '/projects/:projectId/renders',
    {
      schema: {
        tags: ['projects'],
        summary: '渲染记录列表（新→旧）',
        params: projectParamsSchema,
        querystring: listQuerySchema,
        response: { 200: pageResponseSchema(renderRecordSchema), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const workspaceId = await requireWorkspaceOfProject(request.params.projectId);
      await app.requireWorkspace(request, workspaceId, 'project:read');
      const items = await listRenders(domain, {
        workspaceId,
        projectId: request.params.projectId,
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
      return { items, nextCursor: null };
    },
  );

  typed.get(
    '/projects/:projectId/renders/:renderId',
    {
      schema: {
        tags: ['projects'],
        summary: '渲染记录详情（含冻结的输入快照引用）',
        params: renderParamsSchema,
        response: { 200: renderRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return getRender(domain, { workspaceId: request.params.id, renderId: request.params.renderId });
    },
  );

  typed.get(
    '/workspaces/:id/renders/:renderId',
    {
      schema: {
        tags: ['projects'],
        summary: '渲染记录详情（工作区级；跨项目查询）',
        params: z.object({ id: opaqueIdSchema, renderId: opaqueIdSchema }),
        response: { 200: renderRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return getRender(domain, { workspaceId: request.params.id, renderId: request.params.renderId });
    },
  );

  typed.post(
    '/workspaces/:id/renders/:renderId/transition',
    {
      schema: {
        tags: ['projects'],
        summary: '渲染状态推进（单向状态机；审计入 render_events）',
        params: transitionParamsSchema,
        body: transitionBodySchema,
        response: { 200: renderRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      return transitionRender(domain, {
        workspaceId: request.params.id,
        renderId: request.params.renderId,
        to: request.body.to,
        ...(request.body.note !== undefined ? { note: request.body.note } : {}),
        actorId: context.userId,
      });
    },
  );
}
