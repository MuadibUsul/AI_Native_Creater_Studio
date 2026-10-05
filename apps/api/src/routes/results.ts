import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  collectRequestSchema,
  errorEnvelope,
  errorEnvelopeSchema,
  opaqueIdSchema,
  resultCollectionSchema,
  type ResultFetcher,
  type WebhookVerifier,
} from '@ancs/contracts';
import { collectProviderResult, ingestProviderWebhook, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';
import { ensureRawBodyParser, rawBodyOf } from '../plugins/raw-body.js';

/**
 * 结果回收入口（P03-06）。
 *
 * - `POST /providers/:providerId/webhooks`：**公开端点**（无会话），唯一信任来源是**验签**
 *   （HMAC + 时间窗 + replay 键）；验签失败一律 401 且不产生副作用（不落事件行、不改任务状态）；
 *   重复事件（同 eventId）幂等 ack 200；
 * - `POST /workspaces/:id/jobs/:jobId/collect`：人工恢复入口（generation:run）——
 *   与回调/轮询**共用同一状态迁移与回收服务**（计划 §5.5）。
 */


const providerParamsSchema = z.object({ providerId: z.string().min(1).max(100) });
const collectParamsSchema = z.object({ id: opaqueIdSchema, jobId: z.string().min(1).max(128) });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

export interface WebhookRouteDeps {
  verifiers: readonly WebhookVerifier[];
  /** 回收链路所需（与 Worker 注入的是同一接口实现） */
  resultFetcher?: ResultFetcher;
  storage?: DomainDeps['storage'];
}

export function registerWebhookRoutes(app: FastifyInstance, deps: AuthDeps, webhookDeps: WebhookRouteDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = {
    db: deps.db,
    ...(webhookDeps.resultFetcher !== undefined ? { resultFetcher: webhookDeps.resultFetcher } : {}),
    ...(webhookDeps.storage !== undefined ? { storage: webhookDeps.storage } : {}),
  };

  // 保留原始请求体（验签需要原始字符串；JSON 解析行为不变）——共享幂等插件
  ensureRawBodyParser(app);

  app.post('/providers/:providerId/webhooks', { schema: { hide: true } }, async (request, reply) => {
    const params = providerParamsSchema.parse(request.params);
    const rawBody = rawBodyOf(request, request.body);
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
    const result = await ingestProviderWebhook(domain, {
      providerId: params.providerId,
      rawBody,
      headers,
      verifiers: webhookDeps.verifiers,
    });
    if (result.status === 'REJECTED') {
      return reply
        .status(401)
        .send(errorEnvelope('UNAUTHENTICATED', `Webhook 被拒绝：${result.reason ?? 'INVALID'}`, request.id, { reason: result.reason ?? null }));
    }
    return reply.status(200).send({ status: result.status, jobId: result.jobId ?? null, collected: result.collection?.collected ?? 0 });
  });

  typed.post(
    '/workspaces/:id/jobs/:jobId/collect',
    {
      schema: {
        tags: ['providers'],
        summary: '人工恢复：回收 Provider 结果（与回调/轮询共用同一服务；下载失败只重试回收，不重新生成）',
        params: collectParamsSchema,
        body: collectRequestSchema,
        response: { 200: resultCollectionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'generation:run');
      return collectProviderResult(domain, { workspaceId: request.params.id, jobId: request.params.jobId });
    },
  );
}
