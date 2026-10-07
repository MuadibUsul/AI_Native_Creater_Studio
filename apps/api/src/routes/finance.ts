import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createFinanceDataSourceSchema, createFinanceTemplateSchema, errorEnvelopeSchema, financeArtifactListSchema,
  financeArtifactSchema, financeDataSourceListSchema, financeDataSourceSchema, financeTemplateListSchema,
  financeTemplateSchema, generateFinanceArtifactRequestSchema, opaqueIdSchema,
} from '@ancs/contracts';
import {
  createFinanceDataSource, createFinanceTemplate, generateFinanceArtifact, listFinanceArtifacts,
  listFinanceDataSources, listFinanceTemplates, type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

const params = z.object({ id: opaqueIdSchema });
const errors = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerFinanceRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };
  typed.post('/workspaces/:id/finance/data-sources', { schema: { tags: ['finance'], params, body: createFinanceDataSourceSchema, response: { 200: financeDataSourceSchema, ...errors } } }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'workspace:update');
    return createFinanceDataSource(domain, { workspaceId: request.params.id, request: request.body });
  });
  typed.get('/workspaces/:id/finance/data-sources', { schema: { tags: ['finance'], params, response: { 200: financeDataSourceListSchema, ...errors } } }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'workspace:read');
    return { items: await listFinanceDataSources(domain, { workspaceId: request.params.id }) };
  });
  typed.post('/workspaces/:id/finance/templates', { schema: { tags: ['finance'], params, body: createFinanceTemplateSchema, response: { 200: financeTemplateSchema, ...errors } } }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'workspace:update');
    return createFinanceTemplate(domain, { workspaceId: request.params.id, request: request.body });
  });
  typed.get('/workspaces/:id/finance/templates', { schema: { tags: ['finance'], params, response: { 200: financeTemplateListSchema, ...errors } } }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'workspace:read');
    return { items: await listFinanceTemplates(domain, { workspaceId: request.params.id }) };
  });
  typed.post('/workspaces/:id/finance/artifacts', { schema: { tags: ['finance'], params, body: generateFinanceArtifactRequestSchema, response: { 200: financeArtifactSchema, ...errors } } }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'workspace:update');
    return generateFinanceArtifact(domain, { workspaceId: request.params.id, request: request.body });
  });
  typed.get('/workspaces/:id/finance/artifacts', { schema: { tags: ['finance'], params, response: { 200: financeArtifactListSchema, ...errors } } }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'workspace:read');
    return { items: await listFinanceArtifacts(domain, { workspaceId: request.params.id }) };
  });
}
