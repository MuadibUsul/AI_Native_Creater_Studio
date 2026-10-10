import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  appendVoiceEventRequestSchema,
  appendVoiceEventResponseSchema,
  createVoiceSessionRequestSchema,
  createVoiceSessionResponseSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  sealUtteranceRequestSchema,
  sealUtteranceResponseSchema,
  voiceSessionSchema,
} from '@ancs/contracts';
import {
  appendVoiceEvent,
  closeVoiceSession,
  createVoiceSession,
  getVoiceSession,
  revokeVoiceSession,
  sealUtterance,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * N05-01 实时语音会话路由（V03-26／V03-49／V03-53）。
 *
 * - 创建会话需要 `project:write`（无权限用户拿不到会话）；
 * - 会话只返回**短期凭证**，响应里没有 Provider Key/Secret（长期 Key 永不下发）；
 * - 事件与封存都按会话状态/代际校验（过期/撤销/旧代际一律 409）；
 * - partial 只写会话草稿：响应显式带 `projectUntouched: true`（工程零变更）。
 */

const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const sessionParamsSchema = projectParamsSchema.extend({ sessionId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerVoiceSessionRoutes(app: FastifyInstance, deps: AuthDeps, options: { sessionSecret?: string } = {}): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = options.sessionSecret === undefined ? { db: deps.db } : { db: deps.db, voiceSessionSecret: options.sessionSecret };

  typed.post(
    '/workspaces/:id/projects/:projectId/voice-sessions',
    {
      schema: {
        tags: ['projects'],
        summary: '创建实时语音会话（短期凭证 + 显式能力；长期 Key 永不下发）',
        params: projectParamsSchema,
        body: createVoiceSessionRequestSchema,
        response: { 200: createVoiceSessionResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      const created = await createVoiceSession(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        actorId: context.userId,
        selectionAnchorId: request.body.selectionAnchorId,
        ...(request.body.preferredTransport === undefined ? {} : { preferredTransport: request.body.preferredTransport }),
      });
      return created;
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/voice-sessions/:sessionId',
    {
      schema: {
        tags: ['projects'],
        summary: '读取语音会话状态（过期会顺目标记；跨租户 404）',
        params: sessionParamsSchema,
        response: { 200: voiceSessionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return getVoiceSession(domain, {
        workspaceId: request.params.id, projectId: request.params.projectId, sessionId: request.params.sessionId,
      });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/voice-sessions/:sessionId/events',
    {
      schema: {
        tags: ['projects'],
        summary: '接受流式事件（转写中/修订只写会话草稿；旧代际/过期/撤销一律 409）',
        params: sessionParamsSchema,
        body: appendVoiceEventRequestSchema,
        response: { 200: appendVoiceEventResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return appendVoiceEvent(domain, {
        workspaceId: request.params.id, projectId: request.params.projectId, sessionId: request.params.sessionId,
        envelope: request.body.event,
      });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/voice-sessions/:sessionId/seal',
    {
      schema: {
        tags: ['projects'],
        summary: '封存话语为 IntentRevision（未解析指代不可封存；封存本身不改工程）',
        params: sessionParamsSchema,
        body: sealUtteranceRequestSchema,
        response: { 200: sealUtteranceResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return sealUtterance(domain, {
        workspaceId: request.params.id, projectId: request.params.projectId, sessionId: request.params.sessionId,
        request: request.body,
      });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/voice-sessions/:sessionId/close',
    {
      schema: {
        tags: ['projects'],
        summary: '结束采集（幂等：重复结束返回同一状态）',
        params: sessionParamsSchema,
        response: { 200: voiceSessionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return closeVoiceSession(domain, {
        workspaceId: request.params.id, projectId: request.params.projectId, sessionId: request.params.sessionId,
      });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/voice-sessions/:sessionId/revoke',
    {
      schema: {
        tags: ['projects'],
        summary: '撤销会话（撤销后不得继续执行项目操作）',
        params: sessionParamsSchema,
        response: { 200: voiceSessionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return revokeVoiceSession(domain, {
        workspaceId: request.params.id, projectId: request.params.projectId, sessionId: request.params.sessionId,
      });
    },
  );
}
