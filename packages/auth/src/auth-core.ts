import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { account, session, user, verification } from '@ancs/db';

/**
 * Better Auth 集成（计划 §3.1 / 规范 §30）。
 *
 * 职责边界：
 * - Better Auth 负责：用户记录、密码凭据、Web 会话（HttpOnly Cookie、滑动续期）；
 * - 原生客户端的 Access/Refresh Token 由本包 native-tokens 层实现（服务端权威、哈希存储）。
 */

export interface AuthCoreOptions {
  db: NodePgDatabase;
  /** 会话与 Cookie 签名密钥（生产经 KMS/Secrets 注入，禁止入库） */
  secret: string;
  baseUrl: string;
  /** Web 会话有效期（秒），默认 30 天 */
  sessionTtlSeconds?: number;
  /** 会话滑动续期间隔（秒），默认 1 天 */
  sessionUpdateAgeSeconds?: number;
}

export function createAuth(options: AuthCoreOptions) {
  return betterAuth({
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      schema: { user, session, account, verification },
    }),
    secret: options.secret,
    baseURL: options.baseUrl,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    session: {
      expiresIn: options.sessionTtlSeconds ?? 60 * 60 * 24 * 30,
      updateAge: options.sessionUpdateAgeSeconds ?? 60 * 60 * 24,
    },
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;
