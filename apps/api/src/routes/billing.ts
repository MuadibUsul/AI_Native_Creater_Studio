import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  billingStatusSchema,
  creditHoldSchema,
  errorEnvelopeSchema,
  ledgerEntrySchema,
  opaqueIdSchema,
  pageResponseSchema,
  providerGenerationSchema,
  topUpRequestSchema,
  upsertBudgetRequestSchema,
  workspaceBudgetSchema,
} from '@ancs/contracts';
import {
  getBillingStatus,
  listLedger,
  listProviderGenerations,
  reserveCredits,
  topUpCredits,
  upsertBudget,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * 账本与预算路由（P03-05）。
 *
 * 能力：账单/账本/用量与预算设置、充值均要求 **billing:manage**（OWNER/ADMIN）——费用数据是敏感资源；
 * 预留端点要求 generation:run（任务链路创建预留）。
 */

const wsParamsSchema = z.object({ id: opaqueIdSchema });
const ledgerQuerySchema = z.object({ limit: z.coerce.number().int().positive().max(500).optional() });
const generationsQuerySchema = z.object({
  jobId: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});
const reserveRequestSchema = z.object({
  jobId: z.string().min(1).max(128),
  estimatedCredits: z.number().int().nonnegative(),
});
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

export function registerBillingRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.get(
    '/workspaces/:id/billing/status',
    {
      schema: {
        tags: ['billing'],
        summary: '计费状态：余额（账本推论）+ 预算 + 当前周期消耗/预留',
        params: wsParamsSchema,
        response: { 200: billingStatusSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'billing:manage');
      return getBillingStatus(domain, { workspaceId: request.params.id });
    },
  );

  typed.get(
    '/workspaces/:id/billing/ledger',
    {
      schema: {
        tags: ['billing'],
        summary: '账本条目（只追加；HOLD/HOLD_RELEASE/DEBIT/CREDIT 等）',
        params: wsParamsSchema,
        querystring: ledgerQuerySchema,
        response: { 200: pageResponseSchema(ledgerEntrySchema), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'billing:manage');
      const items = await listLedger(domain, {
        workspaceId: request.params.id,
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
      return { items, nextCursor: null };
    },
  );

  typed.put(
    '/workspaces/:id/billing/budget',
    {
      schema: {
        tags: ['billing'],
        summary: '设置预算（周期上限 + 单任务上限 per-job max cost）',
        params: wsParamsSchema,
        body: upsertBudgetRequestSchema,
        response: { 200: workspaceBudgetSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'billing:manage');
      return upsertBudget(domain, { workspaceId: request.params.id, input: request.body });
    },
  );

  typed.post(
    '/workspaces/:id/billing/credits',
    {
      schema: {
        tags: ['billing'],
        summary: '充值（CREDIT 条目；只追加，自托管场景的手动入账）',
        params: wsParamsSchema,
        body: topUpRequestSchema,
        response: { 200: z.object({ entry: ledgerEntrySchema, balanceCredits: z.number().int() }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'billing:manage');
      return topUpCredits(domain, {
        workspaceId: request.params.id,
        amountCredits: request.body.amountCredits,
        ...(request.body.note !== undefined ? { note: request.body.note } : {}),
      });
    },
  );

  typed.post(
    '/workspaces/:id/billing/reservations',
    {
      schema: {
        tags: ['billing'],
        summary: '预算预留（原子；并发抢预算不超额，超限 402 BUDGET_EXCEEDED）',
        params: wsParamsSchema,
        body: reserveRequestSchema,
        response: { 201: creditHoldSchema, 402: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      await app.requireWorkspace(request, request.params.id, 'generation:run');
      const hold = await reserveCredits(domain, {
        workspaceId: request.params.id,
        jobId: request.body.jobId,
        estimatedCredits: request.body.estimatedCredits,
      });
      return reply.status(201).send(hold);
    },
  );

  typed.get(
    '/workspaces/:id/provider-generations',
    {
      schema: {
        tags: ['billing'],
        summary: 'Provider 用量记录（REQ-25-01：成本/延迟/重试/凭证模式可追踪）',
        params: wsParamsSchema,
        querystring: generationsQuerySchema,
        response: { 200: pageResponseSchema(providerGenerationSchema), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'billing:manage');
      const items = await listProviderGenerations(domain, {
        workspaceId: request.params.id,
        ...(request.query.jobId !== undefined ? { jobId: request.query.jobId } : {}),
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
      return { items, nextCursor: null };
    },
  );
}
