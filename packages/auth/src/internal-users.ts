import { withAccountEmailContext } from './account-email.js';
import type { AuthInstance } from './auth-core.js';

/**
 * 内部账号创建（计划 P01-02：首期账号由内部管理创建；D-04 起也是 closed 模式下唯一的建号方式）。
 * CLI 入口：`pnpm --filter @ancs/auth run create-user -- --email ... --password ... --name ...`
 *
 * 运营建的账号视为邮箱已验证（不发验证邮件），配置了发信后也能直接登录。
 */

export interface CreateInternalUserInput {
  email: string;
  password: string;
  name: string;
}

export interface CreatedInternalUser {
  id: string;
  email: string;
  name: string;
}

export async function createInternalUser(
  auth: AuthInstance,
  input: CreateInternalUserInput,
): Promise<CreatedInternalUser> {
  const result = await withAccountEmailContext({ suppress: true }, () => auth.api.signUpEmail({ body: input }));
  const context = await auth.$context;
  // 要求验证邮箱时，已注册的邮箱会得到一个"合成用户"（不落库）——按邮箱查真实账号，避免把它当成新建成功
  const stored = await context.internalAdapter.findUserByEmail(input.email.toLowerCase());
  if (stored === null || stored.user.id !== result.user.id) throw new Error('该邮箱已有账号（未修改原账号）');
  if (!stored.user.emailVerified) await context.internalAdapter.updateUser(stored.user.id, { emailVerified: true });
  return { id: stored.user.id, email: stored.user.email, name: stored.user.name };
}
