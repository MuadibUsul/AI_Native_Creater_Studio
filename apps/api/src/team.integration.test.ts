import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { buildServer } from './server.js';

/**
 * P09-04 验收（真实 DB + HTTP/SDK）：
 * - **邀请生命周期**：创建（不要求账号存在）→ 我的待处理 → **邮箱不匹配 403** → 接受（同事务成员+ACCEPTED）→
 *   重复接受/已接受后撤销 409 → 撤销的邀请不可接受 → 撤销后可重新邀请（历史保留）；
 * - **席位（降级套餐清晰超额处理）**：降级后新增被阻止（422 SEATS_EXCEEDED，含邀请创建/接受双重检查），
 *   **存量成员保留**，`overCommitted` 明确可见；
 * - **撤销成员后访问立即受限**（下一请求 404 抗枚举；Workspace 列表移除）；
 * - **隐私档位**：非 STANDARD 需套餐权益 privacyMode（明确 422）→ 可用档位设置生效 → **降级不静默改写档位**
 *   （进入 overCommitted）；
 * - **角色管理**：非 OWNER 不能授予 OWNER（成员与邀请两侧）、不得移除最后一名 OWNER。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let adminEmail = '';
const ADMIN_PASSWORD = 'admin-password-1234'; // secrets:check-ignore：测试专用假密钥
const PASSWORD = 'password-1234';

const deps = (): DomainDeps => ({ db: handle.db });

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try {
    await handle.pool.query('select 1');
  } catch (error) {
    await handle.close();
    throw new Error(`无法连接测试数据库 ${redactDatabaseUrl(url)}。`, { cause: error });
  }
  await runMigrations(handle);
  auth = createAuth({ db: handle.db, secret: 'team-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  adminEmail = `team-admin-${randomUUID()}@test.local`;
  const adminUser = await createInternalUser(auth, { email: adminEmail, password: ADMIN_PASSWORD, name: 'team-admin' });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    admin: { userIds: [adminUser.id] },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
  await handle.db.delete(plans);
  await ensureDefaultPlans(deps());
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function newClientWithEmail(email: string, name = 'invitee'): Promise<AncsClient> {
  await createInternalUser(auth, { email, password: PASSWORD, name });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function newAdminClient(): Promise<AncsClient> {
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email: adminEmail, password: ADMIN_PASSWORD });
  return client;
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('团队与隐私（P09-04）', () => {
  it('邀请生命周期：创建 → 我的待处理 → 邮箱不匹配 403 → 接受 → 重复接受 409 → 撤销的邀请不可接受 → 可重新邀请', async () => {
    const owner = await newClient('team-inv-owner');
    const workspace = await owner.workspaces.create({ name: `邀请-${randomUUID().slice(0, 8)}` });
    const inviteeEmail = `invitee-${randomUUID()}@test.local`;

    // 创建（不要求账号存在——账号由内部 CLI 创建）
    const invitation = await owner.workspaces.invitations.create(workspace.id, { email: inviteeEmail, role: 'EDITOR' });
    expect(invitation.status).toBe('PENDING');
    expect(invitation.email).toBe(inviteeEmail);
    // 重复 PENDING → 409
    await expectApiError(owner.workspaces.invitations.create(workspace.id, { email: inviteeEmail, role: 'EDITOR' }), 409);

    // 创建账号后：我的待处理可见（含 Workspace 名称）
    const invitee = await newClientWithEmail(inviteeEmail);
    const mine = await invitee.invitations.mine();
    expect(mine).toHaveLength(1);
    expect(mine[0]?.id).toBe(invitation.id);
    expect(mine[0]?.workspaceName).toContain('邀请-');

    // 非受邀邮箱接受 → 403 EMAIL_MISMATCH（身份占有凭据 = 邮箱匹配）
    const other = await newClient('team-inv-other');
    await expectApiError(other.invitations.accept(invitation.id), 403, 'EMAIL_MISMATCH');

    // 接受：成员 + 邀请 ACCEPTED 同事务；返回取得的 Workspace 与角色
    const accepted = await invitee.invitations.accept(invitation.id);
    expect(accepted.workspace.id).toBe(workspace.id);
    expect(accepted.workspace.role).toBe('EDITOR');
    expect(accepted.invitation.status).toBe('ACCEPTED');
    expect(accepted.invitation.acceptedByUserId).not.toBeNull();

    // 成员即刻生效（可读）；重复接受 409；已接受后撤销 409
    const asMember = await invitee.workspaces.get(workspace.id);
    expect(asMember.role).toBe('EDITOR');
    await expectApiError(invitee.invitations.accept(invitation.id), 409, 'INVITATION_NOT_PENDING');
    await expectApiError(owner.workspaces.invitations.revoke(workspace.id, invitation.id), 409, 'INVITATION_NOT_PENDING');

    // 撤销的邀请不可接受；撤销后同邮箱可重新邀请（历史保留：REVOKED + PENDING 两行）
    const secondEmail = `invitee2-${randomUUID()}@test.local`;
    const second = await owner.workspaces.invitations.create(workspace.id, { email: secondEmail, role: 'VIEWER' });
    const revoked = await owner.workspaces.invitations.revoke(workspace.id, second.id);
    expect(revoked.status).toBe('REVOKED');
    const secondUser = await newClientWithEmail(secondEmail, 'invitee2');
    await expectApiError(secondUser.invitations.accept(second.id), 409, 'INVITATION_NOT_PENDING');
    expect(await secondUser.invitations.mine()).toHaveLength(0);

    const reissued = await owner.workspaces.invitations.create(workspace.id, { email: secondEmail, role: 'VIEWER' });
    expect(reissued.status).toBe('PENDING');
    const list = await owner.workspaces.invitations.list(workspace.id);
    expect(list.filter((item) => item.email === secondEmail)).toHaveLength(2);
    expect(list.filter((item) => item.email === secondEmail).map((item) => item.status).sort()).toEqual(['PENDING', 'REVOKED']);
  }, 120_000);

  it('席位（降级清晰超额）：新增/邀请被阻止（422）、存量成员保留、overCommitted 可见；接受时权威复查', async () => {
    const owner = await newClient('team-seat-owner');
    const admin = await newAdminClient();
    const workspace = await owner.workspaces.create({ name: `席位-${randomUUID().slice(0, 8)}` });
    const member2Email = `member2-${randomUUID()}@test.local`;
    await createInternalUser(auth, { email: member2Email, password: PASSWORD, name: 'member2' });

    // 预上线默认 ENTERPRISE（不限席位）：先建立 2 名成员 + 1 条待接受邀请（升级前正常流程）
    await owner.workspaces.members.add(workspace.id, { email: member2Email, role: 'EDITOR' });
    const pendingEmail = `pending-${randomUUID()}@test.local`;
    const pendingInvite = await owner.workspaces.invitations.create(workspace.id, { email: pendingEmail, role: 'VIEWER' });
    const pendingUser = await newClientWithEmail(pendingEmail, 'pending');

    // **降级**：FREE（席位 1）——存量 2 成员保留，进入超额清单
    await admin.admin.assignPlan(workspace.id, { planKey: 'FREE', note: '降级验证' });
    const entitlement = await owner.workspaces.entitlements(workspace.id);
    expect(entitlement.usage.seatsUsed).toBe(2);
    expect(entitlement.entitlements.seats).toBe(1);
    expect(entitlement.overCommitted).toContain('seats');
    const members = await owner.workspaces.members.list(workspace.id);
    expect(members).toHaveLength(2); // 存量保留（不自动移除）

    // 新增被阻止：直接添加 422；邀请创建也做早期检查 422（成员 2 + 待接受 1 + 新增 1 > 1）
    const member3Email = `member3-${randomUUID()}@test.local`;
    await createInternalUser(auth, { email: member3Email, password: PASSWORD, name: 'member3' });
    await expectApiError(owner.workspaces.members.add(workspace.id, { email: member3Email, role: 'VIEWER' }), 422, 'SEATS_EXCEEDED');
    await expectApiError(owner.workspaces.invitations.create(workspace.id, { email: member3Email, role: 'VIEWER' }), 422, 'SEATS_EXCEEDED');

    // 接受时权威复查：升级前创建的邀请在降级后不可接受（成员数 2 > 上限 1）；邀请保持 PENDING
    await expectApiError(pendingUser.invitations.accept(pendingInvite.id), 422, 'SEATS_EXCEEDED');
    expect((await owner.workspaces.invitations.list(workspace.id)).find((item) => item.id === pendingInvite.id)?.status).toBe('PENDING');

    // 恢复升级（CREATOR seats=1 不够；STUDIO seats=10）→ 可继续接受、overCommitted 清空
    await admin.admin.assignPlan(workspace.id, { planKey: 'STUDIO', note: '升级恢复' });
    const accepted = await pendingUser.invitations.accept(pendingInvite.id);
    expect(accepted.workspace.role).toBe('VIEWER');
    expect((await owner.workspaces.entitlements(workspace.id)).overCommitted).toEqual([]);
  }, 120_000);

  it('撤销成员后访问立即受限：下一请求 404（抗枚举）、Workspace 列表移除', async () => {
    const owner = await newClient('team-revoke-owner');
    const workspace = await owner.workspaces.create({ name: `撤销-${randomUUID().slice(0, 8)}` });
    const member = await newClient('team-revoke-member');
    const memberEmail = (await member.auth.session()).user.email;
    await owner.workspaces.members.add(workspace.id, { email: memberEmail, role: 'EDITOR' });

    // 撤销前：可读、在列表中
    expect((await member.workspaces.get(workspace.id)).role).toBe('EDITOR');
    expect((await member.workspaces.list()).some((item) => item.id === workspace.id)).toBe(true);

    const membersBefore = await owner.workspaces.members.list(workspace.id);
    const target = membersBefore.find((item) => item.email === memberEmail);
    expect(target).toBeDefined();
    await owner.workspaces.members.remove(workspace.id, target?.userId ?? '');

    // 撤销后：**下一请求立即** 404（与"workspace 不存在"不可区分），列表不再包含
    await expectApiError(member.workspaces.get(workspace.id), 404);
    await expectApiError(member.workspaces.members.list(workspace.id), 404);
    expect((await member.workspaces.list()).some((item) => item.id === workspace.id)).toBe(false);
  }, 120_000);

  it('隐私档位：套餐门（FREE 明确 422）→ STUDIO 可设 PRIVATE → 降级不静默改写（overCommitted 含 privacyMode）', async () => {
    const owner = await newClient('team-privacy-owner');
    const admin = await newAdminClient();
    const workspace = await owner.workspaces.create({ name: `隐私-${randomUUID().slice(0, 8)}` });

    // 默认 STANDARD
    expect((await owner.workspaces.get(workspace.id)).privacyTier).toBe('STANDARD');

    // FREE（privacyMode=false）→ 422（明确 reason；档位保持 STANDARD）
    await admin.admin.assignPlan(workspace.id, { planKey: 'FREE' });
    await expectApiError(owner.workspaces.setPrivacyTier(workspace.id, { privacyTier: 'PRIVATE' }), 422, 'PRIVACY_MODE_NOT_ALLOWED');
    expect((await owner.workspaces.get(workspace.id)).privacyTier).toBe('STANDARD');

    // STUDIO（privacyMode=true）→ 可设置
    await admin.admin.assignPlan(workspace.id, { planKey: 'STUDIO' });
    const updated = await owner.workspaces.setPrivacyTier(workspace.id, { privacyTier: 'PRIVATE' });
    expect(updated.privacyTier).toBe('PRIVATE');
    expect(await owner.workspaces.entitlements(workspace.id)).toMatchObject({ overCommitted: [] });

    // 降级 FREE：**档位不被静默改写**（仍 PRIVATE），但进入超额清单（运营/用户显式处理）
    await admin.admin.assignPlan(workspace.id, { planKey: 'FREE' });
    expect((await owner.workspaces.get(workspace.id)).privacyTier).toBe('PRIVATE');
    const entitlement = await owner.workspaces.entitlements(workspace.id);
    expect(entitlement.overCommitted).toContain('privacyMode');
  }, 120_000);

  it('角色管理：非 OWNER 不能授予 OWNER（成员/邀请两侧）；不得移除最后一名 OWNER', async () => {
    const owner = await newClient('team-role-owner');
    const workspace = await owner.workspaces.create({ name: `角色-${randomUUID().slice(0, 8)}` });
    const adminUser = await newClient('team-role-admin');
    const adminEmail2 = (await adminUser.auth.session()).user.email;
    await owner.workspaces.members.add(workspace.id, { email: adminEmail2, role: 'ADMIN' });

    // ADMIN 不能授予 OWNER（成员添加与邀请两侧同规则）
    const someEmail = `some-${randomUUID()}@test.local`;
    await createInternalUser(auth, { email: someEmail, password: PASSWORD, name: 'some' });
    await expectApiError(adminUser.workspaces.members.add(workspace.id, { email: someEmail, role: 'OWNER' }), 403);
    await expectApiError(adminUser.workspaces.invitations.create(workspace.id, { email: someEmail, role: 'OWNER' }), 403);
    // ADMIN 可以邀请 EDITOR（member:manage）；PENDING 唯一（同邮箱重复邀请 → 409，即使 OWNER 发起）
    const okInvite = await adminUser.workspaces.invitations.create(workspace.id, { email: someEmail, role: 'EDITOR' });
    expect(okInvite.role).toBe('EDITOR');
    await expectApiError(owner.workspaces.invitations.create(workspace.id, { email: someEmail, role: 'OWNER' }), 409);
    await owner.workspaces.invitations.revoke(workspace.id, okInvite.id);

    // OWNER 可以授予 OWNER（邀请侧）；但最后一名 OWNER 不可被移除
    const ownerEmail = (await owner.auth.session()).user.email;
    const ownerMember = (await owner.workspaces.members.list(workspace.id)).find((item) => item.email === ownerEmail);
    expect(ownerMember).toBeDefined();
    await expectApiError(owner.workspaces.members.remove(workspace.id, ownerMember?.userId ?? ''), 409);
    const ownerInvite = await owner.workspaces.invitations.create(workspace.id, { email: someEmail, role: 'OWNER' });
    expect(ownerInvite.role).toBe('OWNER');
  }, 120_000);
});
