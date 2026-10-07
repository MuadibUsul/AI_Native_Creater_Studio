import { describe, expect, it } from 'vitest';
import {
  FINANCE_VISUALIZATION_TYPES,
  creatorLearningSchema,
  financeArtifactSchema,
  videoPerformanceRecordSchema,
} from './index.js';

const now = '2026-10-07T08:00:00.000Z';

describe('P14 analytics 与 Finance 公共契约', () => {
  it('明确保留缺失指标为 null，并拒绝越界留存率', () => {
    const base = {
      id: 'vperf_1', workspaceId: 'ws_1', projectId: 'prj_1', publicationId: 'pub_1', projectVersionId: 'pv_1', platformId: 'youtube', remoteId: 'remote_1',
      sampling: { from: null, to: null, granularity: 'DAY', timezone: 'Asia/Shanghai', source: 'youtube:fetchAnalytics', fetchedAt: now },
      metrics: { views: 10, impressions: null, clickThroughRate: null, watchTimeMs: null, averageWatchTimeMs: null, retention: [{ positionMs: 0, rate: null }] },
      rawEventId: 'ane_1', createdAt: now,
    };
    expect(videoPerformanceRecordSchema.parse(base).metrics.impressions).toBeNull();
    expect(videoPerformanceRecordSchema.safeParse({ ...base, metrics: { ...base.metrics, retention: [{ positionMs: 0, rate: 1.1 }] } }).success).toBe(false);
  });

  it('学习建议必须声明相关性且不能声称已改写 Channel', () => {
    const base = {
      id: 'clrn_1', workspaceId: 'ws_1', projectId: 'prj_1', channelId: 'chn_1', kind: 'RHYTHM', status: 'ACTIVE', title: '节奏', explanation: '观察结果',
      evidence: { sampleCount: 2, observations: ['a'], interpretation: 'CORRELATION_ONLY' }, recommendation: {}, channelMutationApplied: false,
      acceptedAt: null, disabledAt: null, revertedAt: null, createdAt: now, updatedAt: now,
    };
    expect(creatorLearningSchema.parse(base).channelMutationApplied).toBe(false);
    expect(creatorLearningSchema.safeParse({ ...base, channelMutationApplied: true }).success).toBe(false);
  });

  it('Finance 六种类型完整，产物要求单位、时区、调整口径与来源快照', () => {
    expect(FINANCE_VISUALIZATION_TYPES).toHaveLength(6);
    const source = { id: 'fds_1', workspaceId: 'ws_1', name: 'Feed', sourceUrl: null, license: { licenseId: 'lic_1', name: 'License', url: null, allowedUse: 'video', effectiveAt: now }, createdAt: now };
    const template = { id: 'ftpl_1', workspaceId: 'ws_1', key: 'yield', version: 1, name: 'Yield', visualizationType: 'YIELD_CURVE', config: {}, createdAt: now };
    const artifact = { id: 'fart_1', workspaceId: 'ws_1', visualizationType: 'YIELD_CURVE', title: 'Curve', dataSourceSnapshot: source, templateSnapshot: template, data: [{ label: '10Y', value: 4.25, unit: '%', currency: null, timezone: 'UTC', adjustment: 'UNADJUSTED', sourceId: 'fds_1', observedAt: now, dimensions: {} }], relations: [], createdAt: now };
    expect(financeArtifactSchema.parse(artifact).templateSnapshot.version).toBe(1);
    const missingTrace = { ...artifact, data: [{ label: '10Y', value: 4.25 }] };
    expect(financeArtifactSchema.safeParse(missingTrace).success).toBe(false);
  });
});
