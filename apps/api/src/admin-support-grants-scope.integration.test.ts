import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import {
  adminPrincipals, adminRoleGrants, adminRoleScopes, createDb, redactDatabaseUrl,
  resolveTestDatabaseUrl, runMigrations, supportAccessGrants, user, workspaces, type DbHandle,
} from '@ancs/db';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { buildServer } from './server.js';
import { enrollTestOpsTotp, provisionTestOpsPrincipal, signInTestOpsClient, testOpsDeps } from './test-helpers/ops-auth.js';

const PASSWORD = 'support-grants-test-password'; // secrets:check-ignore: test-only fake credential
const PURPOSE_CANARY = 'private-purpose-canary'; // secrets:check-ignore: test-only leak sentinel
const REQUESTER_CANARY = 'private-requester-canary'; // secrets:check-ignore: test-only leak sentinel
const REVOKER_CANARY = 'private-revoker-canary'; // secrets:check-ignore: test-only leak sentinel
const TICKET_A = 'ticket-support-A';
const TICKET_B = 'ticket-support-B';
const SAFE_KEYS = ['createdAt', 'expiresAt', 'id', 'scope', 'status', 'workspaceId'];

type Operator = { userId: string; email: string; totpUri: string; principalId: string };
type Scope = { workspaceId: string; ticketId: string; startsAt: Date; expiresAt: Date };

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let workspaceA: string;
let workspaceB: string;
let operatorA: Operator;
let operatorB: Operator;
let noScopeOperator: Operator;
let expiredScopeOperator: Operator;
let targetGrantId: string;

async function createOperator(scopes: Scope[]): Promise<Operator> {
  const email = `support-grants-${randomUUID()}@test.local`;
  const user = await createInternalUser(auth, { email, password: PASSWORD, name: 'support grants operator' });
  await provisionTestOpsPrincipal(handle.db, user.id);
  const principal = (await handle.db.select({ id: adminPrincipals.id }).from(adminPrincipals)
    .where(eq(adminPrincipals.userId, user.id)).limit(1))[0];
  if (!principal) throw new Error('Missing test ops principal');
  const roleGrant = (await handle.db.select({ id: adminRoleGrants.id }).from(adminRoleGrants)
    .where(eq(adminRoleGrants.principalId, principal.id)).limit(1))[0];
  if (!roleGrant) throw new Error('Missing test role grant');
  await handle.db.update(adminRoleGrants).set({ role: 'SUPPORT_L2' }).where(eq(adminRoleGrants.id, roleGrant.id));
  await handle.db.delete(adminRoleScopes).where(eq(adminRoleScopes.roleGrantId, roleGrant.id));
  if (scopes.length > 0) await handle.db.insert(adminRoleScopes).values(scopes.map((scope) => ({
    id: `opsc_${randomUUID()}`, roleGrantId: roleGrant.id, scopeKind: 'WORKSPACE', ...scope,
  })));
  const totpUri = await enrollTestOpsTotp(createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' }), email, PASSWORD);
  return { userId: user.id, email, totpUri, principalId: principal.id };
}

async function signedInClient(operator: Operator, fetchImpl?: typeof fetch): Promise<AncsClient> {
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0', ...(fetchImpl ? { fetchImpl } : {}) });
  await signInTestOpsClient(client, operator.email, PASSWORD, operator.totpUri);
  return client;
}

async function expectStatus(promise: Promise<unknown>, expected: number): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  expect((error as AncsApiError).status).toBe(expected);
}

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try { await handle.pool.query('select 1'); }
  catch (error) { await handle.close(); throw new Error(`Cannot connect to test database ${redactDatabaseUrl(url)}`, { cause: error }); }
  await runMigrations(handle);
  auth = createAuth({ db: handle.db, secret: 'support-grants-auth-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore: test-only fake key
  workspaceA = `ws_${randomUUID()}`;
  workspaceB = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values([{ id: workspaceA, name: 'Support grants A' }, { id: workspaceB, name: 'Support grants B' }]);
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    admin: testOpsDeps(handle.db),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;

  const now = Date.now();
  const valid = { startsAt: new Date(now - 60_000), expiresAt: new Date(now + 60 * 60_000) };
  operatorA = await createOperator([
    { workspaceId: workspaceA, ticketId: TICKET_A, ...valid },
    { workspaceId: workspaceA, ticketId: TICKET_B, ...valid },
    { workspaceId: workspaceB, ticketId: TICKET_A, ...valid },
  ]);
  operatorB = await createOperator([{ workspaceId: workspaceA, ticketId: TICKET_A, ...valid }]);
  noScopeOperator = await createOperator([]);
  expiredScopeOperator = await createOperator([{
    workspaceId: workspaceA, ticketId: TICKET_A,
    startsAt: new Date(now - 120_000), expiresAt: new Date(now - 60_000),
  }]);

  const future = new Date(now + 60 * 60_000);
  const newer = new Date('2026-10-07T00:00:00.000Z');
  const grant = (beneficiaryPrincipalId: string, workspaceId: string, ticketId: string, createdAt = newer) => ({
    id: `sag_${randomUUID()}`, workspaceId, beneficiaryPrincipalId, ticketId, scope: 'SUMMARY_READ',
    requestedByUserId: REQUESTER_CANARY, purpose: PURPOSE_CANARY, status: 'ACTIVE', expiresAt: future, createdAt,
  });
  targetGrantId = `sag_${randomUUID()}`;
  await handle.db.insert(supportAccessGrants).values([
    {
      ...grant(operatorA.principalId, workspaceA, TICKET_A, new Date('2026-10-01T00:00:00.000Z')),
      id: targetGrantId, status: 'REVOKED', revokedByUserId: REVOKER_CANARY, revokedAt: newer,
    },
    ...Array.from({ length: 101 }, () => grant(operatorB.principalId, workspaceA, TICKET_A)),
    ...Array.from({ length: 101 }, () => grant(operatorA.principalId, workspaceA, TICKET_B)),
    ...Array.from({ length: 101 }, () => grant(operatorA.principalId, workspaceB, TICKET_A)),
  ]);
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (handle && workspaceA && workspaceB) {
    await handle.db.delete(workspaces).where(inArray(workspaces.id, [workspaceA, workspaceB]));
  }
  if (handle) {
    const userIds = [operatorA?.userId, operatorB?.userId, noScopeOperator?.userId, expiredScopeOperator?.userId]
      .filter((id): id is string => Boolean(id));
    if (userIds.length > 0) await handle.db.delete(user).where(inArray(user.id, userIds));
  }
  await handle?.close();
});

describe('N15-03 ticket-scoped support grant list', () => {
  it('filters workspace, beneficiary and ticket before LIMIT; returns only safe metadata', async () => {
    let rawResponse = '';
    let omitTicket = false;
    const captureFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === `/api/v1/admin/workspaces/${workspaceA}/support-grants` && omitTicket) url.searchParams.delete('ticketId');
      const response = await fetch(url.toString(), init);
      if (url.pathname === `/api/v1/admin/workspaces/${workspaceA}/support-grants` && response.ok) rawResponse = await response.clone().text();
      return response;
    };
    const clientA = await signedInClient(operatorA, captureFetch);
    const visible = await clientA.admin.supportGrants(workspaceA, TICKET_A);
    expect(visible.map((grant) => grant.id)).toEqual([targetGrantId]);
    expect(visible[0]?.status).toBe('REVOKED');
    expect(Object.keys(visible[0] ?? {}).sort()).toEqual(SAFE_KEYS);
    const serverItems = (JSON.parse(rawResponse) as { items: Record<string, unknown>[] }).items;
    expect(Object.keys(serverItems[0] ?? {}).sort()).toEqual(SAFE_KEYS);
    expect(rawResponse).not.toContain(PURPOSE_CANARY);
    expect(rawResponse).not.toContain(REQUESTER_CANARY);
    expect(rawResponse).not.toContain(REVOKER_CANARY);
    expect(rawResponse).not.toMatch(/"(?:purpose|requestedByUserId|revokedByUserId|ticketId|beneficiaryPrincipalId)"\s*:/);

    const otherTicket = await clientA.admin.supportGrants(workspaceA, TICKET_B);
    expect(otherTicket).toHaveLength(100);
    expect(otherTicket.every((grant) => grant.id !== targetGrantId && grant.workspaceId === workspaceA)).toBe(true);
    const otherWorkspace = await clientA.admin.supportGrants(workspaceB, TICKET_A);
    expect(otherWorkspace).toHaveLength(100);
    expect(otherWorkspace.every((grant) => grant.id !== targetGrantId && grant.workspaceId === workspaceB)).toBe(true);

    const clientB = await signedInClient(operatorB);
    const beneficiaryB = await clientB.admin.supportGrants(workspaceA, TICKET_A);
    expect(beneficiaryB).toHaveLength(100);
    expect(beneficiaryB.every((grant) => grant.id !== targetGrantId)).toBe(true);

    await expectStatus(clientA.admin.supportGrants(workspaceA, 'ticket-unassigned'), 403);
    await expectStatus(clientA.admin.supportGrants(`ws_${randomUUID()}`, TICKET_A), 403);
    omitTicket = true;
    await expectStatus(clientA.admin.supportGrants(workspaceA, TICKET_A), 400);
  }, 120_000);

  it('denies SUPPORT_L2 without a matching finite scope', async () => {
    const unscoped = await signedInClient(noScopeOperator);
    await expectStatus(unscoped.admin.supportGrants(workspaceA, TICKET_A), 403);
    const expired = await signedInClient(expiredScopeOperator);
    await expectStatus(expired.admin.supportGrants(workspaceA, TICKET_A), 403);
  }, 120_000);
});
