import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import {
  adminPrincipals, adminRoleGrants, adminRoleScopes, assets, assetVersions,
  createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations,
  user, workspaces, type DbHandle,
} from '@ancs/db';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { buildServer } from './server.js';
import { enrollTestOpsTotp, provisionTestOpsPrincipal, signInTestOpsClient, testOpsDeps } from './test-helpers/ops-auth.js';

const PASSWORD = 'storage-scope-test-password'; // secrets:check-ignore: test-only fake credential
const CANARY = 'private-storage-key-and-filename-secret-canary'; // secrets:check-ignore: test-only leak sentinel

type Operator = { userId: string; email: string; totpUri: string };
let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let workspaceA: string;
let workspaceB: string;
let scoped: Operator;
let platformOnly: Operator;
let noScope: Operator;

async function createOperator(tag: string, scope: 'A' | 'PLATFORM' | 'NONE'): Promise<Operator> {
  const email = `storage-${tag}-${randomUUID()}@test.local`;
  const created = await createInternalUser(auth, { email, password: PASSWORD, name: tag });
  await provisionTestOpsPrincipal(handle.db, created.id);
  const principal = (await handle.db.select({ id: adminPrincipals.id }).from(adminPrincipals).where(eq(adminPrincipals.userId, created.id)).limit(1))[0];
  if (!principal) throw new Error('Missing test principal');
  const grant = (await handle.db.select({ id: adminRoleGrants.id }).from(adminRoleGrants).where(eq(adminRoleGrants.principalId, principal.id)).limit(1))[0];
  if (!grant) throw new Error('Missing test role grant');
  if (scope === 'A') {
    await handle.db.insert(adminRoleScopes).values({ id: `opsc_${randomUUID()}`, roleGrantId: grant.id, scopeKind: 'WORKSPACE', workspaceId: workspaceA });
  } else if (scope === 'NONE') {
    await handle.db.delete(adminRoleScopes).where(eq(adminRoleScopes.roleGrantId, grant.id));
  }
  return { userId: created.id, email, totpUri: '' };
}

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
  auth = createAuth({ db: handle.db, secret: 'storage-scope-auth-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore: test-only fake key
  workspaceA = `ws_${randomUUID()}`;
  workspaceB = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values([{ id: workspaceA, name: 'Storage scope A' }, { id: workspaceB, name: 'Storage scope B' }]);

  const assetA = `ast_${randomUUID()}`;
  const assetB = `ast_${randomUUID()}`;
  const versionA = `av_${randomUUID()}`;
  const versionB = `av_${randomUUID()}`;
  const license = { type: 'USER_OWNED', holder: null, attribution: null, sourceUrl: null, termsUrl: null, notes: null, confirmedBy: null, confirmedAt: null };
  await handle.db.insert(assets).values([
    { id: assetA, workspaceId: workspaceA, assetType: 'USER_UPLOAD', origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'KEEP_USER_SOURCE', license, metadata: { filename: CANARY }, currentVersionId: versionA },
    { id: assetB, workspaceId: workspaceB, assetType: 'USER_UPLOAD', origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'KEEP_USER_SOURCE', license, metadata: { filename: CANARY }, currentVersionId: versionB },
  ]);
  await handle.db.insert(assetVersions).values([
    { id: versionA, assetId: assetA, workspaceId: workspaceA, versionNumber: 1, storageKey: `workspaces/${workspaceA}/${CANARY}`, mimeType: 'video/mp4', sizeBytes: 123, checksumSha256: 'a'.repeat(64), status: 'READY', metadata: { filename: CANARY } },
    { id: versionB, assetId: assetB, workspaceId: workspaceB, versionNumber: 1, storageKey: `workspaces/${workspaceB}/${CANARY}`, mimeType: 'video/mp4', sizeBytes: 9876, checksumSha256: 'b'.repeat(64), status: 'READY', metadata: { filename: CANARY } },
  ]);

  scoped = await createOperator('scoped', 'A');
  platformOnly = await createOperator('platform-only', 'PLATFORM');
  noScope = await createOperator('no-scope', 'NONE');
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    admin: testOpsDeps(handle.db),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
  for (const operator of [scoped, platformOnly, noScope]) {
    operator.totpUri = await enrollTestOpsTotp(createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' }), operator.email, PASSWORD);
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (handle) {
    if (workspaceA && workspaceB) await handle.db.delete(workspaces).where(inArray(workspaces.id, [workspaceA, workspaceB]));
    const userIds = [scoped?.userId, platformOnly?.userId, noScope?.userId].filter((id): id is string => Boolean(id));
    if (userIds.length > 0) await handle.db.delete(user).where(inArray(user.id, userIds));
    await handle.close();
  }
});

async function opsClient(operator: Operator, fetchImpl?: typeof fetch): Promise<AncsClient> {
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0', ...(fetchImpl ? { fetchImpl } : {}) });
  await signInTestOpsClient(client, operator.email, PASSWORD, operator.totpUri);
  return client;
}

describe('Admin storage scoped projection', () => {
  it('returns only A aggregates and rejects B, platform-only, no-scope, and missing-workspace reads', async () => {
    let rawResponse = '';
    let cookie = '';
    const captureFetch: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const isStorage = new URL(url).pathname === '/api/v1/admin/storage';
      if (isStorage) cookie = new Headers(init?.headers).get('cookie') ?? '';
      const response = await fetch(input, init);
      if (isStorage && response.ok) rawResponse = await response.clone().text();
      return response;
    };
    const scopedClient = await opsClient(scoped, captureFetch);
    expect(await scopedClient.admin.storage({ workspaceId: workspaceA })).toEqual({ workspaceId: workspaceA, bytesUsed: 123, assetCount: 1 });
    expect(Object.keys(JSON.parse(rawResponse) as Record<string, unknown>).sort()).toEqual(['assetCount', 'bytesUsed', 'workspaceId']);
    expect(rawResponse).not.toContain(CANARY);
    expect(rawResponse).not.toContain(workspaceB);

    const wrongWorkspace = await scopedClient.admin.storage({ workspaceId: workspaceB }).catch((error: unknown) => error);
    expect(wrongWorkspace).toBeInstanceOf(AncsApiError);
    expect((wrongWorkspace as AncsApiError).status).toBe(403);
    const platformClient = await opsClient(platformOnly);
    const platformDenied = await platformClient.admin.storage({ workspaceId: workspaceA }).catch((error: unknown) => error);
    expect(platformDenied).toBeInstanceOf(AncsApiError);
    expect((platformDenied as AncsApiError).status).toBe(403);
    const noScopeClient = await opsClient(noScope);
    const noScopeDenied = await noScopeClient.admin.storage({ workspaceId: workspaceA }).catch((error: unknown) => error);
    expect(noScopeDenied).toBeInstanceOf(AncsApiError);
    expect((noScopeDenied as AncsApiError).status).toBe(403);

    expect(cookie).toContain('ancs_ops_session=');
    const missingWorkspace = await fetch(`${baseUrl}/api/v1/admin/storage`, {
      headers: { cookie, 'x-client-type': 'web', 'x-client-version': '0.1.0' },
    });
    expect(missingWorkspace.status).toBe(400);
  }, 120_000);
});
