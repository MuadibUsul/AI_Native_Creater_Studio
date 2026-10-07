import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  cmsIngestionListSchema,
  cmsWritebackAttemptListSchema,
  cmsWritebackTargetSchema,
  errorEnvelopeSchema,
  ingestCmsEventRequestSchema,
  ingestCmsEventResponseSchema,
  opaqueIdSchema,
  retryCmsWritebackResponseSchema,
  upsertCmsWritebackTargetRequestSchema,
  type ArticleFetcher,
  type CredentialCipher,
} from '@ancs/contracts';
import {
  getCmsWritebackTarget,
  ingestCmsEvent,
  listCmsIngestions,
  listCmsWritebackAttempts,
  retryCmsWriteback,
  upsertCmsWritebackTarget,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * CMS 摄取路由（P13-06 / §88）：
 * - POST /workspaces/:id/cms/ingest —— 机器摄取事件（重放幂等；正文变化 → 新来源版本）；
 * - GET  /workspaces/:id/cms/ingest —— 摄取列表（状态查询）。
 */

const workspaceParamsSchema = z.object({ id: opaqueIdSchema });
const deliveryParamsSchema = z.object({ id: opaqueIdSchema, deliveryId: opaqueIdSchema });
const attemptQuerySchema = z.object({
  deliveryId: opaqueIdSchema.optional(),
  renderId: opaqueIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 422: errorEnvelopeSchema, 502: errorEnvelopeSchema };

export function registerCmsRoutes(app: FastifyInstance, deps: AuthDeps, extra: { articleFetcher?: ArticleFetcher; credentialCipher?: CredentialCipher }): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = {
    db: deps.db,
    ...(extra.articleFetcher !== undefined ? { articleFetcher: extra.articleFetcher } : {}),
    ...(extra.credentialCipher !== undefined ? { credentials: extra.credentialCipher } : {}),
  };

  typed.post(
    '/workspaces/:id/cms/ingest',
    {
      schema: {
        tags: ['cms'],
        summary: '机器摄取 CMS/RSS/发布事件（同一事件重放不重复建项目；正文变化产生新来源版本）',
        params: workspaceParamsSchema,
        body: ingestCmsEventRequestSchema,
        response: { 200: ingestCmsEventResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'workspace:update');
      return ingestCmsEvent(domain, {
        workspaceId: request.params.id,
        source: request.body.source,
        externalId: request.body.externalId,
        title: request.body.title,
        channelId: request.body.channelId,
        content: request.body.content,
        createdBy: context.userId,
      });
    },
  );

  typed.get(
    '/workspaces/:id/cms/ingest',
    {
      schema: {
        tags: ['cms'],
        summary: 'CMS 摄取列表（新→旧）',
        params: workspaceParamsSchema,
        response: { 200: cmsIngestionListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      const items = await listCmsIngestions(domain, { workspaceId: request.params.id });
      return { items };
    },
  );

  typed.get(
    '/workspaces/:id/cms/writeback-target',
    {
      schema: {
        tags: ['cms'],
        summary: '读取 CMS 回写目标（Secret 仅返回掩码）',
        params: workspaceParamsSchema,
        response: { 200: cmsWritebackTargetSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return getCmsWritebackTarget(domain, { workspaceId: request.params.id });
    },
  );

  typed.put(
    '/workspaces/:id/cms/writeback-target',
    {
      schema: {
        tags: ['cms'],
        summary: '配置、轮换或启停 CMS 回写目标',
        params: workspaceParamsSchema,
        body: upsertCmsWritebackTargetRequestSchema,
        response: { 200: cmsWritebackTargetSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'workspace:update');
      return upsertCmsWritebackTarget(domain, { workspaceId: request.params.id, createdBy: context.userId, request: request.body });
    },
  );

  typed.get(
    '/workspaces/:id/cms/writeback-attempts',
    {
      schema: {
        tags: ['cms'],
        summary: '列出 CMS 回写尝试与响应摘要',
        params: workspaceParamsSchema,
        querystring: attemptQuerySchema,
        response: { 200: cmsWritebackAttemptListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      const items = await listCmsWritebackAttempts(domain, { workspaceId: request.params.id, ...request.query });
      return { items };
    },
  );

  typed.post(
    '/workspaces/:id/cms/writeback-deliveries/:deliveryId/retry',
    {
      schema: {
        tags: ['cms'],
        summary: '人工重发失败的 CMS delivery（复用 deliveryId）',
        params: deliveryParamsSchema,
        response: { 200: retryCmsWritebackResponseSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:update');
      return retryCmsWriteback(domain, { workspaceId: request.params.id, deliveryId: request.params.deliveryId });
    },
  );
}
