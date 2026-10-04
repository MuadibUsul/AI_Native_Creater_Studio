import { describe, expect, it } from 'vitest';
import { errorEnvelopeSchema, healthResponseSchema } from '@ancs/contracts';
import { buildServer } from './server.js';

describe('API 路由（Fastify inject）', () => {
  it('GET /api/v1/health 返回契约合法响应', async () => {
    const app = await buildServer();
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    const health = healthResponseSchema.parse(response.json());
    expect(health.status).toBe('ok');
    await app.close();
  });

  it('POST /api/v1/echo 正常路径', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      payload: { message: 'hi', count: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'hi', repeated: ['hi', 'hi'] });
    await app.close();
  });

  it('非法请求体返回 400 + 统一错误信封（含 requestId）', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      payload: { message: '', count: 99 },
    });
    expect(response.statusCode).toBe(400);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('VALIDATION_FAILED');
    expect(envelope.error.requestId.length).toBeGreaterThan(0);
    expect(Array.isArray(envelope.error.details['issues'])).toBe(true);
    await app.close();
  });

  it('未知路由返回 404 错误信封', async () => {
    const app = await buildServer();
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(response.statusCode).toBe(404);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('NOT_FOUND');
    await app.close();
  });

  it('GET /openapi.json 生成包含业务路由的 OpenAPI 文档', async () => {
    const app = await buildServer();
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    const doc = response.json() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi.startsWith('3.')).toBe(true);
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/v1/health', '/api/v1/echo']));
    await app.close();
  });
});
