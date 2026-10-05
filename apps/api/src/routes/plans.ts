import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ApiFailure,
  ERROR_CODES,
  assignPlanRequestSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  planSchema,
  planKeySchema,
  workspaceEntitlementSchema,
  workspaceSubscriptionSchema,
} from '@ancs/contracts';
import { assignWorkspacePlan, getWorkspaceEntitlement, listPlanVersions, recordAudit, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * 套餐与权益路由（P09-01 / §73）：
 * - GET  /plans：套餐目录（版本化；价格是数据）；
 * - GET  /workspaces/:id/entitlements：当前权益 + 实时用量（成员可读——UI 展示"Storage x/y"口径）；
 * - POST /admin/workspaces/:workspaceId/plan：指派套餐（**平台管理员**；append-only 订阅）。
 */

const paramsSchema = z.object({ id: opaqueIdSchema });
const adminParamsSchema = z.object({ workspaceId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerPlanRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.get(
    '/plans',
    {
      schema: {
        tags: ['plans'],
        summary: '套餐目录（同 Key 全版本，新→旧；仅认证用户可读）',
        querystring: z.object({ planKey: planKeySchema.optional() }),
        response: { 200: z.object({ items: z.array(planSchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const context = await app.authResolve(request);
      if (context === null) throw new ApiFailure(ERROR_CODES.UNAUTHENTICATED, 'Not authenticated', 401);
      const items = await listPlanVersions(domain, request.query.planKey === undefined ? {} : { planKey: request.query.planKey });
      return { items };
    },
  );

  typed.get(
    '/workspaces/:id/entitlements',
    {
      schema: {
        tags: ['plans'],
        summary: '当前权益（订阅版本或部署默认套餐）+ 实时用量（存储/席位/栏目/身份/Custom Motion）',
        params: paramsSchema,
        response: { 200: workspaceEntitlementSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return getWorkspaceEntitlement(domain, { workspaceId: request.params.id });
    },
  );

  typed.post(
    '/admin/workspaces/:workspaceId/plan',
    {
      schema: {
        tags: ['admin'],
        summary: '指派套餐（平台管理员；订阅 append-only——修改套餐不篡改历史账单）',
        params: adminParamsSchema,
        body: assignPlanRequestSchema,
        response: { 200: workspaceSubscriptionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requirePlatformAdmin(request);
      const subscription = await assignWorkspacePlan(domain, {
        workspaceId: request.params.workspaceId,
        planKey: request.body.planKey,
        assignedBy: context.userId,
        note: request.body.note ?? null,
      });
      await recordAudit(domain, {
        actorKind: 'PLATFORM_ADMIN',
        actorUserId: context.userId,
        action: 'plan.assign',
        targetType: 'workspace_subscription',
        targetId: subscription.id,
        workspaceId: request.params.workspaceId,
        details: { planKey: request.body.planKey, planVersion: subscription.planVersion },
      });
      return subscription;
    },
  );
}
