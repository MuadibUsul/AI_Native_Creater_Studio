'use client';

import { useState } from 'react';
import { describeError } from '@/lib/errors';
import { useAdminAudit, useAdminJobs, useAdminOverview } from '@/lib/queries';
import { StateBlock } from '@/ui/StateBlock';
import { SecurityOps } from '@/ui/SecurityOps';
import { OpsEnrollmentPanel, OpsSessionPanel } from '@/ui/OpsSessionPanel';
import styles from '@/components/quiet-frame/legacy.module.css';

/**
 * 最小运营界面（P08-02 / §67）：`/admin`
 * - 仅独立运营 principal 的已验证会话可见；非管理员/未登录 → 无权限块。
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
  const overview = useAdminOverview();
  const [workspaceDraft, setWorkspaceDraft] = useState('');
  const [jobWorkspaceId, setJobWorkspaceId] = useState('');
  const failed = useAdminJobs(jobWorkspaceId, 'FAILED_FINAL');
  const retryable = useAdminJobs(jobWorkspaceId, 'FAILED_RETRYABLE');
  const audit = useAdminAudit();

  const denied = overview.isError && (overview.error as { status?: number } | null)?.status === 404;
  const unauthenticated = overview.isError && (overview.error as { status?: number } | null)?.status === 401;
  if (denied || unauthenticated) {
    return (
      <section className={`page ${styles['surface']} flex flex-col gap-4`}>
        <div className="eyebrow">PLATFORM / OPERATIONS</div><h1>运营</h1>
        <StateBlock
          variant="info"
          title={unauthenticated ? '需要登录' : '需要运营身份与多因素验证'}
          description="运营权限与普通工作区角色分离；已获授权的人员需先配置验证器，再重新登录。"
        />
        {!unauthenticated ? <OpsEnrollmentPanel /> : null}
      </section>
    );
  }

  return (
    <section className={`page ${styles['surface']} flex flex-col gap-4`}>
      <div className="eyebrow">PLATFORM / OPERATIONS</div><h1>运营</h1>
      <OpsSessionPanel />

      {overview.isPending ? <p className="text-sm text-slate-400">正在加载运营总览…</p> : null}
      {overview.isError ? <StateBlock variant="error" title="运营总览加载失败" description={describeError(overview.error).message} action={{ label: '重试', onClick: () => void overview.refetch() }} /> : null}
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
          {overview.data.alerts.length > 0 ? (
            <ul data-testid="ops-alerts" className="flex flex-col gap-1">
              {overview.data.alerts.map((alert) => (
                <li key={alert.id} className={alert.severity === 'CRITICAL' ? 'text-xs text-rose-300' : 'text-xs text-amber-300'}>
                  [{alert.severity}] {alert.summary}（值 {alert.value} / 阈值 {alert.threshold}）
                </li>
              ))}
            </ul>
          ) : null}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <StatusGrid title="任务状态" counts={overview.data.jobs.byStatus} testId="ops-jobs" />
            <StatusGrid title="渲染状态" counts={overview.data.renders.byStatus} testId="ops-renders" />
          </div>
        </>
      ) : null}

      <div className="rounded border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold text-slate-300">失败任务</h2>
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); setJobWorkspaceId(workspaceDraft.trim()); }}>
          <label className="flex flex-col gap-1 text-xs text-slate-400">工作区 ID
            <input className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" value={workspaceDraft} onChange={(event) => setWorkspaceDraft(event.target.value)} autoComplete="off" spellCheck={false} required />
          </label>
          <button type="submit" className="rounded border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:border-slate-500">查看任务</button>
        </form>
        {jobWorkspaceId === '' ? <p className="mt-2 text-xs text-slate-500">输入获授权的工作区 ID 后查看任务。</p> : null}
        {jobWorkspaceId !== '' && (failed.isPending || retryable.isPending) ? <p className="mt-2 text-sm text-slate-400">正在加载…</p> : null}
        {jobWorkspaceId !== '' && (failed.isError || retryable.isError) ? <p role="alert" className="mt-2 text-sm text-rose-300">失败任务加载失败：{describeError(failed.error ?? retryable.error).message} <button type="button" className="textbtn small" onClick={() => { void failed.refetch(); void retryable.refetch(); }}>重试</button></p> : null}
        {jobWorkspaceId !== '' && failed.data !== undefined && retryable.data !== undefined ? (
          <ul data-testid="ops-failed-jobs" className="mt-2 flex flex-col gap-2">
            {[...failed.data, ...retryable.data].slice(0, 20).map((job) => (
              <li key={job.id} className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                <span className={job.status === 'FAILED_FINAL' ? 'text-rose-300' : 'text-amber-300'}>{job.status}</span>
                <span className="font-mono text-slate-300">{job.id}</span>
                <span>尝试 {job.attempts}/{job.maxAttempts}</span>
                <span className="text-slate-500">{job.errorCategory}</span>
              </li>
            ))}
            {failed.data.length === 0 && retryable.data.length === 0 ? <li className="text-slate-500">无失败任务。</li> : null}
          </ul>
        ) : null}
        <p className="mt-2 text-xs text-slate-500">此处只提供工作区范围的任务摘要；人工操作入口将在审批流程完成后开放。</p>
      </div>

      <div className="rounded border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold text-slate-300">审计（job 事件 / 渲染迁移 / 审批）</h2>
        {audit.isPending ? <p className="mt-2 text-sm text-slate-400">正在加载…</p> : null}
        {audit.isError ? <p role="alert" className="mt-2 text-sm text-rose-300">审计记录加载失败：{describeError(audit.error).message} <button type="button" className="textbtn small" onClick={() => void audit.refetch()}>重试</button></p> : null}
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

      {/* P09-05：安全运营面板（完整 Admin / 滥用处理 / 支持工具 / 运营审计表） */}
      <SecurityOps />
    </section>
  );
}
