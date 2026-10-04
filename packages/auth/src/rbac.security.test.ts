import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiFailure, ERROR_CODES, WORKSPACE_ROLES } from '@ancs/contracts';
import {
  authAccessTokens,
  authRefreshTokens,
  createDb,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  user,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import {
  addMember,
  authorizeWorkspace,
  createAuth,
  createInternalUser,
  createWorkspace,
  getMembership,
  listMembers,
  listWorkspaces,
  removeMember,
  roleHasCapability,
  updateMemberRole,
  type AuthInstance,
  type WorkspaceServiceDeps,
} from './index.js';

/**
 * P01-03 安全套件（服务级）：权限矩阵、统一授权入口、OWNER 不变量、撤销即时性。
 * HTTP 级跨租户验证见 apps/api/src/tenant-isolation.security.test.ts。
 */

const PASSWORD = 'password-1234';
let handle: DbHandle;
let auth: AuthInstance;
let deps: WorkspaceServiceDeps;

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
    secret: 'rbac-test-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
    baseUrl: 'http://localhost:3001',
  });
  deps = { db: handle.db };
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(authAccessTokens);
  await handle.db.delete(authRefreshTokens);
  await handle.db.delete(workspaces); // 级联 workspace_members
  await handle.db.delete(user); // 级联 account/session
});

const createUser = (): Promise<{ id: string; email: string }> =>
  createInternalUser(auth, { email: `rbac-${randomUUID()}@test.local`, password: PASSWORD, name: 'RBAC 测试' });

describe('权限矩阵（计划 §6.2）', () => {
  it('角色集合为 5 个 Workspace 角色（PLATFORM_ADMIN 不属于其中，§67）', () => {
    expect([...WORKSPACE_ROLES]).toEqual(['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'VIEWER']);
  });

  it('关键能力差异符合计划 §6.2', () => {
    expect(roleHasCapability('OWNER', 'billing:manage')).toBe(true);
    expect(roleHasCapability('OWNER', 'workspace:transfer_ownership')).toBe(true);
    expect(roleHasCapability('ADMIN', 'member:manage')).toBe(true);
    expect(roleHasCapability('ADMIN', 'billing:manage')).toBe(false);
    expect(roleHasCapability('ADMIN', 'workspace:transfer_ownership')).toBe(false);
    expect(roleHasCapability('EDITOR', 'project:write')).toBe(true);
    expect(roleHasCapability('EDITOR', 'member:manage')).toBe(false);
    expect(roleHasCapability('REVIEWER', 'review:approve')).toBe(true);
    expect(roleHasCapability('REVIEWER', 'project:write')).toBe(false);
    expect(roleHasCapability('VIEWER', 'project:read')).toBe(true);
    expect(roleHasCapability('VIEWER', 'review:comment')).toBe(false);
  });
});

describe('Workspace 服务与统一授权入口', () => {
  it('创建 Workspace：创建者为 OWNER，且出现在其列表中', async () => {
    const a = await createUser();
    const ws = await createWorkspace(deps, { userId: a.id, name: '研究组 A' });
    expect(ws.role).toBe('OWNER');

    const list = await listWorkspaces(deps, { userId: a.id });
    expect(list.map((w) => w.id)).toEqual([ws.id]);
    expect(list[0]?.role).toBe('OWNER');
  });

  it('授权入口：非成员 → 404（抗枚举）；成员能力不足 → 403 并附 requiredCapability', async () => {
    const a = await createUser();
    const outsider = await createUser();
    const ws = await createWorkspace(deps, { userId: a.id, name: '研究组 A' });

    await expect(
      authorizeWorkspace(handle.db, { userId: outsider.id, workspaceId: ws.id, capability: 'workspace:read' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND, httpStatus: 404 });

    await expect(
      authorizeWorkspace(handle.db, { userId: outsider.id, workspaceId: 'ws_not_exist', capability: 'workspace:read' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND, httpStatus: 404 });

    await addMember(deps, { userId: a.id, workspaceId: ws.id, email: outsider.email, role: 'VIEWER' });
    const failure = await authorizeWorkspace(handle.db, {
      userId: outsider.id,
      workspaceId: ws.id,
      capability: 'project:write',
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure).toMatchObject({ code: ERROR_CODES.FORBIDDEN, httpStatus: 403 });
    expect((failure as ApiFailure).details['requiredCapability']).toBe('project:write');
  });

  it('成员管理：重复添加 → 409；未知邮箱 → 404', async () => {
    const a = await createUser();
    const b = await createUser();
    const ws = await createWorkspace(deps, { userId: a.id, name: '研究组 A' });
    await addMember(deps, { userId: a.id, workspaceId: ws.id, email: b.email, role: 'EDITOR' });

    await expect(
      addMember(deps, { userId: a.id, workspaceId: ws.id, email: b.email, role: 'VIEWER' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.ALREADY_EXISTS, httpStatus: 409 });

    await expect(
      addMember(deps, { userId: a.id, workspaceId: ws.id, email: 'ghost@test.local', role: 'VIEWER' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND, httpStatus: 404 });
  });

  it('OWNER 不变量：最后一名 OWNER 不得降级或移除；存在第二名 OWNER 时可操作', async () => {
    const a = await createUser();
    const b = await createUser();
    const ws = await createWorkspace(deps, { userId: a.id, name: '研究组 A' });

    await expect(
      updateMemberRole(deps, { userId: a.id, workspaceId: ws.id, targetUserId: a.id, role: 'ADMIN' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.PRECONDITION_FAILED, httpStatus: 409 });
    await expect(removeMember(deps, { userId: a.id, workspaceId: ws.id, targetUserId: a.id })).rejects.toMatchObject({
      code: ERROR_CODES.PRECONDITION_FAILED,
      httpStatus: 409,
    });

    await addMember(deps, { userId: a.id, workspaceId: ws.id, email: b.email, role: 'OWNER' });
    const demoted = await updateMemberRole(deps, {
      userId: a.id,
      workspaceId: ws.id,
      targetUserId: a.id,
      role: 'ADMIN',
    });
    expect(demoted.role).toBe('ADMIN');
  });

  it('权限边界：非 OWNER 不得授予或修改 OWNER 角色', async () => {
    const owner = await createUser();
    const admin = await createUser();
    const third = await createUser();
    const ws = await createWorkspace(deps, { userId: owner.id, name: '研究组 A' });
    await addMember(deps, { userId: owner.id, workspaceId: ws.id, email: admin.email, role: 'ADMIN' });

    await expect(
      addMember(deps, { userId: admin.id, workspaceId: ws.id, email: third.email, role: 'OWNER' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN, httpStatus: 403 });

    await expect(
      updateMemberRole(deps, { userId: admin.id, workspaceId: ws.id, targetUserId: owner.id, role: 'VIEWER' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN, httpStatus: 403 });

    await expect(
      removeMember(deps, { userId: admin.id, workspaceId: ws.id, targetUserId: owner.id }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN, httpStatus: 403 });
  });

  it('并发 OWNER 降级：恰有一个成功，不会出现零 OWNER（工作区行锁）', async () => {
    const a = await createUser();
    const b = await createUser();
    const ws = await createWorkspace(deps, { userId: a.id, name: '并发测试组' });
    await addMember(deps, { userId: a.id, workspaceId: ws.id, email: b.email, role: 'OWNER' });

    const results = await Promise.allSettled([
      updateMemberRole(deps, { userId: a.id, workspaceId: ws.id, targetUserId: b.id, role: 'ADMIN' }),
      updateMemberRole(deps, { userId: b.id, workspaceId: ws.id, targetUserId: a.id, role: 'ADMIN' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // 核心不变量：恰有一个成功、租户始终至少保留一名 OWNER。
    // 被拒原因随时序不同：行锁内计数为 1 → PRECONDITION_FAILED；对方已降级后重查 → FORBIDDEN。
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    expect(['PRECONDITION_FAILED', 'FORBIDDEN']).toContain(reason.code);

    const members = await listMembers(deps, { userId: a.id, workspaceId: ws.id });
    expect(members.filter((m) => m.role === 'OWNER')).toHaveLength(1);
  });

  it('撤销成员后授权立即失效', async () => {
    const a = await createUser();
    const b = await createUser();
    const ws = await createWorkspace(deps, { userId: a.id, name: '研究组 A' });
    await addMember(deps, { userId: a.id, workspaceId: ws.id, email: b.email, role: 'VIEWER' });

    expect(await getMembership(handle.db, b.id, ws.id)).not.toBeNull();
    await removeMember(deps, { userId: a.id, workspaceId: ws.id, targetUserId: b.id });
    expect(await getMembership(handle.db, b.id, ws.id)).toBeNull();
    await expect(
      authorizeWorkspace(handle.db, { userId: b.id, workspaceId: ws.id, capability: 'workspace:read' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });
});
