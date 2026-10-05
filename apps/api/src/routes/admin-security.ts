import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  abuseFlagSchema,
  adminProjectSummarySchema,
  adminProviderStatusSchema,
  adminStorageSummarySchema,
  adminUserSummarySchema,
  adminWorkspaceSummarySchema,
  auditLogEntrySchema,
  createAbuseFlagRequestSchema,
  createSupportGrantRequestSchema,
  creditStatementSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  resolveAbuseFlagRequestSchema,
  setWorkspaceAbuseStateRequestSchema,
  supportAccessGrantSchema,
  supportViewSchema,
  workspaceAbuseStateSchema,
} from '@ancs/contracts';
import {
  createAbuseFlag,
  createSupportGrant,
  getAdminProviderStatus,
  getAdminStorageSummary,
  getCreditStatement,
  getSupportView,
  listAbuseFlags,
  listAdminProjects,
  listAdminUsers,
  listAdminWorkspaces,
  listAuditLog,
  listSupportGrants,
  resolveAbuseFlag,
  revokeSupportGrant,
  setWorkspaceAbuseState,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * SaaS 安全运营路由（P09-05 / §43.3、§67、§24.2；计划 §8）——**全部要求平台管理员**。
 *
 * - 完整 Admin 只读聚合（users/workspaces/projects/provider status/storage/credits）；
 * - 滥用处理（flags + 工作区限制状态；每次动作写 audit_log）；
 * - 支持工具（时限授权；support-view 每次访问写 audit_log + 工作区可见事件——**不可无痕**）；
 * - 运营审计表（audit_log 查询）。
 */

const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

const listQuerySchema = z.object({
  query: z.string().max(120).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const workspaceParamsSchema = z.object({ workspaceId: opaqueIdSchema });
const grantParamsSchema = z.object({ grantId: opaqueIdSchema });
const flagParamsSchema = z.object({ flagId: opaqueIdSchema });

export function registerAdminSecurityRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  /* ---------- 完整 Admin：只读聚合（§67 列表） ---------- */

  typed.get(
    '/admin/users',
    {
      schema: {
        tags: ['admin'],
        summary: '用户列表（查询邮箱/名称；含参与 Workspace 数）',
        querystring: listQuerySchema,
        response: { 200: z.object({ items: z.array(adminUserSummarySchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requirePlatformAdmin(request);
      const items = await listAdminUsers(domain, {
        ...(request.query.query !== undefined ? { query: request.query.query } : {}),
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
      return { items };
    },
  );

  typed.get(
    '/admin/workspaces',
    {
      schema: {
        tags: ['admin'],
        summary: 'Workspace 列表（查询名称；套餐/用量/积分/限制状态/未解决标记）',
        querystring: listQuerySchema,
        response: { 200: z.object({ items: z.array(adminWorkspaceSummarySchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requirePlatformAdmin(request);
      const items = await listAdminWorkspaces(domain, {
        ...(request.query.query !== undefined ? { query: request.query.query } : {}),
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
      return { items };
    },
  );

  typed.get(
    '/admin/projects',
    {
      schema: {
        tags: ['admin'],
        summary: 'Project 列表（查询标题/按 Workspace）',
        querystring: z.object({
          query: z.string().max(120).optional(),
          workspaceId: opaqueIdSchema.optional(),
          limit: z.coerce.number().int().positive().max(200).optional(),
        }),
        response: { 200: z.object({ items: z.array(adminProjectSummarySchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requirePlatformAdmin(request);
      const items = await listAdminProjects(domain, {
        ...(request.query.query !== undefined ? { query: request.query.query } : {}),
        ...(request.query.workspaceId !== undefined ? { workspaceId: request.query.workspaceId } : {}),
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
      return { items };
    },
  );

  typed.get(
    '/admin/provider-status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Provider 状态（近 7 天生成记录聚合；错误类别截断，不含 Secret）',
        response: { 200: adminProviderStatusSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requirePlatformAdmin(request);
      return getAdminProviderStatus(domain);
    },
  );

  typed.get(
    '/admin/storage',
    {
      schema: {
        tags: ['admin'],
        summary: '存储用量（按 Workspace Top-N + 总量）',
        querystring: z.object({ limit: z.coerce.number().int().positive().max(100).optional() }),
        response: { 200: adminStorageSummarySchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requirePlatformAdmin(request);
      return getAdminStorageSummary(domain, { ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}) });
    },
  );

  typed.get(
    '/admin/workspaces/:workspaceId/credits',
    {
      schema: {
        tags: ['admin'],
        summary: '指定 Workspace 的 Credits 账单（平台视图）',
        params: workspaceParamsSchema,
        response: { 200: creditStatementSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requirePlatformAdmin(request);
      return getCreditStatement(domain, { workspaceId: request.params.workspaceId });
    },
  );

  /* ---------- 运营审计表（audit_log） ---------- */

  typed.get(
    '/admin/audit-log',
    {
      schema: {
        tags: ['admin'],
        summary: '运营审计（append-only；平台管理动作 + 系统安全事件）',
        querystring: z.object({
          workspaceId: opaqueIdSchema.optional(),
          action: z.string().max(80).optional(),
          limit: z.coerce.number().int().positive().max(500).optional(),
        }),
        response: { 200: z.object({ items: z.array(auditLogEntrySchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requirePlatformAdmin(request);
      const items = await listAuditLog(domain, {
        ...(request.query.workspaceId !== undefined ? { workspaceId: request.query.workspaceId } : {}),
        ...(request.query.action !== undefined ? { action: request.query.action } : {}),
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
      return { items };
    },
  );

  /* ---------- 滥用处理 ---------- */

  typed.get(
    '/admin/abuse-flags',
    {
      schema: {
        tags: ['admin'],
        summary: '滥用/审核标记列表（按 Workspace/状态）',
        querystring: z.object({
          workspaceId: opaqueIdSchema.optional(),
          status: z.enum(['OPEN', 'RESOLVED']).optional(),
          limit: z.coerce.number().int().positive().max(500).optional(),
        }),
        response: { 200: z.object({ items: z.array(abuseFlagSchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requirePlatformAdmin(request);
      const items = await listAbuseFlags(domain, {
        ...(request.query.workspaceId !== undefined ? { workspaceId: request.query.workspaceId } : {}),
        ...(request.query.status !== undefined ? { status: request.query.status } : {}),
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
      return { items };
    },
  );

  typed.post(
    '/admin/workspaces/:workspaceId/abuse-flags',
    {
      schema: {
        tags: ['admin'],
        summary: '创建滥用标记（调查载体；审计 abuse.flag.create）',
        params: workspaceParamsSchema,
        body: createAbuseFlagRequestSchema,
        response: { 201: abuseFlagSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { context } = await app.requirePlatformAdmin(request);
      const flag = await createAbuseFlag(domain, { workspaceId: request.params.workspaceId, request: request.body, actorUserId: context.userId });
      return reply.status(201).send(flag);
    },
  );

  typed.post(
    '/admin/abuse-flags/:flagId/resolve',
    {
      schema: {
        tags: ['admin'],
        summary: '解决滥用标记（审计 abuse.flag.resolve）',
        params: flagParamsSchema,
        body: resolveAbuseFlagRequestSchema,
        response: { 200: abuseFlagSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requirePlatformAdmin(request);
      return resolveAbuseFlag(domain, { flagId: request.params.flagId, request: request.body, actorUserId: context.userId });
    },
  );

  typed.post(
    '/admin/workspaces/:workspaceId/abuse-state',
    {
      schema: {
        tags: ['admin'],
        summary: '设置工作区限制状态（RESTRICTED = 阻止新的成本性任务；审计 abuse.state.set）',
        params: workspaceParamsSchema,
        body: setWorkspaceAbuseStateRequestSchema,
        response: { 200: z.object({ workspaceId: opaqueIdSchema, abuseState: workspaceAbuseStateSchema }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requirePlatformAdmin(request);
      return setWorkspaceAbuseState(domain, { workspaceId: request.params.workspaceId, request: request.body, actorUserId: context.userId });
    },
  );

  /* ---------- 支持工具（不可无痕） ---------- */

  typed.get(
    '/admin/workspaces/:workspaceId/support-grants',
    {
      schema: {
        tags: ['admin'],
        summary: '支持访问授权列表（ACTIVE/REVOKED/EXPIRED 推导）',
        params: workspaceParamsSchema,
        response: { 200: z.object({ items: z.array(supportAccessGrantSchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requirePlatformAdmin(request);
      const items = await listSupportGrants(domain, { workspaceId: request.params.workspaceId });
      return { items };
    },
  );

  typed.post(
    '/admin/workspaces/:workspaceId/support-grants',
    {
      schema: {
        tags: ['admin'],
        summary: '创建支持访问授权（时限 ≤ 24h；审计 + **工作区可见事件**——不可无痕）',
        params: workspaceParamsSchema,
        body: createSupportGrantRequestSchema,
        response: { 201: supportAccessGrantSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { context } = await app.requirePlatformAdmin(request);
      const grant = await createSupportGrant(domain, { workspaceId: request.params.workspaceId, request: request.body, actorUserId: context.userId });
      return reply.status(201).send(grant);
    },
  );

  typed.post(
    '/admin/support-grants/:grantId/revoke',
    {
      schema: {
        tags: ['admin'],
        summary: '撤销支持访问授权（审计 support.grant.revoke）',
        params: grantParamsSchema,
        response: { 200: supportAccessGrantSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requirePlatformAdmin(request);
      return revokeSupportGrant(domain, { grantId: request.params.grantId, actorUserId: context.userId });
    },
  );

  typed.get(
    '/admin/workspaces/:workspaceId/support-view',
    {
      schema: {
        tags: ['admin'],
        summary: '支持视图（**需有效授权**；仅元数据摘要；每次访问留痕 + 工作区可见事件）',
        params: workspaceParamsSchema,
        response: { 200: supportViewSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requirePlatformAdmin(request);
      return getSupportView(domain, { workspaceId: request.params.workspaceId, actorUserId: context.userId });
    },
  );
}
