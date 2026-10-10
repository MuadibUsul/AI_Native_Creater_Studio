import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  adoptProposalRequestSchema,
  adoptProposalResponseSchema,
  createProposalRequestSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  proposalSchema,
  proposalTrialSchema,
} from '@ancs/contracts';
import {
  adoptProposal,
  createProposalBranch,
  discardProposal,
  loadProposalForRead,
  previewProposal,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * N06-01／N06-02／N06-04 私有候选路由。
 *
 * - 创建候选：不改工程（只存操作集与绑定）；
 * - 试改：在事务内跑真实执行器再回滚（确定性、零落地）；
 * - 采用：绑定校验（base revision／操作哈希／锚点指纹）→ 统一编辑协议原子执行；失败即失败，不显示"已采用"。
 */

const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const proposalParamsSchema = projectParamsSchema.extend({ proposalId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerProposalRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.post(
    '/workspaces/:id/projects/:projectId/proposals',
    {
      schema: {
        tags: ['projects'],
        summary: '创建私有候选（不改工程；绑定 base revision／意图修订／选择锚点）',
        params: projectParamsSchema,
        body: createProposalRequestSchema,
        response: { 200: proposalSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      return createProposalBranch(domain, {
        workspaceId: request.params.id, projectId: request.params.projectId, actorId: context.userId, request: request.body,
      });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/proposals/:proposalId',
    {
      schema: {
        tags: ['projects'],
        summary: '读取候选（跨租户 404）',
        params: proposalParamsSchema,
        response: { 200: proposalSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return loadProposalForRead(domain, { workspaceId: request.params.id, projectId: request.params.projectId, proposalId: request.params.proposalId });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/proposals/:proposalId/preview',
    {
      schema: {
        tags: ['projects'],
        summary: '确定性私有试改（事务内跑真实执行器后回滚；工程零变更）',
        params: proposalParamsSchema,
        response: { 200: proposalTrialSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      return previewProposal(domain, {
        workspaceId: request.params.id, projectId: request.params.projectId, proposalId: request.params.proposalId, actorId: context.userId,
      });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/proposals/:proposalId/adopt',
    {
      schema: {
        tags: ['projects'],
        summary: '原子采用（绑定校验 + 统一编辑协议；幂等键重放返回同一结果）',
        params: proposalParamsSchema,
        body: adoptProposalRequestSchema,
        response: { 200: adoptProposalResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      const adopted = await adoptProposal(domain, {
        workspaceId: request.params.id, projectId: request.params.projectId, proposalId: request.params.proposalId,
        actorId: context.userId, expectedOperationsHash: request.body.expectedOperationsHash,
        expectedSelectionFingerprint: request.body.expectedSelectionFingerprint, idempotencyKey: request.body.idempotencyKey,
      });
      return { proposal: adopted.proposal, projectRevision: adopted.projectRevision, adopted: true as const };
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/proposals/:proposalId/discard',
    {
      schema: {
        tags: ['projects'],
        summary: '丢弃候选（晚到/过期候选只能被丢弃或取代）',
        params: proposalParamsSchema,
        body: z.object({ reason: z.string().max(200).optional() }).strict(),
        response: { 200: proposalSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return discardProposal(domain, {
        workspaceId: request.params.id, projectId: request.params.projectId, proposalId: request.params.proposalId,
        ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
      });
    },
  );
}
