import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  ApiFailure,
  createProjectRequestSchema,
  createProjectVersionRequestSchema,
  createSceneRequestSchema,
  createSceneResponseSchema,
  editRequestSchema,
  editResponseSchema,
  ERROR_CODES,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  projectDetailSchema,
  projectEditEventPageSchema,
  projectSchema,
  projectStateSchema,
  projectVersionDetailSchema,
  projectVersionSchema,
  sceneGraphSchema,
} from '@ancs/contracts';
import {
  addScene,
  assembleSceneGraph,
  createProject,
  createProjectVersion,
  getProjectDetail,
  getProjectState,
  getProjectVersion,
  listProjects,
  listProjectEditEvents,
  listProjectVersions,
  processEdits,
  redoProject,
  restoreProject,
  softDeleteProject,
  undoProject,
  type DomainDeps,
} from '@ancs/domain';
import { projects as projectsTable } from '@ancs/db';
import type { AuthDeps } from '../plugins/auth.js';

const wsParamsSchema = z.object({ id: opaqueIdSchema });
const projectParamsSchema = z.object({ projectId: opaqueIdSchema });
const versionParamsSchema = z.object({ projectId: opaqueIdSchema, versionId: opaqueIdSchema });
const projectStateQuerySchema = z.object({ schemaVersion: z.string().min(1).max(32).optional() });
const projectEventsQuerySchema = projectStateQuerySchema.extend({
  afterSeq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const projectListSchema = pageResponseSchema(projectSchema);
const versionListSchema = pageResponseSchema(projectVersionSchema);
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
    capability: 'project:read' | 'project:write' | 'project:delete',
  ): Promise<{ workspaceId: string; userId: string }> {
    const rows = await deps.db
      .select({ workspaceId: projectsTable.workspaceId, deletedAt: projectsTable.deletedAt })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);
    const row = rows[0];
    // Trash 中的项目对读/写一律 404（只允许显式恢复端点触达）
    if (!row || row.deletedAt !== null) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
    const { context } = await app.requireWorkspace(request, row.workspaceId, capability);
    return { workspaceId: row.workspaceId, userId: context.userId };
  }

  /** 恢复端点专用：允许定位 Trash 中的项目（仍要求 workspace 能力）。 */
  async function requireProjectAccessIncludingTrashed(
    request: FastifyRequest,
    projectId: string,
    capability: 'project:delete',
  ): Promise<{ workspaceId: string; userId: string }> {
    const rows = await deps.db
      .select({ workspaceId: projectsTable.workspaceId })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
    const { context } = await app.requireWorkspace(request, row.workspaceId, capability);
    return { workspaceId: row.workspaceId, userId: context.userId };
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
        querystring: z.object({ trashed: z.enum(['true', 'false']).optional() }),
        response: { 200: projectListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listProjects(domain, {
        workspaceId: request.params.id,
        trashed: request.query.trashed === 'true',
      });
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
      const { workspaceId } = await requireProjectAccess(request, request.params.projectId, 'project:read');
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
      const { workspaceId } = await requireProjectAccess(request, request.params.projectId, 'project:read');
      return assembleSceneGraph(domain, { workspaceId, projectId: request.params.projectId });
    },
  );

  typed.get(
    '/projects/:projectId/state',
    {
      schema: {
        tags: ['projects'],
        summary: '读取唯一权威 ProjectDocument、对象锁与事件水位线',
        params: projectParamsSchema,
        querystring: projectStateQuerySchema,
        response: { 200: projectStateSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { workspaceId } = await requireProjectAccess(request, request.params.projectId, 'project:read');
      return getProjectState(domain, { workspaceId, projectId: request.params.projectId, schemaVersion: request.query.schemaVersion });
    },
  );

  typed.get(
    '/projects/:projectId/edit-events',
    {
      schema: {
        tags: ['projects'],
        summary: '按单调 seq 增量读取项目 EditEvent',
        params: projectParamsSchema,
        querystring: projectEventsQuerySchema,
        response: { 200: projectEditEventPageSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { workspaceId } = await requireProjectAccess(request, request.params.projectId, 'project:read');
      return listProjectEditEvents(domain, {
        workspaceId,
        projectId: request.params.projectId,
        schemaVersion: request.query.schemaVersion,
        afterSeq: request.query.afterSeq,
        limit: request.query.limit,
      });
    },
  );

  typed.post(
    '/projects/:projectId/edits',
    {
      schema: {
        tags: ['projects'],
        summary: '统一编辑协议（§4.6）：条件更新 / 幂等（Idempotency-Key）/ EditEvent + Outbox 同事务',
        params: projectParamsSchema,
        body: editRequestSchema,
        response: {
          200: editResponseSchema,
          409: errorEnvelopeSchema,
          501: errorEnvelopeSchema,
          ...ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      const { workspaceId, userId } = await requireProjectAccess(request, request.params.projectId, 'project:write');
      const result = await processEdits(domain, {
        workspaceId,
        projectId: request.params.projectId,
        actor: { type: 'USER', id: userId },
        request: request.body,
      });
      return result.response;
    },
  );

  typed.post(
    '/projects/:projectId/scenes',
    {
      schema: {
        tags: ['projects'],
        summary: '追加 Scene（经统一编辑协议实现：insert_scene 追加到末尾）',
        params: projectParamsSchema,
        body: createSceneRequestSchema,
        response: { 201: createSceneResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { workspaceId } = await requireProjectAccess(request, request.params.projectId, 'project:write');
      const result = await addScene(domain, {
        workspaceId,
        projectId: request.params.projectId,
        input: request.body,
      });
      return reply.status(201).send(result);
    },
  );

  typed.get(
    '/projects/:projectId/versions',
    {
      schema: {
        tags: ['projects'],
        summary: '项目版本列表（不可变快照；§23.2）',
        params: projectParamsSchema,
        response: { 200: versionListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { workspaceId } = await requireProjectAccess(request, request.params.projectId, 'project:read');
      const items = await listProjectVersions(domain, { workspaceId, projectId: request.params.projectId });
      return { items, nextCursor: null };
    },
  );

  typed.post(
    '/projects/:projectId/versions',
    {
      schema: {
        tags: ['projects'],
        summary: '手动建立项目版本快照（MANUAL / AI_REDIRECT / FINAL_RENDER / PUBLISH）',
        params: projectParamsSchema,
        body: createProjectVersionRequestSchema,
        response: { 201: projectVersionSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { workspaceId, userId } = await requireProjectAccess(request, request.params.projectId, 'project:write');
      const version = await createProjectVersion(domain, {
        workspaceId,
        projectId: request.params.projectId,
        reason: request.body.reason,
        note: request.body.note,
        createdBy: userId,
      });
      return reply.status(201).send(version);
    },
  );

  typed.get(
    '/projects/:projectId/versions/:versionId',
    {
      schema: {
        tags: ['projects'],
        summary: '版本详情（含快照本体）',
        params: versionParamsSchema,
        response: { 200: projectVersionDetailSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { workspaceId } = await requireProjectAccess(request, request.params.projectId, 'project:read');
      return getProjectVersion(domain, {
        workspaceId,
        projectId: request.params.projectId,
        versionId: request.params.versionId,
      });
    },
  );

  typed.post(
    '/projects/:projectId/undo',
    {
      schema: {
        tags: ['projects'],
        summary: '撤销最近一次编辑（补偿事件；恢复产生新 revision，历史不改写）',
        params: projectParamsSchema,
        response: { 200: editResponseSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { workspaceId, userId } = await requireProjectAccess(request, request.params.projectId, 'project:write');
      const result = await undoProject(domain, {
        workspaceId,
        projectId: request.params.projectId,
        actor: { type: 'USER', id: userId },
      });
      return result.response;
    },
  );

  typed.post(
    '/projects/:projectId/redo',
    {
      schema: {
        tags: ['projects'],
        summary: '重做最近一次撤销（LIFO；新编辑结束重做分支，§4.8）',
        params: projectParamsSchema,
        response: { 200: editResponseSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { workspaceId, userId } = await requireProjectAccess(request, request.params.projectId, 'project:write');
      const result = await redoProject(domain, {
        workspaceId,
        projectId: request.params.projectId,
        actor: { type: 'USER', id: userId },
      });
      return result.response;
    },
  );

  typed.delete(
    '/projects/:projectId',
    {
      schema: {
        tags: ['projects'],
        summary: '软删除 Project（Trash，保留 30 天；期间可恢复，§27）',
        params: projectParamsSchema,
        response: { 200: projectSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { workspaceId } = await requireProjectAccess(request, request.params.projectId, 'project:delete');
      return softDeleteProject(domain, { workspaceId, projectId: request.params.projectId });
    },
  );

  typed.post(
    '/projects/:projectId/restore',
    {
      schema: {
        tags: ['projects'],
        summary: '从 Trash 恢复 Project（保留期内）',
        params: projectParamsSchema,
        response: { 200: projectSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { workspaceId } = await requireProjectAccessIncludingTrashed(request, request.params.projectId, 'project:delete');
      return restoreProject(domain, { workspaceId, projectId: request.params.projectId });
    },
  );
}
