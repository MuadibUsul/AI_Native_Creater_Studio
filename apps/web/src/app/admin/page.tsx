'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAncsClient } from '@/lib/client';
import { useAdminAudit, useAdminJobs, useAdminOverview } from '@/lib/queries';
import { StateBlock } from '@/ui/StateBlock';

/**
 * 最小运营界面（P08-02 / §67）：`/admin`
 * - 仅**平台管理员**可见（部署配置 ANCS_PLATFORM_ADMINS；非管理员/未登录 → 无权限块——不显示任何运营数据）；
 * - 队列与失败任务（人工重试：复用任务服务，预算/幂等/版本规则不变）、成本、Provider 生成状态、
 *   QA/审批概览、审计视图（job 事件 + 渲染迁移 + 审批）。
 */

const STATUS_ORDER = ['QUEUED', 'WAITING_DEPENDENCY', 'RUNNING', 'PROVIDER_QUEUED', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCEL_REQUESTED', 'CANCELLED'] as const;

function StatusGrid({ title, counts, testId }: { title: string; counts: Record<string, number>; testId: string }) {
  const keys = [...new Set([...STATUS_ORDER.filter((status) => counts[status] !== undefined), ...Object.keys(counts)])];
  return (
    <div data-testid={testId} className="rounded border border-slate-800 bg-slate-900/60 p-3">
      <h3 className="text-xs font-semibold text-slate-300">{title}</h3>
      <ul className="mt-2 grid grid-cols-2 gap-1 text-xs text-slate-400">
        {keys.length === 0 ? <li className="col-span-2 text-slate-500">无数据</li> : null}
        {keys.map((key) => (
          <li key={key} className="flex justify-between gap-2">
            <span className="font-mono">{key}</span>
            <span className="text-slate-200">{counts[key]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function AdminPage() {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const overview = useAdminOverview();
  const failed = useAdminJobs('FAILED_FINAL');
  const retryable = useAdminJobs('FAILED_RETRYABLE');
  const audit = useAdminAudit();
  const [notice, setNotice] = useState<string | null>(null);

  const retry = useMutation({
    mutationFn: (jobId: string) => client.admin.retryJob(jobId, { reason: '运营人工重试' }),
    onSuccess: async (job) => {
      setNotice(`任务 ${job.id} 已重新入队（QUEUED）——仍受预算/幂等/版本规则约束。`);
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (error: unknown) => setNotice(`重试失败：${error instanceof Error ? error.message : '未知错误'}`),
  });

  const denied = overview.isError && (overview.error as { status?: number } | null)?.status === 404;
  const unauthenticated = overview.isError && (overview.error as { status?: number } | null)?.status === 401;
  if (denied || unauthenticated) {
    return (
      <section className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">运营</h1>
        <StateBlock
          variant="info"
          title={unauthenticated ? '需要登录' : '无权限访问（或不存在）'}
          description="运营面无公开入口：仅部署配置中登记的平台管理员可访问（普通用户角色不适用）。"
        />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">运营</h1>
      {notice !== null ? <p className="text-xs text-amber-300">{notice}</p> : null}

      {overview.isPending ? <p className="text-sm text-slate-400">正在加载运营总览…</p> : null}
      {overview.data !== undefined ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div data-testid="ops-summary" className="rounded border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-400">
              <h3 className="font-semibold text-slate-300">队列健康</h3>
              <p className="mt-2">待重试失败：<span className="text-slate-200">{overview.data.jobs.failedRetryable}</span></p>
              <p>终态失败：<span className="text-rose-300">{overview.data.jobs.failedFinal}</span></p>
              <p>需对账：<span className="text-amber-300">{overview.data.jobs.needsReconciliation}</span></p>
              <p>最老在途：<span className="text-slate-200">{overview.data.jobs.oldestActiveAgeSeconds === null ? '—' : `${String(overview.data.jobs.oldestActiveAgeSeconds)}s`}</span></p>
            </div>
            <div data-testid="ops-cost" className="rounded border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-400">
              <h3 className="font-semibold text-slate-300">成本（Credits）</h3>
              <p className="mt-2">DEBIT 合计：<span className="text-slate-200">{overview.data.spend.debitsTotal}</span></p>
              <p>有账本租户：<span className="text-slate-200">{overview.data.spend.workspacesWithLedger}</span></p>
            </div>
            <div data-testid="ops-qa" className="rounded border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-400">
              <h3 className="font-semibold text-slate-300">QA / 审批（24h）</h3>
              <p className="mt-2">QA 通过：<span className="text-emerald-300">{overview.data.qa.last24hPass}</span></p>
              <p>QA 未过：<span className="text-rose-300">{overview.data.qa.last24hFail}</span></p>
              <p>已批准：<span className="text-slate-200">{overview.data.approvals.approved}</span> · 驳回：<span className="text-slate-200">{overview.data.approvals.rejected}</span></p>
            </div>
            <StatusGrid title="Provider 生成" counts={overview.data.providerGenerations.byStatus} testId="ops-provider" />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <StatusGrid title="任务状态" counts={overview.data.jobs.byStatus} testId="ops-jobs" />
            <StatusGrid title="渲染状态" counts={overview.data.renders.byStatus} testId="ops-renders" />
          </div>
        </>
      ) : null}

      <div className="rounded border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold text-slate-300">失败任务（人工恢复）</h2>
        {failed.isPending || retryable.isPending ? <p className="mt-2 text-sm text-slate-400">正在加载…</p> : null}
        {failed.data !== undefined && retryable.data !== undefined ? (
          <ul data-testid="ops-failed-jobs" className="mt-2 flex flex-col gap-2">
            {[...failed.data, ...retryable.data].slice(0, 20).map((job) => (
              <li key={job.id} className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                <span className={job.status === 'FAILED_FINAL' ? 'text-rose-300' : 'text-amber-300'}>{job.status}</span>
                <span className="font-mono text-slate-300">{job.type}</span>
                <span>尝试 {job.attempts}/{job.maxAttempts}</span>
                <span className="text-slate-500">{String((job.error as Record<string, unknown> | null)?.['reason'] ?? '')}</span>
                <button
                  type="button"
                  className="rounded border border-slate-700 px-2 py-0.5 text-slate-200 hover:border-slate-500"
                  onClick={() => retry.mutate(job.id)}
                  disabled={retry.isPending}
                >
                  重试
                </button>
              </li>
            ))}
            {failed.data.length === 0 && retryable.data.length === 0 ? <li className="text-slate-500">无失败任务。</li> : null}
          </ul>
        ) : null}
        <p className="mt-2 text-xs text-slate-500">人工重试经统一任务服务：预算、幂等与版本规则不变（§67）。</p>
      </div>

      <div className="rounded border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold text-slate-300">审计（job 事件 / 渲染迁移 / 审批）</h2>
        {audit.isPending ? <p className="mt-2 text-sm text-slate-400">正在加载…</p> : null}
        {audit.data !== undefined ? (
          <ul data-testid="ops-audit" className="mt-2 flex flex-col gap-1 font-mono text-xs text-slate-400">
            {audit.data.slice(0, 20).map((entry) => (
              <li key={entry.id} className="truncate">
                <span className="text-slate-500">{entry.at.slice(0, 19).replace('T', ' ')}</span> · <span className="text-slate-300">{entry.kind}</span> · {entry.summary}
              </li>
            ))}
            {audit.data.length === 0 ? <li className="text-slate-500">无审计记录。</li> : null}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
