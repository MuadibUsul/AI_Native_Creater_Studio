import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { API_PREFIX, requestIdSchema } from '@ancs/contracts';
import { createBuiltInRegistry, type ExtensionRegistry } from '@ancs/extensions';
import { registerErrorHandler } from './error-handler.js';
import { registerAuth, type AuthDeps } from './plugins/auth.js';
import { registerClientContext } from './plugins/client-context.js';
import { registerIdempotency } from './plugins/idempotency.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerCapabilityRoutes } from './routes/capabilities.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerContentRoutes } from './routes/content.js';
import { registerCreatorIdentityRoutes } from './routes/creator-identities.js';
import { registerCredentialRoutes } from './routes/credentials.js';
import { registerEventRoutes } from './routes/events.js';
import { registerEvidenceRoutes } from './routes/evidence.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerWebhookRoutes } from './routes/results.js';
import { registerSpeechProfileRoutes } from './routes/speech-profiles.js';
import { registerStorageRoutes } from './routes/storage.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import type { StorageDeps } from './plugins/storage.js';
import type { CredentialDeps } from './plugins/credentials.js';
import type { WebhookRouteDeps } from './routes/results.js';

export interface BuildServerOptions {
  logger?: boolean;
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
  /**
   * 凭据保险库（P03-04）。未提供时连接/路由端点不注册（无凭据能力的进程，fail-closed）。
   */
  credentials?: CredentialDeps;
  /**
   * Webhook 验签与回收依赖（P03-06）。未提供时 Webhook 端点不注册（无验签能力即不可信，fail-closed）。
   */
  webhooks?: WebhookRouteDeps;
  /** 内容输入依赖（P04-01）：文章抓取器（URL 归一化所需） */
  content?: { articleFetcher?: import('@ancs/contracts').ArticleFetcher };
}

/**
 * 构建 Fastify 实例（独立于 Next.js 的权威业务 API，规范 §29.2）。
 * OpenAPI 文档由同一份 Zod 契约生成（REQ-29-04），暴露于 GET /openapi.json。
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // 请求追踪（§33）：客户端可提供合法 X-Request-Id，否则服务端生成
    genReqId: (raw) => {
      const provided = raw.headers['x-request-id'];
      if (typeof provided === 'string' && requestIdSchema.safeParse(provided).success) return provided;
      return `req_${randomUUID()}`;
    },
  });

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
        registerContentRoutes(instance, authDeps, contentDeps?.articleFetcher);
        registerEvidenceRoutes(instance, authDeps);
        if (storageDeps !== undefined) {
          registerAssetRoutes(instance, authDeps, storageDeps);
        }
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
