import { describe, expect, it, vi } from 'vitest';
import { createClient } from './client.js';

describe('N16-02 用户外观 SDK', () => {
  it('经当前用户端点读取并校验同步偏好，不附带用户 ID 写入', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Response(JSON.stringify({
      userId: 'usr_a', mode: init?.method === 'PUT' ? 'dark' : 'system', updatedAt: init?.method === 'PUT' ? '2026-10-08T00:00:00.000Z' : null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl });
    expect((await client.auth.getAppearance()).mode).toBe('system');
    expect((await client.auth.setAppearance({ mode: 'dark' })).mode).toBe('dark');
    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ['http://127.0.0.1:9999/api/v1/users/me/appearance', 'GET'],
      ['http://127.0.0.1:9999/api/v1/users/me/appearance', 'PUT'],
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({ mode: 'dark' });
  });

  it('非法外观值在发送前拒绝', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createClient({ baseUrl: 'http://127.0.0.1:9999', fetchImpl });
    await expect(client.auth.setAppearance({ mode: 'auto' as 'system' })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
