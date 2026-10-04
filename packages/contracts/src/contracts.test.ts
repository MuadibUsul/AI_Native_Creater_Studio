import { describe, expect, it } from 'vitest';
import { echoRequestSchema, echoResponseSchema, errorEnvelopeSchema, healthResponseSchema } from './index.js';

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

describe('echoRequestSchema', () => {
  it('count 缺省为 1', () => {
    expect(echoRequestSchema.parse({ message: 'hi' })).toEqual({ message: 'hi', count: 1 });
  });

  it('拒绝空 message、越界 count 与非整数', () => {
    expect(echoRequestSchema.safeParse({ message: '' }).success).toBe(false);
    expect(echoRequestSchema.safeParse({ message: 'x', count: 0 }).success).toBe(false);
    expect(echoRequestSchema.safeParse({ message: 'x', count: 11 }).success).toBe(false);
    expect(echoRequestSchema.safeParse({ message: 'x', count: 1.5 }).success).toBe(false);
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

describe('echoResponseSchema', () => {
  it('拒绝非字符串数组', () => {
    expect(echoResponseSchema.safeParse({ message: 'x', repeated: [1, 2] }).success).toBe(false);
  });
});
