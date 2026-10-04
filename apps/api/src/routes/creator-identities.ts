import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createCreatorIdentityRequestSchema,
  creatorIdentitySchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  updateCreatorIdentityRequestSchema,
} from '@ancs/contracts';
import {
  createCreatorIdentity,
  getCreatorIdentity,
  listCreatorIdentities,
  updateCreatorIdentity,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

const wsParamsSchema = z.object({ id: opaqueIdSchema });
const identityParamsSchema = z.object({ id: opaqueIdSchema, creatorIdentityId: opaqueIdSchema });
const identityListSchema = pageResponseSchema(creatorIdentitySchema);
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

/**
 * Creator Identity 路由（P01-04 / 规范 §6.1）：
 * PATCH 的子身份 upsert（avatarIdentity/voiceIdentity/brandIdentity）各自独立 version+1。
 */
export function registerCreatorIdentityRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/workspaces/:id/creator-identities',
    {
      schema: {
        tags: ['creator-identities'],
        summary: '创建 Creator Identity',
        params: wsParamsSchema,
        body: createCreatorIdentityRequestSchema,
        response: { 201: creatorIdentitySchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      const identity = await createCreatorIdentity(
        { db: deps.db },
        { workspaceId: request.params.id, displayName: request.body.displayName },
      );
      return reply.status(201).send(identity);
    },
  );

  typed.get(
    '/workspaces/:id/creator-identities',
    {
      schema: {
        tags: ['creator-identities'],
        summary: 'Creator Identity 列表',
        params: wsParamsSchema,
        response: { 200: identityListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listCreatorIdentities({ db: deps.db }, { workspaceId: request.params.id });
      return { items, nextCursor: null };
    },
  );

  typed.get(
    '/workspaces/:id/creator-identities/:creatorIdentityId',
    {
      schema: {
        tags: ['creator-identities'],
        summary: 'Creator Identity 详情（含子身份）',
        params: identityParamsSchema,
        response: { 200: creatorIdentitySchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return getCreatorIdentity(
        { db: deps.db },
        { workspaceId: request.params.id, creatorIdentityId: request.params.creatorIdentityId },
      );
    },
  );

  typed.patch(
    '/workspaces/:id/creator-identities/:creatorIdentityId',
    {
      schema: {
        tags: ['creator-identities'],
        summary: '更新（子身份 upsert：独立版本递增；status=RETIRED 触发退役）',
        params: identityParamsSchema,
        body: updateCreatorIdentityRequestSchema,
        response: { 200: creatorIdentitySchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return updateCreatorIdentity(
        { db: deps.db },
        {
          workspaceId: request.params.id,
          creatorIdentityId: request.params.creatorIdentityId,
          input: request.body,
        },
      );
    },
  );
}
