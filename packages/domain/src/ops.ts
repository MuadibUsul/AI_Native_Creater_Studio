import { and, count, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { opsAuditEntrySchema, opsJobSummarySchema, opsOverviewSchema, type Job, type JobStatus, type OpsAuditEntry, type OpsJobSummary, type OpsOverview } from '@ancs/contracts';
import { creditLedger, jobs, outboxEvents, providerGenerations, renderApprovals, renderEvents, renderQaReports, renders } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { loadJobRow, retryJob } from './jobs.js';

/**
 * 最小运营服务（P08-02 / 规范 §67）。
 *
 * - **只读聚合**（overview）与**跨 workspace 任务查询**（admin 面，普通用户无入口——守卫在 API 层）；
 * - **人工重试 = 复用既有任务服务** `retryJob`（预算/幂等/版本规则不变；审计经 job 事件）；
 * - 审计视图 = 既有审计来源的合并（job.* Outbox 事件 + render_events + 审批）——
 *   V1 不新建 audit_log 表（§24 的"Intent History 与 Audit Log 分离"由 edit_events（意图）与
 *   系统事件/审批（审计）两侧承担；如需独立审计表，P08-03 评估）。
 */

export async function getOpsOverview(deps: DomainDeps): Promise<OpsOverview> {
  const countBy = async (rows: { status: string | null; total: number }[]): Promise<Record<string, number>> => {
    const result: Record<string, number> = {};
    for (const row of rows) result[row.status ?? 'UNKNOWN'] = Number(row.total);
    return result;
  };

  const [jobRows, renderRows, qaRows, approvalRows, generationRows, spendRows, oldestRow] = await Promise.all([
    deps.db.select({ status: jobs.status, total: count() }).from(jobs).groupBy(jobs.status),
    deps.db.select({ status: renders.status, total: count() }).from(renders).groupBy(renders.status),
    deps.db
      .select({ verdict: renderQaReports.verdict, total: count() })
      .from(renderQaReports)
      .where(gte(renderQaReports.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)))
      .groupBy(renderQaReports.verdict),
    deps.db.select({ decision: renderApprovals.decision, total: count() }).from(renderApprovals).groupBy(renderApprovals.decision),
    deps.db.select({ status: providerGenerations.status, total: count() }).from(providerGenerations).groupBy(providerGenerations.status),
    deps.db.select({ entryType: creditLedger.entryType, total: sql<number>`coalesce(sum(${creditLedger.amount}), 0)`, workspaces: sql<number>`count(distinct ${creditLedger.workspaceId})` }).from(creditLedger).groupBy(creditLedger.entryType),
    deps.db
      .select({ startedAt: sql<Date | null>`min(${jobs.startedAt})` })
      .from(jobs)
      .where(inArray(jobs.status, ['RUNNING', 'PROVIDER_QUEUED'])),
  ]);

  const jobsByStatus = await countBy(jobRows);
  const rendersByStatus = await countBy(renderRows);
  const generationsByStatus = await countBy(generationRows);
  const qaPass = Number(qaRows.find((row) => row.verdict === 'PASS')?.total ?? 0);
  const qaFail = Number(qaRows.find((row) => row.verdict === 'FAIL')?.total ?? 0);
  const approved = Number(approvalRows.find((row) => row.decision === 'APPROVED')?.total ?? 0);
  const rejected = Number(approvalRows.find((row) => row.decision === 'REJECTED')?.total ?? 0);
  const debitsTotal = Number(spendRows.find((row) => row.entryType === 'DEBIT')?.total ?? 0);
  const workspacesWithLedger = Number(spendRows[0]?.workspaces ?? 0);
  const oldestStartedAt = oldestRow[0]?.startedAt ?? null;
  const oldestAge = oldestStartedAt === null ? null : Math.max(0, Math.floor((Date.now() - new Date(oldestStartedAt).getTime()) / 1000));

  const reconciliationRows = await deps.db.select({ total: count() }).from(jobs).where(eq(jobs.needsReconciliation, true));

  const overview = opsOverviewSchema.parse({
    generatedAt: new Date().toISOString(),
    jobs: {
      byStatus: jobsByStatus,
      failedRetryable: jobsByStatus['FAILED_RETRYABLE'] ?? 0,
      failedFinal: jobsByStatus['FAILED_FINAL'] ?? 0,
      needsReconciliation: Number(reconciliationRows[0]?.total ?? 0),
      oldestActiveAgeSeconds: oldestAge,
    },
    renders: { byStatus: rendersByStatus },
    qa: { last24hPass: qaPass, last24hFail: qaFail },
    approvals: { approved, rejected },
    providerGenerations: { byStatus: generationsByStatus },
    spend: { debitsTotal, workspacesWithLedger },
    alerts: [],
  });
  // 告警为同一份总览的纯派生（阈值见 OPS_ALERT_THRESHOLDS；运行手册同步列出）
  return opsOverviewSchema.parse({ ...overview, alerts: evaluateOpsAlerts(overview) });
}

/** Scoped, allowlisted Admin job view; tenant filtering happens before LIMIT. */
export async function listOpsJobs(
  deps: DomainDeps,
  input: { workspaceId: string; status?: JobStatus; limit?: number },
): Promise<OpsJobSummary[]> {
  const conditions = [eq(jobs.workspaceId, input.workspaceId)];
  if (input.status !== undefined) conditions.push(eq(jobs.status, input.status));
  const rows = await deps.db
    .select({
      id: jobs.id,
      workspaceId: jobs.workspaceId,
      projectId: jobs.projectId,
      status: jobs.status,
      submitState: jobs.submitState,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
      needsReconciliation: jobs.needsReconciliation,
      nextAttemptAt: jobs.nextAttemptAt,
      createdAt: jobs.createdAt,
      updatedAt: jobs.updatedAt,
      hasError: sql<boolean>`${jobs.error} is not null`,
    })
    .from(jobs)
    .where(and(...conditions))
    .orderBy(desc(jobs.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  return rows.map((row) =>
    opsJobSummarySchema.parse({
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      status: row.status,
      submitState: row.submitState,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      needsReconciliation: row.needsReconciliation,
      nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      errorCategory: row.status === 'FAILED_RETRYABLE' ? 'RETRYABLE' : row.status === 'FAILED_FINAL' ? 'FINAL' : row.hasError ? 'OTHER' : null,
    }),
  );
}

/** 人工重试（admin）：复用任务服务（预算/幂等/版本规则不变；审计经 job 事件与 actor 记录）。 */
export async function retryOpsJob(
  deps: DomainDeps,
  input: { jobId: string; workspaceId?: string; reason?: string | null },
): Promise<Job> {
  const workspaceId =
    input.workspaceId ?? (await deps.db.select({ workspaceId: jobs.workspaceId }).from(jobs).where(eq(jobs.id, input.jobId)).limit(1))[0]?.workspaceId;
  if (workspaceId === undefined) {
    throw new Error(`任务不存在：${input.jobId}`);
  }
  // loadJobRow 保留 404 语义（跨工作区显式校验），随后经统一迁移服务重试
  await loadJobRow(deps, { workspaceId, jobId: input.jobId });
  return retryJob(deps, { workspaceId, jobId: input.jobId, ...(input.reason !== null && input.reason !== undefined ? { reason: input.reason } : {}) });
}

/** 审计视图：job 事件（Outbox）+ 渲染状态迁移 + 审批（合并，新→旧）。 */
export async function listOpsAudit(deps: DomainDeps, input: { limit?: number } = {}): Promise<OpsAuditEntry[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const [jobEvents, renderEventsRows, approvalRows] = await Promise.all([
    deps.db
      .select()
      .from(outboxEvents)
      .where(or(eq(outboxEvents.type, 'job.failed'), eq(outboxEvents.type, 'job.completed'), eq(outboxEvents.type, 'job.queued')))
      .orderBy(desc(outboxEvents.createdAt))
      .limit(limit),
    deps.db.select().from(renderEvents).orderBy(desc(renderEvents.createdAt)).limit(limit),
    deps.db.select().from(renderApprovals).orderBy(desc(renderApprovals.createdAt)).limit(limit),
  ]);

  const entries: OpsAuditEntry[] = [];
  for (const row of jobEvents) {
    const payload = row.payload as Record<string, unknown>;
    entries.push(
      opsAuditEntrySchema.parse({
        id: row.id,
        kind: 'JOB',
        at: row.createdAt.toISOString(),
        workspaceId: row.workspaceId,
        projectId: typeof payload['projectId'] === 'string' ? payload['projectId'] : null,
        summary: `${row.type} · ${String(payload['jobType'] ?? '')} → ${String(payload['status'] ?? '')}${typeof payload['reason'] === 'string' ? `（${payload['reason']}）` : ''}`,
        details: payload,
      }),
    );
  }
  for (const row of renderEventsRows) {
    entries.push(
      opsAuditEntrySchema.parse({
        id: row.id,
        kind: 'RENDER',
        at: row.createdAt.toISOString(),
        workspaceId: row.workspaceId,
        projectId: null,
        summary: `render ${row.renderId} → ${row.status}${row.note === null ? '' : `（${row.note}）`}`,
        details: { renderId: row.renderId, status: row.status, seq: row.seq, actorId: row.actorId },
      }),
    );
  }
  for (const row of approvalRows) {
    entries.push(
      opsAuditEntrySchema.parse({
        id: row.id,
        kind: 'APPROVAL',
        at: row.createdAt.toISOString(),
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        summary: `render ${row.renderId} 审批 → ${row.decision}${row.note === null ? '' : `（${row.note}）`}`,
        details: { renderId: row.renderId, decision: row.decision, manifestHashAtApproval: row.manifestHashAtApproval, decidedBy: row.decidedBy },
      }),
    );
  }

  entries.sort((left, right) => right.at.localeCompare(left.at));
  return entries.slice(0, limit);
}

/* ---------- 告警条件（P08-03 / §44：可检查的阈值清单——无外部 Alertmanager 时以计算条件 + 运行手册为证据） ---------- */

export interface OpsAlert {
  id: string;
  severity: 'CRITICAL' | 'WARNING';
  summary: string;
  /** 当前值/阈值（可审计） */
  value: number;
  threshold: number;
}

/** 默认阈值（可按部署配置覆盖——V1 常量集中于此，运行手册同步列出）。 */
export const OPS_ALERT_THRESHOLDS = {
  /** 终态失败任务数（> 阈值告警） */
  failedFinal: 0,
  /** 待重试失败任务数 */
  failedRetryable: 10,
  /** 需对账任务数 */
  needsReconciliation: 0,
  /** 最老在途任务年龄（秒） */
  oldestActiveAgeSeconds: 600,
  /** QA 24h 失败数 */
  qaFailed24h: 5,
} as const;

/** 由总览派生告警（纯函数；GET /admin/overview 附带返回）。 */
export function evaluateOpsAlerts(overview: OpsOverview, thresholds: typeof OPS_ALERT_THRESHOLDS = OPS_ALERT_THRESHOLDS): OpsAlert[] {
  const alerts: OpsAlert[] = [];
  if (overview.jobs.failedFinal > thresholds.failedFinal) {
    alerts.push({ id: 'JOBS_FAILED_FINAL', severity: 'CRITICAL', summary: `存在终态失败任务（${String(overview.jobs.failedFinal)} 个）：需人工恢复或重渲决策`, value: overview.jobs.failedFinal, threshold: thresholds.failedFinal });
  }
  if (overview.jobs.failedRetryable > thresholds.failedRetryable) {
    alerts.push({ id: 'JOBS_FAILED_RETRYABLE_HIGH', severity: 'WARNING', summary: `待重试失败任务偏多（${String(overview.jobs.failedRetryable)} 个）`, value: overview.jobs.failedRetryable, threshold: thresholds.failedRetryable });
  }
  if (overview.jobs.needsReconciliation > thresholds.needsReconciliation) {
    alerts.push({ id: 'JOBS_NEEDS_RECONCILIATION', severity: 'CRITICAL', summary: `存在需对账任务（${String(overview.jobs.needsReconciliation)} 个）：绝不自动重复付费提交（§5.6）`, value: overview.jobs.needsReconciliation, threshold: thresholds.needsReconciliation });
  }
  if (overview.jobs.oldestActiveAgeSeconds !== null && overview.jobs.oldestActiveAgeSeconds > thresholds.oldestActiveAgeSeconds) {
    alerts.push({ id: 'QUEUE_BACKLOG', severity: 'WARNING', summary: `在途任务年龄超过阈值（${String(overview.jobs.oldestActiveAgeSeconds)}s）：队列积压或任务卡死`, value: overview.jobs.oldestActiveAgeSeconds, threshold: thresholds.oldestActiveAgeSeconds });
  }
  if (overview.qa.last24hFail > thresholds.qaFailed24h) {
    alerts.push({ id: 'QA_FAIL_RATE_24H', severity: 'WARNING', summary: `24h 内 QA 未通过 ${String(overview.qa.last24hFail)} 次：检查上游素材/字幕质量`, value: overview.qa.last24hFail, threshold: thresholds.qaFailed24h });
  }
  return alerts;
}
