import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, creditLedger, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { assignWorkspacePlan, createPlanVersion, ensureDefaultPlans, grantMonthlyCredits, type DomainDeps } from '@ancs/domain';
import { MockPaymentProvider } from '@ancs/providers-mock-payments';
import { buildServer } from './server.js';

/**
 * P09-03 验收（真实 DB + 脚本化渠道）：
 * - **充值**：结账只返回 URL（**网页跳转不入账**）；`CREDIT_PURCHASED` 事件入账（金额取自包版本数据）；
 * - **支付成功事件只能入账一次**：同 providerEventId 重放 → DUPLICATE，余额不变；账本唯一索引双保险；
 * - **赠送**（管理端）/ **退款**（反向 REFUND，重复退款幂等）/ **订月授予**（幂等）；
 * - **账单**（余额/预扣/明细）与 **对账**（事件 ↔ 账本）。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let provider: MockPaymentProvider;
let adminEmail = '';
const MOCK_SECRET = 'mock-credits-signing-secret-0123456789'; // secrets:check-ignore：测试专用假密钥
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
  auth = createAuth({ db: handle.db, secret: 'credits-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  adminEmail = `credits-admin-${randomUUID()}@test.local`;
  const adminUser = await createInternalUser(auth, { email: adminEmail, password: ADMIN_PASSWORD, name: 'credits-admin' });
  provider = new MockPaymentProvider({ signingSecret: MOCK_SECRET });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    payments: { provider, successUrlBase: 'http://localhost:3000' },
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

async function newAdminClient(): Promise<AncsClient> {
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email: adminEmail, password: ADMIN_PASSWORD });
  return client;
}

async function postEvent(scripted: { headers: Record<string, string>; body: string }): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const response = await fetch(`${baseUrl}/api/v1/webhooks/payments`, { method: 'POST', headers: scripted.headers, body: scripted.body });
  return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> | null };
}

describe('Credits 商业化（P09-03）', () => {
  it('充值：网页跳转不入账；事件入账一次（重复事件余额不变）；对账一致', async () => {
    const user = await newClient('credits-buy');
    const workspace = await user.workspaces.create({ name: `充值-${randomUUID().slice(0, 8)}` });

    // 包目录（版本化数据）
    const packs = await user.workspaces.creditPacks(workspace.id);
    expect(packs.map((pack) => pack.code).sort()).toEqual(['creator_2000', 'starter', 'studio_10000']);
    const starter = packs.find((pack) => pack.code === 'starter');
    expect(starter?.credits).toBe(500);

    // 结账：只返回 URL；**余额不变（网页跳转不入账）**
    const checkout = await user.workspaces.buyCredits(workspace.id, { packCode: 'starter' });
    expect(checkout.checkoutUrl).toContain('pack=starter');
    const before = await user.workspaces.creditStatement(workspace.id);
    expect(before.balanceCredits).toBe(0);

    // 事件入账（金额取自包数据 = 500）
    const eventId = `evt_credit_${randomUUID()}`;
    const scripted = provider.scriptEvent({
      providerEventId: eventId,
      type: 'CREDIT_PURCHASED',
      workspaceId: workspace.id,
      packCode: 'starter',
      occurredAt: new Date().toISOString(),
    });
    const applied = await postEvent(scripted);
    expect(applied.status).toBe(200);
    expect(applied.json?.['outcome']).toBe('APPLIED');
    const afterPurchase = await user.workspaces.creditStatement(workspace.id);
    expect(afterPurchase.balanceCredits).toBe(500);
    expect(afterPurchase.availableCredits).toBe(500);
    const purchaseEntry = afterPurchase.entries.find((entry) => entry.referenceType === 'billing_event');
    expect(purchaseEntry?.entryType).toBe('CREDIT');
    expect(purchaseEntry?.referenceId).toBe(eventId);

    // **支付成功事件只能入账一次**：同 eventId 重放 → DUPLICATE；余额不变
    const duplicate = await postEvent(scripted);
    expect(duplicate.json?.['outcome']).toBe('DUPLICATE');
    expect((await user.workspaces.creditStatement(workspace.id)).balanceCredits).toBe(500);

    // 对账：事件数 = 账本条目数
    const reconcile = await user.workspaces.reconcileCredits(workspace.id);
    expect(reconcile).toMatchObject({ purchaseEvents: 1, purchaseEntries: 1, consistent: true, balanceCredits: 500 });
  }, 120_000);

  it('赠送（管理端）与退款（扣回，幂等）：账本只追加；重复退款不再产生条目', async () => {
    const user = await newClient('credits-grant');
    const admin = await newAdminClient();
    const workspace = await user.workspaces.create({ name: `赠送-${randomUUID().slice(0, 8)}` });

    const granted = await admin.admin.grantCredits(workspace.id, { amountCredits: 300, reason: '活动赠送' });
    expect(granted.entry.entryType).toBe('CREDIT');
    expect(granted.balanceCredits).toBe(300);

    // 退款 = 扣回（DEBIT + reference_type='refund_of'；amount 恒非负、符号由 entryType 决定）
    const refunded = await admin.admin.refundCredit(workspace.id, { entryId: granted.entry.id, note: '活动撤销' });
    expect(refunded.entry.entryType).toBe('DEBIT');
    expect(refunded.entry.referenceType).toBe('refund_of');
    expect(refunded.idempotent).toBe(false);
    expect(refunded.balanceCredits).toBe(0);

    // 重复退款 → 幂等（不再产生新条目，余额不变）
    const again = await admin.admin.refundCredit(workspace.id, { entryId: granted.entry.id });
    expect(again.idempotent).toBe(true);
    expect(again.balanceCredits).toBe(0);
    const rows = await handle.db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspace.id));
    expect(rows.filter((row) => row.referenceType === 'refund_of')).toHaveLength(1);

    // 非 CREDIT 条目不可退款（明确 422）
    const refundFailure = await admin.admin.refundCredit(workspace.id, { entryId: refunded.entry.id }).catch((error: unknown) => error);
    expect((refundFailure as { status?: number }).status).toBe(422);
  }, 120_000);

  it('订阅月授予：同月幂等（第二次跳过）；金额取自 Plan 权益', async () => {
    const user = await newClient('credits-monthly');
    const workspace = await user.workspaces.create({ name: `月授予-${randomUUID().slice(0, 8)}` });
    // 自定义套餐版本（月授予 100）——版本化数据（运营可调）
    const baseRows = await handle.db.select().from(plans).where(eq(plans.planKey, 'PRO')).limit(1);
    await createPlanVersion(deps(), {
      planKey: 'PRO',
      name: 'Pro（含月授予）',
      entitlements: { ...(baseRows[0]?.entitlements as object), managedCreditsPerMonth: 100 } as never,
      price: null,
      status: 'ACTIVE',
    });
    await assignWorkspacePlan(deps(), { workspaceId: workspace.id, planKey: 'PRO', assignedBy: 'test' });

    const periodStart = new Date('2026-10-01T00:00:00.000Z');
    const first = await grantMonthlyCredits(deps(), { workspaceId: workspace.id, periodStart });
    expect(first.granted).toBe(100);
    const second = await grantMonthlyCredits(deps(), { workspaceId: workspace.id, periodStart });
    expect(second).toMatchObject({ granted: 0, skipped: 'ALREADY_GRANTED' });
    const statement = await user.workspaces.creditStatement(workspace.id);
    expect(statement.balanceCredits).toBe(100);
    expect(statement.entries.filter((entry) => entry.referenceType === 'monthly_grant')).toHaveLength(1);
  }, 120_000);
});
