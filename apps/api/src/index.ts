import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { createAuth, DEFAULT_NATIVE_TOKEN_CONFIG, parseNativeClients } from '@ancs/auth';
import { createDb, redactDatabaseUrl } from '@ancs/db';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';
import { createStorageDeps } from './plugins/storage.js';
import { credentialDepsFromEnv } from './plugins/credentials.js';
import { parseWebhookVerifiers } from './plugins/webhooks.js';
import { createHttpResultFetcher } from './plugins/result-fetcher.js';

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

/**
 * 对象存储（P02-04）：默认本地驱动（开发）；生产接 S3/R2 预签名直传（真实凭据阶段，P08/P12）。
 * 本地驱动的端点签名密钥独立于会话密钥：未显式配置时由 BETTER_AUTH_SECRET 派生（作用域隔离）。
 */
const storageDriver = process.env['ANCS_STORAGE_DRIVER'] ?? 'local';
let storageDeps;
if (storageDriver === 'local') {
  const storageSecret = process.env['ANCS_STORAGE_SECRET'] ?? createHmac('sha256', secret).update('storage-local-v1').digest('hex');
  const publicBaseUrl = process.env['ANCS_STORAGE_PUBLIC_BASE_URL'] ?? process.env['BETTER_AUTH_URL'] ?? `http://localhost:${String(port)}`;
  storageDeps = createStorageDeps(
    new LocalObjectStorage({
      rootDir: resolve(process.env['ANCS_STORAGE_LOCAL_DIR'] ?? '.storage'),
      publicBaseUrl,
      signingSecret: storageSecret,
    }),
  );
} else {
  console.error(`启动失败：未知的 ANCS_STORAGE_DRIVER=${storageDriver}（当前仅支持 local；S3/R2 适配器在真实凭据阶段接入）。`);
  process.exit(1);
}

const credentialDeps = credentialDepsFromEnv();

const webhookDeps = {
  verifiers: parseWebhookVerifiers(process.env['ANCS_WEBHOOK_SECRETS']),
  resultFetcher: createHttpResultFetcher(),
  ...(storageDeps.adapter !== undefined ? { storage: storageDeps.adapter } : {}),
};

const app = await buildServer({
  logger: true,
  credentials: credentialDeps,
  webhooks: webhookDeps,
  auth: {
    auth,
    db: handle.db,
    tokens: {
      db: handle.db,
      config: nativeClients === null ? DEFAULT_NATIVE_TOKEN_CONFIG : { ...DEFAULT_NATIVE_TOKEN_CONFIG, nativeClients },
    },
  },
  storage: storageDeps,
});

try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`数据库：${redactDatabaseUrl(databaseUrl)}`);
} catch (error) {
  app.log.error(error);
  await handle.close();
  process.exit(1);
}
