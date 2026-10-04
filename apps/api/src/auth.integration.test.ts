import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorEnvelopeSchema, sessionInfoSchema, tokenResponseSchema } from '@ancs/contracts';
import {
  createAuth,
  createInternalUser,
  DEFAULT_NATIVE_TOKEN_CONFIG,
  base64UrlSha256,
  type AuthInstance,
} from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { buildServer } from './server.js';

/**
 * API 层认证集成测试（P01-02 验收）：
 * 过期 / 退出 / 刷新重放 / 错误回调（PKCE 重定向与错误信封）全部覆盖真实 HTTP 与真实数据库。
 */

const PASSWORD = 'password-1234';
const CLIENT_ID = 'ancs-desktop';
const REDIRECT_URI = 'ancs://auth/callback';
const VERIFIER = 'verifier-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDE';
const CHALLENGE = base64UrlSha256(VERIFIER);

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try {
    await handle.pool.query('select 1');
  } catch (error) {
    await handle.close();
    throw new Error(
      `无法连接测试数据库 ${redactDatabaseUrl(url)}。请先运行：` +
        'docker compose -f infra/docker-compose.dev.yml up -d，或设置 ANCS_TEST_DATABASE_URL。',
      { cause: error },
    );
  }
  await runMigrations(handle);

  auth = createAuth({
    db: handle.db,
    secret: 'api-integration-secret-0123456789abcdef',
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
  });
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

const createUser = (): Promise<{ id: string; email: string }> =>
  createInternalUser(auth, { email: `api-${randomUUID()}@test.local`, password: PASSWORD, name: '接口测试' });

async function signIn(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-in',
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const setCookies = response.headers['set-cookie'];
  const list = Array.isArray(setCookies) ? setCookies : [setCookies ?? ''];
  return list.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

describe('Web 会话（HTTP）', () => {
  it('登录 → 会话 Cookie → /auth/session 返回契约信息', async () => {
    const created = await createUser();
    const cookie = await signIn(created.email);
    expect(cookie).toContain('session_token');

    const session = await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie } });
    expect(session.statusCode).toBe(200);
    const info = sessionInfoSchema.parse(session.json());
    expect(info.user.id).toBe(created.id);
    expect(info.method).toBe('web_session');
    expect(info.sessionId).not.toBeNull();
  });

  it('未认证访问 /auth/session → 401 + UNAUTHENTICATED 信封', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    expect(response.statusCode).toBe(401);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('UNAUTHENTICATED');
  });

  it('密码错误 → 401（统一信封，不泄漏原因细节）', async () => {
    const created = await createUser();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      payload: { email: created.email, password: 'wrong-password-1' },
    });
    expect(response.statusCode).toBe(401);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('UNAUTHENTICATED');
  });

  it('退出后原 Cookie 立即失效', async () => {
    const created = await createUser();
    const cookie = await signIn(created.email);

    const signOut = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-out', headers: { cookie } });
    expect(signOut.statusCode).toBe(204);

    const session = await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie } });
    expect(session.statusCode).toBe(401);
  });
});

describe('原生 PKCE（HTTP）', () => {
  it('未登录授权 → 错误回调重定向（error=login_required + state）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/authorize?responseType=code&clientId=${CLIENT_ID}&redirectUri=${encodeURIComponent(REDIRECT_URI)}&codeChallenge=${CHALLENGE}&state=st_1`,
    });
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers['location'] as string);
    expect(location.searchParams.get('error')).toBe('login_required');
    expect(location.searchParams.get('state')).toBe('st_1');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('未注册 client 或非法 redirectUri → 400 INVALID_CLIENT（不重定向）', async () => {
    const badClient = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/authorize?responseType=code&clientId=unknown-client&redirectUri=${encodeURIComponent(REDIRECT_URI)}&codeChallenge=${CHALLENGE}&state=st`,
    });
    expect(badClient.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(badClient.json()).error.code).toBe('INVALID_CLIENT');

    const badRedirect = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/authorize?responseType=code&clientId=${CLIENT_ID}&redirectUri=${encodeURIComponent('ancs://evil/callback')}&codeChallenge=${CHALLENGE}&state=st`,
    });
    expect(badRedirect.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(badRedirect.json()).error.code).toBe('INVALID_CLIENT');
  });

  it('全流程：授权码兑换 → Bearer 会话 → 刷新轮换 → 重放撤销家族', async () => {
    const created = await createUser();
    const cookie = await signIn(created.email);

    // 1) authorize（带会话 Cookie）→ 302 带回 code
    const authorize = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/authorize?responseType=code&clientId=${CLIENT_ID}&redirectUri=${encodeURIComponent(REDIRECT_URI)}&codeChallenge=${CHALLENGE}&state=st_2`,
      headers: { cookie },
    });
    expect(authorize.statusCode).toBe(302);
    const location = new URL(authorize.headers['location'] as string);
    expect(location.searchParams.get('state')).toBe('st_2');
    const code = location.searchParams.get('code');
    expect(code).toMatch(/^ancs_ac_/);

    // 2) token：授权码兑换
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: { grantType: 'authorization_code', clientId: CLIENT_ID, code, codeVerifier: VERIFIER },
    });
    expect(tokenResponse.statusCode).toBe(200);
    const pair = tokenResponseSchema.parse(tokenResponse.json());

    // 3) Bearer 访问 /auth/session
    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { authorization: `Bearer ${pair.accessToken}` },
    });
    expect(session.statusCode).toBe(200);
    const info = sessionInfoSchema.parse(session.json());
    expect(info.method).toBe('native_access');
    expect(info.user.id).toBe(created.id);

    // 4) 刷新轮换
    const refreshed = tokenResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/token',
          payload: { grantType: 'refresh_token', clientId: CLIENT_ID, refreshToken: pair.refreshToken },
        })
      ).json(),
    );
    expect(refreshed.refreshToken).not.toBe(pair.refreshToken);

    // 5) 旧 refresh 重放 → INVALID_GRANT；新 refresh 与 Access 一并失效
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: { grantType: 'refresh_token', clientId: CLIENT_ID, refreshToken: pair.refreshToken },
    });
    expect(replay.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(replay.json()).error.code).toBe('INVALID_GRANT');

    const afterReplay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: { grantType: 'refresh_token', clientId: CLIENT_ID, refreshToken: refreshed.refreshToken },
    });
    expect(afterReplay.statusCode).toBe(400);
    const bearerAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { authorization: `Bearer ${refreshed.accessToken}` },
    });
    expect(bearerAfter.statusCode).toBe(401);
  });

  it('PKCE verifier 不匹配 / 授权码复用 → 400 INVALID_GRANT', async () => {
    const created = await createUser();
    const cookie = await signIn(created.email);
    const authorize = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/authorize?responseType=code&clientId=${CLIENT_ID}&redirectUri=${encodeURIComponent(REDIRECT_URI)}&codeChallenge=${CHALLENGE}&state=st_3`,
      headers: { cookie },
    });
    const code = new URL(authorize.headers['location'] as string).searchParams.get('code');

    const wrongVerifier = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: { grantType: 'authorization_code', clientId: CLIENT_ID, code, codeVerifier: 'x'.repeat(50) },
    });
    expect(wrongVerifier.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(wrongVerifier.json()).error.code).toBe('INVALID_GRANT');

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: { grantType: 'authorization_code', clientId: CLIENT_ID, code, codeVerifier: VERIFIER },
    });
    expect(ok.statusCode).toBe(200);

    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: { grantType: 'authorization_code', clientId: CLIENT_ID, code, codeVerifier: VERIFIER },
    });
    expect(reuse.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(reuse.json()).error.code).toBe('INVALID_GRANT');
  });

  it('token 端点请求体非法 → 400 VALIDATION_FAILED', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: { grantType: 'client_credentials', clientId: CLIENT_ID },
    });
    expect(response.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('VALIDATION_FAILED');
  });

  it('revoke：退出原生会话后 Bearer 与 Refresh 同时失效', async () => {
    const created = await createUser();
    const cookie = await signIn(created.email);
    const authorize = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/authorize?responseType=code&clientId=${CLIENT_ID}&redirectUri=${encodeURIComponent(REDIRECT_URI)}&codeChallenge=${CHALLENGE}&state=st_4`,
      headers: { cookie },
    });
    const code = new URL(authorize.headers['location'] as string).searchParams.get('code');
    const pair = tokenResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/token',
          payload: { grantType: 'authorization_code', clientId: CLIENT_ID, code, codeVerifier: VERIFIER },
        })
      ).json(),
    );

    const revoke = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/revoke',
      payload: { clientId: CLIENT_ID, refreshToken: pair.refreshToken },
    });
    expect(revoke.statusCode).toBe(204);

    const bearerAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { authorization: `Bearer ${pair.accessToken}` },
    });
    expect(bearerAfter.statusCode).toBe(401);
  });
});
