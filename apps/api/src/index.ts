import { createHmac } from 'node:crypto';
import { createAuth, DEFAULT_NATIVE_TOKEN_CONFIG, parseNativeClients } from '@ancs/auth';
import { apiEnvSchema, checkProviderInventory, crossCheckApiEnv, formatEnvFailure, originOf, resolveAllowedOrigins, resolveLegacyPipeline, validateEnv, type EnvIssue, type ProviderInventoryEntry } from '@ancs/contracts';
import { createDb, redactDatabaseUrl } from '@ancs/db';
import { LocalObjectStorage, localStorageOptionsFromEnv } from '@ancs/providers-storage-local';
import { S3ObjectStorage, s3StorageOptionsFromEnv } from '@ancs/providers-storage-s3';
import { buildServer } from './server.js';
import { createShutdown } from './shutdown.js';
import { DEFAULT_RATE_LIMITS } from './plugins/edge.js';
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
import { configureDeploymentPolicy, createMockDistributionProvider, createPlatformStubProviders, recordAudit } from '@ancs/domain';
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
// 部署策略一次性注入领域层（领域层不读 process.env；非法值已在上面 fail-closed）
configureDeploymentPolicy({ defaultPlan: config.ANCS_DEFAULT_PLAN });
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
 * 对象存储（P02-04）：local = 单机磁盘（字节经 API 端点转发，签名密钥与 Worker、清理 CLI 共用 `localStorageOptionsFromEnv`）；
 * s3 = S3 兼容对象存储（浏览器预签名直传直下，API 不转发字节、不注册本地端点；多机部署用它）。
 * 上传扫描：启发式扫描器检查经 API 端点写入的字节；s3 直传不经过 API，完成上传时仍做内容嗅探与 SHA-256 校验。
 */
const storageDriver = config.ANCS_STORAGE_DRIVER;
if (storageDriver === 's3') console.info(`[api] 对象存储 = s3（桶 ${String(config.ANCS_S3_BUCKET)}${config.ANCS_S3_ENDPOINT === undefined ? '' : `，端点 ${originOf(config.ANCS_S3_ENDPOINT) ?? '已配置'}`}）`);
const s3Storage = storageDriver === 's3' ? new S3ObjectStorage(s3StorageOptionsFromEnv(config)) : null;
const storageDeps = createStorageDeps(
  s3Storage ?? new LocalObjectStorage(localStorageOptionsFromEnv(config)),
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

// s3：启动时探一次桶（HeadBucket），桶名、区域或凭据错误立即启动失败，不等到用户上传才暴露
if (s3Storage !== null) {
  try {
    await s3Storage.checkBucket();
  } catch (error) {
    const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    const status = failure.$metadata?.httpStatusCode;
    console.error(`启动失败：对象存储不可用（${failure.name ?? 'Error'}${status === undefined ? '' : `，HTTP ${String(status)}`}）——检查 ANCS_S3_BUCKET、ANCS_S3_REGION、ANCS_S3_ENDPOINT 与访问密钥。`);
    process.exit(1);
  }
}

const credentialDeps = credentialDepsFromEnv();

/**
 * 旧 V4 流水线（脚本 / 分镜 / 旧编辑器的叙事生成、旧配音、声音克隆、素材搜索、Mock 分发）：目前只有测试替身。
 * 生产缺省 off（不装配，相关端点由领域层 501 fail-closed，界面隐藏旧入口）；开发缺省 mock。
 * V6 共看片室、文章、自主制作走工作流与 Provider Gateway，不依赖这些替身。
 */
const legacyPipeline = resolveLegacyPipeline(config);
const legacyMock = legacyPipeline === 'mock';
if (!legacyMock) console.info('[api] 旧 V4 流水线 = off：脚本 / 分镜 / 旧配音 / 声音克隆 / 素材搜索 / Mock 分发未装配（端点 501），共看片室不受影响。');

/**
 * 声音克隆（P10-02）：V1 使用**明确 Mock**（无真实训练能力——同其他 Mock 驱动）。
 * 真实 Provider（ElevenLabs/HeyGen 等）为契约同构 seam 替换（BLOCKED：凭据）。
 */
if (legacyMock) console.warn('[api] 声音克隆驱动 = mock（无真实训练/验证能力）：仅限开发/测试，不得视为真实克隆结果。');
const voiceCloneDeps = legacyMock ? { provider: new MockVoiceCloneProvider() } : {};

/**
 * 素材搜索（P10-03）：Mock（确定性结果，含无许可/缺署名两类不可用样本——证明守卫）。
 * Runway：**fail-closed 骨架**（未实现；接入需凭据 + 端点核验——不以未核验实现冒充真实接入）。
 */
if (legacyMock) console.warn('[api] 素材搜索驱动 = mock（确定性素材；不代表真实素材库）：仅限开发/测试。');
const mediaDeps = legacyMock ? { stockSearch: new MockAssetSearchProvider() } : {};
void RunwayGenerationAdapter;

/**
 * LLM 适配器（P04-03）：无真实凭据时使用**明确 Mock**（§76-03：不得伪造"真实生成成功"）。
 * ANCS_LLM_DRIVER=mock（默认）| 未来真实驱动名（未知名 → 启动失败，fail-closed）。
 */
const llmDriver = config.ANCS_LLM_DRIVER;
let llmDeps: { llm?: import('@ancs/contracts').LlmAdapter } = {};
if (!legacyMock) {
  // 旧流水线未装配：不注入叙事 LLM（V6 导演的模型经 Provider Gateway 配置）
} else if (llmDriver === 'mock') {
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
let audioDeps: { tts?: import('@ancs/contracts').AudioSynthesisAdapter; aligner?: import('@ancs/contracts').AlignmentProvider } = {};
if (!legacyMock) {
  // 旧流水线未装配：不注入旧配音（V6 旁白经 Provider Gateway）
} else if (ttsDriver === 'mock') {
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

/**
 * 分发 Provider（P13-01）：Mock（脚本化发布，无真实平台账户，仅旧流水线 mock 时装配）+ 平台占位（只报能力矩阵，不伪造发布成功）。
 */
const distributionProviders = legacyMock ? [createMockDistributionProvider(), ...createPlatformStubProviders()] : createPlatformStubProviders();

/**
 * 装配清单与生产守卫（V5-M3，§11.3）：生产进程装配 MOCK/SCRIPTED 必须显式 ANCS_ALLOW_MOCK_PROVIDERS=1，
 * 否则启动失败；清单经 /capabilities 报告（客户端据此显示 Mock 标识）。
 */
const providerInventory: ProviderInventoryEntry[] = [
  ...(legacyMock
    ? ([
        { capability: 'llm', driver: llmDriver, implementation: 'MOCK' },
        { capability: 'tts', driver: ttsDriver, implementation: 'MOCK' },
        { capability: 'voice_clone', driver: 'mock', implementation: 'MOCK' },
        { capability: 'stock_search', driver: 'mock', implementation: 'MOCK' },
        { capability: 'distribution', driver: 'mock', implementation: 'MOCK' },
      ] as const)
    : []),
  ...(paymentsDriver === 'mock' ? [{ capability: 'payments', driver: 'mock', implementation: 'MOCK' as const }] : []),
];
const inventoryIssues = checkProviderInventory(config, providerInventory);
if (inventoryIssues.length > 0) {
  console.error(formatEnvFailure('api', inventoryIssues));
  process.exit(1);
}

const webhookDeps = {
  verifiers: parseWebhookVerifiers(config.ANCS_WEBHOOK_SECRETS),
  resultFetcher: createHttpResultFetcher(),
  ...(storageDeps.adapter !== undefined ? { storage: storageDeps.adapter } : {}),
};

// 优雅退出：排空 → 停止接新请求并等进行中的请求 → 释放连接池（超时强制退出）
const lifecycle = createShutdown({
  drainMs: config.ANCS_SHUTDOWN_DRAIN_SECONDS * 1000,
  timeoutMs: config.ANCS_SHUTDOWN_TIMEOUT_SECONDS * 1000,
  closeServer: () => app.close(),
  closeResources: () => handle.close(),
  exit: (code) => process.exit(code),
  log: (message) => app.log.info(message),
});

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
  admin: createAdminDeps(config.ANCS_OPS_ENVIRONMENT === undefined ? undefined : {
    db: handle.db,
    environment: config.ANCS_OPS_ENVIRONMENT,
    fingerprintKey: createHmac('sha256', secret).update('ops-fingerprint-v1').digest('hex'),
    policy: {
      idleSeconds: config.ANCS_OPS_IDLE_SECONDS,
      absoluteSeconds: config.ANCS_OPS_ABSOLUTE_SECONDS,
      reauthSeconds: config.ANCS_OPS_REAUTH_SECONDS,
    },
  }),
  payments: paymentDeps,
  voice: config.ANCS_VOICE_SESSION_SECRET === undefined ? {} : { sessionSecret: config.ANCS_VOICE_SESSION_SECRET },
  distribution: { providers: distributionProviders },
  providerInventory,
  legacyPipeline,
  // 就绪探针：数据库能查询、没有在退出排空（生产部署编排用；/health 只看存活）
  readiness: {
    checks: { database: async () => (await handle.pool.query('select 1')).rowCount === 1 },
    draining: () => lifecycle.isDraining(),
  },
  // V5-M4 Edge：CORS/Origin 白名单、按 IP 限流（可信代理跳数决定客户端 IP）、生产 HSTS
  edge: {
    allowedOrigins: resolveAllowedOrigins(config),
    rateLimits: config.ANCS_RATE_LIMIT === 'off' ? false : DEFAULT_RATE_LIMITS,
    hsts: config.NODE_ENV === 'production',
    trustProxyHops: config.ANCS_TRUST_PROXY_HOPS,
  },
});

process.on('SIGTERM', () => { void lifecycle.shutdown('SIGTERM'); });
process.on('SIGINT', () => { void lifecycle.shutdown('SIGINT'); });

try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`数据库：${redactDatabaseUrl(databaseUrl)}`);
} catch (error) {
  app.log.error(error);
  await handle.close();
  process.exit(1);
}
