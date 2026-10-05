import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { createAuth, DEFAULT_NATIVE_TOKEN_CONFIG, parseNativeClients } from '@ancs/auth';
import { apiEnvSchema, crossCheckApiEnv, formatEnvFailure, validateEnv, type EnvIssue } from '@ancs/contracts';
import { createDb, redactDatabaseUrl } from '@ancs/db';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';
import { createStorageDeps } from './plugins/storage.js';
import { createAdminDeps } from './plugins/admin.js';
import { MockPaymentProvider } from '@ancs/providers-mock-payments';
import { credentialDepsFromEnv } from './plugins/credentials.js';
import { parseWebhookVerifiers } from './plugins/webhooks.js';
import { createHttpResultFetcher } from './plugins/result-fetcher.js';
import { createHttpArticleFetcher } from './plugins/article-fetcher.js';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { MockTtsAdapter, MockVoiceCloneProvider } from '@ancs/providers-mock-tts';
import { MockAssetSearchProvider, RunwayGenerationAdapter } from '@ancs/providers-mock-provider';
import { HeuristicMalwareScanner } from '@ancs/providers-malware-heuristic';
import { recordAudit } from '@ancs/domain';
import { LocalDocumentParser } from '@ancs/providers-document-extract';

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
// P09-06 商业上线门：live 模式的跨字段条件（fail-closed；台账见 docs/ops/launch-gate.md）
const envIssues: EnvIssue[] = [...crossCheckApiEnv(envResult.value)];
if (envIssues.length > 0) {
  console.error(formatEnvFailure('api', envIssues));
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
    {
      // 上传扫描（§43.3）：启发式为确定性默认（非杀毒引擎）；真实引擎接入 = 替换 seam（BLOCKED：部署决策）
      scanner: new HeuristicMalwareScanner(),
      auditSink: async (entry) => {
        await recordAudit({ db: handle.db }, {
          actorKind: 'SYSTEM',
          action: entry.action,
          targetType: 'storage_object',
          targetId: entry.key,
          workspaceId: entry.workspaceId,
          details: { filename: entry.filename, contentType: entry.contentType, findings: entry.findings, scanner: entry.scanner },
        });
      },
    },
  );
} else {
  console.error(`启动失败：未知的 ANCS_STORAGE_DRIVER=${storageDriver}（当前仅支持 local；S3/R2 适配器在真实凭据阶段接入）。`);
  process.exit(1);
}

const credentialDeps = credentialDepsFromEnv();

/**
 * 声音克隆（P10-02）：V1 使用**明确 Mock**（无真实训练能力——同其他 Mock 驱动）。
 * 真实 Provider（ElevenLabs/HeyGen 等）为契约同构 seam 替换（BLOCKED：凭据）。
 */
console.warn('[api] 声音克隆驱动 = mock（无真实训练/验证能力）：仅限开发/测试，不得视为真实克隆结果。');
const voiceCloneDeps = { provider: new MockVoiceCloneProvider() };

/**
 * 素材搜索（P10-03）：Mock（确定性结果，含无许可/缺署名两类不可用样本——证明守卫）。
 * Runway：**fail-closed 骨架**（未实现；接入需凭据 + 端点核验——不以未核验实现冒充真实接入）。
 */
console.warn('[api] 素材搜索驱动 = mock（确定性素材；不代表真实素材库）：仅限开发/测试。');
const mediaDeps = { stockSearch: new MockAssetSearchProvider() };
void RunwayGenerationAdapter;

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

/**
 * 收款适配器（P09-02）：缺省 = 未配置（收款端点 501 fail-closed）；
 * mock = 脚本化（仅开发/测试——**无真实扣款/对账能力**，启动时警告）；stripe = 真实渠道（需凭据，未接入 → 启动失败）。
 */
let paymentDeps: { provider?: import('@ancs/contracts').PaymentProvider; successUrlBase?: string } = {};
const paymentsDriver = config.ANCS_PAYMENTS_DRIVER;
if (paymentsDriver === 'mock') {
  if (config.ANCS_PAYMENTS_MOCK_SECRET === undefined) {
    console.error('启动失败：ANCS_PAYMENTS_DRIVER=mock 时必须配置 ANCS_PAYMENTS_MOCK_SECRET（≥16）。');
    process.exit(1);
  }
  console.warn('[api] 收款驱动 = mock（脚本化，无真实扣款）：仅限开发/测试，不得用于生产收款。');
  paymentDeps = { provider: new MockPaymentProvider({ signingSecret: config.ANCS_PAYMENTS_MOCK_SECRET }), successUrlBase: config.BETTER_AUTH_URL };
} else if (paymentsDriver === 'stripe') {
  console.error('启动失败：ANCS_PAYMENTS_DRIVER=stripe 尚未接入（真实渠道适配器随商业上线阶段；无 key 绝不伪成功）。');
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
  content: {
    articleFetcher: createHttpArticleFetcher(),
    ...llmDeps,
    // 文档导入（P10-01）：本地解析器（Markdown/DOCX/PDF/EML；扫描件不伪造成功）
    documentParser: new LocalDocumentParser(),
  },
  audio: audioDeps,
  voiceClone: voiceCloneDeps,
  media: mediaDeps,
  auth: {
    auth,
    db: handle.db,
    tokens: {
      db: handle.db,
      config: nativeClients === null ? DEFAULT_NATIVE_TOKEN_CONFIG : { ...DEFAULT_NATIVE_TOKEN_CONFIG, nativeClients },
    },
  },
  storage: storageDeps,
  admin: createAdminDeps(config.ANCS_PLATFORM_ADMINS),
  payments: paymentDeps,
});

try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`数据库：${redactDatabaseUrl(databaseUrl)}`);
} catch (error) {
  app.log.error(error);
  await handle.close();
  process.exit(1);
}
