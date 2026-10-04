import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorEnvelopeSchema } from '@ancs/contracts';
import { createClient } from '@ancs/sdk';
import { buildServer } from './server.js';

/**
 * SDK ↔ API 真实 HTTP 往返（P00-03 兼容性验证）：
 * 证明"Zod 契约 → Fastify 路由 → SDK 客户端"整条管线可用。
 * SDK 以 devDependency 引入（架构规则 R7 只约束生产依赖方向）。
 */
describe('SDK ↔ API 端到端', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let baseUrl: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('health 往返并通过契约解析', async () => {
    const client = createClient({ baseUrl });
    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.service).toBe('ancs-api');
  });

  it('echo 往返（含服务端默认值）', async () => {
    const client = createClient({ baseUrl });
    const result = await client.echo({ message: 'ping' });
    expect(result).toEqual({ message: 'ping', repeated: ['ping'] });
  });

  it('服务端校验失败返回统一错误信封（原始 HTTP）', async () => {
    const response = await fetch(`${baseUrl}/api/v1/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '', count: 99 }),
    });
    expect(response.status).toBe(400);
    const envelope = errorEnvelopeSchema.parse(await response.json());
    expect(envelope.error.code).toBe('VALIDATION_FAILED');
  });
});
