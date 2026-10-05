import type { FastifyInstance } from 'fastify';

/**
 * 原始请求体保留（P09-02；与 P03-06 的 webhook 验签共用同一机制）。
 *
 * 验签必须针对**原始字节**（重新序列化 JSON 会改变签名）。本插件注册一次全局 JSON 解析器：
 * 解析行为不变（仍产出 parsed body），同时把原始字符串挂在请求对象上（键：ancsRawBody）。
 * `ensureRawBodyParser` 幂等（多路由模块共享；已注册则跳过）。
 */

export const RAW_BODY_KEY = 'ancsRawBody';

export function ensureRawBodyParser(app: FastifyInstance): void {
  if (app.hasContentTypeParser('application/json')) return;
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as unknown as Record<string, string>)[RAW_BODY_KEY] = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
}

export function rawBodyOf(request: unknown, fallbackBody: unknown): string {
  const stored = (request as Record<string, string>)[RAW_BODY_KEY];
  if (typeof stored === 'string') return stored;
  return JSON.stringify(fallbackBody ?? {});
}
