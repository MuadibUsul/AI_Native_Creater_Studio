import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_REJECTION_REASONS, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from '@ancs/contracts';
import { createHmacWebhookVerifier } from './results.js';

/** V5-M0（代码审查 P1-3）：Webhook 验签使用恒定时间比较，并覆盖等长不同签名、前缀、时间窗。 */
describe('createHmacWebhookVerifier', () => {
  const secret = 'webhook-unit-secret-0123456789'; // secrets:check-ignore：测试专用假密钥
  const now = new Date('2026-10-11T00:00:00Z');
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const body = JSON.stringify({ jobId: 'job_1', status: 'SUCCEEDED' });
  const sign = (value: string) => createHmac('sha256', secret).update(`${timestamp}.${value}`).digest('hex');
  const verifier = createHmacWebhookVerifier('prov_test', secret);
  const verify = (signature: string, ts = timestamp) => verifier.verify({
    headers: { [WEBHOOK_SIGNATURE_HEADER]: signature, [WEBHOOK_TIMESTAMP_HEADER]: ts }, rawBody: body, now,
  });

  it('正确签名（含 sha256= 前缀）通过', () => {
    expect(verify(sign(body))).toEqual({ ok: true });
    expect(verify(`sha256=${sign(body)}`)).toEqual({ ok: true });
  });

  it('等长但不同的签名被拒（逐位翻转最后一个字符）', () => {
    const good = sign(body);
    const tampered = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
    expect(tampered).toHaveLength(good.length);
    expect(verify(tampered)).toEqual({ ok: false, reason: WEBHOOK_REJECTION_REASONS.INVALID_SIGNATURE });
  });

  it('长度不同的签名被拒且不抛异常', () => {
    expect(verify('abc')).toEqual({ ok: false, reason: WEBHOOK_REJECTION_REASONS.INVALID_SIGNATURE });
    expect(verify(`${sign(body)}00`)).toEqual({ ok: false, reason: WEBHOOK_REJECTION_REASONS.INVALID_SIGNATURE });
  });

  it('时间窗外被拒', () => {
    expect(verify(sign(body), String(Number(timestamp) - 3600))).toEqual({ ok: false, reason: WEBHOOK_REJECTION_REASONS.TIMESTAMP_OUT_OF_WINDOW });
  });
});
