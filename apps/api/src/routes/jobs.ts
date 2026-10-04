import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorEnvelopeSchema, jobSchema, jobStatusSchema, opaqueIdSchema, pageResponseSchema } from '@ancs/contracts';
import { cancelJob, getJob, listJobs, retryJob, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * 任务路由（P03-01）。任务由服务内部创建（生成/渲染/维护），对外只暴露读取与
 * 取消/重试（规范 §35 的 API 清单）：GET /workspaces/:id/jobs/:jobId、
 * POST .../jobs/:jobId/cancel、POST .../jobs/:jobId/retry。
 *
 * 能力：读取需 workspace:read；取消/重试影响执行（可能涉及费用）→ generation:run。
 */

const wsParamsSchema = z.object({ id: opaqueIdSchema });
const jobParamsSchema = z.object({ id: opaqueIdSchema, jobId: opaqueIdSchema });
const jobListQuerySchema = z.object({
  projectId: opaqueIdSchema.optional(),
  status: jobStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

export function registerJobRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.get(
    '/workspaces/:id/jobs',
    {
      schema: {
        tags: ['jobs'],
        summary: '任务列表（可按项目/状态过滤；权威状态在数据库）',
        params: wsParamsSchema,
        querystring: jobListQuerySchema,
        response: { 200: pageResponseSchema(jobSchema), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      const items = await listJobs(domain, {
        workspaceId: request.params.id,
        ...(request.query.projectId !== undefined ? { projectId: request.query.projectId } : {}),
        ...(request.query.status !== undefined ? { status: request.query.status } : {}),
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
      return { items, nextCursor: null };
    },
  );

  typed.get(
    '/workspaces/:id/jobs/:jobId',
    {
      schema: {
        tags: ['jobs'],
        summary: '任务详情（状态机 / 阶段 / 尝试次数 / 是否需对账）',
        params: jobParamsSchema,
        response: { 200: jobSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return getJob(domain, { workspaceId: request.params.id, jobId: request.params.jobId });
    },
  );

  typed.post(
    '/workspaces/:id/jobs/:jobId/cancel',
    {
      schema: {
        tags: ['jobs'],
        summary: '取消任务（QUEUED/等待依赖 → CANCELLED；执行中 → CANCEL_REQUESTED 协作式收敛）',
        params: jobParamsSchema,
        response: { 200: jobSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'generation:run');
      return cancelJob(domain, { workspaceId: request.params.id, jobId: request.params.jobId });
    },
  );

  typed.post(
    '/workspaces/:id/jobs/:jobId/retry',
    {
      schema: {
        tags: ['jobs'],
        summary: '人工重试（FAILED_* / CANCELLED → QUEUED；重新派发）',
        params: jobParamsSchema,
        response: { 200: jobSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'generation:run');
      return retryJob(domain, { workspaceId: request.params.id, jobId: request.params.jobId });
    },
  );
}
