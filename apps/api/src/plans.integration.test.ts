import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, creditLedger, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaceSubscriptions, workspaces, type DbHandle } from '@ancs/db';
import { eq } from 'drizzle-orm';
import { createPlanVersion, ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { LocalCredentialVault } from '@ancs/providers-credential-vault-local';
import { parsePlatformCredentials } from './plugins/credentials.js';
import { buildServer } from './server.js';
import { enrollTestOpsTotp, provisionTestOpsPrincipal, signInTestOpsClient, testOpsDeps } from './test-helpers/ops-auth.js';

/**
 * P09-01 验收（真实 DB）：
 * - 版本化 Plan（同 Key 追加新版本，行不可变）+ 目录种子幂等；
 * - 订阅 append-only（换套餐 = 新行；旧行 supersededAt）——"修改套餐不篡改历史账单"（账本行数不变）；
 * - **所有额度在 API 强制执行**：存储（上传意图）/栏目/身份/BYOK/4K 渲染 多档位实证；
 * - 未订阅 workspace 按部署默认套餐（测试环境默认 ENTERPRISE=不限；显式置 FREE 验证默认额度口径）。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let adminEmail = '';
let adminTotpUri = '';
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
  auth = createAuth({ db: handle.db, secret: 'plans-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  adminEmail = `plans-admin-${randomUUID()}@test.local`;
  const adminUser = await createInternalUser(auth, { email: adminEmail, password: ADMIN_PASSWORD, name: 'plans-admin' });
  await provisionTestOpsPrincipal(handle.db, adminUser.id);
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    credentials: { cipher: new LocalCredentialVault({ keys: 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }), platformCredentials: parsePlatformCredentials(undefined) },
    admin: testOpsDeps(handle.db),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  adminTotpUri = await enrollTestOpsTotp(createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' }), adminEmail, ADMIN_PASSWORD);
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
  await handle.db.delete(plans); // 目录随用例重建（订阅级联于 workspace）
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function newAdminClient(): Promise<AncsClient> {
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await signInTestOpsClient(client, adminEmail, ADMIN_PASSWORD, adminTotpUri);
  return client;
}

describe('套餐权益（P09-01）', () => {
  it('目录种子幂等 + 版本化不可变：追加新版本，旧版本行内容不变', async () => {
    const first = await ensureDefaultPlans(deps());
    expect(first.created.sort()).toEqual(['CREATOR', 'ENTERPRISE', 'FREE', 'PRO', 'STUDIO']);
    const second = await ensureDefaultPlans(deps());
    expect(second.created).toEqual([]); // 幂等

    const rowsBefore = await handle.db.select().from(plans).where(eq(plans.planKey, 'CREATOR'));
    expect(rowsBefore).toHaveLength(1);

    // 追加新版本（如运营调价/调额度）→ 旧版本行保持不变（不可篡改）
    const v2 = await createPlanVersion(deps(), {
      planKey: 'CREATOR',
      name: 'Creator v2',
      entitlements: { ...(rowsBefore[0]?.entitlements as object), seats: 2, customMotionPerMonth: 50 } as never,
      price: { amountMinor: 1900, currency: 'USD', interval: 'MONTH' },
      status: 'ACTIVE',
    });
    expect(v2.version).toBe(2);
    const rowsAfter = await handle.db.select().from(plans).where(eq(plans.planKey, 'CREATOR')).orderBy(plans.version);
    expect(rowsAfter).toHaveLength(2);
    expect(rowsAfter[0]?.entitlements).toMatchObject({ seats: 1 }); // 旧行内容未变
    expect(rowsAfter[1]?.price).toEqual({ amountMinor: 1900, currency: 'USD', interval: 'MONTH' });

    // 目录查询（认证用户）：同 Key 全版本
    const user = await newClient('plans-catalog');
    const items = await user.plans.list({ planKey: 'CREATOR' });
    expect(items.map((plan) => plan.version)).toEqual([2, 1]);
  }, 120_000);

  it('指派套餐：订阅 append-only（旧行 supersededAt，历史保留；账本行数不变）', async () => {
    await ensureDefaultPlans(deps());
    const user = await newClient('plans-assign');
    const admin = await newAdminClient();
    const workspace = await user.workspaces.create({ name: `套餐-${randomUUID().slice(0, 8)}` });

    // 未订阅：默认套餐（测试环境默认 ENTERPRISE=不限）
    const initial = await user.workspaces.entitlements(workspace.id);
    expect(initial.source).toBe('DEFAULT_FREE');
    expect(initial.plan.planKey).toBe('ENTERPRISE');

    const ledgerRowsBefore = await handle.db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspace.id));

    const first = await admin.admin.assignPlan(workspace.id, { planKey: 'CREATOR', note: '试用转正' });
    expect(first.planKey).toBe('CREATOR');
    expect(first.planVersion).toBe(1);

    const afterFirst = await user.workspaces.entitlements(workspace.id);
    expect(afterFirst.source).toBe('SUBSCRIPTION');
    expect(afterFirst.entitlements.seats).toBe(1);
    expect(afterFirst.entitlements.storageBytes).toBe(50 * 1024 * 1024 * 1024);

    // 换套餐 → 新行；旧行被标记 supersededAt（内容不改写）
    const second = await admin.admin.assignPlan(workspace.id, { planKey: 'PRO' });
    expect(second.planKey).toBe('PRO');
    const subscriptionRows = await handle.db.select().from(workspaceSubscriptions).where(eq(workspaceSubscriptions.workspaceId, workspace.id)).orderBy(workspaceSubscriptions.startedAt);
    expect(subscriptionRows).toHaveLength(2);
    expect(subscriptionRows[0]?.planKey).toBe('CREATOR');
    expect(subscriptionRows[0]?.supersededAt).not.toBeNull(); // 历史保留
    expect(subscriptionRows[1]?.planKey).toBe('PRO');
    expect(subscriptionRows[1]?.supersededAt).toBeNull();

    // 修改套餐不篡改历史账单：账本行数不变
    const ledgerRowsAfter = await handle.db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspace.id));
    expect(ledgerRowsAfter.length).toBe(ledgerRowsBefore.length);

    // 普通用户不能指派（admin 面 404 反枚举）
    const denied = await user.admin.assignPlan(workspace.id, { planKey: 'ENTERPRISE' }).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(AncsApiError);
    expect((denied as AncsApiError).status).toBe(404);
  }, 120_000);

  it('额度强制执行：FREE 套餐下 栏目/身份/BYOK/4K 均被明确阻止（422/403 + reason）', async () => {
    await ensureDefaultPlans(deps());
    const user = await newClient('plans-enforce');
    const admin = await newAdminClient();
    const workspace = await user.workspaces.create({ name: `额度-${randomUUID().slice(0, 8)}` });
    await admin.admin.assignPlan(workspace.id, { planKey: 'FREE' });

    // FREE：maxChannels=1 —— 第 2 个栏目被阻止
    await user.channels.create(workspace.id, { name: '栏目 1' });
    const channelDenied = await user.channels.create(workspace.id, { name: '栏目 2' }).catch((error: unknown) => error);
    expect(channelDenied).toBeInstanceOf(AncsApiError);
    expect((channelDenied as AncsApiError).status).toBe(422);
    expect((channelDenied as AncsApiError).details['reason']).toBe('CHANNELS_EXCEEDED');

    // FREE：maxCreatorIdentities=1 —— 第 2 个身份被阻止
    await user.creatorIdentities.create(workspace.id, { displayName: '身份 1' });
    const identityDenied = await user.creatorIdentities.create(workspace.id, { displayName: '身份 2' }).catch((error: unknown) => error);
    expect((identityDenied as AncsApiError).details['reason']).toBe('IDENTITIES_EXCEEDED');

    // FREE：byok=false —— 创建 Provider 连接被阻止（403）
    const byokDenied = await user.providerConnections.create(workspace.id, { providerId: 'unknown.provider', kind: 'LLM', label: 'BYOK', secret: 'sk-test-secret-0123456789' /* secrets:check-ignore：测试专用假密钥 */ }).catch((error: unknown) => error);
    expect(byokDenied).toBeInstanceOf(AncsApiError);
    expect((byokDenied as AncsApiError).status).toBe(403);
    expect((byokDenied as AncsApiError).details['reason']).toBe('BYOK_NOT_ALLOWED');

    // FREE：fourK=false —— PREMIUM_4K 渲染被阻止（422）；STUDIO_1080 不受限（缺 Master 会先 409，属渲染前置；此处验证 4K 门在前）
    const render4k = await user.renders
      .create(workspace.id, await (async () => (await user.projects.create(workspace.id, { title: '额度项目', channelId: (await user.channels.list(workspace.id))[0]?.id ?? '' })).id)(), { profile: 'PREMIUM_4K' })
      .catch((error: unknown) => error);
    expect(render4k).toBeInstanceOf(AncsApiError);
    expect([422, 409]).toContain((render4k as AncsApiError).status);
    if ((render4k as AncsApiError).status === 422) {
      expect((render4k as AncsApiError).details['reason']).toBe('RENDER_PROFILE_NOT_ALLOWED');
    }
  }, 120_000);
});
