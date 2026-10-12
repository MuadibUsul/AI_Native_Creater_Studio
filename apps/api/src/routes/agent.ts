import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ApiFailure,
  ERROR_CODES,
  agentSessionSchema,
  agentToolDescriptorSchema,
  agentTurnSchema,
  createAgentSessionRequestSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  startAgentTurnRequestSchema,
} from '@ancs/contracts';
import { projects } from '@ancs/db';
import {
  cancelWorkflow,
  createAgentSession,
  defaultAgentToolCatalog,
  getAgentSession,
  getAgentTurn,
  listAgentTurns,
  startAgentTurn,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * V6-1：通用导演 Agent（共看片室的对话面）。
 * - POST /workspaces/:id/projects/:projectId/agent-sessions：为一个序列开会话（语言随会话）；
 * - POST /workspaces/:id/agent-sessions/:sessionId/turns：说一句话 → 202 轮次（Worker 执行；改动成为提案）；
 * - GET  /workspaces/:id/agent-sessions/:sessionId[/turns]、/agent-turns/:turnId：查询；
 * - POST /workspaces/:id/agent-turns/:turnId/cancel：取消进行中的轮次；
 * - GET  /workspaces/:id/agent-tools：统一工具目录（透明度：AI 能调用哪些组件）。
 * 鉴权：读 project:read，写 project:write；跨工作区 → 404（反枚举）。模型凭据只在 Worker，不经过 API。
 */

const workspaceParams = z.object({ id: opaqueIdSchema });
const projectParams = workspaceParams.extend({ projectId: opaqueIdSchema });
const sessionParams = workspaceParams.extend({ sessionId: opaqueIdSchema });
const turnParams = workspaceParams.extend({ turnId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerAgentRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  const requireProject = async (workspaceId: string, projectId: string): Promise<void> => {
    const rows = await deps.db.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt))).limit(1);
    if (rows[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  };

  typed.post('/workspaces/:id/projects/:projectId/agent-sessions', {
    schema: { tags: ['agent'], summary: '为序列开启 AI 导演会话', params: projectParams, body: createAgentSessionRequestSchema, response: { 201: agentSessionSchema, ...ERROR_RESPONSES } },
  }, async (request, reply) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
    await requireProject(request.params.id, request.params.projectId);
    const session = await createAgentSession(domain, { workspaceId: request.params.id, projectId: request.params.projectId, request: request.body, createdBy: context.userId });
    return reply.code(201).send(session);
  });

  typed.get('/workspaces/:id/agent-sessions/:sessionId', {
    schema: { tags: ['agent'], summary: 'AI 导演会话', params: sessionParams, response: { 200: agentSessionSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    return getAgentSession(domain, { workspaceId: request.params.id, sessionId: request.params.sessionId });
  });

  typed.post('/workspaces/:id/agent-sessions/:sessionId/turns', {
    schema: { tags: ['agent'], summary: '对 AI 说一句话（异步执行；改动成为提案，采用前工程不变）', params: sessionParams, body: startAgentTurnRequestSchema, response: { 202: agentTurnSchema, ...ERROR_RESPONSES } },
  }, async (request, reply) => {
    const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
    const turn = await startAgentTurn(domain, {
      workspaceId: request.params.id,
      sessionId: request.params.sessionId,
      request: request.body,
      createdBy: context.userId,
      // 幂等按发起用户隔离（HTTP 层幂等另由插件回放）
      idempotencyKey: request.idempotency === null ? null : `${context.userId}:${request.idempotency.key}`,
    });
    return reply.code(202).send(turn);
  });

  typed.get('/workspaces/:id/agent-sessions/:sessionId/turns', {
    schema: { tags: ['agent'], summary: '会话内的轮次（新→旧）', params: sessionParams, response: { 200: pageResponseSchema(agentTurnSchema), ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    return { items: await listAgentTurns(domain, { workspaceId: request.params.id, sessionId: request.params.sessionId }), nextCursor: null };
  });

  typed.get('/workspaces/:id/agent-turns/:turnId', {
    schema: { tags: ['agent'], summary: '轮次详情（回应、提案、工具调用摘要、用量与成本）', params: turnParams, response: { 200: agentTurnSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    return getAgentTurn(domain, { workspaceId: request.params.id, turnId: request.params.turnId });
  });

  typed.post('/workspaces/:id/agent-turns/:turnId/cancel', {
    schema: { tags: ['agent'], summary: '取消进行中的轮次（已有草稿不会成为提案）', params: turnParams, response: { 200: agentTurnSchema, ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:write');
    const turn = await getAgentTurn(domain, { workspaceId: request.params.id, turnId: request.params.turnId });
    if (turn.status !== 'RUNNING' || turn.workflowRunId === null) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'turn is not running', 409, { reason: 'AGENT_TURN_NOT_RUNNING', status: turn.status });
    }
    await cancelWorkflow(domain, { workspaceId: request.params.id, runId: turn.workflowRunId });
    return getAgentTurn(domain, { workspaceId: request.params.id, turnId: request.params.turnId });
  });

  typed.get('/workspaces/:id/agent-tools', {
    schema: { tags: ['agent'], summary: 'AI 可调用的统一工具目录', params: workspaceParams, response: { 200: z.object({ items: z.array(agentToolDescriptorSchema) }).strict(), ...ERROR_RESPONSES } },
  }, async (request) => {
    await app.requireWorkspace(request, request.params.id, 'project:read');
    return { items: defaultAgentToolCatalog().descriptors() };
  });
}
