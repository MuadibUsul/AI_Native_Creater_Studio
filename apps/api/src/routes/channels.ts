import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  channelStyleVersionSchema,
  channelWithStyleSchema,
  createChannelRequestSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  updateChannelRequestSchema,
} from '@ancs/contracts';
import {
  createChannel,
  getChannel,
  listChannelStyleVersions,
  listChannels,
  updateChannel,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

const wsParamsSchema = z.object({ id: opaqueIdSchema });
const channelParamsSchema = z.object({ id: opaqueIdSchema, channelId: opaqueIdSchema });
const channelListSchema = pageResponseSchema(channelWithStyleSchema);
const styleVersionListSchema = pageResponseSchema(channelStyleVersionSchema);
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

/**
 * Channel 路由（P01-04 / 规范 §6）：
 * - 读：project:read；写：project:write（经由统一授权入口 requireWorkspace）；
 * - PATCH 携带 defaults 即产生新的不可变样式版本（旧项目快照不受影响）。
 */
export function registerChannelRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/workspaces/:id/channels',
    {
      schema: {
        tags: ['channels'],
        summary: '创建 Channel（首次样式版本 v1）',
        params: wsParamsSchema,
        body: createChannelRequestSchema,
        response: { 201: channelWithStyleSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      const channel = await createChannel(
        { db: deps.db },
        { workspaceId: request.params.id, createdBy: context.userId, input: request.body },
      );
      return reply.status(201).send(channel);
    },
  );

  typed.get(
    '/workspaces/:id/channels',
    {
      schema: {
        tags: ['channels'],
        summary: 'Channel 列表（含当前样式版本）',
        params: wsParamsSchema,
        response: { 200: channelListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listChannels({ db: deps.db }, { workspaceId: request.params.id });
      return { items, nextCursor: null };
    },
  );

  typed.get(
    '/workspaces/:id/channels/:channelId',
    {
      schema: {
        tags: ['channels'],
        summary: 'Channel 详情（含当前样式版本）',
        params: channelParamsSchema,
        response: { 200: channelWithStyleSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return getChannel({ db: deps.db }, { workspaceId: request.params.id, channelId: request.params.channelId });
    },
  );

  typed.patch(
    '/workspaces/:id/channels/:channelId',
    {
      schema: {
        tags: ['channels'],
        summary: '更新 Channel（提供 defaults 即产生新样式版本）',
        params: channelParamsSchema,
        body: updateChannelRequestSchema,
        response: { 200: channelWithStyleSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      return updateChannel(
        { db: deps.db },
        {
          workspaceId: request.params.id,
          channelId: request.params.channelId,
          createdBy: context.userId,
          input: request.body,
        },
      );
    },
  );

  typed.get(
    '/workspaces/:id/channels/:channelId/style-versions',
    {
      schema: {
        tags: ['channels'],
        summary: '样式版本历史（不可变；快照消费方按 version 解析）',
        params: channelParamsSchema,
        response: { 200: styleVersionListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listChannelStyleVersions(
        { db: deps.db },
        { workspaceId: request.params.id, channelId: request.params.channelId },
      );
      return { items, nextCursor: null };
    },
  );
}
