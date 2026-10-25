import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { OpsRole, OpsSession } from '@ancs/contracts';
import { adminPermissionPolicyVersions, adminPrincipals, adminRoleGrants, auditLog, createDb, resolveTestDatabaseUrl, runMigrations, user, workspaces, type DbHandle } from '@ancs/db';
import {
  createAuth, createInternalUser, decideOpsPermission, grantOpsAccess, OPS_PERMISSION_POLICY_HASH, OPS_PERMISSION_POLICY_VERSION, OpsGrantError,
  type AuthInstance, type OpsAuthDeps,
} from './index.js';

/**
 * I-13 运营后台授权（真实 PostgreSQL）：给已有账号开通运营身份、角色与范围，发布与代码一致的权限策略，
 * 可重复执行，改动后旧会话失效，写审计。
 * 已发布的策略版本不可删除（迁移 0054 触发器），所以每个用例都在 STAGING 环境、并在回滚的事务里做（与 ops-auth 集成测试同法）。
 */

type Db = DbHandle['db'];
const ENV = 'STAGING' as const;
let handle: DbHandle;
let auth: AuthInstance;
const users: string[] = [];

const newAccount = async (): Promise<{ id: string; email: string }> => {
  const email = `ops-grant-${randomUUID().slice(0, 8)}@test.local`;
  const created = await createInternalUser(auth, { email, password: 'password-1234', name: 'Ops' });
  users.push(created.id);
  return { id: created.id, email };
};
const deps = (db: Db): OpsAuthDeps => ({ db, environment: ENV, fingerprintKey: 'unused', policy: { idleSeconds: 900, absoluteSeconds: 28800, reauthSeconds: 300 } });
const session = (principalId: string, roles: OpsRole[]): OpsSession => {
  const now = new Date().toISOString();
  return { id: `ops_${randomUUID()}`, principalId, environment: ENV, roles, createdAt: now, idleExpiresAt: now, absoluteExpiresAt: now, reauthenticatedAt: now, securityNotice: null };
};
const target = (workspaceId: string | null) => ({ workspaceId, resourceKind: null, resourceId: null, amountCredits: null, ticketId: null });
const stagingPolicies = (db: Db) => db.select().from(adminPermissionPolicyVersions).where(eq(adminPermissionPolicyVersions.environment, ENV));

async function rolledBack(run: (db: Db) => Promise<void>): Promise<void> {
  const marker = Symbol('rollback');
  try {
    await handle.db.transaction(async (tx) => { await run(tx as unknown as Db); throw marker; });
  } catch (error) {
    if (error !== marker) throw error;
  }
}

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
  auth = createAuth({ db: handle.db, secret: `ops-bootstrap-${randomUUID()}`, baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假值
  // 前提：STAGING 从未发布过策略（其他测试也只在回滚事务里碰它）
  expect(await stagingPolicies(handle.db)).toEqual([]);
});
afterAll(async () => {
  if (users.length > 0) await handle.db.delete(user).where(inArray(user.id, users));
  await handle.close();
});

describe('grantOpsAccess', () => {
  it('首次授权：建运营身份 + 角色 + 平台范围，发布当前权限策略，写审计（不含邮箱）；平台级操作放行，工作区操作仍要工作区范围', async () => {
    const account = await newAccount();
    await rolledBack(async (db) => {
      expect(await decideOpsPermission(deps(db), { session: session('oppr_none', ['PRODUCTION_OPERATOR']), action: 'ops.overview.read', target: target(null) })).toMatchObject({ reason: 'POLICY_INACTIVE' });
      const result = await grantOpsAccess(db, { email: account.email.toUpperCase(), environment: ENV, roles: ['PRODUCTION_OPERATOR'] });
      expect(result).toMatchObject({ userId: account.id, principalCreated: true, rolesAdded: ['PRODUCTION_OPERATOR'], rolesKept: [], scopesAdded: 1, policy: 'PUBLISHED', policyVersion: OPS_PERMISSION_POLICY_VERSION });
      expect((await db.select().from(adminPrincipals).where(eq(adminPrincipals.id, result.principalId)))[0]!.grantVersion).toBe(result.grantVersion);
      expect(await stagingPolicies(db)).toEqual([expect.objectContaining({ status: 'ACTIVE', version: OPS_PERMISSION_POLICY_VERSION, rulesHash: OPS_PERMISSION_POLICY_HASH, publishedByPrincipalId: result.principalId })]);

      const audit = await db.select().from(auditLog).where(and(eq(auditLog.action, 'ops.principal.bootstrap'), eq(auditLog.targetId, result.principalId)));
      expect(audit).toEqual([expect.objectContaining({ actorKind: 'SYSTEM', targetType: 'admin_principal' })]);
      expect(JSON.stringify(audit[0]!.details)).not.toContain(account.email);

      const ops = session(result.principalId, ['PRODUCTION_OPERATOR']);
      expect(await decideOpsPermission(deps(db), { session: ops, action: 'ops.overview.read', target: target(null) })).toMatchObject({ allowed: true });
      expect(await decideOpsPermission(deps(db), { session: ops, action: 'ops.project.list', target: target('ws_somewhere') })).toMatchObject({ allowed: false, reason: 'SCOPE_MISSING' });
    });
  });

  it('可重复执行：已有的不重复写、会话版本不变；加角色与工作区范围时提升会话版本，工作区操作对该工作区放行', async () => {
    const account = await newAccount();
    await rolledBack(async (db) => {
      const first = await grantOpsAccess(db, { email: account.email, environment: ENV, roles: ['PRODUCTION_OPERATOR'] });
      const again = await grantOpsAccess(db, { email: account.email, environment: ENV, roles: ['PRODUCTION_OPERATOR'] });
      expect(again).toMatchObject({ principalId: first.principalId, principalCreated: false, rolesAdded: [], rolesKept: ['PRODUCTION_OPERATOR'], scopesAdded: 0, grantVersion: first.grantVersion, policy: 'ALREADY_ACTIVE' });

      const workspaceId = `ws_${randomUUID()}`;
      await db.insert(workspaces).values({ id: workspaceId, name: 'Ops scope' });
      const widened = await grantOpsAccess(db, { email: account.email, environment: ENV, roles: ['PRODUCTION_OPERATOR', 'AUDITOR'], workspaceIds: [workspaceId] });
      // PRODUCTION_OPERATOR 加一条工作区范围；新角色 AUDITOR 加平台 + 工作区两条
      expect(widened).toMatchObject({ rolesAdded: ['AUDITOR'], rolesKept: ['PRODUCTION_OPERATOR'], scopesAdded: 3 });
      // 有改动 → 会话版本变了（旧的运营会话失效）
      expect(widened.grantVersion).toBeGreaterThan(first.grantVersion);

      const ops = session(first.principalId, ['PRODUCTION_OPERATOR', 'AUDITOR']);
      expect(await decideOpsPermission(deps(db), { session: ops, action: 'ops.project.list', target: target(workspaceId) })).toMatchObject({ allowed: true });
      expect(await decideOpsPermission(deps(db), { session: ops, action: 'ops.metrics.read', target: target(null) })).toMatchObject({ allowed: true });
    });
  });

  it('策略生命周期：旧版本生效 → 退役旧的、发布当前的；当前版本是草稿 → 直接发布；当前版本已退役 → 报错（不复活）', async () => {
    const account = await newAccount();
    const olderPolicy = (db: Db, status: 'ACTIVE' | 'DRAFT', version = `older-${randomUUID().slice(0, 8)}`, hash = OPS_PERMISSION_POLICY_HASH) => db.insert(adminPermissionPolicyVersions).values({
      id: `oppv_${randomUUID()}`, environment: ENV, version, rulesHash: hash, status,
      ...(status === 'ACTIVE' ? { publishedAt: new Date(), publishedByPrincipalId: 'oppr_previous' } : {}),
    });
    await rolledBack(async (db) => {
      await olderPolicy(db, 'ACTIVE');
      expect((await grantOpsAccess(db, { email: account.email, environment: ENV, roles: ['AUDITOR'] })).policy).toBe('REPLACED');
      const rows = await stagingPolicies(db);
      expect(rows.filter((row) => row.status === 'ACTIVE')).toEqual([expect.objectContaining({ version: OPS_PERMISSION_POLICY_VERSION })]);
      expect(rows.filter((row) => row.status === 'RETIRED')).toHaveLength(1);
    });
    await rolledBack(async (db) => {
      await olderPolicy(db, 'DRAFT', OPS_PERMISSION_POLICY_VERSION);
      expect((await grantOpsAccess(db, { email: account.email, environment: ENV, roles: ['AUDITOR'] })).policy).toBe('PUBLISHED');
      expect(await stagingPolicies(db)).toEqual([expect.objectContaining({ version: OPS_PERMISSION_POLICY_VERSION, status: 'ACTIVE' })]);
    });
    await rolledBack(async (db) => {
      await olderPolicy(db, 'ACTIVE', OPS_PERMISSION_POLICY_VERSION);
      await db.update(adminPermissionPolicyVersions).set({ status: 'RETIRED', retiredAt: new Date() }).where(eq(adminPermissionPolicyVersions.environment, ENV));
      await expect(grantOpsAccess(db, { email: account.email, environment: ENV, roles: ['AUDITOR'] })).rejects.toThrow('cannot be reactivated');
    });
    await rolledBack(async (db) => {
      await olderPolicy(db, 'DRAFT', OPS_PERMISSION_POLICY_VERSION, '0'.repeat(64));
      await expect(grantOpsAccess(db, { email: account.email, environment: ENV, roles: ['AUDITOR'] })).rejects.toThrow('different rules');
    });
  });

  it('拒绝且不写任何东西：没有这个账号、未知工作区、机器身份角色、已停用的身份（不代为重新启用）', async () => {
    const account = await newAccount();
    await rolledBack(async (db) => {
      await expect(grantOpsAccess(db, { email: `nobody-${randomUUID()}@test.local`, environment: ENV, roles: ['AUDITOR'] })).rejects.toThrow(OpsGrantError);
      await expect(grantOpsAccess(db, { email: account.email, environment: ENV, roles: ['AUDITOR'], workspaceIds: ['ws_missing'] })).rejects.toThrow('unknown workspace: ws_missing');
      await expect(grantOpsAccess(db, { email: account.email, environment: ENV, roles: ['SERVICE_ACCOUNT' as never] })).rejects.toThrow('SERVICE_ACCOUNT');
      expect(await db.select().from(adminPrincipals).where(eq(adminPrincipals.userId, account.id))).toEqual([]);
      expect(await stagingPolicies(db)).toEqual([]);

      const granted = await grantOpsAccess(db, { email: account.email, environment: ENV, roles: ['AUDITOR'] });
      await db.update(adminPrincipals).set({ enabled: false, disabledAt: new Date() }).where(eq(adminPrincipals.id, granted.principalId));
      await expect(grantOpsAccess(db, { email: account.email, environment: ENV, roles: ['AUDITOR', 'PRODUCTION_OPERATOR'] })).rejects.toThrow('disabled');
      expect(await db.select().from(adminRoleGrants).where(eq(adminRoleGrants.principalId, granted.principalId))).toEqual([expect.objectContaining({ role: 'AUDITOR' })]);
    });
  });
});
