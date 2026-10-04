import { createAuth, DEFAULT_NATIVE_TOKEN_CONFIG, parseNativeClients } from '@ancs/auth';
import { createDb, redactDatabaseUrl } from '@ancs/db';
import { buildServer } from './server.js';

/**
 * API 入口（P01-02 起接入认证）。
 * 配置缺失时启动失败并说明原因（与 P08-01 "错误配置启动失败并说明原因" 一致，fail-closed）。
 */

const port = Number(process.env['PORT'] ?? 3001);

const secret = process.env['BETTER_AUTH_SECRET'];
if (secret === undefined || secret.length < 16) {
  console.error('启动失败：BETTER_AUTH_SECRET 未配置或过短（≥16 字符）。禁止把 Secret 写入仓库。');
  process.exit(1);
}

const databaseUrl = process.env['DATABASE_URL'] ?? '';
if (databaseUrl === '') {
  console.error('启动失败：DATABASE_URL 未配置。');
  process.exit(1);
}

let nativeClients = null;
try {
  nativeClients = parseNativeClients(process.env['ANCS_NATIVE_CLIENTS']);
} catch (error) {
  console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const handle = createDb(databaseUrl);
const auth = createAuth({
  db: handle.db,
  secret,
  baseUrl: process.env['BETTER_AUTH_URL'] ?? `http://localhost:${String(port)}`,
});

const app = await buildServer({
  logger: true,
  auth: {
    auth,
    db: handle.db,
    tokens: {
      db: handle.db,
      config: nativeClients === null ? DEFAULT_NATIVE_TOKEN_CONFIG : { ...DEFAULT_NATIVE_TOKEN_CONFIG, nativeClients },
    },
  },
});

try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`数据库：${redactDatabaseUrl(databaseUrl)}`);
} catch (error) {
  app.log.error(error);
  await handle.close();
  process.exit(1);
}
