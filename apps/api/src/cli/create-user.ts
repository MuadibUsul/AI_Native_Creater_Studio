import { createAuth, createInternalUser } from '@ancs/auth';
import { createUserCliEnvSchema, formatEnvFailure, validateEnv } from '@ancs/contracts';
import { createDb } from '@ancs/db';

/**
 * 建账号（部署后建首个所有者；公开注册上线前也用它给团队成员建号）：
 *
 *   ANCS_NEW_USER_EMAIL=owner@example.com ANCS_NEW_USER_PASSWORD=… pnpm user:create
 *
 * 密码只从环境变量读（不走命令行参数），不打印；与 API 同一把 BETTER_AUTH_SECRET。邮箱已存在时失败、不改原账号。
 * 退出码：0 = 已建；1 = 配置错误或建号失败。
 */

const envResult = validateEnv(createUserCliEnvSchema, process.env);
if (!envResult.ok || envResult.value === null) {
  console.error(formatEnvFailure('user:create', envResult.issues));
  process.exit(1);
}
const config = envResult.value;
const handle = createDb(config.DATABASE_URL);
try {
  const auth = createAuth({ db: handle.db, secret: config.BETTER_AUTH_SECRET, baseUrl: config.BETTER_AUTH_URL ?? 'http://localhost:3001' });
  const user = await createInternalUser(auth, { email: config.ANCS_NEW_USER_EMAIL, password: config.ANCS_NEW_USER_PASSWORD, name: config.ANCS_NEW_USER_NAME });
  console.log(`[user:create] 已建账号 ${user.email}（${user.id}）`);
  await handle.close();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[user:create] 建号失败：${message.replaceAll(config.ANCS_NEW_USER_PASSWORD, '***')}`);
  await handle.close().catch(() => undefined);
  process.exit(1);
}
