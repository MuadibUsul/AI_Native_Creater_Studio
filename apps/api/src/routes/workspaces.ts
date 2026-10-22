import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  addWorkspaceMemberRequestSchema,
  ApiFailure,
  createInvitationRequestSchema,
  createWorkspaceRequestSchema,
  ENTITLEMENT_ERROR_REASONS,
  ERROR_CODES,
  errorEnvelopeSchema,
  myInvitationSchema,
  opaqueIdSchema,
  pageResponseSchema,
  setPrivacyTierRequestSchema,
  updateWorkspaceMemberRoleRequestSchema,
  updateWorkspaceRequestSchema,
  workspaceInvitationSchema,
  workspaceFeatureKeySchema,
  workspaceFeatureListSchema,
  workspaceFeatureSchema,
  workspaceMemberSchema,
  workspaceWithRoleSchema,
  setWorkspaceFeatureRequestSchema,
} from '@ancs/contracts';
import {
  addMember,
  createWorkspace,
  getWorkspace,
  listMembers,
  listWorkspaces,
  removeMember,
  setWorkspacePrivacyTier,
  updateMemberRole,
  updateWorkspace,
  type AuthContext,
} from '@ancs/auth';
import {
  acceptInvitation,
  assertSeatsAvailable,
  createInvitation,
  getWorkspaceEntitlement,
  listInvitations,
  listMyInvitations,
  listWorkspaceFeatures,
  revokeInvitation,
  setWorkspaceFeaturePreference,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';
import { sendWorkspaceInvitationEmail, type AccountsDeps } from '../plugins/email.js';

const workspaceIdParamsSchema = z.object({ id: opaqueIdSchema });
const memberParamsSchema = z.object({ id: opaqueIdSchema, userId: opaqueIdSchema });
const invitationParamsSchema = z.object({ id: opaqueIdSchema, invitationId: opaqueIdSchema });
const acceptInvitationParamsSchema = z.object({ invitationId: opaqueIdSchema });
const workspaceFeatureParamsSchema = z.object({ id: opaqueIdSchema, featureKey: workspaceFeatureKeySchema });
const workspaceListSchema = pageResponseSchema(workspaceWithRoleSchema);
const memberListSchema = pageResponseSchema(workspaceMemberSchema);
const invitationListSchema = pageResponseSchema(workspaceInvitationSchema);
const myInvitationListSchema = pageResponseSchema(myInvitationSchema);

const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

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
export function registerWorkspaceRoutes(app: FastifyInstance, deps: AuthDeps, accounts?: AccountsDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

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

  typed.get(
    '/workspaces/:id/features',
    {
      schema: {
        tags: ['workspaces'],
        summary: '读取 v0.4 工作区功能偏好与服务端发布门的有效状态',
        params: workspaceIdParamsSchema,
        response: { 200: workspaceFeatureListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return { items: await listWorkspaceFeatures(domain, { workspaceId: request.params.id }) };
    },
  );

  typed.put(
    '/workspaces/:id/features/:featureKey',
    {
      schema: {
        tags: ['workspaces'],
        summary: '设置工作区功能偏好；服务端发布门仍是有效能力的权威来源',
        params: workspaceFeatureParamsSchema,
        body: setWorkspaceFeatureRequestSchema,
        response: { 200: workspaceFeatureSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'workspace:update');
      return setWorkspaceFeaturePreference(domain, {
        workspaceId: request.params.id,
        featureKey: request.params.featureKey,
        enabled: request.body.enabled,
        actorId: context.userId,
      });
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
        summary: '添加成员（需 member:manage；**席位额度强制**；授予 OWNER 仅限 OWNER）',
        params: workspaceIdParamsSchema,
        body: addWorkspaceMemberRequestSchema,
        response: { 201: workspaceMemberSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'member:manage');
      // 席位额度（P09-04：Plan 权益数据驱动；降级后新增被阻止、存量保留）
      await assertSeatsAvailable(domain, { workspaceId: request.params.id, additionalSeats: 1 });
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

  /* ---------- P09-04：邀请（邮箱 + 角色；接受时邮箱匹配 + 权威席位检查） ---------- */

  typed.post(
    '/workspaces/:id/invitations',
    {
      schema: {
        tags: ['workspaces'],
        summary: '创建邀请（需 member:manage；席位早期检查：成员 + 未过期待接受邀请；授予 OWNER 仅限 OWNER）',
        params: workspaceIdParamsSchema,
        body: createInvitationRequestSchema,
        response: { 201: workspaceInvitationSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { context, membership } = await app.requireWorkspace(request, request.params.id, 'member:manage');
      const invitation = await createInvitation(domain, {
        workspaceId: request.params.id,
        request: request.body,
        invitedByUserId: context.userId,
        requesterRole: membership.role,
      });
      // 配置了发信时寄出邀请邮件（不等待投递；邀请本身已生效）
      await sendWorkspaceInvitationEmail(deps.db, accounts, { workspaceId: request.params.id, email: invitation.email, locale: request.body.locale });
      return reply.status(201).send(invitation);
    },
  );

  typed.get(
    '/workspaces/:id/invitations',
    {
      schema: {
        tags: ['workspaces'],
        summary: '邀请列表（需 member:manage；EXPIRED 为读取推导态）',
        params: workspaceIdParamsSchema,
        response: { 200: invitationListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'member:manage');
      const items = await listInvitations(domain, { workspaceId: request.params.id });
      return { items, nextCursor: null };
    },
  );

  typed.delete(
    '/workspaces/:id/invitations/:invitationId',
    {
      schema: {
        tags: ['workspaces'],
        summary: '撤销邀请（PENDING → REVOKED；撤销后不可接受——立即生效）',
        params: invitationParamsSchema,
        response: { 200: workspaceInvitationSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'member:manage');
      return revokeInvitation(domain, { workspaceId: request.params.id, invitationId: request.params.invitationId });
    },
  );

  /** 我的待处理邀请（按登录邮箱；任意认证用户） */
  typed.get(
    '/invitations',
    {
      schema: {
        tags: ['workspaces'],
        summary: '我的待处理邀请（未过期 PENDING；含 Workspace 名称）',
        response: { 200: myInvitationListSchema, ...{ 401: errorEnvelopeSchema } },
      },
    },
    async (request) => {
      const context = await requireAuth(request, app);
      const items = await listMyInvitations(domain, { userId: context.userId });
      return { items, nextCursor: null };
    },
  );

  /** 接受邀请（邮箱匹配 + 席位权威检查；成员写入与邀请置 ACCEPTED 同事务） */
  typed.post(
    '/invitations/:invitationId/accept',
    {
      schema: {
        tags: ['workspaces'],
        summary: '接受邀请（登录邮箱 = 邀请邮箱；返回取得的 Workspace 与角色）',
        params: acceptInvitationParamsSchema,
        response: {
          201: z.object({ workspace: workspaceWithRoleSchema, invitation: workspaceInvitationSchema }),
          ...{ 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema },
        },
      },
    },
    async (request, reply) => {
      const context = await requireAuth(request, app);
      const accepted = await acceptInvitation(domain, { invitationId: request.params.invitationId, userId: context.userId });
      const workspace = await getWorkspace({ db: deps.db }, { userId: context.userId, workspaceId: accepted.member.workspaceId });
      return reply.status(201).send({ workspace, invitation: accepted.invitation });
    },
  );

  /* ---------- P09-04：隐私档位（§20.4；非 STANDARD 需 Plan 权益 privacyMode） ---------- */

  typed.patch(
    '/workspaces/:id/privacy',
    {
      schema: {
        tags: ['workspaces'],
        summary: '设置隐私档位（需 workspace:update；非 STANDARD 需套餐权益 privacyMode——数据驱动，明确 422）',
        params: workspaceIdParamsSchema,
        body: setPrivacyTierRequestSchema,
        response: { 200: workspaceWithRoleSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'workspace:update');
      if (request.body.privacyTier !== 'STANDARD') {
        const entitlement = await getWorkspaceEntitlement(domain, { workspaceId: request.params.id });
        if (!entitlement.entitlements.privacyMode) {
          throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `当前套餐（${entitlement.plan.planKey}）不含隐私模式权益；请升级后设置`, 422, {
            reason: ENTITLEMENT_ERROR_REASONS.PRIVACY_MODE_NOT_ALLOWED,
            planKey: entitlement.plan.planKey,
          });
        }
      }
      return setWorkspacePrivacyTier({ db: deps.db }, { userId: context.userId, workspaceId: request.params.id, privacyTier: request.body.privacyTier });
    },
  );
}
