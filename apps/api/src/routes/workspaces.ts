import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  addWorkspaceMemberRequestSchema,
  ApiFailure,
  createWorkspaceRequestSchema,
  ERROR_CODES,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  updateWorkspaceMemberRoleRequestSchema,
  updateWorkspaceRequestSchema,
  workspaceMemberSchema,
  workspaceWithRoleSchema,
} from '@ancs/contracts';
import {
  addMember,
  createWorkspace,
  getWorkspace,
  listMembers,
  listWorkspaces,
  removeMember,
  updateMemberRole,
  updateWorkspace,
  type AuthContext,
} from '@ancs/auth';
import type { AuthDeps } from '../plugins/auth.js';

const workspaceIdParamsSchema = z.object({ id: opaqueIdSchema });
const memberParamsSchema = z.object({ id: opaqueIdSchema, userId: opaqueIdSchema });
const workspaceListSchema = pageResponseSchema(workspaceWithRoleSchema);
const memberListSchema = pageResponseSchema(workspaceMemberSchema);

const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema };

async function requireAuth(request: FastifyRequest, instance: FastifyInstance): Promise<AuthContext> {
  const context = await instance.authResolve(request);
  if (context === null) {
    throw new ApiFailure(ERROR_CODES.UNAUTHENTICATED, 'Not authenticated', 401);
  }
  return context;
}

/**
 * Workspace 与成员路由（P01-03；规范 §32 的 Workspace 资源 + 成员管理增补）。
 * 每个 workspace 范围请求都经过统一授权入口（REQ-31-02）：
 * 认证（401）→ 成员资格（404 抗枚举）→ 能力（403）。
 * SSE/事件、Project/Asset/Job 路由落地后必须复用同一入口（P02 起）。
 */
export function registerWorkspaceRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/workspaces',
    {
      schema: {
        tags: ['workspaces'],
        summary: '创建 Workspace（创建者成为 OWNER）',
        body: createWorkspaceRequestSchema,
        response: { 201: workspaceWithRoleSchema, 401: errorEnvelopeSchema },
      },
    },
    async (request, reply) => {
      const context = await requireAuth(request, app);
      const workspace = await createWorkspace({ db: deps.db }, { userId: context.userId, name: request.body.name });
      return reply.status(201).send(workspace);
    },
  );

  typed.get(
    '/workspaces',
    {
      schema: {
        tags: ['workspaces'],
        summary: '我参与的 Workspace 列表',
        response: { 200: workspaceListSchema, 401: errorEnvelopeSchema },
      },
    },
    async (request) => {
      const context = await requireAuth(request, app);
      const items = await listWorkspaces({ db: deps.db }, { userId: context.userId });
      return { items, nextCursor: null };
    },
  );

  typed.get(
    '/workspaces/:id',
    {
      schema: {
        tags: ['workspaces'],
        summary: 'Workspace 详情（需成员资格）',
        params: workspaceIdParamsSchema,
        response: { 200: workspaceWithRoleSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return getWorkspace({ db: deps.db }, { userId: context.userId, workspaceId: request.params.id });
    },
  );

  typed.patch(
    '/workspaces/:id',
    {
      schema: {
        tags: ['workspaces'],
        summary: '更新 Workspace（需 workspace:update）',
        params: workspaceIdParamsSchema,
        body: updateWorkspaceRequestSchema,
        response: { 200: workspaceWithRoleSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'workspace:update');
      return updateWorkspace(
        { db: deps.db },
        { userId: context.userId, workspaceId: request.params.id, name: request.body.name },
      );
    },
  );

  typed.get(
    '/workspaces/:id/members',
    {
      schema: {
        tags: ['workspaces'],
        summary: '成员列表（需成员资格）',
        params: workspaceIdParamsSchema,
        response: { 200: memberListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'workspace:read');
      const items = await listMembers({ db: deps.db }, { userId: context.userId, workspaceId: request.params.id });
      return { items, nextCursor: null };
    },
  );

  typed.post(
    '/workspaces/:id/members',
    {
      schema: {
        tags: ['workspaces'],
        summary: '添加成员（需 member:manage；授予 OWNER 仅限 OWNER）',
        params: workspaceIdParamsSchema,
        body: addWorkspaceMemberRequestSchema,
        response: { 201: workspaceMemberSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'member:manage');
      const member = await addMember(
        { db: deps.db },
        {
          userId: context.userId,
          workspaceId: request.params.id,
          email: request.body.email,
          role: request.body.role,
        },
      );
      return reply.status(201).send(member);
    },
  );

  typed.patch(
    '/workspaces/:id/members/:userId',
    {
      schema: {
        tags: ['workspaces'],
        summary: '变更成员角色（OWNER 不变量在服务层强制）',
        params: memberParamsSchema,
        body: updateWorkspaceMemberRoleRequestSchema,
        response: { 200: workspaceMemberSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'member:manage');
      return updateMemberRole(
        { db: deps.db },
        {
          userId: context.userId,
          workspaceId: request.params.id,
          targetUserId: request.params.userId,
          role: request.body.role,
        },
      );
    },
  );

  typed.delete(
    '/workspaces/:id/members/:userId',
    {
      schema: {
        tags: ['workspaces'],
        summary: '移除成员（访问立即失效；不得移除最后一名 OWNER）',
        params: memberParamsSchema,
      },
    },
    async (request, reply) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'member:manage');
      await removeMember(
        { db: deps.db },
        { userId: context.userId, workspaceId: request.params.id, targetUserId: request.params.userId },
      );
      return reply.status(204).send();
    },
  );
}
