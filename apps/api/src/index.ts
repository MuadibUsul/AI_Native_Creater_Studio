import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { createAuth, DEFAULT_NATIVE_TOKEN_CONFIG, parseNativeClients } from '@ancs/auth';
import { apiEnvSchema, formatEnvFailure, validateEnv } from '@ancs/contracts';
import { createDb, redactDatabaseUrl } from '@ancs/db';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';
import { createStorageDeps } from './plugins/storage.js';
import { credentialDepsFromEnv } from './plugins/credentials.js';
import { parseWebhookVerifiers } from './plugins/webhooks.js';
import { createHttpResultFetcher } from './plugins/result-fetcher.js';
import { createHttpArticleFetcher } from './plugins/article-fetcher.js';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { MockTtsAdapter } from '@ancs/providers-mock-tts';

/**
 * API 入口（P01-02 起接入认证）。
 * 配置缺失时启动失败并说明原因（与 P08-01 "错误配置启动失败并说明原因" 一致，fail-closed）。
 */

// P08-01：启动前一次性收集**全部**配置问题（fail-closed；未实现的驱动显式失败，不静默降级）
const envResult = validateEnv(apiEnvSchema, process.env);
if (!envResult.ok || envResult.value === null) {
  console.error(formatEnvFailure('api', envResult.issues));
  process.exit(1);
}
const config = envResult.value;
const port = config.PORT;
const secret = config.BETTER_AUTH_SECRET;
const databaseUrl = config.DATABASE_URL;

let nativeClients = null;
try {
  nativeClients = parseNativeClients(config.ANCS_NATIVE_CLIENTS);
} catch (error) {
  console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const handle = createDb(databaseUrl);
const auth = createAuth({
  db: handle.db,
  secret,
  baseUrl: config.BETTER_AUTH_URL ?? `http://localhost:${String(port)}`,
});

/**
 * 对象存储（P02-04）：默认本地驱动（开发）；生产接 S3/R2 预签名直传（真实凭据阶段，P08/P12）。
 * 本地驱动的端点签名密钥独立于会话密钥：未显式配置时由 BETTER_AUTH_SECRET 派生（作用域隔离）。
 */
const storageDriver = config.ANCS_STORAGE_DRIVER;
let storageDeps;
if (storageDriver === 'local') {
  const storageSecret = config.ANCS_STORAGE_SECRET ?? createHmac('sha256', secret).update('storage-local-v1').digest('hex');
  const publicBaseUrl = config.ANCS_STORAGE_PUBLIC_BASE_URL ?? config.BETTER_AUTH_URL ?? `http://localhost:${String(port)}`;
  storageDeps = createStorageDeps(
    new LocalObjectStorage({
      rootDir: resolve(config.ANCS_STORAGE_LOCAL_DIR ?? '.storage'),
      publicBaseUrl,
      signingSecret: storageSecret,
    }),
  );
} else {
  console.error(`启动失败：未知的 ANCS_STORAGE_DRIVER=${storageDriver}（当前仅支持 local；S3/R2 适配器在真实凭据阶段接入）。`);
  process.exit(1);
}

const credentialDeps = credentialDepsFromEnv();

/**
 * LLM 适配器（P04-03）：无真实凭据时使用**明确 Mock**（§76-03：不得伪造"真实生成成功"）。
 * ANCS_LLM_DRIVER=mock（默认）| 未来真实驱动名（未知名 → 启动失败，fail-closed）。
 */
const llmDriver = config.ANCS_LLM_DRIVER;
let llmDeps: { llm?: import('@ancs/contracts').LlmAdapter };
if (llmDriver === 'mock') {
  console.warn('[api] LLM 驱动 = mock（无真实凭据）：叙事生成为 Mock 输出，不得视为真实模型结果。');
  llmDeps = { llm: new MockLlmAdapter() };
} else {
  console.error(`启动失败：未知的 ANCS_LLM_DRIVER=${llmDriver}（当前仅支持 mock；真实适配器随 P06-01 接入）。`);
  process.exit(1);
}

/**
 * TTS 适配器（P06-03）：无真实凭据时使用**明确 Mock**（§76-03）。
 * ANCS_TTS_DRIVER=mock（默认）| 未来真实驱动名（未知名 → 启动失败，fail-closed）。
 */
const ttsDriver = config.ANCS_TTS_DRIVER;
let audioDeps: { tts?: import('@ancs/contracts').AudioSynthesisAdapter; aligner?: import('@ancs/contracts').AlignmentProvider };
if (ttsDriver === 'mock') {
  console.warn('[api] TTS 驱动 = mock（无真实凭据）：Master Narration 为确定性 Mock 音频（带词级时间戳），不得视为真实语音。');
  audioDeps = { tts: new MockTtsAdapter() };
} else {
  console.error(`启动失败：未知的 ANCS_TTS_DRIVER=${ttsDriver}（当前仅支持 mock；真实适配器随 P06-02 接入）。`);
  process.exit(1);
}

const webhookDeps = {
  verifiers: parseWebhookVerifiers(config.ANCS_WEBHOOK_SECRETS),
  resultFetcher: createHttpResultFetcher(),
  ...(storageDeps.adapter !== undefined ? { storage: storageDeps.adapter } : {}),
};

const app = await buildServer({
  logger: true,
  credentials: credentialDeps,
  webhooks: webhookDeps,
  content: { articleFetcher: createHttpArticleFetcher(), ...llmDeps },
  audio: audioDeps,
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
