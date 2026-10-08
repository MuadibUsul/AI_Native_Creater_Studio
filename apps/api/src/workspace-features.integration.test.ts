import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { ApiFailure } from '@ancs/contracts';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { assertWorkspaceFeatureWriteAllowed } from '@ancs/domain';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { buildServer } from './server.js';

const PASSWORD = 'workspace-feature-test-password'; // secrets:check-ignore: test-only fake credential
let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
const workspaceIds: string[] = [];

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
  auth = createAuth({ db: handle.db, secret: 'workspace-feature-auth-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore: test-only fake key
  app = await buildServer({ auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
}, 120_000);

afterAll(async () => {
  if (workspaceIds.length > 0) await handle.db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
  await app?.close();
  await handle?.close();
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

describe('N00-05 workspace release controls', () => {
  it('defaults off, records opt-in without bypassing G0, preserves existing project reads, and isolates tenants', async () => {
    const owner = await newClient('feature-owner');
    const outsider = await newClient('feature-outsider');
    const workspace = await owner.workspaces.create({ name: `Feature A ${randomUUID().slice(0, 8)}` });
    const other = await outsider.workspaces.create({ name: `Feature B ${randomUUID().slice(0, 8)}` });
    workspaceIds.push(workspace.id, other.id);
    const channel = await owner.channels.create(workspace.id, { name: 'Legacy channel' });
    const project = await owner.projects.create(workspace.id, { title: 'Existing project', channelId: channel.id });

    const defaults = await owner.workspaces.features(workspace.id);
    expect(defaults).toHaveLength(5);
    expect(defaults.every((item) => !item.requestedEnabled && item.effectiveState === 'OFF')).toBe(true);

    const optedIn = await owner.workspaces.setFeature(workspace.id, 'V04_MEDIA_EDITING', true);
    expect(optedIn).toMatchObject({ requestedEnabled: true, effectiveState: 'READ_ONLY', reason: 'RELEASE_GATE_BLOCKED', releaseReady: false });
    const blocked = await assertWorkspaceFeatureWriteAllowed(
      { db: handle.db },
      { workspaceId: workspace.id, featureKey: 'V04_MEDIA_EDITING' },
    ).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(ApiFailure);
    expect((blocked as ApiFailure).details).toMatchObject({ reason: 'RELEASE_GATE_BLOCKED', effectiveState: 'READ_ONLY' });

    // A blocked or disabled v0.4 gate must not hide or mutate pre-existing resources.
    expect((await owner.projects.get(project.id)).id).toBe(project.id);
    const disabled = await owner.workspaces.setFeature(workspace.id, 'V04_MEDIA_EDITING', false);
    expect(disabled).toMatchObject({ requestedEnabled: false, effectiveState: 'OFF', reason: 'WORKSPACE_DISABLED' });
    expect((await owner.projects.get(project.id)).id).toBe(project.id);

    const crossTenantRead = await outsider.workspaces.features(workspace.id).catch((error: unknown) => error);
    expect(crossTenantRead).toBeInstanceOf(AncsApiError);
    expect((crossTenantRead as AncsApiError).status).toBe(404);
    const crossTenantWrite = await outsider.workspaces.setFeature(workspace.id, 'V04_MEDIA_EDITING', true).catch((error: unknown) => error);
    expect(crossTenantWrite).toBeInstanceOf(AncsApiError);
    expect((crossTenantWrite as AncsApiError).status).toBe(404);
  }, 120_000);
});
