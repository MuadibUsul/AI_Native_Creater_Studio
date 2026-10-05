import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ApiFailure,
  ERROR_CODES,
  PAYMENT_ERROR_REASONS,
  PaymentSignatureError,
  billingStateSchema,
  createCheckoutRequestSchema,
  errorEnvelope,
  errorEnvelopeSchema,
  opaqueIdSchema,
  planSchema,
} from '@ancs/contracts';
import { applyBillingEvent, getBillingPortal, getBillingState, listBillingEvents, startCheckout, verifyPaymentWebhook, type DomainDeps } from '@ancs/domain';
import { ensureRawBodyParser, rawBodyOf } from '../plugins/raw-body.js';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * 订阅收款路由（P09-02 / §35、§73.1）：
 * - POST /workspaces/:id/billing/checkout：发起结账（返回渠道结账页 URL；**成功页不代表入账**）；
 * - GET  /workspaces/:id/billing：收款状态 + 事件审计（含重复/乱序记录）；
 * - POST /workspaces/:id/billing/portal：账单入口（未配置 → 501）；
 * - POST /webhooks/payments：渠道事件入口（**验签 → 幂等闸门 → 状态机**；状态唯一来源）。
 */

export interface PaymentRouteDeps {
  /** 收款适配器（未配置 → 相关端点 501 fail-closed） */
  provider?: import('@ancs/contracts').PaymentProvider;
  /** 默认回跳地址（未在请求中提供时使用） */
  successUrlBase?: string;
}

const wsParamsSchema = z.object({ id: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema };

export function registerPaymentRoutes(app: FastifyInstance, deps: AuthDeps, paymentDeps: PaymentRouteDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };
  ensureRawBodyParser(app);

  typed.post(
    '/workspaces/:id/billing/checkout',
    {
      schema: {
        tags: ['billing'],
        summary: '发起结账（返回渠道结账页 URL；订阅状态只由渠道事件改变）',
        params: wsParamsSchema,
        body: createCheckoutRequestSchema,
        response: { 200: z.object({ checkoutUrl: z.string().min(1), providerSubscriptionRef: z.string().nullable() }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:update');
      const base = paymentDeps.successUrlBase ?? `http://localhost:3001/w/${request.params.id}`;
      const result = await startCheckout(domain, {
        workspaceId: request.params.id,
        request: request.body,
        provider: paymentDeps.provider,
        successUrl: `${base}?billing=success`,
        cancelUrl: `${base}?billing=cancel`,
      });
          return result;
    },
  );

  typed.get(
    '/workspaces/:id/billing',
    {
      schema: {
        tags: ['billing'],
        summary: '收款状态与事件审计（含 DUPLICATE/OUT_OF_ORDER）',
        params: wsParamsSchema,
        response: {
          200: z.object({
            state: billingStateSchema,
            plan: planSchema.nullable(),
            events: z.array(
              z.object({
                id: z.string(),
                providerEventId: z.string(),
                type: z.string(),
                outcome: z.string(),
                occurredAt: z.string(),
                receivedAt: z.string(),
              }),
            ),
          }),
          ...ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      const state = await getBillingState(domain, { workspaceId: request.params.id });
      const events = await listBillingEvents(domain, { workspaceId: request.params.id });
      return { state, plan: null, events };
    },
  );

  typed.post(
    '/workspaces/:id/billing/portal',
    {
      schema: {
        tags: ['billing'],
        summary: '账单入口（渠道客户门户；未配置 → 501）',
        params: wsParamsSchema,
        response: { 200: z.object({ portalUrl: z.string().min(1) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      const portal = await getBillingPortal(domain, { workspaceId: request.params.id, provider: paymentDeps.provider });
      if (portal === null) {
        throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '账单入口未配置（渠道客户门户不可用）', 501, { reason: PAYMENT_ERROR_REASONS.PAYMENT_PROVIDER_UNAVAILABLE });
      }
      return portal;
    },
  );

  /** 渠道事件入口（无会话认证：验签即授权；与 P03-06 webhook 同一纪律） */
  app.post('/webhooks/payments', { schema: { hide: true } }, async (request, reply) => {
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
    let event;
    try {
      event = await verifyPaymentWebhook(paymentDeps.provider, { headers, rawBody: rawBodyOf(request, request.body) });
    } catch (error) {
      if (error instanceof PaymentSignatureError) {
        return reply.status(401).send(errorEnvelope('UNAUTHENTICATED', `收款事件被拒绝：${error.message}`, request.id, { reason: PAYMENT_ERROR_REASONS.WEBHOOK_SIGNATURE_INVALID }));
      }
      throw error;
    }
    const result = await applyBillingEvent(domain, event);
    return reply.status(200).send(result);
  });
}
