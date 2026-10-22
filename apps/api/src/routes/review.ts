import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  agentTurnSchema,
  applyReviewRequestSchema,
  applyReviewResponseSchema,
  createReviewNoteRequestSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  reviewNoteSchema,
  reviewStateSchema,
  updateReviewNoteRequestSchema,
} from '@ancs/contracts';
import {
  addReviewNote,
  applyReview,
  deleteReviewNote,
  getReviewState,
  listReviewNoteTurns,
  updateReviewNote,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * V6-4 批注式审片（手机网页与桌面共用）。
 * - GET    /workspaces/:id/projects/:projectId/review：最近一轮审片 + 批注（轮次状态由执行轮与提案派生）；
 * - POST   /workspaces/:id/projects/:projectId/review/notes：标记一处问题（没有进行中的一轮 → 在当前版本开新一轮）；
 * - PATCH  /workspaces/:id/review-notes/:noteId：改文字、确定方案、不改了/重新打开；DELETE 删除；
 * - GET    /workspaces/:id/review-notes/:noteId/turns：这条批注的讨论（讨论本身走 agent-sessions/:id/turns + reviewNoteId）；
 * - POST   /workspaces/:id/projects/:projectId/review/apply：全部执行（202：一个 AI 轮次 → 一个试改提案）。
 * 鉴权：读 project:read，写 project:write；跨工作区 → 404。执行进行中或试改待采用时批注锁定（409）。
 */

const workspaceParams = z.object({ id: opaqueIdSchema });
const projectParams = workspaceParams.extend({ projectId: opaqueIdSchema });
const noteParams = workspaceParams.extend({ noteId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 402: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerReviewRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.get('/workspaces/:id/projects/:projectId/review', {
    schema: { tags: ['review'], summary: '审片：最近一轮与批注', params: projectParams, response: { 200: reviewStateSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    return getReviewState(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
  });

  typed.post('/workspaces/:id/projects/:projectId/review/notes', {
    schema: { tags: ['review'], summary: '标记一处问题（定位 + 一句话）', params: projectParams, body: createReviewNoteRequestSchema, response: { 201: reviewNoteSchema, ...ERROR_RESPONSES } },
  }, async (request, reply) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
    const note = await addReviewNote(domain, { workspaceId: request.params.id, projectId: request.params.projectId, request: request.body, createdBy: context.userId });
    return reply.code(201).send(note);
  });

  typed.patch('/workspaces/:id/review-notes/:noteId', {
    schema: { tags: ['review'], summary: '改批注、确定方案、不改了或重新打开', params: noteParams, body: updateReviewNoteRequestSchema, response: { 200: reviewNoteSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:write');
    return updateReviewNote(domain, { workspaceId: request.params.id, noteId: request.params.noteId, request: request.body });
  });

  typed.delete('/workspaces/:id/review-notes/:noteId', {
    schema: { tags: ['review'], summary: '删除批注', params: noteParams, response: { 204: z.void(), ...ERROR_RESPONSES } },
  }, async (request, reply) => {
    await app.requireWorkspace(request, request.params.id, 'project:write');
    await deleteReviewNote(domain, { workspaceId: request.params.id, noteId: request.params.noteId });
    return reply.status(204).send();
  });

  typed.get('/workspaces/:id/review-notes/:noteId/turns', {
    schema: { tags: ['review'], summary: '这条批注的讨论（新→旧）', params: noteParams, response: { 200: pageResponseSchema(agentTurnSchema), ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    return { items: await listReviewNoteTurns(domain, { workspaceId: request.params.id, noteId: request.params.noteId }), nextCursor: null };
  });

  typed.post('/workspaces/:id/projects/:projectId/review/apply', {
    schema: { tags: ['review'], summary: '全部执行：已确定的批注一次做完（一个试改提案，预览只重渲改动段）', params: projectParams, body: applyReviewRequestSchema, response: { 202: applyReviewResponseSchema, ...ERROR_RESPONSES } },
  }, async (request, reply) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
    const result = await applyReview(domain, {
      workspaceId: request.params.id,
      projectId: request.params.projectId,
      request: request.body,
      createdBy: context.userId,
      idempotencyKey: request.idempotency === null ? null : `${context.userId}:${request.idempotency.key}`,
    });
    return reply.code(202).send(result);
  });
}
