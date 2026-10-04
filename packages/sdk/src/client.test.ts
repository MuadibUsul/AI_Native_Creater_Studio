import { describe, expect, it, vi } from 'vitest';
import { AncsApiError, createClient } from './client.js';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const healthBody = {
  status: 'ok',
  service: 'ancs-api',
  version: '0.0.0',
  now: '2026-10-04T00:00:00.000Z',
};

describe('createClient', () => {
  it('拼接路径、方法与 JSON 请求体（baseUrl 尾斜杠被规范化）', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse(200, { message: 'x', repeated: ['x'] });
    };
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999///', fetchImpl });

    await client.echo({ message: 'x' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:9999/api/v1/echo');
    expect(calls[0]?.init?.method).toBe('POST');
    // 请求体经契约解析：默认值 count=1 已应用
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ message: 'x', count: 1 }));
  });

  it('请求体在客户端先按契约校验（非法输入不发请求）', async () => {
    const fetchImpl = vi.fn();
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl });
    await expect(client.echo({ message: '', count: 1 })).rejects.toThrowError();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('成功响应按契约解析', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, healthBody));
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl });
    await expect(client.health()).resolves.toEqual(healthBody);
  });

  it('统一错误信封转换为 AncsApiError（保留 status/code/requestId）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, {
        error: { code: 'VALIDATION_FAILED', message: 'Request validation failed', requestId: 'req_1', details: {} },
      }),
    );
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl });

    const error = await client.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AncsApiError);
    expect(error).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', requestId: 'req_1' });
  });

  it('200 但响应不符合契约时抛出解析错误（不返回半成品对象）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: 'ok' }));
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl });
    await expect(client.health()).rejects.toThrowError();
  });

  it('非 JSON 错误响应转换为 UNPARSEABLE_ERROR', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 502 }));
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl });
    const error = await client.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AncsApiError);
    expect(error).toMatchObject({ status: 502, code: 'UNPARSEABLE_ERROR' });
  });
});
