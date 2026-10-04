import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiFailure, ERROR_CODES } from '@ancs/contracts';
import {
  authorizeWorkspace,
  resolveAuthContext,
  type AuthContext,
  type Membership,
  type SessionDeps,
  type WorkspaceCapability,
} from '@ancs/auth';

/** API 层的认证依赖（由入口注入；测试可注入独立实例）。 */
export type AuthDeps = SessionDeps;

declare module 'fastify' {
  interface FastifyInstance {
    /** 解析当前请求的认证上下文（Web Cookie 或原生 Bearer）；未认证返回 null。 */
    authResolve(request: FastifyRequest): Promise<AuthContext | null>;
    /**
     * 统一授权入口（P01-03 / REQ-31-02）：解析身份（未认证 → 401）
     * 并校验 workspace 成员资格与能力（非成员 → 404 抗枚举；能力不足 → 403）。
     */
    requireWorkspace(
      request: FastifyRequest,
      workspaceId: string,
      capability: WorkspaceCapability,
    ): Promise<{ context: AuthContext; membership: Membership }>;
  }
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  app.decorate('authResolve', (request: FastifyRequest) =>
    resolveAuthContext(deps, {
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    }),
  );

  app.decorate(
    'requireWorkspace',
    async (request: FastifyRequest, workspaceId: string, capability: WorkspaceCapability) => {
      const context = await app.authResolve(request);
      if (context === null) {
        throw new ApiFailure(ERROR_CODES.UNAUTHENTICATED, 'Not authenticated', 401);
      }
      const membership = await authorizeWorkspace(deps.db, {
        userId: context.userId,
        workspaceId,
        capability,
      });
      return { context, membership };
    },
  );
}
