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

export function useAdminJobs(status?: 'FAILED_RETRYABLE' | 'FAILED_FINAL' | 'RUNNING' | 'QUEUED') {
  const client = useAncsClient();
  return useQuery({
    queryKey: ['admin', 'jobs', status ?? 'all'],
    queryFn: () => client.admin.jobs({ ...(status === undefined ? {} : { status }), limit: 50 }),
    retry: false,
    refetchInterval: 10000,
  });
}

export function useAdminAudit() {
  const client = useAncsClient();
  return useQuery({ queryKey: ['admin', 'audit'], queryFn: () => client.admin.audit({ limit: 50 }), retry: false, refetchInterval: 15000 });
}
