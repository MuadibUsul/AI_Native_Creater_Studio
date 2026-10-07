import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AncsApiError, createClient, generatePkcePair } from './client.js';

const jsonResponse = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extraHeaders } });

const healthBody = {
  status: 'ok',
  service: 'ancs-api',
  version: '0.0.0',
  now: '2026-10-04T00:00:00.000Z',
};

const workspaceBody = {
  id: 'ws_1',
  name: '测试租户',
  role: 'OWNER',
  createdAt: '2026-10-04T00:00:00.000Z',
  updatedAt: '2026-10-04T00:00:00.000Z',
};

describe('createClient：请求构造与标头（§29.3 / §33）', () => {
  it('拼接路径、方法与 JSON 请求体，并携带客户端标头', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse(201, workspaceBody);
    };
    const client = createClient({
      baseUrl: 'http://127.0.0.1:9999///',
      fetchImpl,
      clientType: 'desktop',
      clientVersion: '1.2.3',
    });

    await client.workspaces.create({ name: '测试租户' }, { idempotencyKey: 'idem_test_000001' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:9999/api/v1/workspaces');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ name: '测试租户' }));
    const headers = calls[0]?.init?.headers as Headers;
    expect(headers.get('x-client-type')).toBe('desktop');
    expect(headers.get('x-client-version')).toBe('1.2.3');
    expect(headers.get('idempotency-key')).toBe('idem_test_000001');
  });

  it('请求体在客户端先按契约校验（非法输入不发请求）', async () => {
    const fetchImpl = vi.fn();
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl });
    await expect(client.workspaces.create({ name: '' })).rejects.toThrowError();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('文档字节导入也携带幂等键，供网络失败后安全重试', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      return jsonResponse(422, { error: { code: 'VALIDATION_FAILED', message: '测试拒绝' } });
    };
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl });
    const data = new TextEncoder().encode('# 标题');
    await expect(client.content.importDocument('ws_1', 'prj_1', { filename: 'notes.md', contentType: 'text/markdown', data }, { idempotencyKey: 'idem_document_1' })).rejects.toThrow();
    expect((calls[0]?.headers as Headers).get('idempotency-key')).toBe('idem_document_1');
    expect((calls[0]?.headers as Headers).get('content-type')).toBe('text/markdown');
    expect(calls[0]?.body).toBe(data);
  });
});

describe('createClient：认证模式', () => {
  it('Bearer 模式：getAccessToken 结果进入 Authorization 头', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(init);
      return jsonResponse(200, healthBody);
    };
    const client = createClient({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl,
      credentials: 'omit',
      getAccessToken: () => 'ancs_at_test_token',
    });

    await client.health();
    expect((calls[0]?.headers as Headers).get('authorization')).toBe('Bearer ancs_at_test_token');
  });

  it('Cookie 模式（非浏览器）：捕获 set-cookie 并在后续请求携带', async () => {
    const calls: Array<RequestInit | undefined> = [];
    let first = true;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(init);
      if (first) {
        first = false;
        return jsonResponse(200, { user: { id: 'u_1', email: 'a@b.co', name: 'A', emailVerified: true } }, {
          'set-cookie': 'better-auth.session_token=tok_123; Path=/; HttpOnly; SameSite=Lax',
        });
      }
      return jsonResponse(200, healthBody);
    };
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl });

    await client.auth.signIn({ email: 'a@b.co', password: 'password-1234' });
    await client.health();

    const secondHeaders = calls[1]?.headers as Headers;
    expect(secondHeaders.get('cookie')).toContain('better-auth.session_token=tok_123');
  });

  it('authorize：解析 302 重定向中的 code/state；400 时按错误信封抛出', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes('clientId=unknown')) {
        return jsonResponse(400, {
          error: { code: 'INVALID_CLIENT', message: 'client "unknown" is not registered', requestId: 'req_1', details: {} },
        });
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'ancs://auth/callback?code=ancs_ac_1&state=st_1' },
      });
    };
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl, credentials: 'omit' });

    const ok = await client.auth.authorize({
      clientId: 'ancs-desktop',
      redirectUri: 'ancs://auth/callback',
      codeChallenge: 'x'.repeat(43),
      state: 'st_1',
    });
    expect(ok.code).toBe('ancs_ac_1');
    expect(ok.state).toBe('st_1');
    expect(ok.error).toBeNull();

    const failure = await client.auth.authorize({
      clientId: 'unknown',
      redirectUri: 'ancs://auth/callback',
      codeChallenge: 'x'.repeat(43),
      state: 'st_2',
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AncsApiError);
    expect(failure).toMatchObject({ code: 'INVALID_CLIENT', status: 400 });
  });
});

describe('createClient：响应解析与错误路径', () => {
  it('成功响应按契约解析', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(200, healthBody);
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl });
    await expect(client.health()).resolves.toEqual(healthBody);
  });

  it('统一错误信封转换为 AncsApiError（保留 status/code/requestId）', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(409, {
        error: { code: 'VERSION_CONFLICT', message: 'conflict', requestId: 'req_9', details: { currentProjectRevision: 3 } },
      });
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl });

    const error = await client.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AncsApiError);
    expect(error).toMatchObject({ status: 409, code: 'VERSION_CONFLICT', requestId: 'req_9' });
    expect((error as AncsApiError).details['currentProjectRevision']).toBe(3);
  });

  it('200 但响应不符合契约时抛出解析错误（不返回半成品对象）', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(200, { status: 'ok' });
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl });
    await expect(client.health()).rejects.toThrowError();
  });

  it('非 JSON 错误响应转换为 UNPARSEABLE_ERROR', async () => {
    const fetchImpl: typeof fetch = async () => new Response('<html>502</html>', { status: 502 });
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl });
    const error = await client.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AncsApiError);
    expect(error).toMatchObject({ status: 502, code: 'UNPARSEABLE_ERROR' });
  });
});

describe('generatePkcePair', () => {
  it('生成 S256 校验对且 challenge = base64url(sha256(verifier))', async () => {
    const pair = await generatePkcePair();
    expect(pair.method).toBe('S256');
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = createHash('sha256').update(pair.verifier, 'utf8').digest('base64url');
    expect(pair.challenge).toBe(expected);
  });
});
