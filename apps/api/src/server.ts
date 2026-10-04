import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { API_PREFIX } from '@ancs/contracts';
import { registerErrorHandler } from './error-handler.js';
import { registerAuth, type AuthDeps } from './plugins/auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerCreatorIdentityRoutes } from './routes/creator-identities.js';
import { registerEchoRoutes } from './routes/echo.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSpeechProfileRoutes } from './routes/speech-profiles.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

export interface BuildServerOptions {
  logger?: boolean;
  /**
   * 认证依赖（P01-02）。未提供时不注册认证路由（用于无数据库的单元测试）；
   * 生产与集成测试必须提供。
   */
  auth?: AuthDeps;
}

/**
 * 构建 Fastify 实例（独立于 Next.js 的权威业务 API，规范 §29.2）。
 * OpenAPI 文档由同一份 Zod 契约生成（REQ-29-04），暴露于 GET /openapi.json。
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    genReqId: () => `req_${randomUUID()}`,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);

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
  if (authDeps !== undefined) {
    registerAuth(app, authDeps);
    await app.register(
      async (instance) => {
        registerAuthRoutes(instance, authDeps);
        registerWorkspaceRoutes(instance, authDeps);
        registerChannelRoutes(instance, authDeps);
        registerCreatorIdentityRoutes(instance, authDeps);
        registerSpeechProfileRoutes(instance, authDeps);
      },
      { prefix: API_PREFIX },
    );
  }

  await app.register(
    async (instance) => {
      registerHealthRoutes(instance);
      registerEchoRoutes(instance);
    },
    { prefix: API_PREFIX },
  );

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  return app;
}
