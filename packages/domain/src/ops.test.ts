import { describe, expect, it } from 'vitest';
import { evaluateOpsAlerts, OPS_ALERT_THRESHOLDS } from './ops.js';

/**
 * P08-03 告警条件（纯函数）：阈值触发与"无告警"基线。
 * 阈值集中定义（OPS_ALERT_THRESHOLDS），运行手册 docs/ops/monitoring-recovery.md 同步列出。
 */

const overview = (overrides: {
  failedFinal?: number;
  failedRetryable?: number;
  needsReconciliation?: number;
  oldestActiveAgeSeconds?: number | null;
  qaFail?: number;
}) => ({
  generatedAt: '2026-10-05T12:00:00.000Z',
  jobs: {
    byStatus: {},
    failedRetryable: overrides.failedRetryable ?? 0,
    failedFinal: overrides.failedFinal ?? 0,
    needsReconciliation: overrides.needsReconciliation ?? 0,
    oldestActiveAgeSeconds: overrides.oldestActiveAgeSeconds === undefined ? null : overrides.oldestActiveAgeSeconds,
  },
  renders: { byStatus: {} },
  qa: { last24hPass: 0, last24hFail: overrides.qaFail ?? 0 },
  approvals: { approved: 0, rejected: 0 },
  providerGenerations: { byStatus: {} },
  spend: { debitsTotal: 0, workspacesWithLedger: 0 },
  alerts: [],
});

describe('evaluateOpsAlerts（P08-03）', () => {
  it('健康态 → 无告警', () => {
    expect(evaluateOpsAlerts(overview({}) as never)).toEqual([]);
  });

  it('终态失败/对账 → CRITICAL（阈值 0 即触发）', () => {
    const alerts = evaluateOpsAlerts(overview({ failedFinal: 1, needsReconciliation: 2 }) as never);
    expect(alerts.map((alert) => alert.id).sort()).toEqual(['JOBS_FAILED_FINAL', 'JOBS_NEEDS_RECONCILIATION']);
    expect(alerts.every((alert) => alert.severity === 'CRITICAL')).toBe(true);
  });

  it('待重试积压/队列年龄/QA 失败率 → WARNING（超阈才触发）', () => {
    const below = evaluateOpsAlerts(overview({ failedRetryable: OPS_ALERT_THRESHOLDS.failedRetryable, oldestActiveAgeSeconds: OPS_ALERT_THRESHOLDS.oldestActiveAgeSeconds, qaFail: OPS_ALERT_THRESHOLDS.qaFailed24h }) as never);
    expect(below).toEqual([]);
    const above = evaluateOpsAlerts(overview({ failedRetryable: OPS_ALERT_THRESHOLDS.failedRetryable + 1, oldestActiveAgeSeconds: 3600, qaFail: 6 }) as never);
    expect(above.map((alert) => alert.id).sort()).toEqual(['JOBS_FAILED_RETRYABLE_HIGH', 'QA_FAIL_RATE_24H', 'QUEUE_BACKLOG']);
    expect(above.every((alert) => alert.severity === 'WARNING')).toBe(true);
  });
});
