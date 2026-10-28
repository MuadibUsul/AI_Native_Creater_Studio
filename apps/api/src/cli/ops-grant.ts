import { grantOpsAccess, OpsGrantError } from '@ancs/auth';
import { formatEnvFailure, opsGrantCliEnvSchema, validateEnv } from '@ancs/contracts';
import { createDb } from '@ancs/db';

/**
 * 运营后台授权（I-13）：给已有账号开通运营后台（/admin）。部署后给首个运营者用，之后加人、加角色也用它。
 *
 *   ANCS_OPS_GRANT_EMAIL=owner@example.com pnpm --filter @ancs/api run ops:grant
 *   （可选）ANCS_OPS_GRANT_ROLES=PRODUCTION_OPERATOR,AUDITOR   ANCS_OPS_GRANT_WORKSPACES=ws_…,ws_…
 *
 * 与 API 同一个 ANCS_OPS_ENVIRONMENT；账号要先用 user:create 建好。可重复执行（已有的不重复写）。
 * 首次进入 /admin 时照常输入密码、绑定验证器（TOTP）——本命令不跳过 MFA，也不打印任何密钥。
 * 退出码：0 = 已授权（或本来就有）；1 = 配置错误或授权被拒（原因写在 stderr）。
 */

const envResult = validateEnv(opsGrantCliEnvSchema, process.env);
if (!envResult.ok || envResult.value === null) {
  console.error(formatEnvFailure('ops:grant', envResult.issues));
  process.exit(1);
}
const config = envResult.value;
const handle = createDb(config.DATABASE_URL);
try {
  const result = await grantOpsAccess(handle.db, {
    email: config.ANCS_OPS_GRANT_EMAIL,
    environment: config.ANCS_OPS_ENVIRONMENT,
    roles: config.ANCS_OPS_GRANT_ROLES,
    workspaceIds: config.ANCS_OPS_GRANT_WORKSPACES,
  });
  const policyText = { PUBLISHED: '已发布', ALREADY_ACTIVE: '已是当前版本', REPLACED: '已替换旧版本' }[result.policy];
  console.log(`[ops:grant] ${config.ANCS_OPS_GRANT_EMAIL} @ ${config.ANCS_OPS_ENVIRONMENT}：${result.principalCreated ? '新建运营身份' : '已有运营身份'} ${result.principalId}`);
  console.log(`[ops:grant] 新增角色：${result.rolesAdded.join(', ') || '无'}；已有角色：${result.rolesKept.join(', ') || '无'}；新增范围 ${String(result.scopesAdded)} 条（工作区：${config.ANCS_OPS_GRANT_WORKSPACES.join(', ') || '无，只有平台级'}）`);
  console.log(`[ops:grant] 权限策略 ${result.policyVersion}：${policyText}`);
  console.log('[ops:grant] 下一步：用这个账号登录后打开 /admin，按提示绑定验证器（首次）后进入运营后台。');
  await handle.close();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ops:grant] ${error instanceof OpsGrantError ? '未授权' : '失败'}：${message}`);
  await handle.close().catch(() => undefined);
  process.exit(1);
}
