import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { ERROR_CODES, type ErrorCode, type TokenResponse } from '@ancs/contracts';
import { authAccessTokens, authAuthorizationCodes, authRefreshTokens } from '@ancs/db';

/**
 * 原生客户端令牌服务（P01-02 / 规范 §30）：
 * Authorization Code + PKCE（S256）→ 短生命周期 Access Token + 轮换式 Refresh Token。
 *
 * 安全不变量：
 * - 数据库只存 sha256 哈希；明文令牌只在返回给客户端的那一刻存在；
 * - 授权码单次使用（条件更新防并发双花）；
 * - Refresh 单次使用 + 轮换；重放（已使用令牌再次出现）→ 撤销整个 family；
 * - 撤销以数据库为权威（服务端可即时失效）。
 */

/** 当前所有认证失败的 HTTP 状态均为 400（OAuth 授权类错误惯例）；扩展时同步路由的 response 声明。 */
export type AuthFailureStatus = 400;

export class AuthFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpStatus: AuthFailureStatus = 400,
  ) {
    super(message);
    this.name = 'AuthFailure';
  }
}

export const nativeClientSchema = z.object({
  clientId: z.string().min(1).max(100),
  redirectUris: z.array(z.string().min(1).max(500)).min(1),
});

export type NativeClient = z.infer<typeof nativeClientSchema>;

/** 解析 ANCS_NATIVE_CLIENTS 环境变量（JSON 数组）；非法配置抛错（fail-closed）。 */
export function parseNativeClients(raw: string | undefined): NativeClient[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('ANCS_NATIVE_CLIENTS 不是合法 JSON', { cause: error });
  }
  return z.array(nativeClientSchema).min(1).parse(parsed);
}

export interface NativeTokenConfig {
  accessTokenTtlMs: number;
  refreshTokenTtlMs: number;
  authorizationCodeTtlMs: number;
  nativeClients: NativeClient[];
}

/** 默认值：Access 15 分钟 / Refresh 30 天 / 授权码 5 分钟（可被部署配置覆盖，DEC-14 精神）。 */
export const DEFAULT_NATIVE_TOKEN_CONFIG: NativeTokenConfig = {
  accessTokenTtlMs: 15 * 60 * 1000,
  refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
  authorizationCodeTtlMs: 5 * 60 * 1000,
  nativeClients: [
    { clientId: 'ancs-desktop', redirectUris: ['ancs://auth/callback'] },
    { clientId: 'ancs-mobile', redirectUris: ['ancs://auth/callback'] },
  ],
};

export interface TokenDeps {
  db: NodePgDatabase;
  config: NativeTokenConfig;
}

export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const newToken = (prefix: string): string => `${prefix}${randomBytes(32).toString('base64url')}`;

export const base64UrlSha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('base64url');

export function findRegisteredClient(config: NativeTokenConfig, clientId: string): NativeClient | null {
  return config.nativeClients.find((client) => client.clientId === clientId) ?? null;
}

/** 校验客户端与 redirectUri 注册关系；失败抛 INVALID_CLIENT（授权端点的错误回调依赖此校验）。 */
export function assertRegisteredClient(config: NativeTokenConfig, clientId: string, redirectUri: string): NativeClient {
  const client = findRegisteredClient(config, clientId);
  if (!client) {
    throw new AuthFailure(ERROR_CODES.INVALID_CLIENT, `client "${clientId}" is not registered`);
  }
  if (!client.redirectUris.includes(redirectUri)) {
    throw new AuthFailure(ERROR_CODES.INVALID_CLIENT, `redirectUri is not allowed for client "${clientId}"`);
  }
  return client;
}

export interface AuthorizationCodeInput {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
}

/** 创建授权码（哈希入库；返回明文，仅通过授权端点重定向交付一次）。 */
export async function createAuthorizationCode(
  deps: TokenDeps,
  input: AuthorizationCodeInput,
): Promise<string> {
  const code = newToken('ancs_ac_');
  await deps.db.insert(authAuthorizationCodes).values({
    id: `ac_${randomUUID()}`,
    codeHash: sha256Hex(code),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: 'S256',
    userId: input.userId,
    expiresAt: new Date(Date.now() + deps.config.authorizationCodeTtlMs),
  });
  return code;
}

async function issueTokenPair(
  deps: TokenDeps,
  input: { userId: string; clientId: string; familyId: string },
): Promise<TokenResponse> {
  const accessToken = newToken('ancs_at_');
  const refreshToken = newToken('ancs_rt_');
  const now = Date.now();

  await deps.db.insert(authAccessTokens).values({
    id: `at_${randomUUID()}`,
    tokenHash: sha256Hex(accessToken),
    familyId: input.familyId,
    clientId: input.clientId,
    userId: input.userId,
    expiresAt: new Date(now + deps.config.accessTokenTtlMs),
  });
  await deps.db.insert(authRefreshTokens).values({
    id: `rt_${randomUUID()}`,
    tokenHash: sha256Hex(refreshToken),
    familyId: input.familyId,
    clientId: input.clientId,
    userId: input.userId,
    expiresAt: new Date(now + deps.config.refreshTokenTtlMs),
  });

  return {
    tokenType: 'Bearer',
    accessToken,
    expiresIn: Math.floor(deps.config.accessTokenTtlMs / 1000),
    refreshToken,
    refreshExpiresIn: Math.floor(deps.config.refreshTokenTtlMs / 1000),
  };
}

/** 撤销整个轮换家族（重放检测、退出、管理员撤销共用）。 */
export async function revokeFamily(deps: TokenDeps, familyId: string): Promise<void> {
  const now = new Date();
  await deps.db
    .update(authRefreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(authRefreshTokens.familyId, familyId), isNull(authRefreshTokens.revokedAt)));
  await deps.db
    .update(authAccessTokens)
    .set({ revokedAt: now })
    .where(and(eq(authAccessTokens.familyId, familyId), isNull(authAccessTokens.revokedAt)));
}

/** 授权码兑换（PKCE S256 校验 + 单次使用 + 并发双花防护）。 */
export async function exchangeAuthorizationCode(
  deps: TokenDeps,
  input: { code: string; codeVerifier: string; clientId: string; redirectUri?: string },
): Promise<TokenResponse> {
  const rows = await deps.db
    .select()
    .from(authAuthorizationCodes)
    .where(eq(authAuthorizationCodes.codeHash, sha256Hex(input.code)))
    .limit(1);
  const row = rows[0];

  if (!row) throw new AuthFailure(ERROR_CODES.INVALID_GRANT, 'authorization code is invalid');
  if (row.usedAt !== null) throw new AuthFailure(ERROR_CODES.INVALID_GRANT, 'authorization code is already used');
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new AuthFailure(ERROR_CODES.INVALID_GRANT, 'authorization code has expired');
  }
  if (row.clientId !== input.clientId) {
    throw new AuthFailure(ERROR_CODES.INVALID_GRANT, 'authorization code was issued to a different client');
  }
  if (input.redirectUri !== undefined && input.redirectUri !== row.redirectUri) {
    throw new AuthFailure(ERROR_CODES.INVALID_GRANT, 'redirectUri does not match the authorization request');
  }
  if (base64UrlSha256(input.codeVerifier) !== row.codeChallenge) {
    throw new AuthFailure(ERROR_CODES.INVALID_GRANT, 'PKCE verification failed');
  }

  // 单次使用：条件更新（并发双花时只有一个事务能命中未使用行）
  const claimed = await deps.db
    .update(authAuthorizationCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(authAuthorizationCodes.id, row.id), isNull(authAuthorizationCodes.usedAt)))
    .returning({ id: authAuthorizationCodes.id });
  if (claimed.length === 0) {
    throw new AuthFailure(ERROR_CODES.INVALID_GRANT, 'authorization code is already used');
  }

  return issueTokenPair(deps, {
    userId: row.userId,
    clientId: row.clientId,
    familyId: `fam_${randomUUID()}`,
  });
}

/** 刷新轮换：成功返回新令牌对；重放（旧令牌再次出现）撤销整个家族。 */
export async function refreshTokenPair(
  deps: TokenDeps,
  input: { refreshToken: string; clientId: string },
): Promise<TokenResponse> {
  const rows = await deps.db
    .select()
    .from(authRefreshTokens)
    .where(eq(authRefreshTokens.tokenHash, sha256Hex(input.refreshToken)))
    .limit(1);
  const row = rows[0];

  if (!row || row.revokedAt !== null || row.expiresAt.getTime() <= Date.now() || row.clientId !== input.clientId) {
    throw new AuthFailure(ERROR_CODES.INVALID_GRANT, 'refresh token is invalid');
  }

  if (row.usedAt !== null) {
    // 重放检测：已使用的 refresh 再次出现 → 家族整体撤销（可能已泄露）
    await revokeFamily(deps, row.familyId);
    throw new AuthFailure(ERROR_CODES.INVALID_GRANT, 'refresh token replay detected; token family revoked');
  }

  const claimed = await deps.db
    .update(authRefreshTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(authRefreshTokens.id, row.id), isNull(authRefreshTokens.usedAt), isNull(authRefreshTokens.revokedAt)))
    .returning({ id: authRefreshTokens.id });
  if (claimed.length === 0) {
    await revokeFamily(deps, row.familyId);
    throw new AuthFailure(ERROR_CODES.INVALID_GRANT, 'refresh token replay detected; token family revoked');
  }

  return issueTokenPair(deps, { userId: row.userId, clientId: row.clientId, familyId: row.familyId });
}

/** 撤销（退出原生会话）；幂等，不泄漏令牌是否存在。 */
export async function revokeRefreshToken(
  deps: TokenDeps,
  input: { refreshToken: string; clientId: string },
): Promise<void> {
  const rows = await deps.db
    .select()
    .from(authRefreshTokens)
    .where(eq(authRefreshTokens.tokenHash, sha256Hex(input.refreshToken)))
    .limit(1);
  const row = rows[0];
  if (!row || row.clientId !== input.clientId) return;
  await revokeFamily(deps, row.familyId);
}

export interface NativeAccessTokenInfo {
  userId: string;
  clientId: string;
  familyId: string;
  expiresAt: Date;
}

/** Access Token 验证（未撤销且未过期才有效）。 */
export async function verifyAccessToken(
  deps: TokenDeps,
  accessToken: string,
): Promise<NativeAccessTokenInfo | null> {
  const rows = await deps.db
    .select()
    .from(authAccessTokens)
    .where(eq(authAccessTokens.tokenHash, sha256Hex(accessToken)))
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt !== null || row.expiresAt.getTime() <= Date.now()) return null;
  return { userId: row.userId, clientId: row.clientId, familyId: row.familyId, expiresAt: row.expiresAt };
}
