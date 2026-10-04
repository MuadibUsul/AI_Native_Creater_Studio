import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tokenResponseSchema } from '@ancs/contracts';
import {
  authAccessTokens,
  authRefreshTokens,
  createDb,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  user,
  type DbHandle,
} from '@ancs/db';
import {
  assertRegisteredClient,
  AuthFailure,
  base64UrlSha256,
  createAuth,
  createAuthorizationCode,
  createInternalUser,
  DEFAULT_NATIVE_TOKEN_CONFIG,
  exchangeAuthorizationCode,
  parseNativeClients,
  refreshTokenPair,
  resolveAuthContext,
  revokeRefreshToken,
  sha256Hex,
  verifyAccessToken,
  type AuthInstance,
  type NativeTokenConfig,
  type TokenDeps,
} from './index.js';

const PASSWORD = 'password-1234';
const CLIENT_ID = 'ancs-desktop';
const REDIRECT_URI = 'ancs://auth/callback';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let handle: DbHandle;
let auth: AuthInstance;

const makeTokenDeps = (overrides: Partial<NativeTokenConfig> = {}): TokenDeps => ({
  db: handle.db,
  config: { ...DEFAULT_NATIVE_TOKEN_CONFIG, ...overrides },
});

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
    secret: 'integration-test-secret-0123456789abcdef',
    baseUrl: 'http://localhost:3001',
    // 便于会话过期测试：2 秒 TTL，且不做滑动续期
    sessionTtlSeconds: 2,
    sessionUpdateAgeSeconds: 60 * 60 * 24,
  });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  // user 删除级联清理 account/session/授权码/令牌
  await handle.db.delete(user);
});

const makeEmail = (): string => `auth-${randomUUID()}@test.local`;

async function createUser(): Promise<{ id: string; email: string }> {
  return createInternalUser(auth, { email: makeEmail(), password: PASSWORD, name: '测试用户' });
}

/** Web 登录并提取会话 Cookie（name=value 形式，供 getSession/受保护请求使用）。 */
async function webSignIn(email: string): Promise<{ cookie: string; setCookies: string[] }> {
  const result = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    headers: new Headers(),
    returnHeaders: true,
  });
  const setCookies = result.headers.getSetCookie();
  const cookie = setCookies.map((entry) => entry.split(';')[0] ?? '').join('; ');
  return { cookie, setCookies };
}

const VERIFIER = 'verifier-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDE';
const CHALLENGE = base64UrlSha256(VERIFIER);

describe('Web 会话（Better Auth）', () => {
  it('内部账号创建 + 登录返回 HttpOnly 会话 Cookie，且会话可解析', async () => {
    const created = await createUser();
    const { cookie, setCookies } = await webSignIn(created.email);

    expect(setCookies.join('\n')).toContain('session_token');
    expect(setCookies.join('\n').toLowerCase()).toContain('httponly');

    const context = await resolveAuthContext(
      { auth, db: handle.db, tokens: makeTokenDeps() },
      { cookie },
    );
    expect(context).not.toBeNull();
    expect(context?.kind).toBe('web_session');
    expect(context?.userId).toBe(created.id);
    expect(context?.sessionId).not.toBeNull();
  });

  it('会话过期后解析失败（过期被正确处理）', async () => {
    const created = await createUser();
    const { cookie } = await webSignIn(created.email);

    await sleep(2300);
    const context = await resolveAuthContext({ auth, db: handle.db, tokens: makeTokenDeps() }, { cookie });
    expect(context).toBeNull();
  });

  it('退出后原会话立即失效', async () => {
    const created = await createUser();
    const { cookie } = await webSignIn(created.email);
    const deps = { auth, db: handle.db, tokens: makeTokenDeps() };

    expect(await resolveAuthContext(deps, { cookie })).not.toBeNull();
    await auth.api.signOut({ headers: new Headers({ cookie }) });
    expect(await resolveAuthContext(deps, { cookie })).toBeNull();
  });

  it('密码错误登录失败', async () => {
    const created = await createUser();
    await expect(
      auth.api.signInEmail({
        body: { email: created.email, password: 'wrong-password-1' },
        headers: new Headers(),
      }),
    ).rejects.toThrowError();
  });
});

describe('原生 PKCE 与令牌生命周期', () => {
  it('全流程：授权码 → 兑换 → Access Token 可用', async () => {
    const created = await createUser();
    const deps = makeTokenDeps();

    const code = await createAuthorizationCode(deps, {
      userId: created.id,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
    });
    const pair = tokenResponseSchema.parse(
      await exchangeAuthorizationCode(deps, { code, codeVerifier: VERIFIER, clientId: CLIENT_ID }),
    );

    const info = await verifyAccessToken(deps, pair.accessToken);
    expect(info).not.toBeNull();
    expect(info?.userId).toBe(created.id);
    expect(info?.clientId).toBe(CLIENT_ID);
  });

  it('PKCE verifier 不匹配被拒；授权码在失败后仍可使用（消费前校验）', async () => {
    const created = await createUser();
    const deps = makeTokenDeps();
    const code = await createAuthorizationCode(deps, {
      userId: created.id,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
    });

    await expect(
      exchangeAuthorizationCode(deps, { code, codeVerifier: 'wrong-verifier-'.repeat(4), clientId: CLIENT_ID }),
    ).rejects.toMatchObject({ code: 'INVALID_GRANT' });

    const pair = await exchangeAuthorizationCode(deps, { code, codeVerifier: VERIFIER, clientId: CLIENT_ID });
    expect(pair.accessToken).toMatch(/^ancs_at_/);
  });

  it('授权码单次使用；并发兑换只有一个成功', async () => {
    const created = await createUser();
    const deps = makeTokenDeps();
    const code = await createAuthorizationCode(deps, {
      userId: created.id,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
    });

    const results = await Promise.allSettled([
      exchangeAuthorizationCode(deps, { code, codeVerifier: VERIFIER, clientId: CLIENT_ID }),
      exchangeAuthorizationCode(deps, { code, codeVerifier: VERIFIER, clientId: CLIENT_ID }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AuthFailure);
  });

  it('授权码过期被拒', async () => {
    const created = await createUser();
    const deps = makeTokenDeps({ authorizationCodeTtlMs: 30 });
    const code = await createAuthorizationCode(deps, {
      userId: created.id,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
    });

    await sleep(60);
    await expect(
      exchangeAuthorizationCode(deps, { code, codeVerifier: VERIFIER, clientId: CLIENT_ID }),
    ).rejects.toMatchObject({ code: 'INVALID_GRANT' });
  });

  it('刷新轮换：旧 Refresh 重放触发家族撤销（新 Refresh 与 Access 一并失效）', async () => {
    const created = await createUser();
    const deps = makeTokenDeps();
    const code = await createAuthorizationCode(deps, {
      userId: created.id,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
    });
    const first = await exchangeAuthorizationCode(deps, { code, codeVerifier: VERIFIER, clientId: CLIENT_ID });

    const second = await refreshTokenPair(deps, { refreshToken: first.refreshToken, clientId: CLIENT_ID });
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // 重放旧 refresh：拒绝 + 家族整体撤销
    await expect(
      refreshTokenPair(deps, { refreshToken: first.refreshToken, clientId: CLIENT_ID }),
    ).rejects.toMatchObject({ code: 'INVALID_GRANT' });
    await expect(
      refreshTokenPair(deps, { refreshToken: second.refreshToken, clientId: CLIENT_ID }),
    ).rejects.toMatchObject({ code: 'INVALID_GRANT' });
    expect(await verifyAccessToken(deps, second.accessToken)).toBeNull();
  });

  it('Refresh 过期被拒', async () => {
    const created = await createUser();
    const deps = makeTokenDeps({ refreshTokenTtlMs: 30 });
    const code = await createAuthorizationCode(deps, {
      userId: created.id,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
    });
    const pair = await exchangeAuthorizationCode(deps, { code, codeVerifier: VERIFIER, clientId: CLIENT_ID });

    await sleep(60);
    await expect(
      refreshTokenPair(deps, { refreshToken: pair.refreshToken, clientId: CLIENT_ID }),
    ).rejects.toMatchObject({ code: 'INVALID_GRANT' });
  });

  it('撤销（退出原生会话）：Refresh 与 Access 同时失效', async () => {
    const created = await createUser();
    const deps = makeTokenDeps();
    const code = await createAuthorizationCode(deps, {
      userId: created.id,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
    });
    const pair = await exchangeAuthorizationCode(deps, { code, codeVerifier: VERIFIER, clientId: CLIENT_ID });

    await revokeRefreshToken(deps, { refreshToken: pair.refreshToken, clientId: CLIENT_ID });
    expect(await verifyAccessToken(deps, pair.accessToken)).toBeNull();
    await expect(
      refreshTokenPair(deps, { refreshToken: pair.refreshToken, clientId: CLIENT_ID }),
    ).rejects.toMatchObject({ code: 'INVALID_GRANT' });
  });

  it('Access Token 过期被拒（短生命周期）', async () => {
    const created = await createUser();
    const deps = makeTokenDeps({ accessTokenTtlMs: 50 });
    const code = await createAuthorizationCode(deps, {
      userId: created.id,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
    });
    const pair = await exchangeAuthorizationCode(deps, { code, codeVerifier: VERIFIER, clientId: CLIENT_ID });

    expect(await verifyAccessToken(deps, pair.accessToken)).not.toBeNull();
    await sleep(80);
    expect(await verifyAccessToken(deps, pair.accessToken)).toBeNull();
  });

  it('客户端注册校验：未注册 client 与不允许的 redirectUri 均为 INVALID_CLIENT', () => {
    const deps = makeTokenDeps();
    expect(() => assertRegisteredClient(deps.config, 'unknown-client', REDIRECT_URI)).toThrowError(AuthFailure);
    expect(() => assertRegisteredClient(deps.config, CLIENT_ID, 'ancs://evil/callback')).toThrowError(AuthFailure);
    expect(() => assertRegisteredClient(deps.config, CLIENT_ID, REDIRECT_URI)).not.toThrowError();
  });

  it('原生客户端配置解析（fail-closed）：空值返回 null，非法 JSON / 非法结构抛错', () => {
    expect(parseNativeClients(undefined)).toBeNull();
    expect(parseNativeClients('  ')).toBeNull();
    const clients = parseNativeClients('[{"clientId":"ancs-desktop","redirectUris":["ancs://auth/callback"]}]');
    expect(clients).toEqual([{ clientId: 'ancs-desktop', redirectUris: ['ancs://auth/callback'] }]);
    expect(() => parseNativeClients('not-json')).toThrowError();
    expect(() => parseNativeClients('[{"clientId":"x"}]')).toThrowError();
  });

  it('数据库只存哈希：明文令牌不落库（客户端无长期明文凭据的服务端侧保障）', async () => {
    const created = await createUser();
    const deps = makeTokenDeps();
    const code = await createAuthorizationCode(deps, {
      userId: created.id,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
    });
    const pair = await exchangeAuthorizationCode(deps, { code, codeVerifier: VERIFIER, clientId: CLIENT_ID });

    const accessRows = await handle.db.select().from(authAccessTokens);
    const refreshRows = await handle.db.select().from(authRefreshTokens);

    expect(accessRows).toHaveLength(1);
    expect(refreshRows).toHaveLength(1);
    expect(accessRows[0]?.tokenHash).toBe(sha256Hex(pair.accessToken));
    expect(refreshRows[0]?.tokenHash).toBe(sha256Hex(pair.refreshToken));
    // 整行序列化中不得出现任何明文令牌
    expect(JSON.stringify(accessRows)).not.toContain(pair.accessToken);
    expect(JSON.stringify(refreshRows)).not.toContain(pair.refreshToken);
    // 授权码同理（已消费行仍以哈希存在）
    expect(JSON.stringify(accessRows)).not.toContain(code);
  });
});
