import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { AuthUser } from '@ancs/contracts';
import { user } from '@ancs/db';
import type { AuthInstance } from './auth-core.js';
import { verifyAccessToken, type TokenDeps } from './native-tokens.js';

/**
 * 统一会话解析（P01-02）：Web 会话 Cookie 与原生 Access Token 汇聚为同一 AuthContext。
 * P01-03（Workspace/RBAC）将在此上下文之上叠加成员资格与权限检查。
 */

export interface AuthContext {
  kind: 'web_session' | 'native_access';
  userId: string;
  /** web_session 时的会话 ID；native_access 时为 null */
  sessionId: string | null;
  /** native_access 时的客户端 ID；web_session 时为 null */
  clientId: string | null;
  expiresAt: Date;
}

export interface RequestAuthHeaders {
  cookie?: string;
  authorization?: string;
}

export interface SessionDeps {
  auth: AuthInstance;
  db: NodePgDatabase;
  tokens: TokenDeps;
}

export async function resolveAuthContext(
  deps: SessionDeps,
  headers: RequestAuthHeaders,
): Promise<AuthContext | null> {
  const requestHeaders = new Headers();
  if (headers.cookie !== undefined) requestHeaders.set('cookie', headers.cookie);
  if (headers.authorization !== undefined) requestHeaders.set('authorization', headers.authorization);

  // 1) Web 会话 Cookie（Better Auth 权威）
  const betterSession = await deps.auth.api.getSession({ headers: requestHeaders });
  if (betterSession?.session && betterSession.user) {
    return {
      kind: 'web_session',
      userId: betterSession.user.id,
      sessionId: betterSession.session.id,
      clientId: null,
      expiresAt: betterSession.session.expiresAt,
    };
  }

  // 2) 原生 Access Token（Bearer）
  const authorization = headers.authorization;
  if (authorization !== undefined && authorization.startsWith('Bearer ')) {
    const token = authorization.slice('Bearer '.length).trim();
    if (token.length > 0) {
      const info = await verifyAccessToken(deps.tokens, token);
      if (info) {
        return {
          kind: 'native_access',
          userId: info.userId,
          sessionId: null,
          clientId: info.clientId,
          expiresAt: info.expiresAt,
        };
      }
    }
  }

  return null;
}

export async function findUserById(db: NodePgDatabase, userId: string): Promise<AuthUser | null> {
  const rows = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, emailVerified: row.emailVerified };
}
