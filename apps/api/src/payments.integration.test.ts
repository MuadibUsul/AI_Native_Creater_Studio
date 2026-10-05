import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, billingEvents, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaceSubscriptions, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockPaymentProvider } from '@ancs/providers-mock-payments';
import { buildServer } from './server.js';

/**
 * P09-02 验收（真实 DB + 脚本化收款适配器；验收六类事件全覆盖）：
 * - 成功（CHECKOUT_COMPLETED → ACTIVE + 订阅切换）；失败（PAYMENT_FAILED → PAST_DUE）；续费（RENEWED → ACTIVE）；
 *   取消（CANCELED → 取消 + 回落默认套餐）；
 * - **重复**（同 providerEventId → DUPLICATE，不重复生效）；**乱序**（occurredAt ≤ 水位 → OUT_OF_ORDER + 审计行）；
 * - **网页返回不代表入账**（checkout 后状态不变）；伪造签名 → 401；
 * - fail-closed：未配置适配器 → 收款端点 501。
 * 真实 Stripe 测试账号的事件核验：**BLOCKED（凭据）**——本文件以同构验签路径验证状态机与闸门。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let provider: MockPaymentProvider;
const MOCK_SECRET = 'mock-payments-signing-secret-0123456789'; // secrets:check-ignore：测试专用假密钥
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
  auth = createAuth({ db: handle.db, secret: 'payments-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  provider = new MockPaymentProvider({ signingSecret: MOCK_SECRET });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    payments: { provider, successUrlBase: 'http://localhost:3000' },
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

async function postEvent(scripted: { headers: Record<string, string>; body: string }): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${baseUrl}/api/v1/webhooks/payments`, { method: 'POST', headers: scripted.headers, body: scripted.body });
  return { status: response.status, json: await response.json().catch(() => null) };
}

describe('订阅收款（P09-02；脚本化渠道验证事件矩阵）', () => {
  it('结账返回渠道 URL（**网页返回不入账**）；事件驱动：成功→ACTIVE+订阅、失败→PAST_DUE、续费→ACTIVE、取消→回落默认套餐', async () => {
    const user = await newClient('payments-flow');
    const workspace = await user.workspaces.create({ name: `收款-${randomUUID().slice(0, 8)}` });

    // 结账：返回渠道 URL；**状态不变**（网页返回不是入账依据）
    const checkout = await user.workspaces.checkout(workspace.id, { planKey: 'PRO' });
    expect(checkout.checkoutUrl).toContain('payments.mock.local');
    expect(checkout.checkoutUrl).toContain('plan=PRO');
    const afterCheckout = await user.workspaces.billing(workspace.id);
    expect(afterCheckout.state.state).toBe('NONE'); // 结账页跳转不改变状态

    // 成功 → ACTIVE + 订阅切到 PRO（权益生效）
    const completed = await postEvent(
      provider.scriptEvent({
        type: 'CHECKOUT_COMPLETED',
        workspaceId: workspace.id,
        planKey: 'PRO',
        providerSubscriptionRef: 'sub_mock_pro',
        occurredAt: new Date().toISOString(),
      }),
    );
    expect(completed.status).toBe(200);
    const afterCompleted = await user.workspaces.billing(workspace.id);
    expect(afterCompleted.state.state).toBe('ACTIVE');
    expect(afterCompleted.state.planKey).toBe('PRO');
    const entitlement = await user.workspaces.entitlements(workspace.id);
    expect(entitlement.plan.planKey).toBe('PRO');
    expect(entitlement.entitlements.byok).toBe(true);

    // 失败 → PAST_DUE（套餐保留，状态降级——P09-04 消费）
    await postEvent(provider.scriptEvent({ type: 'PAYMENT_FAILED', workspaceId: workspace.id, occurredAt: new Date(Date.now() + 1000).toISOString() }));
    const afterFailed = await user.workspaces.billing(workspace.id);
    expect(afterFailed.state.state).toBe('PAST_DUE');

    // 续费（INVOICE_PAID/RENEWED）→ ACTIVE
    await postEvent(provider.scriptEvent({ type: 'SUBSCRIPTION_RENEWED', workspaceId: workspace.id, planKey: 'PRO', occurredAt: new Date(Date.now() + 2000).toISOString() }));
    expect((await user.workspaces.billing(workspace.id)).state.state).toBe('ACTIVE');

    // 取消 → CANCELED（订阅回落：不再 ACTIVE → 权益回部署默认套餐）
    await postEvent(provider.scriptEvent({ type: 'SUBSCRIPTION_CANCELED', workspaceId: workspace.id, occurredAt: new Date(Date.now() + 3000).toISOString() }));
    const afterCancel = await user.workspaces.billing(workspace.id);
    expect(afterCancel.state.state).toBe('CANCELED');
    const entitlementAfterCancel = await user.workspaces.entitlements(workspace.id);
    expect(entitlementAfterCancel.source).toBe('DEFAULT_FREE'); // 无 ACTIVE 订阅 → 部署默认套餐
    const subscriptions = await handle.db.select().from(workspaceSubscriptions).where(eq(workspaceSubscriptions.workspaceId, workspace.id));
    expect(subscriptions.some((row) => row.supersededAt !== null)).toBe(true); // 历史保留
  }, 120_000);

  it('重复与乱序：同 eventId 不重复生效；早于水位的事件被忽略并审计；伪造签名 401', async () => {
    const user = await newClient('payments-dedupe');
    const workspace = await user.workspaces.create({ name: `去重-${randomUUID().slice(0, 8)}` });

    const eventId = `evt_dup_${randomUUID()}`;
    const completed = provider.scriptEvent({
      providerEventId: eventId,
      type: 'CHECKOUT_COMPLETED',
      workspaceId: workspace.id,
      planKey: 'CREATOR',
      occurredAt: new Date().toISOString(),
    });
    const first = await postEvent(completed);
    expect(first.status).toBe(200);
    expect((first.json as { outcome: string }).outcome).toBe('APPLIED');
    const subscriptionsAfterFirst = await handle.db.select().from(workspaceSubscriptions).where(eq(workspaceSubscriptions.workspaceId, workspace.id));
    expect(subscriptionsAfterFirst).toHaveLength(1);

    // 重复（完全相同的事件重放）→ DUPLICATE；订阅不重复切换
    const duplicate = await postEvent(completed);
    expect(duplicate.status).toBe(200);
    expect((duplicate.json as { outcome: string }).outcome).toBe('DUPLICATE');
    expect((duplicate.json as { applied: boolean }).applied).toBe(false);
    const subscriptionsAfterDuplicate = await handle.db.select().from(workspaceSubscriptions).where(eq(workspaceSubscriptions.workspaceId, workspace.id));
    expect(subscriptionsAfterDuplicate).toHaveLength(1); // 未重复生效

    // 乱序（发生时间早于水位）→ OUT_OF_ORDER + 审计行；状态不变
    const stale = await postEvent(
      provider.scriptEvent({ type: 'PAYMENT_FAILED', workspaceId: workspace.id, occurredAt: new Date(Date.now() - 60_000).toISOString() }),
    );
    expect(stale.status).toBe(200);
    expect((stale.json as { outcome: string }).outcome).toBe('OUT_OF_ORDER');
    const stateAfterStale = await user.workspaces.billing(workspace.id);
    expect(stateAfterStale.state.state).toBe('ACTIVE'); // 未被乱序事件改写

    // 审计：APPLIED + OUT_OF_ORDER 均可见（重复事件因唯一键未落新行——幂等闸门语义）
    const rows = await handle.db.select().from(billingEvents).where(eq(billingEvents.workspaceId, workspace.id));
    const outcomes = rows.map((row) => row.outcome).sort();
    expect(outcomes).toEqual(['APPLIED', 'OUT_OF_ORDER']);

    // 伪造签名 → 401（无副作用）
    const forged = await fetch(`${baseUrl}/api/v1/webhooks/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mock-signature': 't=1,v1=' + 'a'.repeat(64) },
      body: JSON.stringify({ providerEventId: 'evt_forged', type: 'CHECKOUT_COMPLETED', workspaceId: workspace.id, planKey: 'ENTERPRISE', occurredAt: new Date().toISOString(), payload: {} }),
    });
    expect(forged.status).toBe(401);
    const afterForged = await user.workspaces.billing(workspace.id);
    expect(afterForged.state.planKey).toBe('CREATOR'); // 伪造事件未生效
  }, 120_000);

  it('fail-closed 与配置语义：未配置渠道 → webhook 501；未配置门户 → 501', async () => {
    const user = await newClient('payments-failclosed');
    const workspace = await user.workspaces.create({ name: `未配置-${randomUUID().slice(0, 8)}` });

    // 账单入口：mock 渠道未配置 portalUrl → 501（明确失败）
    const portal = await user.workspaces.billingPortal(workspace.id).catch((error: unknown) => error);
    expect(portal).toBeInstanceOf(AncsApiError);
    expect((portal as AncsApiError).status).toBe(501);

    // 未配置适配器的服务器：webhook 501（fail-closed，无 key 绝不伪成功）
    const bareApp = await buildServer({ auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } } });
    await bareApp.listen({ port: 0, host: '127.0.0.1' });
    const bareAddress = bareApp.server.address() as AddressInfo;
    const bareResponse = await fetch(`http://127.0.0.1:${String(bareAddress.port)}/api/v1/webhooks/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(bareResponse.status).toBe(501);
    await bareApp.close();
  }, 120_000);
});
