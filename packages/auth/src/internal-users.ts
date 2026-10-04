import type { AuthInstance } from './auth-core.js';

/**
 * 内部账号创建（计划 P01-02：首期账号由内部管理创建，不开放公开注册）。
 * CLI 入口：`pnpm --filter @ancs/auth run create-user -- --email ... --password ... --name ...`
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
  const result = await auth.api.signUpEmail({ body: input });
  return { id: result.user.id, email: result.user.email, name: result.user.name };
}
