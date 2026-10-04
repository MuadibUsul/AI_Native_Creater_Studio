import { describe, expect, it } from 'vitest';
import {
  CLIENT_TYPES,
  clientTypeSchema,
  errorEnvelopeSchema,
  healthResponseSchema,
  idempotencyKeySchema,
  requestIdSchema,
} from './index.js';

describe('healthResponseSchema', () => {
  it('接受合法响应并保留字段', () => {
    const value = {
      status: 'ok',
      service: 'ancs-api',
      version: '0.0.0',
      now: '2026-10-04T00:00:00.000Z',
    };
    expect(healthResponseSchema.parse(value)).toEqual(value);
  });

  it('拒绝缺失时间戳的响应', () => {
    const result = healthResponseSchema.safeParse({ status: 'ok', service: 'ancs-api', version: '0.0.0' });
    expect(result.success).toBe(false);
  });
});

describe('HTTP 传输约定（§29.3 / §33）', () => {
  it('客户端类型枚举为 web/desktop/ios/android', () => {
    expect([...CLIENT_TYPES]).toEqual(['web', 'desktop', 'ios', 'android']);
    expect(clientTypeSchema.safeParse('web').success).toBe(true);
    expect(clientTypeSchema.safeParse('cli').success).toBe(false);
  });

  it('requestId 仅允许限定字符集且长度受限', () => {
    expect(requestIdSchema.safeParse('req_abc-123.def:1').success).toBe(true);
    expect(requestIdSchema.safeParse('req with space').success).toBe(false);
    expect(requestIdSchema.safeParse('').success).toBe(false);
    expect(requestIdSchema.safeParse('x'.repeat(129)).success).toBe(false);
  });

  it('幂等键长度 8—200，且仅允许 ASCII 可打印字符（经请求头传输）', () => {
    expect(idempotencyKeySchema.safeParse('idem_workflow_0001').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('k'.repeat(201)).success).toBe(false);
    expect(idempotencyKeySchema.safeParse('idem_并发_0001').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('idem_with space').success).toBe(false);
  });
});

describe('errorEnvelopeSchema', () => {
  it('接受规范 §33 形状的错误响应', () => {
    const envelope = {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        requestId: 'req_1',
        details: { issues: ['message: too small'] },
      },
    };
    expect(errorEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it('拒绝缺少 code 的错误响应', () => {
    const result = errorEnvelopeSchema.safeParse({ error: { message: 'x', requestId: 'r', details: {} } });
    expect(result.success).toBe(false);
  });
});
