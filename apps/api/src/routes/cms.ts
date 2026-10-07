import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { cmsIngestionListSchema, errorEnvelopeSchema, ingestCmsEventRequestSchema, ingestCmsEventResponseSchema, opaqueIdSchema } from '@ancs/contracts';
import { ingestCmsEvent, listCmsIngestions, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * CMS 摄取路由（P13-06 / §88）：
 * - POST /workspaces/:id/cms/ingest —— 机器摄取事件（重放幂等；正文变化 → 新来源版本）；
 * - GET  /workspaces/:id/cms/ingest —— 摄取列表（状态查询）。
 */

const workspaceParamsSchema = z.object({ id: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 422: errorEnvelopeSchema, 502: errorEnvelopeSchema };

export function registerCmsRoutes(app: FastifyInstance, deps: AuthDeps, extra: { articleFetcher?: import('@ancs/contracts').ArticleFetcher }): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db, ...(extra.articleFetcher !== undefined ? { articleFetcher: extra.articleFetcher } : {}) };

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
}
