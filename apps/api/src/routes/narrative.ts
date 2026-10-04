import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  errorEnvelopeSchema,
  narrationBlockSchema,
  narrativeGenerationResultSchema,
  narrativePlanSchema,
  opaqueIdSchema,
  pageResponseSchema,
  updateNarrationBlockRequestSchema,
  type LlmAdapter,
} from '@ancs/contracts';
import { generateNarrative, getCurrentPlan, listPlans, updateNarrationBlock, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Narrative 路由（P04-03 / 规范 §8）。
 *
 * - POST .../narrative/generate：结构化生成（LLM 适配器 + 有限修复；422 附原因）；
 * - GET .../narrative（当前计划；无则 200 + null）、GET .../narrative/plans（版本列表）；
 * - PATCH .../narrative/:planId/blocks/:blockId（作者修订；锁定后 409）。
 */

const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const blockParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, planId: opaqueIdSchema, blockId: opaqueIdSchema });
const generateRequestSchema = z.object({
  documentId: opaqueIdSchema,
  targetDurationMs: z.number().int().positive().max(3_600_000),
  tone: z.string().max(100).nullable().optional(),
  audience: z.string().max(100).nullable().optional(),
  platform: z.string().max(100).nullable().optional(),
});
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

export function registerNarrativeRoutes(app: FastifyInstance, deps: AuthDeps, llm: LlmAdapter | undefined): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db, ...(llm !== undefined ? { llm } : {}) };

  typed.post(
    '/workspaces/:id/projects/:projectId/narrative/generate',
    {
      schema: {
        tags: ['narrative'],
        summary: '生成叙事计划（结构化输出 + 有限修复 + 锁定保留 + 口语化门控；422 附原因）',
        params: projectParamsSchema,
        body: generateRequestSchema,
        response: { 200: narrativeGenerationResultSchema, 422: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      return generateNarrative(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        documentId: request.body.documentId,
        targetDurationMs: request.body.targetDurationMs,
        tone: request.body.tone ?? null,
        audience: request.body.audience ?? null,
        platform: request.body.platform ?? null,
        createdBy: context.userId,
      });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/narrative',
    {
      schema: {
        tags: ['narrative'],
        summary: '当前叙事计划（无计划时返回 null——列表操作 idempotent）',
        params: projectParamsSchema,
        response: { 200: narrativePlanSchema.nullable(), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return getCurrentPlan(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/narrative/plans',
    {
      schema: {
        tags: ['narrative'],
        summary: '叙事计划版本列表（revision 降序；旧版本只读）',
        params: projectParamsSchema,
        response: { 200: pageResponseSchema(narrativePlanSchema), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listPlans(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
      return { items, nextCursor: null };
    },
  );

  typed.patch(
    '/workspaces/:id/projects/:projectId/narrative/:planId/blocks/:blockId',
    {
      schema: {
        tags: ['narrative'],
        summary: '修订旁白块（文本/锁定/状态）；锁定后改文本 → 409 NARRATION_BLOCK_LOCKED',
        params: blockParamsSchema,
        body: updateNarrationBlockRequestSchema,
        response: { 200: narrationBlockSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return updateNarrationBlock(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        planId: request.params.planId,
        blockId: request.params.blockId,
        input: request.body,
      });
    },
  );
}
