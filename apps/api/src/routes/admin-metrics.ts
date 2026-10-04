import type { FastifyInstance } from 'fastify';
import { getOpsOverview, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';
import { snapshotMetrics } from '../plugins/metrics.js';

/**
 * 指标导出（P08-03 / 规范 §44）：`GET /api/v1/admin/metrics`（Prometheus 文本格式 0.0.4）。
 *
 * 指标（全部来自真实数据；外部指标后端可选接入）：
 * - `ancs_api_requests_total{class}` + `ancs_api_request_duration_seconds_bucket{le}`（进程内累计）；
 * - `ancs_api_request_duration_p50/p95_seconds`（按桶估算——§44 的最低证据口径）；
 * - `ancs_jobs{status=}`、`ancs_jobs_oldest_active_seconds`、`ancs_jobs_needs_reconciliation`；
 * - `ancs_renders{status=}`；`ancs_qa_reports_total{verdict=}`（24h）；
 * - `ancs_approvals_total{decision=}`；`ancs_provider_generations{status=}`；
 * - `ancs_credits_debits_total`、`ancs_workspaces_with_ledger`；
 * - `ancs_ops_alerts{id=,severity=}`（0/1，阈值见 OPS_ALERT_THRESHOLDS）。
 * 守卫：平台管理员（非管理员 404 反枚举）。
 */

const promLine = (name: string, labels: Record<string, string>, value: number): string => {
  const labelText = Object.entries(labels)
    .map(([key, text]) => `${key}="${text.replace(/"/g, '\\"')}"`)
    .join(',');
  return labelText === '' ? `${name} ${String(value)}` : `${name}{${labelText}} ${String(value)}`;
};

export function registerAdminMetricsRoutes(app: FastifyInstance, auth: AuthDeps): void {
  const domain: DomainDeps = { db: auth.db };

  app.get('/admin/metrics', { schema: { hide: true } }, async (request, reply) => {
    await app.requirePlatformAdmin(request);
    const [overview] = await Promise.all([getOpsOverview(domain)]);
    const snapshot = snapshotMetrics(app.apiMetrics);

    const lines: string[] = [];
    lines.push('# HELP ancs_api_requests_total API 请求总数（按状态类）');
    lines.push('# TYPE ancs_api_requests_total counter');
    for (const [statusClass, total] of Object.entries(snapshot.byStatusClass)) {
      lines.push(promLine('ancs_api_requests_total', { class: statusClass }, total));
    }
    lines.push('# TYPE ancs_api_request_duration_seconds histogram');
    for (const bucket of snapshot.durationBuckets) {
      lines.push(promLine('ancs_api_request_duration_seconds_bucket', { le: String(bucket.le) }, bucket.count));
    }
    lines.push(promLine('ancs_api_request_duration_seconds_bucket', { le: '+Inf' }, snapshot.requestsTotal));
    lines.push(promLine('ancs_api_request_duration_seconds_sum', {}, snapshot.durationSumSeconds));
    lines.push(promLine('ancs_api_request_duration_seconds_count', {}, snapshot.requestsTotal));
    lines.push('# TYPE ancs_api_request_duration_p50_seconds gauge');
    lines.push(promLine('ancs_api_request_duration_p50_seconds', {}, snapshot.durationP50Seconds));
    lines.push('# TYPE ancs_api_request_duration_p95_seconds gauge');
    lines.push(promLine('ancs_api_request_duration_p95_seconds', {}, snapshot.durationP95Seconds));

    lines.push('# TYPE ancs_jobs gauge');
    for (const [status, total] of Object.entries(overview.jobs.byStatus)) {
      lines.push(promLine('ancs_jobs', { status }, total));
    }
    lines.push(promLine('ancs_jobs_oldest_active_seconds', {}, overview.jobs.oldestActiveAgeSeconds ?? 0));
    lines.push(promLine('ancs_jobs_needs_reconciliation', {}, overview.jobs.needsReconciliation));

    lines.push('# TYPE ancs_renders gauge');
    for (const [status, total] of Object.entries(overview.renders.byStatus)) {
      lines.push(promLine('ancs_renders', { status }, total));
    }

    lines.push('# TYPE ancs_qa_reports_total gauge');
    lines.push(promLine('ancs_qa_reports_total', { verdict: 'PASS', window: '24h' }, overview.qa.last24hPass));
    lines.push(promLine('ancs_qa_reports_total', { verdict: 'FAIL', window: '24h' }, overview.qa.last24hFail));

    lines.push('# TYPE ancs_approvals_total gauge');
    lines.push(promLine('ancs_approvals_total', { decision: 'APPROVED' }, overview.approvals.approved));
    lines.push(promLine('ancs_approvals_total', { decision: 'REJECTED' }, overview.approvals.rejected));

    lines.push('# TYPE ancs_provider_generations gauge');
    for (const [status, total] of Object.entries(overview.providerGenerations.byStatus)) {
      lines.push(promLine('ancs_provider_generations', { status }, total));
    }

    lines.push('# TYPE ancs_credits_debits_total gauge');
    lines.push(promLine('ancs_credits_debits_total', {}, overview.spend.debitsTotal));
    lines.push(promLine('ancs_workspaces_with_ledger', {}, overview.spend.workspacesWithLedger));

    lines.push('# TYPE ancs_ops_alerts gauge（1 = 触发；阈值见 docs/ops/monitoring-recovery.md）');
    for (const alert of overview.alerts) {
      lines.push(promLine('ancs_ops_alerts', { id: alert.id, severity: alert.severity }, 1));
    }

    return reply.status(200).header('content-type', 'text/plain; version=0.0.4; charset=utf-8').send(`${lines.join('\n')}\n`);
  });
}
