import { createServer } from 'node:http';
import { createDb } from '@ancs/db';
import { checkProviderInventory, crossCheckRealtimeEnv, formatEnvFailure, originOf, realtimeEnvSchema, validateEnv, type EnvIssue, type ProviderInventoryEntry } from '@ancs/contracts';
import { createDeepgramLiveRecognizer } from './deepgram-live.js';
import { createRealtimeGateway } from './gateway.js';

/**
 * Realtime Gateway 进程入口（V6-2）。启动前一次性校验配置（fail-closed）；
 * 没配置流式识别时照常启动，但每个连接都明确回"语音识别未配置"（不回退 Mock）。
 * 部署：反向代理把 /realtime/v1/voice 的 WebSocket 升级转到本进程（见 docs/ops/deployment-runbook.md）。
 */

const envResult = validateEnv(realtimeEnvSchema, process.env);
const issues: EnvIssue[] = envResult.ok ? [] : envResult.issues;
if (envResult.ok && envResult.value !== null) issues.push(...crossCheckRealtimeEnv(envResult.value));
const inventory: ProviderInventoryEntry[] = envResult.value?.ANCS_REALTIME_ASR_DRIVER === 'deepgram'
  ? [{ capability: 'realtime_asr', driver: 'deepgram', implementation: 'REAL' }] : [];
if (envResult.value !== null) issues.push(...checkProviderInventory(envResult.value, inventory));
if (issues.length > 0 || envResult.value === null) {
  console.error(formatEnvFailure('realtime', issues));
  process.exit(1);
}
const config = envResult.value;

const allowedOrigins = config.ANCS_ALLOWED_ORIGINS !== undefined
  ? config.ANCS_ALLOWED_ORIGINS.split(',').map((item) => item.trim()).filter((item) => item !== '')
  : [
    ...(config.BETTER_AUTH_URL === undefined ? [] : [originOf(config.BETTER_AUTH_URL) ?? '']),
    ...(config.NODE_ENV === 'production' ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000']),
  ].filter((item) => item !== '');

const handle = createDb(config.DATABASE_URL);
const recognizer = config.ANCS_REALTIME_ASR_DRIVER === 'deepgram' && config.DEEPGRAM_API_KEY !== undefined
  ? createDeepgramLiveRecognizer({
    apiKey: config.DEEPGRAM_API_KEY,
    models: {
      ...(config.ANCS_DEEPGRAM_LIVE_MODEL_ZH === undefined ? {} : { 'zh-CN': config.ANCS_DEEPGRAM_LIVE_MODEL_ZH }),
      ...(config.ANCS_DEEPGRAM_LIVE_MODEL_EN === undefined ? {} : { en: config.ANCS_DEEPGRAM_LIVE_MODEL_EN }),
    },
  })
  : undefined;

const gateway = createRealtimeGateway({
  deps: { db: handle.db, voiceSessionSecret: config.ANCS_VOICE_SESSION_SECRET },
  ...(recognizer === undefined ? {} : { recognizer }),
  allowedOrigins,
  log: (event, detail) => console.log(JSON.stringify({ service: 'realtime', event, ...detail })),
});
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, asr: recognizer === undefined ? 'NOT_CONFIGURED' : recognizer.providerId }));
    return;
  }
  response.writeHead(404);
  response.end();
});
gateway.attach(server, { exclusive: true });
server.listen(config.PORT, () => console.log(JSON.stringify({ service: 'realtime', event: 'listening', port: config.PORT, asr: recognizer?.providerId ?? 'NOT_CONFIGURED' })));

const shutdown = () => {
  void gateway.close().then(() => server.close(() => void handle.close().then(() => process.exit(0))));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
