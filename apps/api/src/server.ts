import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { API_PREFIX } from '@ancs/contracts';
import { registerErrorHandler } from './error-handler.js';
import { registerEchoRoutes } from './routes/echo.js';
import { registerHealthRoutes } from './routes/health.js';

export interface BuildServerOptions {
  logger?: boolean;
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
