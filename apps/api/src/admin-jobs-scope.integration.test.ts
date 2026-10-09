import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { adminPrincipals, adminRoleGrants, adminRoleScopes, createDb, jobs, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { buildServer } from './server.js';
import { enrollTestOpsTotp, provisionTestOpsPrincipal, signInTestOpsClient, testOpsDeps } from './test-helpers/ops-auth.js';

const PASSWORD = 'jobs-scope-test-password'; // secrets:check-ignore: test-only fake credential
const CANARY = 'job-private-canary-do-not-return'; // secrets:check-ignore: test-only leak sentinel

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let workspaceA: string;
let workspaceB: string;
let scopedEmail: string;
let scopedTotpUri: string;
let unscopedEmail: string;
let unscopedTotpUri: string;

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try {
    await handle.pool.query('select 1');
  } catch (error) {
    await handle.close();
    throw new Error(`Cannot connect to test database ${redactDatabaseUrl(url)}`, { cause: error });
  }
  await runMigrations(handle);
  auth = createAuth({ db: handle.db, secret: 'jobs-scope-auth-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore: test-only fake key
  workspaceA = `ws_${randomUUID()}`;
  workspaceB = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values([{ id: workspaceA, name: 'Scoped jobs A' }, { id: workspaceB, name: 'Scoped jobs B' }]);

  scopedEmail = `jobs-scoped-${randomUUID()}@test.local`;
  const scopedUser = await createInternalUser(auth, { email: scopedEmail, password: PASSWORD, name: 'scoped operator' });
  await provisionTestOpsPrincipal(handle.db, scopedUser.id);
  const principal = (await handle.db.select({ id: adminPrincipals.id }).from(adminPrincipals).where(eq(adminPrincipals.userId, scopedUser.id)).limit(1))[0];
  if (!principal) throw new Error('Missing scoped test principal');
  const roleGrant = (await handle.db.select({ id: adminRoleGrants.id }).from(adminRoleGrants).where(eq(adminRoleGrants.principalId, principal.id)).limit(1))[0];
  if (!roleGrant) throw new Error('Missing scoped test role');
  await handle.db.insert(adminRoleScopes).values({ id: `opsc_${randomUUID()}`, roleGrantId: roleGrant.id, scopeKind: 'WORKSPACE', workspaceId: workspaceA });

  unscopedEmail = `jobs-unscoped-${randomUUID()}@test.local`;
  const unscopedUser = await createInternalUser(auth, { email: unscopedEmail, password: PASSWORD, name: 'unscoped operator' });
  await provisionTestOpsPrincipal(handle.db, unscopedUser.id);

  await handle.db.insert(jobs).values([
    { id: `job_${randomUUID()}`, workspaceId: workspaceA, type: CANARY, status: 'FAILED_FINAL', stage: CANARY, input: { secret: CANARY }, result: { secret: CANARY }, error: { reason: CANARY }, createdAt: new Date('2026-10-01T00:00:00.000Z') },
    { id: `job_${randomUUID()}`, workspaceId: workspaceB, type: CANARY, status: 'FAILED_FINAL', input: { secret: CANARY }, error: { reason: CANARY }, createdAt: new Date('2026-10-02T00:00:00.000Z') },
  ]);

  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    admin: testOpsDeps(handle.db),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
  scopedTotpUri = await enrollTestOpsTotp(createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' }), scopedEmail, PASSWORD);
  unscopedTotpUri = await enrollTestOpsTotp(createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' }), unscopedEmail, PASSWORD);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
});

async function opsClient(email: string, totpUri: string, fetchImpl?: typeof fetch): Promise<AncsClient> {
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0', ...(fetchImpl ? { fetchImpl } : {}) });
  await signInTestOpsClient(client, email, PASSWORD, totpUri);
  return client;
}

describe('Admin jobs scoped projection', () => {
  it('filters in SQL before LIMIT, returns only safe fields, and denies missing or wrong workspace scope', async () => {
    let rawResponse = '';
    const captureFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === '/api/v1/admin/jobs' && response.ok) rawResponse = await response.clone().text();
      return response;
    };
    const scoped = await opsClient(scopedEmail, scopedTotpUri, captureFetch);
    const visible = await scoped.admin.jobs({ workspaceId: workspaceA, status: 'FAILED_FINAL', limit: 1 });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.workspaceId).toBe(workspaceA);
    expect(visible[0]?.errorCategory).toBe('FINAL');
    expect(Object.keys(visible[0] ?? {}).sort()).toEqual([
      'attempts', 'createdAt', 'errorCategory', 'id', 'maxAttempts', 'needsReconciliation',
      'nextAttemptAt', 'projectId', 'status', 'submitState', 'updatedAt', 'workspaceId',
    ]);
    expect(rawResponse).not.toContain(CANARY);
    expect(rawResponse).not.toMatch(/"(?:input|result|error|stage|type)"\s*:/);

    const wrongTenant = await scoped.admin.jobs({ workspaceId: workspaceB }).catch((error: unknown) => error);
    expect(wrongTenant).toBeInstanceOf(AncsApiError);
    expect((wrongTenant as AncsApiError).status).toBe(403);

    const unscoped = await opsClient(unscopedEmail, unscopedTotpUri);
    const missingScope = await unscoped.admin.jobs({ workspaceId: workspaceA }).catch((error: unknown) => error);
    expect(missingScope).toBeInstanceOf(AncsApiError);
    expect((missingScope as AncsApiError).status).toBe(403);
  }, 120_000);
});
