import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createSpeechProfileRequestSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  speechProfileSchema,
  updateSpeechProfileRequestSchema,
} from '@ancs/contracts';
import {
  createSpeechProfile,
  getSpeechProfile,
  listSpeechProfiles,
  updateSpeechProfile,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

const wsParamsSchema = z.object({ id: opaqueIdSchema });
const profileParamsSchema = z.object({ id: opaqueIdSchema, speechProfileId: opaqueIdSchema });
const profileListSchema = pageResponseSchema(speechProfileSchema);
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

/**
 * SpeechProfile 路由（P01-04 / 规范 §6.4）：
 * PATCH 携带 fields 即产生新版本（发音词典随版本保存）；P04-06 Speech Director 消费当前版本。
 */
export function registerSpeechProfileRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/workspaces/:id/speech-profiles',
    {
      schema: {
        tags: ['speech-profiles'],
        summary: '创建 SpeechProfile（字段缺省合并系统默认）',
        params: wsParamsSchema,
        body: createSpeechProfileRequestSchema,
        response: { 201: speechProfileSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      const profile = await createSpeechProfile(
        { db: deps.db },
        { workspaceId: request.params.id, name: request.body.name, fields: request.body.fields },
      );
      return reply.status(201).send(profile);
    },
  );

  typed.get(
    '/workspaces/:id/speech-profiles',
    {
      schema: {
        tags: ['speech-profiles'],
        summary: 'SpeechProfile 列表',
        params: wsParamsSchema,
        response: { 200: profileListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listSpeechProfiles({ db: deps.db }, { workspaceId: request.params.id });
      return { items, nextCursor: null };
    },
  );

  typed.get(
    '/workspaces/:id/speech-profiles/:speechProfileId',
    {
      schema: {
        tags: ['speech-profiles'],
        summary: 'SpeechProfile 详情（当前版本）',
        params: profileParamsSchema,
        response: { 200: speechProfileSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return getSpeechProfile(
        { db: deps.db },
        { workspaceId: request.params.id, speechProfileId: request.params.speechProfileId },
      );
    },
  );

  typed.patch(
    '/workspaces/:id/speech-profiles/:speechProfileId',
    {
      schema: {
        tags: ['speech-profiles'],
        summary: '更新 SpeechProfile（提供 fields 即产生新版本）',
        params: profileParamsSchema,
        body: updateSpeechProfileRequestSchema,
        response: { 200: speechProfileSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return updateSpeechProfile(
        { db: deps.db },
        {
          workspaceId: request.params.id,
          speechProfileId: request.params.speechProfileId,
          name: request.body.name,
          fields: request.body.fields,
        },
      );
    },
  );
}
