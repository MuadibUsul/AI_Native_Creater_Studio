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

/**
 * HTTP 单段字节范围（RFC 9110 §14）：浏览器播放视频时靠它拖动进度（没有范围支持时跳转会回到开头）。
 * 返回 null = 没有或不支持的范围（多段、非 bytes 单位、格式错误）→ 按整份 200 返回；
 * 'unsatisfiable' = 起点超出对象大小 → 416。
 */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return null;
  if (first === '') {
    // 后缀范围：最后 N 字节
    const suffix = Number(last);
    if (suffix === 0) return 'unsatisfiable';
    return size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return 'unsatisfiable';
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return null;
  return { start, end };
}

export function registerStorageRoutes(app: FastifyInstance, storage: StorageDeps): void {
  const local = storage.local;
  if (local === undefined) return; // 非本地驱动不暴露端点

  // 二进制请求体解析（JSON 解析器优先级更高，不受影响）
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: local.maxLocalUploadBytes }, (_request, body, done) => {
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
    // 上传扫描（§43.3）：检出 → **拒绝落盘** + 审计（upload.malware_rejected）
    if (storage.scanner !== undefined) {
      const declared = typeof request.headers['x-ancs-filename'] === 'string' ? request.headers['x-ancs-filename'] : payload.downloadFilename ?? payload.key.split('/').pop() ?? 'upload.bin';
      const contentType = typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : 'application/octet-stream';
      const scan = await storage.scanner.scan({ bytes: new Uint8Array(bytes), filename: declared, contentType });
      if (scan.status === 'INFECTED') {
        if (storage.auditSink !== undefined) {
          await storage.auditSink({
            action: 'upload.malware_rejected',
            workspaceId: payload.workspaceId,
            key: payload.key,
            filename: declared.slice(0, 200),
            contentType: contentType.slice(0, 100),
            findings: scan.findings.map((finding) => ({ code: finding.code, message: finding.message })),
            scanner: scan.scanner,
          });
        }
        return reply.status(422).send(
          errorEnvelope('VALIDATION_FAILED', `上传被拒绝：${String(scan.findings.length)} 项安全检出（内容未落盘）`, request.id, {
            reason: 'MALWARE_DETECTED',
            scanner: scan.scanner,
            findings: scan.findings,
          }),
        );
      }
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
    reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
      .header('accept-ranges', 'bytes');
    const range = parseByteRange(typeof request.headers.range === 'string' ? request.headers.range : undefined, data.byteLength);
    if (range === 'unsatisfiable') {
      return reply.status(416).header('content-range', `bytes */${String(data.byteLength)}`).send();
    }
    if (range !== null) {
      return reply
        .status(206)
        .header('content-range', `bytes ${String(range.start)}-${String(range.end)}/${String(data.byteLength)}`)
        .send(Buffer.from(data.subarray(range.start, range.end + 1)));
    }
    return reply.status(200).send(Buffer.from(data));
  });
}
