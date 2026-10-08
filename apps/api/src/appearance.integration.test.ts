import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userAppearancePreferenceSchema } from '@ancs/contracts';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { buildServer } from './server.js';

const password = 'appearance-test-pass-123'; // secrets:check-ignore: test-only dummy
let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let userA: { id: string; email: string };
let userB: { id: string; email: string };
let cookieA1: string;
let cookieA2: string;
let cookieB: string;

async function signIn(email: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-in', payload: { email, password } });
  expect(response.statusCode).toBe(200);
  const headers = response.headers['set-cookie'];
  return (Array.isArray(headers) ? headers : [headers ?? '']).map((entry) => entry.split(';')[0]).join('; ');
}

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
  auth = createAuth({ db: handle.db, secret: 'appearance-test-secret-0123456789abcdef', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore: test-only dummy
  app = await buildServer({ auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } } });
  userA = await createInternalUser(auth, { email: `appearance-a-${randomUUID()}@test.local`, name: 'A', password });
  userB = await createInternalUser(auth, { email: `appearance-b-${randomUUID()}@test.local`, name: 'B', password });
  cookieA1 = await signIn(userA.email);
  cookieA2 = await signIn(userA.email);
  cookieB = await signIn(userB.email);
});

afterAll(async () => { await app?.close(); await handle?.close(); });

describe('N16-02 同步账号外观偏好', () => {
  it('跨两个会话同步 system 意图，同时隔离另一用户', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/v1/users/me/appearance', headers: { cookie: cookieA1 } });
    expect(initial.statusCode).toBe(200);
    expect(userAppearancePreferenceSchema.parse(initial.json())).toEqual({ userId: userA.id, mode: 'system', updatedAt: null });
    expect(initial.headers['cache-control']).toBe('private, no-store');

    const saved = await app.inject({ method: 'PUT', url: '/api/v1/users/me/appearance', headers: { cookie: cookieA1 }, payload: { mode: 'dark' } });
    expect(saved.statusCode).toBe(200);
    expect(userAppearancePreferenceSchema.parse(saved.json())).toMatchObject({ userId: userA.id, mode: 'dark' });

    const otherDevice = await app.inject({ method: 'GET', url: '/api/v1/users/me/appearance', headers: { cookie: cookieA2 } });
    expect(userAppearancePreferenceSchema.parse(otherDevice.json()).mode).toBe('dark');
    const otherUser = await app.inject({ method: 'GET', url: '/api/v1/users/me/appearance', headers: { cookie: cookieB } });
    expect(userAppearancePreferenceSchema.parse(otherUser.json())).toEqual({ userId: userB.id, mode: 'system', updatedAt: null });

    const system = await app.inject({ method: 'PUT', url: '/api/v1/users/me/appearance', headers: { cookie: cookieA2 }, payload: { mode: 'system' } });
    expect(userAppearancePreferenceSchema.parse(system.json()).mode).toBe('system');
    const reread = await app.inject({ method: 'GET', url: '/api/v1/users/me/appearance', headers: { cookie: cookieA1 } });
    expect(userAppearancePreferenceSchema.parse(reread.json()).mode).toBe('system');
  });

  it('拒绝匿名、非法枚举与替他人写入', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/users/me/appearance' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/users/me/appearance', payload: { mode: 'dark' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/users/me/appearance', headers: { cookie: cookieB }, payload: { mode: 'auto' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/users/me/appearance', headers: { cookie: cookieB }, payload: { mode: 'dark', userId: userA.id } })).statusCode).toBe(400);
  });
});
