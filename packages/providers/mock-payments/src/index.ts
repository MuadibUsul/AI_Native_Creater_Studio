import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PaymentSignatureError,
  billingEventSchema,
  type BillingEvent,
  type PaymentProvider,
} from '@ancs/contracts';

/**
 * Mock / 脚本化收款适配器（P09-02；同 P03-07 Mock Provider 范式）。
 *
 * 用途：**无凭据时确定性验证验收事件矩阵**（成功/失败/续费/取消/重复/乱序）：
 * - 结账 = 确定性 URL（不发起真实支付）；
 * - Webhook = HMAC-SHA256 签名（`t=<unix>,v1=<hex>`；对 `${t}.${rawBody}` 签名）——与真实渠道同构的验签路径；
 * - `scriptEvent(...)` 供测试生成**已签名**的事件请求（幂等键/发生时间可控 → 可构造重复与乱序）。
 * 绝不用于生产（无真实扣款/对账能力；生产用真实适配器）。
 */

export interface MockPaymentsOptions {
  /** 签名密钥（测试专用；长度 ≥16） */
  signingSecret: string;
  /** 结账页基址（确定性） */
  checkoutBaseUrl?: string;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly kind = 'mock';
  readonly signingSecret: string;
  private readonly checkoutBaseUrl: string;
  /** 可选：为特定 workspace 配置客户门户 URL（null → 无门户） */
  portalUrl: string | null = null;

  constructor(options: MockPaymentsOptions) {
    if (options.signingSecret.length < 16) throw new Error('Mock 收款签名密钥过短（≥16）');
    this.signingSecret = options.signingSecret;
    this.checkoutBaseUrl = options.checkoutBaseUrl ?? 'https://payments.mock.local/checkout';
  }

  async createCheckout(input: { workspaceId: string; planKey?: string | null; packCode?: string | null; successUrl: string; cancelUrl: string }): Promise<{ checkoutUrl: string; providerSubscriptionRef: string | null }> {
    const query = new URLSearchParams({ workspace: input.workspaceId, success: input.successUrl });
    if (input.packCode != null) query.set('pack', input.packCode);
    if (input.planKey != null) query.set('plan', input.planKey);
    return {
      checkoutUrl: `${this.checkoutBaseUrl}?${query.toString()}`,
      providerSubscriptionRef: input.packCode != null ? null : `sub_mock_${input.workspaceId.slice(-8)}`,
    };
  }

  async createPortal(): Promise<{ portalUrl: string } | null> {
    return this.portalUrl === null ? null : { portalUrl: this.portalUrl };
  }

  /** 生成"已签名"的事件请求（测试驱动 webhook；也可用于手工演练）。 */
  scriptEvent(event: {
    type: BillingEvent['type'];
    workspaceId: string;
    occurredAt: string;
    providerEventId?: string;
    planKey?: BillingEvent['planKey'];
    packCode?: BillingEvent['packCode'];
    providerSubscriptionRef?: string | null;
    payload?: Record<string, unknown>;
  }): { headers: Record<string, string>; body: string } {
    const providerEventId = event.providerEventId ?? `evt_mock_${Math.random().toString(36).slice(2, 10)}`;
    const payload = billingEventSchema.parse({
      planKey: null,
      providerSubscriptionRef: null,
      payload: {},
      ...event,
      providerEventId,
    });
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', this.signingSecret).update(`${String(timestamp)}.${body}`).digest('hex');
    return { headers: { 'content-type': 'application/json', 'x-mock-signature': `t=${String(timestamp)},v1=${signature}` }, body };
  }

  async verifyWebhook(input: { headers: Record<string, string | undefined>; rawBody: string }): Promise<BillingEvent> {
    const header = input.headers['x-mock-signature'];
    if (header === undefined) throw new PaymentSignatureError('缺少签名头 x-mock-signature');
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header.trim());
    if (match === null) throw new PaymentSignatureError('签名头格式非法');
    const timestamp = match[1] ?? '';
    const provided = match[2] ?? '';
    const expected = createHmac('sha256', this.signingSecret).update(`${timestamp}.${input.rawBody}`).digest('hex');
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
      throw new PaymentSignatureError('签名不匹配');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.rawBody);
    } catch {
      throw new PaymentSignatureError('请求体不是合法 JSON');
    }
    const event = billingEventSchema.safeParse(parsed);
    if (!event.success) throw new PaymentSignatureError('事件负载不符合契约');
    return event.data;
  }
}
