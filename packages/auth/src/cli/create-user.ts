#!/usr/bin/env node
/**
 * 内部账号创建 CLI（计划 P01-02）。
 *
 * 用法：
 *   pnpm --filter @ancs/auth run create-user -- --email user@example.com --password 'strong-pass-1' --name '姓名'
 *
 * 环境：
 *   DATABASE_URL 或 ANCS_TEST_DATABASE_URL（默认本地开发库）
 *   BETTER_AUTH_SECRET（必须显式提供；禁止把 Secret 写入仓库）
 */
import { createDb, DEFAULT_TEST_DATABASE_URL, redactDatabaseUrl } from '@ancs/db';
import { createAuth } from '../auth-core.js';
import { createInternalUser } from '../internal-users.js';

function parseArgs(argv: readonly string[]): { email: string; password: string; name: string } {
  // 忽略 pnpm 透传的分隔符 "--"
  const tokens = argv.filter((token) => token !== '--');
  const args = new Map<string, string>();
  let index = 0;
  while (index < tokens.length) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (flag === undefined || !flag.startsWith('--')) {
      throw new Error(`无法解析参数 "${flag ?? ''}"；用法：--email <e> --password <p> --name <n>`);
    }
    if (value === undefined) {
      throw new Error(`参数 ${flag} 缺少值`);
    }
    args.set(flag.slice(2), value);
    index += 2;
  }
  const email = args.get('email');
  const password = args.get('password');
  const name = args.get('name');
  if (!email || !password || !name) {
    throw new Error('缺少必填参数：--email、--password、--name');
  }
  if (password.length < 8) {
    throw new Error('密码至少 8 位');
  }
  return { email, password, name };
}

const input = parseArgs(process.argv.slice(2));
const secret = process.env['BETTER_AUTH_SECRET'];
if (secret === undefined || secret.length < 16) {
  console.error('BETTER_AUTH_SECRET 未设置（或过短）。请在环境变量中提供，勿写入仓库。');
  process.exit(1);
}

const databaseUrl = process.env['ANCS_TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const handle = createDb(databaseUrl);
const auth = createAuth({
  db: handle.db,
  secret,
  baseUrl: process.env['BETTER_AUTH_URL'] ?? 'http://localhost:3001',
});

try {
  const created = await createInternalUser(auth, input);
  console.log(`已创建内部账号：${created.email}（id=${created.id}，name=${created.name}）`);
  console.log(`数据库：${redactDatabaseUrl(databaseUrl)}`);
} catch (error) {
  console.error(`创建失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await handle.close();
}
