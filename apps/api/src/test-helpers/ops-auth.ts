import { createHmac, randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { adminPrincipals, adminRoleGrants } from '@ancs/db';
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
  await db.insert(adminPrincipals).values({ id: principalId, userId, environment: 'TEST' });
  await db.insert(adminRoleGrants).values({ id: `oprg_${randomUUID()}`, principalId, role: 'PRODUCTION_OPERATOR' });
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
