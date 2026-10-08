import { createHmac, randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { OPS_PERMISSION_POLICY_HASH, OPS_PERMISSION_POLICY_VERSION } from '@ancs/auth';
import { adminPermissionPolicyVersions, adminPrincipals, adminRoleGrants, adminRoleScopes } from '@ancs/db';
import type { AncsClient } from '@ancs/sdk';
import { createAdminDeps } from '../plugins/admin.js';

/** Test-only fixture. The server still performs the real TOTP challenge and ops cookie issuance. */
export function testOpsDeps(db: NodePgDatabase) {
  return createAdminDeps({
    db,
    environment: 'TEST',
    fingerprintKey: 'isolated-test-fingerprint-key', // secrets:check-ignore：测试专用假密钥
    policy: { idleSeconds: 900, absoluteSeconds: 28800, reauthSeconds: 300 },
  });
}

export async function provisionTestOpsPrincipal(db: NodePgDatabase, userId: string): Promise<void> {
  const principalId = `oppr_${randomUUID()}`;
  const roleGrantId = `oprg_${randomUUID()}`;
  await db.insert(adminPrincipals).values({ id: principalId, userId, environment: 'TEST' });
  await db.insert(adminRoleGrants).values({ id: roleGrantId, principalId, role: 'PRODUCTION_OPERATOR' });
  // An explicit TEST fixture scope. Migration 0053 deliberately grants no scope to existing rows.
  await db.insert(adminRoleScopes).values({ id: `opsc_${randomUUID()}`, roleGrantId, scopeKind: 'PLATFORM' });
  // TEST only: explicit fixture publication. Migration never enables any environment by default.
  const active = (await db.select({ version: adminPermissionPolicyVersions.version, rulesHash: adminPermissionPolicyVersions.rulesHash })
    .from(adminPermissionPolicyVersions).where(and(
      eq(adminPermissionPolicyVersions.environment, 'TEST'), eq(adminPermissionPolicyVersions.status, 'ACTIVE'),
    )).limit(1))[0];
  if (active === undefined) {
    await db.insert(adminPermissionPolicyVersions).values({
      id: `oppv_${randomUUID()}`, environment: 'TEST', version: OPS_PERMISSION_POLICY_VERSION,
      rulesHash: OPS_PERMISSION_POLICY_HASH, status: 'ACTIVE', publishedAt: new Date(), publishedByPrincipalId: principalId,
    });
  } else if (active.version !== OPS_PERMISSION_POLICY_VERSION || active.rulesHash !== OPS_PERMISSION_POLICY_HASH) {
    throw new Error('TEST permission policy differs from the compiled rule matrix');
  }
}

function decodeBase32(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const letter of value.toUpperCase().replace(/=+$/, '')) {
    const digit = alphabet.indexOf(letter);
    if (digit < 0) throw new Error('Invalid test TOTP secret');
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function testTotpCode(totpUri: string, now = Date.now()): string {
  const secret = new URL(totpUri).searchParams.get('secret');
  if (!secret) throw new Error('Missing test TOTP secret');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, '0');
}

export async function enrollTestOpsTotp(client: AncsClient, email: string, password: string): Promise<string> {
  const signedIn = await client.auth.signIn({ email, password });
  if (!('user' in signedIn)) throw new Error('Unexpected MFA challenge during test enrollment');
  const enrollment = await client.ops.enrollTotp({ password });
  const confirmed = await client.auth.verifyTotp({ code: testTotpCode(enrollment.totpUri) });
  if (!('user' in confirmed)) throw new Error('Test enrollment confirmation failed');
  await client.auth.signOut();
  return enrollment.totpUri;
}

export async function signInTestOpsClient(client: AncsClient, email: string, password: string, totpUri: string): Promise<void> {
  const challenge = await client.auth.signIn({ email, password });
  if (!('twoFactorRequired' in challenge)) throw new Error('Test ops login did not require MFA');
  const verified = await client.auth.verifyTotp({ code: testTotpCode(totpUri) });
  if (!('user' in verified)) throw new Error('Test ops login did not complete');
  const ops = await client.ops.session();
  if (ops.environment !== 'TEST') throw new Error('Test ops environment mismatch');
}
