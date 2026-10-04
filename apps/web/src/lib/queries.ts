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
