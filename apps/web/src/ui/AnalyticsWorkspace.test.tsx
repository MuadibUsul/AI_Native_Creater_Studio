import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import { mockClient, renderWithClient } from '@/test-utils.js';
import { AnalyticsWorkspace } from './AnalyticsWorkspace.js';

const now = '2026-10-07T08:00:00.000Z';
const publication = {
  id: 'pub_1', workspaceId: 'ws_1', projectId: 'prj_1', platformId: 'youtube', accountId: 'acc_1', projectVersionId: 'pv_1', outputAssetId: 'ast_1', state: 'PUBLISHED' as const,
  remoteId: 'video_1', remoteUrl: null, publishedAt: now, title: '利率周报', description: null, tags: [], scheduledAt: null, disclosure: null, lastError: null, transferInstructions: null, createdAt: now, updatedAt: now,
};
const performance = {
  id: 'vperf_1', workspaceId: 'ws_1', projectId: 'prj_1', publicationId: 'pub_1', projectVersionId: 'pv_1', platformId: 'youtube', remoteId: 'video_1',
  sampling: { from: null, to: null, granularity: 'LIFETIME' as const, timezone: 'UTC', source: 'youtube:fetchAnalytics', fetchedAt: now },
  metrics: { views: 1200, impressions: null, clickThroughRate: null, watchTimeMs: 90000, averageWatchTimeMs: null, retention: [{ positionMs: 0, rate: 1 }] }, rawEventId: 'aevt_1', createdAt: now,
};
const learning = {
  id: 'lrn_1', workspaceId: 'ws_1', projectId: 'prj_1', channelId: 'chn_1', kind: 'RHYTHM' as const, status: 'ACTIVE' as const,
  title: '节奏建议', explanation: '已发布样本的短场景留存更高。', evidence: { sampleCount: 2, observations: ['样本'], interpretation: 'CORRELATION_ONLY' as const }, recommendation: {}, channelMutationApplied: false as const,
  acceptedAt: null, disabledAt: null, revertedAt: null, createdAt: now, updatedAt: now,
};

function makeClient() {
  const actOnLearning = vi.fn().mockResolvedValue({ ...learning, status: 'ACCEPTED', acceptedAt: now });
  const listDataSources = vi.fn().mockRejectedValue(new Error('Finance 暂不可用'));
  const client = mockClient({
    publications: { list: vi.fn().mockResolvedValue({ items: [publication] }), listAnalytics: vi.fn().mockResolvedValue({ items: [performance] }), collectAnalytics: vi.fn() },
    analytics: {
      listScenes: vi.fn().mockResolvedValue({ items: [{ id: 'sp_1', workspaceId: 'ws_1', projectId: 'prj_1', projectVersionId: 'pv_1', sceneId: 'scn_1', videoPerformanceId: 'vperf_1', sceneType: 'LINE_CHART', position: 0, startMs: 0, durationMs: 30000, retentionRate: 0.82, interpretation: 'CORRELATION_ONLY', derivation: { method: 'TIME_WINDOW_AVERAGE', sampleCount: 1 }, createdAt: now }] }),
      listLearnings: vi.fn().mockResolvedValue({ items: [learning] }), attributeScenes: vi.fn(), generateLearnings: vi.fn(), actOnLearning,
    },
    finance: { listDataSources },
  });
  return { client, actOnLearning, listDataSources };
}

describe('AnalyticsWorkspace（P14 Web 完成面）', () => {
  it('缺失指标显示未知、场景归因声明相关性，学习操作不声称修改 Channel', async () => {
    const { client, actOnLearning, listDataSources } = makeClient();
    renderWithClient(<AnalyticsWorkspace workspaceId="ws_1" projectId="prj_1" />, client);
    expect(await screen.findByText('1,200')).toBeTruthy();
    expect(screen.getAllByText('未知（平台未返回）').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/仅表示相关性，不代表因果/)).toBeTruthy();
    expect(screen.getByText(/不会静默修改 Channel/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '接受' }));
    await waitFor(() => expect(actOnLearning).toHaveBeenCalledWith('ws_1', 'prj_1', 'lrn_1', { action: 'ACCEPT' }));
    expect(listDataSources).not.toHaveBeenCalled();
  });

  it('renders in English without Chinese interface text', async () => {
    const { client } = makeClient();
    client.publications.list = vi.fn().mockResolvedValue({ items: [{ ...publication, title: 'Rates weekly' }] });
    client.analytics.listLearnings = vi.fn().mockResolvedValue({ items: [{ ...learning, title: 'Rhythm', explanation: 'Short scenes retained better.' }] });
    const { container } = renderWithClient(<I18nProvider initialLocale="en"><AnalyticsWorkspace workspaceId="ws_1" projectId="prj_1" /></I18nProvider>, client);
    expect(await screen.findByText('1,200')).toBeTruthy();
    expect(screen.getAllByText('Unknown (not returned by the platform)').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Click-through rate')).toBeTruthy();
    expect(screen.getByText(/^youtube · LIFETIME · UTC · Fetched /)).toBeTruthy();
    expect(await screen.findByText('Retention: 82% · 1 sample point')).toBeTruthy();
    expect(screen.getByText('Correlation evidence · 2 samples · Channel unchanged')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Select publication' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    expect(container.innerHTML).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
