import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorEnvelopeSchema, jobSchema, jobStatusSchema, opaqueIdSchema, opsAuditEntrySchema, opsOverviewSchema } from '@ancs/contracts';
import { getOpsOverview, listOpsAudit, listOpsJobs, recordAudit, retryOpsJob, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';
import type { AdminDeps } from '../plugins/admin.js';

/**
 * 最小运营 API（P08-02 / §67）：`/api/v1/admin/*`
 * - 只读聚合（overview）、跨 workspace 任务列表、人工重试（复用任务服务）、审计视图；
 * - **守卫**：平台管理员名单（与普通用户角色分离）；非管理员 → 404（反枚举）。
 */

const listQuerySchema = z.object({
  status: jobStatusSchema.optional(),
  workspaceId: opaqueIdSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});
const jobParamsSchema = z.object({ jobId: opaqueIdSchema });
const retryBodySchema = z.object({ reason: z.string().max(300).optional() });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema };

export function registerAdminRoutes(app: FastifyInstance, auth: AuthDeps, admin: AdminDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: auth.db };
  void admin;

  typed.get(
    '/admin/overview',
    {
      schema: { tags: ['admin'], summary: '运营总览（队列/渲染/QA/审批/Provider 生成/开销聚合）', response: { 200: opsOverviewSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      await app.requirePlatformAdmin(request);
      return getOpsOverview(domain);
    },
  );

  typed.get(
    '/admin/jobs',
    {
      schema: {
        tags: ['admin'],
        summary: '跨 workspace 任务列表（失败任务运维入口）',
        querystring: listQuerySchema,
        response: { 200: z.object({ items: z.array(jobSchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requirePlatformAdmin(request);
      const items = await listOpsJobs(domain, {
        ...(request.query.status !== undefined ? { status: request.query.status } : {}),
        ...(request.query.workspaceId !== undefined ? { workspaceId: request.query.workspaceId } : {}),
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
      return { items };
    },
  );

  typed.post(
    '/admin/jobs/:jobId/retry',
    {
      schema: {
        tags: ['admin'],
        summary: '人工重试（复用任务服务：预算/幂等/版本规则不变）',
        params: jobParamsSchema,
        body: retryBodySchema,
        response: { 200: jobSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requirePlatformAdmin(request);
      const job = await retryOpsJob(domain, { jobId: request.params.jobId, reason: request.body.reason ?? null });
      await recordAudit(domain, {
        actorKind: 'PLATFORM_ADMIN',
        actorUserId: context.userId,
        action: 'job.retry',
        targetType: 'job',
        targetId: job.id,
        workspaceId: job.workspaceId,
        details: { reason: (request.body.reason ?? '').slice(0, 200) },
      });
      return job;
    },
  );

  typed.get(
    '/admin/audit',
    {
      schema: {
        tags: ['admin'],
        summary: '审计视图（job 事件 + 渲染状态迁移 + 审批合并）',
        querystring: z.object({ limit: z.coerce.number().int().positive().max(200).optional() }),
        response: { 200: z.object({ items: z.array(opsAuditEntrySchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requirePlatformAdmin(request);
      const items = await listOpsAudit(domain, { ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}) });
      return { items };
    },
  );
}
