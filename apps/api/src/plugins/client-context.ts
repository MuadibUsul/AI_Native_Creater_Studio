import type { FastifyInstance } from 'fastify';
import { clientTypeSchema } from '@ancs/contracts';

/**
 * 客户端标头与请求追踪（规范 §29.3、§33 / P01-05）：
 * - 解析 X-Client-Type（web|desktop|ios|android，非法值视为 unknown）与 X-Client-Version；
 * - 回显 x-request-id（客户端提供合法 X-Request-Id 时即为该值，见 buildServer 的 genReqId）；
 * - 回显 x-ancs-client-type 便于支持与可观测性（P08-03）。
 */

declare module 'fastify' {
  interface FastifyRequest {
    clientType: string;
    clientVersion: string | null;
  }
}

export function registerClientContext(app: FastifyInstance): void {
  app.decorateRequest('clientType', 'unknown');
  app.decorateRequest('clientVersion', null);

  app.addHook('onRequest', async (request, reply) => {
    const rawType = request.headers['x-client-type'];
    if (typeof rawType === 'string') {
      const parsed = clientTypeSchema.safeParse(rawType);
      request.clientType = parsed.success ? parsed.data : 'unknown';
    }

    const rawVersion = request.headers['x-client-version'];
    if (typeof rawVersion === 'string' && rawVersion.length > 0 && rawVersion.length <= 64) {
      request.clientVersion = rawVersion;
    }

    reply.header('x-request-id', String(request.id));
    reply.header('x-ancs-client-type', request.clientType);
  });
}
