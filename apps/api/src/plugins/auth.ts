import type { FastifyInstance, FastifyRequest } from 'fastify';
import { resolveAuthContext, type AuthContext, type SessionDeps } from '@ancs/auth';

/** API 层的认证依赖（由入口注入；测试可注入独立实例）。 */
export type AuthDeps = SessionDeps;

declare module 'fastify' {
  interface FastifyInstance {
    /** 解析当前请求的认证上下文（Web Cookie 或原生 Bearer）；未认证返回 null。 */
    authResolve(request: FastifyRequest): Promise<AuthContext | null>;
  }
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  app.decorate('authResolve', (request: FastifyRequest) =>
    resolveAuthContext(deps, {
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    }),
  );
}
