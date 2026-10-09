import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createEditPlanRequestSchema, createRangeEditPlanRequestSchema, editPlanSchema, errorEnvelopeSchema, opaqueIdSchema, rangeEditPlanSchema, type LlmAdapter } from '@ancs/contracts';
import { planAiEdit, planRangeEdit, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * AI Edit 路由（P05-06 / 规范 §37、§52）。
 *
 * POST .../ai-edit/plan：自然语言 → 结构化编辑计划（**不落库**；未 Apply 不改数据）。
 * Apply 由客户端调用统一编辑协议（POST /projects/:id/edits）——整批在同一事务。
 */

const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema };

export function registerAiEditRoutes(app: FastifyInstance, deps: AuthDeps, llm: LlmAdapter | undefined): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db, ...(llm !== undefined ? { llm } : {}) };

  typed.post(
    '/workspaces/:id/projects/:projectId/ai-edit/plan',
    {
      schema: {
        tags: ['projects'],
        summary: 'AI Edit 计划（结构化 operation + 差异 + 影响；不落库，Apply 走编辑协议）',
        params: projectParamsSchema,
        body: createEditPlanRequestSchema,
        response: { 200: editPlanSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return planAiEdit(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        prompt: request.body.prompt,
      });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/ai-edit/range-plan',
    {
      schema: {
        tags: ['projects'],
        summary: 'N03-09 范围编辑计划（选中片段 + 允许操作 + 源证据 → 可验证结构化编辑；不落库、零 Provider 媒体调用）',
        params: projectParamsSchema,
        body: createRangeEditPlanRequestSchema,
        response: { 200: rangeEditPlanSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return planRangeEdit(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        request: request.body,
      });
    },
  );
}
