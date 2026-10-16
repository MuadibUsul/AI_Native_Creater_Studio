import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  IDENTITY_CONSENT_STATEMENTS,
  IDENTITY_CONSENT_STATEMENT_VERSION,
  acceptGenerationRequestSchema,
  createIdentityProfileRequestSchema,
  errorEnvelopeSchema,
  generationSchema,
  grantIdentityConsentRequestSchema,
  identityProfileSchema,
  opaqueIdSchema,
  revokeIdentityConsentRequestSchema,
  setIdentityReferenceRequestSchema,
} from '@ancs/contracts';
import {
  acceptGeneration,
  createIdentityProfile,
  declineGeneration,
  grantIdentityConsent,
  listIdentityProfiles,
  listProjectGenerations,
  revokeIdentityConsent,
  setIdentityReference,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * V6-7 / V6-8：付费生成的确认与身份档案。
 * - GET  /workspaces/:id/projects/:projectId/generations：报价与生成记录（新的在前）；
 * - POST /workspaces/:id/projects/:projectId/generations/:generationId/accept：用户确认报价（带上看到的报价上限；预留预算后开始生成）；
 * - POST /workspaces/:id/projects/:projectId/generations/:generationId/decline：不要了；
 * - GET/POST /workspaces/:id/identity-profiles、PUT …/:identityId/reference、POST …/:identityId/consents(/revoke)：我的形象与声音；
 * - GET /workspaces/:id/identity-consent-statement：当前授权声明（中英文、版本）。
 * 确认只能由用户经此接口发起（AI 只能报价）；鉴权：读 project:read，写 project:write；跨工作区 → 404。
 */

const workspaceParams = z.object({ id: opaqueIdSchema });
const projectParams = workspaceParams.extend({ projectId: opaqueIdSchema });
const generationParams = projectParams.extend({ generationId: opaqueIdSchema });
const identityParams = workspaceParams.extend({ identityId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 402: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

const consentStatementSchema = z.object({
  version: z.string(),
  statements: z.object({
    LIKENESS: z.object({ 'zh-CN': z.string(), en: z.string() }),
    VOICE: z.object({ 'zh-CN': z.string(), en: z.string() }),
  }),
});

export function registerGenerationRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.get('/workspaces/:id/projects/:projectId/generations', {
    schema: { tags: ['projects'], summary: '付费生成的报价与记录（新的在前）', params: projectParams, response: { 200: z.object({ items: z.array(generationSchema) }), ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    return { items: await listProjectGenerations(domain, { workspaceId: request.params.id, projectId: request.params.projectId, limit: 50 }) };
  });

  typed.post('/workspaces/:id/projects/:projectId/generations/:generationId/accept', {
    schema: {
      tags: ['projects'], summary: '确认生成（预留工作区预算后开始；只调用一次，结果放进试改）',
      params: generationParams, body: acceptGenerationRequestSchema, response: { 200: generationSchema, ...ERROR_RESPONSES },
    },
  }, async (request) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
    return acceptGeneration(domain, {
      workspaceId: request.params.id, projectId: request.params.projectId, generationId: request.params.generationId, request: request.body, actorId: context.userId,
    });
  });

  typed.post('/workspaces/:id/projects/:projectId/generations/:generationId/decline', {
    schema: { tags: ['projects'], summary: '不要这份报价', params: generationParams, response: { 200: generationSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:write');
    return declineGeneration(domain, { workspaceId: request.params.id, projectId: request.params.projectId, generationId: request.params.generationId });
  });

  typed.get('/workspaces/:id/identity-consent-statement', {
    schema: { tags: ['identities'], summary: '当前的形象/声音授权声明（中英文与版本）', params: workspaceParams, response: { 200: consentStatementSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    return { version: IDENTITY_CONSENT_STATEMENT_VERSION, statements: IDENTITY_CONSENT_STATEMENTS };
  });

  typed.get('/workspaces/:id/identity-profiles', {
    schema: { tags: ['identities'], summary: '我的形象与声音（参考素材、授权与授权记录）', params: workspaceParams, response: { 200: z.object({ items: z.array(identityProfileSchema) }), ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    return { items: await listIdentityProfiles(domain, { workspaceId: request.params.id }) };
  });

  typed.post('/workspaces/:id/identity-profiles', {
    schema: { tags: ['identities'], summary: '新建身份档案', params: workspaceParams, body: createIdentityProfileRequestSchema, response: { 201: identityProfileSchema, ...ERROR_RESPONSES } },
  }, async (request, reply) => {
    await app.requireWorkspace(request, request.params.id, 'project:write');
    return reply.code(201).send(await createIdentityProfile(domain, { workspaceId: request.params.id, name: request.body.name }));
  });

  typed.put('/workspaces/:id/identity-profiles/:identityId/reference', {
    schema: { tags: ['identities'], summary: '设定参考照片或声音样本（换参考后需要重新授权）', params: identityParams, body: setIdentityReferenceRequestSchema, response: { 200: identityProfileSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
    return setIdentityReference(domain, { workspaceId: request.params.id, identityId: request.params.identityId, kind: request.body.kind, assetId: request.body.assetId, actorId: context.userId });
  });

  typed.post('/workspaces/:id/identity-profiles/:identityId/consents', {
    schema: { tags: ['identities'], summary: '授权（追加一条授权记录；声明须为当前版本）', params: identityParams, body: grantIdentityConsentRequestSchema, response: { 200: identityProfileSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
    return grantIdentityConsent(domain, { workspaceId: request.params.id, identityId: request.params.identityId, request: request.body, actorId: context.userId });
  });

  typed.post('/workspaces/:id/identity-profiles/:identityId/consents/revoke', {
    schema: { tags: ['identities'], summary: '撤回授权（追加一条撤回记录，立即生效）', params: identityParams, body: revokeIdentityConsentRequestSchema, response: { 200: identityProfileSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
    return revokeIdentityConsent(domain, { workspaceId: request.params.id, identityId: request.params.identityId, kind: request.body.kind, actorId: context.userId });
  });
}
