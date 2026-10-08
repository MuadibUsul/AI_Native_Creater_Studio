'use client';

import { useQuery } from '@tanstack/react-query';
import { useAncsClient } from './client';

/**
 * 服务端状态查询（计划 §3.1：TanStack Query 承载服务端状态，不复制到独立权威状态库）。
 * 所有查询只读；写入一律经 SDK 方法与编辑协议（含幂等键与 revision 条件）。
 */

export const queryKeys = {
  session: ['session'] as const,
  workspaces: ['workspaces'] as const,
  projects: (workspaceId: string) => ['workspaces', workspaceId, 'projects'] as const,
  narrative: (workspaceId: string, projectId: string) => ['projects', projectId, 'narrative', workspaceId] as const,
  graph: (workspaceId: string, projectId: string) => ['projects', projectId, 'graph', workspaceId] as const,
  assets: (workspaceId: string, projectId: string) => ['projects', projectId, 'assets', workspaceId] as const,
  events: (workspaceId: string) => ['workspaces', workspaceId, 'events'] as const,
  versions: (projectId: string) => ['projects', projectId, 'versions'] as const,
  directorPlan: (workspaceId: string, projectId: string, planId: string) =>
    ['projects', projectId, 'director-plan', workspaceId, planId] as const,
  renders: (workspaceId: string, projectId: string) => ['projects', projectId, 'renders', workspaceId] as const,
  renderQa: (workspaceId: string, renderId: string) => ['renders', renderId, 'qa', workspaceId] as const,
  renderPrecheck: (projectId: string) => ['projects', projectId, 'render-precheck'] as const,
  renderApproval: (workspaceId: string, renderId: string) => ['renders', renderId, 'approval', workspaceId] as const,
};

export function useSession() {
  const client = useAncsClient();
  return useQuery({ queryKey: queryKeys.session, queryFn: () => client.auth.session(), retry: false });
}

export function useWorkspaces() {
  const client = useAncsClient();
  return useQuery({ queryKey: queryKeys.workspaces, queryFn: () => client.workspaces.list() });
}

export function useProjects(workspaceId: string) {
  const client = useAncsClient();
  return useQuery({ queryKey: queryKeys.projects(workspaceId), queryFn: () => client.projects.list(workspaceId) });
}

export function useNarrative(workspaceId: string, projectId: string) {
  const client = useAncsClient();
  return useQuery({
    queryKey: queryKeys.narrative(workspaceId, projectId),
    queryFn: () => client.narrative.current(workspaceId, projectId),
  });
}

export function useSceneGraph(workspaceId: string, projectId: string) {
  const client = useAncsClient();
  return useQuery({ queryKey: queryKeys.graph(workspaceId, projectId), queryFn: () => client.projects.graph(projectId) });
}

export function useAssets(workspaceId: string, projectId: string) {
  const client = useAncsClient();
  return useQuery({ queryKey: queryKeys.assets(workspaceId, projectId), queryFn: () => client.assets.list(workspaceId, { projectId }) });
}

export function useWorkspaceEvents(workspaceId: string) {
  const client = useAncsClient();
  return useQuery({
    queryKey: queryKeys.events(workspaceId),
    queryFn: () => client.events.list(workspaceId, { cursor: 0, limit: 50 }),
  });
}

export function useProjectVersions(projectId: string) {
  const client = useAncsClient();
  return useQuery({ queryKey: queryKeys.versions(projectId), queryFn: () => client.projects.versions.list(projectId) });
}

/** 渲染列表（P07-05 审核界面：新→旧） */
export function useRenders(workspaceId: string, projectId: string) {
  const client = useAncsClient();
  return useQuery({
    queryKey: queryKeys.renders(workspaceId, projectId),
    queryFn: () => client.renders.list(workspaceId, projectId),
    refetchInterval: 5000, // 渲染/QA 在途时轮询（队列状态可视化）
  });
}

/** 最新 QA 报告（P07-05；仅在该 Render 已生成报告时非空） */
export function useRenderQaReport(workspaceId: string, renderId: string | null) {
  const client = useAncsClient();
  return useQuery({
    queryKey: queryKeys.renderQa(workspaceId, renderId ?? 'none'),
    enabled: renderId !== null,
    queryFn: () => client.renders.qaReport(workspaceId, renderId as string),
  });
}

/** 最新审批记录（P07-06；未审批 → null） */
export function useRenderApproval(workspaceId: string, renderId: string | null) {
  const client = useAncsClient();
  return useQuery({
    queryKey: queryKeys.renderApproval(workspaceId, renderId ?? 'none'),
    enabled: renderId !== null,
    queryFn: () => client.renders.approval(workspaceId, renderId as string),
  });
}

/** 运营总览（P08-02；仅平台管理员——非管理员 404 由页面呈现为无权限） */
export function useAdminOverview() {
  const client = useAncsClient();
  return useQuery({ queryKey: ['admin', 'overview'], queryFn: () => client.admin.overview(), retry: false, refetchInterval: 10000 });
}

export function useAdminJobs(workspaceId: string, status?: 'FAILED_RETRYABLE' | 'FAILED_FINAL' | 'RUNNING' | 'QUEUED') {
  const client = useAncsClient();
  return useQuery({
    queryKey: ['admin', 'jobs', workspaceId, status ?? 'all'],
    queryFn: () => client.admin.jobs({ workspaceId, ...(status === undefined ? {} : { status }), limit: 50 }),
    enabled: workspaceId !== '',
    retry: false,
    refetchInterval: 10000,
  });
}

export function useAdminAudit() {
  const client = useAncsClient();
  return useQuery({ queryKey: ['admin', 'audit'], queryFn: () => client.admin.audit({ limit: 50 }), retry: false, refetchInterval: 15000 });
}

/** Credits 账单（P09-03：余额 + 预扣 + 明细；只读） */
export function useCreditStatement(workspaceId: string) {
  const client = useAncsClient();
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'credits'],
    queryFn: () => client.workspaces.creditStatement(workspaceId),
    refetchInterval: 15000,
  });
}

/** Credits 包目录（P09-03：版本化；价格为数据） */
export function useCreditPacks(workspaceId: string) {
  const client = useAncsClient();
  return useQuery({ queryKey: ['workspaces', workspaceId, 'credit-packs'], queryFn: () => client.workspaces.creditPacks(workspaceId) });
}

/** 收款状态（P09-02：订阅状态 + 事件审计；Credits 页展示套餐上下文） */
export function useBilling(workspaceId: string) {
  const client = useAncsClient();
  return useQuery({ queryKey: ['workspaces', workspaceId, 'billing'], queryFn: () => client.workspaces.billing(workspaceId), refetchInterval: 15000 });
}

/** Plan 权益与用量（P09-01；P09-03 账单页展示存储/席位用量） */
export function useEntitlements(workspaceId: string) {
  const client = useAncsClient();
  return useQuery({ queryKey: ['workspaces', workspaceId, 'entitlements'], queryFn: () => client.workspaces.entitlements(workspaceId) });
}

/** Workspace 详情（含我的角色与隐私档位；P09-04 团队页） */
export function useWorkspace(workspaceId: string) {
  const client = useAncsClient();
  return useQuery({ queryKey: ['workspaces', workspaceId, 'detail'], queryFn: () => client.workspaces.get(workspaceId) });
}

/** 成员列表（P09-04） */
export function useWorkspaceMembers(workspaceId: string) {
  const client = useAncsClient();
  return useQuery({ queryKey: ['workspaces', workspaceId, 'members'], queryFn: () => client.workspaces.members.list(workspaceId) });
}

/** 邀请列表（P09-04；需 member:manage——非管理角色 403 由页面呈现） */
export function useWorkspaceInvitations(workspaceId: string) {
  const client = useAncsClient();
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'invitations'],
    queryFn: () => client.workspaces.invitations.list(workspaceId),
    retry: false,
  });
}

/* ---------- P09-05 SaaS 安全运营（/admin） ---------- */

export function useAdminUsers(query: string) {
  const client = useAncsClient();
  return useQuery({ queryKey: ['admin', 'users', query], queryFn: () => client.admin.users({ query, limit: 20 }), retry: false });
}

export function useAdminWorkspaces(query: string) {
  const client = useAncsClient();
  return useQuery({ queryKey: ['admin', 'workspaces', query], queryFn: () => client.admin.workspaces({ query, limit: 20 }), retry: false });
}

export function useAdminAbuseFlags() {
  const client = useAncsClient();
  return useQuery({ queryKey: ['admin', 'abuse-flags'], queryFn: () => client.admin.abuseFlags({ limit: 50 }), retry: false, refetchInterval: 15000 });
}

export function useAdminProjects(workspaceId: string, sessionId: string, request: number) {
  const client = useAncsClient();
  return useQuery({
    queryKey: ['admin', 'projects', sessionId, workspaceId, request],
    queryFn: () => client.admin.projects({ workspaceId, limit: 50 }),
    enabled: workspaceId !== '' && sessionId !== '',
    retry: false,
    gcTime: 0,
  });
}

export function useAdminStorage(workspaceId: string, sessionId: string, request: number) {
  const client = useAncsClient();
  return useQuery({
    queryKey: ['admin', 'storage', sessionId, workspaceId, request],
    queryFn: () => client.admin.storage({ workspaceId }),
    enabled: workspaceId !== '' && sessionId !== '',
    retry: false,
    gcTime: 0,
  });
}

export function useAdminProviderStatus() {
  const client = useAncsClient();
  return useQuery({ queryKey: ['admin', 'provider-status'], queryFn: () => client.admin.providerStatus(), retry: false });
}

export function useAdminOpsAuditLog() {
  const client = useAncsClient();
  return useQuery({ queryKey: ['admin', 'audit-log'], queryFn: () => client.admin.auditLog({ limit: 50 }), retry: false, refetchInterval: 15000 });
}

export function useAdminSupportGrants(workspaceId: string, ticketId: string, sessionId: string, request: number) {
  const client = useAncsClient();
  return useQuery({
    queryKey: ['admin', 'support-grants', sessionId, workspaceId, ticketId, request],
    queryFn: () => client.admin.supportGrants(workspaceId, ticketId),
    enabled: workspaceId !== '' && ticketId !== '' && sessionId !== '',
    retry: false,
    gcTime: 0,
  });
}
