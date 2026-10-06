import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import swagger from '@fastify/swagger';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { API_PREFIX, requestIdSchema } from '@ancs/contracts';
import { createBuiltInRegistry, type ExtensionRegistry } from '@ancs/extensions';
import { registerErrorHandler } from './error-handler.js';
import { registerAuth, type AuthDeps } from './plugins/auth.js';
import { registerClientContext } from './plugins/client-context.js';
import { registerIdempotency } from './plugins/idempotency.js';
import { registerAiEditRoutes } from './routes/ai-edit.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerCapabilityRoutes } from './routes/capabilities.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerContentRoutes } from './routes/content.js';
import { registerCreatorIdentityRoutes } from './routes/creator-identities.js';
import { registerCredentialRoutes } from './routes/credentials.js';
import { registerDirectorRoutes } from './routes/director.js';
import { registerEventRoutes } from './routes/events.js';
import { registerEvidenceRoutes } from './routes/evidence.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerNarrationAudioRoutes } from './routes/narration-audio.js';
import { registerMixdownRoutes } from './routes/mixdown.js';
import { registerSceneGenerationRoutes } from './routes/scene-generation.js';
import { registerCustomMotionRoutes } from './routes/custom-motion.js';
import { registerApprovalRoutes } from './routes/approval.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAdminSecurityRoutes } from './routes/admin-security.js';
import { registerVoiceCloneRoutes } from './routes/voice-clones.js';
import { registerStockRoutes } from './routes/stock.js';
import { registerOutputEnhancementRoutes } from './routes/output-enhancements.js';
import { registerSearchExportRoutes } from './routes/search-exports.js';
import { registerContentCoreRoutes } from './routes/content-core.js';
import { registerAtomRoutes } from './routes/atoms.js';
import { registerPackRoutes } from './routes/packs.js';
import { registerLineageRoutes } from './routes/lineage.js';
import { createShortsAnalyzerPlugin } from '@ancs/domain';
import { registerPlanRoutes } from './routes/plans.js';
import { registerPaymentRoutes, type PaymentRouteDeps } from './routes/payments.js';
import { createAdminDeps, registerAdminGuard, type AdminDeps } from './plugins/admin.js';
import { registerMetrics } from './plugins/metrics.js';
import { registerAdminMetricsRoutes } from './routes/admin-metrics.js';
import { registerNativeFallbackRoutes } from './routes/native-fallback.js';
import { registerRenderRoutes } from './routes/renders.js';
import { registerNarrativeRoutes } from './routes/narrative.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerWebhookRoutes } from './routes/results.js';
import { registerSpeechPlanRoutes } from './routes/speech-plan.js';
import { registerSpeechProfileRoutes } from './routes/speech-profiles.js';
import { registerStorageRoutes } from './routes/storage.js';
import { registerVisualGrammarRoutes } from './routes/visual-grammar.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import type { StorageDeps } from './plugins/storage.js';
import type { CredentialDeps } from './plugins/credentials.js';
import type { WebhookRouteDeps } from './routes/results.js';

export interface BuildServerOptions {
  /** 日志开关或 Fastify/pino 日志选项（对象形式会强制并入 Secret 脱敏 redact——§75） */
  logger?: FastifyServerOptions['logger'];
  /**
   * 认证依赖（P01-02）。未提供时不注册认证路由（用于无数据库的单元测试）；
   * 生产与集成测试必须提供。
   */
  auth?: AuthDeps;
  /**
   * 扩展注册表（P01-06）。默认内置注册表（V1 无内置 Pack，诚实空清单）；
   * 测试可注入带测试 Pack 的注册表。
   */
  extensions?: ExtensionRegistry;
  /**
   * 对象存储（P02-04）。未提供时资产路由不注册（无存储能力的进程）；集成测试注入本地驱动。
   */
  storage?: StorageDeps;
  /** 平台管理员（P08-02；缺省=空名单——admin 面不可用，反枚举 404） */
  admin?: AdminDeps;
  /** 订阅收款（P09-02；缺省=未配置——相关端点 501 fail-closed） */
  payments?: PaymentRouteDeps;
  /**
   * 凭据保险库（P03-04）。未提供时连接/路由端点不注册（无凭据能力的进程，fail-closed）。
   */
  credentials?: CredentialDeps;
  /**
   * Webhook 验签与回收依赖（P03-06）。未提供时 Webhook 端点不注册（无验签能力即不可信，fail-closed）。
   */
  webhooks?: WebhookRouteDeps;
  /**
   * 内容输入依赖（P04-01）与叙事生成依赖（P04-03）：
   * articleFetcher（URL 归一化）、llm（结构化生成；无凭据时可注入 Mock，§76-03）。
   */
  content?: {
    articleFetcher?: import('@ancs/contracts').ArticleFetcher;
    llm?: import('@ancs/contracts').LlmAdapter;
    /** 文档解析（P10-01；未提供 → 文档导入端点 501 fail-closed） */
    documentParser?: import('@ancs/contracts').DocumentParser;
  };
  /** Pack 插件（P11-03；默认装配官方 Shorts Analyzer；analyze 经四道闸门 + 受限上下文） */
  packs?: { plugins?: import('@ancs/contracts').PackPlugin[] };
  /** 素材搜索（P10-03；未提供 → 搜索/获取 501 fail-closed） */
  media?: { stockSearch?: import('@ancs/contracts').AssetSearchProvider };
  /** 声音克隆（P10-02；未提供 → 提交/刷新/删除 501 fail-closed） */
  voiceClone?: { provider?: import('@ancs/contracts').VoiceCloneProvider };
  /** 语音合成/对齐（P06-03；Mock 默认，真实适配器随凭据接入） */
  audio?: { tts?: import('@ancs/contracts').AudioSynthesisAdapter; aligner?: import('@ancs/contracts').AlignmentProvider; storage?: import('@ancs/contracts').ObjectStorageAdapter };
}

/**
 * 构建 Fastify 实例（独立于 Next.js 的权威业务 API，规范 §29.2）。
 * OpenAPI 文档由同一份 Zod 契约生成（REQ-29-04），暴露于 GET /openapi.json。
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  // P08-03：请求级指标（onRequest/onResponse 钩子；导出面 /api/v1/admin/metrics）

  const app = Fastify({
    // P08-03：结构化日志 + **Secret 脱敏**（§75/§44：日志严禁记录 Secret；请求头凭据一律 redact）
    logger:
      options.logger === true || (typeof options.logger === 'object' && options.logger !== null)
        ? {
            ...(typeof options.logger === 'object' && options.logger !== null ? options.logger : {}),
            redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], censor: '[REDACTED]' },
          }
        : (options.logger ?? false),
    // 请求追踪（§33）：客户端可提供合法 X-Request-Id，否则服务端生成
    genReqId: (raw) => {
      const provided = raw.headers['x-request-id'];
      if (typeof provided === 'string' && requestIdSchema.safeParse(provided).success) return provided;
      return `req_${randomUUID()}`;
    },
  });
  registerMetrics(app);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);
  registerClientContext(app);

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'ANCS API',
        description: 'Creator Video OS 后端 API。对外统一前缀 /api/v1（计划 DEC-01）。',
        version: '0.0.0',
      },
    },
    transform: jsonSchemaTransform,
  });

  const authDeps = options.auth;
  const storageDeps = options.storage;
  const credentialDeps = options.credentials;
  const webhookDeps = options.webhooks;
  const contentDeps = options.content;
  const packPlugins = options.packs?.plugins ?? [createShortsAnalyzerPlugin()];
  const audioDeps = options.audio;
  if (authDeps !== undefined) {
    registerAuth(app, authDeps);
    await app.register(
      async (instance) => {
        registerIdempotency(instance, authDeps);
        registerAuthRoutes(instance, authDeps);
        registerWorkspaceRoutes(instance, authDeps);
        registerChannelRoutes(instance, authDeps);
        registerCreatorIdentityRoutes(instance, authDeps);
        registerSpeechProfileRoutes(instance, authDeps);
        registerProjectRoutes(instance, authDeps);
        registerEventRoutes(instance, authDeps);
        registerJobRoutes(instance, authDeps);
        registerCatalogRoutes(instance, authDeps);
        registerBillingRoutes(instance, authDeps);
        if (credentialDeps !== undefined) {
          registerCredentialRoutes(instance, authDeps, credentialDeps);
        }
        if (webhookDeps !== undefined) {
          registerWebhookRoutes(instance, authDeps, webhookDeps);
        }
        registerContentRoutes(instance, authDeps, contentDeps?.articleFetcher, {
          ...(contentDeps?.documentParser !== undefined ? { parser: contentDeps.documentParser } : {}),
          ...(storageDeps?.scanner !== undefined ? { scanner: storageDeps.scanner } : {}),
          ...(storageDeps?.auditSink !== undefined ? { auditSink: storageDeps.auditSink } : {}),
        });
        registerEvidenceRoutes(instance, authDeps);
        registerNarrativeRoutes(instance, authDeps, contentDeps?.llm);
        registerStockRoutes(instance, authDeps, options.media ?? {}, storageDeps?.adapter);
        registerOutputEnhancementRoutes(instance, authDeps, storageDeps?.adapter);
        registerSearchExportRoutes(instance, authDeps, storageDeps?.adapter);
        registerContentCoreRoutes(instance, authDeps);
        registerAtomRoutes(instance, authDeps);
        registerPackRoutes(instance, authDeps, options.packs ?? {}, packPlugins);
        registerLineageRoutes(instance, authDeps);
        registerVoiceCloneRoutes(instance, authDeps, {
          ...(options.voiceClone ?? {}),
          ...(storageDeps?.adapter !== undefined ? { storage: storageDeps.adapter } : {}),
        });
        registerVisualGrammarRoutes(instance, authDeps);
        registerDirectorRoutes(instance, authDeps);
        registerAiEditRoutes(instance, authDeps, contentDeps?.llm);
        registerMixdownRoutes(instance, authDeps);
        registerNativeFallbackRoutes(instance, authDeps);
        registerRenderRoutes(instance, authDeps);
        registerSceneGenerationRoutes(instance, authDeps, credentialDeps);
        registerCustomMotionRoutes(instance, authDeps);
        registerNarrationAudioRoutes(instance, authDeps, {
          ...(audioDeps ?? {}),
          ...(storageDeps?.adapter !== undefined ? { storage: storageDeps.adapter } : {}),
        });
        registerSpeechPlanRoutes(instance, authDeps);
        if (storageDeps !== undefined) {
          registerAssetRoutes(instance, authDeps, storageDeps);
          registerApprovalRoutes(instance, authDeps, storageDeps);
        }
        registerAdminGuard(instance, authDeps, options.admin ?? createAdminDeps(process.env['ANCS_PLATFORM_ADMINS']));
        registerAdminRoutes(instance, authDeps, options.admin ?? createAdminDeps(process.env['ANCS_PLATFORM_ADMINS']));
        registerAdminSecurityRoutes(instance, authDeps);
        registerAdminMetricsRoutes(instance, authDeps);
        registerPlanRoutes(instance, authDeps);
        registerPaymentRoutes(instance, authDeps, options.payments ?? {});
      },
      { prefix: API_PREFIX },
    );
  }

  const extensions = options.extensions ?? createBuiltInRegistry();

  await app.register(
    async (instance) => {
      registerHealthRoutes(instance);
      registerCapabilityRoutes(instance, { extensions });
      if (storageDeps !== undefined) {
        registerStorageRoutes(instance, storageDeps);
      }
    },
    { prefix: API_PREFIX },
  );

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  return app;
}
