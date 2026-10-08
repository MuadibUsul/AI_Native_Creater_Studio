import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { opsSessionSchema } from '@ancs/contracts';
import { assessEmergencyGrant, base64UrlSha256, createAuth, createAuthorizationCode, createInternalUser, decideOpsPermission, DEFAULT_NATIVE_TOKEN_CONFIG, exchangeAuthorizationCode, OPS_PERMISSION_POLICY_HASH, OPS_PERMISSION_POLICY_VERSION, type AuthInstance } from '@ancs/auth';
import {
  adminEmergencyGrants, adminPermissionPolicyVersions, adminPrincipals, adminRoleGrants, adminRoleScopes, adminSessions, auditLog, createDb, redactDatabaseUrl,
  resolveTestDatabaseUrl, runMigrations, session, twoFactor, user, type DbHandle,
} from '@ancs/db';
import { buildServer } from './server.js';
import { provisionTestOpsPrincipal, signInTestOpsClient, testOpsDeps, testTotpCode } from './test-helpers/ops-auth.js';
import { LEGACY_ADMIN_ACTIONS } from './plugins/admin-actions.js';

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

/** Policy rows are immutable after publication; roll test publications back instead of polluting later runs. */
async function withRolledBackDb(run: (db: DbHandle['db']) => Promise<void>): Promise<void> {
  const rollbackMarker = Symbol('rollback-test-policy');
  try {
    await handle.db.transaction(async (transaction) => {
      await run(transaction as unknown as DbHandle['db']);
      throw rollbackMarker;
    });
  } catch (error) {
    if (error !== rollbackMarker) throw error;
  }
}

async function expectRejectedInSavepoint(db: DbHandle['db'], statement: () => PromiseLike<unknown>): Promise<void> {
  await db.execute(sql.raw('SAVEPOINT n15_expected_rejection'));
  try {
    await expect(statement()).rejects.toThrow();
  } finally {
    await db.execute(sql.raw('ROLLBACK TO SAVEPOINT n15_expected_rejection'));
    await db.execute(sql.raw('RELEASE SAVEPOINT n15_expected_rejection'));
  }
}

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

describe('N15-03 运营动作矩阵与 0053 作用域', () => {
  it('23 个旧路由都有封闭 action；显式平台 scope 可读总览，未知 action 默认拒绝', async () => {
    expect(Object.keys(LEGACY_ADMIN_ACTIONS)).toHaveLength(23);
    expect(new Set(Object.values(LEGACY_ADMIN_ACTIONS)).size).toBe(23);
    const fixture = await newAdmin();
    const ops = await finishEnrollment(fixture);
    const session = await ops.ops.session();
    const empty = { workspaceId: null, resourceKind: null, resourceId: null, amountCredits: null, ticketId: null } as const;
    expect((await decideOpsPermission(testOpsDeps(handle.db).ops!, { session, action: 'ops.overview.read', target: empty })).allowed).toBe(true);
    expect((await decideOpsPermission(testOpsDeps(handle.db).ops!, { session, action: 'ops.unknown.read', target: empty })).reason).toBe('UNKNOWN_ACTION');
    expect((await ops.admin.overview()).generatedAt).toBeTruthy();
    expect(await status(ops.admin.users())).toBe(403);
    expect(await status(ops.admin.retryJob('job_missing'))).toBe(403);
  }, 120_000);

  it('旧 role grant 无 scope 不授权；错误角色、过期和撤销 scope 均拒绝', async () => {
    const noScope = await newAdmin();
    const noScopePrincipal = (await handle.db.select().from(adminPrincipals).where(eq(adminPrincipals.userId, noScope.userId)).limit(1))[0]!;
    const roleGrant = (await handle.db.select().from(adminRoleGrants).where(eq(adminRoleGrants.principalId, noScopePrincipal.id)).limit(1))[0]!;
    await handle.db.delete(adminRoleScopes).where(eq(adminRoleScopes.roleGrantId, roleGrant.id));
    const noScopeClient = await finishEnrollment(noScope);
    expect(await status(noScopeClient.admin.overview())).toBe(403);

    const wrongRole = await newAdmin();
    const rolePrincipal = (await handle.db.select().from(adminPrincipals).where(eq(adminPrincipals.userId, wrongRole.userId)).limit(1))[0]!;
    await handle.db.update(adminRoleGrants).set({ role: 'SUPPORT_L1' }).where(eq(adminRoleGrants.principalId, rolePrincipal.id));
    expect(await status((await finishEnrollment(wrongRole)).admin.overview())).toBe(403);

    const expired = await newAdmin();
    const expiredPrincipal = (await handle.db.select().from(adminPrincipals).where(eq(adminPrincipals.userId, expired.userId)).limit(1))[0]!;
    const expiredGrant = (await handle.db.select().from(adminRoleGrants).where(eq(adminRoleGrants.principalId, expiredPrincipal.id)).limit(1))[0]!;
    await handle.db.update(adminRoleScopes).set({
      startsAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000),
    }).where(eq(adminRoleScopes.roleGrantId, expiredGrant.id));
    expect(await status((await finishEnrollment(expired)).admin.overview())).toBe(403);

    const revoked = await newAdmin();
    const revokedPrincipal = (await handle.db.select().from(adminPrincipals).where(eq(adminPrincipals.userId, revoked.userId)).limit(1))[0]!;
    const revokedGrant = (await handle.db.select().from(adminRoleGrants).where(eq(adminRoleGrants.principalId, revokedPrincipal.id)).limit(1))[0]!;
    await handle.db.update(adminRoleScopes).set({ revokedAt: new Date() }).where(eq(adminRoleScopes.roleGrantId, revokedGrant.id));
    expect(await status((await finishEnrollment(revoked)).admin.overview())).toBe(403);
  }, 120_000);

  it('金额与租户 scope 决策：越界拒绝，界内高风险写仍需审批', async () => {
    const fixture = await newAdmin();
    const principal = (await handle.db.select().from(adminPrincipals).where(eq(adminPrincipals.userId, fixture.userId)).limit(1))[0]!;
    const billingGrantId = `oprg_${randomUUID()}`;
    const workspaceId = `ws_${randomUUID()}`;
    await handle.db.insert(adminRoleGrants).values({ id: billingGrantId, principalId: principal.id, role: 'BILLING_OPERATOR' });
    await handle.db.insert(adminRoleScopes).values({
      id: `opsc_${randomUUID()}`, roleGrantId: billingGrantId, scopeKind: 'WORKSPACE', workspaceId,
      maxCredits: 100, expiresAt: new Date(Date.now() + 60_000),
    });
    const session = await (await finishEnrollment(fixture)).ops.session();
    const target = { workspaceId, resourceKind: null, resourceId: null, amountCredits: 50, ticketId: null } as const;
    const deps = testOpsDeps(handle.db).ops!;
    expect((await decideOpsPermission(deps, { session, action: 'ops.credit.grant', target })).reason).toBe('APPROVAL_REQUIRED');
    expect((await decideOpsPermission(deps, { session, action: 'ops.credit.grant', target: { ...target, amountCredits: 101 } })).reason).toBe('AMOUNT_EXCEEDED');
    expect((await decideOpsPermission(deps, { session, action: 'ops.credit.grant', target: { ...target, workspaceId: `ws_${randomUUID()}` } })).reason).toBe('SCOPE_MISSING');
    expect((await decideOpsPermission({ ...deps, environment: 'STAGING' }, { session, action: 'ops.credit.grant', target })).reason).toBe('ENVIRONMENT_MISMATCH');
  }, 120_000);

  it('工单支持视图要求有限期角色 scope，不能使用永久 workspace scope', async () => {
    const fixture = await newAdmin();
    const principal = (await handle.db.select().from(adminPrincipals).where(eq(adminPrincipals.userId, fixture.userId)).limit(1))[0]!;
    const roleGrantId = `oprg_${randomUUID()}`;
    const workspaceId = `ws_${randomUUID()}`;
    await handle.db.insert(adminRoleGrants).values({ id: roleGrantId, principalId: principal.id, role: 'SUPPORT_L2' });
    await handle.db.insert(adminRoleScopes).values({
      id: `opsc_${randomUUID()}`, roleGrantId, scopeKind: 'WORKSPACE', workspaceId, ticketId: 'ticket-finite',
    });
    const session = await (await finishEnrollment(fixture)).ops.session();
    const decision = await decideOpsPermission(testOpsDeps(handle.db).ops!, {
      session, action: 'ops.support.view',
      target: { workspaceId, resourceKind: null, resourceId: null, amountCredits: null, ticketId: 'ticket-finite' },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('SCOPE_EXPIRED');
  }, 120_000);

  it('无工单的 scope 不遮蔽同角色下后续有效工单 scope', async () => {
    const fixture = await newAdmin();
    const principal = (await handle.db.select().from(adminPrincipals).where(eq(adminPrincipals.userId, fixture.userId)).limit(1))[0]!;
    const roleGrantId = `oprg_${randomUUID()}`;
    const workspaceId = `ws_${randomUUID()}`;
    await handle.db.insert(adminRoleGrants).values({ id: roleGrantId, principalId: principal.id, role: 'SUPPORT_L2' });
    await handle.db.insert(adminRoleScopes).values([
      { id: `opsc_${randomUUID()}`, roleGrantId, scopeKind: 'WORKSPACE', workspaceId, expiresAt: new Date(Date.now() + 60_000) },
      { id: `opsc_${randomUUID()}`, roleGrantId, scopeKind: 'WORKSPACE', workspaceId, ticketId: 'ticket-valid', expiresAt: new Date(Date.now() + 60_000) },
    ]);
    const session = await (await finishEnrollment(fixture)).ops.session();
    const deps = testOpsDeps(handle.db).ops!;
    const target = { workspaceId, resourceKind: null, resourceId: null, amountCredits: null, ticketId: 'ticket-valid' } as const;
    expect((await decideOpsPermission(deps, { session, action: 'ops.support.view', target })).allowed).toBe(true);
    expect((await decideOpsPermission(deps, { session, action: 'ops.support.view', target: { ...target, ticketId: null } })).reason).toBe('TICKET_REQUIRED');
  }, 120_000);

  it('0053 INSERT/UPDATE/DELETE scope 即时增加 grantVersion，DB 拒绝非法环境与角色', async () => {
    const fixture = await newAdmin();
    const principal = (await handle.db.select().from(adminPrincipals).where(eq(adminPrincipals.userId, fixture.userId)).limit(1))[0]!;
    const roleGrant = (await handle.db.select().from(adminRoleGrants).where(eq(adminRoleGrants.principalId, principal.id)).limit(1))[0]!;
    const version = async () => (await handle.db.select({ grantVersion: adminPrincipals.grantVersion }).from(adminPrincipals).where(eq(adminPrincipals.id, principal.id)).limit(1))[0]!.grantVersion;
    const initial = await version();
    const scopeId = `opsc_${randomUUID()}`;
    await handle.db.insert(adminRoleScopes).values({ id: scopeId, roleGrantId: roleGrant.id, scopeKind: 'WORKSPACE', workspaceId: `ws_${randomUUID()}` });
    expect(await version()).toBe(initial + 1);
    await handle.db.update(adminRoleScopes).set({ ticketId: 'ticket-version-test' }).where(eq(adminRoleScopes.id, scopeId));
    expect(await version()).toBe(initial + 2);
    await handle.db.delete(adminRoleScopes).where(eq(adminRoleScopes.id, scopeId));
    expect(await version()).toBe(initial + 3);
    await expect(handle.db.update(adminPrincipals).set({ environment: 'INVALID' }).where(eq(adminPrincipals.id, principal.id))).rejects.toThrow();
    await expect(handle.db.update(adminRoleGrants).set({ role: 'SUPER_ADMIN' }).where(eq(adminRoleGrants.id, roleGrant.id))).rejects.toThrow();
  }, 120_000);

  it('0054 策略缺失和 hash 漂移默认拒绝，发布版本不可改写或删除', async () => {
    const email = `policy-staging-${randomUUID()}@test.local`;
    const created = await createInternalUser(auth, { email, password: PASSWORD, name: 'policy actor' });
    await withRolledBackDb(async (db) => {
    const principalId = `oppr_${randomUUID()}`;
    const roleGrantId = `oprg_${randomUUID()}`;
    await db.insert(adminPrincipals).values({ id: principalId, userId: created.id, environment: 'STAGING' });
    await db.insert(adminRoleGrants).values({ id: roleGrantId, principalId, role: 'PRODUCTION_OPERATOR' });
    await db.insert(adminRoleScopes).values({ id: `opsc_${randomUUID()}`, roleGrantId, scopeKind: 'PLATFORM' });
    const now = new Date();
    const session = opsSessionSchema.parse({
      id: `opss_${randomUUID()}`, principalId, environment: 'STAGING', roles: ['PRODUCTION_OPERATOR'],
      createdAt: now.toISOString(), idleExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + 120_000).toISOString(),
      reauthenticatedAt: now.toISOString(), securityNotice: null,
    });
    const deps = { ...testOpsDeps(db).ops!, environment: 'STAGING' as const };
    const target = { workspaceId: null, resourceKind: null, resourceId: null, amountCredits: null, ticketId: null } as const;
    expect((await decideOpsPermission(deps, { session, action: 'ops.overview.read', target })).reason).toBe('POLICY_INACTIVE');

    const driftId = `oppv_${randomUUID()}`;
    await db.insert(adminPermissionPolicyVersions).values({
      id: driftId, environment: 'STAGING', version: OPS_PERMISSION_POLICY_VERSION,
      rulesHash: '0'.repeat(64), status: 'ACTIVE', publishedByPrincipalId: principalId, publishedAt: now,
    });
    expect((await decideOpsPermission(deps, { session, action: 'ops.overview.read', target })).reason).toBe('POLICY_MISMATCH');
    await expectRejectedInSavepoint(db, () => db.update(adminPermissionPolicyVersions).set({ rulesHash: OPS_PERMISSION_POLICY_HASH })
      .where(eq(adminPermissionPolicyVersions.id, driftId)));
    await expectRejectedInSavepoint(db, () => db.delete(adminPermissionPolicyVersions).where(eq(adminPermissionPolicyVersions.id, driftId)));
    await db.update(adminPermissionPolicyVersions).set({ status: 'RETIRED', retiredAt: new Date() })
      .where(eq(adminPermissionPolicyVersions.id, driftId));
    const activeId = `oppv_${randomUUID()}`;
    await db.insert(adminPermissionPolicyVersions).values({
      id: activeId, environment: 'STAGING', version: `${OPS_PERMISSION_POLICY_VERSION}-active`,
      rulesHash: OPS_PERMISSION_POLICY_HASH, status: 'ACTIVE', publishedByPrincipalId: principalId, publishedAt: now,
    });
    expect((await decideOpsPermission(deps, { session, action: 'ops.overview.read', target })).reason).toBe('POLICY_MISMATCH');
    await db.update(adminPermissionPolicyVersions).set({ status: 'RETIRED', retiredAt: new Date() })
      .where(eq(adminPermissionPolicyVersions.id, activeId));
    // A version string is immutable after publication: the only valid new row is an explicitly new environment/version.
    const matchingId = `oppv_${randomUUID()}`;
    await expectRejectedInSavepoint(db, () => db.insert(adminPermissionPolicyVersions).values({
      id: matchingId, environment: 'STAGING', version: OPS_PERMISSION_POLICY_VERSION,
      rulesHash: OPS_PERMISSION_POLICY_HASH, status: 'ACTIVE', publishedByPrincipalId: principalId, publishedAt: now,
    }));
    await expectRejectedInSavepoint(db, () => db.insert(adminPermissionPolicyVersions).values({
      id: `oppv_${randomUUID()}`, environment: 'DEVELOPMENT', version: 'invalid',
      rulesHash: 'not-a-hash', status: 'DRAFT',
    }));
    });
  }, 120_000);

  it('0054/0055 紧急资格限具体对象与 30 分钟止损；财务、发布与未核实身份的复核不可借道', async () => {
    const email = `emergency-${randomUUID()}@test.local`;
    const created = await createInternalUser(auth, { email, password: PASSWORD, name: 'incident actor' });
    await withRolledBackDb(async (db) => {
    const principalId = `oppr_${randomUUID()}`;
    await db.insert(adminPrincipals).values({ id: principalId, userId: created.id, environment: 'DEVELOPMENT' });
    await db.insert(adminRoleGrants).values({ id: `oprg_${randomUUID()}`, principalId, role: 'PRODUCTION_OPERATOR' });
    const now = new Date();
    await db.insert(adminPermissionPolicyVersions).values({
      id: `oppv_${randomUUID()}`, environment: 'DEVELOPMENT', version: OPS_PERMISSION_POLICY_VERSION,
      rulesHash: OPS_PERMISSION_POLICY_HASH, status: 'ACTIVE', publishedByPrincipalId: principalId, publishedAt: now,
    });
    const session = opsSessionSchema.parse({
      id: `opss_${randomUUID()}`, principalId, environment: 'DEVELOPMENT', roles: ['PRODUCTION_OPERATOR'],
      createdAt: now.toISOString(), idleExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + 120_000).toISOString(),
      reauthenticatedAt: now.toISOString(), securityNotice: null,
    });
    const deps = { ...testOpsDeps(db).ops!, environment: 'DEVELOPMENT' as const };
    const targetId = `ws_${randomUUID()}`;
    const incidentId = `incident-${randomUUID()}`;
    const grantId = `opem_${randomUUID()}`;
    const request = { session, action: 'PAUSE_NEW_GENERATION', targetKind: 'WORKSPACE', targetId, incidentId, now };
    expect((await assessEmergencyGrant(deps, request)).reason).toBe('GRANT_MISSING');
    await db.insert(adminEmergencyGrants).values({
      id: grantId, environment: 'DEVELOPMENT', principalId, action: 'PAUSE_NEW_GENERATION',
      targetKind: 'WORKSPACE', targetId, incidentId, reason: '异常付费生成止损复核',
      startsAt: new Date(now.getTime() - 1000), expiresAt: new Date(now.getTime() + 10 * 60_000),
      reviewDueAt: new Date(now.getTime() + 60 * 60_000),
    });
    expect((await assessEmergencyGrant(deps, request)).reason).toBe('ALERT_REQUIRED');
    await db.update(adminEmergencyGrants).set({ alertedAt: now }).where(eq(adminEmergencyGrants.id, grantId));
    expect((await assessEmergencyGrant(deps, request)).eligible).toBe(true);
    expect((await assessEmergencyGrant(deps, { ...request, targetId: `ws_${randomUUID()}` })).reason).toBe('GRANT_MISSING');
    expect((await assessEmergencyGrant(deps, { ...request, incidentId: 'other-incident' })).reason).toBe('INCIDENT_MISMATCH');
    expect((await assessEmergencyGrant(deps, { ...request, action: 'REFUND_CASH' })).reason).toBe('UNKNOWN_ACTION');
    expect((await assessEmergencyGrant(deps, { ...request, action: 'PUBLISH_ASSET' })).reason).toBe('UNKNOWN_ACTION');
    expect((await assessEmergencyGrant(deps, { ...request, action: 'UNLOCK_PROJECT' })).reason).toBe('UNKNOWN_ACTION');
    expect((await assessEmergencyGrant(deps, { ...request, now: new Date(now.getTime() + 11 * 60_000) })).reason).toBe('GRANT_EXPIRED');
    await expectRejectedInSavepoint(db, () => db.update(adminEmergencyGrants).set({ reviewedAt: now, reviewedByPrincipalId: principalId })
      .where(eq(adminEmergencyGrants.id, grantId)));
    for (const untrustedReviewer of [principalId, `oppr_${randomUUID()}`]) {
      await expectRejectedInSavepoint(db, () => db.insert(adminEmergencyGrants).values({
        id: `opem_${randomUUID()}`, environment: 'DEVELOPMENT', principalId, action: 'PAUSE_NEW_GENERATION',
        targetKind: 'WORKSPACE', targetId, incidentId, reason: '未核实真实身份禁止复核',
        startsAt: now, expiresAt: new Date(now.getTime() + 10 * 60_000),
        reviewDueAt: new Date(now.getTime() + 60 * 60_000), reviewedAt: now, reviewedByPrincipalId: untrustedReviewer,
      }));
    }
    await expectRejectedInSavepoint(db, () => db.update(adminEmergencyGrants).set({ reviewedAt: now, reviewedByPrincipalId: `oppr_${randomUUID()}` })
      .where(eq(adminEmergencyGrants.id, grantId)));
    await expectRejectedInSavepoint(db, () => db.delete(adminEmergencyGrants).where(eq(adminEmergencyGrants.id, grantId)));
    await db.update(adminEmergencyGrants).set({ revokedAt: new Date() }).where(eq(adminEmergencyGrants.id, grantId));
    expect((await assessEmergencyGrant(deps, request)).reason).toBe('GRANT_REVOKED');
    await expectRejectedInSavepoint(db, () => db.insert(adminEmergencyGrants).values({
      id: `opem_${randomUUID()}`, environment: 'DEVELOPMENT', principalId, action: 'PAUSE_NEW_GENERATION',
      targetKind: 'WORKSPACE', targetId, incidentId, reason: '止损理由足够长度',
      startsAt: now, expiresAt: new Date(now.getTime() + 31 * 60_000), reviewDueAt: new Date(now.getTime() + 60 * 60_000),
    }));
    await expectRejectedInSavepoint(db, () => db.insert(adminEmergencyGrants).values({
      id: `opem_${randomUUID()}`, environment: 'DEVELOPMENT', principalId, action: 'PAUSE_NEW_GENERATION',
      targetKind: 'OPS_SESSION', targetId, incidentId, reason: '目标种类不得改写',
      startsAt: now, expiresAt: new Date(now.getTime() + 10 * 60_000), reviewDueAt: new Date(now.getTime() + 60 * 60_000),
    }));
    });
  }, 120_000);
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
    const refreshed = (await handle.db.select({ reauthenticatedAt: adminSessions.reauthenticatedAt, failures: adminSessions.reauthFailures })
      .from(adminSessions).where(eq(adminSessions.id, current.id)).limit(1))[0];
    expect(refreshed?.reauthenticatedAt.getTime()).toBeGreaterThan(Date.now() - 30_000);
    expect(refreshed?.failures).toBe(0);
    // N15-03 keeps the legacy write closed even after a successful TOTP recheck.
    expect(await status(ops.admin.retryJob('job_missing'))).toBe(403);
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
       expect(await status(productionClient.admin.jobs({ workspaceId: `ws_${randomUUID()}` }))).toBe(403);
       expect(await status(productionClient.admin.supportView(`ws_${randomUUID()}`, 'ticket-production-test'))).toBe(403);
       expect(await status(productionClient.admin.retryJob('job_missing'))).toBe(403);
       await productionClient.ops.reauthenticate({ code: testTotpCode(fixture.enrollment.totpUri) });
       expect((await productionClient.ops.session()).id).toBe(productionSession.id);
       await productionClient.ops.revokeSession({ sessionId: productionSession.id });
       expect(await status(productionClient.ops.session())).toBe(404);
    } finally { await production.close(); }
  }, 120_000);
});
