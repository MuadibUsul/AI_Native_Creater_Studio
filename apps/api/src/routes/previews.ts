import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiFailure, ERROR_CODES, errorEnvelopeSchema, opaqueIdSchema, requestSequencePreviewSchema, sequencePreviewSchema } from '@ancs/contracts';
import { getSequencePreview, latestSequencePreview, requestSequencePreview, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';
import type { StorageDeps } from '../plugins/storage.js';

/**
 * V6-1d：低清预览（改哪里渲染哪里）。
 * - POST /workspaces/:id/projects/:projectId/sequences/:sequenceId/previews：当前版本或提案（试改）的预览（202，Worker 渲染；同计划去重）；
 * - GET  /workspaces/:id/previews/:previewId：状态、短期签名播放地址、浏览器叠加的字幕、分段复用统计；
 * - GET  /workspaces/:id/projects/:projectId/sequences/:sequenceId/previews/latest：当前版本最近一次预览。
 * 预览是可再生的非权威产物：读权限即可请求；`previews` 归入昂贵端点限流（服务端编码计算）。
 */

const workspaceParams = z.object({ id: opaqueIdSchema });
const sequenceParams = workspaceParams.extend({ projectId: opaqueIdSchema, sequenceId: opaqueIdSchema });
const previewParams = workspaceParams.extend({ previewId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerPreviewRoutes(app: FastifyInstance, deps: AuthDeps & { storage?: StorageDeps }): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db, ...(deps.storage === undefined ? {} : { storage: deps.storage.adapter }) };

  typed.post('/workspaces/:id/projects/:projectId/sequences/:sequenceId/previews', {
    schema: { tags: ['projects'], summary: '请求低清预览（当前版本或提案试改；按时间窗缓存复用）', params: sequenceParams, body: requestSequencePreviewSchema, response: { 202: sequencePreviewSchema, ...ERROR_RESPONSES } },
  }, async (request, reply) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:read');
    const preview = await requestSequencePreview(domain, {
      workspaceId: request.params.id,
      projectId: request.params.projectId,
      sequenceId: request.params.sequenceId,
      request: request.body,
      createdBy: context.userId,
    });
    return reply.code(202).send(preview);
  });

  typed.get('/workspaces/:id/previews/:previewId', {
    schema: { tags: ['projects'], summary: '预览状态与播放地址', params: previewParams, response: { 200: sequencePreviewSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    return getSequencePreview(domain, { workspaceId: request.params.id, previewId: request.params.previewId });
  });

  typed.get('/workspaces/:id/projects/:projectId/sequences/:sequenceId/previews/latest', {
    schema: { tags: ['projects'], summary: '当前版本最近一次预览', params: sequenceParams, response: { 200: sequencePreviewSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    const latest = await latestSequencePreview(domain, { workspaceId: request.params.id, sequenceId: request.params.sequenceId });
    if (latest === null || latest.projectId !== request.params.projectId) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'no preview yet', 404);
    return latest;
  });
}
