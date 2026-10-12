import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ApiFailure,
  ERROR_CODES,
  createStudioProjectRequestSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  productionPolicySchema,
  studioProjectRefSchema,
  studioStateSchema,
  undoChangeResponseSchema,
  updateProductionPolicyRequestSchema,
} from '@ancs/contracts';
import { projects } from '@ancs/db';
import { createStudioProject, getStudioState, undoLastChange, updateProjectProductionPolicy, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * V6-1c：共看片室（单屏工作台）的服务端入口。
 * - POST /workspaces/:id/studio-projects：一步建好素材工程 + 主序列 + AI 会话；
 * - GET  /workspaces/:id/projects/:projectId/studio：工作台状态（工程、序列、会话、素材上传/理解进度、AI 成本）；
 * - POST /workspaces/:id/projects/:projectId/undo-change：撤销"这次修改"（同一版本号的全部事件一组撤销）；
 * - PATCH /workspaces/:id/projects/:projectId/production-policy：用户显式修改制作规则的"允许"开关（V6-3 开启特效；写工作区事件）。
 * 其余动作复用既有接口：对话走 agent，试看走 previews，采用/撤回走 proposals，导出走 final-renders。
 * 鉴权：读 project:read，写 project:write；跨工作区 → 404（反枚举）。
 */

const workspaceParams = z.object({ id: opaqueIdSchema });
const projectParams = workspaceParams.extend({ projectId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerStudioRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  const requireProject = async (workspaceId: string, projectId: string): Promise<void> => {
    const rows = await deps.db.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt))).limit(1);
    if (rows[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  };

  typed.post('/workspaces/:id/studio-projects', {
    schema: { tags: ['projects'], summary: '新建共看片室工程（素材工程 + 主序列 + AI 会话）', params: workspaceParams, body: createStudioProjectRequestSchema, response: { 201: studioProjectRefSchema, ...ERROR_RESPONSES } },
  }, async (request, reply) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
    const created = await createStudioProject(domain, { workspaceId: request.params.id, request: request.body, createdBy: context.userId });
    return reply.code(201).send(created);
  });

  typed.get('/workspaces/:id/projects/:projectId/studio', {
    schema: { tags: ['projects'], summary: '共看片室状态（工程、序列、会话、素材进度、AI 成本）', params: projectParams, response: { 200: studioStateSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    return getStudioState(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
  });

  typed.post('/workspaces/:id/projects/:projectId/undo-change', {
    schema: { tags: ['projects'], summary: '撤销这次修改（同一版本号的全部事件一组撤销；之后可逐条重做）', params: projectParams, response: { 200: undoChangeResponseSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
    await requireProject(request.params.id, request.params.projectId);
    return undoLastChange(domain, { workspaceId: request.params.id, projectId: request.params.projectId, actor: { type: 'USER', id: context.userId } });
  });

  typed.patch('/workspaces/:id/projects/:projectId/production-policy', {
    schema: { tags: ['projects'], summary: '修改项目制作规则的"允许"开关（不改工程模式；每项能力调用时服务端仍按规则拦截）', params: projectParams, body: updateProductionPolicyRequestSchema, response: { 200: productionPolicySchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
    return updateProjectProductionPolicy(domain, { workspaceId: request.params.id, projectId: request.params.projectId, actorId: context.userId, changes: request.body });
  });
}
