import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebClient } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('Web SDK transport', () => {
  it('uses same-origin API and includes the session cookie by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'UNAUTHENTICATED', message: 'Sign in required', requestId: 'req_test', details: {} },
    }), { status: 401, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createWebClient().auth.session()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/session', expect.objectContaining({
      method: 'GET', credentials: 'include',
    }));
  });
});
