import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ApiFailure,
  COMPOSITION_FINAL_RENDER_WORKFLOW,
  ERROR_CODES,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  startCompositionFinalRenderRequestSchema,
  workflowRunSchema,
} from '@ancs/contracts';
import { projects } from '@ancs/db';
import { cancelWorkflow, getWorkflowRun, listWorkflowRuns, startCompositionFinalRender, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * V5-M4：素材工程终渲染（工作流）与工作流运行查询。
 * - POST /workspaces/:id/projects/:projectId/sequences/:sequenceId/final-renders：发起（幂等键 → 同一运行）；
 * - GET  /workspaces/:id/projects/:projectId/final-renders：运行列表（新→旧）；
 * - GET  /workspaces/:id/workflow-runs/:runId：运行详情（步骤尝试、输出、错误）；
 * - POST /workspaces/:id/workflow-runs/:runId/cancel：协作式取消（步骤边界生效）。
 * 鉴权：读 project:read，写 project:write；跨工作区 → 404（反枚举）。
 */

const workspaceParams = z.object({ id: opaqueIdSchema });
const projectParams = workspaceParams.extend({ projectId: opaqueIdSchema });
const sequenceParams = projectParams.extend({ sequenceId: opaqueIdSchema });
const runParams = workspaceParams.extend({ runId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema };

export function registerFinalRenderRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  const requireProject = async (workspaceId: string, projectId: string): Promise<void> => {
    const rows = await deps.db.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt))).limit(1);
    if (rows[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  };

  typed.post('/workspaces/:id/projects/:projectId/sequences/:sequenceId/final-renders', {
    schema: {
      tags: ['projects'],
      summary: '发起素材工程终渲染（冻结 RenderPlan → FFmpeg 媒体图 → 产物入库 → 技术 QA）',
      params: sequenceParams,
      body: startCompositionFinalRenderRequestSchema,
      response: { 202: workflowRunSchema, ...ERROR_RESPONSES },
    },
  }, async (request, reply) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
    await requireProject(request.params.id, request.params.projectId);
    const run = await startCompositionFinalRender(domain, {
      workspaceId: request.params.id,
      projectId: request.params.projectId,
      sequenceId: request.params.sequenceId,
      request: request.body,
      // 运行级幂等按发起用户隔离（HTTP 层幂等另由插件回放）
      idempotencyKey: request.idempotency === null ? null : `${context.userId}:${request.idempotency.key}`,
      createdBy: context.userId,
    });
    return reply.code(202).send(run);
  });

  typed.get('/workspaces/:id/projects/:projectId/final-renders', {
    schema: { tags: ['projects'], summary: '素材工程终渲染运行列表（新→旧）', params: projectParams, response: { 200: pageResponseSchema(workflowRunSchema), ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    await requireProject(request.params.id, request.params.projectId);
    const items = await listWorkflowRuns(domain, { workspaceId: request.params.id, projectId: request.params.projectId, type: COMPOSITION_FINAL_RENDER_WORKFLOW });
    return { items, nextCursor: null };
  });

  typed.get('/workspaces/:id/workflow-runs/:runId', {
    schema: { tags: ['workflows'], summary: '工作流运行详情', params: runParams, response: { 200: workflowRunSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    return getWorkflowRun(domain, { workspaceId: request.params.id, runId: request.params.runId });
  });

  typed.post('/workspaces/:id/workflow-runs/:runId/cancel', {
    schema: { tags: ['workflows'], summary: '取消工作流运行（步骤边界生效；已完成的步骤逆序补偿）', params: runParams, response: { 200: workflowRunSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:write');
    return cancelWorkflow(domain, { workspaceId: request.params.id, runId: request.params.runId });
  });
}
