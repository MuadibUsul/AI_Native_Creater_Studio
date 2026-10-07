import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createHandoffRequestSchema,
  errorEnvelopeSchema,
  handoffListSchema,
  handoffRecordSchema,
  opaqueIdSchema,
} from '@ancs/contracts';
import { cancelHandoff, claimHandoff, createHandoff, getHandoff, listProjectHandoffs, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Handoff 路由（P13-05 / §42.3）：
 * - POST .../handoffs —— 创建（限时 + Artifact 绑定校验）；
 * - GET .../handoffs / GET :handoffId —— 状态查询（isExpired 读取时计算）；
 * - POST :handoffId/claim —— 领取（过期/跨租户/已撤销失败）；
 * - POST :handoffId/cancel —— 取消（可撤销）。
 */

const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const handoffParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, handoffId: opaqueIdSchema });
const claimBodySchema = z.object({ claimedBy: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 410: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerHandoffRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.post(
    '/workspaces/:id/projects/:projectId/handoffs',
    {
      schema: {
        tags: ['handoffs'],
        summary: '创建 Handoff（可撤销、限时、绑定账号与 Artifact）',
        params: projectParamsSchema,
        body: createHandoffRequestSchema,
        response: { 200: handoffRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      return createHandoff(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        artifactIds: request.body.artifactIds,
        targetPlatform: request.body.targetPlatform,
        ttlSeconds: request.body.ttlSeconds,
        createdBy: context.userId,
      });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/handoffs',
    {
      schema: {
        tags: ['handoffs'],
        summary: 'Handoff 列表（新→旧；isExpired 读取时计算）',
        params: projectParamsSchema,
        response: { 200: handoffListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listProjectHandoffs(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
      return { items };
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/handoffs/:handoffId',
    {
      schema: {
        tags: ['handoffs'],
        summary: 'Handoff 状态查询（跨租户 → 404）',
        params: handoffParamsSchema,
        response: { 200: handoffRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return getHandoff(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        handoffId: request.params.handoffId,
      });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/handoffs/:handoffId/claim',
    {
      schema: {
        tags: ['handoffs'],
        summary: '领取（过期 → 410；已撤销/已完成 → 409；跨租户 → 404）',
        params: handoffParamsSchema,
        body: claimBodySchema,
        response: { 200: handoffRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return claimHandoff(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        handoffId: request.params.handoffId,
        claimedBy: request.body.claimedBy,
      });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/handoffs/:handoffId/cancel',
    {
      schema: {
        tags: ['handoffs'],
        summary: '取消（可撤销：PENDING/CLAIMED → REVOKED）',
        params: handoffParamsSchema,
        response: { 200: handoffRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return cancelHandoff(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        handoffId: request.params.handoffId,
      });
    },
  );
}
