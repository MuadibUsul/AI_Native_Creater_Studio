import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { base64UrlSha256, createAuth, createAuthorizationCode, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, exchangeAuthorizationCode, type AuthInstance } from '@ancs/auth';
import {
  adminPrincipals, adminRoleGrants, adminSessions, auditLog, createDb, redactDatabaseUrl,
  resolveTestDatabaseUrl, runMigrations, session, twoFactor, user, type DbHandle,
} from '@ancs/db';
import { buildServer } from './server.js';
import { provisionTestOpsPrincipal, signInTestOpsClient, testOpsDeps, testTotpCode } from './test-helpers/ops-auth.js';

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
const PASSWORD = 'test-ops-password-1234'; // secrets:check-ignore：测试专用假密钥
const client = (): AncsClient => createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
const status = async (promise: Promise<unknown>): Promise<number> => {
  const error = await promise.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(AncsApiError);
  return (error as AncsApiError).status;
};

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  if (new URL(url).pathname !== '/ancs_quiet_frame_test_261007') throw new Error('N15-02 requires the exact isolated test database');
  handle = createDb(url);
  try { await handle.pool.query('select 1'); }
  catch (error) { await handle.close(); throw new Error(`无法连接 ${redactDatabaseUrl(url)}`, { cause: error }); }
  await runMigrations(handle);
  auth = createAuth({ db: handle.db, secret: 'n15-02-integration-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    admin: testOpsDeps(handle.db),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
});

afterAll(async () => { await app.close(); await handle.close(); });

async function newAdmin() {
  const email = `n15-ops-${randomUUID()}@test.local`;
  const created = await createInternalUser(auth, { email, password: PASSWORD, name: 'N15 operator' });
  await provisionTestOpsPrincipal(handle.db, created.id);
  const enrollmentClient = client();
  const signIn = await enrollmentClient.auth.signIn({ email, password: PASSWORD });
  expect('user' in signIn).toBe(true);
  const enrollment = await enrollmentClient.ops.enrollTotp({ password: PASSWORD });
  return { email, userId: created.id, enrollmentClient, enrollment };
}

async function finishEnrollment(fixture: Awaited<ReturnType<typeof newAdmin>>): Promise<AncsClient> {
  const verified = await fixture.enrollmentClient.auth.verifyTotp({ code: testTotpCode(fixture.enrollment.totpUri) });
  expect('user' in verified).toBe(true);
  await fixture.enrollmentClient.auth.signOut();
  const current = client();
  await signInTestOpsClient(current, fixture.email, PASSWORD, fixture.enrollment.totpUri);
  return current;
}

describe('N15-02 独立运营认证', () => {
  it('旧普通会话、enrollment 确认均不签发 ops cookie；重新登录完成 TOTP 才可进入 /admin', async () => {
    const fixture = await newAdmin();
    expect(await status(fixture.enrollmentClient.admin.overview())).toBe(404);
    const verified = await fixture.enrollmentClient.auth.verifyTotp({ code: testTotpCode(fixture.enrollment.totpUri) });
    expect('user' in verified).toBe(true);
    expect(await status(fixture.enrollmentClient.admin.overview())).toBe(404);
    const factorRow = (await handle.db.select().from(twoFactor).where(eq(twoFactor.userId, fixture.userId)).limit(1))[0];
    expect(factorRow?.verified).toBe(true);
    expect(factorRow?.secret).not.toContain(new URL(fixture.enrollment.totpUri).searchParams.get('secret'));
    expect(factorRow?.backupCodes).not.toContain(fixture.enrollment.backupCodes[0]);
    expect(() => JSON.parse(factorRow?.backupCodes ?? '')).toThrow();
    await fixture.enrollmentClient.auth.signOut();
    const ops = client();
    await signInTestOpsClient(ops, fixture.email, PASSWORD, fixture.enrollment.totpUri);
    expect((await ops.ops.session()).environment).toBe('TEST');
    expect((await ops.admin.overview()).generatedAt).toBeTruthy();
  });

  it('旧名单、客户 Owner 和测试身份不能绕过独立运营受众', async () => {
    const email = `n15-owner-${randomUUID()}@test.local`;
    const ordinary = await createInternalUser(auth, { email, password: PASSWORD, name: 'owner' });
    const owner = client();
    await owner.auth.signIn({ email, password: PASSWORD });
    expect(await status(owner.admin.overview())).toBe(404);
    expect(await status(owner.ops.enrollTotp({ password: PASSWORD }))).toBe(404);
    await provisionTestOpsPrincipal(handle.db, ordinary.id);
    const robotPrincipal = (await handle.db.select().from(adminPrincipals).where(eq(adminPrincipals.userId, ordinary.id)).limit(1))[0]!;
    await handle.db.insert(adminRoleGrants).values({ id: `oprg_${randomUUID()}`, principalId: robotPrincipal.id, role: 'SERVICE_ACCOUNT' });
    expect(await status(owner.ops.enrollTotp({ password: PASSWORD }))).toBe(404);

    const legacy = await buildServer({
      auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
      admin: { userIds: [ordinary.id] },
    });
    await legacy.listen({ port: 0, host: '127.0.0.1' });
    try {
      const oldClient = createClient({ baseUrl: `http://127.0.0.1:${String((legacy.server.address() as AddressInfo).port)}`, clientType: 'web' });
      await oldClient.auth.signIn({ email, password: PASSWORD });
      expect(await status(oldClient.admin.overview())).toBe(404);
    } finally { await legacy.close(); }
  });

  it('撤销、退出、角色移除及 MFA 停用立即拒绝已有运营会话', async () => {
    const revokeFixture = await newAdmin();
    const revokeClient = await finishEnrollment(revokeFixture);
    const current = await revokeClient.ops.session();
    await revokeClient.ops.revokeSession({ sessionId: current.id });
    expect(await status(revokeClient.admin.overview())).toBe(404);

    const signOutFixture = await newAdmin();
    const signOutClient = await finishEnrollment(signOutFixture);
    const authSessionId = (await handle.db.select({ id: adminSessions.authSessionId }).from(adminSessions)
      .where(eq(adminSessions.principalId, (await signOutClient.ops.session()).principalId)).orderBy(desc(adminSessions.createdAt)).limit(1))[0]?.id;
    await signOutClient.auth.signOut();
    expect(await status(signOutClient.admin.overview())).toBe(401);
    expect((await handle.db.select().from(session).where(eq(session.id, authSessionId!)).limit(1)).length).toBe(0);

    const roleFixture = await newAdmin();
    const roleClient = await finishEnrollment(roleFixture);
    const principal = (await handle.db.select().from(adminPrincipals).where(eq(adminPrincipals.userId, roleFixture.userId)).limit(1))[0]!;
    const auditorGrantId = `oprg_${randomUUID()}`;
    await handle.db.insert(adminRoleGrants).values({ id: auditorGrantId, principalId: principal.id, role: 'AUDITOR' });
    expect(await status(roleClient.admin.overview())).toBe(404);
    await roleClient.auth.signOut();
    const roleClientAfterGrant = client();
    await signInTestOpsClient(roleClientAfterGrant, roleFixture.email, PASSWORD, roleFixture.enrollment.totpUri);
    const versionBeforeRevoke = (await handle.db.select({ version: adminPrincipals.grantVersion }).from(adminPrincipals).where(eq(adminPrincipals.id, principal.id)).limit(1))[0]!.version;
    await handle.db.update(adminRoleGrants).set({ revokedAt: new Date() }).where(and(
      eq(adminRoleGrants.principalId, principal.id), eq(adminRoleGrants.role, 'PRODUCTION_OPERATOR'), isNull(adminRoleGrants.revokedAt),
    ));
    expect(await status(roleClientAfterGrant.admin.overview())).toBe(404);
    const versionAfterRevoke = (await handle.db.select({ version: adminPrincipals.grantVersion }).from(adminPrincipals).where(eq(adminPrincipals.id, principal.id)).limit(1))[0]!.version;
    expect(versionAfterRevoke).toBeGreaterThan(versionBeforeRevoke);
    await handle.db.delete(adminRoleGrants).where(eq(adminRoleGrants.id, auditorGrantId));
    const versionAfterDelete = (await handle.db.select({ version: adminPrincipals.grantVersion }).from(adminPrincipals).where(eq(adminPrincipals.id, principal.id)).limit(1))[0]!.version;
    expect(versionAfterDelete).toBeGreaterThan(versionAfterRevoke);

    const mfaFixture = await newAdmin();
    const mfaClient = await finishEnrollment(mfaFixture);
    await handle.db.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, mfaFixture.userId));
    expect(await status(mfaClient.admin.overview())).toBe(404);
  }, 120_000);

  it('空闲过期、敏感重验与错误验证码锁定按服务端状态执行', async () => {
    const fixture = await newAdmin();
    const ops = await finishEnrollment(fixture);
    const current = await ops.ops.session();
    await handle.db.update(adminSessions).set({ reauthenticatedAt: new Date(Date.now() - 600_000) }).where(eq(adminSessions.id, current.id));
    expect(await status(ops.admin.retryJob('job_missing'))).toBe(403);
    expect(await status(ops.ops.reauthenticate({ code: '000000' }))).toBe(401);
    const failed = (await handle.db.select({ failures: adminSessions.reauthFailures }).from(adminSessions).where(eq(adminSessions.id, current.id)).limit(1))[0];
    expect(failed?.failures).toBe(1);
    await ops.ops.reauthenticate({ code: testTotpCode(fixture.enrollment.totpUri) });
    expect(await status(ops.admin.retryJob('job_missing'))).not.toBe(403);
    await handle.db.update(adminSessions).set({ lastSeenAt: new Date(Date.now() - 901_000) }).where(eq(adminSessions.id, current.id));
    expect(await status(ops.admin.overview())).toBe(404);
  }, 120_000);

  it('Native Bearer、错误 ops cookie 与绝对过期不能进入 /admin', async () => {
    const fixture = await newAdmin();
    const verifier = 'native-test-verifier-0123456789-abcdefghi';
    const nativeDeps = { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG };
    const code = await createAuthorizationCode(nativeDeps, {
      userId: fixture.userId, clientId: 'ancs-desktop', redirectUri: 'ancs://auth/callback',
      codeChallenge: base64UrlSha256(verifier),
    });
    const pair = await exchangeAuthorizationCode(nativeDeps, {
      code, codeVerifier: verifier, clientId: 'ancs-desktop', redirectUri: 'ancs://auth/callback',
    });
    const bearerResponse = await fetch(`${baseUrl}/api/v1/admin/overview`, { headers: { authorization: `Bearer ${pair.accessToken}` } });
    expect(bearerResponse.status).toBe(404);

    await fixture.enrollmentClient.auth.verifyTotp({ code: testTotpCode(fixture.enrollment.totpUri) });
    await fixture.enrollmentClient.auth.signOut();
    const tampered = createClient({
      baseUrl, clientType: 'web',
      fetchImpl: (url, init) => {
        if (String(url).includes('/admin/')) {
          const headers = new Headers(init?.headers);
          const cookie = headers.get('cookie') ?? '';
          headers.set('cookie', cookie.replace(/ancs_ops_session=[^;]+/, `ancs_ops_session=${'A'.repeat(43)}`));
          return fetch(url, { ...init, headers });
        }
        return fetch(url, init);
      },
    });
    await signInTestOpsClient(tampered, fixture.email, PASSWORD, fixture.enrollment.totpUri);
    expect(await status(tampered.admin.overview())).toBe(404);
    const current = await tampered.ops.session();
    await handle.db.update(adminSessions).set({ absoluteExpiresAt: new Date(Date.now() - 1000) }).where(eq(adminSessions.id, current.id));
    expect(await status(tampered.ops.session())).toBe(404);
  }, 120_000);

  it('不同设备登录追加告警证据，TEST principal 不能进入生产，生产旧 Admin 读写均关闭', async () => {
    const fixture = await newAdmin();
    const first = await finishEnrollment(fixture);
    const firstOps = await first.ops.session();
    const differentAgent = createClient({
      baseUrl, clientType: 'web',
      fetchImpl: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('user-agent', 'N15-02 second test device');
        return fetch(url, { ...init, headers });
      },
    });
    await signInTestOpsClient(differentAgent, fixture.email, PASSWORD, fixture.enrollment.totpUri);
    const alert = await handle.db.select().from(auditLog).where(and(
      eq(auditLog.action, 'ops.auth.new_device'), eq(auditLog.actorUserId, fixture.userId),
    )).limit(1);
    expect(alert).toHaveLength(1);
    const changedDeviceSession = await differentAgent.ops.session();
    expect(changedDeviceSession.principalId).toBe(firstOps.principalId);
    expect(changedDeviceSession.securityNotice).toBe('NEW_DEVICE');

    const production = await buildServer({
      auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
      admin: { ops: { ...testOpsDeps(handle.db).ops!, environment: 'PRODUCTION' } },
    });
    await production.listen({ port: 0, host: '127.0.0.1' });
    try {
      const productionClient = createClient({ baseUrl: `http://127.0.0.1:${String((production.server.address() as AddressInfo).port)}`, clientType: 'web' });
      const challenge = await productionClient.auth.signIn({ email: fixture.email, password: PASSWORD });
      expect('twoFactorRequired' in challenge).toBe(true);
      await productionClient.auth.verifyTotp({ code: testTotpCode(fixture.enrollment.totpUri) });
      expect(await status(productionClient.admin.overview())).toBe(404);
      const productionPrincipalId = `oppr_${randomUUID()}`;
      await handle.db.insert(adminPrincipals).values({ id: productionPrincipalId, userId: fixture.userId, environment: 'PRODUCTION' });
      await handle.db.insert(adminRoleGrants).values({ id: `oprg_${randomUUID()}`, principalId: productionPrincipalId, role: 'PRODUCTION_OPERATOR' });
      await productionClient.auth.signOut();
      expect('twoFactorRequired' in await productionClient.auth.signIn({ email: fixture.email, password: PASSWORD })).toBe(true);
       await productionClient.auth.verifyTotp({ code: testTotpCode(fixture.enrollment.totpUri) });
       const productionSession = await productionClient.ops.session();
       expect(productionSession.environment).toBe('PRODUCTION');
       expect(await status(productionClient.admin.overview())).toBe(403);
       expect(await status(productionClient.admin.users())).toBe(403);
       expect(await status(productionClient.admin.jobs())).toBe(403);
       expect(await status(productionClient.admin.supportView(`ws_${randomUUID()}`))).toBe(403);
       expect(await status(productionClient.admin.retryJob('job_missing'))).toBe(403);
       await productionClient.ops.reauthenticate({ code: testTotpCode(fixture.enrollment.totpUri) });
       expect((await productionClient.ops.session()).id).toBe(productionSession.id);
       await productionClient.ops.revokeSession({ sessionId: productionSession.id });
       expect(await status(productionClient.ops.session())).toBe(404);
    } finally { await production.close(); }
  }, 120_000);
});
