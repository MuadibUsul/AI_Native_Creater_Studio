import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  ApiFailure,
  createProjectRequestSchema,
  createSceneRequestSchema,
  createSceneResponseSchema,
  ERROR_CODES,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  projectDetailSchema,
  projectSchema,
  sceneGraphSchema,
} from '@ancs/contracts';
import {
  addScene,
  assembleSceneGraph,
  createProject,
  getProjectDetail,
  listProjects,
  type DomainDeps,
} from '@ancs/domain';
import { projects as projectsTable } from '@ancs/db';
import type { AuthDeps } from '../plugins/auth.js';

const wsParamsSchema = z.object({ id: opaqueIdSchema });
const projectParamsSchema = z.object({ projectId: opaqueIdSchema });
const projectListSchema = pageResponseSchema(projectSchema);
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

/**
 * Project / Scene 路由（P02-01）。
 *
 * 授权模式（REQ-31-02 的"项目范围资源"落地）：
 * 先按 projectId 定位其 workspaceId（不存在 → 404 抗枚举），再经统一授权入口校验成员与能力，
 * 最后才由服务层加载资源——严禁"按 projectId 直接查询后返回"。
 */
export function registerProjectRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  async function requireProjectAccess(
    request: FastifyRequest,
    projectId: string,
    capability: 'project:read' | 'project:write',
  ): Promise<string> {
    const rows = await deps.db
      .select({ workspaceId: projectsTable.workspaceId })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
    await app.requireWorkspace(request, row.workspaceId, capability);
    return row.workspaceId;
  }

  typed.post(
    '/workspaces/:id/projects',
    {
      schema: {
        tags: ['projects'],
        summary: '创建 Project（冻结 Channel 样式快照）',
        params: wsParamsSchema,
        body: createProjectRequestSchema,
        response: { 201: projectDetailSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      const project = await createProject(domain, {
        workspaceId: request.params.id,
        createdBy: context.userId,
        input: request.body,
      });
      return reply.status(201).send(project);
    },
  );

  typed.get(
    '/workspaces/:id/projects',
    {
      schema: {
        tags: ['projects'],
        summary: 'Project 列表',
        params: wsParamsSchema,
        response: { 200: projectListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listProjects(domain, { workspaceId: request.params.id });
      return { items, nextCursor: null };
    },
  );

  typed.get(
    '/projects/:projectId',
    {
      schema: {
        tags: ['projects'],
        summary: 'Project 详情（含创建时的 Channel 样式快照）',
        params: projectParamsSchema,
        response: { 200: projectDetailSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const workspaceId = await requireProjectAccess(request, request.params.projectId, 'project:read');
      return getProjectDetail(domain, { workspaceId, projectId: request.params.projectId });
    },
  );

  typed.get(
    '/projects/:projectId/graph',
    {
      schema: {
        tags: ['projects'],
        summary: '组装 SceneGraph（由规范化数据库状态生成，契约校验通过）',
        params: projectParamsSchema,
        response: { 200: sceneGraphSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const workspaceId = await requireProjectAccess(request, request.params.projectId, 'project:read');
      return assembleSceneGraph(domain, { workspaceId, projectId: request.params.projectId });
    },
  );

  typed.post(
    '/projects/:projectId/scenes',
    {
      schema: {
        tags: ['projects'],
        summary: '追加 Scene（P02-01 基础形态；统一操作协议在 P02-02）',
        params: projectParamsSchema,
        body: createSceneRequestSchema,
        response: { 201: createSceneResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const workspaceId = await requireProjectAccess(request, request.params.projectId, 'project:write');
      const result = await addScene(domain, {
        workspaceId,
        projectId: request.params.projectId,
        input: request.body,
      });
      return reply.status(201).send(result);
    },
  );
}
