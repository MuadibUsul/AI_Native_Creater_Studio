import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { OpsEnvironment, OpsRole } from '@ancs/contracts';
import { adminPermissionPolicyVersions, adminPrincipals, adminRoleGrants, adminRoleScopes, auditLog, user, workspaces } from '@ancs/db';
import { OPS_PERMISSION_POLICY_HASH, OPS_PERMISSION_POLICY_VERSION } from './ops-permissions.js';

/**
 * 运营后台授权（I-13）：给已有账号开通某个环境的运营身份与角色，并确保该环境发布了与代码一致的权限策略。
 *
 * - 账号必须已存在（先用 user:create 建号）；不改密码、不跳过 MFA——首次进入 /admin 时照常绑定验证器；
 * - 每个角色带平台范围（平台级操作）；列出的工作区再各加一条工作区范围（按工作区生效的操作只对这些工作区开放）；
 * - 可重复执行：已有的身份 / 角色 / 范围不重复写；有改动时 grantVersion 由数据库触发器提升，旧的运营会话随之失效、需重新登录；
 * - 被停用的身份不在这里重新启用（那是安全决定，不由引导命令代做）；
 * - 权限策略：没有生效版本就发布当前版本；生效的是旧版本就退役旧的、发布当前的（草稿直接发布；已退役的当前版本不能复活，报错要求发新版本）；
 * - 写一条 audit_log（SYSTEM，ops.principal.bootstrap），只记 ID 与角色，不记邮箱。
 */

export interface OpsGrantInput {
  email: string;
  environment: OpsEnvironment;
  roles: readonly Exclude<OpsRole, 'SERVICE_ACCOUNT'>[];
  workspaceIds?: readonly string[];
}

export interface OpsGrantResult {
  userId: string;
  principalId: string;
  principalCreated: boolean;
  rolesAdded: OpsRole[];
  rolesKept: OpsRole[];
  scopesAdded: number;
  grantVersion: number;
  policy: 'PUBLISHED' | 'ALREADY_ACTIVE' | 'REPLACED';
  policyVersion: string;
}

export class OpsGrantError extends Error {}

/** 与测试夹具同一把锁：同一时间只有一个事务在改某环境的策略发布 */
const POLICY_LOCK = sql`select pg_advisory_xact_lock(1503, 4)`;

export async function grantOpsAccess(db: NodePgDatabase, input: OpsGrantInput): Promise<OpsGrantResult> {
  if (input.roles.length === 0) throw new OpsGrantError('at least one role is required');
  if ((input.roles as readonly string[]).includes('SERVICE_ACCOUNT')) throw new OpsGrantError('SERVICE_ACCOUNT cannot sign in to the operations console');
  const email = input.email.trim().toLowerCase();
  const workspaceIds = [...new Set(input.workspaceIds ?? [])];
  return db.transaction(async (tx) => {
    const account = (await tx.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1))[0];
    if (!account) throw new OpsGrantError(`no account with email ${email}; create it first (user:create)`);
    if (workspaceIds.length > 0) {
      const found = new Set((await tx.select({ id: workspaces.id }).from(workspaces).where(inArray(workspaces.id, workspaceIds))).map((row) => row.id));
      const missing = workspaceIds.filter((id) => !found.has(id));
      if (missing.length > 0) throw new OpsGrantError(`unknown workspace: ${missing.join(', ')}`);
    }

    let principal = (await tx.select().from(adminPrincipals).where(and(
      eq(adminPrincipals.userId, account.id), eq(adminPrincipals.environment, input.environment),
    )).limit(1))[0];
    const principalCreated = principal === undefined;
    if (principal && !principal.enabled) throw new OpsGrantError('this operator is disabled; re-enabling is a separate security decision');
    if (!principal) {
      [principal] = await tx.insert(adminPrincipals).values({ id: `oppr_${randomUUID()}`, userId: account.id, environment: input.environment }).returning();
      if (!principal) throw new Error('principal insert failed');
    }
    const principalId = principal.id;

    const activeGrants = await tx.select().from(adminRoleGrants).where(and(eq(adminRoleGrants.principalId, principalId), isNull(adminRoleGrants.revokedAt)));
    const rolesAdded: OpsRole[] = [];
    const rolesKept: OpsRole[] = [];
    let scopesAdded = 0;
    for (const role of [...new Set(input.roles)]) {
      let grant = activeGrants.find((row) => row.role === role);
      if (grant) rolesKept.push(role);
      else {
        [grant] = await tx.insert(adminRoleGrants).values({ id: `oprg_${randomUUID()}`, principalId, role }).returning();
        if (!grant) throw new Error('role grant insert failed');
        rolesAdded.push(role);
      }
      const scopes = await tx.select().from(adminRoleScopes).where(and(eq(adminRoleScopes.roleGrantId, grant.id), isNull(adminRoleScopes.revokedAt)));
      if (!scopes.some((scope) => scope.scopeKind === 'PLATFORM' && scope.expiresAt === null)) {
        await tx.insert(adminRoleScopes).values({ id: `opsc_${randomUUID()}`, roleGrantId: grant.id, scopeKind: 'PLATFORM' });
        scopesAdded += 1;
      }
      for (const workspaceId of workspaceIds) {
        if (scopes.some((scope) => scope.scopeKind === 'WORKSPACE' && scope.workspaceId === workspaceId && scope.expiresAt === null)) continue;
        await tx.insert(adminRoleScopes).values({ id: `opsc_${randomUUID()}`, roleGrantId: grant.id, scopeKind: 'WORKSPACE', workspaceId });
        scopesAdded += 1;
      }
    }

    // 角色 / 范围的每次变化由数据库触发器提升 grantVersion（迁移 0051、0053）；这里只读回实际值
    const grantVersion = (await tx.select({ grantVersion: adminPrincipals.grantVersion }).from(adminPrincipals).where(eq(adminPrincipals.id, principalId)))[0]?.grantVersion ?? principal.grantVersion;

    // 已发布的策略版本不可改写、不可删除、退役后不可复活（迁移 0054 的触发器）；这里只做它允许的转换
    await tx.execute(POLICY_LOCK);
    const policyRows = await tx.select().from(adminPermissionPolicyVersions).where(eq(adminPermissionPolicyVersions.environment, input.environment));
    const active = policyRows.find((row) => row.status === 'ACTIVE');
    const current = policyRows.find((row) => row.version === OPS_PERMISSION_POLICY_VERSION);
    if (current && current.rulesHash !== OPS_PERMISSION_POLICY_HASH) {
      throw new OpsGrantError(`policy version ${OPS_PERMISSION_POLICY_VERSION} is already recorded in ${input.environment} with different rules; release a new policy version`);
    }
    if (current?.status === 'RETIRED') {
      throw new OpsGrantError(`policy version ${OPS_PERMISSION_POLICY_VERSION} was retired in ${input.environment} and cannot be reactivated; release a new policy version`);
    }
    let policy: OpsGrantResult['policy'] = 'ALREADY_ACTIVE';
    if (current?.status !== 'ACTIVE') {
      const now = new Date();
      if (active) await tx.update(adminPermissionPolicyVersions).set({ status: 'RETIRED', retiredAt: now }).where(eq(adminPermissionPolicyVersions.id, active.id));
      if (current) {
        await tx.update(adminPermissionPolicyVersions).set({ status: 'ACTIVE', publishedAt: now, publishedByPrincipalId: principalId })
          .where(eq(adminPermissionPolicyVersions.id, current.id));
      } else {
        await tx.insert(adminPermissionPolicyVersions).values({
          id: `oppv_${randomUUID()}`, environment: input.environment, version: OPS_PERMISSION_POLICY_VERSION, rulesHash: OPS_PERMISSION_POLICY_HASH,
          status: 'ACTIVE', publishedAt: now, createdByPrincipalId: principalId, publishedByPrincipalId: principalId,
        });
      }
      policy = active ? 'REPLACED' : 'PUBLISHED';
    }

    await tx.insert(auditLog).values({
      id: `aud_${randomUUID()}`,
      actorKind: 'SYSTEM',
      actorUserId: null,
      action: 'ops.principal.bootstrap',
      targetType: 'admin_principal',
      targetId: principalId,
      details: {
        via: 'cli', environment: input.environment, userId: account.id, principalCreated, rolesAdded, rolesKept,
        workspaceIds, scopesAdded, grantVersion, policy, policyVersion: OPS_PERMISSION_POLICY_VERSION,
      },
    });
    return { userId: account.id, principalId, principalCreated, rolesAdded, rolesKept, scopesAdded, grantVersion, policy, policyVersion: OPS_PERMISSION_POLICY_VERSION };
  });
}
