import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import {
  adminPrincipals, adminRoleGrants, adminRoleScopes, channels, channelStyleVersions,
  createDb, projects, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations,
  user, workspaces, type DbHandle,
} from '@ancs/db';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { buildServer } from './server.js';
import { enrollTestOpsTotp, provisionTestOpsPrincipal, signInTestOpsClient, testOpsDeps } from './test-helpers/ops-auth.js';

const PASSWORD = 'projects-scope-test-password'; // secrets:check-ignore: test-only fake credential
const TITLE_CANARY = 'private-project-title-secret-canary-do-not-return'; // secrets:check-ignore: test-only leak sentinel

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let workspaceA: string;
let workspaceB: string;
let projectA: string;
let scopedUserId = '';
let unscopedUserId = '';
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
  auth = createAuth({ db: handle.db, secret: 'projects-scope-auth-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore: test-only fake key

  workspaceA = `ws_${randomUUID()}`;
  workspaceB = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values([{ id: workspaceA, name: 'Projects scope A' }, { id: workspaceB, name: 'Projects scope B' }]);
  const channelA = `chn_${randomUUID()}`;
  const channelB = `chn_${randomUUID()}`;
  const styleA = `chs_${randomUUID()}`;
  const styleB = `chs_${randomUUID()}`;
  await handle.db.insert(channels).values([
    { id: channelA, workspaceId: workspaceA, name: 'A', language: 'zh-CN' },
    { id: channelB, workspaceId: workspaceB, name: 'B', language: 'zh-CN' },
  ]);
  await handle.db.insert(channelStyleVersions).values([
    { id: styleA, workspaceId: workspaceA, channelId: channelA, version: 1, defaults: {} },
    { id: styleB, workspaceId: workspaceB, channelId: channelB, version: 1, defaults: {} },
  ]);
  projectA = `prj_${randomUUID()}`;
  await handle.db.insert(projects).values([
    {
      id: projectA, workspaceId: workspaceA, channelId: channelA, channelStyleVersionId: styleA,
      title: TITLE_CANARY, status: 'DRAFT', aspectRatio: '16:9', resolution: '1920x1080',
      createdAt: new Date('2026-10-01T00:00:00.000Z'), updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    },
    {
      id: `prj_${randomUUID()}`, workspaceId: workspaceB, channelId: channelB, channelStyleVersionId: styleB,
      title: TITLE_CANARY, status: 'DRAFT', aspectRatio: '16:9', resolution: '1920x1080',
      createdAt: new Date('2026-10-02T00:00:00.000Z'), updatedAt: new Date('2026-10-02T00:00:00.000Z'),
    },
  ]);

  scopedEmail = `projects-scoped-${randomUUID()}@test.local`;
  const scopedUser = await createInternalUser(auth, { email: scopedEmail, password: PASSWORD, name: 'scoped operator' });
  scopedUserId = scopedUser.id;
  await provisionTestOpsPrincipal(handle.db, scopedUser.id);
  const principal = (await handle.db.select({ id: adminPrincipals.id }).from(adminPrincipals).where(eq(adminPrincipals.userId, scopedUser.id)).limit(1))[0];
  if (!principal) throw new Error('Missing scoped test principal');
  const roleGrant = (await handle.db.select({ id: adminRoleGrants.id }).from(adminRoleGrants).where(eq(adminRoleGrants.principalId, principal.id)).limit(1))[0];
  if (!roleGrant) throw new Error('Missing scoped test role');
  await handle.db.insert(adminRoleScopes).values({ id: `opsc_${randomUUID()}`, roleGrantId: roleGrant.id, scopeKind: 'WORKSPACE', workspaceId: workspaceA });

  unscopedEmail = `projects-unscoped-${randomUUID()}@test.local`;
  const unscopedUser = await createInternalUser(auth, { email: unscopedEmail, password: PASSWORD, name: 'platform-only operator' });
  unscopedUserId = unscopedUser.id;
  await provisionTestOpsPrincipal(handle.db, unscopedUser.id);

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
  if (handle) {
    if (workspaceA && workspaceB) await handle.db.delete(workspaces).where(inArray(workspaces.id, [workspaceA, workspaceB]));
    if (scopedUserId) await handle.db.delete(user).where(eq(user.id, scopedUserId));
    if (unscopedUserId) await handle.db.delete(user).where(eq(user.id, unscopedUserId));
    await handle.close();
  }
});

async function opsClient(email: string, totpUri: string, fetchImpl?: typeof fetch): Promise<AncsClient> {
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0', ...(fetchImpl ? { fetchImpl } : {}) });
  await signInTestOpsClient(client, email, PASSWORD, totpUri);
  return client;
}

describe('Admin projects scoped projection', () => {
  it('filters in SQL before LIMIT and returns only the safe workspace summary', async () => {
    let rawResponse = '';
    let cookie = '';
    const captureFetch: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const isProjects = new URL(url).pathname === '/api/v1/admin/projects';
      if (isProjects) cookie = new Headers(init?.headers).get('cookie') ?? '';
      const response = await fetch(input, init);
      if (isProjects && response.ok) rawResponse = await response.clone().text();
      return response;
    };
    const scoped = await opsClient(scopedEmail, scopedTotpUri, captureFetch);
    const visible = await scoped.admin.projects({ workspaceId: workspaceA, status: 'DRAFT', limit: 1 });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe(projectA);
    expect(visible[0]?.workspaceId).toBe(workspaceA);
    expect(Object.keys(visible[0] ?? {}).sort()).toEqual(['createdAt', 'id', 'status', 'updatedAt', 'workspaceId']);
    expect(rawResponse).not.toContain(TITLE_CANARY);
    expect(rawResponse).not.toMatch(/"(?:title|sourceType|channelId|channelStyleVersionId)"\s*:/);

    const wrongWorkspace = await scoped.admin.projects({ workspaceId: workspaceB }).catch((error: unknown) => error);
    expect(wrongWorkspace).toBeInstanceOf(AncsApiError);
    expect((wrongWorkspace as AncsApiError).status).toBe(403);

    const unscoped = await opsClient(unscopedEmail, unscopedTotpUri);
    const platformScopeOnly = await unscoped.admin.projects({ workspaceId: workspaceA }).catch((error: unknown) => error);
    expect(platformScopeOnly).toBeInstanceOf(AncsApiError);
    expect((platformScopeOnly as AncsApiError).status).toBe(403);

    expect(cookie).toContain('ancs_ops_session=');
    const headers = { cookie, 'x-client-type': 'web', 'x-client-version': '0.1.0' };
    const missingWorkspace = await fetch(`${baseUrl}/api/v1/admin/projects?limit=1`, { headers });
    expect(missingWorkspace.status).toBe(400);
    const fuzzyQuery = await fetch(`${baseUrl}/api/v1/admin/projects?workspaceId=${encodeURIComponent(workspaceA)}&query=${encodeURIComponent(TITLE_CANARY)}`, { headers });
    expect(fuzzyQuery.status).toBe(400);
  }, 120_000);
});
