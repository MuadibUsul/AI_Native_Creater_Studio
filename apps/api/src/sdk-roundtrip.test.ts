import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient } from '@ancs/sdk';
import { buildServer } from './server.js';

/**
 * SDK ↔ API 真实 HTTP 往返（无数据库模式，P01-05 基线）：
 * - 覆盖成功路径（health）与统一错误信封路径（未注册资源 → NOT_FOUND）；
 * - 授权后的完整业务读写工作流见 sdk-workflow.integration.test.ts（真实数据库）。
 */
describe('SDK ↔ API 端到端（HTTP）', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let baseUrl: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('health 往返并通过契约解析', async () => {
    const client = createClient({ baseUrl, clientType: 'desktop' });
    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.service).toBe('ancs-api');
  });

  it('错误路径：SDK 收到统一错误信封并转换为 AncsApiError', async () => {
    // 无数据库模式下未注册认证路由，workspaces 不存在 → 404 信封
    const client = createClient({ baseUrl });
    const error = await client.workspaces.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AncsApiError);
    expect(error).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
