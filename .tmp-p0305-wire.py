import io

routing = '''import type { FastifyInstance } from 'fastify';
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
'''

io.open('apps/api/src/routes/billing.ts', 'w', encoding='utf-8', newline='\n').write(routing)
print('routes/billing.ts written')

p = 'apps/api/src/server.ts'
s = io.open(p, encoding='utf-8').read()
s = s.replace("import { registerAuthRoutes } from './routes/auth.js';",
              "import { registerAuthRoutes } from './routes/auth.js';\nimport { registerBillingRoutes } from './routes/billing.js';")
s = s.replace("        registerCatalogRoutes(instance, authDeps);",
              "        registerCatalogRoutes(instance, authDeps);\n        registerBillingRoutes(instance, authDeps);")
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('server wired')

p = 'packages/sdk/src/client.ts'
s = io.open(p, encoding='utf-8').read()
old = """  catalogResponseSchema,
  capabilitySelectionSchema,"""
new = """  billingStatusSchema,
  catalogResponseSchema,
  capabilitySelectionSchema,
  creditHoldSchema,
  ledgerEntrySchema,
  providerGenerationSchema,
  topUpRequestSchema,
  upsertBudgetRequestSchema,
  workspaceBudgetSchema,"""
assert s.count(old) == 1, 'sdk imports'
s = s.replace(old, new)

old = """  type CatalogResponse,
  type CapabilitySelection,"""
new = """  type BillingStatus,
  type CatalogResponse,
  type CapabilitySelection,
  type CreditHold,
  type LedgerEntry,
  type ProviderGeneration,
  type WorkspaceBudget,"""
assert s.count(old) == 1, 'sdk types'
s = s.replace(old, new)

old = """  providerConnections: {"""
new = """  billing: {
    /** 计费状态（余额/预算/周期消耗与预留） */
    status(workspaceId: string): Promise<BillingStatus>;
    /** 账本条目（只追加） */
    ledger(workspaceId: string, query?: { limit?: number }): Promise<LedgerEntry[]>;
    /** 设置预算（周期上限 + per-job 上限） */
    setBudget(
      workspaceId: string,
      input: { period?: 'DAILY' | 'MONTHLY'; limitCredits: number; perJobMaxCredits?: number },
      options?: MutationOptions,
    ): Promise<WorkspaceBudget>;
    /** 充值（CREDIT 条目） */
    topUp(
      workspaceId: string,
      input: { amountCredits: number; note?: string },
      options?: MutationOptions,
    ): Promise<{ entry: LedgerEntry; balanceCredits: number }>;
    /** 预留（原子；超限 402 BUDGET_EXCEEDED） */
    reserve(workspaceId: string, input: { jobId: string; estimatedCredits: number }, options?: MutationOptions): Promise<CreditHold>;
    generations(workspaceId: string, query?: { jobId?: string; limit?: number }): Promise<ProviderGeneration[]>;
  };
  providerConnections: {"""
assert s.count(old) == 1, 'sdk interface'
s = s.replace(old, new)

old = """    providerConnections: {
      create: (workspaceId, input, mutation) =>"""
new = """    billing: {
      status: (workspaceId) => request('GET', `/api/v1/workspaces/${workspaceId}/billing/status`, billingStatusSchema),
      ledger: async (workspaceId, query) => {
        const suffix = query?.limit !== undefined ? `?limit=${String(query.limit)}` : '';
        return (await request('GET', `/api/v1/workspaces/${workspaceId}/billing/ledger${suffix}`, listOf(ledgerEntrySchema))).items;
      },
      setBudget: (workspaceId, input, mutation) =>
        request('PUT', `/api/v1/workspaces/${workspaceId}/billing/budget`, workspaceBudgetSchema, {
          body: input,
          bodySchema: upsertBudgetRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      topUp: (workspaceId, input, mutation) =>
        request(
          'POST',
          `/api/v1/workspaces/${workspaceId}/billing/credits`,
          z.object({ entry: ledgerEntrySchema, balanceCredits: z.number().int() }),
          { body: input, bodySchema: topUpRequestSchema, idempotencyKey: mutation?.idempotencyKey },
        ),
      reserve: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/billing/reservations`, creditHoldSchema, {
          body: input,
          bodySchema: z.object({ jobId: z.string().min(1), estimatedCredits: z.number().int().nonnegative() }),
          idempotencyKey: mutation?.idempotencyKey,
        }),
      generations: async (workspaceId, query) => {
        const search = new URLSearchParams();
        if (query?.jobId !== undefined) search.set('jobId', query.jobId);
        if (query?.limit !== undefined) search.set('limit', String(query.limit));
        const suffix = search.size > 0 ? `?${search.toString()}` : '';
        return (await request('GET', `/api/v1/workspaces/${workspaceId}/provider-generations${suffix}`, listOf(providerGenerationSchema))).items;
      },
    },

    providerConnections: {
      create: (workspaceId, input, mutation) =>"""
assert s.count(old) == 1, 'sdk impl'
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('sdk wired')
