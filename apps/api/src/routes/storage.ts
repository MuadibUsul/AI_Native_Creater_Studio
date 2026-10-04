import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { errorEnvelope } from '@ancs/contracts';
import type { StorageDeps } from '../plugins/storage.js';

/**
 * 本地对象存储端点（P02-04，开发/测试驱动；生产用 S3/R2 预签名 URL）。
 *
 * 安全模型（§51"Signed URL scope"、§75）：
 * - URL 由服务端 HMAC 签发，负载含 purpose（upload/download）/对象键/工作区/资产/版本/exp；
 * - 端点只接受签名有效、用途匹配、未过期的 token（其余 403）；
 * - 上传端点写入的键**只能**是 token 内的键（无客户端可控路径）；字节数受 token.maxBytes 与
 *   本地端点上限约束（超限 413）。
 */

const tokenQuerySchema = z.object({ token: z.string().min(1) });

export function registerStorageRoutes(app: FastifyInstance, storage: StorageDeps): void {
  const local = storage.local;
  if (local === undefined) return; // 非本地驱动不暴露端点

  // 二进制请求体解析（JSON 解析器优先级更高，不受影响）
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.put('/storage/upload', { schema: { hide: true } }, async (request, reply) => {
    const parsed = tokenQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(403).send(errorEnvelope('FORBIDDEN', '无效的签名链接', request.id));
    const payload = local.verifyToken(parsed.data.token, 'upload');
    if (payload === null) {
      return reply.status(403).send(errorEnvelope('FORBIDDEN', '签名无效、用途不符或已过期', request.id));
    }
    const body = request.body;
    const bytes = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    const maxBytes = Math.min(payload.maxBytes ?? local.maxLocalUploadBytes, local.maxLocalUploadBytes);
    if (bytes.length === 0) {
      return reply.status(400).send(errorEnvelope('VALIDATION_FAILED', '空请求体', request.id));
    }
    if (bytes.length > maxBytes) {
      return reply.status(413).send(errorEnvelope('VALIDATION_FAILED', '上传超过该意图声明的字节数', request.id, { maxBytes, receivedBytes: bytes.length }));
    }
    await local.writeObject(payload.key, new Uint8Array(bytes));
    return reply.status(200).send({ ok: true, sizeBytes: bytes.length });
  });

  app.get('/storage/download', { schema: { hide: true } }, async (request, reply) => {
    const parsed = tokenQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(403).send(errorEnvelope('FORBIDDEN', '无效的签名链接', request.id));
    const payload = local.verifyToken(parsed.data.token, 'download');
    if (payload === null) {
      return reply.status(403).send(errorEnvelope('FORBIDDEN', '签名无效、用途不符或已过期', request.id));
    }
    const data = await local.readObject(payload.key);
    if (data === null) {
      return reply.status(404).send(errorEnvelope('NOT_FOUND', '对象不存在', request.id));
    }
    const filename = payload.downloadFilename ?? 'download';
    return reply
      .status(200)
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
      .send(Buffer.from(data));
  });
}
