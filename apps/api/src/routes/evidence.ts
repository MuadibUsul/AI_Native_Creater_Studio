import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  chartBindingCheckSchema,
  citationRecordSchema,
  claimRecordSchema,
  createDatasetRequestSchema,
  datasetRecordSchema,
  errorEnvelopeSchema,
  extractionResultSchema,
  factVisualDecisionSchema,
  opaqueIdSchema,
  pageResponseSchema,
} from '@ancs/contracts';
import {
  assertDatasetBindableForChart,
  createClaim,
  createDataset,
  getDataset,
  listClaimCitations,
  listClaims,
  listDatasets,
  resolveFactVisualForClaim,
  runExtraction,
  updateClaim,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * 证据与数据路由（P04-02 / 规范 §10.3、§85）。
 *
 * - 抽取：POST .../content/:documentId/extract（确定性；fact 无来源会降级为 uncertain 并给提示）；
 * - Claims：列表/手动创建（fact 必须带来源）/编辑（锁定后拒绝）/引用列表；
 * - Datasets：创建（必须带来源、非空）/列表/详情；**图表绑定校验**（非 synthetic、非空、有来源）；
 * - 事实可视化策略：GET claims/:claimId/fact-visual（§10.3 降级阶梯，供 Director 调用）。
 */

const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const documentParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, documentId: opaqueIdSchema });
const claimParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, claimId: opaqueIdSchema });
const datasetParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, datasetId: opaqueIdSchema });
const claimListQuerySchema = z.object({ documentId: opaqueIdSchema.optional() });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

const createClaimRequestSchema = z.object({
  text: z.string().min(1).max(4000),
  factuality: z.enum(['fact', 'analysis', 'opinion', 'uncertain']),
  sourceIds: z.array(opaqueIdSchema).default([]),
  locator: z.string().max(300).optional(),
  quotedText: z.string().max(1000).nullable().optional(),
});

export function registerEvidenceRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.post(
    '/workspaces/:id/projects/:projectId/content/:documentId/extract',
    {
      schema: {
        tags: ['content'],
        summary: '确定性抽取：Claim（含事实性判定）/ Citation（块+字符区间定位）/ 数值提及 / 时间线',
        params: documentParamsSchema,
        response: { 200: extractionResultSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return runExtraction(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        documentId: request.params.documentId,
      });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/claims',
    {
      schema: {
        tags: ['content'],
        summary: 'Claim 列表（可按文档过滤；含 factuality 与来源引用）',
        params: projectParamsSchema,
        querystring: claimListQuerySchema,
        response: { 200: pageResponseSchema(claimRecordSchema), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listClaims(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        ...(request.query.documentId !== undefined ? { documentId: request.query.documentId } : {}),
      });
      return { items, nextCursor: null };
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/claims',
    {
      schema: {
        tags: ['content'],
        summary: '手动创建 Claim（fact 类必须带来源；否则 422 CLAIM_REQUIRES_SOURCE）',
        params: projectParamsSchema,
        body: createClaimRequestSchema,
        response: { 201: z.object({ claim: claimRecordSchema, citations: z.array(citationRecordSchema) }), 422: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      void context;
      const result = await createClaim(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        documentId: null,
        input: request.body,
      });
      return reply.status(201).send(result);
    },
  );

  typed.patch(
    '/workspaces/:id/projects/:projectId/claims/:claimId',
    {
      schema: {
        tags: ['content'],
        summary: '编辑 Claim（文本/事实性/锁定）；锁定后修改内容 → 409 CLAIM_LOCKED',
        params: claimParamsSchema,
        body: z
          .object({
            text: z.string().min(1).max(4000),
            factuality: z.enum(['fact', 'analysis', 'opinion', 'uncertain']),
            locked: z.boolean(),
          })
          .partial()
          .strict(),
        response: { 200: claimRecordSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return updateClaim(domain, {
        workspaceId: request.params.id,
        claimId: request.params.claimId,
        input: request.body,
      });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/claims/:claimId/citations',
    {
      schema: {
        tags: ['content'],
        summary: 'Claim 的引用（可追溯链：块 ID + 字符区间 + 引文 → Source）',
        params: claimParamsSchema,
        response: { 200: pageResponseSchema(citationRecordSchema), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listClaimCitations(domain, { workspaceId: request.params.id, claimId: request.params.claimId });
      return { items, nextCursor: null };
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/claims/:claimId/fact-visual',
    {
      schema: {
        tags: ['content'],
        summary: '事实可视化策略（§10.3 降级阶梯：CHART/SOURCE_CARD/QUOTE/TEXTUAL_EXPLANATION/REQUEST_DATA）',
        params: claimParamsSchema,
        querystring: z.object({ datasetId: opaqueIdSchema.optional() }),
        response: { 200: factVisualDecisionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return resolveFactVisualForClaim(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        claimId: request.params.claimId,
        ...(request.query.datasetId !== undefined ? { datasetId: request.query.datasetId } : {}),
      });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/datasets',
    {
      schema: {
        tags: ['content'],
        summary: '创建结构化数据集（必须带来源且非空；synthetic 仅演示用，不可绑定事实图表）',
        params: projectParamsSchema,
        body: createDatasetRequestSchema,
        response: { 201: datasetRecordSchema, 422: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      const dataset = await createDataset(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        input: request.body,
      });
      return reply.status(201).send(dataset);
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/datasets',
    {
      schema: {
        tags: ['content'],
        summary: '数据集列表',
        params: projectParamsSchema,
        response: { 200: pageResponseSchema(datasetRecordSchema), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listDatasets(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
      return { items, nextCursor: null };
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/datasets/:datasetId/binding-check',
    {
      schema: {
        tags: ['content'],
        summary: '图表绑定校验（返回必须写入 Scene 的 data_source_ids；不可绑定 → 422）',
        params: datasetParamsSchema,
        response: { 200: chartBindingCheckSchema, 422: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const check = await assertDatasetBindableForChart(domain, { workspaceId: request.params.id, datasetId: request.params.datasetId });
      return check;
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/datasets/:datasetId',
    {
      schema: {
        tags: ['content'],
        summary: '数据集详情（含序列与来源）',
        params: datasetParamsSchema,
        response: { 200: datasetRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return getDataset(domain, { workspaceId: request.params.id, datasetId: request.params.datasetId });
    },
  );
}
