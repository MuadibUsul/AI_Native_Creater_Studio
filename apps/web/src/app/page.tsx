'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useSession, useWorkspaces } from '@/lib/queries';
import { StateBlock } from '@/ui/StateBlock';

/**
 * Dashboard（P05-03）：工作区/项目列表 + 创建入口。
 * 状态矩阵：加载 / 未登录 / 失败 / 空（工作区或项目）/ 正常。
 */

export default function DashboardPage() {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const session = useSession();
  const workspaces = useWorkspaces();
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [projectTitle, setProjectTitle] = useState('');

  const effectiveWorkspaceId = activeWorkspaceId ?? workspaces.data?.[0]?.id ?? null;

  const projects = useQuery({
    queryKey: queryKeys.projects(effectiveWorkspaceId ?? 'none'),
    queryFn: () => client.projects.list(effectiveWorkspaceId ?? ''),
    enabled: effectiveWorkspaceId !== null,
  });

  const createWorkspace = useMutation({
    mutationFn: (name: string) => client.workspaces.create({ name }),
    onSuccess: (workspace) => {
      setActiveWorkspaceId(workspace.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });

  const createProject = useMutation({
    mutationFn: async (title: string) => {
      const workspaceId = effectiveWorkspaceId ?? '';
      const channels = await client.channels.list(workspaceId);
      const channel = channels[0] ?? (await client.channels.create(workspaceId, { name: '默认栏目' }));
      return client.projects.create(workspaceId, { title, channelId: channel.id });
    },
    onSuccess: () => {
      setProjectTitle('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects(effectiveWorkspaceId ?? 'none') });
    },
  });

  if (session.isPending || workspaces.isPending) {
    return <StateBlock variant="loading" title="正在加载工作区…" />;
  }
  if (session.isError && describeError(session.error).kind === 'unauthenticated') {
    return (
      <StateBlock
        variant="unauthenticated"
        title="需要登录"
        description="Creator Studio 需要会话登录后访问（Web 会话 Cookie）。"
        action={{ label: '前往登录', onClick: () => { window.location.href = '/sign-in'; } }}
      />
    );
  }
  if (workspaces.isError) {
    const described = describeError(workspaces.error);
    return (
      <StateBlock
        variant={described.kind === 'unauthenticated' ? 'unauthenticated' : described.kind === 'unavailable' ? 'unavailable' : 'error'}
        title="加载工作区失败"
        description={described.message}
        diagnostics={described.code ?? undefined}
        action={{ label: '重试', onClick: () => void workspaces.refetch() }}
      />
    );
  }

  return (
    <main className="flex flex-col gap-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">ANCS · Creator Studio</h1>
        <span className="text-sm text-slate-400">Article → Professional Long Video（V1）</span>
      </header>

      {(workspaces.data ?? []).length === 0 ? (
        <StateBlock
          variant="empty"
          title="还没有工作区"
          description="工作区是项目、预算与成员的边界。"
        >
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (workspaceName.trim() !== '') createWorkspace.mutate(workspaceName.trim());
            }}
          >
            <input
              aria-label="工作区名称"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="例如：财经观察"
              className="rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
            />
            <button type="submit" className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500">
              创建工作区
            </button>
          </form>
        </StateBlock>
      ) : (
        <section className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-400" htmlFor="workspace-select">
              工作区
            </label>
            <select
              id="workspace-select"
              value={effectiveWorkspaceId ?? ''}
              onChange={(event) => setActiveWorkspaceId(event.target.value)}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
            >
              {(workspaces.data ?? []).map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </div>

          {projects.isPending ? <StateBlock variant="loading" title="正在加载项目…" /> : null}
          {projects.isError ? (
            <StateBlock
              variant={describeError(projects.error).kind === 'forbidden' ? 'forbidden' : 'error'}
              title="加载项目失败"
              description={describeError(projects.error).message}
              action={{ label: '重试', onClick: () => void projects.refetch() }}
            />
          ) : null}

          {projects.data !== undefined && projects.data.length === 0 ? (
            <StateBlock variant="empty" title="该工作区还没有项目" description="创建第一个项目开始：导入文章 → 生成叙事 → 分镜 → 编辑。">
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (projectTitle.trim() !== '') createProject.mutate(projectTitle.trim());
                }}
              >
                <input
                  aria-label="项目标题"
                  value={projectTitle}
                  onChange={(event) => setProjectTitle(event.target.value)}
                  placeholder="例如：利率周报视频"
                  className="rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
                />
                <button type="submit" disabled={createProject.isPending} className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">
                  创建项目
                </button>
              </form>
              {createProject.isError ? (
                <p className="text-xs text-rose-300">{describeError(createProject.error).message}</p>
              ) : null}
            </StateBlock>
          ) : null}

          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {(projects.data ?? []).map((project) => (
              <li key={project.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                <Link className="text-base font-medium text-sky-300 hover:underline" href={`/w/${effectiveWorkspaceId ?? ''}/p/${project.id}/script`}>
                  {project.title}
                </Link>
                <p className="mt-1 text-xs text-slate-400">
                  状态 {project.status} · revision {project.revision} · {project.aspectRatio} · {project.fps}fps
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
