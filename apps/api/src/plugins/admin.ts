import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiFailure, ERROR_CODES, parsePlatformAdmins } from '@ancs/contracts';
import type { AuthContext } from '@ancs/auth';
import type { AuthDeps } from './auth.js';

/**
 * 平台管理员守卫（P08-02 / 规范 §67；REQ-67-02："不复用普通用户角色"）。
 *
 * - 管理员名单来自**部署配置**（`ANCS_PLATFORM_ADMINS` = user_id 逗号分隔；经 Secrets/环境注入），
 *   与 workspace 成员角色完全分离（普通用户即便 OWNER 也不是平台管理员）；
 * - 未认证 → 401；已认证但非管理员 → **404**（反枚举；不暴露 /admin 面存在性）；
 * - 名单为空 → 整个 admin 面不可用（404）——避免"默认开放"。
 */

export interface AdminDeps {
  /** 平台管理员 user_id（去重后的白名单） */
  userIds: readonly string[];
}

export function createAdminDeps(rawList: string | undefined): AdminDeps {
  return { userIds: parsePlatformAdmins(rawList) };
}

declare module 'fastify' {
  interface FastifyInstance {
    requirePlatformAdmin(request: FastifyRequest): Promise<{ context: AuthContext }>;
  }
}

export function registerAdminGuard(app: FastifyInstance, auth: AuthDeps, admin: AdminDeps): void {
  const allowed = new Set(admin.userIds);
  app.decorate('requirePlatformAdmin', async (request: FastifyRequest) => {
    const context = await app.authResolve(request);
    if (context === null) {
      throw new ApiFailure(ERROR_CODES.UNAUTHENTICATED, 'Not authenticated', 401);
    }
    if (!allowed.has(context.userId)) {
      // 反枚举：非管理员（含 workspace OWNER）看不到 admin 面
      throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'not found', 404);
    }
    return { context };
  });
  void auth;
}
