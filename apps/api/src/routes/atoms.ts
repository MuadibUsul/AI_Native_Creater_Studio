import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { channelFitSchema, channelRecipeSchema, contentAtomSchema, createAtomRequestSchema, errorEnvelopeSchema, opaqueIdSchema } from '@ancs/contracts';
import { createAtom, evaluateChannelFit, listAtoms, listChannelRecipes, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Atom / Recipe / Fit 路由（P11-02 / §93.2—93.4）。
 * - POST/GET atoms（创建强制来源可追溯——422 SOURCE_REF_NOT_TRACEABLE）；
 * - GET channel-recipes（官方种子幂等；需求为版本化数据）；
 * - GET projects/:projectId/channel-fit?channelKey=（**NOT_RECOMMENDED 是 200 正常结果** + 逐条原因）。
 */

const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerAtomRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.post(
    '/workspaces/:id/projects/:projectId/atoms',
    {
      schema: {
        tags: ['atoms'],
        summary: '创建 Content Atom（**必须携带可追溯来源引用**——claimId/sourceId 需存在于项目内）',
        params: projectParamsSchema,
        body: createAtomRequestSchema,
        response: { 201: contentAtomSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      const atom = await createAtom(domain, { workspaceId: request.params.id, projectId: request.params.projectId, request: request.body, actorId: context.userId });
      return reply.status(201).send(atom);
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/atoms',
    {
      schema: {
        tags: ['atoms'],
        summary: 'Atom 列表（新→旧；含来源引用）',
        params: projectParamsSchema,
        response: { 200: z.object({ items: z.array(contentAtomSchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listAtoms(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
      return { items };
    },
  );

  typed.get(
    '/workspaces/:id/channel-recipes',
    {
      schema: {
        tags: ['atoms'],
        summary: '渠道 Recipe 目录（版本化数据；每渠道最新 ACTIVE 版本）',
        params: z.object({ id: opaqueIdSchema }),
        response: { 200: z.object({ items: z.array(channelRecipeSchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listChannelRecipes(domain);
      return { items };
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/channel-fit',
    {
      schema: {
        tags: ['atoms'],
        summary: 'Channel Fit（规则化评估；RECOMMENDED/OPTIONAL/NOT_RECOMMENDED + 逐条原因——**非报错**）',
        params: projectParamsSchema,
        querystring: z.object({ channelKey: z.string().min(1).max(60) }),
        response: { 200: channelFitSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return evaluateChannelFit(domain, { workspaceId: request.params.id, projectId: request.params.projectId, channelKey: request.query.channelKey });
    },
  );
}

