import { describe, expect, it } from 'vitest';
import { errorEnvelopeSchema, healthResponseSchema, type PackManifest } from '@ancs/contracts';
import { createBuiltInRegistry } from '@ancs/extensions';
import { buildServer } from './server.js';

/** 测试用假 Pack（仅存在于测试进程的注册表；不进入产品内置清单） */
const testPack: PackManifest = {
  manifestVersion: '1.0',
  packId: 'test.pack.capability',
  name: '能力测试 Pack',
  version: '0.1.0',
  capabilities: ['read_content_core'],
  compatibility: { coreRange: '>=0.1.0', sceneGraphSchemaVersion: null },
  outputFormats: ['test_1x1'],
  quota: null,
  signature: null,
};

describe('API 路由（Fastify inject；无数据库模式）', () => {
  it('GET /api/v1/health 返回契约合法响应', async () => {
    const app = await buildServer();
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    const health = healthResponseSchema.parse(response.json());
    expect(health.status).toBe('ok');
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

  it('客户端标头与请求追踪（§29.3 / §33）：回显 request id、解析 client type', async () => {
    const app = await buildServer();

    // 客户端提供合法 X-Request-Id → 服务端采用并回显
    const traced = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'req_client_custom-1', 'x-client-type': 'desktop', 'x-client-version': '1.2.3' },
    });
    expect(traced.headers['x-request-id']).toBe('req_client_custom-1');
    expect(traced.headers['x-ancs-client-type']).toBe('desktop');

    // 非法 X-Request-Id → 服务端生成（req_ 前缀）；非法 client type → unknown
    const generated = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'has space', 'x-client-type': 'cli' },
    });
    expect(String(generated.headers['x-request-id'])).toMatch(/^req_/);
    expect(generated.headers['x-ancs-client-type']).toBe('unknown');

    await app.close();
  });

  it('GET /api/v1/capabilities：默认内置注册表为空；未安装能力明确返回不可用与原因', async () => {
    const app = await buildServer();

    const listed = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(listed.statusCode).toBe(200);
    const snapshot = listed.json() as {
      packs: unknown[];
      outputFormats: string[];
      outputFormatAvailability: unknown;
    };
    expect(snapshot.packs).toEqual([]);
    expect(snapshot.outputFormats).toEqual([]);
    expect(snapshot.outputFormatAvailability).toBeNull();

    const probe = await app.inject({ method: 'GET', url: '/api/v1/capabilities?outputFormat=shorts_9x16' });
    const probed = probe.json() as { outputFormatAvailability: { available: boolean; reason: string | null } };
    expect(probed.outputFormatAvailability.available).toBe(false);
    expect(probed.outputFormatAvailability.reason).toContain('未安装');

    await app.close();
  });

  it('GET /api/v1/capabilities：注入注册表后列出 Pack 并报告可用性', async () => {
    const registry = createBuiltInRegistry();
    registry.registerPack(testPack);
    const app = await buildServer({ extensions: registry });

    const listed = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    const snapshot = listed.json() as { packs: Array<{ packId: string }>; outputFormats: string[] };
    expect(snapshot.packs.map((p) => p.packId)).toEqual(['test.pack.capability']);
    expect(snapshot.outputFormats).toEqual(['test_1x1']);

    const probe = await app.inject({ method: 'GET', url: '/api/v1/capabilities?outputFormat=test_1x1' });
    const probed = probe.json() as { outputFormatAvailability: { available: boolean; reason: string | null } };
    expect(probed.outputFormatAvailability.available).toBe(true);
    expect(probed.outputFormatAvailability.reason).toBeNull();

    await app.close();
  });

  it('GET /openapi.json 生成 OpenAPI 文档（含健康检查路径；临时 echo 已按 P01-05 删除）', async () => {
    const app = await buildServer();
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    const doc = response.json() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi.startsWith('3.')).toBe(true);
    expect(Object.keys(doc.paths)).toContain('/api/v1/health');
    expect(Object.keys(doc.paths)).not.toContain('/api/v1/echo');
    await app.close();
  });
});
